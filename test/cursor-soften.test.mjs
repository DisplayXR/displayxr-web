// Crosstalk softening of the lifted depth cursor (runtime ADR-046 Amendment 2 §B.7), the web port.
//
// The numbers mirror displayxr-runtime tests/tests_aux_cursor_depth.cpp, "cursor_soften: …"
// TEST_CASEs, one for one, so the web and native cursors soften identically. Then the web-only
// pieces: the ghost offset measured from the VIEWS, the padded quad, the analytic 13-tap arrow (the
// reference the GLSL mirrors), the option, and the three/pair glue (crisp frames stay crisp).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CURSOR_SOFTEN_DEFAULTS as D,
  CURSOR_SOFTEN_KERNEL,
  CURSOR_SOFTEN_PRESETS,
  CURSOR_ARROW,
  CURSOR_ARROW_FILL,
  CURSOR_ARROW_SIZE,
  CURSOR_FILL_COLOR,
  CURSOR_OUTLINE_COLOR,
  cursorGhostPx,
  cursorPlacementSoften,
  cursorPolygonSd,
  cursorProjectToCanvas,
  cursorSoften,
  cursorSoftArrowBox,
  cursorSoftArrowGLSL,
  cursorSoftArrowRaster,
  cursorSoftArrowSample,
  parseCursorSoften,
  resolveCursorOption,
  resolveCursorSoften,
  CursorDepthPlacer,
} from '../js/inline3d-cursor-depth.js';
import { resolvePairCursorOption } from '../js/inline3d-cursor-option.js';
import { DepthCursor } from '../js/inline3d-three.js';

const near = (a, b, eps = 1e-5, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} != ${b}`);
const P = (over = {}) => ({ ...D, ...over });

// ── The runtime's test vectors ─────────────────────────────────────────────────────────────

test('cursor_soften: defaults - both on, the documented values', () => {
  assert.equal(D.blur, true);
  assert.equal(D.alpha, true);
  assert.equal(D.blurK, 0.1);
  assert.equal(D.blurMaxPx, 8);
  assert.equal(D.blurMaxFrac, 0.06);
  assert.equal(D.alphaMin, 0.5);
  assert.equal(D.fullD, 0.03);
  assert.ok(Object.isFrozen(D));
});

test('cursor_soften: on the glass there is no softening at all', () => {
  assert.deepEqual(cursorSoften(0, 0, undefined, D), { blurPx: 0, alpha: 1 });
  // A null params object and non-finite input are "no softening" too.
  assert.deepEqual(cursorSoften(-0.05, 10, undefined, null), { blurPx: 0, alpha: 1 });
  assert.deepEqual(cursorSoften(NaN, Infinity, undefined, D), { blurPx: 0, alpha: 1 });
  // And sized, whatever the size.
  assert.deepEqual(cursorSoften(0, 0, 64, D), { blurPx: 0, alpha: 1 });
});

test('cursor_soften: blur = k x ghost, capped; monotonic in the ghost offset', () => {
  const p = P({ blurMaxPx: 1.5 }); // the absolute cap (unsized applies only this)
  near(cursorSoften(-0.02, 5, undefined, p).blurPx, 0.5);
  near(cursorSoften(-0.02, -5, undefined, p).blurPx, 0.5);
  near(cursorSoften(-0.02, 14, undefined, p).blurPx, 1.4);
  near(cursorSoften(-0.02, 15, undefined, p).blurPx, 1.5);
  near(cursorSoften(-0.02, 200, undefined, p).blurPx, 1.5);
  let prev = -1;
  for (let g = 0; g <= 40; g += 0.5) {
    const b = cursorSoften(-0.02, g, undefined, p).blurPx;
    assert.ok(b >= prev);
    assert.ok(b <= p.blurMaxPx);
    prev = b;
  }
  // The blur depends on the ghost offset only, not on d.
  near(cursorSoften(-0.5, 5, undefined, p).blurPx, 0.5);
});

test('cursor_soften: opacity eases 1 -> alpha_min by smoothstep over |d|, then holds', () => {
  const p = P({ alphaMin: 0.75, fullD: 0.1 });
  near(cursorSoften(-0.05, 0, undefined, p).alpha, 0.875);
  near(cursorSoften(-0.025, 0, undefined, p).alpha, 1 - 0.25 * 0.15625);
  near(cursorSoften(-0.1, 0, undefined, p).alpha, 0.75);
  near(cursorSoften(-0.6, 0, undefined, p).alpha, 0.75);
  near(cursorSoften(0.05, 0, undefined, p).alpha, 0.875); // |d|: symmetric
  let prev = 2;
  for (let d = 0; d >= -0.3; d -= 0.005) {
    const a = cursorSoften(d, 0, undefined, p).alpha;
    assert.ok(a <= prev);
    assert.ok(a >= p.alphaMin - 1e-6);
    assert.ok(a <= 1);
    prev = a;
  }
  assert.ok(cursorSoften(-0.001, 0, undefined, p).alpha > 0.9999); // smooth start
  // alphaMin outside [0, 1] is clamped by the easing itself.
  near(cursorSoften(-1, 0, undefined, P({ alphaMin: -2 })).alpha, 0);
  near(cursorSoften(-1, 0, undefined, P({ alphaMin: 3 })).alpha, 1);
});

test('cursor_soften: the presets switch each effect independently', () => {
  let r = parseCursorSoften(null, null, null, null, null, null);
  assert.equal(r.changed, false);
  assert.ok(r.params.blur && r.params.alpha);
  r = parseCursorSoften('both');
  assert.equal(r.changed, false);
  assert.ok(r.params.blur && r.params.alpha);

  r = parseCursorSoften('off');
  assert.equal(r.changed, true);
  assert.deepEqual(cursorSoften(-0.2, 30, undefined, r.params), { blurPx: 0, alpha: 1 });

  r = parseCursorSoften('alpha');
  assert.equal(r.changed, true);
  let s = cursorSoften(-0.2, 30, undefined, r.params);
  assert.equal(s.blurPx, 0);
  near(s.alpha, D.alphaMin);

  r = parseCursorSoften('blur');
  assert.equal(r.changed, true);
  s = cursorSoften(-0.2, 30, undefined, r.params);
  near(s.blurPx, 0.1 * 30); // k x ghost, under the 8 px ceiling (unsized)
  assert.equal(s.alpha, 1);
});

test('cursor_soften: numeric knobs parse, and bad values keep the default', () => {
  let r = parseCursorSoften(null, '0.2', '2', null, '0.5', '0.05');
  assert.equal(r.changed, true);
  near(r.params.blurK, 0.2);
  near(r.params.blurMaxPx, 2);
  near(r.params.alphaMin, 0.5);
  near(r.params.fullD, 0.05);
  const s = cursorSoften(-0.05, 5, undefined, r.params);
  near(s.blurPx, 1);
  near(s.alpha, 0.5);

  // Out of range / garbage: each falls back on its own.
  r = parseCursorSoften(null, '-1', '9', '0.9', '1.5', '0');
  assert.equal(r.changed, false);
  assert.deepEqual(r.params, { ...D });
  r = parseCursorSoften(null, 'abc', '1x', null, '', 'nan');
  assert.equal(r.changed, false);
  near(r.params.blurK, 0.1);
  near(r.params.fullD, 0.03);
  // Windows cmd's `set X=off && app` leaves a trailing space: still honoured.
  r = parseCursorSoften('off ', null, '2 ', null, null, null);
  assert.equal(r.changed, true);
  assert.ok(!r.params.blur && !r.params.alpha);
  near(r.params.blurMaxPx, 2);
  r = parseCursorSoften('blurx');
  assert.equal(r.changed, false);
  assert.ok(r.params.blur && r.params.alpha);
  // Boundaries that are legal: k = 0 and max = 0 disable the blur.
  r = parseCursorSoften(null, '0', null, null, '1', null);
  assert.equal(r.changed, true);
  assert.equal(cursorSoften(-0.2, 30, undefined, r.params).blurPx, 0);
  near(cursorSoften(-0.2, 30, undefined, r.params).alpha, 1);
  // Each range edge, in and out (the runtime's soften_parse_float bounds).
  assert.equal(parseCursorSoften(null, null, '8').params.blurMaxPx, 8);
  assert.equal(parseCursorSoften(null, null, '8.01').params.blurMaxPx, 8);
  assert.equal(parseCursorSoften(null, null, null, '0.5').params.blurMaxFrac, 0.5);
  assert.equal(parseCursorSoften(null, null, null, '0.51').params.blurMaxFrac, 0.06);
  assert.equal(parseCursorSoften(null, null, null, null, '0').params.alphaMin, 0);
  assert.equal(parseCursorSoften(null, null, null, null, null, '1e-3').params.fullD, 0.001);
  assert.equal(parseCursorSoften(null, null, null, null, null, '-0.1').params.fullD, 0.03);
});

test('cursor_soften: ghost offset = largest NEIGHBOUR-view hotspot distance, in panel px', () => {
  const o = [[0.5, 0.4], [0.51, 0.4]]; // 0.01 of a 1920 px canvas = 19.2 px
  near(cursorGhostPx(o, 1920, 1080), 19.2, 1e-4);
  near(cursorGhostPx([[0.5, 0.4], [0.5, 0.4]], 1920, 1080), 0); // on the glass: no ghost
  near(cursorGhostPx([[0.5, 0.4], [0.5, 0.41]], 1920, 1000), 10, 1e-4); // vertical counts with the height
  // Four views: neighbours only (0-3 spans three gaps), the largest wins.
  near(cursorGhostPx([[0.5, 0.4], [0.51, 0.4], [0.53, 0.4], [0.54, 0.4]], 1000, 1000), 20, 1e-4);
  assert.equal(cursorGhostPx(o, 0, 1000), 0);
  assert.equal(cursorGhostPx([[0.5, 0.4]], 1000, 1000), 0);
  assert.equal(cursorGhostPx(null, 1000, 1000), 0);
});

test('cursor_soften: the padded quad grows by the blur radius, hotspot fixed', () => {
  // No blur: the arrow's own box, the tip (hotspot) at its top-left corner.
  cursorSoftArrowBox(0).forEach((x, i) => near(x, [0, 0, CURSOR_ARROW_SIZE[0], CURSOR_ARROW_SIZE[1]][i], 0));
  // 2 px of blur on a 40 px arrow: every edge moves 0.05 arrow heights out; the origin stays the tip.
  const b = cursorSoftArrowBox(2 / 40);
  near(b[0], -0.05);
  near(b[1], -0.05);
  near(b[2], CURSOR_ARROW_SIZE[0] + 0.05);
  near(b[3], CURSOR_ARROW_SIZE[1] + 0.05);
  assert.ok(b[0] < 0 && b[1] < 0, 'the hotspot (0, 0) is inside the padded quad, not moved');
  // Plus the AA width, so the anti-aliased rim is not clipped either.
  near(cursorSoftArrowBox(0.05, 0.01)[0], -0.06);
  assert.deepEqual(cursorSoftArrowBox(NaN), cursorSoftArrowBox(0));
  assert.deepEqual(CURSOR_ARROW_SIZE, [11.7 / 19, 18.6 / 19]);
});

test('cursor_soften: the blur cap is proportional to the DRAWN sprite height', () => {
  const ghost = 200;
  near(cursorSoften(-0.05, ghost, 64, D).blurPx, 3.84); // 0.06 x 64 px
  near(cursorSoften(-0.05, ghost, 25.6, D).blurPx, 1.536); // the same cursor at 96 DPI
  near(cursorSoften(-0.05, ghost, 256, D).blurPx, D.blurMaxPx); // huge pointer: the hard ceiling
  near(cursorSoften(-0.05, 20, 64, D).blurPx, 2); // below the cap: k x ghost
  near(cursorSoften(-0.05, ghost, 0, D).blurPx, D.blurMaxPx); // unknown size: the ceiling only
  assert.equal(cursorSoften(-0.05, ghost, NaN, D).blurPx, cursorSoften(-0.05, ghost, undefined, D).blurPx);
  near(cursorSoften(-0.05, ghost, 64, P({ blurMaxFrac: 0 })).blurPx, D.blurMaxPx); // frac 0 = off
  assert.deepEqual(cursorSoften(0, 0, 64, D), { blurPx: 0, alpha: 1 });
});

test('cursor_soften: the default opacity reaches 0.5 at the typical lift (0.03)', () => {
  near(cursorSoften(-0.03, 0, undefined, D).alpha, 0.5);
  near(cursorSoften(-0.015, 0, undefined, D).alpha, 0.75); // smoothstep midpoint
  near(cursorSoften(-0.2, 0, undefined, D).alpha, 0.5);
});

// ── The web side: ghost from the views, the analytic arrow, the option, the glue ───────────

const Wc = 0.3, Hc = 0.2; // canvas, m
function kooima(eye) {
  const d = eye[2];
  const l = (-Wc / 2 - eye[0]) / d, r = (Wc / 2 - eye[0]) / d;
  const u = (Hc / 2 - eye[1]) / d, dn = (-Hc / 2 - eye[1]) / d;
  const n = 0.01, f = 100;
  return {
    projectionMatrix: [2 / (r - l), 0, 0, 0, 0, 2 / (u - dn), 0, 0, (r + l) / (r - l), (u + dn) / (u - dn), -(f + n) / (f - n), -1, 0, 0, (-2 * f * n) / (f - n), 0],
    transformMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, eye[0], eye[1], eye[2], 1],
  };
}

test('cursorProjectToCanvas: a canvas point lands where it is; a lifted point splits by its disparity', () => {
  const a = kooima([-0.032, 0, 0.6]), b = kooima([0.032, 0, 0.6]);
  // On the glass both views see it at the same canvas point.
  const on = [-Wc / 2 + 0.25 * Wc, Hc / 2 - 0.75 * Hc, 0];
  for (const v of [a, b]) {
    const uv = cursorProjectToCanvas(v, on);
    near(uv[0], 0.25);
    near(uv[1], 0.75);
  }
  // 0.1 m in front of a 0.6 m-away glass: on-screen disparity = baseline × (1 − 1/t), t = 5/6.
  const p = [0, 0, 0.1];
  const ua = cursorProjectToCanvas(a, p), ub = cursorProjectToCanvas(b, p);
  near((ua[0] - ub[0]) * Wc, 0.064 * (1 / (5 / 6) - 1), 1e-9); // crossed: left eye sees it right
  near(ua[1], 0.5);
  // XRView shape, a parent scale, and behind the eye.
  const xr = { projectionMatrix: a.projectionMatrix, transform: { matrix: a.transformMatrix } };
  near(cursorProjectToCanvas(xr, on)[0], 0.25);
  const s2 = { projectionMatrix: a.projectionMatrix, transformMatrix: [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, -0.064, 0, 1.2, 1] };
  near(cursorProjectToCanvas(s2, [on[0] * 2, on[1] * 2, 0])[0], 0.25);
  assert.equal(cursorProjectToCanvas(a, [0, 0, 1]), null);
  assert.equal(cursorProjectToCanvas({ projectionMatrix: a.projectionMatrix, transformMatrix: new Array(16).fill(0) }, on), null);
});

test('cursorPlacementSoften: the ghost is the drawn views\' split, the radius in arrow units, the glass untouched', () => {
  const views = [kooima([-0.032, 0, 0.6]), kooima([0.032, 0, 0.6])];
  const placer = new CursorDepthPlacer();
  // Content at z = 0.1 under the pointer; let the filter settle.
  let p;
  for (let i = 0; i < 60; i++) p = placer.update(views, { u: 0.5, v: 0.5, nearestPoint: [0, 0, 0.1] }, 1 + i * 0.016);
  assert.equal(p.active, true);
  const h = 19 / 600; // the OS arrow on a 600-px-tall canvas
  const s = cursorPlacementSoften(p, views, 900, 600, h, D);
  // Ghost: the 64 mm baseline × (−d) of canvas width (0.3 m over 900 px).
  near(s.ghostPx, 0.064 * -p.disparity * (900 / Wc), 1e-6);
  near(s.spritePx, 19);
  near(s.blurPx, Math.min(0.1 * s.ghostPx, 0.06 * 19, 8), 1e-9);
  near(s.radius, s.blurPx / 19, 1e-12);
  near(s.aa, 1 / 19, 1e-12);
  near(s.alpha, 0.5); // well past fullD (d ≈ −0.215)
  assert.equal(s.soft, true);
  // Off: crisp.
  const off = cursorPlacementSoften(p, views, 900, 600, h, resolveCursorSoften('off'));
  assert.equal(off.soft, false);
  assert.equal(off.blurPx, 0);
  assert.equal(off.alpha, 1);
  // 'alpha' alone (no blur) is still a softened frame: the fade needs the soft material.
  const fadeOnly = cursorPlacementSoften(p, views, 900, 600, h, resolveCursorSoften('alpha'));
  assert.equal(fadeOnly.blurPx, 0);
  assert.equal(fadeOnly.radius, 0);
  near(fadeOnly.alpha, 0.5);
  assert.equal(fadeOnly.soft, true);
  // Inactive (on the glass, nothing drawn): never softened.
  assert.equal(cursorPlacementSoften({ active: false }, views, 900, 600, h, D).soft, false);
  assert.equal(cursorPlacementSoften(null, views, 900, 600, h, D).soft, false);
});

test('the 13-tap kernel is the runtime\'s: centre 1, four at r/2 (0.7066), eight at r (0.2494)', () => {
  assert.equal(CURSOR_SOFTEN_KERNEL.length, 13);
  assert.deepEqual(CURSOR_SOFTEN_KERNEL[0], [0, 0, 1]);
  for (const k of CURSOR_SOFTEN_KERNEL.slice(1, 5)) {
    near(Math.hypot(k[0], k[1]), 0.5);
    assert.equal(k[2], 0.7066);
  }
  for (const [i, k] of CURSOR_SOFTEN_KERNEL.slice(5).entries()) {
    near(Math.hypot(k[0], k[1]), 1);
    near(Math.atan2(k[1], k[0]) < 0 ? Math.atan2(k[1], k[0]) + 2 * Math.PI : Math.atan2(k[1], k[0]), 0.3927 + 0.7854 * i, 1e-9);
    assert.equal(k[2], 0.2494);
  }
});

test('cursorPolygonSd: negative inside, positive outside, the edge distance either way', () => {
  near(cursorPolygonSd(CURSOR_ARROW, -0.1, 0.3), 0.1, 1e-9); // left of the shaft
  assert.ok(cursorPolygonSd(CURSOR_ARROW, 0.1, 0.3) < 0);
  near(cursorPolygonSd(CURSOR_ARROW, 0.02, 0.3), -0.02, 1e-9); // inside, 0.02 from the left edge
  assert.ok(cursorPolygonSd(CURSOR_ARROW, 0.7, 0.9) > 0);
  // Winding does not matter.
  near(cursorPolygonSd([...CURSOR_ARROW].reverse(), 0.02, 0.3), -0.02, 1e-9);
});

test('cursorSoftArrowSample: crisp = the arrow\'s colours; blurred = premultiplied, symmetric about an edge, continuous', () => {
  // Crisp (r = 0): fill inside, outline in the rim, nothing outside.
  assert.deepEqual(cursorSoftArrowSample(0.15, 0.4, 0, 0), [...CURSOR_FILL_COLOR]);
  assert.deepEqual(cursorSoftArrowSample(0.01, 0.4, 0, 0), [...CURSOR_OUTLINE_COLOR]);
  assert.deepEqual(cursorSoftArrowSample(-0.01, 0.4, 0, 0), [0, 0, 0, 0]);
  // Blurred: exactly half coverage ON a straight edge (the shaft's left edge, x = 0), far from
  // corners — the kernel is symmetric (taps lying on the edge count half, with any AA width).
  near(cursorSoftArrowSample(0, 0.4, 0.04, 1e-6)[3], 0.5, 1e-9);
  // Straight-alpha colour on the outer rim is the OUTLINE's: clear taps add no colour.
  const rim = cursorSoftArrowSample(-0.02, 0.4, 0.04, 0);
  assert.ok(rim[3] > 0 && rim[3] < 0.5);
  near(rim[0], CURSOR_OUTLINE_COLOR[0], 1e-9);
  // Blur spreads coverage out to the outermost tap and no further: r·cos(22.5°) across a vertical
  // edge (the runtime's 8 outer taps sit at 22.5° + k·45°).
  assert.ok(cursorSoftArrowSample(-0.036, 0.4, 0.04, 0)[3] > 0);
  assert.equal(cursorSoftArrowSample(-0.038, 0.4, 0.04, 0)[3], 0);
  // Monotonic across the edge.
  let prev = -1;
  for (let x = -0.05; x <= 0.05; x += 0.002) {
    const a = cursorSoftArrowSample(x, 0.4, 0.04, 0.01)[3];
    assert.ok(a >= prev - 1e-12);
    prev = a;
  }
  // AA width alone: a linear ramp one aa wide, centred on the edge.
  near(cursorSoftArrowSample(0, 0.4, 0, 0.02)[3], 0.5, 1e-9);
  near(cursorSoftArrowSample(-0.005, 0.4, 0, 0.02)[3], 0.25, 1e-9);
});

test('cursorSoftArrowGLSL: generated from the same polygons and kernel (no arrays, no loops)', () => {
  const src = cursorSoftArrowGLSL();
  assert.match(src, /vec4 inline3dSoftArrow\(vec2 p, float radius, float aa, vec3 fill, vec3 outline\)/);
  // Every vertex of both polygons, every tap weight, every tap offset.
  const f = (v) => (+v).toPrecision(9);
  for (const poly of [CURSOR_ARROW, CURSOR_ARROW_FILL]) for (const [x, y] of poly) assert.ok(src.includes(`vec2(${f(x)}, ${f(y)})`), `vertex ${x}, ${y}`);
  assert.equal((src.match(/i3dCursorTap\(p \+ vec2/g) || []).length, 12);
  assert.equal((src.match(/0\.706600000 \*/g) || []).length, 4);
  assert.equal((src.match(/0\.249400000 \*/g) || []).length, 8);
  assert.match(src, /wsum \+= 4\.82160000;/); // 4 × 0.7066 + 8 × 0.2494
  assert.ok(!/\bfor\s*\(|\[\d/.test(src), 'portable GLSL: no loops, no array indexing');
  assert.equal((src.match(/i3dCursorEdge\(p, vec2/g) || []).length, CURSOR_ARROW.length + CURSOR_ARROW_FILL.length);
});

test('cursorSoftArrowRaster: the tip stays on the hotspot pixel; blur widens the footprint; opacity scales alpha', () => {
  const crisp = cursorSoftArrowRaster(100.5, 50.5, 40, 0, 1);
  const soft = cursorSoftArrowRaster(100.5, 50.5, 40, 0.06, 1);
  const faded = cursorSoftArrowRaster(100.5, 50.5, 40, 0, 0.5);
  const at = (r, x, y) => {
    const o = ((y - r.y0) * r.width + (x - r.x0)) * 4;
    return [...r.data.slice(o, o + 4)];
  };
  const count = (r) => { let n = 0; for (let i = 3; i < r.data.length; i += 4) n += r.data[i] > 0; return n; };
  // The padded raster starts left/above the hotspot by the pad, and is bigger with blur.
  assert.ok(soft.x0 < crisp.x0 && soft.y0 < crisp.y0);
  assert.ok(count(soft) > count(crisp));
  // Deep inside the fill: white, opaque — even blurred, the interior is untouched.
  assert.deepEqual(at(crisp, 106, 70), [255, 255, 255, 255]);
  assert.deepEqual(at(soft, 106, 70), [255, 255, 255, 255]);
  // Opacity halves alpha, not colour.
  assert.deepEqual(at(faded, 106, 70), [255, 255, 255, 128]);
  // Peak fill falls / max edge step falls under blur.
  const maxStep = (r) => {
    let m = 0;
    for (let y = 0; y < r.height; y++) for (let x = 1; x < r.width; x++) {
      const o = (y * r.width + x) * 4;
      m = Math.max(m, Math.abs(r.data[o + 3] - r.data[o - 1]));
    }
    return m;
  };
  assert.ok(maxStep(soft) < maxStep(crisp) / 2, `${maxStep(soft)} vs ${maxStep(crisp)}`);
});

test('cursor.soften option: presets, an object over the defaults, validated at the call', () => {
  assert.deepEqual([...CURSOR_SOFTEN_PRESETS], ['both', 'off', 'alpha', 'blur']);
  assert.deepEqual(resolveCursorSoften(undefined), { ...D });
  assert.deepEqual(resolveCursorSoften(true), { ...D });
  assert.deepEqual(resolveCursorSoften('both'), { ...D });
  assert.deepEqual(resolveCursorSoften(false), { ...D, blur: false, alpha: false });
  assert.deepEqual(resolveCursorSoften('off'), { ...D, blur: false, alpha: false });
  assert.deepEqual(resolveCursorSoften('alpha'), { ...D, blur: false });
  assert.deepEqual(resolveCursorSoften('blur'), { ...D, alpha: false });
  assert.deepEqual(resolveCursorSoften({ blurK: 0.2, alphaMin: 0.7 }), { ...D, blurK: 0.2, alphaMin: 0.7 });
  assert.deepEqual(resolveCursorSoften({ mode: 'blur', blurMaxFrac: 0.1 }), { ...D, alpha: false, blurMaxFrac: 0.1 });
  assert.deepEqual(resolveCursorSoften({ fullD: 1000, blurMaxPx: 0, blurMaxFrac: 0.5, alphaMin: 1, blurK: 0 }), { ...D, fullD: 1000, blurMaxPx: 0, blurMaxFrac: 0.5, alphaMin: 1, blurK: 0 });
  assert.throws(() => resolveCursorSoften('soft'), /cursor\.soften/);
  assert.throws(() => resolveCursorSoften(3), /cursor\.soften/);
  assert.throws(() => resolveCursorSoften({ radius: 2 }), /unknown option/);
  assert.throws(() => resolveCursorSoften({ mode: 'x' }), /cursor\.soften/);
  assert.throws(() => resolveCursorSoften({ fullD: 0 }), /fullD/);
  assert.throws(() => resolveCursorSoften({ blurMaxPx: 9 }), /blurMaxPx/);
  assert.throws(() => resolveCursorSoften({ blurMaxFrac: 0.6 }), /blurMaxFrac/);
  assert.throws(() => resolveCursorSoften({ alphaMin: 1.1 }), /alphaMin/);
  assert.throws(() => resolveCursorSoften({ blurK: -0.1 }), /blurK/);
  assert.throws(() => resolveCursorSoften({ blurK: '0.1' }), /blurK/);
  // Through the cursor options (model/splat, and a pair).
  assert.deepEqual(resolveCursorOption({ soften: 'alpha' }), { soften: 'alpha' });
  assert.throws(() => resolveCursorOption({ soften: 'nope' }), /cursor\.soften/);
  assert.deepEqual(resolvePairCursorOption({ soften: { alphaMin: 0.6 } }), { soften: { alphaMin: 0.6 } });
  assert.throws(() => resolvePairCursorOption({ soften: { alphaMin: 2 } }), /alphaMin/);
});

// ── three glue: crisp frames draw the crisp mesh, lifted ones the soft quad ─────────────────

function stubTHREE() {
  class Mat { constructor(o) { Object.assign(this, o); } dispose() { this.disposed = true; } }
  class Geom { setAttribute(k, v) { this[k] = v; } dispose() { this.disposed = true; } }
  const V = class { constructor(...a) { this.v = a; } set(...a) { this.v = a; return this; } };
  return {
    BufferGeometry: Geom,
    Float32BufferAttribute: class { constructor(a, n) { this.array = a; this.itemSize = n; } },
    MeshBasicMaterial: Mat,
    ShaderMaterial: Mat,
    ShaderChunk: { colorspace_fragment: '' },
    Vector3: V,
    Vector4: V,
    DoubleSide: 2,
    Mesh: class {
      constructor(geometry, material) {
        this.geometry = geometry;
        this.material = material;
        this.matrix = { elements: null, fromArray(a) { this.elements = a; } };
      }
    },
  };
}
function stubCanvas() {
  const handlers = {};
  return {
    style: { cursor: '' },
    handlers,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 200 }),
    addEventListener(k, f) { handlers[k] = f; },
    removeEventListener(k) { delete handlers[k]; },
  };
}

test('DepthCursor: lifted = the soft quad (radius, opacity in its uniforms); soften off = the crisp mesh, unchanged', () => {
  const hitTest = (o, d) => {
    const t = (0.1 - o[2]) / d[2];
    return [o[0] + d[0] * t, o[1] + d[1] * t, 0.1];
  };
  const views = [kooima([-0.032, 0, 0.6]), kooima([0.032, 0, 0.6])];
  const run = (soften) => {
    const cur = new DepthCursor(stubTHREE(), { canvas: stubCanvas(), hitTest, soften });
    const crisp = { g: cur.object.geometry, m: cur.object.material };
    cur.setPointer(0.5, 0.5);
    let p;
    for (let i = 0; i < 30; i++) p = cur.update(views, 1000 + i * 16);
    return { cur, crisp, p };
  };
  const a = run(undefined);
  assert.equal(a.p.active, true);
  assert.equal(a.cur.softening.soft, true);
  assert.notEqual(a.cur.object.material, a.crisp.m, 'the soft material is swapped in');
  const u = a.cur.object.material.uniforms;
  near(u.inline3dCursorSoft.value.v[0], a.cur.softening.radius, 1e-12);
  near(u.inline3dCursorSoft.value.v[1], 0.5, 1e-9);
  assert.equal(a.cur.object.material.depthTest, false);
  assert.match(a.cur.object.material.fragmentShader, /#include <colorspace_fragment>/);
  near(u.inline3dCursorBox.value.v[0], -(a.cur.softening.radius + a.cur.softening.aa), 1e-12);

  const b = run('off');
  assert.equal(b.p.active, true);
  assert.equal(b.cur.softening.soft, false);
  assert.equal(b.cur.object.material, b.crisp.m, 'crisp material, the very same object');
  assert.equal(b.cur.object.geometry, b.crisp.g);
  assert.equal(b.cur._soft, null, 'nothing soft is ever built when it is off');

  // Back to the glass: nothing drawn, softening cleared; dispose frees both.
  a.cur.setPointer(null);
  assert.equal(a.cur.update(views, 2000).active, false);
  assert.equal(a.cur.softening, null);
  a.cur.dispose();
  assert.ok(a.crisp.m.disposed && a.cur._soft.material.disposed && a.cur._soft.geometry.disposed);

  // three 0.150–0.153: the older output chunk name.
  const T = stubTHREE();
  delete T.ShaderChunk;
  const c = new DepthCursor(T, { canvas: stubCanvas(), hitTest });
  c.setPointer(0.5, 0.5);
  for (let i = 0; i < 30; i++) c.update(views, 1000 + i * 16);
  assert.match(c.object.material.fragmentShader, /#include <encodings_fragment>/);
  assert.throws(() => new DepthCursor(stubTHREE(), { canvas: stubCanvas(), hitTest, soften: 'nope' }), /cursor\.soften/);
});

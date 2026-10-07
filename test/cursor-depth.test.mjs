// Tests for the depth-aware cursor — the placement maths (./cursor-depth, a port of the
// runtime's u_cursor_depth, ADR-046) and ./three's DepthCursor glue.
//
// The views are built the way the runtime builds them — off-axis frusta from each eye onto one
// physical canvas — and handed over as XRViews carry them (column-major projection + transform
// matrices). The numbers deliberately match the runtime's tests_aux_cursor_depth.cpp, so the web
// and native cursors cannot drift apart unnoticed.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CURSOR_DEFAULT_TUNING as T,
  CURSOR_DEFAULT_HEIGHT,
  CursorDepthPlacer,
  cursorFilterStep,
  cursorPointDisparity,
  cursorTarget,
  placeCursor,
  solveCursorGeometry,
} from '../js/inline3d-cursor-depth.js';
import { DepthCursor } from '../js/inline3d-three.js';

const W = 0.3; // canvas width, m
const H = 0.2; // canvas height, m

const near = (a, b, eps = 1e-5, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} != ${b}`);
const near3 = (a, b, eps = 1e-5) => a.forEach((x, i) => near(x, b[i], eps, `[${i}]`));

/** Column-major rigid transform from a unit quaternion + position, with optional uniform scale s. */
function transform(q = [0, 0, 0, 1], p = [0, 0, 0], s = 1) {
  const [x, y, z, w] = q;
  return [
    (1 - 2 * (y * y + z * z)) * s, 2 * (x * y + z * w) * s, 2 * (x * z - y * w) * s, 0,
    2 * (x * y - z * w) * s, (1 - 2 * (x * x + z * z)) * s, 2 * (y * z + x * w) * s, 0,
    2 * (x * z + y * w) * s, 2 * (y * z - x * w) * s, (1 - 2 * (x * x + y * y)) * s, 0,
    p[0], p[1], p[2], 1,
  ];
}
const apply = (m, v) => [
  m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
  m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
  m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14],
];

/** Off-axis view from a display-space eye onto the W×H canvas at z = 0, carried by `world`. */
function kooima(eye, world = transform()) {
  const d = eye[2];
  const l = (-W / 2 - eye[0]) / d, r = (W / 2 - eye[0]) / d;
  const u = (H / 2 - eye[1]) / d, dn = (-H / 2 - eye[1]) / d;
  const n = 0.01, f = 100;
  const proj = [
    2 / (r - l), 0, 0, 0,
    0, 2 / (u - dn), 0, 0,
    (r + l) / (r - l), (u + dn) / (u - dn), -(f + n) / (f - n), -1,
    0, 0, (-2 * f * n) / (f - n), 0,
  ];
  // The view's transform: the world transform's rotation (and scale), the eye carried through it.
  const t = world.slice();
  const pe = apply(world, eye);
  t[12] = pe[0]; t[13] = pe[1]; t[14] = pe[2];
  return { projectionMatrix: proj, transformMatrix: t };
}

test('cursor-depth: the canvas point under the cursor is where the view rays meet', () => {
  const g = solveCursorGeometry(kooima([-0.032, 0, 0.6]), kooima([0.032, 0, 0.6]), 0.25, 0.75);
  assert.ok(g);
  near3(g.canvasPoint, [-W / 2 + 0.25 * W, H / 2 - 0.75 * H, 0]);
  near3(g.eye, [0, 0, 0.6]);
  near(g.eyeToCanvas, 0.6);
  near(g.canvasHeight, H);
});

test('cursor-depth: off-axis, unequal-depth eyes still find the canvas point', () => {
  const g = solveCursorGeometry(kooima([0.05, 0.03, 0.55]), kooima([0.11, 0.045, 0.57]), 0.9, 0.1);
  near3(g.canvasPoint, [-W / 2 + 0.9 * W, H / 2 - 0.1 * H, 0]);
  near(g.canvasHeight, H);
});

test('cursor-depth: disparity in eye-baseline units — 0 on the canvas, -1 halfway to the eye', () => {
  const g = solveCursorGeometry(kooima([-0.032, 0, 0.6]), kooima([0.032, 0, 0.6]), 0.5, 0.5);
  near(cursorPointDisparity(g, [0, 0, 0]), 0);
  near(cursorPointDisparity(g, [0, 0, 0.3]), -1);
  near(cursorPointDisparity(g, [0.05, -0.02, 0.3]), -1);
  near(cursorPointDisparity(g, [0, 0, -0.6]), 0.5);
  assert.equal(cursorPointDisparity(g, [0, 0, 0.9]), null);
});

test('cursor-depth: placement sits on the cyclopean ray and keeps its apparent size', () => {
  const g = solveCursorGeometry(kooima([-0.032, 0, 0.6]), kooima([0.032, 0, 0.6]), 0.25, 0.75);
  const p = placeCursor(g, -1, 0.05);
  near3(p.position, [g.canvasPoint[0] / 2, g.canvasPoint[1] / 2, 0.3]);
  near(p.height, 0.05 * H * 0.5);
  near(placeCursor(g, 0, 0).height, CURSOR_DEFAULT_HEIGHT * H);
  near(cursorPointDisparity(g, placeCursor(g, -0.37, 0.05).position), -0.37);
});

test('cursor-depth: invariant under a rigid transform + 12.5x scale (camera rigs)', () => {
  const h = 0.35, n = Math.hypot(0.3, 1, 0.2);
  const q = [(Math.sin(h) * 0.3) / n, Math.sin(h) / n, (Math.sin(h) * 0.2) / n, Math.cos(h)];
  const X = transform(q, [3, -1.5, 7], 12.5);
  const g0 = solveCursorGeometry(kooima([-0.032, 0.01, 0.6]), kooima([0.032, 0.01, 0.6]), 0.3, 0.6);
  const g1 = solveCursorGeometry(kooima([-0.032, 0.01, 0.6], X), kooima([0.032, 0.01, 0.6], X), 0.3, 0.6);
  near3(g1.canvasPoint, apply(X, g0.canvasPoint), 1e-6 * 12.5 * 100);
  near(g1.canvasHeight, g0.canvasHeight * 12.5, 1e-6 * 100);
  const p0 = [0.02, -0.03, 0.17];
  near(cursorPointDisparity(g1, apply(X, p0)), cursorPointDisparity(g0, p0), 1e-6);
});

test('cursor-depth: head motion does not move the cursor on the glass', () => {
  const onGlass = (eye, p) => {
    const k = eye[2] / (eye[2] - p[2]);
    return [eye[0] + (p[0] - eye[0]) * k, eye[1] + (p[1] - eye[1]) * k];
  };
  let ref = null;
  for (const h of [[0, 0, 0.6], [0.12, -0.05, 0.5], [-0.2, 0.08, 0.75]]) {
    const el = [h[0] - 0.032, h[1], h[2]], er = [h[0] + 0.032, h[1], h[2]];
    const g = solveCursorGeometry(kooima(el), kooima(er), 0.3, 0.4);
    const c = placeCursor(g, -0.4, 0.03).position;
    const sl = onGlass(el, c), sr = onGlass(er, c);
    near(sr[0] - sl[0], 0.064 * -0.4);
    near(sr[1], sl[1]);
    if (ref) { near3(sl, ref[0]); near3(sr, ref[1]); } else ref = [sl, sr];
  }
});

test('cursor-depth: degenerate input is null, never garbage', () => {
  const mono = kooima([0, 0, 0.6]);
  assert.equal(solveCursorGeometry(mono, mono, 0.5, 0.5), null);
  const a = kooima([-0.032, 0, 0.6]), b = kooima([0.032, 0, 0.6]);
  assert.equal(solveCursorGeometry(a, b, -0.01, 0.5), null);
  assert.equal(solveCursorGeometry(a, b, 0.5, NaN), null);
});

test('cursor-depth: target = content minus margin, clamped; nothing under it = the canvas', () => {
  assert.equal(cursorTarget(T, false, -0.4), 0);
  near(cursorTarget(T, true, -0.2), -0.2 - T.margin);
  assert.equal(cursorTarget(T, true, -5), T.minDisparity);
  assert.equal(cursorTarget(T, true, 0.95), T.maxDisparity);
});

test('cursor-depth: the filter rises fast and sinks slowly, and re-primes after a gap', () => {
  const f = {};
  assert.equal(cursorFilterStep(f, T, -0.3, 1.0), -0.3);
  assert.ok(cursorFilterStep(f, T, 0, 1.03) < -0.25);
  const g = {};
  cursorFilterStep(g, T, 0, 1.0);
  const d = cursorFilterStep(g, T, -0.3, 1.03);
  near(d, -0.3 * (1 - Math.exp(-1)), 1e-4);
  assert.equal(cursorFilterStep(g, T, 0.5, 1.03), d);
  assert.equal(cursorFilterStep(g, T, 0.1, 2.0), 0.1);
});

test('cursor-depth: CursorDepthPlacer accepts XRView-shaped views and is inactive in 2D', () => {
  const a = kooima([-0.032, 0, 0.6]), b = kooima([0.032, 0, 0.6]);
  const xr = (v) => ({ projectionMatrix: v.projectionMatrix, transform: { matrix: v.transformMatrix } });
  const placer = new CursorDepthPlacer();
  const p = placer.update([xr(a), xr(b)], { u: 0.5, v: 0.5, nearestPoint: [0, 0, 0.1] }, 1);
  assert.equal(p.active, true);
  near(p.targetDisparity, 1 - 0.6 / 0.5 - T.margin);
  assert.equal(placer.update([xr(a)], { u: 0.5, v: 0.5, nearestPoint: null }, 2).active, false);
});

// ── DepthCursor (three.js glue) against a recording stub ───────────────────────────────────

function stubTHREE() {
  class Mat { constructor(o) { Object.assign(this, o); } dispose() { this.disposed = true; } }
  class Geom { setAttribute(k, v) { this[k] = v; } dispose() { this.disposed = true; } }
  return {
    BufferGeometry: Geom,
    Float32BufferAttribute: class { constructor(a, n) { this.array = a; this.itemSize = n; } },
    LineBasicMaterial: Mat,
    LineSegments: class {
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
    style: { cursor: 'crosshair' },
    handlers,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 200 }),
    addEventListener(k, f) { handlers[k] = f; },
    removeEventListener(k) { delete handlers[k]; },
  };
}

test('DepthCursor: rises in front of what it hovers, hides the CSS cursor, and gives it back', () => {
  const canvas = stubCanvas();
  // Content: a plane at z = 0.1 (in front of the glass) covering the left half of the canvas.
  const hitTest = (o, d) => {
    if (d[2] >= 0) return null;
    const t = (0.1 - o[2]) / d[2];
    const p = [o[0] + d[0] * t, o[1] + d[1] * t, 0.1];
    return p[0] < 0 ? p : null;
  };
  const cur = new DepthCursor(stubTHREE(), { canvas, hitTest });
  const views = [kooima([-0.032, 0, 0.6]), kooima([0.032, 0, 0.6])];

  // No pointer yet: inactive, CSS cursor untouched.
  assert.equal(cur.update(views, 1000).active, false);
  assert.equal(canvas.style.cursor, 'crosshair');

  // Over the content: in front of z = 0.1 by the margin, CSS cursor hidden.
  canvas.handlers.pointermove({ clientX: 75, clientY: 100 }); // u = 0.25
  const p = cur.update(views, 1016);
  assert.equal(p.active, true);
  assert.equal(cur.object.visible, true);
  near(p.targetDisparity, 1 - 0.6 / 0.5 - T.margin);
  assert.ok(p.position[2] > 0.1, 'sprite is in front of the content');
  assert.equal(canvas.style.cursor, 'none');

  // Off the content (right half): back on the glass.
  cur.setPointer(0.75, 0.5);
  assert.equal(cur.update(views, 1032).targetDisparity, 0);

  // The footprint, not the hotspot: just right of the content edge still sees it.
  cur.setPointer(0.505, 0.5);
  assert.ok(cur.update(views, 1048).targetDisparity < 0, 'a nearer edge within the footprint counts');

  // 2D (one view): inactive, CSS cursor restored.
  assert.equal(cur.update([views[0]], 1064).active, false);
  assert.equal(cur.object.visible, false);
  assert.equal(canvas.style.cursor, 'crosshair');

  // Leaving the canvas deactivates; dispose removes listeners and restores the cursor.
  cur.update(views, 1080);
  canvas.handlers.pointerleave();
  assert.equal(cur.update(views, 1096).active, false);
  cur.dispose();
  assert.equal(canvas.handlers.pointermove, undefined);
  assert.equal(canvas.style.cursor, 'crosshair');
});

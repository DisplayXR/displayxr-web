// The depth cursor on a stereo PAIR (js/camera/pair-cursor.js): runtime ADR-046 Phase 3b done in
// the page, for call tiles and camera views. What is pinned:
//   - the footprint match reads the NEAREST content under the sprite, in the displayed buffer's
//     pixels: the crop offset of each eye (convergence) is taken out, the output scale applied;
//   - a mirrored view flips the pointer, never the disparity;
//   - the policy is the shared core's (ADR-046 Amendment 2), not a copy: the target is cursorTarget
//     on the content's disparity in eye baselines, converted through the panel's pixel pitch
//     (displayMetrics) × the eye separation; margin 0.015 baselines; the draw threshold
//     (cursorShouldDraw: −0.005 baselines and ≥ 0.5 px) decides when the arrow is drawn;
//   - the cursor never goes INSIDE the display: content on or behind the glass → the plane; only
//     content that comes out moves it;
//   - it is the normal arrow: two copies ± half the disparity about the pointer, crossed = in front;
//   - on the plane nothing is drawn and the OS cursor shows; it is hidden only while the drawn arrow
//     replaces it; the filter rises fast and hands back to the OS arrow as the content sinks;
//   - opt-in: no option → no cursor object, no module import, the CSS cursor untouched.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { installCallDom, doc, FakeTrack, FakeStream } from './call-dom.mjs';
import { pairFootprintDisparity, pairCursorTarget, pairCursorScale, pairPxPerBaseline, drawPairArrow, PairCursor, PAIR_CURSOR_CSS_PX_M, PAIR_CURSOR_HEIGHT, PAIR_CURSOR_ARROW } from '../js/camera/pair-cursor.js';
import { CURSOR_DEFAULT_TUNING as T, CURSOR_ARROW, cursorTarget, cursorShouldDraw } from '../js/inline3d-cursor-depth.js';
import { DISPLAY_METRICS_DEFAULTS } from '../js/inline3d-display-metrics.js';
import { resolvePairCursorOption } from '../js/inline3d-cursor-option.js';
import { normalizeCallOptions as normalizeOptions } from '../js/call/options.js';
import { attrsToOpts } from '../js/call/element.js';

installCallDom();
// pointerScope 'window' listens on the window; node has none.
globalThis.addEventListener ??= () => {};
globalThis.removeEventListener ??= () => {};
const { openCamera, addCameraView } = await import('../js/inline3d-camera.js');

/**
 * A W×H SBS luma frame: a random texture whose right eye is the left shifted so that content at
 * column x of the left eye sits at x − d(x, y) in the right eye (d > 0 = crossed). `dAt` gives d.
 */
function sbs(E, H, dAt, seed = 7) {
  const W = 2 * E;
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  // A world texture wide enough to sample from both eyes; blocks of 2 px so matching is crisp.
  const tex = new Uint8Array((E + 64) * H);
  for (let y = 0; y < H; y += 2) for (let x = 0; x < E + 64; x += 2) {
    const v = 20 + Math.floor(rnd() * 210);
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) if (y + dy < H && x + dx < E + 64) tex[(y + dy) * (E + 64) + x + dx] = v;
  }
  const img = new Uint8Array(W * H);
  const T = (y, x) => (x >= -32 && x < E + 32 ? tex[y * (E + 64) + x + 32] : 0);
  for (let y = 0; y < H; y++) {
    // d is a property of the LEFT eye's content: left column x reappears at x − d in the right
    // eye. Splat far → near so the nearer surface occludes, the way a real pair does; start from
    // the far content so disocclusions are filled.
    const cols = [];
    let dFar = Infinity;
    for (let x = -32; x < E + 32; x++) {
      const d = dAt(Math.max(0, Math.min(E - 1, x)), y);
      cols.push([x, d]);
      dFar = Math.min(dFar, d);
    }
    for (let x = 0; x < E; x++) {
      img[y * W + x] = T(y, x);
      img[y * W + E + x] = T(y, x + dFar);
    }
    cols.sort((a, b) => a[1] - b[1]);
    for (const [x, d] of cols) {
      const xr = x - d;
      if (xr >= 0 && xr < E) img[y * W + E + xr] = T(y, x);
    }
  }
  return { img, w: W, h: H, scale: 1 };
}

const E = 240;
const H = 135;
const full = { sx: 0, sy: 0, sw: E, sh: H };

test('footprint disparity: a uniform pair reads its disparity in output px', () => {
  const luma = sbs(E, H, () => 10);
  const d = pairFootprintDisparity(luma, { rL: full, rR: full, outW: E }, 0.5, 0.5, PAIR_CURSOR_HEIGHT, E / H);
  assert.ok(d !== null && Math.abs(d - 10) < 0.6, `≈10 px crossed, got ${d}`);
});

test('footprint disparity: the convergence crop is taken out, and the output scale applied', () => {
  const luma = sbs(E, H, () => 10);
  // The left eye's crop starts 4 source px further right than the right eye's: displayed 10 − 4.
  const rL = { sx: 4, sy: 0, sw: E - 8, sh: H };
  const rR = { sx: 0, sy: 0, sw: E - 8, sh: H };
  const d = pairFootprintDisparity(luma, { rL, rR, outW: E - 8 }, 0.5, 0.5, PAIR_CURSOR_HEIGHT, E / H);
  assert.ok(Math.abs(d - (10 - 4)) < 0.6, `source 10, crops 4 apart → 6, got ${d}`);
  // Output twice the source eye width → disparities double.
  const d2 = pairFootprintDisparity(luma, { rL: full, rR: full, outW: 2 * E }, 0.5, 0.5, PAIR_CURSOR_HEIGHT, E / H);
  assert.ok(Math.abs(d2 - 20) < 1.2, `×2 output → ≈20, got ${d2}`);
  // A source copy at half resolution reads the same displayed disparity.
  const half = sbs(E / 2, Math.round(H / 2), () => 5);
  const d3 = pairFootprintDisparity({ ...half, scale: 0.5 }, { rL: full, rR: full, outW: E }, 0.5, 0.5, PAIR_CURSOR_HEIGHT, E / H);
  assert.ok(Math.abs(d3 - 10) < 1.2, `half-res copy, 5 copy px = 10 source px, got ${d3}`);
});

test('footprint disparity: the NEAREST content under the footprint wins (an edge beside the hotspot)', () => {
  // A near object (d = 16) on the right of x = 126, background d = 4 elsewhere.
  const luma = sbs(E, H, (x) => (x >= 126 ? 16 : 4));
  const d = pairFootprintDisparity(luma, { rL: full, rR: full, outW: E }, 0.5, 0.5, 0.1, E / H);
  assert.ok(Math.abs(d - 16) < 0.6, `hotspot over the background, footprint reaches the near edge → 16, got ${d}`);
  const far = pairFootprintDisparity(luma, { rL: full, rR: full, outW: E }, 0.2, 0.5, 0.1, E / H);
  assert.ok(Math.abs(far - 4) < 0.6, `well clear of it → the background, got ${far}`);
});

test('footprint disparity: a mirrored view flips the pointer, never the disparity', () => {
  const luma = sbs(E, H, (x) => (x < 80 ? 14 : 3));
  const geo = { rL: full, rR: full, outW: E };
  const plain = pairFootprintDisparity(luma, geo, 0.15, 0.5, 0.05, E / H);
  const mirrored = pairFootprintDisparity(luma, { ...geo, mirror: true }, 0.85, 0.5, 0.05, E / H);
  assert.ok(Math.abs(plain - 14) < 0.6, `left side is near: ${plain}`);
  assert.ok(Math.abs(mirrored - 14) < 0.6, `the same content, seen at the mirrored pointer, still crossed: ${mirrored}`);
});

test('footprint disparity: nothing to match (flat frame, no copy) → null; target is then the glass', () => {
  const flat = { img: new Uint8Array(2 * E * H).fill(128), w: 2 * E, h: H, scale: 1 };
  assert.equal(pairFootprintDisparity(flat, { rL: full, rR: full, outW: E }, 0.5, 0.5, 0.06, E / H), null);
  assert.equal(pairFootprintDisparity(null, { rL: full, rR: full, outW: E }, 0.5, 0.5, 0.06, E / H), null);
  assert.equal(pairCursorTarget(null, 100), 0);
});

test('target: the core policy in px — content that comes out + 0.015 baselines (clamped); never behind the glass', () => {
  const k = 100; // output px of on-screen disparity per eye baseline
  assert.ok(Math.abs(pairCursorTarget(10, k) - (10 + 0.015 * k)) < 1e-9, 'the margin is 0.015 baselines');
  assert.ok(Math.abs(pairCursorTarget(500, k) - -T.minDisparity * k) < 1e-9, 'clamped at the core minDisparity');
  assert.equal(pairCursorTarget(0, k), 0, 'content on the glass: the plane');
  assert.equal(pairCursorTarget(-3, k), 0, 'content behind the glass: the cursor stays on the plane, never inside');
  assert.equal(pairCursorTarget(-500, k), 0);
  // Property: the same numbers as the core, and never behind the glass, for any content.
  let s = 3;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 500; i++) {
    const c = (rnd() - 0.5) * 200, kk = 5 + rnd() * 400;
    const t = pairCursorTarget(c, kk);
    assert.ok(t >= 0, `never behind the glass (${c} px → ${t})`);
    if (c <= 0) assert.equal(t, 0);
    assert.ok(Math.abs(t - -cursorTarget(T, true, -c / kk) * kk) < 1e-9, 'driven by the core');
  }
  // A tuning passes straight through: the margin is the core's, not a local copy.
  assert.ok(Math.abs(pairCursorTarget(10, k, { ...T, margin: 0.1 }) - 20) < 1e-9);
});

test('units: baseline ↔ px through the panel pixel pitch (displayMetrics) and the tile scale', () => {
  // A 640-px buffer eye stretched over a 320-CSS-px tile on a panel where 1 CSS px = 0.225 mm:
  // 2 mm = 8.89 CSS px = 17.8 buffer px.
  const s = pairCursorScale(640, 320, 0.000225);
  assert.ok(Math.abs(0.002 * s - (0.002 / 0.000225) * 2) < 1e-9);
  assert.equal(pairCursorScale(640, 320, null), 2 / PAIR_CURSOR_CSS_PX_M, 'unknown pitch → the CSS reference px');
  // The margin, 0.015 of a 63 mm eye separation = 0.945 mm on the glass.
  const k = pairPxPerBaseline(640, 320, 0.000225);
  assert.ok(Math.abs(k - s * DISPLAY_METRICS_DEFAULTS.eyeSeparationM) < 1e-9);
  assert.ok(Math.abs(pairCursorTarget(1e-9, k) / s - 0.015 * 0.063) < 1e-9, 'margin ≈ 0.95 mm on the glass');
});

/** A 2D context that records each filled path (the arrow's outline, then its fill). */
function recordingCtx() {
  const ops = [];
  let path = [];
  return {
    ops,
    save() {}, restore() {}, rect() {}, clip() {}, closePath() {}, stroke() {},
    beginPath() { path = []; },
    moveTo(x, y) { path.push([x, y]); },
    lineTo(x, y) { path.push([x, y]); },
    fill() { ops.push({ fill: this.fillStyle, pts: path.slice() }); },
  };
}

test('arrow: the normal pointer arrow, tip at the hotspot; left copy +d/2, right copy −d/2 (crossed = in front)', () => {
  const g = recordingCtx();
  drawPairArrow(g, 400, 300, 0.25, 0.5, 12, 19);
  assert.equal(g.ops.length, 4, 'per eye: the dark outline, then the white fill');
  const [l, lf, r] = g.ops;
  assert.equal(l.fill, '#000', 'dark outline');
  assert.equal(lf.fill, '#fff', 'white fill, like the OS arrow');
  assert.equal(PAIR_CURSOR_ARROW, CURSOR_ARROW, "the core's arrow, not a copy");
  assert.equal(l.pts.length, CURSOR_ARROW.length);
  assert.deepEqual(l.pts[0], [100 + 6, 150], 'left eye: the tip at 0.25·400 + 6, on the hotspot row');
  assert.deepEqual(r.pts[0], [400 + 100 - 6, 150], 'right eye: its half, 0.25·400 − 6');
  const h = Math.max(...l.pts.map((p) => p[1])) - 150;
  assert.ok(h > 18 && h <= 19, `19 px tall, hanging down from the tip (${h})`);
  assert.ok(Math.min(...l.pts.map((p) => p[0])) === 106, 'nothing left of the tip: it points up-left like the OS arrow');
});

test('PairCursor: the OS arrow on the plane; the drawn arrow only over content that comes out; rises fast, sinks back', () => {
  const canvas = doc.createElement('canvas');
  canvas.style = { cursor: 'pointer' };
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 384, height: 216 });
  const cur = new PairCursor(canvas, { pointerScope: 'canvas' });
  const geo = { rL: full, rR: full, outW: E, outH: H };
  const near = sbs(E, H, () => 12);
  const behind = sbs(E, H, () => -6, 5);
  const g = recordingCtx();
  assert.equal(cur.hovering, false);
  assert.equal(cur.draw(g, near, geo, 1), null, 'no pointer → nothing drawn');
  assert.equal(g.ops.length, 0);
  assert.equal(canvas.style.cursor, 'pointer', 'the CSS cursor is untouched while not drawing');
  cur.pointer.set(0.5, 0.5);
  // Over content behind the glass: nothing drawn, the OS arrow stays.
  const pb = cur.draw(g, behind, geo, 1);
  assert.equal(pb.drawn, false);
  assert.equal(pb.disparityPx, 0);
  assert.equal(g.ops.length, 0, 'nothing drawn into the pair');
  assert.equal(canvas.style.cursor, 'pointer', 'the OS arrow is the cursor on the plane');
  // Content comes out: the drawn arrow replaces it, in front of that content, within a frame or two.
  const p0 = cur.draw(g, near, geo, 1.1);
  const p0b = cur.draw(g, near, geo, 1.2);
  assert.equal(p0b.drawn, true);
  assert.equal(canvas.style.cursor, 'none', 'the drawn arrow replaces the OS arrow');
  const k = pairPxPerBaseline(E, 384, null);
  assert.ok(Math.abs(p0b.pxPerBaseline - k) < 1e-9, 'px ↔ baselines through the tile scale (CSS reference px before displayMetrics answers)');
  assert.ok(Math.abs(p0b.disparityPx - pairCursorTarget(12, k)) < 0.6, `caught up within ~100 ms (${p0.disparityPx} → ${p0b.disparityPx})`);
  assert.ok(Math.abs(p0b.targetPx - (12 + 0.015 * k)) < 0.6, 'content + 0.015 baselines');
  const tipX = g.ops.at(-4).pts[0][0];
  assert.ok(Math.abs(tipX - (0.5 * E + p0b.disparityPx / 2)) < 1e-9, 'left copy +d/2 about the hotspot');
  assert.equal(g.ops.at(-4).pts[0][1], 0.5 * H, 'the TIP is on the hotspot row');
  const sz = Math.max(...g.ops.at(-4).pts.map((p) => p[1])) - 0.5 * H;
  assert.ok(Math.abs(sz - (19 / 216) * H * (18.6 / 19)) < 0.01, `the OS arrow's size: 19 CSS px of a 216-px tile (${sz})`);
  // Content sinks back behind the glass: the arrow follows slowly, then hands back to the OS arrow
  // exactly at the core's draw threshold.
  const p1 = cur.draw(g, behind, geo, 1.25);
  assert.equal(p1.drawn, true, '50 ms later it is still in front (slow sink, no flicker)');
  let pn = p1;
  let belowButOut = 0;
  for (let t = 1.3; t < 3.0; t += 0.02) {
    pn = cur.draw(g, behind, geo, t);
    assert.equal(pn.drawn, cursorShouldDraw(-pn.filteredPx / k, k), `drawn ⇔ the core threshold (${pn.filteredPx} px)`);
    if (!pn.drawn && pn.filteredPx > 1e-3) belowButOut++;
  }
  assert.ok(belowButOut > 0, 'still slightly in front, but under the threshold: not drawn');
  assert.equal(pn.drawn, false, 'settled: back to the OS arrow on the plane');
  assert.equal(canvas.style.cursor, 'pointer');
  cur.pointer.set(null);
  assert.equal(cur.draw(g, near, geo, 3.1), null);
  assert.equal(canvas.style.cursor, 'pointer', 'pointer gone → the CSS cursor as it was');
  cur.dispose();
});

test('options: off by default; `depth` / an object turn it on; scene-only keys are refused', () => {
  assert.equal(resolvePairCursorOption(undefined), null);
  assert.equal(resolvePairCursorOption(false), null);
  assert.deepEqual(resolvePairCursorOption('depth'), {});
  assert.deepEqual(resolvePairCursorOption({ height: 0.08 }), { height: 0.08 });
  assert.throws(() => resolvePairCursorOption({ anchor: 'world' }), /not supported on a stereo pair/);
  assert.throws(() => resolvePairCursorOption({ margin: 0.01 }), /not supported on a stereo pair/);
  assert.throws(() => resolvePairCursorOption('laser'), /expected 'depth'/);
  assert.equal(normalizeOptions({}).cursor, null, 'the call default is off');
  assert.deepEqual(normalizeOptions({ cursor: 'depth' }).cursor, {});
  assert.equal(attrsToOpts((n) => (n === 'cursor' ? 'depth' : null)).cursor, 'depth', '<dxr-call cursor="depth">');
  assert.equal(attrsToOpts(() => null).cursor, undefined);
});

test('opt-in: a camera view without `cursor` builds nothing and imports nothing; with it, the cursor arrives', async () => {
  const wall = { supported: true, addImage: () => ({ remove() {} }) };
  const cam = await openCamera({ prefer: new FakeStream([Object.assign(new FakeTrack('video'), { getSettings: () => ({ width: 1280, height: 480 }) })]), format: 'sbs' });
  const off = addCameraView(wall, doc.createElement('canvas'), cam);
  assert.equal(off.cursor, null);
  assert.equal(off._cursorOpt, null);
  off.remove();
  const on = addCameraView(wall, doc.createElement('canvas'), cam, { cursor: 'depth' });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(on.cursor instanceof PairCursor, 'the module loads on opt-in');
  on.remove();
  assert.equal(on.cursor, null, 'remove() disposes it');
  assert.throws(() => addCameraView(wall, doc.createElement('canvas'), cam, { cursor: { anchor: 'world' } }), /not supported on a stereo pair/);
  cam.close();
  // Structural: the pair cursor is reached only through a dynamic import.
  for (const f of ['../js/inline3d-camera.js', '../js/inline3d-call.js']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.ok(!/^\s*import\s[^;]*pair-cursor/m.test(src), `${f}: no static import of the pair cursor`);
    assert.match(src, /import\('\.\/camera\/pair-cursor\.js'\)/, `${f}: loads it on opt-in`);
  }
});

test('PairCursor: the panel pixel pitch from the tile handle (displayMetrics) sets the px scale', async () => {
  const canvas = doc.createElement('canvas');
  canvas.style = { cursor: '' };
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 384, height: 216 });
  const cur = new PairCursor(canvas, { pointerScope: 'canvas' });
  cur.pointer.set(0.5, 0.5);
  const handle = { displayMetrics: async () => ({ metersPerCssPx: 0.0002, eyeSeparationM: 0.063 }) };
  const geo = { rL: full, rR: full, outW: E, outH: H, handle };
  const g = recordingCtx();
  const p0 = cur.draw(g, sbs(E, H, () => 12), geo, 1);
  assert.ok(Math.abs(p0.pxPerBaseline - pairPxPerBaseline(E, 384, null)) < 1e-9, 'before it answers: the CSS reference px');
  await new Promise((r) => setTimeout(r, 0));
  const p1 = cur.draw(g, sbs(E, H, () => 12), geo, 1.016);
  assert.ok(Math.abs(p1.pxPerBaseline - pairPxPerBaseline(E, 384, 0.0002, 0.063)) < 1e-9, 'after: the panel pitch');
  cur.dispose();
});

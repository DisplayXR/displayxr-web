// The depth cursor on a stereo PAIR (js/camera/pair-cursor.js): runtime ADR-046 Phase 3b done in
// the page, for call tiles and camera views. What is pinned:
//   - the footprint match reads the NEAREST content under the sprite, in the displayed buffer's
//     pixels: the crop offset of each eye (convergence) is taken out, the output scale applied;
//   - a mirrored view flips the pointer, never the disparity;
//   - nothing matched → the display plane; margin + clamp on the target;
//   - the crosshair's two copies sit ± half the disparity about the pointer, crossed = in front;
//   - the controller hides the CSS cursor only while it draws, and the filter rises fast;
//   - opt-in: no option → no cursor object, no module import, the CSS cursor untouched.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { installCallDom, doc, FakeTrack, FakeStream } from './call-dom.mjs';
import { pairFootprintDisparity, pairCursorTarget, drawPairCrosshair, PairCursor, PAIR_CURSOR_MARGIN, PAIR_CURSOR_CLAMP, PAIR_CURSOR_HEIGHT } from '../js/camera/pair-cursor.js';
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
  assert.equal(pairCursorTarget(null, 640), 0);
});

test('target: content plus the margin (crossed), clamped both ways', () => {
  const W = 640;
  assert.equal(pairCursorTarget(10, W), 10 + PAIR_CURSOR_MARGIN * W);
  assert.equal(pairCursorTarget(-3, W), -3 + PAIR_CURSOR_MARGIN * W, 'content behind the glass: the cursor settles onto it');
  assert.equal(pairCursorTarget(500, W), PAIR_CURSOR_CLAMP * W);
  assert.equal(pairCursorTarget(-500, W), -PAIR_CURSOR_CLAMP * W);
});

/** A 2D context that records the crosshair segments' x span per stroke batch. */
function recordingCtx() {
  const ops = [];
  let path = [];
  return {
    ops,
    save() {}, restore() {}, rect() {}, clip() {},
    beginPath() { path = []; },
    moveTo(x, y) { path.push([x, y]); },
    lineTo(x, y) { path.push([x, y]); },
    stroke() { ops.push({ width: this.lineWidth, pts: path.slice() }); },
  };
}
const centreX = (pts) => (Math.min(...pts.map((p) => p[0])) + Math.max(...pts.map((p) => p[0]))) / 2;

test('crosshair: left copy +d/2, right copy −d/2 about the pointer (crossed = in front); outline then fill', () => {
  const g = recordingCtx();
  drawPairCrosshair(g, 400, 300, 0.25, 0.5, 12, 0.1);
  assert.equal(g.ops.length, 4, 'two eyes × (outline, fill)');
  const [lo, lf, ro, rf] = g.ops;
  assert.ok(lo.width > lf.width, 'the dark outline is drawn first and wider');
  assert.equal(centreX(lf.pts), 100 + 6, 'left eye: 0.25·400 + 6');
  assert.equal(centreX(rf.pts), 400 + 100 - 6, 'right eye: its half, 0.25·400 − 6');
  assert.equal(centreX(ro.pts), centreX(rf.pts));
});

test('PairCursor: draws only while hovered, hides the CSS cursor meanwhile, rises fast and sinks slowly', () => {
  const canvas = doc.createElement('canvas');
  canvas.style = { cursor: 'crosshair' };
  const cur = new PairCursor(canvas, { pointerScope: 'canvas' });
  const geo = { rL: full, rR: full, outW: E, outH: H };
  const near = sbs(E, H, () => 12);
  const g = recordingCtx();
  assert.equal(cur.hovering, false);
  assert.equal(cur.draw(g, near, geo, 1), null, 'no pointer → nothing drawn');
  assert.equal(g.ops.length, 0);
  assert.equal(canvas.style.cursor, 'crosshair', 'the CSS cursor is untouched while not drawing');
  cur.pointer.set(0.5, 0.5);
  const p0 = cur.draw(g, near, geo, 1);
  assert.equal(g.ops.length, 4);
  assert.equal(canvas.style.cursor, 'none', 'the sprite replaces the CSS cursor');
  assert.ok(Math.abs(p0.disparityPx - pairCursorTarget(12, E)) < 0.6, 'the first frame snaps to the target');
  // Content drops back to the glass: the sprite sinks slowly…
  const flat = sbs(E, H, () => 0, 3);
  const p1 = cur.draw(g, flat, geo, 1.05);
  assert.ok(p1.disparityPx > p1.targetPx + 5, `50 ms later it is still well in front (${p1.disparityPx} vs ${p1.targetPx})`);
  // …and comes forward fast.
  const p2 = cur.draw(g, near, geo, 1.1);
  const p3 = cur.draw(g, near, geo, 1.2);
  assert.ok(p3.targetPx - p3.disparityPx < 0.2 * (p2.targetPx - p1.disparityPx) + 0.5, 'within ~100 ms it has caught up');
  cur.pointer.set(null);
  assert.equal(cur.draw(g, near, geo, 1.3), null);
  assert.equal(canvas.style.cursor, 'crosshair', 'pointer gone → the CSS cursor is back');
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

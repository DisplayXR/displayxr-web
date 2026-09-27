// Auto-convergence (js/call/disparity.js + the measured branch of createConvergence): synthetic SBS
// pairs with KNOWN disparities. d = left x − right x; positive = in front of the display plane.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  measureFocusDisparity,
  nearestMode,
  blockDisparities,
  createDisparityTrack,
  lumaFromRgba,
  createFocusTracker,
} from '../js/call/disparity.js';
import { createConvergence, clampShift, convergenceShiftPx } from '../js/call/wire.js';

/** Deterministic texture: a value per (x, y) in 4-px cells, seeded. */
function texture(seed) {
  return (x, y) => {
    let h = (Math.floor(x / 4) * 73856093) ^ (Math.floor(y / 4) * 19349663) ^ (seed * 83492791);
    h = (h ^ (h >>> 13)) * 1274126177;
    return 40 + (((h ^ (h >>> 16)) >>> 0) % 176);
  };
}

/**
 * A SBS gray image. `layers` are drawn back to front: { d, tex, inside(x, y) } where inside() is in
 * LEFT-eye coordinates (null = everywhere). The right eye sees each layer shifted left by d.
 */
function sbs(E, H, layers) {
  const W = 2 * E;
  const img = new Uint8Array(W * H);
  for (let eye = 0; eye < 2; eye++) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < E; x++) {
        let v = 128;
        for (const L of layers) {
          const xl = eye === 0 ? x : x + L.d; // the left-eye point this right-eye pixel shows
          if (!L.inside || L.inside(xl, y)) v = L.tex(xl, y);
        }
        img[y * W + eye * E + x] = v;
      }
    }
  }
  return { img, W, H };
}

const rect = (x0, y0, x1, y1) => (x, y) => x >= x0 && x < x1 && y >= y0 && y < y1;
const ellipse = (cx, cy, rx, ry) => (x, y) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;

test('the sample pattern: a square 48 px in front of a checkerboard AT the plane → d ≈ 48', () => {
  const E = 240;
  const H = 135;
  const { img, W } = sbs(E, H, [
    { d: 0, tex: texture(1) },
    { d: 48, tex: texture(2), inside: rect(90, 35, 150, 95) },
  ]);
  const m = measureFocusDisparity(img, W, H);
  assert.ok(m, 'measured');
  assert.ok(Math.abs(m.d - 48) <= 1, `d=${m.d}`);
  assert.equal(m.method, 'mode');
});

test('a person: head nearer than the torso, room far behind → the head (eyes) wins', () => {
  const E = 240;
  const H = 180;
  const { img, W } = sbs(E, H, [
    { d: 6, tex: texture(3) }, // the room
    { d: 24, tex: texture(4), inside: rect(60, 110, 180, 180) }, // shoulders / torso
    { d: 30, tex: texture(5), inside: ellipse(120, 70, 38, 50) }, // the head
  ]);
  const m = measureFocusDisparity(img, W, H);
  assert.ok(m);
  assert.ok(Math.abs(m.d - 30) <= 1.5, `d=${m.d}`);
  // The focus lands on the head, in its upper half (the eye line), not on the shoulders.
  assert.ok(m.x > 85 && m.x < 155, `x=${m.x}`);
  assert.ok(m.y > 25 && m.y < 95, `y=${m.y}`);
});

test('a given focus point (a face detector) is measured directly', () => {
  const E = 240;
  const H = 180;
  const { img, W } = sbs(E, H, [
    { d: 6, tex: texture(3) },
    { d: 30, tex: texture(5), inside: ellipse(120, 70, 38, 50) },
  ]);
  const m = measureFocusDisparity(img, W, H, { focus: { x: 120, y: 60 } });
  assert.ok(m);
  assert.equal(m.method, 'focus');
  assert.ok(Math.abs(m.d - 30) <= 1, `d=${m.d}`);
});

test('a small vertical misalignment (raw, unrectified pair) is tolerated', () => {
  const E = 240;
  const H = 135;
  const base = sbs(E, H, [
    { d: 0, tex: texture(1) },
    { d: 40, tex: texture(2), inside: rect(80, 30, 160, 100) },
  ]);
  // Drop the right eye 2 rows.
  const img = new Uint8Array(base.img);
  for (let y = H - 1; y >= 2; y--) img.copyWithin(y * base.W + E, (y - 2) * base.W + E, (y - 2) * base.W + 2 * E);
  const m = measureFocusDisparity(img, base.W, H);
  assert.ok(m);
  assert.ok(Math.abs(m.d - 40) <= 1.5, `d=${m.d}`);
});

test('a flat frame (camera covered, black) measures nothing', () => {
  const E = 240;
  const H = 135;
  const img = new Uint8Array(2 * E * H).fill(12);
  assert.equal(measureFocusDisparity(img, 2 * E, H), null);
});

test('nearestMode: needs a real share of the blocks, not one outlier', () => {
  const blocks = [
    ...Array.from({ length: 20 }, () => ({ d: 5 })),
    ...Array.from({ length: 8 }, () => ({ d: 30 })),
    { d: 60 }, // a single spurious match
  ];
  assert.equal(nearestMode(blocks).d, 30);
  assert.equal(nearestMode([]), null);
});

test('blockDisparities reports positive d for a crossed (in front) layer', () => {
  const E = 160;
  const H = 90;
  const { img, W } = sbs(E, H, [{ d: 12, tex: texture(7) }]);
  const b = blockDisparities(img, W, H);
  assert.ok(b.length > 10);
  const med = b.map((x) => x.d).sort((a, c) => a - c)[b.length >> 1];
  assert.ok(Math.abs(med - 12) <= 0.6, `median ${med}`);
});

test('convergence: a measured disparity d shifts each eye by d/2 and wins over the hint', () => {
  const c = createConvergence();
  c.hello = { hfovDeg: 70, baselineMm: 63 };
  c.subjectZmm = 600; // the formula alone would give ~24 px at 640 wide
  c.measuredPx = 48;
  assert.equal(c.target(640), 24);
  c.depth = 0.5; // the slider stays an offset on top
  assert.ok(c.target(640) > 24);
  c.depth = 0;
  c.measuredPx = null; // no measurement yet → back to the hint formula
  const hinted = convergenceShiftPx({ eyeWidthPx: 640, hfovDeg: 70, baselineMm: 63, subjectZmm: 600 });
  assert.ok(Math.abs(c.target(640) - hinted) < 1e-9, `hint target ${c.target(640)}`);
  // Clamped like any other shift.
  c.measuredPx = 400;
  assert.equal(c.target(640), clampShift(200, 640));
});

test('disparity track: median of the last 3, holds the last value through a failed measurement', () => {
  const t = createDisparityTrack();
  assert.equal(t.push(null), null);
  t.push(40);
  t.push(44);
  assert.equal(t.push(90), 44); // one outlier does not move it
  assert.equal(t.push(null), 44); // a blink: hold
  t.reset();
  assert.equal(t.value, null);
});

test('lumaFromRgba: BT.601-ish weights', () => {
  const y = lumaFromRgba(new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255]), 3);
  assert.equal(y[0], 255);
  assert.equal(y[1], 0);
  assert.ok(y[2] > 70 && y[2] < 80);
});

test('focus tracker: locks with a full search, then follows a moving head cheaply', () => {
  const E = 240;
  const H = 180;
  const frame = (cx, d) =>
    sbs(E, H, [
      { d: 6, tex: texture(3) },
      { d, tex: texture(5), inside: ellipse(cx, 70, 38, 50) },
    ]);
  const tr = createFocusTracker();
  const a = frame(120, 30);
  const m0 = tr.measure(a.img, a.W, H, 0);
  assert.ok(m0 && m0.method === 'mode' && Math.abs(m0.d - 30) <= 1.5, JSON.stringify(m0));
  // The head moves 8 px right (in the left eye; texture follows the head) and 2 px nearer.
  const shifted = (cx, d) =>
    sbs(E, H, [
      { d: 6, tex: texture(3) },
      { d, tex: (x, y) => texture(5)(x - (cx - 120), y), inside: ellipse(cx, 70, 38, 50) },
    ]);
  const b = shifted(128, 32);
  const m1 = tr.measure(b.img, b.W, H, 200);
  assert.ok(m1, 'tracked');
  assert.equal(m1.method, 'track');
  assert.ok(Math.abs(m1.d - 32) <= 1, `d=${m1.d}`);
  // Lost (covered camera) → a full search, which finds nothing → null.
  const flat = new Uint8Array(2 * E * H).fill(10);
  assert.equal(tr.measure(flat, 2 * E, H, 400), null);
});

test('focus tracker: re-runs the full search after fullEveryMs', () => {
  const E = 240;
  const H = 180;
  const f = sbs(E, H, [
    { d: 6, tex: texture(3) },
    { d: 30, tex: texture(5), inside: ellipse(120, 70, 38, 50) },
  ]);
  const tr = createFocusTracker({ fullEveryMs: 1000 });
  assert.equal(tr.measure(f.img, f.W, H, 0).method, 'mode');
  assert.equal(tr.measure(f.img, f.W, H, 500).method, 'track');
  assert.equal(tr.measure(f.img, f.W, H, 1500).method, 'mode');
});

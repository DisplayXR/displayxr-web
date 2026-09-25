// Tests for js/lift/orbit.js — the explore orbit (cap, gain, sign, relax curve, click slop) and
// the camera model ported from the gallery's Spatial View (rig, off-axis frustum, window fit,
// cone clamp, head tracker, the PLY-axes adapter). Pure math: no three.js, no Spark, no DOM.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  orbitFromDrag,
  createOrbit,
  createClickTracker,
  easeK,
  relaxRemaining,
  ORBIT_MAX_DEG,
  ORBIT_TAU_REST_S,
  ORBIT_TAU_DRAG_S,
  CLICK_SLOP_PX,
  rigFromMeta,
  frustumFor,
  fitWindow,
  clampHead,
  coneLimit,
  createHeadTracker,
  resolveAxes,
  LIFT_AXES_DEFAULT,
  NEAR,
  FAR,
  PIVOT_MIN_M,
} from '../js/lift/orbit.js';

const near = (a, b, eps, what = '') => assert.ok(Math.abs(a - b) < eps, `${what} ${a} !~= ${b}`);
// Steps whole frames; returns the time actually integrated (seconds rounded to frames).
const run = (orbit, seconds, fps = 60) => {
  const n = Math.round(seconds * fps);
  for (let i = 0; i < n; i++) orbit.step(1 / fps);
  return n / fps;
};

// ── orbit: the mapping ──────────────────────────────────────────────────────────────────────

test('constants: 15° cap, τ 0.2 s held / 0.6 s release (shared with the PlayCanvas orbit)', () => {
  assert.equal(ORBIT_MAX_DEG, 15);
  assert.equal(ORBIT_TAU_DRAG_S, 0.2);
  assert.equal(ORBIT_TAU_REST_S, 0.6);
  assert.equal(CLICK_SLOP_PX, 6);
});

test('orbitFromDrag: a half-width swipe reaches the cap, and no further', () => {
  assert.deepEqual(orbitFromDrag(0.5, 0), { yaw: 15, pitch: 0 });
  assert.deepEqual(orbitFromDrag(0.25, 0), { yaw: 7.5, pitch: 0 });
  assert.deepEqual(orbitFromDrag(3, -3), { yaw: 15, pitch: -15 });
  assert.deepEqual(orbitFromDrag(-0.5, 0.5), { yaw: -15, pitch: 15 });
});

test('orbitFromDrag: TURNTABLE sign — +dx ⇒ +yaw, +dy (drag down) ⇒ +pitch', () => {
  assert.ok(orbitFromDrag(0.1, 0).yaw > 0);
  assert.ok(orbitFromDrag(0, 0.1).pitch > 0);
});

test('orbitFromDrag: custom gain and cap', () => {
  assert.deepEqual(orbitFromDrag(0.1, 0, 10, 50), { yaw: 5, pitch: 0 });
  assert.deepEqual(orbitFromDrag(1, 0, 10, 50), { yaw: 10, pitch: 0 });
});

// ── orbit: the stateful ease ────────────────────────────────────────────────────────────────

test('createOrbit: target is ABSOLUTE from the press (not cumulative) and capped', () => {
  const o = createOrbit();
  o.press();
  o.drag(0.2, 0);
  o.drag(0.3, 0); // same drag, further along — not added to the previous
  assert.equal(o.targetYaw, 9);
  o.drag(2, -2);
  assert.equal(o.targetYaw, 15);
  assert.equal(o.targetPitch, -15);
});

test('createOrbit: while held, eases toward the target with τ = 0.2 s', () => {
  const o = createOrbit();
  o.press();
  o.drag(0.5, 0);
  run(o, 0.2);
  near(o.yaw, 15 * (1 - Math.exp(-1)), 1e-6, 'one τ');
  run(o, 2);
  near(o.yaw, 15, 1e-3, 'arrived');
});

test('createOrbit: release relaxes to 0 along exp(−t/0.6), frame-rate independent', () => {
  for (const fps of [30, 60, 144]) {
    const o = createOrbit();
    o.setTarget(15, -10, { snap: true });
    o.setTarget(0, 0, { snap: true }); // rest back at 0
    // put it at 15/-10 by a held drag that has settled
    o.press();
    o.drag(0.5, -1 / 3);
    run(o, 5, fps);
    near(o.yaw, 15, 1e-3);
    near(o.pitch, -10, 1e-3);
    o.release();
    for (const t of [0.3, 0.6, 1.2]) {
      const o2 = createOrbit();
      o2.press();
      o2.drag(0.5, -1 / 3);
      run(o2, 5, fps);
      o2.release();
      const tt = run(o2, t, fps);
      near(o2.yaw, 15 * relaxRemaining(tt), 1e-3, `yaw @${t}s ${fps}fps`);
      near(o2.pitch, -10 * relaxRemaining(tt), 1e-3, `pitch @${t}s ${fps}fps`);
    }
  }
});

test('createOrbit: settles EXACTLY at rest and reports not-moving', () => {
  const o = createOrbit();
  o.press();
  o.drag(0.5, 0);
  run(o, 2);
  o.release();
  run(o, 10);
  assert.equal(o.yaw, 0);
  assert.equal(o.mode, null);
  assert.equal(o.step(1 / 60), false);
});

test('createOrbit relax:false — the pose holds on release; the next drag starts from it', () => {
  const o = createOrbit({ relax: false });
  o.press();
  o.drag(0.25, 0);
  run(o, 3);
  o.release();
  run(o, 3);
  near(o.yaw, 7.5, 1e-3, 'held');
  o.press();
  o.drag(0.25, 0);
  assert.equal(o.targetYaw, 15, 'cumulative across drags, still capped');
});

test('createOrbit: setTarget clamps, becomes the rest pose, snap jumps', () => {
  const o = createOrbit({ maxAngleDeg: 15 });
  o.setTarget(40, -40, { snap: true });
  assert.equal(o.yaw, 15);
  assert.equal(o.pitch, -15);
  o.setTarget(5, 0);
  run(o, 10);
  near(o.yaw, 5, 1e-6, 'eased to page pose');
  o.press();
  o.drag(0.1, 0);
  run(o, 3);
  o.release();
  run(o, 10);
  near(o.yaw, 5, 1e-6, 'relaxes to the page pose, not to 0');
});

test('easeK: τ ≤ 0 snaps; dt 0 holds', () => {
  assert.equal(easeK(0.016, 0), 1);
  assert.equal(easeK(0, 0.6), 0);
  near(easeK(0.6, 0.6), 1 - Math.exp(-1), 1e-12);
});

test('click tracker: < 6 px is a click, ≥ 6 px latches a drag', () => {
  const c = createClickTracker();
  c.down(100, 100);
  assert.equal(c.move(103, 104), false); // 5 px
  assert.equal(c.up(), 'click');
  c.down(100, 100);
  assert.equal(c.move(106, 100), true);
  assert.equal(c.move(100, 100), true, 'latched');
  assert.equal(c.up(), 'drag');
  assert.equal(c.up(), null, 'no press');
});

// ── camera model ────────────────────────────────────────────────────────────────────────────

const META = { focalPx: 776, pivotZ: -2, w: 896, h: 672, layers: 2 };

test('axes adapter: default is opengl (camera looking −z); opencv flips', () => {
  assert.equal(LIFT_AXES_DEFAULT, 'opengl');
  assert.deepEqual(resolveAxes('opengl'), { name: 'opengl', fwd: -1, flip: false });
  assert.deepEqual(resolveAxes('opencv'), { name: 'opencv', fwd: 1, flip: true });
  assert.throws(() => resolveAxes('nope'), /unknown axes/);
});

test('rigFromMeta: window = the photo frustum cut at the pivot; opencv pivot is +z', () => {
  const r = rigFromMeta(META);
  assert.equal(r.dPivot, 2);
  near(r.halfW, (2 * 448) / 776, 1e-12);
  near(r.halfH, (2 * 336) / 776, 1e-12);
  const c = rigFromMeta({ ...META, pivotZ: 2 }, 'opencv');
  assert.equal(c.dPivot, 2);
  assert.equal(rigFromMeta({ ...META, pivotZ: -0.001 }).dPivot, PIVOT_MIN_M, 'sanity clamp');
  assert.throws(() => rigFromMeta({ ...META, focalPx: 0 }), /focalPx/);
});

test('frustumFor: neutral frustum is symmetric and independent of the pivot (focal agreement)', () => {
  for (const pivotZ of [-0.5, -2, -9]) {
    const r = rigFromMeta({ ...META, pivotZ });
    const f = frustumFor(r, { x: 0, y: 0, z: 0 });
    near(f.l, -f.r, 1e-15);
    near(f.t, -f.b, 1e-15);
    // (r − l)/near = w / f — the photo's own horizontal FOV whatever the pivot
    near((f.r - f.l) / NEAR, META.w / META.focalPx, 1e-12, `pivot ${pivotZ}`);
  }
  assert.equal(FAR, 5000);
});

test('frustumFor: an eye moved right sees the window shifted LEFT (off-axis, unrotated)', () => {
  const r = rigFromMeta(META);
  const f = frustumFor(r, { x: 0.05, y: 0, z: 0 });
  assert.ok(f.r < -f.l, 'asymmetric toward the left');
  // The window's edges stay pinned in space: l·d/near = −halfW − e.x
  near((f.l * r.dPivot) / NEAR, -r.halfW - 0.05, 1e-12);
});

test('fitWindow: cover crops, contain letterboxes, stretch keeps the photo window', () => {
  const r = rigFromMeta(META); // 4:3
  const wide = fitWindow(r, 16 / 9, 'cover');
  near(wide.halfW, r.halfW, 1e-12);
  near(wide.halfW / wide.halfH, 16 / 9, 1e-12);
  const tall = fitWindow(r, 0.5, 'cover');
  near(tall.halfH, r.halfH, 1e-12);
  near(tall.halfW / tall.halfH, 0.5, 1e-12);
  const c = fitWindow(r, 16 / 9, 'contain');
  near(c.halfH, r.halfH, 1e-12);
  assert.ok(c.halfW > r.halfW);
  assert.deepEqual(fitWindow(r, 3, 'stretch'), { halfW: r.halfW, halfH: r.halfH });
});

test('clampHead: the 15° cone about the capture camera, z untouched', () => {
  const r = rigFromMeta(META);
  const lim = coneLimit(r);
  near(lim, Math.tan((15 * Math.PI) / 180) * 2, 1e-12);
  const e = clampHead(lim, { x: 3, y: 4, z: 0.2 });
  near(Math.hypot(e.x, e.y), lim, 1e-12);
  near(e.x / e.y, 0.75, 1e-12);
  assert.equal(e.z, 0.2);
  assert.deepEqual(clampHead(lim, { x: 0.1, y: 0, z: 0 }), { x: 0.1, y: 0, z: 0 });
});

test('head tracker: world units → metres by the measured IPD; rest head = median of the first N', () => {
  const h = createHeadTracker({ restSamples: 3 });
  // A display rig in world units where the eyes are 0.021 apart (IPD 0.063 ⇒ 3 m per unit).
  const pose = (x, y = 0, z = 0.2) => [{ x: x - 0.0105, y, z }, { x: x + 0.0105, y, z }];
  h.update(pose(0.01));
  h.update(pose(0.0));
  h.update(pose(0.02));
  assert.deepEqual(h.ref, { x: 0.01, y: 0, z: 0.2 });
  near(h.metresPerUnit, 3, 1e-9);
  const { eyes, mid } = h.update(pose(0.02));
  near(mid.x, 0.03, 1e-9, 'leaning 1 cm world = 3 cm scene');
  near(eyes[1].x - eyes[0].x, 0.063, 1e-9, 'real IPD');
});

test('head tracker: clamping moves both eyes together — the separation is never squeezed', () => {
  const h = createHeadTracker({ restSamples: 1 });
  h.update([{ x: -0.0315, y: 0, z: 0.6 }, { x: 0.0315, y: 0, z: 0.6 }]);
  const { eyes, mid } = h.update([{ x: 0.9685, y: 0, z: 0.6 }, { x: 1.0315, y: 0, z: 0.6 }], 0.25);
  near(mid.x, 0.25, 1e-9);
  near(eyes[1].x - eyes[0].x, 0.063, 1e-9);
});

test("head tracker rest:'display' — lateral rest is the display centre, not the first pose", () => {
  const h = createHeadTracker({ restSamples: 1, rest: 'display' });
  const { mid } = h.update([{ x: 0.0685, y: 0, z: 0.6 }, { x: 0.1315, y: 0, z: 0.6 }]);
  near(mid.x, 0.1, 1e-9);
  near(mid.z, 0, 1e-9);
});

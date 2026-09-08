// Tests for SceneViewer's OUTPUT surface — getPose / getSubjectBounds / depthOffset (web#26).
//
// Before these existed, a page that wanted to know where its subject sat had to read _pivot,
// _fitScale and _zoom. The interesting case, and the reason a getter was not enough, is the
// last group: the orbit rotates the subject, so its depth in display space is a function of
// yaw. Anything measured once at load is correct at yaw 0 and wrong everywhere else.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installDom, makeCanvas, makeTHREE } from './stubs.mjs';

installDom();
const { SceneViewer } = await import('../js/inline3d-viewer.js');

/** `fit: 'none'` pins fitScale at 1, so bounds arithmetic is exact and canvas-size independent. */
function raw(opts = {}) {
  const { THREE } = makeTHREE();
  return new SceneViewer(THREE, makeCanvas(400, 200), { fit: 'none', orbit: false, ...opts });
}

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !~= ${b}`);

// ---- pose readback ---------------------------------------------------------------------------

test('getPose reports the defaults before anything is set', () => {
  assert.deepEqual(raw().getPose(), { yaw: 0, pitch: 0, zoom: 1, depthOffset: 0 });
});

test('setPose snaps, so eased and target agree immediately', () => {
  const v = raw();
  v.setPose({ yaw: 30, pitch: -10, zoom: 2, depthOffset: 0.05 });
  assert.deepEqual(v.getPose(), { yaw: 30, pitch: -10, zoom: 2, depthOffset: 0.05 });
  assert.deepEqual(v.getPose({ target: true }), v.getPose());
});

test('mid-ease, target and current differ — and that is the point of the flag', () => {
  const v = raw();
  v._targetYaw = 90; // what _tick eases toward; _yaw is still 0
  assert.equal(v.getPose().yaw, 0);
  assert.equal(v.getPose({ target: true }).yaw, 90);
});

test('pitch is clamped by pitchLimit on the way in', () => {
  const v = raw({ pitchLimit: [-20, 20] });
  v.setPose({ pitch: 80 });
  assert.equal(v.getPose().pitch, 20);
});

// ---- depthOffset -----------------------------------------------------------------------------

test('depthOffset round-trips and reaches the transform', () => {
  const v = raw();
  v.depthOffset = -0.03;
  assert.equal(v.depthOffset, -0.03);
  assert.equal(v._pivot.position.z, -0.03);
});

test('a refit PRESERVES the depth slide', () => {
  // The 1.5.x behaviour was to zero it: fitTo hardcoded _pivot.position.z = 0, so reframing
  // silently threw away the author's placement.
  const v = raw();
  v.depthOffset = 0.04;
  v.fitTo([0, 0, 0], [1, 1, 1]);
  assert.equal(v.depthOffset, 0.04);
  assert.equal(v._pivot.position.z, 0.04);
});

test('resetPose clears the depth slide with the rest of the pose', () => {
  const v = raw();
  v.setPose({ yaw: 45, zoom: 3, depthOffset: 0.04 });
  v.resetPose();
  assert.deepEqual(v.getPose(), { yaw: 0, pitch: 0, zoom: 1, depthOffset: 0 });
});

test('a non-finite depthOffset is refused, not propagated into the matrix', () => {
  const v = raw();
  v.depthOffset = 0.02;
  for (const bad of [NaN, Infinity, undefined, null, '0.5']) {
    v.depthOffset = bad;
    assert.equal(v.depthOffset, 0.02, `${String(bad)} should have been rejected`);
  }
});

// ---- subject bounds --------------------------------------------------------------------------

test('bounds before any fitTo are empty rather than throwing', () => {
  const b = raw().getSubjectBounds();
  assert.deepEqual(b.extent, { x: 0, y: 0, z: 0 });
  assert.equal(b.front, 0);
  assert.equal(b.back, 0);
});

test('head-on, the box is the subject extent and front/back straddle the glass', () => {
  const v = raw();
  v.fitTo([0, 0, 0], [0.3, 0.2, 0.1]);
  const b = v.getSubjectBounds();
  assert.deepEqual(b.extent, { x: 0.3, y: 0.2, z: 0.1 });
  assert.deepEqual(b.center, { x: 0, y: 0, z: 0 });
  near(b.front, 0.05); // +z is toward the viewer
  near(b.back, -0.05);
  assert.equal(b.scale, 1);
});

test('the subject centre is the BOX centre, so an off-origin model still lands on the glass', () => {
  const v = raw();
  v.fitTo([5, -2, 7], [0.3, 0.2, 0.1]);
  const b = v.getSubjectBounds();
  assert.deepEqual(b.center, { x: 0, y: 0, z: 0 });
  near(b.front, 0.05);
});

test('the depth slide moves the whole box, front and back together', () => {
  const v = raw();
  v.fitTo([0, 0, 0], [0.3, 0.2, 0.1]);
  v.depthOffset = 0.02;
  const b = v.getSubjectBounds();
  near(b.center.z, 0.02);
  near(b.front, 0.07);
  near(b.back, -0.03);
  near(b.extent.z, 0.1); // a slide never resizes
});

test('zoom scales the box and shows up in `scale`', () => {
  const v = raw();
  v.fitTo([0, 0, 0], [0.3, 0.2, 0.1]);
  v.setPose({ zoom: 2 });
  const b = v.getSubjectBounds();
  assert.equal(b.scale, 2);
  near(b.extent.x, 0.6);
  near(b.front, 0.1);
});

test('THE ORBIT CASE: yaw swings depth into z, so front is not a constant', () => {
  // A wide, shallow subject — a page. Face-on it is 0.02 m deep; turned 90 degrees the 1 m
  // width IS the depth, and it now sticks 0.5 m out of the glass. A viewer that cached its
  // front extent at load would still be reporting 0.01.
  const v = raw();
  v.fitTo([0, 0, 0], [1, 0.5, 0.02]);
  near(v.getSubjectBounds().front, 0.01);

  v.setPose({ yaw: 90 });
  const turned = v.getSubjectBounds();
  near(turned.front, 0.5);
  near(turned.extent.z, 1);
  near(turned.extent.x, 0.02); // and the width has become the depth
});

test('45 degrees is the conservative diagonal, not an interpolation', () => {
  const v = raw();
  v.fitTo([0, 0, 0], [1, 0.5, 1]);
  v.setPose({ yaw: 45 });
  // half-extent = (|cos45|*0.5 + |sin45|*0.5) = 0.7071...
  near(v.getSubjectBounds().front, Math.SQRT1_2 * 0.5 + Math.SQRT1_2 * 0.5, 1e-12);
});

test('pitch rotates about X, so height swings into z', () => {
  // pitchLimit is widened deliberately: the default +-60 clamp would cap this at 60 degrees and
  // the assertion would be measuring the clamp rather than the rotation.
  const v = raw({ pitchLimit: [-90, 90] });
  v.fitTo([0, 0, 0], [0.2, 1, 0.02]);
  v.setPose({ pitch: 90 });
  const b = v.getSubjectBounds();
  near(b.front, 0.5);
  near(b.extent.y, 0.02);
});

test('yaw and pitch compose the same way the transform does', () => {
  const v = raw();
  v.fitTo([0, 0, 0], [1, 2, 4]);
  v.setPose({ yaw: 37, pitch: -22 });
  const { pitch, yaw } = v.getPose();
  const p = (pitch * Math.PI) / 180;
  const y = (yaw * Math.PI) / 180;
  // R = Rx(pitch) . Ry(yaw); the z row is [-cp*sy, sp, cp*cy].
  const expect =
    Math.abs(Math.cos(p) * Math.sin(y)) * 0.5 +
    Math.abs(Math.sin(p)) * 1 +
    Math.abs(Math.cos(p) * Math.cos(y)) * 2;
  near(v.getSubjectBounds().front, expect, 1e-12);
});

test('a real fit puts its scale in `scale`, and the box follows it', () => {
  const { THREE } = makeTHREE();
  // fit 'height': subject occupies margin (0.8) of a 0.24 m tile → 0.192 m tall.
  const v = new SceneViewer(THREE, makeCanvas(400, 200), {
    fit: 'height', margin: 0.8, virtualDisplayHeight: 0.24, orbit: false, fitSweep: false,
  });
  v.fitTo([0, 0, 0], [1, 2, 1]);
  const b = v.getSubjectBounds();
  near(b.scale, (0.8 * 0.24) / 2);
  near(b.extent.y, 0.8 * 0.24);
});

// ---- the analytic box, checked against brute force -------------------------------------------
//
// getSubjectBounds derives the AABB from the rows of R = Rx(pitch) . Ry(yaw). That is a claim
// about what three.js's 'XYZ' Euler order MEANS, and getting it wrong would be invisible at yaw 0
// and at pitch 0 — i.e. in every casual check. So: rebuild the matrix straight from three's own
// Matrix4.makeRotationFromEuler formula, transform all eight corners, and compare.

/** three.js Matrix4.makeRotationFromEuler, order 'XYZ', z = 0. Returns rows. */
function eulerXYZRows(pitchRad, yawRad) {
  const a = Math.cos(pitchRad), b = Math.sin(pitchRad);
  const c = Math.cos(yawRad), d = Math.sin(yawRad);
  const e = 1, f = 0; // z = 0
  // three stores column-major in te[]; these are the rows it represents.
  return [
    [c * e, -c * f, d],
    [a * f + b * e * d, a * e - b * f * d, -b * c],
    [b * f - a * e * d, b * e + a * f * d, a * c],
  ];
}

function bruteForceBox(half, rows, scale, offsetZ) {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    const v = [sx * half[0], sy * half[1], sz * half[2]];
    for (let i = 0; i < 3; i++) {
      const w = scale * (rows[i][0] * v[0] + rows[i][1] * v[1] + rows[i][2] * v[2]) + (i === 2 ? offsetZ : 0);
      if (w < lo[i]) lo[i] = w;
      if (w > hi[i]) hi[i] = w;
    }
  }
  return { lo, hi };
}

test('the analytic AABB matches transforming all eight corners, at arbitrary angles', () => {
  const extent = [0.7, 1.3, 0.4];
  const cases = [[0, 0], [90, 0], [0, 90], [37, -22], [-58, 143], [12.5, 359], [-90, -45]];
  for (const [pitch, yaw] of cases) {
    const v = raw({ pitchLimit: [-180, 180] });
    v.fitTo([0, 0, 0], extent);
    v.setPose({ pitch, yaw, zoom: 1.7, depthOffset: 0.03 });
    const b = v.getSubjectBounds();
    const rows = eulerXYZRows((pitch * Math.PI) / 180, (yaw * Math.PI) / 180);
    const bf = bruteForceBox(extent.map((e) => e / 2), rows, 1.7, 0.03);
    near(b.front, bf.hi[2], 1e-12);
    near(b.back, bf.lo[2], 1e-12);
    near(b.extent.x, bf.hi[0] - bf.lo[0], 1e-12);
    near(b.extent.y, bf.hi[1] - bf.lo[1], 1e-12);
    near(b.extent.z, bf.hi[2] - bf.lo[2], 1e-12);
  }
});

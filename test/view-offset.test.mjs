// handle.setViewOffset — the 2D tier's off-axis eye offset (a phone's tilt as head parallax).
//
// What is pinned: the focus plane does not move on screen, nearer content moves AGAINST the eye
// and farther content WITH it (parallax, not a pan), |offset| = 1 is the orbit's comfort cone
// (the line of sight to the focus swings orbitMaxDeg), the unit-disc clamp, validation, the
// no-op cases (zero offset, controls:'page'), and that pick()/eyeFrame see the drawn camera.
import test from 'node:test';
import assert from 'node:assert/strict';
import { attachPlayCanvasSplat, offsetMonoView, perspectiveFov, poseMatrix, mat4Invert, mat4Mul } from '../js/inline3d-splat-playcanvas.js';
import { installDom, makeCanvas } from './stubs.mjs';

const DEG = Math.PI / 180;

/** World point → NDC [x, y] through (proj, pose). */
function ndc(proj, pose, p) {
  const V = mat4Invert(pose);
  const M = mat4Mul(proj, V);
  const x = M[0] * p[0] + M[4] * p[1] + M[8] * p[2] + M[12];
  const y = M[1] * p[0] + M[5] * p[1] + M[9] * p[2] + M[13];
  const w = M[3] * p[0] + M[7] * p[1] + M[11] * p[2] + M[15];
  return [x / w, y / w];
}

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

test('offsetMonoView: the focus plane is pinned, near content moves against the eye, far with it', () => {
  const c = 2; // camera at z = 2 looking down −z at a focus plane through the origin
  const pose = poseMatrix([0, 0, c], [0, 0, 0, 1]);
  const proj = perspectiveFov(50, 16 / 9, 0.02, 100, new Float64Array(16));
  const P = new Float64Array(16);
  const Q = new Float64Array(16);
  assert.equal(offsetMonoView(pose, proj, 0.6, -0.4, c, 15, P, Q), true);

  // Every point ON the focus plane lands where it did (not just its centre).
  for (const p of [[0, 0, 0], [0.3, -0.2, 0], [-0.5, 0.4, 0]]) {
    const [ax, ay] = ndc(proj, pose, p);
    const [bx, by] = ndc(Q, P, p);
    assert.ok(near(ax, bx) && near(ay, by), `focus-plane point ${p} moved`);
  }
  // Eye right (+x): a NEAR point slides left on screen, a FAR point slides right.
  const nearPt = ndc(Q, P, [0, 0, 1]);
  const farPt = ndc(Q, P, [0, 0, -5]);
  assert.ok(nearPt[0] < -1e-3, 'near content moves against the eye');
  assert.ok(farPt[0] > 1e-3, 'far content moves with the eye');
  // Eye down (−y): the near point goes UP.
  assert.ok(nearPt[1] > 1e-3);

  // |offset| = 1 is the comfort cone: the eye moved c·tan(15°), in the camera plane only.
  const P1 = new Float64Array(16);
  const Q1 = new Float64Array(16);
  offsetMonoView(pose, proj, 1, 0, c, 15, P1, Q1);
  assert.ok(near(P1[12], c * Math.tan(15 * DEG)));
  assert.ok(near(P1[13], 0) && near(P1[14], c), 'no dolly');
  // Rotation untouched: off-axis, the camera never turns.
  for (let i = 0; i < 12; i++) assert.equal(P1[i], pose[i]);
});

test('offsetMonoView: no offset, or a focus behind the camera, leaves the outputs alone', () => {
  const pose = poseMatrix([0, 0, 1], [0, 0, 0, 1]);
  const proj = perspectiveFov(50, 1, 0.02, 100, new Float64Array(16));
  const P = new Float64Array(16).fill(7);
  const Q = new Float64Array(16).fill(7);
  assert.equal(offsetMonoView(pose, proj, 0, 0, 1, 15, P, Q), false);
  assert.equal(offsetMonoView(pose, proj, 0.5, 0, -1, 15, P, Q), false);
  assert.equal(offsetMonoView(pose, proj, 0.5, 0, NaN, 15, P, Q), false);
  assert.ok(P.every((v) => v === 7) && Q.every((v) => v === 7));
});

test('handle: setViewOffset validates, clamps to the unit disc, chains, and reads back', () => {
  installDom();
  const pc = { createGraphicsDevice: () => new Promise(() => {}) };
  const out = {};
  attachPlayCanvasSplat(out, null, makeCanvas(320, 180), 'x.sog', { playcanvas: pc }, []);
  assert.deepEqual(out.viewOffset, { x: 0, y: 0 });
  assert.equal(out.setViewOffset({ x: 0.3, y: -0.2 }), out);
  assert.deepEqual(out.viewOffset, { x: 0.3, y: -0.2 });
  out.setViewOffset({ x: 3, y: 4 }); // |5| → the unit disc, direction kept
  assert.ok(near(out.viewOffset.x, 0.6) && near(out.viewOffset.y, 0.8));
  out.setViewOffset({ x: 0.5 }); // a missing component is 0
  assert.deepEqual(out.viewOffset, { x: 0.5, y: 0 });
  out.setViewOffset(null);
  assert.deepEqual(out.viewOffset, { x: 0, y: 0 });
  for (const bad of [{ x: NaN }, { y: Infinity }, { x: '1' }]) assert.throws(() => out.setViewOffset(bad), TypeError);
  out.remove();
});

test('handle: the drawn mono camera (and so pick / eyeFrame) is the offset one; the orbit composes', () => {
  installDom();
  const pc = { createGraphicsDevice: () => new Promise(() => {}) };
  const out = {};
  attachPlayCanvasSplat(out, null, makeCanvas(320, 180), 'x.sog', { playcanvas: pc }, []);
  const v = out.viewer;
  v._mode = 'mono';
  v._updateMonoProjection();
  const rest = v.currentView();
  assert.equal(rest.pose, v.mono.pose, 'no offset → the mono camera itself');
  const eyeRest = v.eyeFrame().origin;

  out.setViewOffset({ x: 1, y: 0 });
  const off = v.currentView();
  const c = v.mono.pose[14]; // display rig: camera on +z, focus at the origin
  assert.ok(near(off.pose[12] - v.mono.pose[12], c * Math.tan(v.orbitMaxDeg * DEG), 1e-9));
  // The focus point (display-space origin) is still dead centre.
  const [fx, fy] = ndc(off.proj, off.pose, [0, 0, 0]);
  assert.ok(near(fx, 0) && near(fy, 0));
  const eyeOff = v.eyeFrame().origin;
  assert.ok(Math.hypot(eyeOff[0] - eyeRest[0], eyeOff[1] - eyeRest[1], eyeOff[2] - eyeRest[2]) > 1e-3, 'eyeFrame follows the drawn eye');

  // The orbit is a separate state: a yaw does not touch the offset, and vice versa.
  out.setPose({ yaw: 10 });
  assert.deepEqual(out.viewOffset, { x: 1, y: 0 });
  assert.equal(out.viewer.getPose().yaw, 10);
  out.remove();
});

test("handle: controls:'page' ignores the offset (the page owns the camera)", () => {
  installDom();
  const pc = { createGraphicsDevice: () => new Promise(() => {}) };
  const out = {};
  attachPlayCanvasSplat(out, null, makeCanvas(320, 180), 'x.sog', { playcanvas: pc, controls: 'page' }, []);
  out.setViewOffset({ x: 1, y: 0 });
  const v = out.viewer;
  assert.equal(v.currentView().pose, v.mono.pose);
  out.remove();
});

test('handle: the mono frame DRAWS the offset camera, and a zero offset draws the mono camera itself', () => {
  installDom();
  const pc = { createGraphicsDevice: () => new Promise(() => {}) };
  const out = {};
  attachPlayCanvasSplat(out, null, makeCanvas(320, 180), 'x.sog', { playcanvas: pc }, []);
  const v = out.viewer;
  v._mode = 'mono';
  v._updateMonoProjection();
  let drawn = null;
  v._drawEntries = (entries) => {
    drawn = { pose: Float64Array.from(entries[0].pose), proj: Float64Array.from(entries[0].proj) };
    return true;
  };
  v._drawMono();
  assert.deepEqual(drawn.pose, Float64Array.from(v.mono.pose));
  out.setViewOffset({ x: 0, y: 1 });
  v._drawMono();
  assert.ok(drawn.pose[13] - v.mono.pose[13] > 1e-3, 'eye moved up in the drawn frame');
  assert.ok(Math.abs(drawn.proj[9] - v.mono.proj[9]) > 1e-3, 'window shifted in the drawn frame');
  out.setViewOffset(null);
  v._drawMono();
  assert.deepEqual(drawn.pose, Float64Array.from(v.mono.pose));
  out.remove();
});

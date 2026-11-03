// SceneViewer roll + nudgePose (for `@displayxr/inline3d/hands`).
//
// Pinned: roll is 0 and the transform is the old Rx(pitch)·Ry(yaw) product for every page that
// never sets it (the Euler order change to 'ZXY' is bit-identical at roll 0); setPose / getPose /
// resetPose carry roll; nudgePose moves the TARGETS (eased by _tick), clamps pitch and zoom, and
// counts as input for the idle turntable; getSubjectBounds follows a rolled subject.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installDom, makeCanvas, makeTHREE } from './stubs.mjs';

installDom();
const { SceneViewer } = await import('../js/inline3d-viewer.js');

function raw(opts = {}) {
  const { THREE } = makeTHREE();
  return new SceneViewer(THREE, makeCanvas(400, 200), { fit: 'none', orbit: false, ...opts });
}
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !~= ${b}`);

test('roll defaults to 0 and the pivot rotation is the old product, in ZXY order', () => {
  const v = raw();
  assert.equal(v.getPose().roll, 0);
  v.setPose({ yaw: 30, pitch: 10 });
  const r = v._pivot.rotation;
  near(r.x, (10 * Math.PI) / 180);
  near(r.y, (30 * Math.PI) / 180);
  assert.equal(r.z, 0);
  assert.equal(r.order, 'ZXY');
});

test('setPose / getPose / resetPose carry roll', () => {
  const v = raw();
  v.setPose({ roll: 45 });
  assert.equal(v.getPose().roll, 45);
  assert.equal(v.getPose({ target: true }).roll, 45);
  near(v._pivot.rotation.z, Math.PI / 4);
  v.resetPose();
  assert.equal(v.getPose().roll, 0);
  assert.equal(v._pivot.rotation.z, 0);
});

test('nudgePose moves the targets, not the eased values, and clamps pitch and zoom', () => {
  const v = raw({ pitchLimit: [-20, 20] });
  v.nudgePose({ yaw: 10, pitch: 50, zoom: 100, roll: -5 });
  const t = v.getPose({ target: true });
  assert.equal(t.yaw, 10);
  assert.equal(t.pitch, 20, 'pitch clamped by pitchLimit');
  assert.ok(t.zoom < 100 && t.zoom > 1, 'zoom bounded by the viewer clamp');
  assert.equal(t.roll, -5);
  const e = v.getPose();
  assert.equal(e.yaw, 0, 'the eased pose waits for _tick');
  v.nudgePose({ zoom: 0.5 });
  assert.ok(v.getPose({ target: true }).zoom < t.zoom, 'zoom multiplies');
  v.nudgePose({});
  assert.deepEqual(v.getPose({ target: true }), { ...t, zoom: v.getPose({ target: true }).zoom }, 'an empty nudge changes nothing');
});

test('nudgePose counts as input: the idle turntable does not add yaw on the next tick', () => {
  const v = raw({ idleSpin: 90 });
  v._lastInput = 0; // long idle: a tick would spin
  v._lastTick = 1; // some elapsed time
  v.nudgePose({ yaw: 1 });
  const before = v.getPose({ target: true }).yaw;
  v._tick();
  assert.equal(v.getPose({ target: true }).yaw, before, 'no turntable increment right after an input');
});

test('_tick eases roll toward its target', () => {
  const v = raw();
  v.nudgePose({ roll: 90 });
  v._lastTick = 1;
  v._tick();
  const r = v.getPose().roll;
  assert.ok(r > 0 && r < 90, `roll eases: ${r}`);
  near(v._pivot.rotation.z, (r * Math.PI) / 180);
});

test('getSubjectBounds: a 90° roll swaps the x and y extents; at roll 0 it is the old box', () => {
  const v = raw();
  v.fitTo([0, 0, 0], [2, 1, 0.5]); // half-extents 1, 0.5, 0.25 at fit 'none'
  const b0 = v.getSubjectBounds();
  near(b0.extent.x, 2);
  near(b0.extent.y, 1);
  near(b0.extent.z, 0.5);
  v.setPose({ roll: 90 });
  const b = v.getSubjectBounds();
  near(b.extent.x, 1);
  near(b.extent.y, 2);
  near(b.extent.z, 0.5, 1e-9);
  // Depth never changes under a roll about the view axis, whatever the yaw / pitch.
  v.setPose({ yaw: 40, pitch: 15, roll: 0 });
  const z0 = v.getSubjectBounds().extent.z;
  v.setPose({ roll: 33 });
  near(v.getSubjectBounds().extent.z, z0);
});

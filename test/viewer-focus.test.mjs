// Tests for SceneViewer's FOCUS — the point that is simultaneously the orbit centre, the pivot
// plane and (on a camera rig) the convergence distance.
//
// What is worth pinning is not the lerp but the INVARIANT that makes the three the same thing:
//
//   · a display rig brings the focused point to the middle of the tile (the pivot stays at the
//     origin), while a camera rig leaves the capture where it was placed and moves only what the
//     rotation turns about — `centering` and `orbitCentre` cancel. Translating a camera-rig
//     scene would move the viewpoint, and on a lifted photograph the neutral view IS the
//     photograph;
//   · `fitTo` goes THROUGH the focus rather than around it, so a refit cannot leave the orbit
//     turning about somewhere the framing has moved away from — the two used to be separate
//     writes to `_centering.position` and that is exactly the drift this closes;
//   · the ease is per FRAME (the gallery's 0.18), settles exactly rather than asymptotically,
//     and a viewer that never focuses pays nothing.

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
const pos = (o) => [o.position.x, o.position.y, o.position.z];

test('the default focus is the origin, and nothing is translated', () => {
  const v = raw();
  assert.deepEqual(v.getFocus(), { x: 0, y: 0, z: 0 });
  assert.deepEqual(pos(v._centering), [0, 0, 0]);
  assert.deepEqual(pos(v._pivot), [0, 0, 0]);
});

test('a display rig BRINGS the focused point to the middle of the tile', () => {
  const v = raw();
  v.setFocus([1, 2, 3], { snap: true, recentre: true });
  // Content slides by -focus; the pivot stays at the origin, so the point is now on the glass.
  assert.deepEqual(pos(v._centering), [-1, -2, -3]);
  assert.deepEqual(pos(v._pivot), [0, 0, 0]);
});

test('a camera rig moves only the rotation centre — the capture does not move', () => {
  const v = raw();
  v.setFocus([1, 2, 3], { snap: true, recentre: false });
  // centering and the pivot's position cancel: every point is exactly where it was...
  assert.deepEqual(pos(v._centering), [-1, -2, -3]);
  assert.deepEqual(pos(v._pivot), [1, 2, 3]);
  // ...until something rotates, and then it rotates about the focus. A yaw of 180° about
  // (1,2,3) sends the origin to (2,2,6).
  v.setPose({ yaw: 180 });
  const [px, py, pz] = pos(v._pivot);
  near(px, 1);
  near(pz, 3);
  assert.equal(py, 2);
});

test('the depth slide rides ON TOP of the orbit centre, and still works without one', () => {
  const v = raw();
  v.depthOffset = 0.05;
  assert.deepEqual(pos(v._pivot), [0, 0, 0.05]);
  v.setFocus([0, 0, 2], { snap: true, recentre: false });
  assert.deepEqual(pos(v._pivot), [0, 0, 2.05]);
});

test('fitTo goes THROUGH the focus, so framing and orbit centre cannot drift apart', () => {
  const v = raw();
  v.fitTo([4, 5, 6], [1, 1, 1]);
  assert.deepEqual(v.getFocus(), { x: 4, y: 5, z: 6 });
  assert.deepEqual(pos(v._centering), [-4, -5, -6]);
  // A fit is a framing, not a gesture: it must not ease in over a second.
  assert.deepEqual(v.getFocus({ target: true }), v.getFocus());
});

test('an un-snapped focus EASES, at 0.18 a frame, and settles exactly', () => {
  const v = raw();
  v.setFocus([0, 0, 10]);
  assert.deepEqual(v.getFocus(), { x: 0, y: 0, z: 0 }, 'not applied until a frame runs');
  assert.deepEqual(v.getFocus({ target: true }), { x: 0, y: 0, z: 10 });
  v._tick();
  near(v.getFocus().z, 1.8);
  v._tick();
  near(v.getFocus().z, 1.8 + 8.2 * 0.18);
  for (let i = 0; i < 200; i++) v._tick();
  // Exactly, not asymptotically — a residual here would leave the pivot a hair off forever.
  assert.deepEqual(v.getFocus(), { x: 0, y: 0, z: 10 });
  assert.equal(v._focusSettled, true);
});

test('onFocusChange fires while easing and stops when settled', () => {
  const v = raw();
  const seen = [];
  v.onFocusChange = (f) => seen.push(f.z);
  v.setFocus([0, 0, 1]);
  for (let i = 0; i < 300; i++) v._tick();
  assert.ok(seen.length > 5 && seen.length < 300, `eased over ${seen.length} frames`);
  near(seen[seen.length - 1], 1);
  const settledCount = seen.length;
  v._tick();
  assert.equal(seen.length, settledCount, 'a settled focus costs nothing per frame');
});

test('onTick fires every frame, settled or not', () => {
  const v = raw();
  let n = 0;
  v.onTick = () => n++;
  v._tick();
  v._tick();
  assert.equal(n, 2);
});

test('null resets to the origin, and a non-finite component is refused', () => {
  const v = raw();
  v.setFocus([1, 1, 1], { snap: true });
  v.setFocus(null, { snap: true });
  assert.deepEqual(v.getFocus(), { x: 0, y: 0, z: 0 });
  v.setFocus({ x: 2, y: Number.NaN, z: 3 }, { snap: true });
  assert.deepEqual(v.getFocus(), { x: 2, y: 0, z: 3 });
});

test('recentre is STICKY — a later setFocus keeps the rig it was told about', () => {
  const v = raw();
  v.setFocus([0, 0, 1], { snap: true, recentre: false });
  v.setFocus([0, 0, 2], { snap: true });
  assert.deepEqual(pos(v._pivot), [0, 0, 2], 'still a camera rig');
});

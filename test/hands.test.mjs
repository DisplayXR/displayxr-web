// `@displayxr/inline3d/hands` — the gesture controller (a port of the Model Viewer's, so these
// mirror its self-check: pinch hysteresis, one-hand orbit, two-hand zoom / roll / orbit, tracking
// loss re-anchoring, the separation guard, the EMA, hand-relative pinch), plus the session side
// against a fake XRSession: watchHands fills samples from `inputSources`, handControls drives a
// viewer's nudgePose in degrees, the `hands` option rides a handle's remove() however it is
// reassigned, and everything is inert without a session or without hands.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HAND_JOINTS,
  HAND_GESTURE_DEFAULTS,
  PinchDetector,
  HandGestureController,
  handGate,
  watchHands,
  handControls,
  attachHandsOption,
} from '../js/inline3d-hands.js';

const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} !~= ${b} (tol ${tol})`);

/** A hand whose pinch point sits at (x, y, z); `open` metres between the tips. */
const hand = (x, y, z, open, palmLength) => ({
  tracked: true,
  thumbTip: [x - open / 2, y, z],
  indexTip: [x + open / 2, y, z],
  ...(palmLength ? { palmLength } : {}),
});
/** No EMA: deltas are exact. */
const deterministic = (extra = {}) => new HandGestureController({ smoothTauS: 0, orbitRadPerM: 10, ...extra });

// ── pinch ───────────────────────────────────────────────────────────────────────────────────

test('PinchDetector: two thresholds with hysteresis; tracking loss releases', () => {
  const p = new PinchDetector();
  assert.equal(p.update(true, 0.05, 0.025, 0.04), false, 'open hand is not a pinch');
  assert.equal(p.update(true, 0.03, 0.025, 0.04), false, 'between the thresholds from open stays open');
  assert.equal(p.update(true, 0.02, 0.025, 0.04), true, 'below enter starts the pinch');
  assert.equal(p.update(true, 0.03, 0.025, 0.04), true, 'between the thresholds from pinched stays pinched');
  assert.equal(p.update(true, 0.039, 0.025, 0.04), true, 'just under exit still pinched');
  assert.equal(p.update(true, 0.041, 0.025, 0.04), false, 'above exit releases');
  assert.equal(p.update(true, 0.01, 0.025, 0.04), true, 're-pinch');
  assert.equal(p.update(false, 0.01, 0.025, 0.04), false, 'tracking loss releases regardless of distance');
});

test('defaults are the Model Viewer values', () => {
  assert.equal(HAND_GESTURE_DEFAULTS.pinchEnterM, 0.025);
  assert.equal(HAND_GESTURE_DEFAULTS.pinchExitM, 0.04);
  assert.equal(HAND_GESTURE_DEFAULTS.referencePalmM, 0.095);
  assert.equal(HAND_GESTURE_DEFAULTS.orbitRadPerM, 10);
  assert.equal(HAND_JOINTS.length, 25);
  assert.equal(HAND_JOINTS[0], 'wrist');
  assert.equal(HAND_JOINTS[4], 'thumb-tip');
  assert.equal(HAND_JOINTS[9], 'index-finger-tip');
});

// ── one hand ────────────────────────────────────────────────────────────────────────────────

test('one pinched hand dragged right and up: yaw +, pitch − (the subject follows the hand)', () => {
  const c = deterministic();
  let yaw = 0;
  let pitch = 0;
  for (let i = 0; i <= 10; i++) {
    const d = c.update({ time: i / 60, right: hand(0.01 * i, 0.005 * i, 0.3, 0.01) });
    assert.ok(d.oneHand && !d.twoHand && d.any, 'frame flagged one-hand');
    if (i === 0) assert.ok(d.yaw === 0 && d.pitch === 0, 'first pinched frame anchors, no delta');
    yaw += d.yaw;
    pitch += d.pitch;
  }
  near(yaw, 1.0, 1e-9);
  near(pitch, -0.5, 1e-9);
  assert.ok(c.pinched('right') && !c.pinched('left'), 'pinch state readable per hand');
  // Open the hand: nothing, even while it keeps moving.
  let d = c.update({ time: 11 / 60, right: hand(0.5, 0.5, 0.3, 0.08) });
  assert.ok(!d.any && d.yaw === 0, 'released hand produces nothing');
  // Pinch again far away: anchors, no jump.
  d = c.update({ time: 12 / 60, right: hand(0.5, 0.5, 0.3, 0.01) });
  assert.ok(d.oneHand && d.yaw === 0 && d.pitch === 0, 're-pinch re-anchors with zero delta');
});

// ── two hands ───────────────────────────────────────────────────────────────────────────────

test('two pinched hands: separation ratio is zoom, clamped per frame', () => {
  const c = deterministic();
  let d = c.update({ time: 0, left: hand(-0.1, 0, 0.3, 0.01), right: hand(0.1, 0, 0.3, 0.01) });
  assert.ok(d.twoHand && d.zoom === 1 && d.roll === 0, 'first two-hand frame anchors');
  let zoom = 1;
  for (let i = 1; i <= 8; i++) {
    const half = 0.1 + 0.0125 * i;
    d = c.update({ time: i / 60, left: hand(-half, 0, 0.3, 0.01), right: hand(half, 0, 0.3, 0.01) });
    zoom *= d.zoom;
    assert.ok(d.yaw === 0 && d.pitch === 0, 'symmetric separation moves no midpoint');
  }
  near(zoom, 2.0, 1e-9);
  // One frame that jumps 2.25x (0.40 → 0.90 m) is limited to maxZoomStep.
  d = c.update({ time: 9 / 60, left: hand(-0.45, 0, 0.3, 0.01), right: hand(0.45, 0, 0.3, 0.01) });
  near(d.zoom, 1.25, 1e-9);
});

test('two pinched hands turning counter-clockwise roll the subject counter-clockwise, continuous across ±π', () => {
  const c = deterministic();
  let roll = 0;
  for (let i = 0; i <= 9; i++) {
    const a = (i * Math.PI) / 18;
    const hx = 0.2 * Math.cos(a);
    const hy = 0.2 * Math.sin(a);
    const d = c.update({ time: i / 60, left: hand(-hx, -hy, 0.3, 0.01), right: hand(hx, hy, 0.3, 0.01) });
    roll += d.roll;
    if (i > 0) near(d.zoom, 1, 1e-6);
  }
  near(roll, Math.PI / 2, 1e-6);
  const c3 = deterministic();
  let sum = 0;
  for (let i = 0; i <= 4; i++) {
    const a = Math.PI - 0.1 + 0.05 * i; // 170° → 190°
    const hx = 0.2 * Math.cos(a);
    const hy = 0.2 * Math.sin(a);
    sum += c3.update({ time: i / 60, left: hand(-hx, -hy, 0.3, 0.01), right: hand(hx, hy, 0.3, 0.01) }).roll;
  }
  near(sum, 0.2, 1e-6);
});

test('two pinched hands dragged together orbit from the midpoint', () => {
  const c = deterministic();
  let yaw = 0;
  for (let i = 0; i <= 5; i++) {
    yaw += c.update({ time: i / 60, left: hand(-0.1 + 0.02 * i, 0, 0.3, 0.01), right: hand(0.1 + 0.02 * i, 0, 0.3, 0.01) }).yaw;
  }
  near(yaw, 1.0, 1e-9);
});

// ── mode changes ────────────────────────────────────────────────────────────────────────────

test('a hand lost or regained re-anchors: no delta on the frame the mode changes', () => {
  const c = deterministic();
  c.update({ time: 0, left: hand(-0.1, 0, 0.3, 0.01), right: hand(0.1, 0, 0.3, 0.01) });
  let d = c.update({ time: 1 / 60, left: null, right: hand(0.15, 0, 0.3, 0.01) });
  assert.ok(d.oneHand && !d.twoHand, 'one hand lost -> one-hand mode');
  assert.ok(d.yaw === 0 && d.zoom === 1 && d.roll === 0, 'no delta on the frame the mode changes');
  assert.ok(c.tipDistance('left') < 0, 'untracked hand reports no tip distance');
  d = c.update({ time: 2 / 60, right: hand(0.16, 0, 0.3, 0.01) });
  near(d.yaw, 0.1, 1e-9);
  d = c.update({ time: 3 / 60, left: hand(-0.3, 0, 0.3, 0.01), right: hand(0.16, 0, 0.3, 0.01) });
  assert.ok(d.twoHand && d.yaw === 0 && d.zoom === 1, 'hand returns -> two-hand anchors with zero delta');
});

test('an implausible separation is no gesture, and the baseline is dropped', () => {
  const c = deterministic({ maxHandSeparationM: 0.5 });
  c.update({ time: 0, left: hand(-0.1, 0, 0.3, 0.01), right: hand(0.1, 0, 0.3, 0.01) });
  let d = c.update({ time: 1 / 60, left: hand(-0.1, 0, 0.3, 0.01), right: hand(1.9, 0, 0.3, 0.01) });
  assert.ok(!d.any && d.zoom === 1, 'implausible separation: no gesture at all');
  d = c.update({ time: 2 / 60, left: hand(-0.1, 0, 0.3, 0.01), right: hand(0.2, 0, 0.3, 0.01) });
  assert.ok(d.twoHand && d.zoom === 1 && d.yaw === 0, 'first plausible frame after a glitch re-anchors');
  d = c.update({ time: 3 / 60, left: hand(-0.1, 0, 0.3, 0.01), right: hand(0.25, 0, 0.3, 0.01) });
  near(d.zoom, 0.35 / 0.3, 1e-9);
});

test('the EMA: monotone, no overshoot, within 1% in 10 time constants, and lagging', () => {
  const c = new HandGestureController({ smoothTauS: 0.05, orbitRadPerM: 10 });
  c.update({ time: 0, right: hand(0, 0, 0.3, 0.01) });
  let yaw = 0;
  let prev = 0;
  let monotone = true;
  let overshoot = false;
  for (let i = 1; i <= 30; i++) {
    yaw += c.update({ time: i / 60, right: hand(0.1, 0, 0.3, 0.01) }).yaw;
    if (yaw < prev - 1e-9) monotone = false;
    if (yaw > 1.0 + 1e-6) overshoot = true;
    prev = yaw;
  }
  assert.ok(monotone, 'monotone');
  assert.ok(!overshoot, 'never overshoots');
  near(yaw, 1.0, 0.01);
  assert.ok(yaw < 1.0, 'lags the raw step');
});

test('hand-relative pinch: a half-size hand pinches at half the metre thresholds; lengthScale scales everything', () => {
  const c = deterministic();
  // palm 0.0475 (gain 0.5): 2 cm is open for THIS hand, 1 cm is a pinch.
  assert.ok(!c.update({ time: 0, right: hand(0, 0, 0.3, 0.02, 0.0475) }).any, 'half-size hand, tips 2 cm apart: open');
  assert.ok(c.update({ time: 1 / 60, right: hand(0, 0, 0.3, 0.01, 0.0475) }).oneHand, 'half-size hand, tips 1 cm apart: pinch');
  // No palm length: the metre thresholds as given.
  assert.ok(deterministic().update({ time: 0, right: hand(0, 0, 0.3, 0.02) }).oneHand, 'unknown palm: 2 cm pinches');
  // referencePalmM 0 switches the scaling off.
  assert.ok(deterministic({ referencePalmM: 0 }).update({ time: 0, right: hand(0, 0, 0.3, 0.01, 0.0475) }).oneHand);
  // lengthScale 3 with a KNOWN palm: tips, palm and drag scale together, so the hand-relative
  // motion cancels it — the same finger travel, the same angle (1.0 rad), and the pinch holds.
  const c4 = deterministic();
  let yaw = 0;
  for (let i = 0; i <= 10; i++) {
    const d = c4.update({ time: i / 60, lengthScale: 3, right: hand(0.01 * i, 0, 0.3, 0.02, 0.095) });
    assert.ok(d.oneHand, 'scaled hand stays pinched');
    yaw += d.yaw;
  }
  near(yaw, 1.0, 1e-9);
  // Without a palm length, lengthScale is the only scale: the 0.10 m drag reads as 0.30 m.
  const c5 = deterministic();
  yaw = 0;
  for (let i = 0; i <= 10; i++) yaw += c5.update({ time: i / 60, lengthScale: 3, right: hand(0.01 * i, 0, 0.3, 0.005) }).yaw;
  near(yaw, 3.0, 1e-9);
});

test('hand-relative motion: a scaled hand turns the subject by the same angle for the same finger travel', () => {
  // A double-size hand (palm 0.19) dragging 0.20 m == a reference hand dragging 0.10 m.
  const big = deterministic();
  const ref = deterministic();
  let yawBig = 0;
  let yawRef = 0;
  for (let i = 0; i <= 10; i++) {
    yawBig += big.update({ time: i / 60, right: hand(0.02 * i, 0, 0.3, 0.02, 0.19) }).yaw;
    yawRef += ref.update({ time: i / 60, right: hand(0.01 * i, 0, 0.3, 0.01, 0.095) }).yaw;
  }
  near(yawBig, 1.0, 1e-9);
  near(yawRef, 1.0, 1e-9);
  // Two double-size hands 2 m apart are a plausible pair (1 m for a reference hand); their zoom is
  // the separation ratio as before.
  const c = deterministic();
  let d = c.update({ time: 0, left: hand(-1.0, 0, 0.3, 0.02, 0.19), right: hand(1.0, 0, 0.3, 0.02, 0.19) });
  assert.ok(d.twoHand, 'scaled hands inside the scaled guard');
  d = c.update({ time: 1 / 60, left: hand(-1.1, 0, 0.3, 0.02, 0.19), right: hand(1.1, 0, 0.3, 0.02, 0.19) });
  near(d.zoom, 1.1, 1e-9);
  // Without a palm length nothing scales: 2 m apart is over the metre guard.
  const u = deterministic();
  assert.ok(!u.update({ time: 0, left: hand(-1.0, 0, 0.3, 0.01), right: hand(1.0, 0, 0.3, 0.01) }).any);
});

// ── the session side ────────────────────────────────────────────────────────────────────────

/** A joint space whose pose fillPoses writes: translation only. */
const J = (x, y, z) => ({ x, y, z });
/** A fake XRHand: 25 joint spaces, `values()` in spec order, positions from `at(name)`. */
function fakeHand(handedness, at) {
  const spaces = HAND_JOINTS.map((name) => ({ jointName: name, ...at(name) }));
  const hand = { size: 25, values: () => spaces[Symbol.iterator](), get: (n) => spaces[HAND_JOINTS.indexOf(n)] };
  return { handedness, targetRayMode: 'tracked-pointer', profiles: ['generic-hand'], hand };
}
function fakeSession() {
  const listeners = new Map();
  const rafs = [];
  const s = {
    inputSources: [],
    handInputWithheldReason: null,
    requestAnimationFrame(cb) {
      rafs.push(cb);
      return rafs.length;
    },
    cancelAnimationFrame(id) {
      rafs[id - 1] = null;
    },
    addEventListener(t, cb) {
      listeners.set(t, [...(listeners.get(t) || []), cb]);
    },
    removeEventListener(t, cb) {
      listeners.set(t, (listeners.get(t) || []).filter((f) => f !== cb));
    },
    listenerCount: (t) => (listeners.get(t) || []).length,
    /** Run one session frame at `tMs`. */
    frame(tMs, tracked = true) {
      const batch = rafs.splice(0, rafs.length);
      const frame = {
        fillPoses(spaces, ref, out) {
          if (!tracked) return false;
          spaces.forEach((sp, i) => {
            out[i * 16 + 12] = sp.x;
            out[i * 16 + 13] = sp.y;
            out[i * 16 + 14] = sp.z;
          });
          return true;
        },
        fillJointRadii(spaces, out) {
          spaces.forEach((_, i) => (out[i] = 0.008));
          return true;
        },
      };
      for (const cb of batch) if (cb) cb(tMs, frame);
      return batch.filter(Boolean).length;
    },
    emit(t, e) {
      for (const cb of listeners.get(t) || []) cb(e);
    },
  };
  return s;
}
/** A right hand at pinch point (x, y, z), tips `open` apart, palm 9.5 cm. */
const rightAt = (x, y, z, open) =>
  fakeHand('right', (n) => {
    if (n === 'thumb-tip') return J(x - open / 2, y, z);
    if (n === 'index-finger-tip') return J(x + open / 2, y, z);
    if (n === 'wrist') return J(x, y - 0.095, z);
    return J(x, y, z); // middle knuckle at the pinch point → palm 0.095
  });

test('watchHands: no session → inert, never throws, reports unknown', () => {
  const calls = [];
  for (const wall of [null, undefined, { supported: false }, { supported: true, session: {} }]) {
    const w = watchHands(wall, (f) => calls.push(f));
    assert.equal(w.running, false);
    assert.equal(w.state.gate, 'unknown');
    w.stop();
  }
  assert.equal(calls.length, 0);
});

test('watchHands: fills samples from the hand sources each frame, reports the gate, stops with the session', () => {
  const session = fakeSession();
  const wall = { supported: true, session, refSpace: {} };
  const frames = [];
  const changes = [];
  const w = watchHands(wall, (f) => frames.push(f), { onChange: (e) => changes.push(e) });
  assert.equal(w.running, true);
  session.frame(1000);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].hands, 0);
  assert.equal(frames[0].gate, 'available');
  assert.equal(frames[0].left, null);
  const src = rightAt(0.1, 0.05, 0.3, 0.02);
  session.inputSources = [src];
  session.emit('inputsourceschange', { added: [src, { handedness: 'none' }], removed: [] });
  assert.deepEqual(changes, [{ added: [src], removed: [] }], 'only hand sources are reported');
  session.frame(1016);
  const f = frames[1];
  assert.equal(f.hands, 1);
  assert.equal(f.left, null);
  assert.equal(f.right.handedness, 'right');
  const near3 = (a, b) => a.forEach((v, i) => near(v, b[i], 1e-6)); // Float32 poses
  near3(f.right.thumbTip, [0.09, 0.05, 0.3]);
  near3(f.right.indexTip, [0.11, 0.05, 0.3]);
  near3(f.right.joint('wrist'), [0.1, -0.045, 0.3]);
  near(f.right.palmLength, 0.095, 1e-6);
  near(f.right.radii[0], 0.008, 1e-6); // Float32
  near(f.time, 1.016, 1e-9);
  session.handInputWithheldReason = 'not-fullscreen';
  session.frame(1032, false);
  assert.equal(frames[2].gate, 'not-fullscreen');
  assert.equal(frames[2].hands, 0, 'a fillPoses that fails is an untracked hand');
  assert.equal(w.state.gate, 'not-fullscreen');
  session.emit('end');
  assert.equal(w.running, false);
  assert.equal(session.frame(1048), 0, 'no frame callback left after end');
  assert.equal(session.listenerCount('inputsourceschange'), 0);
});

test('handGate: unknown without the surface, available on null, the reason otherwise', () => {
  assert.equal(handGate(null), 'unknown');
  assert.equal(handGate({}), 'unknown');
  assert.equal(handGate({ handInputWithheldReason: null }), 'available');
  assert.equal(handGate({ handInputWithheldReason: 'camera-rig' }), 'camera-rig');
});

test('handControls: a pinch drag nudges the viewer in DEGREES; two hands zoom; roll goes where supported', () => {
  const session = fakeSession();
  const wall = { supported: true, session, refSpace: {} };
  const nudges = [];
  const viewer = { nudgePose: (d) => nudges.push(d) };
  const handle = { viewer: null, setPose() {} }; // the backend has not loaded yet
  const ctl = handControls(wall, handle, { gestures: { smoothTauS: 0 } });
  session.inputSources = [rightAt(0, 0, 0.3, 0.01)];
  session.frame(0);
  session.inputSources = [rightAt(0.1, 0, 0.3, 0.01)];
  session.frame(16);
  assert.equal(nudges.length, 0, 'no viewer yet: the gesture is anchored but nothing is driven');
  handle.viewer = viewer;
  session.inputSources = [rightAt(0.2, 0.05, 0.3, 0.01)];
  session.frame(32);
  assert.equal(nudges.length, 1);
  near(nudges[0].yaw, (0.1 * 10 * 180) / Math.PI, 1e-4); // Float32 poses
  near(nudges[0].pitch, (-0.05 * 10 * 180) / Math.PI, 1e-4);
  assert.equal(nudges[0].zoom, 1);
  assert.equal(nudges[0].roll, 0);
  assert.ok(ctl.controller.pinched('right'));
  // Two hands: spread 0.2 → 0.24 is zoom 1.2.
  const left = fakeHand('left', (n) => (n === 'thumb-tip' ? J(-0.105, 0, 0.3) : n === 'index-finger-tip' ? J(-0.095, 0, 0.3) : J(-0.1, 0, 0.3)));
  session.inputSources = [left, rightAt(0.1, 0, 0.3, 0.01)];
  session.frame(48);
  session.inputSources = [left, rightAt(0.14, 0, 0.3, 0.01)];
  session.frame(64);
  const z = nudges[nudges.length - 1];
  near(z.zoom, 1.2, 1e-5);
  ctl.stop();
  assert.equal(ctl.running, false);
  session.frame(80);
  assert.equal(nudges.length, 3, 'stopped: no more nudges');
});

test('handControls: without nudgePose, falls back to getPose + setPose', () => {
  const session = fakeSession();
  const wall = { supported: true, session, refSpace: {} };
  const pose = { yaw: 10, pitch: 0, zoom: 1 };
  const viewer = { getPose: () => ({ ...pose }), setPose: (p) => Object.assign(pose, p) };
  handControls(wall, viewer, { gestures: { smoothTauS: 0 } });
  session.inputSources = [rightAt(0, 0, 0.3, 0.01)];
  session.frame(0);
  session.inputSources = [rightAt(0.1, 0, 0.3, 0.01)];
  session.frame(16);
  near(pose.yaw, 10 + (1.0 * 180) / Math.PI, 1e-4);
});

test('attachHandsOption: wires once, exposes handle.hands, and the stop rides remove() through reassignment', () => {
  const session = fakeSession();
  const wall = { supported: true, session, refSpace: {} };
  let removed = 0;
  const handle = { viewer: null, remove: () => removed++ };
  assert.equal(attachHandsOption(wall, handle, {}), null, 'no option, nothing attached');
  const ctl = attachHandsOption(wall, handle, { hands: true });
  assert.ok(ctl && handle.hands === ctl && ctl.running);
  assert.equal(attachHandsOption(wall, handle, { hands: true }), null, 'a second call does not double-wire');
  // An adapter reassigns remove() after its module loads, as the PlayCanvas path does.
  let removed2 = 0;
  handle.remove = () => removed2++;
  handle.remove();
  assert.equal(removed, 0);
  assert.equal(removed2, 1, 'the reassigned remove ran');
  assert.equal(ctl.running, false, 'and the hands stopped with it');
});

test('attachHandsOption composes with the core claim accessor on remove', () => {
  const session = fakeSession();
  const wall = { supported: true, session, refSpace: {} };
  // The core's _claim shape: an accessor whose setter swaps the implementation.
  const handle = { viewer: null };
  let impl = () => 'core-initial';
  const coreRemove = (...a) => impl(...a);
  Object.defineProperty(handle, 'remove', { configurable: true, enumerable: true, get: () => coreRemove, set: (fn) => (impl = fn) });
  const ctl = attachHandsOption(wall, handle, { hands: {} });
  handle.remove = () => 'adapter';
  assert.equal(handle.remove(), 'adapter', 'the adapter implementation ran through the core wrapper');
  assert.equal(ctl.running, false);
});

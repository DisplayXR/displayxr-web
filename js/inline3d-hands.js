// inline3d-hands.js — `@displayxr/inline3d/hands`: tracked hands on an inline-3D session, and
// the pinch gestures that drive a viewer's orbit from them.
//
// EXPERIMENTAL — a scene subpath, not covered by the 1.x semver promise (docs/sdk-stability.md).
//
// WHAT THE BROWSER GIVES US. From DisplayXR Browser 1.8.0 (Windows) an ordinary `inline-3d`
// session exposes standard WebXR Hand Input when the runtime has a hand provider (an Ultraleap
// tracker today): one `XRInputSource` per tracked hand (`handedness`, `profiles: ['generic-hand']`,
// `.hand` = the 25-joint XRHand), `inputsourceschange` as hands appear and vanish, and
// `XRFrame.fillPoses()` / `fillJointRadii()` against any reference space the page asked for. The
// joints arrive in the SAME rig frame as the eye views, so a joint drawn where the API puts it sits
// on the real hand, and a hand over a tile is measured in that tile's rig metres.
//
// WHAT IT DOES NOT GIVE US. No `select` / `squeeze` events on a hand source (browser-pvt#321), no
// controllers, no haptics. A pinch has to be computed from the thumb-tip / index-tip distance, and
// that is what `HandGestureController` does — a port of the DisplayXR Model Viewer's gesture math,
// signed off on the panel: hand-relative pinch thresholds, one pinched hand orbits, two pinched
// hands zoom / roll / orbit.
//
// GATE. Hands are delivered per frame only when the browser can place them in the element's rig:
// `XRSession.handInputWithheldReason` is `null` when they can be, else a reason string
// (`'camera-rig'`, `'posed-rig'`, `'rig-factors'`, `'no-canvas'`, `'not-fullscreen'`,
// `'scaled-rig'`). On a display rig (what `addModel` / `addSplat` / `addScene` use by default) they
// are available when the runtime supports rig-scoped joints (runtime v2.59+). This module surfaces
// that as `state.gate` rather than hiding it: a page that shows "hands off: not fullscreen" is
// better than one whose hands silently do nothing.
//
// Everywhere else — every other browser, the DisplayXR Browser on a box with no hand provider, a
// session with no `XRHand` — this module is inert: `watchHands` runs, reports no hands, and
// `handControls` moves nothing. Pointer and wheel orbit keep working regardless.
//
//   import { createInline3D } from '@displayxr/inline3d';
//   import { addModel } from '@displayxr/inline3d/model';
//
//   const wall = await createInline3D({ lazy: false });
//   addModel(wall, canvas, 'helmet.glb', { hands: true });   // pinch to turn, two pinches to zoom
//
//   // or, by hand, on anything with the viewer pose surface:
//   import { handControls } from '@displayxr/inline3d/hands';
//   const ctl = handControls(wall, handle);   ctl.state.gate   ctl.stop()

/** The 25 WebXR hand joints, in `XRHand` iteration order. */
export const HAND_JOINTS = Object.freeze([
  'wrist',
  'thumb-metacarpal',
  'thumb-phalanx-proximal',
  'thumb-phalanx-distal',
  'thumb-tip',
  'index-finger-metacarpal',
  'index-finger-phalanx-proximal',
  'index-finger-phalanx-intermediate',
  'index-finger-phalanx-distal',
  'index-finger-tip',
  'middle-finger-metacarpal',
  'middle-finger-phalanx-proximal',
  'middle-finger-phalanx-intermediate',
  'middle-finger-phalanx-distal',
  'middle-finger-tip',
  'ring-finger-metacarpal',
  'ring-finger-phalanx-proximal',
  'ring-finger-phalanx-intermediate',
  'ring-finger-phalanx-distal',
  'ring-finger-tip',
  'pinky-finger-metacarpal',
  'pinky-finger-phalanx-proximal',
  'pinky-finger-phalanx-intermediate',
  'pinky-finger-phalanx-distal',
  'pinky-finger-tip',
]);

const JOINT_INDEX = new Map(HAND_JOINTS.map((n, i) => [n, i]));
const WRIST = JOINT_INDEX.get('wrist');
const THUMB_TIP = JOINT_INDEX.get('thumb-tip');
const INDEX_TIP = JOINT_INDEX.get('index-finger-tip');
const MIDDLE_KNUCKLE = JOINT_INDEX.get('middle-finger-phalanx-proximal');

/**
 * The gesture tuning, as the Model Viewer ships it. Distances in metres of the hand's own frame
 * (the rig frame the joints are reported in), angles in radians.
 */
export const HAND_GESTURE_DEFAULTS = Object.freeze({
  /** Thumb-tip to index-tip distance that STARTS a pinch, for a hand of `referencePalmM`. */
  pinchEnterM: 0.025,
  /** Distance that ENDS it (> enter: hysteresis, so a held pinch does not flicker). */
  pinchExitM: 0.04,
  /**
   * Palm length (wrist → middle knuckle) the pinch distances are stated for. A sample's own palm
   * length scales them: a hand delivered at a gain, or scaled into a small tile, pinches at the
   * same finger posture as a physical one. 0 = never scale.
   */
  referencePalmM: 0.095,
  /** Radians of orbit per metre of pinch-point drag, for a `referencePalmM` hand — 10 cm is about 57°. */
  orbitRadPerM: 10,
  /** EMA time constant on the pinch point, seconds; 0 = off. Smooths tracker jitter before differencing. */
  smoothTauS: 0.05,
  /** Per-frame zoom ratio clamp, both ways — one bad sample cannot slam the zoom. */
  maxZoomStep: 1.25,
  /** Two-hand gestures are ignored (and their baseline dropped) while the hands are further apart than this, for `referencePalmM` hands. */
  maxHandSeparationM: 1.2,
});

/** Two-threshold pinch state. `update` returns the new state. */
export class PinchDetector {
  constructor() {
    this._pinched = false;
  }
  get pinched() {
    return this._pinched;
  }
  reset() {
    this._pinched = false;
  }
  /**
   * @param {boolean} tracked  false releases regardless of distance
   * @param {number} tipDistance  thumb-tip to index-tip, metres
   * @param {number} enter  start threshold
   * @param {number} exit  end threshold (> enter)
   */
  update(tracked, tipDistance, enter, exit) {
    if (!tracked) {
      this._pinched = false;
      return false;
    }
    if (this._pinched) {
      if (tipDistance > exit) this._pinched = false;
    } else if (tipDistance < enter) {
      this._pinched = true;
    }
    return this._pinched;
  }
}

const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Wrap an angle difference into (-π, π]. */
function wrapAngle(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a <= -Math.PI) a += 2 * Math.PI;
  return a;
}

/**
 * Pinch gestures → pose deltas, per frame. Pure arithmetic: no DOM, no WebXR, no engine — feed it
 * `{ time, left, right, lengthScale }` and read `{ yaw, pitch, roll, zoom, oneHand, twoHand }`.
 *
 * Deltas are in the SUBJECT's convention, the one `SceneViewer.nudgePose` takes: a pinch dragged
 * RIGHT turns the near face right (yaw +), dragged UP tilts it up (pitch −, since +pitch tilts the
 * near face down), two hands turning counter-clockwise as the viewer sees them roll the subject
 * counter-clockwise (roll +), and spreading them zooms in (zoom > 1). That is also what a pointer
 * drag on the same viewer does. (The native Model Viewer rotates its RIG instead, so its yaw / roll
 * are the negation of these — same gesture, same picture.)
 *
 * - pinch = thumb tip to index tip below `pinchEnterM`, until above `pinchExitM`, both scaled by
 *   `palmLength / referencePalmM` when a sample carries its palm length — and so is every other
 *   distance: the orbit gain and the separation guard are stated for a reference-size hand, so a
 *   hand that arrives scaled (a provider gain, a rig scale, a small tile) behaves the same;
 * - one hand pinched and moving = ORBIT: lateral motion × `orbitRadPerM` → yaw (x) and pitch (y);
 * - both hands pinched: separation ratio = ZOOM, rotation of the inter-hand vector in the display
 *   plane = ROLL, midpoint drag = ORBIT;
 * - the pinch point (midpoint of the two tips) is EMA-smoothed before differencing;
 * - the first frame of any gesture anchors and yields no delta; a hand lost or a hand gained
 *   re-anchors, so a mode change never produces a jump.
 */
export class HandGestureController {
  /** @param {Partial<typeof HAND_GESTURE_DEFAULTS>} [config] */
  constructor(config = {}) {
    this.config = { ...HAND_GESTURE_DEFAULTS, ...config };
    this._pinch = [new PinchDetector(), new PinchDetector()];
    this._tipDist = [-1, -1];
    this._handScale = [1, 1];
    this._point = [[0, 0, 0], [0, 0, 0]];
    this._pointValid = [false, false];
    this._prevOne = [false, false];
    this._prevPoint = [[0, 0, 0], [0, 0, 0]];
    this._prevTwo = false;
    this._prevMid = [0, 0, 0];
    this._prevDist = 0;
    this._prevAngle = 0;
    this._prevTime = -1;
  }

  /** Pinch state of a hand after the last update (`0` left, `1` right, or `'left'` / `'right'`). */
  pinched(hand) {
    return this._pinch[handIndex(hand)].pinched;
  }
  /** Last measured thumb-index tip distance, metres; < 0 when untracked. */
  tipDistance(hand) {
    return this._tipDist[handIndex(hand)];
  }
  /** Forget every anchor (tracking lost for a while, a page-side reset). */
  reset() {
    for (let h = 0; h < 2; h++) {
      this._pinch[h].reset();
      this._tipDist[h] = -1;
      this._pointValid[h] = false;
      this._prevOne[h] = false;
    }
    this._prevTwo = false;
    this._prevTime = -1;
  }

  /**
   * Feed one frame. `left` / `right`: `{ thumbTip:[x,y,z], indexTip:[x,y,z], palmLength? }` or
   * null / `{ tracked:false }` when the hand is not tracked. `time` in seconds (any origin);
   * `lengthScale` multiplies every position first (1 = as given).
   *
   * @returns {{yaw:number, pitch:number, roll:number, zoom:number, oneHand:boolean, twoHand:boolean, any:boolean}}
   *          yaw / pitch / roll in radians to ADD, zoom a ratio to MULTIPLY.
   */
  update({ time = 0, left = null, right = null, lengthScale = 1 } = {}) {
    const cfg = this.config;
    const out = { yaw: 0, pitch: 0, roll: 0, zoom: 1, oneHand: false, twoHand: false, any: false };

    // Frame interval for the EMA. The first frame, a stalled clock or a long gap all count as "no
    // smoothing history" rather than a huge step.
    let dt = 0;
    if (this._prevTime >= 0 && time > this._prevTime) dt = Math.min(time - this._prevTime, 0.25);
    this._prevTime = time;

    const ls = lengthScale > 0 ? lengthScale : 1;
    const samples = [left, right];
    const pinched = [false, false];
    for (let h = 0; h < 2; h++) {
      const s = samples[h];
      if (!s || s.tracked === false || !s.thumbTip || !s.indexTip) {
        this._pinch[h].reset();
        this._tipDist[h] = -1;
        this._pointValid[h] = false;
        continue;
      }
      const thumb = [s.thumbTip[0] * ls, s.thumbTip[1] * ls, s.thumbTip[2] * ls];
      const index = [s.indexTip[0] * ls, s.indexTip[1] * ls, s.indexTip[2] * ls];
      this._tipDist[h] = dist3(thumb, index);
      // Hand-relative thresholds: a known palm length scales the metre distances to this hand's
      // size, gain and all.
      let enter = cfg.pinchEnterM;
      let exit = cfg.pinchExitM;
      let hs = 1;
      if (s.palmLength > 0 && cfg.referencePalmM > 0) {
        hs = (s.palmLength * ls) / cfg.referencePalmM;
        enter *= hs;
        exit *= hs;
      }
      this._handScale[h] = hs;
      pinched[h] = this._pinch[h].update(true, this._tipDist[h], enter, exit);

      // The pinch point is the midpoint of the two tips; smooth it.
      const raw = [0.5 * (thumb[0] + index[0]), 0.5 * (thumb[1] + index[1]), 0.5 * (thumb[2] + index[2])];
      const p = this._point[h];
      if (!this._pointValid[h] || cfg.smoothTauS <= 0 || dt <= 0) {
        p[0] = raw[0];
        p[1] = raw[1];
        p[2] = raw[2];
      } else {
        const alpha = 1 - Math.exp(-dt / cfg.smoothTauS);
        for (let i = 0; i < 3; i++) p[i] += alpha * (raw[i] - p[i]);
      }
      this._pointValid[h] = true;
    }

    let two = pinched[0] && pinched[1];
    // HAND-RELATIVE MOTION, like the pinch. Every distance below is divided by the pinched hands'
    // size factor (palm / referencePalmM; 1 when unknown), so the orbit gain and the separation
    // guard are stated for a reference-size hand and a hand that arrives scaled — a provider gain,
    // a rig scale, a small tile — turns the subject by the same angle for the same finger travel.
    const hsAll = two
      ? 0.5 * (this._handScale[0] + this._handScale[1])
      : pinched[0]
        ? this._handScale[0]
        : pinched[1]
          ? this._handScale[1]
          : 1;
    const mid = [0, 0, 0];
    const v = [0, 0, 0];
    let d = 0;
    if (two) {
      const [a, b] = this._point;
      for (let i = 0; i < 3; i++) {
        mid[i] = 0.5 * (a[i] + b[i]);
        v[i] = b[i] - a[i];
      }
      d = Math.hypot(v[0], v[1], v[2]);
      // Implausibly far apart: not a gesture. Drop the baseline so the next plausible frame
      // re-anchors instead of integrating the glitch.
      if (d / hsAll > cfg.maxHandSeparationM) {
        this._prevTwo = false;
        this._prevOne[0] = this._prevOne[1] = false;
        return out;
      }
    }
    const one = !two && pinched[0] ? 0 : !two && pinched[1] ? 1 : -1;
    const k = cfg.orbitRadPerM / hsAll;

    if (two) {
      out.twoHand = out.any = true;
      // Roll is measured in the display plane (XY); the view axis is Z.
      const angle = Math.atan2(v[1], v[0]);
      if (this._prevTwo) {
        // Midpoint drag = orbit, in the subject's convention (see the class comment).
        out.yaw = (mid[0] - this._prevMid[0]) * k;
        out.pitch = -(mid[1] - this._prevMid[1]) * k;
        // Separation ratio = zoom, clamped so one bad sample cannot slam it.
        if (this._prevDist > 1e-4 && d > 1e-4) {
          out.zoom = Math.min(cfg.maxZoomStep, Math.max(1 / cfg.maxZoomStep, d / this._prevDist));
        }
        // The hands turning counter-clockwise (as the viewer sees them) turn the subject
        // counter-clockwise on screen.
        out.roll = wrapAngle(angle - this._prevAngle);
      }
      this._prevMid[0] = mid[0];
      this._prevMid[1] = mid[1];
      this._prevMid[2] = mid[2];
      this._prevDist = d;
      this._prevAngle = angle;
      this._prevTwo = true;
      this._prevOne[0] = this._prevOne[1] = false;
    } else if (one >= 0) {
      out.oneHand = out.any = true;
      const p = this._point[one];
      const q = this._prevPoint[one];
      if (this._prevOne[one]) {
        out.yaw = (p[0] - q[0]) * k;
        out.pitch = -(p[1] - q[1]) * k;
      }
      q[0] = p[0];
      q[1] = p[1];
      q[2] = p[2];
      this._prevOne[one] = true;
      this._prevOne[one ^ 1] = false;
      this._prevTwo = false;
    } else {
      this._prevTwo = false;
      this._prevOne[0] = this._prevOne[1] = false;
    }
    return out;
  }
}

function handIndex(hand) {
  if (hand === 'left') return 0;
  if (hand === 'right') return 1;
  return hand & 1;
}

// ── the session side ──────────────────────────────────────────────────────────────────────────

/** Can this document deliver hand sources at all? (`XRHand` is the Hand Input module's marker.) */
export function handInputAvailable() {
  return typeof XRHand === 'function' || typeof XRHand === 'object';
}

/**
 * The browser's per-frame hand gate, as a string: `'available'` when hands can be delivered,
 * the withheld reason otherwise, `'unknown'` where the session has no such surface (not a
 * DisplayXR Browser, or one before 1.8.0).
 */
export function handGate(session) {
  if (!session || typeof session !== 'object' || !('handInputWithheldReason' in session)) return 'unknown';
  const r = session.handInputWithheldReason;
  return r === null || r === undefined ? 'available' : String(r);
}

const jointsOf = new WeakMap(); // XRInputSource → XRJointSpace[] (hand.values() is stable per source)

/**
 * One tracked hand, as `watchHands` reports it. Positions are `[x, y, z]` metres in the watch's
 * reference space (the SDK's `viewer` space by default: the rig frame the eye views use).
 *
 * @typedef {object} HandSample
 * @property {boolean} tracked
 * @property {'left'|'right'|'none'} handedness
 * @property {Float32Array} poses  25 × 16 column-major joint transforms (`fillPoses`)
 * @property {Float32Array} radii  25 joint radii, metres (`fillJointRadii`)
 * @property {(name: string) => number[]} joint  position of a joint by WebXR name
 * @property {number[]} wrist
 * @property {number[]} thumbTip
 * @property {number[]} indexTip
 * @property {number} palmLength  wrist → middle knuckle, metres (0 if unknown)
 * @property {XRInputSource} source
 */

function makeSample(source) {
  const poses = new Float32Array(HAND_JOINTS.length * 16);
  const radii = new Float32Array(HAND_JOINTS.length);
  const pos = (i) => [poses[i * 16 + 12], poses[i * 16 + 13], poses[i * 16 + 14]];
  const s = {
    tracked: false,
    handedness: source.handedness || 'none',
    poses,
    radii,
    joint(name) {
      const i = JOINT_INDEX.get(name);
      return i === undefined ? null : pos(i);
    },
    wrist: [0, 0, 0],
    thumbTip: [0, 0, 0],
    indexTip: [0, 0, 0],
    palmLength: 0,
    source,
  };
  return s;
}

function fillSample(s, frame, refSpace) {
  const hand = s.source.hand;
  let joints = jointsOf.get(s.source);
  if (!joints) {
    joints = Array.from(hand.values());
    jointsOf.set(s.source, joints);
  }
  if (joints.length !== HAND_JOINTS.length) return false;
  if (!frame.fillPoses(joints, refSpace, s.poses)) return false;
  if (typeof frame.fillJointRadii === 'function') frame.fillJointRadii(joints, s.radii);
  const p = (i) => [s.poses[i * 16 + 12], s.poses[i * 16 + 13], s.poses[i * 16 + 14]];
  s.wrist = p(WRIST);
  s.thumbTip = p(THUMB_TIP);
  s.indexTip = p(INDEX_TIP);
  s.palmLength = dist3(s.wrist, p(MIDDLE_KNUCKLE));
  return true;
}

/**
 * Watch the hands on an inline-3D session. Runs its own `session.requestAnimationFrame` loop (a
 * second callback per frame beside the SDK's own, which WebXR allows) and calls `onFrame` every
 * session frame with `{ time, gate, left, right, hands }` — `left` / `right` a `HandSample` or
 * null, `hands` the number tracked this frame, `gate` as `handGate()`.
 *
 * Inert where there are no hands: the callback still fires with both hands null, so a page can
 * draw its "no hands" state from the same place. Stops itself when the session ends.
 *
 * @param {object} wall  the `createInline3D()` result (uses `wall.session` and `wall.refSpace`)
 * @param {(f: {time:number, gate:string, left:HandSample|null, right:HandSample|null, hands:number}) => void} onFrame
 * @param {object} [opts]
 * @param {XRReferenceSpace} [opts.referenceSpace]  joints are located in this space (default: the wall's)
 * @param {(e: {added: XRInputSource[], removed: XRInputSource[]}) => void} [opts.onChange]  `inputsourceschange`, hand sources only
 * @returns {{ stop(): void, readonly running: boolean, readonly state: {gate:string, hands:number, supported:boolean} }}
 */
export function watchHands(wall, onFrame, opts = {}) {
  const session = wall && wall.supported !== false ? wall.session : null;
  const state = { gate: 'unknown', hands: 0, supported: false };
  let running = false;
  if (!session || typeof session.requestAnimationFrame !== 'function') {
    return { stop() {}, get running() { return false; }, state };
  }
  state.supported = handInputAvailable();
  const refSpace = opts.referenceSpace || wall.refSpace || null;
  const samples = new WeakMap(); // source → HandSample
  let rafId = 0;
  running = true;

  const onChange = (e) => {
    if (typeof opts.onChange !== 'function') return;
    const isHand = (s) => !!(s && s.hand);
    const added = Array.from(e.added || []).filter(isHand);
    const removed = Array.from(e.removed || []).filter(isHand);
    if (added.length || removed.length) opts.onChange({ added, removed });
  };
  const onEnd = () => stop();
  session.addEventListener('inputsourceschange', onChange);
  session.addEventListener('end', onEnd);

  const tick = (t, frame) => {
    if (!running) return;
    rafId = session.requestAnimationFrame(tick);
    state.gate = handGate(session);
    let left = null;
    let right = null;
    let hands = 0;
    const sources = session.inputSources;
    if (refSpace && sources && sources.length) {
      for (const src of sources) {
        if (!src || !src.hand) continue;
        let s = samples.get(src);
        if (!s) {
          s = makeSample(src);
          samples.set(src, s);
        }
        s.tracked = fillSample(s, frame, refSpace);
        if (!s.tracked) continue;
        hands++;
        if (src.handedness === 'left') left = s;
        else if (src.handedness === 'right') right = s;
        else if (!right) right = s;
        else if (!left) left = s;
      }
    }
    state.hands = hands;
    onFrame({ time: t / 1000, gate: state.gate, left, right, hands, frame });
  };
  rafId = session.requestAnimationFrame(tick);

  function stop() {
    if (!running) return;
    running = false;
    try {
      if (rafId && typeof session.cancelAnimationFrame === 'function') session.cancelAnimationFrame(rafId);
    } catch {
      /* a session that has already ended */
    }
    session.removeEventListener('inputsourceschange', onChange);
    session.removeEventListener('end', onEnd);
  }
  return {
    stop,
    get running() {
      return running;
    },
    state,
  };
}

const RAD2DEG = 180 / Math.PI;

/**
 * Drive a viewer's orbit from the hands: pinch to turn, two pinches to zoom and roll. `target`
 * is anything with the viewer pose surface — an `addModel` / `addSplat` handle (its `viewer`
 * is read each frame, so a handle whose backend has not loaded yet is fine), a `SceneViewer`,
 * or the PlayCanvas backend's viewer. Prefers `viewer.nudgePose()` (which also counts as input
 * for the idle turntable); falls back to `getPose` + `setPose` on anything else that has them.
 *
 * Opt-in, and inert without hands. Pointer and wheel orbit keep working alongside.
 *
 * @param {object} wall
 * @param {object} target
 * @param {object} [opts]
 * @param {Partial<typeof HAND_GESTURE_DEFAULTS>} [opts.gestures]  controller tuning
 * @param {number} [opts.lengthScale=1]  multiplies every hand position before the gesture math
 * @param {boolean} [opts.roll=true]  apply the two-hand roll (where the viewer supports it)
 * @param {boolean} [opts.zoom=true]  apply the two-hand zoom
 * @param {XRReferenceSpace} [opts.referenceSpace]
 * @param {(f: object, d: object) => void} [opts.onFrame]  after each frame: the hands frame and the gesture delta
 * @returns {{ stop(): void, readonly running: boolean, controller: HandGestureController, state: object }}
 */
export function handControls(wall, target, opts = {}) {
  const controller = new HandGestureController(opts.gestures);
  const lengthScale = opts.lengthScale > 0 ? opts.lengthScale : 1;
  const applyRoll = opts.roll !== false;
  const applyZoom = opts.zoom !== false;
  const viewerOf = () => {
    if (!target) return null;
    if (typeof target.nudgePose === 'function' || typeof target.setPose === 'function') {
      // A viewer itself — or a handle that also carries setPose. Prefer a handle's viewer: the
      // handle's setPose on PlayCanvas is a queued proxy before the backend loads.
      if (target.viewer && typeof target.viewer === 'object') return target.viewer;
      return target;
    }
    return target.viewer || null;
  };
  const watch = watchHands(
    wall,
    (f) => {
      const d = controller.update({ time: f.time, left: f.left, right: f.right, lengthScale });
      if (d.any) {
        const viewer = viewerOf();
        if (viewer) {
          const delta = {
            yaw: d.yaw * RAD2DEG,
            pitch: d.pitch * RAD2DEG,
            zoom: applyZoom ? d.zoom : 1,
            roll: applyRoll ? d.roll * RAD2DEG : 0,
          };
          if (typeof viewer.nudgePose === 'function') viewer.nudgePose(delta);
          else if (typeof viewer.getPose === 'function' && typeof viewer.setPose === 'function') {
            const p = viewer.getPose({ target: true });
            viewer.setPose({
              yaw: p.yaw + delta.yaw,
              pitch: p.pitch + delta.pitch,
              zoom: p.zoom * delta.zoom,
              ...(p.roll !== undefined && delta.roll ? { roll: p.roll + delta.roll } : {}),
            });
          }
        }
      }
      if (typeof opts.onFrame === 'function') opts.onFrame(f, d);
    },
    { referenceSpace: opts.referenceSpace, onChange: opts.onChange },
  );
  return {
    stop: watch.stop,
    get running() {
      return watch.running;
    },
    controller,
    state: watch.state,
  };
}

/**
 * Attach `hands` to a subpath handle when its options ask for it — the shared seam `addModel`
 * and `addSplat` (every entry, both engines) go through. `hands: true` or an options object.
 * The controls stop with the handle's `remove()`, however many times the adapters reassign it,
 * and are exposed as `handle.hands` (`stop()`, `state.gate`, `controller`).
 */
export function attachHandsOption(wall, handle, opts) {
  const want = opts && opts.hands;
  if (!want || !handle || typeof handle !== 'object' || handle.hands) return null;
  const ctl = handControls(wall, handle, want === true ? {} : want);
  Object.defineProperty(handle, 'hands', { value: ctl, enumerable: true, configurable: true, writable: false });
  // Ride whatever `remove` is or becomes: the core's claim already wraps it in an accessor and the
  // adapters assign through that setter when their module loads; compose with either shape.
  const desc = Object.getOwnPropertyDescriptor(handle, 'remove');
  let impl = desc && typeof desc.get === 'function' ? null : handle.remove;
  const remove = (...args) => {
    ctl.stop();
    const fn = desc && typeof desc.get === 'function' ? desc.get.call(handle) : impl;
    return typeof fn === 'function' ? fn.apply(handle, args) : undefined;
  };
  Object.defineProperty(handle, 'remove', {
    configurable: true,
    enumerable: true,
    get: () => remove,
    set: (fn) => {
      if (desc && typeof desc.set === 'function') desc.set.call(handle, fn);
      else impl = fn;
    },
  });
  return ctl;
}

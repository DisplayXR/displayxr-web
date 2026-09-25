// lift/orbit.js — the "Convert to 3D" explore orbit: drag → turntable tilt about the pivot,
// capped, relaxing back to rest on release. Pure math, no DOM, no three.js — unit-tested in
// test/lift-explore-orbit.test.mjs.
//
// This is the gallery's Spatial View drag (displayxr-gallery-pvt src/lib/spatialView/camera.ts
// `orbitFromDrag` + `MAX_ANGLE_DEG`) and the PlayCanvas backend's TILT-AND-RELAX easing
// (js/inline3d-splat-playcanvas.js `_bindOrbit`, constants in ./inline3d-splat-shared.js §ORBIT),
// in one object so the explore renderer can own its pointer without a SceneViewer:
//
//   · The drag is a FRACTION of the canvas box (dx = Δx / width, dy = Δy / height, measured from
//     the PRESS, not cumulative), so a thumb-swipe on a tablet and a mouse on a desktop agree
//     whatever the tile's pixel size. target = clamp(dx · gain, ±max); gain defaults to 2·max,
//     so a HALF-width swipe reaches the cap and no further (David approved this mapping:
//     "fraction of canvas, ±15° half-width swipe; never pixel/cumulative").
//   · SIGN = TURNTABLE: the scene follows the finger. +dx ⇒ +yaw, and Ry(+θ) about the focus
//     point swings content NEARER than the focus toward +x, so dragging right slides the
//     foreground right and the background left. +dy (drag down) ⇒ +pitch; Rx(+φ) takes the near
//     side down. Same convention as SceneViewer and the gallery (David, 2026-09-07: "better if we
//     feel we move the scene / object").
//   · Easing is exponential toward the target, k = 1 − exp(−dt/τ): τ = 0.2 s while held (so the
//     scene tracks the finger with a little weight rather than jittering), τ = 0.6 s on the relax
//     after release (a slow settle home, never a snap).
//   · 15°, not 20°: at 20° real photo lifts show floaters (the splat's outer haze has no support
//     that far off the capture axis). Measured on the gallery corpus.

import { ORBIT_MAX_DEG, ORBIT_TAU_DRAG_S, ORBIT_TAU_REST_S } from '../inline3d-splat-shared.js';

export { ORBIT_MAX_DEG, ORBIT_TAU_DRAG_S, ORBIT_TAU_REST_S };

/** A press that travels less than this (CSS px, Euclidean) is a CLICK, not a drag. */
export const CLICK_SLOP_PX = 6;

/** Clamp to [lo, hi]. */
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Drag fraction → target angles, degrees. The gallery's `orbitFromDrag`, with the gain and the
 * cap as parameters (defaults: gain 2·max, max 15°).
 *
 * @param {number} dx  horizontal drag as a fraction of the canvas width (+ = right)
 * @param {number} dy  vertical drag as a fraction of the canvas height (+ = down)
 */
export function orbitFromDrag(dx, dy, maxDeg = ORBIT_MAX_DEG, gain = 2 * maxDeg) {
  return {
    yaw: clamp(dx * gain, -maxDeg, maxDeg),
    pitch: clamp(dy * gain, -maxDeg, maxDeg),
  };
}

/** Per-step easing factor for a time constant τ (seconds) over dt (seconds). τ ≤ 0 = snap. */
export function easeK(dt, tau) {
  if (!(tau > 0)) return 1;
  if (!(dt > 0)) return 0;
  return 1 - Math.exp(-dt / tau);
}

/**
 * The analytic relax curve: the fraction of the release angle still left after `t` seconds.
 * `step()` integrates exactly this (exp is closed under composition), whatever the frame rate.
 */
export function relaxRemaining(t, tau = ORBIT_TAU_REST_S) {
  return Math.exp(-Math.max(0, t) / tau);
}

/**
 * A stateful orbit. Feed it pointer fractions and a clock; read `yaw`/`pitch` (degrees).
 *
 * @param {object} [o]
 * @param {number} [o.maxAngleDeg=15]  the cap, both axes.
 * @param {boolean} [o.relax=true]  on release, ease back to the rest pose (0, 0 or setTarget's).
 *        false = the pose stays where the drag left it (a press then starts from there).
 * @param {number} [o.gain=2·max]  degrees per canvas-width of drag.
 * @param {number} [o.tauDrag=0.2]  easing time constant while held, s.
 * @param {number} [o.tauRest=0.6]  easing time constant of the relax, s.
 */
export function createOrbit(o = {}) {
  const maxDeg = Number.isFinite(o.maxAngleDeg) ? Math.abs(o.maxAngleDeg) : ORBIT_MAX_DEG;
  const gain = Number.isFinite(o.gain) ? o.gain : 2 * maxDeg;
  const relax = o.relax !== false;
  const tauDrag = Number.isFinite(o.tauDrag) ? o.tauDrag : ORBIT_TAU_DRAG_S;
  const tauRest = Number.isFinite(o.tauRest) ? o.tauRest : ORBIT_TAU_REST_S;

  const s = {
    yaw: 0,
    pitch: 0,
    targetYaw: 0,
    targetPitch: 0,
    // Rest pose: where a release relaxes to. setTarget() moves it (a page-driven pose).
    restYaw: 0,
    restPitch: 0,
    // Where the current drag's pose started from.
    baseYaw: 0,
    basePitch: 0,
    mode: null, // 'drag' | 'rest' | null (settled)
  };

  const api = {
    maxAngleDeg: maxDeg,
    gain,
    relax,
    get yaw() {
      return s.yaw;
    },
    get pitch() {
      return s.pitch;
    },
    get targetYaw() {
      return s.targetYaw;
    },
    get targetPitch() {
      return s.targetPitch;
    },
    get mode() {
      return s.mode;
    },
    /** Start a drag. The drag is measured from here. */
    press() {
      // With relax, every drag is measured from the rest pose (the gallery's absolute mapping);
      // without it, from wherever the pose was heading when pressed.
      s.baseYaw = relax ? s.restYaw : s.targetYaw;
      s.basePitch = relax ? s.restPitch : s.targetPitch;
      s.mode = 'drag';
    },
    /** Drag fractions since press (dx of width, dy of height). */
    drag(dx, dy) {
      if (s.mode !== 'drag') api.press();
      const d = orbitFromDrag(dx, dy, maxDeg, gain);
      s.targetYaw = clamp(s.baseYaw + d.yaw, -maxDeg, maxDeg);
      s.targetPitch = clamp(s.basePitch + d.pitch, -maxDeg, maxDeg);
    },
    /** End the drag: relax home (or hold, with relax:false). */
    release() {
      if (relax) {
        s.targetYaw = s.restYaw;
        s.targetPitch = s.restPitch;
        s.mode = 'rest';
      } else {
        s.mode = 'rest'; // finishes easing to the last drag target, then settles
      }
    },
    /**
     * Page-driven pose (degrees), clamped to the cap. Becomes the rest pose; eases there with the
     * relax τ. Pass `{ snap: true }` to jump.
     */
    setTarget(yaw, pitch, opt = {}) {
      s.restYaw = s.targetYaw = clamp(Number.isFinite(yaw) ? yaw : 0, -maxDeg, maxDeg);
      s.restPitch = s.targetPitch = clamp(Number.isFinite(pitch) ? pitch : 0, -maxDeg, maxDeg);
      if (opt.snap) {
        s.yaw = s.targetYaw;
        s.pitch = s.targetPitch;
        s.mode = null;
      } else if (s.mode !== 'drag') s.mode = 'rest';
    },
    /**
     * Advance the easing by dt seconds. Returns true while still moving (a caller that only
     * repaints on change can stop once it returns false).
     */
    step(dt) {
      if (s.mode === null) return false;
      const k = easeK(dt, s.mode === 'drag' ? tauDrag : tauRest);
      s.yaw += (s.targetYaw - s.yaw) * k;
      s.pitch += (s.targetPitch - s.pitch) * k;
      if (
        s.mode === 'rest' &&
        Math.abs(s.targetYaw - s.yaw) < 1e-4 &&
        Math.abs(s.targetPitch - s.pitch) < 1e-4
      ) {
        s.yaw = s.targetYaw;
        s.pitch = s.targetPitch;
        s.mode = null;
        return false;
      }
      return true;
    },
  };
  return api;
}

/**
 * Click-vs-drag discrimination for one pointer. `down(x,y)`, then `move(x,y)` returns true once
 * the pointer has travelled CLICK_SLOP_PX (latched: it stays a drag if it comes back), and
 * `up()` returns 'click' | 'drag'.
 */
export function createClickTracker(slopPx = CLICK_SLOP_PX) {
  let x0 = 0;
  let y0 = 0;
  let down = false;
  let dragging = false;
  return {
    get active() {
      return down;
    },
    get dragging() {
      return dragging;
    },
    down(x, y) {
      x0 = x;
      y0 = y;
      down = true;
      dragging = false;
    },
    move(x, y) {
      if (!down) return false;
      if (!dragging && Math.hypot(x - x0, y - y0) >= slopPx) dragging = true;
      return dragging;
    },
    up() {
      const was = down ? (dragging ? 'drag' : 'click') : null;
      down = false;
      dragging = false;
      return was;
    },
    origin() {
      return { x: x0, y: y0 };
    },
  };
}

// ════════════════════════════════════════════════════════════════════════════════════════════
// Camera model — the gallery's Spatial View CAMERA RIG (camera.ts `rigFromAsset` / `frustumFor`
// / `clampEye` + the wall's `?rig=camera` branch in SpatialView.tsx), pure and three-free.
//
// The invariant it preserves: the neutral view IS the photo. The lift's origin is the capture
// camera, so an eye at the origin looking down the view axis through the photo's own frustum
// reproduces the picture exactly; only MOTION reveals depth. That needs an OFF-AXIS frustum —
// a fixed window in space (the photo's frustum cut at the pivot depth), seen from a moving,
// unrotated eye. Rotating the camera toward the subject ("look at") shears the whole image and
// the rest pose stops being the photo.
//
// Zero parallax sits on the pivot plane (the window): on the woven display that plane lands on
// the glass, so the subject is at the screen and the background recedes behind it.
// ════════════════════════════════════════════════════════════════════════════════════════════

/** Near/far, metres. FAR is huge on purpose: a lifted sky sits at the depth cap and some
 *  gaussians scatter beyond it; at FAR = 200 they dropped out as black holes on orbit (gallery
 *  f2df268). Spark sorts rather than depth-tests, so the near:far ratio costs nothing. */
export const NEAR = 0.02;
export const FAR = 5000;

/** Sanity clamp on the pivot depth, metres (gallery PIVOT_MIN_M / PIVOT_MAX_M). Only bites on a
 *  degenerate meta; real lifts land in 0.5–5 m. */
export const PIVOT_MIN_M = 0.1;
export const PIVOT_MAX_M = 20;

/** Interocular used to turn the runtime's world-unit eye poses into scene metres. */
export const IPD_M = 0.063;

/**
 * THE CONVENTION ADAPTER. How the lift's PLY axes map onto the scene (three.js / OpenGL: x right,
 * y up, the camera looking down −z).
 *
 *   `fwd`   sign of the view axis in PLY coordinates: depth along the axis = fwd · z.
 *   `flip`  true = the PLY is y-down/z-forward (OpenCV, what SHARP writes), so the mesh gets the
 *           180° turn about X that `addSplat`'s `flipY` applies.
 *
 * A4's documented convention (docs/lift-gen.md) decides the default. If it disagrees with the
 * assumption below, THIS LINE is the fix (or pass `meta.axes` / `createExplore({axes})`):
 */
export const LIFT_AXES_DEFAULT = 'opengl';
export const LIFT_AXES = Object.freeze({
  opengl: Object.freeze({ fwd: -1, flip: false }), // camera at origin looking −z, y up (assumed)
  opencv: Object.freeze({ fwd: +1, flip: true }), // camera at origin looking +z, y down (SHARP)
});

export function resolveAxes(name) {
  const key = name || LIFT_AXES_DEFAULT;
  const a = LIFT_AXES[key];
  if (!a) throw new Error(`lift/explore: unknown axes "${key}" — expected ${Object.keys(LIFT_AXES).join(' | ')}`);
  return { name: key, ...a };
}

/**
 * Everything the renderer needs, from the lift's meta. `{focalPx, pivotZ, w, h}`: the focal the
 * gaussians were unprojected through (FOCAL AGREEMENT: rendering at any other focal scales the
 * picture about its centre — a pure zoom error), the convergence depth along the PLY's z, and the
 * image size in px (principal point at the centre).
 */
export function rigFromMeta(meta, axesName) {
  const axes = resolveAxes(axesName ?? meta?.axes);
  const w = Math.max(+meta?.w || 0, 1);
  const h = Math.max(+meta?.h || 0, 1);
  const fPx = +meta?.focalPx;
  if (!(fPx > 0)) throw new Error('lift/explore: meta.focalPx must be a positive number of pixels');
  const rawD = axes.fwd * +meta?.pivotZ;
  const dPivot = clamp(Number.isFinite(rawD) && rawD > 0 ? rawD : 2, PIVOT_MIN_M, PIVOT_MAX_M);
  const halfW = (dPivot * (w / 2)) / fPx;
  const halfH = (dPivot * (h / 2)) / fPx;
  return { axes, w, h, fPx, dPivot, halfW, halfH };
}

/** The motion-cone radius at the pivot, metres (the gallery's `rig.limit`). */
export function coneLimit(rig, maxDeg = ORBIT_MAX_DEG) {
  return Math.tan((maxDeg * Math.PI) / 180) * rig.dPivot;
}

/**
 * The window's half-extents for a viewport of aspect `vpAspect` (width/height).
 *   'cover'   (default) crop the photo to fill the viewport — the rest pose is a centred crop.
 *   'contain' letterbox: the whole photo is visible, the window grows on one axis.
 *   'stretch' the photo's own window whatever the viewport (distorts on a mismatch).
 */
export function fitWindow(rig, vpAspect, fit = 'cover') {
  let { halfW, halfH } = rig;
  if (fit === 'stretch' || !(vpAspect > 0)) return { halfW, halfH };
  const imgAspect = halfW / halfH;
  const wider = vpAspect > imgAspect;
  if (fit === 'contain' ? !wider : wider) halfH = halfW / vpAspect;
  else halfW = halfH * vpAspect;
  return { halfW, halfH };
}

/**
 * Off-axis frustum edges at the near plane for an eye at `eye` (scene metres, the capture camera
 * at the origin, +z toward the viewer). The window is FIXED at depth dPivot; `d` is the eye's own
 * distance to it, which is why leaning in (e.z < 0) widens the view instead of scaling the image.
 * Exactly the gallery's `frustumFor`.
 */
export function frustumFor(rig, eye, win = rig, near = NEAR) {
  const d = Math.max(rig.dPivot + eye.z, near);
  const k = near / d;
  return {
    l: (-win.halfW - eye.x) * k,
    r: (win.halfW - eye.x) * k,
    t: (win.halfH - eye.y) * k,
    b: (-win.halfH - eye.y) * k,
  };
}

/**
 * Clamp a head position into the comfort cone (radius `limit` in x/y). The gallery's `clampEye`,
 * centred on the capture camera (the origin) — for a single-image lift the capture camera IS the
 * head centre (the gallery's B/2 offset was the two-camera case). z is left alone.
 */
export function clampHead(limit, e) {
  const r = Math.hypot(e.x, e.y);
  if (r <= limit || r === 0) return e;
  const k = limit / r;
  return { x: e.x * k, y: e.y * k, z: e.z };
}

/**
 * Runtime eye poses → scene-metre eye positions. The gallery wall's camera rig:
 *
 *   · the runtime reports eye positions in WORLD UNITS where the tile spans
 *     virtualDisplayHeight — the measured interocular converts them to metres (IPD / |E_R − E_L|),
 *     the only display fact needed (the web SDK exposes no panel size or nominal distance);
 *   · positions are taken relative to a frozen REST head: the median of the first
 *     `restSamples` eye midpoints (rest:'median', the hardware-verified gallery behaviour), or the
 *     display centre at the median z (rest:'display': a head off to the side of the glass then
 *     sees the side of the scene from the first frame);
 *   · the head midpoint is clamped into the cone and both eyes move with it (their separation is
 *     never squeezed — that would flatten the stereo, not limit the motion).
 *
 * The result is "ipd factor 1": virtual eyes a real IPD apart in a metric scene; leaning 10 cm
 * moves the virtual eye 10 cm.
 */
export function createHeadTracker(o = {}) {
  const ipd = o.ipd > 0 ? o.ipd : IPD_M;
  const restSamples = Math.max(1, o.restSamples ?? 12);
  const restMode = o.rest === 'display' ? 'display' : 'median';
  const mids = [];
  let ref = null;
  let metres = 0;

  const med = (k) => [...mids].map((m) => m[k]).sort((p, q) => p - q)[mids.length >> 1];

  return {
    get ref() {
      return ref;
    },
    get metresPerUnit() {
      return metres;
    },
    reset() {
      mids.length = 0;
      ref = null;
      metres = 0;
    },
    /**
     * @param {{x,y,z}[]} positions  per-view eye positions in world units.
     * @param {number} limit  cone radius, metres (Infinity = unclamped).
     * @returns {{eyes:{x,y,z}[], mid:{x,y,z}}} scene-metre eyes (rest head = origin).
     */
    update(positions, limit = Infinity) {
      const n = positions.length;
      if (n === 0) return { eyes: [], mid: { x: 0, y: 0, z: 0 } };
      let mx = 0;
      let my = 0;
      let mz = 0;
      for (const p of positions) {
        mx += p.x;
        my += p.y;
        mz += p.z;
      }
      const m = { x: mx / n, y: my / n, z: mz / n };
      if (!ref) {
        if (n >= 2) {
          const a = positions[0];
          const b = positions[n - 1];
          const sep = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) / (n - 1);
          if (sep > 1e-6) metres = ipd / sep;
        }
        if (!(metres > 0)) metres = 1;
        mids.push(m);
        if (mids.length >= restSamples) {
          ref = restMode === 'display' ? { x: 0, y: 0, z: med('z') } : { x: med('x'), y: med('y'), z: med('z') };
        }
      }
      const r0 = ref ?? (mids.length ? { x: med('x'), y: med('y'), z: med('z') } : m);
      const mid = { x: (m.x - r0.x) * metres, y: (m.y - r0.y) * metres, z: (m.z - r0.z) * metres };
      const c = clampHead(limit, mid);
      const sx = c.x - mid.x;
      const sy = c.y - mid.y;
      const eyes = positions.map((p) => ({
        x: (p.x - r0.x) * metres + sx,
        y: (p.y - r0.y) * metres + sy,
        z: (p.z - r0.z) * metres,
      }));
      return { eyes, mid: c };
    },
  };
}

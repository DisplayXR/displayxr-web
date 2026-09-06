// inline3d-mode-switch.js — the eased 2D<->3D rendering-mode transition, as a state machine.
//
// A dependency-free port of `dxr::ModeSwitch` (displayxr-common `common/mode_switch.h/.cpp`), the
// sequencer the native DisplayXR apps already use. It owns nothing but a scalar ramp and one
// decision, and that decision is the whole point — the SEQUENCING ASYMMETRY that hand-rolled
// versions get wrong:
//
//   3D -> 2D : ramp the disparity to 0 FIRST, and only then issue the mode request, so the panel
//              flips on already-flat content.
//   2D -> 3D : issue the mode request FIRST (the first 3D frame is flat), then ease the disparity
//              up to the app's steady value.
//
// It is aesthetic policy, never correctness: the runtime keeps the eye set coherent whatever the
// page does, and a browser or a page that skips this sees exactly the old snap.
//
// Driven by WALL-CLOCK dt, not frame counts, so the ramp takes the same time at 30 fps and 144 fps.
// Interruptible: calling request() mid-flight retargets seamlessly from the value in force right
// now, and a not-yet-fired ->2D that gets reversed simply ramps back up and NEVER fires.
//
// This module knows nothing about WebXR, the SDK, or the DOM — it is a pure state machine so it
// can be unit-tested on its own (`test/mode-switch.test.mjs`, mirroring the C++ smoke test).

/** The C++ default ramp duration (`XrSessionUpdateModeSwitch` configures 0.18 s). */
export const MODE_SWITCH_DEFAULT_DURATION_MS = 180;

/** The C++ default curve (`ModeSwitchEasing::SmoothStep`). */
export const MODE_SWITCH_DEFAULT_EASING = 'smoothstep';

/** Every easing this understands — the three of `dxr::ModeSwitchEasing`. */
export const MODE_SWITCH_EASINGS = ['linear', 'smoothstep', 'easeoutcubic'];

/**
 * Normalise an easing name to one of {@link MODE_SWITCH_EASINGS}, or `null` when it is not one of
 * them. Case- and separator-insensitive (`'ease-out-cubic'`, `'easeOutCubic'`), so a caller may
 * spell it the way its own config does. Returning null rather than a default is what lets the
 * caller decide whether an unknown name is worth a warning.
 *
 * @param {string} [easing]
 * @returns {string|null}
 */
export function normaliseModeSwitchEasing(easing) {
  if (typeof easing !== 'string') return null;
  const key = easing.toLowerCase().replace(/[-_\s]/g, '');
  return MODE_SWITCH_EASINGS.includes(key) ? key : null;
}

/** The curves themselves. `t` is already clamped to [0,1] by the caller. */
function ease(easing, t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  if (easing === 'linear') return t;
  if (easing === 'easeoutcubic') {
    const u = 1 - t;
    return 1 - u * u * u;
  }
  return t * t * (3 - 2 * t); // smoothstep — Hermite 3t^2 - 2t^3
}

const IDLE = 'idle';
const RAMP_DOWN_THEN_FIRE = 'rampDownThenFire';
const FIRE_THEN_RAMP_UP = 'fireThenRampUp';

/**
 * The 2D<->3D mode-switch sequencer. One instance per session.
 *
 * The values it ramps are DIMENSIONLESS here: the SDK drives it with `steady: 1`, so `factor` is
 * the fraction of each window's OWN configured `ipdFactor`/`parallaxFactor` to send this frame
 * (0 = flat, 1 = exactly what the page asked for). The C++ original ramps an absolute ipdFactor
 * instead; the state machine is identical either way, which is why `steady` is a parameter rather
 * than a constant.
 */
export class ModeSwitch {
  constructor(durationS, easing) {
    this._phase = IDLE;
    this._targetMode = null;
    this._firePending = false; // fireThenRampUp: emit `fire` on the next update()
    this._fireAtEnd = false; // rampDownThenFire: emit `fire` when the ramp lands
    this._from = 0;
    this._to = 0;
    this._cur = 0; // last evaluated factor
    this._t = 1; // normalised progress; 1 = landed/idle
    this._dur = MODE_SWITCH_DEFAULT_DURATION_MS / 1000;
    this._easing = MODE_SWITCH_DEFAULT_EASING;
    if (durationS !== undefined || easing !== undefined) this.configure(durationS, easing);
  }

  /**
   * Ramp duration in SECONDS and easing curve. `durationS <= 0` means instant — the switch fires
   * and the value reaches its endpoint on the first `update()`, which is the honest way to say
   * "no transition" without a second code path. An unknown easing name falls back to the default
   * silently (the caller is the right place to warn about its own option).
   *
   * @param {number} [durationS] default 0.18
   * @param {string} [easing] `'smoothstep'` (default) | `'linear'` | `'easeoutcubic'`
   */
  configure(durationS, easing) {
    if (durationS !== undefined) {
      const d = Number(durationS);
      this._dur = Number.isFinite(d) && d > 0 ? d : 0;
    }
    if (easing !== undefined) {
      this._easing = normaliseModeSwitchEasing(easing) || MODE_SWITCH_DEFAULT_EASING;
    }
    return this;
  }

  /** The ramp duration in seconds (0 = instant). */
  get durationS() {
    return this._dur;
  }

  /** The easing name in force. */
  get easing() {
    return this._easing;
  }

  /**
   * Begin — or, mid-flight, seamlessly REDIRECT — a transition to `targetMode`.
   *
   * Safe to call on every toggle: a mid-ramp call fully resets the phase from the value in force
   * right now, so a pending (un-fired) ->2D that the user reverses is simply dropped.
   *
   * @param {object} req
   * @param {number|null} [req.targetMode] the rendering-mode index wanted (reported back by `update`)
   * @param {number} req.targetViewCount that mode's view count (1 = 2D/mono, >1 = 3D)
   * @param {number|null} [req.currentMode] the mode index active right now
   * @param {number} req.currentViewCount its view count
   * @param {number} [req.current] the value in force RIGHT NOW — the last `update()` factor while a
   *        ramp runs, and the STEADY value when idle. Passing an internal 0 while idle is the
   *        classic first-press snap: there is nothing to ramp down from.
   * @param {number} [req.steady] the value to restore to (the page's own configured factors; the
   *        SDK passes 1 because it scales each window's own numbers by the result)
   */
  request({
    targetMode = null,
    targetViewCount,
    currentMode = null,
    currentViewCount,
    current,
    steady = 1,
  } = {}) {
    const toMono = !(targetViewCount > 1);
    const fromMono = !(currentViewCount > 1);
    const steadyValue = Number.isFinite(steady) ? steady : 1;
    const currentValue = Number.isFinite(current) ? current : steadyValue;

    this._targetMode = targetMode;
    this._from = currentValue;

    if (toMono && !fromMono) {
      // 3D -> 2D: flatten first, switch on landing, so 2D engages on already-mono content. The
      // mode request is HELD until the ramp completes.
      this._phase = RAMP_DOWN_THEN_FIRE;
      this._to = 0;
      this._fireAtEnd = true;
      this._firePending = false;
    } else if (!toMono && fromMono) {
      // 2D -> 3D: switch now so the first 3D frame is flat (`from` is forced to 0 regardless of
      // any stale value), then ease up to steady.
      this._phase = FIRE_THEN_RAMP_UP;
      this._from = 0;
      this._to = steadyValue;
      this._firePending = true;
      this._fireAtEnd = false;
    } else {
      // Same dimensionality: 2D->2D, 3D->3D, or the REVERSAL of a not-yet-fired ->2D (nothing
      // fired, so the display is still 3D and `currentViewCount` is still > 1). No flatten: switch
      // now — skipping the fire when the target is already the current mode, which is exactly what
      // makes a reversal never issue a stale request — and restore steady disparity for a 3D
      // target. For a 2D target the value is irrelevant (mono), so leave it where it is.
      this._phase = FIRE_THEN_RAMP_UP;
      this._to = toMono ? currentValue : steadyValue;
      this._firePending = !(targetMode !== null && targetMode === currentMode);
      this._fireAtEnd = false;
    }

    this._t = this._dur > 0 ? 0 : 1;
    this._cur = this._from;
    return this;
  }

  /**
   * Advance the ramp by `dtS` seconds and report this frame's outputs.
   *
   * @param {number} dtS wall-clock seconds since the last call
   * @returns {{factor:number, fire:boolean, mode:(number|null)}} `factor` is the value to submit
   *   this frame; `fire` is true on EXACTLY ONE update — the frame on which the caller should
   *   issue the real mode request for `mode`.
   */
  update(dtS) {
    let fire = false;

    if (this._phase !== IDLE) {
      const dt = Number.isFinite(dtS) && dtS > 0 ? dtS : 0;
      if (this._t < 1 && this._dur > 0) {
        this._t += dt / this._dur;
        if (this._t > 1) this._t = 1;
      } else {
        this._t = 1;
      }
      this._cur = this._from + (this._to - this._from) * ease(this._easing, this._t);

      if (this._phase === FIRE_THEN_RAMP_UP) {
        if (this._firePending) {
          this._firePending = false;
          fire = true;
        }
        if (this._t >= 1) this._phase = IDLE;
      } else {
        if (this._t >= 1) {
          if (this._fireAtEnd) {
            this._fireAtEnd = false;
            fire = true;
          }
          this._phase = IDLE;
        }
      }
    }

    return { factor: this._cur, fire, mode: this._targetMode };
  }

  /** True while a ramp is in flight or a held mode request has not fired yet. */
  active() {
    return this._phase !== IDLE;
  }

  /** The current factor, without advancing the clock. */
  value() {
    return this._cur;
  }

  /** True while a mode request is being HELD until the ramp lands (a ->2D that has not fired). */
  firePending() {
    return this._phase === RAMP_DOWN_THEN_FIRE ? this._fireAtEnd : this._firePending;
  }

  /** Drop everything in flight. The factor is left where it is — the caller owns what to do next. */
  cancel() {
    this._phase = IDLE;
    this._firePending = false;
    this._fireAtEnd = false;
    this._t = 1;
    return this;
  }
}

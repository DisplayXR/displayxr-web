// inline3d-viewer-ease.js — ease the eye views across a tracking acquisition or loss.
//
// THE SNAP THIS REMOVES. While nobody is tracked the session's views come from the runtime's
// NOMINAL viewer (two eyes straight in front of the window at the nominal distance). The frame a
// viewer is acquired, the views jump to the tracked eyes — tens to hundreds of millimetres in one
// frame — and so does everything drawn from them: the per-eye cameras, head parallax, display-rig
// layers. The reverse happens on a loss wherever the vendor does not animate it. The browser
// passes the views through and the core SDK deliberately does too (inline3d.js `_frame`), so the
// ease lives in the SDK's RENDERERS (SceneViewer, the PlayCanvas splat and model viewers), on the
// matrices they already copy out of every view, and every page that renders through them gets it.
//
// WHAT IT DOES. On a trigger, the difference between what was DRAWN last frame and what the
// session reports now is frozen as an offset, and the offset decays to zero over `durationMs`
// (smoothstep by default) while the live views keep moving underneath — so the eyes leave from
// where they were and arrive on the tracked viewer without lagging behind it once the window ends.
//
//   pose_out = pose_now + w · A_now · d_local      d_local = A_then⁻¹ · (eye_drawn − eye_now)
//   proj_out = proj_now + w · (proj_drawn − proj_now)        w = 1 − ease(t / duration)
//
// The position offset is held in the VIEW's own frame (A = the pose's 3×3), so a rig the page
// moves during the ease (orbit, zoom) carries the offset with it. The projection is offset
// element-wise, and that is exact, not an approximation: every DisplayXR frustum (the display
// rig's window-relative Kooima and the camera rig's portal, displayxr-common dxr_view_math.c) has
// its off-axis terms and its focal terms AFFINE in the eye position, with fixed near/far — so the
// eased (pose, proj) pair is the view the runtime itself would report for the eased eye. A view's
// frustum still crosses its rig's window exactly, which is what ./inline3d-splat-rig-map.js
// reads the located rig off.
//
// TRIGGERS, in order of trust:
//   1. `trackingState` edge ('searching' <-> 'tracking', DisplayXR Browser patch 0195+). For
//      `armMs` after it (the edge frame included) any frame whose eyes move more than `armedJump`
//      (in eye separations) starts — or restarts — the ease from what was drawn, because the edge
//      and the jump need not land on the same frame. An edge without a jump changes nothing.
//   2. Where the browser reports no state ('unknown'), a jump of more than `jump` eye separations
//      in one frame. A seated viewer's head moves well under that per frame; a nominal ↔ tracked
//      switch is a multiple of it.
// Eye positions for the jump test are read off the PROJECTIONS (focal and off-axis terms), in
// eye-separation units, so the test is blind to rig changes, scene scale and canvas size.
//
// WHAT IT LEAVES ALONE. A view-count change (a 2D <-> 3D rendering-mode switch: the eased mode
// switch, ./inline3d-mode-switch.js, owns that) and a buffer reallocation reset it. One view
// (mono) is passed through. Replayed (last-good) frames are not re-eased. The panel's own optical
// switch (lens/backlight state on acquisition) is hardware and is not touched by anything here.
//
// Pure arithmetic on Float32Array(16) pairs; no WebXR, no DOM. test/viewer-ease.test.mjs.

/** Default ease window (ms). Long enough to read as a glide, short enough not to feel laggy. */
export const VIEWER_EASE_DEFAULT_MS = 300;
/** Default curve: smoothstep (the mode switch's own default; zero velocity at both ends). */
export const VIEWER_EASE_DEFAULT_EASING = 'smoothstep';
/** Untracked-state jump detector: eye movement in one frame, in eye separations. */
export const VIEWER_EASE_JUMP = 0.5;
/** After a tracking edge: the (lower) per-frame movement that restarts the ease, in separations. */
export const VIEWER_EASE_ARMED_JUMP = 0.15;
/** How long after a tracking edge the lower threshold applies (ms). */
export const VIEWER_EASE_ARM_MS = 600;

const EASINGS = {
  linear: (t) => t,
  smoothstep: (t) => t * t * (3 - 2 * t),
  easeoutcubic: (t) => 1 - (1 - t) ** 3,
};

const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

/**
 * Resolve a page's `viewerEase` option. `false` / `{ enabled:false }` / `{ durationMs:0 }`
 * disables; `true` / undefined is the default; an object overrides fields.
 *
 * @param {boolean|{enabled?:boolean,durationMs?:number,easing?:string}} [opt]
 * @returns {{enabled:boolean,durationMs:number,easing:string}}
 */
export function resolveViewerEaseOption(opt) {
  const out = { enabled: true, durationMs: VIEWER_EASE_DEFAULT_MS, easing: VIEWER_EASE_DEFAULT_EASING };
  if (opt === false) out.enabled = false;
  else if (opt && typeof opt === 'object') {
    if (opt.enabled === false) out.enabled = false;
    if (Number.isFinite(opt.durationMs) && opt.durationMs >= 0) out.durationMs = opt.durationMs;
    if (typeof opt.easing === 'string') {
      const k = opt.easing.toLowerCase().replace(/[-_\s]/g, '');
      if (EASINGS[k]) out.easing = k;
    }
  }
  if (!(out.durationMs > 0)) out.enabled = false;
  return out;
}

/** Eye position in window-width units, read off a projection's focal and off-axis terms. */
function eyeFromProj(P, out) {
  const p0 = P[0];
  const p5 = P[5];
  const aspect = p5 !== 0 ? p0 / p5 : 1; // = H / W for a window-relative frustum
  out[0] = -P[8] / 2;
  out[1] = (-P[9] / 2) * aspect;
  out[2] = p0 / 2;
  return out;
}

const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Inverse of the upper-left 3×3 of a column-major 4×4, into a 9-array (column-major). False if singular. */
function inv3(M, out) {
  const a = M[0], b = M[4], c = M[8];
  const d = M[1], e = M[5], f = M[9];
  const g = M[2], h = M[6], i = M[10];
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!(Math.abs(det) > 1e-12)) return false;
  const k = 1 / det;
  // row-major inverse entries
  const r00 = A * k, r01 = -(b * i - c * h) * k, r02 = (b * f - c * e) * k;
  const r10 = B * k, r11 = (a * i - c * g) * k, r12 = -(a * f - c * d) * k;
  const r20 = C * k, r21 = -(a * h - b * g) * k, r22 = (a * e - b * d) * k;
  out[0] = r00; out[3] = r01; out[6] = r02;
  out[1] = r10; out[4] = r11; out[7] = r12;
  out[2] = r20; out[5] = r21; out[8] = r22;
  return true;
}

/**
 * One renderer's ease state. Feed it the matrices it is about to draw, once per LIVE frame,
 * in place; it rewrites them while an ease is running and leaves them untouched otherwise.
 */
export class ViewerEase {
  /**
   * @param {object} [o]  resolveViewerEaseOption() fields, plus test knobs (`clock`, `jump`,
   *        `armedJump`, `armMs`).
   */
  constructor(o = {}) {
    const r = resolveViewerEaseOption(o);
    this.enabled = r.enabled;
    this.durationMs = r.durationMs;
    this.easing = r.easing;
    this.jump = Number.isFinite(o.jump) ? o.jump : VIEWER_EASE_JUMP;
    this.armedJump = Number.isFinite(o.armedJump) ? o.armedJump : VIEWER_EASE_ARMED_JUMP;
    this.armMs = Number.isFinite(o.armMs) ? o.armMs : VIEWER_EASE_ARM_MS;
    this.clock = typeof o.clock === 'function' ? o.clock : now;
    this.reset();
    /** What the last apply() did, for diagnostics: { weight, reason: null|'armed-jump'|'jump'|'easing', jump }. */
    this.last = { weight: 0, reason: null, jump: 0 };
  }

  /** Change the tuning at run time (the same shapes the option takes). */
  configure(opt) {
    const r = resolveViewerEaseOption(opt);
    this.enabled = r.enabled;
    this.durationMs = r.durationMs;
    this.easing = r.easing;
    if (!this.enabled) this._active = false;
  }

  /** Forget everything (a view-count change, a buffer reallocation, a mono stretch). */
  reset() {
    this._n = 0;
    this._drawn = []; // per view: { proj, pose } as DRAWN last frame
    this._seen = []; // per view: eye (window units) as REPORTED last frame
    this._off = []; // per view: { d: [3] local, dp: Float64Array(16) }
    this._active = false;
    this._t0 = 0;
    this._state = null; // last tracking state seen
    this._armedUntil = -Infinity;
    this._eye = [0, 0, 0];
    this._inv = new Float64Array(9);
  }

  /** Is an ease running right now? */
  get active() {
    return this._active;
  }

  /**
   * Ease these entries in place. `entries[i].proj` / `.pose` are column-major Float32Array(16)
   * (or any 16-array), already holding THIS frame's reported matrices.
   *
   * @param {Array<{proj:ArrayLike<number>,pose:ArrayLike<number>}>} entries
   * @param {'tracking'|'searching'|'unknown'|string|null} [trackingState]
   * @param {number} [t]  ms; defaults to the clock.
   * @returns {number} the weight applied this frame (0 = passed through, 1 = fully the old views).
   */
  apply(entries, trackingState, t = this.clock()) {
    const L = this.last;
    L.weight = 0;
    L.reason = null;
    L.jump = 0;
    const n = entries ? entries.length : 0;
    if (!this.enabled || n < 2) {
      if (n !== this._n) this.reset();
      this._remember(entries, n);
      return 0;
    }
    if (n !== this._n) {
      // A view-count change is a rendering-mode switch: the mode switch's ramp owns it.
      this.reset();
      this._remember(entries, n);
      this._state = trackingState || null;
      return 0;
    }

    // ── triggers ──
    const state = trackingState === 'tracking' || trackingState === 'searching' ? trackingState : null;
    const edge = state !== null && this._state !== null && state !== this._state;
    if (state !== null) this._state = state;
    if (edge) this._armedUntil = t + this.armMs;

    const jump = this._jump(entries, n);
    L.jump = jump;
    // An edge only ARMS: it is the jump that is eased, on whichever frame it lands (the state can
    // lead the views by a frame). An edge with no jump — a vendor that already animates the eyes —
    // changes nothing.
    let trigger = null;
    if (t <= this._armedUntil && jump > this.armedJump) trigger = 'armed-jump';
    else if (state === null && jump > this.jump) trigger = 'jump';

    if (trigger) {
      this._start(entries, n, t);
      L.reason = trigger;
    }

    // ── apply ──
    let w = 0;
    if (this._active) {
      const u = this.durationMs > 0 ? (t - this._t0) / this.durationMs : 1;
      if (u >= 1) this._active = false;
      else {
        w = 1 - EASINGS[this.easing](Math.max(0, u));
        for (let i = 0; i < n; i++) {
          const e = entries[i];
          const o = this._off[i];
          const P = e.pose;
          const d = o.d;
          // A_now · d_local, added to the live position.
          P[12] += w * (P[0] * d[0] + P[4] * d[1] + P[8] * d[2]);
          P[13] += w * (P[1] * d[0] + P[5] * d[1] + P[9] * d[2]);
          P[14] += w * (P[2] * d[0] + P[6] * d[1] + P[10] * d[2]);
          const Q = e.proj;
          for (let k = 0; k < 16; k++) Q[k] += w * o.dp[k];
        }
        if (!L.reason) L.reason = 'easing';
      }
    }
    L.weight = w;
    this._remember(entries, n);
    return w;
  }

  /** Largest per-view eye move since the last frame, in eye separations (0 when unknown). */
  _jump(entries, n) {
    if (this._seen.length !== n) return 0;
    const eye = this._eye;
    let sep = 0;
    const a = eyeFromProj(entries[0].proj, [0, 0, 0]);
    const b = eyeFromProj(entries[n - 1].proj, [0, 0, 0]);
    sep = dist3(a, b);
    const prevSep = dist3(this._seen[0], this._seen[n - 1]);
    // Floor: a typical IPD at this distance (~0.1 of the eye depth), so a vendor pair collapsed
    // onto one point (separation ~0) does not turn every millimetre into a "jump".
    const s = Math.max(sep, prevSep, 0.1 * Math.abs((a[2] + b[2]) / 2));
    if (!(s > 1e-6)) return 0;
    let m = 0;
    for (let i = 0; i < n; i++) {
      eyeFromProj(entries[i].proj, eye);
      m = Math.max(m, dist3(eye, this._seen[i]));
    }
    return m / s;
  }

  /** Freeze the offset between what was drawn last frame and what is reported now. */
  _start(entries, n, t) {
    if (this._drawn.length !== n) return;
    for (let i = 0; i < n; i++) {
      const e = entries[i];
      const D = this._drawn[i];
      const o = (this._off[i] ||= { d: [0, 0, 0], dp: new Float64Array(16) });
      const dx = D.pose[12] - e.pose[12];
      const dy = D.pose[13] - e.pose[13];
      const dz = D.pose[14] - e.pose[14];
      if (inv3(e.pose, this._inv)) {
        const I = this._inv;
        o.d[0] = I[0] * dx + I[3] * dy + I[6] * dz;
        o.d[1] = I[1] * dx + I[4] * dy + I[7] * dz;
        o.d[2] = I[2] * dx + I[5] * dy + I[8] * dz;
      } else {
        o.d[0] = dx;
        o.d[1] = dy;
        o.d[2] = dz;
      }
      for (let k = 0; k < 16; k++) o.dp[k] = D.proj[k] - e.proj[k];
    }
    this._active = true;
    this._t0 = t;
  }

  /** Keep this frame's drawn matrices and reported eyes for the next one. */
  _remember(entries, n) {
    this._n = n;
    if (!this.enabled || n < 2) {
      this._drawn.length = 0;
      this._seen.length = 0;
      return;
    }
    for (let i = 0; i < n; i++) {
      const e = entries[i];
      const D = (this._drawn[i] ||= { proj: new Float64Array(16), pose: new Float64Array(16) });
      for (let k = 0; k < 16; k++) {
        D.proj[k] = e.proj[k];
        D.pose[k] = e.pose[k];
      }
    }
    this._drawn.length = n;
    this._seen.length = n;
    // The REPORTED eyes: undo this frame's offset from the projection before keeping it.
    const w = this.last.weight;
    const raw = (this._raw ||= new Float64Array(16));
    for (let i = 0; i < n; i++) {
      const Q = entries[i].proj;
      const o = this._off[i];
      if (w > 0 && o) for (let k = 0; k < 16; k++) raw[k] = Q[k] - w * o.dp[k];
      this._seen[i] = eyeFromProj(w > 0 && o ? raw : Q, this._seen[i] || [0, 0, 0]);
    }
  }
}

/** The session's tracking state as the frame sees it, or null (no frame / old browser). */
export function frameTrackingState(frame) {
  try {
    const s = frame && frame.session ? frame.session.trackingState : undefined;
    return s === 'tracking' || s === 'searching' || s === 'unknown' ? s : null;
  } catch {
    return null;
  }
}

// ── session-wide default ──
// `createInline3D({ viewerEase })` sets the default for every renderer drawing through that
// session; a renderer's own `viewerEase` option overrides it. Keyed by the XRSession object, so
// renderers find it from the XRFrame they are handed and need no reference to the manager.
const SESSION_OPTS = new WeakMap();

/** Record a session's `viewerEase` option (createInline3D does this). */
export function setSessionViewerEase(session, opt) {
  if (session && (typeof session === 'object' || typeof session === 'function')) SESSION_OPTS.set(session, opt);
}

/**
 * The ViewerEase a renderer should use for frames of this session: its own option when it has
 * one (anything but undefined), else the session's, else the default (on).
 */
export function viewerEaseFor(frame, windowOpt) {
  let opt = windowOpt;
  if (opt === undefined) {
    try {
      opt = frame && frame.session ? SESSION_OPTS.get(frame.session) : undefined;
    } catch {
      opt = undefined;
    }
  }
  return new ViewerEase(opt === true ? undefined : opt);
}

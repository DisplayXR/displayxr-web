// inline3d-cursor-depth.js — the depth-aware cursor's placement maths, dependency-free.
//
// The OS cursor is flat: it is drawn at zero disparity, on the glass. Hover it over content that
// pops OUT of the glass and it is drawn on top of pixels whose disparity says they are in front
// of it — a depth violation, and it reads as a broken image. The fix is a cursor SPRITE drawn at
// the depth of the nearest content under it.
//
// This is a line-for-line port of the runtime's `u_cursor_depth` (displayxr-runtime ADR-046,
// extension XR_DXR_cursor_depth), so a web page and a native app place their cursors
// identically. The test file pins the same numbers as the runtime's C tests.
//
// Division of labour, as in the runtime: the PAGE knows its content, so it supplies the nearest
// content point under the cursor (a raycast, a depth readback, a depth map); this module decides
// where the sprite goes, how big it is, and how it moves over time. ./three's `DepthCursor` wires
// both for a three.js scene. Nothing here runs unless a page calls it — opt-in, zero cost
// otherwise.
//
// The geometry is solved from the VIEWS the page is about to render (projection + transform
// matrices, column-major, as an XRView carries them), never from rig internals, so it is
// correct for display rigs, camera rigs, any scale, and any view count >= 2:
//
//  - S, the canvas point under the cursor, is where the two outermost view rays through (u, v)
//    meet (every off-axis frustum frames the same canvas);
//  - E, the cyclopean eye, is the midpoint of those two views;
//  - a point's depth is t = its distance in front of E along the display normal over S's
//    (t = 1 on the canvas, t < 1 in front of it);
//  - the policy works in DISPARITY d = 1 - 1/t, in eye-baseline units (on-screen disparity =
//    baseline × d): 0 on the canvas, < 0 in front. The eye compares disparities, so the margin,
//    the clamp and the slew rates live there;
//  - WHERE along that depth the sprite goes is the anchor mode (CURSOR_ANCHOR_MODES):
//      'screen' — C = E + t (S - E), on the cyclopean ray: exactly over the pointer from where the
//                 viewer is, but head-motion invariant — disparity WITHOUT motion parallax, which
//                 on a head-tracked display reads as "at the glass";
//      'world'  — C = S - f (1 - t) eyeToCanvas, straight in front of the pointer's canvas point:
//                 parallaxes like content, drifts ~mm off the pointer from an off-axis viewer;
//      'hybrid' (default) — 'screen' while the pointer moves (exact aim), and world-FIXED while it
//                 is still (correct parallax): the line of sight at the last pointer move (E0 → S0)
//                 is kept, and the sprite sits on it at the current depth — the point whose
//                 distance in front of the glass is (1 - t) eyeToCanvas. A head move leaves it
//                 put; a depth change slides it along that line, so it stays on the click point
//                 for the viewer who placed it. Continuous at the stop frame.
//    The height is scaled by t either way, so the apparent size is constant.
//
// THE POLICY (ADR-046 Amendment 2, the same for every DisplayXR depth cursor — this module, ./three's
// DepthCursor, `cursor: 'depth'` on ./model and ./splat, and the stereo-tile cursor on ./call and
// ./camera, which calls the pieces exported here):
//  - never behind the glass: target = d < 0 ? max(d - margin, dMin) : 0 — it only comes forward,
//    to stay ahead of content that comes OUT of the screen (cursorTarget);
//  - margin 0.03 eye baselines (~2 mm of crossed on-screen disparity at a 65 mm IPD);
//  - on the plane it IS the OS cursor: nothing is drawn while the filtered disparity is above
//    CURSOR_DRAW_THRESHOLD (-0.005, ~0.3 mm) or under CURSOR_DRAW_MIN_PX on the panel
//    (cursorShouldDraw), and the CSS cursor is left alone;
//  - the look: the classic arrow (CURSOR_ARROW, tip = hotspot), at the OS cursor's size
//    (CURSOR_ARROW_CSS_PX tall on the page, cursorDefaultHeight).

import { CURSOR_ANCHOR_MODES } from './inline3d-cursor-option.js';

export { CURSOR_ANCHOR_MODES, CURSOR_OPTION_KEYS, resolveCursorOption } from './inline3d-cursor-option.js';

/**
 * Fallback sprite height, as a fraction of the canvas height, when the canvas's on-page size is
 * unknown. With a known size the default is the OS cursor's size (cursorDefaultHeight).
 */
export const CURSOR_DEFAULT_HEIGHT = 0.03;

/** The OS arrow's height in CSS px: the drawn arrow's default size, so the hand-over is seamless. */
export const CURSOR_ARROW_CSS_PX = 19;

/**
 * The default sprite height for a canvas `cssHeight` CSS px tall: the OS arrow's 19 CSS px, as a
 * fraction of it (capped at half the canvas). Recompute it when the canvas resizes.
 */
export function cursorDefaultHeight(cssHeight) {
  return cssHeight > 0 && Number.isFinite(cssHeight) ? Math.min(0.5, CURSOR_ARROW_CSS_PX / cssHeight) : CURSOR_DEFAULT_HEIGHT;
}

/**
 * The draw threshold (eye-baseline units): the sprite is drawn only while the FILTERED disparity is
 * at or below this (~0.3 mm of on-screen disparity at a 65 mm IPD). Above it, the OS cursor is the
 * cursor and nothing is drawn.
 */
export const CURSOR_DRAW_THRESHOLD = -0.005;
/** …and never while the on-screen disparity is under this many panel pixels (where they are knowable). */
export const CURSOR_DRAW_MIN_PX = 0.5;

/**
 * Should the sprite be drawn at filtered `disparity`? Only while it is in front of the glass by at
 * least the draw threshold, and — when `pxPerBaseline` (panel pixels of on-screen disparity per
 * eye-baseline unit) is known — by at least CURSOR_DRAW_MIN_PX.
 */
export function cursorShouldDraw(disparity, pxPerBaseline) {
  if (!(disparity <= CURSOR_DRAW_THRESHOLD)) return false;
  return !(pxPerBaseline > 0 && Number.isFinite(pxPerBaseline)) || -disparity * pxPerBaseline >= CURSOR_DRAW_MIN_PX;
}

/**
 * The runtime's defaults (u_cursor_depth_tuning_defaults), in the same units.
 * Disparities are in eye-baseline units; times in seconds.
 */
export const CURSOR_DEFAULT_TUNING = Object.freeze({
  /**
   * How far in front of out-of-screen content the cursor floats: 0.03 eye baselines, ~2 mm of
   * crossed on-screen disparity at a 65 mm IPD (ADR-046 Amendment 2; the reference app's value).
   */
  margin: 0.03,
  /** Comfort clamp: t >= 0.625, never more than ~3/8 of the way to the eye. */
  minDisparity: -0.6,
  /** Never behind the glass: 0, and cursorTarget never goes above 0 whatever this says. */
  maxDisparity: 0,
  /** Rising toward the viewer is fast — never lag behind content that comes forward. */
  riseTau: 0.03,
  /** Sinking away is slow — no flicker as the footprint crosses an edge. */
  sinkTau: 0.25,
  /** A gap longer than this re-primes (snaps) the filter. */
  stale: 0.5,
});

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const addScaled = (a, b, s) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const finite3 = (a) => Number.isFinite(a[0]) && Number.isFinite(a[1]) && Number.isFinite(a[2]);
const rotate = (m, v) => [
  m[0] * v[0] + m[4] * v[1] + m[8] * v[2],
  m[1] * v[0] + m[5] * v[1] + m[9] * v[2],
  m[2] * v[0] + m[6] * v[1] + m[10] * v[2],
];

/**
 * The ray from a view through canvas point (u, v) — origin and (unnormalised) direction in the
 * space of the view's transform. (u, v) is canvas-normalised: [0,1]², origin top-left, v down.
 *
 * Use this for the page's own hit test, so the rays it casts are exactly the rays the placement
 * is solved from.
 *
 * @param {{projectionMatrix: ArrayLike<number>, transformMatrix: ArrayLike<number>}} view
 * @param {number} u
 * @param {number} v
 * @returns {{origin: number[], direction: number[]}}
 */
export function cursorViewRay(view, u, v) {
  const p = view.projectionMatrix;
  const m = view.transformMatrix;
  // Any perspective projection maps view-space (X, Y, Z) to NDC x = (a X + c Z) / -Z, so the
  // view-space direction through NDC (x, y) is ((x + c) / a, (y + d) / b, -1).
  const x = 2 * u - 1;
  const y = 1 - 2 * v;
  const d = [(x + p[8]) / p[0], (y + p[9]) / p[5], -1];
  return { origin: [m[12], m[13], m[14]], direction: rotate(m, d) };
}

/**
 * Solve the cursor's line of sight from two views (normally the first and the last).
 * @returns {object|null} the geometry, or null when degenerate — coincident views (2D), parallel
 *   rays, (u, v) off the canvas, non-finite input.
 */
export function solveCursorGeometry(viewA, viewB, u, v) {
  if (!(u >= 0 && u <= 1 && v >= 0 && v <= 1)) return null;
  const ra = cursorViewRay(viewA, u, v);
  const rb = cursorViewRay(viewB, u, v);
  const p1 = ra.origin, d1 = ra.direction, p2 = rb.origin, d2 = rb.direction;
  if (!finite3(p1) || !finite3(p2) || !finite3(d1) || !finite3(d2)) return null;

  // Closest points of p1 + s d1 and p2 + r d2; the midpoint absorbs float noise.
  const w0 = sub(p1, p2);
  const aa = dot(d1, d1), bb = dot(d1, d2), cc = dot(d2, d2);
  const dd = dot(d1, w0), ee = dot(d2, w0);
  const den = aa * cc - bb * bb;
  if (dot(w0, w0) <= 0 || !(den > 1e-12 * aa * cc)) return null;
  const s = (bb * ee - cc * dd) / den;
  const r = (aa * ee - bb * dd) / den;
  if (!(s > 0 && r > 0)) return null;
  const q1 = addScaled(p1, d1, s), q2 = addScaled(p2, d2, r);
  const canvasPoint = [(q1[0] + q2[0]) / 2, (q1[1] + q2[1]) / 2, (q1[2] + q2[2]) / 2];
  const eye = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2, (p1[2] + p2[2]) / 2];

  const ma = viewA.transformMatrix;
  const fwd = rotate(ma, [0, 0, -1]);
  const fl = Math.hypot(fwd[0], fwd[1], fwd[2]);
  const forward = [fwd[0] / fl, fwd[1] / fl, fwd[2] / fl];
  const eyeToCanvas = dot(sub(canvasPoint, eye), forward);
  // Canvas height from view A's frustum: tan(up) - tan(down) = 2 / b.
  const canvasHeight = dot(sub(canvasPoint, p1), forward) * (2 / viewA.projectionMatrix[5]);
  if (!(eyeToCanvas > 0) || !(canvasHeight > 0) || !Number.isFinite(canvasHeight)) return null;

  return { eye, canvasPoint, forward, eyeToCanvas, canvasHeight, basis: orthonormalBasis(ma) };
}

/** The view's rotation as unit X/Y/Z columns (a transform with parent scale still works). */
function orthonormalBasis(m) {
  const col = (i) => {
    const c = [m[i], m[i + 1], m[i + 2]];
    const l = Math.hypot(c[0], c[1], c[2]) || 1;
    return [c[0] / l, c[1] / l, c[2] / l];
  };
  return { x: col(0), y: col(4), z: col(8) };
}

/**
 * Disparity of a point (eye-baseline units; 0 on the canvas, < 0 in front).
 * @returns {number|null} null when the point is not in front of the eye.
 */
export function cursorPointDisparity(g, point) {
  if (!finite3(point)) return null;
  const t = dot(sub(point, g.eye), g.forward) / g.eyeToCanvas;
  if (!(t > 0) || !Number.isFinite(t)) return null;
  return 1 - 1 / t;
}

/**
 * Target disparity — the policy: `d < 0 ? max(d - margin, dMin) : 0`. Content in front of the glass
 * (d < 0) puts the cursor the margin in front of it (clamped); content on or behind the glass, or
 * nothing under it, leaves it ON the glass. Never behind it: the result is never above 0.
 */
export function cursorTarget(tuning, hasContent, contentDisparity) {
  if (!hasContent || !Number.isFinite(contentDisparity) || !(contentDisparity < 0)) return 0;
  const hi = Math.min(0, Number.isFinite(tuning.maxDisparity) ? tuning.maxDisparity : 0);
  return Math.min(hi, Math.max(tuning.minDisparity, contentDisparity - tuning.margin));
}

/**
 * Advance the filter toward `target`. `filter` is a plain object, `{}` to start (the first step
 * snaps). A call at a time not after the previous one does not advance it.
 * @param {number} nowSec  seconds (e.g. rAF timestamp / 1000).
 */
export function cursorFilterStep(filter, tuning, target, nowSec) {
  if (!filter.primed || nowSec < filter.last || nowSec - filter.last > tuning.stale) {
    filter.primed = true;
    filter.disparity = target;
    filter.last = nowSec;
    return target;
  }
  if (nowSec === filter.last) return filter.disparity;
  const dt = nowSec - filter.last;
  const tau = target < filter.disparity ? tuning.riseTau : tuning.sinkTau;
  const alpha = tau > 0 ? 1 - Math.exp(-dt / tau) : 1;
  filter.disparity += alpha * (target - filter.disparity);
  filter.last = nowSec;
  return filter.disparity;
}

/** Where to draw a sprite at `disparity`, and how tall, for `heightFraction` of the canvas. */
export function placeCursor(g, disparity, heightFraction) {
  const t = 1 / (1 - disparity);
  const hf = heightFraction > 0 && Number.isFinite(heightFraction) ? heightFraction : CURSOR_DEFAULT_HEIGHT;
  return { position: addScaled(g.eye, sub(g.canvasPoint, g.eye), t), height: hf * g.canvasHeight * t };
}


/** A pointer moving less than this (canvas-normalised) between frames counts as still. */
const POINTER_STILL_EPS = 1e-4;

/**
 * The whole pipeline with its state: one per cursor.
 *
 *   const placer = new CursorDepthPlacer();
 *   // per frame, with the views you are about to render:
 *   const p = placer.update(views, { u, v, nearestPoint, cursorHeight, canvasPx }, now / 1000);
 *   if (p.active) drawSprite(p.position, p.basis, p.height); // else: the OS cursor, untouched
 *
 * `views` are `{projectionMatrix, transformMatrix}` (or XRViews — `transform.matrix` is read
 * when `transformMatrix` is absent). `nearestPoint` is the content point under the cursor
 * FOOTPRINT nearest the viewer, in the views' space, or null for "nothing under it". `canvasPx`
 * (optional) is the canvas's height in panel pixels, for the draw threshold's pixel floor.
 *
 * `active` is the DRAW decision (cursorShouldDraw on the filtered disparity): false on the plane,
 * where the OS cursor is the cursor. The filter and the anchor keep running either way, and
 * `solved` says the geometry was (position etc. are then filled for diagnostics).
 */
export class CursorDepthPlacer {
  /**
   * @param {object} [tuning=CURSOR_DEFAULT_TUNING]  placement policy (see CursorTuning).
   * @param {{anchor?: 'hybrid'|'screen'|'world'}} [opts]
   */
  constructor(tuning = CURSOR_DEFAULT_TUNING, { anchor = 'hybrid' } = {}) {
    if (!CURSOR_ANCHOR_MODES.includes(anchor)) {
      throw new Error(`@displayxr/inline3d: cursor anchor "${anchor}" — expected ${CURSOR_ANCHOR_MODES.join(', ')}.`);
    }
    this.tuning = tuning;
    this.anchor = anchor;
    this.filter = {};
    this._line = null; // hybrid: the line of sight at the last pointer move { E, S, D }
    this._last = null; // [u, v] of the previous active frame
  }

  update(views, hint, nowSec) {
    const inactive = { active: false, solved: false, position: null, basis: null, height: 0, disparity: 0, targetDisparity: 0 };
    if (!views || views.length < 2 || !hint) {
      this._line = null;
      this._last = null;
      return inactive;
    }
    const a = asView(views[0]);
    const b = asView(views[views.length - 1]);
    const g = solveCursorGeometry(a, b, hint.u, hint.v);
    if (!g) {
      this._line = null;
      this._last = null;
      return inactive;
    }
    const content = hint.nearestPoint ? cursorPointDisparity(g, hint.nearestPoint) : null;
    const target = cursorTarget(this.tuning, content !== null, content);
    const f = this.filter;
    const reprimed = !f.primed || nowSec < f.last || nowSec - f.last > this.tuning.stale;
    const disparity = cursorFilterStep(f, this.tuning, target, nowSec);
    const { position: onRay, height } = placeCursor(g, disparity, hint.cursorHeight);
    const t = 1 / (1 - disparity);
    const out = (-(1 - t) * g.eyeToCanvas); // signed offset along the normal (toward the viewer)
    const fw = g.forward;
    let position = onRay;
    let anchored = false;
    if (this.anchor === 'world') {
      position = addScaled(g.canvasPoint, fw, out);
    } else if (this.anchor === 'hybrid') {
      const last = this._last;
      const moved =
        reprimed || !this._line || !last || Math.abs(hint.u - last[0]) > POINTER_STILL_EPS || Math.abs(hint.v - last[1]) > POINTER_STILL_EPS;
      if (moved) {
        this._line = { E: g.eye, S: g.canvasPoint, D: g.eyeToCanvas };
      } else {
        // On the kept line E0 → S0, the point (1 - t)·eyeToCanvas in front of the glass.
        const L = this._line;
        const k = 1 - ((1 - t) * g.eyeToCanvas) / L.D;
        position = addScaled(L.E, sub(L.S, L.E), k);
        anchored = true;
      }
    }
    this._last = [hint.u, hint.v];
    // Panel px of on-screen disparity per baseline unit: the outer views' baseline over the canvas
    // height, in the views' space, times the canvas height in panel px.
    const ra = a.transformMatrix, rb = b.transformMatrix;
    const baseline = Math.hypot(ra[12] - rb[12], ra[13] - rb[13], ra[14] - rb[14]);
    const pxPerBaseline = hint.canvasPx > 0 ? (baseline / g.canvasHeight) * hint.canvasPx : null;
    const active = cursorShouldDraw(disparity, pxPerBaseline);
    return { active, solved: true, position, basis: g.basis, height, disparity, targetDisparity: target, anchored, geometry: g, pxPerBaseline };
  }
}

function asView(v) {
  return v.transformMatrix ? v : { projectionMatrix: v.projectionMatrix, transformMatrix: v.transform.matrix };
}

/**
 * The pointer half of a depth cursor, shared by every backend: tracks the pointer over the
 * canvas (canvas-normalised, v down) and hides the CSS cursor exactly while a sprite replaces it.
 * Constructing one adds two listeners; nothing else runs until a backend asks for `uv`.
 */
export class CursorPointer {
  /**
   * @param {HTMLElement} canvas
   * @param {{scope?: 'canvas'|'window'}} [opts]  'canvas' (default): the pointer counts only while
   *        it is over the canvas element itself. 'window': while it is inside the canvas's BOX,
   *        even over DOM layered on top of it (overlay buttons, labels) — and the CSS cursor is then
   *        hidden page-wide while the sprite shows, since the overlay has its own cursor.
   */
  constructor(canvas, { scope = 'canvas' } = {}) {
    if (scope !== 'canvas' && scope !== 'window') {
      throw new Error(`@displayxr/inline3d: cursor pointerScope "${scope}" — expected 'canvas' or 'window'.`);
    }
    this.canvas = canvas;
    this.scope = scope;
    /** `[u, v]` while the pointer is over the canvas, else null. */
    this.uv = null;
    this._hidden = false;
    this._prev = '';
    this._onMove = (e) => {
      const r = canvas.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) return void (this.uv = null);
      const u = (e.clientX - r.left) / r.width;
      const v = (e.clientY - r.top) / r.height;
      this.uv = u >= 0 && u <= 1 && v >= 0 && v <= 1 ? [u, v] : null;
    };
    this._onLeave = () => {
      this.uv = null;
    };
    this._target = scope === 'window' ? globalThis : canvas;
    this._target.addEventListener('pointermove', this._onMove);
    if (scope === 'window') {
      // Leaving the window (relatedTarget null) or losing focus mid-hover: nothing to hover.
      this._onOut = (e) => {
        if (!e.relatedTarget) this.uv = null;
      };
      globalThis.addEventListener('pointerout', this._onOut);
      globalThis.addEventListener('blur', this._onLeave);
    } else {
      canvas.addEventListener('pointerleave', this._onLeave);
    }
  }

  /** Set the pointer directly (canvas-normalised, v down), or null — for scripted input. */
  set(u, v) {
    this.uv = u === null || u === undefined ? null : [u, v];
  }

  /** The canvas aspect (width / height), for a round footprint. */
  aspect() {
    const r = this.canvas.getBoundingClientRect();
    return r.height > 0 ? r.width / r.height : 1;
  }

  /** The canvas's on-page height, CSS px (0 when unknown). */
  cssHeight() {
    const r = this.canvas.getBoundingClientRect();
    return r.height > 0 ? r.height : 0;
  }

  /** The canvas's height in panel (device) pixels, or 0 when unknown. */
  panelPx() {
    return this.cssHeight() * (globalThis.devicePixelRatio > 0 ? globalThis.devicePixelRatio : 1);
  }

  /**
   * Hide (true) or restore (false) the CSS cursor; idempotent. Only ever while a sprite replaces
   * it: whatever cursor the page set (`pointer`, `grab`, a `url(…)` image) is the cursor the rest of
   * the time, and a cursor the page changes while it is hidden is not overwritten on restore.
   * (Mirroring the page's CSS cursor INTO the drawn sprite is future work — ADR-046 Amendment 2 C,
   * the browser feeding the computed CSS cursor to the runtime; today the sprite is the arrow.)
   */
  hideCss(hide) {
    if (hide === this._hidden) return;
    if (this.scope === 'window') {
      pageCursorHidden(hide);
    } else if (hide) {
      this._prev = this.canvas.style.cursor || '';
      this.canvas.style.cursor = 'none';
    } else if (this.canvas.style.cursor === 'none') {
      this.canvas.style.cursor = this._prev; // only if it is still ours
    }
    this._hidden = hide;
  }

  dispose() {
    this._target.removeEventListener('pointermove', this._onMove);
    if (this.scope === 'window') {
      globalThis.removeEventListener('pointerout', this._onOut);
      globalThis.removeEventListener('blur', this._onLeave);
    } else {
      this.canvas.removeEventListener('pointerleave', this._onLeave);
    }
    this.hideCss(false);
  }
}

// pointerScope 'window': the overlay DOM has its own cursor, so hiding it on the canvas alone is
// not enough. A class on <html> plus one injected rule hides it everywhere while any depth cursor
// shows; a count keeps two tiles from un-hiding each other.
let _pageHides = 0;
function pageCursorHidden(hide) {
  const doc = globalThis.document;
  if (!doc || !doc.documentElement) return;
  if (hide && !doc.getElementById('inline3d-cursor-style')) {
    const st = doc.createElement('style');
    st.id = 'inline3d-cursor-style';
    st.textContent = 'html.inline3d-cursor-hidden, html.inline3d-cursor-hidden * { cursor: none !important; }';
    (doc.head || doc.documentElement).appendChild(st);
  }
  _pageHides = Math.max(0, _pageHides + (hide ? 1 : -1));
  doc.documentElement.classList.toggle('inline3d-cursor-hidden', _pageHides > 0);
}

/**
 * A footprint ring: the point (u, v) plus 8 points on a circle of radius 0.75 × the sprite
 * height (canvas heights) around it.
 * @returns {Array<[number, number]>} canvas-normalised points, (u, v) first.
 */
export function cursorFootprint(u, v, height, aspect) {
  const r = 0.75 * height;
  const out = [[u, v]];
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4;
    out.push([u + (r * Math.cos(a)) / aspect, v + r * Math.sin(a)]);
  }
  return out;
}

/**
 * The footprint every backend samples for the ARROW: the hotspot (its tip) first, then a ring
 * around the arrow's BODY, which hangs down-right of the tip — that is what content must not
 * overlap. Canvas-normalised, v down.
 * @returns {Array<[number, number]>}
 */
export function cursorArrowFootprint(u, v, height, aspect) {
  return [[u, v], ...cursorFootprint(u + (0.3 * height) / aspect, v + 0.5 * height, height, aspect)];
}

/**
 * The classic pointer arrow every backend draws (ADR-046 Amendment 2: the depth cursor is the
 * cursor the user already has; where its shape cannot be read, this). The OS arrow's outline,
 * 12 × 19 px normalised: unit = its height, x right, y DOWN, the hotspot = the TIP at (0, 0). This
 * is the DARK outline's polygon; the white fill is it inset by one px (CURSOR_ARROW_FILL).
 */
export const CURSOR_ARROW = Object.freeze(
  [[0, 0], [0, 16], [4.2, 12.4], [6.9, 18.6], [9.5, 17.5], [6.8, 11.5], [11.7, 11.5]].map(([x, y]) => Object.freeze([x / 19, y / 19])),
);

/** Triangles over CURSOR_ARROW's vertices (indices): a fan from the tip over the head, the tail as two. */
const ARROW_TRIS = Object.freeze([[0, 1, 2], [0, 2, 5], [0, 5, 6], [2, 3, 4], [2, 4, 5]]);

/**
 * CURSOR_ARROW inset by `d` (units of its height) — mitred, so every edge moves in by exactly d.
 * @returns {Array<[number, number]>}
 */
export function cursorArrowInset(d, poly = CURSOR_ARROW) {
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % poly.length];
    area += x0 * y1 - x1 * y0;
  }
  const sgn = area > 0 ? 1 : -1;
  const n = poly.map((p, i) => {
    const q = poly[(i + 1) % poly.length];
    const dx = q[0] - p[0], dy = q[1] - p[1];
    const l = Math.hypot(dx, dy) || 1;
    return [(-dy / l) * sgn, (dx / l) * sgn]; // inward normal of edge i → i+1
  });
  return poly.map((p, i) => {
    const a = n[(i + poly.length - 1) % poly.length], b = n[i];
    const k = d / (1 + a[0] * b[0] + a[1] * b[1]);
    return [p[0] + (a[0] + b[0]) * k, p[1] + (a[1] + b[1]) * k];
  });
}

/** The white fill: the arrow inset by one px of its 19. */
export const CURSOR_ARROW_FILL = Object.freeze(cursorArrowInset(1 / 19).map((p) => Object.freeze(p)));

/** The arrow's colours (RGBA, 0..1): white fill, dark outline — the OS arrow. */
export const CURSOR_FILL_COLOR = Object.freeze([1, 1, 1, 1]);
export const CURSOR_OUTLINE_COLOR = Object.freeze([0.02, 0.02, 0.03, 1]);

/**
 * The arrow as a filled 3D mesh in its own XY plane (unit = sprite height, x right, y UP, the tip
 * = the hotspot at the origin, so cursorModelMatrix puts the tip on the placement): the dark
 * outline polygon first, the white fill over it — the order a depth-test-off draw needs.
 * Triangles, non-indexed. Shared by three, PlayCanvas and (in 2D) the stereo-tile cursor.
 * @returns {{positions: Float32Array, colors: Float32Array, count: number}}
 */
export function cursorArrowMesh(fill = CURSOR_FILL_COLOR, outline = CURSOR_OUTLINE_COLOR) {
  const pos = [];
  const col = [];
  for (const [poly, c] of [[CURSOR_ARROW, outline], [CURSOR_ARROW_FILL, fill]]) {
    for (const tri of ARROW_TRIS) {
      for (const k of tri) {
        pos.push(poly[k][0], -poly[k][1], 0);
        col.push(c[0], c[1], c[2], c[3]);
      }
    }
  }
  return { positions: new Float32Array(pos), colors: new Float32Array(col), count: pos.length / 3 };
}

// The retired crosshair (1.36–1.40), kept only behind the deprecated cursorCrosshairMesh.
const CROSSHAIR = [
  [-0.5, 0, -0.15, 0], [0.15, 0, 0.5, 0], [0, -0.5, 0, -0.15], [0, 0.15, 0, 0.5],
  [-0.15, -0.15, 0.15, -0.15], [0.15, -0.15, 0.15, 0.15], [0.15, 0.15, -0.15, 0.15], [-0.15, 0.15, -0.15, -0.15],
];

/**
 * @deprecated The crosshair is retired (ADR-046 Amendment 2): every depth cursor draws the arrow,
 * cursorArrowMesh(). Kept for pages that built their own sprite from it; removed in 2.0.
 */
export function cursorCrosshairMesh(fill = [1, 0.84, 0.1, 1], outline = [0.04, 0.04, 0.06, 0.85]) {
  const pos = [];
  const col = [];
  const quad = ([x0, y0, x1, y1], w, ext, c) => {
    const dx = x1 - x0, dy = y1 - y0;
    const l = Math.hypot(dx, dy) || 1;
    const ux = dx / l, uy = dy / l;
    const nx = -uy * (w / 2), ny = ux * (w / 2);
    const ax = x0 - ux * ext, ay = y0 - uy * ext, bx = x1 + ux * ext, by = y1 + uy * ext;
    const v = [[ax - nx, ay - ny], [bx - nx, by - ny], [bx + nx, by + ny], [ax - nx, ay - ny], [bx + nx, by + ny], [ax + nx, ay + ny]];
    for (const [x, y] of v) {
      pos.push(x, y, 0);
      col.push(c[0], c[1], c[2], c[3]);
    }
  };
  for (const seg of CROSSHAIR) quad(seg, 0.15, 0.04, outline);
  for (const seg of CROSSHAIR) quad(seg, 0.07, 0, fill);
  return { positions: new Float32Array(pos), colors: new Float32Array(col), count: pos.length / 3 };
}

/**
 * A column-major model matrix placing the unit sprite (the arrow, tip at its origin) for a
 * placement: the sprite's basis scaled by its height, its origin (the hotspot) at its position.
 */
export function cursorModelMatrix(placement, out = new Array(16)) {
  const { x, y, z } = placement.basis;
  const h = placement.height;
  const e = placement.position;
  out[0] = x[0] * h; out[1] = x[1] * h; out[2] = x[2] * h; out[3] = 0;
  out[4] = y[0] * h; out[5] = y[1] * h; out[6] = y[2] * h; out[7] = 0;
  out[8] = z[0] * h; out[9] = z[1] * h; out[10] = z[2] * h; out[11] = 0;
  out[12] = e[0]; out[13] = e[1]; out[14] = e[2]; out[15] = 1;
  return out;
}

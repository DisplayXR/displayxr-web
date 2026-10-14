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
//      'hybrid' (default) — 'screen' while the pointer moves (exact aim), and DISPLAY-fixed while
//                 it is still (correct parallax): the line of sight at the last pointer move
//                 (E0 → S0) is kept, IN THE DISPLAY'S FRAME (relative to the canvas, in canvas
//                 heights), and the sprite sits on it at the current depth — the point whose
//                 distance in front of the glass is (1 - t) eyeToCanvas. A head move leaves it
//                 put; a depth change slides it along that line, so it stays on the click point
//                 for the viewer who placed it; a rig move (orbit, pan, zoom) carries it with the
//                 canvas, so it stays on the pointer. Continuous at the stop frame.
//    The height is scaled by t either way, so the apparent size is constant.
//
// THE POLICY (ADR-046 Amendment 2, the same for every DisplayXR depth cursor — this module, ./three's
// DepthCursor, `cursor: 'depth'` on ./model and ./splat, and the stereo-tile cursor on ./call and
// ./camera, which calls the pieces exported here):
//  - never behind the glass: target = d < 0 ? max(d - margin, dMin) : 0 — it only comes forward,
//    to stay ahead of content that comes OUT of the screen (cursorTarget);
//  - margin 0.015 eye baselines (~1 mm of crossed on-screen disparity at a 63-65 mm IPD);
//  - on the plane it IS the OS cursor: nothing is drawn while the filtered disparity is above
//    CURSOR_DRAW_THRESHOLD (-0.005, ~0.3 mm) or under CURSOR_DRAW_MIN_PX on the panel
//    (cursorShouldDraw), and the CSS cursor is left alone;
//  - the look: the classic arrow (CURSOR_ARROW, tip = hotspot), at the OS cursor's size
//    (CURSOR_ARROW_CSS_PX tall on the page, cursorDefaultHeight) — or, mirroring the page's CSS
//    cursor: every CSS keyword and url() images (./inline3d-cursor-shape.js);
//  - crosstalk softening (Amendment 2 §B.7): a LIFTED arrow is blurred by k × its ghost offset and
//    faded toward alphaMin with its lift, both exactly zero on the glass (cursorSoften and below).

import { CURSOR_ANCHOR_MODES } from './inline3d-cursor-option.js';

export {
  CURSOR_ANCHOR_MODES,
  CURSOR_OPTION_KEYS,
  CURSOR_SOFTEN_DEFAULTS,
  CURSOR_SOFTEN_KEYS,
  CURSOR_SOFTEN_PRESETS,
  parseCursorSoften,
  resolveCursorOption,
  resolveCursorSoften,
} from './inline3d-cursor-option.js';
import { CURSOR_SOFTEN_DEFAULTS } from './inline3d-cursor-option.js';
import { CURSOR_HIDDEN_ATTR, ensureCursorHiddenRule } from './inline3d-cursor-shape.js';

// Which sprite: the page's CSS cursor mirrored (shapes, read-back) — its own module, re-exported.
export {
  CURSOR_CSS_KEYWORDS,
  CURSOR_CSS_READ_MS,
  CURSOR_HIDDEN_ATTR,
  CURSOR_HIDDEN_RULE,
  CURSOR_IMAGE_MAX_PX,
  CURSOR_SHAPES,
  CURSOR_SHAPE_OPTIONS,
  CURSOR_SHAPE_TEXTURE_PX,
  CursorCssReader,
  CursorImageCache,
  CursorShapeSelector,
  cssCursorToShape,
  cssKeywordToShape,
  curFileHotspot,
  cursorImageCache,
  cursorPickShape,
  cursorShape,
  cursorShapeBox,
  cursorShapePolys,
  cursorShapeRaster,
  cursorShapeSample,
  cursorShapeTexture,
  cursorSoftenPixels,
  cursorSpriteBox,
  cursorSpriteGLSL,
  cursorSpriteRect,
  drawCursorShape2D,
  ensureCursorHiddenRule,
  parseCssCursor,
  readPageCursor,
  resolveCursorSprite,
  spriteForName,
} from './inline3d-cursor-shape.js';

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
   * How far in front of out-of-screen content the cursor floats: 0.015 eye baselines, ~1 mm of
   * crossed on-screen disparity at a 63-65 mm IPD (ADR-046 Amendment 2 A.2; halved from 0.03 on
   * 2026-10-11 after a Windows panel check: 0.03 floated visibly off the content).
   */
  margin: 0.015,
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

  // Canvas aspect (width / height) from the same frustum: (2 / a) / (2 / b).
  const aspect = viewA.projectionMatrix[5] / viewA.projectionMatrix[0];
  return { eye, canvasPoint, forward, eyeToCanvas, canvasHeight, aspect, basis: orthonormalBasis(ma) };
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
/** The runtime's U_CURSOR_DEPTH_ANCHOR_PLANE_EPS: a canvas whose shape moves more than this re-anchors. */
const CURSOR_ANCHOR_PLANE_EPS = 1e-3;

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
      let moved =
        reprimed || !this._line || !last || Math.abs(hint.u - last[0]) > POINTER_STILL_EPS || Math.abs(hint.v - last[1]) > POINTER_STILL_EPS;
      // The kept line lives in the DISPLAY's frame, never the scene's: origin S (the canvas point
      // under the pointer — the same canvas point while the pointer is still), axes the canvas's
      // (g.basis), unit the canvas height. A rig that orbits, pans or zooms the scene (./model's
      // idle spin, damped drag, a scripted camera) moves the views and the canvas together, so in
      // this frame nothing changed and the sprite stays on the pointer; a head move changes the
      // eye's position relative to the canvas, so it still parallaxes like content. (The runtime's
      // u_cursor_depth gets this for free: it works in display space.)
      let k = 0;
      let L = this._line;
      if (!moved) {
        // #1951's rule: the line means something only on the canvas it was taken against. In the
        // display frame a rig move is not a change; a canvas whose SHAPE changed (resize) is.
        moved = !(Math.abs(g.aspect / L.aspect - 1) <= CURSOR_ANCHOR_PLANE_EPS);
      }
      if (!moved) {
        // On the kept line E0 → S0, the point (1 - t)·eyeToCanvas in front of the glass, all in
        // canvas heights: s = 1 - lift / D0, C = S0 + (1 - s)(E0 - S0) = S0 + k E0.
        const lift = ((1 - t) * g.eyeToCanvas) / g.canvasHeight;
        k = lift / L.D;
        // s <= 0 (the head moved back past E0): never place it at or behind the anchor eye.
        if (!(k < 1) || !Number.isFinite(k)) moved = true;
      }
      if (moved) {
        const e = sub(g.eye, g.canvasPoint);
        const h = g.canvasHeight;
        const B = g.basis;
        L = this._line = { E: [dot(e, B.x) / h, dot(e, B.y) / h, dot(e, B.z) / h], D: g.eyeToCanvas / h, aspect: g.aspect };
      } else {
        const B = g.basis;
        const h = g.canvasHeight * k;
        position = g.canvasPoint;
        position = addScaled(position, B.x, L.E[0] * h);
        position = addScaled(position, B.y, L.E[1] * h);
        position = addScaled(position, B.z, L.E[2] * h);
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
   * @param {{scope?: 'canvas'|'window', keepCss?: boolean}} [opts]  'canvas' (default): the pointer counts only while
   *        it is over the canvas element itself. 'window': while it is inside the canvas's BOX,
   *        even over DOM layered on top of it (overlay buttons, labels) — and the CSS cursor is then
   *        hidden page-wide while the sprite shows, since the overlay has its own cursor.
   *        `keepCss`: never hide the CSS cursor (`cursor: { debug: 'both' }`, the latency check
   *        that films the sprite next to the OS cursor).
   */
  constructor(canvas, { scope = 'canvas', keepCss = false } = {}) {
    if (scope !== 'canvas' && scope !== 'window') {
      throw new Error(`@displayxr/inline3d: cursor pointerScope "${scope}" — expected 'canvas' or 'window'.`);
    }
    this.canvas = canvas;
    this.scope = scope;
    this.keepCss = !!keepCss;
    this._uv = null;
    /** Time (event timeStamp, ms) of the newest pointer sample; 0 before the first. */
    this.sampleTime = 0;
    /** Pointer samples received so far (diagnostics). */
    this.samples = 0;
    this._hidden = false;
    this._cx = 0;
    this._cy = 0;
    this._pending = false; // a sample not yet resolved to uv (resolved once, on the next read)
    this._onMove = (e) => this._sample(e);
    this._onLeave = () => {
      this.uv = null;
    };
    this._target = scope === 'window' ? globalThis : canvas;
    // Freshest pointer: `pointerrawupdate` (Chromium, secure contexts) fires as each input arrives,
    // not once per frame, so the frame reads the newest position instead of one up to a frame old.
    // `pointermove` stays as the fallback (and for synthetic events) — a sample older than one
    // already held is ignored, so the two never fight.
    /** Which event feeds the position: 'pointerrawupdate' where supported, else 'pointermove'. */
    this.source = supportsRawUpdate(this._target) ? 'pointerrawupdate' : 'pointermove';
    this._target.addEventListener('pointermove', this._onMove);
    if (this.source === 'pointerrawupdate') this._target.addEventListener('pointerrawupdate', this._onMove);
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

  /** `[u, v]` while the pointer is over the canvas, else null. */
  get uv() {
    if (this._pending) {
      this._pending = false;
      const r = this.canvas.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) {
        this._uv = null;
      } else {
        const u = (this._cx - r.left) / r.width;
        const v = (this._cy - r.top) / r.height;
        this._uv = u >= 0 && u <= 1 && v >= 0 && v <= 1 ? [u, v] : null;
      }
    }
    return this._uv;
  }

  set uv(x) {
    this._pending = false;
    this._uv = x;
  }

  // One pointer event: keep its NEWEST coalesced sample (getCoalescedEvents(), last entry), unless
  // a newer one is already held. No layout read here — uv resolves on the next read, once a frame.
  _sample(e) {
    const list = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null;
    const s = list && list.length ? list[list.length - 1] : e;
    const t = s.timeStamp > 0 ? s.timeStamp : e.timeStamp > 0 ? e.timeStamp : globalThis.performance ? globalThis.performance.now() : Date.now();
    if (t < this.sampleTime) return;
    this.samples++;
    this.sampleTime = t;
    this._cx = s.clientX;
    this._cy = s.clientY;
    this._pending = true;
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

  /** The canvas's `[width, height]` in panel (device) pixels, `[0, 0]` when unknown. */
  panelSize() {
    const r = this.canvas.getBoundingClientRect();
    const k = globalThis.devicePixelRatio > 0 ? globalThis.devicePixelRatio : 1;
    return r.width > 0 && r.height > 0 ? [r.width * k, r.height * k] : [0, 0];
  }

  /**
   * Hide (true) or restore (false) the CSS cursor; idempotent. Only ever while a sprite replaces
   * it. The hide is a data attribute (CURSOR_HIDDEN_ATTR) on the canvas — on <html> for
   * pointerScope 'window' — plus one injected `cursor: none !important` rule for it: the page's
   * own cursor (`pointer`, `grab`, a `url(…)` image, inline or from a stylesheet) is never
   * written, so it is what shows the rest of the time, and what the sprite mirrors (CursorCssReader
   * lifts the attribute for its read).
   */
  hideCss(hide) {
    if (this.keepCss) hide = false;
    if (hide === this._hidden) return;
    if (this.scope === 'window') {
      pageCursorHidden(hide);
    } else if (this.canvas.setAttribute) {
      if (hide) {
        ensureCursorHiddenRule();
        this.canvas.setAttribute(CURSOR_HIDDEN_ATTR, '');
      } else {
        this.canvas.removeAttribute(CURSOR_HIDDEN_ATTR);
      }
    }
    this._hidden = hide;
  }

  dispose() {
    this._target.removeEventListener('pointermove', this._onMove);
    if (this.source === 'pointerrawupdate') this._target.removeEventListener('pointerrawupdate', this._onMove);
    if (this.scope === 'window') {
      globalThis.removeEventListener('pointerout', this._onOut);
      globalThis.removeEventListener('blur', this._onLeave);
    } else {
      this.canvas.removeEventListener('pointerleave', this._onLeave);
    }
    this.hideCss(false);
  }
}

/** Does `target` dispatch `pointerrawupdate`? (Chromium; only in a secure context.) */
export function supportsRawUpdate(target) {
  return !!target && 'onpointerrawupdate' in target && globalThis.isSecureContext !== false;
}

// pointerScope 'window': the overlay DOM has its own cursor, so hiding it on the canvas alone is
// not enough. The attribute on <html> (the injected rule covers its descendants) hides it
// everywhere while any depth cursor shows; a count keeps two tiles from un-hiding each other.
let _pageHides = 0;
function pageCursorHidden(hide) {
  const doc = globalThis.document;
  if (!doc || !doc.documentElement) return;
  if (hide) ensureCursorHiddenRule(doc);
  _pageHides = Math.max(0, _pageHides + (hide ? 1 : -1));
  const el = doc.documentElement;
  if (_pageHides > 0) el.setAttribute?.(CURSOR_HIDDEN_ATTR, '');
  else el.removeAttribute?.(CURSOR_HIDDEN_ATTR);
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


// ── Crosstalk softening of the lifted cursor (runtime ADR-046 Amendment 2 §B.7) ─────────────
//
// A port of the runtime's u_cursor_draw_soften_sized / u_cursor_draw_ghost_px and its 13-tap
// kernel (comp_metal_compositor.m `cursor_fragment_soft`, the same on every backend). The blur
// and the fade live in the CURSOR'S OWN material: a quad whose fragment shader evaluates the arrow
// analytically at the kernel's 13 taps (cursorSoftArrowGLSL), or, on a 2D pair, the same function
// rasterised in JS (cursorSoftArrowRaster). Never a CSS filter or CSS opacity. A frame whose
// softening is (0 px, 1.0) draws the crisp arrow mesh exactly as before.

/**
 * One frame's softening (u_cursor_draw_soften_sized): the blur radius in panel px and the opacity,
 * for a cursor drawn at filtered disparity `d` (eye baselines) whose neighbouring views sit
 * `ghostPx` panel px apart. Blur = blurK × |ghost|, capped at blurMaxPx and — when `spritePx`, the
 * drawn arrow's height in panel px, is known — at blurMaxFrac × spritePx. Opacity eases 1 → alphaMin
 * by a smoothstep over |d| up to fullD. Both are (0, 1) on the glass; non-finite input = none.
 * @param {number} d
 * @param {number} ghostPx
 * @param {number} [spritePx]
 * @param {object} [params=CURSOR_SOFTEN_DEFAULTS]  resolveCursorSoften's result.
 * @returns {{blurPx: number, alpha: number}}
 */
export function cursorSoften(d, ghostPx, spritePx, params = CURSOR_SOFTEN_DEFAULTS) {
  const s = { blurPx: 0, alpha: 1 };
  const p = params;
  if (!p) return s;
  if (p.blur && Number.isFinite(ghostPx) && p.blurK > 0 && p.blurMaxPx > 0) {
    let cap = p.blurMaxPx;
    if (p.blurMaxFrac > 0 && Number.isFinite(spritePx) && spritePx > 0) {
      const rel = p.blurMaxFrac * spritePx; // proportional to the drawn cursor
      cap = rel < cap ? rel : cap;
    }
    const b = p.blurK * Math.abs(ghostPx);
    s.blurPx = b < cap ? b : cap;
  }
  if (p.alpha && Number.isFinite(d) && p.fullD > 0) {
    let x = Math.abs(d) / p.fullD;
    x = x < 1 ? x : 1;
    const ease = x * x * (3 - 2 * x); // smoothstep(0, fullD, |d|)
    const amin = p.alphaMin < 0 ? 0 : p.alphaMin > 1 ? 1 : p.alphaMin;
    s.alpha = 1 - (1 - amin) * ease;
  }
  return s;
}

/**
 * The ghost offset (u_cursor_draw_ghost_px): the largest distance, in panel px, between the
 * hotspot's positions in two NEIGHBOURING views (i, i + 1) — what crosstalk leaks.
 * @param {ArrayLike<ArrayLike<number>|null>} origins  the hotspot per view, canvas-normalised [u, v]
 * @param {number} pxW  panel px that 0..1 of u spans (the canvas width)
 * @param {number} pxH  panel px that 0..1 of v spans
 */
export function cursorGhostPx(origins, pxW, pxH) {
  if (!origins || !(pxW > 0) || !(pxH > 0)) return 0;
  let ghost = 0;
  for (let i = 0; i + 1 < origins.length; i++) {
    const a = origins[i], b = origins[i + 1];
    if (!a || !b) continue;
    const g = Math.hypot((b[0] - a[0]) * pxW, (b[1] - a[1]) * pxH);
    if (Number.isFinite(g) && g > ghost) ghost = g;
  }
  return ghost;
}

/**
 * Where a world point lands on the canvas in one view: canvas-normalised [u, v] (v down), or null
 * when it is not in front of the view. The view's transform may carry a parent scale.
 */
export function cursorProjectToCanvas(view, point) {
  const v = asView(view);
  const m = v.transformMatrix, p = v.projectionMatrix;
  // Inverse of the transform's 3×3 (cofactors) applied to (point − origin).
  const a = m[0], b = m[4], c = m[8], d = m[1], e = m[5], f = m[9], g = m[2], h = m[6], k = m[10];
  const A = e * k - f * h, B = -(d * k - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!(Math.abs(det) > 1e-30)) return null;
  const x = point[0] - m[12], y = point[1] - m[13], z = point[2] - m[14];
  const lx = (A * x + (c * h - b * k) * y + (b * f - c * e) * z) / det;
  const ly = (B * x + (a * k - c * g) * y + (c * d - a * f) * z) / det;
  const lz = (C * x + (b * g - a * h) * y + (a * e - b * d) * z) / det;
  const cx = p[0] * lx + p[4] * ly + p[8] * lz + p[12];
  const cy = p[1] * lx + p[5] * ly + p[9] * lz + p[13];
  const cw = p[3] * lx + p[7] * ly + p[11] * lz + p[15];
  if (!(cw > 0)) return null;
  const out = [(cx / cw + 1) / 2, (1 - cy / cw) / 2];
  return Number.isFinite(out[0]) && Number.isFinite(out[1]) ? out : null;
}

/**
 * The softening for a placement (CursorDepthPlacer.update's result) drawn with `views` on a canvas
 * `panelW` × `panelH` panel px, the arrow `heightFraction` of the canvas tall. The ghost offset is
 * measured from where the placement's hotspot lands in each view — right for every rig and view
 * count. Inactive placements are never softened.
 * @returns {{blurPx: number, alpha: number, ghostPx: number, spritePx: number, radius: number, aa: number, soft: boolean}}
 *   `radius` / `aa`: the blur radius and one panel px in ARROW units (its height = 1), for the
 *   material; `soft`: false = draw the crisp arrow (bit-identical to the unsoftened draw).
 */
export function cursorPlacementSoften(placement, views, panelW, panelH, heightFraction, params = CURSOR_SOFTEN_DEFAULTS) {
  const none = { blurPx: 0, alpha: 1, ghostPx: 0, spritePx: 0, radius: 0, aa: 0, soft: false };
  if (!placement || !placement.active || !placement.position || !views) return none;
  const origins = Array.from(views, (v) => cursorProjectToCanvas(v, placement.position));
  const ghostPx = cursorGhostPx(origins, panelW, panelH);
  const spritePx = heightFraction > 0 && panelH > 0 ? heightFraction * panelH : 0;
  const s = cursorSoften(placement.disparity, ghostPx, spritePx, params);
  const soft = s.blurPx > 0 || s.alpha < 1;
  return {
    blurPx: s.blurPx,
    alpha: s.alpha,
    ghostPx,
    spritePx,
    radius: spritePx > 0 ? s.blurPx / spritePx : 0,
    aa: spritePx > 0 ? 1 / spritePx : 0,
    soft,
  };
}

/**
 * The runtime's blur kernel, in units of the radius: `[dx, dy, weight]` — the centre, 4 taps at
 * r/2 and 8 at r (a Gaussian, sigma ≈ 0.6 r). Taps outside the arrow read as transparent.
 */
export const CURSOR_SOFTEN_KERNEL = Object.freeze([
  Object.freeze([0, 0, 1]),
  ...[[0.5, 0], [-0.5, 0], [0, 0.5], [0, -0.5]].map(([x, y]) => Object.freeze([x, y, 0.7066])),
  ...Array.from({ length: 8 }, (_, k) => {
    const a = 0.3927 + 0.7854 * k;
    return Object.freeze([Math.cos(a), Math.sin(a), 0.2494]);
  }),
]);

/** The arrow's extent in its own units (height = 1, x right, y down from the tip). */
export const CURSOR_ARROW_SIZE = Object.freeze([
  Math.max(...CURSOR_ARROW.map((p) => p[0])),
  Math.max(...CURSOR_ARROW.map((p) => p[1])),
]);

/**
 * The softened arrow's quad in arrow units (y down, the tip = the hotspot at the origin): the
 * arrow's box padded by the blur radius (plus one AA width) on every side, so the soft edge is not
 * clipped. The hotspot does not move — the box only grows around it.
 * @returns {[number, number, number, number]}  [x0, y0, x1, y1]
 */
export function cursorSoftArrowBox(radius, aa = 0) {
  const pad = (radius > 0 && Number.isFinite(radius) ? radius : 0) + (aa > 0 && Number.isFinite(aa) ? aa : 0);
  return [-pad, -pad, CURSOR_ARROW_SIZE[0] + pad, CURSOR_ARROW_SIZE[1] + pad];
}

/** Signed distance to a polygon (negative inside), any winding — the crossing-number form. */
export function cursorPolygonSd(poly, x, y) {
  let d = (x - poly[0][0]) ** 2 + (y - poly[0][1]) ** 2;
  let s = 1;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i++) {
    const vi = poly[i], vj = poly[j];
    const ex = vj[0] - vi[0], ey = vj[1] - vi[1];
    const wx = x - vi[0], wy = y - vi[1];
    const t = Math.min(1, Math.max(0, (wx * ex + wy * ey) / (ex * ex + ey * ey)));
    const bx = wx - ex * t, by = wy - ey * t;
    d = Math.min(d, bx * bx + by * by);
    const c1 = y >= vi[1], c2 = y < vj[1], c3 = ex * wy > ey * wx;
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s;
  }
  return s * Math.sqrt(d);
}

const coverage = (sd, aa) => (aa > 0 ? Math.min(1, Math.max(0, 0.5 - sd / aa)) : sd < 0 ? 1 : 0);

/**
 * The softened arrow at point (x, y) of its own units — the reference the shader mirrors: the
 * kernel's 13 taps of the crisp arrow (dark outline, the fill over it, each edge anti-aliased over
 * `aa`), accumulated PREMULTIPLIED, so clear taps add no colour. `radius` 0 = the centre tap only.
 * @returns {[number, number, number, number]}  straight RGB and alpha (before the opacity)
 */
export function cursorSoftArrowSample(x, y, radius, aa, fill = CURSOR_FILL_COLOR, outline = CURSOR_OUTLINE_COLOR, polys = [CURSOR_ARROW, CURSOR_ARROW_FILL]) {
  let r = 0, g = 0, b = 0, a = 0, ws = 0;
  const taps = radius > 0 ? CURSOR_SOFTEN_KERNEL : CURSOR_SOFTEN_KERNEL.slice(0, 1);
  for (const [dx, dy, w] of taps) {
    const px = x + dx * radius, py = y + dy * radius;
    const co = coverage(cursorPolygonSd(polys[0], px, py), aa);
    const cf = co > 0 ? coverage(cursorPolygonSd(polys[1], px, py), aa) : 0;
    r += w * (outline[0] * co + (fill[0] - outline[0]) * cf);
    g += w * (outline[1] * co + (fill[1] - outline[1]) * cf);
    b += w * (outline[2] * co + (fill[2] - outline[2]) * cf);
    a += w * co;
    ws += w;
  }
  a /= ws;
  if (!(a > 1e-5)) return [0, 0, 0, 0];
  return [r / ws / a, g / ws / a, b / ws / a, a];
}

const glf = (v) => {
  const s = (+v).toPrecision(9);
  return /[.eE]/.test(s) ? s : `${s}.0`;
};

/**
 * GLSL (ES 1.00 and 3.00 alike: no arrays, no loops) for the softened arrow, generated from the
 * same polygons and kernel as cursorSoftArrowSample:
 *
 *   vec4 inline3dSoftArrow(vec2 p, float radius, float aa, vec3 fill, vec3 outline)
 *
 * `p` in arrow units (height 1, y down, tip at the origin). Returns straight RGB and alpha; the
 * caller multiplies the alpha by the opacity.
 */
export function cursorSoftArrowGLSL(polys = [CURSOR_ARROW, CURSOR_ARROW_FILL]) {
  const v2 = (q) => `vec2(${glf(q[0])}, ${glf(q[1])})`;
  const sdFn = (name, poly) => {
    const lines = [`float ${name}(vec2 p) {`, `  float d = dot(p - ${v2(poly[0])}, p - ${v2(poly[0])});`, '  float s = 1.0;'];
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i++) lines.push(`  i3dCursorEdge(p, ${v2(poly[i])}, ${v2(poly[j])}, d, s);`);
    lines.push('  return s * sqrt(d);', '}');
    return lines.join('\n');
  };
  const taps = CURSOR_SOFTEN_KERNEL.slice(1)
    .map(([dx, dy, w]) => `    acc += ${glf(w)} * i3dCursorTap(p + vec2(${glf(dx)}, ${glf(dy)}) * radius, aa, fill, outline);`)
    .join('\n');
  const wsum = CURSOR_SOFTEN_KERNEL.slice(1).reduce((t, k) => t + k[2], 0);
  return `
void i3dCursorEdge(vec2 p, vec2 vi, vec2 vj, inout float d, inout float s) {
  vec2 e = vj - vi;
  vec2 w = p - vi;
  vec2 b = w - e * clamp(dot(w, e) / dot(e, e), 0.0, 1.0);
  d = min(d, dot(b, b));
  bool c1 = p.y >= vi.y;
  bool c2 = p.y < vj.y;
  bool c3 = e.x * w.y > e.y * w.x;
  if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s;
}
${sdFn('i3dCursorSdOutline', polys[0])}
${sdFn('i3dCursorSdFill', polys[1])}
float i3dCursorCov(float sd, float aa) {
  return aa > 0.0 ? clamp(0.5 - sd / aa, 0.0, 1.0) : (sd < 0.0 ? 1.0 : 0.0);
}
vec4 i3dCursorTap(vec2 p, float aa, vec3 fill, vec3 outline) {
  float co = i3dCursorCov(i3dCursorSdOutline(p), aa);
  float cf = i3dCursorCov(i3dCursorSdFill(p), aa);
  return vec4(outline * co + (fill - outline) * cf, co);
}
vec4 inline3dSoftArrow(vec2 p, float radius, float aa, vec3 fill, vec3 outline) {
  vec4 acc = i3dCursorTap(p, aa, fill, outline);
  float wsum = 1.0;
  if (radius > 0.0) {
${taps}
    wsum += ${glf(wsum)};
  }
  acc /= wsum;
  return vec4(acc.a > 1e-5 ? acc.rgb / acc.a : vec3(0.0), acc.a);
}
`;
}

/**
 * The softened arrow rasterised for a 2D canvas (the stereo-pair cursor): pixel (i, j) of the
 * result covers canvas px (x0 + i, y0 + j), sampled at its centre, with the arrow `sizePx` tall and
 * its tip at canvas point (cx, cy). Straight-alpha RGBA bytes (ImageData layout), the opacity
 * applied. One canvas px is the AA width.
 * @returns {{x0: number, y0: number, width: number, height: number, data: Uint8ClampedArray}}
 */
export function cursorSoftArrowRaster(cx, cy, sizePx, radius, alpha, fill = CURSOR_FILL_COLOR, outline = CURSOR_OUTLINE_COLOR, polys = [CURSOR_ARROW, CURSOR_ARROW_FILL]) {
  const size = sizePx > 0 && Number.isFinite(sizePx) ? sizePx : 1;
  const aa = 1 / size;
  const [bx0, by0, bx1, by1] = cursorSoftArrowBox(radius, aa);
  const x0 = Math.floor(cx + bx0 * size), y0 = Math.floor(cy + by0 * size);
  const width = Math.max(1, Math.ceil(cx + bx1 * size) - x0), height = Math.max(1, Math.ceil(cy + by1 * size) - y0);
  const data = new Uint8ClampedArray(width * height * 4);
  const op = alpha >= 0 && alpha <= 1 ? alpha : 1;
  for (let j = 0; j < height; j++) {
    const y = (y0 + j + 0.5 - cy) / size;
    for (let i = 0; i < width; i++) {
      const c = cursorSoftArrowSample((x0 + i + 0.5 - cx) / size, y, radius, aa, fill, outline, polys);
      if (!(c[3] > 0)) continue;
      const o = (j * width + i) * 4;
      data[o] = Math.round(c[0] * 255);
      data[o + 1] = Math.round(c[1] * 255);
      data[o + 2] = Math.round(c[2] * 255);
      data[o + 3] = Math.round(c[3] * op * 255);
    }
  }
  return { x0, y0, width, height, data };
}

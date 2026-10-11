// camera/pair-cursor.js — the depth-aware cursor on a STEREO PAIR: a call tile or a camera view.
//
// The OS cursor is drawn at zero disparity, on the glass. Over a person who sits in front of it
// (a converged stereo call puts the face AT the glass, so the shoulders, a raised hand, a cup held
// up are all in front), it is drawn on top of pixels that say they are nearer — the depth
// violation runtime ADR-046 is about. A pair has no scene to raycast and no depth buffer, but its
// two halves ARE the depth: this is ADR-046 Phase 3b done in the page. Block-match a cursor-sized
// footprint between the eyes and take the nearest confident match.
//
// The policy is the one every DisplayXR depth cursor follows (runtime ADR-046 Amendment 2), taken
// from the shared core (../inline3d-cursor-depth.js), not re-implemented here:
//  - never behind the glass: only content that comes OUT of the screen moves it, to the margin
//    (0.03 eye baselines, ~2 mm) in front of that content (cursorTarget);
//  - on the plane it IS the OS cursor: the arrow is drawn into both halves only while the filtered
//    disparity is past the draw threshold (-0.005 baselines, and >= 0.5 px; cursorShouldDraw), the
//    OS cursor hidden exactly then;
//  - the same filter (fast rise, slow sink) and the same arrow (CURSOR_ARROW, tip = hotspot, the
//    OS arrow's 19 CSS px).
// What is specific to a pair: it has no 3D views, so it works in tile PIXEL disparity — OUTPUT
// pixels of one eye of the woven buffer, + = crossed (in front of the glass), the sign the rest of
// camera/ uses — and converts to the core's eye-baseline units through the panel's pixel pitch:
// buffer px per metre = outW / tileCssWidth / metersPerCssPx (the tile handle's displayMetrics()),
// times the eye separation (displayMetrics' default, 63 mm). Loaded only when a page asks for
// `cursor: 'depth'` — zero cost otherwise.

import {
  CursorPointer,
  cursorArrowFootprint,
  cursorArrowInset,
  cursorDefaultHeight,
  cursorFilterStep,
  cursorShouldDraw,
  cursorTarget,
  CURSOR_ARROW,
  CURSOR_ARROW_CSS_PX,
  CURSOR_DEFAULT_TUNING,
} from '../inline3d-cursor-depth.js';
import { DISPLAY_METRICS_DEFAULTS } from '../inline3d-display-metrics.js';
import { matchBlock, MIN_NCC } from './disparity.js';

/** The arrow's height in CSS px — the OS arrow's apparent size (the core's CURSOR_ARROW_CSS_PX). */
export const PAIR_CURSOR_CSS_PX = CURSOR_ARROW_CSS_PX;
/** Arrow height as a fraction of the tile height when the tile's on-page size is unknown. */
export const PAIR_CURSOR_HEIGHT = 0.06;
/** The arrow every DisplayXR depth cursor draws (the core's CURSOR_ARROW): tip at (0, 0), unit = its height, y down. */
export const PAIR_CURSOR_ARROW = CURSOR_ARROW;
/** One CSS px in metres when the panel cannot say (the CSS reference pixel, 1/96 in). */
export const PAIR_CURSOR_CSS_PX_M = 0.0254 / 96;

/**
 * The displayed disparity of the nearest content under the cursor's footprint, or null when no
 * point of the footprint matched confidently (flat, ambiguous, off the frame).
 *
 * @param {{img: ArrayLike<number>, w: number, h: number, scale: number}} luma  a grayscale copy
 *        of the WHOLE side-by-side source frame; `scale` = copy px per source px.
 * @param {{rL: {sx:number, sy:number, sw:number, sh:number}, rR: {sx:number}, outW: number, mirror?: boolean}} geo
 *        each eye's source crop (relative to its half, eyeCropRect) and the output eye width; a
 *        mirrored view (the self view) flips the pointer, never the disparity.
 * @param {number} u  pointer hotspot, tile-normalised (0..1, left → right as the viewer sees it)
 * @param {number} v  pointer hotspot, tile-normalised (0..1, top → bottom)
 * @param {number} height  arrow height (fraction of the tile height); the footprint covers the
 *        arrow's body, which hangs down-right of the hotspot
 * @param {number} aspect  the tile's width / height, for a round footprint
 * @returns {number|null}  output px, + = in front of the glass
 */
export function pairFootprintDisparity(luma, geo, u, v, height, aspect) {
  if (!luma || !luma.img || !geo || !geo.rL || !geo.rR || !(geo.outW > 0)) return null;
  const { img, w, h, scale } = luma;
  const E = w / 2;
  const b = Math.max(8, Math.round(E / 20));
  const dMax = Math.round(E * 0.3);
  const dMin = -Math.round(E * 0.05);
  const { rL, rR } = geo;
  const k = geo.outW / rL.sw; // output px per source px
  let best = null;
  // The tip, then a ring centred on the arrow's body: that is what content must not overlap.
  for (const [pu, pv] of cursorArrowFootprint(u, v, height, aspect)) {
    if (!(pu >= 0 && pu <= 1 && pv >= 0 && pv <= 1)) continue;
    const su = geo.mirror ? 1 - pu : pu;
    const x = Math.round((rL.sx + su * rL.sw) * scale - b / 2);
    const y = Math.round((rL.sy + pv * rL.sh) * scale - b / 2);
    if (x < 0 || x + b > E || y < 0 || y + b > h) continue;
    const m = matchBlock(img, w, h, x, y, b, b, { dMin, dMax, dyMax: 2 });
    if (!m || m.c < MIN_NCC) continue;
    // Source disparity → displayed: each eye's crop moved its half by its own offset.
    const d = (m.d / scale - (rL.sx - rR.sx)) * k;
    if (best === null || d > best) best = d;
  }
  return best;
}

/**
 * Output px of one eye per metre on the glass: the buffer eye is stretched over the tile's CSS
 * width, and one CSS px is `metersPerCssPx` on the panel (the CSS reference px when unknown).
 */
export function pairCursorScale(outW, tileCssWidth, metersPerCssPx) {
  const m = metersPerCssPx > 0 && Number.isFinite(metersPerCssPx) ? metersPerCssPx : PAIR_CURSOR_CSS_PX_M;
  return tileCssWidth > 0 ? outW / tileCssWidth / m : outW / (1000 * m);
}

/**
 * Output px of on-screen disparity per eye-baseline unit — the conversion between this module's
 * pixels and the core's units: pairCursorScale × the eye separation.
 */
export function pairPxPerBaseline(outW, tileCssWidth, metersPerCssPx, eyeSeparationM = DISPLAY_METRICS_DEFAULTS.eyeSeparationM) {
  return pairCursorScale(outW, tileCssWidth, metersPerCssPx) * eyeSeparationM;
}

/**
 * The arrow's target disparity in output px (+ = in front): the core's policy (cursorTarget) on
 * the content's disparity, converted through `pxPerBaseline`. In front of content that comes OUT
 * of the screen by the margin (0.03 baselines), else the glass — never behind it.
 */
export function pairCursorTarget(contentPx, pxPerBaseline, tuning = CURSOR_DEFAULT_TUNING) {
  if (contentPx === null || !Number.isFinite(contentPx) || !(pxPerBaseline > 0)) return 0;
  return -cursorTarget(tuning, true, -contentPx / pxPerBaseline) * pxPerBaseline || 0;
}

/** The arrow's fill, inset by one output px (at least 1/19 of its height), cached per size. */
const _fillBySize = new Map();
function arrowFill(sizePx) {
  const d = sizePx > 0 ? Math.max(1 / 19, 1 / sizePx) : 1 / 19;
  const key = Math.round(d * 1e4);
  let f = _fillBySize.get(key);
  if (!f) {
    if (_fillBySize.size > 32) _fillBySize.clear();
    _fillBySize.set(key, (f = cursorArrowInset(d)));
  }
  return f;
}

/**
 * Draw the arrow into both halves of a woven buffer: the left eye's copy `disparityPx / 2` right of
 * the pointer, the right eye's as far left (crossed = in front). The shared arrow: its dark outline
 * polygon, then the white fill inset by a px; the tip on the hotspot. Each copy is clipped to its
 * own half, so an arrow at the edge never bleeds into the other eye.
 * @param {number} sizePx  arrow height in output px
 */
export function drawPairArrow(g, outW, outH, u, v, disparityPx, sizePx) {
  const cy = v * outH;
  const fill = arrowFill(sizePx);
  for (const eye of [0, 1]) {
    const cx = eye * outW + u * outW + (eye === 0 ? disparityPx / 2 : -disparityPx / 2);
    g.save();
    g.beginPath();
    g.rect(eye * outW, 0, outW, outH);
    g.clip();
    for (const [poly, style] of [[CURSOR_ARROW, '#000'], [fill, '#fff']]) {
      g.beginPath();
      poly.forEach(([x, y], k) => (k ? g.lineTo : g.moveTo).call(g, cx + x * sizePx, cy + y * sizePx));
      g.closePath();
      g.fillStyle = style;
      g.fill();
    }
    g.restore();
  }
}

/**
 * One cursor over one woven pair. The owner calls `draw()` after painting the pair each frame
 * (`idle()` on any frame it does not paint a woven pair), and hands it the latest grayscale copy
 * of the source when it has one; `hovering` says when that copy is worth grabbing more often.
 */
export class PairCursor {
  /** @param {HTMLElement} canvas  the tile — the pointer counts over its box */
  constructor(canvas, { height, pointerScope = 'window' } = {}) {
    this.pointer = new CursorPointer(canvas, { scope: pointerScope });
    // A fraction of the tile height when given; by default the OS arrow's size (CSS px → tile).
    this.height = height > 0 ? height : null;
    this.filter = {};
    this._luma = null;
    this._uv = null;
    this._content = null;
    this._metricsFor = null; // the tile handle whose displayMetrics() was asked for
    /** One CSS px on the panel, metres, once the tile's handle has said (else the CSS reference px). */
    this.metersPerCssPx = null;
    /** The eye separation (metres) the baseline units convert with: displayMetrics' (a default today). */
    this.eyeSeparationM = DISPLAY_METRICS_DEFAULTS.eyeSeparationM;
    /** The last frame's placement, for diagnostics: `{ contentPx, targetPx, disparityPx, filteredPx, drawn, pxPerBaseline }` (output px, + = in front) or null. */
    this.last = null;
  }

  get hovering() {
    return !!this.pointer.uv;
  }

  /**
   * Draws the arrow only while content in front of the glass is under it (the OS cursor is hidden
   * exactly then); otherwise leaves the buffer alone and the OS arrow shows, on the plane.
   * @param {CanvasRenderingContext2D} g  the woven buffer (2·outW × outH), already painted
   * @param {object|null} luma  the latest grayscale source copy (pairFootprintDisparity)
   * @param {{rL: object, rR: object, outW: number, outH: number, mirror?: boolean, handle?: object}} geo
   *        `handle` = the tile's woven handle: its `displayMetrics()` gives the panel's pixel pitch
   * @param {number} nowSec
   */
  draw(g, luma, geo, nowSec) {
    const uv = this.pointer.uv;
    if (!uv) return this.idle();
    const [u, v] = uv;
    const hf = this.height ?? this._osArrowFraction();
    // Match only when there is something new to match: a new frame copy or a moved pointer.
    if (luma !== this._luma || !this._uv || this._uv[0] !== u || this._uv[1] !== v) {
      this._content = pairFootprintDisparity(luma, geo, u, v, hf, geo.outW / geo.outH);
      this._luma = luma;
      this._uv = uv;
    }
    this._askMetrics(geo.handle);
    const r = this.pointer.canvas.getBoundingClientRect?.();
    const pxPerBaseline = pairPxPerBaseline(geo.outW, r && r.width, this.metersPerCssPx, this.eyeSeparationM);
    // The core's policy and filter, in its units (eye baselines, < 0 = in front).
    const content = this._content === null ? null : -this._content / pxPerBaseline;
    const target = cursorTarget(CURSOR_DEFAULT_TUNING, content !== null, content);
    const d = cursorFilterStep(this.filter, CURSOR_DEFAULT_TUNING, target, nowSec);
    const drawn = cursorShouldDraw(d, pxPerBaseline);
    const disparity = -d * pxPerBaseline; // output px, + = in front
    if (drawn) drawPairArrow(g, geo.outW, geo.outH, u, v, disparity, hf * geo.outH);
    this.pointer.hideCss(drawn); // the OS arrow IS the cursor on the plane
    this.last = { contentPx: this._content, targetPx: -target * pxPerBaseline || 0, disparityPx: drawn ? disparity : 0, filteredPx: disparity || 0, drawn, pxPerBaseline };
    return this.last;
  }

  /** Ask the tile's handle once for the panel's pixel pitch; until it answers, the CSS reference px. */
  _askMetrics(handle) {
    if (!handle || handle === this._metricsFor || typeof handle.displayMetrics !== 'function') return;
    this._metricsFor = handle;
    Promise.resolve()
      .then(() => handle.displayMetrics())
      .then((m) => {
        if (this._metricsFor !== handle || !m) return;
        if (m.metersPerCssPx > 0) this.metersPerCssPx = m.metersPerCssPx;
        if (m.eyeSeparationM > 0) this.eyeSeparationM = m.eyeSeparationM;
      })
      .catch(() => {});
  }

  /** The OS arrow's height as a fraction of the tile's on-page height (the core's default size). */
  _osArrowFraction() {
    const r = this.pointer.canvas.getBoundingClientRect?.();
    return r && r.height > 0 ? cursorDefaultHeight(r.height) : PAIR_CURSOR_HEIGHT;
  }

  /** Not drawing this frame (pointer away, tile not woven): the CSS cursor comes back. */
  idle() {
    this.pointer.hideCss(false);
    this.filter = {};
    this._uv = null;
    this.last = null;
    return null;
  }

  dispose() {
    this.pointer.dispose();
  }
}

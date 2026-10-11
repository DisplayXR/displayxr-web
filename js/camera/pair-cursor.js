// camera/pair-cursor.js — the depth-aware cursor on a STEREO PAIR: a call tile or a camera view.
//
// The OS cursor is drawn at zero disparity, on the glass. Over a person who sits in front of it
// (a converged stereo call puts the face AT the glass, so the shoulders, a raised hand, a cup held
// up are all in front), it is drawn on top of pixels that say they are nearer — the depth
// violation runtime ADR-046 is about. A pair has no scene to raycast and no depth buffer, but its
// two halves ARE the depth: this is ADR-046 Phase 3b done in the page. Block-match a cursor-sized
// footprint between the eyes and take the nearest confident match.
//
// The cursor only ever comes FORWARD (David, 2026-10-10): it never goes inside the display. While
// what is under it sits at or behind the glass, it is simply the OS arrow, on the screen plane.
// Only when content comes out of the screen under it is the arrow drawn into both halves, with that
// content's disparity plus a small margin (the OS cursor hidden meanwhile), so it is never overlapped
// by what pops out. It is the normal arrow either way, not a special sprite.
//
// Same filter as the scene cursor (./inline3d-cursor-depth.js): fast rise, slow sink, the plane when
// nothing matches. Disparities here are in OUTPUT pixels of one eye of the woven buffer, + = crossed
// (in front of the glass), the sign the rest of camera/ uses. Loaded only when a page asks for
// `cursor: 'depth'` — zero cost otherwise.

import { CursorPointer, cursorFootprint, cursorFilterStep, CURSOR_DEFAULT_TUNING } from '../inline3d-cursor-depth.js';
import { matchBlock, MIN_NCC } from './disparity.js';

/** The arrow's height in CSS px — the OS arrow's apparent size, so the swap to the drawn one is seamless. */
export const PAIR_CURSOR_CSS_PX = 19;
/** Arrow height as a fraction of the tile height when the tile's on-page size is unknown. */
export const PAIR_CURSOR_HEIGHT = 0.06;
/**
 * Below this far in front of the glass (metres of on-screen disparity, ~0.3 mm = 0.005 of the eye
 * baseline, the runtime's rule) the drawn arrow hands back to the OS cursor. Never under 0.5 px.
 */
export const PAIR_CURSOR_SHOW_M = 0.0003;
export const PAIR_CURSOR_SHOW_MIN_PX = 0.5;
/**
 * The standard pointer arrow, hotspot at the tip (0, 0), unit = its height, x right, y down: the
 * OS arrow's outline (a 19-px-tall Windows/macOS arrow, normalised).
 */
export const PAIR_CURSOR_ARROW = Object.freeze([
  [0, 0], [0, 16 / 19], [4.2 / 19, 12.4 / 19], [6.9 / 19, 18.6 / 19], [9.5 / 19, 17.5 / 19], [6.8 / 19, 11.5 / 19], [11.7 / 19, 11.5 / 19],
]);
/**
 * How far in front of out-of-screen content the arrow floats: 2 mm of on-screen disparity — the
 * runtime's 0.03 of the eye baseline (ADR-046 / runtime #1908), so a lifted tile's cursor and a
 * stereo tile's sit the same way. Converted to buffer px through the tile's `displayMetrics()`.
 */
export const PAIR_CURSOR_MARGIN_M = 0.002;
/** One CSS px in metres when the panel cannot say (the CSS reference pixel, 1/96 in). */
export const PAIR_CURSOR_CSS_PX_M = 0.0254 / 96;
/** Comfort cap on how far in front the arrow comes, as a fraction of the eye width. */
export const PAIR_CURSOR_CLAMP = 0.08;

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
  // The ring is centred on the arrow's body, not its tip: that is what content must not overlap.
  for (const [pu, pv] of cursorFootprint(u + (0.3 * height) / aspect, v + 0.5 * height, height, aspect)) {
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
 * The arrow's target disparity: in front of content that comes OUT of the screen (its disparity
 * plus the margin, clamped), else the glass. Never behind the glass — the cursor does not go inside
 * the display.
 * @param {number} marginPx  the margin in output px (pairCursorScale × PAIR_CURSOR_MARGIN_M)
 */
export function pairCursorTarget(contentPx, outW, marginPx) {
  if (contentPx === null || !Number.isFinite(contentPx) || !(contentPx > 0)) return 0;
  return Math.min(PAIR_CURSOR_CLAMP * outW, contentPx + marginPx);
}

/**
 * Output px of one eye per metre on the glass: the buffer eye is stretched over the tile's CSS
 * width, and one CSS px is `metersPerCssPx` on the panel.
 */
export function pairCursorScale(outW, tileCssWidth, metersPerCssPx) {
  const m = metersPerCssPx > 0 && Number.isFinite(metersPerCssPx) ? metersPerCssPx : PAIR_CURSOR_CSS_PX_M;
  return tileCssWidth > 0 ? outW / tileCssWidth / m : outW / (1000 * m);
}

/**
 * Draw the arrow into both halves of a woven buffer: the left eye's copy `disparityPx / 2` right of
 * the pointer, the right eye's as far left (crossed = in front). White with a dark outline, like the
 * OS arrow. Each copy is clipped to its own half, so an arrow at the edge never bleeds into the other eye.
 * @param {number} sizePx  arrow height in output px
 */
export function drawPairArrow(g, outW, outH, u, v, disparityPx, sizePx) {
  const cy = v * outH;
  for (const eye of [0, 1]) {
    const cx = eye * outW + u * outW + (eye === 0 ? disparityPx / 2 : -disparityPx / 2);
    g.save();
    g.beginPath();
    g.rect(eye * outW, 0, outW, outH);
    g.clip();
    g.beginPath();
    PAIR_CURSOR_ARROW.forEach(([x, y], k) => (k ? g.lineTo : g.moveTo).call(g, cx + x * sizePx, cy + y * sizePx));
    g.closePath();
    g.fillStyle = '#fff';
    g.fill();
    g.lineWidth = Math.max(1, sizePx / 19);
    g.lineJoin = 'miter';
    g.strokeStyle = '#000';
    g.stroke();
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
    /** The last frame's placement, for diagnostics: `{ contentPx, targetPx, disparityPx, drawn }` or null. */
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
    const pxPerM = pairCursorScale(geo.outW, r && r.width, this.metersPerCssPx);
    const target = pairCursorTarget(this._content, geo.outW, PAIR_CURSOR_MARGIN_M * pxPerM);
    // The shared filter rises fast toward SMALLER values (nearer, in its convention): negate.
    const disparity = -cursorFilterStep(this.filter, CURSOR_DEFAULT_TUNING, -target, nowSec);
    const drawn = disparity >= Math.max(PAIR_CURSOR_SHOW_MIN_PX, PAIR_CURSOR_SHOW_M * pxPerM);
    if (drawn) drawPairArrow(g, geo.outW, geo.outH, u, v, disparity, hf * geo.outH);
    this.pointer.hideCss(drawn); // the OS arrow IS the cursor on the plane
    this.last = { contentPx: this._content, targetPx: target, disparityPx: drawn ? disparity : 0, drawn };
    return this.last;
  }

  /** Ask the tile's handle once for the panel's pixel pitch; until it answers, the CSS reference px. */
  _askMetrics(handle) {
    if (!handle || handle === this._metricsFor || typeof handle.displayMetrics !== 'function') return;
    this._metricsFor = handle;
    Promise.resolve(handle.displayMetrics())
      .then((m) => {
        if (this._metricsFor === handle && m && m.metersPerCssPx > 0) this.metersPerCssPx = m.metersPerCssPx;
      })
      .catch(() => {});
  }

  /** The OS arrow's height as a fraction of the tile's on-page height. */
  _osArrowFraction() {
    const r = this.pointer.canvas.getBoundingClientRect?.();
    return r && r.height > 0 ? Math.min(0.5, PAIR_CURSOR_CSS_PX / r.height) : PAIR_CURSOR_HEIGHT;
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

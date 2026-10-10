// camera/pair-cursor.js — the depth-aware cursor on a STEREO PAIR: a call tile or a camera view.
//
// The OS cursor is drawn at zero disparity, on the glass. Over a person who sits in front of it
// (a converged stereo call puts the face AT the glass, so the shoulders, a raised hand, a cup held
// up are all in front), it is drawn on top of pixels that say they are nearer — the depth
// violation runtime ADR-046 is about. A pair has no scene to raycast and no depth buffer, but its
// two halves ARE the depth: this is ADR-046 Phase 3b done in the page. Block-match a cursor-sized
// footprint between the eyes, take the nearest confident match, and draw a crosshair into both
// halves with that disparity plus a small margin. The browser weaves the pair as usual, so the
// sprite lands just in front of the content under it.
//
// Same policy as the scene cursor (./inline3d-cursor-depth.js): the footprint ring, the fast-rise /
// slow-sink filter, the display plane when nothing matches. Disparities here are in OUTPUT pixels
// of one eye of the woven buffer, + = crossed (in front of the glass), the sign the rest of
// camera/ uses. Loaded only when a page asks for `cursor: 'depth'` — zero cost otherwise.

import { CursorPointer, cursorFootprint, cursorFilterStep, CURSOR_DEFAULT_TUNING, CURSOR_CROSSHAIR, CURSOR_FILL_COLOR, CURSOR_OUTLINE_COLOR } from '../inline3d-cursor-depth.js';
import { matchBlock, MIN_NCC } from './disparity.js';

/** Sprite height, as a fraction of the tile height (a call tile is small; 3% would be a speck). */
export const PAIR_CURSOR_HEIGHT = 0.06;
/** How far in front of the content the sprite floats, as a fraction of the eye width (crossed). */
export const PAIR_CURSOR_MARGIN = 0.002;
/** Comfort clamp on the sprite's disparity, as a fraction of the eye width, either way. */
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
 * @param {number} u  pointer, tile-normalised (0..1, left → right as the viewer sees it)
 * @param {number} v  pointer, tile-normalised (0..1, top → bottom)
 * @param {number} height  sprite height (fraction of the tile height)
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
  for (const [pu, pv] of cursorFootprint(u, v, height, aspect)) {
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

/** The sprite's target disparity: the content plus the margin, clamped; the glass with nothing under it. */
export function pairCursorTarget(contentPx, outW) {
  if (contentPx === null || !Number.isFinite(contentPx)) return 0;
  const lim = PAIR_CURSOR_CLAMP * outW;
  return Math.max(-lim, Math.min(lim, contentPx + PAIR_CURSOR_MARGIN * outW));
}

/**
 * Draw the crosshair into both halves of a woven buffer: the left eye's copy `disparityPx / 2`
 * right of the pointer, the right eye's as far left (crossed = in front). Each copy is clipped to
 * its own half, so a sprite at the edge never bleeds into the other eye.
 */
export function drawPairCrosshair(g, outW, outH, u, v, disparityPx, height) {
  const size = height * outH;
  const cy = v * outH;
  const rgba = (c) => `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${c[3]})`;
  for (const eye of [0, 1]) {
    const cx = eye * outW + u * outW + (eye === 0 ? disparityPx / 2 : -disparityPx / 2);
    g.save();
    g.beginPath();
    g.rect(eye * outW, 0, outW, outH);
    g.clip();
    for (const [width, color, cap] of [
      [0.15, CURSOR_OUTLINE_COLOR, 'square'],
      [0.07, CURSOR_FILL_COLOR, 'butt'],
    ]) {
      g.lineWidth = width * size;
      g.lineCap = cap;
      g.strokeStyle = rgba(color);
      g.beginPath();
      for (const [x0, y0, x1, y1] of CURSOR_CROSSHAIR) {
        g.moveTo(cx + x0 * size, cy + y0 * size);
        g.lineTo(cx + x1 * size, cy + y1 * size);
      }
      g.stroke();
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
    this.height = height > 0 ? height : PAIR_CURSOR_HEIGHT;
    this.filter = {};
    this._luma = null;
    this._uv = null;
    this._content = null;
    /** The last frame's placement, for diagnostics: `{ contentPx, targetPx, disparityPx }` or null. */
    this.last = null;
  }

  get hovering() {
    return !!this.pointer.uv;
  }

  /**
   * @param {CanvasRenderingContext2D} g  the woven buffer (2·outW × outH), already painted
   * @param {object|null} luma  the latest grayscale source copy (pairFootprintDisparity)
   * @param {{rL: object, rR: object, outW: number, outH: number, mirror?: boolean}} geo
   * @param {number} nowSec
   */
  draw(g, luma, geo, nowSec) {
    const uv = this.pointer.uv;
    if (!uv) return this.idle();
    const [u, v] = uv;
    // Match only when there is something new to match: a new frame copy or a moved pointer.
    if (luma !== this._luma || !this._uv || this._uv[0] !== u || this._uv[1] !== v) {
      this._content = pairFootprintDisparity(luma, geo, u, v, this.height, geo.outW / geo.outH);
      this._luma = luma;
      this._uv = uv;
    }
    const target = pairCursorTarget(this._content, geo.outW);
    // The shared filter rises fast toward SMALLER values (nearer, in its convention): negate.
    const disparity = -cursorFilterStep(this.filter, CURSOR_DEFAULT_TUNING, -target, nowSec);
    drawPairCrosshair(g, geo.outW, geo.outH, u, v, disparity, this.height);
    this.pointer.hideCss(true);
    this.last = { contentPx: this._content, targetPx: target, disparityPx: disparity };
    return this.last;
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

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
//    (0.015 eye baselines, ~1 mm) in front of that content (cursorTarget);
//  - on the plane it IS the OS cursor: the arrow is drawn into both halves only while the filtered
//    disparity is past the draw threshold (-0.005 baselines, and >= 0.5 px; cursorShouldDraw), the
//    OS cursor hidden exactly then;
//  - the same filter (fast rise, slow sink) and the same arrow (CURSOR_ARROW, tip = hotspot, the
//    OS arrow's 19 CSS px);
//  - the same crosstalk softening (Amendment 2 §B.7, cursorSoften): a lifted arrow is blurred by
//    0.1 × its ghost offset (here: its disparity, the two halves being the two views) and faded
//    toward 0.5, both zero on the glass. Rasterised into the buffer from the core's 13-tap kernel
//    (cursorSoftArrowRaster) — inside the woven pixels, never a CSS filter or CSS opacity.
// What is specific to a pair: it has no 3D views, so it works in tile PIXEL disparity — OUTPUT
// pixels of one eye of the woven buffer, + = crossed (in front of the glass), the sign the rest of
// camera/ uses — and converts to the core's eye-baseline units through the panel's pixel pitch:
// buffer px per metre = outW / tileCssWidth / metersPerCssPx (the tile handle's displayMetrics()),
// times the eye separation (displayMetrics' default, 63 mm). Loaded only when a page asks for
// `cursor: 'depth'` — zero cost otherwise.
//
// Where the browser and the runtime draw the web cursor (runtime ADR-046 Amendment 4: the tile's
// layer answers getCursorDepthSupport() "runtime"), nothing is drawn into the buffer: the matched
// content disparity goes to the layer RAW, in device px (−contentPx × device px per output px), and
// the runtime draws the browser's own cursor with the one policy. Elsewhere: the arrow, as above.

import {
  CursorPointer,
  CursorRuntimeLink,
  CursorShapeSelector,
  cursorArrowFootprint,
  cursorShapePolys,
  cursorShapeRaster,
  cursorSoftenPixels,
  drawCursorShape2D,
  cursorDefaultHeight,
  cursorFilterStep,
  cursorShouldDraw,
  cursorSoften,
  cursorTarget,
  resolveCursorSoften,
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
  const swp = swappedHalves(luma);
  const found = []; // { d, x, y, eye }: a consistent match and WHERE it was taken
  const seen = new Set();
  const sample = (su, pv) => {
    const y = Math.round((rL.sy + pv * rL.sh) * scale - b / 2);
    if (y < 0 || y + b > h) return;
    const xl = Math.round((rL.sx + su * rL.sw) * scale - b / 2);
    const xr = Math.round((rR.sx + su * rR.sw) * scale - b / 2);
    // The arrow is far smaller than a block (~6 vs 12 copy px at the OS arrow's size), so
    // neighbouring footprint points land on the SAME block: match each block once.
    if (!seen.has(`L${xl},${y}`)) {
      seen.add(`L${xl},${y}`);
      const dl = consistentMatch(img, swp, w, h, xl, y, b, dMin, dMax);
      if (dl !== null) found.push({ d: dl, x: xl, y, eye: 0 });
    }
    if (!seen.has(`R${xr},${y}`)) {
      seen.add(`R${xr},${y}`);
      const dr = consistentMatch(swp, img, w, h, xr, y, b, -dMax, -dMin); // right-anchored: d' = -d
      if (dr !== null) found.push({ d: -dr, x: xr, y, eye: 1 });
    }
  };
  // The tip, then a ring centred on the arrow's body: that is what content must not overlap. Each
  // point is sampled from BOTH eyes' images (the pointer's spot in the left eye matched into the
  // right, and the same spot in the right eye matched into the left), so neither eye is favoured:
  // at a foreground edge one eye's block can sit on the subject and the other's on the background.
  // Every match must also pass the left-right consistency check (consistentMatch).
  let cu = 0, cv = 0, n = 0;
  for (const [pu, pv] of cursorArrowFootprint(u, v, height, aspect)) {
    if (!(pu >= 0 && pu <= 1 && pv >= 0 && pv <= 1)) continue;
    sample(geo.mirror ? 1 - pu : pu, pv);
    cu += pu; cv += pv; n++;
  }
  if (!n) return null;
  // ...plus four blocks half a block around the footprint's centre, so that real content under
  // the arrow is seen by more than one distinct block (pairNearestSupported needs that).
  const du = (b / 2 / scale) / rL.sw, dv = (b / 2 / scale) / rL.sh;
  for (const [ou, ov] of [[-du, 0], [du, 0], [0, -dv], [0, dv]]) {
    const pu = cu / n + ou, pv = cv / n + ov;
    if (pu >= 0 && pu <= 1 && pv >= 0 && pv <= 1) sample(geo.mirror ? 1 - pu : pu, pv);
  }
  // Source disparity → displayed: each eye's crop moved its half by its own offset.
  for (const f of found) f.d = (f.d / scale - (rL.sx - rR.sx)) * k;
  return pairNearestSupported(found, (PAIR_SUPPORT_COPY_PX / scale) * k, b / 2);
}

/**
 * Two consistent footprint matches must agree (within this many px of the grayscale copy) before
 * the nearest is believed: content that comes out of the screen covers several blocks, a lone
 * block claiming something nearer than the rest is noise.
 */
export const PAIR_SUPPORT_COPY_PX = 1.5;

/** The SBS copy with its halves swapped (cached per copy): matching it is matching right → left. */
const _swapped = new WeakMap();
function swappedHalves(luma) {
  let s = _swapped.get(luma);
  if (s) return s;
  const { img, w, h } = luma;
  const E = w / 2;
  s = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < E; x++) {
      s[o + x] = img[o + E + x];
      s[o + E + x] = img[o + x];
    }
  }
  _swapped.set(luma, s);
  return s;
}

/**
 * A block of image A's left half matched into its right half, kept only if the matched block,
 * matched BACK (in B = A with its halves swapped), lands within 1 px of where it started — the
 * classic left-right consistency check. A block straddling a depth edge (half subject, half
 * background, each eye seeing a different half) fails it instead of returning a random depth.
 * @returns {number|null} disparity in A's convention (left x − right x), copy px
 */
export function consistentMatch(A, B, w, h, x, y, b, dMin, dMax) {
  const E = w / 2;
  if (x < 0 || x + b > E) return null;
  const m = matchBlock(A, w, h, x, y, b, b, { dMin, dMax, dyMax: 2 });
  if (!m || m.c < MIN_NCC) return null;
  const xb = Math.round(x - m.d);
  const yb = y + m.dy;
  if (xb < 0 || xb + b > E || yb < 0 || yb + b > h) return null;
  const back = matchBlock(B, w, h, xb, yb, b, b, { dMin: -Math.ceil(m.d) - 2, dMax: -Math.floor(m.d) + 2, dyMax: 1 });
  if (!back || back.c < MIN_NCC || Math.abs(-back.d - m.d) > 1) return null;
  return m.d;
}

/**
 * The nearest disparity that an INDEPENDENT second sample corroborates (within `tol`), else null.
 * Independent = taken from the other eye's image, or from a block at least `minSep` copy px away:
 * two footprint points inside one block are one witness, not two. (A block straddling a face edge
 * and a bright window matched at a bogus +49 px, consistently, and its twin counted as support.)
 * @param {Array<{d:number, x?:number, y?:number, eye?:number}|number>} samples  output px, + = in front
 * @returns {number|null}
 */
export function pairNearestSupported(samples, tol, minSep = 0) {
  const S = samples.map((s) => (typeof s === 'number' ? { d: s, x: 0, y: 0, eye: -1 } : s));
  if (S.length < 2) return null;
  const sorted = [...S].sort((p, q) => q.d - p.d); // nearest first
  const independent = (p, q) => p.eye === -1 || p.eye !== q.eye || Math.abs(p.x - q.x) + Math.abs(p.y - q.y) >= minSep;
  for (const p of sorted) {
    for (const q of sorted) {
      if (q !== p && Math.abs(p.d - q.d) <= tol && independent(p, q)) return p.d;
    }
  }
  return null;
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
 * of the screen by the margin (0.015 baselines), else the glass — never behind it.
 */
export function pairCursorTarget(contentPx, pxPerBaseline, tuning = CURSOR_DEFAULT_TUNING) {
  if (contentPx === null || !Number.isFinite(contentPx) || !(pxPerBaseline > 0)) return 0;
  return -cursorTarget(tuning, true, -contentPx / pxPerBaseline) * pxPerBaseline || 0;
}

/** The shape's outline + fill inset by one output px (at least 1/19 of its height), cached per size. */
const _polysBySize = new Map();
function shapePolys(name, sizePx) {
  const d = sizePx > 0 ? Math.max(1 / 19, 1 / sizePx) : 1 / 19;
  const key = `${name}:${Math.round(d * 1e4)}`;
  let f = _polysBySize.get(key);
  if (!f) {
    if (_polysBySize.size > 64) _polysBySize.clear();
    _polysBySize.set(key, (f = cursorShapePolys(name, d)));
  }
  return f;
}

/**
 * Draw the cursor into both halves of a woven buffer: the left eye's copy `disparityPx / 2` right of
 * the pointer, the right eye's as far left (crossed = in front). The shared sprite (the arrow by
 * default, or `shape`): its dark outline, then the white fill inset by a px; the hotspot on the
 * pointer. Each copy is clipped to its own half, so a sprite at the edge never bleeds into the
 * other eye.
 * @param {number} sizePx  sprite height (one arrow height) in output px
 * @param {string} [shape='arrow']  a CURSOR_SHAPES name
 */
export function drawPairArrow(g, outW, outH, u, v, disparityPx, sizePx, shape = 'arrow') {
  const cy = v * outH;
  const polys = shapePolys(shape, sizePx);
  for (const eye of [0, 1]) {
    const cx = eye * outW + u * outW + (eye === 0 ? disparityPx / 2 : -disparityPx / 2);
    g.save();
    g.beginPath();
    g.rect(eye * outW, 0, outW, outH);
    g.clip();
    drawCursorShape2D(g, shape, cx, cy, sizePx, polys);
    g.restore();
  }
}

// A scratch 2D canvas for the softened arrow (drawImage blends and honours the clip; putImageData
// would do neither). Null where no canvas can be made — then the crisp arrow is drawn.
let _scratch = null;
function scratchCanvas(w, h) {
  if (!_scratch || (typeof OffscreenCanvas === 'function' && !(_scratch instanceof OffscreenCanvas))) {
    try {
      if (typeof OffscreenCanvas === 'function') _scratch = new OffscreenCanvas(1, 1);
      else if (globalThis.document && document.createElement) _scratch = document.createElement('canvas');
    } catch {
      _scratch = null;
    }
  }
  if (!_scratch || typeof _scratch.getContext !== 'function') return null;
  if (_scratch.width < w) _scratch.width = w;
  if (_scratch.height < h) _scratch.height = h;
  return _scratch.getContext('2d');
}

/**
 * The SOFTENED arrow into both halves (ADR-046 Amendment 2 §B.7): as drawPairArrow — same
 * placement, same tip, same clip to each half — but rasterised from the core's 13-tap blur of the
 * arrow with `radius` (arrow heights) and `alpha` (opacity). Returns false (nothing drawn) when no
 * scratch canvas is available, so the caller can fall back to the crisp arrow.
 */
export function drawPairArrowSoft(g, outW, outH, u, v, disparityPx, sizePx, radius, alpha, shape = 'arrow') {
  const cy = v * outH;
  const polys = shapePolys(shape, sizePx);
  const rasters = [0, 1].map((eye) => {
    const cx = eye * outW + u * outW + (eye === 0 ? disparityPx / 2 : -disparityPx / 2);
    return cursorShapeRaster(shape, cx, cy, sizePx, radius, alpha, [1, 1, 1, 1], [0, 0, 0, 1], polys);
  });
  const sg = scratchCanvas(Math.max(rasters[0].width, rasters[1].width), Math.max(rasters[0].height, rasters[1].height));
  if (!sg || typeof sg.putImageData !== 'function' || typeof ImageData !== 'function') return false;
  for (const eye of [0, 1]) {
    const r = rasters[eye];
    sg.putImageData(new ImageData(r.data, r.width, r.height), 0, 0);
    g.save();
    g.beginPath();
    g.rect(eye * outW, 0, outW, outH);
    g.clip();
    g.drawImage(sg.canvas, 0, 0, r.width, r.height, r.x0, r.y0, r.width, r.height);
    g.restore();
  }
  return true;
}

/**
 * A url() image cursor into both halves: at its CSS size (one sprite unit = `sizePx` output px per
 * 19 CSS px), its hotspot on the pointer, softened in the PIXELS (cursorSoftenPixels: `radiusPx`
 * blur, `alpha` opacity) — never a CSS filter or opacity. Returns false when no scratch canvas.
 */
export function drawPairImage(g, outW, outH, u, v, disparityPx, sizePx, sprite, radiusPx, alpha) {
  const k = sizePx / 19; // output px per CSS px
  const w = Math.max(1, Math.round(sprite.width * k)), h = Math.max(1, Math.round(sprite.height * k));
  const sg = scratchCanvas(w + 2 * (Math.ceil(radiusPx) + 2), h + 2 * (Math.ceil(radiusPx) + 2));
  if (!sg || typeof sg.getImageData !== 'function' || typeof ImageData !== 'function') return false;
  sg.clearRect(0, 0, sg.canvas.width, sg.canvas.height);
  sg.drawImage(sprite.entry.image, 0, 0, w, h);
  const soft = cursorSoftenPixels(sg.getImageData(0, 0, w, h).data, w, h, radiusPx, alpha);
  sg.clearRect(0, 0, sg.canvas.width, sg.canvas.height);
  sg.putImageData(new ImageData(soft.data, soft.width, soft.height), 0, 0);
  const cy = v * outH - sprite.hotspot[1] * k - soft.pad;
  for (const eye of [0, 1]) {
    const cx = eye * outW + u * outW + (eye === 0 ? disparityPx / 2 : -disparityPx / 2) - sprite.hotspot[0] * k - soft.pad;
    g.save();
    g.beginPath();
    g.rect(eye * outW, 0, outW, outH);
    g.clip();
    g.drawImage(sg.canvas, 0, 0, soft.width, soft.height, Math.round(cx), Math.round(cy), soft.width, soft.height);
    g.restore();
  }
  return true;
}

/**
 * One cursor over one woven pair. The owner calls `draw()` after painting the pair each frame
 * (`idle()` on any frame it does not paint a woven pair), and hands it the latest grayscale copy
 * of the source when it has one; `hovering` says when that copy is worth grabbing more often.
 */
export class PairCursor {
  /** @param {HTMLElement} canvas  the tile — the pointer counts over its box */
  constructor(canvas, { height, pointerScope = 'window', soften, shape = 'auto', shapeFor = null } = {}) {
    this.pointer = new CursorPointer(canvas, { scope: pointerScope });
    /** Which sprite (CSS mirror / fixed / shapeFor); `.current` = the one drawn last. */
    this.shapes = new CursorShapeSelector(this.pointer, { shape, shapeFor });
    /** Crosstalk softening parameters (resolveCursorSoften). */
    this.soften = resolveCursorSoften(soften, '@displayxr/inline3d pair cursor');
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
    /** The last frame's placement, for diagnostics: `{ contentPx, targetPx, disparityPx, filteredPx, drawn, pxPerBaseline, soften }` (output px, + = in front) or null. */
    this.last = null;
    /** The runtime-drawn cursor (ADR-046 Amendment 4), bound to the tile's handle each frame. */
    this.runtime = new CursorRuntimeLink();
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
    const runtime = this.runtime.bind(geo && geo.handle);
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
    const r = this.pointer.canvas.getBoundingClientRect?.();
    if (runtime) return this._drawRuntime(u, v, r, geo);
    this.runtime.withdraw();
    this._askMetrics(geo.handle);
    const pxPerBaseline = pairPxPerBaseline(geo.outW, r && r.width, this.metersPerCssPx, this.eyeSeparationM);
    // The core's policy and filter, in its units (eye baselines, < 0 = in front).
    const content = this._content === null ? null : -this._content / pxPerBaseline;
    const target = cursorTarget(CURSOR_DEFAULT_TUNING, content !== null, content);
    const d = cursorFilterStep(this.filter, CURSOR_DEFAULT_TUNING, target, nowSec);
    const drawn = cursorShouldDraw(d, pxPerBaseline);
    const disparity = -d * pxPerBaseline; // output px, + = in front
    let soften = null;
    let shape = null;
    if (drawn) {
      // Softening in PANEL px: one output px of an eye spans (tile CSS width × dpr) / outW of them.
      // The ghost offset of a pair IS its disparity (the two halves are the two views).
      const sizePx = hf * geo.outH;
      const dpr = globalThis.devicePixelRatio > 0 ? globalThis.devicePixelRatio : 1;
      const k = r && r.width > 0 ? (r.width * dpr) / geo.outW : 1;
      const spritePx = r && r.height > 0 ? hf * r.height * dpr : sizePx;
      const s = cursorSoften(d, disparity * k, spritePx, this.soften);
      const sprite = this.shapes.pick({ u, v, point: null }, nowSec * 1000);
      shape = this.shapes.current;
      soften = { blurPx: s.blurPx, alpha: s.alpha, ghostPx: Math.abs(disparity * k), spritePx, radius: spritePx > 0 ? s.blurPx / spritePx : 0, soft: s.blurPx > 0 || s.alpha < 1 };
      if (sprite.kind === 'image') {
        drawPairImage(g, geo.outW, geo.outH, u, v, disparity, sizePx, sprite, soften.soft ? soften.radius * sizePx : 0, soften.soft ? s.alpha : 1);
      } else if (sprite.kind === 'shape' && (!soften.soft || !drawPairArrowSoft(g, geo.outW, geo.outH, u, v, disparity, sizePx, soften.radius, s.alpha, shape))) {
        drawPairArrow(g, geo.outW, geo.outH, u, v, disparity, sizePx, shape);
      } // 'none': the page hides its cursor; draw nothing (the OS cursor stays hidden)
    }
    this.pointer.hideCss(drawn); // the OS arrow IS the cursor on the plane
    this.last = { contentPx: this._content, targetPx: -target * pxPerBaseline || 0, disparityPx: drawn ? disparity : 0, filteredPx: disparity || 0, drawn, pxPerBaseline, soften, shape };
    return this.last;
  }

  // The runtime draws (ADR-046 Amendment 4): the matched content disparity, RAW, in device px
  // between the two views (the two halves), < 0 crossed: one output px of an eye spans
  // (tile CSS width × dpr) / outW device px. Nothing drawn into the buffer, the CSS cursor alone.
  _drawRuntime(u, v, r, geo) {
    this.pointer.hideCss(false);
    this.filter = {};
    const dpr = globalThis.devicePixelRatio > 0 ? globalThis.devicePixelRatio : 1;
    const k = r && r.width > 0 && geo.outW > 0 ? (r.width * dpr) / geo.outW : null;
    const px = this._content === null || k === null ? null : -this._content * k;
    this.runtime.report(u, v, px);
    this.last = { contentPx: this._content, targetPx: 0, disparityPx: 0, filteredPx: 0, drawn: false, runtime: true, runtimeDisparityPx: px, pxPerBaseline: null, soften: null, shape: null };
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
    this.runtime.withdraw();
    this.pointer.hideCss(false);
    this.filter = {};
    this._uv = null;
    this.last = null;
    return null;
  }

  dispose() {
    this.runtime.dispose();
    this.pointer.dispose();
    this.shapes.dispose();
  }
}

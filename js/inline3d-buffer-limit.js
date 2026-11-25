// inline3d-buffer-limit.js — keep a woven canvas's backing store inside the device's GL limits.
//
// Internal to the SDK (core, ./viewer, ./splat on both engines, ./model on both engines), except
// sceneBufferSize(), which the core re-exports. Renderer-free and dependency-free.
//
// WHY (measured, an Android 3D tablet on Adreno 740, DisplayXR Browser 154): a full-screen SBS
// canvas asked for 5120×1348 (2560 per eye) with renderScale 1. The browser reports
// MAX_TEXTURE_SIZE 4096 there (Chromium's `webgl_or_caps_max_texture_size_limit_4096` driver
// workaround) and SILENTLY clamps the WebGL drawing buffer to 4096×1348, while `canvas.width` still
// reads 5120. `XRDisplayLayer.getViewport()` splits `canvas.width` (the attribute), so each eye was
// drawn 2560 wide into a 4096-wide buffer: the eye boundary landed at 62.5% of the buffer while the
// weave splits it at 50%, and the panel showed a large double image. Nothing was logged. Windows
// and Linux report 16384, so the same page was fine there.
//
// Two layers of defence, both here:
//   1. clampEyeBuffer(): shrink the requested per-eye size, UNIFORMLY (the eye aspect is kept), so
//      that the whole store (cols × eyeW by rows × eyeH) fits min(MAX_TEXTURE_SIZE,
//      MAX_RENDERBUFFER_SIZE, MAX_VIEWPORT_DIMS). The browser then never has to clamp.
//   2. bufferScale(): if the drawing buffer STILL differs from canvas.width/height after a resize
//      (a clamp we did not predict), the caller maps the layer's canvas-space viewports onto the
//      real drawing buffer with these factors — never canvas.width / 2.

/**
 * The browser's cap on a WebGL drawing buffer's AREA, separate from the per-axis GL limits:
 * Chromium's `WebGLRenderingContextBase::Reshape` (`kMaxArea = 5760 * 5760`, "resolution of an
 * 8K monitor"), the same on every platform. Past it the drawing buffer is scaled by
 * sqrt(kMaxArea / area), aspect kept, while `canvas.width` keeps the requested value. MEASURED on
 * an 8K panel at 300% (DisplayXR Browser 1.10.6 / Chromium 158): 15360×4320 drew at 10861×3054.
 */
export const MAX_DRAWING_BUFFER_AREA = 5760 * 5760;

/** @typedef {{ maxW: number, maxH: number, nameW: string, nameH: string, valueW: number, valueH: number }} BufferLimits */

const cache = new WeakMap(); // gl context → BufferLimits
let probed; // undefined = not tried; null = no WebGL available; else BufferLimits

/** Smallest of the named candidates, with its name (the first one wins a tie). */
function smallest(cands) {
  let best = null;
  for (const [name, v] of cands) {
    if (!(v > 0)) continue;
    if (!best || v < best[1]) best = [name, v];
  }
  return best;
}

/**
 * The largest backing store this GL context can hold and render into, queried once per context
 * and cached. Returns null for anything that is not a GL context (or a context lost mid-query).
 *
 * @param {WebGLRenderingContext|WebGL2RenderingContext|null|undefined} gl
 * @returns {BufferLimits|null}
 */
export function glBufferLimits(gl) {
  if (!gl || typeof gl.getParameter !== 'function') return null;
  const hit = cache.get(gl);
  if (hit) return hit;
  let tex, rb, vp;
  try {
    tex = gl.getParameter(gl.MAX_TEXTURE_SIZE ?? 0x0d33);
    rb = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE ?? 0x84e8);
    vp = gl.getParameter(gl.MAX_VIEWPORT_DIMS ?? 0x0d3a);
  } catch {
    return null;
  }
  const vpW = vp && vp.length >= 2 ? vp[0] : 0;
  const vpH = vp && vp.length >= 2 ? vp[1] : 0;
  const w = smallest([['MAX_TEXTURE_SIZE', tex], ['MAX_RENDERBUFFER_SIZE', rb], ['MAX_VIEWPORT_DIMS', vpW]]);
  const h = smallest([['MAX_TEXTURE_SIZE', tex], ['MAX_RENDERBUFFER_SIZE', rb], ['MAX_VIEWPORT_DIMS', vpH]]);
  if (!w || !h) return null; // a lost context answers 0/null — don't cache a non-answer
  const lim = { maxW: w[1], maxH: h[1], nameW: w[0], nameH: h[0], valueW: w[1], valueH: h[1] };
  cache.set(gl, lim);
  return lim;
}

/**
 * The limits of a throwaway WebGL context, for callers without one of their own yet: the core's
 * image/video windows (2D canvases, which the weave still has to take as a GPU texture) and the
 * PlayCanvas viewer before its engine has booted. Probed once per document, then the context is
 * released. Null where there is no DOM or no WebGL (tests, workers, a GPU-less browser): no
 * clamp is applied then.
 *
 * @returns {BufferLimits|null}
 */
export function probeBufferLimits() {
  if (probed !== undefined) return probed;
  probed = null;
  try {
    if (typeof document === 'undefined' || !document || typeof document.createElement !== 'function') return probed;
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return probed;
    probed = glBufferLimits(gl);
    gl.getExtension?.('WEBGL_lose_context')?.loseContext?.();
  } catch {
    probed = null;
  }
  return probed;
}

/** Tests only: forget the probed document limits. */
export function _resetProbedLimits() {
  probed = undefined;
}

/**
 * Fit a requested per-eye size into the device's limits. The store is `cols × eyeW` by
 * `rows × eyeH` (SBS: cols 2, rows 1; mono: cols 1). Both axes shrink by ONE factor, so the eye
 * keeps its aspect; the result is floored so it can never round back over the limit.
 *
 * @param {number} eyeW  requested per-eye width, buffer px
 * @param {number} eyeH  requested per-eye height, buffer px
 * @param {BufferLimits|null} limits
 * @param {{ cols?: number, rows?: number }} [layout]
 * @returns {{ eyeW: number, eyeH: number, scale: number, clamped: boolean,
 *             reqW: number, reqH: number, bufW: number, bufH: number,
 *             limitName: string, limitValue: number }}
 */
export function clampEyeBuffer(eyeW, eyeH, limits, { cols = 2, rows = 1 } = {}) {
  const reqW = eyeW * cols;
  const reqH = eyeH * rows;
  const base = { eyeW, eyeH, cols, scale: 1, clamped: false, reqW, reqH, bufW: reqW, bufH: reqH, limitName: '', limitValue: 0 };
  if (!limits || !(eyeW > 0) || !(eyeH > 0)) return base;
  const sw = limits.maxW / reqW;
  const sh = limits.maxH / reqH;
  const maxArea = limits.maxArea > 0 ? limits.maxArea : MAX_DRAWING_BUFFER_AREA;
  const sa = Math.sqrt(maxArea / (reqW * reqH));
  const s = Math.min(sw, sh, sa);
  if (!(s < 1)) return base;
  const byArea = sa < Math.min(sw, sh);
  const byW = sw <= sh;
  // Floor (never round up past the limit), and never above the per-axis cap either way.
  const w = Math.max(1, Math.min(Math.floor(eyeW * s + 1e-9), Math.floor(limits.maxW / cols)));
  const h = Math.max(1, Math.min(Math.floor(eyeH * s + 1e-9), Math.floor(limits.maxH / rows)));
  return {
    eyeW: w,
    eyeH: h,
    cols,
    scale: s,
    clamped: true,
    reqW,
    reqH,
    bufW: w * cols,
    bufH: h * rows,
    limitName: byArea ? 'the browser drawing-buffer area cap' : byW ? limits.nameW : limits.nameH,
    limitValue: byArea ? maxArea : byW ? limits.valueW : limits.valueH,
  };
}

/** Round a scale for a human-readable warning: 0.8, 0.625, never 0.8000000001. */
export function roundScale(s) {
  return Math.round(s * 1000) / 1000;
}

/**
 * The one warning text, so every path names the same things: the store it wanted, the limit, what
 * it rendered at, and (where there is one) the renderScale request vs the effective value.
 */
export function clampWarning(tag, c, requestedScale) {
  const rs =
    typeof requestedScale === 'number'
      ? ` (renderScale ${roundScale(requestedScale)} → ${roundScale(requestedScale * c.scale)})`
      : ` (scale ${roundScale(c.scale)})`;
  return (
    `${tag} ${c.cols === 1 ? 'buffer' : 'SBS buffer'} ${c.reqW}×${c.reqH} exceeds ${c.limitName} ${c.limitValue} on this device; ` +
    `rendering at ${c.bufW}×${c.bufH}${rs}.`
  );
}

/**
 * How the layer's viewports (canvas-attribute space: XRDisplayLayer.getViewport() splits
 * `canvas.width`) map onto the drawing buffer the GL context really has. {1, 1, false} whenever
 * the two agree, which is every case the clamp above predicted.
 *
 * @param {{ width: number, height: number }} canvas
 * @param {object|null} gl  a WebGL context, or null (a 2D canvas: no separate drawing buffer)
 */
export function bufferScale(canvas, gl) {
  const cw = canvas?.width || 0;
  const ch = canvas?.height || 0;
  const dw = gl && gl.drawingBufferWidth > 0 ? gl.drawingBufferWidth : cw;
  const dh = gl && gl.drawingBufferHeight > 0 ? gl.drawingBufferHeight : ch;
  const sx = cw > 0 ? dw / cw : 1;
  const sy = ch > 0 ? dh / ch : 1;
  return { sx, sy, w: dw, h: dh, mismatch: sx !== 1 || sy !== 1 };
}

/** Scale one {x, y, width, height} viewport by bufferScale()'s factors (identity returns it as is). */
export function scaleViewport(vp, sx, sy) {
  if (sx === 1 && sy === 1) return vp;
  return {
    x: Math.round(vp.x * sx),
    y: Math.round(vp.y * sy),
    width: Math.max(1, Math.round(vp.width * sx)),
    height: Math.max(1, Math.round(vp.height * sy)),
  };
}

/** The warning for a drawing buffer the clamp did not predict. `tail` says what happens next. */
export function mismatchWarning(
  tag,
  canvas,
  b,
  tail = 'laying the eyes out from the drawing buffer. Lower renderScale to stay inside the device limit.',
) {
  return (
    `${tag} the browser clamped this canvas's drawing buffer to ${b.w}×${b.h} (canvas.width/height ` +
    `say ${canvas.width}×${canvas.height}); ${tail}`
  );
}

const warnedScene = typeof WeakSet === 'function' ? new WeakSet() : null;

/**
 * PUBLIC (re-exported by the core as `sceneBufferSize`): the backing store an `addScene` page
 * should give its canvas. The SDK sizes every canvas it owns this way; a scene canvas is the
 * page's to size, and hand-rolled `clientWidth × devicePixelRatio × 2` goes wrong on big panels:
 *
 *   - devicePixelRatio is NOT capped there. An 8K desktop at 300% scaling is dpr 3, so a
 *     full-window SBS store is 15360×4320 (66 Mpx, plus MSAA) — 8× a tablet's, for detail the
 *     weave cannot show (each eye gets a fraction of the panel's pixels anyway).
 *   - Nothing keeps the store inside the GL limits. Past them the browser SILENTLY shrinks the
 *     drawing buffer while `canvas.width` keeps the requested value, `getViewport()` keeps
 *     splitting `canvas.width`, and the eye boundary lands off-centre: a double image.
 *
 * Per eye it is the native runtime's rule, `window device px × recommendedViewScale`, when the
 * page passes `viewScale` (the `getDisplayInfo()` result, or `{x, y}` / `[x, y]`): the weave can
 * only show that many pixels per view, so more is fill rate spent on nothing. Without it (no
 * display info yet, a plain browser) it is the CSS box × devicePixelRatio capped at
 * `maxPixelRatio` (default 2, as the SDK's own windows). Then `renderScale`, then both axes
 * shrink by one factor to fit min(MAX_TEXTURE_SIZE, MAX_RENDERBUFFER_SIZE, MAX_VIEWPORT_DIMS) —
 * warned once per canvas, never thrown.
 *
 * @param {{ clientWidth?: number, clientHeight?: number }} canvas
 * @param {{ sbs?: boolean, renderScale?: number, maxPixelRatio?: number, gl?: object|null,
 *           viewScale?: object|number[]|null, cssWidth?: number, cssHeight?: number }} [opts]
 * @returns {{ width: number, height: number, eyeWidth: number, eyeHeight: number,
 *             pixelRatio: number, viewScale: [number, number]|null, scale: number,
 *             clamped: boolean, limit: string|null }}
 */
export function sceneBufferSize(canvas, opts = {}) {
  const { sbs = true, renderScale = 1, maxPixelRatio = 2, gl = null } = opts;
  const rawDpr = (typeof window !== 'undefined' && window && window.devicePixelRatio) || 1;
  const cap = Number.isFinite(maxPixelRatio) && maxPixelRatio > 0 ? maxPixelRatio : 2;
  // The view scale is the 3D mode's (half width per eye on a Leia panel); the mono store is the 2D
  // mode, which shows the full window, so a view scale never applies to it.
  const vs = sbs ? readViewScale(opts.viewScale) : null;
  // With a view scale the base is the window's DEVICE px (the native rule); without, the capped dpr.
  const pixelRatio = vs ? rawDpr : Math.min(rawDpr, cap);
  const rs = Number.isFinite(renderScale) && renderScale > 0 ? renderScale : 1;
  const cssW = Number.isFinite(opts.cssWidth) ? opts.cssWidth : canvas?.clientWidth || 0;
  const cssH = Number.isFinite(opts.cssHeight) ? opts.cssHeight : canvas?.clientHeight || 0;
  const eyeW = Math.max(1, Math.round((cssW || 1) * pixelRatio * (vs ? vs[0] : 1) * rs));
  const eyeH = Math.max(1, Math.round((cssH || 1) * pixelRatio * (vs ? vs[1] : 1) * rs));
  const limits = (gl && glBufferLimits(gl)) || probeBufferLimits();
  const c = clampEyeBuffer(eyeW, eyeH, limits, { cols: sbs ? 2 : 1 });
  if (c.clamped && canvas && typeof canvas === 'object' && warnedScene && !warnedScene.has(canvas)) {
    warnedScene.add(canvas);
    try {
      console.warn(clampWarning('[inline3d] sceneBufferSize:', c, rs));
    } catch {
      /* no console */
    }
  }
  return {
    width: c.bufW,
    height: c.bufH,
    eyeWidth: c.eyeW,
    eyeHeight: c.eyeH,
    pixelRatio,
    viewScale: vs,
    scale: rs * c.scale,
    clamped: c.clamped,
    limit: c.clamped ? `${c.limitName} ${c.limitValue}` : null,
  };
}

/** `getDisplayInfo()`'s recommendedViewScaleX/Y, `{x, y}` or `[x, y]` → [sx, sy] in (0, 1], or null. */
function readViewScale(v) {
  if (!v) return null;
  let x, y;
  if (Array.isArray(v)) [x, y] = v;
  else if (typeof v === 'object') {
    x = v.recommendedViewScaleX ?? v.viewScaleX ?? v.x;
    y = v.recommendedViewScaleY ?? v.viewScaleY ?? v.y;
  }
  const ok = (n) => Number.isFinite(n) && n > 0 && n <= 1;
  return ok(x) && ok(y) ? [x, y] : null;
}

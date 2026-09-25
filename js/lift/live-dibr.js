// @displayxr/inline3d — live DIBR ("Convert to 3D", lift): render a 2D frame + a low-res
// relative-disparity map as N per-view depth-image-based renderings, one per SDK view, straight
// into `layer.getViewport(view)`. WebGL2, dependency-free.
//
//   const dibr = createLiveDibr({ canvas });          // canvas = the addScene canvas
//   dibr.setSource(video);
//   depthWorker.onmessage = (e) => dibr.setDepth({ data: e.data, w: 364, h: 210, space: 'disparity' });
//   wall.addScene(canvas, (views, layer) => dibr.render({ views, layer }));
//
// Depth arrives at 10-15 fps, frames at 60: every render() reuses the last depth. Normalisation,
// convergence and dilation are CPU-side at depth resolution (76k px - microseconds); the shader
// reads the RAW dilated disparity and normalises with two uniforms, so an EMA step never
// re-uploads. The view -> uniform mapping reads ONLY view.projectionMatrix (see viewEye()).
// Full write-up: docs/lift-dibr.md.

import VERT from './shaders/dibr.vert.glsl.js';
import FRAG from './shaders/dibr.frag.glsl.js';

/** Nominal viewing geometry: IPD / viewing distance (63 mm at 0.6 m). Sets how much parallax a
 *  given disparity budget means for an eye at a given offset; it cancels for the nominal pair. */
export const KAPPA = 0.063 / 0.6;

export const DEFAULT_PARAMS = Object.freeze({
  depth: 1, // gain on the disparity budget
  convergence: 'auto', // 'auto' | 0..1 (normalised disparity placed on the glass)
  dilate: 2, // foreground max-filter radius, depth px
  edgeTaper: 0.03, // border fade of disparity to 0, fraction of width
  stabilize: true, // EMA the percentile range + auto-convergence
  budget: 0.025, // total near-far disparity between the nominal eye pair, fraction of width
  loPct: 0.02,
  hiPct: 0.98,
  ema: 0.9, // decay: state = ema*state + (1-ema)*new
  steps: 32, // coarse ray-march steps
});

// ---------------------------------------------------------------------------------------------
// Pure math (unit-tested in test/lift-dibr-math.test.mjs)
// ---------------------------------------------------------------------------------------------

/** Percentiles of a Float32Array via a 2048-bin histogram over [min,max]. NaN/Inf skipped.
 *  @returns {{lo:number, hi:number, min:number, max:number}} */
export function percentileRange(data, loPct = 0.02, hiPct = 0.98) {
  let mn = Infinity;
  let mx = -Infinity;
  let count = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (!Number.isFinite(v)) continue;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
    count++;
  }
  if (!count) return { lo: 0, hi: 1, min: 0, max: 1 };
  if (mx <= mn) return { lo: mn, hi: mn, min: mn, max: mx };
  const BINS = 2048;
  const hist = new Uint32Array(BINS);
  const s = (BINS - 1) / (mx - mn);
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (Number.isFinite(v)) hist[((v - mn) * s) | 0]++;
  }
  const at = (p) => {
    const target = p * (count - 1);
    let acc = 0;
    for (let b = 0; b < BINS; b++) {
      if (acc + hist[b] > target) {
        // linear within the bin
        const f = hist[b] ? (target - acc) / hist[b] : 0;
        return mn + (b + f) / s;
      }
      acc += hist[b];
    }
    return mx;
  };
  return { lo: at(loPct), hi: at(hiPct), min: mn, max: mx };
}

/** Median of normalised disparity over the centre `frac` (per axis) of a w×h map. */
export function centreMedian(data, w, h, lo, hi, frac = 0.5) {
  const x0 = Math.floor((w * (1 - frac)) / 2);
  const y0 = Math.floor((h * (1 - frac)) / 2);
  const x1 = Math.max(x0 + 1, Math.ceil((w * (1 + frac)) / 2));
  const y1 = Math.max(y0 + 1, Math.ceil((h * (1 + frac)) / 2));
  const vals = new Float32Array((x1 - x0) * (y1 - y0));
  const inv = 1 / Math.max(hi - lo, 1e-9);
  let k = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const v = data[y * w + x];
      vals[k++] = Number.isFinite(v) ? Math.min(1, Math.max(0, (v - lo) * inv)) : 0;
    }
  }
  const a = vals.subarray(0, k).sort();
  return k % 2 ? a[(k - 1) >> 1] : 0.5 * (a[k / 2 - 1] + a[k / 2]);
}

/** Separable max filter (foreground dilation). Radius in px; returns a new array. */
export function dilateMax(data, w, h, r) {
  r = Math.max(0, Math.round(r));
  if (!r) return Float32Array.from(data);
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let m = -Infinity;
      const a = Math.max(0, x - r);
      const b = Math.min(w - 1, x + r);
      for (let i = a; i <= b; i++) if (data[row + i] > m) m = data[row + i];
      tmp[row + x] = m;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let m = -Infinity;
      const a = Math.max(0, y - r);
      const b = Math.min(h - 1, y + r);
      for (let i = a; i <= b; i++) if (tmp[i * w + x] > m) m = tmp[i * w + x];
      out[y * w + x] = m;
    }
  }
  return out;
}

/** metric depth (m) -> disparity (1/m); disparity passes through. Non-positive depth -> 0. */
export function toDisparity(data, space) {
  if (space !== 'metric') return data;
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] > 0 ? 1 / data[i] : 0;
  return out;
}

/** EMA-smoothed depth statistics: percentile range + auto-convergence. */
export class DepthNormalizer {
  constructor(opts = {}) {
    this.ema = opts.ema ?? 0.9;
    this.loPct = opts.loPct ?? 0.02;
    this.hiPct = opts.hiPct ?? 0.98;
    this.reset();
  }
  reset() {
    this.lo = NaN;
    this.hi = NaN;
    this.conv = NaN;
  }
  /** Feed one (already dilated) disparity map. `stabilize:false` = take this frame's values. */
  update(data, w, h, { stabilize = true, reset = false } = {}) {
    if (reset) this.reset();
    const r = percentileRange(data, this.loPct, this.hiPct);
    let hi = r.hi;
    if (hi - r.lo < 1e-6) hi = r.lo + 1e-6; // flat map: keep a non-zero range
    const ema = (prev, v, on) => (on && Number.isFinite(prev) ? this.ema * prev + (1 - this.ema) * v : v);
    this.lo = ema(this.lo, r.lo, stabilize);
    this.hi = ema(this.hi, hi, stabilize);
    // median in the SMOOTHED range, so convergence and range agree on what n means
    const c = centreMedian(data, w, h, this.lo, this.hi, 0.5);
    this.conv = ema(this.conv, c, stabilize);
    return { lo: this.lo, hi: this.hi, conv: this.conv };
  }
}

/**
 * THE view -> uniform mapping. From an XRView's projection matrix alone (column-major, Kooima
 * off-axis frustum onto the display window) recover the eye relative to the window centre, in
 * window HEIGHTS, and the window aspect:
 *   P0 = 2n/(r-l), P5 = 2n/(t-b), P8 = (r+l)/(r-l), P9 = (t+b)/(t-b)
 *   eye.x = -P8 * P5 / (2 P0),  eye.y = -P9 / 2,  eye.z = P5 / 2,  aspect = P5 / P0
 * No transform, no virtualDisplayHeight, no rig assumption beyond "the frustum's near plane is
 * parallel to the window" (true for every display rig). This is exactly the RGBD player's
 * facePos / sk2 / f2 triple, but read back from the runtime's projection instead of re-derived
 * from a head pose: sk2 = -facePos*invd/(1-facePos.z*invd) IS the off-axis term P8/P9.
 */
export function viewEye(projectionMatrix) {
  const P = projectionMatrix;
  const P0 = P[0];
  const P5 = P[5];
  const P8 = P[8];
  const P9 = P[9];
  return {
    x: (-P8 * P5) / (2 * P0),
    y: -P9 / 2,
    z: P5 / 2,
    aspect: P5 / P0,
  };
}

/** q (relative parallax) per unit of normalised disparity. Nominal pair (baseline KAPPA*D0)
 *  then sees `budget*gain` of the width between n=0 and n=1. */
export function qScale(budget, gain, aspect, D0, kappa = KAPPA) {
  return (budget * gain * aspect) / (kappa * D0);
}

/** Build a Kooima projection (column-major Float32Array) for an eye at `eye` (window heights,
 *  relative to the window centre) looking at a window of `aspect`. Used by the dev page and
 *  tests to stand in for the runtime's views when no DisplayXR session exists. */
export function kooimaProjection(eye, aspect, near = 0.05, far = 100) {
  const d = eye.z;
  const l = ((-aspect / 2 - eye.x) * near) / d;
  const r = ((aspect / 2 - eye.x) * near) / d;
  const b = ((-0.5 - eye.y) * near) / d;
  const t = ((0.5 - eye.y) * near) / d;
  const m = new Float32Array(16);
  m[0] = (2 * near) / (r - l);
  m[5] = (2 * near) / (t - b);
  m[8] = (r + l) / (r - l);
  m[9] = (t + b) / (t - b);
  m[10] = -(far + near) / (far - near);
  m[11] = -1;
  m[14] = (-2 * far * near) / (far - near);
  return m;
}

// ---------------------------------------------------------------------------------------------
// WebGL2 module
// ---------------------------------------------------------------------------------------------

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error('[lift/dibr] shader compile failed: ' + log);
  }
  return s;
}

/**
 * @param {object} opts
 * @param {HTMLCanvasElement|OffscreenCanvas} opts.canvas  the addScene canvas (WebGL2 is created
 *        on it unless `opts.gl` is given).
 * @param {WebGL2RenderingContext} [opts.gl]
 * @param {number} [opts.maxLayers=1]  only 1 is implemented (single-layer LDI).
 * @param {object} [opts.contextAttributes]
 */
export function createLiveDibr(opts = {}) {
  const { canvas, maxLayers = 1 } = opts;
  if (maxLayers !== 1) throw new Error('[lift/dibr] maxLayers > 1 is not implemented');
  const gl =
    opts.gl ||
    canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      premultipliedAlpha: true,
      ...(opts.contextAttributes || {}),
    });
  if (!gl) throw new Error('[lift/dibr] WebGL2 unavailable');

  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error('[lift/dibr] link failed: ' + gl.getProgramInfoLog(prog));
  }
  const U = {};
  for (const n of [
    'uColor', 'uDisp', 'uDispRes', 'uLo', 'uHi', 'uConv', 'uQScale', 'uTaper', 'uAspect',
    'uEye', 'uD0', 'uSteps',
  ]) {
    U[n] = gl.getUniformLocation(prog, n);
  }
  const vao = gl.createVertexArray();

  const mkTex = () => {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  };
  const colorTex = mkTex();
  const dispTex = mkTex();
  // Placeholder: flat grey, flat disparity — renders the plain 2D frame until data arrives.
  gl.bindTexture(gl.TEXTURE_2D, colorTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
  gl.bindTexture(gl.TEXTURE_2D, dispTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, 1, 1, 0, gl.RED, gl.FLOAT, new Float32Array([0]));

  const params = { ...DEFAULT_PARAMS };
  const norm = new DepthNormalizer(params);
  let source = null;
  let sourceDirty = false;
  let lastVideoTime = -1;
  let dispW = 1;
  let dispH = 1;
  let lastRaw = null; // {data,w,h} in disparity space, pre-dilation (so setParams({dilate}) can redo it)
  let D0ema = NaN;
  const stats = {
    frames: 0,
    depthUpdates: 0,
    views: 0,
    uploadMs: 0,
    renderMs: 0,
    depthCpuMs: 0,
    lo: 0,
    hi: 1,
    convergence: 0.5,
    qScale: 0,
    D0: 0,
  };

  function processDepth(reset) {
    const t0 = performance.now();
    const { data, w, h } = lastRaw;
    const dil = dilateMax(data, w, h, params.dilate);
    norm.ema = params.ema;
    norm.update(dil, w, h, { stabilize: params.stabilize, reset });
    gl.bindTexture(gl.TEXTURE_2D, dispTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (w !== dispW || h !== dispH) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, w, h, 0, gl.RED, gl.FLOAT, dil);
      dispW = w;
      dispH = h;
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RED, gl.FLOAT, dil);
    }
    stats.depthCpuMs = performance.now() - t0;
    stats.depthUpdates++;
  }

  function uploadSource() {
    if (!source) return;
    const isVideo = typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement;
    if (isVideo) {
      if (source.readyState < 2) return;
      // Re-upload only on a new frame (paused video = one upload).
      if (!sourceDirty && source.currentTime === lastVideoTime && source.paused) return;
      lastVideoTime = source.currentTime;
    } else if (!sourceDirty) {
      return;
    }
    const t0 = performance.now();
    gl.bindTexture(gl.TEXTURE_2D, colorTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    stats.uploadMs = performance.now() - t0;
    sourceDirty = false;
  }

  return {
    gl,
    /** @param {HTMLVideoElement|HTMLImageElement|HTMLCanvasElement|VideoFrame} el */
    setSource(el) {
      source = el;
      sourceDirty = true;
      lastVideoTime = -1;
    },
    /** Mark a non-video source (canvas / image) as changed. VideoFrame: call setSource again. */
    touchSource() {
      sourceDirty = true;
    },
    /** @param {{data:Float32Array,w:number,h:number,space?:'disparity'|'metric',reset?:boolean}} d */
    setDepth(d) {
      if (!d || !d.data || d.data.length < d.w * d.h) throw new Error('[lift/dibr] bad depth');
      lastRaw = { data: toDisparity(d.data, d.space || 'disparity'), w: d.w, h: d.h };
      processDepth(!!d.reset);
    },
    setParams(p = {}) {
      const redilate = p.dilate !== undefined && p.dilate !== params.dilate;
      Object.assign(params, p);
      if (redilate && lastRaw) processDepth(false);
    },
    getParams: () => ({ ...params }),
    /**
     * Draw every view into its viewport. `views` = XRView[] (only projectionMatrix is read),
     * `layer.getViewport(view)` -> {x,y,width,height} in GL (bottom-left) backing-store px.
     */
    render({ views, layer } = {}) {
      if (!views || !views.length) return;
      const t0 = performance.now();
      uploadSource();
      // Source camera distance: the mean eye distance of this frame's views, so a centred view
      // at the viewer's distance is the IDENTITY (neutral view reproduces the source) and the
      // effect is pure lateral parallax. See docs/lift-dibr.md "Forward/back motion".
      const eyes = views.map((v) => viewEye(v.projectionMatrix));
      let zsum = 0;
      for (const e of eyes) zsum += e.z;
      const D0 = zsum / eyes.length;
      D0ema = D0;
      const conv =
        params.convergence === 'auto'
          ? Number.isFinite(norm.conv)
            ? norm.conv
            : 0.5
          : Math.min(1, Math.max(0, +params.convergence));
      const lo = Number.isFinite(norm.lo) ? norm.lo : 0;
      const hi = Number.isFinite(norm.hi) ? norm.hi : 1;

      gl.useProgram(prog);
      gl.bindVertexArray(vao);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.enable(gl.SCISSOR_TEST);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, colorTex);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, dispTex);
      gl.uniform1i(U.uColor, 0);
      gl.uniform1i(U.uDisp, 1);
      gl.uniform2f(U.uDispRes, dispW, dispH);
      gl.uniform1f(U.uLo, lo);
      gl.uniform1f(U.uHi, hi);
      gl.uniform1f(U.uConv, lastRaw ? conv : 0);
      gl.uniform1f(U.uTaper, params.edgeTaper);
      gl.uniform1f(U.uD0, D0);
      gl.uniform1i(U.uSteps, Math.max(4, Math.min(64, params.steps | 0)));
      let qs = 0;
      for (let i = 0; i < views.length; i++) {
        const vp = layer.getViewport(views[i]);
        if (!vp) continue;
        const e = eyes[i];
        qs = lastRaw ? qScale(params.budget, params.depth, e.aspect, D0) : 0;
        gl.viewport(vp.x, vp.y, vp.width, vp.height);
        gl.scissor(vp.x, vp.y, vp.width, vp.height);
        gl.uniform1f(U.uAspect, e.aspect);
        gl.uniform1f(U.uQScale, qs);
        gl.uniform3f(U.uEye, e.x, e.y, e.z);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      gl.disable(gl.SCISSOR_TEST);
      gl.bindVertexArray(null);
      stats.frames++;
      stats.views = views.length;
      stats.lo = lo;
      stats.hi = hi;
      stats.convergence = conv;
      stats.qScale = qs;
      stats.D0 = D0ema;
      stats.renderMs = performance.now() - t0;
    },
    getStats: () => ({ ...stats }),
    dispose() {
      gl.deleteTexture(colorTex);
      gl.deleteTexture(dispTex);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(prog);
      source = null;
      lastRaw = null;
    },
  };
}

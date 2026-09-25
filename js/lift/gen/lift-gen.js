// lift-gen.js — "Convert to 3D": one RGB image + its disparity → a two-layer, image-aligned 3D
// Gaussian scene, as a standard binary 3DGS PLY that `addSplat` (Spark or PlayCanvas) loads.
//
// EXPERIMENTAL. Not covered by the SDK's semver promise. Design + conventions: docs/lift-gen.md.
//
//   import { generateLift } from './lift/gen/lift-gen.js';
//   const { ply, meta } = await generateLift({
//     rgb: bitmap,                                       // ImageBitmap | HTMLCanvasElement | ImageData
//     depth: { data, w, h, space: 'disparity' },         // any resolution; relative is fine
//     inpainter,                                         // optional { inpaintTwoSided(...) }
//     quality: 'medium',
//   });
//   const tile = addSplat(wall, canvas, ply, {
//     rig: 'camera', intrinsics: meta.intrinsics, focus: [0, 0, meta.pivotZ], idleSpin: 0,
//   });
//
// The shape is Apple SHARP's: LAYER 0 is the visible surface, one Gaussian per output pixel;
// LAYER 1 is the hidden background — present only in a band under each foreground silhouette,
// as wide as the background can be revealed at the maximum orbit angle, plus a 4 % outpainted
// border — so an orbit of ±15° uncovers background instead of holes.
//
// Image processing runs as WebGL2 fragment passes (./gl.js, ./passes/*); Gaussian emission and
// PLY packing run in a module Worker (./ply-writer.js). The generator never touches a depth or
// inpainting model — the caller supplies depth and, optionally, an inpainter.

import { GLRunner } from './gl.js';
import upsampleFS from './passes/upsample.glsl.js';
import snapFS from './passes/snap.glsl.js';
import erodeFS from './passes/erode.glsl.js';
import edgesFS from './passes/edges.glsl.js';
import hiddenFS from './passes/hidden.glsl.js';
import * as pushpull from './passes/pushpull.glsl.js';
import matteFS from './passes/matte.glsl.js';
import composeFS from './passes/compose.glsl.js';
import { emitLiftSplats, NO_LAYER } from './ply-writer.js';

/** Output width caps per quality (the raster is never upscaled beyond the source). */
export const LIFT_QUALITY = Object.freeze({
  low: { maxWidth: 768 },
  medium: { maxWidth: 1024 },
  high: { maxWidth: 1536 },
});

/** Defaults — every one is overridable through `generateLift(opts.params)`. */
export const LIFT_DEFAULTS = Object.freeze({
  /** relative disparity is mapped so the scene spans [zNear, zFar] metres */
  zNear: 0.7,
  zFar: 3.0,
  /** percentiles the disparity is normalised on */
  pLow: 0.02,
  pHigh: 0.98,
  /** focal when none is given: 1.2 × width (≈ 45° horizontal FOV) */
  focalFactor: 1.2,
  /** the orbit the hidden layer is sized for, degrees */
  maxOrbitDeg: 15,
  /** hidden band cap, fraction of the output width (full-res, inpainted) */
  maxBandFrac: 0.05,
  /** backplate cap: the hidden layer continues, at HALF resolution and with push-pull colour,
   *  out to this fraction of the width (0 disables the backplate) */
  backplateFrac: 0.25,
  /** outpaint border, fraction of each dimension */
  borderFrac: 0.04,
  /** edge threshold, normalised disparity */
  tau: 0.04,
  /** snap threshold over a 7×7 window */
  snapStep: 0.08,
  /** joint-bilateral sigmas */
  jbuSigmaS: 1.0,
  jbuSigmaR: 0.08,
  /** Gaussian shape (see ply-writer.js) */
  sigmaPx: 0.65,
  thin: 0.15,
  slopeGain: 0.5,
  maxAniso: 8,
  orient: true,
  /** pivot = median layer-0 depth of the central box of this half-size */
  pivotRegion: 0.2,
});

const abortError = () =>
  typeof DOMException === 'function' ? new DOMException('lift-gen aborted', 'AbortError') : new Error('aborted');

/**
 * @param {object} opts
 * @param {ImageBitmap|HTMLCanvasElement|OffscreenCanvas|ImageData} opts.rgb
 * @param {{data:Float32Array,w:number,h:number,space:'disparity'|'metric',intrinsics?:{focalPx:number}}} opts.depth
 *        `focalPx` is in pixels of the RGB SOURCE resolution.
 * @param {{inpaintTwoSided:Function}} [opts.inpainter]
 * @param {'low'|'medium'|'high'} [opts.quality='medium']
 * @param {AbortSignal} [opts.signal]
 * @param {(p:{stage:string,progress:number})=>void} [opts.onProgress]
 * @param {object} [opts.params]  overrides for LIFT_DEFAULTS
 * @param {boolean} [opts.worker=true]  emit + pack in a Worker
 * @param {boolean} [opts.debug=false]  also return the intermediate rasters on `meta.debug`
 * @returns {Promise<{ply:ArrayBuffer, meta:object}>}
 */
export async function generateLift(opts) {
  const { rgb, depth, inpainter = null, quality = 'medium', signal, onProgress, worker = true, debug = false } = opts;
  const P = { ...LIFT_DEFAULTS, ...(opts.params || {}) };
  const q = LIFT_QUALITY[quality];
  if (!q) throw new Error(`lift-gen: quality "${quality}" — expected low | medium | high`);
  if (!rgb) throw new Error('lift-gen: rgb is required');
  if (!depth || !depth.data || !(depth.w > 0) || !(depth.h > 0) || depth.data.length < depth.w * depth.h) {
    throw new Error('lift-gen: depth must be { data: Float32Array, w, h, space }');
  }
  const space = depth.space || 'disparity';
  if (space !== 'disparity' && space !== 'metric') throw new Error(`lift-gen: depth.space "${space}"`);

  const timings = {};
  let tMark = performance.now();
  const mark = (stage, gl) => {
    if (gl && debug !== 'notime') gl.sync();
    const now = performance.now();
    timings[stage] = +(now - tMark).toFixed(1);
    tMark = now;
  };
  const progress = (stage, v) => {
    if (signal?.aborted) throw abortError();
    try { onProgress?.({ stage, progress: v }); } catch { /* a page's callback must not break us */ }
  };
  progress('start', 0);

  // ── 0. rasters ────────────────────────────────────────────────────────────────────────────
  const src = rgb instanceof ImageData ? await createImageBitmap(rgb) : rgb;
  const Ws = src.width, Hs = src.height;
  const W = Math.min(Ws, q.maxWidth);
  const H = Math.max(2, Math.round((Hs * W) / Ws));
  const bx = Math.max(8, Math.round(P.borderFrac * W));
  const by = Math.max(8, Math.round(P.borderFrac * H));
  const PW = W + 2 * bx, PH = H + 2 * by;
  const f = (depth.intrinsics?.focalPx > 0 ? depth.intrinsics.focalPx : P.focalFactor * Ws) * (W / Ws);

  const canvas = typeof OffscreenCanvas === 'function'
    ? new OffscreenCanvas(PW, PH)
    : Object.assign(document.createElement('canvas'), { width: PW, height: PH });
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, bx, by, W, H);
  if (src !== rgb) src.close?.();
  const rgbPad = new Uint8Array(ctx.getImageData(0, 0, PW, PH).data.buffer);

  // ── 1. disparity normalisation (CPU; low-res) ────────────────────────────────────────────
  const { dlo, invFar, invNear, pivotLo } = normaliseDisparity(depth, space, P);
  mark('prep');
  progress('prep', 0.05);

  // pivot + band width. w_px = f · zp · tanθ · Δ(1/z) and Δ(1/z) = Δd̂ · (invNear − invFar).
  const zPivotLo = 1 / (invFar + pivotLo * (invNear - invFar));
  const band = f * zPivotLo * Math.tan((P.maxOrbitDeg * Math.PI) / 180) * (invNear - invFar);
  const K = Math.max(2, Math.min(256, Math.ceil(P.maxBandFrac * W)));
  const R = Math.min(256, K + 2);
  const Kb = Math.max(K, Math.min(256, Math.ceil(P.backplateFrac * W)));

  // ── 2. GPU passes ────────────────────────────────────────────────────────────────────────
  // Our OWN offscreen WebGL2 context, always — never a display canvas's (the live renderer owns
  // that one); it is lost again in dispose() below.
  const g = new GLRunner();
  let out0, out1, outB, maskTex = null, dbg = null;
  try {
    const tRGB = g.texture(PW, PH, 'rgba8', rgbPad);
    const tDlo = g.texture(depth.w, depth.h, 'r32f', dlo);
    const tD0 = g.texture(PW, PH, 'r32f');
    const tD = g.texture(PW, PH, 'r32f');
    const pad = [bx, by], inner = [W, H];
    g.pass('upsample', upsampleFS, tD0, { uDlo: tDlo, uRGB: tRGB, uPad: pad, uInner: inner, uSigmaS: P.jbuSigmaS, uSigmaR: P.jbuSigmaR });
    g.pass('snap', snapFS, tD, { uD: tD0, uStep: P.snapStep });
    mark('upsample', g);
    progress('upsample', 0.15);

    const tE = g.texture(PW, PH, 'rgba32f');
    const tM = g.texture(PW, PH, 'rgba32f');
    g.pass('edges', edgesFS, tE, { uD: tD, uPad: pad, uInner: inner, uTau: P.tau });
    g.pass('hidden', hiddenFS, tM, { uD: tD, uE: tE, uPad: pad, uInner: inner, uK: K, uBand: band, uTau: P.tau });
    // the wide mask: the same dilation out to the backplate cap. It also decides the fill's seeds,
    // so a big foreground never seeds the background it hides.
    const tMb = Kb > K ? g.texture(PW, PH, 'rgba32f') : tM;
    if (Kb > K) g.pass('hidden', hiddenFS, tMb, { uD: tD, uE: tE, uPad: pad, uInner: inner, uK: Kb, uBand: band, uTau: P.tau });
    mark('mask', g);
    progress('mask', 0.25);

    const tEro = g.texture(PW, PH, 'r32f');
    g.pass('erode', erodeFS, tD0, { uD: tD, uDir: [1, 0], uR: R });
    g.pass('erode', erodeFS, tEro, { uD: tD0, uDir: [0, 1], uR: R });
    mark('erode', g);
    progress('erode', 0.3);

    // push-pull pyramid
    const levels = [];
    let lw = PW, lh = PH;
    levels.push({ A: g.texture(lw, lh, 'rgba32f'), B: g.texture(lw, lh, 'rgba32f'), w: lw, h: lh });
    g.pass('pp-init', pushpull.init, [levels[0].A, levels[0].B], { uD: tD, uEro: tEro, uRGB: tRGB, uM: tMb, uPad: pad, uInner: inner, uTau: P.tau });
    while (lw > 1 || lh > 1) {
      lw = Math.max(1, Math.ceil(lw / 2));
      lh = Math.max(1, Math.ceil(lh / 2));
      const L = { A: g.texture(lw, lh, 'rgba32f'), B: g.texture(lw, lh, 'rgba32f'), w: lw, h: lh };
      const prev = levels[levels.length - 1];
      g.pass('pp-down', pushpull.down, [L.A, L.B], { uA: prev.A, uB: prev.B });
      levels.push(L);
    }
    let FA = levels[levels.length - 1].A, FB = levels[levels.length - 1].B;
    for (let l = levels.length - 2; l >= 0; l--) {
      const L = levels[l];
      const nA = g.texture(L.w, L.h, 'rgba32f'), nB = g.texture(L.w, L.h, 'rgba32f');
      g.pass('pp-up', pushpull.up, [nA, nB], { uA: L.A, uB: L.B, uFA: FA, uFB: FB });
      if (l < levels.length - 2) g.free(FA, FB);
      FA = nA; FB = nB;
    }
    mark('fill', g);
    progress('fill', 0.4);

    const tOut0 = g.texture(PW, PH, 'rgba32f');
    const tOut1 = g.texture(PW, PH, 'rgba32f');
    const tOutB = g.texture(PW, PH, 'rgba32f');
    g.pass('matte', matteFS, tOut0, { uD: tD, uRGB: tRGB, uPad: pad, uInner: inner, uTau: P.tau });
    g.pass('compose', composeFS, [tOut1, tOutB], { uD: tD, uM: tM, uMb: tMb, uFA: FA, uFB: FB, uTau: P.tau });
    mark('matte', g);

    out0 = g.read(tOut0, bx, by, W, H);
    out1 = g.read(tOut1);
    outB = Kb > K ? g.read(tOutB) : null;
    if (inpainter || debug) maskTex = g.read(tM);
    if (debug) {
      dbg = { edges: g.read(tE), dUp: g.read(tD) };
    }
    mark('readback');
    progress('readback', 0.45);
  } finally {
    g.dispose();
  }

  // ── 3. hidden-layer colour: the inpainting net (optional) ────────────────────────────────
  if (inpainter) {
    const N = PW * PH;
    const rgbChw = new Float32Array(3 * N), mR = new Float32Array(N), mL = new Float32Array(N);
    // Holes (M and the border) are PRE-FILLED with the push-pull background before the net sees
    // them: the light net is trained on thin disocclusion bands and passes much of a wide hole's
    // content through, so a hole still holding the foreground came back as a copy of the
    // foreground. Seeded with the smooth background, the worst it can do is leave it smooth.
    for (let i = 0; i < N; i++) {
      const hole = out1[4 * i + 3] > NO_LAYER;
      for (let c = 0; c < 3; c++) rgbChw[c * N + i] = hole ? out1[4 * i + c] : rgbPad[4 * i + c] / 255;
      mR[i] = maskTex[4 * i];
      mL[i] = maskTex[4 * i + 1];
    }
    progress('inpaint', 0.5);
    const res = await inpainter.inpaintTwoSided(rgbChw, mR, mL, PW, PH);
    if (signal?.aborted) throw abortError();
    for (let i = 0; i < N; i++) {
      if (out1[4 * i + 3] <= NO_LAYER) continue;
      out1[4 * i] = res[i];
      out1[4 * i + 1] = res[N + i];
      out1[4 * i + 2] = res[2 * N + i];
    }
    mark('inpaint');
  }
  progress('emit', 0.8);

  // ── 4. Gaussians + PLY (Worker) ──────────────────────────────────────────────────────────
  const job = {
    W, H, PW, PH, bx, by, f, invFar, invNear, out0, rgbPad, out1, outB,
    sigmaPx: P.sigmaPx, thin: P.thin, slopeGain: P.slopeGain, maxAniso: P.maxAniso, pivotRegion: P.pivotRegion, orient: P.orient,
  };
  // the debug views need the rasters after the worker has taken them
  const keep = debug ? { out0: out0.slice(), out1: out1.slice(), outB: outB && outB.slice(), rgbPad: rgbPad.slice() } : null;
  const r = worker && typeof Worker === 'function' ? await emitInWorker(job, signal) : emitLiftSplats(job);
  mark('emit');
  progress('done', 1);

  // Pivot = min(convergence, subject) — the gallery's Spatial View rule (integration). `subject` is
  // the median layer-0 depth of the central box (r.pivotZ, A4). `convergence` is the depth at the
  // MEAN normalised disparity of the central 60 % — the plane that balances crossed and uncrossed
  // disparity. On a frame whose centre is mostly far background (a sky or a wall between near
  // objects), the median alone lands on the background and the whole foreground swings under the
  // orbit; the min keeps the zero-parallax plane among the content.
  let convSum = 0, convN = 0;
  for (let y = Math.floor(depth.h * 0.2); y < Math.ceil(depth.h * 0.8); y++)
    for (let x = Math.floor(depth.w * 0.2); x < Math.ceil(depth.w * 0.8); x++) { convSum += dlo[y * depth.w + x]; convN++; }
  const convergenceZ = 1 / (invFar + (convN ? convSum / convN : 0.5) * (invNear - invFar));
  const pivotZ = Math.min(r.pivotZ, convergenceZ);

  const meta = {
    focalPx: f,
    pivotZ,
    subjectZ: r.pivotZ,
    convergenceZ,
    w: W,
    h: H,
    layers: 2,
    splatCount: r.splatCount,
    layerCounts: r.layerCounts,
    hiddenBandCount: r.bandCount,
    hiddenBackplateCount: r.backplateCount,
    bounds: r.bounds,
    // convenience for addSplat's camera rig: one eye, OpenCV, the output raster
    intrinsics: { fx: f, fy: f, cx: W / 2, cy: H / 2, width: W, height: H },
    convention: 'opencv',
    /** the same, under the name explore.js (rigFromMeta) reads */
    axes: 'opencv',
    border: { x: bx, y: by },
    depthRange: { near: 1 / invNear, far: 1 / invFar },
    bandPxPerDisparity: band,
    maxBandPx: K,
    backplatePx: Kb > K ? Kb : 0,
    inpainted: !!inpainter,
    timings,
  };
  if (debug) meta.debug = { ...keep, ...dbg, mask: maskTex, PW, PH };
  return { ply: r.ply, meta };
}

/**
 * Normalise disparity on its 2–98th percentiles and pick the inverse-depth mapping.
 * Relative disparity → 1/z ∈ [1/zFar, 1/zNear]; metric depth → its own 1/z range.
 */
export function normaliseDisparity(depth, space, P = LIFT_DEFAULTS) {
  const { w, h } = depth;
  const n = w * h;
  const disp = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = depth.data[i];
    // Metric providers mark invalid pixels (MoGe: sky / no-surface) with depth 0. That must read as
    // FAR, not as 1/1e-3 = the nearest thing in the scene: NaN here stays out of the percentiles and
    // normalises to 0 (the far end) below. (Integration fix: a MoGe sky became a curtain of
    // foreground-depth splats in front of everything.)
    disp[i] = space === 'metric' ? (v > 0 && Number.isFinite(v) ? 1 / Math.max(v, 1e-3) : NaN) : v;
  }
  const step = Math.max(1, Math.floor(n / 200000));
  const sample = [];
  for (let i = 0; i < n; i += step) if (Number.isFinite(disp[i])) sample.push(disp[i]);
  sample.sort((a, b) => a - b);
  const pct = (p) => sample[Math.min(sample.length - 1, Math.max(0, Math.round(p * (sample.length - 1))))];
  const lo = pct(P.pLow), hi = pct(P.pHigh);
  const range = hi - lo;
  const dlo = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = range > 1e-9 ? (disp[i] - lo) / range : 0.5;
    dlo[i] = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
  }
  let invFar, invNear;
  if (space === 'metric') {
    invFar = Math.max(lo, 0.01); // ≤ 100 m
    invNear = Math.max(hi, invFar * 1.01);
  } else {
    invFar = 1 / P.zFar;
    invNear = 1 / P.zNear;
  }
  // pivot seed: median normalised disparity of the central box (low-res)
  const c = [];
  const r = P.pivotRegion;
  for (let y = Math.floor(h * (0.5 - r)); y < Math.ceil(h * (0.5 + r)); y++)
    for (let x = Math.floor(w * (0.5 - r)); x < Math.ceil(w * (0.5 + r)); x++) c.push(dlo[y * w + x]);
  c.sort((a, b) => a - b);
  return { dlo, invFar, invNear, pivotLo: c.length ? c[c.length >> 1] : 0.5, lo, hi };
}

function emitInWorker(job, signal) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./ply-writer.js', import.meta.url), { type: 'module' });
    const done = () => { w.terminate(); signal?.removeEventListener?.('abort', onAbort); };
    const onAbort = () => { done(); reject(abortError()); };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    w.onmessage = (e) => {
      done();
      if (e.data.ok) resolve(e.data);
      else reject(new Error(`lift-gen worker: ${e.data.error}`));
    };
    w.onerror = (e) => { done(); reject(new Error(`lift-gen worker: ${e.message}`)); };
    w.postMessage(job, [job.out0.buffer, job.out1.buffer, job.rgbPad.buffer, ...(job.outB ? [job.outB.buffer] : [])]);
  });
}

/**
 * TEST HOOK (not API): run the morphology passes alone on a synthetic padded disparity field, for
 * the GPU-vs-CPU parity test. Returns raw readbacks.
 */
export function __runMorphologyPasses({ d, W, H, pad = [0, 0], inner = [W, H], tau, K, band, R }) {
  const g = new GLRunner();
  try {
    const tD = g.texture(W, H, 'r32f', d);
    const tE = g.texture(W, H, 'rgba32f');
    const tM = g.texture(W, H, 'rgba32f');
    const tT = g.texture(W, H, 'r32f');
    const tEro = g.texture(W, H, 'r32f');
    g.pass('edges', edgesFS, tE, { uD: tD, uPad: pad, uInner: inner, uTau: tau });
    g.pass('hidden', hiddenFS, tM, { uD: tD, uE: tE, uPad: pad, uInner: inner, uK: K, uBand: band, uTau: tau });
    g.pass('erode', erodeFS, tT, { uD: tD, uDir: [1, 0], uR: R });
    g.pass('erode', erodeFS, tEro, { uD: tT, uDir: [0, 1], uR: R });
    const ero = g.read(tEro);
    const eroR = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) eroR[i] = ero[4 * i];
    return { edges: g.read(tE), hidden: g.read(tM), erode: eroR };
  } finally {
    g.dispose();
  }
}

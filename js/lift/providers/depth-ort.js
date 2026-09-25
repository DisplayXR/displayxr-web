// depth-ort.js — depth estimation on onnxruntime-web (WebGPU EP).
//
//   const p = createDepthProvider({ kind: 'video', modelSource, quality: 'auto' });
//   await p.load({ onProgress });
//   const { data, w, h, space } = await p.estimate({ source: video, t: video.currentTime });
//
// kind 'video' — Video-Depth-Anything-Small, STREAMING export: static shape, explicit temporal
//   cache [42,F] fed back every frame and kept on the GPU (reading it back doubles frame time).
//   Quality: low = 364×210, medium = 518×294, auto = medium unless a warm-up (1 compile frame +
//   3 timed) exceeds 90 ms/frame, then low. `t` (seconds, e.g. video.currentTime) resets the
//   temporal history on a backwards seek or a > 1 s jump — the cache would otherwise smear the old
//   shot into the new one.
// kind 'still' — any `depth-still` manifest model; its io descriptor decides input size (static
//   W×H, or dynamic: long side `longSide`, short side snapped to `multipleOf` nearest the source
//   aspect), in-graph vs JS normalisation, and post-processing (`post`):
//     medium/auto → MoGe-3 ViT-L 770×434 (metric depth + mask + focal → intrinsics.focalPx)
//     high        → MoGe-3 ViT-L 1022×574
//     low         → Depth-Anything-V2-Small (dynamic, relative disparity)
//   DA3Mono-Large (relative, sky-filled, no camera) is selectable by name via `model`.
//   `intrinsics.focalPx` is in the pixel grid of the returned map (w×h); `fovXDeg` is grid-free.
//
// Output `data` is row-major h×w float32 at MODEL resolution (callers resample to the source).
// 'disparity' = relative inverse depth (bigger = nearer, affine-invariant); 'metric' = metres.

import { getRegistry } from './registry.js';
import { loadOrt } from './ort.js';
import { createCpuPreprocessor, createGpuPreprocessor, sourceSize } from './preprocess.js';
import { mogePost, da3Post } from './still-post.js';

export const AUTO_DROP_MS = 90;

/**
 * Registry-dispatched factory (the public contract). Picks the highest-priority registered
 * provider for `opts.kind` (or `opts.provider` by name).
 */
export function createDepthProvider(opts) {
  const kind = opts.kind || kindOfModel(opts.model);
  const e = getRegistry().resolve(kind, opts.provider);
  if (!e) throw new Error(`lift: no depth provider registered for kind ${JSON.stringify(kind)}`);
  return e.factory({ ...opts, kind });
}

/** Model families (manifest `families`) → kind, so `{ model: 'moge3' }` needs no `kind`. */
export const MODEL_KINDS = { 'vda-small': 'video', moge3: 'still', da3: 'still', 'da2-small': 'still' };

export function kindOfModel(model) {
  if (!model) return undefined;
  if (MODEL_KINDS[model]) return MODEL_KINDS[model];
  return /^vda/.test(model) ? 'video' : 'still';
}

/**
 * The ORT/WebGPU provider.
 * @param {object} opts
 * @param {'video'|'still'} opts.kind
 * @param {any} opts.modelSource  from createModelSource()
 * @param {any} [opts.ort]         onnxruntime-web module; default loadOrt(opts.ortOptions)
 * @param {'low'|'medium'|'high'|'auto'} [opts.quality='auto']
 * @param {string} [opts.model]    manifest model name (overrides quality → model)
 * @param {'gpu'|'cpu'|'auto'} [opts.preprocess='auto']
 */
export function createOrtDepthProvider(opts) {
  const { modelSource } = opts;
  const kind = opts.kind || kindOfModel(opts.model);
  if (kind !== 'video' && kind !== 'still') throw new Error(`lift depth: bad kind ${JSON.stringify(kind)}`);
  if (!modelSource) throw new Error('lift depth: modelSource required');
  const quality = opts.quality || 'auto';

  let ort = null;
  let session = null;
  let entry = null;         // manifest entry in use
  let io = null;
  let pre = null;           // preprocessor
  let device = null;
  let queue = Promise.resolve();
  let disposed = false;
  // video state
  let cache = null, zeroCache = null, lastT = null;
  let FIRST = null, NEXT = null;

  const info = { model: null, width: 0, height: 0, preprocess: null, warmupMs: null, backend: 'webgpu' };

  async function createSession(name, { signal, onProgress }) {
    const { bytes } = await modelSource.getBytes(name, { signal, onProgress });
    if (signal && signal.aborted) throw signal.reason;
    const e = modelSource.entry(name);
    const so = { executionProviders: ['webgpu'], graphOptimizationLevel: 'all' };
    if (kind === 'video') so.preferredOutputLocation = { [e.io.outputs.cache]: 'gpu-buffer' };
    const s = await ort.InferenceSession.create(bytes, so);
    return { s, e };
  }

  async function setupPre() {
    const want = opts.preprocess || 'auto';
    const norm = io.normalize || undefined;
    if (want !== 'cpu' && ort.Tensor.fromGpuBuffer) {
      try {
        device = await ort.env.webgpu.device;
        if (device) { pre = createGpuPreprocessor(device, { normalize: norm }); info.preprocess = 'gpu'; return; }
      } catch (err) {
        if (want === 'gpu') throw err;
      }
    }
    pre = createCpuPreprocessor({ normalize: norm });
    info.preprocess = 'cpu';
  }

  function imageTensor(source, W, H) {
    if (pre.kind === 'gpu') {
      const buf = pre.toBuffer(source, W, H);
      return ort.Tensor.fromGpuBuffer(buf, { dataType: 'float32', dims: [1, 3, H, W] });
    }
    return new ort.Tensor('float32', pre.toChw(source, W, H), [1, 3, H, W]);
  }

  function dropCache() {
    if (cache && cache !== zeroCache && cache.location === 'gpu-buffer') cache.dispose();
    cache = null;
  }

  function zeros() {
    if (!zeroCache) {
      const [a, b] = io.cacheShape;
      zeroCache = new ort.Tensor('float32', new Float32Array(a * b), [a, b]);
    }
    return zeroCache;
  }

  async function runVideo(imgTensor) {
    const first = cache === null;
    const feeds = {
      [io.inputs.image]: imgTensor,
      [io.inputs.cache]: first ? zeros() : cache,
      [io.inputs.isFirst]: first ? FIRST : NEXT,
    };
    const out = await session.run(feeds);
    if (!first && cache.location === 'gpu-buffer') cache.dispose();
    cache = out[io.outputs.cache];
    const d = out[io.outputs.depth];
    return d.location === 'cpu' ? d.data : await d.getData(true);
  }

  async function warmupMs() {
    // A synthetic mid-grey frame; 1 untimed (shader compile) + 3 timed.
    const W = io.width, H = io.height;
    const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H) : null;
    let src = c;
    if (c) { const g = /** @type {any} */ (c.getContext('2d')); g.fillStyle = '#808080'; g.fillRect(0, 0, W, H); }
    const run = async () => runVideo(src ? imageTensor(src, W, H) : new ort.Tensor('float32', new Float32Array(3 * W * H).fill(0.5), [1, 3, H, W]));
    await run();
    const ts = [];
    for (let i = 0; i < 3; i++) { const t0 = performance.now(); await run(); ts.push(performance.now() - t0); }
    dropCache();
    ts.sort((a, b) => a - b);
    return ts[1];
  }

  function adopt(s, e) {
    session = s; entry = e; io = e.io;
    info.model = e.name;
    if (io.width) { info.width = io.width; info.height = io.height; }
  }

  async function load({ signal, onProgress } = {}) {
    if (session) return info;
    ort = opts.ort || await loadOrt(opts.ortOptions);
    if (kind === 'video') {
      FIRST = new ort.Tensor('float32', new Float32Array([1]), [1]);
      NEXT = new ort.Tensor('float32', new Float32Array([0]), [1]);
      await modelSource.ready();
      const q = quality === 'auto' ? 'medium' : quality;
      // opts.model: a concrete manifest name (used as-is) or a family alias ('vda-small') that
      // quality maps to a resolution; 'auto' warm-up applies to families and the default only.
      const concrete = opts.model && !modelSource.family(opts.model);
      const name = modelSource.resolveName(opts.model, 'depth-video', q);
      const { s, e } = await createSession(name, { signal, onProgress });
      adopt(s, e);
      await setupPre();
      if (quality === 'auto' && !concrete) {
        const ms = await warmupMs();
        info.warmupMs = ms;
        const low = modelSource.resolveName(opts.model, 'depth-video', 'low');
        if (ms > AUTO_DROP_MS && low && low !== name) {
          // Create the low session BEFORE releasing medium: releasing the last session can tear
          // down ORT's WebGPU device, and our preprocess buffers belong to that device.
          const r = await createSession(low, { signal, onProgress });
          await session.release();
          zeroCache = null;
          adopt(r.s, r.e);
          if (pre && pre.kind === 'gpu' && (await ort.env.webgpu.device) !== device) { pre.dispose(); await setupPre(); }
          info.warmupMs = await warmupMs();
          info.autoDropped = true;
          info.warmupDroppedMs = ms;
        }
      }
    } else {
      await modelSource.ready();
      const name = modelSource.resolveName(opts.model, 'depth-still', quality === 'auto' ? 'medium' : quality);
      const { s, e } = await createSession(name, { signal, onProgress });
      adopt(s, e);
      await setupPre();
    }
    if (disposed) { await session.release(); session = null; throw new Error('lift depth: disposed during load'); }
    return info;
  }

  /** Model input size for a still of the given source size. */
  function stillSize(sw, sh) {
    if (!io.dynamic) return [io.width, io.height];
    const L = io.longSide || 518;
    const m = io.multipleOf || 14;
    const snap = (v) => Math.max(m, Math.round(v / m) * m);
    return sw >= sh ? [snap(L), snap((L * sh) / sw)] : [snap((L * sw) / sh), snap(L)];
  }

  async function estimateNow({ source, t }) {
    if (!session) throw new Error('lift depth: call load() first');
    if (kind === 'video') {
      if (typeof t === 'number' && lastT !== null && (t < lastT || t - lastT > 1.0)) dropCache();
      if (typeof t === 'number') lastT = t;
      const data = await runVideo(imageTensor(source, io.width, io.height));
      return { data, w: io.width, h: io.height, space: io.space || 'disparity' };
    }
    const [sw, sh] = sourceSize(source);
    const [W, H] = stillSize(sw, sh);
    const out = await session.run({ [io.inputs.image]: imageTensor(source, W, H) });
    const o = io.outputs;
    const read = async (k) => { const t = out[k]; return t.location === 'cpu' ? t.data : await t.getData(); };
    try {
      /** @type {any} */
      let res;
      if (io.post === 'moge') {
        const [pts, nrm, msk, sc] = await Promise.all([o.points, o.normal, o.mask, o.metricScale].map(read));
        const r = mogePost(pts, msk, sc[0], opts.normals ? nrm : null, W, H);
        res = { data: r.depth, w: W, h: H, space: 'metric', mask: r.mask,
                intrinsics: { focalPx: r.focalPx, fovXDeg: r.fovXDeg } };
        if (r.normals) res.normals = r.normals;
      } else if (io.post === 'da3') {
        const r = da3Post(await read(o.depth), await read(o.sky), W, H);
        const d = r.depth, disp = new Float32Array(d.length);
        for (let i = 0; i < d.length; i++) disp[i] = d[i] > 1e-6 ? 1 / d[i] : 0;   // relative depth → disparity
        res = { data: disp, w: W, h: H, space: 'disparity', mask: r.mask };
      } else {
        const d = out[o.depth], dims = d.dims;
        res = { data: await read(o.depth), w: dims[dims.length - 1], h: dims[dims.length - 2], space: io.space || 'disparity' };
      }
      info.width = res.w; info.height = res.h;
      return res;
    } finally {
      for (const k in out) if (out[k].location !== 'cpu') out[k].dispose?.();
    }
  }

  return {
    id: 'ort-webgpu',
    kind,
    info,
    load,
    /** Frames are serialised: a call made while one is in flight waits its turn. */
    estimate(args) {
      const p = queue.then(() => estimateNow(args));
      queue = p.catch(() => {});
      return p;
    },
    reset() { dropCache(); lastT = null; },
    async dispose() {
      disposed = true;
      await queue;
      dropCache();
      if (pre) pre.dispose();
      pre = null;
      if (session) await session.release();
      session = null;
    },
  };
}

getRegistry().registerDepthProvider('ort', createOrtDepthProvider, {
  priority: 0,
  kinds: ['video', 'still'],
  available: () => typeof navigator !== 'undefined' && !!(/** @type {any} */ (navigator)).gpu,
});

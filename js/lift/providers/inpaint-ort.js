// inpaint-ort.js — disocclusion inpainting (iw3 light_inpaint_v1, nagadomi/nunif, MIT) on ORT WebGPU.
//
//   const ip = createInpainter({ modelSource, quality: 'medium' });
//   await ip.load({ onProgress });
//   const filled = await ip.inpaintTwoSided(rgbChw, maskRight, maskLeft, W, H);
//
// Model I/O (static shape per file; dims multiples of 64):
//   rgb  f32 [1,3,H,W] 0..1 planar CHW;  mask f32 [1,1,H,W] 1 = hole (thresholded > 0.5 in-graph)
//   out  f32 [1,3,H,W] 0..1 — unchanged outside the hole EXCEPT a ~7 px feather (the graph blurs the
//        mask with a 15-tap Gaussian and blends), so pixels next to a hole are touched too.
// ORIENTATION: trained as the RIGHT view of a stereo pair ⇒ expects BACKGROUND to the RIGHT of a hole.
// Holes whose background is on the left must be mirrored — `inpaintTwoSided` does that.
// Quality: low/medium/auto = 512×288 tiles (~42 ms/tile M1 Pro), high = 1024×576 (~130–230 ms/tile).

import { loadOrt } from './ort.js';
import { getRegistry } from './registry.js';

/**
 * @param {object} o
 * @param {any} o.modelSource
 * @param {any} [o.ort]
 * @param {'low'|'medium'|'high'|'auto'} [o.quality='auto']
 * @param {string} [o.model]  manifest name override
 */
export function createInpainter(o) {
  const { modelSource } = o;
  if (!modelSource) throw new Error('lift inpaint: modelSource required');
  const quality = o.quality === 'auto' || !o.quality ? 'medium' : o.quality;
  let ort = null, session = null, W = 0, H = 0, io = null;
  let queue = Promise.resolve();

  async function load({ signal, onProgress } = {}) {
    if (session) return api;
    ort = o.ort || await loadOrt(o.ortOptions);
    await modelSource.ready();
    const name = modelSource.resolveName(o.model, 'inpaint', quality);
    const e = modelSource.entry(name);
    const { bytes } = await modelSource.getBytes(name, { signal, onProgress });
    session = await ort.InferenceSession.create(bytes, { executionProviders: ['webgpu'], graphOptimizationLevel: 'all' });
    io = e.io; W = io.width; H = io.height;
    api.width = W; api.height = H; api.model = name;
    return api;
  }

  /** One model-sized pass. rgb: Float32Array(3·W·H), mask: Float32Array(W·H). */
  async function inpaintTile(rgb, mask) {
    const N = W * H;
    if (!session) throw new Error('lift inpaint: call load() first');
    if (rgb.length !== 3 * N || mask.length !== N) throw new Error(`lift inpaint: expected ${W}x${H}`);
    const r = await session.run({
      [io.inputs.rgb]: new ort.Tensor('float32', rgb, [1, 3, H, W]),
      [io.inputs.mask]: new ort.Tensor('float32', mask, [1, 1, H, W]),
    });
    const t = r[io.outputs.rgb];
    return t.location === 'cpu' ? t.data : await t.getData(true);
  }

  // Arbitrary-size image via overlapping model-size tiles. Tiles with no hole are skipped (depth-edge
  // bands are sparse). Each tile contributes its centre (overlap/2 margin dropped) except at borders.
  // overlap ≥ 128 recommended (receptive field ≈ 64 px windows at 1/4 and 1/8 res + shifted windows).
  async function inpaintImage(rgb, mask, imgW, imgH, { overlap = 128 } = {}) {
    const N = W * H, P = imgW * imgH, out = Float32Array.from(rgb);
    const stepX = W - overlap, stepY = H - overlap, m2 = overlap >> 1;
    const xs = [], ys = [];
    for (let x = 0; ; x += stepX) { xs.push(Math.min(x, Math.max(0, imgW - W))); if (x + W >= imgW) break; }
    for (let y = 0; ; y += stepY) { ys.push(Math.min(y, Math.max(0, imgH - H))); if (y + H >= imgH) break; }
    const tr = new Float32Array(3 * N), tm = new Float32Array(N);
    for (const y0 of ys) for (const x0 of xs) {
      let any = false;
      for (let ty = 0; ty < H; ty++) {           // gather, edge-replicating if the image < tile
        const sy = Math.min(y0 + ty, imgH - 1);
        for (let tx = 0; tx < W; tx++) {
          const sx = Math.min(x0 + tx, imgW - 1), si = sy * imgW + sx, ti = ty * W + tx;
          const mv = mask[si]; tm[ti] = mv; if (mv > 0.5) any = true;
          tr[ti] = rgb[si]; tr[N + ti] = rgb[P + si]; tr[2 * N + ti] = rgb[2 * P + si];
        }
      }
      if (!any) continue;
      const res = await inpaintTile(tr, tm);
      const ox0 = x0 === 0 ? 0 : m2, oy0 = y0 === 0 ? 0 : m2;
      const ox1 = x0 + W >= imgW ? W : W - m2, oy1 = y0 + H >= imgH ? H : H - m2;
      for (let ty = oy0; ty < oy1 && y0 + ty < imgH; ty++) for (let tx = ox0; tx < ox1 && x0 + tx < imgW; tx++) {
        const si = (y0 + ty) * imgW + x0 + tx, ti = ty * W + tx;
        out[si] = res[ti]; out[P + si] = res[N + ti]; out[2 * P + si] = res[2 * N + ti];
      }
    }
    return out;
  }

  // maskRight = holes with background on their RIGHT; maskLeft = background on their LEFT (split the
  // band by the sign of the depth gradient across it). Pass 2 runs mirrored on pass 1's output.
  async function inpaintTwoSided(rgb, maskRight, maskLeft, imgW, imgH, opts) {
    const flip = (a, c) => {
      const out = new Float32Array(a.length);
      for (let k = 0; k < c; k++) for (let y = 0; y < imgH; y++) {
        const row = (k * imgH + y) * imgW;
        for (let x = 0; x < imgW; x++) out[row + x] = a[row + imgW - 1 - x];
      }
      return out;
    };
    const a = await inpaintImage(rgb, maskRight, imgW, imgH, opts);
    return flip(await inpaintImage(flip(a, 3), flip(maskLeft, 1), imgW, imgH, opts), 3);
  }

  const serial = (fn) => (...args) => {
    const p = queue.then(() => fn(...args));
    queue = p.catch(() => {});
    return p;
  };

  const api = {
    id: 'ort-webgpu-inpaint',
    width: 0, height: 0, model: null,
    load,
    inpaint: serial(inpaintTile),
    inpaintImage: serial(inpaintImage),
    inpaintTwoSided: serial(inpaintTwoSided),
    async dispose() { await queue; if (session) await session.release(); session = null; },
  };
  return api;
}

getRegistry().registerInpainter('ort', createInpainter, {
  priority: 0,
  available: () => typeof navigator !== 'undefined' && !!(/** @type {any} */ (navigator)).gpu,
});

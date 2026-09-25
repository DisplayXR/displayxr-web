// preprocess.js — frame → model input tensor (float32 planar CHW, RGB, optionally normalised).
//
// Two paths, same output:
//   GPU  copyExternalImageToTexture(source) on ORT's own GPUDevice → one compute pass resamples to
//        model resolution (4-tap box filter, so a 1080p → 518 downscale doesn't alias), normalises,
//        writes CHW f32 into a storage buffer → `ort.Tensor.fromGpuBuffer`. Nothing touches the CPU.
//   CPU  drawImage into an OffscreenCanvas at model res → getImageData → CHW loop. The fallback when
//        there is no WebGPU device or `fromGpuBuffer` (older ORT, wasm EP).
// Measured on the dev page (samples/lift/dev-depth.html, `?pre=gpu|cpu`); GPU is the default.

/** Pixel size of any drawable source. */
export function sourceSize(s) {
  const a = /** @type {any} */ (s);
  if (a.videoWidth !== undefined) return [a.videoWidth, a.videoHeight];         // HTMLVideoElement
  if (a.displayWidth !== undefined) return [a.displayWidth, a.displayHeight];   // VideoFrame
  if (a.naturalWidth !== undefined) return [a.naturalWidth, a.naturalHeight];   // HTMLImageElement
  return [a.width, a.height];                                                   // canvas, ImageBitmap
}

const IDENTITY = { mean: [0, 0, 0], std: [1, 1, 1] };

/** CPU path. `toChw(source, W, H) → Float32Array(3*W*H)`. */
export function createCpuPreprocessor({ normalize } = {}) {
  const nm = normalize || IDENTITY;
  let canvas = null, ctx = null;
  return {
    kind: 'cpu',
    toChw(source, W, H, out) {
      if (!canvas || canvas.width !== W || canvas.height !== H) {
        canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H)
          : Object.assign(document.createElement('canvas'), { width: W, height: H });
        ctx = /** @type {any} */ (canvas).getContext('2d', { willReadFrequently: true });
        ctx.imageSmoothingQuality = 'high';
      }
      ctx.drawImage(source, 0, 0, W, H);
      const px = ctx.getImageData(0, 0, W, H).data;
      const n = W * H;
      out = out && out.length === 3 * n ? out : new Float32Array(3 * n);
      const [m0, m1, m2] = nm.mean, s0 = 1 / (255 * nm.std[0]), s1 = 1 / (255 * nm.std[1]), s2 = 1 / (255 * nm.std[2]);
      const o0 = m0 * 255, o1 = m1 * 255, o2 = m2 * 255;
      for (let i = 0, j = 0; i < n; i++, j += 4) {
        out[i] = (px[j] - o0) * s0;
        out[n + i] = (px[j + 1] - o1) * s1;
        out[2 * n + i] = (px[j + 2] - o2) * s2;
      }
      return out;
    },
    dispose() { canvas = ctx = null; },
  };
}

const WGSL = /* wgsl */ `
struct P { w: u32, h: u32, pad0: u32, pad1: u32, mean: vec4f, invstd: vec4f };
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<storage, read_write> dst: array<f32>;
@group(0) @binding(3) var<uniform> p: P;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= p.w || id.y >= p.h) { return; }
  let inv = vec2f(1.0 / f32(p.w), 1.0 / f32(p.h));
  let c = (vec2f(id.xy) + 0.5) * inv;
  let q = inv * 0.25;
  let v = 0.25 * (textureSampleLevel(src, samp, c + vec2f(-q.x, -q.y), 0.0)
                + textureSampleLevel(src, samp, c + vec2f( q.x, -q.y), 0.0)
                + textureSampleLevel(src, samp, c + vec2f(-q.x,  q.y), 0.0)
                + textureSampleLevel(src, samp, c + vec2f( q.x,  q.y), 0.0));
  let n = p.w * p.h;
  let i = id.y * p.w + id.x;
  let o = (v.rgb - p.mean.xyz) * p.invstd.xyz;
  dst[i] = o.x;
  dst[n + i] = o.y;
  dst[2u * n + i] = o.z;
}`;

/**
 * GPU path on `device` (must be ORT's device so the buffer is usable as an input tensor).
 * `toBuffer(source, W, H) → GPUBuffer` holding float32 CHW; the buffer is reused per W×H, so the
 * caller must consume it (session.run) before the next call — the providers serialise frames.
 */
export function createGpuPreprocessor(device, { normalize } = {}) {
  const nm = normalize || IDENTITY;
  const G = /** @type {any} */ (globalThis);
  const module = device.createShaderModule({ code: WGSL });
  const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  const uniform = device.createBuffer({ size: 48, usage: G.GPUBufferUsage.UNIFORM | G.GPUBufferUsage.COPY_DST });
  let tex = null, texW = 0, texH = 0;
  /** @type {Map<string, any>} */
  const outs = new Map();

  function srcTexture(w, h) {
    if (!tex || texW !== w || texH !== h) {
      if (tex) tex.destroy();
      tex = device.createTexture({
        size: [w, h], format: 'rgba8unorm',
        usage: G.GPUTextureUsage.TEXTURE_BINDING | G.GPUTextureUsage.COPY_DST | G.GPUTextureUsage.RENDER_ATTACHMENT,
      });
      texW = w; texH = h;
    }
    return tex;
  }

  return {
    kind: 'gpu',
    toBuffer(source, W, H) {
      const [sw, sh] = sourceSize(source);
      if (!sw || !sh) throw new Error('lift preprocess: source has no size yet (video not loaded?)');
      const t = srcTexture(sw, sh);
      device.queue.copyExternalImageToTexture({ source }, { texture: t }, [sw, sh]);
      const key = `${W}x${H}`;
      let out = outs.get(key);
      if (!out) {
        const buffer = device.createBuffer({
          size: 3 * W * H * 4,
          usage: G.GPUBufferUsage.STORAGE | G.GPUBufferUsage.COPY_SRC | G.GPUBufferUsage.COPY_DST,
        });
        const bind = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: t.createView() },
            { binding: 1, resource: sampler },
            { binding: 2, resource: { buffer } },
            { binding: 3, resource: { buffer: uniform } },
          ],
        });
        out = { buffer, bind, tex: t };
        outs.set(key, out);
      }
      if (out.tex !== t) { // source size changed → rebind the new texture
        out.bind = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: t.createView() },
            { binding: 1, resource: sampler },
            { binding: 2, resource: { buffer: out.buffer } },
            { binding: 3, resource: { buffer: uniform } },
          ],
        });
        out.tex = t;
      }
      const u = new ArrayBuffer(48);
      new Uint32Array(u, 0, 2).set([W, H]);
      new Float32Array(u, 16, 8).set([...nm.mean, 0, ...nm.std.map((s) => 1 / s), 1]);
      device.queue.writeBuffer(uniform, 0, u);
      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, out.bind);
      pass.dispatchWorkgroups(Math.ceil(W / 8), Math.ceil(H / 8));
      pass.end();
      device.queue.submit([enc.finish()]);
      return out.buffer;
    },
    dispose() {
      for (const o of outs.values()) o.buffer.destroy();
      outs.clear();
      if (tex) tex.destroy();
      tex = null;
      uniform.destroy();
    },
  };
}

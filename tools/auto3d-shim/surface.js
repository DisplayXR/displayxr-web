// DisplayXR auto-3D — the per-graphics-API SURFACE seam. PROTOTYPE, not a product.
//
// `function dxrSurface(core)`, a part of the core bundle (build.mjs). Everything the core does that
// depends on the canvas's graphics API, and nothing else, sits behind one object per canvas:
//
//   surface = {
//     kind            'webgl' | 'webgpu' (HUD / state() / reports)
//     limit()         the largest 2D size the store may have on this context (each axis), or Infinity
//     flush()         makes everything the engine has encoded for this frame visible to a read made NOW
//                     (WebGL: nothing to do; WebGPU: the engine's pending command buffers are submitted)
//     readEye(st, target)
//                     the LEFT eye (store rect 0,0,eyeW,eyeH) of the frame just drawn, into the 2D canvas
//                     `target`, scaled to it, forced opaque. Must be called in the task that drew it.
//                     Returns true / false (WebGL, synchronous) or a Promise of true / false (WebGPU:
//                     the copy is mapped asynchronously).
//     readFrame(st, target)
//                     the WHOLE store (the mono frame just drawn: the go-live cover), the same way, or
//                     false when the caller's own drawImage() of the canvas is the right read (WebGL,
//                     in the drawing task). WebGPU always reads back: after the frame presents,
//                     drawImage() of a WebGPU canvas into a GPU-backed 2D canvas is EMPTY (P-W0 probe,
//                     Chrome 154), so neither cover is ever taken from drawImage / toDataURL there.
//     async           true when readEye / readFrame resolve later (the core then holds the flip until
//                     the go-live cover has its pixels, and the out-cover until its read lands)
//     toClip(projGL, out)
//                     the projection the ENGINE gets for an eye, from the runtime's projection. The
//                     runtime's XRView.projectionMatrix is GL clip space (z -1..1): the inline-3d session's
//                     graphics API stays WebGL unless it asked for the 'webgpu' feature, and we do not.
//                     WebGL: the matrix itself. WebGPU (clip z 0..1): z row := (z row + w row) / 2, the
//                     depth-range matrix PlayCanvas (Camera.applyShaderProjectionTransform) and three
//                     (WebGPUCoordinateSystem) apply to their own projections. Without it everything
//                     nearer than 2 x near is clipped and half the depth range is wasted. Frustum maths
//                     (fov / near / far read back from the matrix) keeps using the GL matrix.
//   }
//
// Adapters return one from `ad.surface(st)` (the core caches it on st.surf): `core.surfaces.gl(gl)` or
// `core.surfaces.gpu({ device, context, flush, alphaMode })`. A third API (or three.js's
// WebGPURenderer, which can run either backend) is one more factory here, or a choice between the two.
function dxrSurface(core) {
  const { warnOnce } = core;

  // ------------------------------------------------------------ WebGL
  // Copies the LEFT eye (store rect 0,0,eyeW,eyeH) of the default framebuffer's CURRENT contents into
  // the 2D canvas `target`, scaled to it, forced opaque. Must run in the task that drew it (the pages'
  // preserveDrawingBuffer is false). Leaves every GL binding / pack parameter it touches as it found it.
  // false = could not (no context, lost, readPixels threw, or the read came back all zero).
  function readGlEye(gl, st, target) {
    if (!gl || !st.R || typeof gl.readPixels !== 'function' || (gl.isContextLost && gl.isContextLost())) return false;
    const bw = gl.drawingBufferWidth, bh = gl.drawingBufferHeight;
    const w = Math.min(st.R.eyeW, bw), h = Math.min(st.R.eyeH, bh);
    if (!(w > 0 && h > 0)) return false;
    const gl2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
    const px = new Uint8Array(w * h * 4);
    const fb = gl.getParameter(gl.FRAMEBUFFER_BINDING); // WebGL2: the DRAW binding
    const rfb = gl2 ? gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) : null;
    const pack = gl.getParameter(gl.PACK_ALIGNMENT);
    const pbo = gl2 ? gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING) : null;
    const p2 = gl2 ? [gl.PACK_ROW_LENGTH, gl.PACK_SKIP_PIXELS, gl.PACK_SKIP_ROWS].map((k) => [k, gl.getParameter(k)]) : [];
    try {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (pack !== 4) gl.pixelStorei(gl.PACK_ALIGNMENT, 4);
      if (pbo) gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      for (const [k, v] of p2) if (v) gl.pixelStorei(k, 0);
      // GL origin is bottom-left: the store's top rows (canvas y 0..h) are GL rows bh-h..bh.
      gl.readPixels(0, bh - h, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    } catch (e) { return false; } finally {
      for (const [k, v] of p2) if (v) gl.pixelStorei(k, v);
      if (pbo) gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
      if (pack !== 4) gl.pixelStorei(gl.PACK_ALIGNMENT, pack);
      if (gl2) { gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fb); gl.bindFramebuffer(gl.READ_FRAMEBUFFER, rfb); }
      else gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    }
    let any = 0;
    for (let i = 0; i < px.length; i += 4) { any |= px[i] | px[i + 1] | px[i + 2] | px[i + 3]; px[i + 3] = 255; }
    if (!any) return false; // an all-zero read is a cleared buffer, not a picture
    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    tmp.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px.buffer), w, h), 0, 0);
    const g = target.getContext('2d');
    g.save();
    g.translate(0, target.height); g.scale(1, -1); // flip: the read is bottom-up
    g.drawImage(tmp, 0, 0, w, h, 0, 0, target.width, target.height);
    g.restore();
    return true;
  }
  function gl(ctx) {
    let lim;
    return {
      kind: 'webgl',
      limit() {
        if (lim === undefined) {
          let v = Infinity;
          try { const vp = ctx.getParameter(ctx.MAX_VIEWPORT_DIMS); v = Math.min(ctx.getParameter(ctx.MAX_TEXTURE_SIZE), ctx.getParameter(ctx.MAX_RENDERBUFFER_SIZE), vp[0], vp[1]); } catch (e) { v = Infinity; }
          lim = v > 0 ? v : Infinity; // a context's limits do not change
        }
        return lim;
      },
      flush() {}, // the default framebuffer is readable as drawn, in the drawing task
      readEye: (st, target) => readGlEye(ctx, st, target),
      readFrame: () => false, // the core's drawImage of the canvas, in the drawing task
      async: false,
      toClip: (m) => m,
    };
  }

  // ------------------------------------------------------------ WebGPU
  // z row := (z row + w row) / 2, column-major: GL clip z -1..1 -> WebGPU clip z 0..1. `out` gets the
  // result (a Float32Array / Float64Array of 16, or anything with numeric indices).
  function toClipGpu(m, out) {
    for (let c = 0; c < 4; c++) {
      out[c * 4] = m[c * 4]; out[c * 4 + 1] = m[c * 4 + 1];
      out[c * 4 + 2] = 0.5 * (m[c * 4 + 2] + m[c * 4 + 3]);
      out[c * 4 + 3] = m[c * 4 + 3];
    }
    return out;
  }
  // The left eye (or, full = true, the whole store) of the canvas's CURRENT texture (the frame just drawn; it expires when the task ends
  // and the canvas presents), copied to a mappable buffer in this task and read once mapped. No Y flip
  // (WebGPU's origin is top-left); bytesPerRow 256-aligned; bgra -> rgba; premultiplied -> straight;
  // forced opaque. Needs COPY_SRC on the canvas texture (PlayCanvas and three configure it); without
  // it, or on a format this reads no bytes of (rgba16float), false: the core keeps the drawImage still.
  function readGpuEye(o, st, target, full) {
    const { device, context } = o;
    if (!device || !context || (!full && !st.R) || typeof context.getCurrentTexture !== 'function') return false;
    let tex = null;
    try { tex = context.getCurrentTexture(); } catch (e) { return false; }
    const U = typeof GPUTextureUsage !== 'undefined' ? GPUTextureUsage : null;
    if (!tex || !U || !(tex.usage & U.COPY_SRC)) { warnOnce('gpu-copysrc', 'WebGPU canvas without COPY_SRC: no cover read-back (covers via drawImage in the drawing task)'); return false; }
    const fmt = String(tex.format || '');
    const bgra = /^bgra8unorm/.test(fmt);
    if (!bgra && !/^rgba8unorm/.test(fmt)) { warnOnce('gpu-format', `WebGPU canvas format ${fmt} (HDR?): no cover read-back, the covers may be blank`); return false; }
    const w = full ? tex.width : Math.min(st.R.eyeW, tex.width), h = full ? tex.height : Math.min(st.R.eyeH, tex.height);
    if (!(w > 0 && h > 0)) return false;
    const bpr = Math.ceil((w * 4) / 256) * 256;
    let buf = null;
    try {
      o.flush(); // the engine's commands for this frame are queued before the copy
      buf = device.createBuffer({ size: bpr * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const enc = device.createCommandEncoder();
      enc.copyTextureToBuffer({ texture: tex, origin: { x: 0, y: 0, z: 0 } }, { buffer: buf, bytesPerRow: bpr, rowsPerImage: h }, { width: w, height: h, depthOrArrayLayers: 1 });
      device.queue.submit([enc.finish()]);
    } catch (e) { if (buf) { try { buf.destroy(); } catch (e2) { /* ignore */ } } return false; }
    const premul = o.alphaMode === 'premultiplied';
    return buf.mapAsync(GPUMapMode.READ).then(() => {
      const src = new Uint8Array(buf.getMappedRange());
      const px = new Uint8ClampedArray(w * h * 4);
      let any = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0, s = y * bpr, d = y * w * 4; x < w; x++, s += 4, d += 4) {
          let r = src[s], g = src[s + 1], b = src[s + 2];
          const a = src[s + 3];
          if (bgra) { const t = r; r = b; b = t; }
          if (premul && a > 0 && a < 255) { r = (r * 255) / a; g = (g * 255) / a; b = (b * 255) / a; }
          any |= r | g | b | a;
          px[d] = r; px[d + 1] = g; px[d + 2] = b; px[d + 3] = 255;
        }
      }
      buf.unmap(); buf.destroy();
      if (!any) return false; // a cleared texture, not a picture
      const tmp = document.createElement('canvas');
      tmp.width = w; tmp.height = h;
      tmp.getContext('2d').putImageData(new ImageData(px, w, h), 0, 0);
      const g = target.getContext('2d');
      g.clearRect(0, 0, target.width, target.height);
      g.drawImage(tmp, 0, 0, w, h, 0, 0, target.width, target.height);
      return true;
    }, () => { try { buf.destroy(); } catch (e) { /* ignore */ } return false; });
  }
  // o = { device: GPUDevice, context: GPUCanvasContext, flush?: () => void, alphaMode? }
  function gpu(o) {
    const s = {
      kind: 'webgpu',
      // The DEVICE's limit, not the adapter's: a canvas texture over it fails getCurrentTexture(). WebGPU
      // has no separate viewport maximum (a viewport lies inside its attachment).
      limit() { const v = o.device && o.device.limits && o.device.limits.maxTextureDimension2D; return v > 0 ? v : 8192; },
      flush() { if (typeof o.flush === 'function') { try { o.flush(); } catch (e) { warnOnce('gpu-flush', 'could not submit the frame before a read', e); } } },
      readEye: (st, target) => readGpuEye({ ...o, flush: s.flush }, st, target, false),
      readFrame: (st, target) => readGpuEye({ ...o, flush: s.flush }, st, target, true),
      async: true,
      toClip: toClipGpu,
    };
    return s;
  }

  return { gl, gpu, readGlEye, toClipGpu };
}

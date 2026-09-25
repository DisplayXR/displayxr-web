// gl.js — the smallest WebGL2 "image-processing" runner lift-gen needs.
//
// EXPERIMENTAL, internal to ./lift-gen.js.
//
// WHY WEBGL2 AND NOT WEBGPU. Every pass in the generator is a gather over a neighbourhood of one
// output pixel — an upsample, a min-filter, a directional search, a push-pull level. That is
// exactly a fragment shader, and WebGL2 + EXT_color_buffer_float is available on every browser
// the SDK targets (including the DisplayXR Browser's Android build and Safari), where WebGPU is
// not yet. Nothing here needs shared memory or atomics, so compute buys nothing but reach lost.
//
// Everything is float: R32F / RGBA32F render targets (EXT_color_buffer_float is REQUIRED and
// checked), fetched with texelFetch only — no filtering, so OES_texture_float_linear is never
// needed and every tap is exact.

const VS = `#version 300 es
void main() {
  // one full-screen triangle, no attributes
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/** Common GLSL prelude every pass gets. */
export const PRELUDE = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
// clamp-to-edge integer fetch
vec4 tap(sampler2D t, ivec2 p) {
  ivec2 s = textureSize(t, 0);
  return texelFetch(t, clamp(p, ivec2(0), s - 1), 0);
}
`;

const FORMATS = {
  r32f: { internal: 'R32F', format: 'RED', type: 'FLOAT', bytes: 4, ch: 1 },
  rgba32f: { internal: 'RGBA32F', format: 'RGBA', type: 'FLOAT', bytes: 16, ch: 4 },
  rgba8: { internal: 'RGBA8', format: 'RGBA', type: 'UNSIGNED_BYTE', bytes: 4, ch: 4 },
};

export class GLRunner {
  constructor() {
    let gl;
    {
      const c =
        typeof OffscreenCanvas === 'function'
          ? new OffscreenCanvas(1, 1)
          : Object.assign(document.createElement('canvas'), { width: 1, height: 1 });
      gl = c.getContext('webgl2', { antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false });
    }
    if (!gl) throw new Error('lift-gen: WebGL2 is not available');
    if (!gl.getExtension('EXT_color_buffer_float')) {
      throw new Error('lift-gen: EXT_color_buffer_float is not available (float render targets are required)');
    }
    this.gl = gl;
    this.vao = gl.createVertexArray();
    this.fbo = gl.createFramebuffer();
    this.programs = new Map();
    this.textures = new Set();
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  }

  /**
   * @param {number} w @param {number} h
   * @param {'r32f'|'rgba32f'|'rgba8'} fmt
   * @param {ArrayBufferView|TexImageSource|null} [data]
   */
  texture(w, h, fmt, data = null) {
    const gl = this.gl;
    const f = FORMATS[fmt];
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl[f.internal], w, h);
    if (data) {
      if (ArrayBuffer.isView(data)) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl[f.format], gl[f.type], data);
      else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl[f.format], gl[f.type], data);
    }
    const tex = { t, w, h, fmt };
    this.textures.add(tex);
    return tex;
  }

  free(...texs) {
    for (const tex of texs) {
      if (!tex || !this.textures.has(tex)) continue;
      this.gl.deleteTexture(tex.t);
      this.textures.delete(tex);
    }
  }

  program(key, fs) {
    let p = this.programs.get(key);
    if (p) return p;
    const gl = this.gl;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        throw new Error(`lift-gen: shader "${key}" failed to compile:\n${gl.getShaderInfoLog(s)}`);
      }
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, PRELUDE + fs));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(`lift-gen: program "${key}" failed to link:\n${gl.getProgramInfoLog(prog)}`);
    }
    const uniforms = new Map();
    const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(prog, i);
      uniforms.set(info.name, { loc: gl.getUniformLocation(prog, info.name), type: info.type });
    }
    p = { prog, uniforms };
    this.programs.set(key, p);
    return p;
  }

  /**
   * Run one full-screen pass.
   * @param {string} key  program cache key (the pass name)
   * @param {string} fs   fragment source (without prelude)
   * @param {object|object[]} out  target texture(s) (MRT when an array)
   * @param {object} [inputs]  { uniformName: texture | number | number[] | boolean }
   */
  pass(key, fs, out, inputs = {}) {
    const gl = this.gl;
    const { prog, uniforms } = this.program(key, fs);
    const outs = Array.isArray(out) ? out : [out];
    gl.useProgram(prog);
    gl.bindVertexArray(this.vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    const bufs = [];
    outs.forEach((o, i) => {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, o.t, 0);
      bufs.push(gl.COLOR_ATTACHMENT0 + i);
    });
    // detach any stale attachments from a previous MRT pass
    for (let i = outs.length; i < 4; i++) gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, null, 0);
    gl.drawBuffers(bufs);
    let unit = 0;
    for (const [name, v] of Object.entries(inputs)) {
      const u = uniforms.get(name);
      if (!u) continue; // optimised out
      if (v && typeof v === 'object' && 't' in v) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, v.t);
        gl.uniform1i(u.loc, unit++);
      } else {
        const a = Array.isArray(v) ? v : [typeof v === 'boolean' ? +v : v];
        switch (u.type) {
          case gl.FLOAT: gl.uniform1f(u.loc, a[0]); break;
          case gl.FLOAT_VEC2: gl.uniform2f(u.loc, a[0], a[1]); break;
          case gl.FLOAT_VEC3: gl.uniform3f(u.loc, a[0], a[1], a[2]); break;
          case gl.FLOAT_VEC4: gl.uniform4f(u.loc, a[0], a[1], a[2], a[3]); break;
          case gl.INT: case gl.BOOL: gl.uniform1i(u.loc, a[0]); break;
          case gl.INT_VEC2: gl.uniform2i(u.loc, a[0], a[1]); break;
          case gl.INT_VEC4: gl.uniform4i(u.loc, a[0], a[1], a[2], a[3]); break;
          default: throw new Error(`lift-gen: uniform ${name} has an unsupported type`);
        }
      }
    }
    gl.viewport(0, 0, outs[0].w, outs[0].h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Read a float/rgba8 texture (or a sub-rect) back as RGBA. */
  read(tex, x = 0, y = 0, w = tex.w, h = tex.h) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex.t, 0);
    for (let i = 1; i < 4; i++) gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, null, 0);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    const isByte = tex.fmt === 'rgba8';
    const outArr = isByte ? new Uint8Array(w * h * 4) : new Float32Array(w * h * 4);
    gl.readPixels(x, y, w, h, gl.RGBA, isByte ? gl.UNSIGNED_BYTE : gl.FLOAT, outArr);
    return outArr;
  }

  /** Block until the GPU has drained (for per-stage timing only). */
  sync() {
    const gl = this.gl;
    const s = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    gl.clientWaitSync(s, gl.SYNC_FLUSH_COMMANDS_BIT, 0);
    // clientWaitSync with timeout 0 only polls; a 1-texel readback is the portable hard sync.
    const px = new Float32Array(4);
    const any = [...this.textures].find((t) => t.fmt !== 'rgba8');
    if (any) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, any.t, 0);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, px);
    }
    gl.deleteSync(s);
  }

  dispose() {
    const gl = this.gl;
    for (const t of this.textures) gl.deleteTexture(t.t);
    this.textures.clear();
    for (const p of this.programs.values()) gl.deleteProgram(p.prog);
    this.programs.clear();
    gl.deleteFramebuffer(this.fbo);
    gl.deleteVertexArray(this.vao);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

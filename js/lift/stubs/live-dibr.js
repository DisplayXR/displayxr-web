// lift/stubs/live-dibr.js — STUB of js/lift/live-dibr.js (A3).
//
// Same contract: createLiveDibr({canvas}) → { setSource, setDepth, setParams, render, dispose }.
// A one-pass backward warp (uv.x += eye·depth·(d − convergence)) — crude, holes smear, but it
// exercises the real path: source upload, depth upload, and one draw per view into
// layer.getViewport(view). With a single (mono / 2D-fallback) view it adds a slow sideways wobble
// so the 2D page visibly shows the pipeline running.

import { getGL, program, disparityToBytes, eyeFactor } from './gl.js';

const VS = `#version 300 es
out vec2 v_uv;
void main(){ vec2 p = vec2((gl_VertexID<<1)&2, gl_VertexID&2); v_uv = p; gl_Position = vec4(p*2.0-1.0,0.0,1.0); }`;
const FS = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D u_src, u_depth; uniform float u_shift, u_conv, u_hasDepth;
void main(){
  float d = u_hasDepth > 0.5 ? texture(u_depth, v_uv).r : u_conv;
  vec2 uv = v_uv + vec2(u_shift * (d - u_conv), 0.0);
  o = texture(u_src, clamp(uv, vec2(0.0), vec2(1.0)));
  o.a = 1.0;
}`;

export function createLiveDibr({ canvas }) {
  const gl = getGL(canvas);
  const prog = program(gl, VS, FS);
  const vao = gl.createVertexArray();
  const u = (n) => gl.getUniformLocation(prog, n);
  const U = { src: u('u_src'), depth: u('u_depth'), shift: u('u_shift'), conv: u('u_conv'), hasDepth: u('u_hasDepth') };
  const mkTex = () => {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  };
  const texSrc = mkTex();
  const texDepth = mkTex();
  let source = null;
  let hasDepth = false;
  const params = { depth: 1, convergence: 'auto', dilate: 0 };
  const t0 = performance.now();

  return {
    setSource(el) {
      source = el;
    },
    setDepth({ data, w, h }) {
      gl.bindTexture(gl.TEXTURE_2D, texDepth);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); // raw buffers ignore FLIP_Y; flipped in-shader via row order below
      const bytes = disparityToBytes(data);
      // Rows arrive top-first; GL's v=0 is the bottom. Flip rows on the CPU.
      const flipped = new Uint8Array(bytes.length);
      for (let y = 0; y < h; y++) flipped.set(bytes.subarray(y * w, (y + 1) * w), (h - 1 - y) * w);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, flipped);
      hasDepth = true;
    },
    setParams(p) {
      Object.assign(params, p);
    },
    render({ views, layer }) {
      if (!source) return;
      gl.bindTexture(gl.TEXTURE_2D, texSrc);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      } catch {
        return; // no frame yet
      }
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.useProgram(prog);
      gl.bindVertexArray(vao);
      gl.disable(gl.BLEND);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texSrc);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, texDepth);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform1i(U.src, 0);
      gl.uniform1i(U.depth, 1);
      gl.uniform1f(U.conv, typeof params.convergence === 'number' ? params.convergence : 0.5);
      gl.uniform1f(U.hasDepth, hasDepth ? 1 : 0);
      const n = views.length;
      const wobble = n === 1 ? Math.sin((performance.now() - t0) / 600) : 0;
      for (let i = 0; i < n; i++) {
        const vp = layer.getViewport(views[i]);
        gl.viewport(vp.x, vp.y, vp.width, vp.height);
        const e = n > 1 ? eyeFactor(i, n) : wobble;
        gl.uniform1f(U.shift, 0.03 * params.depth * e);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
    },
    dispose() {
      gl.deleteTexture(texSrc);
      gl.deleteTexture(texDepth);
      gl.deleteProgram(prog);
      gl.deleteVertexArray(vao);
      source = null;
    },
  };
}

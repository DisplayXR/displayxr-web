// lift/stubs/explore.js — STUB of js/lift/explore.js (A5). Point sprites, not Gaussians.
//
// Same contract: createExplore({canvas, ply, meta, orbit:{maxAngleDeg, relax}})
//   → { render({views, layer, session}), onPointerDown/Move/Up(ev), setTarget(yaw,pitch), fadeIn(ms), dispose() }
// plus a NON-contract fadeOut(ms) that lift.js uses when present. Parses the binary PLY (x,y,z,
// f_dc_*, opacity) and draws round points orbiting about (0,0,pivotZ). Stereo views get a ±3 cm
// eye offset; a lone mono view gets a slow idle sway so the 2D fallback visibly moves.

import { getGL, program, eyeFactor } from './gl.js';

const SH_C0 = 0.28209479177387814;

export function parsePly(buf) {
  const bytes = new Uint8Array(buf);
  const end = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 4096))).indexOf('end_header\n');
  if (end < 0) throw new Error('explore stub: not a PLY');
  const header = new TextDecoder().decode(bytes.subarray(0, end));
  const count = +(/element vertex (\d+)/.exec(header) || [])[1];
  const props = [...header.matchAll(/property float (\S+)/g)].map((m) => m[1]);
  const stride = props.length;
  const f = new Float32Array(buf.slice(end + 'end_header\n'.length));
  const at = (name) => props.indexOf(name);
  const ix = at('x'), iy = at('y'), iz = at('z'), ir = at('f_dc_0'), ig = at('f_dc_1'), ib = at('f_dc_2'), io = at('opacity');
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const o = i * stride;
    pos.set([f[o + ix], f[o + iy], f[o + iz]], i * 3);
    const a = io >= 0 ? 1 / (1 + Math.exp(-f[o + io])) : 1;
    col.set([0.5 + SH_C0 * f[o + ir], 0.5 + SH_C0 * f[o + ig], 0.5 + SH_C0 * f[o + ib], a], i * 4);
  }
  return { count, pos, col };
}

const VS = `#version 300 es
layout(location=0) in vec3 a_pos; layout(location=1) in vec4 a_col;
uniform mat3 u_rot; uniform float u_pivot, u_f, u_eye, u_ptSize; uniform vec2 u_half;
out vec4 v_col;
void main(){
  vec3 p = a_pos - vec3(0.0,0.0,u_pivot);
  p = u_rot * p; p.z += u_pivot; p.x -= u_eye;
  gl_Position = vec4((p.x*u_f/p.z)/u_half.x, -(p.y*u_f/p.z)/u_half.y, 0.5 - 0.1/p.z, 1.0);
  gl_PointSize = u_ptSize * (u_pivot / p.z);
  v_col = a_col;
}`;
const FS = `#version 300 es
precision mediump float; in vec4 v_col; uniform float u_alpha; out vec4 o;
void main(){ vec2 c = gl_PointCoord*2.0-1.0; if(dot(c,c)>1.0) discard; float a = v_col.a*u_alpha; o = vec4(v_col.rgb*a, a); }`;

export function createExplore({ canvas, ply, meta, orbit = {} }) {
  const gl = getGL(canvas);
  const prog = program(gl, VS, FS);
  const { count, pos, col } = parsePly(ply);
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const b0 = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, b0);
  gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
  const b1 = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, b1);
  gl.bufferData(gl.ARRAY_BUFFER, col, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  const u = (n) => gl.getUniformLocation(prog, n);
  const U = { rot: u('u_rot'), pivot: u('u_pivot'), f: u('u_f'), eye: u('u_eye'), pt: u('u_ptSize'), half: u('u_half'), alpha: u('u_alpha') };

  const maxRad = ((orbit.maxAngleDeg ?? 15) * Math.PI) / 180;
  const relax = orbit.relax !== false;
  let yaw = 0, pitch = 0, tYaw = 0, tPitch = 0;
  let drag = null;
  let fadeFrom = 1, fadeTo = 1, fadeT0 = 0, fadeMs = 0;
  let lastInput = -1e9;
  const clamp = (v) => Math.max(-maxRad, Math.min(maxRad, v));
  const now = () => performance.now();
  const alpha = () => {
    if (!fadeMs) return fadeTo;
    const k = Math.min(1, (now() - fadeT0) / fadeMs);
    return fadeFrom + (fadeTo - fadeFrom) * k * k * (3 - 2 * k);
  };

  return {
    render({ views, layer }) {
      // views: null = the 2D fallback's flat path (the real explore's contract): one mono view, whole canvas.
      if (!views) {
        views = [{ eye: 'none' }];
        layer = { getViewport: () => ({ x: 0, y: 0, width: canvas.width, height: canvas.height }) };
      }
      const idle = now() - lastInput > 1500 && !drag;
      if (idle && views.length === 1) tYaw = maxRad * 0.35 * Math.sin(now() / 900);
      else if (idle && relax) (tYaw = 0), (tPitch = 0);
      yaw += (tYaw - yaw) * 0.12;
      pitch += (tPitch - pitch) * 0.12;
      const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
      // R = Rx(pitch) * Ry(yaw), column-major
      const rot = new Float32Array([cy, sp * sy, -cp * sy, 0, cp, sp, sy, -sp * cy, cp * cy]);
      const a = alpha();
      gl.useProgram(prog);
      gl.bindVertexArray(vao);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniformMatrix3fv(U.rot, false, rot);
      gl.uniform1f(U.pivot, meta.pivotZ);
      gl.uniform1f(U.f, meta.focalPx);
      gl.uniform2f(U.half, meta.w / 2, meta.h / 2);
      gl.uniform1f(U.alpha, a);
      const n = views.length;
      for (let i = 0; i < n; i++) {
        const vp = layer.getViewport(views[i]);
        gl.viewport(vp.x, vp.y, vp.width, vp.height);
        if (a >= 1) {
          gl.enable(gl.SCISSOR_TEST);
          gl.scissor(vp.x, vp.y, vp.width, vp.height);
          gl.clearColor(0, 0, 0, 0);
          gl.clear(gl.COLOR_BUFFER_BIT);
          gl.disable(gl.SCISSOR_TEST);
        }
        gl.uniform1f(U.eye, 0.03 * eyeFactor(i, n));
        gl.uniform1f(U.pt, (vp.width / meta.w) * 1.6);
        gl.drawArrays(gl.POINTS, 0, count);
      }
      gl.disable(gl.BLEND);
      gl.bindVertexArray(null);
    },
    onPointerDown(ev) {
      drag = { x: ev.clientX, y: ev.clientY, yaw: tYaw, pitch: tPitch, w: ev.target?.clientWidth || 300 };
      lastInput = now();
    },
    onPointerMove(ev) {
      if (!drag) return;
      // Fraction of the canvas: a half-width swipe = the full maxAngle.
      tYaw = clamp(drag.yaw + ((ev.clientX - drag.x) / (drag.w / 2)) * maxRad);
      tPitch = clamp(drag.pitch + ((ev.clientY - drag.y) / (drag.w / 2)) * maxRad);
      lastInput = now();
    },
    onPointerUp() {
      drag = null;
      lastInput = now();
    },
    setTarget(y, p) {
      tYaw = clamp(y);
      tPitch = clamp(p);
      lastInput = now();
    },
    fadeIn(ms = 300) {
      fadeFrom = 0; fadeTo = 1; fadeT0 = now(); fadeMs = ms;
    },
    fadeOut(ms = 300) {
      fadeFrom = alpha(); fadeTo = 0; fadeT0 = now(); fadeMs = ms;
    },
    dispose() {
      gl.deleteBuffer(b0);
      gl.deleteBuffer(b1);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(prog);
    },
  };
}

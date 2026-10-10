// inline3d-splat-effects-wgsl.js — the WGSL twins of the splat effects (./inline3d-splat-effects.js)
// and of the SDK's other PlayCanvas shader pieces, for a PlayCanvas WebGPU device.
//
// PREVIEW TIER. Internal module: inline3d-splat-effects.js composes from it when the tile's device
// speaks WGSL (composeModifier(instances, 'wgsl'), getEffectChunks('wgsl')). Guide:
// docs/splat-effects.md §WGSL twins.
//
// ── The contract (PlayCanvas 2.22.3) ──────────────────────────────────────────────────────────
//
// The engine's WGSL `gsplatModifyVS` chunk is three functions:
//   fn modifySplatCenter(center: ptr<function, vec3f>)
//   fn modifySplatRotationScale(originalCenter: vec3f, modifiedCenter: vec3f,
//                               rotation: ptr<function, vec4f>, scale: ptr<function, vec3f>)
//   fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>)
// and the SAME source is included in four shaders:
//   - gsplatVS            (vertex; RASTER_CPU_SORT, the WebGL2 default's twin)
//   - compute-gsplat-projector (compute; RASTER_GPU_SORT — the WebGPU DEFAULT renderer): center →
//                          (opacity clip) → rotation/scale → covariance → colour, per splat ONCE
//                          for both eyes; uniforms come from `scene.gsplat.material.parameters`
//   - compute-gsplat-shadow-cull (compute; only with gsplat shadows)
//   - gsplatCopyToWorkbuffer (FRAGMENT; entity scope's setWorkBufferModifier({ wgsl }))
// so every body here is stage-agnostic: no derivatives, no textures, no barriers, no builtins.
// Uniforms are declared `uniform name: type;` and read as `uniform.name` — the engine's WGSL
// processor collects them into the material's (vertex/fragment) or `ub_compute` (compute) buffer.
// Per-splat state that the GLSL keeps in globals is `var<private>` here (per invocation).
//
// Every body is a line-for-line twin of its GLSL: the SAME uniform names (prefix + name, so the
// runner's setParameter calls do not change), the same math, the same early-outs. Differences
// that are the engine's, not the bodies', are in docs/splat-effects.md §WGSL twins.

import { FADE_TRANSMITTANCE_FLOOR } from './inline3d-splat-shared.js';

/** SHARP's per-layer gaussian count (768²) — the default of `order: 'layers'` (as the GLSL). */
const SHARP_LAYER_SIZE = 768 * 768;

// dxrFxHash / dxrFxNoise / dxrFxFbm: adapted from PlayCanvas engine
// scripts/esm/gsplat/shader-effect-dissolve.mjs @ v2.22.3 (its WGSL twin), MIT (THIRD_PARTY_NOTICES.md).
export const PRELUDE_WGSL = `
fn dxrFxHash(q: vec3f) -> f32 {
  var p = fract(q * vec3f(443.8975, 397.2973, 491.1871));
  p = p + dot(p, p.yzx + 19.19);
  return fract((p.x + p.y) * p.z);
}
fn dxrFxNoise(p: vec3f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(dxrFxHash(i + vec3f(0.0, 0.0, 0.0)), dxrFxHash(i + vec3f(1.0, 0.0, 0.0)), u.x),
        mix(dxrFxHash(i + vec3f(0.0, 1.0, 0.0)), dxrFxHash(i + vec3f(1.0, 1.0, 0.0)), u.x), u.y),
    mix(mix(dxrFxHash(i + vec3f(0.0, 0.0, 1.0)), dxrFxHash(i + vec3f(1.0, 0.0, 1.0)), u.x),
        mix(dxrFxHash(i + vec3f(0.0, 1.0, 1.0)), dxrFxHash(i + vec3f(1.0, 1.0, 1.0)), u.x), u.y),
    u.z);
}
fn dxrFxFbm(q: vec3f) -> f32 {
  var p = q;
  var sum = 0.0;
  var amp = 0.5;
  for (var i = 0; i < 3; i++) {
    sum += amp * dxrFxNoise(p);
    p *= 2.02;
    amp *= 0.5;
  }
  return sum / 0.875;
}
`;

const FLOOR = FADE_TRANSMITTANCE_FLOOR.toFixed(4);

/** `uniform.<P><name>` */
const ua = (P) => (n) => `uniform.${P}${n}`;

// The empty stages, shared by the bodies that do not touch them.
const noCenter = (P) => `fn ${P}center(c: ptr<function, vec3f>) {}\n`;
const noRs = (P) => `fn ${P}rs(oc: vec3f, mc: vec3f, r: ptr<function, vec4f>, sc: ptr<function, vec3f>) {}\n`;
const noColor = (P) => `fn ${P}color(c: vec3f, col: ptr<function, vec4f>) {}\n`;
const scaleByLambda = (P) => `fn ${P}rs(oc: vec3f, mc: vec3f, r: ptr<function, vec4f>, sc: ptr<function, vec3f>) { *sc = *sc * ${P}lambda; }\n`;

// ── the bodies (twins of EFFECTS[name].glsl) ──────────────────────────────────────────────────

const inflate = (P) => {
  const u = ua(P);
  return `
uniform ${P}amount: f32;
uniform ${P}s0: f32;
uniform ${P}O: vec3f;
uniform ${P}A: vec3f;
uniform ${P}D: f32;
var<private> ${P}lambda: f32;
fn ${P}center(c: ptr<function, vec3f>) {
  ${P}lambda = 1.0;
  if (${u('amount')} >= 1.0) { return; }
  let s = mix(${u('s0')}, 1.0, ${u('amount')});
  let v = *c - ${u('O')};
  let d = dot(v, ${u('A')});
  if (d <= 1e-4) { return; }
  ${P}lambda = (${u('D')} + (d - ${u('D')}) * s) / d;
  *c = ${u('O')} + v * ${P}lambda;
}
${scaleByLambda(P)}${noColor(P)}`;
};

const sweep = (P) => {
  const u = ua(P);
  return `
uniform ${P}amount: f32;
uniform ${P}C: vec3f;
uniform ${P}R: f32;
uniform ${P}B: f32;
uniform ${P}E: vec3f;
fn ${P}k(c: vec3f) -> f32 {
  let j = (dxrFxHash(c) - 0.5) * ${u('B')};
  return clamp((${u('R')} - length(c - ${u('C')}) + j) / ${u('B')}, 0.0, 1.0);
}
${noCenter(P)}fn ${P}rs(oc: vec3f, mc: vec3f, r: ptr<function, vec4f>, sc: ptr<function, vec3f>) {
  if (${u('amount')} >= 1.0) { return; }
  let k = ${P}k(oc);
  if (k <= 0.0) { *sc = vec3f(0.0); return; }
  *sc = *sc * mix(0.15, 1.0, k * k);
}
fn ${P}color(c: vec3f, col: ptr<function, vec4f>) {
  if (${u('amount')} >= 1.0) { return; }
  let k = ${P}k(c);
  if (k <= 0.0) { (*col).a = 0.0; return; }
  *col = vec4f((*col).rgb + ${u('E')} * (1.0 - k), (*col).a);
}
`;
};

// the coverage remap shared by fade (amount, k) and xfade (k only)
const coverageColor = (P, gate) => {
  const u = ua(P);
  return `fn ${P}color(c: vec3f, col: ptr<function, vec4f>) {
  if (${gate} >= 1.0) { return; }
  (*col).a = select(1.0 - pow(max(1.0 - (*col).a, ${FLOOR}), ${u('k')}), 0.0, ${u('k')} <= 0.0);
}
`;
};

const fade = (P) => `
uniform ${P}amount: f32;
uniform ${P}k: f32;
${noCenter(P)}${noRs(P)}${coverageColor(P, ua(P)('amount'))}`;

const xfade = (P) => `
uniform ${P}k: f32;
${noCenter(P)}${noRs(P)}${coverageColor(P, ua(P)('k'))}`;

const dissolve = (P) => {
  const u = ua(P);
  return `
uniform ${P}amount: f32;
uniform ${P}freq: f32;
uniform ${P}ew: f32;
uniform ${P}ec: vec3f;
uniform ${P}up: vec3f;
uniform ${P}lift: f32;
uniform ${P}wa: f32;
uniform ${P}wf: f32;
uniform ${P}time: f32;
// the burn keyed on the ORIGINAL centre, kept for the colour stage; -1 = not computed this splat
var<private> ${P}b: f32 = -1.0;
fn ${P}burn(c: vec3f, n: ptr<function, f32>) -> f32 {
  *n = dxrFxFbm(c * ${u('freq')});
  return clamp(((1.0 - ${u('amount')}) * (1.0 + ${u('ew')}) - *n) / ${u('ew')}, 0.0, 1.0);
}
fn ${P}center(c: ptr<function, vec3f>) {
  ${P}b = -1.0;
  if (${u('amount')} >= 1.0) { return; }
  var n: f32;
  let b = ${P}burn(*c, &n);
  ${P}b = b;
  if (b <= 0.0) { return; }
  let travel = b * b;
  var off = ${u('up')} * (travel * ${u('lift')});
  let phase = n * 43.7;
  off.x += sin((*c).y * ${u('wf')} + phase + ${u('time')} * 2.0) * ${u('wa')} * travel;
  off.z += cos((*c).x * ${u('wf')} + phase + ${u('time')} * 1.7) * ${u('wa')} * travel;
  *c = *c + off;
}
fn ${P}rs(oc: vec3f, mc: vec3f, r: ptr<function, vec4f>, sc: ptr<function, vec3f>) {
  if (${u('amount')} >= 1.0) { return; }
  var n: f32;
  let b = ${P}burn(oc, &n);
  if (b <= 0.0) { return; }
  if (b >= 1.0) { *sc = vec3f(0.0); return; }
  let size = gsplatGetSizeFromScale(*sc);
  *sc = mix(*sc, vec3f(size), min(b * 3.0, 1.0));
  *sc = *sc * (1.0 - b);
}
fn ${P}color(c: vec3f, col: ptr<function, vec4f>) {
  if (${u('amount')} >= 1.0) { return; }
  var b = ${P}b;
  if (b < 0.0) {
    var n: f32;
    b = ${P}burn(c, &n);
  }
  if (b <= 0.0) { return; }
  *col = vec4f(mix((*col).rgb, ${u('ec')}, smoothstep(0.0, 0.4, b)), (*col).a * (1.0 - smoothstep(0.5, 1.0, b)));
}
`;
};

const pulse = (P) => {
  const u = ua(P);
  return `
uniform ${P}C: vec3f;
uniform ${P}R: f32;
uniform ${P}B: f32;
uniform ${P}K: vec3f;
${noCenter(P)}${noRs(P)}fn ${P}color(c: vec3f, col: ptr<function, vec4f>) {
  let x = (length(c - ${u('C')}) - ${u('R')}) / ${u('B')};
  *col = vec4f((*col).rgb + ${u('K')} * exp(-x * x), (*col).a);
}
`;
};

const grade = (P) => {
  const u = ua(P);
  return `
uniform ${P}gain: f32;
uniform ${P}contrast: f32;
uniform ${P}sat: f32;
uniform ${P}tint: vec3f;
${noCenter(P)}${noRs(P)}fn ${P}color(c: vec3f, col: ptr<function, vec4f>) {
  var rgb = (*col).rgb * ${u('gain')};
  rgb = (rgb - 0.5) * ${u('contrast')} + 0.5;
  let l = dot(rgb, vec3f(0.2126, 0.7152, 0.0722));
  *col = vec4f(mix(vec3f(l), rgb, ${u('sat')}) * ${u('tint')}, (*col).a);
}
`;
};

const clip = (P) => {
  const u = ua(P);
  return `
uniform ${P}mode: f32;
uniform ${P}lo: vec3f;
uniform ${P}hi: vec3f;
uniform ${P}sc: vec3f;
uniform ${P}sr: f32;
uniform ${P}inv: f32;
fn ${P}out(c: vec3f) -> bool {
  var inside: bool;
  if (${u('mode')} < 0.5) {
    inside = all(c >= ${u('lo')}) && all(c <= ${u('hi')});
  } else {
    inside = length(c - ${u('sc')}) <= ${u('sr')};
  }
  return select(!inside, inside, ${u('inv')} > 0.5);
}
${noCenter(P)}fn ${P}rs(oc: vec3f, mc: vec3f, r: ptr<function, vec4f>, sc: ptr<function, vec3f>) { if (${P}out(oc)) { *sc = vec3f(0.0); } }
fn ${P}color(c: vec3f, col: ptr<function, vec4f>) { if (${P}out(c)) { (*col).a = 0.0; } }
`;
};

const wavefront = (P) => {
  const u = ua(P);
  return `
uniform ${P}amount: f32;
uniform ${P}band: f32;
uniform ${P}ridge: f32;
uniform ${P}capK: f32;
uniform ${P}O: vec3f;
uniform ${P}A: vec3f;
uniform ${P}X: vec3f;
uniform ${P}tanX: f32;
var<private> ${P}lambda: f32;
fn ${P}center(c: ptr<function, vec3f>) {
  ${P}lambda = 1.0;
  if (${u('amount')} >= 1.0) { return; }
  let v = *c - ${u('O')};
  let d = dot(v, ${u('A')});
  if (d <= 1e-4) { return; }
  let uu = 0.5 + 0.5 * dot(v, ${u('X')}) / (d * ${u('tanX')});
  let lt = clamp((${u('amount')} - uu * (1.0 - ${u('band')})) / ${u('band')}, 0.0, 1.0);
  let bump = min(${u('ridge')}, ${u('capK')} * d * d) * sin(lt * 3.14159265);
  ${P}lambda = (d - bump) / d;
  *c = ${u('O')} + v * ${P}lambda;
}
${scaleByLambda(P)}${noColor(P)}`;
};

const wipecull = (P) => {
  const u = ua(P);
  const views = [0, 1, 2, 3];
  return `
uniform ${P}on: f32;
uniform ${P}side: f32;
uniform ${P}edge: f32;
uniform ${P}n: f32;
${views.map((i) => `uniform ${P}V${i}: mat4x4f;\nuniform ${P}X${i}: vec4f;\nuniform ${P}W${i}: vec4f;\nuniform ${P}K${i}: vec4f;`).join('\n')}
var<private> ${P}cut: bool;
// true when some of the footprint may reach the kept side of the front in this view
fn ${P}reach(V: mat4x4f, X: vec4f, Wr: vec4f, K: vec4f, c: vec3f, s: f32) -> bool {
  let p = vec4f(c, 1.0);
  let v = V * p;
  let z = -v.z;
  let w = dot(Wr, p);
  if (z <= 1e-6 || w <= 1e-6) { return true; } // at or behind the eye: the engine decides
  let xn = dot(X, p) / w;
  let jz = K.x / z;
  let j2 = jz * jz * (1.0 + dot(v.xy, v.xy) / (z * z));
  let l1 = 2.0 * sqrt(2.0 * (j2 * K.z * s * s + 0.3));
  return ${u('side')} * (xn - ${u('edge')}) + (2.0 * l1 + 8.0) * K.y > 0.0;
}
${noCenter(P)}fn ${P}rs(oc: vec3f, mc: vec3f, r: ptr<function, vec4f>, sc: ptr<function, vec3f>) {
  ${P}cut = false;
  if (${u('on')} < 0.5) { return; }
  let s = max((*sc).x, max((*sc).y, (*sc).z));
${views.map((i) => `  if (${i > 0 ? `${u('n')} > ${i}.5 && ` : ''}${P}reach(${u('V' + i)}, ${u('X' + i)}, ${u('W' + i)}, ${u('K' + i)}, mc, s)) { return; }`).join('\n')}
  ${P}cut = true;
}
fn ${P}color(c: vec3f, col: ptr<function, vec4f>) { if (${P}cut) { (*col).a = 0.0; } }
`;
};

const envelope = (P) => {
  const u = ua(P);
  const rects = [0, 1, 2, 3, 4, 5, 6, 7];
  return `
uniform ${P}on: f32;
uniform ${P}O: vec3f;
uniform ${P}A: vec3f;
uniform ${P}R: vec3f;
uniform ${P}U: vec3f;
uniform ${P}T: vec4f;
uniform ${P}K: vec4f;
uniform ${P}S: vec4f;
uniform ${P}E: vec4f;
${rects.map((i) => `uniform ${P}F${i}: vec4f;`).join('\n')}
uniform ${P}W0: vec4f;
uniform ${P}W1: vec4f;
var<private> ${P}lambda: f32;
fn ${P}flat(f: vec2f, C: vec4f, w: f32) -> f32 {
  if (w <= 0.0 || C.x >= C.y || C.z >= C.w) { return 1.0; }
  let o = max(vec2f(max(C.x - f.x, f.x - C.y) * ${u('T')}.z, max(C.z - f.y, f.y - C.w) * ${u('T')}.w), vec2f(0.0));
  return mix(1.0, smoothstep(0.0, ${u('E')}.x, length(o)), w);
}
fn ${P}center(c: ptr<function, vec3f>) {
  ${P}lambda = 1.0;
  if (${u('on')} < 0.5) { return; }
  let v = *c - ${u('O')};
  let d = dot(v, ${u('A')});
  if (d <= 1e-4) { return; }
  let f = vec2f(dot(v, ${u('R')}) / (d * ${u('T')}.x), dot(v, ${u('U')}) / (d * ${u('T')}.y));
  let S = ${u('S')};
  let inside = min(min(f.x - S.x, S.y - f.x) * ${u('T')}.z, min(f.y - S.z, S.w - f.y) * ${u('T')}.w);
  var e = smoothstep(0.0, ${u('E')}.x, inside);
${rects.map((i) => `  e = min(e, ${P}flat(f, ${u('F' + i)}, ${u('W' + (i >> 2))}.${'xyzw'[i & 3]}));`).join('\n')}
  let F = ${u('E')}.y + max(${u('K')}.w - ${u('E')}.y, 0.0) * e;
  let invEnv = ${u('K')}.x + F / (${u('K')}.y * max(${u('K')}.z - F, 1e-3));
  if (1.0 / d <= invEnv) { return; }
  ${P}lambda = 1.0 / (invEnv * d);
  *c = ${u('O')} + v * ${P}lambda;
}
${scaleByLambda(P)}${noColor(P)}`;
};

// ── particle reveals (twins of particleCommon / particleColor / CURL_GLSL) ───────────────────

const orderWgsl = (P, order, layerSize) => {
  const u = ua(P);
  const radial = `clamp(length(vec2f(dot(v, ${u('X')}), dot(v, ${u('Y')})) / d - ${u('fimg')}) / ${u('rmax')}, 0.0, 1.0)`;
  switch (order) {
    case 'depth':
      return `k = clamp((d - ${u('dmin')}) / max(${u('dmax')} - ${u('dmin')}, 1e-4), 0.0, 1.0);`;
    case 'noise':
      return `k = clamp((dxrFxFbm(${P}iq(c) * ${u('freq')}) - 0.3) / 0.4, 0.0, 1.0);`;
    case 'random':
      return `k = ${P}h(c, 1.0);`;
    case 'layers':
      // splat.index: the asset's own FILE index in the work-buffer copy (entity scope only)
      return `k = 0.5 * min(f32(splat.index / ${layerSize >>> 0}u), 1.0) + 0.5 * ${radial};`;
    default:
      return `k = ${radial};`;
  }
};

const particleCommon = (P, o) => {
  const u = ua(P);
  return `
uniform ${P}amount: f32;
uniform ${P}time: f32;
uniform ${P}stagger: f32;
uniform ${P}jit: f32;
uniform ${P}O: vec3f;
uniform ${P}A: vec3f;
uniform ${P}X: vec3f;
uniform ${P}Y: vec3f;
uniform ${P}F: vec3f;
uniform ${P}fimg: vec2f;
uniform ${P}rmax: f32;
uniform ${P}dmin: f32;
uniform ${P}dmax: f32;
uniform ${P}freq: f32;
uniform ${P}capK: f32;
uniform ${P}dotK: f32;
uniform ${P}grow: f32;
uniform ${P}tx: f32;
uniform ${P}glow: vec3f;
uniform ${P}falpha: f32;
uniform ${P}van: f32;
uniform ${P}dens: f32;
var<private> ${P}lp: f32 = -1.0;
fn ${P}h(c: vec3f, s: f32) -> f32 { return dxrFxHash(c + vec3f(s * 17.13, s * 31.71, s * 7.31)); }
fn ${P}iq(c: vec3f) -> vec3f {
  let v = c - ${u('O')};
  let d = max(dot(v, ${u('A')}), 1e-4);
  return vec3f(dot(v, ${u('X')}) / (d * ${u('tx')}), dot(v, ${u('Y')}) / (d * ${u('tx')}), log(d));
}
fn ${P}unit(c: vec3f) -> f32 { return max(dot(c - ${u('O')}, ${u('A')}), 1e-4) * ${u('tx')}; }
fn ${P}local(c: vec3f) -> f32 {
  let v = c - ${u('O')};
  let d = max(dot(v, ${u('A')}), 1e-4);
  var k: f32;
  ${orderWgsl(P, o.order, o.layerSize)}
  k = mix(k, ${P}h(c, 1.0), ${u('jit')});
  return clamp((${u('amount')} - k * ${u('stagger')}) / max(1.0 - ${u('stagger')}, 1e-3), 0.0, 1.0);
}
fn ${P}near(home: vec3f, p: vec3f) -> vec3f {
  let dh = dot(home - ${u('O')}, ${u('A')});
  if (dh <= 1e-4) { return p; }
  let dn = dh / (1.0 + ${u('capK')} * dh);
  let v = p - ${u('O')};
  let d = dot(v, ${u('A')});
  if (d >= dn) { return p; }
  if (d <= 1e-3 * dh) { return p + ${u('A')} * (dn - d); }
  return ${u('O')} + v * (dn / d);
}
fn ${P}rot(v: vec3f, a: vec3f, t: f32) -> vec3f {
  let cs = cos(t);
  let sn = sin(t);
  return v * cs + cross(a, v) * sn + a * dot(a, v) * (1.0 - cs);
}
fn ${P}lpOf(c: vec3f) -> f32 {
  if (${P}lp >= 0.0) { return ${P}lp; }
  return ${P}local(c);
}
fn ${P}dot(lp: f32, mc: vec3f, sc: ptr<function, vec3f>, mul: f32) {
  let g = smoothstep(${u('grow')}, 1.0, lp);
  let d = max(dot(mc - ${u('O')}, ${u('A')}), 1e-4);
  let dsc = min(*sc, vec3f(${u('dotK')} * d * mul));
  *sc = mix(dsc, *sc, g);
}
`;
};

// in-flight colour; `extra` may read/write rgb, a, lp, g (the GLSL's col.rgb / col.a)
const particleColor = (P, extra = '') => {
  const u = ua(P);
  return `
fn ${P}color(c: vec3f, col: ptr<function, vec4f>) {
  if (${u('amount')} >= 1.0) { return; }
  let lp = ${P}lpOf(c);
  if (lp >= 1.0) { return; }
  let g = smoothstep(${u('grow')}, 1.0, lp);
  var rgb = (*col).rgb + ${u('glow')} * (1.0 - g);
  var a = (*col).a * mix(${u('falpha')}, 1.0, g);
  if (${u('van')} > 0.0) { a *= smoothstep(0.0, ${u('van')}, lp); }
  if (${u('dens')} < 1.0 && ${P}h(c, 9.0) > ${u('dens')}) { a *= g; }
  ${extra}
  *col = vec4f(rgb, a);
}
`;
};

const CURL_WGSL = (P) => `
fn ${P}curl(q: vec3f, t: f32) -> vec3f {
  return vec3f(
    -cos(q.z * 1.13 + t) + cos(q.y * 0.87 - 0.6 * t),
    -cos(q.x * 1.31 - t) + cos(q.z * 0.79 + 0.4 * t),
    -cos(q.y * 0.97 + 0.7 * t) + cos(q.x * 1.07 - 0.5 * t));
}
`;

// the rs stage every flying particle shares (`zeroAtStart`: converge / shimmer hide unlaunched ones)
const particleRs = (P, mul = '1.0', zeroAtStart = false) => `
fn ${P}rs(oc: vec3f, mc: vec3f, r: ptr<function, vec4f>, sc: ptr<function, vec3f>) {
  if (${ua(P)('amount')} >= 1.0) { return; }
  let lp = ${P}lpOf(oc);
  if (lp >= 1.0) { return; }
${zeroAtStart ? '  if (lp <= 0.0) { *sc = vec3f(0.0); return; }\n' : ''}  ${P}dot(lp, mc, sc, ${mul});
}
`;

// local progress cached by the centre stage (the GLSL's prologue)
const lpPrologue = (P) => `  ${P}lp = -1.0;
  if (${ua(P)('amount')} >= 1.0) { return; }
  let lp = ${P}local(*c);
  ${P}lp = lp;
  if (lp >= 1.0) { return; }`;

const PARTICLE_BODIES = {
  assemble: (P) => {
    const u = ua(P);
    return `
uniform ${P}spread: f32;
uniform ${P}swirl: f32;
uniform ${P}turb: f32;
uniform ${P}coh: f32;
uniform ${P}dep: f32;
${CURL_WGSL(P)}
fn ${P}center(c: ptr<function, vec3f>) {
${lpPrologue(P)}
  let tau = 1.0 - lp;
  let w = tau * tau;
  let home = *c;
  let un = ${P}unit(home);
  let r = vec3f(${P}h(home, 2.0), ${P}h(home, 3.0), ${P}h(home, 4.0)) * 2.0 - 1.0;
  let q = ${P}iq(home) * ${u('freq')};
  let n = vec3f(dxrFxNoise(q), dxrFxNoise(q + 19.1), dxrFxNoise(q + 47.3)) * 2.0 - 1.0;
  var dir = mix(r, n * 2.5, ${u('coh')});
  let dz = dot(dir, ${u('A')});
  dir = dir - ${u('A')} * dz + ${u('A')} * abs(dz) * ${u('dep')};
  dir = dir / max(length(dir), 1e-3);
  var p = home + dir * (${u('spread')} * un * (0.35 + 0.65 * ${P}h(home, 5.0)) * w);
  p = ${u('F')} + ${P}rot(p - ${u('F')}, ${u('A')}, ${u('swirl')} * w * tau * (0.5 + ${P}h(home, 6.0)));
  p = p + ${P}curl(q * 1.5 + dir * w * ${u('spread')} * 3.0, ${u('time')} * 0.8) * (${u('turb')} * un * w);
  *c = ${P}near(home, p);
}
${particleRs(P)}`;
  },

  'dissolve-in': (P) => {
    const u = ua(P);
    return `
uniform ${P}lift: f32;
uniform ${P}drift: f32;
${CURL_WGSL(P)}
fn ${P}center(c: ptr<function, vec3f>) {
${lpPrologue(P)}
  let tau = 1.0 - lp;
  let w = tau * tau;
  let home = *c;
  let un = ${P}unit(home);
  let q = ${P}iq(home) * ${u('freq')} * 0.7;
  let t = ${u('time')} * 0.25;
  var n = ${P}curl(q * 2.0, t * 4.0) * 0.5;
  let r = vec3f(${P}h(home, 3.0), ${P}h(home, 4.0), ${P}h(home, 5.0)) * 2.0 - 1.0;
  n = mix(n * 1.6, r, 0.65);
  n = n - ${u('A')} * dot(n, ${u('A')}) * 0.8;
  let wind = normalize(${u('Y')} + 0.35 * ${u('X')});
  let p = home + (wind * (${u('lift')} * (0.5 + ${P}h(home, 2.0))) + n * ${u('drift')} * 2.0) * (un * w);
  *c = ${P}near(home, p);
}
${particleRs(P)}`;
  },

  converge: (P) => {
    const u = ua(P);
    return `
uniform ${P}spin: f32;
uniform ${P}burst: f32;
fn ${P}center(c: ptr<function, vec3f>) {
${lpPrologue(P)}
  let tau = 1.0 - lp;
  let e = 1.0 - tau * tau;
  let home = *c;
  let b = (vec2f(${P}h(home, 3.0), ${P}h(home, 4.0)) * 2.0 - 1.0) * (${u('burst')} * ${u('tx')} * (1.0 - e));
  let fv = ${u('F')} - ${u('O')};
  let hv = home - ${u('O')};
  let fd = max(dot(fv, ${u('A')}), 1e-4);
  let hd = max(dot(hv, ${u('A')}), 1e-4);
  let fi = vec2f(dot(fv, ${u('X')}), dot(fv, ${u('Y')})) / fd;
  let hi = vec2f(dot(hv, ${u('X')}), dot(hv, ${u('Y')})) / hd;
  var im = mix(fi + b, hi, e);
  let ang = ${u('spin')} * (1.0 - e) * (0.6 + 0.8 * ${P}h(home, 2.0));
  im = ${u('fimg')} + mat2x2f(vec2f(cos(ang), sin(ang)), vec2f(-sin(ang), cos(ang))) * (im - ${u('fimg')});
  let d = mix(fd, hd, e);
  let p = ${u('O')} + (${u('A')} + ${u('X')} * im.x + ${u('Y')} * im.y) * d;
  *c = ${P}near(home, p);
}
${particleRs(P, '1.0', true)}`;
  },

  shimmer: (P) => {
    const u = ua(P);
    return `
uniform ${P}tw: f32;
uniform ${P}sp: f32;
uniform ${P}sc: vec3f;
fn ${P}twk(c: vec3f) -> f32 {
  let h = ${P}h(c, 3.0);
  return pow(0.5 + 0.5 * sin(${u('time')} * ${u('tw')} * (0.6 + 0.8 * h) + 6.2832 * ${P}h(c, 4.0)), 6.0);
}
fn ${P}center(c: ptr<function, vec3f>) {
  ${P}lp = -1.0;
  if (${u('amount')} >= 1.0) { return; }
  ${P}lp = ${P}local(*c);
}
${particleRs(P, `0.7 + 0.9 * ${P}twk(oc)`, true)}`;
  },
};

const PARTICLE_COLOR_EXTRA = {
  converge: () => 'a *= smoothstep(0.0, 0.15, lp);',
  shimmer: (P) => {
    const u = ua(P);
    return `let tw = ${P}twk(c);
  rgb = mix(rgb, ${u('sc')}, min(1.0, tw * ${u('sp')}) * (1.0 - g));
  a *= smoothstep(0.0, 0.12, lp) * mix(0.55 + 0.45 * tw, 1.0, g);`;
  },
};

const particle = (name) => (P, o = {}) => {
  const opts = { order: 'radial', layerSize: SHARP_LAYER_SIZE, ...o };
  return particleCommon(P, opts) + PARTICLE_BODIES[name](P, opts) + particleColor(P, PARTICLE_COLOR_EXTRA[name]?.(P) ?? '');
};

/**
 * The WGSL body of every built-in effect, `(P, opts) => source` — the twin of EFFECTS[name].glsl,
 * defining `P##center`, `P##rs`, `P##color` with the same uniforms.
 */
export const WGSL_BODIES = Object.freeze({
  inflate,
  deflate: inflate,
  sweep,
  fade,
  dissolve,
  pulse,
  grade,
  clip,
  wavefront,
  wipecull,
  envelope,
  xfade,
  assemble: particle('assemble'),
  'dissolve-in': particle('dissolve-in'),
  converge: particle('converge'),
  shimmer: particle('shimmer'),
});

// ── custom WGSL ───────────────────────────────────────────────────────────────────────────────

const HOOK_FNS_WGSL = [
  ['modifySplatCenter', 'center', 'fn %(c: ptr<function, vec3f>) {}'],
  ['modifySplatRotationScale', 'rs', 'fn %(oc: vec3f, mc: vec3f, r: ptr<function, vec4f>, sc: ptr<function, vec3f>) {}'],
  ['modifySplatColor', 'color', 'fn %(c: vec3f, col: ptr<function, vec4f>) {}'],
];

/**
 * A custom effect's WGSL body under prefix P: the engine-shaped functions renamed to
 * P##center/rs/color (missing ones stubbed). `dxrProgress` / `dxrTime` are rewritten to the
 * effect's own uniforms (WGSL has no #define substitution).
 */
export function customWgsl(P, wgsl) {
  let body = String(wgsl).replace(/\bdxrProgress\b/g, `uniform.${P}p`).replace(/\bdxrTime\b/g, `uniform.${P}t`);
  let out = `uniform ${P}p: f32;\nuniform ${P}t: f32;\n`;
  for (const [engineName, suffix, stub] of HOOK_FNS_WGSL) {
    const re = new RegExp(`\\b${engineName}\\b`, 'g');
    if (re.test(body)) body = body.replace(re, `${P}${suffix}`);
    else out += stub.replace('%', `${P}${suffix}`) + '\n';
  }
  return out + body + '\n';
}

/** Screen-space inputs a custom WGSL body may not read (the stereo rule), on top of the GLSL list. */
export const SCREEN_SPACE_WGSL = /\b(matrix_view|matrix_projection|matrix_viewProjection|viewport_size|view_position|uCameraPosition|camera_params|pcPosition)\b|@builtin/;

/**
 * The generated WGSL modifier from an ALREADY-ORDERED list of { name, P, body } (the runner sorts
 * by STAGE_ORDER, exactly as for GLSL). Same three entry points as the engine's default chunk.
 */
export function composeWgsl(list) {
  let code = '// generated by @displayxr/inline3d/splat (splat effects, WGSL)\n' + PRELUDE_WGSL;
  const calls = { center: [], rs: [], color: [] };
  for (const { name, stage, P, body } of list) {
    code += `// ── ${name} (${stage})\n` + body;
    calls.center.push(`  ${P}center(center);`);
    calls.rs.push(`  ${P}rs(originalCenter, modifiedCenter, rotation, scale);`);
    calls.color.push(`  ${P}color(center, color);`);
  }
  code += `fn modifySplatCenter(center: ptr<function, vec3f>) {\n${calls.center.join('\n')}\n}\n`;
  code += `fn modifySplatRotationScale(originalCenter: vec3f, modifiedCenter: vec3f, rotation: ptr<function, vec4f>, scale: ptr<function, vec3f>) {\n${calls.rs.join('\n')}\n}\n`;
  code += `fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>) {\n${calls.color.join('\n')}\n}\n`;
  return code;
}

// ── engine chunk patches (twins of patchGsplatFootprint / patchPlayCanvasQuadExtent) ──────────

/**
 * The non-square-pixel footprint fix on the WGSL `gsplatCornerVS` (2.22.3): the Jacobian's y
 * row takes its OWN focal length (viewport height × P[1][1]) instead of the width's. Applies to
 * the RASTER_CPU_SORT path only: on RASTER_GPU_SORT (the WebGPU default) the covariance is
 * computed in the compute projector from one `focal` uniform, which no chunk reaches (fixed
 * upstream in 2.23.2). Adapted from PlayCanvas engine src/scene/shader-lib/wgsl/chunks/gsplat/vert/
 * gsplatCorner.js @ v2.22.3, MIT (THIRD_PARTY_NOTICES.md).
 *
 * @returns {{src:string, ok:boolean}}
 */
export function patchGsplatFootprintWgsl(src) {
  if (typeof src !== 'string') return { src, ok: false };
  if (src.includes('dxrFocalY')) return { src, ok: true };
  const r1 = /let\s+J2\s*=\s*-J1\s*\/\s*vp\.z\s*\*\s*vp\.xy\s*;/;
  const r2 = /vec3f\(\s*0\.0\s*,\s*J1\s*,\s*J2\.y\s*\)/;
  if (!r1.test(src) || !r2.test(src)) return { src, ok: false };
  return {
    src: src
      .replace(
        r1,
        'let J1y = (uniform.viewport_size.y * uniform.matrix_projection[1][1]) / vp.z; /* dxrFocalY */ ' +
          'let J2 = vec2f(-J1 / vp.z * vp.x, -J1y / vp.z * vp.y);',
      )
      .replace(r2, 'vec3f(0.0, J1y, J2.y)'),
    ok: true,
  };
}

const PC_CLIP_ANCHOR_WGSL = /let\s+clip\s*=\s*min\(\s*half\(\s*1\.0\s*\)\s*,/;

/**
 * perf.maxStdDev's quad-extent cap on a WGSL chunk: `gsplatCommonVS` (RASTER_CPU_SORT) and
 * `gsplatHybridVS` (RASTER_GPU_SORT) carry the same `clipCorner` line. Adapted from PlayCanvas
 * engine src/scene/shader-lib/wgsl/chunks/gsplat/vert/gsplatCommon.js @ v2.22.3, MIT.
 *
 * @returns {{src:string, ok:boolean}}
 */
export function patchQuadExtentWgsl(src, k) {
  if (typeof src !== 'string' || !(k > 0 && k < 1)) return { src, ok: false };
  if (src.includes('dxrQuadExtent')) return { src, ok: true };
  if (!PC_CLIP_ANCHOR_WGSL.test(src)) return { src, ok: false };
  return { src: src.replace(PC_CLIP_ANCHOR_WGSL, `let clip = min(half(${k.toFixed(7)}) /* dxrQuadExtent */,`), ok: true };
}

// ── the adapter's ShaderMaterials (vertexWGSL / fragmentWGSL twins) ───────────────────────────
//
// Twins of the GLSL in inline3d-splat-playcanvas.js `_makeFeather` and `_ensureSnapshotOverlay`.
// gl_FragCoord → the fragment's @builtin(position) (`input.position`). The snapshot is read with
// textureLoad at the fragment's own pixel — the GLSL's `texture2D(dxrSnap, gl_FragCoord.xy *
// invSize)` at a texel centre. Both APIs put the snapshot's row 0 where their fragment y is 0 when
// it is a plain framebuffer COPY (GL: bottom row / y up; WebGPU: top row / y down), so the
// mapping is the identity on both — a capture that BLITS with a flip would need one here.

const OVERLAY_VS = `
attribute vertex_position: vec3f;
@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4f(input.vertex_position.xy, 0.0, 1.0);
  return output;
}
`;

const snapshotFragment = (body) => `
var dxrSnap: texture_2d<f32>;
uniform dxrSnapInvSize: vec2f;
uniform dxrSnapAlpha: f32;
uniform dxrSnapWipe: vec3f;
uniform dxrSnapOver: f32;
fn dxrSnapWeight(fc: vec2f) -> f32 {
  if (uniform.dxrSnapWipe.x < -1.0) { return uniform.dxrSnapAlpha; }
  let vw = 1.0 / (uniform.dxrSnapInvSize.x * uniform.dxrSnapWipe.z);
  let u = (fc.x % vw) / vw;
  // wavefrontCommit(): column u has committed lt of the way to the new photo
  let lt = clamp((uniform.dxrSnapWipe.x - u * (1.0 - uniform.dxrSnapWipe.y)) / uniform.dxrSnapWipe.y, 0.0, 1.0);
  return uniform.dxrSnapAlpha * (1.0 - smoothstep(0.0, 1.0, lt));
}
fn dxrSnapTexel(fc: vec2f) -> vec4f { return textureLoad(dxrSnap, vec2i(fc), 0); }
@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
  var output: FragmentOutput;
  let fc = input.position.xy;
  ${body}
  return output;
}
`;

/**
 * The adapter's ShaderMaterial sources in WGSL. `snapshot.scale` / `snapshot.add` are the
 * `inline3dSnapshotScale` / `inline3dSnapshotAdd` parts (same uniforms: dxrSnap, dxrSnapInvSize,
 * dxrSnapAlpha, dxrSnapWipe, dxrSnapOver); `feather` is `inline3dEdgeFeather` (dxrFeatherFx/Fy).
 */
export const OVERLAY_WGSL = Object.freeze({
  snapshot: Object.freeze({
    vertex: OVERLAY_VS,
    scale: snapshotFragment(
      'let w = dxrSnapWeight(fc); let a = dxrSnapTexel(fc).a; output.color = vec4f(0.0, 0.0, 0.0, mix(1.0 - w, 1.0 - w * a, uniform.dxrSnapOver));',
    ),
    add: snapshotFragment('output.color = dxrSnapTexel(fc) * dxrSnapWeight(fc);'),
  }),
  feather: Object.freeze({
    vertex: `
attribute vertex_position: vec3f;
attribute vertex_texCoord0: vec2f;
varying vUv: vec2f;
@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  output.vUv = input.vertex_texCoord0;
  output.position = vec4f(input.vertex_position.xy, 0.0, 1.0);
  return output;
}
`,
    fragment: `
varying vUv: vec2f;
uniform dxrFeatherFx: f32;
uniform dxrFeatherFy: f32;
@fragment
fn fragmentMain(input: FragmentInput) -> FragmentOutput {
  var output: FragmentOutput;
  let ax = smoothstep(0.0, uniform.dxrFeatherFx, input.vUv.x) * smoothstep(0.0, uniform.dxrFeatherFx, 1.0 - input.vUv.x);
  let ay = smoothstep(0.0, uniform.dxrFeatherFy, input.vUv.y) * smoothstep(0.0, uniform.dxrFeatherFy, 1.0 - input.vUv.y);
  output.color = vec4f(1.0, 1.0, 1.0, ax * ay);
  return output;
}
`,
  }),
});

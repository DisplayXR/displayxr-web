// The WGSL twins of the splat effects (js/inline3d-splat-effects-wgsl.js): every GLSL body has a
// twin with the same uniforms (name AND type), the twins compile — validated with naga (wgpu's
// WGSL front end, `naga-wasm`, a devDependency) inside a harness that includes them the way the
// engine does, in a VERTEX, a FRAGMENT and a COMPUTE entry point (PlayCanvas 2.22.3 includes
// gsplatModifyVS in gsplatVS, gsplatCopyToWorkbuffer and the GPU-sort compute projector) — the
// runner picks the device's language, and the engine-chunk patches find their anchors. The GPU
// half (the real engine compiling them, pixels drawn) is test/e2e/splat-effects-wgsl.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import {
  SplatEffects,
  EFFECTS,
  composeModifier,
  customGlsl,
  getEffectChunks,
  prefixOf,
  resolveEffectOptions,
} from '../js/inline3d-splat-effects.js';
import {
  WGSL_BODIES,
  customWgsl,
  patchGsplatFootprintWgsl,
  patchQuadExtentWgsl,
  OVERLAY_WGSL,
} from '../js/inline3d-splat-effects-wgsl.js';

const GLSL_TYPE = { float: 'f32', vec2: 'vec2f', vec3: 'vec3f', vec4: 'vec4f', mat4: 'mat4x4f' };
const glslUniforms = (src) => new Map([...src.matchAll(/^\s*uniform\s+(\w+)\s+(\w+)\s*;/gm)].map((m) => [m[2], GLSL_TYPE[m[1]] ?? m[1]]));
const wgslUniforms = (src) => new Map([...src.matchAll(/^\s*uniform\s+(\w+)\s*:\s*([\w<>, ]+?)\s*;/gm)].map((m) => [m[1], m[2]]));

const ORDERS = ['radial', 'depth', 'noise', 'random', 'layers'];
/** Every compiled variant of every effect: [label, name, opts]. */
function variants() {
  const out = [];
  for (const name of Object.keys(EFFECTS)) {
    if (EFFECTS[name].particle) for (const order of ORDERS) out.push([`${name}/${order}`, name, { order, layerSize: 1024 }]);
    else out.push([name, name, {}]);
  }
  return out;
}

test('every built-in effect has a WGSL twin, with the same uniforms (name and type)', () => {
  assert.deepEqual(Object.keys(WGSL_BODIES).sort(), Object.keys(EFFECTS).sort());
  for (const [label, name, o] of variants()) {
    const P = prefixOf(name);
    const g = glslUniforms(EFFECTS[name].glsl(P, o));
    const w = wgslUniforms(WGSL_BODIES[name](P, o));
    assert.ok(g.size > 0, label);
    assert.deepEqual([...w.entries()].sort(), [...g.entries()].sort(), `${label}: uniforms differ`);
    for (const fn of ['center', 'rs', 'color']) assert.match(WGSL_BODIES[name](P, o), new RegExp(`fn ${P}${fn}\\(`), `${label}: ${fn}`);
  }
});

test('custom: the WGSL body gets the same p/t uniforms, renamed hooks and stubs', () => {
  const P = prefixOf('custom:x');
  const w = customWgsl(P, 'fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>) { (*color).a *= dxrProgress + dxrTime; }');
  assert.deepEqual([...wgslUniforms(w).keys()], [...glslUniforms(customGlsl(P, 'void modifySplatColor(vec3 c, inout vec4 col) {}')).keys()]);
  assert.match(w, new RegExp(`fn ${P}color\\(`));
  assert.match(w, new RegExp(`fn ${P}center\\(c: ptr<function, vec3f>\\) \\{\\}`));
  assert.match(w, new RegExp(`uniform\\.${P}p \\+ uniform\\.${P}t`));
  assert.doesNotMatch(w, /dxrProgress|dxrTime|modifySplat/);
});

test('the GLSL path is unchanged: composeModifier(x) === composeModifier(x, "glsl"); getEffectChunks("glsl") composes the same', () => {
  const insts = ['grade', 'inflate', 'dissolve-in', 'xfade'].map((name) => ({ name, def: EFFECTS[name], opts: resolveEffectOptions(name, {}, EFFECTS[name].kind === 'persistent' ? 'set' : 'play', { internal: true }) }));
  const a = composeModifier(insts);
  assert.deepEqual(composeModifier(insts, 'glsl'), a);
  assert.equal(getEffectChunks('glsl').chunks.gsplatModifyVS(insts), a.code);
  assert.match(a.code, /^void modifySplatCenter\(inout vec3 center\)/m);
  const w = composeModifier(insts, 'wgsl');
  assert.deepEqual(w.order, a.order);
  assert.match(w.code, /^fn modifySplatCenter\(center: ptr<function, vec3f>\)/m);
  assert.equal(getEffectChunks('wgsl').chunks.gsplatModifyVS(insts), w.code);
});

// ── naga ────────────────────────────────────────────────────────────────────────────────────────

let naga = null;
try {
  naga = await import('naga-wasm');
} catch {
  /* reported below */
}

/**
 * A standalone module around a gsplatModifyVS chunk: the engine's `uniform x: T;` lines become one
 * uniform struct (the processor's job), plus the engine symbols a body may use (splat.index,
 * gsplatGetSizeFromScale), and three entry points calling the hooks in the engine's order.
 */
function harness(chunk) {
  const members = [];
  const src = chunk.replace(/^[ \t]*uniform[ \t]+(\w+)\s*:\s*([^;]+);[ \t]*$/gm, (_, n, t) => (members.push(`  ${n}: ${t.trim()},`), ''));
  const body = members.length ? src.replace(/\buniform\.(\w+)/g, 'ub.$1') : src;
  const call = `
  var c = vec3f(f32(i), 0.5, -2.0);
  let oc = c;
  modifySplatCenter(&c);
  var r = vec4f(0.0, 0.0, 0.0, 1.0);
  var s = vec3f(0.01);
  modifySplatRotationScale(oc, c, &r, &s);
  var col = vec4f(0.5, 0.5, 0.5, 0.8);
  modifySplatColor(c, &col);`;
  return `
struct Splat { index: u32, uv: vec2i }
var<private> splat: Splat;
fn gsplatGetSizeFromScale(scale: vec3f) -> f32 { return sqrt((scale.x * scale.x + scale.y * scale.y + scale.z * scale.z) / 3.0); }
${members.length ? `struct DxrUB {\n${members.join('\n')}\n}\n@group(0) @binding(0) var<uniform> ub: DxrUB;` : ''}
@group(0) @binding(1) var<storage, read_write> sink: array<vec4f>;
${body}
@vertex fn vsMain(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  splat.index = i;${call}
  return vec4f(c + s, col.a + r.x);
}
@fragment fn fsMain(@builtin(position) p: vec4f) -> @location(0) vec4f {
  let i = u32(p.x);
  splat.index = i;${call}
  return col + vec4f(c + s, r.x);
}
@compute @workgroup_size(64) fn csMain(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  splat.index = i;${call}
  sink[i] = col + vec4f(c + s, r.x);
}
`;
}

function nagaCheck(label, code) {
  try {
    naga.validate(naga.parseWgsl(code));
  } catch (e) {
    const lines = code.split('\n').map((l, i) => `${String(i + 1).padStart(4)}: ${l}`).join('\n');
    assert.fail(`${label}: naga rejected the WGSL\n${e.formatted ?? e.message}\n${lines}`);
  }
}

test('naga validates every WGSL twin in a vertex, a fragment and a compute entry point', { skip: naga ? false : 'naga-wasm not installed (devDependency)' }, () => {
  for (const [label, name, o] of variants()) {
    const inst = { name, def: EFFECTS[name], opts: o };
    nagaCheck(label, harness(composeModifier([inst], 'wgsl').code));
  }
  // everything at once (one of each stage, two particle bodies): the prefixes keep them apart
  const all = Object.keys(EFFECTS).map((name) => ({ name, def: EFFECTS[name], opts: EFFECTS[name].particle ? { order: 'noise' } : {} }));
  nagaCheck('all', harness(composeModifier(all, 'wgsl').code));
  // a page's custom WGSL
  const custom = { name: 'custom:wave', def: { stage: 'custom' }, opts: { wgsl: 'fn modifySplatCenter(center: ptr<function, vec3f>) { (*center).y += sin(dxrTime) * (1.0 - dxrProgress); }' } };
  nagaCheck('custom', harness(composeModifier([custom], 'wgsl').code));
  // and the harness itself rejects a broken body (the check is not vacuous)
  assert.throws(() => naga.validate(naga.parseWgsl(harness(composeModifier([{ name: 'custom:bad', def: { stage: 'custom' }, opts: { wgsl: 'fn modifySplatCenter(center: ptr<function, vec3f>) { *center = 1.0; }' } }], 'wgsl').code))));
});

// ── the runner picks the device's language ──────────────────────────────────────────────────────

function fakeWorld(webgpu) {
  const chunks = { glsl: new Map(), wgsl: new Map() };
  const params = new Map();
  const entity = {
    gsplat: {
      modifier: undefined,
      setWorkBufferModifier(m) {
        this.modifier = m;
      },
      setParameter() {},
    },
  };
  const material = {
    getShaderChunks: (lang) => ({ set: (k, v) => chunks[lang].set(k, v), delete: (k) => chunks[lang].delete(k), get: (k) => chunks[lang].get(k) }),
    setParameter: (n, v) => params.set(n, v),
    update() {},
  };
  const ctx = {
    pc: () => ({ SHADERLANGUAGE_GLSL: 'glsl', SHADERLANGUAGE_WGSL: 'wgsl', WORKBUFFER_UPDATE_ALWAYS: 2, WORKBUFFER_UPDATE_ONCE: 1, WORKBUFFER_UPDATE_AUTO: 0 }),
    app: () => ({ graphicsDevice: { isWebGPU: webgpu }, scene: { gsplat: { material } } }),
    now: () => 1000,
    eyes: () => ({ origin: [0, 0, 0], axis: [0, 0, -1], right: [1, 0, 0], up: [0, 1, 0], tanHalfFovX: 0.5, tanHalfFovY: 0.4, separation: 0.06 }),
    focus: () => [0, 0, -2],
    framing: () => ({ center: [0, 0, -2], extent: [2, 2, 2] }),
    pick: () => null,
    modelToContent: (p) => p,
    entity: () => entity,
  };
  return { fx: new SplatEffects(ctx), chunks, params, entity };
}

test('WebGPU device: tile effects go to the WGSL chunk set, entity effects to setWorkBufferModifier({ wgsl })', () => {
  const w = fakeWorld(true);
  w.fx.set('grade', { saturation: 0.5 });
  assert.match(w.chunks.wgsl.get('gsplatModifyVS'), /fn modifySplatColor\(center: vec3f, color: ptr<function, vec4f>\)/);
  assert.equal(w.chunks.glsl.size, 0);
  assert.equal(w.params.get('dxrFx_grade_sat'), 0.5); // same uniform names as GLSL
  w.fx.drive(w.entity, 'dissolve-in', { order: 'noise' });
  assert.deepEqual(Object.keys(w.entity.gsplat.modifier), ['wgsl']);
  assert.match(w.entity.gsplat.modifier.wgsl, /fn dxrFx_dissolve_in_center\(/);
  w.fx.set('grade', null);
  assert.equal(w.chunks.wgsl.has('gsplatModifyVS'), false);
  // the shared (render-time) transition body and its prewarm twin
  assert.match(w.fx.sharedChunkCode('transition', 'dissolve-in', { order: 'noise' }, 'wgsl'), /fn dxrFx_transition_center\(/);
});

test('WebGL device: unchanged — GLSL chunk set, setWorkBufferModifier({ glsl })', () => {
  const w = fakeWorld(false);
  w.fx.set('grade', { saturation: 0.5 });
  assert.match(w.chunks.glsl.get('gsplatModifyVS'), /^void modifySplatColor/m);
  assert.equal(w.chunks.wgsl.size, 0);
  w.fx.drive(w.entity, 'xfade', { k: 0.5 });
  assert.deepEqual(Object.keys(w.entity.gsplat.modifier), ['glsl']);
});

test('custom effects: the call is refused when no body is in the device language', () => {
  const g = 'void modifySplatColor(vec3 c, inout vec4 col) { col.a *= dxrProgress; }';
  const wg = 'fn modifySplatColor(c: vec3f, col: ptr<function, vec4f>) { (*col).a *= dxrProgress; }';
  assert.throws(() => fakeWorld(true).fx.set('custom', { glsl: g }), /runs on WebGPU/);
  assert.throws(() => fakeWorld(false).fx.set('custom', { wgsl: wg }), /runs on WebGL/);
  const w = fakeWorld(true);
  w.fx.set('custom', { glsl: g, wgsl: wg, progress: 0.3 });
  assert.match(w.chunks.wgsl.get('gsplatModifyVS'), /uniform\.dxrFx_custom_p/);
  assert.throws(() => resolveEffectOptions('custom', {}, 'set'), /needs \{ glsl/);
  assert.throws(() => resolveEffectOptions('custom', { wgsl: 'fn f() { let p = pcPosition; }' }, 'set'), /screen-space input \(pcPosition\)/);
  assert.throws(() => resolveEffectOptions('custom', { wgsl: wg, fragmentWgsl: 'x', scope: 'entity' }, 'set'), /fragmentWgsl is tile scope only/);
});

// ── engine chunk patches + the ShaderMaterial twins ─────────────────────────────────────────────

let pcRoot = null;
try {
  // the package's exports map hides package.json: cut the main entry back to the package root
  const main = createRequire(import.meta.url).resolve('playcanvas');
  pcRoot = pathToFileURL(main.slice(0, main.lastIndexOf('playcanvas') + 'playcanvas'.length)).href.replace(/\/build\/playcanvas$/, '/');
} catch {
  /* the peer is optional */
}
const chunk = async (rel) => (await import(`${pcRoot}build/playcanvas/src/scene/shader-lib/wgsl/chunks/gsplat/vert/${rel}`)).default;

test('engine patches find their anchors in the WGSL chunks of the installed engine', { skip: pcRoot ? false : 'playcanvas not installed' }, async () => {
  const corner = patchGsplatFootprintWgsl(await chunk('gsplatCorner.js'));
  assert.ok(corner.ok, 'gsplatCornerVS footprint anchor');
  assert.match(corner.src, /vec3f\(0\.0, J1y, J2\.y\)/);
  assert.equal(patchGsplatFootprintWgsl(corner.src).src, corner.src); // idempotent
  for (const f of ['gsplatCommon.js', 'gsplatHybrid.js']) {
    const q = patchQuadExtentWgsl(await chunk(f), 0.75);
    assert.ok(q.ok, f);
    assert.match(q.src, /min\(half\(0\.7500000\) \/\* dxrQuadExtent \*\//);
  }
  assert.equal(patchQuadExtentWgsl('no anchor', 0.5).ok, false);
  assert.equal(getEffectChunks('wgsl').chunks.gsplatCornerVS, patchGsplatFootprintWgsl);
});

test('the overlay / feather ShaderMaterial twins keep the GLSL uniforms', () => {
  for (const f of [OVERLAY_WGSL.snapshot.scale, OVERLAY_WGSL.snapshot.add]) {
    assert.deepEqual([...wgslUniforms(f).keys()].sort(), ['dxrSnapAlpha', 'dxrSnapInvSize', 'dxrSnapOver', 'dxrSnapWipe']);
    assert.match(f, /var dxrSnap: texture_2d<f32>;/);
  }
  assert.deepEqual([...wgslUniforms(OVERLAY_WGSL.feather.fragment).keys()].sort(), ['dxrFeatherFx', 'dxrFeatherFy']);
  assert.equal(getEffectChunks('wgsl').overlay, OVERLAY_WGSL);
  assert.equal(getEffectChunks('glsl').overlay, null);
});

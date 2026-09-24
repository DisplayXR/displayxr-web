// Splat effects (js/inline3d-splat-effects.js) against a recording fake of the two engine hooks:
// chunk composition order, removal restoring the engine's own chunk, option validation, promise
// resolution, the start gate, and the stereo rule. The GPU half (pixels, per-eye consistency,
// frame cost) is measured headless on the real GPU: docs/splat-effects.md §Gates.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SplatEffects,
  EFFECTS,
  STAGE_ORDER,
  PUBLIC_EFFECTS,
  composeModifier,
  customGlsl,
  prefixOf,
  resolveEffectOptions,
  resolveRevealOption,
  resolveOriginSpec,
  validateEffectCall,
  wavefrontCommit,
} from '../js/inline3d-splat-effects.js';

const near = (a, b, eps, what = '') => assert.ok(Math.abs(a - b) < eps, `${what} ${a} !~= ${b}`);

function fakeWorld() {
  const chunks = new Map();
  const params = new Map();
  const rec = { updates: 0, chunkSets: 0 };
  let T = 1000;
  const material = {
    getShaderChunks: () => ({
      set: (k, v) => (rec.chunkSets++, chunks.set(k, v)),
      delete: (k) => chunks.delete(k),
      get: (k) => chunks.get(k),
    }),
    setParameter: (n, v) => params.set(n, v),
    update: () => rec.updates++,
  };
  const eparams = new Map();
  const entity = {
    gsplat: {
      modifier: null,
      workBufferUpdate: 0,
      setWorkBufferModifier(m) {
        this.modifier = m;
      },
      setParameter: (n, v) => eparams.set(n, v),
    },
  };
  const ctx = {
    pc: () => ({ SHADERLANGUAGE_GLSL: 'glsl', WORKBUFFER_UPDATE_ALWAYS: 2, WORKBUFFER_UPDATE_ONCE: 1 }),
    app: () => ({ scene: { gsplat: { material } } }),
    now: () => T,
    eyes: () => ({ origin: [0, 0, 0], axis: [0, 0, -1], right: [1, 0, 0], up: [0, 1, 0], tanHalfFovX: 0.5 }),
    focus: () => [0, 0, -2],
    framing: () => ({ center: [0, 0, -2], extent: [2, 2, 2] }),
    pick: (x, y) => [x, y, -3],
    modelToContent: (p) => [p[0], -p[1], -p[2]],
    entity: () => entity,
  };
  const fx = new SplatEffects(ctx);
  const tick = (dt = 0) => {
    T += dt;
    fx.tick(T);
    fx.flush();
  };
  return { fx, chunks, params, eparams, entity, rec, tick, ctx, setT: (t) => (T = t) };
}

// ── composition ─────────────────────────────────────────────────────────────────────────────

test('ONE generated chunk, composed grade → clip → reveal → pulse → custom whatever the call order', () => {
  const w = fakeWorld();
  w.fx.set('custom', { glsl: 'void modifySplatColor(vec3 c, inout vec4 col) { col.r = 1.0; }' });
  w.fx.set('pulse', { progress: 0.5 });
  w.fx.set('inflate', { progress: 0.5 });
  w.fx.set('clip', { sphere: { center: [0, 0, 2], radius: 1 } });
  w.fx.set('grade', { exposure: 1 });
  const code = w.chunks.get('gsplatModifyVS');
  assert.ok(code, 'the tile chunk is installed');
  for (const fn of ['modifySplatCenter', 'modifySplatRotationScale', 'modifySplatColor']) {
    assert.equal(code.split(`void ${fn}(`).length - 1, 1, `${fn} defined exactly once`);
  }
  const body = code.slice(code.indexOf('void modifySplatColor(vec3 center'));
  const at = (n) => body.indexOf(`${prefixOf(n)}color(center, color)`);
  const order = ['grade', 'clip', 'inflate', 'pulse', 'custom'];
  for (let i = 1; i < order.length; i++) assert.ok(at(order[i - 1]) < at(order[i]), `${order[i - 1]} before ${order[i]}`);
  assert.deepEqual(STAGE_ORDER, ['grade', 'clip', 'reveal', 'pulse', 'custom']);
  assert.deepEqual(composeModifier([
    { name: 'custom', def: { stage: 'custom' }, opts: { glsl: '' } },
    { name: 'fade', def: EFFECTS.fade, opts: {} },
  ]).order, ['fade', 'custom']);
});

test('removing the last effect DELETES the chunk (the engine default = the exact baseline)', () => {
  const w = fakeWorld();
  w.fx.set('grade', { saturation: 0 });
  w.fx.set('custom', { glsl: 'void modifySplatColor(vec3 c, inout vec4 col) {}', fragmentGlsl: 'void modifySplatColor(vec2 uv, inout vec4 color) {}' });
  assert.ok(w.chunks.has('gsplatModifyVS'));
  assert.ok(w.chunks.has('gsplatModifyPS'), 'custom fragmentGlsl → gsplatModifyPS');
  w.fx.stop('custom');
  assert.ok(w.chunks.has('gsplatModifyVS'), 'grade still on');
  assert.equal(w.chunks.has('gsplatModifyPS'), false, 'the PS chunk left with its effect');
  w.fx.set('grade', null);
  assert.equal(w.chunks.has('gsplatModifyVS'), false, 'no effect → no chunk, not a no-op chunk');
  assert.equal(w.fx.active, false);
});

test('entity scope: one work-buffer modifier per entity, UPDATE_ALWAYS while on, ONCE after removal', () => {
  const w = fakeWorld();
  w.fx.set('inflate', { progress: 0.25, scope: 'entity' });
  w.fx.set('grade', { exposure: -1, scope: 'entity' });
  const g = w.entity.gsplat;
  assert.match(g.modifier.glsl, /dxrFx_inflate_center/);
  assert.match(g.modifier.glsl, /dxrFx_grade_color/);
  assert.equal(g.workBufferUpdate, 2);
  assert.equal(w.chunks.has('gsplatModifyVS'), false, 'the tile chunk is untouched');
  assert.ok(w.eparams.has('dxrFx_inflate_amount'), 'uniforms go to the entity');
  w.fx.stop();
  assert.equal(g.modifier, null);
  assert.equal(g.workBufferUpdate, 1, 'one clean re-render without it');
});

test('an entity effect that ends puts the engine placement back on AUTO: no per-frame work-buffer re-render after it', () => {
  const w = fakeWorld();
  const pc = w.ctx.pc();
  w.ctx.pc = () => ({ ...pc, WORKBUFFER_UPDATE_AUTO: 0 });
  // The engine's GSplatPlacement setter, verbatim semantics (playcanvas 2.22.3): ONCE is a
  // one-shot (dirtyVersion++) and does NOT change the mode; any other value becomes the mode.
  const placement = { mode: 0, dirtyVersion: 0 };
  const g = w.entity.gsplat;
  let comp = g.workBufferUpdate;
  Object.defineProperty(g, 'workBufferUpdate', {
    get: () => comp,
    set: (v) => {
      comp = v;
      if (v === 1) placement.dirtyVersion++;
      else placement.mode = v;
    },
    configurable: true,
    enumerable: true,
  });
  for (const name of ['inflate', 'sweep', 'fade']) {
    w.fx.set(name, { progress: 0.5, scope: 'entity' });
    assert.equal(placement.mode, 2, `${name}: ALWAYS while on`);
    const dv = placement.dirtyVersion;
    w.fx.stop();
    assert.equal(placement.mode, 0, `${name}: back on AUTO once it ends (was stuck on ALWAYS: re-render + re-sort every frame)`);
    assert.equal(placement.dirtyVersion, dv + 1, `${name}: exactly one clean re-render without it`);
  }
});

test('internal xfade + an entity reveal on the same entity compose into ONE modifier (setSource)', () => {
  const w = fakeWorld();
  w.fx.setInternal(w.entity, 'xfade', { k: 0.3 });
  w.fx.play('sweep', { scope: 'entity' }, { entity: w.entity });
  const code = w.entity.gsplat.modifier.glsl;
  assert.match(code, /dxrFx_xfade_color\(center, color\)/);
  assert.match(code, /dxrFx_sweep_color\(center, color\)/);
  assert.equal(w.eparams.get('dxrFx_xfade_k'), 0.3);
  assert.deepEqual(w.fx.list().map((e) => e.name), ['sweep'], 'internal effects are not listed');
  w.fx.setInternal(w.entity, 'xfade', null);
  assert.doesNotMatch(w.entity.gsplat.modifier.glsl, /xfade/);
});

test('the structure is compiled once: uniforms change per frame, the chunk does not', () => {
  const w = fakeWorld();
  w.fx.play('inflate', { durationMs: 1000 });
  const sets = w.rec.chunkSets;
  for (let i = 0; i < 10; i++) w.tick(50);
  assert.equal(w.rec.chunkSets, sets, 'no re-set of the chunk while playing');
  assert.ok(w.rec.updates >= 10, 'material.update() after each frame of uniforms');
});

// ── playback ────────────────────────────────────────────────────────────────────────────────

test('playEffect: eased amount per frame, resolves {finished:true} and removes itself at the end', async () => {
  const w = fakeWorld();
  const p = w.fx.play('inflate', { durationMs: 1000, easing: 'linear', holdMs: 0 });
  assert.equal(w.params.get('dxrFx_inflate_amount'), 0, 'installed at its START state');
  w.tick(0); // clock starts
  w.tick(250);
  near(w.params.get('dxrFx_inflate_amount'), 0.25, 1e-12);
  near(w.params.get('dxrFx_inflate_D'), 2, 1e-12, 'plane = focus distance along the eyes’ axis');
  assert.deepEqual(w.params.get('dxrFx_inflate_O'), [0, 0, 0], "origin 'eyes'");
  w.tick(750);
  assert.deepEqual(await p, { finished: true });
  assert.equal(w.chunks.has('gsplatModifyVS'), false);
  assert.deepEqual(w.fx.list(), []);
});

test('holdMs delays the clock; easings are applied; a replay replaces (old resolves finished:false)', async () => {
  const w = fakeWorld();
  const a = w.fx.play('fade', { durationMs: 100, holdMs: 200, easing: 'easeInQuad' });
  w.tick(0);
  w.tick(100);
  assert.equal(w.params.get('dxrFx_fade_amount'), 0, 'still holding');
  w.tick(150); // 50 ms into a 100 ms fade
  near(w.params.get('dxrFx_fade_amount'), 0.25, 1e-12, 'easeInQuad(0.5)');
  const b = w.fx.play('fade', { durationMs: 100 });
  assert.deepEqual(await a, { finished: false });
  w.tick(0);
  w.tick(100);
  assert.deepEqual(await b, { finished: true });
});

test("direction 'out' holds its end state; stop() removes (finished:false), stop({finish}) jumps to the end", async () => {
  const w = fakeWorld();
  const d = w.fx.play('deflate', { durationMs: 100, easing: 'linear' });
  w.tick(0);
  w.tick(100);
  assert.deepEqual(await d, { finished: true });
  assert.equal(w.params.get('dxrFx_deflate_amount'), 0, 'held flat');
  assert.ok(w.chunks.has('gsplatModifyVS'), 'still installed');
  w.fx.stop('deflate');
  assert.equal(w.chunks.has('gsplatModifyVS'), false);

  const s = w.fx.play('sweep', { durationMs: 1000 });
  w.fx.stop('sweep', { finish: true });
  assert.deepEqual(await s, { finished: true });
  assert.equal(w.chunks.has('gsplatModifyVS'), false, "an 'in' effect's end state is the untouched asset");
});

test('a start gate holds the START state until it settles (reveal waits for firstWoven)', async () => {
  const w = fakeWorld();
  let open;
  const gate = new Promise((r) => (open = r));
  const p = w.fx.play('sweep', { durationMs: 100, easing: 'linear' }, { gate });
  for (let i = 0; i < 5; i++) w.tick(500);
  assert.equal(w.params.get('dxrFx_sweep_amount'), 0);
  assert.equal(w.fx.list()[0].waiting, true);
  near(w.params.get('dxrFx_sweep_R'), -w.params.get('dxrFx_sweep_B'), 1e-12, 'amount 0 = the front one band BEFORE the origin: nothing shows');
  open();
  await gate;
  await null;
  w.tick(0);
  w.tick(100);
  assert.deepEqual(await p, { finished: true });
});

test('custom: engine-shaped functions renamed + stubbed, dxrProgress/dxrTime defined, uniforms per frame', () => {
  const g = customGlsl('P_', 'uniform float k; void modifySplatColor(vec3 c, inout vec4 col) { col.a *= k * dxrProgress; }');
  assert.match(g, /void P_color\(vec3 c, inout vec4 col\)/);
  assert.match(g, /void P_center\(inout vec3 c\) \{\}/, 'missing functions stubbed');
  assert.match(g, /#define dxrProgress P_p/);
  assert.doesNotMatch(g, /modifySplat/);
  const w = fakeWorld();
  const seen = [];
  w.fx.set('custom:mine', { glsl: 'uniform float k; void modifySplatColor(vec3 c, inout vec4 col) { col.a *= k; }', uniforms: { k: (t) => (seen.push(t), 0.5), v: [1, 2, 3] } });
  w.tick(16);
  assert.equal(w.params.get('k'), 0.5);
  assert.deepEqual(w.params.get('v'), [1, 2, 3]);
  assert.ok(seen.length >= 1 && seen.at(-1) === 1016, 'uniform functions get the frame time');
  assert.equal(w.params.get('dxrFx_custom_mine_p'), 1, 'setEffect custom: progress 1 unless given');
});

// ── the stereo rule ─────────────────────────────────────────────────────────────────────────

test('no built-in effect reads a screen-space input; custom GLSL that does is refused', () => {
  const screen = /\b(gl_FragCoord|gl_Position|matrix_view|matrix_projection|matrix_viewProjection|viewport_size|view_position|uCameraPosition)\b/;
  for (const [name, def] of Object.entries(EFFECTS)) assert.doesNotMatch(def.glsl('P_'), screen, name);
  assert.throws(() => resolveEffectOptions('custom', { glsl: 'void modifySplatColor(vec3 c, inout vec4 col) { col.r = gl_FragCoord.x; }' }, 'set'), /screen-space input \(gl_FragCoord\)/);
  assert.throws(() => resolveEffectOptions('custom', { glsl: 'void modifySplatCenter(inout vec3 c) { c += matrix_view[0].xyz; }' }, 'set'), /matrix_view/);
  assert.throws(() => resolveEffectOptions('custom', { glsl: 'x', fragmentGlsl: 'void f() { gl_FragCoord; }' }, 'set'), /fragmentGlsl reads a screen-space input/);
});

// ── validation ──────────────────────────────────────────────────────────────────────────────

test('option validation: names, kinds, numbers, easings, origins, scopes', () => {
  assert.throws(() => resolveEffectOptions('sparkle', {}), /unknown effect 'sparkle'/);
  assert.throws(() => resolveEffectOptions('xfade', {}), /unknown effect 'xfade'/, 'internal effects are not public');
  assert.throws(() => resolveEffectOptions('wavefront', {}), /unknown effect/);
  assert.throws(() => resolveEffectOptions('grade', {}, 'play'), /persistent effect — use setEffect/);
  assert.throws(() => resolveEffectOptions('inflate', { durationMs: -1 }), /durationMs/);
  assert.throws(() => resolveEffectOptions('inflate', { durationMs: NaN }), /durationMs/);
  assert.throws(() => resolveEffectOptions('inflate', { easing: 'bounce' }), /unknown easing 'bounce'/);
  assert.ok(resolveEffectOptions('inflate', { easing: (x) => x }).easingFn);
  assert.throws(() => resolveEffectOptions('inflate', { direction: 'sideways' }), /direction/);
  assert.throws(() => resolveEffectOptions('inflate', { scope: 'page' }), /scope/);
  assert.throws(() => resolveEffectOptions('inflate', { progress: 2 }, 'set'), /progress/);
  assert.throws(() => resolveEffectOptions('sweep', { origin: 'viewer' }), /origin must be/);
  assert.throws(() => resolveEffectOptions('sweep', { edgeColor: [1, 2] }), /edgeColor/);
  assert.throws(() => resolveEffectOptions('clip', {}, 'set'), /exactly one of/);
  assert.throws(() => resolveEffectOptions('clip', { box: { min: [0, 0, 0], max: [1, 1, 1] }, sphere: { center: [0, 0, 0], radius: 1 } }, 'set'), /exactly one of/);
  assert.throws(() => resolveEffectOptions('custom', {}, 'set'), /needs \{ glsl/);
  assert.throws(() => resolveEffectOptions('custom', { glsl: 'x', uniforms: { dxrSecret: 1 } }, 'set'), /not allowed/);
  assert.throws(() => resolveEffectOptions('custom', { glsl: 'x', uniforms: { k: 'a' } }, 'set'), /must be a number/);
  assert.throws(() => resolveEffectOptions('custom', { glsl: 'x', fragmentGlsl: 'y', scope: 'entity' }, 'set'), /tile scope only/);
  assert.ok(resolveEffectOptions('custom:a', { glsl: 'x' }, 'set'));
  assert.throws(() => resolveEffectOptions('custom:', { glsl: 'x' }, 'set'), /unknown effect/);
  assert.deepEqual(resolveOriginSpec([1, 2, 3]), { kind: 'model', point: [1, 2, 3] });
  assert.deepEqual(resolveOriginSpec([10, 20]), { kind: 'client', x: 10, y: 20 });
  assert.deepEqual(resolveOriginSpec({ clientX: 5, clientY: 6 }), { kind: 'client', x: 5, y: 6 });
  assert.doesNotThrow(() => validateEffectCall('grade', null, 'set'));
  assert.throws(() => validateEffectCall('nope', null, 'set'), /unknown effect/);
  assert.deepEqual(PUBLIC_EFFECTS, ['clip', 'custom', 'deflate', 'dissolve', 'fade', 'grade', 'inflate', 'pulse', 'sweep']);
});

test('reveal option: false/undefined → none, a name, or {type,…}; bad ones throw', () => {
  assert.equal(resolveRevealOption(undefined), null);
  assert.equal(resolveRevealOption(false), null);
  assert.equal(resolveRevealOption('sweep').type, 'sweep');
  const r = resolveRevealOption({ type: 'inflate', durationMs: 900, holdMs: 100, easing: 'linear', origin: 'eyes' });
  assert.equal(r.opts.durationMs, 900);
  assert.equal(r.opts.direction, 'in');
  assert.throws(() => resolveRevealOption('pulse'), /reveal type 'pulse'/);
  assert.throws(() => resolveRevealOption(true), /reveal must be/);
  assert.throws(() => resolveRevealOption({ type: 'fade', direction: 'out' }), /plays in/);
  assert.throws(() => resolveRevealOption({ type: 'fade', durationMs: -5 }), /durationMs/);
});

test('origins: model point → world, canvas point → pick(), else the focus', () => {
  const w = fakeWorld();
  w.fx.play('pulse', { origin: [1, 2, 3] });
  assert.deepEqual(w.params.get('dxrFx_pulse_C'), [1, -2, -3], 'model → content (the flip)');
  w.fx.play('pulse', { origin: [40, 50] });
  assert.deepEqual(w.params.get('dxrFx_pulse_C'), [40, 50, -3], 'picked');
  w.fx.play('pulse', { origin: 'focus' });
  assert.deepEqual(w.params.get('dxrFx_pulse_C'), [0, 0, -2]);
});

test('wavefront: the prototype commit (u = 0 starts at t = 0, u = 1 ends at t = 1, band 0.18 of travel)', () => {
  near(wavefrontCommit(0, 0, 0.18), 0, 1e-12);
  near(wavefrontCommit(0.18, 0, 0.18), 1, 1e-12, 'column 0 committed after one band');
  near(wavefrontCommit(1, 1, 0.18), 1, 1e-12, 'the last column commits exactly at t = 1');
  near(wavefrontCommit(0.82, 1, 0.18), 0, 1e-12, 'and starts one band before');
  near(wavefrontCommit(0.5, 0.5, 0.18), (0.5 - 0.41) / 0.18, 1e-12);
});

test('wavefront ridge: metres toward the eyes, capped in disparity by the eye separation', () => {
  const w = fakeWorld();
  const e = w.entity;
  w.ctx.eyes = () => ({ origin: [0, 0, 0], axis: [0, 0, -1], right: [1, 0, 0], up: [0, 1, 0], tanHalfFovX: 0.5, separation: 0.064 });
  w.fx.play('wavefront', { scope: 'entity' }, { entity: e, internal: true });
  near(w.eparams.get('dxrFx_wavefront_ridge'), 0.03, 1e-12, '0.03 world units (m on a metric photo)');
  // Δmax = cap · 2·tan(fovX/2) · d² / sep: 0.004 · 1 · d² / 0.064 → 1.5625 cm at d = 0.5 m
  near(w.eparams.get('dxrFx_wavefront_capK'), (0.004 * 2 * 0.5) / 0.064, 1e-12);
  assert.match(e.gsplat.modifier.glsl, /min\(dxrFx_wavefront_ridge, dxrFx_wavefront_capK \* d \* d\)/);
  assert.throws(() => w.fx.play('wavefront', {}), /unknown effect/, 'not public');
  w.ctx.eyes = () => ({ origin: [0, 0, 0], axis: [0, 0, -1], right: [1, 0, 0], up: [0, 1, 0], tanHalfFovX: 0.5, separation: 0 });
  w.fx.play('wavefront', { scope: 'entity' }, { entity: e, internal: true });
  assert.ok(w.eparams.get('dxrFx_wavefront_capK') > 1e8, 'no disparity in 2D: nothing to cap');
});

// Particle reveals (assemble, dissolve-in, converge, shimmer) in js/inline3d-splat-effects.js,
// against a recording fake of the two engine hooks: registration, the reveal option, the chunk
// they compose into, the end state (amount 1 → every body returns; the end of a played run
// deletes the chunk = the engine's own default), removal, option validation, the `layers` order's
// entity-only rule, and the comfort cap. Pixels, per-eye consistency and cost are measured on the
// real GPU: docs/splat-effects.md §Gates.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SplatEffects,
  EFFECTS,
  PUBLIC_EFFECTS,
  REVEAL_EFFECTS,
  PARTICLE_NOMINAL_SEPARATION,
  SHARP_LAYER_SIZE,
  composeModifier,
  prefixOf,
  resolveEffectOptions,
  resolveRevealOption,
} from '../js/inline3d-splat-effects.js';

const PARTICLES = ['assemble', 'dissolve-in', 'converge', 'shimmer'];
const near = (a, b, eps, what = '') => assert.ok(Math.abs(a - b) < eps, `${what} ${a} !~= ${b}`);

function fakeWorld({ separation = 0, tanHalfFovY = 0.3 } = {}) {
  const chunks = new Map();
  const params = new Map();
  const eparams = new Map();
  let T = 1000;
  const material = {
    getShaderChunks: () => ({ set: (k, v) => chunks.set(k, v), delete: (k) => chunks.delete(k), get: (k) => chunks.get(k) }),
    setParameter: (n, v) => params.set(n, v),
    update: () => {},
  };
  const entity = {
    gsplat: {
      modifier: null,
      workBufferUpdate: 1,
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
    eyes: () => ({ origin: [0, 0, 0], axis: [0, 0, -1], right: [1, 0, 0], up: [0, 1, 0], tanHalfFovX: 0.5, tanHalfFovY, separation }),
    focus: () => [0, 0, -2],
    framing: () => ({ center: [0, 0, -3], extent: [2, 2, 2] }),
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
  return { fx, chunks, params, eparams, entity, tick };
}

test('registered: public names, accepted as reveals, one reveal-stage body each', () => {
  for (const n of PARTICLES) {
    assert.ok(PUBLIC_EFFECTS.includes(n), n);
    assert.ok(REVEAL_EFFECTS.includes(n), n);
    assert.equal(EFFECTS[n].stage, 'reveal');
    assert.equal(EFFECTS[n].kind, 'transition');
    const r = resolveRevealOption(n);
    assert.equal(r.type, n);
    assert.equal(r.opts.direction, 'in');
    assert.ok(r.opts.durationMs >= 2000 && r.opts.durationMs <= 3000, `${n}: ~2–3 s by default`);
    const P = prefixOf(n);
    const { code } = composeModifier([{ name: n, def: EFFECTS[n], opts: r.opts }]);
    for (const fn of ['center', 'rs', 'color']) assert.match(code, new RegExp(`void ${P}${fn}\\(`), `${n} ${fn}`);
    // every stage returns at amount >= 1 → amount 1 IS the baseline
    const early = code.split(`if (${P}amount >= 1.0) return;`).length - 1;
    assert.ok(early >= 3, `${n}: all three stages return at amount 1 (${early})`);
    assert.doesNotMatch(code, /splat\.index/, `${n}: the default order reads world position only`);
  }
  assert.equal(prefixOf('dissolve-in'), 'dxrFx_dissolve_in_', 'a GLSL-safe prefix');
});

test('a played particle reveal ends by DELETING the chunk (the exact baseline) and resolves finished', async () => {
  for (const n of PARTICLES) {
    const w = fakeWorld();
    const P = prefixOf(n);
    const p = w.fx.play(n, { durationMs: 1000 });
    assert.ok(w.chunks.get('gsplatModifyVS').includes(`${P}center`), `${n} installed at its start state`);
    assert.equal(w.params.get(P + 'amount'), 0);
    w.tick(0);
    w.tick(500);
    near(w.params.get(P + 'amount'), 0.5, 1e-12, `${n} linear clock`);
    near(w.params.get(P + 'time'), 0.5, 1e-12, `${n} time uniform (s)`);
    w.tick(500);
    assert.deepEqual(await p, { finished: true });
    assert.equal(w.chunks.has('gsplatModifyVS'), false, `${n}: no effect → no chunk`);
    assert.deepEqual(w.fx.list(), []);
  }
});

test('held at progress 1 → amount 1; removal deletes the chunk / the entity modifier', () => {
  for (const n of PARTICLES) {
    const w = fakeWorld();
    w.fx.set(n, { progress: 1 });
    assert.equal(w.params.get(prefixOf(n) + 'amount'), 1);
    w.fx.set(n, null);
    assert.equal(w.chunks.has('gsplatModifyVS'), false);
    w.fx.set(n, { progress: 0.3, scope: 'entity' });
    assert.ok(w.entity.gsplat.modifier?.glsl.includes(prefixOf(n) + 'center'));
    assert.equal(w.entity.gsplat.workBufferUpdate, 2, 'UPDATE_ALWAYS while on');
    near(w.eparams.get(prefixOf(n) + 'amount'), 0.3, 1e-12);
    w.fx.stop(n);
    assert.equal(w.entity.gsplat.modifier, null);
    assert.equal(w.entity.gsplat.workBufferUpdate, 1, 'ONCE after removal');
  }
});

test("order 'layers' reads splat.index (SHARP grid order) — entity scope only, forced when unset", () => {
  const o = resolveEffectOptions('assemble', { order: 'layers' });
  assert.equal(o.scope, 'entity', 'layers puts the effect on the asset');
  assert.throws(() => resolveEffectOptions('assemble', { order: 'layers', scope: 'tile' }), /entity scope only/);
  const { code } = composeModifier([{ name: 'assemble', def: EFFECTS.assemble, opts: o }]);
  assert.match(code, new RegExp(`splat\\.index / ${SHARP_LAYER_SIZE}u`));
  const o2 = resolveEffectOptions('shimmer', { order: 'layers', layerSize: 1024 });
  assert.match(composeModifier([{ name: 'shimmer', def: EFFECTS.shimmer, opts: o2 }]).code, /splat\.index \/ 1024u/);
  const w = fakeWorld();
  w.fx.play('converge', { order: 'layers' });
  assert.ok(w.entity.gsplat.modifier, 'played on the entity');
  assert.equal(w.chunks.has('gsplatModifyVS'), false, 'not on the tile');
  // a reveal spec with layers resolves too (addSplat's reveal)
  assert.equal(resolveRevealOption({ type: 'dissolve-in', order: 'layers' }).opts.scope, 'entity');
  // the other orders compose different keys, all world-position only
  for (const order of ['radial', 'depth', 'noise', 'random']) {
    const c = composeModifier([{ name: 'shimmer', def: EFFECTS.shimmer, opts: resolveEffectOptions('shimmer', { order }) }]).code;
    assert.doesNotMatch(c, /splat\.index/, order);
  }
});

test('option validation', () => {
  for (const n of PARTICLES) {
    assert.throws(() => resolveEffectOptions(n, { order: 'screen' }), /order must be one of/);
    assert.throws(() => resolveEffectOptions(n, { stagger: 1 }), /stagger/);
    assert.throws(() => resolveEffectOptions(n, { jitter: -0.1 }), /jitter/);
    assert.throws(() => resolveEffectOptions(n, { dotSize: 0.5 }), /dotSize/);
    assert.throws(() => resolveEffectOptions(n, { grow: 1 }), /grow/);
    assert.throws(() => resolveEffectOptions(n, { maxDisparity: 0.2 }), /maxDisparity/);
    assert.throws(() => resolveEffectOptions(n, { maxDisparity: NaN }), /maxDisparity/);
    assert.throws(() => resolveEffectOptions(n, { color: [1, 1] }), /color/);
    assert.throws(() => resolveEffectOptions(n, { flightAlpha: 2 }), /flightAlpha/);
    assert.throws(() => resolveEffectOptions(n, { layerSize: 1.5 }), /layerSize/);
    assert.ok(resolveEffectOptions(n, { maxDisparity: 0, stagger: 0, jitter: 1 }));
  }
  assert.throws(() => resolveEffectOptions('assemble', { spread: -1 }), /spread/);
  assert.throws(() => resolveEffectOptions('assemble', { coherence: 2 }), /coherence/);
  assert.throws(() => resolveEffectOptions('dissolve-in', { drift: 5 }), /drift/);
  assert.throws(() => resolveEffectOptions('converge', { burst: 3 }), /burst/);
  assert.throws(() => resolveEffectOptions('shimmer', { twinkle: -1 }), /twinkle/);
});

test('comfort cap: Δdepth toward the eyes ≤ maxDisparity·2·tan(fovX/2)·d²/separation (nominal in 2D)', () => {
  // 3D: the eyes' own separation
  const w = fakeWorld({ separation: 0.064 });
  w.fx.set('assemble', { progress: 0.5, maxDisparity: 0.004 });
  const capK = w.params.get('dxrFx_assemble_capK');
  near(capK, (0.004 * 2 * 0.5) / 0.064, 1e-12);
  // the floor the shader enforces, dn = dh / (1 + capK·dh), adds EXACTLY the budget of disparity
  // (in view widths) at every home depth
  for (const dh of [0.3, 0.5, 1, 2, 5, 40]) {
    const dn = dh / (1 + capK * dh);
    const extra = (0.064 * (1 / dn - 1 / dh)) / (2 * 0.5);
    near(extra, 0.004, 1e-12, `d=${dh}`);
  }
  // 2D: a nominal separation scaled to the focus distance (2 m here), not "no cap"
  const w2 = fakeWorld({ separation: 0 });
  w2.fx.set('converge', { progress: 0.5 });
  near(w2.params.get('dxrFx_converge_capK'), (0.004 * 2 * 0.5) / (PARTICLE_NOMINAL_SEPARATION * 2), 1e-12);
  // maxDisparity 0 → particles never come nearer than home
  const w3 = fakeWorld({ separation: 0.064 });
  w3.fx.set('dissolve-in', { progress: 0.5, maxDisparity: 0 });
  assert.equal(w3.params.get('dxrFx_dissolve_in_capK'), 0);
});

test('the fixed frame: origin image point, the lens radius, the framed depth range', () => {
  const w = fakeWorld({ tanHalfFovY: 0.3 });
  w.fx.set('converge', { progress: 0.5 });
  assert.deepEqual(w.params.get('dxrFx_converge_F'), [0, 0, -2], "origin 'focus'");
  assert.deepEqual(w.params.get('dxrFx_converge_fimg'), [0, 0]);
  near(w.params.get('dxrFx_converge_rmax'), Math.hypot(0.5, 0.3), 1e-12, 'focus → farthest lens corner');
  near(w.params.get('dxrFx_converge_dmin'), 2, 1e-12);
  near(w.params.get('dxrFx_converge_dmax'), 4, 1e-12);
  near(w.params.get('dxrFx_converge_tx'), 0.5, 1e-12);
  // no lens height → the framing box's corners as seen from the eyes
  const w2 = fakeWorld({ tanHalfFovY: 0 });
  w2.fx.set('assemble', { progress: 0.5 });
  near(w2.params.get('dxrFx_assemble_rmax'), Math.hypot(1, 1) / 2, 1e-12);
  // a model-space origin moves the image point
  const w3 = fakeWorld();
  w3.fx.set('converge', { progress: 0.5, origin: [0.5, 0, 2] });
  near(w3.params.get('dxrFx_converge_fimg')[0], 0.25, 1e-12);
});

test('a particle reveal composes with a grade in one chunk, grade first', () => {
  const w = fakeWorld();
  w.fx.set('shimmer', { progress: 0.4 });
  w.fx.set('grade', { exposure: 1 });
  const code = w.chunks.get('gsplatModifyVS');
  assert.ok(code.indexOf('dxrFx_grade_color(center') < code.indexOf('dxrFx_shimmer_color(center'));
  w.fx.stop('shimmer');
  assert.ok(!w.chunks.get('gsplatModifyVS').includes('shimmer'));
});

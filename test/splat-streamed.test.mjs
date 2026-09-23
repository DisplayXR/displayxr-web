// Streamed SOG (`lod-meta.json`) on the PlayCanvas backend — epic #36 P2. The pure parts: the
// LOD knob mapping and its kill switches, the per-tile budget model (pinned), streamed-URL
// detection, the bytes refusal, and the handle's stats() shape. The GPU half — resident counts,
// time to first frame, bytes, GPU ms — is measured in the browser (docs/playcanvas-adapter.md
// §Streamed SOG).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  playcanvasPerfSettings,
  tileSplatBudget,
  budgetPerManager,
  STREAMED_SPLAT_BUDGET,
  SPLAT_BUDGET_MODEL,
} from '../js/inline3d-splat-perf.js';
import {
  engineFormatFor,
  isStreamedUrl,
  streamedEntryUrl,
  streamedBytesError,
  attachPlayCanvasSplat,
  PlayCanvasSplatViewer,
  octreeSample,
  describeResource,
} from '../js/inline3d-splat-playcanvas.js';
import { installDom, makeCanvas } from './stubs.mjs';

const enc = (s) => new TextEncoder().encode(s);

// ── LOD knobs ───────────────────────────────────────────────────────────────────────────────

test('LOD knobs pass straight through to scene.gsplat; unset stays the engine default', () => {
  const r = playcanvasPerfSettings({ lodMode: 'error', lodUpdateDistance: 0.5, lodUpdateAngle: 5, lodUnderfillLimit: 2 });
  assert.equal(r.settings.lodMode, 'error');
  assert.equal(r.settings.lodUpdateDistance, 0.5);
  assert.equal(r.settings.lodUpdateAngle, 5);
  assert.equal(r.settings.lodUnderfillLimit, 2);
  const d = playcanvasPerfSettings(undefined);
  for (const k of ['lodMode', 'lodUpdateDistance', 'lodUpdateAngle', 'lodUnderfillLimit', 'splatBudget']) {
    assert.equal(k in d.settings, false, `${k} unset = engine default`);
  }
  for (const preset of ['exact', 'balanced', 'aggressive', true]) {
    const p = playcanvasPerfSettings(preset);
    assert.equal('lodMode' in p.settings || 'splatBudget' in p.settings, false, `${preset} names no LOD knob`);
  }
});

test('perf:false sets no LOD knob and no budget (kill switch)', () => {
  const r = playcanvasPerfSettings(false);
  assert.deepEqual(r.settings, {});
  assert.equal(r.applied, null);
});

test('a bad lodMode warns and is dropped; negative / non-finite numbers are dropped silently', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const r = playcanvasPerfSettings({ lodMode: 'screen', lodUpdateDistance: -1, lodUpdateAngle: NaN, lodUnderfillLimit: 0 });
  assert.equal('lodMode' in r.settings, false);
  assert.equal('lodUpdateDistance' in r.settings, false);
  assert.equal('lodUpdateAngle' in r.settings, false);
  assert.equal(r.settings.lodUnderfillLimit, 0, '0 is a real value (the engine default, stated)');
  assert.equal(warn.mock.calls.filter((c) => /lodMode "screen"/.test(String(c.arguments[0]))).length, 1);
});

// ── the budget ──────────────────────────────────────────────────────────────────────────────

test('SPLAT_BUDGET_MODEL is pinned: per tile, one budget for all views, fallback divides', () => {
  assert.deepEqual({ ...SPLAT_BUDGET_MODEL }, {
    scope: 'tile',
    views: 'shared',
    fallbackDivides: true,
    lodCamera: 'first-view',
  });
  assert.ok(Object.isFrozen(SPLAT_BUDGET_MODEL));
  assert.equal(STREAMED_SPLAT_BUDGET, 600000);
});

test('budgetPerManager: RenderView = the tile budget for any N; N cameras = split N ways', () => {
  assert.equal(budgetPerManager(600000, 'renderview', 1), 600000);
  assert.equal(budgetPerManager(600000, 'renderview', 2), 600000, 'both eyes share ONE manager');
  assert.equal(budgetPerManager(600000, 'renderview', 4), 600000);
  assert.equal(budgetPerManager(600000, 'cameras', 2), 300000);
  assert.equal(budgetPerManager(600001, 'cameras', 4), 150000);
  assert.equal(budgetPerManager(3, 'cameras', 8), 1, 'never 0 (the engine reads <= 0 as its 1M default)');
  assert.equal(budgetPerManager(undefined, 'cameras', 2), undefined);
});

test('tileSplatBudget: caller wins; streamed default 600k; flat and perf:false leave the engine’s', () => {
  assert.equal(tileSplatBudget(playcanvasPerfSettings({ splatBudget: 250000 }), 'streamed'), 250000);
  assert.equal(tileSplatBudget(playcanvasPerfSettings(undefined), 'streamed'), STREAMED_SPLAT_BUDGET);
  assert.equal(tileSplatBudget(playcanvasPerfSettings('balanced'), 'streamed'), STREAMED_SPLAT_BUDGET);
  assert.equal(tileSplatBudget(playcanvasPerfSettings(undefined), 'flat'), undefined);
  assert.equal(tileSplatBudget(playcanvasPerfSettings(false), 'streamed'), undefined, 'kill switch = engine 1M');
  assert.equal(tileSplatBudget(playcanvasPerfSettings({ splatBudget: 250000 }), 'flat'), 250000);
});

// ── streamed-URL detection and the bytes refusal ─────────────────────────────────────────────

test('isStreamedUrl: lod-meta.json or a directory URL, query/hash ignored', () => {
  for (const u of [
    'https://cdn/x/v1/lod-meta.json',
    'https://cdn/x/v1/lod-meta.json?token=a#b',
    'lod-meta.json',
    './scene/LOD-META.JSON',
    'https://cdn/x/v1/',
    'https://cdn/x/v1/?sig=1',
  ]) assert.equal(isStreamedUrl(u), true, u);
  for (const u of ['https://cdn/x/scene.sog', 'https://cdn/x/meta.json', 'https://cdn/x/my-lod-meta.json', '', null, 42]) {
    assert.equal(isStreamedUrl(u), false, String(u));
  }
});

test('streamedEntryUrl appends lod-meta.json to a directory URL, keeping query and hash', () => {
  assert.equal(streamedEntryUrl('https://cdn/x/v1/'), 'https://cdn/x/v1/lod-meta.json');
  assert.equal(streamedEntryUrl('https://cdn/x/v1/?sig=1#h'), 'https://cdn/x/v1/lod-meta.json?sig=1#h');
  assert.equal(streamedEntryUrl('https://cdn/x/v1/lod-meta.json?a=1'), 'https://cdn/x/v1/lod-meta.json?a=1');
});

test('engineFormatFor: a directory URL is streamed; a plain meta.json is NOT', () => {
  assert.deepEqual(engineFormatFor('https://cdn/x/v1/'), { ext: 'json', streamed: true });
  assert.deepEqual(engineFormatFor('https://cdn/x/v1/lod-meta.json'), { ext: 'json', streamed: true });
  assert.deepEqual(engineFormatFor('https://cdn/x/unbundled/meta.json'), { ext: 'json', streamed: false });
});

test('streamedBytesError: named lod-meta.json, or sniffed lod-meta keys → a message; anything else → null', () => {
  const lod = enc('\n  {"version":1,"lodLevels":3,"filenames":["0_0/meta.json"],"tree":{}}');
  assert.match(streamedBytesError(lod), /cannot be passed as bytes/);
  assert.match(streamedBytesError(lod), /Pass its URL instead/);
  assert.match(streamedBytesError(enc('{}'), 'scene/lod-meta.json'), /cannot be passed as bytes/);
  assert.equal(streamedBytesError(enc('{"version":2,"count":10,"means":{}}')), null, 'a SOG meta.json is not a lod-meta');
  assert.equal(streamedBytesError(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0])), null, 'a .sog');
  assert.equal(streamedBytesError(enc('ply\nformat binary_little_endian 1.0\n')), null);
  assert.equal(streamedBytesError(new Uint8Array(0)), null);
});

// ── through the adapter, against a minimal fake engine ──────────────────────────────────────

/** Enough of `playcanvas` to boot the adapter and load a Streamed SOG. Records what it is given. */
function fakePc(resource) {
  const rec = { assetUrls: [] };
  class Entity {
    constructor(name, app) { this.name = name; this.app = app; }
    addChild() {}
    addComponent(type, data) {
      if (type === 'camera') this.camera = { ...data, camera: { setXrProperties() {} } };
      if (type === 'gsplat') this.gsplat = data;
    }
    setLocalPosition() {}
    setLocalRotation() {}
    setLocalScale() {}
    setLocalEulerAngles() {}
  }
  class AppBase {
    constructor(canvas) {
      this.canvas = canvas;
      this.root = new Entity('root', this);
      this.scene = { gsplat: { splatBudget: 1000000, minPixelSize: 2 } };
      this.resolutionMode = 'fixed';
      this.renderer = { _gsplatCount: 0 };
      this.assets = { add() {}, load: (a) => { a.resource = resource; queueMicrotask(() => a._ready?.(a)); } };
      rec.app = this;
    }
    init() {}
    start() {}
    tick() {}
    destroy() {}
  }
  class Camera {}
  Object.defineProperty(Camera.prototype, 'xrViews', { get() { return null; }, set() {} });
  const pc = {
    DEVICETYPE_WEBGL2: 'webgl2', RESOLUTION_FIXED: 'fixed', SHADERLANGUAGE_GLSL: 'glsl', TONEMAP_NONE: 6,
    createGraphicsDevice: async () => ({}),
    AppOptions: class {}, AppBase, Entity, Camera, RenderView: class {},
    Asset: class {
      constructor(name, type, file) { Object.assign(this, { name, type, file }); rec.assetUrls.push(file.url); }
      ready(cb) { this._ready = cb; }
      once() {}
    },
    Color: class {},
    CameraComponentSystem: 'cam', GSplatComponentSystem: 'gsplat', TextureHandler: 'tex', GSplatHandler: 'gsh',
    ShaderChunks: { get: () => ({ get: () => '', set() {} }) },
  };
  return { pc, rec };
}

function octreeResource({ camera, files = 5, loaded = 2 } = {}) {
  return {
    octree: { nodes: [], lodLevels: 5, files: Array.from({ length: files }, () => ({})), fileResources: new Map(Array.from({ length: loaded }, (_, i) => [i, {}])) },
    numSplats: 364374,
    aabb: { center: { x: 0, y: 0, z: 0 }, halfExtents: { x: 240, y: 240, z: 240 } },
    data: { version: 1, count: 705975, lodLevels: 5, tree: null, ...(camera ? { camera } : {}) },
  };
}

test('bytes of a lod-meta.json reject with the URL form in the message; the engine never loads', async (t) => {
  installDom();
  t.mock.method(console, 'warn', () => {});
  const { pc, rec } = fakePc(octreeResource());
  const bytes = enc('{"version":1,"lodLevels":5,"filenames":["0_0/meta.json"],"tree":{}}');
  await assert.rejects(
    attachPlayCanvasSplat({}, null, makeCanvas(320, 180), bytes, { playcanvas: pc, focusInput: false }, []),
    /Streamed SOG \(lod-meta\.json\) cannot be passed as bytes[\s\S]*lod-meta\.json'/,
  );
  assert.equal(rec.assetUrls.length, 0);
});

test('a directory URL loads <dir>/lod-meta.json and gets the 600k streamed budget on the scene', async () => {
  installDom();
  const { pc, rec } = fakePc(octreeResource());
  const out = {};
  await attachPlayCanvasSplat(out, null, makeCanvas(320, 180), 'https://cdn/x/v1/', { playcanvas: pc, focusInput: false }, []);
  assert.deepEqual(rec.assetUrls, ['https://cdn/x/v1/lod-meta.json']);
  assert.equal(rec.app.scene.gsplat.splatBudget, STREAMED_SPLAT_BUDGET);
  assert.equal(out.perf.splatBudget, STREAMED_SPLAT_BUDGET);
  out.remove();
});

test('a caller splatBudget wins on a Streamed SOG; perf:false leaves the engine’s 1M', async () => {
  installDom();
  let f = fakePc(octreeResource());
  let out = {};
  await attachPlayCanvasSplat(out, null, makeCanvas(320, 180), 'https://cdn/x/lod-meta.json', { playcanvas: f.pc, perf: { splatBudget: 250000 }, focusInput: false }, []);
  assert.equal(f.rec.app.scene.gsplat.splatBudget, 250000);
  out.remove();
  f = fakePc(octreeResource());
  out = {};
  await attachPlayCanvasSplat(out, null, makeCanvas(320, 180), 'https://cdn/x/lod-meta.json', { playcanvas: f.pc, perf: false, focusInput: false }, []);
  assert.equal(f.rec.app.scene.gsplat.splatBudget, 1000000, 'untouched');
  assert.equal(out.perf, null);
  out.remove();
});

test('a flat .sog gets NO streamed default (the engine budget does nothing there anyway)', async () => {
  installDom();
  const flat = { gsplatData: { numSplats: 10, meta: {} }, centers: new Float32Array(30) };
  const { pc, rec } = fakePc(flat);
  const out = {};
  await attachPlayCanvasSplat(out, null, makeCanvas(320, 180), 'https://cdn/x/a.sog', { playcanvas: pc, focusInput: false }, []);
  assert.equal(rec.app.scene.gsplat.splatBudget, 1000000);
  out.remove();
});

test('stats(): shape, resident/peak/firstFrameMs from the renderer, octree file counts', async () => {
  installDom();
  const { pc, rec } = fakePc(octreeResource({ files: 7, loaded: 3 }));
  const out = {};
  await attachPlayCanvasSplat(out, null, makeCanvas(320, 180), 'https://cdn/x/lod-meta.json', { playcanvas: pc, focusInput: false }, []);
  const s0 = out.stats();
  assert.deepEqual(Object.keys(s0).sort(), [
    'budget', 'files', 'filesLoaded', 'firstFrameMs', 'kind', 'lodLevels', 'numSplats', 'peakResident', 'resident', 'views',
  ]);
  assert.equal(s0.kind, 'streamed');
  assert.equal(s0.budget, STREAMED_SPLAT_BUDGET);
  assert.equal(s0.numSplats, 364374);
  assert.equal(s0.lodLevels, 5);
  assert.equal(s0.files, 7);
  assert.equal(s0.filesLoaded, 3);
  assert.equal(s0.firstFrameMs, null, 'nothing drawn yet');
  rec.app.renderer._gsplatCount = 0;
  out.viewer._afterTick();
  assert.equal(out.stats().firstFrameMs, null, 'an EMPTY frame is not the first frame');
  rec.app.renderer._gsplatCount = 412000;
  out.viewer._afterTick();
  rec.app.renderer._gsplatCount = 380000;
  out.viewer._afterTick();
  const s = out.stats();
  assert.equal(s.resident, 380000);
  assert.equal(s.peakResident, 412000);
  assert.equal(typeof s.firstFrameMs, 'number');
  out.remove();
});

test('the N-camera fallback splits the tile budget across its per-camera managers', async () => {
  installDom();
  const { pc, rec } = fakePc(octreeResource());
  const v = new PlayCanvasSplatViewer(makeCanvas(320, 180), { orbit: false });
  await v.attachEngine(pc, { perf: playcanvasPerfSettings({ splatBudget: 600000 }), viewPath: 'cameras' });
  assert.equal(rec.app.scene.gsplat.splatBudget, 600000, 'one view so far');
  v._budgetViews = 2;
  v._applyBudget();
  assert.equal(rec.app.scene.gsplat.splatBudget, 300000);
  assert.equal(v.tileBudget, 600000, 'the tile still reports its own budget');
  v.dispose();
});

test('Streamed SOG framing: a caller frame beats the octree root bound (floaters make it huge)', async () => {
  installDom();
  const { pc } = fakePc(octreeResource());
  const out = {};
  const frame = { center: [1, 2, 3], extent: [2, 2, 2] };
  await attachPlayCanvasSplat(out, null, makeCanvas(320, 180), 'https://cdn/x/lod-meta.json', { playcanvas: pc, frame, focusInput: false }, []);
  assert.deepEqual(out.frame, { center: [1, -2, -3], extent: [2, 2, 2] });
  out.remove();
});

test('octreeSample: count-proportional, deterministic, inside each box', () => {
  const nodes = [
    { min: [0, 0, 0], max: [1, 1, 1], count: 3000 },
    { min: [10, 10, 10], max: [11, 11, 11], count: 1000 },
  ];
  const a = octreeSample(nodes, 400);
  const b = octreeSample(nodes, 400);
  assert.deepEqual(a, b, 'same input → same sample (no Math.random)');
  assert.equal(a.length, 400 * 3);
  let inFirst = 0;
  for (let i = 0; i < a.length; i += 3) {
    const inA = a[i] >= 0 && a[i] <= 1 && a[i + 1] >= 0 && a[i + 1] <= 1 && a[i + 2] >= 0 && a[i + 2] <= 1;
    const inB = a[i] >= 10 && a[i] <= 11;
    assert.ok(inA || inB, 'every point is inside some node box');
    if (inA) inFirst++;
  }
  assert.equal(inFirst, 300, '3:1 by count');
  assert.equal(octreeSample([]), null);
  assert.equal(octreeSample([{ min: [0, 0, 0], max: [1, 1, 1], count: 0 }]), null);
});

test('describeResource frames a Streamed SOG from its leaf boxes, not the floater-sized root', () => {
  const box = (min, max) => ({
    center: { x: (min[0] + max[0]) / 2, y: (min[1] + max[1]) / 2, z: (min[2] + max[2]) / 2 },
    halfExtents: { x: (max[0] - min[0]) / 2, y: (max[1] - min[1]) / 2, z: (max[2] - min[2]) / 2 },
  });
  const nodes = [];
  // a dense 2 m subject in 8 nodes, and one huge sparse "sky shell" node
  for (let i = 0; i < 8; i++) nodes.push({ bounds: box([i * 0.25 - 1, -1, -1], [i * 0.25 - 0.75, 1, 1]), lods: [{ count: 50000 }] });
  nodes.push({ bounds: box([-240, -240, -240], [240, 240, 240]), lods: [{ count: 3000 }] });
  const d = describeResource({
    octree: { nodes },
    numSplats: 403000,
    aabb: box([-240, -240, -240], [240, 240, 240]),
    data: { version: 1 },
  });
  assert.equal(d.boundsSource, 'octree-sample');
  assert.ok(d.bounds.extent.every((e) => e < 3), `subject-sized, got ${d.bounds.extent}`);
  assert.deepEqual(d.rootBounds.extent, [480, 480, 480]);
});

test("engine:'spark' refuses a Streamed SOG URL by name, synchronously, before Spark sees it", async () => {
  const { STREAMED_NEEDS_PLAYCANVAS, isStreamedUrl: sharedIsStreamed } = await import('../js/inline3d-splat-shared.js');
  assert.equal(sharedIsStreamed, isStreamedUrl, 'one definition, shared by both engines');
  assert.match(STREAMED_NEEDS_PLAYCANVAS, /read only by engine:'playcanvas'/);
  const fs = await import('node:fs');
  const splat = fs.readFileSync(new URL('../js/inline3d-splat.js', import.meta.url), 'utf8');
  const body = splat.slice(splat.indexOf('export function addSplat('));
  const refuse = body.indexOf('if (isStreamedUrl(src)) throw new Error(');
  assert.ok(refuse > 0, 'the Spark branch refuses a streamed URL');
  assert.ok(refuse > body.indexOf("resolveSplatEngine(opts) === 'playcanvas'"), 'after the PlayCanvas branch returned');
  assert.ok(refuse < body.indexOf('new SplatMesh('), 'before Spark is handed the URL');
});

test('./splat refuses lod-meta BYTES at call time on the PlayCanvas engine (playcanvasCannotRead)', async () => {
  const { playcanvasCannotRead } = await import('../js/inline3d-splat-shared.js');
  const lod = enc('{"version":1,"lodLevels":3,"filenames":["0_0/meta.json"],"tree":{}}');
  assert.match(playcanvasCannotRead(lod), /cannot be passed as bytes/);
  assert.match(playcanvasCannotRead(lod.buffer), /cannot be passed as bytes/, 'an ArrayBuffer too');
  assert.equal(playcanvasCannotRead('https://cdn/x/v1/'), null, 'a directory URL is accepted');
  assert.equal(playcanvasCannotRead('https://cdn/x/v1/lod-meta.json'), null);
});

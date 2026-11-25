// The automatic program release (./inline3d-pc-auto-release.js), on a fake engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installAutoProgramRelease, patchMaterialPrototype, materialShapeProblem, autoReleaseStats, autoReleaseState, sweep } from '../js/inline3d-pc-auto-release.js';

// The engine's shape (2.22.x): Material.getShaderVariant links a program on params.device and
// MeshInstance stores it in material.variants; Material.destroy empties variants.
class Material {
  constructor() {
    this.variants = new Map();
    this.meshInstances = new Set();
  }
  getShaderVariant(params) {
    return params.device.link(params.key);
  }
  destroy() {
    this.variants.clear();
    for (const mi of this.meshInstances) mi.material = null;
    this.meshInstances.clear();
  }
}

function device() {
  const d = {
    shaders: [],
    library: new Map(), // ProgramLibrary: one Shader per key
    link(key) {
      let s = d.library.get(key);
      if (!s) {
        s = { key, device: d, destroy() { d.shaders.splice(d.shaders.indexOf(s), 1); d.library.delete(key); } };
        d.shaders.push(s);
        d.library.set(key, s);
      }
      return s;
    },
  };
  return d;
}

function app(dev) {
  const listeners = new Map();
  const root = { children: [] };
  root.findComponents = (kind) => (kind === 'render' ? root.children.filter((e) => !e.gone).map((e) => ({ meshInstances: e.mis })) : []);
  return {
    graphicsDevice: dev,
    root,
    scene: { layers: { layerList: [] } },
    assets: { list: () => [] },
    once(ev, fn) { (listeners.get(ev) || listeners.set(ev, []).get(ev)).push({ fn, once: true }); },
    on(ev, fn) { (listeners.get(ev) || listeners.set(ev, []).get(ev)).push({ fn, once: false }); },
    off(ev, fn) { listeners.set(ev, (listeners.get(ev) || []).filter((l) => fn && l.fn !== fn)); },
    fire(ev) {
      const ls = listeners.get(ev) || [];
      listeners.set(ev, ls.filter((l) => !l.once));
      for (const l of ls) l.fn();
    },
  };
}

// An entity under app.root drawing `material` with program `key` (as MeshInstance.getShaderInstance does).
function show(a, material, key) {
  const mi = { material, _shaderCache: new Map() };
  const s = material.getShaderVariant({ device: a.graphicsDevice, key });
  material.variants.set(key, s);
  material.meshInstances.add(mi);
  const e = { mis: [mi], destroy() { this.gone = true; } };
  a.root.children.push(e);
  return e;
}

test('a destroyed material\'s program is destroyed at the next frameend, and the library forgets it', () => {
  const dev = device();
  const a = app(dev);
  assert.equal(installAutoProgramRelease(a, Material), 'patched');
  const m = new Material();
  const e = show(a, m, 'product-1');
  assert.equal(dev.shaders.length, 1);
  e.destroy();
  m.destroy(); // what asset.unload() does to a container's materials
  assert.equal(dev.shaders.length, 1, 'deferred: content added in the same frame has not drawn yet');
  a.fire('frameend');
  assert.equal(dev.shaders.length, 0);
  assert.equal(dev.library.size, 0, 'a later ask for the variant compiles again');
  assert.equal(autoReleaseStats(a).released, 1);
});

test('a program the incoming content shares is kept (one Shader per key)', () => {
  const dev = device();
  const a = app(dev);
  installAutoProgramRelease(a, Material);
  const old = new Material();
  const oe = show(a, old, 'standard');
  oe.destroy();
  old.destroy();
  show(a, new Material(), 'standard'); // the next product, same options, drawn this frame
  a.fire('frameend');
  assert.equal(dev.shaders.length, 1);
});

test('a live material the page keeps off-scene still holds its program', () => {
  const dev = device();
  const a = app(dev);
  installAutoProgramRelease(a, Material);
  const kept = new Material();
  const ke = show(a, kept, 'shared');
  ke.destroy(); // taken out of the scene, material kept to show again
  const gone = new Material();
  const ge = show(a, gone, 'shared');
  ge.destroy();
  gone.destroy();
  a.fire('frameend');
  assert.equal(dev.shaders.length, 1, 'destroying it would leave a dead program in kept.variants');
  kept.destroy();
  a.fire('frameend');
  assert.equal(dev.shaders.length, 0, 'released with its last material');
});

test('a program already destroyed (releaseEntity) is not destroyed twice', () => {
  const dev = device();
  const a = app(dev);
  installAutoProgramRelease(a, Material);
  const m = new Material();
  const e = show(a, m, 'p');
  const s = dev.shaders[0];
  let calls = 0;
  const orig = s.destroy;
  s.destroy = function () { calls++; return orig.call(this); };
  e.destroy();
  m.destroy();
  s.destroy(); // the page released it itself
  a.fire('frameend');
  assert.equal(calls, 1);
});

test('materials on a device the SDK did not create are left alone', () => {
  const sdk = device();
  installAutoProgramRelease(app(sdk), Material);
  const pageDev = device();
  const pageApp = app(pageDev);
  const m = new Material();
  const e = show(pageApp, m, 'page-own');
  e.destroy();
  m.destroy();
  pageApp.fire('frameend');
  assert.equal(pageDev.shaders.length, 1);
});

test('the page\'s own frameend listeners survive the sweep', () => {
  const dev = device();
  const a = app(dev);
  installAutoProgramRelease(a, Material);
  let pageTicks = 0;
  a.on('frameend', () => pageTicks++);
  const m = new Material();
  const e = show(a, m, 'p');
  e.destroy();
  m.destroy();
  a.fire('frameend');
  a.fire('frameend');
  assert.equal(pageTicks, 2);
});

test('a stopped app still sweeps on the backup timer', async () => {
  const dev = device();
  const a = app(dev);
  installAutoProgramRelease(a, Material);
  const m = new Material();
  const e = show(a, m, 'p');
  e.destroy();
  m.destroy();
  const st = autoReleaseState(a);
  assert.ok(st.scheduled);
  assert.equal(sweep(st), 1); // what the timer calls
  assert.equal(sweep(st), 0, 'idempotent');
});

test('24 distinct products swapped under one app: live programs stay bounded', () => {
  const dev = device();
  const a = app(dev);
  installAutoProgramRelease(a, Material);
  let prev = null;
  const peaks = [];
  for (let i = 0; i < 24; i++) {
    const mats = [new Material(), new Material()];
    const ents = mats.map((m, j) => show(a, m, `p${i}-${j}`)); // ~2 new programs per product
    if (prev) for (const { e, m } of prev) { e.destroy(); m.destroy(); }
    a.fire('frameend');
    peaks.push(dev.shaders.length);
    prev = ents.map((e, j) => ({ e, m: mats[j] }));
  }
  assert.ok(Math.max(...peaks) <= 2, `live programs ${peaks.join(',')}`);
});

test('an engine whose Material no longer has the expected shape is not patched', () => {
  assert.match(materialShapeProblem({}), /no Material/);
  class Other { getShaderVariant() {} destroy() { /* nothing */ } }
  assert.match(patchMaterialPrototype(Other.prototype), /^skipped: Material.destroy no longer clears/);
  const dev = device();
  assert.match(installAutoProgramRelease(app(dev), Other), /^skipped/);
});

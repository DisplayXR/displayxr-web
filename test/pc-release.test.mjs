// handle.releaseEntity's core (./inline3d-pc-release.js), on a fake app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { releaseEntity, liveShaders, materialShaders } from '../js/inline3d-pc-release.js';

const prog = (name) => ({ name, destroyed: false, destroy() { this.destroyed = true; } });
const mat = (...shaders) => ({ variants: new Map(shaders.map((s, i) => [i, s])) });
const mi = (material, mesh = {}) => ({ material, mesh, _shaderCache: new Map() });

function node(mis = [], children = []) {
  const n = {
    mis,
    children,
    parent: null,
    findComponents(kind) {
      if (kind !== 'render') return [];
      const out = [];
      const walk = (x) => {
        if (x.mis.length) out.push({ meshInstances: x.mis });
        x.children.forEach(walk);
      };
      walk(this);
      return out;
    },
    destroy() {
      const p = this.parent;
      if (p) p.children.splice(p.children.indexOf(this), 1);
      this.destroyed = true;
    },
  };
  for (const c of children) c.parent = n;
  return n;
}
function app(children = [], { layerMis = [], assets = [] } = {}) {
  const root = node([], children);
  const list = [...assets];
  return {
    root,
    scene: { layers: { layerList: [{ meshInstances: layerMis }] } },
    assets: {
      list: () => list,
      remove: (a) => list.splice(list.indexOf(a), 1),
    },
  };
}

test('the entity\'s programs are destroyed, except one something else still draws with', () => {
  const own = prog('own');
  const shared = prog('shared');
  const gone = node([mi(mat(own, shared))]);
  const kept = node([mi(mat(shared))]);
  const a = app([gone, kept]);
  const r = releaseEntity(a, gone);
  assert.deepEqual(r, { programs: 1, container: null });
  assert.ok(gone.destroyed);
  assert.ok(own.destroyed);
  assert.equal(shared.destroyed, false, 'ProgramLibrary hands one Shader to every material with the same key');
});

test('a mesh instance\'s own shader cache counts, and layer mesh instances and registry materials keep theirs', () => {
  const viaCache = prog('cache');
  const inLayer = prog('layer');
  const inRegistry = prog('registry');
  const m = mi(mat(inLayer, inRegistry));
  m._shaderCache.set(1, { shader: viaCache });
  const gone = node([m]);
  const a = app([gone], { layerMis: [mi(mat(inLayer))], assets: [{ type: 'material', resource: mat(inRegistry) }] });
  assert.equal(releaseEntity(a, gone).programs, 1);
  assert.ok(viaCache.destroyed);
  assert.equal(inLayer.destroyed, false);
  assert.equal(inRegistry.destroyed, false);
});

test('the container: unloaded (and its materials\' programs released) when nothing else draws from it', () => {
  const p = prog('p');
  const material = mat(p);
  const mesh = {};
  const container = { materials: [{ resource: material }], renders: [{ resource: { meshes: [mesh] } }] };
  const asset = { resource: container, unloaded: false, unload() { this.unloaded = true; } };
  const gone = node([mi(material, mesh)]);
  const a = app([gone], { assets: [asset] });
  const r = releaseEntity(a, gone, { asset });
  assert.deepEqual(r, { programs: 1, container: 'unloaded' });
  assert.ok(asset.unloaded);
  assert.equal(a.assets.list().includes(asset), false, 'out of the registry');
});

test('the container stays when another instance still draws from it; nothing it shares is destroyed', () => {
  const p = prog('p');
  const material = mat(p);
  const mesh = {};
  const container = { materials: [{ resource: material }], renders: [{ resource: { meshes: [mesh] } }] };
  const asset = { resource: container, unloaded: false, unload() { this.unloaded = true; } };
  const gone = node([mi(material, mesh)]);
  const twin = node([mi(material, mesh)]);
  const a = app([gone, twin], { assets: [asset] });
  assert.deepEqual(releaseEntity(a, gone, { asset }), { programs: 0, container: 'in-use' });
  assert.equal(asset.unloaded, false);
  assert.equal(p.destroyed, false);
});

test('helpers: materialShaders collects variants; liveShaders sees disabled content under root', () => {
  const s = prog('s');
  assert.deepEqual([...materialShaders([mat(s), null])], [s]);
  const a = app([node([mi(mat(s))])]);
  assert.ok(liveShaders(a).has(s));
  assert.deepEqual(releaseEntity(null, null), { programs: 0, container: null });
});

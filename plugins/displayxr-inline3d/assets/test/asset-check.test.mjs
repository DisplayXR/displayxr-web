// node --test plugins/displayxr-inline3d/assets/test/asset-check.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'asset-check.mjs');
const dir = mkdtempSync(join(tmpdir(), 'asset-check-'));

// A PNG header claiming w x h (enough for the size probe).
const png = (w, h) => { const b = Buffer.alloc(33); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };

function glb({ tris = 1, scale = 1, tex = 1024, offset = 0, extra = {} } = {}) {
  const pos = new Float32Array([-0.15, -0.15, 0, 0.15, -0.15, 0, 0, 0.15, 0]);
  const img = png(tex, tex);
  const bin = Buffer.concat([Buffer.from(pos.buffer), img, Buffer.alloc((4 - (img.length % 4)) % 4)]);
  const json = {
    asset: { version: '2.0' },
    scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, scale: [scale, scale, scale], translation: [offset, 0, 0] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { metallicFactor: 0, baseColorTexture: { index: 0 } } }],
    textures: [{ source: 0 }],
    images: [{ bufferView: 1, mimeType: 'image/png' }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3 * tris, type: 'VEC3', min: [-0.15, -0.15, 0], max: [0.15, 0.15, 0] }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: img.length }],
    buffers: [{ byteLength: bin.length }],
    ...extra,
  };
  let j = Buffer.from(JSON.stringify(json));
  j = Buffer.concat([j, Buffer.alloc((4 - (j.length % 4)) % 4, 0x20)]);
  const head = Buffer.alloc(12); head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + j.length + 8 + bin.length, 8);
  const c = (t, d) => { const h = Buffer.alloc(8); h.writeUInt32LE(d.length, 0); h.writeUInt32LE(t, 4); return Buffer.concat([h, d]); };
  return Buffer.concat([head, c(0x4e4f534a, j), c(0x004e4942, bin)]);
}
function check(name, buf, ...args) {
  const p = join(dir, name); writeFileSync(p, buf);
  const r = spawnSync(process.execPath, [BIN, p, '--json', ...args], { encoding: 'utf8' });
  const out = JSON.parse(r.stdout);
  return { code: r.status, out, by: (id) => out.checks.find((c) => c.id === id) };
}

test('a small, metric, self-contained model passes', () => {
  const r = check('ok.glb', glb());
  assert.equal(r.out.verdict, 'pass', JSON.stringify(r.out.checks));
  assert.equal(r.code, 0);
});
test('an 8K texture fails on the tablet budget and passes the decoded-size check on desktop only with a warn', () => {
  const r = check('tex.glb', glb({ tex: 8192 }));
  assert.equal(r.by('textures').status, 'fail');
  assert.equal(r.code, 1);
  assert.equal(check('tex2.glb', glb({ tex: 8192 }), '--target', 'desktop').by('textures').status, 'warn');
});
test('too many triangles: warn, then fail', () => {
  assert.equal(check('t1.glb', glb({ tris: 400_000 })).by('triangles').status, 'warn');
  assert.equal(check('t2.glb', glb({ tris: 2_000_000 })).by('triangles').status, 'fail');
});
test('centimetre-scale bounds are flagged', () => {
  assert.equal(check('cm.glb', glb({ scale: 1000 })).by('scale').status, 'warn');
});
test('a model far from its own origin gets a pivot warning', () => {
  assert.equal(check('piv.glb', glb({ offset: 2 })).by('pivot').status, 'warn');
});
test('Draco needs served decoder files', () => {
  const r = check('draco.glb', glb({ extra: { extensionsUsed: ['KHR_draco_mesh_compression'] } }));
  assert.match(r.by('decoders').summary, /draco/i);
});
test('a .gltf with a missing external file fails', () => {
  const g = { asset: { version: '2.0' }, buffers: [{ uri: 'missing.bin', byteLength: 4 }], scenes: [{ nodes: [] }] };
  const r = check('ext.gltf', Buffer.from(JSON.stringify(g)));
  assert.equal(r.by('files').status, 'fail');
});

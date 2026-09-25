// Tests for js/lift/providers/models.js — manifest parsing, sha256 verification, Cache API reuse,
// and the native-store preference. Pure: fetch / caches are recording fakes, WebCrypto is Node's.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  parseManifest, createModelSource, sha256Hex, VERIFIED_HEADER, CACHE_NAME,
} from '../js/lift/providers/models.js';

const shipped = JSON.parse(readFileSync(new URL('../js/lift/models.json', import.meta.url), 'utf8'));
const BYTES = new TextEncoder().encode('not really an onnx graph, but 58 bytes of deterministic data');
const SHA = createHash('sha256').update(BYTES).digest('hex');

const manifest = (over = {}) => ({
  schema: 1,
  generated: 'test',
  defaults: { 'depth-video': { low: 'v-low', medium: 'v-med' }, 'depth-still': 's' },
  models: [
    { name: 'v-med', version: '1', role: 'depth-video', format: 'onnx', precision: 'w16', license: 'x',
      files: [{ path: 'vda/med.onnx', sha256: SHA, size: BYTES.byteLength, url: '${baseUrl}/vda/med.onnx' }], ...over },
    { name: 'v-low', version: '1', role: 'depth-video', format: 'onnx', precision: 'w16', license: 'x',
      files: [{ path: 'vda/low.onnx', sha256: SHA, size: BYTES.byteLength }] },
    { name: 's', version: '1', role: 'depth-still', format: 'onnx', precision: 'fp16', license: 'x',
      files: [{ path: 's.onnx', sha256: SHA, size: BYTES.byteLength }] },
  ],
});

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url) => {
    calls.push(String(url));
    const body = routes[String(url)];
    if (body === undefined) return new Response('nope', { status: 404 });
    if (body instanceof Error) throw body;
    return new Response(body, { headers: { 'content-length': String(body.byteLength) } });
  };
  fn.calls = calls;
  return fn;
}

function fakeCaches() {
  const stores = new Map();
  return {
    stores,
    async open(name) {
      if (!stores.has(name)) {
        const m = new Map();
        stores.set(name, {
          map: m,
          async match(u) { const r = m.get(u); return r ? r.clone() : undefined; },
          async put(u, r) { m.set(u, r.clone()); },
          async delete(u) { return m.delete(u); },
        });
      }
      return stores.get(name);
    },
    async delete(name) { return stores.delete(name); },
  };
}

test('the shipped models.json parses and every entry is well-formed', () => {
  const m = parseManifest(shipped);
  assert.equal(m.schema, 1);
  for (const role of ['depth-video', 'depth-still', 'inpaint'])
    assert.ok(m.models.some((e) => e.role === role), `has a ${role} model`);
  for (const e of m.models) for (const f of e.files) assert.match(f.sha256, /^[0-9a-f]{64}$/);
  // the defaults must name real entries — a typo here is a load-time 404 in the field
  const walk = (v) => (typeof v === 'string' ? [v] : Object.values(v).flatMap(walk));
  for (const n of walk(m.defaults)) assert.ok(m.byName.has(n), `default ${n} exists`);
  // static video models: the cache width is the one the graph was exported with
  for (const e of m.models.filter((x) => x.role === 'depth-video')) {
    const { width: w, height: h, cacheShape } = e.io;
    const ph = h / 14, pw = w / 14, d0 = ph * pw, d1 = Math.ceil(ph / 2) * Math.ceil(pw / 2), d3 = 4 * ph * pw;
    assert.deepEqual(cacheShape, [42, 2 * (d0 * 192 + d1 * 384 + d0 * 64 + d3 * 64)]);
  }
});

test('parseManifest rejects structural errors loudly', () => {
  assert.throws(() => parseManifest({ ...manifest(), schema: 2 }), /schema/);
  assert.throws(() => parseManifest({ schema: 1 }), /models/);
  assert.throws(() => parseManifest(manifest({ role: 'depth' })), /bad role/);
  assert.throws(() => parseManifest(manifest({ files: [{ path: '../x.onnx', sha256: SHA, size: 1 }] })), /bad file path/);
  assert.throws(() => parseManifest(manifest({ files: [{ path: 'x.onnx', sha256: 'abc', size: 1 }] })), /sha256/);
  const dup = manifest(); dup.models.push({ ...dup.models[0] });
  assert.throws(() => parseManifest(dup), /duplicate/);
});

test('sha256Hex matches node:crypto', async () => {
  assert.equal(await sha256Hex(BYTES), SHA);
});

test('url/has/defaultFor resolve against baseUrl', () => {
  const src = createModelSource({ baseUrl: 'https://cdn.example/m', manifest: manifest(), caches: null });
  assert.equal(src.url('v-med'), 'https://cdn.example/m/vda/med.onnx');
  assert.equal(src.url('v-med/vda/med.onnx'), 'https://cdn.example/m/vda/med.onnx');
  assert.ok(src.has('s'));
  assert.ok(!src.has('nope'));
  assert.equal(src.defaultFor('depth-video', 'low'), 'v-low');
  assert.equal(src.defaultFor('depth-video', 'high'), 'v-med');   // unknown tier → medium
  assert.equal(src.defaultFor('depth-still', 'low'), 's');         // string default = every tier
});

test('network download is verified, cached with a stamp, then served from cache without refetch', async () => {
  const fetch = fakeFetch({ 'https://m/vda/med.onnx': BYTES });
  const caches = fakeCaches();
  const src = createModelSource({ baseUrl: 'https://m/', manifest: manifest(), fetch, caches, native: false });
  const progress = [];
  const a = await src.getBytes('v-med', { onProgress: (p) => progress.push(p) });
  assert.equal(a.source, 'network');
  assert.deepEqual([...a.bytes], [...BYTES]);
  assert.equal(progress.at(-1).loaded, BYTES.byteLength);
  assert.equal(progress.at(-1).total, BYTES.byteLength);
  const stored = caches.stores.get(CACHE_NAME).map.get('https://m/vda/med.onnx');
  assert.equal(stored.headers.get(VERIFIED_HEADER), SHA);

  const b = await src.get('v-med');
  assert.equal(b.source, 'cache');
  assert.equal(b.sha256, SHA);
  assert.equal(b.size, BYTES.byteLength);
  const back = new Uint8Array(await new Response(b.stream).arrayBuffer());
  assert.deepEqual([...back], [...BYTES]);
  assert.equal(fetch.calls.length, 1, 'cache hit must not refetch');
});

test('a corrupted download is rejected and NOT cached', async () => {
  const bad = BYTES.slice(); bad[3] ^= 0xff;
  const fetch = fakeFetch({ 'https://m/vda/med.onnx': bad });
  const caches = fakeCaches();
  const src = createModelSource({ baseUrl: 'https://m', manifest: manifest(), fetch, caches, native: false });
  await assert.rejects(src.getBytes('v-med'), (e) => e.code === 'EINTEGRITY' && /sha256 mismatch/.test(e.message));
  assert.equal(caches.stores.get(CACHE_NAME).map.size, 0);
});

test('a truncated download fails on size before hashing', async () => {
  const fetch = fakeFetch({ 'https://m/vda/med.onnx': BYTES.slice(0, 10) });
  const src = createModelSource({ baseUrl: 'https://m', manifest: manifest(), fetch, caches: null, native: false });
  await assert.rejects(src.getBytes('v-med'), /size 10/);
});

test('an unstamped / poisoned cache entry is re-verified: good bytes get stamped, bad bytes evicted', async () => {
  const caches = fakeCaches();
  const c = await caches.open(CACHE_NAME);
  await c.put('https://m/vda/med.onnx', new Response(BYTES));            // good, no stamp
  const bad = BYTES.slice(); bad[0] ^= 1;
  await c.put('https://m/vda/low.onnx', new Response(bad));              // poisoned
  const fetch = fakeFetch({ 'https://m/vda/low.onnx': BYTES });
  const src = createModelSource({ baseUrl: 'https://m', manifest: manifest(), fetch, caches, native: false });

  const a = await src.getBytes('v-med');
  assert.equal(a.source, 'cache');
  assert.equal(c.map.get('https://m/vda/med.onnx').headers.get(VERIFIED_HEADER), SHA);

  const b = await src.getBytes('v-low');
  assert.equal(b.source, 'network', 'poisoned entry must be refetched');
  assert.deepEqual([...b.bytes], [...BYTES]);
  assert.deepEqual(fetch.calls, ['https://m/vda/low.onnx']);
});

test('the native store is preferred when advertised, and falls back to the network when it fails', async () => {
  const fetch = fakeFetch({ 'displayxr-lift://models/v-med': BYTES, 'https://m/s.onnx': BYTES });
  const src = createModelSource({ baseUrl: 'https://m', manifest: manifest(), fetch, caches: null, native: true });
  assert.equal((await src.getBytes('v-med')).source, 'native');
  assert.equal((await src.getBytes('s')).source, 'network');   // native 404 → network
  assert.deepEqual(fetch.calls, ['displayxr-lift://models/v-med', 'displayxr-lift://models/s', 'https://m/s.onnx']);
});

test('globalThis.__dxrLiftNative turns the native path on in auto mode', async () => {
  const fetch = fakeFetch({ 'displayxr-lift://models/s': BYTES });
  globalThis.__dxrLiftNative = true;
  try {
    const src = createModelSource({ baseUrl: 'https://m', manifest: manifest(), fetch, caches: null });
    assert.equal((await src.getBytes('s')).source, 'native');
  } finally { delete globalThis.__dxrLiftNative; }
});

test('a manifest URL is fetched lazily; sync accessors demand ready()', async () => {
  const fetch = async (u) => (String(u) === 'https://m/models.json'
    ? new Response(JSON.stringify(manifest())) : new Response('', { status: 404 }));
  const src = createModelSource({ baseUrl: 'https://m', manifest: 'https://m/models.json', fetch, caches: null });
  assert.throws(() => src.url('s'), /ready/);
  await src.ready();
  assert.equal(src.url('s'), 'https://m/s.onnx');
});

test('families resolve by quality; concrete names pass through; unknown names throw', () => {
  const src = createModelSource({ baseUrl: 'https://m', manifest: shipped, caches: null });
  assert.equal(src.resolveName('vda-small', 'depth-video', 'low'), 'vda-small-stream-364x210');
  assert.equal(src.resolveName('vda-small', 'depth-video', 'medium'), 'vda-small-stream-518x294');
  assert.equal(src.resolveName('moge3', 'depth-still', 'medium'), 'moge3-vitl-770x434');
  assert.equal(src.resolveName('moge3', 'depth-still', 'high'), 'moge3-vitl-1022x574');
  assert.equal(src.resolveName('da3', 'depth-still', 'high'), 'da3mono-large-1022x574');
  assert.equal(src.resolveName(undefined, 'depth-still', 'low'), 'da2-small');
  assert.equal(src.resolveName(undefined, 'depth-still', 'medium'), 'moge3-vitl-770x434');
  assert.equal(src.resolveName('da2-small', 'depth-still', 'high'), 'da2-small');
  assert.equal(src.resolveName(undefined, 'inpaint', 'high'), 'light-inpaint-v1-1024x576');
  assert.throws(() => src.resolveName('nope', 'depth-still'), /unknown model or family/);
  assert.throws(() => parseManifest({ ...manifest(), families: { f: { role: 'inpaint', low: 'ghost' } } }), /unknown model ghost/);
});

test('a poisoned cache entry is evicted even when the refetch fails (no poisoned hit next time)', async () => {
  const caches = fakeCaches();
  const c = await caches.open(CACHE_NAME);
  const bad = BYTES.slice(); bad[0] ^= 1;
  await c.put('https://m/s.onnx', new Response(bad));
  const src = createModelSource({ baseUrl: 'https://m', manifest: manifest(), fetch: fakeFetch({}), caches, native: false });
  await assert.rejects(src.getBytes('s'), /HTTP 404/);
  assert.equal(c.map.has('https://m/s.onnx'), false);
});

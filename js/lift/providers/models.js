// models.js — resolve, fetch, verify and cache the lift models (`js/lift/models.json`).
//
// Models are NEVER bundled into the SDK and never committed to git. A page points a model source
// at wherever it hosts the .onnx files (`baseUrl`), and this module:
//
//   1. prefers the DisplayXR Browser's native model store (`displayxr-lift://models/<name>`) when
//      the browser advertises it (`globalThis.__dxrLiftNative`, or the page itself is served from
//      that scheme) — the browser ships/verifies the weights, so nothing is downloaded (Phase A);
//   2. otherwise fetches `baseUrl + path`, streaming with progress (Content-Length), verifies the
//      byte count and the sha256 from the manifest (WebCrypto), and streams the bytes into the
//      Cache API (`caches.open('dxr-lift-models')`) plus a separate "verified" stamp entry
//      (see stampKey), so a warm load is a cache hit with no re-hash;
//   3. falls back to a plain verified fetch when the Cache API is unavailable (http:, opaque
//      origins, private modes that throw).
//
// Schema 1 manifest:
//   { schema: 1, generated, defaults?, models: [ { name, version, role, format, precision, license,
//       io?, files: [ { path, sha256, size, url } ] } ] }
// `role` ∈ 'depth-video' | 'depth-still' | 'inpaint'. A model's primary file is files[0]; `get(name)`
// returns it (`get('name/<path>')` addresses a secondary file, for future external-data models).

export const MANIFEST_SCHEMA = 1;
export const CACHE_NAME = 'dxr-lift-models';
export const NATIVE_ORIGIN = 'displayxr-lift://models/';
/**
 * Cache key of the "verified" stamp for a model URL: a tiny entry whose body is the sha256 the
 * cached bytes matched. Kept separate from the body entry so the body can be streamed in.
 */
export function stampKey(u) {
  return u + (u.includes('?') ? '&' : '?') + 'dxr-lift-verified-sha256';
}

const ROLES = new Set(['depth-video', 'depth-still', 'inpaint']);
const HEX64 = /^[0-9a-f]{64}$/;

/** URL of the manifest shipped next to this module. */
export const DEFAULT_MANIFEST_URL = new URL('../models.json', import.meta.url).href;

/**
 * Validate and index a schema-1 manifest. Throws a descriptive Error on any structural problem
 * (a bad manifest is a packaging bug — fail loudly, before any download starts).
 */
export function parseManifest(json) {
  const m = typeof json === 'string' ? JSON.parse(json) : json;
  if (!m || typeof m !== 'object') throw new Error('lift manifest: not an object');
  if (m.schema !== MANIFEST_SCHEMA) throw new Error(`lift manifest: unsupported schema ${m.schema} (want ${MANIFEST_SCHEMA})`);
  if (!Array.isArray(m.models)) throw new Error('lift manifest: `models` must be an array');
  const byName = new Map();
  for (const e of m.models) {
    const where = `lift manifest: model ${JSON.stringify(e && e.name)}`;
    if (!e || typeof e.name !== 'string' || !e.name) throw new Error(`${where}: missing name`);
    if (byName.has(e.name)) throw new Error(`${where}: duplicate name`);
    if (!ROLES.has(e.role)) throw new Error(`${where}: bad role ${JSON.stringify(e.role)}`);
    if (e.format !== 'onnx') throw new Error(`${where}: unsupported format ${JSON.stringify(e.format)}`);
    if (!Array.isArray(e.files) || !e.files.length) throw new Error(`${where}: no files`);
    for (const f of e.files) {
      if (!f || typeof f.path !== 'string' || !f.path || f.path.startsWith('/') || f.path.includes('..'))
        throw new Error(`${where}: bad file path ${JSON.stringify(f && f.path)}`);
      if (typeof f.sha256 !== 'string' || !HEX64.test(f.sha256)) throw new Error(`${where}: bad sha256 for ${f.path}`);
      if (!Number.isSafeInteger(f.size) || f.size <= 0) throw new Error(`${where}: bad size for ${f.path}`);
    }
    byName.set(e.name, e);
  }
  const families = m.families || {};
  for (const [fam, f] of Object.entries(families)) {
    if (!f || !ROLES.has(f.role)) throw new Error(`lift manifest: family ${fam}: bad role`);
    for (const q of ['low', 'medium', 'high']) if (f[q] && !byName.has(f[q])) throw new Error(`lift manifest: family ${fam}.${q} → unknown model ${f[q]}`);
  }
  return { schema: m.schema, generated: m.generated, defaults: m.defaults || {}, families, models: m.models, byName };
}

/** Lowercase hex sha256 of an ArrayBuffer / view, via WebCrypto. */
export async function sha256Hex(bytes, cryptoImpl = globalThis.crypto) {
  if (!cryptoImpl || !cryptoImpl.subtle) throw new Error('lift models: WebCrypto (crypto.subtle) unavailable — needs a secure context');
  const digest = await cryptoImpl.subtle.digest('SHA-256', bytes);
  const b = new Uint8Array(digest);
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

/** Drain a ReadableStream into one Uint8Array, reporting progress. */
export async function readAll(stream, { total = 0, onProgress, signal, name } = {}) {
  const reader = stream.getReader();
  const chunks = [];
  let loaded = 0;
  try {
    for (;;) {
      if (signal && signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.byteLength;
      if (onProgress) onProgress({ name, loaded, total: total || loaded });
    }
  } finally {
    reader.releaseLock?.();
  }
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(loaded);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out;
}

const bytesStream = (bytes) => new Response(bytes).body;

function joinUrl(base, path) {
  return base.endsWith('/') ? base + path : `${base}/${path}`;
}

function integrityError(msg) {
  const e = new Error(msg);
  e.code = 'EINTEGRITY';
  return e;
}

/**
 * Create a model source.
 * @param {object} [o]
 * @param {string} [o.baseUrl]   where the .onnx files live (joined with each file's `path`)
 * @param {object|string} [o.manifest]  parsed manifest object, or a URL to fetch; default: the
 *                                      models.json shipped next to this module
 * @param {boolean} [o.native]   force (true) / forbid (false) the displayxr-lift:// native store;
 *                               default: auto (`globalThis.__dxrLiftNative` or protocol)
 * @param {boolean} [o.verify=true]     sha256-verify network downloads
 * @param {string}  [o.cacheName]       Cache API bucket (default 'dxr-lift-models'); null disables
 * @param {Function} [o.fetch] [o.caches] [o.crypto]   injectable for tests
 */
export function createModelSource(o = {}) {
  const fetchImpl = o.fetch || ((...a) => globalThis.fetch(...a));
  const cachesImpl = 'caches' in o ? o.caches : globalThis.caches;
  const cryptoImpl = o.crypto || globalThis.crypto;
  const cacheName = o.cacheName === undefined ? CACHE_NAME : o.cacheName;
  const verify = o.verify !== false;
  const baseUrl = o.baseUrl;

  let manifest = null;
  let readyP = null;
  if (o.manifest && typeof o.manifest === 'object') manifest = parseManifest(o.manifest);

  function ready() {
    if (manifest) return Promise.resolve(manifest);
    if (!readyP) {
      const url = typeof o.manifest === 'string' ? o.manifest : DEFAULT_MANIFEST_URL;
      readyP = (async () => {
        const r = await fetchImpl(url);
        if (!r.ok) throw new Error(`lift models: manifest ${url} → HTTP ${r.status}`);
        manifest = parseManifest(await r.json());
        return manifest;
      })();
      readyP.catch(() => { readyP = null; });
    }
    return readyP;
  }

  function need() {
    if (!manifest) throw new Error('lift models: manifest not loaded yet — `await source.ready()` first');
    return manifest;
  }

  /** Split 'model' | 'model/<path>' into { entry, file }. */
  function lookup(name) {
    const m = need();
    let entry = m.byName.get(name);
    let file = entry && entry.files[0];
    if (!entry) {
      const i = name.indexOf('/');
      if (i > 0) {
        entry = m.byName.get(name.slice(0, i));
        file = entry && entry.files.find((f) => f.path === name.slice(i + 1));
      }
    }
    if (!entry || !file) throw new Error(`lift models: unknown model ${JSON.stringify(name)}`);
    return { entry, file };
  }

  function useNative() {
    if (o.native !== undefined) return !!o.native;
    if (globalThis.__dxrLiftNative) return true;
    const proto = globalThis.location && globalThis.location.protocol;
    return proto === 'displayxr-lift:' || proto === 'displayxr:';
  }

  function url(name) {
    const { file } = lookup(name);
    if (baseUrl) return joinUrl(baseUrl, file.path);
    if (file.url && !file.url.includes('${')) return file.url;
    throw new Error('lift models: no `baseUrl` given and the manifest has no absolute url for ' + name);
  }

  async function openCache() {
    if (!cachesImpl || cacheName === null) return null;
    try { return await cachesImpl.open(cacheName); } catch { return null; } // opaque origin / private mode
  }

  async function checkBytes(bytes, file, name) {
    if (bytes.byteLength !== file.size)
      throw integrityError(`lift models: ${name}: size ${bytes.byteLength} ≠ manifest ${file.size}`);
    if (!verify) return;
    const h = await sha256Hex(bytes, cryptoImpl);
    if (h !== file.sha256) throw integrityError(`lift models: ${name}: sha256 mismatch (got ${h}, want ${file.sha256})`);
  }

  /**
   * Resolve bytes for a model. Returns { bytes, size, sha256, source: 'native'|'cache'|'network' }.
   * `bytes` is a Uint8Array (what ORT's InferenceSession.create wants).
   */
  async function getBytes(name, { signal, onProgress } = {}) {
    await ready();
    const { file } = lookup(name);

    if (useNative()) {
      try {
        const r = await fetchImpl(NATIVE_ORIGIN + encodeURIComponent(name), { signal });
        if (r.ok && r.body) {
          const total = +(r.headers.get('content-length') || file.size);
          const bytes = await readAll(r.body, { total, onProgress, signal, name });
          return { bytes, size: bytes.byteLength, sha256: file.sha256, source: 'native' };
        }
      } catch (e) {
        if (signal && signal.aborted) throw e;
        // native store absent/refused — fall through to the network path
      }
    }

    const u = url(name);
    const sk = stampKey(u);
    const cache = await openCache();
    if (cache) {
      try {
        const hit = await cache.match(u);
        if (hit) {
          const st = await cache.match(sk);
          const stamp = st ? (await st.text()).trim() : '';
          const bytes = new Uint8Array(await hit.arrayBuffer());
          if (onProgress) onProgress({ name, loaded: bytes.byteLength, total: bytes.byteLength });
          if (stamp === file.sha256 && bytes.byteLength === file.size)
            return { bytes, size: bytes.byteLength, sha256: file.sha256, source: 'cache' };
          // stale or unstamped entry: re-verify once; drop it if it is not the manifest's bytes
          try {
            await checkBytes(bytes, file, name);
            await cache.put(sk, new Response(file.sha256));
            return { bytes, size: bytes.byteLength, sha256: file.sha256, source: 'cache' };
          } catch {
            await cache.delete(u);
            await cache.delete(sk);
          }
        }
      } catch (e) {
        if (e && e.code === 'EINTEGRITY') throw e;
      }
    }

    const r = await fetchImpl(u, { signal });
    if (!r.ok) throw new Error(`lift models: ${u} → HTTP ${r.status}`);
    const total = +(r.headers.get('content-length') || file.size);
    // Cache by STREAMING the response body into the Cache API (tee), not by putting the assembled
    // buffer: Chrome refuses a ~700 MB in-memory Response in Cache.put ("Unexpected internal
    // error") but accepts the same bytes streamed. The verified stamp is a separate tiny entry,
    // written only after the sha256 matches; a mismatch deletes the body entry.
    let body = r.body;
    /** @type {Promise<boolean> | null} */
    let putP = null;
    if (cache && body) {
      const [toCache, toRead] = body.tee();
      body = toRead;
      putP = cache.put(u, new Response(toCache, {
        headers: { 'content-type': 'application/octet-stream', 'content-length': String(file.size) },
      })).then(() => true, (e) => {
        console.warn(`lift models: not cached ${name} (${(file.size / 1e6).toFixed(0)} MB): ${e && e.name}: ${e && e.message}`);
        return false;
      });
    }
    let bytes;
    try {
      bytes = body
        ? await readAll(body, { total, onProgress, signal, name })
        : new Uint8Array(await r.arrayBuffer());
      await checkBytes(bytes, file, name);
    } catch (e) {
      if (putP && await putP) { await cache.delete(u); await cache.delete(sk); }
      throw e;
    }
    if (putP && await putP && verify) {
      try { await cache.put(sk, new Response(file.sha256)); } catch { /* next load re-verifies */ }
    }
    return { bytes, size: bytes.byteLength, sha256: file.sha256, source: 'network' };
  }

  function defaultFor(role, quality = 'medium') {
    const d = need().defaults[role];
    if (!d) return (need().models.find((m) => m.role === role) || {}).name;
    return typeof d === 'string' ? d : d[quality] || d.medium || Object.values(d)[0];
  }

  return {
    ready,
    get manifest() { return manifest; },
    has(name) {
      try { lookup(name); return true; } catch { return false; }
    },
    url,
    /** Manifest entry for a model (io descriptor, role, …). */
    entry(name) { return lookup(name).entry; },
    /** Default model name for a role/quality from the manifest's `defaults`. */
    defaultFor,
    /** Family descriptor ({ role, low, medium, high }) for a family alias like 'moge3', else null. */
    family(name) { return (name && need().families[name]) || null; },
    /**
     * Concrete manifest name for a model name, a family alias ('vda-small' | 'moge3' | 'da3' |
     * 'da2-small' | 'light-inpaint-v1') + quality, or — with no name — the role's default.
     */
    resolveName(name, role, quality = 'medium') {
      const m = need();
      if (name && m.byName.has(name)) return name;
      const f = name && m.families[name];
      if (f) return f[quality] || f.medium;
      if (name) throw new Error(`lift models: unknown model or family ${JSON.stringify(name)}`);
      return defaultFor(role, quality);
    },
    /** Contract: `{ stream, size, sha256 }` (plus `source`). */
    async get(name, opts) {
      const r = await getBytes(name, opts);
      return { stream: bytesStream(r.bytes), size: r.size, sha256: r.sha256, source: r.source };
    },
    getBytes,
    /** Remove every cached model (e.g. a "free disk space" button). */
    async clear() {
      if (!cachesImpl || cacheName === null) return false;
      try { return await cachesImpl.delete(cacheName); } catch { return false; }
    },
  };
}

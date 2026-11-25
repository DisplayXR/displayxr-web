// signaling/keys.mjs — publishable keys for the hosted `dxr-signal/1` service (RFC 0003 §5a).
//
// A key is PUBLIC: it sits in page source, so it is attribution + a quota bucket + an origin
// binding that browsers enforce, never a secret. The record lives server-side (a KV namespace on
// Cloudflare: `key:<id>` → JSON; a Map on the dev server), is issued by hand (tools/signal-keys.mjs),
// and is checked on every connect against the request's `Origin`. Every session carries its key
// id so usage is attributable per key from day one (billing identity; billing itself is OFF).

/** `pk_` + 20–40 base62 chars. The id IS the key (there is no secret half). */
export const KEY_RE = /^pk_[A-Za-z0-9]{20,40}$/;

/**
 * @typedef {object} KeyRecord
 * @property {string} id            the key itself (`pk_…`)
 * @property {string[]} origins     allowed page origins; `*` suffix wildcards one label level
 *                                  (`https://*.example.com`), `http://localhost` matches any port
 * @property {string} [note]        who / what it was issued for (never shown to clients)
 * @property {string} [createdAt]   ISO date
 * @property {boolean} [revoked]    a revoked key is refused like an unknown one
 * @property {Partial<import('./limits.mjs').TierLimits>} [limits]  per-key overrides
 */

/** Generate a new key id. `random` = bytes → used in Node and in the Worker alike. */
export function newKeyId(bytes = globalThis.crypto.getRandomValues(new Uint8Array(24))) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (const b of bytes) s += A[b % 62];
  return 'pk_' + s.slice(0, 24);
}

/** Parse + validate a stored record; null if it is not a usable key record. */
export function parseKeyRecord(id, raw) {
  if (!KEY_RE.test(id || '')) return null;
  let rec = raw;
  if (typeof raw === 'string') {
    try {
      rec = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!rec || typeof rec !== 'object') return null;
  const origins = Array.isArray(rec.origins) ? rec.origins.filter((o) => typeof o === 'string' && o).map(normalizeOrigin) : [];
  return {
    id,
    origins,
    note: typeof rec.note === 'string' ? rec.note : '',
    createdAt: typeof rec.createdAt === 'string' ? rec.createdAt : '',
    revoked: !!rec.revoked,
    limits: rec.limits && typeof rec.limits === 'object' ? { ...rec.limits } : undefined,
  };
}

/** Lowercase scheme+host, strip a trailing slash and a default port. */
export function normalizeOrigin(o) {
  let s = String(o || '')
    .trim()
    .toLowerCase()
    .replace(/\/+$/, '');
  s = s.replace(/^(https):\/\/([^/:]+):443$/, '$1://$2').replace(/^(http):\/\/([^/:]+):80$/, '$1://$2');
  return s;
}

/**
 * Does `origin` (the request header) match one allowed pattern?
 *  - exact: `https://app.example.com`
 *  - one-label wildcard: `https://*.example.com` (matches `a.example.com`, not `example.com`, not `a.b.example.com`)
 *  - `http://localhost` / `https://localhost` / `http://127.0.0.1`: any port (dev pages)
 *  - `*`: any origin (a key used purely for attribution / headroom)
 * An ABSENT Origin header (a non-browser client) never matches a key with an origin list.
 */
export function originAllowed(origin, patterns) {
  const o = normalizeOrigin(origin);
  if (!o || o === 'null') return patterns.includes('*');
  for (const raw of patterns) {
    const p = normalizeOrigin(raw);
    if (p === '*' || p === o) return true;
    if (/^https?:\/\/(localhost|127\.0\.0\.1)$/.test(p) && (o === p || o.startsWith(p + ':'))) return true;
    const m = /^(https?):\/\/\*\.(.+)$/.exec(p);
    if (m) {
      const n = new RegExp(`^${m[1]}:\\/\\/[a-z0-9-]+\\.${m[2].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(:\\d+)?$`);
      if (n.test(o)) return true;
    }
  }
  return false;
}

/**
 * Resolve the `key` query parameter against the key store for one connect.
 * @param {string|null} param  the raw `?key=` value ('' / null = anonymous)
 * @param {{ get(id: string): Promise<KeyRecord|null> }} store
 * @param {string} origin  the request's Origin header
 * @returns {Promise<{ ok: true, tier: 'anon' } | { ok: true, tier: 'key', key: KeyRecord } | { ok: false, code: 'bad-key'|'origin-not-allowed', message: string }>}
 */
export async function resolveKey(param, store, origin) {
  if (!param) return { ok: true, tier: 'anon' };
  if (!KEY_RE.test(param)) return { ok: false, code: 'bad-key', message: 'malformed key (pk_…)' };
  const rec = store ? await store.get(param) : null;
  if (!rec || rec.revoked) return { ok: false, code: 'bad-key', message: 'unknown or revoked key' };
  if (!originAllowed(origin, rec.origins)) return { ok: false, code: 'origin-not-allowed', message: `key is not allowed from origin "${origin || '(none)'}"` };
  return { ok: true, tier: 'key', key: rec };
}

/** A key store over a Cloudflare KV namespace (`key:<id>`), with the edge cache KV offers. */
export function kvKeyStore(kv, { cacheTtl = 60 } = {}) {
  if (!kv) return null;
  return {
    async get(id) {
      try {
        const raw = await kv.get(`key:${id}`, { cacheTtl });
        return raw ? parseKeyRecord(id, raw) : null;
      } catch {
        return null; // a KV hiccup refuses the key (fail closed) rather than crashing the connect
      }
    },
  };
}

/** A key store over a plain Map / object (dev server, tests). */
export function mapKeyStore(map) {
  const get = (id) => (map instanceof Map ? map.get(id) : map && map[id]);
  return { async get(id) { const r = get(id); return r ? parseKeyRecord(id, r) : null; } };
}

// signaling/limits.mjs — rate limits and caps for the hosted `dxr-signal/1` service (RFC 0003 §5b).
// Runtime-agnostic and pure: a `Meter` is the counters of ONE subject (a salted IP hash, or a key
// id) — fixed-window hit counters plus "leases" (the rooms that subject currently has open). The
// Cloudflare Worker keeps one Durable Object per subject around a Meter; the Node dev server keeps
// them in a Map. Both call exactly the same code, so a limit cannot drift between them.
//
// Every number here is a starting value from the RFC table and is overridable per deployment
// through environment variables (limitsFromEnv) and per key through the key record (`limits`).

/** @typedef {{ joinsPerMin: number, rooms: number, roomTtlS: number, mintsPerHour: number, turnTtl: number }} TierLimits */

/** RFC 0003 §5b starting values. `turnTtl` is §5a (anonymous 600 s, keyed 3600 s). */
export const DEFAULT_LIMITS = Object.freeze({
  anon: Object.freeze({ joinsPerMin: 20, rooms: 5, roomTtlS: 2 * 3600, mintsPerHour: 30, turnTtl: 600 }),
  key: Object.freeze({ joinsPerMin: 200, rooms: 50, roomTtlS: 8 * 3600, mintsPerHour: 300, turnTtl: 3600 }),
});

/** Env var names, per tier, in `DEFAULT_LIMITS` key order (documented in README.md). */
const ENV_NAMES = {
  anon: { joinsPerMin: 'ANON_JOINS_PER_MIN', rooms: 'ANON_ROOMS', roomTtlS: 'ANON_ROOM_TTL', mintsPerHour: 'ANON_MINTS_PER_HOUR', turnTtl: 'ANON_TURN_TTL' },
  key: { joinsPerMin: 'KEY_JOINS_PER_MIN', rooms: 'KEY_ROOMS', roomTtlS: 'KEY_ROOM_TTL', mintsPerHour: 'KEY_MINTS_PER_HOUR', turnTtl: 'TURN_TTL' },
};

const posInt = (v, dflt) => {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
};

/** Read both tiers' limits from an env object (unset vars keep the RFC defaults). */
export function limitsFromEnv(env = {}) {
  const out = {};
  for (const tier of ['anon', 'key']) {
    const t = {};
    for (const [k, name] of Object.entries(ENV_NAMES[tier])) t[k] = posInt(env[name], DEFAULT_LIMITS[tier][k]);
    t.turnTtl = Math.max(60, Math.min(86400, t.turnTtl || DEFAULT_LIMITS[tier].turnTtl));
    out[tier] = t;
  }
  return out;
}

/**
 * The effective limits for one session: the tier's base, then the key record's `limits`
 * overrides (a keyed customer can be given more — or less — headroom by hand).
 * @param {'anon'|'key'} tier
 * @param {{limits?: Partial<TierLimits>}|null} keyRecord
 * @param {{anon: TierLimits, key: TierLimits}} [base]
 * @returns {TierLimits}
 */
export function limitsFor(tier, keyRecord, base = DEFAULT_LIMITS) {
  const t = { ...(base[tier] || DEFAULT_LIMITS[tier]) };
  const o = tier === 'key' && keyRecord && keyRecord.limits && typeof keyRecord.limits === 'object' ? keyRecord.limits : null;
  if (o) for (const k of Object.keys(t)) if (Number.isFinite(+o[k]) && +o[k] >= 0) t[k] = Math.floor(+o[k]);
  t.turnTtl = Math.max(60, Math.min(86400, t.turnTtl || DEFAULT_LIMITS[tier].turnTtl));
  return t;
}

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;

/**
 * The counters of one subject. Serialisable (`toJSON` / `Meter.from`) so a Durable Object can
 * persist it between requests and across hibernation.
 */
export class Meter {
  /** @param {{ now?: () => number, state?: any }} [o] */
  constructor({ now = () => Date.now(), state = null } = {}) {
    this.now = now;
    /** fixed windows: name -> { at: windowStartMs, count } */
    this.windows = new Map();
    /** leases: roomKey -> { count, expiresAt } — the rooms this subject currently has open */
    this.leases = new Map();
    if (state) this._load(state);
  }

  _load(s) {
    if (s && s.windows && typeof s.windows === 'object') for (const [k, v] of Object.entries(s.windows)) if (v && Number.isFinite(v.at)) this.windows.set(k, { at: v.at, count: v.count | 0 });
    if (s && s.leases && typeof s.leases === 'object') for (const [k, v] of Object.entries(s.leases)) if (v && Number.isFinite(v.expiresAt)) this.leases.set(k, { count: v.count | 0, expiresAt: v.expiresAt });
  }

  toJSON() {
    const t = this.now();
    const windows = {};
    for (const [k, v] of this.windows) if (t - v.at < HOUR_MS * 2) windows[k] = v; // nothing lives longer than an hour window
    const leases = {};
    for (const [k, v] of this.leases) if (v.expiresAt > t && v.count > 0) leases[k] = v;
    return { windows, leases };
  }

  static from(json, now) {
    return new Meter({ now, state: json });
  }

  /**
   * Count one event in a fixed window. `ok` is false once the window's count exceeds `limit`
   * (the event is still counted: a flood keeps its own window hot).
   * @returns {{ ok: boolean, count: number, limit: number, retryMs: number }}
   */
  hit(name, windowMs, limit) {
    const t = this.now();
    let w = this.windows.get(name);
    if (!w || t - w.at >= windowMs) {
      w = { at: t, count: 0 };
      this.windows.set(name, w);
    }
    w.count++;
    const ok = w.count <= limit;
    return { ok, count: w.count, limit, retryMs: ok ? 0 : Math.max(1, windowMs - (t - w.at)) };
  }

  /** Current count in a window without counting (for diagnostics). */
  peek(name, windowMs) {
    const w = this.windows.get(name);
    return w && this.now() - w.at < windowMs ? w.count : 0;
  }

  _prune() {
    const t = this.now();
    for (const [k, v] of this.leases) if (v.expiresAt <= t || v.count <= 0) this.leases.delete(k);
  }

  /** Distinct rooms this subject holds open (expired leases pruned). */
  rooms() {
    this._prune();
    return this.leases.size;
  }

  /**
   * Take a lease on `roomKey` (a connection into that room). Opening a NEW room is refused once
   * the subject already holds `limit` distinct rooms; a second connection into a room it already
   * holds is always allowed (that is the same room, not a new one). Leases expire by themselves
   * after `ttlMs`, so a lost `release` (an evicted object, a crashed server) cannot wedge a
   * subject for ever.
   * @returns {{ ok: boolean, rooms: number, limit: number }}
   */
  acquire(roomKey, limit, ttlMs) {
    this._prune();
    const have = this.leases.get(roomKey);
    if (!have && this.leases.size >= limit) return { ok: false, rooms: this.leases.size, limit };
    const expiresAt = this.now() + Math.max(1000, ttlMs | 0 || HOUR_MS);
    if (have) {
      have.count++;
      have.expiresAt = Math.max(have.expiresAt, expiresAt);
    } else this.leases.set(roomKey, { count: 1, expiresAt });
    return { ok: true, rooms: this.leases.size, limit };
  }

  /** Give a lease back. Idempotent for a room that is not held. */
  release(roomKey) {
    const have = this.leases.get(roomKey);
    if (!have) return;
    if (--have.count <= 0) this.leases.delete(roomKey);
  }

  /**
   * One round trip for a join: the join-rate window, then the room lease — in that order, so a
   * flood is answered `rate-limited` before it can even ask about rooms, and a refused join never
   * takes a lease.
   * @param {{ roomKey: string, tierName: string, joinsPerMin: number, rooms?: number, leaseTtlMs?: number }} o
   *        `rooms` absent = do not lease here (the caller leases on another subject)
   * @returns {{ ok: true } | { ok: false, code: 'rate-limited'|'quota', retryMs: number, message: string }}
   */
  admit({ roomKey, tierName, joinsPerMin, rooms, leaseTtlMs }) {
    const r = this.hit(`joins.${tierName}`, MINUTE_MS, joinsPerMin);
    if (!r.ok) return { ok: false, code: 'rate-limited', retryMs: r.retryMs, message: `too many joins (${r.limit}/min); retry in ${Math.ceil(r.retryMs / 1000)} s` };
    if (rooms !== undefined) {
      const l = this.acquire(roomKey, rooms, leaseTtlMs);
      if (!l.ok) return { ok: false, code: 'quota', retryMs: 0, message: `too many open rooms (${l.limit}); leave one first` };
    }
    return { ok: true };
  }

  /**
   * Run a serialised command (the Durable Object and the dev server speak this one vocabulary).
   * @param {{op: string} & Record<string, any>} cmd
   */
  exec(cmd) {
    switch (cmd && cmd.op) {
      case 'admit':
        return this.admit(cmd);
      case 'hit':
        return this.hit(cmd.name, cmd.windowMs, cmd.limit);
      case 'acquire':
        return this.acquire(cmd.roomKey, cmd.limit, cmd.ttlMs);
      case 'release':
        this.release(cmd.roomKey);
        return { ok: true, rooms: this.rooms() };
      case 'peek':
        return { rooms: this.rooms(), windows: Object.fromEntries([...this.windows].map(([k, v]) => [k, v.count])) };
      default:
        return { ok: false, code: 'bad-op' };
    }
  }
}

/**
 * The subject id for an IP: a salted SHA-256 prefix, so rate-limit state never holds a raw
 * address (RFC 0003 §5e). The salt is a deployment var (`RATE_SALT`); rotating it forgets every
 * counter, which is harmless.
 */
export async function subjectForIp(ip, salt = '') {
  const bytes = new TextEncoder().encode(`${salt}|${ip || ''}`);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return 'ip:' + [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Close codes the server uses for refusals (documented in README.md). */
export const CLOSE_CODES = Object.freeze({
  'bad-message': 4000,
  'bad-version': 4000,
  'bad-room': 4000,
  'bad-id': 4000,
  'id-taken': 4000,
  'too-big': 4000,
  'bad-key': 4001,
  'origin-not-allowed': 4001,
  full: 4003,
  expired: 4004,
  'rate-limited': 4029,
  quota: 4030,
  blocked: 4040,
});

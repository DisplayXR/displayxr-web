// signaling/gate.mjs — admission for one `dxr-signal/1` connect: key + origin (keys.mjs), the
// blocklist, join rate + room leases (limits.mjs), and the TURN decision (turn-budget.mjs).
// Shared verbatim by the Cloudflare Worker (worker.mjs) and the Node dev server (dev-server.mjs);
// the two only differ in where the counters live (Durable Objects vs a Map), which they inject
// as `meters` / `budget`.
//
// Order of checks, and why: key/origin first (a wrong key is a configuration error, answered
// before any counter moves) → blocklist → join rate on the IP (a flood is refused before it can
// ask about rooms) → room lease on the IP (anonymous) or the key (keyed) → TURN policy from the
// budget, then the per-IP mint rate. Every refusal is a `{code, message, closeCode}` the caller
// turns into one `error` message + a close, so a client always learns WHY (never a silent hang).

import { limitsFor, CLOSE_CODES, HOUR_MS, subjectForIp } from './limits.mjs';
import { resolveKey } from './keys.mjs';
import { turnPolicy } from './turn-budget.mjs';

/**
 * @typedef {object} Session  what a connect is admitted AS (carried on the socket, never to the client verbatim)
 * @property {'anon'|'key'} tier
 * @property {string|null} key           the key id (billing identity), null for anonymous
 * @property {string} ipSubject          salted IP hash subject (`ip:…`)
 * @property {{ mint: boolean, ttl: number, status: string, reason?: string }} turn
 * @property {number} roomTtlS           room lifetime for a room this session opens
 * @property {{ subject: string, roomKey: string }[]} leases  what to release on close
 */

/**
 * @param {object} o
 * @param {{anon: object, key: object}} o.limits         from limitsFromEnv()
 * @param {{get(id: string): Promise<object|null>}|null} o.keys   key store (null = keys unsupported → every key is 'bad-key')
 * @param {{ snapshot(): Promise<{fraction: number, status: string}>|{fraction: number, status: string}, cfg: object }} o.budget
 * @param {{ exec(subject: string, cmd: object): Promise<any>|any }} o.meters
 * @param {{ has(ip: string): Promise<boolean>|boolean }|null} [o.blocklist]
 * @param {string} [o.salt]
 */
export function createGate({ limits, keys, budget, meters, blocklist = null, salt = '' }) {
  const refuse = (code, message, retryMs = 0) => ({ ok: false, code, message, closeCode: CLOSE_CODES[code] || 4000, retryMs });

  return {
    /**
     * @param {{ ip: string, origin: string, key: string|null, roomKey: string, wantTurn?: boolean }} req
     *        `wantTurn` false = the server has no TURN configured at all (skip the budget entirely)
     * @returns {Promise<{ ok: true, session: Session } | { ok: false, code: string, message: string, closeCode: number, retryMs: number }>}
     */
    async admit({ ip, origin, key: keyParam, roomKey, wantTurn = true }) {
      const k = await resolveKey(keyParam || null, keys, origin || '');
      if (!k.ok) return refuse(k.code, k.message);
      if (blocklist && (await blocklist.has(ip || ''))) return refuse('blocked', 'this address is blocked (abuse@displayxr.org)');
      const tier = k.tier;
      const rec = tier === 'key' ? k.key : null;
      const lim = limitsFor(tier, rec, limits);
      const ipSubject = await subjectForIp(ip || '', salt);
      const leaseTtlMs = lim.roomTtlS * 1000 + HOUR_MS; // a lease outlives the room it is for
      /** @type {Session} */
      const session = { tier, key: rec ? rec.id : null, ipSubject, turn: { mint: false, ttl: 0, status: 'off', reason: 'unconfigured' }, roomTtlS: lim.roomTtlS, leases: [] };

      // Join rate is always per IP (the tier only picks the number); the room lease is per key
      // for keyed sessions (a customer's quota is theirs, not their users' IPs') and per IP otherwise.
      const anonRooms = tier === 'anon' ? lim.rooms : undefined;
      const a = await meters.exec(ipSubject, { op: 'admit', roomKey, tierName: tier, joinsPerMin: lim.joinsPerMin, rooms: anonRooms, leaseTtlMs });
      if (!a.ok) return refuse(a.code, a.message, a.retryMs);
      if (anonRooms !== undefined) session.leases.push({ subject: ipSubject, roomKey });
      if (tier === 'key') {
        const keySubject = `key:${rec.id}`;
        const l = await meters.exec(keySubject, { op: 'acquire', roomKey, limit: lim.rooms, ttlMs: leaseTtlMs });
        if (!l.ok) return refuse('quota', `this key has too many open rooms (${l.limit})`);
        session.leases.push({ subject: keySubject, roomKey });
      }

      if (wantTurn) {
        const snap = await budget.snapshot();
        const pol = turnPolicy(snap, tier, lim, budget.cfg);
        session.turn = { mint: pol.mint, ttl: pol.ttl, status: pol.status };
        if (pol.reason) session.turn.reason = pol.reason;
        if (pol.mint) {
          // Mint rate per IP per hour (RFC §5b): over it, the session still joins — STUN-only.
          const m = await meters.exec(ipSubject, { op: 'hit', name: `mints.${tier}`, windowMs: HOUR_MS, limit: pol.mintsPerHour });
          if (!m.ok) session.turn = { mint: false, ttl: 0, status: pol.status, reason: 'rate' };
        }
      }
      return { ok: true, session };
    },

    /** Give every lease of a session back (socket closed). Safe to call twice. */
    async release(session) {
      if (!session || !Array.isArray(session.leases)) return;
      const leases = session.leases;
      session.leases = [];
      for (const { subject, roomKey } of leases) {
        try {
          await meters.exec(subject, { op: 'release', roomKey });
        } catch {
          /* the lease expires on its own */
        }
      }
    },
  };
}

/** A blocklist over a KV namespace (`block:<ip>` present = blocked) — or null. */
export function kvBlocklist(kv) {
  if (!kv) return null;
  return {
    async has(ip) {
      try {
        return !!(ip && (await kv.get(`block:${ip}`, { cacheTtl: 60 })));
      } catch {
        return false;
      }
    },
  };
}

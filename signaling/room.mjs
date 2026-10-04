// signaling/room.mjs — the `dxr-signal/1` room logic, shared VERBATIM by the Cloudflare Worker's
// Durable Object (worker.mjs) and the Node dev server (dev-server.mjs). Runtime-agnostic: no
// sockets here, just "a connection said this; tell these connections that". The protocol is
// documented in ./README.md.
//
// What this server knows: a room id, random per-join peer ids, and the SDP/ICE blobs it relays.
// It never sees media (DTLS-SRTP is peer-to-peer) and holds nothing after the last peer leaves.

import { CLOSE_CODES } from './limits.mjs';

export const PROTOCOL = 'dxr-signal/1';
export const ROOM_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
export const PEER_ID_RE = /^[A-Za-z0-9_-]{8,32}$/;
/** Default room size, and the largest a server will allow (full mesh stops scaling at 4). */
export const DEFAULT_ROOM_CAP = 4;
export const MAX_ROOM_CAP = 8;
/** A single signalling message is a JSON SDP or candidate — 64 KiB is generous. */
export const MAX_MESSAGE_BYTES = 64 * 1024;
/** Per-connection flood guard: at most this many messages per window. */
export const RATE_LIMIT = { messages: 300, windowMs: 10_000 };

/** SHA-256 of the room id, hex — the only room-derived value that appears in a URL. */
export async function roomKey(room) {
  const bytes = new TextEncoder().encode(String(room));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * One room. `conn` is anything with `send(obj)` and `close(code, reason)`; the host runtime owns
 * the socket and calls `onMessage(conn, text)` / `onClose(conn)`.
 *
 * @param {object} opts
 * @param {string} opts.key  the roomKey this room was addressed by (join must match it)
 * @param {number} [opts.cap]  server-side participant cap (clamped to MAX_ROOM_CAP)
 * @param {(info: object|null) => Promise<object[]|null>} [opts.iceServers]  mints short-lived
 *        TURN credentials per join (given the connection's admission session, see gate.mjs, whose
 *        `turn.ttl` is the TTL to mint); null/absent = the client uses its own defaults (public STUN)
 * @param {{ onFirst?: (info: object|null) => void, onEmpty?: () => void }} [opts.hooks]  the room
 *        went 0→1 peers (start its lifetime clock) / 1→0 (stop it)
 * @param {() => number} [opts.now]
 */
export class Room {
  constructor({ key, cap = DEFAULT_ROOM_CAP, iceServers = null, hooks = {}, now = () => Date.now() } = {}) {
    this.key = key || null;
    this.cap = Math.max(2, Math.min(MAX_ROOM_CAP, cap | 0 || DEFAULT_ROOM_CAP));
    this.max = null; // set by the first joiner (<= cap)
    this.peers = new Map(); // id -> conn
    this.meta = new WeakMap(); // conn -> { id, count, windowAt, session }
    this.iceServers = iceServers;
    this.hooks = hooks || {};
    this.now = now;
  }

  get size() {
    return this.peers.size;
  }

  _meta(conn) {
    let m = this.meta.get(conn);
    if (!m) {
      m = { id: null, count: 0, windowAt: this.now(), session: null };
      this.meta.set(conn, m);
    }
    return m;
  }

  /**
   * Record what a connection was admitted as (gate.mjs `Session`: tier, key id, TURN decision,
   * room lifetime). Call before its first message; absent = anonymous, TURN per server config.
   */
  attach(conn, session) {
    this._meta(conn).session = session || null;
  }

  /** Re-attach a connection that already joined (Durable Object wake from hibernation). */
  restore(conn, id, session = null) {
    if (!PEER_ID_RE.test(id)) return;
    this.peers.set(id, conn);
    this.meta.set(conn, { id, count: 0, windowAt: this.now(), session: session || null });
  }

  async onMessage(conn, text) {
    if (typeof text !== 'string') text = String(text);
    if (text.length > MAX_MESSAGE_BYTES) return this._fail(conn, 'too-big', 'message exceeds 64 KiB');
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return this._fail(conn, 'bad-message', 'not JSON');
    }
    if (!msg || typeof msg !== 'object') return this._fail(conn, 'bad-message', 'not an object');
    const m = this._meta(conn);
    const t = this.now();
    if (t - m.windowAt > RATE_LIMIT.windowMs) {
      m.windowAt = t;
      m.count = 0;
    }
    if (++m.count > RATE_LIMIT.messages) return this._fail(conn, 'rate-limited', 'slow down', true);

    switch (msg.t) {
      case 'ping':
        return safeSend(conn, { t: 'pong' });
      case 'join':
        return this._join(conn, m, msg);
      case 'signal':
        if (!m.id) return this._fail(conn, 'not-joined', 'join first');
        if (typeof msg.to !== 'string' || !this.peers.has(msg.to) || msg.to === m.id) {
          return safeSend(conn, { t: 'error', code: 'no-such-peer', to: msg.to ?? null });
        }
        return safeSend(this.peers.get(msg.to), { t: 'signal', from: m.id, data: msg.data ?? null });
      case 'leave':
        this.onClose(conn);
        try {
          conn.close(1000, 'left');
        } catch {
          /* already closed */
        }
        return;
      default:
        return this._fail(conn, 'bad-message', `unknown type "${msg.t}"`);
    }
  }

  async _join(conn, m, msg) {
    if (m.id) return this._fail(conn, 'already-joined', 'one join per connection');
    if (msg.v !== undefined && msg.v !== 1) return this._fail(conn, 'bad-version', `server speaks ${PROTOCOL}`, true);
    if (!ROOM_ID_RE.test(msg.room || '')) return this._fail(conn, 'bad-room', 'room id must be 16-64 base64url chars', true);
    if (this.key && (await roomKey(msg.room)) !== this.key) return this._fail(conn, 'bad-room', 'room does not match its key', true);
    if (!PEER_ID_RE.test(msg.id || '')) return this._fail(conn, 'bad-id', 'peer id must be 8-32 base64url chars', true);
    if (this.peers.has(msg.id)) return this._fail(conn, 'id-taken', 'that peer id is in the room', true);
    if (this.max === null || this.peers.size === 0) {
      const want = Number.isInteger(msg.max) ? msg.max : DEFAULT_ROOM_CAP;
      this.max = Math.max(2, Math.min(this.cap, want));
    }
    if (this.peers.size >= this.max) {
      safeSend(conn, { t: 'full', max: this.max });
      try {
        conn.close(4003, 'room full');
      } catch {
        /* ignore */
      }
      return;
    }
    const others = [...this.peers.keys()];
    m.id = msg.id;
    this.peers.set(msg.id, conn);
    const first = others.length === 0;
    const s = m.session;
    // TURN: the admission decision (budget / tier / mint rate) says whether to mint at all and
    // for how long; a server without TURN configured has no minter. The welcome always says
    // which, so the SDK can tell "no relay this month" (`turn-cap`) from "self-hosted, no TURN".
    let ice = null;
    /** @type {{status: string, reason?: string, ttl?: number}} */
    let turn = { status: 'off', reason: 'unconfigured' };
    if (this.iceServers) {
      const want = s && s.turn ? s.turn : { mint: true, ttl: 0, status: 'ok' };
      if (!want.mint) turn = { status: want.status || 'off', reason: want.reason || 'budget' };
      else {
        try {
          ice = await this.iceServers(s);
          turn = ice ? { status: want.status || 'ok', ttl: want.ttl || undefined } : { status: 'off', reason: 'unconfigured' };
        } catch {
          ice = null; // TURN minting failed: the client falls back to STUN, the call may still work
          turn = { status: want.status || 'ok', reason: 'mint-failed' };
        }
      }
    }
    const welcome = { t: 'welcome', v: 1, id: msg.id, peers: others, max: this.max, tier: s ? s.tier : 'anon', turn };
    if (s && s.key) welcome.key = s.key;
    if (ice) welcome.iceServers = ice;
    safeSend(conn, welcome);
    for (const id of others) safeSend(this.peers.get(id), { t: 'peer-joined', id: msg.id });
    if (first) this.hooks.onFirst?.(s);
  }

  /** The socket closed (or the peer left): tell the others. Idempotent. */
  onClose(conn) {
    const m = this.meta.get(conn);
    if (!m || !m.id) return;
    const id = m.id;
    m.id = null;
    if (this.peers.get(id) !== conn) return;
    this.peers.delete(id);
    for (const other of this.peers.values()) safeSend(other, { t: 'peer-left', id });
    if (this.peers.size === 0) {
      this.max = null;
      this.hooks.onEmpty?.();
    }
  }

  /**
   * The room's lifetime is up (RFC §5b: 2 h anonymous, 8 h keyed): every peer gets `expired`
   * and is closed (4004). Media already flowing peer-to-peer is not touched by this; the peers
   * simply have no signalling for that room any more.
   */
  expire() {
    const conns = [...this.peers.values()];
    this.peers.clear();
    this.max = null;
    for (const conn of conns) {
      const m = this.meta.get(conn);
      if (m) m.id = null;
      safeSend(conn, { t: 'expired' });
      try {
        conn.close(CLOSE_CODES.expired, 'expired');
      } catch {
        /* ignore */
      }
    }
    if (conns.length) this.hooks.onEmpty?.();
  }

  _fail(conn, code, message, close = false) {
    safeSend(conn, { t: 'error', code, message });
    if (close) {
      this.onClose(conn);
      try {
        conn.close(CLOSE_CODES[code] || 4000, code);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Refuse a connection before it ever reaches a room (an admission failure, gate.mjs): one
 * `error` message, then the close code for that error. The client learns why; nothing hangs.
 */
export function refuseConn(conn, { code, message, retryMs = 0, closeCode }) {
  const err = { t: 'error', code, message };
  if (retryMs > 0) err.retryMs = retryMs;
  safeSend(conn, err);
  try {
    conn.close(closeCode || CLOSE_CODES[code] || 4000, code);
  } catch {
    /* ignore */
  }
}

function safeSend(conn, obj) {
  try {
    conn.send(obj);
  } catch {
    /* the socket is going away; its close handler cleans up */
  }
}

/**
 * Mint short-lived TURN credentials with Cloudflare Realtime TURN. Returns the `iceServers` array
 * or null when not configured. The key id and API token live in the Worker's env (a secret), and
 * ONLY there — clients receive credentials that expire after `ttl` seconds.
 *
 * `customIdentifier` tags the credential with the session's key id ('anon' otherwise), which is
 * how Cloudflare's TURN analytics attribute relay bytes per key (turn-budget.mjs readTurnUsage).
 * If the API ever rejects that field, the mint is retried once without it.
 *
 * @param {{TURN_KEY_ID?: string, TURN_KEY_API_TOKEN?: string, TURN_TTL?: string}} env
 * @param {typeof fetch} [fetchImpl]
 * @param {{ ttl?: number, customIdentifier?: string }} [o]  `ttl` overrides env.TURN_TTL
 */
export async function mintTurnCredentials(env, fetchImpl = globalThis.fetch, o = {}) {
  if (!env || !env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return null;
  const ttl = Math.max(60, Math.min(86400, (o.ttl > 0 ? o.ttl | 0 : 0) || parseInt(env.TURN_TTL || '3600', 10) || 3600));
  const url = `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.TURN_KEY_ID)}/credentials/generate-ice-servers`;
  const post = (body) =>
    fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const tag = typeof o.customIdentifier === 'string' && o.customIdentifier ? o.customIdentifier.slice(0, 64) : '';
  let res = await post(tag ? { ttl, customIdentifier: tag } : { ttl });
  if (!res.ok && tag && res.status === 400) res = await post({ ttl });
  if (!res.ok) throw new Error(`TURN credential mint failed: HTTP ${res.status}`);
  const body = await res.json();
  // Current API: { iceServers: [ {urls}, {urls, username, credential} ] }. The older
  // `/credentials/generate` answered { iceServers: { urls, username, credential } } — accept both.
  const s = body && body.iceServers;
  if (Array.isArray(s)) return s;
  if (s && s.urls) return [s];
  return null;
}

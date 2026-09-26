// signaling/room.mjs — the `dxr-signal/1` room logic, shared VERBATIM by the Cloudflare Worker's
// Durable Object (worker.mjs) and the Node dev server (dev-server.mjs). Runtime-agnostic: no
// sockets here, just "a connection said this; tell these connections that". The protocol is
// documented in ./README.md.
//
// What this server knows: a room id, random per-join peer ids, and the SDP/ICE blobs it relays.
// It never sees media (DTLS-SRTP is peer-to-peer) and holds nothing after the last peer leaves.

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
 * @param {() => Promise<object[]|null>} [opts.iceServers]  mints short-lived TURN credentials
 *        per join; null/absent = the client uses its own defaults (public STUN)
 * @param {() => number} [opts.now]
 */
export class Room {
  constructor({ key, cap = DEFAULT_ROOM_CAP, iceServers = null, now = () => Date.now() } = {}) {
    this.key = key || null;
    this.cap = Math.max(2, Math.min(MAX_ROOM_CAP, cap | 0 || DEFAULT_ROOM_CAP));
    this.max = null; // set by the first joiner (<= cap)
    this.peers = new Map(); // id -> conn
    this.meta = new WeakMap(); // conn -> { id, count, windowAt }
    this.iceServers = iceServers;
    this.now = now;
  }

  get size() {
    return this.peers.size;
  }

  /** Re-attach a connection that already joined (Durable Object wake from hibernation). */
  restore(conn, id) {
    if (!PEER_ID_RE.test(id)) return;
    this.peers.set(id, conn);
    this.meta.set(conn, { id, count: 0, windowAt: this.now() });
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
    const m = this.meta.get(conn) || { id: null, count: 0, windowAt: this.now() };
    this.meta.set(conn, m);
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
    let ice = null;
    if (this.iceServers) {
      try {
        ice = await this.iceServers();
      } catch {
        ice = null; // TURN minting failed: the client falls back to STUN, the call may still work
      }
    }
    const welcome = { t: 'welcome', v: 1, id: msg.id, peers: others, max: this.max };
    if (ice) welcome.iceServers = ice;
    safeSend(conn, welcome);
    for (const id of others) safeSend(this.peers.get(id), { t: 'peer-joined', id: msg.id });
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
    if (this.peers.size === 0) this.max = null;
  }

  _fail(conn, code, message, close = false) {
    safeSend(conn, { t: 'error', code, message });
    if (close) {
      this.onClose(conn);
      try {
        conn.close(4000, code);
      } catch {
        /* ignore */
      }
    }
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
 * @param {{TURN_KEY_ID?: string, TURN_KEY_API_TOKEN?: string, TURN_TTL?: string}} env
 * @param {typeof fetch} [fetchImpl]
 */
export async function mintTurnCredentials(env, fetchImpl = globalThis.fetch) {
  if (!env || !env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return null;
  const ttl = Math.max(60, Math.min(86400, parseInt(env.TURN_TTL || '3600', 10) || 3600));
  const res = await fetchImpl(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.TURN_KEY_ID)}/credentials/generate-ice-servers`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl }),
    }
  );
  if (!res.ok) throw new Error(`TURN credential mint failed: HTTP ${res.status}`);
  const body = await res.json();
  // Current API: { iceServers: [ {urls}, {urls, username, credential} ] }. The older
  // `/credentials/generate` answered { iceServers: { urls, username, credential } } — accept both.
  const s = body && body.iceServers;
  if (Array.isArray(s)) return s;
  if (s && s.urls) return [s];
  return null;
}

// signaling/worker.mjs — the `dxr-signal/1` reference server on Cloudflare: a Worker that routes
// each WebSocket to one Durable Object per room. Template only — NOT deployed by this repo. See
// ./README.md for the protocol, deployment, and the TURN variables.
//
// Routing key: the client connects to `/v1/connect?k=<sha256(room) hex>`, so a URL (and any log
// line that records one) carries a hash, never the room itself. The join message carries the
// room, and the room checks it against the key.
//
// The DO uses the WebSocket HIBERNATION API (state.acceptWebSocket): an idle room costs nothing
// while its sockets stay open, and a woken object rebuilds its peer table from each socket's
// serialized attachment.

import { Room, DEFAULT_ROOM_CAP, mintTurnCredentials } from './room.mjs';

const KEY_RE = /^[0-9a-f]{64}$/;

export default {
  /** @param {Request} request @param {any} env */
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/health') {
      return json({ ok: true, protocol: 'dxr-signal/1', turn: !!(env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN) });
    }
    if (url.pathname !== '/v1/connect') return new Response('not found', { status: 404 });
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected a WebSocket upgrade', { status: 426 });
    const key = url.searchParams.get('k') || '';
    if (!KEY_RE.test(key)) return new Response('bad room key', { status: 400 });
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const origin = request.headers.get('Origin') || '';
    if (allowed.length && !allowed.includes(origin)) return new Response('origin not allowed', { status: 403 });
    const stub = env.ROOMS.get(env.ROOMS.idFromName(key));
    return stub.fetch(request);
  },
};

export class CallRoom {
  /** @param {DurableObjectState} state @param {any} env */
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.room = null;
  }

  async _ensureRoom(key) {
    if (this.room) return this.room;
    // The key this object was addressed by, persisted so a hibernation wake can still check joins.
    if (key) await this.state.storage.put('key', key);
    else key = (await this.state.storage.get('key')) || null;
    if (this.room) return this.room; // another event won the race while we awaited storage
    const cap = parseInt(this.env.MAX_PEERS || String(DEFAULT_ROOM_CAP), 10) || DEFAULT_ROOM_CAP;
    const turn = this.env.TURN_KEY_ID && this.env.TURN_KEY_API_TOKEN ? () => mintTurnCredentials(this.env) : null;
    this.room = new Room({ key, cap, iceServers: turn });
    // Woken from hibernation: re-attach every socket that had already joined.
    for (const ws of this.state.getWebSockets()) {
      const a = ws.deserializeAttachment() || {};
      if (a.id) this.room.restore(this._conn(ws), a.id);
      if (a.max && this.room.max === null) this.room.max = a.max;
    }
    return this.room;
  }

  /** One `{send, close}` wrapper per WebSocket, cached so the Room's maps key on it stably. */
  _conn(ws) {
    this._conns ??= new WeakMap();
    let c = this._conns.get(ws);
    if (!c) {
      c = {
        send: (obj) => {
          ws.send(JSON.stringify(obj));
          // Persist what a wake needs: the peer id this socket joined as, and the room size.
          if (obj && obj.t === 'welcome') ws.serializeAttachment({ id: obj.id, max: obj.max });
        },
        close: (code, reason) => ws.close(code, reason),
      };
      this._conns.set(ws, c);
    }
    return c;
  }

  /** @param {Request} request */
  async fetch(request) {
    const key = new URL(request.url).searchParams.get('k');
    await this._ensureRoom(key);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const room = await this._ensureRoom(null);
    await room.onMessage(this._conn(ws), typeof message === 'string' ? message : new TextDecoder().decode(message));
  }

  async webSocketClose(ws) {
    (await this._ensureRoom(null)).onClose(this._conn(ws));
  }

  async webSocketError(ws) {
    (await this._ensureRoom(null)).onClose(this._conn(ws));
  }
}

function json(obj) {
  return new Response(JSON.stringify(obj), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
}

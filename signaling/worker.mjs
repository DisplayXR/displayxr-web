// signaling/worker.mjs — the `dxr-signal/1` reference server on Cloudflare: a Worker that admits
// each connect (gate.mjs: key + origin, blocklist, rate limits, room leases, the TURN budget) and
// routes the WebSocket to one Durable Object per room. See ./README.md for the protocol, the
// deployment, the variables and the admin recipe.
//
// Routing key: the client connects to `/v1/connect?k=<sha256(room) hex>[&key=pk_…]`, so a URL
// (and any log line that records one) carries a hash, never the room itself. The join message
// carries the room, and the room checks it against the key.
//
// Durable Objects:
//   CallRoom  one per room (hibernating WebSockets: an idle room costs nothing while its sockets
//             stay open; a woken object rebuilds its peer table from each socket's attachment),
//             with an alarm for the room's lifetime.
//   Meter     one per rate-limit subject (a salted IP hash, or a key id): join windows, room
//             leases, mint windows (limits.mjs).
//   Budget    one per deployment: month-to-date TURN usage per key, the estimate, the analytics
//             figure and the operator override (turn-budget.mjs).
// KV `KEYS`: publishable keys (`key:<id>`) and the IP blocklist (`block:<ip>`) — issued by hand
// with tools/signal-keys.mjs (RFC 0003 Decision 4).

import { Room, DEFAULT_ROOM_CAP, mintTurnCredentials, refuseConn } from './room.mjs';
import { Meter, limitsFromEnv } from './limits.mjs';
import { TurnBudget, budgetFromEnv, readTurnUsage } from './turn-budget.mjs';
import { kvKeyStore, parseKeyRecord, KEY_RE } from './keys.mjs';
import { createGate, kvBlocklist } from './gate.mjs';

const KEY_RE_ROOM = /^[0-9a-f]{64}$/;
/** The Worker caches the budget snapshot per isolate for this long: joins never wait on the Budget object twice in a row. */
const BUDGET_CACHE_MS = 15_000;
let budgetCache = { at: 0, snap: null };

/** TURN_FAKE = "1" (staging / tests): dummy credentials with no token, so the budget path runs end to end. */
const turnConfigured = (env) => !!(env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN) || env.TURN_FAKE === '1';
const fakeIce = (ttl) => [
  { urls: ['stun:stun.cloudflare.com:3478'] },
  { urls: ['turn:turn.invalid:3478?transport=udp', 'turns:turn.invalid:443?transport=tcp'], username: `fake-${ttl}`, credential: 'fake' },
];

async function doCall(stub, cmd) {
  const res = await stub.fetch('https://do/', { method: 'POST', body: JSON.stringify(cmd) });
  return res.json();
}

const meters = (env) => ({ exec: (subject, cmd) => doCall(env.METERS.get(env.METERS.idFromName(subject)), cmd) });
const budgetStub = (env) => env.BUDGET.get(env.BUDGET.idFromName('budget'));

async function budgetSnapshot(env, fresh = false) {
  const now = Date.now();
  if (!fresh && budgetCache.snap && now - budgetCache.at < BUDGET_CACHE_MS) return budgetCache.snap;
  const snap = await doCall(budgetStub(env), { op: 'snapshot' });
  budgetCache = { at: now, snap };
  return snap;
}

function gateFor(env) {
  return createGate({
    limits: limitsFromEnv(env),
    keys: kvKeyStore(env.KEYS),
    budget: { snapshot: () => budgetSnapshot(env), cfg: budgetFromEnv(env) },
    meters: meters(env),
    blocklist: kvBlocklist(env.KEYS),
    salt: env.RATE_SALT || '',
  });
}

/** Refuse a connect at the Worker: accept the socket just long enough to say why, then close. */
function refuseUpgrade(result) {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();
  refuseConn({ send: (o) => server.send(JSON.stringify(o)), close: (c, r) => server.close(c, r) }, result);
  return new Response(null, { status: 101, webSocket: client });
}

export default {
  /** @param {Request} request @param {any} env @param {ExecutionContext} ctx */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/health') {
      let turn = 'unconfigured';
      if (turnConfigured(env)) {
        try {
          turn = (await budgetSnapshot(env)).status;
        } catch {
          turn = 'ok';
        }
      }
      const out = { ok: true, protocol: 'dxr-signal/1', turn, keys: !!env.KEYS, limits: limitsFromEnv(env) };
      if (env.TURN_FAKE === '1' && !(env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN)) out.turnFake = true;
      return json(out);
    }
    if (url.pathname.startsWith('/admin/')) return admin(request, env, url);
    if (url.pathname !== '/v1/connect') return new Response('not found', { status: 404 });
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected a WebSocket upgrade', { status: 426 });
    const k = url.searchParams.get('k') || '';
    if (!KEY_RE_ROOM.test(k)) return new Response('bad room key', { status: 400 });
    // The legacy deployment-wide origin allowlist (self-hosters): still honoured, before keys.
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const origin = request.headers.get('Origin') || '';
    if (allowed.length && !allowed.includes(origin)) return new Response('origin not allowed', { status: 403 });

    const gate = gateFor(env);
    const admitted = await gate.admit({
      ip: request.headers.get('CF-Connecting-IP') || '',
      origin,
      key: url.searchParams.get('key') || null,
      roomKey: k,
      wantTurn: turnConfigured(env),
    });
    if (!admitted.ok) return refuseUpgrade(admitted);
    ctx.waitUntil(doCall(budgetStub(env), { op: 'join', key: admitted.session.key }).catch(() => {}));
    const h = new Headers(request.headers);
    h.set('X-Dxr-Session', JSON.stringify(admitted.session));
    const stub = env.ROOMS.get(env.ROOMS.idFromName(k));
    return stub.fetch(new Request(request.url, { method: 'GET', headers: h }));
  },

  /** Hourly: pull the real month-to-date relay figure from TURN analytics into the Budget object. */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        const u = await readTurnUsage(env);
        if (u) await doCall(budgetStub(env), { op: 'actual', totalGB: u.totalGB, byKey: u.byKey });
      })().catch((e) => console.warn('turn analytics poll failed:', e && e.message))
    );
  },
};

// ── admin (ADMIN_TOKEN secret; absent = no admin surface at all) ─────────────────────────────

async function admin(request, env, url) {
  if (!env.ADMIN_TOKEN) return new Response('not found', { status: 404 });
  const auth = request.headers.get('Authorization') || '';
  if (!(await tokenMatches(auth.replace(/^Bearer\s+/i, ''), env.ADMIN_TOKEN))) return new Response('unauthorized', { status: 401 });
  const parts = url.pathname.split('/').filter(Boolean); // ['admin', ...]
  const body = async () => {
    try {
      return await request.json();
    } catch {
      return {};
    }
  };
  if (parts[1] === 'usage') {
    if (request.method === 'GET') return json(await budgetSnapshot(env, true));
    if (request.method === 'POST') {
      const b = await body();
      if ('overrideGB' in b) await doCall(budgetStub(env), { op: 'override', gb: b.overrideGB === null ? null : Number(b.overrideGB) });
      if ('actualGB' in b) await doCall(budgetStub(env), { op: 'actual', totalGB: Number(b.actualGB), byKey: b.byKey || null });
      budgetCache = { at: 0, snap: null };
      return json(await budgetSnapshot(env, true));
    }
  }
  if (parts[1] === 'keys' && parts[2]) {
    if (!env.KEYS) return json({ error: 'no KEYS namespace bound' }, 501);
    const id = parts[2];
    if (!KEY_RE.test(id)) return json({ error: 'malformed key id' }, 400);
    if (request.method === 'GET') {
      const raw = await env.KEYS.get(`key:${id}`);
      return raw ? json(parseKeyRecord(id, raw)) : json({ error: 'not found' }, 404);
    }
    if (request.method === 'PUT') {
      const rec = parseKeyRecord(id, await body());
      if (!rec) return json({ error: 'bad record' }, 400);
      await env.KEYS.put(`key:${id}`, JSON.stringify(rec));
      return json(rec);
    }
    if (request.method === 'DELETE') {
      const raw = await env.KEYS.get(`key:${id}`);
      if (!raw) return json({ error: 'not found' }, 404);
      const rec = { ...parseKeyRecord(id, raw), revoked: true };
      await env.KEYS.put(`key:${id}`, JSON.stringify(rec));
      return json(rec);
    }
  }
  if (parts[1] === 'meter' && parts[2] && request.method === 'GET') return json(await meters(env).exec(decodeURIComponent(parts[2]), { op: 'peek' }));
  if (parts[1] === 'analytics' && request.method === 'POST') {
    // Pull the real figure now (the cron does this hourly).
    const u = await readTurnUsage(env);
    if (!u) return json({ error: 'analytics not configured (CF_ANALYTICS_API_TOKEN, CF_ACCOUNT_ID, TURN_KEY_ID)' }, 501);
    await doCall(budgetStub(env), { op: 'actual', totalGB: u.totalGB, byKey: u.byKey });
    return json(u);
  }
  return new Response('not found', { status: 404 });
}

async function tokenMatches(given, expected) {
  const a = new TextEncoder().encode(given || '');
  const b = new TextEncoder().encode(expected || '');
  if (a.length !== b.length || !b.length) return false;
  try {
    return globalThis.crypto.subtle.timingSafeEqual(a, b);
  } catch {
    return given === expected;
  }
}

// ── Durable Objects ──────────────────────────────────────────────────────────────────────────

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
    const env = this.env;
    const turn = turnConfigured(env)
      ? async (s) => {
          const ttl = s && s.turn && s.turn.ttl > 0 ? s.turn.ttl : undefined;
          const ice = env.TURN_FAKE === '1' && !(env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN) ? fakeIce(ttl || 600) : await mintTurnCredentials(env, undefined, { ttl, customIdentifier: (s && s.key) || 'anon' });
          if (ice) doCall(budgetStub(env), { op: 'mint', key: s ? s.key : null, ttl: ttl || parseInt(env.TURN_TTL || '3600', 10) || 3600 }).catch(() => {});
          return ice;
        }
      : null;
    this.room = new Room({
      key,
      cap,
      iceServers: turn,
      hooks: {
        // The room's lifetime starts with its first peer (RFC §5b) and is the FIRST joiner's tier's.
        onFirst: (s) => {
          const ttlS = s && s.roomTtlS > 0 ? s.roomTtlS : limitsFromEnv(env).anon.roomTtlS;
          this.state.storage.setAlarm(Date.now() + ttlS * 1000).catch(() => {});
        },
        onEmpty: () => this.state.storage.deleteAlarm().catch(() => {}),
      },
    });
    // Woken from hibernation: re-attach every socket that had already joined.
    for (const ws of this.state.getWebSockets()) {
      const a = ws.deserializeAttachment() || {};
      if (a.id) this.room.restore(this._conn(ws), a.id, a.session || null);
      else if (a.session) this.room.attach(this._conn(ws), a.session);
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
          if (obj && obj.t === 'welcome') ws.serializeAttachment({ ...(ws.deserializeAttachment() || {}), id: obj.id, max: obj.max });
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
    const room = await this._ensureRoom(key);
    let session = null;
    try {
      session = JSON.parse(request.headers.get('X-Dxr-Session') || 'null');
    } catch {
      session = null;
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ session });
    room.attach(this._conn(server), session);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const room = await this._ensureRoom(null);
    await room.onMessage(this._conn(ws), typeof message === 'string' ? message : new TextDecoder().decode(message));
  }

  async _closed(ws) {
    (await this._ensureRoom(null)).onClose(this._conn(ws));
    const a = ws.deserializeAttachment() || {};
    if (a.session && Array.isArray(a.session.leases) && a.session.leases.length) {
      const s = a.session;
      ws.serializeAttachment({ ...a, session: { ...s, leases: [] } }); // release exactly once
      await gateFor(this.env).release(s);
    }
  }

  async webSocketClose(ws) {
    await this._closed(ws);
  }

  async webSocketError(ws) {
    await this._closed(ws);
  }

  /** The room's lifetime alarm. */
  async alarm() {
    const room = await this._ensureRoom(null);
    const conns = [...room.peers.values()];
    room.expire();
    // The sockets are closed by expire(); their close events release the leases.
    void conns;
  }
}

/** One rate-limit subject's counters (limits.mjs Meter), persisted in the object's storage. */
export class MeterObject {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.meter = null;
    this.state.blockConcurrencyWhile(async () => {
      this.meter = Meter.from((await this.state.storage.get('meter')) || null);
    });
  }

  async fetch(request) {
    let cmd;
    try {
      cmd = await request.json();
    } catch {
      return json({ ok: false, code: 'bad-op' }, 400);
    }
    if (!this.meter) this.meter = Meter.from((await this.state.storage.get('meter')) || null);
    const out = this.meter.exec(cmd);
    await this.state.storage.put('meter', this.meter.toJSON());
    return json(out);
  }
}

/** The deployment's TURN budget (turn-budget.mjs TurnBudget), persisted in the object's storage. */
export class BudgetObject {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.budget = null;
    this.state.blockConcurrencyWhile(async () => {
      this.budget = new TurnBudget({ cfg: budgetFromEnv(env), state: (await this.state.storage.get('budget')) || null });
    });
  }

  async fetch(request) {
    let cmd;
    try {
      cmd = await request.json();
    } catch {
      return json({ ok: false, code: 'bad-op' }, 400);
    }
    if (!this.budget) this.budget = new TurnBudget({ cfg: budgetFromEnv(this.env), state: (await this.state.storage.get('budget')) || null });
    const b = this.budget;
    switch (cmd.op) {
      case 'snapshot':
        return json(b.snapshot());
      case 'join':
        b.recordJoin(cmd.key);
        break;
      case 'mint':
        b.recordMint(cmd.key, cmd.ttl);
        break;
      case 'actual':
        b.setActual(cmd.totalGB, { byKey: cmd.byKey || null });
        break;
      case 'override':
        b.setOverride(cmd.gb === null ? NaN : Number(cmd.gb));
        break;
      default:
        return json({ ok: false, code: 'bad-op' }, 400);
    }
    await this.state.storage.put('budget', b.toJSON());
    return json({ ok: true, ...b.snapshot() });
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
}

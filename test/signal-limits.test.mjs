// Tests for the hosted-service half of dxr-signal/1 (RFC 0003 §5, phase C3): rate limits and
// room leases (limits.mjs), publishable keys (keys.mjs), TURN metering + the monthly cap
// (turn-budget.mjs), the admission gate that ties them together (gate.mjs), the welcome's new
// fields and room expiry (room.mjs) — and the same things end to end against the Node dev server
// with the SDK's own adapter, plus the adapter's alias failover against a fake WebSocket.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Meter, limitsFromEnv, limitsFor, DEFAULT_LIMITS, subjectForIp, CLOSE_CODES, MINUTE_MS, HOUR_MS } from '../signaling/limits.mjs';
import { KEY_RE, newKeyId, parseKeyRecord, originAllowed, resolveKey, mapKeyStore } from '../signaling/keys.mjs';
import { TurnBudget, budgetFromEnv, budgetGB, turnPolicy, statusFor, readTurnUsage, DEFAULT_BUDGET, GB } from '../signaling/turn-budget.mjs';
import { createGate } from '../signaling/gate.mjs';
import { Room, refuseConn } from '../signaling/room.mjs';
import { startDevServer } from '../signaling/dev-server.mjs';
import { dxrSignaling, DXR_SIGNAL_ALIASES, DXR_SIGNAL_DEFAULT } from '../js/call/signaling.js';
import { MeshTransport, DEFAULT_ICE_SERVERS } from '../js/call/transport.js';
import { newRoomId } from '../js/inline3d-call.js';

const clock = (t0 = 1_000_000) => {
  let t = t0;
  return { now: () => t, tick: (ms) => (t += ms) };
};

// ── limits.mjs ───────────────────────────────────────────────────────────────────────────────

test('Meter: a fixed window admits `limit` hits, refuses the rest with a retry hint, and resets', () => {
  const c = clock();
  const m = new Meter({ now: c.now });
  for (let i = 1; i <= 20; i++) assert.equal(m.hit('joins.anon', MINUTE_MS, 20).ok, true, `hit ${i}`);
  const r = m.hit('joins.anon', MINUTE_MS, 20);
  assert.equal(r.ok, false);
  assert.equal(r.count, 21);
  assert.ok(r.retryMs > 0 && r.retryMs <= MINUTE_MS);
  c.tick(MINUTE_MS);
  assert.equal(m.hit('joins.anon', MINUTE_MS, 20).ok, true, 'a new window');
  // Windows are independent per name: the keyed window of the same subject is untouched.
  assert.equal(m.hit('joins.key', MINUTE_MS, 200).count, 1);
});

test('Meter: room leases count DISTINCT rooms, a held room is always re-enterable, leases expire', () => {
  const c = clock();
  const m = new Meter({ now: c.now });
  for (let i = 0; i < 5; i++) assert.equal(m.acquire(`room${i}`, 5, HOUR_MS).ok, true);
  assert.equal(m.acquire('room9', 5, HOUR_MS).ok, false, 'a 6th distinct room');
  assert.equal(m.acquire('room0', 5, HOUR_MS).ok, true, 'a second connection into a held room');
  m.release('room0');
  assert.equal(m.rooms(), 5, 'still held by the other connection');
  m.release('room0');
  assert.equal(m.rooms(), 4);
  assert.equal(m.acquire('room9', 5, HOUR_MS).ok, true);
  c.tick(HOUR_MS + 1);
  assert.equal(m.rooms(), 0, 'a lost release cannot wedge the subject: leases expire');
});

test('Meter: admit = join window then lease, in that order; serialises and restores', () => {
  const c = clock();
  const m = new Meter({ now: c.now });
  const cmd = { op: 'admit', roomKey: 'r1', tierName: 'anon', joinsPerMin: 3, rooms: 1, leaseTtlMs: HOUR_MS };
  assert.equal(m.exec(cmd).ok, true);
  assert.equal(m.exec({ ...cmd, roomKey: 'r2' }).code, 'quota', 'second distinct room over the lease limit');
  assert.equal(m.exec(cmd).ok, true, 'the held room again');
  const r = m.exec(cmd);
  assert.equal(r.code, 'rate-limited', '4th join in the minute');
  assert.ok(r.retryMs > 0);
  const again = Meter.from(JSON.parse(JSON.stringify(m.toJSON())), c.now);
  assert.equal(again.rooms(), 1);
  assert.equal(again.exec(cmd).code, 'rate-limited', 'the window survived the round trip');
  assert.equal(again.exec({ op: 'nope' }).code, 'bad-op');
});

test('limits: env overrides and per-key overrides; TTL clamps; IP subjects are salted hashes', async () => {
  const base = limitsFromEnv({ ANON_JOINS_PER_MIN: '7', KEY_ROOMS: '9', ANON_TURN_TTL: '10', TURN_TTL: '99999' });
  assert.equal(base.anon.joinsPerMin, 7);
  assert.equal(base.key.rooms, 9);
  assert.equal(base.anon.turnTtl, 60, 'clamped up to 60 s');
  assert.equal(base.key.turnTtl, 86400, 'clamped down to a day');
  assert.equal(base.key.joinsPerMin, DEFAULT_LIMITS.key.joinsPerMin);
  const k = limitsFor('key', { limits: { rooms: 100, turnTtl: 7200, bogus: 1 } }, base);
  assert.equal(k.rooms, 100);
  assert.equal(k.turnTtl, 7200);
  assert.equal(k.joinsPerMin, 200);
  assert.deepEqual(limitsFor('anon', { limits: { rooms: 100 } }, base).rooms, 5, 'anonymous sessions take no key overrides');
  const a = await subjectForIp('203.0.113.9', 'salt1');
  assert.match(a, /^ip:[0-9a-f]{24}$/);
  assert.notEqual(a, await subjectForIp('203.0.113.9', 'salt2'));
  assert.ok(!a.includes('203'), 'no raw address in the subject');
});

// ── keys.mjs ─────────────────────────────────────────────────────────────────────────────────

test('keys: ids, records, origin matching', () => {
  const id = newKeyId();
  assert.match(id, KEY_RE);
  assert.equal(parseKeyRecord('nope', { origins: [] }), null);
  const rec = parseKeyRecord(id, JSON.stringify({ origins: ['https://App.Example.com/', 'https://*.example.org', 'http://localhost'], note: 'acme', limits: { rooms: 3 } }));
  assert.deepEqual(rec.origins, ['https://app.example.com', 'https://*.example.org', 'http://localhost']);
  assert.equal(rec.revoked, false);
  assert.equal(rec.limits.rooms, 3);
  assert.equal(originAllowed('https://app.example.com', rec.origins), true);
  assert.equal(originAllowed('https://APP.example.com:443', rec.origins), true, 'default port + case');
  assert.equal(originAllowed('https://evil.com', rec.origins), false);
  assert.equal(originAllowed('https://a.example.org', rec.origins), true, 'one-label wildcard');
  assert.equal(originAllowed('https://example.org', rec.origins), false, 'wildcard needs a label');
  assert.equal(originAllowed('https://a.b.example.org', rec.origins), false, 'one label only');
  assert.equal(originAllowed('http://localhost:5173', rec.origins), true, 'localhost: any port');
  assert.equal(originAllowed('', rec.origins), false, 'no Origin header → not a browser → refused');
  assert.equal(originAllowed('', ['*']), true);
  assert.equal(originAllowed('null', ['https://x.com']), false, 'an opaque origin');
});

test('keys: resolveKey — anonymous, malformed, unknown, revoked, wrong origin, ok', async () => {
  const id = newKeyId();
  const store = mapKeyStore({ [id]: { origins: ['https://ok.example'] }, [newKeyId()]: { origins: ['*'], revoked: true } });
  assert.deepEqual(await resolveKey('', store, 'https://x'), { ok: true, tier: 'anon' });
  assert.equal((await resolveKey('pk_short', store, 'https://x')).code, 'bad-key');
  assert.equal((await resolveKey(newKeyId(), store, 'https://x')).code, 'bad-key');
  assert.equal((await resolveKey(id, store, 'https://nope.example')).code, 'origin-not-allowed');
  const r = await resolveKey(id, store, 'https://ok.example');
  assert.equal(r.tier, 'key');
  assert.equal(r.key.id, id);
  assert.equal((await resolveKey(id, null, 'https://ok.example')).code, 'bad-key', 'no store = keys unsupported');
});

// ── turn-budget.mjs ──────────────────────────────────────────────────────────────────────────

test('budget: free tier + $cap/price = the month; status thresholds; the policy matrix', () => {
  const cfg = budgetFromEnv({});
  assert.equal(budgetGB(cfg), 3000, '1000 GB free + $100 / $0.05');
  assert.equal(budgetGB(budgetFromEnv({ TURN_CAP_USD: '0' })), 1000);
  assert.equal(statusFor(0.69), 'ok');
  assert.equal(statusFor(0.7), 'degraded');
  assert.equal(statusFor(1), 'off');
  const lim = limitsFromEnv({});
  const at = (f, tier) => turnPolicy({ fraction: f }, tier, lim[tier], cfg);
  assert.deepEqual(at(0.1, 'anon'), { mint: true, ttl: 600, mintsPerHour: 30, status: 'ok' });
  assert.deepEqual(at(0.1, 'key'), { mint: true, ttl: 3600, mintsPerHour: 300, status: 'ok' });
  assert.deepEqual(at(0.75, 'anon'), { mint: true, ttl: 300, mintsPerHour: 5, status: 'degraded' }, '70%: anonymous shortened');
  assert.deepEqual(at(0.75, 'key'), { mint: true, ttl: 3600, mintsPerHour: 300, status: 'degraded' }, '70%: keyed untouched');
  assert.deepEqual(at(0.92, 'anon'), { mint: false, ttl: 0, mintsPerHour: 0, status: 'degraded', reason: 'budget' }, '90%: anonymous stops');
  assert.equal(at(0.92, 'key').mint, true, '90%: keyed keeps TURN');
  assert.deepEqual(at(1.0, 'key'), { mint: false, ttl: 0, mintsPerHour: 0, status: 'off', reason: 'cap' }, '100%: nobody');
  assert.equal(at(1.5, 'anon').reason, 'cap');
});

test('TurnBudget: estimate from minted TTLs, the real figure when fresh, override and force beat both, month rollover', () => {
  const c = clock(Date.UTC(2026, 9, 3, 12));
  const b = new TurnBudget({ cfg: budgetFromEnv({}), now: c.now });
  assert.equal(b.snapshot().usedGB, 0);
  assert.equal(b.snapshot().source, 'estimate');
  for (let i = 0; i < 10; i++) b.recordMint('pk_a', 3600);
  b.recordMint(null, 600);
  assert.equal(b.estimatedGB, (10 + 600 / 3600) * 0.3);
  assert.equal(b.snapshot().byKey.pk_a.mints, 10);
  assert.equal(b.snapshot().byKey.anon.ttlSeconds, 600);
  b.setActual(1500, { byKey: { pk_a: 1400, anon: 100 } });
  assert.equal(b.snapshot().source, 'actual');
  assert.equal(b.snapshot().usedGB, 1500);
  assert.equal(b.snapshot().status, 'ok');
  assert.equal(b.snapshot().byKey.pk_a.actualGB, 1400);
  c.tick(4 * HOUR_MS);
  assert.equal(b.snapshot().source, 'estimate', 'a stale analytics figure no longer counts');
  b.setOverride(2850);
  assert.equal(b.snapshot().source, 'override');
  assert.equal(b.snapshot().fraction, 0.95);
  assert.equal(b.snapshot().status, 'degraded');
  const forced = new TurnBudget({ cfg: budgetFromEnv({ TURN_FORCE_USAGE_GB: '3100' }), now: c.now, state: b.toJSON() });
  assert.equal(forced.snapshot().source, 'forced');
  assert.equal(forced.snapshot().status, 'off');
  assert.equal(forced.snapshot().overrideGB, 2850, 'state restored');
  // A new month forgets usage but keeps the operator's override switch.
  c.tick(31 * 24 * HOUR_MS);
  const next = new TurnBudget({ cfg: budgetFromEnv({}), now: c.now, state: b.toJSON() });
  assert.equal(next.estimatedGB, 0);
  assert.equal(next.snapshot().overrideGB, 2850);
  b.setOverride(null);
  assert.equal(b.snapshot().source, 'estimate');
});

test('readTurnUsage: null when unconfigured; sums egress+ingress per customIdentifier from the GraphQL answer', async () => {
  assert.equal(await readTurnUsage({}), null);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return {
      ok: true,
      json: async () => ({
        data: {
          viewer: {
            accounts: [
              {
                callsTurnUsageAdaptiveGroups: [
                  { dimensions: { customIdentifier: 'pk_a' }, sum: { egressBytes: 2 * GB, ingressBytes: 1 * GB } },
                  { dimensions: { customIdentifier: 'anon' }, sum: { egressBytes: 0.5 * GB, ingressBytes: 0 } },
                ],
              },
            ],
          },
        },
      }),
    };
  };
  const u = await readTurnUsage({ CF_ANALYTICS_API_TOKEN: 't', CF_ACCOUNT_ID: 'acc', TURN_KEY_ID: 'kid' }, { fetchImpl, now: Date.UTC(2026, 9, 3) });
  assert.equal(calls[0].url, 'https://api.cloudflare.com/client/v4/graphql');
  assert.equal(calls[0].body.variables.key, 'kid');
  assert.equal(calls[0].body.variables.from, '2026-10-01');
  assert.match(calls[0].body.query, /callsTurnUsageAdaptiveGroups/);
  assert.equal(u.totalGB, 3.5);
  assert.deepEqual(u.byKey, { pk_a: 3, anon: 0.5 });
});

// ── gate.mjs ─────────────────────────────────────────────────────────────────────────────────

function memGate({ env = {}, keys = null, fraction = 0, now } = {}) {
  const meters = new Map();
  const exec = (subject, cmd) => {
    let m = meters.get(subject);
    if (!m) meters.set(subject, (m = new Meter({ now })));
    return m.exec(cmd);
  };
  const budget = { snapshot: () => ({ fraction, status: statusFor(fraction) }), cfg: budgetFromEnv(env), set: (f) => (fraction = f) };
  const gate = createGate({ limits: limitsFromEnv(env), keys: keys ? mapKeyStore(keys) : null, budget, meters: { exec }, blocklist: { has: (ip) => ip === '9.9.9.9' }, salt: 's' });
  return { gate, meters, budget };
}

test('gate: anonymous — join rate per IP, concurrent rooms per IP, TURN at the tier TTL, leases released', async () => {
  const { gate, budget } = memGate({ env: { ANON_JOINS_PER_MIN: '8', ANON_ROOMS: '2' } });
  const ip = '198.51.100.1';
  const a = await gate.admit({ ip, origin: '', key: null, roomKey: 'k1' });
  assert.equal(a.ok, true);
  assert.equal(a.session.tier, 'anon');
  assert.equal(a.session.key, null);
  assert.deepEqual(a.session.turn, { mint: true, ttl: 600, status: 'ok' });
  assert.equal(a.session.roomTtlS, 7200);
  assert.equal(a.session.leases.length, 1);
  assert.equal((await gate.admit({ ip, origin: '', key: null, roomKey: 'k2' })).ok, true);
  const q = await gate.admit({ ip, origin: '', key: null, roomKey: 'k3' });
  assert.equal(q.code, 'quota');
  assert.equal(q.closeCode, CLOSE_CODES.quota);
  await gate.release(a.session);
  assert.equal((await gate.admit({ ip, origin: '', key: null, roomKey: 'k3' })).ok, true, 'released → a new room fits');
  for (let i = 0; i < 4; i++) await gate.admit({ ip, origin: '', key: null, roomKey: 'k3' });
  const r = await gate.admit({ ip, origin: '', key: null, roomKey: 'k3' });
  assert.equal(r.code, 'rate-limited', '9th join in the minute');
  assert.equal(r.closeCode, 4029);
  assert.ok(r.retryMs > 0);
  assert.equal((await gate.admit({ ip: '198.51.100.2', origin: '', key: null, roomKey: 'k3' })).ok, true, 'another IP is unaffected');
  assert.equal((await gate.admit({ ip: '9.9.9.9', origin: '', key: null, roomKey: 'k3' })).code, 'blocked');
  budget.set(0.95);
  const shed = await gate.admit({ ip: '198.51.100.3', origin: '', key: null, roomKey: 'k3' });
  assert.deepEqual(shed.session.turn, { mint: false, ttl: 0, status: 'degraded', reason: 'budget' });
  const none = await gate.admit({ ip: '198.51.100.3', origin: '', key: null, roomKey: 'k3', wantTurn: false });
  assert.equal(none.session.turn.reason, 'unconfigured', 'a server without TURN never consults the budget');
});

test('gate: keyed — origin binding, the key\'s own room quota and limits, a separate per-IP join window, the cap', async () => {
  const id = newKeyId();
  const { gate, budget } = memGate({ env: { ANON_JOINS_PER_MIN: '1', ANON_MINTS_PER_HOUR: '1' }, keys: { [id]: { origins: ['https://app.example'], limits: { rooms: 1, mintsPerHour: 2 } } } });
  const ip = '198.51.100.7';
  assert.equal((await gate.admit({ ip, origin: 'https://other.example', key: id, roomKey: 'k1' })).code, 'origin-not-allowed');
  assert.equal((await gate.admit({ ip, origin: 'https://app.example', key: 'pk_bogus', roomKey: 'k1' })).code, 'bad-key');
  const a = await gate.admit({ ip, origin: 'https://app.example', key: id, roomKey: 'k1' });
  assert.equal(a.ok, true);
  assert.equal(a.session.tier, 'key');
  assert.equal(a.session.key, id);
  assert.equal(a.session.turn.ttl, 3600);
  assert.equal(a.session.roomTtlS, 8 * 3600);
  assert.deepEqual(a.session.leases.map((l) => l.subject), [`key:${id}`], 'keyed sessions lease on the key, not the IP');
  assert.equal((await gate.admit({ ip, origin: 'https://app.example', key: id, roomKey: 'k2' })).code, 'quota', 'the key\'s rooms override (1)');
  // The anonymous window on this IP is exhausted after one join; the keyed window is separate.
  assert.equal((await gate.admit({ ip, origin: '', key: null, roomKey: 'k9' })).ok, true);
  assert.equal((await gate.admit({ ip, origin: '', key: null, roomKey: 'k9' })).code, 'rate-limited');
  const b = await gate.admit({ ip, origin: 'https://app.example', key: id, roomKey: 'k1' });
  assert.equal(b.ok, true, 'keyed joins from the flooded IP still work');
  const c = await gate.admit({ ip, origin: 'https://app.example', key: id, roomKey: 'k1' });
  assert.deepEqual(c.session.turn, { mint: false, ttl: 0, status: 'ok', reason: 'rate' }, '3rd mint this hour over the key\'s mintsPerHour=2: joins, STUN-only');
  budget.set(0.95);
  assert.equal((await gate.admit({ ip: '198.51.100.8', origin: 'https://app.example', key: id, roomKey: 'k1' })).session.turn.mint, true, '90%: keyed keeps TURN');
  budget.set(1.01);
  const cap = await gate.admit({ ip: '198.51.100.8', origin: 'https://app.example', key: id, roomKey: 'k1' });
  assert.equal(cap.ok, true, 'the cap refuses relays, not joins');
  assert.deepEqual(cap.session.turn, { mint: false, ttl: 0, status: 'off', reason: 'cap' });
});

// ── room.mjs: the welcome's new fields, expiry, refusals ─────────────────────────────────────

const fakeConn = () => {
  const out = [];
  return { out, conn: { send: (m) => out.push(m), close: (code, reason) => out.push({ closed: code, reason }) } };
};

test('Room: welcome carries tier / key / turn; the minter sees the session; expire() tells everyone (4004)', async () => {
  const seen = [];
  const r = new Room({ iceServers: async (s) => (seen.push(s), [{ urls: 'turn:x', username: 'u', credential: 'c' }]) });
  const a = fakeConn();
  const session = { tier: 'key', key: 'pk_x', turn: { mint: true, ttl: 1234, status: 'degraded' }, roomTtlS: 10, leases: [] };
  r.attach(a.conn, session);
  await r.onMessage(a.conn, JSON.stringify({ t: 'join', v: 1, room: newRoomId(), id: 'peerAAAA1' }));
  assert.equal(a.out[0].t, 'welcome');
  assert.equal(a.out[0].tier, 'key');
  assert.equal(a.out[0].key, 'pk_x');
  assert.deepEqual(a.out[0].turn, { status: 'degraded', ttl: 1234 });
  assert.equal(a.out[0].iceServers.length, 1);
  assert.equal(seen[0], session);
  // An admitted-without-TURN session: no mint, the welcome says why.
  const b = fakeConn();
  r.attach(b.conn, { tier: 'anon', key: null, turn: { mint: false, ttl: 0, status: 'off', reason: 'cap' }, roomTtlS: 10, leases: [] });
  await r.onMessage(b.conn, JSON.stringify({ t: 'join', v: 1, room: (await import('../js/inline3d-call.js')).newRoomId(), id: 'peerBBBB2' }));
  // (that join is refused: wrong room for this key-less Room? No — a Room without a key accepts any room id)
  assert.equal(b.out[0].t, 'welcome');
  assert.equal(b.out[0].iceServers, undefined);
  assert.deepEqual(b.out[0].turn, { status: 'off', reason: 'cap' });
  assert.equal(seen.length, 1, 'no mint attempted');
  // No minter at all (self-hosted, STUN-only): 'unconfigured'.
  const r2 = new Room({});
  const c = fakeConn();
  await r2.onMessage(c.conn, JSON.stringify({ t: 'join', v: 1, room: newRoomId(), id: 'peerCCCC3' }));
  assert.deepEqual(c.out[0].turn, { status: 'off', reason: 'unconfigured' });
  assert.equal(c.out[0].tier, 'anon');
  // Expiry.
  let empties = 0;
  r.hooks.onEmpty = () => empties++;
  r.expire();
  assert.equal(r.size, 0);
  assert.deepEqual(a.out.at(-2), { t: 'expired' });
  assert.deepEqual(a.out.at(-1), { closed: 4004, reason: 'expired' });
  assert.deepEqual(b.out.at(-2), { t: 'expired' });
  assert.equal(empties, 1);
  // Refusals carry their own close code.
  const d = fakeConn();
  refuseConn(d.conn, { code: 'rate-limited', message: 'slow down', retryMs: 1500, closeCode: CLOSE_CODES['rate-limited'] });
  assert.deepEqual(d.out, [{ t: 'error', code: 'rate-limited', message: 'slow down', retryMs: 1500 }, { closed: 4029, reason: 'rate-limited' }]);
});

// ── end to end against the dev server, with the SDK adapter ──────────────────────────────────

const FAKE_ICE = [{ urls: 'turn:turn.invalid:3478', username: 'u', credential: 'c' }];
const hooks = (id) => ({ id, maxPeers: 4, events: [], onDisconnect(err) { this.events.push(['disconnect', err && err.code]); } });

async function withServer(opts, fn) {
  const srv = await startDevServer({ port: 0, turn: async () => FAKE_ICE, ...opts });
  try {
    await fn(srv);
  } finally {
    await srv.close();
  }
}

/** The dev server reads the page origin from the upgrade request; Node's WebSocket lets a test set it. */
const wsWithOrigin = (origin) =>
  class extends globalThis.WebSocket {
    constructor(url) {
      super(url, { headers: { origin } });
    }
  };

// ── room.mjs: ordering — `welcome` is the first message a joined peer receives ────────────────
// With a real TURN key the mint is a network call, so a join has an await between "slot reserved"
// and "welcome sent". Whatever is addressed to that peer in between must wait behind its welcome.

/** A minter whose calls resolve only when the test says so (and in the order it says). */
const deferredMinter = () => {
  const calls = [];
  const ice = [{ urls: 'turn:x', username: 'u', credential: 'c' }];
  return { calls, mint: () => new Promise((res) => calls.push(() => res(ice))) };
};
const tick = () => new Promise((r) => setTimeout(r, 0));
const types = (c) => c.out.map((m) => m.t || (m.closed ? `closed:${m.closed}` : '?'));
const joinMsg = (id, extra = {}) => JSON.stringify({ t: 'join', v: 1, room: 'roomroomroomroom1234', id, ...extra });

test('Room: nothing reaches a peer before its welcome, even when another peer joins and signals it during its TURN mint; the roster is read at send time and each pair hears of the other exactly once', async () => {
  const d = deferredMinter();
  const r = new Room({ iceServers: d.mint });
  const a = fakeConn();
  const b = fakeConn();
  const pa = r.onMessage(a.conn, joinMsg('peerAAAA1'));
  const pb = r.onMessage(b.conn, joinMsg('peerBBBB2'));
  await tick();
  assert.equal(d.calls.length, 2, 'both joins are waiting on their mint');
  assert.deepEqual(types(a), [], 'A: nothing before its welcome (B joined during A\'s mint)');
  assert.deepEqual(types(b), []);
  // B's mint lands first: B is welcomed while A is still waiting.
  d.calls[1]();
  await pb;
  assert.deepEqual(types(b), ['welcome']);
  assert.deepEqual(b.out[0].peers, ['peerAAAA1'], 'B\'s roster already has A (its slot is reserved)');
  assert.deepEqual(types(a), [], 'A still has nothing: no peer-joined ahead of its welcome');
  // B is entitled to signal A now; A must not see it before its own welcome.
  await r.onMessage(b.conn, JSON.stringify({ t: 'signal', to: 'peerAAAA1', data: { sdp: 'offer' } }));
  assert.deepEqual(types(a), [], 'a signal addressed to a not-yet-welcomed peer is held');
  // A, not yet welcomed, has nothing to signal about.
  await r.onMessage(a.conn, JSON.stringify({ t: 'signal', to: 'peerBBBB2', data: {} }));
  assert.equal(a.out.length, 1);
  assert.equal(a.out[0].code, 'not-joined');
  a.out.length = 0;
  d.calls[0]();
  await pa;
  assert.deepEqual(types(a), ['welcome', 'signal'], 'welcome first, then what was held, in order');
  assert.deepEqual(a.out[0].peers, ['peerBBBB2'], 'A\'s roster is read when its welcome goes out — it includes B');
  assert.equal(a.out[1].from, 'peerBBBB2');
  assert.ok(!types(b).includes('peer-joined'), 'B had A in its roster: no second announcement');
  assert.ok(!types(a).includes('peer-joined'), 'A has B in its roster: no second announcement');
  // A third peer, after both are welcomed: told to each of them exactly once.
  const c = fakeConn();
  const pc = r.onMessage(c.conn, joinMsg('peerCCCC3'));
  await tick();
  assert.deepEqual(a.out.filter((m) => m.t === 'peer-joined').map((m) => m.id), ['peerCCCC3']);
  assert.deepEqual(b.out.filter((m) => m.t === 'peer-joined').map((m) => m.id), ['peerCCCC3']);
  d.calls[2]();
  await pc;
  assert.deepEqual(types(c), ['welcome']);
  assert.deepEqual(c.out[0].peers, ['peerAAAA1', 'peerBBBB2']);
});

test('Room: a burst into a room of 4 reserves exactly 4 slots and mints exactly 4 times — the rest are `full` at once, with no credentials minted for them', async () => {
  const d = deferredMinter();
  const r = new Room({ iceServers: d.mint });
  const conns = Array.from({ length: 7 }, fakeConn);
  const ps = conns.map((c, i) => r.onMessage(c.conn, joinMsg(`peerBURST${i}`, { max: 4 })));
  await tick();
  assert.equal(d.calls.length, 4, 'one mint per reserved slot, none for the refused');
  assert.deepEqual(conns.slice(4).map(types), [['full', 'closed:4003'], ['full', 'closed:4003'], ['full', 'closed:4003']]);
  assert.deepEqual(conns.slice(0, 4).map(types), [[], [], [], []], 'the four admitted are silent until their own welcome');
  for (const go of [d.calls[3], d.calls[1], d.calls[0], d.calls[2]]) go(); // any order
  await Promise.all(ps);
  for (const c of conns.slice(0, 4)) {
    assert.equal(types(c)[0], 'welcome', 'welcome is first for every admitted peer');
    assert.equal(c.out[0].peers.length, 3, 'and every roster has the other three');
    assert.ok(!types(c).includes('peer-joined'), 'so nobody is announced twice');
  }
});

test('Room: a peer that goes away during its mint gets no welcome; the others hear peer-left once and the slot is free again', async () => {
  const d = deferredMinter();
  const r = new Room({ iceServers: d.mint });
  const b = fakeConn();
  const pb = r.onMessage(b.conn, joinMsg('peerBBBB2', { max: 2 }));
  await tick();
  d.calls[0]();
  await pb;
  const a = fakeConn();
  const pa = r.onMessage(a.conn, joinMsg('peerAAAA1'));
  await tick();
  assert.deepEqual(b.out.slice(1).map((m) => [m.t, m.id]), [['peer-joined', 'peerAAAA1']]);
  r.onClose(a.conn); // the socket died while the mint was in flight
  assert.deepEqual(b.out.slice(2).map((m) => [m.t, m.id]), [['peer-left', 'peerAAAA1']]);
  d.calls[1]();
  await pa;
  assert.deepEqual(types(a), [], 'no welcome to a peer that already left');
  assert.equal(r.size, 1);
  const c = fakeConn();
  const pc = r.onMessage(c.conn, joinMsg('peerCCCC3'));
  await tick();
  d.calls[2]();
  await pc;
  assert.equal(types(c)[0], 'welcome', 'the freed slot is usable');
});

test('dev server: a join flood from one IP is answered `rate-limited` (with retryMs), never a hang; a keyed join from the same IP still works', async () => {
  const id = newKeyId();
  await withServer({ env: { ANON_JOINS_PER_MIN: '3' }, keys: { [id]: { origins: ['*'] } } }, async (srv) => {
    const room = newRoomId();
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => dxrSignaling(srv.url).join(room, hooks(`peer000${i}`))));
    const ok = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r) => r.status === 'rejected');
    assert.equal(ok.length, 3, 'the window admits 3');
    assert.equal(refused.length, 5);
    for (const r of refused) {
      assert.equal(r.reason.code, 'rate-limited');
      assert.ok(r.reason.retryMs > 0 && r.reason.retryMs <= 60_000, `retryMs ${r.reason.retryMs}`);
    }
    const keyed = await dxrSignaling(srv.url, { key: id }).join(room, hooks('peerKEY01'));
    assert.equal(keyed.tier, 'key');
    assert.equal(keyed.key, id);
    assert.deepEqual(keyed.iceServers, FAKE_ICE);
    keyed.leave();
    for (const r of ok) r.value.leave();
    const h = await (await fetch(`http://127.0.0.1:${srv.port}/`)).json();
    assert.equal(h.ok, true);
    assert.equal(h.turn, 'ok');
    assert.equal(h.keys, true);
    assert.equal(srv.budget.snapshot().byKey[id].joins, 1);
    assert.equal(srv.budget.snapshot().byKey.anon.mints, 3, 'only admitted sessions minted');
  });
});

test('dev server: concurrent-room quota per IP → `quota`; a key is bound to its origin', async () => {
  const id = newKeyId();
  await withServer({ env: { ANON_ROOMS: '1' }, keys: { [id]: { origins: ['https://app.example'] } } }, async (srv) => {
    const s1 = await dxrSignaling(srv.url).join(newRoomId(), hooks('peer00001'));
    await assert.rejects(dxrSignaling(srv.url).join(newRoomId(), hooks('peer00002')), (e) => e.code === 'quota');
    s1.leave();
    await new Promise((r) => setTimeout(r, 50));
    const s2 = await dxrSignaling(srv.url).join(newRoomId(), hooks('peer00003'));
    s2.leave();
    await assert.rejects(dxrSignaling(srv.url, { key: id }).join(newRoomId(), hooks('peer00004')), (e) => e.code === 'origin-not-allowed', 'Node sends no Origin');
    await assert.rejects(dxrSignaling(srv.url, { key: id, WebSocket: wsWithOrigin('https://evil.example') }).join(newRoomId(), hooks('peer00005')), (e) => e.code === 'origin-not-allowed');
    await assert.rejects(dxrSignaling(srv.url, { key: 'pk_nope' }).join(newRoomId(), hooks('peer00006')), (e) => e.code === 'bad-key');
    const ok = await dxrSignaling(srv.url, { key: id, WebSocket: wsWithOrigin('https://app.example') }).join(newRoomId(), hooks('peer00007'));
    assert.equal(ok.key, id);
    ok.leave();
  });
});

test('dev server: forced 90% sheds anonymous TURN only; forced cap refuses every relay (`cap`) while joins and presence still work', async () => {
  const id = newKeyId();
  await withServer({ keys: { [id]: { origins: ['*'] } } }, async (srv) => {
    const room = newRoomId();
    srv.budget.setOverride(0.95 * budgetGB(srv.budget.cfg));
    const anon = await dxrSignaling(srv.url).join(room, hooks('peerANON1'));
    assert.equal(anon.iceServers, undefined);
    assert.deepEqual(anon.turn, { status: 'degraded', reason: 'budget' });
    const keyed = await dxrSignaling(srv.url, { key: id }).join(room, hooks('peerKEY01'));
    assert.deepEqual(keyed.iceServers, FAKE_ICE, 'keyed keeps TURN at 90%');
    assert.deepEqual(keyed.turn, { status: 'degraded', ttl: 3600 });
    anon.leave();
    keyed.leave();
    srv.budget.setOverride(budgetGB(srv.budget.cfg) + 1);
    const a2 = await dxrSignaling(srv.url).join(room, hooks('peerANON2'));
    const k2 = await dxrSignaling(srv.url, { key: id }).join(room, hooks('peerKEY02'));
    assert.deepEqual(a2.turn, { status: 'off', reason: 'cap' });
    assert.deepEqual(k2.turn, { status: 'off', reason: 'cap' });
    assert.equal(k2.iceServers, undefined);
    assert.deepEqual(k2.peers, ['peerANON2'], 'signalling itself is untouched by the cap');
    // The transport treats a welcome without TURN as "STUN only", never as fatal.
    const t = new MeshTransport({ signaling: { join: async () => ({ ...k2, send() {}, leave() {} }) }, id: 'peerKEY02', RTCPeerConnection: class {} });
    const session = await t.start({ room });
    assert.equal(session.turn.reason, 'cap');
    assert.deepEqual(t.iceServers, DEFAULT_ICE_SERVERS);
    t.stop();
    a2.leave();
    k2.leave();
    srv.budget.setOverride(null);
    assert.equal((await fetch(`http://127.0.0.1:${srv.port}/`).then((r) => r.json())).turn, 'ok');
  });
});

test('dev server: a room expires after its lifetime — every peer gets `expired`, no reconnect', async () => {
  await withServer({ env: { ANON_ROOM_TTL: '1' } }, async (srv) => {
    const room = newRoomId();
    const ha = hooks('peerAAAA1');
    const hb = hooks('peerBBBB2');
    await dxrSignaling(srv.url).join(room, ha);
    await dxrSignaling(srv.url).join(room, hb);
    const t0 = Date.now();
    while (!(ha.events.length && hb.events.length)) {
      if (Date.now() - t0 > 4000) throw new Error('no expiry; ' + JSON.stringify([ha.events, hb.events]));
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.deepEqual(ha.events, [['disconnect', 'expired']]);
    assert.deepEqual(hb.events, [['disconnect', 'expired']]);
    assert.equal(srv.rooms.size, 0);
  });
});

// ── the adapter's alias failover (fake WebSocket) ────────────────────────────────────────────

class FakeWS {
  static urls = [];
  /** Hosts that refuse the socket (reset per case). */
  static dead = /dead/;
  constructor(url) {
    FakeWS.urls.push(url);
    this.readyState = 0;
    setTimeout(() => {
      if (FakeWS.dead.test(url)) {
        this.readyState = 3;
        this.onerror?.();
        this.onclose?.();
      } else {
        this.readyState = 1;
        this.onopen?.();
      }
    }, 0);
  }
  send(s) {
    const m = JSON.parse(s);
    if (m.t === 'join') setTimeout(() => this.onmessage?.({ data: JSON.stringify({ t: 'welcome', v: 1, id: m.id, peers: [], max: 4, tier: 'anon', turn: { status: 'off', reason: 'cap' } }) }), 0);
  }
  close() {
    this.readyState = 3;
  }
}

test('dxrSignaling: the hosted default fails over across DXR_SIGNAL_ALIASES; a custom URL takes `aliases`; one dead host alone is `signaling-unreachable`', async () => {
  const NEW = /^wss:\/\/signal\.displayxr\.org\/v1\/connect\?k=[0-9a-f]{64}$/;
  const OLD = /^wss:\/\/dxr-signal\.displayxr\.workers\.dev\/v1\/connect\?k=[0-9a-f]{64}$/;
  // The canonical host is the vanity domain (RFC 0003 §5g step 3); workers.dev is the fallback.
  assert.equal(DXR_SIGNAL_DEFAULT, 'wss://signal.displayxr.org');
  assert.deepEqual([...DXR_SIGNAL_ALIASES], ['wss://signal.displayxr.org', 'wss://dxr-signal.displayxr.workers.dev']);
  // Every session is left in `finally`: a failed assertion must not leave a ping timer that keeps
  // the test process alive.
  const live = [];
  const track = (x) => (live.push(x), x);
  try {
    // (a) Both hosts up: a default join opens ONE socket, to signal.displayxr.org.
    FakeWS.dead = /dead/;
    FakeWS.urls = [];
    let s = track(await dxrSignaling(undefined, { WebSocket: FakeWS }).join(newRoomId(), hooks('peerAAAA1')));
    assert.equal(FakeWS.urls.length, 1);
    assert.match(FakeWS.urls[0], NEW);
    assert.deepEqual(s.turn, { status: 'off', reason: 'cap' });
    s.leave();
    // (b) The new host is unreachable: the default fails over to the workers.dev host.
    FakeWS.dead = /dead|signal\.displayxr\.org/;
    FakeWS.urls = [];
    s = track(await dxrSignaling(undefined, { WebSocket: FakeWS }).join(newRoomId(), hooks('peerAAAA1')));
    assert.equal(FakeWS.urls.length, 2);
    assert.match(FakeWS.urls[0], NEW);
    assert.match(FakeWS.urls[1], OLD);
    s.leave();
    // (c) A page that names the OLD host (signaling="wss://dxr-signal.displayxr.workers.dev", with
    // or without a trailing slash) tries it first and still fails over to the new one.
    FakeWS.dead = /dead|workers\.dev/;
    FakeWS.urls = [];
    s = track(await dxrSignaling('wss://dxr-signal.displayxr.workers.dev/', { WebSocket: FakeWS }).join(newRoomId(), hooks('peerAAAA1')));
    assert.equal(FakeWS.urls.length, 2);
    assert.match(FakeWS.urls[0], OLD);
    assert.match(FakeWS.urls[1], NEW);
    s.leave();
    // ...and a page that names the NEW host explicitly fails over to the old one.
    FakeWS.dead = /dead|signal\.displayxr\.org/;
    FakeWS.urls = [];
    s = track(await dxrSignaling('wss://signal.displayxr.org', { WebSocket: FakeWS }).join(newRoomId(), hooks('peerAAAA1')));
    assert.equal(FakeWS.urls.length, 2);
    assert.match(FakeWS.urls[0], NEW);
    assert.match(FakeWS.urls[1], OLD);
    s.leave();
    // (d) A self-hosted URL gets no hosted aliases: only its own `aliases`, or nothing.
    FakeWS.dead = /dead/;
    FakeWS.urls = [];
    const c = track(await dxrSignaling('wss://dead.example/', { WebSocket: FakeWS, aliases: ['wss://alive.example'], key: 'pk_x' }).join(newRoomId(), hooks('peerAAAA1')));
    assert.equal(FakeWS.urls.length, 2);
    assert.match(FakeWS.urls[1], /^wss:\/\/alive\.example\/v1\/connect\?k=[0-9a-f]{64}&key=pk_x$/);
    c.leave();
    FakeWS.urls = [];
    await assert.rejects(dxrSignaling('wss://dead.example', { WebSocket: FakeWS }).join(newRoomId(), hooks('peerAAAA1')), (e) => e.code === 'signaling-unreachable');
    assert.equal(FakeWS.urls.length, 1, 'a self-hosted URL has no aliases to try');
    assert.ok(!FakeWS.urls.some((u) => /displayxr/.test(u)), 'no hosted alias is appended to a custom URL');
  } finally {
    FakeWS.dead = /dead/;
    for (const x of live) x.leave();
  }
});

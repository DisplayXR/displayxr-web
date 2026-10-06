#!/usr/bin/env node
// test/e2e/signal-staging.e2e.mjs — the C3 gate (RFC 0003 §7) against the STAGING Worker
// (signaling/deploy/staging.toml, wss://dxr-signal-staging.displayxr.workers.dev):
//
//   1. a join FLOOD (hundreds of sockets from this address) trips `rate-limited` — and the
//      service stays up: health is ok and a keyed join from the same address still works;
//   2. a FORCED 90 % budget trip degrades anonymous TURN only (keyed welcomes keep credentials);
//   3. a FORCED CAP trip refuses every new relay with `turn-cap` while a direct P2P call between
//      two stock-Chrome pages still connects (video flowing both ways);
//   4. (optional, E2E_RELAY=1 and a staging TURN secret) a forced relay over TLS 443 still
//      connects for a keyed page.
//
//   ADMIN_TOKEN=<staging admin secret> node test/e2e/signal-staging.e2e.mjs
//   SIGNAL_URL=wss://… FLOOD=300 CHROME=… PUPPETEER_CORE=<dir with node_modules/puppeteer-core>
//
// The forced trips use the Worker's /admin/usage override (an operator switch on the Budget
// object, never real usage) and clear it on exit; the keys it issues for the run are revoked on
// exit. Not part of `npm test` (network, a browser, ~2 min). Prints the numbers.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, join, extname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { newKeyId } from '../../signaling/keys.mjs';
import { roomKey } from '../../js/call/signaling.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SIGNAL = (process.env.SIGNAL_URL || 'wss://dxr-signal-staging.displayxr.workers.dev').replace(/\/+$/, '');
const HTTP = SIGNAL.replace(/^ws/, 'http');
const ADMIN = process.env.ADMIN_TOKEN || '';
const FLOOD = +(process.env.FLOOD || 300);
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const TIMEOUT_MS = +(process.env.E2E_TIMEOUT_MS || 60000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64url = (n) => randomBytes(n).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function admin(method, path, body) {
  const res = await fetch(`${HTTP}/admin/${path}`, { method, headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) throw new Error(`admin ${method} ${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

/** One raw dxr-signal/1 join: resolves with the first server message (+ the close code). */
function rawJoin(room, { key = '', origin, id = b64url(8), timeoutMs = 15000 } = {}) {
  return new Promise(async (resolve) => {
    const k = await roomKey(room);
    const url = `${SIGNAL}/v1/connect?k=${k}${key ? `&key=${key}` : ''}`;
    const t0 = Date.now();
    const out = { first: null, close: null, ms: 0, err: null };
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      out.ms = Date.now() - t0;
      resolve(out);
    };
    const timer = setTimeout(() => {
      out.err = 'timeout';
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      finish();
    }, timeoutMs);
    const ws = origin ? new WebSocket(url, { headers: { origin } }) : new WebSocket(url);
    ws.onopen = () => ws.send(JSON.stringify({ t: 'join', v: 1, room, id, max: 4 }));
    ws.onmessage = (ev) => {
      if (out.first) return;
      out.first = JSON.parse(String(ev.data));
      if (out.first.t === 'welcome') {
        clearTimeout(timer);
        ws.close(1000, 'done');
        finish();
      }
    };
    ws.onerror = () => {
      out.err = out.err || 'socket error';
    };
    ws.onclose = (ev) => {
      out.close = ev.code;
      clearTimeout(timer);
      finish();
    };
  });
}

// ── puppeteer-core + a static server (same as call-element.e2e.mjs) ────────────────────────
async function loadPuppeteer() {
  const candidates = [process.env.PUPPETEER_CORE, root, ...(process.env.PUPPETEER_CORE_PATHS || '').split(':')].filter(Boolean);
  for (const dir of candidates) {
    try {
      const req = createRequire(join(dir, 'package.json'));
      return (await import(pathToFileURL(req.resolve('puppeteer-core')).href)).default;
    } catch {
      /* next */
    }
  }
  throw new Error('puppeteer-core not found: PUPPETEER_CORE=<dir containing node_modules/puppeteer-core>');
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.css': 'text/css' };
function serve(pages) {
  const srv = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (pages[path]) return void res.writeHead(200, { 'content-type': TYPES['.html'], 'cache-control': 'no-store' }).end(pages[path]);
    const file = resolve(root, '.' + path);
    if (!file.startsWith(root)) return void res.writeHead(403).end();
    try {
      const st = await stat(file);
      if (!st.isFile()) throw new Error('dir');
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(await readFile(file));
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, url: `http://127.0.0.1:${srv.address().port}` })));
}
async function waitFor(page, fn, what, ms = TIMEOUT_MS) {
  const t0 = Date.now();
  for (;;) {
    const v = await page.evaluate(fn);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout (${ms} ms) waiting for: ${what}\nevents: ${JSON.stringify(await page.evaluate(() => window.__events.map((e) => [e.t, e.d]).slice(-12)))}`);
    await sleep(200);
  }
}

/** Two `<dxr-call>` pages in one headless Chrome over the staging server; returns what each saw. */
async function headlessCall({ key, relay = false }) {
  const puppeteer = await loadPuppeteer();
  const base = await readFile(resolve(root, 'test/e2e/element.html'), 'utf8');
  const relayShim = relay
    ? `<script>
  // Forced relay: every RTCPeerConnection is relay-only, and only TURN over TLS 443 is kept.
  (() => { const O = window.RTCPeerConnection; window.RTCPeerConnection = function (cfg) {
    const ice = (cfg && cfg.iceServers || []).map((s) => ({ ...s, urls: [].concat(s.urls).filter((u) => /^turns:.*:443/.test(u)) })).filter((s) => s.urls.length);
    return new O({ ...cfg, iceServers: ice, iceTransportPolicy: 'relay' });
  }; window.RTCPeerConnection.prototype = O.prototype; })();
</script>`
    : '';
  const page = base.replace('<dxr-call auto-join no-ui>', `<dxr-call auto-join no-ui signaling="${SIGNAL}" key="${key}">`).replace('</head>', `${relayShim}</head>`);
  const { srv, url } = await serve({ '/__staging.html': page });
  const room = b64url(16);
  const t0 = Date.now();
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--disable-gpu'],
  });
  const out = { room, pages: {} };
  try {
    const open = async (name) => {
      const ctx = await browser.createBrowserContext();
      const p = await ctx.newPage();
      p.on('pageerror', (e) => console.log(`  [${name}:pageerror] ${e.message}`));
      await p.goto(`${url}/__staging.html#room=${room}`, { waitUntil: 'load' });
      return p;
    };
    const A = await open('A');
    const B = await open('B');
    for (const [name, p] of [['A', A], ['B', B]]) {
      const st = await waitFor(p, () => (document.querySelector('dxr-call')?.call?.state === 'in-call' ? { id: document.querySelector('dxr-call').call.id } : null), `${name} in-call`);
      out.pages[name] = { id: st.id, joinedMs: Date.now() - t0 };
    }
    for (const [name, p] of [['A', A], ['B', B]]) {
      const peer = await waitFor(
        p,
        () => {
          const c = document.querySelector('dxr-call').call;
          const peer = c.peers[0];
          const q = peer && peer.quality && peer.quality.in;
          return peer && peer.state === 'connected' && q && q.fps > 0 ? { id: peer.id, fps: q.fps, w: q.width, h: q.height, codec: q.codec } : null;
        },
        `${name}: peer connected with inbound video`
      );
      out.pages[name].peer = peer;
      out.pages[name].connectedMs = Date.now() - t0;
      out.pages[name].errors = await p.evaluate(() => window.__events.filter((e) => e.t === 'error' || e.t === 'warning').map((e) => `${e.t}:${e.d && e.d.code}`));
      if (relay) {
        out.pages[name].candidatePair = await p.evaluate(async () => {
          const pc = document.querySelector('dxr-call').call.transport?.peerConnection?.(document.querySelector('dxr-call').call.peers[0].id);
          if (!pc) return null;
          const stats = await pc.getStats();
          let pair = null;
          stats.forEach((s) => {
            if (s.type === 'candidate-pair' && s.state === 'succeeded' && (s.nominated || s.selected)) pair = s;
          });
          if (!pair) return null;
          const local = stats.get(pair.localCandidateId);
          const remote = stats.get(pair.remoteCandidateId);
          return { local: local && local.candidateType, remote: remote && remote.candidateType, protocol: local && local.relayProtocol };
        });
      }
    }
    await A.evaluate(() => document.querySelector('dxr-call').remove());
    await B.evaluate(() => document.querySelector('dxr-call').remove());
    await sleep(300);
  } finally {
    await browser.close().catch(() => {});
    srv.close();
  }
  return out;
}

async function main() {
  const report = { signal: SIGNAL };
  const health = await (await fetch(`${HTTP}/`)).json();
  if (!health.ok) throw new Error('staging health not ok');
  report.health = health;
  console.log(`gate: ${SIGNAL} health ${JSON.stringify(health)}`);
  if (!ADMIN) throw new Error('ADMIN_TOKEN is required (the staging Worker\'s admin secret)');
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}`);

  const keyAny = newKeyId(); // for Node (no Origin): any origin
  const keyPage = newKeyId(); // for the headless pages served from http://127.0.0.1:<port>
  await admin('PUT', `keys/${keyAny}`, { origins: ['*'], note: 'c3 gate run (node)' });
  await admin('PUT', `keys/${keyPage}`, { origins: ['http://127.0.0.1'], note: 'c3 gate run (pages)' });
  await admin('POST', 'usage', { overrideGB: null });
  const cleanup = async () => {
    await admin('POST', 'usage', { overrideGB: null }).catch(() => {});
    await admin('DELETE', `keys/${keyAny}`).catch(() => {});
    await admin('DELETE', `keys/${keyPage}`).catch(() => {});
  };
  try {
    await sleep(2000); // KV: the new keys propagate

    // ── 1. join flood ─────────────────────────────────────────────────────────────────────
    console.log(`gate 1: flooding ${FLOOD} anonymous joins into one room…`);
    const room = b64url(16);
    const t0 = Date.now();
    const results = [];
    for (let i = 0; i < FLOOD; i += 50) results.push(...(await Promise.all(Array.from({ length: Math.min(50, FLOOD - i) }, () => rawJoin(room)))));
    const floodMs = Date.now() - t0;
    const codes = {};
    for (const r of results) {
      const c = r.err ? `ERR:${r.err}` : r.first ? (r.first.t === 'error' ? `${r.first.code}/${r.close}` : `${r.first.t}/${r.close}`) : `none/${r.close}`;
      codes[c] = (codes[c] || 0) + 1;
    }
    const rateLimited = results.filter((r) => r.first && r.first.code === 'rate-limited').length;
    const errors = results.filter((r) => r.err).length;
    const retryMs = results.find((r) => r.first && r.first.code === 'rate-limited')?.first.retryMs;
    const p95 = results.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(results.length * 0.95)];
    report.flood = { sockets: FLOOD, ms: floodMs, codes, rateLimited, errors, retryMs, p95Ms: p95 };
    console.log(`gate 1: ${JSON.stringify(report.flood)}`);
    if (errors) throw new Error(`flood: ${errors} sockets errored/timed out — that is an outage, not a refusal`);
    // A dual-stack client may reach the Worker from its IPv4 AND its IPv6 address — two per-IP
    // meters, so up to 2 × joinsPerMin get through before the refusals start.
    const admitted = 2 * health.limits.anon.joinsPerMin;
    if (rateLimited < FLOOD - admitted - 5) throw new Error(`flood: only ${rateLimited} rate-limited (expected ≥ ${FLOOD - admitted - 5})`);
    const h2 = await (await fetch(`${HTTP}/`)).json();
    if (!h2.ok) throw new Error('health not ok after the flood');
    const keyedAfter = await rawJoin(b64url(16), { key: keyAny });
    report.flood.keyedJoinAfter = keyedAfter.first && keyedAfter.first.t;
    console.log(`gate 1: health ok after the flood; keyed join from the same address → ${report.flood.keyedJoinAfter} (tier ${keyedAfter.first?.tier}, turn ${JSON.stringify(keyedAfter.first?.turn)})`);
    if (keyedAfter.first?.t !== 'welcome') throw new Error('a keyed join from the flooded address should still work');

    // ── 2. forced 90 % ────────────────────────────────────────────────────────────────────
    const snap = await admin('GET', 'usage');
    const budget = snap.budgetGB;
    await admin('POST', 'usage', { overrideGB: 0.95 * budget });
    await sleep(20000); // the Worker caches the budget snapshot per isolate for 15 s
    // The anonymous join windows from this address are hot after the flood (a window starts at
    // its subject's FIRST hit, which for a second address may be late in the flood): wait them out.
    const anonWait = Math.max(0, 62000 - (Date.now() - (t0 + floodMs)));
    if (anonWait) {
      console.log(`gate 2: waiting ${Math.ceil(anonWait / 1000)} s for this address's anonymous join window…`);
      await sleep(anonWait);
    }
    const a90 = await rawJoin(b64url(16));
    const k90 = await rawJoin(b64url(16), { key: keyAny });
    report.at90 = { usedGB: 0.95 * budget, anon: { turn: a90.first?.turn, ice: !!a90.first?.iceServers }, keyed: { turn: k90.first?.turn, ice: !!k90.first?.iceServers }, health: (await (await fetch(`${HTTP}/`)).json()).turn };
    console.log(`gate 2: ${JSON.stringify(report.at90)}`);
    if (a90.first?.t !== 'welcome' || a90.first.iceServers || a90.first.turn?.reason !== 'budget') throw new Error(`90%: anonymous should join without TURN (reason budget); got ${JSON.stringify(a90.first)}`);
    if (k90.first?.t !== 'welcome' || !k90.first.iceServers || k90.first.turn?.status !== 'degraded') throw new Error('90%: keyed should keep TURN (degraded)');

    // ── 3. forced cap + a direct P2P call ────────────────────────────────────────────────
    await admin('POST', 'usage', { overrideGB: budget + 1 });
    await sleep(20000);
    const aCap = await rawJoin(b64url(16));
    const kCap = await rawJoin(b64url(16), { key: keyAny });
    report.atCap = { usedGB: budget + 1, anon: { turn: aCap.first?.turn, ice: !!aCap.first?.iceServers }, keyed: { turn: kCap.first?.turn, ice: !!kCap.first?.iceServers }, health: (await (await fetch(`${HTTP}/`)).json()).turn };
    console.log(`gate 3: ${JSON.stringify(report.atCap)}`);
    if (aCap.first?.turn?.reason !== 'cap' || kCap.first?.turn?.reason !== 'cap' || kCap.first.iceServers) throw new Error('cap: every new relay should be refused (reason cap)');
    console.log('gate 3: headless P2P call (two stock-Chrome pages, keyed) under the cap…');
    const call = await headlessCall({ key: keyPage });
    report.atCap.call = call;
    console.log(`gate 3: ${JSON.stringify(call)}`);
    for (const n of ['A', 'B']) {
      if (!call.pages[n].errors.includes('error:turn-cap')) throw new Error(`${n}: no turn-cap error event under the cap`);
      if (!(call.pages[n].peer && call.pages[n].peer.fps > 0)) throw new Error(`${n}: no inbound video`);
    }
    await admin('POST', 'usage', { overrideGB: null });
    await sleep(20000);
    const back = await rawJoin(b64url(16), { key: keyAny });
    report.cleared = { keyed: { turn: back.first?.turn, ice: !!back.first?.iceServers } };
    console.log(`gate 3: override cleared → keyed ${JSON.stringify(report.cleared.keyed)}`);

    // ── 4. forced relay over TLS 443 (needs real TURN on staging) ────────────────────────
    if (process.env.E2E_RELAY === '1') {
      if (health.turnFake || health.turn === 'unconfigured') {
        report.relay = 'skipped: staging has no real TURN (TURN_KEY_API_TOKEN not set)';
        console.log(`gate 4: ${report.relay}`);
      } else {
        const r = await headlessCall({ key: keyPage, relay: true });
        report.relay = r;
        console.log(`gate 4: forced relay ${JSON.stringify(r)}`);
        for (const n of ['A', 'B']) if (r.pages[n].candidatePair?.local !== 'relay') throw new Error(`${n}: selected pair is not relayed`);
      }
    } else report.relay = 'not run (E2E_RELAY=1 to run; needs a staging TURN secret)';
    console.log(`gate: PASS ${JSON.stringify(report)}`);
  } finally {
    await cleanup();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`gate: FAIL — ${err.message}`);
    process.exit(1);
  }
);

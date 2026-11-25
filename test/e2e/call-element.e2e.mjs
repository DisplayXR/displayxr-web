#!/usr/bin/env node
// test/e2e/call-element.e2e.mjs — the C1 gate's headless end-to-end run (RFC 0003 §7):
// `<dxr-call>` in stock Chrome ↔ `<dxr-call>` in stock Chrome over the HOSTED signalling server.
//
//   npm run test:e2e
//
// Page A loads the element from the SOURCE files (import map), page B from the CDN BUNDLE
// (dist/call.js, built first if missing), in two isolated browser contexts of one headless Chrome
// with a fake camera + mic. Both are plain `<dxr-call auto-join no-ui>` opened on the same
// invite link (`#room=`). Pass = both join, each sees the other connected with video flowing
// (inbound fps > 0 on the quality event), then A's element is removed from the DOM and B sees
// `peerleft`. Stock Chrome has no inline 3D, so both walls are 2D — this proves the element, the
// bundle, the transport and the hosted server; the woven path needs a panel run.
//
// Needs: Chrome (CHROME env, default the macOS app path) and puppeteer-core (PUPPETEER_CORE env =
// a directory containing it, else resolved from this repo, else a few known scratch paths). It
// is NOT part of `npm test`: it needs a browser, the network and ~20 s.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, join, extname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const TIMEOUT_MS = +(process.env.E2E_TIMEOUT_MS || 45000);

// ── puppeteer-core ──────────────────────────────────────────────────────────────────────────
async function loadPuppeteer() {
  const candidates = [process.env.PUPPETEER_CORE, root, ...(process.env.PUPPETEER_CORE_PATHS || '').split(':')].filter(Boolean);
  for (const dir of candidates) {
    try {
      const req = createRequire(join(dir, 'package.json'));
      const p = req.resolve('puppeteer-core');
      return (await import(pathToFileURL(p).href)).default;
    } catch {
      /* next */
    }
  }
  throw new Error('puppeteer-core not found: `npm i --no-save puppeteer-core`, or PUPPETEER_CORE=<dir containing node_modules/puppeteer-core>');
}

// ── a static server for the repo root ─────────────────────────────────────────────────────
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.css': 'text/css' };
function serve() {
  const srv = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64url = (n) => randomBytes(n).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function waitFor(page, fn, what, ms = TIMEOUT_MS) {
  const t0 = Date.now();
  for (;;) {
    const v = await page.evaluate(fn);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout (${ms} ms) waiting for: ${what}\nevents: ${JSON.stringify(await page.evaluate(() => window.__events.map((e) => [e.t, e.d]).slice(-12)))}`);
    await sleep(200);
  }
}

async function main() {
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME} (set CHROME)`);
  // Always rebuilt (50 ms): page B must run THIS checkout's bundle, never a stale one.
  execFileSync(process.execPath, [resolve(root, 'tools/dist/build.mjs')], { stdio: 'inherit' });
  const puppeteer = await loadPuppeteer();
  const { srv, url } = await serve();
  const room = b64url(16);
  const t0 = Date.now();
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--disable-gpu'],
  });
  const result = { room, url, pages: {} };
  try {
    const open = async (name, file) => {
      const ctx = await browser.createBrowserContext();
      const page = await ctx.newPage();
      page.on('console', (m) => {
        const txt = m.text();
        if (/inline3d|dxr-call|error/i.test(txt)) console.log(`  [${name}:${m.type()}] ${txt.slice(0, 200)}`);
      });
      page.on('pageerror', (e) => console.log(`  [${name}:pageerror] ${e.message}`));
      await page.goto(`${url}/test/e2e/${file}#room=${room}`, { waitUntil: 'load' });
      return { ctx, page };
    };
    const a = await open('A/src', 'element.html');
    const b = await open('B/dist', 'element-dist.html');

    // Both mounted (auto-join → straight into the call).
    for (const [name, p] of [['A', a.page], ['B', b.page]]) {
      const st = await waitFor(p, () => (document.querySelector('dxr-call')?.call?.state === 'in-call' ? { id: document.querySelector('dxr-call').call.id, room: document.querySelector('dxr-call').call.room } : null), `${name} in-call`);
      if (st.room !== room) throw new Error(`${name}: joined room ${st.room}, expected ${room} (invite fragment)`);
      result.pages[name] = { id: st.id, joinedMs: Date.now() - t0 };
      console.log(`e2e: ${name} in-call as ${st.id} after ${result.pages[name].joinedMs} ms`);
    }
    // Each sees the other connected, with inbound video flowing (quality events carry fps).
    for (const [name, p] of [['A', a.page], ['B', b.page]]) {
      const peer = await waitFor(
        p,
        () => {
          const c = document.querySelector('dxr-call').call;
          const peer = c.diagnostics().peers[0]; // route + quality are diagnostics since C2
          const q = peer && peer.quality && peer.quality.in;
          return peer && peer.state === 'connected' && q && q.fps > 0 ? { id: peer.id, state: peer.state, fps: q.fps, w: q.width, h: q.height, codec: q.codec, route: peer.route, format: peer.format, display: peer.display } : null;
        },
        `${name}: peer connected with inbound video`
      );
      result.pages[name].peer = peer;
      result.pages[name].connectedMs = Date.now() - t0;
      console.log(`e2e: ${name} sees ${peer.id} ${peer.state}, ${peer.w}x${peer.h}@${peer.fps} ${peer.codec} route=${peer.route} after ${result.pages[name].connectedMs} ms`);
    }
    if (result.pages.A.peer.id !== result.pages.B.id || result.pages.B.peer.id !== result.pages.A.id) throw new Error('the peers are not each other');
    // The DOM event path, at the document (bubbling): ready, joined, peer, state, quality.
    for (const [name, p] of [['A', a.page], ['B', b.page]]) {
      const ev = await p.evaluate(() => window.__events.map((e) => e.t));
      for (const need of ['ready', 'joined', 'peer', 'state', 'quality']) if (!ev.includes(need)) throw new Error(`${name}: no dxr-call:${need} DOM event; got ${ev.join(',')}`);
      result.pages[name].events = ev;
    }
    // disconnect = leave: A's element leaves the DOM → its call is 'left' (the element's own
    // `dxr-call:left` fires on the element, which is out of the tree by then, so it is observed
    // there rather than at the document), and B sees peerleft.
    await a.page.evaluate(() => {
      window.__a = document.querySelector('dxr-call');
      window.__aHandle = window.__a.call;
      window.__aLeft = [];
      window.__a.addEventListener('dxr-call:left', (e) => window.__aLeft.push(e.detail));
      window.__a.remove();
    });
    const aState = await waitFor(a.page, () => (window.__aHandle.state === 'left' && !window.__a.call && window.__aLeft.length === 1 ? 'left (handle state, el.call null, dxr-call:left on the element)' : null), 'A left after removal');
    const gone = await waitFor(b.page, () => (window.__events.some((e) => e.t === 'peerleft') ? window.__events.find((e) => e.t === 'peerleft').d : null), 'B sees peerleft');
    console.log(`e2e: A removed from the DOM → A ${aState}, B peerleft ${JSON.stringify(gone)} after ${Date.now() - t0} ms`);
    result.totalMs = Date.now() - t0;
    console.log(`e2e: PASS in ${result.totalMs} ms — ${JSON.stringify({ room, A: result.pages.A.peer, B: result.pages.B.peer })}`);
    await b.page.evaluate(() => document.querySelector('dxr-call').remove());
    await sleep(300);
  } finally {
    await browser.close().catch(() => {});
    srv.close();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`e2e: FAIL — ${err.message}`);
    process.exit(1);
  }
);

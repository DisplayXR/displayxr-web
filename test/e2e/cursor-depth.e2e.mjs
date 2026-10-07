#!/usr/bin/env node
// test/e2e/cursor-depth.e2e.mjs — `cursor: 'depth'` on the REAL viewers, headless:
//
//   npm run test:e2e:cursor
//
// Runs test/e2e/cursor-depth/ for ./model and ./splat on both engines. Each run hands the real
// viewer two hand-built off-axis views (what the DisplayXR Browser hands addScene) and a scripted
// pointer. Pass =
//   model (a unit cube): over the cube the crosshair's disparity is the cube front's minus the
//     margin (in front of it, by exactly the policy), and off it the crosshair is on the glass;
//   splat (butterfly.sog; 'three' = the Spark engine): over the subject the crosshair is in front of the glass, off it on it;
//   both: the CSS cursor is hidden while the crosshair shows and restored on pointerleave, and the
//     crosshair draws with depth test off.
// Stock Chrome has no inline 3D: this proves the hit test and the placement, not the weave — that
// needs a panel (samples/model/?cursor=depth, samples/splat/?cursor=depth).
//
// Needs: Chrome (CHROME env, default the macOS app path) with a GPU (ANGLE/Metal on macOS) and
// puppeteer-core (`npm i --no-save puppeteer-core`, or PUPPETEER_CORE=<dir>). Not part of `npm test`.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, join, extname } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const TIMEOUT_MS = +(process.env.E2E_TIMEOUT_MS || 90000);
const CASES = [
  { engine: 'playcanvas', kind: 'model' },
  { engine: 'three', kind: 'model' },
  { engine: 'playcanvas', kind: 'splat' },
  { engine: 'three', kind: 'splat' },
];

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
  throw new Error('puppeteer-core not found: `npm i --no-save puppeteer-core`, or PUPPETEER_CORE=<dir containing node_modules/puppeteer-core>');
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.gltf': 'model/gltf+json' };
function serve() {
  const srv = createServer(async (req, res) => {
    const file = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!file.startsWith(root)) return void res.writeHead(403).end();
    try {
      let f = file;
      if ((await stat(f)).isDirectory()) f = join(f, 'index.html');
      res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(await readFile(f));
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, url: `http://127.0.0.1:${srv.address().port}` })));
}

async function main() {
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME} (set CHROME)`);
  const only = process.argv.slice(2);
  const puppeteer = await loadPuppeteer();
  const { srv, url } = await serve();
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-first-run', '--enable-gpu', '--ignore-gpu-blocklist', ...(process.platform === 'darwin' ? ['--use-angle=metal'] : [])],
  });
  const results = [];
  try {
    for (const c of CASES) {
      if (only.length && !only.includes(`${c.engine}/${c.kind}`)) continue;
      const page = await browser.newPage();
      page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
      page.on('console', (m) => /inline3d|Uncaught/i.test(m.text()) && console.log(`  [page:${m.type()}] ${m.text().slice(0, 200)}`));
      const t0 = Date.now();
      await page.goto(`${url}/test/e2e/cursor-depth/?engine=${c.engine}&kind=${c.kind}&settle=90`, { waitUntil: 'load' });
      await page.waitForFunction(() => !document.getElementById('out').textContent.startsWith('running'), { timeout: TIMEOUT_MS, polling: 250 });
      const r = JSON.parse(await page.evaluate(() => document.getElementById('out').textContent));
      await page.close();
      const tag = `${c.engine}/${c.kind}`;
      const fmt = (x) => (x === null || x === undefined ? 'null' : x.toFixed(4));
      console.log(`e2e: ${tag} ${r.pass ? 'PASS' : 'FAIL'} in ${Date.now() - t0} ms — over: cursor ${fmt(r.over?.cursorDisparity)}` +
        `${r.over?.cubeFrontDisparity !== null && r.over?.cubeFrontDisparity !== undefined ? ` (front ${fmt(r.over.cubeFrontDisparity)})` : ''}, off: ${fmt(r.off?.cursorDisparity)}` +
        `${r.error ? ` — ${r.error}` : ''}`);
      results.push(!!r.pass);
    }
  } finally {
    await browser.close().catch(() => {});
    srv.close();
  }
  if (!results.length || results.some((p) => !p)) throw new Error('cursor: depth e2e failed');
  console.log('e2e: PASS');
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`e2e: FAIL — ${err.message}`);
    process.exit(1);
  },
);

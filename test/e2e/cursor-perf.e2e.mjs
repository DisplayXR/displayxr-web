#!/usr/bin/env node
// test/e2e/cursor-perf.e2e.mjs — what the depth cursor COSTS a frame, headless, on a heavy glTF:
//
//   npm run test:e2e:cursor-perf                 # Khronos CarConcept (213k triangles, 97 meshes)
//   npm run test:e2e:cursor-perf -- --glb=<url>  # any other model
//   CURSOR_PERF_SECONDS=10 npm run test:e2e:cursor-perf
//   npm run test:e2e:cursor-perf -- --noraw        # A/B: hide pointerrawupdate (pointermove only)
//
// Opens test/e2e/cursor-perf/ (the REAL ./model three.js viewer with `cursor: { debug: true }`, a
// fake wall, two off-axis views a frame from requestAnimationFrame), moves the REAL mouse in a
// circle over the canvas (so Chrome fires its own pointermove / pointerrawupdate), and prints the
// cursor's own rolling stats: update() ms, rays a frame, frame interval, pointer-sample age. Then a
// parity pass: the cursor's hit test against three's plain raycast on 400 rays.
//
// A measurement, not a gate: it fails only when the page breaks or the parity check disagrees.
// Real time, one Chrome (puppeteer-core; CHROME env, default the macOS app), closed on exit.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, join, extname } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SECONDS = +(process.env.CURSOR_PERF_SECONDS || 6);
const glbArg = process.argv.find((a) => a.startsWith('--glb='));
const GLB = glbArg ? glbArg.slice(6) : '';

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

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json' };
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

const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : 'n/a');
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};

async function main() {
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME} (set CHROME)`);
  const puppeteer = await loadPuppeteer();
  const { srv, url } = await serve();
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-first-run', '--enable-gpu', '--ignore-gpu-blocklist', ...(process.platform === 'darwin' ? ['--use-angle=metal'] : [])],
  });
  const pid = browser.process()?.pid;
  let failed = null;
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 700 });
    page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
    page.on('console', (m) => /inline3d/i.test(m.text()) && console.log(`  [page] ${m.text().slice(0, 260)}`));
    const q = `?parity=1${GLB ? `&glb=${encodeURIComponent(GLB)}` : ''}${process.argv.includes('--noraw') ? '&noraw=1' : ''}`;
    await page.goto(`${url}/test/e2e/cursor-perf/${q}`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__perf && window.__perf.state !== 'loading', { timeout: 120000, polling: 250 });
    let perf = await page.evaluate(() => window.__perf);
    if (perf.state === 'error') throw new Error(perf.error);
    console.log(`model: ${perf.model.url.split('/').pop()} — ${perf.model.triangles.toLocaleString()} triangles, ${perf.model.meshes} meshes; raysPerFrame ${perf.raysPerFrame}`);
    await page.waitForFunction(() => window.__perf.state === 'ready', { timeout: 120000, polling: 250 });
    perf = await page.evaluate(() => window.__perf);
    if (perf.parity) {
      const p = perf.parity;
      console.log(`parity: ${p.rays} rays — ${p.hits} hits, ${p.misses} misses, ${p.mismatch} mismatches (worst ${p.worstErr.toExponential(1)} m); ` +
        `plain ${f(p.plainMsPerRay, 3)} ms/ray, cursor's ${f(p.fastMsPerRay, 3)} ms/ray (bvh ${p.bvh})`);
      if (p.mismatch > 0) failed = `parity: ${p.mismatch} rays disagree`;
    }
    // The canvas is at (0, 0) 800 × 600 CSS px: a circle over its middle, one turn a second.
    await page.mouse.move(400, 300);
    await new Promise((r) => setTimeout(r, 1500)); // warm-up: first picks (and any lazy BVH builds)
    const skip = await page.evaluate(() => window.__perfCursor.debugStats.history.length);
    // Input at ~500 Hz like a gaming mouse: CDP mouse events fired without awaiting each one
    // (page.mouse.move awaits a round trip, which caps the rate at about one per frame).
    const cdp = await page.createCDPSession();
    const t0 = Date.now();
    await new Promise((done) => {
      const timer = setInterval(() => {
        const el = Date.now() - t0;
        if (el >= SECONDS * 1000) return void (clearInterval(timer), done());
        const a = (el / 1000) * 2 * Math.PI;
        cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 400 + 160 * Math.cos(a), y: 300 + 140 * Math.sin(a) }).catch(() => {});
      }, 2);
    });
    const hist = await page.evaluate(() => {
      const c = document.querySelector('canvas') && window.__perf && window.__perfCursor;
      return c ? c.debugStats.history : null;
    });
    const h = (hist || []).slice(skip + 1); // only whole seconds of steady motion
    if (!h.length) throw new Error('no debug stats — is the cursor running?');
    const pick = (k, s) => h.map((x) => x[k][s]);
    console.log(`update(): ${f(median(pick('updateMs', 'mean')), 3)} ms mean · ${f(median(pick('updateMs', 'p95')), 3)} p95 · ${f(Math.max(...pick('updateMs', 'max')), 3)} max ` +
      `(median of ${h.length} one-second windows; max over all)`);
    console.log(`rays/frame: ${f(median(pick('rays', 'mean')), 1)} · frame interval ${f(median(pick('frameMs', 'mean')), 1)} ms mean, ${f(median(pick('frameMs', 'p95')), 1)} p95, ${f(Math.max(...pick('frameMs', 'max')), 1)} max`);
    console.log(`pointer: ${h[0].pointerSource || '?'} · ${f(median(h.map((x) => x.samplesPerFrame)), 1)} samples/frame · age at use ${f(median(pick('pointerAgeMs', 'mean')), 1)} ms mean`);
    console.log(`JSON ${JSON.stringify({ model: perf.model, raysPerFrame: perf.raysPerFrame, parity: perf.parity, history: h })}`);
  } finally {
    await browser.close().catch(() => {});
    if (pid) {
      try {
        process.kill(pid, 0);
        process.kill(pid, 'SIGKILL'); // still alive after close(): ours, so ours to end
      } catch {
        /* gone */
      }
    }
    srv.close();
  }
  if (failed) throw new Error(failed);
  console.log('cursor-perf: done');
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`cursor-perf: FAIL — ${err.message}`);
    process.exit(1);
  },
);

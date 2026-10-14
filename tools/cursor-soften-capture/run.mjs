#!/usr/bin/env node
// tools/cursor-soften-capture/run.mjs — headless pixel evidence for the depth cursor's crosstalk
// softening (runtime ADR-046 Amendment 2 §B.7) on the REAL sample pages.
//
//   node tools/cursor-soften-capture/run.mjs [outDir] [sample ...]     # samples: hello-cube model splat
//
// Stock Chrome has no inline-3d session, so a sample would run flat (one view: no depth cursor by
// design). This serves the repo with `@displayxr/inline3d`'s createInline3D swapped for a fake wall
// that hands each addScene two off-axis views (the runtime's display rig: 64 mm IPD, 0.6 m, the
// canvas = virtualDisplayHeight at z = 0) on a controlled clock — everything else is the page's own
// code. Per sample and preset (?cursor=depth&soften=off|alpha|blur|both) the pointer is pinned
// over content (lifted) and over the background (on the glass); at a frozen instant the SBS buffer
// is read with the cursor, then again with the pointer gone (same instant = same content), and the
// difference is the cursor. Reported per eye: touched px, peak luminance, max horizontal edge step
// inside the cursor, and the arrow tip (the hotspot) pixel.
//
// ONE headless Chrome (ANGLE Metal on macOS, DPR 1 or $DPR), closed on exit. Needs puppeteer-core
// (PUPPETEER_CORE=<dir with node_modules/puppeteer-core>, or on the resolve path) and network
// access for the samples' CDN imports (three, PlayCanvas, Spark).

import { createServer } from 'node:http';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, join, extname } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = resolve(process.argv[2] || 'cursor-soften-out');
const ONLY = process.argv.slice(3);
const PRESETS = ['off', 'alpha', 'blur', 'both'];
const DPR = +(process.env.DPR || 1); // device pixel ratio (a Leia panel is ~2)
// Pointer spots (page-relative to the sampled canvas): over content, and over background.
const SAMPLES = [
  { name: 'hello-cube', path: 'samples/hello-cube/', canvas: 'canvas', over: [0.5, 0.5], glass: [0.06, 0.08] },
  // The idle turntable orbits the RIG, so a world-fixed ('hybrid' while still) cursor travels with
  // the content under a still pointer: pin these with anchor=screen to keep the tip on the pointer.
  { name: 'model', path: 'samples/model/', query: '&anchor=screen', canvas: '#tileA', over: [0.5, 0.45], glass: [0.06, 0.08] },
  { name: 'splat', path: 'samples/splat/', query: '&anchor=screen', canvas: 'canvas', over: [0.5, 0.5], glass: [0.04, 0.06] },
].filter((s) => !ONLY.length || ONLY.includes(s.name));

async function loadPuppeteer() {
  for (const dir of [process.env.PUPPETEER_CORE, root, process.cwd()].filter(Boolean)) {
    try {
      return (await import(pathToFileURL(createRequire(join(dir, 'package.json')).resolve('puppeteer-core')).href)).default;
    } catch {
      /* next */
    }
  }
  throw new Error('puppeteer-core not found (npm i --no-save puppeteer-core, or PUPPETEER_CORE=<dir>)');
}

// The swap: /js/inline3d.js is this shim; the real module is /js/inline3d.js?real.
const SHIM = `export * from './inline3d.js?real';
export async function createInline3D() { return globalThis.__cap.wall; }
export function startInline3D() { throw new Error('cursor-soften-capture: startInline3D not faked'); }
`;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.css': 'text/css' };
function serve() {
  const srv = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/js/inline3d.js' && !u.searchParams.has('real')) {
      res.writeHead(200, { 'content-type': TYPES['.js'], 'cache-control': 'no-store' });
      return void res.end(SHIM);
    }
    const file = resolve(root, '.' + decodeURIComponent(u.pathname));
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

// Runs in the page before any of its scripts: the fake wall, the clock, the capture.
function pageHooks() {
  const cap = (globalThis.__cap = { t: 1000, frozen: false, scenes: [], shot: null });
  performance.now = () => cap.t;
  const kooima = (W, H, ex, ey, ez) => {
    const l = (-W / 2 - ex) / ez, r = (W / 2 - ex) / ez, u = (H / 2 - ey) / ez, d = (-H / 2 - ey) / ez;
    const n = 0.01, f = 100;
    return {
      projectionMatrix: new Float32Array([2 / (r - l), 0, 0, 0, 0, 2 / (u - d), 0, 0, (r + l) / (r - l), (u + d) / (u - d), -(f + n) / (f - n), -1, 0, 0, (-2 * f * n) / (f - n), 0]),
      transform: { matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, ex, ey, ez, 1]) },
    };
  };
  cap.wall = {
    supported: true,
    addScene(canvas, cb, opts = {}) {
      const scene = { canvas, cb, vH: opts.virtualDisplayHeight || 0.24 };
      scene.views = () => {
        const r = canvas.getBoundingClientRect();
        const aspect = r.height > 0 ? r.width / r.height : 1;
        const s = scene.vH / ((r.height || 400) * 0.0254 / 96); // virtual m per physical m (96-dpi panel)
        const W = scene.vH * aspect;
        return [kooima(W, scene.vH, -0.032 * s, 0, 0.6 * s), kooima(W, scene.vH, 0.032 * s, 0, 0.6 * s)];
      };
      scene.tick = () => {
        const views = scene.views();
        const layer = { getViewport: (v) => ({ x: views.indexOf(v) * (canvas.width / 2), y: 0, width: canvas.width / 2, height: canvas.height }) };
        cb(views, layer, null);
      };
      cap.scenes.push(scene);
      return new Proxy({ firstWoven: new Promise(() => {}), ready: Promise.resolve() }, { get: (t, k) => (k in t ? t[k] : () => {}) });
    },
  };
  // One shared timer drives every scene (rAF is throttled headless); a capture happens in the SAME
  // task as the frame that drew it, so no preserveDrawingBuffer is needed.
  setInterval(() => {
    if (!cap.frozen) cap.t += 16;
    // A real pointer keeps reporting; and the cursor module loads asynchronously on opt-in, so a
    // single early event can land before anything listens.
    if (cap.pinning && cap.pin) cap.pin();
    for (const s of cap.scenes) {
      try {
        s.tick();
      } catch (e) {
        cap.error = String(e && e.stack || e);
      }
      if (cap.want && cap.want.canvas === s.canvas) {
        cap.want.png = s.canvas.toDataURL('image/png');
        cap.want.w = s.canvas.width;
        cap.want.h = s.canvas.height;
        cap.want.done = true;
        cap.want = null;
      }
    }
  }, 16);
}

// In the page: decode two PNGs of the SBS buffer, diff, measure per eye.
async function measure(aPng, bPng) {
  const load = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
  const [A, B] = await Promise.all([load(aPng), load(bPng)]);
  const W = A.width, H = A.height;
  // Composited over black, as a transparent canvas is over a dark page: the alpha must count.
  const px = (img) => { const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, W, H); g.drawImage(img, 0, 0); return g.getImageData(0, 0, W, H).data; };
  const a = px(A), b = px(B);
  const L = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  const eyes = [];
  for (const e of [0, 1]) {
    const x0 = e * (W / 2), x1 = x0 + W / 2;
    const mask = new Uint8Array(W * H);
    let n = 0, peak = 0, bx0 = W, by0 = H, bx1 = -1, by1 = -1, tip = null;
    for (let y = 0; y < H; y++) for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 4;
      if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2])) > 3) {
        mask[y * W + x] = 1;
        n++;
        peak = Math.max(peak, L(a, i));
        if (x < bx0) bx0 = x;
        if (x > bx1) bx1 = x;
        if (y < by0) by0 = y;
        if (y > by1) by1 = y;
        if (!tip) tip = [x - x0, y]; // topmost row first, leftmost in it
      }
    }
    let step = 0, stepBg = 0;
    for (let y = 0; y < H; y++) for (let x = x0; x + 1 < x1; x++) {
      if (!mask[y * W + x] && !mask[y * W + x + 1]) continue;
      const i = (y * W + x) * 4;
      step = Math.max(step, Math.abs(L(a, i + 4) - L(a, i)));
      stepBg = Math.max(stepBg, Math.abs(L(b, i + 4) - L(b, i)));
    }
    let crop = null;
    if (n) {
      const pad = 6, cx0 = Math.max(x0, bx0 - pad), cy0 = Math.max(0, by0 - pad), cw = Math.min(x1, bx1 + pad + 1) - cx0, ch = Math.min(H, by1 + pad + 1) - cy0;
      const c = document.createElement('canvas'); c.width = cw * 6; c.height = ch * 6;
      const g = c.getContext('2d'); g.imageSmoothingEnabled = false; g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height); g.drawImage(A, cx0, cy0, cw, ch, 0, 0, cw * 6, ch * 6);
      crop = c.toDataURL('image/png');
    }
    eyes.push({ touched: n, peakL: Math.round(peak), maxEdgeStep: Math.round(step), bgEdgeStep: Math.round(stepBg), bbox: n ? [bx0 - x0, by0, bx1 - x0, by1] : null, tip, crop });
  }
  return { W, H, eyes };
}

async function main() {
  const puppeteer = await loadPuppeteer();
  const { srv, url } = await serve();
  await mkdir(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-first-run', '--enable-gpu', '--ignore-gpu-blocklist', `--force-device-scale-factor=${DPR}`, ...(process.platform === 'darwin' ? ['--use-angle=metal'] : [])],
  });
  const report = [];
  try {
    for (const smp of SAMPLES) {
      for (const preset of PRESETS) {
        const page = await browser.newPage();
        await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: DPR });
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        page.on('console', (m) => (m.type() === 'error' || /Shader|WebGL|GL_INVALID/i.test(m.text())) && errors.push(m.text().slice(0, 300)));
        await page.evaluateOnNewDocument(pageHooks);
        await page.goto(`${url}/${smp.path}?cursor=depth&soften=${preset}${smp.query || ''}`, { waitUntil: 'load' });
        await page.waitForFunction((sel) => globalThis.__cap.scenes.some((s) => s.canvas === document.querySelector(sel)), { timeout: 60000, polling: 200 }, smp.canvas);
        const row = { sample: smp.name, preset };
        for (const [spot, [u, v]] of [['over', smp.over], ['glass', smp.glass]]) {
          // Pin the pointer, let the content load + the cursor settle (~3 s of page clock), freeze.
          await page.evaluate((sel, u, v) => {
            const c = document.querySelector(sel);
            const r = c.getBoundingClientRect();
            globalThis.__cap.frozen = false;
            globalThis.__cap.pin = () => c.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + u * r.width, clientY: r.top + v * r.height, bubbles: true }));
            globalThis.__cap.pinning = true;
          }, smp.canvas, u, v);
          // Settled = the sprite has replaced the CSS cursor (over) / given it back (glass), plus
          // 1.5 s more for the filter. Assets arrive from CDNs, so allow up to 45 s for the first.
          await page
            .waitForFunction((sel, over) => (document.querySelector(sel).style.cursor === 'none') === over, { timeout: 45000, polling: 100 }, smp.canvas, spot === 'over')
            .catch(() => console.log(`  (${smp.name}/${preset}/${spot}: the cursor never ${spot === 'over' ? 'lifted' : 'settled on the glass'})`));
          await new Promise((r) => setTimeout(r, 1500));
          const shoot = () =>
            page.evaluate(async (sel) => {
              const cap = globalThis.__cap;
              const want = { canvas: document.querySelector(sel) };
              cap.want = want;
              while (!want.done) await new Promise((r) => setTimeout(r, 5));
              return want;
            }, smp.canvas);
          await page.evaluate(() => { globalThis.__cap.frozen = true; });
          await new Promise((r) => setTimeout(r, 100));
          const withCursor = await shoot();
          await page.evaluate((sel) => {
            globalThis.__cap.pinning = false;
            document.querySelector(sel).dispatchEvent(new PointerEvent('pointerleave'));
          }, smp.canvas);
          await new Promise((r) => setTimeout(r, 100));
          const without = await shoot();
          const css = await page.evaluate((sel) => document.querySelector(sel).style.cursor, smp.canvas);
          const m = await page.evaluate(measure, withCursor.png, without.png);
          for (const [i, e] of m.eyes.entries()) {
            if (e.crop) await writeFile(join(OUT, `${smp.name}-${spot}-${preset}-eye${i}.png`), Buffer.from(e.crop.split(',')[1], 'base64'));
            delete e.crop;
          }
          await writeFile(join(OUT, `${smp.name}-${spot}-${preset}-sbs.png`), Buffer.from(withCursor.png.split(',')[1], 'base64'));
          row[spot] = { buffer: [m.W, m.H], eyes: m.eyes, cssAfterLeave: css };
        }
        const pageErr = await page.evaluate(() => globalThis.__cap.error || null);
        row.errors = [...errors, ...(pageErr ? [pageErr] : [])];
        report.push(row);
        const f = (e) => `touched ${e.touched} peak ${e.peakL} step ${e.maxEdgeStep} (bg ${e.bgEdgeStep}) tip ${e.tip ? e.tip.join(',') : '-'} bbox ${e.bbox ? e.bbox.join(',') : '-'}`;
        console.log(`${smp.name.padEnd(10)} ${preset.padEnd(5)} over: L[${f(row.over.eyes[0])}] R[${f(row.over.eyes[1])}]  glass: touched ${row.glass.eyes[0].touched}/${row.glass.eyes[1].touched}${row.errors.length ? `  ERRORS ${row.errors.length}: ${row.errors[0]}` : ''}`);
        await page.close();
      }
    }
  } finally {
    await browser.close().catch(() => {});
    srv.close();
  }
  await writeFile(join(OUT, 'report.json'), JSON.stringify(report, null, 1));
  console.log(`wrote ${OUT}/report.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

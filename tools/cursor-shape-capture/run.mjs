#!/usr/bin/env node
// tools/cursor-shape-capture/run.mjs — headless pixel evidence that the depth cursor mirrors the
// page's CSS cursor (ADR-046 Amendment 2 §C, page side) on the REAL model sample.
//
//   [SOFTEN=off] node tools/cursor-shape-capture/run.mjs [outDir] [engine ...]     # engines: playcanvas three
//
// Same harness as tools/cursor-soften-capture (the fake wall: two off-axis views on a frozen clock;
// everything else is the sample's own code, `?cursor=depth&anchor=screen`). The pointer is pinned
// over the lifted model; per case the page's cursor on the tile is set — inline `style.cursor` =
// auto, pointer, grab, grabbing, move, all-scroll, text, url(…) — and the woven buffer is read with
// the cursor and again with the pointer gone (same instant), the difference being the sprite. Per
// eye: the shape the cursor reports, its bbox, and its HOTSPOT pixel recovered from the bbox through
// the shape's own box (cursorShape(name).box) — the same pixel for every shape when the hotspot is
// right. Then the Shop case: a stylesheet `cursor: grab` plus a class toggled to `grabbing` on
// pointerdown (removed on pointerup), driven by real dispatched pointer events: the drawn shape
// must go grab → grabbing → grab. Fails on ANY page error or GL/shader console error.
//
// ONE headless Chrome (DPR 2), closed on exit. Needs puppeteer-core and network (CDN imports).

import { createServer } from 'node:http';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, join, extname } from 'node:path';
import { cursorShape } from '../../js/inline3d-cursor-shape.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = resolve(process.argv[2] || 'cursor-shape-out');
const ENGINES = process.argv.slice(3).length ? process.argv.slice(3) : ['playcanvas', 'three'];
const OVER = [0.5, 0.45];
// SOFTEN=off: crisp sprites, for the hotspot geometry (a blurred tip fades under the diff threshold
// and biases the bbox estimate); default = the shipping softened sprite.
const SOFTEN = process.env.SOFTEN || '';
const CASES = [
  ['auto', 'arrow'],
  ['pointer', 'pointer'],
  ['grab', 'grab'],
  ['grabbing', 'grabbing'],
  ['move', 'move'],
  ['all-scroll', 'move'],
  ['text', 'arrow'],
  ['url("data:image/png;base64,iVBORw0KGgo=") 4 4, grab', 'arrow'],
];

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
export function startInline3D() { throw new Error('cursor-shape-capture: startInline3D not faked'); }
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
    args: ['--no-first-run', '--enable-gpu', '--ignore-gpu-blocklist', '--force-device-scale-factor=2', ...(process.platform === 'darwin' ? ['--use-angle=metal'] : [])],
  });
  const report = { cases: [], shop: [], errors: [] };
  let fail = 0;
  try {
    for (const engine of ENGINES) {
      const page = await browser.newPage();
      await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 2 });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      // A missing favicon is not an error of the page; any other failed load is.
      page.on('response', (r) => r.status() >= 400 && !/favicon\.ico$/.test(r.url()) && errors.push(`HTTP ${r.status()} ${r.url()}`));
      page.on('console', (m) => ((m.type() === 'error' && !/Failed to load resource/.test(m.text())) || /Shader|WebGL|GL_INVALID|GL ERROR/i.test(m.text())) && errors.push(m.text().slice(0, 300)));
      await page.evaluateOnNewDocument(pageHooks);
      await page.goto(`${url}/samples/model/?cursor=depth&anchor=screen${SOFTEN ? `&soften=${SOFTEN}` : ''}${engine === 'three' ? '&engine=three' : ''}`, { waitUntil: 'load' });
      const sel = '#tileA';
      await page.waitForFunction((sel) => globalThis.__cap.scenes.some((s) => s.canvas === document.querySelector(sel)), { timeout: 60000, polling: 200 }, sel);
      const pin = () =>
        page.evaluate((sel, u, v) => {
          const c = document.querySelector(sel);
          const r = c.getBoundingClientRect();
          globalThis.__cap.frozen = false;
          globalThis.__cap.pin = () => c.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + u * r.width, clientY: r.top + v * r.height, bubbles: true, pointerId: 1, isPrimary: true }));
          globalThis.__cap.pinning = true;
        }, sel, OVER[0], OVER[1]);
      const shoot = () =>
        page.evaluate(async (sel) => {
          const cap = globalThis.__cap;
          const want = { canvas: document.querySelector(sel) };
          cap.want = want;
          while (!want.done) await new Promise((r) => setTimeout(r, 5));
          return want;
        }, sel);
      const drawn = () => page.evaluate(() => {
        const v = globalThis.__dxrModel?.a?.viewer || globalThis.__model?.viewer;
        const c = v?.cursorDepth;
        return c ? { shape: c.shape, active: !!c.placement?.active, css: c.shapes?.reader?.css ?? null } : null;
      });
      // One capture: settle, freeze, with/without, measure; hotspot from the bbox + the shape's box.
      const capture = async (tag) => {
        await pin();
        await page
          .waitForFunction((sel) => document.querySelector(sel).hasAttribute('data-inline3d-cursor-hidden'), { timeout: 45000, polling: 100 }, sel)
          .catch(() => console.log(`  (${engine}/${tag}: the cursor never lifted)`));
        await new Promise((r) => setTimeout(r, 1200));
        await page.evaluate(() => { globalThis.__cap.frozen = true; });
        await new Promise((r) => setTimeout(r, 100));
        const d = await drawn();
        const withCursor = await shoot();
        await page.evaluate((sel) => {
          globalThis.__cap.pinning = false;
          document.querySelector(sel).dispatchEvent(new PointerEvent('pointerleave'));
        }, sel);
        await new Promise((r) => setTimeout(r, 100));
        const without = await shoot();
        const m = await page.evaluate(measure, withCursor.png, without.png);
        const box = cursorShape(d?.shape || 'arrow').box;
        const eyes = m.eyes.map((e, i) => {
          if (e.crop) writeFile(join(OUT, `${engine}-${tag}-eye${i}.png`), Buffer.from(e.crop.split(',')[1], 'base64'));
          if (!e.bbox) return { touched: 0 };
          const [x0, y0, x1, y1] = e.bbox;
          const hx = x0 + ((0 - box[0]) / (box[2] - box[0])) * (x1 - x0);
          const hy = y0 + ((0 - box[1]) / (box[3] - box[1])) * (y1 - y0);
          return { touched: e.touched, bbox: e.bbox, hotspot: [+hx.toFixed(1), +hy.toFixed(1)] };
        });
        await writeFile(join(OUT, `${engine}-${tag}-sbs.png`), Buffer.from(withCursor.png.split(',')[1], 'base64'));
        return { drawn: d, eyes };
      };

      // 1) Every CSS value, inline on the tile.
      const hot = [];
      for (const [css, want] of CASES) {
        await page.evaluate((sel, css) => { document.querySelector(sel).style.cursor = css; }, sel, css);
        const r = await capture(`css-${want}-${css.replace(/[^a-z-]/gi, '').slice(0, 12)}`);
        const ok = r.drawn && r.drawn.shape === want && r.eyes.every((e) => e.touched > 0);
        fail += !ok;
        if (ok) hot.push(r.eyes.map((e) => e.hotspot));
        report.cases.push({ engine, css, want, ...r, ok });
        console.log(`${engine.padEnd(10)} css ${JSON.stringify(css).slice(0, 34).padEnd(36)} → ${String(r.drawn?.shape).padEnd(9)} ${ok ? 'PASS' : 'FAIL'}  hotspot L ${r.eyes[0].hotspot} R ${r.eyes[1].hotspot}  touched ${r.eyes.map((e) => e.touched).join('/')}`);
      }
      // The hotspot pixel per eye must be the same for every shape. The noise floor is the ARROW
      // drawn three times (auto / text / url): same sprite, so its spread is the estimator's own
      // (bbox thresholding, the filter's last sub-px) — a shape may not add more than 1 px to it.
      const spreadOf = (pts) => Math.max(Math.max(...pts.map((p) => p[0])) - Math.min(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1])) - Math.min(...pts.map((p) => p[1])));
      const arrows = CASES.map(([, w], i) => (w === 'arrow' ? i : -1)).filter((i) => i >= 0 && hot[i]);
      for (const eye of [0, 1]) {
        const all = spreadOf(hot.map((h) => h[eye]));
        const floor = spreadOf(arrows.map((i) => hot[i][eye]));
        // Softened, a blurred tip (the fingertip, the arrowheads) fades under the diff threshold and
        // shifts the bbox estimate itself by up to ~1.5 px; crisp (SOFTEN=off) holds the 1 px bound.
        const ok = hot.length === CASES.length && all <= floor + (SOFTEN === 'off' ? 1 : 2);
        fail += !ok;
        report.cases.push({ engine, eye, hotspotSpreadPx: all, arrowRepeatSpreadPx: floor, ok });
        console.log(`${engine.padEnd(10)} eye ${eye}: hotspot spread over ${hot.length} shapes = ${all.toFixed(1)} px (arrow-vs-arrow floor ${floor.toFixed(1)} px) ${ok ? 'PASS' : 'FAIL'}`);
      }

      // 2) The Shop case: stylesheet grab, a class to grabbing on pointerdown, off on pointerup.
      await page.evaluate((sel) => {
        const c = document.querySelector(sel);
        c.style.cursor = '';
        const st = document.createElement('style');
        st.textContent = '#tileA { cursor: grab } #tileA.dragging { cursor: grabbing }';
        document.head.appendChild(st);
        c.addEventListener('pointerdown', () => c.classList.add('dragging'));
        c.addEventListener('pointerup', () => c.classList.remove('dragging'));
      }, sel);
      const seq = [];
      for (const [step, ev] of [['hover', null], ['press', 'pointerdown'], ['release', 'pointerup']]) {
        if (ev) {
          await page.evaluate((sel, ev, u, v) => {
            const c = document.querySelector(sel);
            const r = c.getBoundingClientRect();
            c.dispatchEvent(new PointerEvent(ev, { clientX: r.left + u * r.width, clientY: r.top + v * r.height, bubbles: true, pointerId: 1, isPrimary: true, button: 0, buttons: ev === 'pointerdown' ? 1 : 0 }));
          }, sel, ev, OVER[0], OVER[1]);
        }
        const r = await capture(`shop-${step}`);
        seq.push(r.drawn?.shape);
        report.shop.push({ engine, step, ...r });
        console.log(`${engine.padEnd(10)} shop ${step.padEnd(8)} → ${r.drawn?.shape} (css read ${JSON.stringify(r.drawn?.css)})  hotspot L ${r.eyes[0].hotspot}`);
      }
      const shopOk = seq.join() === 'grab,grabbing,grab';
      fail += !shopOk;
      console.log(`${engine.padEnd(10)} shop sequence ${seq.join(' → ')} ${shopOk ? 'PASS' : 'FAIL'}`);
      const pageErr = await page.evaluate(() => globalThis.__cap.error || null);
      const errs = [...errors, ...(pageErr ? [pageErr] : [])];
      if (errs.length) {
        fail++;
        console.log(`${engine}: ERRORS ${errs.length}: ${errs.slice(0, 3).join(' | ')}`);
      } else console.log(`${engine}: no page / GL / shader errors`);
      report.errors.push({ engine, errors: errs });
      await page.close();
    }
  } finally {
    await browser.close().catch(() => {});
    srv.close();
  }
  await writeFile(join(OUT, 'report.json'), JSON.stringify(report, null, 1));
  console.log(`wrote ${OUT}/report.json — ${fail ? `FAIL (${fail})` : 'PASS'}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

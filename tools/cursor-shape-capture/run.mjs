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
import { cursorShapeTexture } from '../../js/inline3d-cursor-shape.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = resolve(process.argv[2] || 'cursor-shape-out');
const ENGINES = process.argv.slice(3).length ? process.argv.slice(3) : ['playcanvas', 'three'];
const OVER = [0.5, 0.45];
// SOFTEN=off: crisp sprites, for the hotspot geometry (a blurred tip fades under the diff threshold
// and biases the bbox estimate); default = the shipping softened sprite.
const SOFTEN = process.env.SOFTEN || '';
// A url() image: a 24×24 SVG (magenta with a dark centre) as a data: URL, hotspot 12 12 explicit.
const SVG = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24'%3E%3Crect width='24' height='24' fill='%23e0f'/%3E%3Crect x='10' y='10' width='4' height='4' fill='%23111'/%3E%3C/svg%3E";
const CASES = [
  ['auto', 'arrow'], ['default', 'arrow'], ['wobble', 'arrow'],
  ['pointer', 'pointer'], ['grab', 'grab'], ['grabbing', 'grabbing'], ['move', 'move'], ['all-scroll', 'move'],
  ['text', 'text'], ['vertical-text', 'vertical-text'], ['crosshair', 'crosshair'], ['not-allowed', 'not-allowed'],
  ['no-drop', 'not-allowed'], ['help', 'help'], ['wait', 'wait'], ['progress', 'progress'], ['copy', 'copy'],
  ['alias', 'alias'], ['context-menu', 'context-menu'], ['cell', 'cell'], ['n-resize', 'ns-resize'],
  ['ew-resize', 'ew-resize'], ['ne-resize', 'nesw-resize'], ['nwse-resize', 'nwse-resize'], ['col-resize', 'col-resize'],
  ['row-resize', 'row-resize'], ['zoom-in', 'zoom-in'], ['zoom-out', 'zoom-out'],
  [`url("${SVG}") 12 12, pointer`, 'image'],
  ['url("missing-cursor.png") 3 3, grab', 'grab'], // a url that never loads: the keyword fallback
  ['none', 'none'],
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
      page.on('response', (r) => r.status() >= 400 && !/favicon\.ico$|missing-cursor\.png$/.test(r.url()) && errors.push(`HTTP ${r.status()} ${r.url()}`));
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
        const sp = c?.shapes?.sprite;
        return c ? { shape: c.shape, active: !!c.placement?.active, css: c.shapes?.reader?.css?.slice(0, 80) ?? null, image: sp && sp.kind === 'image' ? { width: sp.width, height: sp.height, hotspot: sp.hotspot } : null } : null;
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
        // The sprite's own rect (sprite units around the hotspot): a texture's, or an image's CSS box.
        const box = d?.image
          ? [-d.image.hotspot[0] / 19, -d.image.hotspot[1] / 19, (d.image.width - d.image.hotspot[0]) / 19, (d.image.height - d.image.hotspot[1]) / 19]
          : cursorShapeTexture(d?.shape === 'none' ? 'arrow' : d?.shape || 'arrow').rect;
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
        const r = await capture(`css-${want}-${css.startsWith('url("data') ? 'dataurl' : css.replace(/[^a-z-]/gi, '').slice(0, 14)}`);
        // none: nothing drawn, and the OS cursor still hidden (the page asked for no cursor).
        const hidden = await page.evaluate((sel) => getComputedStyle(document.querySelector(sel)).cursor, sel);
        const ok = r.drawn && r.drawn.shape === want && (want === 'none' ? r.eyes.every((e) => e.touched === 0) : r.eyes.every((e) => e.touched > 0));
        fail += !ok;
        if (ok && want !== 'none') hot.push(r.eyes.map((e) => e.hotspot));
        report.cases.push({ engine, css: css.slice(0, 80), want, ...r, cssAfter: hidden, ok });
        console.log(`${engine.padEnd(10)} css ${JSON.stringify(css).slice(0, 34).padEnd(36)} → ${String(r.drawn?.shape).padEnd(9)} ${ok ? 'PASS' : 'FAIL'}  hotspot L ${r.eyes[0].hotspot} R ${r.eyes[1].hotspot}  touched ${r.eyes.map((e) => e.touched).join('/')}`);
      }
      // The hotspot must be the same pixel for every sprite. Per eye, x also carries the sprite's
      // DISPARITY, which moves between captures (the model idles while each case settles, so the
      // depth under the pointer differs); the cyclopean hotspot — the eyes' midpoint, and y — does
      // not. The noise floor is the arrow drawn three times (auto / default / an unknown keyword);
      // a sprite may add at most 1 px to it crisp, 2 px softened (a blurred tip fades under the
      // diff threshold and shifts the bbox estimate itself).
      const spreadOf = (pts) => Math.max(Math.max(...pts.map((p) => p[0])) - Math.min(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1])) - Math.min(...pts.map((p) => p[1])));
      const cyc = hot.map(([l, r]) => [(l[0] + r[0]) / 2, (l[1] + r[1]) / 2]);
      const all = spreadOf(cyc);
      const floor = spreadOf([0, 1, 2].map((i) => cyc[i]));
      const disp = hot.map(([l, r]) => l[0] - r[0]);
      // The floor is at least 0.5 px: bit-identical arrow repeats give 0, but the bbox estimate is
      // integer-quantised per edge (±0.5 px) whatever the sprite.
      const okHot = hot.length === CASES.length - 1 && all <= Math.max(floor, 0.5) + (SOFTEN === 'off' ? 1 : 2);
      fail += !okHot;
      report.cases.push({ engine, cyclopeanHotspotSpreadPx: all, arrowRepeatSpreadPx: floor, disparityRangePx: [Math.min(...disp), Math.max(...disp)], ok: okHot });
      console.log(`${engine.padEnd(10)} cyclopean hotspot spread over ${hot.length} sprites = ${all.toFixed(1)} px (arrow-vs-arrow floor ${floor.toFixed(1)} px; per-eye disparity ${Math.min(...disp).toFixed(1)}..${Math.max(...disp).toFixed(1)} px) ${okHot ? 'PASS' : 'FAIL'}`);

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

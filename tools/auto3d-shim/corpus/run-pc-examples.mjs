// The official PlayCanvas examples (playcanvas.com/examples) through the auto-3D shim — a coverage
// run, not a gate.
//
// The examples site loads each example in an iframe, `<site>/iframe/<category>_<example>.html`, a
// standalone page (import map -> ../iframe/playcanvas.mjs, the engine the site runs: v2.24.0 on
// 2026-11-10). Each one is loaded TOP-LEVEL here in a fresh incognito context of real-GPU headless
// Chrome (../test/run.mjs's launch flags), with what the harness injects at document start:
// ../test/fake-xr.js (two views, ±0.1 off-axis skew: the right eye must equal the left shifted
// 0.1 x eyeW) and the DEV bundle built in memory from the sources (../build.mjs), so
// window.__dxrAuto3D.state() and the dev host's report log (window.__dxrAuto3DReports) are there.
//
// Per example: the reports (converting:PlayCanvas / live:PlayCanvas / flat:<reason> / standdown /
// guard), the PlayCanvas renderer's state (active, flatReason, stats, CameraFrame split, footprint),
// console errors (page vs ours), and, when live, a screenshot of the canvas (the composited frame:
// the examples do not preserve the drawing buffer) scored as a stereo pair:
//   zeroErr   MAE(left, right) at shift 0 (halves differ)
//   shift     the best horizontal shift right(x + s) ≈ left(x)   (want = 0.1 x eyeW)
//   resid     MAE at the best shift (low = the eyes agree; high = something differs per eye: a
//             screen-space effect, UI, random per-draw content)
//   blankL/R  fraction of near-uniform rows per half (an eye left black)
// Verdict: PASS (live, shift ≈ want, resid < 6), REVIEW (live but shift/resid off, or errors),
// FLAT (stayed 2D with a reason), NONE (never detected), ERROR (the example itself failed).
//
// Usage: node run-pc-examples.mjs [--only cat/name,cat/name] [--cat c1,c2] [--hidden] [--keep] [--tag x] [--resume]
//   env: CHROME=<binary>  PC_EXAMPLES=<site base, default https://playcanvas.com/examples>  SHIM_DEV=<dev bundle to inject>
// Output: results/<date>-pc-examples[-tag][-only].json. Captures (the canvas, left|right) only with --keep
// (results/pc-examples-png/) or KEEP_DIR=<dir>: images are never committed.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { build } from '../build.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const shimDir = join(here, '..');
const WIN = process.platform === 'win32';
const CHROME = process.env.CHROME || (WIN ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  : process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome');
const ANGLE = WIN ? 'd3d11' : process.platform === 'darwin' ? 'metal' : 'vulkan';
const W = 1280, H = 720;
const SITE = (process.env.PC_EXAMPLES || 'https://playcanvas.com/examples').replace(/\/$/, '');

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const ONLY = opt('--only', '').split(',').filter(Boolean);
const CATS = opt('--cat', '').split(',').filter(Boolean);
const HIDDEN = argv.includes('--hidden');
const TAG = opt('--tag', '');
const KEEP_DIR = process.env.KEEP_DIR || (argv.includes('--keep') ? join(here, 'results', 'pc-examples-png') : null);
const SETTLE_MS = Number(opt('--settle-ms', 14000)); // after load: detection + the switch + 90 stereo frames
const BUDGET_MS = Number(opt('--budget-ms', 30000));

// ------------------------------------------------------------ the example list (from the site's own bundle)
async function listExamples() {
  const js = await (await fetch(`${SITE}/index.js`)).text();
  const re = /\{path:"[^"]*",categoryKebab:"([^"]+)",exampleNameKebab:"([^"]+)",hidden:!([01])\}/g;
  const seen = new Set(), out = [];
  for (let m; (m = re.exec(js));) {
    const id = `${m[1]}/${m[2]}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, cat: m[1], name: m[2], hidden: m[3] === '0' });
  }
  if (!out.length) throw new Error(`no examples found in ${SITE}/index.js (the bundle's shape changed?)`);
  return out;
}

// ------------------------------------------------------------ injected
// SHIM_DEV=<file>: inject that dev bundle instead (e.g. an older release's dist/auto3d-dev.js, for a before/after).
const DEV = process.env.SHIM_DEV ? readFileSync(process.env.SHIM_DEV, 'utf8') : build(shimDir).files['dist/auto3d-dev.js'];
const FAKE = readFileSync(join(shimDir, 'test', 'fake-xr.js'), 'utf8');
// guardFps 5: headless rAF on a contended GPU is not the panel's; the guard is measured elsewhere.
const CFG = `window.__dxrAuto3DTestCfg = ${JSON.stringify({ guardFps: 5 })}; window.__fakeXROpts = {};`;

// ------------------------------------------------------------ the pair score (node side, RGBA)
const lum = (px, i) => 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
function score(px, w, h) {
  const eyeW = w >> 1, want = Math.round(0.1 * eyeW), S = Math.ceil(0.2 * eyeW);
  let best = { s: 0, e: Infinity }, zero = 0;
  const errAt = (s) => {
    let e = 0, n = 0;
    for (let y = 0; y < h; y += 2) for (let x = Math.max(0, -s); x < Math.min(eyeW, eyeW - s); x += 2) { e += Math.abs(lum(px, (y * w + x) * 4) - lum(px, (y * w + eyeW + x + s) * 4)); n++; }
    return e / (n || 1);
  };
  for (let s = -S; s <= S; s++) { const e = errAt(s); if (s === 0) zero = e; if (e < best.e) best = { s, e }; }
  const blank = (x0) => { let b = 0; for (let y = 0; y < h; y += 4) { let mn = 255, mx = 0; for (let x = x0; x < x0 + eyeW; x += 4) { const l = lum(px, (y * w + x) * 4); if (l < mn) mn = l; if (l > mx) mx = l; } if (mx - mn < 3) b++; } return b / Math.ceil(h / 4); };
  return { eyeW, want, shift: best.s, resid: +best.e.toFixed(2), residAtWant: +errAt(want).toFixed(2), zeroErr: +zero.toFixed(2), blankL: +blank(0).toFixed(2), blankR: +blank(eyeW).toFixed(2) };
}

// ------------------------------------------------------------ one example
async function runOne(browser, ex) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  const log = [];
  page.on('console', (m) => log.push(`[${m.type()}] ${m.text().slice(0, 300)}`));
  page.on('pageerror', (e) => log.push(`[pageerror] ${String((e && e.message) || e).slice(0, 300)} @@${String((e && e.stack) || '').split('\n').slice(1, 3).join(' < ').slice(0, 300)}`));
  await page.evaluateOnNewDocument(CFG);
  await page.evaluateOnNewDocument(FAKE);
  await page.evaluateOnNewDocument(DEV);
  const t0 = Date.now();
  const r = { id: ex.id, cat: ex.cat, hidden: ex.hidden, url: `${SITE}/iframe/${ex.cat}_${ex.name}.html` };
  try {
    try { await page.goto(r.url, { waitUntil: 'load', timeout: BUDGET_MS }); } catch (e) { r.loadTimeout = true; }
    // Live with 90 stereo frames and the depth fade done, or a terminal report, or the settle budget.
    try {
      await page.waitForFunction(() => {
        const S = window.__dxrAuto3D && window.__dxrAuto3D.state();
        const R = S && S.renderers.find((x) => x.active);
        if (R && R.stats.twoView > 90 && (R.rampK === 1 && !R.ramping)) return true;
        const rep = window.__dxrAuto3DReports || [];
        const last = rep[rep.length - 1];
        return !!(last && /^(standdown|guard|optout)$/.test(last.status) && performance.now() - last.t > 1500);
      }, { timeout: SETTLE_MS, polling: 250 });
    } catch (e) { r.settleTimeout = true; }
    const snap = await page.evaluate(() => {
      const S = window.__dxrAuto3D ? window.__dxrAuto3D.state() : null;
      const pcs = S ? S.renderers.filter((x) => x.engine === 'PlayCanvas') : [];
      const R = pcs.find((x) => x.active) || pcs[pcs.length - 1] || null;
      let cams = null;
      try {
        // What the example has (diagnostics): its cameras, through the app the shim found.
        const app = (window.pc && window.pc.app) || null;
        if (app) cams = app.systems.camera.cameras.map((c) => ({ n: c.entity.name, en: c.enabled && c.entity.enabled, rt: !!c.renderTarget, ortho: c.projection === 1, fp: (c.framePasses || []).length, layers: c.layers.length }));
      } catch (e) { /* ignore */ }
      return {
        reports: (window.__dxrAuto3DReports || []).map(({ status, engine, reason, t }) => ({ status, engine: engine || null, reason: reason || null, t: Math.round(t) })),
        version: S && S.version, detected: S && S.playcanvas ? S.playcanvas.detected : [],
        renderers: S ? S.renderers.length : 0,
        R: R && { canvas: R.canvas, css: R.css, real: R.real, eye: R.eye, active: R.active, pending: R.pending, haveViews: R.haveViews, why: R.why, flatReason: R.flatReason,
          stats: R.stats, convergence: R.convergence, convergenceSource: R.convergenceSource, detection: R.detection, device: R.device, renderView: R.renderView,
          footprint: R.footprint, cameraFrame: R.cameraFrame, camera: R.camera, autoRender: R.autoRender, pageSizeWrites: R.pageSizeWrites },
        cams, hasCanvas: !!document.querySelector('canvas'),
      };
    });
    Object.assign(r, snap);
    // The pair: a screenshot of the canvas element (the composited frame), with everything else on the
    // page hidden for the shot (the page's own DOM UI over the canvas, our HUD and chip), so the score
    // reads the canvas only. A pair that is still blank (content streaming in: splats, glTF) is shot
    // again, twice at most, 4 s apart.
    const R = snap.R;
    if (R && R.active) {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt) await new Promise((res) => setTimeout(res, 4000));
        const el = await page.$('canvas:not([data-dxr-auto3d-cover])');
        const box = el && (await el.boundingBox());
        if (!(box && box.width > 8 && box.height > 8)) break;
        await page.evaluate(() => { const s = document.createElement('style'); s.id = '__dxrShot'; s.textContent = '* { visibility: hidden !important; } canvas:not([data-dxr-auto3d-cover]) { visibility: visible !important; }'; document.documentElement.appendChild(s); });
        await page.evaluate(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res))));
        const png = await page.screenshot({ clip: { x: box.x, y: box.y, width: Math.min(box.width, W - box.x), height: Math.min(box.height, H - box.y) }, encoding: 'base64' });
        await page.evaluate(() => { const s = document.getElementById('__dxrShot'); if (s) s.remove(); });
        const DW = 640; // decoded at a fixed width: the score reads 2 x 320 px eyes
        const d = await page.evaluate(async (b64, DW) => {
          const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
          const h = Math.max(2, Math.round((DW * img.height) / img.width));
          const c = document.createElement('canvas'); c.width = DW; c.height = h;
          const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0, DW, h);
          const px = g.getImageData(0, 0, DW, h).data; let s = '';
          for (let i = 0; i < px.length; i += 32768) s += String.fromCharCode.apply(null, px.subarray(i, i + 32768));
          return { w: DW, h, b64: btoa(s) };
        }, png, DW);
        r.pair = { ...score(Buffer.from(d.b64, 'base64'), d.w, d.h), shots: attempt + 1 };
        if (KEEP_DIR) { mkdirSync(KEEP_DIR, { recursive: true }); writeFileSync(join(KEEP_DIR, `${ex.cat}_${ex.name}.png`), Buffer.from(png, 'base64')); }
        if (r.pair.blankL < 0.6 && r.pair.blankR < 0.6) break;
      }
      // Still the same renderer, still live at the end (a late stand-down shows up here).
      r.liveAtEnd = await page.evaluate(() => { const S = window.__dxrAuto3D && window.__dxrAuto3D.state(); return !!(S && S.renderers.some((x) => x.active)); });
    }
  } catch (e) {
    r.harnessError = String((e && e.message) || e).slice(0, 300);
  }
  r.ms = Date.now() - t0;
  const ours = (l) => /dxr|auto3d|playcanvas-adapter|core\.js/i.test(l);
  r.errors = log.filter((l) => /^\[(pageerror|error)\]/.test(l) && !ours(l)).slice(0, 8);
  r.ourErrors = log.filter((l) => /^\[(pageerror|error)\]/.test(l) && ours(l)).slice(0, 8);
  r.dxr = log.filter((l) => /dxr-auto3d/.test(l)).slice(0, 25);
  r.verdict = verdict(r);
  await ctx.close().catch(() => {});
  return r;
}

function verdict(r) {
  const last = r.reports && r.reports[r.reports.length - 1];
  const live = r.R && r.R.active && r.reports.some((x) => x.status === 'live');
  if (live) {
    const p = r.pair;
    if (!p) return { v: 'REVIEW', why: 'live, no capture' };
    if (p.blankL > 0.9 && p.blankR > 0.9) return { v: 'REVIEW', why: 'live, both eyes blank/uniform' };
    if (Math.abs(p.blankL - p.blankR) > 0.3) return { v: 'REVIEW', why: `live, one eye blank (L ${p.blankL} R ${p.blankR})` };
    if (p.zeroErr <= 0.3) return { v: 'REVIEW', why: 'live, halves identical (no disparity)' };
    const shiftOk = Math.abs(p.shift - p.want) <= 2 || p.residAtWant <= p.resid + 0.5;
    if (!shiftOk) return { v: 'REVIEW', why: `live, shift ${p.shift} != ${p.want} (resid ${p.resid}, at want ${p.residAtWant})` };
    if (p.residAtWant >= 6) return { v: 'REVIEW', why: `live, eyes disagree (resid ${p.residAtWant} at the expected shift)` };
    if (r.ourErrors.length) return { v: 'REVIEW', why: 'live, but errors from our code' };
    return { v: 'PASS', why: `live, shift ${p.shift}/${p.want}, resid ${p.residAtWant}` };
  }
  if (r.ourErrors && r.ourErrors.length) return { v: 'FAIL', why: 'errors from our code: ' + r.ourErrors[0].slice(0, 120) };
  if (last && last.status === 'flat') return { v: 'FLAT', why: last.reason || (r.R && r.R.flatReason) || 'flat' };
  if (last && /^(standdown|guard|optout)$/.test(last.status)) return { v: last.status.toUpperCase(), why: last.reason || '' };
  if (r.R && (r.R.flatReason || r.R.why)) return { v: 'FLAT', why: r.R.flatReason || r.R.why };
  if (r.R && r.R.pending) return { v: 'REVIEW', why: 'still converting at the end of the watch' };
  if (r.R) return { v: 'NONE', why: 'detected, never qualified' + (r.errors.length ? ' (page errors)' : '') };
  if (!r.hasCanvas || r.errors.length) return { v: 'ERROR', why: r.errors[0] ? r.errors[0].slice(0, 140) : 'no canvas' };
  return { v: 'NONE', why: (r.detected && r.detected.length) ? 'app found, no renderer state' : 'PlayCanvas never detected' };
}

// ------------------------------------------------------------ main
if (!existsSync(CHROME)) { console.error(`FAILED: no Chrome at ${CHROME}`); process.exit(2); }
let list = await listExamples();
if (!HIDDEN) list = list.filter((e) => !e.hidden);
if (CATS.length) list = list.filter((e) => CATS.includes(e.cat));
if (ONLY.length) list = list.filter((e) => ONLY.includes(e.id));
console.log(`${list.length} example(s) from ${SITE}`);
const LAUNCH = {
  executablePath: CHROME, headless: 'new',
  args: [`--use-angle=${ANGLE}`, '--enable-gpu', '--ignore-gpu-blocklist', '--no-sandbox', `--window-size=${W},${H}`, '--hide-scrollbars', '--force-device-scale-factor=1', '--disable-features=OpenXR,WebXR', '--autoplay-policy=no-user-gesture-required'],
};
const date = new Date().toISOString().slice(0, 10);
const out = join(here, 'results', `${date}-pc-examples${TAG ? '-' + TAG : ''}${ONLY.length || CATS.length ? '-only' : ''}.json`);
// Written after every example, so a crash loses nothing; --resume skips the examples already in it.
const results = argv.includes('--resume') && existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')).results : [];
const done = new Set(results.map((r) => r.id));
const save = () => {
  const byCat = {};
  for (const r of results) { const c = (byCat[r.cat] = byCat[r.cat] || {}); c[r.verdict.v] = (c[r.verdict.v] || 0) + 1; }
  writeFileSync(out, JSON.stringify({ site: SITE, date, shim: (results.find((r) => r.version) || {}).version || null, shimSource: process.env.SHIM_DEV ? 'SHIM_DEV' : 'sources', byCat, results }, null, 1));
  return byCat;
};
let browser = await puppeteer.launch(LAUNCH);
try {
  for (const ex of list) {
    if (done.has(ex.id)) continue;
    // A browser that died with the previous example (a GPU process crash) is replaced, and the example run once more.
    if (!browser.connected) browser = await puppeteer.launch(LAUNCH);
    let r = await runOne(browser, ex).catch((e) => ({ id: ex.id, cat: ex.cat, hidden: ex.hidden, harnessError: String((e && e.message) || e), errors: [], ourErrors: [], reports: [] }));
    if (r.harnessError && !browser.connected) { browser = await puppeteer.launch(LAUNCH); r = await runOne(browser, ex).catch((e) => ({ ...r, harnessError: String((e && e.message) || e) })); }
    if (!r.verdict) r.verdict = { v: 'ERROR', why: 'harness: ' + String(r.harnessError).slice(0, 120) };
    results.push(r);
    save();
    console.log(`${r.verdict.v.padEnd(9)} ${ex.id.padEnd(48)} ${r.verdict.why}  (${r.ms} ms)`);
  }
} finally { await browser.close().catch(() => {}); }
const byCat = save();
console.log('\n' + Object.entries(byCat).map(([c, v]) => `${c.padEnd(24)} ${JSON.stringify(v)}`).join('\n'));
console.log(`\nwrote ${out}`);

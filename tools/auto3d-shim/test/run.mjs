// Headless harness for tools/auto3d-shim — no DisplayXR Browser, no display.
//
// Each page is loaded in real-GPU headless Chrome (puppeteer-core) with, injected by
// page.evaluateOnNewDocument (main world, before any page script — the same timing as the
// extension's MAIN-world document_start content scripts):
//   1. the harness config (window.__dxrAuto3DTestCfg),
//   2. fake-xr.js — a fake inline-3d session whose views carry a ±0.1 off-axis skew,
//   3. the shim: dist/auto3d-dev.js, built IN MEMORY from the sources by ../build.mjs (never the
//      committed dist/, which may lag the sources between releases); or, for the parity run, the
//      pre-split content.js from PR #47's commit 84b14f7, read out of git; or, for product-mode
//      cases, fake-host.js driving dist/auto3d-sentinel.js + dist/auto3d-core.js as the browser would.
//
// Cases live in test/cases/*.mjs (a registry, loaded in file-name order; see cases/existing.mjs).
//
// Usage: node run.mjs [caseId…]      env: CHROME=<binary>  SOG_DIR=<dir with ports_25.sog>  KEEP=1 (write PNGs to test/out)
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';
import { build } from '../build.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const shimDir = join(here, '..');
const repo = join(here, '..', '..', '..');
const LEGACY_COMMIT = '84b14f7';
const SOG_DIR = process.env.SOG_DIR || join(homedir(), 'Documents/GitHub/displayxr-gallery-pvt/public/bench');
const WIN = process.platform === 'win32';
const CHROME = process.env.CHROME || (WIN ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  : process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome');
const ANGLE = WIN ? 'd3d11' : process.platform === 'darwin' ? 'metal' : 'vulkan';
const W = 1280, H = 720;

// ------------------------------------------------------------ static server
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.sog': 'application/octet-stream', '.png': 'image/png', '.css': 'text/css', '.svg': 'image/svg+xml' };
function serve() {
  const roots = [['/deps/', join(here, '.deps')], ['/bench/', SOG_DIR], ['/', repo]];
  const srv = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    for (const [pre, dir] of roots) {
      if (!path.startsWith(pre)) continue;
      const f = normalize(join(dir, path.slice(pre.length)));
      if (!f.startsWith(normalize(dir))) break;
      try {
        if (!statSync(f).isFile()) break;
        res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
        res.end(readFileSync(f));
        return;
      } catch { break; }
    }
    res.writeHead(404); res.end('not found');
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

// ------------------------------------------------------------ the cases
const BUILT = build(shimDir).files;
const NEW = [BUILT['dist/auto3d-dev.js']];
const LEGACY = [execFileSync('git', ['-C', repo, 'show', `${LEGACY_COMMIT}:tools/auto3d-shim/content.js`], { encoding: 'utf8' })];
const FAKE = readFileSync(join(here, 'fake-xr.js'), 'utf8');
const hasSog = existsSync(join(SOG_DIR, 'ports_25.sog'));
const P = '/tools/auto3d-shim/test/pages/';
// Product mode: the page gets what the browser injects — the sentinel + core texts, evaluated by
// fake-host.js with (0,eval) and driven through a recording cap (window.__dxrFakeHost).
const FAKE_HOST = readFileSync(join(here, 'fake-host.js'), 'utf8');
const PRODUCT_SRC = { sentinel: BUILT['dist/auto3d-sentinel.js'], core: BUILT['dist/auto3d-core.js'] };
const productShim = (hostCfg = {}) => [`window.__dxrFakeHostSrc = ${JSON.stringify(PRODUCT_SRC)}; window.__dxrFakeHostCfg = ${JSON.stringify(hostCfg)};`, FAKE_HOST];
const CASES = [];
const env = { P, NEW, LEGACY, BUILT, productShim, hasSog, SOG_DIR };
for (const f of readdirSync(join(here, 'cases')).filter((x) => x.endsWith('.mjs')).sort()) {
  const mod = await import(pathToFileURL(join(here, 'cases', f)).href);
  for (const c of mod.default(env)) {
    if (CASES.some((x) => x.id === c.id)) throw new Error(`duplicate case id '${c.id}' (cases/${f})`);
    CASES.push({ ...c, file: f });
  }
}

// ------------------------------------------------------------ pixel helpers
const lum = (px, i) => 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
function mae(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; }
function diffCount(a, b) { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n; }
// The horizontal shift s that best maps the left half onto the right half: right(x + s) ≈ left(x).
function bestShift(px, w, h, eyeW) {
  let best = { s: 0, e: Infinity }, zero = 0;
  for (let s = -120; s <= 120; s++) {
    let e = 0, n = 0;
    for (let y = 0; y < h; y += 2) {
      for (let x = Math.max(0, -s); x < Math.min(eyeW, eyeW - s); x += 2) {
        const l = lum(px, (y * w + x) * 4), r = lum(px, (y * w + eyeW + x + s) * 4);
        e += Math.abs(l - r); n++;
      }
    }
    e /= n || 1;
    if (s === 0) zero = e;
    if (e < best.e) best = { s, e };
  }
  return { ...best, zeroErr: zero };
}

// ------------------------------------------------------------ driver
async function runCase(browser, base, c) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  const log = [];
  page.on('console', (m) => log.push(`[${m.type()}] ${m.text().slice(0, 240)}`));
  page.on('pageerror', (e) => log.push(`[pageerror] ${String(e.message || e).slice(0, 240)}`));
  const missing = []; // an engine / addon the page could not load: fail loudly, not as a 60 s timeout
  page.on('response', (res) => { if (res.status() >= 400 && /\/deps\//.test(res.url())) missing.push(`${res.status()} ${new URL(res.url()).pathname}`); });
  await page.evaluateOnNewDocument(`window.__dxrAuto3DTestCfg = ${JSON.stringify(c.cfg || {})}; window.__fakeXROpts = ${JSON.stringify(c.fake || {})};${c.commits ? ' window.__fakeXRTrackCommits = true;' : ''}`);
  if (c.seed) await page.evaluateOnNewDocument(`if (!sessionStorage.getItem('dxrSeeded')) { sessionStorage.setItem('dxrSeeded', '1'); localStorage.setItem('dxrAuto3D', ${JSON.stringify(JSON.stringify(c.seed))}); }`);
  await page.evaluateOnNewDocument(FAKE);
  for (const s of c.shim) await page.evaluateOnNewDocument(s);
  if (c.before) await c.before(page); // e.g. page.emulateMediaFeatures, before the first script runs
  const t0 = Date.now();
  await page.goto(base + c.url, { waitUntil: 'load', timeout: 60000 });
  // Settled = converted, enough 2-view frames, the page's own ready flag, AND the go-live depth fade
  // finished (rampK exactly 1, no ramp running): the rig is sampled at the configured depth, never
  // mid-fade. (The pre-split script has no fade: rampK null.)
  const convertReady = `(() => { const s = window.__dxrAuto3D && window.__dxrAuto3D.state(); const r = s && s.renderers.find((x) => x.active);
    return !!(r && r.stats.twoView > ${c.minFrames || 90} && (r.rampK == null || (r.rampK === 1 && !r.ramping)) && (${c.ready || 'true'})); })()`;
  if (missing.length) { await ctx.close(); return { c, ok: false, ms: Date.now() - t0, missing, log, state: null, fake: null }; }
  if (c.run) {
    // A case with its own driver (cases/*.mjs): it returns what its check() reads.
    let extra = {}, ok = true;
    try { extra = await c.run(page, HELPERS); } catch (e) { ok = false; extra = { error: String((e && e.message) || e) }; }
    await ctx.close();
    return { c, ok, ms: Date.now() - t0, log, missing, state: null, fake: null, ...extra };
  }
  if (c.expect === 'migrate') {
    await page.waitForFunction(() => !!window.__dxrAuto3D, { timeout: 10000 });
    const res = await page.evaluate(() => { const s = window.__dxrAuto3D.state(); return { depths: s.depths, depth: s.depth, rigMode: s.rigMode }; });
    await ctx.close();
    return { c, ok: true, ms: Date.now() - t0, log, migrate: res, state: null, fake: null, missing };
  }
  if (c.expect === 'noviews') {
    // Wait for the stand-down (or give up after 8 s), then read what happened.
    try { await page.waitForFunction(() => window.__fakeXR.layers.some((l) => l.closedAt !== null), { timeout: 8000, polling: 50 }); } catch { /* asserted below */ }
    const res = await page.evaluate(() => ({ state: window.__dxrAuto3D.state(), layers: window.__fakeXR.layers, noViewFrames: window.__fakeXR.noViewFrames || 0}));
    await ctx.close();
    return { c, ok: true, ms: Date.now() - t0, log, noviews: res, state: res.state, fake: null, missing };
  }
  if (c.expect === 'flip') {
    // Sample the shim and the page's phase every 100 ms across four phases.
    const samples = [];
    const tEnd = Date.now() + 9000;
    while (Date.now() < tEnd) {
      samples.push(await page.evaluate(() => {
        const s = window.__dxrAuto3D.state(), r = s.renderers[0];
        return { t: performance.now(), phase: { ...window.__phase }, active: !!(r && r.active), releasing: !!(r && r.releasing), sessions: window.__fakeXR.sessions.length, layers: window.__fakeXR.layers.length };
      }));
      await new Promise((r) => setTimeout(r, 100));
    }
    const fake = await page.evaluate(() => ({ layers: window.__fakeXR.layers, closes: window.__fakeXR.closes }));
    await ctx.close();
    return { c, ok: true, ms: Date.now() - t0, samples, fake, log, state: null };
  }
  const settle = c.expect === 'convert' ? convertReady : `(${c.ready || 'true'}) && performance.now() > 6000`;
  let ok = true;
  try { await page.waitForFunction(settle, { timeout: c.timeoutMs || 60000, polling: 200 }); } catch { ok = false; }
  if (c.expect !== 'convert') await new Promise((r) => setTimeout(r, 1500));
  const state = await page.evaluate(() => (window.__dxrAuto3D ? window.__dxrAuto3D.state() : null));
  const hud = await page.evaluate(() => (document.querySelector('[data-dxr-auto3d-hud]') || {}).textContent || null);
  const stall = await page.evaluate(() => window.__stall || null);
  const probe = c.probe ? await page.evaluate(c.probe) : null; // a case's extra read, right after settling
  const fake = await page.evaluate(() => ({ sessions: window.__fakeXR.sessions.length, layers: window.__fakeXR.layers.length, lastRig: window.__fakeXR.lastRig, frames: window.__fakeXR.frames, expected: window.__expectedConvergence ?? null, expectedSource: window.__expectedConvergenceSource ?? null }));
  let pixels = null;
  if (c.expect === 'convert' && ok) {
    // Read the canvas between frames (the pages use preserveDrawingBuffer), twice, one frame apart.
    const grab = () => page.evaluate(() => new Promise((res) => requestAnimationFrame(() => setTimeout(() => {
      const src = document.querySelector('canvas:not([data-dxr-auto3d-cover])');
      const w = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width').get.call(src);
      const h = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'height').get.call(src);
      const c2 = document.createElement('canvas'); c2.width = w; c2.height = h;
      const g = c2.getContext('2d', { willReadFrequently: true }); g.drawImage(src, 0, 0);
      const d = g.getImageData(0, 0, w, h).data;
      let s = ''; for (let i = 0; i < d.length; i += 32768) s += String.fromCharCode.apply(null, d.subarray(i, i + 32768));
      res({ w, h, b64: btoa(s), png: c2.toDataURL('image/png') });
    }, 0))));
    const g1 = await grab();
    const g2 = await grab();
    pixels = { w: g1.w, h: g1.h, px: Buffer.from(g1.b64, 'base64'), px2: Buffer.from(g2.b64, 'base64'), png: g1.png };
  }
  const hotkey = async (code) => {
    await page.keyboard.down('Control'); await page.keyboard.down('Alt'); await page.keyboard.press(code);
    await page.keyboard.up('Alt'); await page.keyboard.up('Control');
  };
  let display = null;
  if (c.displayAfter && ok) {
    const snap = async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return page.evaluate(() => ({ rig: window.__fakeXR.lastRig, state: window.__dxrAuto3D.state(), hud: (document.querySelector('[data-dxr-auto3d-hud]') || {}).textContent || null, stored: localStorage.getItem('dxrAuto3D') }));
    };
    // Camera rig first: one step down (0.5 -> 0.4), which must NOT leak into the display rig.
    await hotkey('Minus');
    const cam = await snap(300);
    await hotkey('KeyP');
    display = await snap(600);          // display rig at ITS default, 1.0
    display.cam = cam;
    await hotkey('Minus');
    display.down = await snap(300);     // display 0.8: ipd AND parallax
    await hotkey('Equal'); await hotkey('Equal');
    display.up = await snap(300);       // 0.8 -> 1.0 -> capped at 1.0
    await hotkey('Minus');
    display.down2 = await snap(300);    // 0.8 again, left there
    await hotkey('KeyP');
    display.back = await snap(400);     // camera rig: its own 0.4 is back
    await hotkey('KeyP');
    display.again = await snap(400);    // display rig: its own 0.8 is back
    await hotkey('KeyP');
    await new Promise((r) => setTimeout(r, 200));
    // Remembered per site, per rig: a reload of the same origin comes back with both values.
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => !!window.__dxrAuto3D, { timeout: 10000 });
    display.reloaded = await page.evaluate(() => { const s = window.__dxrAuto3D.state(); return { depths: s.depths, depth: s.depth, rigMode: s.rigMode }; });
  }
  let after = null;
  if (c.killAfter && ok) {
    // The out-cover lives only briefly: record the first one inserted, from inside the page.
    await page.evaluate(() => {
      window.__outCover = null;
      const mo = new MutationObserver((recs) => {
        for (const r of recs) for (const n of r.addedNodes) {
          if (!window.__outCover && n.nodeType === 1 && n.matches('img[data-dxr-auto3d-cover]')) {
            window.__outCover = { srcLen: n.src.length, naturalWidth: n.naturalWidth, naturalHeight: n.naturalHeight, src: n.src };
            mo.disconnect();
          }
        }
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
    });
    await hotkey('Digit3');
    await new Promise((r) => setTimeout(r, 1000));
    after = await page.evaluate(() => ({ state: window.__dxrAuto3D.state(), hud: (document.querySelector('[data-dxr-auto3d-hud]') || {}).textContent || null, closes: window.__fakeXR.closes, sessions: window.__fakeXR.sessions.length, outCover: window.__outCover }));
    // Compare the out-cover, downsampled, with the mono canvas after the stand-down (same flat picture,
    // right way up): a blank or flipped cover differs from it by far more than resampling noise.
    if (after.outCover) {
      after.outCover.cmp = await page.evaluate(async () => {
        const oc = window.__outCover, w = 128, h = 72;
        const img = new Image(); img.src = oc.src; await img.decode();
        const px = (src) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(src, 0, 0, w, h); return g.getImageData(0, 0, w, h).data; };
        const a = px(img), b = px(document.querySelector('canvas:not([data-dxr-auto3d-cover])'));
        const lum = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        let e = 0, ef = 0, m = 0, m2 = 0;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4, j = ((h - 1 - y) * w + x) * 4, l = lum(a, i);
          e += Math.abs(l - lum(b, i)); ef += Math.abs(l - lum(b, j)); m += l; m2 += l * l;
        }
        const n = w * h; m /= n;
        return { mae: e / n, maeFlipped: ef / n, std: Math.sqrt(Math.max(0, m2 / n - m * m)) };
      });
      delete after.outCover.src;
    }
    // A page that renders on demand is asked for one repaint by the restore; read what is on the canvas now.
    const g = await page.evaluate(() => new Promise((res) => requestAnimationFrame(() => setTimeout(() => {
      const src = document.querySelector('canvas'); const c2 = document.createElement('canvas'); c2.width = src.width; c2.height = src.height;
      const x = c2.getContext('2d', { willReadFrequently: true }); x.drawImage(src, 0, 0);
      const d = x.getImageData(0, 0, c2.width, c2.height).data; let s = ''; for (let i = 0; i < d.length; i += 32768) s += String.fromCharCode.apply(null, d.subarray(i, i + 32768));
      res({ w: c2.width, h: c2.height, b64: btoa(s) });
    }, 0))));
    after.px = Buffer.from(g.b64, 'base64'); after.w = g.w; after.h = g.h;
    // Finding 1: on again. The page draws nothing any more (frozen: render on demand).
    const t1 = Date.now();
    await hotkey('Digit3');
    let again = true;
    try {
      await page.waitForFunction(() => { const r = window.__dxrAuto3D.state().renderers.find((x) => x.active); return !!(r && r.stats.twoView > 10); }, { timeout: 4000, polling: 50 });
    } catch { again = false; }
    after.reenable = { again, ms: Date.now() - t1, ...(await page.evaluate(() => ({ sessions: window.__fakeXR.sessions.length, frozen: !!window.__frozen, pageFrames: window.__pageFrames ?? null }))) };
  }
  await ctx.close();
  return { c, ok, ms: Date.now() - t0, state, hud, fake, pixels, log, after, display, probe, stall: stall || { from: NaN, ms: 0 } };
}

// Is a small (128x72) committed frame a side-by-side pair? The fake's skew shifts the right half
// by 0.1 × eye width (6.4 px here) against the left, so a pair has a small residual between
// left(x) and right(x + 6..7), measured on CONTENT pixels only (a mostly empty frame matches itself
// anywhere). What counts as small is calibrated per page and per close: the pair baseline is the
// best frame committed while the layer was open (`before`, which ends with the frames around the
// switch), the mono baseline the last frame committed after close() (mono on every ordering).
const snapPx = (f) => Buffer.from(f.px, 'base64');
function pairResidual(px, w = 128, h = 72) {
  const eyeW = w / 2, bg = lum(px, 0);
  let best = Infinity;
  for (const s of [6, 7]) {
    let e = 0, n = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < eyeW - s; x++) {
      const l = lum(px, (y * w + x) * 4), r = lum(px, (y * w + eyeW + x + s) * 4);
      if (Math.abs(l - bg) < 12 && Math.abs(r - bg) < 12) continue;
      e += Math.abs(l - r); n++;
    }
    if (n >= 40) best = Math.min(best, e / n);
  }
  return best;
}
// Finding 2: after close(), the browser shows the last committed frame unwoven. Neither it nor the
// next few may be a raw pair (unless the cover hides the canvas).
function rawPairAtClose(close) {
  const frames = [close.committed, ...close.after].filter(Boolean);
  const pairBase = Math.min(...close.before.map((f) => pairResidual(snapPx(f))));
  const last = close.after[close.after.length - 1];
  const monoBase = last ? pairResidual(snapPx(last)) : NaN;
  // A mono frame with too little content to match anywhere (Infinity) is certainly not a pair.
  const cut = isFinite(monoBase) ? (pairBase + monoBase) / 2 : pairBase * 1.5 + 0.5;
  const res = frames.map((f) => pairResidual(snapPx(f)));
  const bad = res.map((e, i) => ({ i, e, covered: frames[i].covered })).filter((f) => f.e < cut && !f.covered);
  return { frames: frames.length, bad, pairBase, monoBase, discriminates: pairBase < 0.7 * monoBase || !isFinite(monoBase), atClose: res[0] };
}

// ------------------------------------------------------------ assertions
function check(r, results) {
  const { c, state, fake, pixels } = r;
  const A = [];
  const t = (name, pass, detail) => A.push({ name, pass: !!pass, detail });
  if (r.missing && r.missing.length) {
    t('engine files load (run `node deps.mjs`; see its header for local overrides)', false, r.missing.join(', '));
    return A;
  }
  if (c.check) { c.check(r, t, HELPERS); return A; }
  if (c.expect === 'flip') return checkFlip(r, t, A);
  if (c.expect === 'migrate') {
    const M = r.migrate;
    t('v0.3 single depth carried to the camera rig only; the display rig starts at its 1.0; active = display', M.depths.camera === 0.35 && M.depths.display === 1 && M.rigMode === 'display' && M.depth === 1, JSON.stringify(M));
    return A;
  }
  if (c.expect === 'noviews') {
    const N = r.noviews, L = N.layers[0], S = N.state.renderers[0];
    const since = L && L.closedAt !== null && S && S.drawnAt ? L.closedAt - S.drawnAt : NaN;
    t('no eyes ever: back to 2D (layer closed, not active)', L && L.closedAt !== null && S && !S.active && !S.releasing, `layers ${N.layers.length}, closedAt ${L && L.closedAt}, active ${S && S.active}, frames without views ${N.noViewFrames}`);
    t(`... noViewsMs (${c.cfg.noViewsMs} ms) after the FIRST DRAW, not before`, since >= c.cfg.noViewsMs && since < c.cfg.noViewsMs + 1000, `closed ${since.toFixed(0)} ms after the first draw (layer at ${L && L.at.toFixed(0)}, first draw at ${S && S.drawnAt && S.drawnAt.toFixed(0)})`);
    t('console names the reason', r.log.some((l) => /back to 2D: no 2-view frame within 1500 ms/.test(l)), '');
    return A;
  }
  if (c.expect === 'idle') {
    t('no session requested', fake.sessions === 0, `sessions=${fake.sessions}`);
    t('nothing converted', state && state.renderers.every((x) => !x.active), `renderers=${state && state.renderers.length}`);
    t('site switch reported', state && state.enabled === false, `enabled=${state && state.enabled}`);
    return A;
  }
  if (c.expect === 'standdown') {
    t('page owns inline-3d: shim stood down', state && /inline-3d/.test(state.foreign || ''), `foreign=${state && state.foreign}`);
    t('shim opened no session of its own', fake.sessions === 1, `sessions=${fake.sessions} (the SDK's)`);
    t('nothing converted by the shim', state && state.renderers.every((x) => !x.active && !x.pending), `renderers=${state && state.renderers.map((x) => x.engine).join(',')}`);
    t('HUD says it stood down', /standing down \(the page requested 'inline-3d'\)/.test(r.hud || ''), `hud="${r.hud}"`);
    return A;
  }
  t(`converted within ${(c.timeoutMs || 60000) / 1000} s`, r.ok, `${r.ms} ms`);
  if (c.lateViews) {
    const S = state && state.renderers.find((x) => x.active);
    t('late first draw + late eyes: ONE layer, never a false no-views stand-down', fake.layers === 1 && !r.log.some((l) => /no 2-view frame/.test(l)),
      `layers ${fake.layers}, sessions ${fake.sessions}; timer started at the first draw, ${S && S.drawnAt ? (S.drawnAt - r.stall.from).toFixed(0) : '?'} ms into the page's ${r.stall.ms} ms stall` + (r.log.find((l) => /no 2-view frame/.test(l)) ? `; ${r.log.find((l) => /no 2-view frame/.test(l))}` : ''));
  }
  const R = state && state.renderers.find((x) => x.active);
  if (!R || !pixels) return A;
  const [rw, rh] = R.real, [ew, eh] = R.eye || [rw / 2, rh]; // the pre-split script does not report the eye
  t('SBS store = 2 × eye width', rw === 2 * ew && rh === eh, `store ${rw}x${rh}, eye ${ew}x${eh}, page sees ${JSON.stringify(R.page)}`);
  if (R.engine === 'three.js') t('page still sees its mono canvas.width', R.page.canvasWidthSeenByPage === Math.floor(R.page.w * R.page.pr), `canvas.width seen by page = ${R.page.canvasWidthSeenByPage}`);
  const sh = bestShift(pixels.px, pixels.w, pixels.h, ew);
  const want = Math.round(0.1 * ew);
  t('halves differ', sh.zeroErr > 1, `MAE(left, right) at shift 0 = ${sh.zeroErr.toFixed(2)}`);
  t(`right half = left half shifted ${want} px`, Math.abs(sh.s - want) <= 1, `best shift ${sh.s} px (residual ${sh.e.toFixed(2)})`);
  t('HUD counters: stereo > 0, no flat scene frame after eyes', R.stats.stereo > 0 && (R.stats.flatAfterEyes ?? 0) === 0, `3D ${R.stats.stereo} · flat ${R.stats.flat} · flatAfterEyes ${R.stats.flatAfterEyes} · replay ${R.stats.replays} · twoView ${R.stats.twoView}`);
  const rig = fake.lastRig || {};
  const d = R.convergence;
  const rigOk = rig.type === 'camera' && Math.abs(rig.verticalFov - (c.fovDeg * Math.PI) / 180) < 1e-6 && Math.abs(rig.convergenceDiopters - 1 / d) < 1e-3 * (1 / d) &&
    Math.abs(rig.metersToVirtual - (0.5 * d) / 0.5) < 1e-3 * d && rig.ipdFactor === 1 && rig.parallaxFactor === 1;
  t('rig pushed: camera, page fov, 1/d, 0.5·d/0.5, ipd/parallax 1', rigOk, `type=${rig.type} vfov=${(rig.verticalFov * 180 / Math.PI).toFixed(3)}° diopters=${rig.convergenceDiopters?.toFixed(5)} m2v=${rig.metersToVirtual?.toFixed(4)} ipd=${rig.ipdFactor} parallax=${rig.parallaxFactor} pushes=${fake.frames}`);
  const exp = fake.expected;
  t('convergence ≈ known subject distance (±5 %)', exp && Math.abs(d - exp) / exp < 0.05, `estimated ${d.toFixed(3)}, expected ${exp && exp.toFixed(3)}, source ${R.convergenceSource}${R.convergenceVia ? ' (' + R.convergenceVia + ')' : ''}`);
  if (fake.expectedSource) {
    t(`convergence source = '${fake.expectedSource}', on the HUD and in state()`, R.convergenceSource === fake.expectedSource && (r.hud || '').includes(`(${fake.expectedSource})`),
      `state ${R.convergenceSource} via ${R.convergenceVia}; hud "${r.hud}"`);
  }
  if (R.engine === 'PlayCanvas') {
    t('PlayCanvas app detected', !!R.detection, `via ${R.detection}; RenderView ${R.renderView}; device ${R.device}; footprint patched ${R.footprint.patched}/${R.footprint.seen}`);
    if (c.id === 'c') t('gsplat footprint shader patched', R.footprint.patched > 0, `${R.footprint.patched} shader(s)`);
  }
  if (c.parityOf) {
    const other = results.find((x) => x.c.id === c.parityOf);
    if (other && other.pixels && other.pixels.px.length === pixels.px.length) {
      const m = mae(other.pixels.px, pixels.px);
      t(`parity with case ${c.parityOf} (byte-identical frame)`, m === 0, `MAE ${m.toFixed(3)}, ${diffCount(other.pixels.px, pixels.px)} bytes differ of ${pixels.px.length}`);
      const oR = other.state.renderers.find((x) => x.active);
      t(`parity with case ${c.parityOf} (rig + counters)`, JSON.stringify(oR.rig) === JSON.stringify(R.rig) && oR.convergence === R.convergence,
        `rig ${JSON.stringify(oR.rig) === JSON.stringify(R.rig) ? 'identical' : 'DIFFERS'}, convergence ${oR.convergence} vs ${R.convergence}`);
    } else t(`parity with case ${c.parityOf}`, false, 'no frame to compare');
  }
  if (c.killAfter) {
    const a = r.after, S = a && a.state.renderers[0];
    t('Ctrl+Alt+3: back to 2D' + (R.engine === 'PlayCanvas' ? ', xrViews released' : ''), a && !a.state.enabled && S && !S.active && !S.releasing && (R.engine !== 'PlayCanvas' || S.camera === null),
      `enabled=${a && a.state.enabled} active=${S && S.active} releasing=${S && S.releasing} camera=${S && S.camera} hud="${a && a.hud}"`);
    if (a) {
      const sh2 = bestShift(a.px, a.w, a.h, a.w / 2);
      t('after stand-down the canvas is one mono view (no SBS pair)', sh2.e > 2, `store ${a.w}x${a.h}; best half-to-half match residual ${sh2.e.toFixed(2)} (an SBS pair matches at ~0)`);
      const cl = a.closes && a.closes[0];
      const rp = cl ? rawPairAtClose(cl) : null;
      t('turn-off: no raw side-by-side frame once the layer is closed (commit model)', rp && rp.frames >= 3 && rp.discriminates && rp.bad.length === 0,
        rp ? `${rp.frames} committed frames from close(); pair residual: at close ${rp.atClose.toFixed(2)}, pair baseline ${rp.pairBase.toFixed(2)}, mono baseline ${rp.monoBase.toFixed(2)}; raw pairs at frames [${rp.bad.map((b) => b.i).join(', ')}]` : 'layer never closed');
      // The session here is FAKE, so drawImage() of the canvas would not be empty in this harness
      // (on the panel it is: the canvas has an XRDisplayLayer bound). This mostly guards the
      // readPixels path from regressing to a blank cover; an empty eye PNG is ~10-130 KB.
      const oc = a.outCover;
      // A size floor alone is page-dependent (these test scenes compress to 60-170 KB even when real),
      // so it is ORed with a content check: textured (std) and matching the mono canvas right way up.
      const k = oc && oc.cmp;
      const real = oc && (oc.srcLen > 200000 || (k && k.std > 4 && k.mae < 12 && 3 * k.mae < k.maeFlipped));
      t('out-cover holds a real picture (not the empty drawImage of a layer-bound canvas)', real,
        oc ? `data URL ${oc.srcLen} chars, ${oc.naturalWidth}x${oc.naturalHeight}` + (k ? `; vs mono canvas MAE ${k.mae.toFixed(2)} (flipped ${k.maeFlipped.toFixed(2)}), luma std ${k.std.toFixed(1)}` : '')
          : 'no out-cover <img> was inserted');
      const re = a.reenable;
      t('Ctrl+Alt+3 again on a page that no longer draws: 3D again within 4 s', re && re.again && re.frozen, re ? `${re.again ? 're-converted' : 'still 2D'} after ${re.ms} ms; sessions ${re.sessions}; page frozen ${re.frozen} at ${re.pageFrames} frames` : 'n/a');
    }
  }
  if (c.displayAfter) {
    const D = r.display, g = D && D.rig, S = D && D.state.renderers.find((x) => x.active);
    const dd = S ? S.convergence : NaN, fov = (c.fovDeg * Math.PI) / 180;
    const want = 2 * dd * Math.tan(fov / 2);
    const near = (a, b) => Math.abs(a - b) < 1e-9;
    const hudDepth = (h) => ((h || '').match(/depth (\d+\.\d+)/) || [])[1];
    t('Ctrl+Alt+P: display rig declared (portal on the convergence plane, framed by the page FOV) at ITS default depth 1.0: ipd = parallax = 1',
      g && g.type === 'display' && Math.abs(g.position.z + dd) < 1e-3 * dd && g.position.x === 0 && g.position.y === 0 && g.orientation.w === 1 &&
      Math.abs(g.virtualDisplayHeight - want) < 1e-3 * want && near(g.ipdFactor, 1) && near(g.parallaxFactor, 1) && g.perspectiveFactor === 1 && !('verticalFov' in g) &&
      near(D.state.depth, 1) && hudDepth(D.hud) === '1.00',
      g ? `type=${g.type} pos=(${g.position.x},${g.position.y},${g.position.z.toFixed(3)}) vdh=${g.virtualDisplayHeight?.toFixed(4)} (want ${want.toFixed(4)}) ipd=${g.ipdFactor} parallax=${g.parallaxFactor} persp=${g.perspectiveFactor}; state depth ${D.state.depth}, HUD depth ${hudDepth(D.hud)}` : 'no rig');
    t('display rig on the HUD, in state() and remembered for the site', D && D.state.rigMode === 'display' && /display rig/.test(D.hud || '') && JSON.parse(D.stored || '{}').rig === 'display',
      `rigMode=${D && D.state.rigMode} hud="${D && D.hud}" stored=${D && D.stored}`);
    const C = D && D.cam, cg = C && C.rig, cd = C && C.state.renderers.find((x) => x.active);
    t('camera rig, Ctrl+Alt+-: depth 0.5 -> 0.4 (m2v = 0.4·d/0.5), HUD + state()', cg && cg.type === 'camera' && near(C.state.depth, 0.4) && Math.abs(cg.metersToVirtual - (0.4 * cd.convergence) / 0.5) < 1e-6 * cd.convergence && hudDepth(C.hud) === '0.40',
      cg ? `depth ${C.state.depth}, m2v ${cg.metersToVirtual} (want ${((0.4 * cd.convergence) / 0.5).toFixed(6)}), HUD depth ${hudDepth(C.hud)}` : 'n/a');
    const dn = D && D.down, dg = dn && dn.rig;
    t('display rig, Ctrl+Alt+-: ONE joint control, ipdFactor = parallaxFactor = depth = 0.8; the camera rig keeps 0.4',
      dg && dg.type === 'display' && near(dg.ipdFactor, 0.8) && near(dg.parallaxFactor, 0.8) && near(dn.state.depth, 0.8) && hudDepth(dn.hud) === '0.80' && near(dn.state.depths.camera, 0.4) && near(dn.state.depths.display, 0.8),
      dg ? `ipd ${dg.ipdFactor}, parallax ${dg.parallaxFactor}, depths ${JSON.stringify(dn.state.depths)}, HUD depth ${hudDepth(dn.hud)}` : 'n/a');
    const up = D && D.up, ug = up && up.rig;
    t('display rig, Ctrl+Alt+= twice from 0.8: 1.0, then capped at 1.0 (the runtime\'s display-rig limit)', ug && near(ug.ipdFactor, 1) && near(ug.parallaxFactor, 1) && near(up.state.depth, 1),
      ug ? `ipd ${ug.ipdFactor}, parallax ${ug.parallaxFactor}, depth ${up.state.depth}` : 'n/a');
    const b = D && D.back, bg = b && b.rig, bd = b && b.state.renderers.find((x) => x.active);
    t('Ctrl+Alt+P again: back to the camera rig WITH its own depth 0.4 (not the display rig\'s 0.8)',
      bg && bg.type === 'camera' && b.state.rigMode === 'camera' && near(b.state.depth, 0.4) && Math.abs(bg.metersToVirtual - (0.4 * bd.convergence) / 0.5) < 1e-6 * bd.convergence && hudDepth(b.hud) === '0.40',
      bg ? `type=${bg.type} rigMode=${b.state.rigMode} depth ${b.state.depth} m2v ${bg.metersToVirtual} HUD depth ${hudDepth(b.hud)}` : 'n/a');
    const ag = D && D.again && D.again.rig;
    t('Ctrl+Alt+P once more: the display rig restores ITS 0.8', ag && ag.type === 'display' && near(ag.ipdFactor, 0.8) && near(ag.parallaxFactor, 0.8) && near(D.again.state.depth, 0.8),
      ag ? `ipd ${ag.ipdFactor}, parallax ${ag.parallaxFactor}, depth ${D.again.state.depth}` : 'n/a');
    const rl = D && D.reloaded, st = D && JSON.parse(D.again.stored || '{}');
    t('depth stored per site PER RIG: localStorage and a reload give camera 0.4, display 0.8', rl && near(rl.depths.camera, 0.4) && near(rl.depths.display, 0.8) && st.depths && near(st.depths.camera, 0.4) && near(st.depths.display, 0.8) && !('depth' in st),
      `stored ${D && D.again.stored}; after reload ${JSON.stringify(rl)}`);
  }
  t('frame stable across two reads', diffCount(pixels.px, pixels.px2) === 0, `${diffCount(pixels.px, pixels.px2)} bytes differ`);
  if (c.alsoCheck) c.alsoCheck(r, t, HELPERS, R); // a case's own assertions ON TOP of the generic ones
  return A;
}

// Finding 5: loaders/glb. The session and the layer are released on every orthographic phase (the
// panel goes back to 2D), so the browser's join is NOT kept across the flip, and every perspective
// phase is a fresh layer that gets the full join-window cover. Pinned here, deliberately: see the
// README, "Cameras that switch projection".
function checkFlip(r, t, A) {
  const S = r.samples;
  const orthoLate = S.filter((s) => s.phase.ortho && s.t - s.phase.since > 700);
  const perspPhases = new Set(S.filter((s) => !s.phase.ortho && s.active).map((s) => s.phase.flips));
  t('orthographic phases are 2D (no live layer)', orthoLate.length > 5 && orthoLate.every((s) => !s.active && !s.releasing), `${orthoLate.length} samples > 700 ms into an ortho phase, active in ${orthoLate.filter((s) => s.active).length}`);
  t('every perspective phase goes 3D', perspPhases.size >= 3, `3D seen in perspective phases ${[...perspPhases].join(', ')}`);
  const L = r.fake.layers;
  t('each perspective phase is a fresh session + layer (released on ortho)', L.length >= 3 && L.slice(0, -1).every((l) => l.closedAt !== null), `layers ${L.length}, closed ${L.filter((l) => l.closedAt !== null).length}`);
  t('so each fresh layer gets the full join-window cover', L.length >= 2 && L.every((l) => l.coverAtCreate), `cover up at layer creation: ${L.map((l) => l.coverAtCreate).join(', ')}`);
  const rps = r.fake.closes.map(rawPairAtClose);
  t('camera switch: no raw side-by-side frame once each layer is closed (commit model)', rps.length >= 2 && rps.every((x) => x.discriminates && x.bad.length === 0),
    rps.map((x) => `at close ${x.atClose.toFixed(2)} (pair ${x.pairBase.toFixed(2)}, mono ${x.monoBase.toFixed(2)}), raw pairs [${x.bad.map((b) => b.i).join(', ')}]`).join(' | '));
  t('console names the reason', r.log.some((l) => /back to 2D: the camera is orthographic/.test(l)), '');
  return A;
}

// What a case's own run() / check() / alsoCheck() may use. Case hooks: before(page) runs before
// page.goto; probe (a page function) is evaluated right after settling (r.probe); alsoCheck(r, t, h, R)
// adds assertions after the generic 'convert' ones (R = the active renderer).
const HELPERS = { sleep: (ms) => new Promise((r) => setTimeout(r, ms)), lum, mae, diffCount, bestShift, pairResidual, rawPairAtClose, W, H };

// ------------------------------------------------------------ main
const only = process.argv.slice(2);
// Preflight: every engine file the pages import, and the browser. Missing ones fail HERE, loudly,
// instead of as pages that never convert (a 60 s timeout per case).
const DEP_FILES = ['three/three.module.js', 'three/three.core.js', 'three/OrbitControls.js', 'playcanvas/playcanvas.mjs', 'playcanvas/camera-controls.mjs', 'three/Pass.js', 'spark/spark.module.js'];
const missingDeps = DEP_FILES.filter((f) => !existsSync(join(here, '.deps', f)));
if (missingDeps.length) {
  console.error(`FAILED: engine files missing from ${join(here, '.deps')}: ${missingDeps.join(', ')}\n` +
    'Run `node deps.mjs` (npm pack from the registry), or point it at local copies: THREE_BUILD_DIR, PLAYCANVAS_MJS, THREE_ORBIT_CONTROLS, PLAYCANVAS_CAMERA_CONTROLS, THREE_PASS_JS, SPARK_DIST (see deps.mjs).');
  process.exit(2);
}
if (!existsSync(CHROME)) { console.error(`FAILED: no Chrome at ${CHROME} — set CHROME=<binary>`); process.exit(2); }
let running = '';
if (!WIN) { try { running = execFileSync('sh', ['-c', 'ps aux | grep -- --headless=new | grep -v grep || true'], { encoding: 'utf8' }).trim(); } catch { /* no ps */ } }
if (running) console.warn('WARNING: another headless Chrome is running — GPU contention can skew timings:\n' + running.split('\n').slice(0, 3).join('\n'));
const srv = await serve();
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: [`--use-angle=${ANGLE}`, '--enable-gpu', '--ignore-gpu-blocklist', '--no-sandbox', `--window-size=${W},${H}`, '--hide-scrollbars', '--force-device-scale-factor=1', '--disable-features=OpenXR,WebXR'],
});
const results = [];
let failed = 0;
try {
  const gpu = await (async () => { const p = await browser.newPage(); const g = await p.evaluate(() => { const gl = document.createElement('canvas').getContext('webgl2'); const d = gl && gl.getExtension('WEBGL_debug_renderer_info'); return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'n/a'; }); await p.close(); return g; })();
  console.log(`GPU: ${gpu}\n`);
  for (const c of CASES) {
    if (only.length && !only.includes(c.id) && !(c.parityOf && only.includes(c.parityOf))) continue;
    if (c.skip) { console.log(`— ${c.id} ${c.name}: SKIPPED (${c.skip})\n`); continue; }
    const r = await runCase(browser, base, c);
    results.push(r);
    const A = check(r, results);
    const bad = A.filter((a) => !a.pass).length;
    failed += bad;
    console.log(`${bad ? '✗' : '✓'} ${c.id} ${c.name}  (${r.ms} ms)`);
    for (const a of A) console.log(`   ${a.pass ? 'pass' : 'FAIL'}  ${a.name} — ${a.detail}`);
    const errs = r.log.filter((l) => /pageerror|\[error\]/.test(l));
    if (errs.length) console.log('   page errors:\n     ' + errs.slice(0, 5).join('\n     '));
    if (bad || process.env.VERBOSE) console.log('   console:\n     ' + r.log.filter((l) => /dxr-auto3d/.test(l)).slice(0, 14).join('\n     '));
    if (process.env.KEEP && r.pixels) {
      mkdirSync(join(here, 'out'), { recursive: true });
      writeFileSync(join(here, 'out', `${c.id}.png`), Buffer.from(r.pixels.png.split(',')[1], 'base64'));
    }
    console.log('');
  }
} finally {
  await browser.close();
  srv.close();
}
console.log(failed ? `${failed} assertion(s) FAILED` : 'all assertions passed');
process.exit(failed ? 1 : 0);

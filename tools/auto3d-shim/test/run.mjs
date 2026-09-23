// Headless harness for tools/auto3d-shim — no DisplayXR Browser, no display.
//
// Each page is loaded in real-GPU headless Chrome (puppeteer-core) with, injected by
// page.evaluateOnNewDocument (main world, before any page script — the same timing as the
// extension's MAIN-world document_start content scripts):
//   1. the harness config (window.__dxrAuto3DTestCfg),
//   2. fake-xr.js — a fake inline-3d session whose views carry a ±0.1 off-axis skew,
//   3. the shim: core.js, three-adapter.js, playcanvas-adapter.js (or, for the parity run, the
//      pre-split content.js from PR #47's commit 84b14f7, read out of git).
//
// Usage: node run.mjs [caseId…]      env: CHROME=<binary>  SOG_DIR=<dir with ports_25.sog>  KEEP=1 (write PNGs to test/out)
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = dirname(fileURLToPath(import.meta.url));
const shimDir = join(here, '..');
const repo = join(here, '..', '..', '..');
const LEGACY_COMMIT = '84b14f7';
const SOG_DIR = process.env.SOG_DIR || join(homedir(), 'Documents/GitHub/displayxr-gallery-pvt/public/bench');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
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
const NEW = ['core.js', 'three-adapter.js', 'playcanvas-adapter.js'].map((f) => readFileSync(join(shimDir, f), 'utf8'));
const LEGACY = [execFileSync('git', ['-C', repo, 'show', `${LEGACY_COMMIT}:tools/auto3d-shim/content.js`], { encoding: 'utf8' })];
const FAKE = readFileSync(join(here, 'fake-xr.js'), 'utf8');
const hasSog = existsSync(join(SOG_DIR, 'ports_25.sog'));
const P = '/tools/auto3d-shim/test/pages/';
const CASES = [
  { id: 'a', name: 'three.js keyframes', url: P + 'three-keyframes.html', shim: NEW, expect: 'convert', fovDeg: 40, ready: 'window.__frozen' },
  { id: 'a-legacy', name: 'three.js keyframes, pre-split content.js', url: P + 'three-keyframes.html', shim: LEGACY, expect: 'convert', fovDeg: 40, ready: 'window.__frozen', parityOf: 'a' },
  { id: 'a-off', name: 'three.js keyframes, site switched off', url: P + 'three-keyframes.html', shim: NEW, cfg: { enabled: false }, expect: 'idle', ready: 'window.__frozen' },
  { id: 'b', name: 'PlayCanvas meshes (ESM, no globals)', url: P + 'pc-mesh.html', shim: NEW, expect: 'convert', fovDeg: 40, ready: 'window.__frozen' },
  { id: 'b-kill', name: 'PlayCanvas meshes, Ctrl+Alt+3 while live (stand-down)', url: P + 'pc-mesh.html', shim: NEW, expect: 'convert', fovDeg: 40, ready: 'window.__frozen', killAfter: true },
  { id: 'c', name: 'PlayCanvas gsplat ports_25.sog', url: P + 'pc-gsplat.html', shim: NEW, expect: 'convert', fovDeg: 50, ready: 'window.__splatReady', minFrames: 700, skip: hasSog ? null : `no ports_25.sog in ${SOG_DIR}` },
  { id: 'd', name: 'SDK samples/splat (must stand down)', url: '/samples/splat/index.html?engine=playcanvas&url=/bench/ports_25.sog', shim: NEW, expect: 'standdown', skip: hasSog ? null : `no ports_25.sog in ${SOG_DIR}` },
];

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
  await page.evaluateOnNewDocument(`window.__dxrAuto3DTestCfg = ${JSON.stringify(c.cfg || {})};`);
  await page.evaluateOnNewDocument(FAKE);
  for (const s of c.shim) await page.evaluateOnNewDocument(s);
  const t0 = Date.now();
  await page.goto(base + c.url, { waitUntil: 'load', timeout: 60000 });
  const convertReady = `(() => { const s = window.__dxrAuto3D && window.__dxrAuto3D.state(); const r = s && s.renderers.find((x) => x.active);
    return !!(r && r.stats.twoView > ${c.minFrames || 90} && (${c.ready || 'true'})); })()`;
  const settle = c.expect === 'convert' ? convertReady : `(${c.ready || 'true'}) && performance.now() > 6000`;
  let ok = true;
  try { await page.waitForFunction(settle, { timeout: 60000, polling: 200 }); } catch { ok = false; }
  if (c.expect !== 'convert') await new Promise((r) => setTimeout(r, 1500));
  const state = await page.evaluate(() => (window.__dxrAuto3D ? window.__dxrAuto3D.state() : null));
  const fake = await page.evaluate(() => ({ sessions: window.__fakeXR.sessions.length, layers: window.__fakeXR.layers.length, lastRig: window.__fakeXR.lastRig, frames: window.__fakeXR.frames, expected: window.__expectedConvergence ?? null }));
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
  let after = null;
  if (c.killAfter && ok) {
    await page.keyboard.down('Control'); await page.keyboard.down('Alt'); await page.keyboard.press('Digit3');
    await page.keyboard.up('Alt'); await page.keyboard.up('Control');
    await new Promise((r) => setTimeout(r, 1000));
    after = await page.evaluate(() => ({ state: window.__dxrAuto3D.state(), hud: (document.querySelector('[data-dxr-auto3d-hud]') || {}).textContent || null }));
    // A page that renders on demand is asked for one repaint by the restore; read what is on the canvas now.
    const g = await page.evaluate(() => new Promise((res) => requestAnimationFrame(() => setTimeout(() => {
      const src = document.querySelector('canvas'); const c2 = document.createElement('canvas'); c2.width = src.width; c2.height = src.height;
      const x = c2.getContext('2d', { willReadFrequently: true }); x.drawImage(src, 0, 0);
      const d = x.getImageData(0, 0, c2.width, c2.height).data; let s = ''; for (let i = 0; i < d.length; i += 32768) s += String.fromCharCode.apply(null, d.subarray(i, i + 32768));
      res({ w: c2.width, h: c2.height, b64: btoa(s) });
    }, 0))));
    after.px = Buffer.from(g.b64, 'base64'); after.w = g.w; after.h = g.h;
  }
  await ctx.close();
  return { c, ok, ms: Date.now() - t0, state, fake, pixels, log, after };
}

// ------------------------------------------------------------ assertions
function check(r, results) {
  const { c, state, fake, pixels } = r;
  const A = [];
  const t = (name, pass, detail) => A.push({ name, pass: !!pass, detail });
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
    return A;
  }
  t('converted within 60 s', r.ok, `${r.ms} ms`);
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
    Math.abs(rig.metersToVirtual - (0.3 * d) / 0.5) < 1e-3 * d && rig.ipdFactor === 1 && rig.parallaxFactor === 1;
  t('rig pushed: camera, page fov, 1/d, 0.3·d/0.5, ipd/parallax 1', rigOk, `type=${rig.type} vfov=${(rig.verticalFov * 180 / Math.PI).toFixed(3)}° diopters=${rig.convergenceDiopters?.toFixed(5)} m2v=${rig.metersToVirtual?.toFixed(4)} ipd=${rig.ipdFactor} parallax=${rig.parallaxFactor} pushes=${fake.frames}`);
  const exp = fake.expected;
  t('convergence ≈ known subject distance (±5 %)', exp && Math.abs(d - exp) / exp < 0.05, `estimated ${d.toFixed(3)}, expected ${exp && exp.toFixed(3)}`);
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
    t('Ctrl+Alt+3: back to 2D, xrViews released', a && !a.state.enabled && S && !S.active && S.camera === null, `enabled=${a && a.state.enabled} active=${S && S.active} camera=${S && S.camera} hud="${a && a.hud}"`);
    if (a) {
      const sh2 = bestShift(a.px, a.w, a.h, a.w / 2);
      t('after stand-down the canvas is one mono view (no SBS pair)', sh2.e > 2, `store ${a.w}x${a.h}; best half-to-half match residual ${sh2.e.toFixed(2)} (an SBS pair matches at ~0)`);
    }
  }
  t('frame stable across two reads', diffCount(pixels.px, pixels.px2) === 0, `${diffCount(pixels.px, pixels.px2)} bytes differ`);
  return A;
}

// ------------------------------------------------------------ main
const only = process.argv.slice(2);
const running = execFileSync('sh', ['-c', 'ps aux | grep -- --headless=new | grep -v grep || true'], { encoding: 'utf8' }).trim();
if (running) console.warn('WARNING: another headless Chrome is running — GPU contention can skew timings:\n' + running.split('\n').slice(0, 3).join('\n'));
const srv = await serve();
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--no-sandbox', `--window-size=${W},${H}`, '--hide-scrollbars', '--force-device-scale-factor=1'],
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

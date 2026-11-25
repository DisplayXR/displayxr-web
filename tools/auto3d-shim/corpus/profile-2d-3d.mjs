// 2D vs 3D frame cost of one live PlayCanvas page (v0.7.10, #319): one page, toggled live, no panel.
//
// Real-GPU headless Chrome (ANGLE D3D11 / WebGPU, vsync and the frame-rate limit off, so the rate is
// what the GPU allows) at a panel-sized viewport (default 2560x1305 CSS at DPR 3: a maximised window on
// the 8K panel at 300 %). Injected at document start: ../test/fake-xr.js (two views, eyes ±3.2 cm, pixel
// aspect 2) and a built bundle (default ../dist; --dist <dir> for another build, e.g. an older one for
// A/B) through ../test/fake-host.js in DEV mode with the frame-rate guard off (guardFps 0), so 3D is
// never sent back. After --settle ms it alternates 2D (__dxrAuto3D.set('enabled', false)) and 3D for
// --rounds rounds of --phase ms each and prints, per phase: the engine's draw rate (postrender events over the
// phase's wall time; rAF callbacks stall for seconds on a GPU-bound WebGL page), app.tick CPU ms, draw calls, the
// splat count, the store size, the eye, and the engine's GPU profiler (device.gpuProfiler: the frame
// and, on WebGPU, per pass). --cpu adds a CDP CPU profile (top self time).
//
// Usage: node profile-2d-3d.mjs [--webgpu] [--url U] [--settle 45000] [--phase 8000] [--rounds 2] [--dpr 3]
//          [--w 2560 --h 1305] [--test '{"maxSbsWidth":2048}'] [--dist <dir>] [--cpu] [--out file.json]
//   env: CHROME=<binary>. Default URL: arrival.space/16538486_8412 (?webgpu=1 with --webgpu).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = dirname(fileURLToPath(import.meta.url));
const shim = join(here, '..');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const flag = (n) => argv.includes(n);
const WEBGPU = flag('--webgpu');
let URL0 = opt('--url', 'https://arrival.space/16538486_8412');
if (WEBGPU) URL0 += (URL0.includes('?') ? '&' : '?') + 'webgpu=1';
const SETTLE = +opt('--settle', 45000), PHASE = +opt('--phase', 8000);
const DPR = +opt('--dpr', 3), VW = +opt('--w', 2560), VH = +opt('--h', 1305);
const TEST = JSON.parse(opt('--test', '{}'));
const CPU = flag('--cpu');
const ROUNDS = +opt('--rounds', 2);
const OUT = opt('--out', null);
const DIST = opt('--dist', join(shim, 'dist'));

const read = (p) => readFileSync(p, 'utf8');
const SRC = { sentinel: read(join(DIST, 'auto3d-sentinel.js')) + '\n//# sourceURL=dxr-auto3d-sentinel.js', core: read(join(DIST, 'auto3d-core.js')) + '\n//# sourceURL=dxr-auto3d-core.js' };
const FAKE_XR = read(join(shim, 'test', 'fake-xr.js'));
const FAKE_HOST = read(join(shim, 'test', 'fake-host.js'));
const topOnly = (src) => `if (window === window.top) (0, eval)(${JSON.stringify(src)});`;

// In-page sampler: per rAF, app.tick CPU ms + engine stats; gpu pass timings.
const SAMPLER = `(() => {
  const S = window.__prof = { on: false, rows: [], gpu: new Map(), gpuN: 0, errs: [] };
  const findApp = () => { try { return (window.pc && (window.pc.app || (pc.AppBase && pc.AppBase.getApplication()))) || null; } catch (e) { return null; } };
  let hooked = null;
  function hook() {
    const app = findApp();
    if (!app || hooked === app || typeof app.tick !== 'function') return;
    hooked = app;
    const t0 = app.tick;
    const wrapped = function () { const a = performance.now(); try { return t0.apply(this, arguments); } finally { S.lastTick = performance.now() - a; } };
    app.tick = wrapped;
    S.app = app;
    S.renders = 0;
    app.on('postrender', () => { S.renders++; });
  }
  setInterval(hook, 500);
  let last = 0;
  function f() {
    requestAnimationFrame(f);
    const t = performance.now(); // not the rAF timestamp: with the frame-rate limit off it does not track wall time
    if (!S.on || !S.app) { last = t; return; }
    if (!S.t0) { S.t0 = t; S.f0 = S.app.frame; }
    S.t1 = t; S.f1 = S.app.frame;
    const app = S.app, fr = app.stats && app.stats.frame;
    const d = app.graphicsDevice;
    S.rows.push({ dt: last ? t - last : 0, tick: S.lastTick || 0, render: fr ? fr.renderTime : 0, update: fr ? fr.updateTime : 0,
      sort: fr ? fr.gsplatSort || 0 : 0, gsplats: fr ? fr.gsplats || 0 : 0, cams: fr ? fr.cameras : 0, dc: app.stats.drawCalls ? app.stats.drawCalls.total : 0,
      w: d.width, h: d.height, gpuFrame: d.gpuProfiler ? d.gpuProfiler._frameTime || 0 : 0 });
    const g = app.stats.gpu;
    if (g && g.size) { S.gpuN++; for (const [k, v] of g) S.gpu.set(k, (S.gpu.get(k) || 0) + v); }
    last = t;
  }
  requestAnimationFrame(f);
})();`;

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--no-sandbox', `--window-size=${VW},${VH + 135}`, '--hide-scrollbars', '--disable-features=OpenXR,WebXR',
    '--enable-webgpu-developer-features', '--disable-gpu-vsync', '--disable-frame-rate-limit'].concat(process.env.VSYNC ? [] : []),
  protocolTimeout: 120000,
});
const page = await browser.newPage();
await page.setViewport({ width: VW, height: VH, deviceScaleFactor: DPR });
await page.setBypassCSP(true);
await page.setUserAgent((await browser.userAgent()).replace('HeadlessChrome', 'Chrome'));
const logs = [];
page.on('console', (m) => { const t = m.text(); if (/auto3d|dxr|Destroyed|WebGPU|error/i.test(t)) logs.push(`[${m.type()}] ${t.slice(0, 400)}`); });
page.on('pageerror', (e) => logs.push('[pageerror] ' + String(e.message || e).slice(0, 300)));
await page.evaluateOnNewDocument(topOnly(`window.__fakeXROpts = ${JSON.stringify({ eyeX: 0.032, eyeZ: 0, pixelAspect: 2 })};`));
await page.evaluateOnNewDocument(topOnly(FAKE_XR));
await page.evaluateOnNewDocument(topOnly(SAMPLER));
await page.evaluateOnNewDocument(topOnly(`window.__dxrFakeHostSrc = ${JSON.stringify(SRC)}; window.__dxrFakeHostCfg = ${JSON.stringify({ decision: 'allow', dev: true, test: { guardFps: 0, hud: false, ...TEST } })};`));
await page.evaluateOnNewDocument(topOnly(FAKE_HOST));
const t0 = Date.now();
await page.goto(URL0, { waitUntil: 'load', timeout: 90000 }).catch((e) => logs.push('goto: ' + e.message));
console.log(`loaded in ${Date.now() - t0} ms; settling ${SETTLE} ms`);
await new Promise((r) => setTimeout(r, SETTLE));
await page.evaluate(() => { try { window.__dxrAuto3D.set('hud', false); } catch (e) {} });
const cdp = CPU ? await page.createCDPSession() : null;
if (cdp) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 250 }); }

async function state() { return page.evaluate(() => { try { const s = window.__dxrAuto3D.state(); const r = s.renderers.find((x) => x.engine === 'PlayCanvas') || s.renderers[0]; return r ? { active: r.active, real: r.real, eye: r.eye, css: r.css, why: r.why, flat: r.flatReason, pe: r.postEffects, haveViews: r.haveViews, stats: r.stats } : null; } catch (e) { return String(e); } }); }
async function setEnabled(v) { await page.evaluate((v) => window.__dxrAuto3D.set('enabled', v), v); }
async function waitActive(want, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const s = await state(); if (s && !!s.active === want) return s; await new Promise((r) => setTimeout(r, 300)); }
  return state();
}
function summarize(rows) {
  rows = rows.filter((r) => r.dt > 0);
  const n = rows.length; if (!n) return null;
  const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
  const med = (k) => { const v = rows.map((r) => r[k]).sort((a, b) => a - b); return v[Math.floor(n / 2)]; };
  return { frames: n, rafFps: +(1000 * n / sum('dt')).toFixed(1), dtMed: +med('dt').toFixed(1), tick: +(sum('tick') / n).toFixed(2), render: +(sum('render') / n).toFixed(2),
    update: +(sum('update') / n).toFixed(2), sort: +(sum('sort') / n).toFixed(2), gsplats: Math.round(sum('gsplats') / n), cams: +(sum('cams') / n).toFixed(2), dc: Math.round(sum('dc') / n),
    gpuFrame: +(sum('gpuFrame') / n).toFixed(2), size: `${rows[n - 1].w}x${rows[n - 1].h}` };
}
async function measure(label) {
  await page.evaluate(() => { const S = window.__prof; S.rows = []; S.gpu = new Map(); S.gpuN = 0; S.t0 = 0; S.on = true; S.w0 = performance.now(); S.wf0 = S.renders || 0; try { S.app.graphicsDevice.gpuProfiler.enabled = true; } catch (e) {} });
  if (cdp) await cdp.send('Profiler.start');
  await new Promise((r) => setTimeout(r, PHASE));
  let prof = null;
  if (cdp) prof = (await cdp.send('Profiler.stop')).profile;
  const got = await page.evaluate(() => { const S = window.__prof; S.on = false; const wall = performance.now() - S.w0; return { appFps: S.app ? +((1000 * (S.renders - S.wf0)) / wall).toFixed(1) : null, wallMs: Math.round(wall), rows: S.rows, gpu: [...S.gpu].map(([k, v]) => [k, +(v / Math.max(1, S.gpuN)).toFixed(2)]), gpuN: S.gpuN }; });
  const s = summarize(got.rows);
  const st = await state();
  const res = { label, appFps: got.appFps, wallMs: got.wallMs, ...s, gpuPasses: got.gpu.sort((a, b) => b[1] - a[1]).slice(0, 14), eye: st && st.eye, real: st && st.real, active: st && st.active };
  if (prof) res.cpuTop = topSelf(prof);
  console.log(JSON.stringify(res));
  return res;
}
function topSelf(p) {
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  const self = new Map();
  const dts = p.timeDeltas; let total = 0;
  for (let i = 0; i < p.samples.length; i++) {
    const n = byId.get(p.samples[i]); const d = dts[i] || 0; total += d;
    const cf = n.callFrame; const key = `${cf.functionName || '(anon)'} ${(cf.url || '').split('/').pop().slice(0, 40)}:${cf.lineNumber}`;
    self.set(key, (self.get(key) || 0) + d);
  }
  return [...self].sort((a, b) => b[1] - a[1]).slice(0, 18).map(([k, v]) => `${(100 * v / total).toFixed(1)}% ${k}`);
}

const out = { url: URL0, dpr: DPR, viewport: [VW, VH], test: TEST, phases: [] };
console.log('initial state', JSON.stringify(await state()));
for (let r = 0; r < ROUNDS; r++) {
  await setEnabled(false); await waitActive(false); await new Promise((r) => setTimeout(r, 1500));
  out.phases.push(await measure(`2D#${r}`));
  await setEnabled(true); const s = await waitActive(true, 30000); await new Promise((r) => setTimeout(r, 3500));
  if (!s || !s.active) console.log('not active:', JSON.stringify(s));
  out.phases.push(await measure(`3D#${r}`));
}
out.state = await state();
out.logs = logs;
console.log('state', JSON.stringify(out.state));
console.log('logs:\n' + logs.slice(0, 60).join('\n'));
if (OUT) writeFileSync(OUT, JSON.stringify(out, null, 1));
await browser.close();

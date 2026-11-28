// Live probe of the GL-level adapter on a page no engine adapter claims (a Sketchfab viewer), in stock
// headless Chrome with the dev build and the fake inline-3d session (fake-xr.js, the runtime model: a
// nominal viewer, eyes +-eyeX x m2v, off-axis frusta converged by the rig). Never the DisplayXR Browser,
// never the runtime. Saves the side-by-side store (the adapter's copy of the last frame) at rest, after a
// scripted orbit and after a scripted zoom, and measures the page's frame rate converted and in 2D under
// continuous scripted orbit.
//
// Usage: node probe-skf.mjs <url> [--tag name] [--iframe] [--secs 25] [--fps 6] [--dpr 1] [--out dir]
//   --iframe   load <url> inside a cross-origin iframe on a data: host page (the embed case)
// env: CHROME=<binary>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { build } from '../../build.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const url = argv.find((a) => /:\/\//.test(a));
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true); };
if (!url) { console.error('usage: node probe-skf.mjs <url> [--tag name] [--iframe]'); process.exit(2); }
const tag = opt('tag', 'skf'), secs = +opt('secs', 25), fpsSecs = +opt('fps', 6), dpr = +opt('dpr', 1), out = opt('out', join(here, 'out'));
mkdirSync(out, { recursive: true });
const WIN = process.platform === 'win32';
const CHROME = process.env.CHROME || (WIN ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/google-chrome');
const DEV = build(join(here, '..', '..')).files['dist/auto3d-dev.js'];
const FAKE = readFileSync(join(here, '..', 'fake-xr.js'), 'utf8');

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, defaultViewport: null,
  args: [`--use-angle=${WIN ? 'd3d11' : 'vulkan'}`, '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1280,800', '--hide-scrollbars',
    `--force-device-scale-factor=${dpr}`, '--disable-features=OpenXR,WebXR', '--mute-audio', '--no-first-run', '--no-default-browser-check', '--lang=en-US'],
});
const UA = (await browser.userAgent()).replace('HeadlessChrome', 'Chrome');
const page = await (await browser.createBrowserContext()).newPage();
await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: dpr });
await page.setUserAgent(UA);
const log = [];
page.on('console', (m) => { const t = m.text(); if (/dxr-auto3d/.test(t)) log.push(t.slice(0, 300)); });
await page.evaluateOnNewDocument(`window.__dxrAuto3DTestCfg = { rig: 'auto', coreGlass: true, guardFps: 0 }; window.__fakeXROpts = { nominal: [0, 0.1, 0.6], eyeX: 0.032 };`);
await page.evaluateOnNewDocument(FAKE);
await page.evaluateOnNewDocument(DEV);
let target = url;
if (opt('iframe', false)) {
  const host = `<!doctype html><title>host</title><body style="margin:0;background:#222"><iframe src="${url}" style="border:0;width:1280px;height:720px" allow="autoplay; fullscreen; xr-spatial-tracking"></iframe></body>`;
  target = 'data:text/html;base64,' + Buffer.from(host).toString('base64');
}
const t0 = Date.now();
try { await page.goto(target, { waitUntil: 'load', timeout: 60000 }); } catch (e) { console.log('goto:', String(e.message).slice(0, 200)); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// the frame the GL-level adapter drives
async function glFrame() {
  for (const f of page.frames()) {
    try { if (await f.evaluate(() => !!(window.__dxrAuto3D && window.__dxrAuto3D.state().renderers.some((r) => r.engine === 'WebGL')))) return f; } catch (e) { /* gone */ }
  }
  return null;
}
const stateOf = (f) => f.evaluate(() => { const r = window.__dxrAuto3D.state().renderers.find((x) => x.engine === 'WebGL'); return r && { active: r.active, why: r.why, flat: r.flatReason, real: r.real, eye: r.eye, page: r.page, conv: r.convergence, src: r.convergenceSource, via: r.convergenceVia, rig: r.rigNow, verdict: r.verdict, stats: r.stats, gl: r.gl, rampK: r.rampK }; });
let f = null, st = null;
const tEnd = Date.now() + secs * 1000;
while (Date.now() < tEnd) {
  f = f || await glFrame();
  if (f) { st = await stateOf(f).catch(() => null); if (st && st.active && st.stats.twoView > 90 && st.rampK === 1) break; }
  await sleep(500);
}
const report = { url, tag, iframe: !!opt('iframe', false), dpr, loadSecs: (Date.now() - t0) / 1000, live: !!(st && st.active), state: st, shots: {}, fps: null };
async function shot(name) {
  if (!f) return null;
  await sleep(1200); // the page settles (its own accumulation), the session redraws
  const g = await f.evaluate(() => window.__dxrGlGrab && window.__dxrGlGrab('copy'));
  if (!g) return null;
  const file = join(out, `${tag}-${name}.png`);
  writeFileSync(file, Buffer.from(g.png.split(',')[1], 'base64'));
  report.shots[name] = { file, w: g.w, h: g.h, state: await stateOf(f) };
  return file;
}
// the canvas's box in the top page's coordinates (the iframe at 0,0)
const box = f ? await f.evaluate(() => { const c = document.querySelector('canvas:not([data-dxr-auto3d-cover])'); const r = [...document.querySelectorAll('canvas')].map((c) => c.getBoundingClientRect()).sort((a, b) => b.width * b.height - a.width * a.height)[0]; return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null; }) : null;
const cx = box ? box.x + box.w / 2 : 640, cy = box ? box.y + box.h / 2 : 360;
async function drag(dx, dy, steps = 20) {
  await page.mouse.move(cx, cy); await page.mouse.down();
  for (let i = 1; i <= steps; i++) { await page.mouse.move(cx + (dx * i) / steps, cy + (dy * i) / steps); await sleep(25); }
  await page.mouse.up();
}
async function wheel(dy, n = 5) { await page.mouse.move(cx, cy); for (let i = 0; i < n; i++) { await page.mouse.wheel({ deltaY: dy }); await sleep(60); } }
if (report.live && opt('trace', false)) {
  await f.evaluate(() => window.__dxrGlTrace());
  await drag(30, 0, 5); await sleep(300);
  report.trace = await f.evaluate(() => window.__dxrGlTrace(true));
  writeFileSync(join(out, `${tag}-trace.json`), JSON.stringify(report.trace, null, 1));
}
if (report.live && opt('eval', false)) { await sleep(1000); const pr = f.evaluate(String(opt('eval'))); if (opt('evaldrag', false)) await drag(220, 40, 40); console.log('EVAL', JSON.stringify(await pr)); }
if (report.live) {
  await shot('rest');
  await drag(220, 40); await shot('orbit');
  await wheel(-240, 6); await shot('zoom-in');
  await wheel(+240, 10); await shot('zoom-out');
  // frame rate under continuous orbit: converted, then 2D (Ctrl+Alt+3 in the viewer's frame)
  const measure = async () => {
    const a = await stateOf(f), ta = Date.now();
    await page.mouse.move(cx, cy); await page.mouse.down();
    let i = 0;
    while (Date.now() - ta < fpsSecs * 1000) { i++; await page.mouse.move(cx + 140 * Math.cos(i / 15), cy + 50 * Math.sin(i / 15)); await sleep(16); }
    await page.mouse.up();
    const b = await stateOf(f), tb = Date.now();
    return { fps: +(((b.gl.frames - a.gl.frames) * 1000) / (tb - ta)).toFixed(1), frames: b.gl.frames - a.gl.frames, ms: tb - ta, active: b.active };
  };
  const on = await measure();
  await f.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit3', ctrlKey: true, altKey: true, bubbles: true })));
  await sleep(2500);
  const off = await measure();
  report.fps = { converted: on, flat2D: off };
}
report.log = log;
report.canvasBox = box;
writeFileSync(join(out, `${tag}-report.json`), JSON.stringify(report, null, 1));
await page.screenshot({ path: join(out, `${tag}-screen.png`) });
console.log(JSON.stringify({ live: report.live, why: st && (st.why || st.flat), state: st && { real: st.real, eye: st.eye, page: st.page, conv: st.conv, src: st.src, via: st.via, verdict: st.verdict, gl: st.gl }, shots: Object.keys(report.shots), fps: report.fps }, null, 1));
console.log(log.join('\n'));
await browser.close();

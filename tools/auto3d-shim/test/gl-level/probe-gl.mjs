// SPIKE: load a LIVE page in stock Google Chrome with gl-hook.js injected at document start in
// every frame, then dump WebGL statistics (mode=stats) or capture a per-draw-doubled side-by-side
// frame (mode=stereo). No DisplayXR Browser, no runtime, no logins.
//
// Usage: node probe-gl.mjs <url> [--mode stats|stereo] [--secs 20] [--sep 0.03] [--conv auto|<n>]
//          [--iframe] (load <url> inside a cross-origin iframe on a data: host page)
//          [--headed] (headed, window off-screen at -32000,-32000; default: new headless)
//          [--drag] (drag the mouse a little over the page centre after load)
//          [--out <dir>] [--tag <name>] [--noisolation] (keep cross-origin iframes in-process)
//          [--timing] (also measure frame time with and without the stereo doubling: two loads)
// env: CHROME=<binary>
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const url = argv.find((a) => !a.startsWith('--') && !/^\d|^auto$|^stats$|^stereo$/.test(a) && /:\/\//.test(a));
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true); };
if (!url) { console.error('usage: node probe-gl.mjs <url> [--mode stats|stereo] ...'); process.exit(2); }
const mode = opt('mode', 'stats'), secs = +opt('secs', 20), out = opt('out', join(here, 'out')), tag = opt('tag', 'probe');
mkdirSync(out, { recursive: true });
const WIN = process.platform === 'win32';
const CHROME = process.env.CHROME || (WIN ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/google-chrome');
const HOOK = readFileSync(join(here, 'gl-hook.js'), 'utf8');
const headed = !!opt('headed', false);

const args = [`--use-angle=${WIN ? 'd3d11' : 'vulkan'}`, '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader=false', '--window-size=1280,800',
  '--hide-scrollbars', '--force-device-scale-factor=1', '--disable-features=OpenXR,WebXR', '--mute-audio', '--no-first-run', '--no-default-browser-check', '--lang=en-US'];
if (headed) args.push('--window-position=-32000,-32000');
if (opt('noisolation', false)) args.push('--disable-site-isolation-trials', '--disable-features=IsolateOrigins,site-per-process,OpenXR,WebXR');
const browser = await puppeteer.launch({ executablePath: CHROME, headless: headed ? false : true, args, defaultViewport: null, ignoreDefaultArgs: opt('noautoflag', false) ? ['--enable-automation'] : [] });
const ver = await browser.version();
const UA = (await browser.userAgent()).replace('HeadlessChrome', 'Chrome');
const ctx = await browser.createBrowserContext();
const page = await ctx.newPage();
await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
await page.setUserAgent(UA);
const cons = [];
page.on('console', (m) => { const t = m.text(); if (cons.length < 40 && /webgl|gl_|error|context/i.test(t)) cons.push(t.slice(0, 200)); });
const cfg = { shiftVia: opt('shiftvia', 'viewport'), noSkew: !!opt('noskew', false), noTrans: !!opt('notrans', false), allStages: !!opt("allstages", false), mode, sep: +opt('sep', 0.03), conv: opt('conv', 'auto') === 'auto' ? 'auto' : +opt('conv') };
await page.evaluateOnNewDocument(`window.__glpCfg = ${JSON.stringify(cfg)}; window.__glpSrc = ${JSON.stringify(HOOK)};`);
if (!opt("nohook", false)) await page.evaluateOnNewDocument(HOOK);
// OOPIF check: puppeteer applies evaluateOnNewDocument to out-of-process iframes too (we verify
// per frame below: __glp present + installedAt + readyStateAtInstall).

let target = url;
if (opt('iframe', false)) {
  const host = `<!doctype html><title>host</title><body style="margin:0;background:#222"><iframe id=f src="${url}" style="border:0;width:1280px;height:720px" allow="autoplay; fullscreen; xr-spatial-tracking"></iframe></body>`;
  target = 'data:text/html;base64,' + Buffer.from(host).toString('base64');
}
const t0 = Date.now();
try { await page.goto(target, { waitUntil: 'load', timeout: 60000 }); } catch (e) { console.log('goto:', String(e.message).slice(0, 200)); }
if (opt('globe', false)) { // Google Maps: a fresh profile has 'Globe view' off (flat map). Turn it on (Layers > More > Globe view), then press '3D'.
  await new Promise((r) => setTimeout(r, 12000));
  await page.mouse.move(130, 660); await new Promise((r) => setTimeout(r, 1200));
  const more = await page.evaluate(() => { const el = [...document.querySelectorAll('button,[role=button],label,span,div')].filter((e) => e.childElementCount <= 2 && /^\s*More\s*$/.test(e.textContent || '')).map((e) => e.getBoundingClientRect()).filter((b) => b.width > 0 && b.y > 500)[0]; return el ? { x: el.x + el.width / 2, y: el.y + el.height / 2 } : null; });
  console.log('more:', JSON.stringify(more));
  if (more) { await page.mouse.move(more.x, more.y - 25); await new Promise((r) => setTimeout(r, 500)); await page.mouse.click(more.x, more.y - 25); }
  await new Promise((r) => setTimeout(r, 2500));
  await page.screenshot({ path: join(out, `${tag}-globe-panel.png`) });
  const find = () => page.evaluate(() => { const el = [...document.querySelectorAll('label')].find((e) => /^\s*Globe view\s*$/.test(e.textContent || '')); if (!el) return null; el.scrollIntoView(); const b = el.getBoundingClientRect(); const btn = el.closest('button'); return { x: b.x + b.width / 2, y: b.y + b.height / 2, checked: btn && btn.getAttribute('aria-checked') }; });
  let g = await find(); await new Promise((r) => setTimeout(r, 400)); g = await find();
  if (g && g.checked !== 'true') { await page.evaluate(() => { const b = document.querySelector('button[jsaction*="spherical"]'); if (b) b.click(); }); await new Promise((r) => setTimeout(r, 2500)); }
  console.log('globe view:', JSON.stringify(await find()));
  // close the panel (Escape), then the '3D' button by its text
  await page.keyboard.press('Escape'); await new Promise((r) => setTimeout(r, 1000));
  const b3 = await page.evaluate(() => { const el = [...document.querySelectorAll('button')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).find((e) => /^\s*3D\s*$/.test(e.textContent || '') || /^(Tilt|3D|Show 3D)/i.test(e.getAttribute('aria-label') || '')); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, label: el.getAttribute('aria-label'), text: el.textContent.trim().slice(0, 20) }; });
  console.log('3D button:', JSON.stringify(b3));
  if (b3) { await page.mouse.click(b3.x, b3.y); await new Promise((r) => setTimeout(r, 4000)); await page.screenshot({ path: join(out, `${tag}-after3d.png`) }); }
}
await new Promise((r) => setTimeout(r, secs * 1000));

async function glFrame() { // the frame that owns the biggest WebGL canvas
  let best = null;
  for (const f of page.frames()) {
    try {
      const r = await f.evaluate(() => window.__glp ? { n: window.__glp.contexts.length, area: Math.max(0, ...window.__glp.contexts.map((c) => c.w * c.h)) } : null);
      if (r && r.n && (!best || r.area > best.area)) best = { f, ...r };
    } catch (e) { /* frame gone */ }
  }
  return best && best.f;
}
if (opt('tilt', false)) { // Ctrl + drag up: Maps' tilt gesture
  const vp = page.viewport(); const cx = vp.width / 2 + 100, cy = vp.height / 2 + 100;
  await page.keyboard.down('Control'); await page.mouse.move(cx, cy); await page.mouse.down();
  for (let i = 1; i <= 20; i++) { await page.mouse.move(cx, cy - i * 10); await new Promise((r) => setTimeout(r, 40)); }
  await page.mouse.up(); await page.keyboard.up('Control');
  await new Promise((r) => setTimeout(r, +opt('tiltwait', 8) * 1000));
}
if (opt('drag', false)) {
  const vp = page.viewport();
  const cx = vp.width / 2, cy = vp.height / 2;
  await page.mouse.move(cx, cy); await page.mouse.down();
  for (let i = 1; i <= 15; i++) { await page.mouse.move(cx + i * 8, cy + i * 2); await new Promise((r) => setTimeout(r, 30)); }
  if (opt('shots', false)) await page.screenshot({ path: join(out, `${tag}-${mode}-middrag.png`) });
  await page.mouse.up();
  if (opt('shots', false)) {
    let last = 0;
    for (const ms of String(opt('shots')).split(',').map(Number)) { await new Promise((r) => setTimeout(r, ms - last)); last = ms; await page.screenshot({ path: join(out, `${tag}-${mode}-t${ms}.png`) }); }
  } else await new Promise((r) => setTimeout(r, 3000));
}
let measure = null;
if (opt('measure', false)) { // continuous camera motion for N s: the page must draw every frame
  const N = +opt('measure');
  const gf0 = await glFrame();
  const tStart = gf0 ? await gf0.evaluate(() => performance.now()) : 0;
  const vp = page.viewport(); const cx = vp.width / 2, cy = vp.height / 2;
  await page.mouse.move(cx, cy); await page.mouse.down();
  const t1 = Date.now(); let i = 0;
  while (Date.now() - t1 < N * 1000) { i++; await page.mouse.move(cx + 120 * Math.cos(i / 20), cy + 40 * Math.sin(i / 20)); await new Promise((r) => setTimeout(r, 16)); }
  await page.mouse.up();
  if (gf0) measure = await gf0.evaluate((t0, N) => {
    const fs = window.__glp.frames.filter((f) => f.ts > t0 + 300);
    const avg = (k) => +(fs.reduce((a, f) => a + f[k], 0) / Math.max(1, fs.length)).toFixed(2);
    const dts = []; for (let i = 1; i < fs.length; i++) dts.push(fs[i].ts - fs[i - 1].ts); dts.sort((a, b) => a - b);
    return { drawFrames: fs.length, fps: +(fs.length / (N - 0.3)).toFixed(1), dtMedian: dts[dts.length >> 1], dtP90: dts[Math.floor(dts.length * 0.9)], cpuMsAvg: avg('cpuMs'), drawsAvg: avg('draws') };
  }, tStart, N);
}
const frames = [];
for (const f of page.frames()) {
  try {
    const r = await f.evaluate(() => ({ url: location.href.slice(0, 140), hooked: !!window.__glp, installedAt: window.__glp && +window.__glp.installedAt.toFixed(1), readyStateAtInstall: window.__glp && window.__glp.readyStateAtInstall, contexts: window.__glp ? window.__glp.contexts.length : 0 }));
    frames.push(r);
  } catch (e) { frames.push({ url: f.url().slice(0, 140), error: String(e.message).slice(0, 120) }); }
}
const gf = await glFrame();
const summary = gf ? await gf.evaluate(() => window.__glp.summary(90)) : null;
const report = { measure, url, mode, chrome: ver, headed, iframe: !!opt('iframe', false), loadSecs: (Date.now() - t0) / 1000, frames, console: cons, summary };
const base = join(out, `${tag}-${mode}`);
writeFileSync(base + '.json', JSON.stringify(report, null, 1));
await page.screenshot({ path: base + '.png' });
console.log(JSON.stringify({ measure, frames, contexts: summary && summary.contexts, perFrame: summary && summary.perFrame, frameMsAvg: summary && summary.frameMsAvg, stereo: summary && summary.stereo, drawsPerFboSize: summary && summary.drawsPerFboSize, unseen: summary && summary.unseen, workers: summary && summary.workers, offscreen: summary && summary.offscreen, errors: summary && summary.errors }, null, 1));
console.log('wrote', base + '.json', base + '.png');
await browser.close();

// Probe a LIVE page with the dev shim in headless Chrome (fake inline-3d session, no display):
// what does auto-3D decide there, and why? Prints the [dxr-auto3d] console lines and the state.
// Usage: node probe-live.mjs <url> [seconds=25]      env: CHROME=<binary>, SHOT=<png path>
// Like run.mjs: real-GPU headless Chrome, --disable-features=OpenXR,WebXR (never the real runtime).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { build } from '../build.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const url = process.argv[2], secs = +process.argv[3] || 25;
if (!url) { console.error('usage: node probe-live.mjs <url> [seconds]'); process.exit(2); }
const WIN = process.platform === 'win32';
const CHROME = process.env.CHROME || (WIN ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/google-chrome');
const DEV = build(join(here, '..')).files['dist/auto3d-dev.js'];
const FAKE = readFileSync(join(here, 'fake-xr.js'), 'utf8');

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: [`--use-angle=${WIN ? 'd3d11' : 'vulkan'}`, '--enable-gpu', '--ignore-gpu-blocklist', '--no-sandbox', '--window-size=1280,720', '--hide-scrollbars', '--force-device-scale-factor=1', '--disable-features=OpenXR,WebXR', '--mute-audio'],
});
const page = await (await browser.createBrowserContext()).newPage();
await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
const log = [];
page.on('console', (m) => { const t = m.text(); if (/dxr-auto3d|gsplat surface/.test(t)) log.push(t.slice(0, 400)); });
await page.evaluateOnNewDocument(`window.__dxrAuto3DTestCfg = { rig: 'auto', coreGlass: true, guardFps: 0 }; window.__fakeXROpts = {};`);
await page.evaluateOnNewDocument(FAKE);
await page.evaluateOnNewDocument(DEV);
try { await page.goto(url, { waitUntil: 'load', timeout: 60000 }); } catch (e) { console.log('goto:', String(e.message).slice(0, 200)); }
await new Promise((r) => setTimeout(r, secs * 1000));
const states = [];
for (const f of page.frames()) {
  try {
    const s = await f.evaluate(() => {
      const A = window.__dxrAuto3D; if (!A) return null;
      const S = A.state();
      return { url: location.href.slice(0, 120), rigMode: S.rigMode, engines: S.engines, renderers: S.renderers.map((r) => ({ active: r.active, engine: r.engine, src: r.convergenceSource, via: r.convergenceVia, conv: r.convergence, open: r.openLatched, openWhy: r.openWhy, verdict: r.verdict, overlay: r.overlayTracked, glass: r.glass, scale: r.rigScale, flat: r.flatReason, real: r.real, eye: r.eye, stats: r.stats, renderer: r.renderer, clearPath: r.clearPath, gpuChain: r.gpuChain, ppSubs: r.ppSubs, ppTarget: r.ppTarget, gpuUnsplit: r.gpuUnsplit })) };
    });
    if (s && (s.renderers.length || s.engines.length)) states.push(s);
  } catch (e) { /* cross-origin frame gone */ }
}
// SHOT=<file.png>: a screenshot of the page at the end (the compositor's copy: a presented WebGPU
// canvas reads back empty from script, but not from the compositor).
if (process.env.SHOT) { try { await page.screenshot({ path: process.env.SHOT }); } catch (e) { console.log('screenshot:', String(e.message).slice(0, 200)); } }
console.log(log.join('\n'));
console.log(JSON.stringify(states, null, 1));
await browser.close();

// Load a live third-party URL with the dev shim and the fake inline-3d session, report what the shim
// did, and screenshot the page. A coverage probe, not a case: the site's content is not ours.
// Usage: node probe-url.mjs <url> [waitSeconds=20] [out.png]   env: CHROME=<binary>
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { build } from '../build.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const [url, waitS = '20', out = join(here, 'out', 'probe.png')] = process.argv.slice(2);
if (!url) { console.error('usage: node probe-url.mjs <url> [waitSeconds] [out.png]'); process.exit(2); }
const WIN = process.platform === 'win32';
const CHROME = process.env.CHROME || (WIN ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/google-chrome');
const shim = build(join(here, '..')).files['dist/auto3d-dev.js'];
const FAKE = readFileSync(join(here, 'fake-xr.js'), 'utf8');

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: [`--use-angle=${WIN ? 'd3d11' : 'vulkan'}`, '--enable-gpu', '--ignore-gpu-blocklist', '--no-sandbox', '--window-size=1280,720', '--hide-scrollbars', '--force-device-scale-factor=1', '--disable-features=OpenXR,WebXR'],
  defaultViewport: { width: 1280, height: 720 },
});
const page = await browser.newPage();
const log = [];
page.on('console', (m) => log.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => log.push(`[pageerror] ${e.message}`));
await page.evaluateOnNewDocument(`window.__dxrAuto3DTestCfg = { guardFps: 5 }; window.__fakeXROpts = {};`);
await page.evaluateOnNewDocument(FAKE);
await page.evaluateOnNewDocument(shim);
await page.goto(url, { waitUntil: 'load', timeout: 60000 }).catch((e) => log.push(`[goto] ${e.message}`));
await new Promise((r) => setTimeout(r, +waitS * 1000));
if (process.env.CLICK_AT) {
  // A real mouse click at x,y (CSS px): a user gesture, for sites that start on one.
  const [x, y] = process.env.CLICK_AT.split(',').map(Number);
  await page.mouse.click(x, y);
  log.push('[dxr-probe] clicked at ' + x + ',' + y);
  await new Promise((r) => setTimeout(r, +(process.env.AFTER || 15) * 1000));
}
if (process.env.CLICK) {
  // Click the first button / link whose text matches CLICK (a site's 'Enter' / 'Start'), then wait again.
  const hit = await page.evaluate((re) => { const rx = new RegExp(re, 'i'); const el = [...document.querySelectorAll('button, a, [role=button], div, span')].find((e) => rx.test(e.textContent.trim()) && e.children.length === 0); if (!el) return false; el.click(); return el.textContent.trim(); }, process.env.CLICK);
  log.push('[dxr-probe] clicked: ' + hit);
  await new Promise((r) => setTimeout(r, +(process.env.AFTER || 15) * 1000));
}
const st = await page.evaluate(() => {
  const s = window.__dxrAuto3D && window.__dxrAuto3D.state();
  if (!s) return null;
  return { renderers: s.renderers.map((r) => ({ active: r.active, label: r.label, why: r.why || r.unqualified || r.flatReason || null, stats: r.stats, R: r.R, clearPath: r.clearPath, gpuChain: r.gpuChain, convergence: r.convergence, convergenceSource: r.convergenceSource })) };
}).catch((e) => ({ error: e.message }));
await page.screenshot({ path: out }).catch((e) => log.push(`[screenshot] ${e.message}`));
console.log(JSON.stringify(st, null, 1));
console.log(log.filter((l) => /dxr|error|warn/i.test(l)).slice(0, 40).join('\n'));
console.log('screenshot:', out);
await browser.close();

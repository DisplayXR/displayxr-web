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
if (process.env.TSLDUMP) await page.evaluateOnNewDocument(() => { Error.stackTraceLimit = 100; const e = console.error; console.error = function (...a) { if (/TSL|NodeBuilder/.test(String(a[0]))) e.call(console, '[stack] ' + new Error().stack.split(String.fromCharCode(10)).slice(2, 60).filter((x) => /dxr|auto3d|Pipeline|PassNode|TRAA|GTAO|animate|updateBefore|chrome-extension/.test(x)).map((x) => x.trim().replace(/https:\/\/threejs\.org\//, '')).join(' < ')); return e.apply(console, a); }; });
if (process.env.TSLDUMP) page.on('console', async (m) => { if (/TSL|NodeBuilder/.test(m.text())) { for (const a of m.args()) { try { log.push('[arg] ' + await a.evaluate((x) => (x && x.stack) ? x.stack : String(x))); } catch (e) { /* gone */ } } } });
await page.evaluateOnNewDocument(`window.__dxrAuto3DTestCfg = { guardFps: 5, ...${process.env.CFG || '{}'} }; window.__fakeXROpts = {};`);
if (process.env.COPYLOG) await page.evaluateOnNewDocument(() => { const o = GPUCommandEncoder.prototype.copyTextureToTexture; let n = 0; GPUCommandEncoder.prototype.copyTextureToTexture = function (s, d, size) { const S = s.texture, D = d.texture; if (n < 6 && (S.width !== D.width || S.height !== D.height)) { n++; console.log('[dxr-copylog] ' + S.label + ' ' + S.width + 'x' + S.height + ' ' + S.format + ' -> ' + D.label + ' ' + D.width + 'x' + D.height + ' ' + D.format + ' size ' + JSON.stringify(size) + ' ' + new Error().stack.split(String.fromCharCode(10)).slice(2, 6).map((x) => x.trim().slice(0, 90)).join(' < ')); } return o.call(this, s, d, size); }; });
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
if (process.env.STACK) console.log('STACK', JSON.stringify(await page.evaluate(() => document.elementsFromPoint(innerWidth / 2, innerHeight / 2).map((e) => { const s = getComputedStyle(e); return [e.tagName, e.id || String(e.className).slice(0, 30), 'z' + s.zIndex, 'op' + s.opacity, s.backgroundColor]; }))));
await page.screenshot({ path: out }).catch((e) => log.push(`[screenshot] ${e.message}`));
console.log(JSON.stringify(st, null, 1));
console.log(log.filter((l) => /dxr|error|warn/i.test(l)).slice(0, 40).join('\n'));
console.log('GPU validation errors:', log.filter((l) => /GPUValidationError/.test(l)).length, '| THREE.TSL errors:', log.filter((l) => /THREE.TSL/.test(l)).length);
if (process.env.TSLDUMP) console.log(log.filter((l) => /THREE.TSL|NodeBuilder|^\[arg\]/.test(l)).join('\n---\n'));
console.log('screenshot:', out);
await browser.close();

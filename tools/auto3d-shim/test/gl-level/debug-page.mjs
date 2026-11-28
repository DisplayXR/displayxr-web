// Debug: serve the repo, open a test page with the dev build + fake XR, print state over time.
import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { build } from '../../build.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..', '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript' };
const srv = createServer((req, res) => { const f = normalize(join(repo, decodeURIComponent(new URL(req.url, 'http://x').pathname))); try { if (!statSync(f).isFile()) throw 0; res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream' }); res.end(readFileSync(f)); } catch { res.writeHead(404); res.end(); } });
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${srv.address().port}/tools/auto3d-shim/test/pages/${process.argv[2] || 'globe-tiles.html'}`;
const DEV = build(join(here, '..', '..')).files['dist/auto3d-dev.js'];
const FAKE = readFileSync(join(here, '..', 'fake-xr.js'), 'utf8');
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1280,720', '--force-device-scale-factor=1', '--disable-features=OpenXR,WebXR'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
page.on('console', (m) => console.log('  console:', m.text().slice(0, 300)));
page.on('pageerror', (e) => console.log('  PAGEERROR', e.message));
await page.evaluateOnNewDocument(`window.__dxrAuto3DTestCfg = { rig: 'auto', guardFps: 0 }; window.__fakeXROpts = ${JSON.stringify({ nominal: [0, 0.1, 0.6], eyeX: 0.032, pixelAspect: 2 })};`);
await page.evaluateOnNewDocument(FAKE);
await page.evaluateOnNewDocument(DEV);
await page.goto(url, { waitUntil: 'load' });
for (let i = 0; i < +(process.argv[3] || 8); i++) {
  await new Promise((r) => setTimeout(r, 1000));
  console.log(i, JSON.stringify(await page.evaluate(() => ({ frames: window.__frames, g: window.__dxrGlobe ? window.__dxrGlobe.states().map((s) => ({ rec: s.recognised, q: s.qualifying, fr: s.frames, F: s.lastF, surf: s.surf, C: s.C })) : null }))));
}
await browser.close(); srv.close();

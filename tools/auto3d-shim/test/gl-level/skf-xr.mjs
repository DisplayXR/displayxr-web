// SPIKE: does the Sketchfab embed offer WebXR immersive-vr when the browser says it is supported?
// A FAKE navigator.xr (no real runtime): isSessionSupported -> true, requestSession records its args and rejects.
import puppeteer from 'puppeteer-core';
const url = process.argv[2];
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, defaultViewport: null,
  args: ['--use-angle=d3d11', '--window-size=1280,800', '--force-device-scale-factor=1', '--disable-features=OpenXR,WebXR', '--mute-audio', '--no-first-run'] });
const page = await (await browser.createBrowserContext()).newPage();
await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
await page.evaluateOnNewDocument(() => {
  window.__xrCalls = [];
  const xr = new EventTarget();
  xr.isSessionSupported = async (m) => { window.__xrCalls.push(['isSessionSupported', m]); return m === 'immersive-vr' || m === 'inline'; };
  xr.requestSession = async (m, o) => { window.__xrCalls.push(['requestSession', m, JSON.stringify(o || {})]); throw new DOMException('probe only', 'NotSupportedError'); };
  Object.defineProperty(Navigator.prototype, 'xr', { configurable: true, get: () => xr });
  window.XRWebGLLayer = function () {}; window.XRSession = function () {};
});
await page.goto(url, { waitUntil: 'load', timeout: 60000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 15000));
const btn = await page.evaluate(() => [...document.querySelectorAll('[class*=vr i],[title*=VR i],[aria-label*=VR i],[data-tooltip*=VR i]')].map((e) => [e.tagName, e.className.toString().slice(0, 60), e.getAttribute('title') || e.getAttribute('aria-label') || '', Math.round(e.getBoundingClientRect().x), Math.round(e.getBoundingClientRect().y), e.getBoundingClientRect().width]).filter((a) => a[5] > 0).slice(0, 8));
console.log('vr elements', JSON.stringify(btn));
const b = btn.find((a) => a[5] > 10);
await page.mouse.move(640, 400); await new Promise((r) => setTimeout(r, 500)); await page.mouse.move(1215, 690); await new Promise((r) => setTimeout(r, 800));
await page.screenshot({ path: 'out/skf-xr-hover.png' });
await page.mouse.click(1218, 694); await new Promise((r) => setTimeout(r, 3000));
const txt = await page.evaluate(() => document.body.innerText.split(String.fromCharCode(10)).filter((l) => /VR|headset|cardboard|Enter/i.test(l)).slice(0, 10));
console.log('vr ui text', JSON.stringify(txt));
const enter = await page.evaluate(() => { const e = [...document.querySelectorAll('button,a,div')].filter((x) => x.childElementCount < 3 && /enter vr|start vr|launch|vr headset|cardboard/i.test(x.textContent || '') && x.getBoundingClientRect().width > 0)[0]; if (!e) return null; const r = e.getBoundingClientRect(); return { t: e.textContent.trim().slice(0, 40), x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
console.log('enter', JSON.stringify(enter));
if (enter) { await page.mouse.click(enter.x, enter.y); await new Promise((r) => setTimeout(r, 3000)); }
console.log('xr calls', JSON.stringify(await page.evaluate(() => window.__xrCalls)));
await page.screenshot({ path: 'out/skf-xr.png' });
await browser.close();

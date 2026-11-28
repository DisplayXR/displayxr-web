// SPIKE: open Google Maps headed off-screen, open the Layers panel, screenshot (does this profile offer 3D / Globe view?).
import puppeteer from 'puppeteer-core';
import { readFileSync } from 'node:fs';
const url = process.argv[2]; const out = process.argv[3]; const extra = process.argv.slice(4);
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: false, defaultViewport: null,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1280,800', '--window-position=-32000,-32000', '--force-device-scale-factor=1', '--disable-features=OpenXR,WebXR', '--mute-audio', '--no-first-run', '--lang=en-US', ...extra] });
const page = await (await browser.createBrowserContext()).newPage();
await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
await page.goto(url, { waitUntil: 'load', timeout: 60000 }).catch((e) => console.log('goto', e.message));
await new Promise((r) => setTimeout(r, 12000));
console.log('webdriver', await page.evaluate(() => navigator.webdriver), 'url', page.url().slice(0, 120));
const info = await page.evaluate(async () => { const c = new OffscreenCanvas(1, 1); const g = c.getContext('webgl2', { failIfMajorPerformanceCaveat: true }); const d = g && g.getExtension('WEBGL_debug_renderer_info'); return { ok: !!g, renderer: g && d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : null }; });
console.log('gl', JSON.stringify(info));
await page.mouse.move(130, 660); await new Promise((r) => setTimeout(r, 1500));
await page.screenshot({ path: out + '-hover.png' });
await page.mouse.move(460, 660); await new Promise((r) => setTimeout(r, 800));
await page.mouse.click(460, 660); await new Promise((r) => setTimeout(r, 2500));
await page.screenshot({ path: out + '-more.png' });
const txt = await page.evaluate(() => document.body.innerText.match(/Globe view|3D|Labels|Satellite/g));
console.log('ui words', JSON.stringify(txt));
const r = await page.evaluate(() => {
  const el = [...document.querySelectorAll('*')].find((e) => e.childElementCount === 0 && /^\s*Globe view\s*$/.test(e.textContent || ''));
  if (!el) return 'none';
  let p = el; const chain = []; for (let i = 0; i < 4 && p; i++, p = p.parentElement) chain.push(p.tagName + (p.getAttribute('role') ? '[' + p.getAttribute('role') + ']' : '') + (p.getAttribute('aria-checked') ? '{' + p.getAttribute('aria-checked') + '}' : ''));
  const rect = el.getBoundingClientRect(); return { chain, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, html: el.parentElement.parentElement.outerHTML.slice(0, 400) };
});
console.log(JSON.stringify(r));
if (r && r.chain) {
  await page.evaluate(() => { const el = [...document.querySelectorAll('*')].find((e) => e.childElementCount === 0 && /^\s*Globe view\s*$/.test(e.textContent || '')); el.scrollIntoView(); });
  await new Promise((r) => setTimeout(r, 500));
  const r2 = await page.evaluate(() => { const el = [...document.querySelectorAll('*')].find((e) => e.childElementCount === 0 && /^\s*Globe view\s*$/.test(e.textContent || '')); const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; });
  await page.mouse.click(r2.x - 40, r2.y); await new Promise((r) => setTimeout(r, 1500));
  await page.screenshot({ path: out + '-globe.png' });
  await page.goto(url, { waitUntil: 'load', timeout: 60000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 15000));
  await page.screenshot({ path: out + '-after.png' });
  console.log('after url', page.url().slice(0, 120));
}
await browser.close();

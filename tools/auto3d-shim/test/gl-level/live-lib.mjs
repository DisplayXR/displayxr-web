// Shared driver for the live Google Maps / Google Earth probes: stock headless Chrome, scripts
// injected at document start, Maps UI helpers (Globe view on, the 3D button, pan / tilt / zoom).
// Never signs in, uses no API key, never touches a DisplayXR Browser.
import puppeteer from 'puppeteer-core';

const WIN = process.platform === 'win32';
export const CHROME = process.env.CHROME || (WIN ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/google-chrome');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ inject = [], width = 1280, height = 720, headed = false, extraArgs = [] } = {}) {
  const args = [`--use-angle=${WIN ? 'd3d11' : 'vulkan'}`, '--enable-gpu', '--ignore-gpu-blocklist', `--window-size=${width},${height + 80}`,
    '--hide-scrollbars', '--force-device-scale-factor=1', '--disable-features=OpenXR,WebXR', '--mute-audio', '--no-first-run', '--no-default-browser-check', '--lang=en-US', ...extraArgs];
  if (headed) args.push('--window-position=-32000,-32000');
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: !headed, args, defaultViewport: null });
  const UA = (await browser.userAgent()).replace('HeadlessChrome', 'Chrome');
  const page = await (await browser.createBrowserContext()).newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.setUserAgent(UA);
  for (const src of inject) await page.evaluateOnNewDocument(src);
  const log = [];
  page.on('console', (m) => { const t = m.text(); if (log.length < 400) log.push(t.slice(0, 400)); });
  page.on('pageerror', (e) => { if (log.length < 400) log.push('PAGEERROR ' + String(e.message).slice(0, 300)); });
  return { browser, page, log };
}

const findText = (page, re, sel = 'button,[role=button],label,span,div') => page.evaluate((src, sel) => {
  const rx = new RegExp(src);
  const el = [...document.querySelectorAll(sel)].filter((e) => e.childElementCount <= 2 && rx.test(e.textContent || '')).map((e) => e.getBoundingClientRect()).filter((b) => b.width > 0)[0];
  return el ? { x: el.x + el.width / 2, y: el.y + el.height / 2 } : null;
}, re.source, sel);

// Google Maps: turn "Globe view" on (a fresh profile has it off), then press the 3D button.
// Returns { globe, threeD } as found.
export async function mapsGlobe3D(page, { want3D = true, log = console.log } = {}) {
  await sleep(10000);
  const find = () => page.evaluate(() => { const el = [...document.querySelectorAll('label')].find((e) => /^\s*Globe view\s*$/.test(e.textContent || '')); if (!el) return null; el.scrollIntoView(); const btn = el.closest('button'); return { checked: btn && btn.getAttribute('aria-checked') }; });
  let g = null;
  for (let attempt = 0; attempt < 3 && !(g && g.checked === 'true'); attempt++) {
    await page.mouse.move(130, 660); await sleep(1200);
    const more = await page.evaluate(() => { const el = [...document.querySelectorAll('button,[role=button],label,span,div')].filter((e) => e.childElementCount <= 2 && /^\s*More\s*$/.test(e.textContent || '')).map((e) => e.getBoundingClientRect()).filter((b) => b.width > 0 && b.y > 500)[0]; return el ? { x: el.x + el.width / 2, y: el.y + el.height / 2 } : null; });
    if (more) { await page.mouse.move(more.x, more.y - 25); await sleep(500); await page.mouse.click(more.x, more.y - 25); }
    await sleep(2500);
    g = await find(); await sleep(400); g = await find();
    if (g && g.checked !== 'true') { await page.evaluate(() => { const b = document.querySelector('button[jsaction*="spherical"]'); if (b) b.click(); }); await sleep(2500); g = await find(); }
    log('globe view (attempt ' + (attempt + 1) + '):', JSON.stringify(g));
    await page.keyboard.press('Escape'); await sleep(1000);
  }
  let b3 = null;
  if (want3D) {
    b3 = await page.evaluate(() => { const el = [...document.querySelectorAll('button')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).find((e) => /^\s*3D\s*$/.test(e.textContent || '') || /^(Tilt|3D|Show 3D)/i.test(e.getAttribute('aria-label') || '')); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, label: el.getAttribute('aria-label'), text: el.textContent.trim().slice(0, 20) }; });
    log('3D button:', JSON.stringify(b3));
    if (b3) { await page.mouse.click(b3.x, b3.y); await sleep(4000); }
  }
  return { globe: g, threeD: b3 };
}

// Gestures over the map (centre of the map area; the left rail is ~72 px).
export async function drag(page, dx, dy, { steps = 15, ctrl = false, x = 700, y = 400, stepMs = 30 } = {}) {
  if (ctrl) await page.keyboard.down('Control');
  await page.mouse.move(x, y); await page.mouse.down();
  for (let i = 1; i <= steps; i++) { await page.mouse.move(x + (dx * i) / steps, y + (dy * i) / steps); await sleep(stepMs); }
  await page.mouse.up();
  if (ctrl) await page.keyboard.up('Control');
}
export async function wheel(page, deltaY, { n = 5, x = 700, y = 400, gapMs = 120 } = {}) {
  await page.mouse.move(x, y);
  for (let i = 0; i < n; i++) { await page.mouse.wheel({ deltaY }); await sleep(gapMs); }
}

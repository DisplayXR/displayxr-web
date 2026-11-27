import puppeteer from 'puppeteer-core';
const url = process.argv[2];
const b = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--no-sandbox', '--window-size=1280,720', '--disable-features=OpenXR,WebXR', '--mute-audio'] });
const p = await b.newPage(); await p.setViewport({ width: 1280, height: 720 });
await p.goto(url, { waitUntil: 'load', timeout: 60000 }); await new Promise((r) => setTimeout(r, 12000));
for (const f of p.frames()) {
  try {
    const r = await f.evaluate(() => [...document.querySelectorAll('.sse-handle')].slice(0, 4).map((e) => { const c = getComputedStyle(e), q = e.getBoundingClientRect(); let chain = []; for (let x = e; x && chain.length < 5; x = x.parentElement) chain.push(x.tagName.toLowerCase() + (x.id ? '#' + x.id : '') + (typeof x.className === 'string' && x.className ? '.' + x.className.trim().split(/\s+/).join('.') : '')); return { chain, opacity: c.opacity, pe: c.pointerEvents, rect: [Math.round(q.x), Math.round(q.y), Math.round(q.width), Math.round(q.height)], text: (e.innerText || '').slice(0, 40), title: e.title }; }));
    if (r.length) console.log(f.url().slice(0, 80), JSON.stringify(r, null, 1));
  } catch (e) {}
}
await b.close();

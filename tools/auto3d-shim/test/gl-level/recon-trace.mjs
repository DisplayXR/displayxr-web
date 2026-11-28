// Recon: one frame's draw sequence on Google Maps (Globe view + 3D, or the 2D map with --flat).
// Usage: node recon-trace.mjs [url] [--flat] [--out out/trace.json]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, mapsGlobe3D, sleep, drag } from './live-lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const url = argv.find((a) => /:\/\//.test(a)) || 'https://www.google.com/maps/@37.8009429,-122.4058,836a,35y,39.22t/data=!3m1!1e3?entry=ttu';
const flat = argv.includes('--flat'), earth = /earth\.google/.test(url);
const outI = argv.indexOf('--out'); const out = outI >= 0 ? argv[outI + 1] : join(here, 'out', flat ? 'trace-flat.json' : earth ? 'trace-earth.json' : 'trace-3d.json');
mkdirSync(dirname(out), { recursive: true });
const { browser, page, log } = await launch({ inject: [readFileSync(join(here, 'trace-frame.js'), 'utf8')] });
await page.goto(url, { waitUntil: 'load', timeout: 60000 }).catch((e) => console.log('goto', e.message));
if (earth) { await sleep(25000); await page.keyboard.press('Escape'); await sleep(800); await page.mouse.click(843, 119); await sleep(800); await page.mouse.click(60, 148); await sleep(1500); }
else if (!flat) await mapsGlobe3D(page);
else await sleep(12000);
await drag(page, 40, 10);
await sleep(1500);
const res = [];
const dr = drag(page, 120, 0, { steps: 30 });
await sleep(400);
for (const f of page.frames()) {
  try {
    await f.evaluate(() => self.__trace && self.__trace.arm());
  } catch (e) { /* gone */ }
}
await dr;
await sleep(1500);
for (const f of page.frames()) {
  try { const o = await f.evaluate(() => ({ url: location.href.slice(0, 100), ctxs: self.__trace && self.__trace.ctxs, out: self.__trace && self.__trace.out })); if (o.ctxs) res.push(o); } catch (e) { /* gone */ }
}
const canv = await page.evaluate(() => [...document.querySelectorAll('canvas')].map((c) => { const r = c.getBoundingClientRect(); return { w: c.width, h: c.height, rect: [r.x, r.y, r.width, r.height].map(Math.round), parent: c.parentElement && c.parentElement.className.slice(0, 40) }; }));
writeFileSync(out, JSON.stringify({ url, canv, res }, null, 1));
await page.screenshot({ path: out.replace(/\.json$/, '.png') });
for (const r of res) {
  console.log('frame', r.url, 'contexts', r.ctxs, 'draws', r.out && r.out.draws.length);
  if (r.out) for (const d of r.out.draws.slice(0, 400)) console.log(` c${d.ctx} p${d.prog} ${d.dn}(${d.n}) fbo=${d.fbo} vp=${d.vp} b=${+d.blend} d=${+d.depth} ${d.gl} ${d.m4} ${d.tex}`);
}
console.log('canvases', JSON.stringify(canv));
console.log(log.filter((l) => /error/i.test(l)).slice(0, 5).join('\n'));
await browser.close();

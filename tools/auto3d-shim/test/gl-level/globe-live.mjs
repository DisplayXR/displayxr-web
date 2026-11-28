// Live check of the globe part on Google Maps (Globe view + 3D) or Google Earth, in stock headless
// Chrome with the DEV build and the fake inline-3d session (fake-xr.js, runtime model: nominal viewer,
// half-IPD eyes, so the eye shear is what the runtime would hand back). No sign-in, no API key.
//
// Usage: node globe-live.mjs [url] [--tag t] [--script globe|city|street|tour] [--fps] [--off]
//   --off    the shim with the globe route disabled (cfg.engines.globe false): the 2D baseline
//   --fps    measure the page's frame rate during a scripted pan, 2D (before go-live) and converted
// Writes out/<tag>-*.png (side-by-side canvas pixels, read in the drawing task) + out/<tag>.json.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../../build.mjs';
import { launch, mapsGlobe3D, sleep, drag, wheel } from './live-lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true); };
const url = argv.find((a) => /:\/\//.test(a)) || 'https://www.google.com/maps/@37.8009429,-122.4058,836a,35y,39.22t/data=!3m1!1e3?entry=ttu';
const tag = opt('tag', 'live'), script = opt('script', 'city'), earth = /earth\.google/.test(url);
const out = join(here, 'out'); mkdirSync(out, { recursive: true });
const DEV = build(join(here, '..', '..')).files['dist/auto3d-dev.js'];
const FAKE = readFileSync(join(here, '..', 'fake-xr.js'), 'utf8');
const testCfg = { rig: 'auto', guardFps: 0, ...(opt('off', false) ? { engines: { globe: false } } : {}) };
const pre = `window.__dxrAuto3DTestCfg = ${JSON.stringify(testCfg)}; window.__fakeXROpts = ${JSON.stringify({ nominal: [0, 0.1, 0.6], eyeX: 0.032, pixelAspect: 2 })};`;
// test-only frame counter (under every other wrapper): rAF ticks in which the page drew anything
const COUNTER = `(() => { let tick = 0, last = -1; const ticks = []; const R = window.requestAnimationFrame.bind(window); const loop = (t) => { tick++; R(loop); }; R(loop);
  for (const P of [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype]) for (const k of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced']) { const o = P[k]; if (!o) continue; P[k] = function () { if (tick !== last) { last = tick; ticks.push(performance.now()); if (ticks.length > 5000) ticks.shift(); } return o.apply(this, arguments); }; }
  window.__drawTicks = (since) => ticks.filter((t) => t >= since).length; })();`;
// --off: no shim at all (the page as it is: the 2D baseline)
const { browser, page, log } = await launch({ inject: opt('off', false) ? [COUNTER] : [COUNTER, pre, FAKE, DEV] });
const t0 = Date.now();
await page.goto(url, { waitUntil: 'load', timeout: 60000 }).catch((e) => console.log('goto', e.message));
if (earth) { await sleep(20000); await page.keyboard.press('Escape'); await sleep(1500); }
else if (!opt('flat', false)) await mapsGlobe3D(page);
else await sleep(12000);

const state = () => page.evaluate(() => {
  const A = window.__dxrAuto3D, S = A && A.state();
  return { renderers: S ? S.renderers.map((r) => ({ engine: r.engine, active: r.active, src: r.convergenceSource, via: r.convergenceVia, open: r.openLatched, openWhy: r.openWhy, rig: S.rigMode, twoView: r.stats && r.stats.twoView, stereo: r.stats && r.stats.stereo, desc: r.describe || r.page || null })) : null, globe: window.__dxrGlobe ? window.__dxrGlobe.states() : null };
});
const grab = async (name) => {
  const g = await page.evaluate(() => (window.__dxrGlobe ? Promise.race([window.__dxrGlobe.grab(), new Promise((r) => setTimeout(() => r(null), 4000))]) : null));
  if (!g) { await page.screenshot({ path: join(out, `${tag}-${name}-page.png`) }); console.log(name, 'no grab (page screenshot instead)'); return null; }
  writeFileSync(join(out, `${tag}-${name}.png`), Buffer.from(g.png.split(',')[1], 'base64'));
  console.log(name, JSON.stringify({ live: g.live, stereo: g.stereo, fit: g.fit && { c: +g.fit.c.toPrecision(4), near: +g.fit.near.toPrecision(4), relief: +g.fit.relief.toFixed(2), n: g.fit.n } }));
  return g;
};
const fpsWindow = async (ms, motion) => {
  const p = page.evaluate((ms) => new Promise((res) => { const ts = []; const f = (t) => { ts.push(t); if (t - ts[0] < ms) requestAnimationFrame(f); else res(ts.length); }; requestAnimationFrame(f); }), ms);
  const before = await page.evaluate(() => (window.__dxrGlobe ? window.__dxrGlobe.states().map((s) => s.frames || 0) : []));
  const d0 = await page.evaluate(() => window.__globeFrames || 0);
  if (motion) await motion();
  await p;
  return { before, d0 };
};

let res = { url, tag, script, steps: [] };
await sleep(4000);
res.steps.push({ at: 'after 3D', state: await state() });
console.log('state', JSON.stringify(res.steps[0].state).slice(0, 900));
// The scripted pan / tilt / zoom, grabbing the side-by-side store along the way.
const shot = async (name) => {
  const g = opt('off', false) ? null : await grab(name);
  await page.screenshot({ path: join(out, `${tag}-${name}-page.png`) });
  const ticks = await page.evaluate(() => window.__drawTicks(0));
  console.log(name, 'page draw ticks so far', ticks);
  res.steps.push({ at: name, ticks, state: await state(), stereo: g && g.stereo, fit: g && g.fit, surf: g && g.surf });
};
await shot('start');
if (script === 'fpsab') { // A/B of the tap's costs (dev knobs), one 8 s pan each
  const pageCount = () => page.evaluate(() => window.__dxrGlobe.states().reduce((a, s) => a + (s.pageCount || 0), 0));
  const run = async (label) => { const t0 = await page.evaluate(() => performance.now()), c0 = await pageCount(); await drag(page, 400, 0, { steps: 160, stepMs: 50, x: 400 }); const t1 = await page.evaluate(() => performance.now()), c1 = await pageCount(); const fps = +((c1 - c0) / ((t1 - t0) / 1000)).toFixed(1); console.log('fpsab', label, fps); res.steps.push({ at: label, fps }); await sleep(1500); };
  await run('live');
  await page.evaluate(() => window.__dxrGlobe.set({ sampleVerts: false })); await run('live, no vertex samples');
  await page.evaluate(() => window.__dxrGlobe.set({ record: false })); await run('live, no vertex samples, no recording');
  await page.keyboard.down('Control'); await page.keyboard.down('Alt'); await page.keyboard.press('Digit3'); await page.keyboard.up('Alt'); await page.keyboard.up('Control'); await sleep(2000);
  await run('turned off (tap still installed, mono)');
}
if (script === 'fps') {
  // a continuous pan for 8 s: frames the page drew (rAF ticks with draws) per second
  for (let rep = 0; rep < 2; rep++) {
    // page frames only: the globe part's own count (its replays are not page frames) when the shim is
    // on, the draw-tick counter when it is off (no shim: no replay)
    const pageCount = () => page.evaluate(() => (window.__dxrGlobe ? window.__dxrGlobe.states().reduce((a, s) => a + (s.pageCount || 0), 0) : null));
    const t0 = await page.evaluate(() => performance.now()), c0 = await pageCount();
    await drag(page, 500, 0, { steps: 160, stepMs: 50, x: 400 });
    const t1 = await page.evaluate(() => performance.now()), c1 = await pageCount();
    const n = c0 === null ? await page.evaluate((a) => window.__drawTicks(a), t0) : c1 - c0;
    const fps = +(n / ((t1 - t0) / 1000)).toFixed(1);
    res.steps.push({ at: 'fps' + rep, fps, ms: Math.round(t1 - t0) });
    console.log('fps', rep, fps, 'frames', n, 'in', Math.round(t1 - t0), 'ms');
    await sleep(1500);
  }
  res.steps.push({ at: 'fps-state', state: await state() });
}
// Maps ignores the wheel after a Ctrl+drag tilt in this headless driver (with or without the shim: the
// --off baseline shows the same), so the tilt comes last.
if (script === 'street2') { // already at street level (the URL): a little closer, then a pan
  await wheel(page, -120, { n: 3 }); await sleep(4000); await shot('zoom');
  await drag(page, 140, 20); await sleep(3000); await shot('pan');
}
if (script === 'street3') { // from the city view down to street level over land (the wheel zooms toward the pointer)
  await wheel(page, -240, { n: 8, x: 420, y: 560 }); await sleep(4500); await shot('zoomin');
  await wheel(page, -240, { n: 6, x: 640, y: 420 }); await sleep(5000); await shot('street');
  await drag(page, 120, -40); await sleep(3500); await shot('street-pan');
}
if (script === 'tour' || script === 'city') { await drag(page, 160, 40); await sleep(2500); await shot('pan'); }
if (script === 'tour' || script === 'street') {
  await wheel(page, -240, { n: 8 }); await sleep(4000); await shot('zoomin');
  await wheel(page, -240, { n: 6 }); await sleep(5000); await shot('street');
  await drag(page, -120, 30); await sleep(3000); await shot('street-pan');
}
if (script === 'tour' || script === 'globe') {
  await wheel(page, 300, { n: 30, gapMs: 150 }); await sleep(6000); await shot('zoomout');
  await wheel(page, 300, { n: 30, gapMs: 150 }); await sleep(7000); await shot('globe');
  await drag(page, 200, 0); await sleep(4000); await shot('globe-pan');
}
if (script === 'tour' || script === 'city') { await drag(page, 0, -120, { ctrl: true }); await sleep(3000); await shot('tilt'); }
res.log = log.filter((l) => /dxr-auto3d|globe|PAGEERROR|rror/.test(l)).slice(0, 120);
res.secs = (Date.now() - t0) / 1000;
writeFileSync(join(out, `${tag}.json`), JSON.stringify(res, null, 1));
console.log(res.log.join('\n'));
await browser.close();

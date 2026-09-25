// run.mjs — drive the built-in bundle end to end in ONE headless Chrome (real GPU via ANGLE Metal).
//
//   npm run build:lift-builtin && node tools/lift-builtin/test/run.mjs [--csp strict|open|both]
//        [--photo <jpg>] [--out <dir>] [--chrome <path>]
//
// Per CSP mode: load the page (bundle via <script> = the injection), check the API surface and
// the globals it leaks, then  video: convertAt → live → pause → explore → cancelAll;
// image: convertAt → explore → convertAt again (toggle → removed). PNGs + a JSON report go to --out
// (default: tools/lift-builtin/test/_out, gitignored with the rest of _out). Exits 1 on any failure.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const OUT = path.resolve(arg('--out', path.join(HERE, '_out')));
const CHROME = arg('--chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const MODES = (arg('--csp', 'both') === 'both' ? ['strict', 'open'] : [arg('--csp')]);
fs.mkdirSync(OUT, { recursive: true });

const { start, log: netLog } = await import('./server.mjs');
const puppeteer = (await import('puppeteer-core')).default;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = await start(+arg('--port', 0)); // 0 = any free port
const PORT = server.address().port;
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dxr-lift-builtin-prof-')),
  args: ['--use-angle=metal', '--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1360,820',
    '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--no-default-browser-check'],
  defaultViewport: { width: 1360, height: 820 },
});
const report = { chrome: await browser.version(), modes: {} };
let failed = false;

async function waitState(page, want, ms) {
  const t0 = Date.now();
  let st;
  while (Date.now() - t0 < ms) {
    st = await page.evaluate(() => __dxrLift.status());
    const s = st.lifts[0] && st.lifts[0].state;
    if (want.includes(s)) return { st, ms: Date.now() - t0 };
    if (s === 'error') break;
    await sleep(250);
  }
  return { st, ms: Date.now() - t0, timeout: true };
}

try {
  for (const mode of MODES) {
    const r = (report.modes[mode] = { steps: [], console: [], checks: {} });
    const page = await browser.newPage();
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warn' || m.type() === 'warning') r.console.push(`${m.type()}: ${m.text()}`.slice(0, 400)); });
    page.on('pageerror', (e) => r.console.push(`pageerror: ${String(e.message || e).slice(0, 400)}`));
    netLog.length = 0;
    const tNav = Date.now();
    await page.goto(`http://127.0.0.1:${PORT}/?csp=${mode}`, { waitUntil: 'load' });
    r.checks.load = await page.evaluate(() => {
      const res = performance.getEntriesByType('resource').find((e) => e.name.includes('displayxr-lift-builtin.js'));
      const before = new Set(globalThis.__dxrGlobalsBefore);
      const added = Object.getOwnPropertyNames(globalThis).filter((k) => !before.has(k) && !k.startsWith('__dxrBundle'));
      return {
        fetchMs: res ? Math.round(res.responseEnd - res.startTime) : null,
        evalMs: Math.round(globalThis.__dxrBundleEvaluatedAt - (res ? res.responseEnd : globalThis.__dxrHarnessAt)),
        apiKeys: Object.getOwnPropertyNames(__dxrLift),
        frozen: Object.isFrozen(__dxrLift),
        enumerable: Object.keys(globalThis).includes('__dxrLift'),
        version: __dxrLift.version,
        globalsAdded: added,
        renderer: (() => { const g = document.createElement('canvas').getContext('webgl2'); const x = g && g.getExtension('WEBGL_debug_renderer_info'); return x ? g.getParameter(x.UNMASKED_RENDERER_WEBGL) : '?'; })(),
        webgpu: !!navigator.gpu,
        jspi: typeof WebAssembly.Suspending === 'function',
        hidden: document.hidden,
      };
    });
    r.checks.load.navMs = Date.now() - tNav;

    const center = (sel) => page.evaluate((s) => { const b = document.querySelector(s).getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; }, sel);
    const shot = async (name) => { const f = path.join(OUT, `${mode}-${name}.png`); await page.screenshot({ path: f }); return path.basename(f); };
    // Orbit by dragging (explore takes pointer events), shoot mid-drag, release (relax springs back).
    const dragShot = async (sel, name) => {
      const [cx, cy] = await center(sel);
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      for (let i = 1; i <= 10; i++) { await page.mouse.move(cx + 22 * i, cy + 3 * i); await sleep(40); }
      await sleep(1200);
      const f = await shot(name);
      await page.mouse.up();
      return f;
    };
    const step = (o) => { r.steps.push(o); console.log(`[${mode}]`, JSON.stringify(o).slice(0, 600)); if (o.ok === false) failed = true; };

    // ── video: live → pause → explore ──
    await page.waitForFunction(() => document.querySelector('#v').currentTime > 0.5, { timeout: 15000 });
    let [x, y] = await center('#v');
    let t = Date.now();
    let res = await page.evaluate((a, b) => __dxrLift.convertAt(a, b, 'video'), x, y);
    let w = await waitState(page, ['live'], 90000);
    await sleep(3000);
    step({ step: 'video convertAt → live', result: res, ok: res.ok && !w.timeout && w.st.lifts[0]?.state === 'live', ms: Date.now() - t, status: w.st, png: await shot('1-video-live') });

    t = Date.now();
    await page.evaluate(() => document.querySelector('#v').pause());
    w = await waitState(page, ['explore'], 180000);
    await sleep(2500);
    step({ step: 'pause → explore', ok: !w.timeout && w.st.lifts[0]?.state === 'explore', ms: Date.now() - t, status: w.st, png: await shot('2-video-explore'), pngOrbit: await dragShot('#v', '2b-video-explore-orbit') });

    await page.evaluate(() => __dxrLift.cancelAll());
    await sleep(500);
    const afterCancel = await page.evaluate(() => ({ lifts: __dxrLift.status().lifts.length, hosts: document.querySelectorAll('#v ~ *:not(img)').length, videoVisible: getComputedStyle(document.querySelector('#v')).visibility }));
    step({ step: 'cancelAll', ok: afterCancel.lifts === 0, afterCancel, png: await shot('3-after-cancel') });

    // ── image: explore, then toggle off ──
    [x, y] = await center('#i');
    t = Date.now();
    res = await page.evaluate((a, b) => __dxrLift.convertAt(a, b, 'image'), x, y);
    w = await waitState(page, ['explore'], 180000);
    await sleep(2500);
    step({ step: 'image convertAt → explore', result: res, ok: res.ok && !w.timeout && w.st.lifts[0]?.state === 'explore', ms: Date.now() - t, status: w.st, png: await shot('4-image-explore'), pngOrbit: await dragShot('#i', '4b-image-explore-orbit') });

    res = await page.evaluate((a, b) => __dxrLift.convertAt(a, b, 'image'), x, y);
    await sleep(500);
    const n = await page.evaluate(() => __dxrLift.status().lifts.length);
    step({ step: 'image convertAt again → removed', result: res, ok: res.ok && res.action === 'removed' && n === 0, png: await shot('5-image-removed') });

    // EME refusal is checked without real DRM: a video with mediaKeys faked on the instance.
    const eme = await page.evaluate(async () => {
      const v = document.querySelector('#v');
      Object.defineProperty(v, 'mediaKeys', { value: {}, configurable: true });
      const b = v.getBoundingClientRect();
      const out = await __dxrLift.convertAt(b.left + b.width / 2, b.top + b.height / 2, 'video');
      delete v.mediaKeys;
      return out;
    });
    step({ step: 'EME refused', result: eme, ok: eme.ok === false && eme.reason === 'encrypted-media' });

    r.csp = await page.evaluate(() => [...new Set(globalThis.__dxrCspViolations)]);
    r.network = [...new Set(netLog.filter((p) => p.startsWith('/runtime/') || p.startsWith('/models/')))];
    await page.close();
  }
} catch (e) {
  failed = true;
  report.fatal = String((e && e.stack) || e);
  console.error(e);
} finally {
  await browser.close();
  server.close();
}
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log(`[lift-builtin test] ${failed ? 'FAIL' : 'PASS'} — report ${path.join(OUT, 'report.json')}`);
process.exit(failed ? 1 : 0);

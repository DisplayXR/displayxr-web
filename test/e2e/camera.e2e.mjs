#!/usr/bin/env node
// test/e2e/camera.e2e.mjs — the C2 gate's headless run for `/camera` (RFC 0003 §7):
//
//   npm run test:e2e:camera
//
// In one headless Chrome, test/e2e/camera.html opens a SYNTHETIC side-by-side pair (a white marker
// further right in the left eye: a subject in FRONT of the screen) as a StereoCamera and puts it
// on a mock woven wall. Pass =
//   1. addCameraView painted a mirrored-AND-swapped pair: the left half of the woven buffer is
//      the mirrored RIGHT eye, the right half the mirrored LEFT eye, and the marker's disparity
//      keeps its sign (+40 source px → +40·scale) — the naive per-half mirror would flip it;
//      with mirror off the pair is as sent;
//   2. capturePhoto() yields a real JPEG (SOI) whose XMP parses back to the stereo record
//      (layout sbs, eye 320×240, baseline 63, FOV 70) and a `_2x1.jpg` name;
//   3. record() for ~1.2 s yields a WebM whose DXR_* tags parse back, plus a mono copy.
// Stock Chrome has no inline 3D, so the wall is a mock: this proves the module's pixels and files,
// not the weave — that needs a panel run (the sample at samples/camera/?camera=synthetic).
//
// Needs: Chrome (CHROME env, default the macOS app path) and puppeteer-core (resolved from this
// repo or PUPPETEER_CORE=<dir>). Not part of `npm test`: it needs a browser and ~10 s.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, join, extname } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const TIMEOUT_MS = +(process.env.E2E_TIMEOUT_MS || 30000);

async function loadPuppeteer() {
  const candidates = [process.env.PUPPETEER_CORE, root, ...(process.env.PUPPETEER_CORE_PATHS || '').split(':')].filter(Boolean);
  for (const dir of candidates) {
    try {
      const req = createRequire(join(dir, 'package.json'));
      return (await import(pathToFileURL(req.resolve('puppeteer-core')).href)).default;
    } catch {
      /* next */
    }
  }
  throw new Error('puppeteer-core not found: `npm i --no-save puppeteer-core`, or PUPPETEER_CORE=<dir containing node_modules/puppeteer-core>');
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json' };
function serve() {
  const srv = createServer(async (req, res) => {
    const file = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!file.startsWith(root)) return void res.writeHead(403).end();
    try {
      if (!(await stat(file)).isFile()) throw new Error('dir');
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(await readFile(file));
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, url: `http://127.0.0.1:${srv.address().port}` })));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, tol, what) => {
  if (Math.abs(a - b) > tol) throw new Error(`${what}: ${a} is not within ${tol} of ${b}`);
};

async function main() {
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME} (set CHROME)`);
  const puppeteer = await loadPuppeteer();
  const { srv, url } = await serve();
  const t0 = Date.now();
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--disable-gpu'] });
  try {
    const page = await browser.newPage();
    page.on('console', (m) => /inline3d|error/i.test(m.text()) && console.log(`  [page:${m.type()}] ${m.text().slice(0, 200)}`));
    page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
    await page.goto(`${url}/test/e2e/camera.html`, { waitUntil: 'load' });
    const opened = await page.evaluate(() => window.__ready);
    if (opened.format !== 'sbs' || opened.width !== 640 || opened.route !== 'woven-sbs') throw new Error(`unexpected camera: ${JSON.stringify(opened)}`);
    console.log(`e2e: camera open ${JSON.stringify(opened)} after ${Date.now() - t0} ms`);

    // 1. The mirrored pair in the woven buffer.
    await sleep(600); // a few frames of the paint loop
    const m = await page.evaluate(() => window.__markers());
    const s = m.scale; // buffer px per source px (320 → outW)
    const EYE = 320;
    // Source markers: left eye 100..140 (mid 120), right eye 60..100 (mid 80). Mirrored halves,
    // swapped: left half = mirrored RIGHT → mid (320 − 80) = 240; right half = mirrored LEFT → 200.
    near(m.left.mid / s, EYE - 80, 3, 'left half = mirrored right eye (marker mid)');
    near(m.right.mid / s, EYE - 120, 3, 'right half = mirrored left eye (marker mid)');
    const disparity = (m.left.mid - m.right.mid) / s;
    near(disparity, 40, 3, 'disparity preserved (+40: the subject stays in front)');
    if (Math.abs(m.left.mid / s - (EYE - 120)) < 3) throw new Error('the naive per-half mirror was painted (left half = mirrored LEFT eye): pseudoscopic');
    console.log(`e2e: mirrored buffer ${m.bufferW}x${m.bufferH}: left-half marker ${m.left.lo}-${m.left.hi}, right-half ${m.right.lo}-${m.right.hi}, disparity +${disparity.toFixed(1)} px (source)`);
    // Mirror off: the pair as sent.
    const plain = await page.evaluate(async () => {
      window.__view.setMirror(false);
      await new Promise((r) => setTimeout(r, 300));
      return window.__markers();
    });
    near(plain.left.mid / s, 120, 3, 'mirror off: left half = left eye');
    near(plain.right.mid / s, 80, 3, 'mirror off: right half = right eye');
    await page.evaluate(() => window.__view.setMirror(true));

    // 2. A photo with its XMP record.
    const photo = await page.evaluate(async () => {
      const p = await window.__cam.capturePhoto({ name: 'e2e' });
      const bytes = new Uint8Array(await p.blob.arrayBuffer());
      return { name: p.suggestedName, type: p.type, width: p.width, height: p.height, layout: p.layout, size: bytes.length, soi: [bytes[0], bytes[1]], hasXmp: !!p.xmp, meta: window.__readJpeg(bytes), convergencePx: p.convergencePx };
    });
    if (photo.name !== 'e2e_2x1.jpg') throw new Error(`photo name ${photo.name}`);
    if (photo.soi[0] !== 0xff || photo.soi[1] !== 0xd8 || photo.type !== 'image/jpeg') throw new Error('not a JPEG');
    if (!photo.meta || photo.meta.layout !== 'sbs' || photo.meta.eyeWidth !== 320 || photo.meta.eyeHeight !== 240 || photo.meta.baselineMm !== 63 || photo.meta.horizontalFovDeg !== 70 || photo.meta.columns !== 2) throw new Error(`XMP record did not round-trip: ${JSON.stringify(photo.meta)}`);
    // The file carries the value rounded to 3 decimals; the result carries the raw measurement.
    const same = photo.convergencePx === null ? photo.meta.convergencePx === null : photo.meta.convergencePx !== null && Math.abs(photo.convergencePx - photo.meta.convergencePx) <= 0.001;
    if (!same) throw new Error(`convergencePx in the file (${photo.meta.convergencePx}) differs from the result (${photo.convergencePx})`);
    console.log(`e2e: photo ${photo.name} ${photo.width}x${photo.height} ${photo.size} B, XMP → ${JSON.stringify(photo.meta)}`);

    // 3. A recording with its tags (+ a mono copy).
    const clip = await page.evaluate(async () => {
      const rec = window.__cam.record({ mono: true, name: 'e2e' });
      await new Promise((r) => setTimeout(r, 1200));
      const c = await rec.stop();
      const bytes = new Uint8Array(await c.blob.arrayBuffer());
      return { name: c.suggestedName, monoName: c.monoSuggestedName, type: c.type, size: bytes.length, monoSize: c.mono ? c.mono.size : null, tagged: c.tagged, durationMs: c.durationMs, meta: window.__readWebm(bytes), monoMeta: c.mono ? window.__readWebm(new Uint8Array(await c.mono.arrayBuffer())) : null };
    });
    if (clip.name !== 'e2e_2x1.webm' || clip.monoName !== 'e2e.webm') throw new Error(`clip names ${clip.name} / ${clip.monoName}`);
    if (!clip.size || !clip.monoSize) throw new Error(`empty recording: ${JSON.stringify(clip)}`);
    if (!clip.tagged || !clip.meta || clip.meta.layout !== 'sbs' || clip.meta.eyeWidth !== 320) throw new Error(`WebM tags did not round-trip: ${JSON.stringify(clip.meta)}`);
    if (!clip.monoMeta || clip.monoMeta.layout !== 'mono') throw new Error(`mono copy tags: ${JSON.stringify(clip.monoMeta)}`);
    console.log(`e2e: clip ${clip.name} ${clip.size} B (${clip.durationMs} ms, ${clip.type}) + ${clip.monoName} ${clip.monoSize} B; tags → ${JSON.stringify(clip.meta)}`);
    console.log(`e2e: PASS in ${Date.now() - t0} ms`);
  } finally {
    await browser.close().catch(() => {});
    srv.close();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`e2e: FAIL — ${err.message}`);
    process.exit(1);
  }
);

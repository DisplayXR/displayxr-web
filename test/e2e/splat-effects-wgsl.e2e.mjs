#!/usr/bin/env node
// test/e2e/splat-effects-wgsl.e2e.mjs — the WGSL twins on a REAL PlayCanvas WebGPU device:
//
//   npm run test:e2e:wgsl
//
// One headless Chrome with WebGPU opens test/e2e/splat-effects-wgsl.html, which loads
// samples/splat/assets/butterfly.sog and runs every splat effect through the SDK's own runner
// (SplatEffects → the WGSL chunk set / setWorkBufferModifier({ wgsl })) on BOTH gsplat renderers —
// RASTER_GPU_SORT (WebGPU's default: the modifier runs in the compute projector) and
// RASTER_CPU_SORT (the vertex stage) — then the engine-chunk patches and the overlay / feather
// ShaderMaterials. Pass =
//   1. no GPU validation error and no shader-module compilation error, anywhere;
//   2. the splat draws (baseline lit pixels), every effect at amount 1 draws ~the baseline, fade at
//      0 draws nothing, the mid-way states differ from the baseline;
//   3. the snapshot overlay at alpha 1 shows its green texture; the feather darkens the edges.
// The per-mesh-instance probe (driveShared) is REPORTED, not gated: see docs/splat-effects.md
// §WGSL twins (on GPU-sort the projector reads only the tile material's values).
//
// Needs: Chrome with WebGPU (CHROME env; default: the platform's Google Chrome) and puppeteer-core
// (resolved from this repo or PUPPETEER_CORE=<dir>), and the playcanvas peer installed. Not part of
// `npm test`: it needs a GPU. On Windows headless Chrome exposes WebGPU with the flags below.

import { createServer } from 'node:http';
import { readFile, stat, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, join, extname } from 'node:path';
import { tmpdir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_CHROME = {
  win32: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  linux: '/usr/bin/google-chrome',
}[process.platform];
const CHROME = process.env.CHROME || DEFAULT_CHROME;
const TIMEOUT_MS = +(process.env.E2E_TIMEOUT_MS || 180000);

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

async function main() {
  if (!CHROME || !existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME} (set CHROME)`);
  if (!existsSync(join(root, 'node_modules', 'playcanvas'))) throw new Error('the playcanvas peer is not installed (npm i --no-save playcanvas@2.22.3)');
  const puppeteer = await loadPuppeteer();
  const { srv, url } = await serve();
  const profile = await mkdtemp(join(process.env.E2E_PROFILE_DIR || tmpdir(), 'dxr-wgsl-e2e-'));
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    userDataDir: profile,
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--enable-gpu',
      '--ignore-gpu-blocklist',
      '--enable-unsafe-webgpu',
      ...(process.platform === 'win32' ? ['--use-angle=d3d11'] : []),
      // never touch an OpenXR runtime from a test browser
      '--disable-features=OpenXR,WebXR',
    ],
  });
  const fails = [];
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && console.log(`  [page:error] ${m.text().slice(0, 300)}`));
    await page.goto(`${url}/test/e2e/splat-effects-wgsl.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__result?.done, { timeout: TIMEOUT_MS, polling: 250 });
    const R = await page.evaluate(() => window.__result);
    if (R.fatal) throw new Error(`page: ${R.fatal}`);
    console.log(`e2e: WebGPU adapter ${JSON.stringify(R.adapter)}; splat ${JSON.stringify(R.splat)}`);
    for (const s of R.steps) console.log(`  ${s.threw ? 'THREW' : s.newErrors || s.compileErrors ? 'GPUERR' : 'ok   '} ${s.name.padEnd(62)} lit=${s.px?.lit ?? '-'} mean=${JSON.stringify(s.px?.mean ?? null)}${s.threw ? ' ' + s.threw : ''}`);
    for (const n of R.notes) console.log(`  note: ${n}`);
    console.log(`  patches: ${JSON.stringify(R.patches)}`);

    for (const e of R.errors) fails.push(`GPU validation error at ${e.step}: ${e.msg}`);
    for (const e of R.compileErrors) fails.push(`shader compile error at ${e.step} (${e.label}): ${e.msg} @${e.lineNum}: ${e.line}`);
    for (const s of R.steps) if (s.threw) fails.push(`${s.name} threw: ${s.threw}`);
    for (const k of ['corner', 'common', 'hybrid']) if (!R.patches?.[k]) fails.push(`patch ${k} found no anchor`);

    const by = new Map(R.steps.map((s) => [s.name, s.px]));
    for (const r of ['gpu-sort', 'cpu-sort']) {
      const base = by.get(`${r}:baseline`)?.lit ?? 0;
      if (base < 500) fails.push(`${r}: the splat does not draw (${base} lit px)`);
      const near = (a, what) => {
        if (a == null || Math.abs(a - base) > Math.max(60, base * 0.03)) fails.push(`${r}: ${what} lit ${a} vs baseline ${base}`);
      };
      for (const s of R.steps) {
        if (!s.name.startsWith(r + ':')) continue;
        if (s.name.endsWith('@1') || s.name.endsWith(':after') || s.name.endsWith(':after shared')) near(s.px?.lit, s.name);
      }
      const f0 = by.get(`${r}:fade@0`)?.lit;
      if (!(f0 < base * 0.02)) fails.push(`${r}: fade at 0 still draws ${f0} px`);
      const sw = by.get(`${r}:sweep@0.5`)?.lit;
      if (!(sw < base * 0.97)) fails.push(`${r}: sweep at 0.5 hides nothing (${sw} vs ${base})`);
      const cl = by.get(`${r}:grade+clip`)?.lit;
      if (!(cl < base * 0.9)) fails.push(`${r}: clip sphere hides nothing (${cl} vs ${base})`);
      const g = by.get(`${r}:grade`)?.mean, b0 = by.get(`${r}:baseline`)?.mean;
      if (!g || !b0 || Math.abs(g[0] - g[1]) > 1.5 || Math.abs(g[1] - g[2]) > 1.5) fails.push(`${r}: grade saturation 0 is not grey ${JSON.stringify(g)} (baseline ${JSON.stringify(b0)})`);
      // (inflate / deflate are invisible from their origin, the eyes = this camera: not checked)
      for (const n of ['dissolve', 'assemble/noise', 'dissolve-in/noise', 'converge/radial', 'shimmer/random']) {
        const m = by.get(`${r}:${n}@0.5`)?.mean, m1 = by.get(`${r}:${n}@1`)?.mean;
        if (!m || !m1 || m.every((v, i) => Math.abs(v - m1[i]) < 0.05)) fails.push(`${r}: ${n} at 0.5 looks identical to 1 ${JSON.stringify(m)} vs ${JSON.stringify(m1)}`);
      }
    }
    // same bodies, two stages: with the projector's size culls off, GPU-sort's particles match
    // CPU-sort's vertex-stage ones (the semantic-identity check across the two inclusions)
    for (const n of ['assemble/depth', 'dissolve-in/noise']) {
      const a = by.get(`gpu-sort:${n}@0.5 (no projector cull)`)?.lit, b = by.get(`cpu-sort:${n}@0.5 (no projector cull)`)?.lit;
      if (!(a > 0 && b > 0 && Math.abs(a - b) <= Math.max(a, b) * 0.03)) fails.push(`${n}: gpu-sort (compute) ${a} vs cpu-sort (vertex) ${b} lit px`);
    }
    const ov = R.overlaySnapshot?.mean;
    if (!ov || !(ov[1] > 150 && ov[0] < 30 && ov[2] < 30)) fails.push(`snapshot overlay at alpha 1 is not the green texture: ${JSON.stringify(ov)}`);
    if (!R.feather?.mean) fails.push('feather step drew nothing');
  } finally {
    await browser.close();
    srv.close();
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
  if (fails.length) {
    console.error(`e2e FAIL (${fails.length}):\n  - ${fails.join('\n  - ')}`);
    process.exit(1);
  }
  console.log('e2e PASS: WGSL twins compile and draw on a WebGPU device (both gsplat renderers)');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

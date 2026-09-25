// Live-depth quality harness driver (samples/lift/dev-livequality.html) — NOT part of `npm test`
// (needs a GPU browser, the VDA models under _scratch/models and ORT under _scratch/ort):
//   CHROME=… PUPPETEER_CORE=/dir/with/node_modules/puppeteer-core \
//     node test/lift-livequality.run.mjs <experiment.mjs> [outDir]
// <experiment.mjs> exports `default async (lq, { save, log }) => {}` where `lq(fn, arg)` calls
// window.__lq[fn](arg) in the page and `save(name, dataUrlOrText)` writes into outDir.
// One headless Chrome per run, closed on exit.
import http from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const root = fileURLToPath(new URL('..', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm',
  '.json': 'application/json', '.webm': 'video/webm', '.mp4': 'video/mp4' };
const server = http.createServer(async (req, res) => {
  const p = normalize(join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  if (!p.startsWith(root)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(p);
    res.writeHead(200, { 'content-type': types[extname(p)] || 'application/octet-stream', 'cache-control': 'no-store',
      'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'credentialless' }).end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const exp = (await import(pathToFileURL(resolve(process.argv[2])).href)).default;
const outDir = resolve(process.argv[3] || join(root, '_scratch/livequality'));
await mkdir(outDir, { recursive: true });

const puppeteer = createRequire(join(process.env.PUPPETEER_CORE || root, 'x.js'))('puppeteer-core');
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  protocolTimeout: 1800000,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--no-first-run', '--enable-unsafe-webgpu',
    '--autoplay-policy=no-user-gesture-required'],
});
let code = 0;
try {
  const page = await browser.newPage();
  page.on('console', (m) => { const t = m.text(); if (!/^\[W:onnxruntime|^\[I:/.test(t)) console.log('[page]', t.slice(0, 400)); });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  const ready = new Promise((r) => page.on('console', (m) => m.text() === 'LQ READY' && r()));
  await page.goto(`http://127.0.0.1:${port}/samples/lift/dev-livequality.html`);
  await Promise.race([ready, new Promise((_, j) => setTimeout(() => j(new Error('page not ready')), 120000))]);
  const lq = (fn, arg) => page.evaluate((f, a) => window.__lq[f](a), fn, arg);
  const save = async (name, v) => {
    const p = join(outDir, name);
    if (typeof v === 'string' && v.startsWith('data:')) await writeFile(p, Buffer.from(v.split(',')[1], 'base64'));
    else await writeFile(p, typeof v === 'string' ? v : JSON.stringify(v, null, 1));
    return p;
  };
  await exp(lq, { save, log: console.log, page, outDir });
} catch (e) {
  console.error(e);
  code = 1;
} finally {
  await browser.close();
  server.close();
}
process.exit(code);

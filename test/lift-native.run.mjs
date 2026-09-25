// Native-mode lift() in a real browser — NOT part of `npm test` (needs a GPU browser):
//   CHROME=… PUPPETEER_CORE=/dir/with/node_modules/puppeteer-core node test/lift-native.run.mjs [outDir]
// Serves the repo, opens test/lift-native.html (which fakes the DisplayXR Browser's displayxr-lift://
// endpoints in window.fetch), runs window.__run() and prints the JSON result. One headless Chrome,
// closed on exit.
import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = fileURLToPath(new URL('..', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.mp4': 'video/mp4', '.wasm': 'application/wasm' };
const server = http.createServer(async (req, res) => {
  const p = normalize(join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  if (!p.startsWith(root)) return res.writeHead(403).end();
  try {
    const body = await readFile(p);
    res.writeHead(200, { 'content-type': types[extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const outDir = resolve(process.argv[2] || join(root, '_scratch/lift-native'));
await mkdir(outDir, { recursive: true });

const puppeteer = createRequire(join(process.env.PUPPETEER_CORE || join(root, 'tools/lift-builtin'), 'x.js'))('puppeteer-core');
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  protocolTimeout: 600000,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--no-first-run', '--autoplay-policy=no-user-gesture-required'],
});
let code = 0;
try {
  const page = await browser.newPage();
  page.on('console', (m) => console.log('[page]', m.text().slice(0, 300)));
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  const ready = new Promise((r) => page.on('console', (m) => m.text() === 'NATIVE READY' && r()));
  await page.goto(`http://127.0.0.1:${port}/test/lift-native.html`);
  await Promise.race([ready, new Promise((_, j) => setTimeout(() => j(new Error('page not ready')), 60000))]);
  const out = await page.evaluate(() => window.__run());
  if (out.img && typeof out.img.png === 'string' && out.img.png.startsWith('data:')) {
    await writeFile(join(outDir, 'img-explore.png'), Buffer.from(out.img.png.split(',')[1], 'base64'));
    out.img.png = join(outDir, 'img-explore.png');
  }
  if (out.gauss && typeof out.gauss.png === 'string' && out.gauss.png.startsWith('data:')) {
    await writeFile(join(outDir, 'gauss-explore.png'), Buffer.from(out.gauss.png.split(',')[1], 'base64'));
    out.gauss.png = join(outDir, 'gauss-explore.png');
  }
  await writeFile(join(outDir, 'report.json'), JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
} catch (e) {
  console.error(e);
  code = 1;
} finally {
  await browser.close();
  server.close();
}
process.exit(code);

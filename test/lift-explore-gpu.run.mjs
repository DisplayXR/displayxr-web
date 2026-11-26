// Runs test/lift-explore-gpu.html (the explore renderer's stereo stability on PlayCanvas) in
// headless Chrome and exits non-zero on a failure. Not part of `npm test` (it needs a GPU browser):
//   CHROME=/path/to/chrome PUPPETEER_CORE=/dir/whose/node_modules/has/puppeteer-core node test/lift-explore-gpu.run.mjs
// The page imports playcanvas from jsDelivr (the samples' pin, 2.22.3). SHOT=<file.png> saves the canvas.
import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = fileURLToPath(new URL('..', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript' };
const server = http.createServer(async (req, res) => {
  const p = normalize(join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  if (!p.startsWith(root)) { res.writeHead(403).end(); return; }
  let body;
  try { body = await readFile(p); } catch { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': types[extname(p)] || 'application/octet-stream' }).end(body);
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const puppeteer = createRequire(join(process.env.PUPPETEER_CORE || root, 'x.js'))('puppeteer-core');
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--no-first-run'],
});
let pass = false;
try {
  const page = await browser.newPage();
  const done = new Promise((res) => page.on('console', (m) => { const t = m.text(); console.log(t); if (t === 'RESULT PASS') pass = true; if (t === 'DONE') res(); }));
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.goto(`http://localhost:${port}/test/lift-explore-gpu.html`);
  await Promise.race([done, new Promise((r) => setTimeout(r, 90000))]);
  if (process.env.SHOT) {
    const url = await page.evaluate(() => window.__shot && window.__shot());
    if (url) await writeFile(process.env.SHOT, Buffer.from(url.split(',')[1], 'base64'));
  }
} finally {
  await browser.close();
  server.close();
}
process.exit(pass ? 0 : 1);

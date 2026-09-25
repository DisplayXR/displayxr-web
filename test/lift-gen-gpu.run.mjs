// Runs test/lift-gen-gpu.html in headless Chrome and exits non-zero on a parity failure.
// Not part of `npm test` (it needs a GPU browser):
//   CHROME=/path/to/chrome PUPPETEER_CORE=/dir/whose/node_modules/has/puppeteer-core node test/lift-gen-gpu.run.mjs
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = fileURLToPath(new URL('..', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript' };
const server = http.createServer(async (req, res) => {
  const p = normalize(join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  if (!p.startsWith(root)) { res.writeHead(403).end(); return; }
  try { res.writeHead(200, { 'content-type': types[extname(p)] || 'application/octet-stream' }).end(await readFile(p)); }
  catch { res.writeHead(404).end(); }
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
  await page.goto(`http://localhost:${port}/test/lift-gen-gpu.html`);
  await Promise.race([done, new Promise((r) => setTimeout(r, 60000))]);
} finally {
  await browser.close();
  server.close();
}
process.exit(pass ? 0 : 1);

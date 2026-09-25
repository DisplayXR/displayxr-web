// server.mjs — a local stand-in for the DisplayXR Browser's displayxr-lift:// scheme + a page.
//
//   node tools/lift-builtin/test/server.mjs [--port 8813] [--models ~/dxr-2d3d-exports/models]
//        [--video <mp4>] [--photo <jpg>]
//
//   /                      test page (index.html); ?csp=strict (default) | open
//   /bundle/<file>         lift-sdk/<file>            (the page's <script> = "injection")
//   /runtime/<file>        lift-sdk/<file>            ≙ displayxr-lift://runtime/<file> (pak)
//   /runtime/models.json   js/lift/models.json        ≙ the pak's installer copy
//   /models/<name>         <models>/<manifest path>   ≙ displayxr-lift://models/<name> (by NAME)
//   /media/video.mp4, /media/photo.jpg   same-origin test media
//
// Only 127.0.0.1. No Range support (the store does not do Range either).
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const home = (p) => p.replace(/^~/, os.homedir());
const PORT = +arg('--port', 8813);
const MODELS = home(arg('--models', '~/dxr-2d3d-exports/models'));
const VIDEO = home(arg('--video', path.join(MODELS, 'dev/pan.mp4')));
const PHOTO = home(arg('--photo', path.join(MODELS, 'dev/synthetic.jpg')));
const SDK = path.join(ROOT, 'lift-sdk');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'js/lift/models.json'), 'utf8'));
const byName = new Map(MANIFEST.models.map((m) => [m.name, m]));

const CSP = {
  // Emulates what the built-in meets in the browser: no workers at all (page worker-src 'none'),
  // no data:/blob: fetches (the lift world's connect-src is `displayxr-lift: https:`).
  strict: "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'none'; connect-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'",
  // Same, but blob: workers allowed (the worker path).
  open: "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' data:; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'",
};
const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.html': 'text/html', '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.png': 'image/png', '.map': 'application/json' };
export const log = [];

function sendFile(res, file, extra = {}) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'content-length': st.size, 'access-control-allow-origin': '*', 'cache-control': 'no-store', ...extra });
    fs.createReadStream(file).pipe(res);
  });
}

export function start(port = PORT) {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = decodeURIComponent(u.pathname);
    log.push(p);
    if (p === '/' || p === '/index.html') {
      const mode = u.searchParams.get('csp') || 'strict';
      const html = fs.readFileSync(path.join(HERE, 'index.html'), 'utf8').replace('%CSP%', CSP[mode] || CSP.strict);
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
      return res.end(html);
    }
    if (p === '/harness.js' || p === '/after.js') return sendFile(res, path.join(HERE, p.slice(1)));
    if (p === '/media/video.mp4') return sendFile(res, VIDEO);
    if (p === '/media/photo.jpg') return sendFile(res, PHOTO);
    if (p === '/runtime/models.json') return sendFile(res, path.join(ROOT, 'js/lift/models.json'));
    const m = /^\/(bundle|runtime)\/([^/]+)$/.exec(p);
    if (m) return sendFile(res, path.join(SDK, m[2]));
    const mm = /^\/models\/([^/]+)$/.exec(p);
    if (mm) {
      const e = byName.get(mm[1]);
      if (!e) { res.writeHead(404); return res.end('not in the manifest'); }
      return sendFile(res, path.join(MODELS, e.files[0].path));
    }
    res.writeHead(404); res.end('not found');
  });
  return new Promise((r) => srv.listen(port, '127.0.0.1', () => r(srv)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await start();
  console.log(`lift-builtin test server: http://127.0.0.1:${PORT}/  (models ${MODELS})`);
}

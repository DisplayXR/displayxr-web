// Forward proxy for the checker's Chrome: lets a page load public http(s) resources, plus the
// checker's own file server on loopback (check_files). Resolves every host itself and connects to
// the checked address, so DNS rebinding cannot reach a private network. Chrome sends EVERYTHING
// here, loopback and link-local included (--proxy-bypass-list=<-loopback>: Chrome otherwise skips
// the proxy for 169.254.0.0/16 and fe80::/10, i.e. cloud metadata). Listens on 127.0.0.1:8899.
import http from 'node:http';
import net from 'node:net';
import { lookup } from 'node:dns/promises';
import { isPublicAddress } from './ip-guard.mjs';

const PORT = 8899;
const TOKEN = process.env.GUARD_PROXY_TOKEN || ''; // the handler's byte-budget reset, not a page's
const LOOPBACK = new Set(['127.0.0.1', '::1']);
const MAX_BYTES = 200 * 1024 * 1024; // per page load, all requests together: a runaway page stops here
let total = 0;

async function resolvePublic(host) {
  const h = host.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(h) ? [{ address: h, family: net.isIP(h) }] : await lookup(h, { all: true });
  if (!addrs.length) throw new Error('no address');
  // Loopback is the checker's own server (and nothing else listens there but this proxy).
  if (addrs.every((a) => LOOPBACK.has(a.address))) return addrs[0];
  for (const a of addrs) if (!isPublicAddress(a.address)) throw new Error(`blocked address ${a.address}`);
  return addrs[0];
}

function count(n) { total += n; return total <= MAX_BYTES; }

const server = http.createServer(async (req, res) => {
  // Plain http: the request line carries an absolute URL.
  if (TOKEN && req.url === `/__reset?t=${TOKEN}`) { total = 0; res.writeHead(204).end(); return; } // handler, before each job
  let u;
  try { u = new URL(req.url); } catch { res.writeHead(400).end(); return; }
  if (u.protocol !== 'http:') { res.writeHead(400).end(); return; }
  try {
    const a = await resolvePublic(u.hostname);
    const up = http.request({ host: a.address, family: a.family, port: u.port || 80, method: req.method, path: u.pathname + u.search, headers: { ...req.headers, host: u.host }, setHost: false }, (r) => {
      res.writeHead(r.statusCode || 502, r.headers);
      r.on('data', (c) => { if (!count(c.length)) { r.destroy(); res.destroy(); } });
      r.pipe(res);
    });
    up.on('error', () => res.destroy());
    req.pipe(up);
  } catch (e) { res.writeHead(403, { 'content-type': 'text/plain' }).end(`guard-proxy: ${e.message}`); }
});

server.on('connect', async (req, sock, head) => {
  const [host, portS] = req.url.split(/:(?=\d+$)/);
  sock.on('error', () => {});
  try {
    const a = await resolvePublic(host);
    const up = net.connect({ host: a.address, port: Number(portS) || 443, family: a.family }, () => {
      sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) up.write(head);
      up.pipe(sock);
      sock.pipe(up);
    });
    up.on('data', (c) => { if (!count(c.length)) { up.destroy(); sock.destroy(); } });
    up.on('error', () => sock.destroy());
  } catch { sock.end('HTTP/1.1 403 Forbidden\r\n\r\n'); }
});

server.listen(PORT, '127.0.0.1', () => console.error(`guard-proxy on 127.0.0.1:${PORT}`));

// Public-URL checks for the front end. The worker's guard proxy repeats the address check at
// connect time for everything Chrome loads; this file covers what the front end itself fetches
// (asset URLs) and turns an obviously private target into a clear error before a GPU is used.
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import { isPublicAddress } from '../worker/ip-guard.mjs';

export { isPublicAddress };

export class GuardError extends Error {}

export function parsePublicUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new GuardError(`not a URL: ${String(raw).slice(0, 200)}`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new GuardError('only http and https URLs can be checked');
  if (u.username || u.password) throw new GuardError('URLs with a user name or password are refused');
  const h = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) {
    throw new GuardError(`${u.hostname} is not a public address. The hosted checker can only load public pages: pass the files with check_files instead, or deploy the page and pass its public URL.`);
  }
  if (net.isIP(h) && !isPublicAddress(h)) throw new GuardError(`${u.hostname} is a private address. Pass the files with check_files instead.`);
  return u;
}

// dns.lookup replacement that refuses non-public answers: used for every connection we open, so a
// name that resolves to a private address (DNS rebinding) is refused at connect time.
export function guardedLookup(hostname, options, cb) {
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err);
    const bad = addrs.find((a) => !isPublicAddress(a.address));
    if (bad) return cb(new GuardError(`${hostname} resolves to a non-public address`));
    if (options && options.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  });
}

export async function assertResolvesPublic(u) {
  const h = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(h)) return;
  const addrs = await dns.promises.lookup(h, { all: true }).catch(() => { throw new GuardError(`cannot resolve ${h}`); });
  if (addrs.some((a) => !isPublicAddress(a.address))) throw new GuardError(`${h} resolves to a non-public address. Pass the files with check_files instead.`);
}

// GET a public URL into a Buffer: redirects followed by hand (each hop re-checked), a byte cap and
// a timeout. No cookies, no credentials.
export function guardedGet(raw, { maxBytes = 50 * 1024 * 1024, timeoutMs = 20000, redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = parsePublicUrl(raw); } catch (e) { reject(e); return; }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(u, { lookup: guardedLookup, timeout: timeoutMs, headers: { 'user-agent': 'displayxr-inline3d-connector (asset check)', accept: '*/*' } }, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        if (redirects <= 0) { reject(new GuardError('too many redirects')); return; }
        resolve(guardedGet(new URL(res.headers.location, u).href, { maxBytes, timeoutMs, redirects: redirects - 1 }));
        return;
      }
      if (code !== 200) { res.resume(); reject(new GuardError(`HTTP ${code} for ${u.href}`)); return; }
      const len = Number(res.headers['content-length'] || 0);
      if (len > maxBytes) { res.destroy(); reject(new GuardError(`${u.href} is ${(len / 1048576).toFixed(1)} MB, over the ${maxBytes / 1048576} MB limit`)); return; }
      const chunks = []; let n = 0;
      res.on('data', (c) => { n += c.length; if (n > maxBytes) { res.destroy(); reject(new GuardError(`over the ${maxBytes / 1048576} MB limit`)); } else chunks.push(c); });
      res.on('end', () => resolve({ url: u.href, body: Buffer.concat(chunks), type: res.headers['content-type'] || '' }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new GuardError(`timed out fetching ${u.href}`)));
    req.on('error', reject);
  });
}

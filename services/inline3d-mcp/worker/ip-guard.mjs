// Is an IP address on the public internet? Shared by the worker's guard proxy and the front end
// (services/inline3d-mcp/lib/url-guard.mjs imports this file), so both refuse the same ranges.
import net from 'node:net';

const V4_BLOCKED = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
const v4int = (s) => s.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
const inV4 = (ip, [base, bits]) => bits === 0 || ((v4int(ip) ^ v4int(base)) >>> (32 - bits)) === 0;

function v6groups(ip) {
  let s = ip.toLowerCase().split('%')[0];
  let tail = [];
  const m = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (m) { const n = v4int(m[1]); tail = [(n >>> 16).toString(16), (n & 0xffff).toString(16)]; s = s.slice(0, -m[1].length).replace(/:$/, ':0'); s = s.replace(/:0$/, ''); }
  const [a, b] = s.split('::');
  const A = a ? a.split(':') : [];
  const B = b !== undefined ? (b ? b.split(':') : []) : null;
  const head = B === null ? [...A, ...tail] : [...A, ...Array(8 - A.length - B.length - tail.length).fill('0'), ...B, ...tail];
  return head.map((g) => parseInt(g || '0', 16));
}

export function isPublicAddress(ip) {
  const fam = net.isIP(ip);
  if (fam === 4) return !V4_BLOCKED.some((r) => inV4(ip, r));
  if (fam !== 6) return false;
  const g = v6groups(ip);
  if (g.length !== 8 || g.some((x) => Number.isNaN(x))) return false;
  const v4of = (hi, lo) => `${hi >>> 8}.${hi & 255}.${lo >>> 8}.${lo & 255}`;
  if (g.slice(0, 7).every((x) => x === 0)) return false; // :: and ::1
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return isPublicAddress(v4of(g[6], g[7])); // ::ffff:a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b) return isPublicAddress(v4of(g[6], g[7])); // NAT64
  if ((g[0] & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return false; // fe80::/10 link local
  if ((g[0] & 0xff00) === 0xff00) return false; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // documentation
  if (g[0] === 0x2002) return isPublicAddress(v4of(g[1], g[2])); // 6to4
  return true;
}

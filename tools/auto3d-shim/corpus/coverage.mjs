// Before / after three.js coverage from two run-corpus.mjs results over the same site list.
// Usage: node coverage.mjs <before.json> <after.json> [sites-three.json]  -> markdown on stdout
// An outcome is bucketed as: 3D (converted), 2D with a reason (flat / standdown: the shim saw the
// engine and declined), not found (no engine announced: idle / none), or error (unreachable).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const [beforeF, afterF, sitesF = 'sites-three.json'] = process.argv.slice(2);
if (!beforeF || !afterF) { console.error('usage: node coverage.mjs <before.json> <after.json> [sites.json]'); process.exit(2); }
const load = (f) => { const j = JSON.parse(readFileSync(f, 'utf8')); return new Map((j.rows || j.sites || j).map((r) => [r.id, r])); };
const B = load(beforeF), A = load(afterF);
const sites = JSON.parse(readFileSync(join(here, sitesF), 'utf8')).sites;

const bucket = (r) => {
  if (!r || r.verdict === 'ERROR' || r.outcome === 'error') return 'error';
  const o = String(r.outcome);
  if (/^converted/.test(o)) return /^converted, then/.test(o) ? '3D, then 2D' : '3D';
  if (/^(flat|standdown|guard|optout)/.test(o)) return '2D (reason)';
  return 'not found';
};
const why = (r) => {
  if (!r) return '';
  const o = String(r.outcome);
  const m = o.match(/\((.*)\)$/);
  return m ? m[1] : (bucket(r) === 'not found' ? `${o}${r.webgpuContexts ? ', WebGPU page' : ''}${r.webglContexts ? ', WebGL page' : ''}` : '');
};
const KINDS = [['webgl-example', 'threejs.org WebGL examples'], ['webgpu-example', 'threejs.org WebGPU examples'], ['site', 'Published three.js sites']];
const count = (rows, b) => rows.filter((x) => x === b).length;

const out = [];
out.push('| category | sites | 3D before (0.6.2) | 3D after (0.6.3) |', '|---|---|---|---|');
let tb = 0, ta = 0, tn = 0;
for (const [k, label] of KINDS) {
  const ss = sites.filter((s) => s.kind === k && bucket(A.get(s.id)) !== 'error' && bucket(B.get(s.id)) !== 'error');
  const b = count(ss.map((s) => bucket(B.get(s.id))), '3D'), a = count(ss.map((s) => bucket(A.get(s.id))), '3D');
  tb += b; ta += a; tn += ss.length;
  out.push(`| ${label} | ${ss.length} | ${b} | ${a} |`);
}
out.push(`| **all reachable** | **${tn}** | **${tb}** (${Math.round((100 * tb) / tn)} %) | **${ta}** (${Math.round((100 * ta) / tn)} %) |`, '');
out.push('| site | kind | before (0.6.2) | after (0.6.3) | why, after |', '|---|---|---|---|---|');
for (const s of sites) {
  const b = B.get(s.id), a = A.get(s.id);
  const mark = bucket(b) !== bucket(a) ? ' ⬆' : '';
  out.push(`| [${s.id}](${s.url}) | ${s.kind} | ${bucket(b)} | ${bucket(a)}${mark} | ${why(a).replace(/\|/g, '\\|').slice(0, 140)} |`);
}
console.log(out.join('\n'));

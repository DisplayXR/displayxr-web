// Print a compact view of a probe-gl JSON report: the frame's own summary and every worker's.
import { readFileSync } from 'node:fs';
const r = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const show = (label, s) => {
  if (!s) return;
  console.log(`== ${label} inWorker=${s.inWorker} href=${String(s.href).slice(0, 90)}`);
  console.log(' contexts', JSON.stringify(s.contexts.map((c) => [c.kind, c.type, c.w, c.h, c.t, c.readyState, c.attrs && JSON.stringify(c.attrs).slice(0, 160)])));
  console.log(' transfers', s.transfers, JSON.stringify(s.transferred || []), 'workers', JSON.stringify((s.workers || []).map((w) => [w.type, w.injected, w.url.slice(0, 70)])));
  console.log(' framesWithDraws', s.framesWithDraws, 'perFrame', JSON.stringify(s.perFrame));
  console.log(' fbo', JSON.stringify(s.drawsPerFboSize), 'viewports', JSON.stringify(s.viewports), 'programs', s.distinctPrograms, 'unseen', JSON.stringify(s.unseen));
  console.log(' ext', Object.keys(s.ext || {}).join(','));
  console.log(' shaders', s.shaders.count, 'kw', JSON.stringify(s.shaders.kw));
  console.log(' mat4Decl', JSON.stringify(s.shaders.mat4Decl));
  console.log(' blocks', JSON.stringify(s.shaders.blocks).slice(0, 1500));
  for (const [k, v] of Object.entries(s.mat4 || {})) console.log('  m4', k, v.n, JSON.stringify(v.kinds), v.multi ? 'MULTI' : '', JSON.stringify(v.sample));
  if (s.stereo && s.stereo.doubled + s.stereo.single) console.log(' stereo', JSON.stringify({ d: s.stereo.doubled, s: s.stereo.single, conv: s.stereo.convSamples.slice(-3) }));
  if (s.errors && s.errors.length) console.log(' errors', JSON.stringify(s.errors).slice(0, 600));
};
console.log('measure', JSON.stringify(r.measure));
show('frame', r.summary);
for (const [k, v] of Object.entries((r.summary && r.summary.workerReports) || {})) if (v && (v.contexts.length || v.framesWithDraws)) show('worker ' + k.slice(0, 80), v);

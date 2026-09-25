// Headless stereo harness for the rig map (js/inline3d-splat-rig-map.js): photo A → photo B (two SOGs with
// DIFFERENT camera blocks: convergence and vertical FOV), the page playing the runtime with a 1- or 2-frame
// rig-arrival lag. Per frame it logs which rig each photo is drawn through and where reference points of
// each photo land vs. where that photo's OWN rig puts them; plus the live outgoing target vs. the frame
// before the swap, and each run's end frame (compare to a cut).
//
//   python3 -m http.server 8791 --bind 127.0.0.1          # from the repo root
//   (put the two SOGs in tools/rig-swap-capture/assets/, gitignored — or ASSETS=<same-origin URL>)
//   A=ports.sog B=bakery.sog node tools/rig-swap-capture/run.mjs /tmp/out crossfade:1 crossfade:2 wavefront:2 swarm:2 cut:1 crossfade:2:oldrig
//
// case = transition:lag[:diag]. EYES=nominal for eyes at the nominal viewer (default: an off-centre, leaning
// head). ONE headless Chrome (ANGLE Metal), killed by PID on exit.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = process.argv[2];
const CASES = process.argv.slice(3);
const PORT = 9377;
const BASE = process.env.BASE || 'http://127.0.0.1:8791/tools/rig-swap-capture';
const Q = `${process.env.ASSETS ? `&assets=${encodeURIComponent(process.env.ASSETS)}` : ''}${process.env.A ? `&a=${process.env.A}` : ''}`;
const B_ASSET = process.env.B || 'bakery.sog';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const udd = mkdtempSync(join(tmpdir(), 'rigswap-udd-'));
const chrome = spawn(CHROME, ['--headless=new', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', `--remote-debugging-port=${PORT}`, `--user-data-dir=${udd}`, '--window-size=1400,900', '--hide-scrollbars', '--force-device-scale-factor=1', 'about:blank'], { stdio: 'ignore' });
const kill = () => {
  try { chrome.kill('SIGTERM'); } catch {}
  // children of THIS Chrome only: matched by our unique user-data-dir
  try { const pids = execFileSync('pgrep', ['-f', udd]).toString().trim().split('\n').filter(Boolean); for (const p of pids) { try { process.kill(+p, 'SIGKILL'); } catch {} } } catch {}
};
process.on('exit', kill);
process.on('SIGINT', () => { kill(); process.exit(1); });
for (let i = 0; i < 60; i++) { try { await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch { await sleep(200); } }
const page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const pending = new Map(); const logs = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.type + ' ' + m.params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 400));
  if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + JSON.stringify(m.params.exceptionDetails).slice(0, 800));
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 600));
  return r.result?.result?.value;
};
await send('Runtime.enable'); await send('Page.enable');
async function open(url) {
  logs.length = 0;
  await send('Page.navigate', { url });
  for (let i = 0; i < 600; i++) { await sleep(150); if (await ev('!!window.__ready').catch(() => false)) return; const e = await ev('window.__err || null').catch(() => null); if (e) throw new Error(e); }
  throw new Error('not ready ' + logs.slice(-5).join(' | '));
}
try {
  for (const c of CASES) {
    const [tr, lag, diag] = c.split(':');
    const url = `${BASE}/index.html?lag=${lag || 1}${process.env.EYES ? `&eyes=${process.env.EYES}` : ""}${Q}${diag ? `&diag=${diag}` : ''}`;
    await open(url);
    const aId = await ev('window.__setupA()');
    await ev('window.__step(10, 16.667, 10)');
    const o = tr === 'cut' ? { transition: 'cut' } : { transition: tr, ...(tr === 'swarm' ? {} : { durationMs: 900 }) };
    await ev(`window.__go(${JSON.stringify(B_ASSET)}, ${JSON.stringify(o)})`);
    const n = await ev('window.__until("window.__done || window.__err2", 1500)');
    const err2 = await ev('window.__err2');
    await ev('window.__step(90, 16.667, 12)');
    const png = await ev('window.__png()');
    const tag = c.replace(/:/g, '_');
    writeFileSync(`${OUT}/${tag}_end.png`, Buffer.from(png.split(',')[1], 'base64'));
    const pix = await ev('window.__pix || null');
    if (pix) for (const [k, v] of Object.entries(pix)) writeFileSync(`${OUT}/${c.replace(/:/g, '_')}_${k}.png`, Buffer.from(v.split(',')[1], 'base64'));
    const recs = await ev('window.__recs()');
    const rigs = await ev('window.__rigs()');
    const decls = await ev('window.__decls()');
    writeFileSync(`${OUT}/${tag}.json`, JSON.stringify({ case: c, aId, frames: n, err2, rigs, decls, recs, logs: logs.slice(-40) }));
    const worst = { A: 0, B: 0 };
    for (const rec of recs) for (const k of ['A', 'B']) if (rec.photos[k] && (k === 'B' || rec.photos[k].who === 'live')) worst[k] = Math.max(worst[k], rec.photos[k].err);
    const px = recs.filter((rec) => rec.pix).map((rec) => rec.pix);
    console.log(`${c.padEnd(22)} outgoing max ${worst.A.toFixed(3)} px, incoming max ${worst.B.toFixed(3)} px (vs. each photo's own rig)` +
      (px.length ? `; live target vs. pre-swap frame: MAE ≤ ${Math.max(...px.map((p) => p.mae))}, max ${Math.max(...px.map((p) => p.max))} (${[...new Set(px.map((p) => p.path))].join('/')})` : '') + (err2 ? ` ERROR ${err2}` : ''));
  }
} finally {
  ws.close();
  kill();
}

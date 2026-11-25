#!/usr/bin/env node
// test/bundlers/run.mjs — the C1 gate's bundler smoke tests (RFC 0003 §7): Vite, webpack and
// esbuild builds of a tiny app on `/call/full` and one on plain `/call`.
//
//   npm run test:bundlers            # installs test/bundlers/node_modules on first run (network)
//
// For each bundler × app it asserts the build succeeds and the output carries the `<dxr-call>`
// registration (not tree-shaken: `sideEffects`) and the 'lift-not-bundled' path. Then it RUNS
// every output in Node:
//   /call/full  → `liftBundled` must equal "js/lift/index.js is the real module" for this
//                 checkout (true once feat/lift has landed — and then the /call/full output must
//                 be materially larger than /call's, i.e. lift was actually shipped; false with
//                 the placeholder, where the build merely has to succeed everywhere);
//   /call       → against the recording DOM of test/call-dom.mjs with a woven fake wall and a
//                 mono peer, the bundled call must emit `warning { code: 'lift-not-bundled' }` —
//                 the computed import failed the way it does in a real deployment, and the call
//                 said so instead of staying flat in silence.
//
// Not part of `npm test`: it installs three bundlers (~40 s cold) and takes ~10 s warm.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = resolve(dirname(fileURLToPath(import.meta.url)));
const root = resolve(here, '..', '..');
const out = resolve(here, 'out');
const apps = ['app-call', 'app-full']; // /call first: /call/full's size check compares against it
const results = [];
const t0 = Date.now();

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: here, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...opts });

// ── install (once) ────────────────────────────────────────────────────────────────────────
if (!existsSync(resolve(here, 'node_modules/vite')) || !existsSync(resolve(here, 'node_modules/webpack')) || !existsSync(resolve(here, 'node_modules/esbuild'))) {
  console.log('bundlers: installing vite + webpack + esbuild into test/bundlers/node_modules …');
  sh('npm', ['install', '--no-audit', '--no-fund', '--no-package-lock'], { stdio: 'inherit' });
}
// `file:../..` is a symlink to the repo; the entries resolve through the real package.json exports.
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const versions = {};
for (const p of ['vite', 'webpack', 'esbuild']) versions[p] = JSON.parse(readFileSync(resolve(here, 'node_modules', p, 'package.json'), 'utf8')).version;
console.log(`bundlers: vite ${versions.vite}, webpack ${versions.webpack}, esbuild ${versions.esbuild}`);

// ── builds ────────────────────────────────────────────────────────────────────────────────
const builds = {
  async esbuild(app) {
    const { build } = await import(pathToFileURL(resolve(here, 'node_modules/esbuild/lib/main.js')).href);
    const outfile = resolve(out, 'esbuild', `${app}.js`);
    await build({ entryPoints: [resolve(here, 'src', `${app}.js`)], bundle: true, format: 'esm', outfile, logLevel: 'silent', target: 'es2022' });
    return outfile;
  },
  async vite(app) {
    const dir = resolve(out, 'vite', app);
    const cfg = resolve(out, `vite.${app}.config.mjs`);
    writeFileSync(
      cfg,
      `export default { logLevel: 'error', build: { outDir: ${JSON.stringify(dir)}, emptyOutDir: true, minify: false, target: 'es2022',
        lib: { entry: ${JSON.stringify(resolve(here, 'src', `${app}.js`))}, formats: ['es'], fileName: () => '${app}.js' },
        rollupOptions: { output: { inlineDynamicImports: false } } } };\n`
    );
    sh(resolve(here, 'node_modules/.bin/vite'), ['build', '--config', cfg]);
    return resolve(dir, `${app}.js`);
  },
  async webpack(app) {
    const dir = resolve(out, 'webpack', app);
    const cfg = resolve(out, `webpack.${app}.config.mjs`);
    writeFileSync(
      cfg,
      `export default { mode: 'production', entry: ${JSON.stringify(resolve(here, 'src', `${app}.js`))}, devtool: false,
        experiments: { outputModule: true }, target: ['web', 'es2022'],
        output: { path: ${JSON.stringify(dir)}, filename: '${app}.js', module: true, library: { type: 'module' }, clean: true },
        optimization: { minimize: false }, stats: 'errors-only' };\n`
    );
    sh(resolve(here, 'node_modules/.bin/webpack'), ['--config', cfg]);
    return resolve(dir, `${app}.js`);
  },
};

const liftSrc = readFileSync(resolve(root, 'js/lift/index.js'), 'utf8');
const realLift = !/LIFT_PLACEHOLDER/.test(liftSrc) && (/\bexport\s*\{[^}]*\blift\b/.test(liftSrc) || /\bexport\s+(async\s+)?function\s+lift\b/.test(liftSrc));
console.log(`bundlers: js/lift/index.js is ${realLift ? 'the real lift module — /call/full must ship it' : 'the PLACEHOLDER (feat/lift not merged) — /call/full must build and report liftBundled=false'}`);

let failed = 0;
const fail = (msg) => {
  failed++;
  console.log(`  FAIL ${msg}`);
};

for (const bundler of Object.keys(builds)) {
  for (const app of apps) {
    const t = Date.now();
    let file;
    try {
      file = await builds[bundler](app);
    } catch (err) {
      fail(`${bundler} × ${app}: build failed — ${String(err.stderr || err.message).trim().split('\n').slice(0, 6).join('\n       ')}`);
      results.push({ bundler, app, ok: false });
      continue;
    }
    const src = readFileSync(file, 'utf8');
    const kb = src.length / 1024;
    const hasWarn = src.includes('lift-not-bundled');
    const hasElement = src.includes('dxr-call');
    const r = { bundler, app, ok: true, kb, ms: Date.now() - t, hasWarn, hasElement, file };
    if (!hasWarn) fail(`${bundler} × ${app}: the 'lift-not-bundled' path is missing`), (r.ok = false);
    if (!hasElement) fail(`${bundler} × ${app}: <dxr-call> registration was tree-shaken away (sideEffects)`), (r.ok = false);
    if (realLift && app === 'app-full') {
      const call = results.find((x) => x.bundler === bundler && x.app === 'app-call');
      if (call && !(kb > call.kb + 5)) fail(`${bundler} × ${app}: /call/full is not larger than /call (${kb.toFixed(1)} vs ${call.kb.toFixed(1)} KB) — lift was not shipped`), (r.ok = false);
    }
    results.push(r);
    console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${bundler.padEnd(8)} ${app.padEnd(9)} ${kb.toFixed(1).padStart(7)} KB  ${String(r.ms).padStart(5)} ms  warn-path=${hasWarn} element=${hasElement}`);
  }
}

// ── run the bundles: does the bundled /call actually emit the warning? ──────────────────────
const { installCallDom, doc, channels, FakeTrack, FakeStream, silentUntilLayerWall } = await import(pathToFileURL(resolve(root, 'test/call-dom.mjs')).href);
installCallDom();
globalThis.HTMLElement = class {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const onePeer = { async join(room, hooks) { return { id: hooks.id, peers: ['~~~~~~~~~~~'], send() {}, leave() {} }; } };
const origWarn = console.warn;
const origInfo = console.info;
for (const r of results.filter((x) => x.ok)) {
  let mod;
  try {
    mod = await import(pathToFileURL(r.file).href);
  } catch (err) {
    fail(`${r.bundler} × ${r.app}: the output does not import in Node — ${err.message.split('\n')[0]}`);
    continue;
  }
  if (r.app === 'app-full') {
    if (mod.liftBundled !== realLift) fail(`${r.bundler} × ${r.app}: liftBundled=${mod.liftBundled}, expected ${realLift}`);
    else console.log(`  run  ${r.bundler.padEnd(8)} ${r.app}: liftBundled=${mod.liftBundled} (matches this checkout)`);
    continue;
  }
  const w = silentUntilLayerWall();
  const warnings = [];
  const warned = [];
  console.warn = (...a) => warned.push(a.join(' '));
  console.info = () => {};
  const host = doc.body.appendChild(doc.createElement('div'));
  let call;
  try {
    call = await mod.start(w.wall, host, {
      signaling: onePeer,
      room: 'R'.repeat(22),
      ui: false,
      audio: false,
      selfView: false,
      camera: new FakeStream([new FakeTrack('video')]),
      format: 'mono',
      mono3D: 'auto',
    });
    call.on('warning', (e) => warnings.push(e));
    await call.join();
    const hello = { type: 'hello', v: 1, format: 'mono', width: 640, height: 480 };
    for (const dc of channels) dc.onmessage && dc.onmessage({ data: JSON.stringify(hello) });
    const v = doc.created.filter((e) => e.tagName === 'VIDEO' && (e.listeners.playing || []).length).at(-1);
    Object.assign(v, { readyState: 4, videoWidth: 640, videoHeight: 480 });
    v.fire('playing');
    for (let i = 0; i < 400 && !warnings.length; i++) await sleep(5);
  } catch (err) {
    fail(`${r.bundler} × ${r.app}: running the bundle threw — ${err.message}`);
  } finally {
    console.warn = origWarn;
    console.info = origInfo;
    call?.leave();
  }
  const code = warnings.map((e) => e.code).join(',');
  const reason = call?.mono3D?.reason;
  if (code !== 'lift-not-bundled') fail(`${r.bundler} × ${r.app}: bundled /call emitted [${code}] (mono3D.reason=${reason}); expected lift-not-bundled`);
  else console.log(`  run  ${r.bundler.padEnd(8)} ${r.app}: warning lift-not-bundled emitted once (mono3D.reason=${reason}, console.warn ×${warned.filter((m) => m.includes('lift-not-bundled')).length})`);
}

console.log(`bundlers: ${failed ? `FAIL (${failed})` : 'PASS'} — ${results.filter((r) => r.ok).length}/${results.length} builds ok in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
process.exit(failed ? 1 : 0);

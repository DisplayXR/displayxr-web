#!/usr/bin/env node
// build.mjs — build the DisplayXR Browser's built-in "Convert to 3D" bundle into lift-sdk/.
//
//   npm run build:lift-builtin            (from the repo root)
//   node tools/lift-builtin/build.mjs [--out <dir>] [--no-minify]
//
// Output (lift-sdk/, gitignored) — exactly the files displayxr-browser-pvt's
// scripts/stage-lift-resources.sh stages into the pak (served as displayxr-lift://runtime/<file>):
//   displayxr-lift-builtin.js           the IIFE: SDK lift core + providers + DIBR + generator +
//                                       explore + the PlayCanvas engine slice it uses (+ .map, NOT staged)
//   ort.jspi.min.mjs                    onnxruntime-web, pinned (ORT_VERSION in js/lift/providers/ort.js)
//   ort-wasm-simd-threaded.jspi.mjs     its wasm glue (import()ed by the above)
//   ort-wasm-simd-threaded.jspi.wasm    its wasm (fetched by the glue)
//   MANIFEST.json                       file, size, sha256 + SDK version, commit, ORT version
//
// The SDK is dependency-free; the build-only deps (esbuild, playcanvas, onnxruntime-web) are
// pinned in tools/lift-builtin/package.json and installed there on first run (`npm ci`).
// (Until 2026-09 the explore renderer was three + Spark — 85 % of the bundle; see docs/lift-builtin.md.)

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const OUT = path.resolve(ROOT, argOf('--out', 'lift-sdk'));
const MINIFY = !args.includes('--no-minify');

// ── build-only deps ─────────────────────────────────────────────────────────────────────────
const NM = path.join(HERE, 'node_modules');
if (!fs.existsSync(path.join(NM, 'esbuild')) || !fs.existsSync(path.join(NM, 'playcanvas'))) {
  console.log('[lift-builtin] installing pinned build deps (tools/lift-builtin/package.json)…');
  execSync(fs.existsSync(path.join(HERE, 'package-lock.json')) ? 'npm ci --no-audit --no-fund' : 'npm install --no-audit --no-fund', { cwd: HERE, stdio: 'inherit' });
}
const esbuild = (await import(pathToFileURL(path.join(NM, 'esbuild/lib/main.js')).href)).default;
const pkgOf = (p) => JSON.parse(fs.readFileSync(path.join(p, 'package.json'), 'utf8'));
const buildPkg = pkgOf(HERE);
const pinned = buildPkg.devDependencies;
const have = (name) => pkgOf(path.join(NM, name)).version;
for (const n of Object.keys(pinned)) {
  if (have(n) !== pinned[n]) throw new Error(`[lift-builtin] ${n} is ${have(n)}, package.json pins ${pinned[n]} — run npm ci in tools/lift-builtin`);
}

// ── versions ────────────────────────────────────────────────────────────────────────────────
const sdkVersion = pkgOf(ROOT).version;
const git = (c) => { try { return execSync(`git ${c}`, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; } };
const commit = git('rev-parse HEAD') || 'unknown';
const dirty = git('status --porcelain -- js tools/lift-builtin package.json') !== '';
const version = `${sdkVersion}+${commit.slice(0, 7)}${dirty ? '.dirty' : ''}`;

// The SDK's ORT pin is the ONE source of truth: the dist we copy must be exactly that build.
const ortSrc = fs.readFileSync(path.join(ROOT, 'js/lift/providers/ort.js'), 'utf8');
const ORT_VERSION = /ORT_VERSION = '([^']+)'/.exec(ortSrc)[1];
if (have('onnxruntime-web') !== ORT_VERSION)
  throw new Error(`[lift-builtin] js/lift/providers/ort.js pins ORT ${ORT_VERSION} but tools/lift-builtin has ${have('onnxruntime-web')}`);

// ── plugins: source transforms that make the SDK + PlayCanvas run as a classic script in the lift world
// The engine's ES-module SOURCE tree (build/playcanvas/src), not its prebuilt bundle: esbuild then
// tree-shakes it down to what js/inline3d-playcanvas-engine.js names.
const PC_SRC = path.join(NM, 'playcanvas/build/playcanvas/src');
const PC_SORTER = /[\\/]scene[\\/]gsplat-unified[\\/]gsplat-unified-sorter\.js$/;
const PC_SORT_WORKER = /[\\/]scene[\\/]gsplat-unified[\\/]gsplat-unified-sort-worker\.js$/;
const WORKERS = path.join(HERE, 'workers.js');
const LIFTGEN = path.join(ROOT, 'js/lift/gen/lift-gen.js');
const PLYWRITER = path.join(ROOT, 'js/lift/gen/ply-writer.js');
const MODELS = path.join(ROOT, 'js/lift/providers/models.js');
const rel = (p) => JSON.stringify(p);

function mustReplace(src, from, to, what) {
  const n = src.split(from).length - 1;
  if (n < 1) throw new Error(`[lift-builtin] transform "${what}" found no match — did the source change?`);
  return src.split(from).join(to);
}

/**
 * PlayCanvas's gsplat SORT worker (the one worker the explore renderer runs). The engine builds it
 * as a blob: worker from `(${UnifiedSortWorker.toString()})()` with the bin-weights class pasted
 * in front BY NAME. Two changes:
 *   1. the worker function takes its dependencies as PARAMETERS — `(self, GSplatSortBinWeights)` —
 *      instead of reaching for free globals. Minification renames the function's reference to the
 *      class, so the engine's by-name paste would be a ReferenceError inside a minified worker;
 *      passed in, the names are the function's own.
 *   2. where the probe said blob workers are blocked (the page's CSP), the same function runs
 *      IN-THREAD behind workers.js mainThreadWorker() — no eval, no blob: URL.
 */
function transformPcSortWorker(src) {
  src = mustReplace(src, 'function UnifiedSortWorker() {', 'function UnifiedSortWorker(__dxrSelf, GSplatSortBinWeights) {', 'pc sort worker signature');
  return mustReplace(
    src,
    'const myself = typeof self !== "undefined" && self || require("node:worker_threads").parentPort;',
    'const myself = __dxrSelf || self;',
    'pc sort worker self',
  );
}
function transformPcSorter(src) {
  src = mustReplace(
    src,
    '(${UnifiedSortWorker.toString()})()',
    '(${UnifiedSortWorker.toString()})(self, GSplatSortBinWeights)',
    'pc sorter worker call',
  );
  src = mustReplace(
    src,
    'this.worker = new Worker(URL.createObjectURL(new Blob([workerSource], {\n\t\t\t\ttype: "application/javascript"\n\t\t\t})));',
    'this.worker = __dxrWorkersOk() ? new Worker(URL.createObjectURL(new Blob([workerSource], { type: "application/javascript" }))) : __dxrMainThreadWorker((s) => UnifiedSortWorker(s, GSplatSortBinWeights));',
    'pc sorter worker creation',
  );
  return `import { workersOk as __dxrWorkersOk, mainThreadWorker as __dxrMainThreadWorker } from ${rel(WORKERS)};\n` + src;
}

/** lift-gen: the PLY emit worker becomes a blob worker from a pre-built IIFE of ply-writer.js, used
 *  only when the probe said workers work; otherwise lift-gen's own in-thread emit. */
async function transformLiftGen(src) {
  const ply = await esbuild.build({ entryPoints: [PLYWRITER], bundle: true, format: 'iife', write: false, minify: MINIFY, target: 'chrome120', logLevel: 'silent' });
  const plySrc = ply.outputFiles[0].text;
  src = mustReplace(src, "new Worker(new URL('./ply-writer.js', import.meta.url), { type: 'module' })", '__dxrPlyWorker()', 'lift-gen worker url');
  src = mustReplace(src, "worker && typeof Worker === 'function'", "worker && __dxrWorkersOk() && typeof Worker === 'function'", 'lift-gen worker gate');
  return (
    `import { workersOk as __dxrWorkersOk } from ${rel(WORKERS)};\n` +
    `const __dxrPlySrc = ${JSON.stringify(plySrc)};\n` +
    `let __dxrPlyUrl = null;\n` +
    `function __dxrPlyWorker() { __dxrPlyUrl = __dxrPlyUrl || URL.createObjectURL(new Blob([__dxrPlySrc], { type: 'text/javascript' })); return new Worker(__dxrPlyUrl); }\n` +
    src
  );
}

/** models.js: DEFAULT_MANIFEST_URL is resolved against import.meta.url at module init (empty in an
 *  IIFE → TypeError). In the browser the manifest is the pak's runtime/models.json. */
function transformModels(src) {
  return mustReplace(src, "new URL('../models.json', import.meta.url).href", "'displayxr-lift://runtime/models.json'", 'models.js manifest url');
}

const liftPlugin = {
  name: 'dxr-lift-builtin',
  setup(b) {
    b.onLoad({ filter: PC_SORT_WORKER }, async (a) => ({ contents: transformPcSortWorker(await fs.promises.readFile(a.path, 'utf8')), loader: 'js', resolveDir: path.dirname(a.path) }));
    b.onLoad({ filter: PC_SORTER }, async (a) => ({ contents: transformPcSorter(await fs.promises.readFile(a.path, 'utf8')), loader: 'js', resolveDir: path.dirname(a.path) }));
    b.onLoad({ filter: /[\\/]js[\\/]lift[\\/]gen[\\/]lift-gen\.js$/ }, async (a) => ({ contents: await transformLiftGen(await fs.promises.readFile(a.path, 'utf8')), loader: 'js', resolveDir: path.dirname(a.path) }));
    b.onLoad({ filter: /[\\/]js[\\/]lift[\\/]providers[\\/]models\.js$/ }, async (a) => ({ contents: transformModels(await fs.promises.readFile(a.path, 'utf8')), loader: 'js', resolveDir: path.dirname(a.path) }));
    // The dev-only stub backend is never used by the built-in: keep it out of the bundle.
    b.onResolve({ filter: /^\.\/stubs\// }, (a) => (a.importer.endsWith(path.join('lift', 'lift.js')) ? { path: a.path, namespace: 'dxr-stub' } : undefined));
    b.onLoad({ filter: /.*/, namespace: 'dxr-stub' }, () => ({ contents: "throw new Error('lift: the stub backend is not in the built-in bundle');", loader: 'js' }));
    // Bare peers resolve to the pinned build deps.
    b.onResolve({ filter: /^playcanvas$/ }, () => ({ path: path.join(PC_SRC, 'index.js') }));
    // The engine's Node branches (`platform.environment === 'node'`) require worker_threads; never
    // taken in a browser. An empty module keeps the bundle free of a require().
    b.onResolve({ filter: /^node:worker_threads$/ }, () => ({ path: 'worker_threads', namespace: 'dxr-empty' }));
    b.onLoad({ filter: /.*/, namespace: 'dxr-empty' }, () => ({ contents: 'export default {};', loader: 'js' }));
  },
};

// ── bundle ──────────────────────────────────────────────────────────────────────────────────
fs.mkdirSync(OUT, { recursive: true });
const t0 = Date.now();
const res = await esbuild.build({
  entryPoints: [path.join(HERE, 'entry.js')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  minify: MINIFY,
  sourcemap: 'external',
  legalComments: 'eof',
  charset: 'utf8',
  outfile: path.join(OUT, 'displayxr-lift-builtin.js'),
  define: { __DXR_LIFT_VERSION__: JSON.stringify(version) },
  banner: { js: `/* @displayxr/inline3d lift built-in ${version} — ORT ${ORT_VERSION}, PlayCanvas ${pinned.playcanvas}. Generated by tools/lift-builtin/build.mjs; do not edit. */` },
  plugins: [liftPlugin],
  metafile: true,
  logLevel: 'warning',
});
if (res.errors.length) process.exit(1);
const out = fs.readFileSync(path.join(OUT, 'displayxr-lift-builtin.js'), 'utf8');
// Guards: nothing may depend on a module URL or an ES module context at runtime.
if (/import\.meta/.test(out)) throw new Error('[lift-builtin] output still references import.meta');
if (/^\s*(import|export)\s[^(]/m.test(out)) throw new Error('[lift-builtin] output has static import/export — not a classic script');
const dyn = [...out.matchAll(/\bimport\(([^)]{0,40})/g)].map((x) => x[1]);
console.log(`[lift-builtin] dynamic import() sites left in the bundle (must all be ORT's runtime URL): ${JSON.stringify(dyn)}`);

// ── ORT runtime siblings ────────────────────────────────────────────────────────────────────
const ORT_FILES = ['ort.jspi.min.mjs', 'ort-wasm-simd-threaded.jspi.mjs', 'ort-wasm-simd-threaded.jspi.wasm'];
const ORT_DIST = path.join(NM, 'onnxruntime-web/dist');
for (const f of ORT_FILES) fs.copyFileSync(path.join(ORT_DIST, f), path.join(OUT, f));

// ── MANIFEST.json ───────────────────────────────────────────────────────────────────────────
const staged = ['displayxr-lift-builtin.js', ...ORT_FILES];
const files = staged.map((f) => {
  const buf = fs.readFileSync(path.join(OUT, f));
  return { file: f, size: buf.length, gzip: zlib.gzipSync(buf, { level: 9 }).length, brotli: zlib.brotliCompressSync(buf).length, sha256: createHash('sha256').update(buf).digest('hex') };
});
const manifest = {
  schema: 1,
  name: 'displayxr-lift-builtin',
  version,
  sdkVersion,
  commit,
  dirty,
  built: new Date().toISOString(),
  ort: { package: 'onnxruntime-web', version: ORT_VERSION, bundle: 'jspi' },
  playcanvas: pinned.playcanvas,
  esbuild: pinned.esbuild,
  // The models manifest compiled into the bundle. The browser's installer/models.json (staged as
  // runtime/models.json, and what the native store serves by name) must be byte-identical.
  modelsJson: (() => { const b = fs.readFileSync(path.join(ROOT, 'js/lift/models.json')); return { sha256: createHash('sha256').update(b).digest('hex'), size: b.length, generated: JSON.parse(b).generated }; })(),
  runtimeBase: 'displayxr-lift://runtime/',
  modelsBase: 'displayxr-lift://models/',
  files,
};
fs.writeFileSync(path.join(OUT, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');

const inputs = Object.entries(res.metafile.outputs).find(([k]) => k.endsWith('.js'))[1].inputs;
const byPkg = {};
for (const [k, v] of Object.entries(inputs)) {
  const key = k.includes('node_modules/') ? k.split('node_modules/')[1].split('/').slice(0, k.includes('@') ? 2 : 1).join('/') : k.startsWith('js/') || k.includes('/js/') ? 'sdk js/' : k;
  byPkg[key] = (byPkg[key] || 0) + v.bytesInOutput;
}
console.log(`[lift-builtin] ${version} → ${path.relative(ROOT, OUT)}/ in ${Date.now() - t0} ms`);
for (const f of files) console.log(`  ${f.file.padEnd(36)} ${(f.size / 1024).toFixed(0).padStart(7)} KiB  gz ${(f.gzip / 1024).toFixed(0).padStart(6)} KiB  br ${(f.brotli / 1024).toFixed(0).padStart(6)} KiB`);
console.log('  bundle composition (minified bytes):');
for (const [k, v] of Object.entries(byPkg).sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`    ${k.padEnd(40)} ${(v / 1024).toFixed(0).padStart(7)} KiB`);

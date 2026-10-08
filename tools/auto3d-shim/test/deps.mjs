// Resolves the engines the test pages import into test/.deps/ (gitignored). Nothing is fetched
// from threejs.org or a CDN at test time: three and playcanvas come from the npm registry (npm pack)
// unless a local copy is named.
//   THREE_BUILD_DIR=<dir with three.module.js + three.core.js + three.webgpu.js>   (default: npm pack three@0.180.0)
//   PLAYCANVAS_MJS=<path to build/playcanvas.mjs>                 (default: npm pack playcanvas@2.22.3)
//   SPARK_DIST=<dir with spark.module.js>                         (default: npm pack @sparkjsdev/spark@2.2.0)
// The addons the pages use (three's OrbitControls, PlayCanvas's CameraControls script) come from the
// same npm versions, unless a local copy is found or named — so a box with no registry access (the
// Windows panel box) can run the whole harness from local files:
//   THREE_ORBIT_CONTROLS=<path to OrbitControls.js>        (else <THREE_BUILD_DIR>/../examples/jsm/controls/OrbitControls.js if it exists)
//   PLAYCANVAS_CAMERA_CONTROLS=<path to camera-controls.mjs> (else <PLAYCANVAS_MJS>/../../scripts/esm/camera-controls.mjs if it exists)
//   THREE_PASS_JS=<path to postprocessing/Pass.js>          (else <THREE_BUILD_DIR>/../examples/jsm/postprocessing/Pass.js if it exists;
//                                                            Spark imports its FullScreenQuad)
// Every step fails LOUDLY (non-zero exit, names the file and the override to use): a missing engine
// otherwise shows up much later as a page that never converts. run.mjs checks the same files first.
//
// Windows: `npm` is `npm.cmd` there, which Node refuses to spawn without a shell (EINVAL since the
// 2024 batch-file fix), so npm runs through the shell on win32. tar runs in the temp dir with a
// relative archive name: a Git Bash GNU tar would read `C:\…` as a remote host.
import { execFileSync, execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '.deps');
const THREE = 'three@0.180.0';
const PLAYCANVAS = 'playcanvas@2.22.3';
const SPARK = '@sparkjsdev/spark@2.2.0'; // World Labs' splat renderer for three (peer: three >= 0.180)
const WIN = process.platform === 'win32';

// The files the pages import, by .deps path (run.mjs's preflight checks the same list).
const DEP_FILES = ['three/three.module.js', 'three/three.core.js', 'three/three.webgpu.js', 'three/OrbitControls.js', 'playcanvas/playcanvas.mjs', 'playcanvas/camera-controls.mjs', 'three/Pass.js', 'spark/spark.module.js'];

function die(msg) {
  console.error(`\ndeps: FAILED — ${msg}\n`);
  process.exit(1);
}
function npmPack(spec, dest) {
  const args = ['pack', spec, '--silent', '--pack-destination', dest];
  try {
    const text = WIN
      ? execSync(`npm ${args.map((a) => `"${a}"`).join(' ')}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      : execFileSync('npm', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return text.trim().split(/\r?\n/).pop().trim();
  } catch (e) {
    const why = String((e && (e.stderr || e.message)) || e).trim().split(/\r?\n/).slice(-3).join(' | ');
    die(`npm pack ${spec} failed (${why}). No registry access? Point the env overrides in deps.mjs's header at local copies.`);
  }
}
const packs = new Map();
function packed(spec, files) {
  let tmp = packs.get(spec);
  if (!tmp) {
    tmp = mkdtempSync(join(tmpdir(), 'dxr-auto3d-'));
    const tgz = npmPack(spec, tmp);
    try { execFileSync('tar', ['-xzf', tgz], { cwd: tmp }); } catch (e) { die(`could not unpack ${tgz} in ${tmp}: ${e.message}`); }
    packs.set(spec, tmp);
  }
  for (const f of files) if (!existsSync(join(tmp, 'package', f))) die(`${spec} has no ${f}`);
  return (f) => join(tmp, 'package', f);
}
// One .deps file: from `local` (an explicit or derived local path) when given, else from the npm pack.
function ensure(dir, file, local, env, spec) {
  const name = file.split('/').pop();
  const dst = join(out, dir, name);
  mkdirSync(join(out, dir), { recursive: true });
  if (existsSync(dst)) return console.log(`deps: ${dir}/${name} present`);
  if (local && !existsSync(local)) die(`${env} names ${local}, which does not exist`);
  const src = local || packed(spec, [file])(file);
  copyFileSync(src, dst);
  console.log(`deps: ${dir}/${name} <- ${local || spec}`);
}
const env = (k) => (process.env[k] ? resolve(process.env[k]) : null);
const derived = (base, rel) => { if (!base) return null; const p = resolve(base, rel); return existsSync(p) ? p : null; };
const threeDir = env('THREE_BUILD_DIR'), pcMjs = env('PLAYCANVAS_MJS'), sparkDir = env('SPARK_DIST');
ensure('three', 'build/three.module.js', threeDir && join(threeDir, 'three.module.js'), 'THREE_BUILD_DIR', THREE);
ensure('three', 'build/three.core.js', threeDir && join(threeDir, 'three.core.js'), 'THREE_BUILD_DIR', THREE);
ensure('three', 'build/three.webgpu.js', threeDir && join(threeDir, 'three.webgpu.js'), 'THREE_BUILD_DIR', THREE); // WebGPURenderer (+ its WebGL2 fallback backend)
ensure('three', 'examples/jsm/controls/OrbitControls.js', env('THREE_ORBIT_CONTROLS') || derived(threeDir, '../examples/jsm/controls/OrbitControls.js'), 'THREE_ORBIT_CONTROLS', THREE);
ensure('three', 'examples/jsm/postprocessing/Pass.js', env('THREE_PASS_JS') || derived(threeDir, '../examples/jsm/postprocessing/Pass.js'), 'THREE_PASS_JS', THREE);
ensure('spark', 'dist/spark.module.js', sparkDir && join(sparkDir, 'spark.module.js'), 'SPARK_DIST', SPARK);
ensure('playcanvas', 'build/playcanvas.mjs', pcMjs, 'PLAYCANVAS_MJS', PLAYCANVAS);
ensure('playcanvas', 'scripts/esm/camera-controls.mjs', env('PLAYCANVAS_CAMERA_CONTROLS') || derived(pcMjs && dirname(pcMjs), '../scripts/esm/camera-controls.mjs'), 'PLAYCANVAS_CAMERA_CONTROLS', PLAYCANVAS);
for (const f of DEP_FILES) if (!existsSync(join(out, f))) die(`.deps/${f} is still missing after resolution`);

// Resolves the engines the test pages import into test/.deps/ (gitignored). Nothing is fetched
// from threejs.org or a CDN at test time: three and playcanvas come from the npm registry (npm pack)
// unless a local copy is named.
//   THREE_BUILD_DIR=<dir with three.module.js + three.core.js>   (default: npm pack three@0.180.0)
//   PLAYCANVAS_MJS=<path to build/playcanvas.mjs>                 (default: npm pack playcanvas@2.22.3)
// The addons the pages use (three's OrbitControls, PlayCanvas's CameraControls script) always come
// from the same npm versions.
//
// Windows: `npm` is `npm.cmd` there, which Node refuses to spawn without a shell (EINVAL since the
// 2024 batch-file fix), so npm runs through the shell on win32. tar runs in the temp dir with a
// relative archive name: a Git Bash GNU tar would read `C:\…` as a remote host.
import { execFileSync, execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '.deps');
const THREE = 'three@0.180.0';
const PLAYCANVAS = 'playcanvas@2.22.3';
const WIN = process.platform === 'win32';

function npmPack(spec, dest) {
  const args = ['pack', spec, '--silent', '--pack-destination', dest];
  const text = WIN
    ? execSync(`npm ${args.map((a) => `"${a}"`).join(' ')}`, { encoding: 'utf8' })
    : execFileSync('npm', args, { encoding: 'utf8' });
  return text.trim().split(/\r?\n/).pop().trim();
}
const packs = new Map();
function packed(spec, files) {
  let tmp = packs.get(spec);
  if (!tmp) {
    tmp = mkdtempSync(join(tmpdir(), 'dxr-auto3d-'));
    const tgz = npmPack(spec, tmp);
    execFileSync('tar', ['-xzf', tgz], { cwd: tmp });
    packs.set(spec, tmp);
  }
  for (const f of files) if (!existsSync(join(tmp, 'package', f))) throw new Error(`${spec} has no ${f}`);
  return (f) => join(tmp, 'package', f);
}
function ensure(dir, files, local, spec, srcPath) {
  const dst = join(out, dir);
  mkdirSync(dst, { recursive: true });
  if (files.every((f) => existsSync(join(dst, f.split('/').pop())))) return console.log(`deps: ${dir} ${files.map((f) => f.split('/').pop()).join(', ')} present`);
  const from = srcPath ? () => srcPath : local ? (f) => join(local, f.split('/').pop()) : packed(spec, files);
  for (const f of files) copyFileSync(from(f), join(dst, f.split('/').pop()));
  console.log(`deps: ${dir} <- ${local || srcPath || spec}`);
}
ensure('three', ['build/three.module.js', 'build/three.core.js'], process.env.THREE_BUILD_DIR, THREE);
ensure('three', ['examples/jsm/controls/OrbitControls.js'], null, THREE);
ensure('playcanvas', ['build/playcanvas.mjs'], null, PLAYCANVAS, process.env.PLAYCANVAS_MJS);
ensure('playcanvas', ['scripts/esm/camera-controls.mjs'], null, PLAYCANVAS);

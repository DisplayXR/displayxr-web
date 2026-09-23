// Resolves the engines the test pages import into test/.deps/ (gitignored). Nothing is fetched
// from threejs.org or a CDN at test time: three and playcanvas come from the npm registry (npm pack)
// unless a local copy is named.
//   THREE_BUILD_DIR=<dir with three.module.js + three.core.js>   (default: npm pack three@0.180.0)
//   PLAYCANVAS_MJS=<path to build/playcanvas.mjs>                 (default: npm pack playcanvas@2.22.3)
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '.deps');
const THREE = 'three@0.180.0';
const PLAYCANVAS = 'playcanvas@2.22.3';

function packed(spec, files) {
  const tmp = mkdtempSync(join(tmpdir(), 'dxr-auto3d-'));
  const tgz = execFileSync('npm', ['pack', spec, '--silent', '--pack-destination', tmp], { encoding: 'utf8' }).trim().split('\n').pop();
  execFileSync('tar', ['-xzf', join(tmp, tgz), '-C', tmp, ...files.map((f) => `package/${f}`)]);
  return (f) => join(tmp, 'package', f);
}
function ensure(dir, files, local, spec, srcPath) {
  const dst = join(out, dir);
  mkdirSync(dst, { recursive: true });
  if (files.every((f) => existsSync(join(dst, f.split('/').pop())))) return console.log(`deps: ${dir} present`);
  const from = srcPath ? () => srcPath : local ? (f) => join(local, f.split('/').pop()) : packed(spec, files);
  for (const f of files) copyFileSync(from(f), join(dst, f.split('/').pop()));
  console.log(`deps: ${dir} <- ${local || srcPath || spec}`);
}
ensure('three', ['build/three.module.js', 'build/three.core.js'], process.env.THREE_BUILD_DIR, THREE);
ensure('playcanvas', ['build/playcanvas.mjs'], null, PLAYCANVAS, process.env.PLAYCANVAS_MJS);

#!/usr/bin/env node
// tools/vendor/three-mesh-bvh.mjs — rebuilds js/vendor/three-mesh-bvh.js, the slice of
// three-mesh-bvh (MIT, Garrett Johnson) the depth cursor's BVH pick uses: `MeshBVH` only.
//
//   npm run vendor:bvh          # after bumping VERSION below (an exact release >= 2 weeks old)
//
// Why vendored and not a bare `import('three-mesh-bvh')`: the SDK must not add an import-map entry
// (or a bundler dependency) to every page that uses ./model, and `cursor: 'depth'` is opt-in — so
// the module ships inside the package and ./model imports it DYNAMICALLY, only on opt-in. `three`
// stays external: the slice imports the page's own three.js through the same `three` specifier the
// SDK already requires. Commit the output together with the pin.
//
// Not a devDependency on purpose: three-mesh-bvh peers on three, npm would install three into
// node_modules, and the unit tests assert behaviour when three is NOT resolvable. The tarball is
// fetched with `npm pack` into a temp dir and bundled from there.

import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

/** The vendored release. Bump deliberately; THIRD_PARTY_NOTICES.md names it too. */
const VERSION = '0.9.15';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmp = mkdtempSync(join(tmpdir(), 'dxr-bvh-'));
const outfile = resolve(root, 'js/vendor/three-mesh-bvh.js');
let pkg;
try {
  const tgz = execFileSync('npm', ['pack', `three-mesh-bvh@${VERSION}`, '--silent', '--pack-destination', tmp], { encoding: 'utf8' }).trim().split('\n').pop();
  execFileSync('tar', ['-xzf', join(tmp, tgz), '-C', tmp]);
  const dir = join(tmp, 'package');
  pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  if (pkg.version !== VERSION) throw new Error(`npm pack gave three-mesh-bvh ${pkg.version}, expected ${VERSION}`);
  await bundle(dir);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

async function bundle(dir) {
await build({
  stdin: { contents: "export { MeshBVH } from './src/index.js';", resolveDir: dir, sourcefile: 'three-mesh-bvh-slice.js' },
  bundle: true,
  format: 'esm',
  target: ['es2020'],
  minify: true,
  external: ['three'],
  legalComments: 'none',
  banner: {
    js:
      `/* three-mesh-bvh ${pkg.version} (MeshBVH only) — MIT License, Copyright (c) 2018 Garrett Johnson — https://github.com/gkjohnson/three-mesh-bvh\n` +
      ` * Vendored by @displayxr/inline3d for the depth cursor's pick; rebuilt by tools/vendor/three-mesh-bvh.mjs. Do not edit. */`,
  },
  outfile,
  logLevel: 'warning',
  // Upstream marks itself side-effect free; its bare `import '…generated.js'` lines are dropped by
  // design (the same output as resolving it through node_modules).
  logOverride: { 'ignored-bare-import': 'silent' },
});
}
console.log(`vendor: ${outfile.slice(root.length + 1)}  ${(statSync(outfile).size / 1024).toFixed(1)} KB (min) — three-mesh-bvh ${pkg.version}`);

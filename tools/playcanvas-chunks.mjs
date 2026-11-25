#!/usr/bin/env node
// tools/playcanvas-chunks.mjs — refresh test/playcanvas-chunks/<version>/ from the npm build.
//
//   node tools/playcanvas-chunks.mjs 2.24.0 [2.25.0 …]
//
// The SDK rewrites a few PlayCanvas GLSL shader chunks by matching anchors in their text (the
// splat footprint and quad-extent patches, the stereo grab UV for transmission, the splat-effect
// hook signatures). test/playcanvas-chunks.test.mjs runs those rewrites against the REAL chunks
// of every engine version in the peer range, read from these copies (`npm test` stays offline).
// Supporting a new engine release = run this with its version, add it to VERSIONS in the test,
// and read what fails. The chunk text is PlayCanvas engine source, MIT (THIRD_PARTY_NOTICES.md).
//
// Needs npm (registry access) and tar. Nothing else is fetched.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** The chunks the SDK matches anchors in (GLSL; the SDK forces WebGL2). */
export const CHUNKS = ['gsplatCornerVS', 'gsplatCommonVS', 'gsplatModifyVS', 'gsplatModifyPS', 'refractionDynamicPS'];

/** Every registered GLSL chunk of a built playcanvas.mjs, by name. */
export function glslChunks(src) {
  const vars = {};
  for (const m of src.matchAll(/var (\w+_default\d*) = `/g)) {
    const start = m.index + m[0].length;
    let i = start;
    for (;;) {
      const j = src.indexOf('`', i);
      if (j < 0) break;
      if (src[j - 1] === '\\') {
        i = j + 1;
        continue;
      }
      vars[m[1]] = src.slice(start, j);
      break;
    }
  }
  // The build registers the GLSL chunk table first, then the WGSL one: first sighting wins.
  const out = {};
  for (const m of src.matchAll(/^\t(\w+): (\w+_default\d*),$/gm)) {
    if (m[2] in vars && !(m[1] in out)) out[m[1]] = vars[m[2]];
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const versions = process.argv.slice(2);
  if (!versions.length) {
    console.error('usage: node tools/playcanvas-chunks.mjs <version> [...]');
    process.exit(2);
  }
  for (const v of versions) {
    const tmp = mkdtempSync(join(tmpdir(), 'pc-chunks-'));
    try {
      const tgz = execFileSync('npm', ['pack', `playcanvas@${v}`, '--silent', '--pack-destination', tmp], { encoding: 'utf8' }).trim().split('\n').pop();
      execFileSync('tar', ['xzf', tgz, 'package/build/playcanvas.mjs'], { cwd: tmp });
      const all = glslChunks(readFileSync(join(tmp, 'package/build/playcanvas.mjs'), 'utf8'));
      const dir = join(root, 'test/playcanvas-chunks', v);
      mkdirSync(dir, { recursive: true });
      for (const name of CHUNKS) {
        if (!(name in all)) {
          console.error(`playcanvas@${v}: no ${name} chunk (the test will say what that breaks)`);
          continue;
        }
        writeFileSync(join(dir, `${name}.glsl`), all[name]);
      }
      console.log(`playcanvas@${v}: wrote ${dir}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}

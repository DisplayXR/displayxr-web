#!/usr/bin/env node
// tools/dist/build.mjs — builds the CDN bundle(s) into dist/ with esbuild (RFC 0003 §1, C1).
//
//   npm run build:dist            # dist/call.js (+ dist/lift.js when js/lift/ carries the module)
//
// `dist/` is NOT committed: `prepack` runs this, so every published tarball — and therefore
// jsDelivr's `@displayxr/inline3d@<v>/dist/call.js` — carries a bundle built from that exact
// version. The banner and `CALL_SDK` (sent in `hello`) both carry the version.
//
// Why esbuild: the SDK has no build step and no bundler of its own; this is the one place one is
// needed, and esbuild is a single devDependency with no config. The output is plain ESM, so the
// page still needs `<script type="module">` (there is no classic-script global — Decision 11).

import { build } from 'esbuild';
import { readFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const outdir = resolve(root, 'dist');
mkdirSync(outdir, { recursive: true });

const banner = `/* @displayxr/inline3d ${pkg.version} — dist/call.js — ${pkg.license} — https://github.com/DisplayXR/displayxr-web */`;
const common = {
  bundle: true,
  format: 'esm',
  target: ['es2022'],
  minify: true,
  sourcemap: false, // the sources ship in the same tarball; a 4x-size map is not worth its bytes
  legalComments: 'none',
  banner: { js: banner },
  logLevel: 'warning',
};

const entries = [{ entryPoints: [resolve(root, 'tools/dist/call-entry.js')], outfile: resolve(outdir, 'call.js') }];

// The lift chunk: only when this copy of the SDK carries the real module (the placeholder on a
// pre-lift main exports no `lift`; bundling it would be a 200-byte file that says nothing).
const liftIndex = resolve(root, 'js/lift/index.js');
const liftSrc = existsSync(liftIndex) ? readFileSync(liftIndex, 'utf8') : '';
const hasLift = /\bexport\s*\{[^}]*\blift\b/.test(liftSrc) || /\bexport\s+(async\s+)?function\s+lift\b/.test(liftSrc);
if (hasLift) entries.push({ entryPoints: [liftIndex], outfile: resolve(outdir, 'lift.js') });

for (const e of entries) {
  await build({ ...common, ...e });
  const kb = (statSync(e.outfile).size / 1024).toFixed(1);
  console.log(`dist: ${e.outfile.slice(root.length + 1)}  ${kb} KB (min, unzipped)`);
}
if (!hasLift) console.log('dist: no lift.js — js/lift/index.js exports no `lift` in this checkout (the module lands with feat/lift)');

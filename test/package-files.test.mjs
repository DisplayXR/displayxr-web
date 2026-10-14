// Every relative import of every published .js file resolves INSIDE the published file set.
//
// package.json `files` is a hand-kept allow-list: a new module that an existing one imports, but
// that nobody adds to `files`, passes every other test (they run from the repo) and breaks every
// npm consumer at load. inline3d-cursor-shape.js (1.45.0) was caught at release this way — it is
// imported by inline3d-cursor-depth.js, which ./three imports.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.add(relative(root, p));
  }
}

function publishedFiles() {
  const out = new Set();
  for (const entry of pkg.files || []) {
    const p = join(root, entry);
    if (!existsSync(p)) continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else out.add(normalize(entry));
  }
  return out;
}

test('package.json files: every relative import of a published .js resolves to a published file', () => {
  const files = publishedFiles();
  const missing = [];
  for (const f of files) {
    if (!f.endsWith('.js')) continue;
    const src = readFileSync(join(root, f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const m of src.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const target = normalize(join(dirname(f), m[1]));
      if (!files.has(target)) missing.push(`${f} -> ${m[1]}`);
    }
  }
  assert.deepEqual(missing, [], `add to package.json "files": ${[...new Set(missing.map((s) => s.split(' -> ')[1]))].join(', ')}`);
});

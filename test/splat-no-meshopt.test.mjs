// `./splat` must never reach the OPTIONAL `meshoptimizer` peer — not even through a lazy import().
//
// The regression this pins (1.16 → 1.19): the PlayCanvas splat adapter's setRig('display') did
// `await import('./inline3d-model-playcanvas.js')` for its look helpers (environments,
// prepareTransmission), and that module holds `import('meshoptimizer/decoder')` for the model
// path's meshopt decoder. A browser never notices — the import() never runs on the splat path — but
// a bundler follows EVERY import in the graph at build time, so any bundled app that used only
// `./splat` failed with "Can't resolve 'meshoptimizer/decoder'" unless it installed meshoptimizer.
// The helpers now live in js/inline3d-pc-look.js, which reaches nothing optional.
//
// Like model-decoder-imports.test.mjs this reads the source the way a bundler does, because the
// property is about what a build tool can SEE, and the suite takes no dependencies (no esbuild):
// walk every static `import … from`, `export … from`, bare `import '…'` and literal `import('…')`
// from each package entry, and collect the bare specifiers the graph reaches.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/**
 * Every module specifier `src` names, as a bundler would read it: static imports, re-exports,
 * side-effect imports and literal dynamic imports. Comments are skipped and string contents are
 * never scanned as code (so prose ABOUT an import — this file is full of it — is not an import).
 * Also returns the source with comments blanked, strings kept.
 */
function scanSpecifiers(src) {
  const specs = [];
  const code = src.split('');
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (code[k] !== '\n') code[k] = ' ';
  };
  const word = (k) => /[A-Za-z0-9_$]/.test(src[k] || '');
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      const end = src.indexOf('\n', i);
      const stop = end < 0 ? src.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      i = j + 1;
      continue;
    }
    if (!word(i - 1) && (src.startsWith('import', i) || src.startsWith('export', i)) && !word(i + 6)) {
      const rest = src.slice(i);
      const m =
        /^import\s*\(\s*(['"])([^'"\\]+)\1\s*\)/.exec(rest) || // import('x')
        /^import\s*(['"])([^'"\\]+)\1/.exec(rest) || // import 'x'
        /^import\s[^'"();]*?\bfrom\s*(['"])([^'"\\]+)\1/.exec(rest) || // import … from 'x'
        /^export\s*(?:\*\s*(?:as\s+[A-Za-z_$][\w$]*\s*)?|\{[^}]*\}\s*)from\s*(['"])([^'"\\]+)\1/.exec(rest); // export … from 'x'
      if (m) {
        specs.push(m[2]);
        i += m[0].length;
        continue;
      }
    }
    i++;
  }
  return { specs, code: code.join('') };
}

/** The graph from `entry` (a path under the package): every file reached + every bare specifier. */
function walk(entry) {
  const files = new Map(); // abs path → comment-blanked code
  const bare = new Map(); // bare specifier → first file that names it
  const queue = [join(ROOT, entry)];
  while (queue.length) {
    const f = queue.shift();
    if (files.has(f)) continue;
    assert.ok(existsSync(f), `the graph names ${relative(ROOT, f)}, which does not exist`);
    const { specs, code } = scanSpecifiers(readFileSync(f, 'utf8'));
    files.set(f, code);
    for (const s of specs) {
      if (s.startsWith('./') || s.startsWith('../')) queue.push(join(dirname(f), s));
      else if (!bare.has(s)) bare.set(s, relative(ROOT, f));
    }
  }
  return { files, bare };
}

const entryOf = (sub) => PKG.exports[sub].import;
const meshoptIn = ({ files, bare }) => ({
  specifiers: [...bare.keys()].filter((s) => /meshoptimizer/.test(s)).map((s) => `${s} (from ${bare.get(s)})`),
  // Any mention in CODE (comments blanked), e.g. a specifier assembled from strings.
  mentions: [...files].filter(([, code]) => /meshoptimizer/.test(code)).map(([f]) => relative(ROOT, f)),
});

test('./splat reaches no module that imports or names meshoptimizer (an optional peer of ./model)', () => {
  const g = walk(entryOf('./splat'));
  const { specifiers, mentions } = meshoptIn(g);
  assert.deepEqual(
    specifiers,
    [],
    `./splat's import graph reaches meshoptimizer — every bundled app using only ./splat then fails ` +
      `to build without it. Move what ./splat needs out of the module that imports it.`,
  );
  assert.deepEqual(mentions, [], `./splat reaches code that names meshoptimizer: ${mentions.join(', ')}`);
  assert.ok(!g.files.has(join(ROOT, 'js/inline3d-model-playcanvas.js')), './splat reaches the model backend again');
});

test('the walk follows lazy imports: ./splat reaches the PlayCanvas adapter and its look helpers', () => {
  // Pins the walker: a scanner that missed import() would pass the test above vacuously.
  const { files } = walk(entryOf('./splat'));
  for (const f of ['js/inline3d-splat-playcanvas.js', 'js/inline3d-pc-look.js']) {
    assert.ok(files.has(join(ROOT, f)), `${f} not reached from ./splat — the walker is not following imports`);
  }
});

test('./model still reaches meshoptimizer/decoder (the meshopt path is intact, and the walk can see it)', () => {
  const { bare } = walk(entryOf('./model'));
  assert.ok(bare.has('meshoptimizer/decoder'), `./model no longer reaches meshoptimizer/decoder; saw ${[...bare.keys()].join(', ')}`);
});

test('the specifier scanner reads each import form and ignores prose', () => {
  const { specs } = scanSpecifiers(
    [
      "// import('commented/out') and import x from 'nope'",
      "const s = \"import('in/a/string')\";",
      "import a, { b } from './static.js';",
      'import {\n  c,\n  d,\n} from "./multi-line.js";',
      "import './side-effect.js';",
      "export { e } from './re-export.js';",
      "export * from './star.js';",
      "const m = await import('meshoptimizer/decoder');",
      'const v = import.meta.url;',
    ].join('\n'),
  );
  assert.deepEqual(specs, ['./static.js', './multi-line.js', './side-effect.js', './re-export.js', './star.js', 'meshoptimizer/decoder']);
});

test('the new look module ships in the package', () => {
  assert.ok(PKG.files.includes('js/inline3d-pc-look.js'), 'add js/inline3d-pc-look.js to package.json "files"');
});

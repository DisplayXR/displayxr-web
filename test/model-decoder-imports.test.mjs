// Every `import()` in the shipped SDK carries a LITERAL specifier — the one property that decides
// whether `/model` works under a bundler.
//
// This is a source-level test on purpose, and it is the only kind that can pin this bug. The
// failure is not a value, a branch or an order-of-calls: it is whether a build tool can SEE the
// specifier. `await import(spec.module)` runs perfectly in a browser with a bare importmap — which
// is exactly how samples/model/ loads — and only webpack/Turbopack/rollup can tell you it is
// wrong, by refusing to follow an expression:
//
//     Critical dependency: the request of a dependency is an expression     (build time)
//     Cannot find module 'three/addons/libs/meshopt_decoder.module.js'      (run time, a stub throws)
//
// Nothing that executes the module reproduces that, so nothing that executes the module can guard
// it. What a guard CAN do is read the source the way a bundler does.
//
// `three` is not installed for these tests (the suite is deliberately dependency-free — see
// stubs.mjs), so js/inline3d-model.js cannot even be imported here. That costs nothing: the
// property under test is textual.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const JS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'js');

/**
 * Walk `src` once, tracking whether we are in code, a comment or a string, and report every
 * dynamic import with the specifier it was given (`null` when that specifier is an expression).
 * Also returns the source with COMMENTS blanked (strings kept, since a later regex reads decoder
 * paths out of them), so prose cannot be mistaken for code — these files document the broken form
 * in their own comments, which a naive `/import\(/` scan would read as a violation.
 *
 * A hand-rolled scanner rather than a parser because the suite takes no dependencies, and this
 * needs to distinguish exactly three things: code, comment, string.
 */
function scanDynamicImports(src) {
  const calls = [];
  const code = src.split('');
  let i = 0;
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (code[k] !== '\n') code[k] = ' ';
  };
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
      i = j + 1; // stepped over: a string's contents are never scanned for imports
      continue;
    }
    // `import` as a whole word, followed by `(`.
    if (src.startsWith('import', i) && !/[A-Za-z0-9_$]/.test(src[i - 1] || '')) {
      const m = /^import\s*\(\s*/.exec(src.slice(i));
      if (m) {
        const rest = src.slice(i + m[0].length);
        const lit = /^(['"])([^'"\\]*)\1\s*\)/.exec(rest);
        calls.push({ specifier: lit ? lit[2] : null, at: src.slice(0, i).split('\n').length });
        i += m[0].length;
        continue;
      }
    }
    i++;
  }
  return { calls, code: code.join('') };
}

const files = readdirSync(JS_DIR)
  .filter((f) => f.endsWith('.js'))
  .map((f) => ({ name: f, src: readFileSync(join(JS_DIR, f), 'utf8') }));

test('every dynamic import in js/ names its module literally, so a bundler can follow it', () => {
  assert.ok(files.length > 0, 'no sources found to scan');
  const bad = [];
  for (const { name, src } of files) {
    for (const call of scanDynamicImports(src).calls) {
      if (call.specifier === null) bad.push(`${name}:${call.at}`);
    }
  }
  assert.deepEqual(
    bad,
    [],
    `import() with a computed specifier at ${bad.join(', ')} — a bundler emits "Critical ` +
      `dependency: the request of a dependency is an expression" and ships a stub that throws. ` +
      `Write the specifier out, one literal per target, and select between them with a thunk.`,
  );
});

test('the scanner itself sees an expression specifier (so the guard above can fail)', () => {
  // Pins the detector, not the SDK: a scanner that silently matched nothing would make the test
  // above pass no matter what the source says.
  const { calls } = scanDynamicImports(
    [
      "// import(commentedOut) and a string: 'import(alsoNotCode)'",
      "const a = await import('three/addons/loaders/DRACOLoader.js');",
      'const b = await import(spec.module);',
    ].join('\n'),
  );
  assert.deepEqual(
    calls.map((c) => c.specifier),
    ['three/addons/loaders/DRACOLoader.js', null],
  );
});

test('each decoder the model path can attach is reachable by a literal import of its own', () => {
  const { src } = files.find((f) => f.name === 'inline3d-model.js');
  const { calls, code } = scanDynamicImports(src);

  // The DECODERS table names each decoder module as a STRING too, because the error messages quote
  // it ("X is MeshoptDecoder from 'three/addons/libs/meshopt_decoder.module.js'"). That string is
  // what a reader is told to type, so it has to be the module that actually gets loaded — if the
  // two drift, the message sends people to a file the SDK never imports.
  const declared = [...code.matchAll(/module:\s*'([^']+)'/g)].map((m) => m[1]);
  assert.equal(declared.length, 3, `expected 3 decoder module specifiers, saw ${declared.length}`);
  assert.deepEqual(new Set(declared).size, 3, 'two decoders name the same module');

  const literal = new Set(calls.map((c) => c.specifier));
  for (const spec of declared) {
    assert.ok(
      literal.has(spec),
      `DECODERS names '${spec}' but nothing imports it literally — add ` +
        `\`load: () => import('${spec}')\` beside it.`,
    );
  }

  // And the three kinds are the ones the module claims to handle, spelled as three's own paths.
  assert.deepEqual(declared.sort(), [
    'three/addons/libs/meshopt_decoder.module.js',
    'three/addons/loaders/DRACOLoader.js',
    'three/addons/loaders/KTX2Loader.js',
  ]);
});

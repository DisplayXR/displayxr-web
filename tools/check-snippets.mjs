#!/usr/bin/env node
// tools/check-snippets.mjs — every sample and every code snippet in the call / camera docs must
// compile against the PUBLIC types only (RFC 0003 §7, the C2 gate).
//
//   node tools/check-snippets.mjs            # exit 1 on the first snippet that does not typecheck
//   node tools/check-snippets.mjs --verbose  # list every file it checked
//
// What it does: pulls every fenced ```js / ```ts / ```jsx block out of DOCS, writes each as its
// own module into a temp dir, adds the samples (SAMPLES, checked in place so their relative
// imports resolve), maps the package specifiers (`@displayxr/inline3d`, `/call`, `/call/full`,
// `/camera`, …) onto this checkout's .d.ts files with tsconfig `paths`, and runs `tsc --noEmit`.
//
// A snippet that names a page thing the docs never declare (`joinBtn`, `toast`, `roster`) is
// still a snippet, so "cannot find name" (TS2304/TS2552) is allowed; everything else — a missing
// export, an option key the types do not have, a renamed handle member, a wrong argument type —
// fails. Fragments that do not import what they use get the public names injected, so they are
// checked against the real types rather than skipped. Finally, a deprecated name imported from the
// `./call` entry (the one-release wrappers) fails outright: the docs must never show them.
//
// Needs `typescript` (a devDependency; CI's typecheck job installs it). test/snippets.test.mjs
// runs this under `node --test` where typescript resolves, and skips where it does not.

import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, basename } from 'node:path';
import { exportedNames } from './api-surface.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const DOCS = ['docs/call.md', 'docs/camera.md'];
export const SAMPLES = ['samples/call/app.js', 'samples/call-embed/app.js', 'samples/camera/app.js'];
/** TS codes a snippet may raise: undeclared page identifiers only. */
const ALLOWED = new Set(['TS2304', 'TS2552', 'TS2582', 'TS2583']);
/**
 * A SAMPLE is plain JS that reaches into the page (`el.options`, `e.detail`, `window.__call`):
 * "property does not exist" on a DOM type is page scaffolding, not API drift, and is allowed
 * there. The same error on a package type (`CallHandle`, `StereoCamera`, …) still fails.
 */
const DOM_TYPES = /does not exist on type '(HTMLElement|Element|Event|EventTarget|Document|Window & typeof globalThis)'/;
/** Package subpath → the .d.ts that is its public surface (`./lift` has none yet: a stub). */
const ENTRIES = {
  '@displayxr/inline3d': 'index.d.ts',
  '@displayxr/inline3d/three': 'three.d.ts',
  '@displayxr/inline3d/viewer': 'viewer.d.ts',
  '@displayxr/inline3d/splat': 'splat.d.ts',
  '@displayxr/inline3d/model': 'model.d.ts',
  '@displayxr/inline3d/player': 'player.d.ts',
  '@displayxr/inline3d/call': 'call.d.ts',
  '@displayxr/inline3d/call/full': 'call-full.d.ts',
  '@displayxr/inline3d/camera': 'camera.d.ts',
};

/** `[{ lang, code, line }]` for every fenced js/ts/jsx/tsx block in a Markdown string. */
export function extractSnippets(md) {
  const out = [];
  const re = /^```(javascript|typescript|jsx|tsx|js|ts)\b[^\n]*\n([\s\S]*?)^```/gm;
  let m;
  while ((m = re.exec(md))) {
    const line = md.slice(0, m.index).split('\n').length;
    out.push({ lang: m[1], code: m[2], line });
  }
  return out;
}

/** Specifiers imported from `./call` that are deprecated wrappers — never in a doc or sample. */
export function deprecatedImports(code) {
  const deprecated = new Set(exportedNames('call.d.ts').filter((n) => n.deprecated).map((n) => n.name));
  const bad = [];
  const re = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]@displayxr\/inline3d\/call(?:\/full)?['"]/g;
  let m;
  while ((m = re.exec(code))) {
    for (const spec of m[1].split(',')) {
      const name = spec.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
      if (deprecated.has(name)) bad.push(name);
    }
  }
  return bad;
}

/**
 * Imports to prepend so a FRAGMENT (no import of that entry) is checked against the real types.
 * Only entries the snippet does not already import from; only non-deprecated names.
 */
export function injectedImports(code) {
  const lines = [];
  // `/call/full` re-exports `/call`'s surface: a snippet on either has the call names already.
  const has = (spec) => new RegExp(`from\\s*['"]${spec.replace(/[/]/g, '\\/')}(\\/full)?['"]`).test(code);
  const add = (spec, dts, names) => {
    if (has(spec) || !names.length) return;
    lines.push(`import { ${names.join(', ')} } from '${spec}';`);
  };
  const pub = (dts) => exportedNames(dts).filter((n) => !n.deprecated);
  add('@displayxr/inline3d', 'index.d.ts', ['sharedInline3D', 'createInline3D', 'inline3DAvailable']);
  add('@displayxr/inline3d/call', 'call.d.ts', pub('call.d.ts').map((n) => n.name));
  add('@displayxr/inline3d/camera', 'camera.d.ts', pub('camera.d.ts').map((n) => n.name));
  return lines;
}

const PRELUDE = `// generated by tools/check-snippets.mjs
declare module 'react' { export const useEffect: any; export const useRef: any; export const useState: any; const React: any; export default React; }
declare module '@displayxr/inline3d/lift' { export const lift: import('@displayxr/inline3d/call').LiftFunction; export function liftCapabilities(o?: object): Promise<any>; }
declare namespace JSX { interface IntrinsicElements { [tag: string]: any } }
declare const React: any;
`;

/** Run the check. Returns `{ ok, errors: string[], files: string[] }`. */
export function checkSnippets({ verbose = false } = {}) {
  const req = createRequire(join(root, 'package.json'));
  let tsc;
  try {
    tsc = req.resolve('typescript/bin/tsc');
  } catch {
    return { ok: false, errors: ['typescript is not installed (npm install --include=dev)'], files: [] };
  }
  const dir = mkdtempSync(join(tmpdir(), 'dxr-snippets-'));
  const files = [];
  const errors = [];
  try {
    writeFileSync(join(dir, 'prelude.d.ts'), PRELUDE);
    files.push(join(dir, 'prelude.d.ts'));
    for (const doc of DOCS) {
      const md = readFileSync(resolve(root, doc), 'utf8');
      extractSnippets(md).forEach((snip, i) => {
        const ext = /x$/.test(snip.lang) ? 'tsx' : 'ts';
        const name = `${basename(doc, '.md')}-${String(i + 1).padStart(2, '0')}-L${snip.line}.${ext}`;
        const bad = deprecatedImports(snip.code);
        if (bad.length) errors.push(`${doc}:${snip.line}: imports deprecated name(s) from the ./call entry: ${bad.join(', ')}`);
        const code = `${injectedImports(snip.code).join('\n')}\n${snip.code}\nexport {};\n`;
        writeFileSync(join(dir, name), code);
        files.push(join(dir, name));
      });
    }
    for (const s of SAMPLES) {
      const abs = resolve(root, s);
      if (!existsSync(abs)) {
        errors.push(`${s}: missing`);
        continue;
      }
      const bad = deprecatedImports(readFileSync(abs, 'utf8'));
      if (bad.length) errors.push(`${s}: imports deprecated name(s) from the ./call entry: ${bad.join(', ')}`);
      files.push(abs);
    }
    const paths = {};
    for (const [spec, dts] of Object.entries(ENTRIES)) paths[spec] = [resolve(root, dts)];
    const cfg = {
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'bundler',
        lib: ['ES2022', 'DOM', 'DOM.Iterable'],
        types: ['webxr'],
        typeRoots: [resolve(root, 'node_modules/@types')],
        baseUrl: root,
        paths,
        allowJs: true,
        checkJs: true,
        jsx: 'preserve',
        strict: false,
        noEmit: true,
        skipLibCheck: true,
        allowImportingTsExtensions: true,
      },
      files,
    };
    const cfgPath = join(dir, 'tsconfig.json');
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    const r = spawnSync(process.execPath, [tsc, '-p', cfgPath, '--pretty', 'false'], { encoding: 'utf8' });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    for (const line of out.split('\n')) {
      const m = /^(.*?)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(line.trim());
      if (!m) {
        if (/error TS/.test(line)) errors.push(line.trim());
        continue;
      }
      if (ALLOWED.has(m[4])) continue;
      const isSnippet = m[1].includes('dxr-snippets-');
      const rel = m[1].replace(root + '/', '');
      const isSample = SAMPLES.some((f) => rel.endsWith(f));
      // Only what the gate is about: the snippets and the samples. A JS file a sample pulls in
      // (its own helper, an SDK source file) is not a doc and is not checked here.
      if (!isSnippet && !isSample) continue;
      if (isSample && m[4] === 'TS2339' && DOM_TYPES.test(m[5])) continue;
      const file = isSnippet ? `(snippet) ${basename(m[1])}` : rel;
      errors.push(`${file}(${m[2]},${m[3]}): ${m[4]}: ${m[5]}`);
    }
    if (r.error) errors.push(String(r.error));
  } finally {
    if (!verbose) rmSync(dir, { recursive: true, force: true });
  }
  return { ok: errors.length === 0, errors, files: files.map((f) => (f.startsWith(root) ? f.slice(root.length + 1) : basename(f))) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const verbose = process.argv.includes('--verbose');
  const r = checkSnippets({ verbose });
  if (verbose) console.log(r.files.join('\n'));
  if (!r.ok) {
    console.error(`check-snippets: ${r.errors.length} problem(s):\n${r.errors.join('\n')}`);
    process.exit(1);
  }
  console.log(`check-snippets: ${r.files.length - 1} file(s) typecheck against the public types`);
}

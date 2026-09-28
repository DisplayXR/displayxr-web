// Build for tools/auto3d-shim. Node, no dependencies, no bundler: concatenation plus a version
// stamp. The browser vendors dist/ VERBATIM (a browser-side edit is a bug: fix here, rebuild,
// re-vendor); VENDOR.json lets it check that mechanically.
//
//   node build.mjs           write dist/ + VENDOR.json
//   node build.mjs --check   rebuild in memory, diff against the committed output, exit 1 on drift
//
// Outputs (each part file is one top-level `function dxr…`; see README "Architecture"):
//   dist/auto3d-sentinel.js  (function (cfg, cap) { <sentinel.js> return dxrSentinel(cfg, cap); })
//                            an EXPRESSION: the injector evaluates it and calls the result.
//   dist/auto3d-core.js      (function (cfg, cap, S) { <core, guard, chip, dev, three, playcanvas>
//                            return dxrCore(cfg, cap, S); })   also an expression; what cap.loadCore()
//                            evaluates. All parts share its one lexical scope; nothing goes on window.
//   dist/auto3d-dev.js       the dev extension's content script (manifest.json): an IIFE with the
//                            dev host (host-dev.js over localStorage), the sentinel, and the core.
//   VENDOR.json              { name, version, sourceCommit, sourceSha256, files: { <f>: { bytes, sha256 } } }
//
// Transforms: CRLF -> LF; full-line `//` comments dropped (never inside a template literal); the
// token __DXR_AUTO3D_VERSION__ replaced by manifest.json's version. sourceSha256 hashes the source
// files in SOURCES order as `<name>\n<bytes>\n<LF-normalised text>`. sourceCommit is the last commit
// touching them, suffixed `+dirty` when the working tree differs (--check rejects a dirty one).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
export const CORE_PARTS = ['core.js', 'guard.js', 'chip.js', 'dev.js', 'three-adapter.js', 'playcanvas-adapter.js'];
export const SOURCES = ['manifest.json', 'host-dev.js', 'sentinel.js', ...CORE_PARTS];
export const OUTPUTS = ['dist/auto3d-sentinel.js', 'dist/auto3d-core.js', 'dist/auto3d-dev.js'];
const VERSION_TOKEN = '__DXR_AUTO3D_VERSION__';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const lf = (s) => s.replace(/\r\n/g, '\n');

// Drops lines that are only a `//` comment. A small scanner tracks strings, template literals
// (with ${} nesting), block comments and regex literals, so a `//` line inside a template is kept.
export function stripLineComments(src, name = '?') {
  const out = [];
  const lines = src.split('\n');
  const stack = []; // 'tmpl' | 'expr' (a ${ } inside a template)
  let block = false;
  let prev = ''; // last significant code character, for the regex-vs-division call
  const inCode = () => !block && (stack.length === 0 || stack[stack.length - 1] === 'expr');
  for (const line of lines) {
    if (inCode() && /^\s*\/\//.test(line)) continue;
    out.push(line);
    let i = 0, q = null; // q: an open ' or " string (never spans lines)
    while (i < line.length) {
      const c = line[i], n = line[i + 1];
      if (block) { if (c === '*' && n === '/') { block = false; i += 2; } else i++; continue; }
      if (q) { if (c === '\\') i += 2; else { if (c === q) q = null; i++; } continue; }
      const top = stack[stack.length - 1];
      if (top === 'tmpl') {
        if (c === '\\') i += 2;
        else if (c === '`') { stack.pop(); prev = ')'; i++; }
        else if (c === '$' && n === '{') { stack.push('expr'); prev = '('; i += 2; }
        else i++;
        continue;
      }
      if (c === '/' && n === '/') break; // line comment: rest of line
      if (c === '/' && n === '*') { block = true; i += 2; continue; }
      if (c === "'" || c === '"') { q = c; i++; continue; }
      if (c === '`') { stack.push('tmpl'); i++; continue; }
      if (top === 'expr' && c === '}') { stack.pop(); i++; continue; }
      if (top === 'expr' && c === '{') { stack.push('expr'); prev = '{'; i++; continue; }
      if (c === '/') {
        const word = /(?:^|[^\w$])(return|typeof|case|in|of|delete|void|throw|new|else|do)\s*$/.test(line.slice(0, i));
        if (!prev || '(,=:[!&|?{};+-*%<>~^'.includes(prev) || word) {
          // a regex literal: skip to its closing slash (classes may hold a slash)
          let j = i + 1, cls = false;
          while (j < line.length) {
            const d = line[j];
            if (d === '\\') { j += 2; continue; }
            if (cls) { if (d === ']') cls = false; } else if (d === '[') cls = true; else if (d === '/') break;
            j++;
          }
          i = j + 1; prev = ')';
          continue;
        }
      }
      if (!/\s/.test(c)) prev = c;
      i++;
    }
    if (q) throw new Error(`${name}: unterminated string on a line: ${line.slice(0, 80)}`);
  }
  if (block || stack.length) throw new Error(`${name}: scanner ended inside a ${block ? 'block comment' : 'template literal'} — refusing to strip`);
  return out.join('\n');
}

function git(root, args) {
  try { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
}

// Builds everything in memory. Returns { version, files: { 'dist/…': text, 'VENDOR.json': text }, vendor }.
export function build(root = here) {
  const src = {};
  for (const f of SOURCES) src[f] = lf(readFileSync(join(root, f), 'utf8'));
  const version = JSON.parse(src['manifest.json']).version;
  if (!/^\d+\.\d+\.\d+$/.test(version || '')) throw new Error(`manifest.json version '${version}' is not x.y.z`);
  const part = (f) => stripLineComments(src[f], f).split(VERSION_TOKEN).join(version).replace(/\n+$/, '');
  const coreBody = CORE_PARTS.map(part).join('\n');
  const banner = `// DisplayXR auto-3D ${version} — built by tools/auto3d-shim/build.mjs from displayxr-web. Do not edit: fix the source, rebuild, re-vendor.`;
  const files = {
    'dist/auto3d-sentinel.js': `${banner}\n(function (cfg, cap) {\n'use strict';\n${part('sentinel.js')}\nreturn dxrSentinel(cfg, cap);\n})\n`,
    'dist/auto3d-core.js': `${banner}\n(function (cfg, cap, S) {\n'use strict';\n${coreBody}\nreturn dxrCore(cfg, cap, S);\n})\n`,
    'dist/auto3d-dev.js': `${banner}\n(() => {\n'use strict';\n${part('host-dev.js')}\n${part('sentinel.js')}\n` +
      `const CORE = function (cfg, cap, S) {\n${coreBody}\nreturn dxrCore(cfg, cap, S);\n};\n` +
      `const h = dxrDevHost(() => CORE);\ndxrSentinel(h.cfg, h.cap);\n})();\n`,
  };
  for (const f of OUTPUTS) {
    if (files[f].includes(VERSION_TOKEN)) throw new Error(`${f}: version token left unstamped`);
    try { new vm.Script(files[f], { filename: f }); } catch (e) { throw new Error(`${f} does not parse: ${e.message}`); }
  }
  const sourceSha256 = sha256(SOURCES.map((f) => `${f}\n${Buffer.byteLength(src[f])}\n${src[f]}`).join(''));
  const last = git(root, ['log', '-1', '--format=%H', '--', ...SOURCES]);
  const dirty = git(root, ['status', '--porcelain', '--', ...SOURCES]);
  const vendor = {
    name: 'displayxr-auto3d',
    version,
    sourceCommit: last ? last + (dirty ? '+dirty' : '') : null,
    sourceSha256,
    files: Object.fromEntries(OUTPUTS.map((f) => [f, { bytes: Buffer.byteLength(files[f]), sha256: sha256(files[f]) }])),
  };
  files['VENDOR.json'] = JSON.stringify(vendor, null, 2) + '\n';
  return { version, files, vendor };
}

// --check: the committed dist/ + VENDOR.json must be exactly what the committed sources build to
// (sourceCommit aside, which names the commit rather than the content).
export function check(root = here) {
  const { files, vendor } = build(root);
  const problems = [];
  for (const f of OUTPUTS) {
    const p = join(root, f);
    if (!existsSync(p)) { problems.push(`${f}: missing`); continue; }
    if (lf(readFileSync(p, 'utf8')) !== files[f]) problems.push(`${f}: differs from a rebuild`);
  }
  const vp = join(root, 'VENDOR.json');
  if (!existsSync(vp)) problems.push('VENDOR.json: missing');
  else {
    const have = JSON.parse(readFileSync(vp, 'utf8'));
    const strip = (v) => JSON.stringify({ ...v, sourceCommit: null });
    if (strip(have) !== strip(vendor)) problems.push('VENDOR.json: version / hashes differ from a rebuild');
    if (!have.sourceCommit || /\+dirty$/.test(have.sourceCommit)) problems.push(`VENDOR.json: sourceCommit '${have.sourceCommit}' is not a clean commit`);
  }
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  if (process.argv.includes('--check')) {
    const problems = check();
    if (problems.length) { console.error('build --check: FAILED\n  ' + problems.join('\n  ') + '\nRun `node build.mjs` and commit dist/ + VENDOR.json.'); process.exit(1); }
    console.log('build --check: dist/ and VENDOR.json match the sources');
  } else {
    const { version, files } = build();
    mkdirSync(join(here, 'dist'), { recursive: true });
    for (const [f, text] of Object.entries(files)) writeFileSync(join(here, f), text);
    console.log(`built ${version}: ` + OUTPUTS.map((f) => `${f} (${Buffer.byteLength(files[f])} B)`).join(', '));
  }
}

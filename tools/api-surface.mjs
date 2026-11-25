#!/usr/bin/env node
// tools/api-surface.mjs — the public-API snapshot gate (RFC 0003 §7, C2).
//
//   node tools/api-surface.mjs            # print the surface of every pinned .d.ts
//   node tools/api-surface.mjs --check    # exit 1 if any snapshot in test/api-snapshot/ is stale
//   node tools/api-surface.mjs --update   # rewrite the snapshots (do this IN THE SAME CHANGE as the .d.ts)
//
// test/api-snapshot.test.mjs runs the check under `node --test`, so a change to a pinned entry's
// public surface fails `npm test` (and CI) until the snapshot is updated alongside it — which is
// the point: the diff of the snapshot IS the review of the API change.
//
// WHAT IS PINNED: the top-level `export`s of each listed .d.ts — name + kind, an interface's or
// class's member names (with `?` optionality and `readonly`), a type alias's right-hand side, a
// function's parameter list and return type, a const's type — with whitespace collapsed. NOT
// pinned: comments and formatting. Declarations tagged `@deprecated` in the JSDoc right above
// them are listed with a `[deprecated]` mark, so the one-release deprecation set (RFC 0003 §2) is
// itself part of the record and its removal in 1.31 is a visible snapshot change.
//
// Zero dependencies on purpose: the unit-test CI job installs nothing (the SDK's zero-dependency
// promise holds in its own test run), so this is a small purpose-built reader of the .d.ts style
// used in this repo, not the TypeScript compiler. It is deliberately conservative: anything it
// does not understand is recorded verbatim (collapsed), never dropped.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The entries whose surface is pinned, and where each snapshot lives. */
export const PINNED = Object.freeze([
  { dts: 'call.d.ts', snap: 'test/api-snapshot/call.api.txt' },
  { dts: 'call-full.d.ts', snap: 'test/api-snapshot/call-full.api.txt' },
  { dts: 'camera.d.ts', snap: 'test/api-snapshot/camera.api.txt' },
]);

const collapse = (s) =>
  s
    .replace(/\s+/g, ' ')
    .replace(/\s*([{}();,:<>|=?])\s*/g, '$1')
    .replace(/,([)}\]])/g, '$1') // trailing commas are formatting, not surface
    .replace(/;}/g, '}')
    .replace(/^[:=]\s*/, '')
    .trim();

/**
 * Strip comments and remember, per surviving offset, whether a JSDoc block saying `@deprecated`
 * immediately preceded it. Strings are kept intact.
 */
function stripComments(src) {
  let out = '';
  const marks = new Set();
  let i = 0;
  let pendingDeprecated = false;
  while (i < src.length) {
    if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2);
      const body = src.slice(i, end < 0 ? src.length : end + 2);
      if (/@deprecated\b/.test(body)) pendingDeprecated = true;
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (src.startsWith('//', i)) {
      const end = src.indexOf('\n', i);
      i = end < 0 ? src.length : end;
      continue;
    }
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (pendingDeprecated && /\S/.test(c)) {
      marks.add(out.length);
      pendingDeprecated = false;
    }
    out += c;
    i++;
  }
  return { code: out, deprecatedAt: (o) => marks.has(o) };
}

const OPEN = '{([';
const CLOSE = '})]';

/** Skip a string literal starting at `i`; returns the index of its closing quote. */
function skipString(code, i) {
  const q = code[i];
  let j = i + 1;
  while (j < code.length && code[j] !== q) j += code[j] === '\\' ? 2 : 1;
  return j;
}

/** Index of the `}` matching the `{` at `open`; -1 if none. */
function matchBrace(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(code, i);
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

/**
 * The end (exclusive) of a declaration starting at `from`: the first depth-0 `;`, or the start of
 * the next top-level `export` / `declare` line, or EOF. Only `{}` `()` `[]` nest (never `<>`:
 * `=>` and comparisons would confuse it, and a generic's own `;` sits inside braces anyway).
 */
function declEnd(code, from) {
  let depth = 0;
  for (let i = from; i < code.length; i++) {
    const c = code[i];
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(code, i);
      continue;
    }
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) depth--;
    if (depth === 0 && c === ';') return i;
    if (depth === 0 && c === '\n' && /^\s*(export|declare)\b/.test(code.slice(i + 1, i + 40))) return i;
  }
  return code.length;
}

/** Split an interface/class body into top-level members (depth-0 `;` or newline separated). */
function members(body, deprecatedAt, base) {
  const out = [];
  let depth = 0;
  let start = 0;
  const push = (a, b) => {
    const raw = body.slice(a, b);
    const t = raw.trim();
    if (!t) return;
    const at = base + a + raw.search(/\S/);
    out.push({ text: collapse(t), deprecated: deprecatedAt(at) });
  };
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(body, i);
      continue;
    }
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) depth--;
    if (depth === 0 && (c === ';' || c === '\n')) {
      push(start, i);
      start = i + 1;
    }
  }
  push(start, body.length);
  return out;
}

/** A member's name (`foo`, `foo?`, `readonly foo`, `static foo`), for the sorted listing. */
function memberName(text) {
  const m = /^(?:(static)\s+)?(?:(readonly)\s+)?([A-Za-z_$][\w$]*|'[^']*'|"[^"]*"|\[[^\]]*\])\s*(\?)?/.exec(text);
  return m ? `${m[1] ? 'static ' : ''}${m[2] ? 'readonly ' : ''}${m[3]}${m[4] || ''}` : text;
}

/**
 * The surface of one .d.ts as sorted lines: `kind name [deprecated]: detail`, with an interface's
 * or class's members indented under it.
 * @param {string} src
 */
export function extractSurface(src) {
  const { code, deprecatedAt } = stripComments(src);
  const groups = [];
  const re = /(^|\n)[ \t]*(export\s+(?:declare\s+)?(?:(?:async\s+)?function|const|let|var|class|abstract\s+class|interface|type|enum)\s+([A-Za-z_$][\w$]*)|export\s*\{|export\s*\*|declare\s+global)/g;
  let m;
  while ((m = re.exec(code))) {
    const head = m[2];
    const at = m.index + m[0].indexOf(head);
    const dep = deprecatedAt(at) ? ' [deprecated]' : '';
    if (/^export\s*\{/.test(head)) {
      const end = code.indexOf('}', re.lastIndex);
      const from = /^\s*from\s*('[^']*'|"[^"]*")/.exec(code.slice(end + 1, end + 200));
      groups.push([`reexport {${collapse(code.slice(re.lastIndex, end))}}${from ? ` from ${from[1]}` : ''}`]);
      re.lastIndex = end + 1;
      continue;
    }
    if (/^export\s*\*/.test(head)) {
      const end = declEnd(code, re.lastIndex);
      groups.push([`reexport ${collapse(head + code.slice(re.lastIndex, end))}`]);
      re.lastIndex = end + 1;
      continue;
    }
    if (/^declare\s+global/.test(head)) {
      const open = code.indexOf('{', re.lastIndex);
      const close = matchBrace(code, open);
      for (const x of members(code.slice(open + 1, close), () => false, 0)) groups.push([`global ${x.text}`]);
      re.lastIndex = close + 1;
      continue;
    }
    const kind = head
      .replace(/^export\s+(declare\s+)?/, '')
      .replace(/\s+[A-Za-z_$][\w$]*$/, '')
      .replace(/\s+/g, ' ');
    const name = m[3];
    if (/class|interface/.test(kind)) {
      const open = code.indexOf('{', re.lastIndex);
      const close = matchBrace(code, open);
      const heritage = collapse(code.slice(re.lastIndex, open));
      const ms = members(code.slice(open + 1, close), deprecatedAt, open + 1)
        .map((x) => `  ${name}.${memberName(x.text)}${x.deprecated ? ' [deprecated]' : ''}: ${x.text}`)
        .sort();
      groups.push([`${kind} ${name}${dep}${heritage ? ` ${heritage}` : ''}`, ...ms]);
      re.lastIndex = close + 1;
      continue;
    }
    const end = declEnd(code, re.lastIndex);
    groups.push([`${kind} ${name}${dep}: ${collapse(code.slice(re.lastIndex, end))}`]);
    re.lastIndex = end + 1;
  }
  groups.sort((a, b) => a[0].localeCompare(b[0]));
  return groups.flat();
}

export function surfaceText(dtsPath) {
  const src = readFileSync(resolve(root, dtsPath), 'utf8');
  return `# public API surface of ${basename(dtsPath)} — generated by tools/api-surface.mjs; update with --update in the same change as the .d.ts\n${extractSurface(src).join('\n')}\n`;
}

/** `[{ dts, snap, current, expected, stale }]` for every pinned entry. */
export function checkAll() {
  return PINNED.map((p) => {
    const current = surfaceText(p.dts);
    const snapPath = resolve(root, p.snap);
    const expected = existsSync(snapPath) ? readFileSync(snapPath, 'utf8') : null;
    return { ...p, current, expected, stale: current !== expected };
  });
}

export function updateAll() {
  for (const p of PINNED) {
    const out = resolve(root, p.snap);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, surfaceText(p.dts));
  }
}

/** A readable line diff (added / removed lines), enough to see what moved. */
export function diffLines(expected, current) {
  const a = (expected || '').split('\n');
  const b = current.split('\n');
  const sa = new Set(a);
  const sb = new Set(b);
  return [...b.filter((l) => !sa.has(l)).map((l) => `+ ${l}`), ...a.filter((l) => !sb.has(l)).map((l) => `- ${l}`)];
}

/** Every exported name of a pinned .d.ts, with its deprecation flag (for the snippet checker). */
export function exportedNames(dtsPath) {
  const out = [];
  for (const line of extractSurface(readFileSync(resolve(root, dtsPath), 'utf8'))) {
    const m = /^(function|const|let|var|class|abstract class|interface|type|enum) ([A-Za-z_$][\w$]*)( \[deprecated\])?/.exec(line);
    if (m) out.push({ name: m[2], kind: m[1], deprecated: !!m[3], type: /interface|type/.test(m[1]) });
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = process.argv[2];
  if (arg === '--update') {
    updateAll();
    console.log(`api-surface: wrote ${PINNED.map((p) => p.snap).join(', ')}`);
  } else if (arg === '--check') {
    let bad = 0;
    for (const r of checkAll()) {
      if (!r.stale) continue;
      bad++;
      console.error(`api-surface: ${r.snap} is stale for ${r.dts}:\n${diffLines(r.expected, r.current).join('\n')}`);
    }
    if (bad) {
      console.error('api-surface: the public surface changed — review it, then `node tools/api-surface.mjs --update` in the same change');
      process.exit(1);
    }
    console.log('api-surface: snapshots match');
  } else {
    for (const p of PINNED) process.stdout.write(surfaceText(p.dts) + '\n');
  }
}

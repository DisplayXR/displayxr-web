#!/usr/bin/env node
// Non-blocking reminder hook for the displayxr-inline3d plugin. Always exits 0 and never returns a
// "block" decision.
//
//   post: after Edit/Write/MultiEdit of a web file that uses @displayxr/inline3d, add ONE line of
//         context for the agent (once per session, and again only after the checker has run and the
//         page was edited since). After a Bash call that ran inline3d-check, remember that.
//   stop: if an inline-3D page was edited after the last checker run, show the user a one-line
//         notice (systemMessage). It does not stop the turn from ending.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const mode = process.argv[2] || 'post';
let input = {};
try { input = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }

const dir = join(tmpdir(), 'displayxr-inline3d-hook');
const sid = String(input.session_id || 'nosession').replace(/[^\w.-]/g, '_');
const file = join(dir, `${sid}.json`);
let state = { edited: 0, checked: 0, reminded: 0, files: [] };
try { if (existsSync(file)) state = { ...state, ...JSON.parse(readFileSync(file, 'utf8')) }; } catch { /* fresh */ }
const save = () => { try { mkdirSync(dir, { recursive: true }); writeFileSync(file, JSON.stringify(state)); } catch { /* best effort */ } };
const out = (o) => { process.stdout.write(JSON.stringify(o)); process.exit(0); };
const ROOT = process.env.CLAUDE_PLUGIN_ROOT || fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const CHECK = `node "${join(ROOT, 'checker', 'bin', 'inline3d-check.mjs')}" <url | dir | page.html>`;

const WEB = new Set(['.html', '.htm', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.vue', '.svelte', '.astro', '.css']);
const usesInline3d = (path) => {
  try {
    if (!WEB.has(extname(path).toLowerCase())) return false;
    const src = readFileSync(path, 'utf8');
    return /@displayxr\/inline3d|createInline3D|sharedInline3D|XRDisplayLayer/.test(src)
      || (extname(path).toLowerCase() === '.css' && state.files.length > 0); // CSS of a page already in play
  } catch { return false; }
};

if (mode === 'post') {
  const tool = input.tool_name || '';
  const ti = input.tool_input || {};
  if (tool === 'Bash') {
    if (/inline3d-check/.test(String(ti.command || ''))) { state.checked = Date.now(); save(); }
    process.exit(0);
  }
  const path = ti.file_path || ti.path;
  if (!path || !usesInline3d(path)) process.exit(0);
  state.edited = Date.now();
  if (!state.files.includes(path)) state.files = [...state.files, path].slice(-20);
  const due = !state.reminded || (state.checked > state.reminded && state.edited > state.checked);
  if (!due) { save(); process.exit(0); }
  state.reminded = Date.now();
  save();
  out({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: `This file uses @displayxr/inline3d. Before saying the page is done, run the checker and fix every FAIL: ${CHECK} (add --root <project> if the page imports ../ or /node_modules/).`,
    },
  });
}

if (mode === 'stop') {
  if (input.stop_hook_active) process.exit(0);
  if (state.edited && state.edited > state.checked) {
    out({ systemMessage: `displayxr-inline3d: an inline-3D page was edited after the last checker run. Run: ${CHECK}` });
  }
  process.exit(0);
}
process.exit(0);

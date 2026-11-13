#!/usr/bin/env node
// inline3d-check — does this @displayxr/inline3d page really render glasses-free 3D?
//
//   node inline3d-check.mjs <url | dir | file.html> [--root <dir>] [--max-texture 4096] [--json] [--out report.json]
//
// Loads the page in headless Chrome twice: once inside a FAKE DisplayXR inline-3D environment (the
// SDK believes it is in the DisplayXR Browser and renders two eyes), once plain (the 2D fallback).
// Exit code: 0 pass or warnings only, 1 a check failed, 2 the checker itself could not run.
// Needs Node >= 18 and a local Chrome (CHROME=/path/to/chrome to override). No npm install.
import { writeFileSync } from 'node:fs';
import { runCheck, formatHuman, VERSION } from '../lib/run.mjs';

const USAGE = `inline3d-check ${VERSION}
usage: inline3d-check <url | dir | file.html> [options]

  <url>            a running page (your dev server: http://localhost:5173/)
  <dir|file.html>  served from --root (default: the dir itself / the file's dir) on 127.0.0.1
options:
  --root <dir>         serve this directory (use the project root when the page imports ../ or /node_modules/)
  --max-texture <n>    simulate a device MAX_TEXTURE_SIZE (4096 = the Android tablet)
  --timeout <ms>       how long to wait for the 3D run to settle (default 15000)
  --viewport WxH       default 1280x800
  --no-fallback        skip the plain-browser (2D fallback) run
  --json               print the JSON report only
  --out <file>         also write the JSON report to a file
env: CHROME=/path/to/chrome`;

function parse(argv) {
  const o = { target: null, json: false, out: null, opt: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} needs a value`); return v; };
    if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0); }
    else if (a === '--version') { console.log(VERSION); process.exit(0); }
    else if (a === '--json') o.json = true;
    else if (a === '--out') o.out = val();
    else if (a === '--root') o.opt.root = val();
    else if (a === '--max-texture') o.opt.maxTexture = parseInt(val(), 10) || 0;
    else if (a === '--timeout') o.opt.timeoutMs = parseInt(val(), 10) || 15000;
    else if (a === '--no-fallback') o.opt.fallback = false;
    else if (a === '--viewport') { const [w, h] = val().split('x').map(Number); o.opt.viewport = { width: w || 1280, height: h || 800, dpr: 1 }; }
    else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else if (!o.target) o.target = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (!o.target) throw new Error('missing target');
  return o;
}

let args;
try { args = parse(process.argv.slice(2)); } catch (e) { console.error(`${e.message}\n\n${USAGE}`); process.exit(2); }
try {
  const report = await runCheck(args.target, args.opt);
  if (args.out) writeFileSync(args.out, JSON.stringify(report, null, 2));
  console.log(args.json ? JSON.stringify(report, null, 2) : formatHuman(report));
  process.exit(report.verdict === 'fail' ? 1 : 0);
} catch (e) {
  const err = { tool: 'inline3d-check', version: VERSION, target: args.target, verdict: 'error', error: e.message };
  if (args.json) console.log(JSON.stringify(err, null, 2));
  else console.error(`inline3d-check: ${e.message}`);
  process.exit(2);
}

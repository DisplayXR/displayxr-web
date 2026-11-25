#!/usr/bin/env node
// inline3d-tools — tools for @displayxr/inline3d pages, for any coding agent or a human.
//
//   inline3d-tools check <url | dir | page.html> [--root <dir>] [--max-texture 4096] [--json] [--out f]
//   inline3d-tools assets <file.glb|file.gltf> [--target tablet|desktop] [--json]
//   inline3d-tools assets prep <in> <out.glb> [--metres <m>] [--decimate <r>] [--blender <path>]
//   inline3d-tools gen providers | run <adapter> ... --confirm-paid | provenance --file ...
//   inline3d-tools scaffold <esm|vite> <target-dir> [--title "..."] [--name <npm-name>] [--force]
//   inline3d-tools mcp                          stdio MCP server with the same operations
import { readFileSync } from 'node:fs';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const USAGE = `inline3d-tools ${VERSION}: tools for @displayxr/inline3d pages

  check <url | dir | page.html> [...]     headless check: fake DisplayXR Browser + plain 2D run
  assets <file.glb|file.gltf> [...]       glTF/GLB budget + readiness check (no network)
  assets prep <in> <out.glb> [...]        convert/fix with an already-installed Blender
  gen providers | run | provenance        optional paid generation (your keys, --confirm-paid) + ASSETS.md
  scaffold <esm|vite> <target-dir> [...]  copy a known-good page template
  mcp                                     stdio MCP server exposing the same operations

  <command> --help for its options. Docs: https://github.com/DisplayXR/displayxr-web/tree/main/tools/inline3d-tools`;

const [cmd, ...rest] = process.argv.slice(2);
let code;
switch (cmd) {
  case 'check': code = await (await import('../lib/check/cli.mjs')).main(rest); break;
  case 'assets':
    code = rest[0] === 'prep'
      ? (await import('../lib/assets/prep.mjs')).main(rest.slice(1))
      : (await import('../lib/assets/asset-check.mjs')).main(rest);
    break;
  case 'gen': code = await (await import('../lib/gen.mjs')).main(rest); break;
  case 'scaffold': code = (await import('../lib/scaffold.mjs')).main(rest); break;
  case 'mcp': code = await (await import('../lib/mcp.mjs')).main(); break;
  case '--version': case '-v': console.log(VERSION); code = 0; break;
  case undefined: case 'help': case '--help': case '-h': console.log(USAGE); code = 0; break;
  default: console.error(`unknown command "${cmd}"\n\n${USAGE}`); code = 2;
}
if (code !== undefined) process.exitCode = code;

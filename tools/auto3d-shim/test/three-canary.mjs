// three.js release canary for the auto3d WebGPURenderer driver (v0.7.3). No browser, no GPU: runs on
// a stock CI runner (.github/workflows/auto3d-three-canary.yml, weekly) and on any dev box.
//
// threejs.org's examples move to every new three release (about monthly). Through v0.7.2 the driver
// had a revision ceiling, so each release silently turned the WebGPU examples 2D (r187: the
// webgpu_loader_gltf example). The driver now gates on the hooks it uses (three-adapter.js
// missingHooks) and converts newer revisions with one console note. This script is the early warning
// for both ways a release can still hurt:
//   exit 1  a hook the driver needs is GONE from the release -> pages on it go flat. Fix the driver.
//   exit 2  the release is newer than GPU_VERIFIED and every hook is present -> it converts, untested.
//           Run the harness on it (below), then raise GPU_VERIFIED.
//   exit 0  nothing to do.
// Usage: node three-canary.mjs [version|latest]    (default: latest; env THREE_CANARY_FILE=<three.webgpu.js> skips the fetch)
// Harness on the release:  rm -rf .deps/three && THREE_VERSION=<v> node deps.mjs && node run.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const adapter = readFileSync(join(here, '..', 'three-adapter.js'), 'utf8');
const num = (re, what) => { const m = adapter.match(re); if (!m) { console.error(`canary: cannot find ${what} in three-adapter.js`); process.exit(3); } return m[1]; };
const GPU_VERIFIED = parseInt(num(/GPU_VERIFIED\s*=\s*(\d+)/, 'GPU_VERIFIED'), 10);
const COMMON_API = JSON.parse(num(/const COMMON_API\s*=\s*(\[[^\]]*\])/, 'COMMON_API').replace(/'/g, '"'));

const want = process.argv[2] || 'latest';
let version, src;
if (process.env.THREE_CANARY_FILE) {
  src = readFileSync(process.env.THREE_CANARY_FILE, 'utf8');
  version = want;
} else {
  const meta = await (await fetch(`https://registry.npmjs.org/three/${want}`)).json();
  if (!meta || !meta.version) { console.error(`canary: no three@${want} on npm`); process.exit(3); }
  version = meta.version;
  const url = `https://cdn.jsdelivr.net/npm/three@${version}/build/three.webgpu.js`;
  const res = await fetch(url);
  if (!res.ok) { console.error(`canary: ${url} -> HTTP ${res.status}`); process.exit(3); }
  src = await res.text();
}
const rev = parseInt(version.split('.')[1], 10);

// The same hooks as three-adapter.js missingHooks(), looked for in the source (a method definition,
// a getter, or an assignment in the constructor).
const method = (k) => new RegExp(`\\n\\s*(?:async\\s+)?${k}\\s*\\([^)]*\\)\\s*\\{`).test(src);
const prop = (k) => new RegExp(`this\\.${k}\\s*=|get\\s+${k}\\s*\\(`).test(src);
const miss = [];
if (!prop('backend')) miss.push('backend');
if (!prop('autoClearColor')) miss.push('autoClearColor');
for (const k of COMMON_API) if (!method(k)) miss.push(k + '()');
if (!method('hasInitialized') && !prop('_initialized')) miss.push('hasInitialized() / _initialized');
if (!prop('needsFrameBufferTarget') && !method('_getFrameBufferTarget')) miss.push('needsFrameBufferTarget / _getFrameBufferTarget()');

console.log(`three@${version} (r${rev}); driver verified through r${GPU_VERIFIED}`);
if (miss.length) {
  console.log(`MISSING: ${miss.join(', ')}\nPages on r${rev} go flat ("without what the driver uses"). Fix three-adapter.js, run the harness on r${rev}, raise GPU_VERIFIED.`);
  process.exit(1);
}
if (rev > GPU_VERIFIED) {
  console.log(`NEWER: every hook is present, so r${rev} converts, but the harness has not run on it.\n` +
    `  cd tools/auto3d-shim/test && rm -rf .deps/three && THREE_VERSION=${version} node deps.mjs && node run.mjs\n` +
    `then raise GPU_VERIFIED to ${rev} in three-adapter.js.`);
  process.exit(2);
}
console.log('OK');

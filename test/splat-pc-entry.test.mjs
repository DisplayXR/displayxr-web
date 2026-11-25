// `@displayxr/inline3d/splat/playcanvas` must never pull `three` or `@sparkjsdev/spark` onto a
// page. ./splat imports both statically (Spark is its default engine), so a page asking it for
// engine:'playcanvas' still downloads ~1.7 MB gzipped it never runs. This entry exists to stop
// that, and the property is easy to lose: one convenience import anywhere in its graph puts
// both back. So walk the STATIC import graph and fail on any bare specifier other than none —
// `playcanvas` is reached only through dynamic import(), which is the point.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const js = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'js');

/** Static `import … from 'x'` / `export … from 'x'` / bare `import 'x'` specifiers of one file. */
function staticSpecifiers(file) {
  const src = readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const out = [];
  const re = /(?:^|[;\n])\s*(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  for (const m of src.matchAll(re)) out.push(m[1]);
  return out;
}

function staticGraph(entry) {
  const seen = new Set();
  const bare = new Map();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const spec of staticSpecifiers(file)) {
      if (spec.startsWith('.')) walk(resolve(dirname(file), spec));
      else bare.set(spec, file);
    }
  };
  walk(entry);
  return { files: seen, bare };
}

test('./splat/playcanvas: no bare package in its static import graph', () => {
  const { files, bare } = staticGraph(resolve(js, 'inline3d-splat-pc-entry.js'));
  assert.ok(files.has(resolve(js, 'inline3d-splat-deferred.js')), 'walker reached the deferred handle');
  assert.deepEqual(
    [...bare].map(([spec, from]) => `${spec} (from ${from.slice(js.length + 1)})`),
    [],
    'a static import of three / spark / playcanvas leaked into ./splat/playcanvas',
  );
});

test('the walker does see ./splat\'s static three + spark (control)', () => {
  const { bare } = staticGraph(resolve(js, 'inline3d-splat.js'));
  assert.ok(bare.has('three') && bare.has('@sparkjsdev/spark'), [...bare.keys()].join(', '));
});

test('./splat/playcanvas addSplat: PlayCanvas handle, engine fixed, same call-site checks', async () => {
  const { addSplat } = await import('../js/inline3d-splat-pc-entry.js');
  const h = addSplat(null, {}, 'scene.sog');
  assert.equal(h.backend, 'playcanvas');
  assert.equal(typeof h.exclude, 'function');
  // the adapter cannot start under node (no playcanvas): `ready` rejects, which is expected here
  await h.ready.catch(() => {});
  assert.throws(() => addSplat(null, {}, 'scene.sog', { engine: 'spark' }), /PlayCanvas only/);
  assert.throws(() => addSplat(null, {}, 'scene.sog', { captureFit: 'nope' }), /captureFit/);
  assert.throws(() => addSplat(null, {}, 'scene.sog', { reveal: 'nope' }));
});

// The experimental app helpers (1.52.2): the SAME functions as the viewers', and still light.
test('./splat/rig re-exports the viewers\' own rig/window functions, with no bare import at all', async () => {
  const rig = await import('../js/inline3d-splat-rig-entry.js');
  const inner = await import('../js/inline3d-splat-rig.js');
  const shared = await import('../js/inline3d-splat-shared.js');
  for (const k of ['toRestSpace', 'aheadOfRest', 'planeDistance', 'medianDisparityDistance', 'FOCUS_MIN_M', 'FOCUS_MAX_M']) assert.equal(rig[k], inner[k], k);
  assert.equal(rig.captureWindow, shared.captureWindow);
  assert.deepEqual([...staticGraph(resolve(js, 'inline3d-splat-rig-entry.js')).bare.keys()], []);
});

test('./splat/playcanvas: readCloud loads the viewer module lazily (not in the static graph); room helpers are the look module\'s', async () => {
  const entry = await import('../js/inline3d-splat-pc-entry.js');
  const look = await import('../js/inline3d-pc-look.js');
  assert.equal(entry.roomRGBE, look.roomRGBE);
  assert.equal(entry.ROOM_YAW_DEG, look.ROOM_YAW_DEG);
  assert.equal(await entry.readCloud(null), null, 'a missing resource resolves null, through the real readCloud');
  const g = staticGraph(resolve(js, 'inline3d-splat-pc-entry.js'));
  assert.ok(![...g.files].some((f) => f.endsWith('inline3d-splat-playcanvas.js')), 'the viewer module stays out of the static graph');
});

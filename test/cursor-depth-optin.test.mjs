// `cursor: 'depth'` is OPT-IN with zero cost otherwise (runtime ADR-046 §0). Pins the structural
// half of that promise on both viewers: without the option nothing is built and the per-frame
// hooks have nothing to call. (The behavioural half — what the cursor does when asked — is
// test/cursor-depth.test.mjs and test/e2e/cursor-depth.e2e.mjs.)

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { installDom, makeCanvas, makeTHREE, makeViews, makeLayer } from './stubs.mjs';

installDom();
const { SceneViewer } = await import('../js/inline3d-viewer.js');
const { EyeCamera } = await import('../js/inline3d-three.js');
const { PlayCanvasSplatViewer } = await import('../js/inline3d-splat-playcanvas.js');

test('SceneViewer: no cursor option → no cursor object, and frames run without one', () => {
  const { THREE } = makeTHREE();
  const canvas = makeCanvas(300, 200);
  const viewer = new SceneViewer(THREE, canvas, { orbit: false });
  viewer.useEyeCamera(EyeCamera);
  assert.equal(viewer.cursorDepth ?? null, null);
  viewer.onFrame(makeViews(2), makeLayer(canvas), null);
  assert.equal(viewer.cursorDepth ?? null, null);
  assert.equal(canvas.style.cursor, undefined, 'the CSS cursor is never touched');
  viewer.dispose();
});

test('PlayCanvasSplatViewer: no cursor option → no cursor, and its module is only ever imported on opt-in', () => {
  const viewer = new PlayCanvasSplatViewer(makeCanvas(300, 200), { orbit: false });
  assert.equal(viewer._cursorOpt, null);
  assert.equal(viewer.cursorDepth, null);
  // The module is reached by a DYNAMIC import guarded by the option, never statically.
  const src = readFileSync(new URL('../js/inline3d-splat-playcanvas.js', import.meta.url), 'utf8');
  assert.ok(!/^\s*import\s[^;]*inline3d-cursor-depth/m.test(src), 'no static import of the cursor modules');
  assert.match(src, /if \(this\._cursorOpt\) \{[^}]*?import\('\.\/inline3d-cursor-depth-playcanvas\.js'\)/s);
  // The option is validated by the tiny option module, never by importing the cursor itself.
  assert.match(src, /^import \{ resolveCursorOption \} from '\.\/inline3d-cursor-option\.js';$/m);
});

test('./model (three.js): the BVH pick and its vendored three-mesh-bvh load only on opt-in, dynamically', () => {
  const read = (f) => readFileSync(new URL(`../js/${f}`, import.meta.url), 'utf8');
  const model = read('inline3d-model.js');
  // Never statically: not from ./model, not from the viewer, not from ./three (every three page loads those).
  for (const [f, src] of [['inline3d-model.js', model], ['inline3d-viewer.js', read('inline3d-viewer.js')], ['inline3d-three.js', read('inline3d-three.js')]]) {
    assert.ok(!/^\s*import\s[^;]*(inline3d-cursor-bvh|three-mesh-bvh)/m.test(src), `${f}: no static import of the BVH pick`);
  }
  // One literal dynamic import, inside cursorHitTest, which is reached only through the option.
  assert.equal((model.match(/import\('\.\/inline3d-cursor-bvh\.js'\)/g) || []).length, 1);
  assert.match(model, /function cursorHitTest\(content\) \{[^]*?import\('\.\/inline3d-cursor-bvh\.js'\)/);
  const uses = model.match(/\bcursorHitTest\b/g) || [];
  assert.equal(uses.length, 2, 'defined once, used once');
  assert.match(model, /if \(cursorOpts\) viewer\.useDepthCursor\(DepthCursor, cursorHitTest,/);
  // The vendored slice is the only thing that imports three-mesh-bvh, and it ships in the package.
  assert.match(read('inline3d-cursor-bvh.js'), /^import \{ MeshBVH \} from '\.\/vendor\/three-mesh-bvh\.js';$/m);
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  for (const f of ['js/inline3d-cursor-bvh.js', 'js/vendor/', 'js/inline3d-cursor-perf.js']) assert.ok(pkg.files.includes(f), `package.json "files" lists ${f}`);
});

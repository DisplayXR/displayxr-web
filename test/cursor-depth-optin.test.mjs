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
  assert.match(src, /if \(this\._cursorOpt === 'depth'\) \{\s*import\('\.\/inline3d-cursor-depth-playcanvas\.js'\)/);
});

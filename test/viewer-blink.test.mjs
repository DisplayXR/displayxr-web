// Regression tests for web#12 — the viewer's dark blink under load.
//
// The bug in one line: SceneViewer.onFrame cleared the canvas BEFORE it knew whether it could
// draw, so a frame that arrived with a short view list (or a viewport it could not resolve) left
// a transparent buffer for the weave to consume. These tests pin the two halves of the fix:
//
//   1. No frame ever clears without drawing.       (the blink itself)
//   2. A no-op resize never touches canvas.width.  (the black frame per box change)

import test from 'node:test';
import assert from 'node:assert/strict';

import { installDom, makeCanvas, makeTHREE, makeViews, makeLayer } from './stubs.mjs';

const dom = installDom();
const { SceneViewer } = await import('../js/inline3d-viewer.js');
const { EyeCamera } = await import('../js/inline3d-three.js');

function setup({ withEye = true, canvasSize = [300, 200] } = {}) {
  const { THREE, log } = makeTHREE();
  const canvas = makeCanvas(...canvasSize);
  const viewer = new SceneViewer(THREE, canvas, { orbit: false });
  if (withEye) viewer.useEyeCamera(EyeCamera);
  log.setSize.length = 0; // the constructor's first sizing is not under test
  return { THREE, log, canvas, viewer };
}

function withCapturedWarnings(fn) {
  const warns = [];
  const real = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    fn(warns);
  } finally {
    console.warn = real;
  }
  return warns;
}

// ── 1. validate before clear ────────────────────────────────────────────────────────────

test('an empty view list never clears the canvas', () => {
  const { log, canvas, viewer } = setup();
  viewer.onFrame([], makeLayer(canvas));
  assert.equal(log.clear, 0, 'cleared on a frame it could not draw');
  assert.equal(log.render.length, 0);
});

test('a one-eye view list never clears the canvas', () => {
  const { log, canvas, viewer } = setup();
  viewer.onFrame(makeViews(1), makeLayer(canvas));
  assert.equal(log.clear, 0, 'the load-induced mono fallback must not blank the tile');
  assert.equal(log.render.length, 0);
});

test('a null viewport never clears the canvas', () => {
  const { log, canvas, viewer } = setup();
  viewer.onFrame(makeViews(2), makeLayer(canvas, { nullFor: 1 }));
  assert.equal(log.clear, 0, 'cleared even though the right eye had nowhere to go');
  assert.equal(log.render.length, 0);
});

test('a degenerate (zero-width) viewport never clears the canvas', () => {
  const { log, canvas, viewer } = setup();
  const layer = { getViewport: () => ({ x: 0, y: 0, width: 0, height: 0 }) };
  viewer.onFrame(makeViews(2), layer);
  assert.equal(log.clear, 0);
});

test('a missing layer never clears the canvas', () => {
  const { log, viewer } = setup();
  viewer.onFrame(makeViews(2), null);
  assert.equal(log.clear, 0);
});

test('without useEyeCamera it warns ONCE and draws the mono camera instead of clearing', () => {
  const { log, canvas, viewer } = setup({ withEye: false });
  const warns = withCapturedWarnings(() => {
    for (let i = 0; i < 5; i++) viewer.onFrame(makeViews(2), makeLayer(canvas));
  });
  assert.equal(warns.length, 1, 'the warning must be once per viewer, not once per frame');
  assert.match(warns[0], /useEyeCamera/);
  assert.equal(log.clear, 5);
  assert.equal(log.render.length, 10, 'two eyes a frame');
  for (const r of log.render) assert.equal(r.camera, viewer.monoCamera);
  assert.equal(log.clearsWithoutDraw, 0, 'the old code cleared and drew nothing, silently');
});

test('a good frame clears once and draws both eyes', () => {
  const { log, canvas, viewer } = setup();
  viewer.onFrame(makeViews(2), makeLayer(canvas));
  assert.equal(log.clear, 1);
  assert.equal(log.render.length, 2);
  assert.deepEqual(log.scissorTest, [true, false]);
});

// ── 2. replay ───────────────────────────────────────────────────────────────────────────

test('a bad frame replays the last good frame, matrices and viewports intact', () => {
  const { log, canvas, viewer } = setup();
  const views = makeViews(2, /*seed*/ 7);
  const layer = makeLayer(canvas);
  viewer.onFrame(views, layer);

  const goodProj = log.render.map((r) => Array.from(r.camera.projectionMatrix.elements));
  const goodVps = log.render.map((r) => r.viewport);
  log.clear = 0;
  log.render.length = 0;

  viewer.onFrame([], layer); // the frame that used to go dark

  assert.equal(log.clear, 1, 'a replay still commits a frame — the weave needs the repaint');
  assert.equal(log.render.length, 2, 'both eyes replayed');
  assert.deepEqual(
    log.render.map((r) => Array.from(r.camera.projectionMatrix.elements)),
    goodProj,
    'the replayed projection must be the cached one',
  );
  assert.deepEqual(log.render.map((r) => r.viewport), goodVps);
  assert.equal(log.clearsWithoutDraw, 0);
});

test('the replay cache COPIES the matrices — an XRView is only valid in its own frame', () => {
  const { log, canvas, viewer } = setup();
  const views = makeViews(2, 3);
  const layer = makeLayer(canvas);
  viewer.onFrame(views, layer);
  const beforeRecycle = log.render.map((r) => Array.from(r.camera.projectionMatrix.elements));

  // The UA recycles the view's backing store after the callback returns. Simulate that.
  for (const v of views) {
    v.projectionMatrix.fill(-999);
    v.transform.matrix.fill(-999);
    v.transform = null;
  }
  log.render.length = 0;
  viewer.onFrame(null, layer);

  assert.deepEqual(
    log.render.map((r) => Array.from(r.camera.projectionMatrix.elements)),
    beforeRecycle,
    'the replay read recycled view memory — the cache is holding references, not copies',
  );
});

test('a bad frame before any good one does nothing at all', () => {
  const { log, canvas, viewer } = setup();
  for (let i = 0; i < 3; i++) viewer.onFrame(makeViews(1), makeLayer(canvas));
  assert.equal(log.clear, 0);
  assert.equal(log.render.length, 0);
});

test('a sustained bad run keeps replaying rather than degrading', () => {
  const { log, canvas, viewer } = setup();
  const layer = makeLayer(canvas);
  viewer.onFrame(makeViews(2), layer);
  log.clear = 0;
  log.render.length = 0;
  for (let i = 0; i < 60; i++) viewer.onFrame(makeViews(1), layer);
  assert.equal(log.clear, 60);
  assert.equal(log.render.length, 120);
  assert.equal(log.clearsWithoutDraw, 0);
});

// ── 3. non-destructive resize ───────────────────────────────────────────────────────────

test('a no-op resize does not call setSize (writing canvas.width clears the buffer)', () => {
  const { log, viewer } = setup();
  viewer._resize();
  viewer._resize();
  assert.equal(log.setSize.length, 0, 'the buffer had not moved — this is the per-box-change blink');
});

test('a real resize resizes and repaints the last good frame immediately', () => {
  const { log, canvas, viewer } = setup();
  const layer = makeLayer(canvas);
  viewer.onFrame(makeViews(2), layer);
  log.clear = 0;
  log.render.length = 0;

  canvas.setBox(400, 250);
  viewer._resize();

  assert.equal(log.setSize.length, 1);
  assert.deepEqual(log.setSize[0], { w: 800, h: 250 }, 'SBS store is double-width');
  assert.equal(log.render.length, 2, 'the cleared buffer must be repainted in the same task');
  // …and into the NEW geometry, not the stale rects the cache was taken with.
  assert.deepEqual(log.render[1].viewport, { x: 400, y: 0, width: 400, height: 250 });
  assert.equal(log.clearsWithoutDraw, 0);
});

test('observer bursts coalesce to a single animation frame', () => {
  const { log, canvas, viewer } = setup();
  canvas.setBox(500, 300);
  for (let i = 0; i < 8; i++) viewer._onResize();
  assert.equal(log.setSize.length, 0, 'the resize must not run inline with the observer');
  dom.flushRaf();
  assert.equal(log.setSize.length, 1, 'eight callbacks, one reallocation');
  viewer.dispose();
});

// ── 4. EyeCamera.setFromMatrices ────────────────────────────────────────────────────────

test('setFromMatrices and setFromView produce the same camera', () => {
  const { THREE } = makeTHREE();
  const [view] = makeViews(1, 5);
  const a = new EyeCamera(THREE);
  const b = new EyeCamera(THREE);
  a.setFromView(view);
  b.setFromMatrices(view.projectionMatrix, view.transform.matrix);
  for (const k of ['projectionMatrix', 'projectionMatrixInverse', 'matrix', 'matrixWorld', 'matrixWorldInverse']) {
    assert.deepEqual(Array.from(a.camera[k].elements), Array.from(b.camera[k].elements), k);
  }
});

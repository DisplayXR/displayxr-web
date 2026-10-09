// Every session frame presents (1.38, woven-canvas-rules "redraw every frame"): the PlayCanvas
// viewer behind ./splat (engine:'playcanvas') and ./model (default engine) draws on EVERY frame it
// is handed — its views, the last good frame, or, before there is one, the mono camera into both
// halves — with or without content loaded. (SceneViewer, the Spark / three engines' viewer, is
// pinned the same way in viewer-blink.test.mjs.) Stand-in engine: draws are recorded.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installDom, makeCanvas } from './stubs.mjs';

installDom();
const { PlayCanvasSplatViewer } = await import('../js/inline3d-splat-playcanvas.js');

function gl(canvas) {
  return {
    getParameter: (p) => (p === 3 ? Int32Array.from([16384, 16384]) : 16384),
    MAX_TEXTURE_SIZE: 1,
    MAX_RENDERBUFFER_SIZE: 2,
    MAX_VIEWPORT_DIMS: 3,
    get drawingBufferWidth() {
      return canvas.width;
    },
    get drawingBufferHeight() {
      return canvas.height;
    },
  };
}

function viewerWithEngine() {
  const canvas = makeCanvas(400, 200);
  const viewer = new PlayCanvasSplatViewer(canvas, { orbit: false });
  viewer.app = { graphicsDevice: { gl: gl(canvas) }, destroy() {} };
  viewer.pc = {};
  viewer._resize();
  const draws = [];
  viewer._drawEntriesInner = (entries, cache) => {
    draws.push({ n: entries.length, rects: entries.map((e) => [e.x, e.y, e.width, e.height]), cached: !!cache });
    return true;
  };
  return { canvas, viewer, draws };
}

const views2 = () =>
  [0, 1].map(() => ({ projectionMatrix: new Float32Array([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, -1, -1, 0, 0, -0.5, 0]), transform: { matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) } }));
const layer = (canvas) => ({ getViewport: () => ({ x: 0, y: 0, width: canvas.width / 2, height: canvas.height }) });

test('before any good frame, a short view list draws the flat pair (both halves), not nothing', () => {
  const { canvas, viewer, draws } = viewerWithEngine();
  viewer.onFrame([], layer(canvas), {});
  viewer.onFrame(null, layer(canvas), {});
  assert.equal(draws.length, 2, 'one presented frame per session frame');
  for (const d of draws) {
    assert.equal(d.n, 2);
    assert.deepEqual(d.rects, [
      [0, 0, 400, 200],
      [400, 0, 400, 200],
    ]);
    assert.equal(d.cached, false);
  }
  viewer.dispose();
});

test('before any good frame, a frame with no usable viewport draws the flat pair', () => {
  const { viewer, draws } = viewerWithEngine();
  viewer.onFrame(views2(), null, {});
  viewer.onFrame(views2(), { getViewport: () => ({ x: 0, y: 0, width: 0, height: 0 }) }, {});
  assert.equal(draws.length, 2);
  viewer.dispose();
});

test('every session frame presents: good frames, load-fallback frames, with no content loaded', () => {
  const { canvas, viewer, draws } = viewerWithEngine();
  assert.equal(viewer.splat, null, 'no source: nothing loaded on this viewer');
  const seq = [2, 1, 0, 2, 2, 1, 2];
  for (const n of seq) viewer.onFrame(n === 2 ? views2() : n === 1 ? views2().slice(0, 1) : [], layer(canvas), {});
  assert.equal(draws.length, seq.length, 'a draw for every frame, whatever it carried');
  assert.equal(draws[1].cached, true, 'after a good frame, a bad one replays it');
  viewer.dispose();
});

test('before the engine attaches there is no context to present into: no draw, no throw', () => {
  const canvas = makeCanvas(400, 200);
  const viewer = new PlayCanvasSplatViewer(canvas, { orbit: false });
  assert.doesNotThrow(() => viewer.onFrame([], layer(canvas), {}));
  assert.equal(viewer._drawFlatPair(), false);
  viewer.dispose();
});

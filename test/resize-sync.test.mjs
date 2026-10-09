// Resize and draw in the same task (1.38): the PlayCanvas viewer (./splat engine:'playcanvas',
// ./model's default engine) resizes its backing store and replays the last frame INSIDE the
// ResizeObserver callback, which runs before the paint — so the old store is never shown
// stretched onto the new box. And the core's addScene `onResize(box)` hands a page-drawn window
// the same moment. Mocked ResizeObserver (test/stubs.mjs), recording draws, no engine.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installDom, makeCanvas } from './stubs.mjs';

const dom = installDom();
const { PlayCanvasSplatViewer } = await import('../js/inline3d-splat-playcanvas.js');

function gl(canvas) {
  return {
    MAX_TEXTURE_SIZE: 1,
    MAX_RENDERBUFFER_SIZE: 2,
    MAX_VIEWPORT_DIMS: 3,
    getParameter: (p) => (p === 3 ? Int32Array.from([16384, 16384]) : 16384),
    get drawingBufferWidth() {
      return canvas.width;
    },
    get drawingBufferHeight() {
      return canvas.height;
    },
  };
}

/** A viewer with a stand-in engine: draws are recorded, with the buffer size they drew into. */
function pcViewer(box = [400, 200]) {
  const canvas = makeCanvas(...box);
  const viewer = new PlayCanvasSplatViewer(canvas, { orbit: false });
  viewer.app = { graphicsDevice: { gl: gl(canvas) }, destroy() {} };
  viewer.pc = {};
  const draws = [];
  viewer._drawEntriesInner = (entries, cache) => {
    draws.push({ w: canvas.width, h: canvas.height, proj: entries.map((e) => Array.from(e.proj)), cache, drawing: viewer._drawing });
    return true;
  };
  viewer._resize(); // the constructor sized before the stand-in GL existed
  return { canvas, viewer, draws };
}

const P = [2, 0, 0, 0, 0, 2, 0, 0, 0.25, 0, -1, -1, 0, 0, -0.5, 0]; // exact in float32
function seedGood(viewer, canvas) {
  const views = [0, 1].map(() => ({ projectionMatrix: Float32Array.from(P), transform: { matrix: new Float32Array(16) } }));
  const half = canvas.width / 2;
  viewer._cacheGood(views, [
    { x: 0, y: 0, width: half, height: canvas.height },
    { x: half, y: 0, width: half, height: canvas.height },
  ]);
}

test('PlayCanvas viewer: a CSS resize resizes and replays INSIDE the observer callback, no rAF', () => {
  const { canvas, viewer, draws } = pcViewer();
  assert.equal(canvas.width, 800);
  seedGood(viewer, canvas);
  draws.length = 0;
  dom.flushRaf();
  canvas.setBox(600, 200);
  dom.fireResizeObservers();
  assert.equal(canvas.width, 1200, 'resized in the callback, before the paint');
  assert.equal(draws.length, 1, 'and drawn in the same task');
  assert.equal(draws[0].w, 1200, 'into the NEW store');
  assert.equal(dom.pendingRaf(), 0, 'nothing deferred to the next frame');
  viewer.dispose();
});

test('PlayCanvas viewer: the replay keeps proportions across an aspect change (x row / f)', () => {
  const { canvas, viewer, draws } = pcViewer([400, 200]); // 2:1 per eye
  seedGood(viewer, canvas);
  draws.length = 0;
  canvas.setBox(800, 200); // 4:1: f = 2
  dom.fireResizeObservers();
  const proj = draws[0].proj[0];
  assert.equal(proj[0], 1, 'P[0] / 2');
  assert.equal(proj[8], 0.125, 'the off-axis term scales with it');
  assert.equal(proj[5], 2, 'the vertical frustum is untouched');
  // The cache itself is untouched: the next located views replace it, a second replay redoes the fix.
  assert.equal(viewer._lastGood.entries[0].proj[0], 2);
  viewer.dispose();
});

test('PlayCanvas viewer: same-aspect resize replays the cached projection unchanged', () => {
  const { canvas, viewer, draws } = pcViewer([400, 200]);
  seedGood(viewer, canvas);
  draws.length = 0;
  canvas.setBox(800, 400);
  dom.fireResizeObservers();
  assert.deepEqual(draws[0].proj[0], P);
  viewer.dispose();
});

test('PlayCanvas viewer: an observer callback during a draw, or a re-entrant one, defers to one rAF', () => {
  const { canvas, viewer, draws } = pcViewer();
  seedGood(viewer, canvas);
  draws.length = 0;
  dom.flushRaf();
  viewer._drawing = true; // a nested dispatch from inside the engine's tick
  canvas.setBox(500, 200);
  dom.fireResizeObservers();
  assert.equal(canvas.width, 800, 'never reallocated under a running render');
  assert.equal(dom.pendingRaf(), 1);
  viewer._drawing = false;
  dom.flushRaf();
  assert.equal(canvas.width, 1000);

  // Re-entrancy: a resize whose own work fires the observer again.
  let inner = 0;
  const real = viewer._resize.bind(viewer);
  viewer._resize = () => {
    inner++;
    if (inner === 1) {
      canvas.setBox(520, 200);
      dom.fireResizeObservers();
    }
    real();
  };
  canvas.setBox(510, 200);
  dom.fireResizeObservers();
  assert.equal(inner, 1, 'the nested callback did not resize re-entrantly');
  assert.equal(dom.pendingRaf(), 1, 'it was deferred instead');
  dom.flushRaf();
  assert.equal(inner, 2);
  assert.equal(canvas.width, 1040);
  viewer.dispose();
});

test('PlayCanvas viewer: _drawing is set for exactly the duration of a draw', () => {
  const { canvas, viewer, draws } = pcViewer();
  seedGood(viewer, canvas);
  draws.length = 0;
  viewer._replayLastGood();
  assert.equal(draws[0].drawing, true);
  assert.equal(viewer._drawing, false);
  viewer.dispose();
});

// ── core: addScene({ onResize }) ─────────────────────────────────────────────────────────────

test('core addScene onResize: called in the observer callback on a real box change only', async () => {
  const observers = [];
  globalThis.ResizeObserver = class {
    constructor(cb) {
      this.cb = cb;
      observers.push(this);
    }
    observe() {}
    disconnect() {
      this.gone = true;
    }
  };
  let frameCb = null;
  const session = {
    addEventListener() {},
    removeEventListener() {},
    requestReferenceSpace: async () => ({}),
    requestAnimationFrame(cb) {
      frameCb = cb;
      return 1;
    },
    end() {},
  };
  Object.defineProperty(globalThis, 'navigator', { value: { xr: { requestSession: async () => session } }, configurable: true, writable: true });
  class L {
    getViewport() {
      return { x: 0, y: 0, width: 1, height: 1 };
    }
    close() {}
  }
  globalThis.window = { XRDisplayLayer: L, devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} };
  globalThis.XRDisplayLayer = L;
  const { createInline3D } = await import('../js/inline3d.js');
  const wall = await createInline3D({ lazy: false, autoChrome: false });
  const canvas = { style: {}, width: 0, height: 0, clientWidth: 300, clientHeight: 150, parentElement: null, getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 150 }) };
  const seen = [];
  const h = wall.addScene(canvas, () => {}, { onResize: (box) => seen.push(box) });
  const ro = observers.at(-1);
  ro.cb([]); // the initial observe() fire: nothing changed
  assert.equal(seen.length, 0);
  canvas.clientWidth = 600;
  ro.cb([]);
  assert.deepEqual(seen, [{ width: 600, height: 150, dpr: 1 }]);
  ro.cb([]);
  assert.equal(seen.length, 1, 'same box: not called again');
  // A throwing callback is contained, warned once.
  const warns = [];
  const realWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    const h2c = { ...canvas, clientWidth: 100 };
    wall.addScene(h2c, () => {}, { onResize: () => { throw new Error('boom'); } });
    const ro2 = observers.at(-1);
    h2c.clientWidth = 200;
    ro2.cb([]);
    h2c.clientWidth = 300;
    ro2.cb([]);
  } finally {
    console.warn = realWarn;
  }
  assert.equal(warns.filter((w) => /onResize threw/.test(w)).length, 1);
  h.remove();
  assert.equal(ro.gone, true, 'the observer goes with the window');
  void frameCb;
  wall.close();
});

test('core addScene without onResize: no observer on a scene canvas (unchanged)', async () => {
  const observers = [];
  globalThis.ResizeObserver = class {
    constructor() {
      observers.push(this);
    }
    observe() {}
    disconnect() {}
  };
  const { createInline3D } = await import('../js/inline3d.js');
  const wall = await createInline3D({ lazy: false, autoChrome: false });
  const canvas = { style: {}, width: 0, height: 0, clientWidth: 300, clientHeight: 150, parentElement: null, getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 150 }) };
  wall.addScene(canvas, () => {});
  assert.equal(observers.length, 0);
  wall.close();
});

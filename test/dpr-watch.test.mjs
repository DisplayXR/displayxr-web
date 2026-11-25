// A devicePixelRatio-only change (browser zoom, a drag to a monitor at a different scale) is
// invisible to ResizeObserver: the CSS box keeps its size while the buffer it deserves changes
// (web#267). The core's `(resolution: Ndppx)` watcher must reach a scene window's onResize(box)
// (it used to stop at _onBoxChange, which ignores windows that do not own their buffer), and
// SceneViewer must watch dpr itself, re-arming on the new value and letting go in dispose().
// Mocked matchMedia + ResizeObserver, no engine.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installDom, makeCanvas, makeTHREE } from './stubs.mjs';

const dom = installDom();

/** A matchMedia that records every `(resolution: Ndppx)` query and lets a test flip one. */
function installMatchMedia() {
  const queries = [];
  window.matchMedia = (media) => {
    const q = {
      media,
      listeners: new Set(),
      addEventListener(type, cb) {
        if (type === 'change') this.listeners.add(cb);
      },
      removeEventListener(type, cb) {
        if (type === 'change') this.listeners.delete(cb);
      },
    };
    queries.push(q);
    return q;
  };
  return {
    queries,
    /** The queries somebody is still listening to. */
    live: () => queries.filter((q) => q.listeners.size > 0),
    /** Move devicePixelRatio and fire every live query, as the browser would. */
    setDpr(dpr) {
      window.devicePixelRatio = dpr;
      for (const q of queries.slice()) for (const cb of [...q.listeners]) cb({ matches: false, media: q.media });
    },
  };
}

test('SceneViewer: a dpr-only change resizes the buffer; the watch re-arms and goes with dispose()', async () => {
  window.devicePixelRatio = 1;
  const mm = installMatchMedia();
  const { SceneViewer } = await import('../js/inline3d-viewer.js');
  const { THREE } = makeTHREE();
  const canvas = makeCanvas(400, 200);
  const v = new SceneViewer(THREE, canvas, { fit: 'none', orbit: false });
  assert.equal(canvas.width, 800, '3D store: double width at dpr 1');
  assert.deepEqual(mm.live().map((q) => q.media), ['(resolution: 1dppx)']);

  dom.flushRaf();
  mm.setDpr(1.5);
  assert.deepEqual(mm.live().map((q) => q.media), ['(resolution: 1.5dppx)'], 're-armed on the new value, old one released');
  assert.equal(dom.pendingRaf(), 1, 'the resize is the coalesced one');
  dom.flushRaf();
  assert.equal(canvas.width, 1200);
  assert.equal(canvas.height, 300);

  // dpr is capped at 2 for this viewer: a 3x display sizes like a 2x one.
  mm.setDpr(3);
  dom.flushRaf();
  assert.equal(canvas.width, 1600);

  v.dispose();
  assert.equal(mm.live().length, 0, 'dispose() removes the listener');
  mm.setDpr(1);
  assert.equal(dom.pendingRaf(), 0, 'nothing scheduled after dispose');
  window.devicePixelRatio = 1;
  delete window.matchMedia;
});

test('SceneViewer without matchMedia: constructs and disposes as before', async () => {
  delete window.matchMedia;
  const { SceneViewer } = await import('../js/inline3d-viewer.js');
  const { THREE } = makeTHREE();
  const v = new SceneViewer(THREE, makeCanvas(400, 200), { fit: 'none', orbit: false });
  assert.equal(v._dprWatch, null);
  v.dispose();
});

test('core: a dpr-only change reaches a scene window onResize(box), once per change', async () => {
  const observers = [];
  globalThis.ResizeObserver = class {
    constructor(cb) {
      this.cb = cb;
      observers.push(this);
    }
    observe() {}
    disconnect() {}
  };
  const session = {
    addEventListener() {},
    removeEventListener() {},
    requestReferenceSpace: async () => ({}),
    requestAnimationFrame: () => 1,
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
  const mm = installMatchMedia();
  const { createInline3D } = await import('../js/inline3d.js');
  const wall = await createInline3D({ lazy: false, autoChrome: false });
  const canvas = { style: {}, width: 0, height: 0, clientWidth: 300, clientHeight: 150, parentElement: null, getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 150 }) };
  const seen = [];
  const h = wall.addScene(canvas, () => {}, { onResize: (box) => seen.push(box) });
  assert.ok(mm.live().length >= 1, 'the manager armed a resolution query');

  mm.setDpr(2);
  assert.deepEqual(seen, [{ width: 300, height: 150, dpr: 2 }], 'the box did not move, dpr did: onResize runs');
  assert.ok(mm.live().every((q) => q.media === '(resolution: 2dppx)'), 're-armed on the new value');

  // The ResizeObserver firing afterwards on the same box and dpr is not a second change.
  observers.at(-1).cb([]);
  assert.equal(seen.length, 1);

  h.remove();
  wall.close();
});

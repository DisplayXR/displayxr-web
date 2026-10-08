// The double-attach guard (1.38): add*() on a canvas that is still registered on the same wall
// warns once per canvas, naming the method and the live first registration, and returns the
// EXISTING handle — no second layer, no second renderer. A kiosk demo attached its stage twice per
// screen visit before this. Core methods and the ./splat entry (engine:'playcanvas', whose
// renderer exists before its core window, which is why the check sits at the entry).

import test from 'node:test';
import assert from 'node:assert/strict';

import { installDom, makeCanvas as makeViewerCanvas } from './stubs.mjs';

const dom = installDom();

function makeCanvas(w = 300, h = 150) {
  const ctx = { save() {}, restore() {}, clearRect() {}, drawImage() {} };
  return {
    style: {},
    width: 0,
    height: 0,
    clientWidth: w,
    clientHeight: h,
    parentElement: null,
    contains: () => false,
    getBoundingClientRect: () => ({ x: 0, y: 0, left: 0, top: 0, width: w, height: h }),
    getContext: () => ctx,
  };
}

const created = [];
class FakeDisplayLayer {
  constructor(session, canvas) {
    this.canvas = canvas;
    created.push(this);
  }
  getViewport() {
    return { x: 0, y: 0, width: 1, height: 1 };
  }
  close() {
    this.closed = true;
  }
}
const session = {
  addEventListener() {},
  removeEventListener() {},
  requestReferenceSpace: async () => ({}),
  requestAnimationFrame: () => 1,
  end() {},
};
Object.defineProperty(globalThis, 'navigator', { value: { xr: { requestSession: async () => session } }, configurable: true, writable: true });
Object.assign(globalThis.window, { XRDisplayLayer: FakeDisplayLayer, addEventListener() {}, removeEventListener() {} });
globalThis.XRDisplayLayer = FakeDisplayLayer;
globalThis.Image = class {};

const { createInline3D } = await import('../js/inline3d.js');
const { addSplat } = await import('../js/inline3d-splat-pc-entry.js');

function captureWarnings(fn) {
  const real = console.warn;
  const warns = [];
  console.warn = (...a) => warns.push(a.map(String).join(' '));
  try {
    return { result: fn(), warns };
  } finally {
    console.warn = real;
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

test('core: a second addScene on a live canvas returns the first handle, warns once, builds no layer', async () => {
  const wall = await createInline3D({ lazy: false, autoChrome: false });
  const canvas = makeCanvas();
  created.length = 0;
  const first = wall.addScene(canvas, () => {});
  const { result: second, warns } = captureWarnings(() => [wall.addScene(canvas, () => {}), wall.addScene(canvas, () => {})]);
  assert.equal(second[0], first);
  assert.equal(second[1], first);
  assert.equal(created.length, 1, 'no second layer');
  assert.equal(created[0].closed, undefined, 'the first layer was not closed and rebuilt');
  assert.equal(warns.length, 1, 'once per canvas');
  assert.match(warns[0], /addScene\(\) on a canvas that is already registered .*by addScene\(\), not yet removed/);
  wall.close();
});

test('core: across methods (addImage, then addVideo) — the live image handle comes back', async () => {
  const wall = await createInline3D({ lazy: false, autoChrome: false });
  const canvas = makeCanvas();
  const img = wall.addImage(canvas, makeCanvas());
  const { result, warns } = captureWarnings(() => wall.addVideo(canvas, { readyState: 0 }));
  assert.equal(result, img);
  assert.match(warns[0], /^\[inline3d\] addVideo\(\) .*by addImage\(\)/);
  wall.close();
});

test('core: after remove() the canvas registers again, silently, as a new window', async () => {
  const wall = await createInline3D({ lazy: false, autoChrome: false });
  const canvas = makeCanvas();
  const a = wall.addScene(canvas, () => {});
  a.remove();
  const { result: b, warns } = captureWarnings(() => wall.addScene(canvas, () => {}));
  assert.notEqual(b, a);
  assert.equal(warns.length, 0);
  wall.close();
});

test('core: the guard is per wall — a closed wall does not block a new one', async () => {
  const w1 = await createInline3D({ lazy: false, autoChrome: false });
  const canvas = makeCanvas();
  w1.addScene(canvas, () => {});
  w1.close();
  const w2 = await createInline3D({ lazy: false, autoChrome: false });
  const { warns } = captureWarnings(() => w2.addScene(canvas, () => {}));
  assert.equal(warns.length, 0);
  w2.close();
});

test('./splat (playcanvas): a second addSplat returns the first handle; a core add*() on it does too', async () => {
  const wall = await createInline3D({ lazy: false, autoChrome: false });
  const canvas = makeViewerCanvas(320, 180);
  const pc = { createGraphicsDevice: () => new Promise(() => {}) }; // the engine never arrives
  const first = addSplat(wall, canvas, 'a.sog', { playcanvas: pc });
  const { result, warns } = captureWarnings(() => addSplat(wall, canvas, 'b.sog', { playcanvas: pc }));
  assert.equal(result, first);
  assert.match(warns[0], /addSplat\(\) .*by addSplat\(\), not yet removed/);
  // Its own core window goes through (the entry's claim), and is the canvas's one layer.
  const { warns: w2 } = await (async () => {
    const real = console.warn;
    const ws = [];
    console.warn = (...a) => ws.push(a.map(String).join(' '));
    try {
      await flush();
      await flush();
    } finally {
      console.warn = real;
    }
    return { warns: ws };
  })();
  assert.equal(w2.filter((w) => /already registered/.test(w)).length, 0, 'the subpath’s own addScene was let through');
  assert.equal(wall._windows.has(canvas), true);
  assert.equal(captureWarnings(() => wall.addScene(canvas, () => {})).result, first, 'the page-facing handle, not the core tile');
  // remove() releases the canvas.
  first.remove();
  await flush();
  const { result: again, warns: w3 } = captureWarnings(() => addSplat(wall, canvas, 'c.sog', { playcanvas: pc }));
  assert.notEqual(again, first);
  assert.equal(w3.filter((w) => /already registered/.test(w)).length, 0);
  again.remove();
  await flush();
  wall.close();
  void dom;
});

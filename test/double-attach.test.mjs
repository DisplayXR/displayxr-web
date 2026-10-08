// Double-attach detection (1.38): add*() on a canvas that is still registered on the same wall
// WARNS once per canvas, naming the method and the live registration, and then proceeds exactly
// as before — the layer is closed and rebuilt, the call returns its own new handle. A warning
// only, so no page changes behavior. Core methods and the ./splat entry (engine:'playcanvas',
// whose renderer exists before its core window, which is why the check also sits at the entry).

import test from 'node:test';
import assert from 'node:assert/strict';

import { installDom, makeCanvas as makeViewerCanvas } from './stubs.mjs';

installDom();

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

/** Run fn (sync or async) with console.warn captured; only the double-attach warnings are kept. */
async function warnsOf(fn) {
  const real = console.warn;
  const warns = [];
  console.warn = (...a) => warns.push(a.map(String).join(' '));
  try {
    const result = await fn();
    return { result, warns: warns.filter((w) => /already registered/.test(w)) };
  } finally {
    console.warn = real;
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const flushFirstWoven = (h) => Promise.race([h.firstWoven, flush().then(() => 'pending')]);

test('core: a second addScene on a live canvas warns once, then rebuilds the layer and returns a NEW handle', async () => {
  const wall = await createInline3D({ lazy: false, autoChrome: false });
  const canvas = makeCanvas();
  created.length = 0;
  const first = wall.addScene(canvas, () => {});
  const { result: [second, third], warns } = await warnsOf(() => [wall.addScene(canvas, () => {}), wall.addScene(canvas, () => {})]);
  assert.notEqual(second, first, 'its own new handle, as before');
  assert.notEqual(third, second);
  assert.equal(created.length, 3, 'a new layer per call, as before');
  assert.equal(created[0].closed, true, 'the first layer was closed and rebuilt, as before');
  assert.equal(created[1].closed, true);
  assert.equal((await flushFirstWoven(first)).reason, 'removed', 'the first window is removed, as before');
  assert.equal(warns.length, 1, 'once per canvas');
  assert.match(warns[0], /^\[inline3d\] addScene\(\) on a canvas that is already registered .*\(by addScene\(\), not yet removed\)/);
  assert.match(warns[0], /rebuilding the canvas's layer \(a fresh 0\.4-1\.2 s identity gap\) or putting a second renderer/);
  assert.match(warns[0], /handle\.remove\(\)/);
  wall.close();
});

test('core: across methods (addImage, then addVideo) — warned with both names, the video window replaces it', async () => {
  const wall = await createInline3D({ lazy: false, autoChrome: false });
  const canvas = makeCanvas();
  const img = wall.addImage(canvas, makeCanvas());
  const { result: vid, warns } = await warnsOf(() => wall.addVideo(canvas, { readyState: 0 }));
  assert.notEqual(vid, img);
  assert.equal(wall._windows.get(canvas).kind, 'video');
  assert.equal(warns.length, 1);
  assert.match(warns[0], /^\[inline3d\] addVideo\(\) .*by addImage\(\)/);
  wall.close();
});

test('core: after remove() the canvas registers again, silently', async () => {
  const wall = await createInline3D({ lazy: false, autoChrome: false });
  const canvas = makeCanvas();
  wall.addScene(canvas, () => {}).remove();
  const { warns } = await warnsOf(() => wall.addScene(canvas, () => {}));
  assert.equal(warns.length, 0);
  wall.close();
});

test('core: the detection is per wall — a closed wall does not warn on a new one', async () => {
  const w1 = await createInline3D({ lazy: false, autoChrome: false });
  const canvas = makeCanvas();
  w1.addScene(canvas, () => {});
  w1.close();
  const w2 = await createInline3D({ lazy: false, autoChrome: false });
  const { warns } = await warnsOf(() => w2.addScene(canvas, () => {}));
  assert.equal(warns.length, 0);
  w2.close();
});

test('./splat (playcanvas): a second addSplat during the first one’s load warns once and attaches its own handle', async () => {
  const wall = await createInline3D({ lazy: false, autoChrome: false });
  const canvas = makeViewerCanvas(320, 180);
  const pc = { createGraphicsDevice: () => new Promise(() => {}) }; // the engine never arrives
  const { result, warns } = await warnsOf(async () => {
    const first = addSplat(wall, canvas, 'a.sog', { playcanvas: pc });
    // Caught at the entry, before either core window exists.
    assert.equal(wall._windows.has(canvas), false);
    const second = addSplat(wall, canvas, 'b.sog', { playcanvas: pc });
    await flush();
    await flush();
    return { first, second };
  });
  assert.notEqual(result.second, result.first, 'a new handle, as before');
  assert.equal(warns.length, 1, 'once per canvas, including both subpaths’ own addScene calls');
  assert.match(warns[0], /addSplat\(\) .*by addSplat\(\), not yet removed/);
  assert.equal(wall._windows.has(canvas), true);
  // remove() releases the claim: a later addSplat on the removed canvas is silent.
  result.first.remove();
  result.second.remove();
  await flush();
  const wall2 = await createInline3D({ lazy: false, autoChrome: false });
  const c2 = makeViewerCanvas(320, 180);
  const { warns: w3 } = await warnsOf(async () => {
    const a = addSplat(wall2, c2, 'a.sog', { playcanvas: pc });
    a.remove();
    await flush();
    addSplat(wall2, c2, 'c.sog', { playcanvas: pc }).remove();
    await flush();
  });
  assert.equal(w3.length, 0);
  wall.close();
  wall2.close();
});

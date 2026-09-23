// Tests for `handle.firstWoven` / `onFirstWoven` — the SDK's "safe to reveal this canvas" signal
// (web#36 follow-up, docs/authoring-inline-3d.md § Woven canvas rules).
//
// What is pinned is the CONTRACT a page releases its poster on, not pixels:
//   - it settles `woven: true` only once the window's CURRENT layer has carried a real stereo
//     frame AND has existed for the hold — never on layer construction alone, never on a mono
//     (short view list) frame, never on a frame whose onFrame threw;
//   - it settles exactly once, never rejects, and settles `woven: false` on every path that means
//     "this window will not weave", so a poster can never be stranded;
//   - `confirmed` is false: no browser reports joins, and the SDK must not pretend one did.
//
// Recording stubs and an injected clock (the SDK reads `performance.now()` through the global on
// every call), no jsdom — same approach as teardown-mono.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';

let clock = 0;
Object.defineProperty(globalThis, 'performance', {
  value: { now: () => clock },
  configurable: true,
  writable: true,
});

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
    getBoundingClientRect: () => ({ x: 0, y: 0, width: w, height: h, right: w, bottom: h, left: 0, top: 0 }),
    getContext: () => ctx,
  };
}

function installEnv({ throwOnConstruct = false } = {}) {
  const created = [];
  class FakeDisplayLayer {
    constructor(session, canvas) {
      if (throwOnConstruct) throw new TypeError('refused');
      this.canvas = canvas;
      created.push(this);
    }
    getViewport() {
      return { x: 0, y: 0, width: 150, height: 150 };
    }
    close() {
      this.closed = true;
    }
  }
  const listeners = new Map();
  let frameCb = null;
  const session = {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    requestReferenceSpace: async () => ({}),
    requestAnimationFrame(cb) {
      frameCb = cb;
      return 1;
    },
    end() {},
  };
  Object.defineProperty(globalThis, 'navigator', {
    value: { xr: { requestSession: async () => session } },
    configurable: true,
    writable: true,
  });
  globalThis.window = { XRDisplayLayer: FakeDisplayLayer, devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} };
  globalThis.XRDisplayLayer = FakeDisplayLayer;
  globalThis.document = undefined;
  globalThis.IntersectionObserver = undefined;
  const images = [];
  globalThis.Image = class {
    constructor() {
      this.naturalWidth = 800;
      this.naturalHeight = 200;
      images.push(this);
    }
  };
  return {
    created,
    images,
    fire(type) {
      for (const fn of listeners.get(type) ?? []) fn({ type });
    },
    /** Run the armed session frame with `n` views (2 = stereo, 1 = the load fallback, 0 = none). */
    runFrame(n = 2) {
      const cb = frameCb;
      frameCb = null;
      assert.ok(cb, 'the manager should have a session frame armed');
      const views = [{ eye: 'left' }, { eye: 'right' }].slice(0, n);
      cb(clock, { getViewerPose: () => (n ? { views } : null) });
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** Settled value, or 'pending' — without waiting for it. */
async function peek(p) {
  const PENDING = Symbol('pending');
  const v = await Promise.race([p, flush().then(() => PENDING)]);
  return v === PENDING ? 'pending' : v;
}

async function quiet(fn) {
  const w = console.warn;
  const d = console.debug;
  console.warn = () => {};
  console.debug = () => {};
  try {
    return await fn();
  } finally {
    console.warn = w;
    console.debug = d;
  }
}

installEnv();
const { createInline3D } = await import('../js/inline3d.js');
const newWall = () => createInline3D({ lazy: false, autoChrome: false });

test('scene: layer construction alone is NOT woven — it waits for a stereo frame AND the hold', async () => {
  clock = 1000;
  const env = installEnv();
  const wall = await newWall();
  const h = wall.addScene(makeCanvas(), () => {});
  assert.equal(env.created.length, 1, 'non-lazy: the layer is built inside addScene');
  assert.equal(await peek(h.firstWoven), 'pending', 'a constructed layer is step 5, not the join');

  env.runFrame(2); // stereo frame at t=1000, but the layer is 0 ms old
  assert.equal(await peek(h.firstWoven), 'pending', 'released before the hold — the raw-SBS window');

  clock = 1000 + 1199;
  env.runFrame(2);
  assert.equal(await peek(h.firstWoven), 'pending', 'default hold is 1200 ms');

  clock = 1000 + 1200;
  env.runFrame(2);
  const r = await peek(h.firstWoven);
  assert.deepEqual({ ...r }, { woven: true, confirmed: false, reason: 'hold-elapsed', ms: 1200 });
  wall.close();
});

test('scene: mono (short view list) and missing-pose frames never count as stereo', async () => {
  clock = 0;
  const env = installEnv();
  const wall = await newWall();
  const h = wall.addScene(makeCanvas(), () => {}, { firstWovenHoldMs: 0 });
  await quiet(() => {
    env.runFrame(1);
    env.runFrame(0);
    env.runFrame(1);
  });
  assert.equal(await peek(h.firstWoven), 'pending');
  assert.deepEqual(h.stats(), { frames: 2, monoFrames: 2 });
  env.runFrame(2);
  assert.equal((await peek(h.firstWoven)).woven, true);
  wall.close();
});

test('scene: a frame whose onFrame threw is not a stereo frame', async () => {
  clock = 0;
  const env = installEnv();
  const wall = await newWall();
  let fail = true;
  const h = wall.addScene(
    makeCanvas(),
    () => {
      if (fail) throw new Error('texture 404');
    },
    { firstWovenHoldMs: 0 }
  );
  await quiet(() => env.runFrame(2));
  assert.equal(await peek(h.firstWoven), 'pending');
  fail = false;
  env.runFrame(2);
  assert.equal((await peek(h.firstWoven)).woven, true);
  wall.close();
});

test('image: pending until the source has loaded and been painted side-by-side', async () => {
  clock = 0;
  const env = installEnv();
  const wall = await newWall();
  const h = wall.addImage(makeCanvas(), 'slow-sbs.png', { firstWovenHoldMs: 0 });
  await flush();
  env.runFrame(2);
  assert.equal(await peek(h.firstWoven), 'pending', 'an empty SBS buffer is nothing to reveal');
  env.images[0].onload();
  await flush();
  env.runFrame(2);
  assert.equal((await peek(h.firstWoven)).woven, true);
  wall.close();
});

test('lazy: a layer that closes before settling restarts the hold on its next layer', async () => {
  clock = 0;
  const env = installEnv();
  const wall = await newWall();
  const canvas = makeCanvas();
  const h = wall.addScene(canvas, () => {}, { firstWovenHoldMs: 100 });
  const win = wall._windows.get(canvas);
  env.runFrame(2);
  clock = 50;
  wall._deactivate(win); // scrolled away half-way through the hold
  clock = 60;
  wall._activate(win); // back: a NEW layer, fresh to the compositor
  env.runFrame(2);
  clock = 120; // 120 ms after the first layer, only 60 ms after this one
  env.runFrame(2);
  assert.equal(await peek(h.firstWoven), 'pending', 'time spent on a closed layer was credited');
  clock = 160;
  env.runFrame(2);
  assert.equal((await peek(h.firstWoven)).woven, true);
  wall.close();
});

test('a layer that cannot be built settles woven:false AFTER onLayerLost ran', async () => {
  clock = 0;
  installEnv({ throwOnConstruct: true });
  const order = [];
  const { wall, h } = await quiet(async () => {
    const wall = await newWall();
    const h = wall.addScene(makeCanvas(), () => {}, { onLayerLost: () => order.push('lost') });
    h.onFirstWoven((r) => order.push(r.reason));
    return { wall, h };
  });
  const r = await h.firstWoven;
  await flush();
  assert.equal(r.woven, false);
  assert.equal(r.reason, 'layer-failed');
  assert.deepEqual(order, ['lost', 'layer-failed'], 'the poster must come down onto an already-flat canvas');
  wall.close();
});

test('session end and remove() settle woven:false — a poster is never stranded', async () => {
  clock = 0;
  const env = installEnv();
  const wall = await newWall();
  const a = wall.addScene(makeCanvas(), () => {});
  const b = wall.addScene(makeCanvas(), () => {});
  b.remove();
  assert.equal((await b.firstWoven).reason, 'removed');
  env.fire('end');
  const r = await a.firstWoven;
  assert.equal(r.woven, false);
  assert.equal(r.reason, 'session-ended');
});

test('settles exactly once: a woven window stays woven through teardown; callbacks fire once', async () => {
  clock = 0;
  const env = installEnv();
  const wall = await newWall();
  const h = wall.addScene(makeCanvas(), () => {}, { firstWovenHoldMs: 0 });
  let calls = 0;
  let droppedCalls = 0;
  h.onFirstWoven(() => calls++);
  const off = h.onFirstWoven(() => droppedCalls++);
  off();
  env.runFrame(2);
  env.runFrame(2);
  const first = await h.firstWoven;
  env.fire('end');
  await flush();
  assert.equal(await h.firstWoven, first, 'the promise is one-shot; teardown must not re-settle it');
  assert.equal(first.woven, true);
  assert.equal(calls, 1);
  assert.equal(droppedCalls, 0, 'unsubscribe before settling must suppress the callback');
  // A late subscriber still hears it, asynchronously.
  let late = null;
  h.onFirstWoven((r) => (late = r));
  assert.equal(late, null, 'must not call back synchronously');
  await flush();
  assert.equal(late, first);
});

test('a bad firstWovenHoldMs falls back to the default rather than 0', async () => {
  clock = 0;
  const env = installEnv();
  const wall = await newWall();
  const h = wall.addScene(makeCanvas(), () => {}, { firstWovenHoldMs: -5 });
  env.runFrame(2);
  assert.equal(await peek(h.firstWoven), 'pending');
  clock = 1200;
  env.runFrame(2);
  assert.equal((await peek(h.firstWoven)).woven, true);
  wall.close();
});

test('no inline-3D session: createInline3D says unsupported and there is nothing to fire', async () => {
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
  globalThis.window = { devicePixelRatio: 1 };
  globalThis.XRDisplayLayer = undefined;
  const wall = await createInline3D();
  assert.equal(wall.supported, false);
  assert.equal(typeof wall.addScene, 'undefined', 'the fallback path has no windows, so no signal');
});

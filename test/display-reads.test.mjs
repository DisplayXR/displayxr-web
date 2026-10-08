// Tests for the display reads waiting on a layer's FIRST FRAME: getDisplayInfo(),
// getRenderingModes() and requestRenderingMode() all answer from the browser's weave session,
// which only exists once the layer has delivered a frame. Before that the browser answers null /
// [] / false, and null is documented as "no glasses-free display" — so a page asking right after
// add*() was told there is no display (found by the samples panel test, web#151). What is pinned:
//   - a call made before the first frame waits, and is asked only once the layer has framed: the
//     first stereo frame, or (where the browser reports wovenState) the first non-'pending' read —
//     no 1200 ms hold either way;
//   - a layer that never frames still answers, at the first-woven cap (4 holds from the layer's
//     construction), with whatever the layer says then (null / []: a real absence);
//   - no session, no layer, a failed layer, a removed window: settles at once, as before;
//   - a call made after the first frame goes straight through, no deferral.
//
// Same recording-stub approach as woven-state.test.mjs (no jsdom, injected clock).

import test from 'node:test';
import assert from 'node:assert/strict';

let clock = 0;
Object.defineProperty(globalThis, 'performance', {
  value: { now: () => clock },
  configurable: true,
  writable: true,
});

const INFO = Object.freeze({
  displayWidthMeters: 0.6,
  displayHeightMeters: 0.34,
  displayPixelWidth: 3840,
  displayPixelHeight: 2160,
  recommendedViewScaleX: 0.5,
  recommendedViewScaleY: 1,
});
const MODES = Object.freeze([
  Object.freeze({ modeIndex: 0, name: '2D', viewCount: 1, isActive: false, isRequestable: true }),
  Object.freeze({ modeIndex: 1, name: '3D', viewCount: 2, isActive: true, isRequestable: true }),
]);

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
    getBoundingClientRect() {
      return { x: 0, y: 0, left: 0, top: 0, width: this.clientWidth, height: this.clientHeight, right: this.clientWidth, bottom: this.clientHeight };
    },
    getContext: () => ctx,
  };
}

/**
 * A layer that behaves as the browser does: until it has a weave session (`answers`, which the
 * test flips when the layer "delivers" its first frame) getDisplayInfo is null, getRenderingModes
 * is [] and requestRenderingMode is false. `report: true` adds wovenState; `failCtor` throws.
 */
function installEnv({ report = false, failCtor = false } = {}) {
  const created = [];
  class FakeDisplayLayer {
    constructor(session, canvas) {
      if (failCtor) throw new Error('refused');
      this.canvas = canvas;
      this._state = 'pending';
      this.answers = false;
      this.calls = [];
      created.push(this);
    }
    getViewport() {
      return { x: 0, y: 0, width: 150, height: 150 };
    }
    close() {
      this.closed = true;
    }
  }
  const P = FakeDisplayLayer.prototype;
  P.getDisplayInfo = async function () {
    this.calls.push(['getDisplayInfo', this.answers]);
    return this.answers ? INFO : null;
  };
  P.getRenderingModes = async function () {
    this.calls.push(['getRenderingModes', this.answers]);
    return this.answers ? MODES.map((m) => ({ ...m })) : [];
  };
  P.requestRenderingMode = async function (i) {
    this.calls.push(['requestRenderingMode', this.answers, i]);
    return this.answers;
  };
  if (report) {
    Object.defineProperty(P, 'wovenState', { get() { return this._state; }, configurable: true });
    Object.defineProperty(P, 'withheldReason', { get() { return null; }, configurable: true });
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
  return {
    created,
    get layer() {
      return created[created.length - 1];
    },
    /** The browser now has a weave session for the latest layer: the methods answer for real. */
    goLive() {
      this.layer.answers = true;
    },
    report(state) {
      this.layer._state = state;
    },
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
async function peek(p) {
  const PENDING = Symbol('pending');
  const v = await Promise.race([p, flush().then(() => PENDING)]);
  return v === PENDING ? 'pending' : v;
}

installEnv();
const { createInline3D } = await import('../js/inline3d.js');
const newWall = (opts = {}) => createInline3D({ lazy: false, autoChrome: false, modeSwitch: { enabled: false }, ...opts });

test('a read made right after add*() waits for the first stereo frame, then gets the real answer', async () => {
  clock = 0;
  const env = installEnv();
  const wall = await newWall();
  const h = wall.addScene(makeCanvas(), () => {});
  const info = h.getDisplayInfo();
  const modes = h.getRenderingModes();
  const wallInfo = wall.getDisplayInfo();
  const req = h.requestRenderingMode(1);
  assert.equal(await peek(info), 'pending', 'not answered null while the layer has not framed');
  assert.equal(await peek(modes), 'pending');
  assert.equal(await peek(wallInfo), 'pending', 'the wall-level read waits too');
  assert.equal(await peek(req), 'pending', 'requestRenderingMode has the same early "false" shape');
  assert.deepEqual(env.layer.calls, [], 'the layer is not even asked before it has framed');
  env.runFrame(1); // a mono (load-fallback) frame is not the first stereo frame
  assert.equal(await peek(info), 'pending');
  clock = 16; // the first stereo frame: no hold
  env.goLive();
  env.runFrame(2);
  assert.deepEqual(await info, INFO);
  assert.deepEqual(await modes, MODES);
  assert.deepEqual(await wallInfo, INFO);
  assert.equal(await req, true, 'forwarded once the layer had a session to forward to');
  assert.ok(env.layer.calls.every(([, live]) => live), 'every call reached a layer that answers');
  wall.close();
});

test('with wovenState: released by the first non-pending read, not by a stereo frame while pending', async () => {
  clock = 0;
  const env = installEnv({ report: true });
  const wall = await newWall();
  const h = wall.addScene(makeCanvas(), () => {});
  const info = h.getDisplayInfo();
  env.runFrame(2);
  assert.equal(await peek(info), 'pending', "a stereo frame the browser still calls 'pending' does not release");
  clock = 50;
  env.goLive();
  env.report('withheld'); // the browser has seen the layer (withheld is not pending)
  env.runFrame(2);
  assert.deepEqual(await info, INFO);
  wall.close();
});

test('a layer that never frames: the read resolves null / [] at the first-woven cap, a real absence', async () => {
  clock = 0;
  const env = installEnv();
  const wall = await newWall();
  const h = wall.addScene(makeCanvas(), () => {});
  const info = h.getDisplayInfo();
  const modes = h.getRenderingModes();
  clock = 4799; // 4 x the 1200 ms hold, from the layer's construction
  env.runFrame(0);
  assert.equal(await peek(info), 'pending');
  clock = 4800;
  env.runFrame(0);
  assert.equal(await info, null, "the layer's own null, asked at the cap");
  assert.deepEqual(await modes, []);
  // Once capped, a later read on the same layer is asked at once.
  assert.equal(await peek(h.getDisplayInfo()), null);
  wall.close();
});

test('the cap follows firstWovenHoldMs (four holds), never under four default holds', async () => {
  clock = 0;
  const env = installEnv();
  const wall = await newWall();
  const long = wall.addScene(makeCanvas(), () => {}, { firstWovenHoldMs: 2000 });
  const short = wall.addScene(makeCanvas(), () => {}, { firstWovenHoldMs: 0 });
  const a = long.getDisplayInfo();
  const b = short.getDisplayInfo();
  clock = 4800;
  env.runFrame(0);
  assert.equal(await peek(a), 'pending', 'a 2000 ms hold caps at 8000 ms');
  assert.equal(await b, null, 'firstWovenHoldMs: 0 still waits four default holds, not zero');
  clock = 8000;
  env.runFrame(0);
  assert.equal(await a, null);
  wall.close();
});

test('a read made after the first frame goes straight through, no deferral', async () => {
  clock = 0;
  const env = installEnv();
  const wall = await newWall();
  const h = wall.addScene(makeCanvas(), () => {});
  env.goLive();
  env.runFrame(2);
  await flush();
  const before = env.layer.calls.length;
  const info = h.getDisplayInfo();
  assert.equal(env.layer.calls.length, before + 1, 'asked synchronously, in the same call');
  assert.deepEqual(await info, INFO);
  wall.close();
});

test('no session (unsupported browser): nothing to wait on, the unsupported shape at once', async () => {
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
  globalThis.window = { devicePixelRatio: 1 };
  globalThis.XRDisplayLayer = undefined;
  const wall = await createInline3D();
  assert.equal(wall.supported, false);
  assert.equal(typeof wall.getDisplayInfo, 'undefined', 'no manager, so no read to defer');
});

// (No layer at all — a lazy tile off screen — rejects at once exactly as before; pinned in
// test/display-modes.test.mjs.)
test('a window whose layer failed: settles at once, as before', async () => {
  clock = 0;
  installEnv({ failCtor: true });
  const warn = console.warn;
  console.warn = () => {};
  try {
    const wall = await newWall();
    const f = wall.addScene(makeCanvas(), () => {});
    await assert.rejects(() => f.getDisplayInfo(), /live weave layer/);
    wall.close();
  } finally {
    console.warn = warn;
  }
});

test('a window removed, or a session ended, while a read waits: the read settles at once', async () => {
  clock = 0;
  installEnv();
  const wall = await newWall();
  const h = wall.addScene(makeCanvas(), () => {});
  const p = h.getDisplayInfo().catch((e) => e);
  assert.equal(await peek(p), 'pending');
  h.remove();
  assert.match(String((await peek(p)).message), /live weave layer/);

  const h2 = wall.addScene(makeCanvas(), () => {});
  const q = h2.getRenderingModes().catch((e) => e);
  assert.equal(await peek(q), 'pending');
  wall.close();
  assert.match(String((await peek(q)).message), /live weave layer/);
});

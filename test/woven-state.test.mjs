// Tests for firstWoven / rewoven on the browser's own join report, `XRDisplayLayer.wovenState`
// (DisplayXR Browser PR #258; Windows, feature-flagged). What is pinned:
//   - feature detection is `'wovenState' in XRDisplayLayer.prototype`; without it the hold path
//     runs exactly as before (confirmed:false, 'hold-elapsed');
//   - with it, firstWoven settles confirmed:true, reason 'woven', on the first 'woven' read once a
//     stereo frame is drawn — no hold;
//   - rewoven never settles on a stale 'woven' from the old rect: it needs a 'withheld'/'pending'
//     read after the call, or WOVEN_STATE_LAG_FRAMES frames after a box change seen after the
//     call, or (no such change) WOVEN_STATE_LAG_FRAMES frames after the call — never a hold, and
//     never on the frame of the call;
//   - the cap still releases a layer stuck in 'withheld', as woven:false with the browser's reason;
//   - handle.wovenState / withheldReason read the report live, null where it is absent.
//
// Same recording-stub approach as first-woven.test.mjs (no jsdom, injected clock).

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
    getBoundingClientRect() {
      return { x: 0, y: 0, left: 0, top: 0, width: this.clientWidth, height: this.clientHeight, right: this.clientWidth, bottom: this.clientHeight };
    },
    getContext: () => ctx,
  };
}

/** `report: true` gives the layer class a `wovenState` / `withheldReason` pair, as the patched browser does. */
function installEnv({ report = true } = {}) {
  const created = [];
  class FakeDisplayLayer {
    constructor(session, canvas) {
      this.canvas = canvas;
      this._state = 'pending';
      this._reason = null;
      created.push(this);
    }
    getViewport() {
      return { x: 0, y: 0, width: 150, height: 150 };
    }
    close() {
      this.closed = true;
      this._state = 'pending';
    }
  }
  if (report) {
    Object.defineProperty(FakeDisplayLayer.prototype, 'wovenState', { get() { return this._state; }, configurable: true });
    Object.defineProperty(FakeDisplayLayer.prototype, 'withheldReason', { get() { return this._state === 'withheld' ? this._reason : null; }, configurable: true });
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
    /** Set what the browser reports for the (latest) layer from the next read on. */
    report(state, reason = null) {
      const l = created[created.length - 1];
      l._state = state;
      l._reason = reason;
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
const newWall = () => createInline3D({ lazy: false, autoChrome: false });

test('no wovenState on the prototype: the hold path, byte for byte (confirmed:false, hold-elapsed)', async () => {
  clock = 0;
  const env = installEnv({ report: false });
  const wall = await newWall();
  const h = wall.addScene(makeCanvas(), () => {});
  assert.equal(h.wovenState, null, 'absent attribute reads null, not a guess');
  assert.equal(h.withheldReason, null);
  env.runFrame(2);
  clock = 1199;
  env.runFrame(2);
  assert.equal(await peek(h.firstWoven), 'pending');
  clock = 1200;
  env.runFrame(2);
  assert.deepEqual({ ...(await peek(h.firstWoven)) }, { woven: true, confirmed: false, reason: 'hold-elapsed', ms: 1200 });
  wall.close();
});

test('firstWoven: pending → woven settles confirmed on the first woven read, no hold', async () => {
  clock = 0;
  const env = installEnv();
  const wall = await newWall();
  const h = wall.addScene(makeCanvas(), () => {});
  assert.equal(h.wovenState, 'pending');
  env.runFrame(2);
  clock = 16;
  env.runFrame(2);
  assert.equal(await peek(h.firstWoven), 'pending', 'still pending: nothing to settle on');
  clock = 50;
  env.report('woven');
  env.runFrame(2);
  assert.equal(h.wovenState, 'woven');
  assert.deepEqual({ ...(await peek(h.firstWoven)) }, { woven: true, confirmed: true, reason: 'woven', ms: 50 });
  wall.close();
});

test('firstWoven: a woven read needs a stereo frame drawn too', async () => {
  clock = 0;
  const env = installEnv();
  const wall = await newWall();
  const quietDebug = console.debug;
  console.debug = () => {};
  try {
    const h = wall.addScene(makeCanvas(), () => {});
    env.report('woven');
    env.runFrame(1); // a mono (load-fallback) frame: not a stereo frame
    assert.equal(await peek(h.firstWoven), 'pending');
    env.runFrame(2);
    assert.equal((await peek(h.firstWoven)).reason, 'woven');
  } finally {
    console.debug = quietDebug;
  }
  wall.close();
});

test('firstWoven: a layer withheld forever is released at the cap, woven:false with the browser reason', async () => {
  clock = 0;
  const env = installEnv();
  const wall = await newWall();
  const h = wall.addScene(makeCanvas(), () => {}, { firstWovenHoldMs: 100 });
  env.report('withheld', 'cross-pass:mono');
  assert.equal(h.withheldReason, 'cross-pass:mono');
  env.runFrame(2);
  clock = 4799; // the cap never drops below four DEFAULT holds, whatever firstWovenHoldMs says
  env.runFrame(2);
  assert.equal(await peek(h.firstWoven), 'pending');
  clock = 4800;
  env.runFrame(2);
  assert.deepEqual({ ...(await peek(h.firstWoven)) }, { woven: false, confirmed: true, reason: 'cross-pass:mono', ms: 4800 });
  // A confirmed withheld is a level, not a loss: rewoven() measures again rather than replaying it.
  const p = h.rewoven();
  assert.equal(await peek(p), 'pending', 'measured again, not answered with the withheld result');
  env.runFrame(2); // still withheld after the call: the gap
  env.report('woven');
  env.runFrame(2);
  assert.deepEqual({ ...(await peek(p)) }, { woven: true, confirmed: true, reason: 'woven', ms: 0 });
  wall.close();
});

async function wovenWall(env, canvas, opts = {}) {
  const wall = await newWall();
  const h = wall.addScene(canvas, () => {}, opts);
  env.report('woven');
  env.runFrame(2);
  assert.equal((await peek(h.firstWoven)).confirmed, true);
  return { wall, h };
}

test('rewoven: a stale woven from the old rect does not settle it; withheld → woven after the change does', async () => {
  clock = 0;
  const env = installEnv();
  const canvas = makeCanvas(400, 200);
  const { wall, h } = await wovenWall(env, canvas);
  clock = 1000;
  const p = h.rewoven();
  canvas.clientWidth = 800; // the rect changes; the browser still reports the OLD rect as woven
  canvas.clientHeight = 400;
  env.runFrame(2);
  assert.equal(await peek(p), 'pending', 'a woven read on the frame the change was seen is the old rect');
  clock = 1016;
  env.report('withheld', 'no-identity');
  env.runFrame(2);
  assert.equal(h.wovenState, 'withheld');
  assert.equal(h.withheldReason, 'no-identity');
  assert.equal(await peek(p), 'pending');
  clock = 1300;
  env.report('woven');
  env.runFrame(2);
  assert.deepEqual({ ...(await peek(p)) }, { woven: true, confirmed: true, reason: 'woven', ms: 300 });
  wall.close();
});

test('rewoven: a move rejoined without a gap settles three frames after the change, not before', async () => {
  clock = 0;
  const env = installEnv();
  const canvas = makeCanvas(400, 200);
  const { wall, h } = await wovenWall(env, canvas);
  const p = h.rewoven();
  canvas.clientWidth = 500;
  env.runFrame(2); // change seen (frame N)
  env.runFrame(2); // N+1
  env.runFrame(2); // N+2
  assert.equal(await peek(p), 'pending', 'the report can trail the join by up to three frames');
  env.runFrame(2); // N+3
  assert.equal((await peek(p)).reason, 'woven');
  wall.close();
});

test('rewoven: a woven read before the call does not count as the gap', async () => {
  clock = 0;
  const env = installEnv();
  const canvas = makeCanvas(400, 200);
  const { wall, h } = await wovenWall(env, canvas);
  env.report('withheld', 'no-join'); // a gap BEFORE the call
  env.runFrame(2);
  env.report('woven');
  env.runFrame(2);
  const p = h.rewoven();
  canvas.clientWidth = 640;
  env.runFrame(2);
  assert.equal(await peek(p), 'pending');
  wall.close();
});

test('rewoven: called after the move, steady woven reads settle three frames after the call, not after a hold', async () => {
  clock = 0;
  const env = installEnv();
  const canvas = makeCanvas(400, 200);
  const { wall, h } = await wovenWall(env, canvas);
  // The kiosk case: the page moves the canvas, a frame sees the new box (no rewoven pending
  // yet), THEN the page calls rewoven(). The browser never reads withheld.
  canvas.clientWidth = 640;
  clock = 100;
  env.runFrame(2);
  const p = h.rewoven(); // call frame C
  clock = 116;
  env.runFrame(2); // C+1
  clock = 133;
  env.runFrame(2); // C+2
  assert.equal(await peek(p), 'pending', 'a woven read under three frames after the call can still be the old rect');
  clock = 150;
  env.runFrame(2); // C+3
  assert.deepEqual({ ...(await peek(p)) }, { woven: true, confirmed: true, reason: 'woven', ms: 50 });
  wall.close();
});

test('rewoven: a stale woven read on the frame of the call does not settle it', async () => {
  clock = 0;
  const env = installEnv();
  const wall = await newWall();
  let p = null;
  let calls = 0;
  // rewoven() called from inside the frame callback: that frame's own read is not after the call.
  const h = wall.addScene(makeCanvas(), () => {
    if (++calls === 3) p = h.rewoven();
  });
  env.report('woven');
  env.runFrame(2); // frame 1: firstWoven
  assert.equal((await peek(h.firstWoven)).confirmed, true);
  env.runFrame(2); // frame 2
  clock = 100;
  env.runFrame(2); // frame 3: the call, then this frame's woven read
  assert.ok(p, 'the call was made in the frame callback');
  assert.equal(await peek(p), 'pending', 'never settled on the frame of the call');
  env.runFrame(2);
  env.runFrame(2);
  assert.equal(await peek(p), 'pending', 'nor two frames after it');
  clock = 150;
  env.runFrame(2);
  assert.deepEqual({ ...(await peek(p)) }, { woven: true, confirmed: true, reason: 'woven', ms: 50 });
  wall.close();
});

test('rewoven: a box change after the call still counts three frames from the change', async () => {
  clock = 0;
  const env = installEnv();
  const canvas = makeCanvas(400, 200);
  const { wall, h } = await wovenWall(env, canvas);
  const p = h.rewoven(); // call frame C
  env.runFrame(2); // C+1
  canvas.clientWidth = 520;
  env.runFrame(2); // C+2: change seen (frame N)
  env.runFrame(2); // C+3 = N+1: three frames after the call, but not after the change
  env.runFrame(2); // N+2
  assert.equal(await peek(p), 'pending', 'the change restarts the count; the call frame no longer rules');
  env.runFrame(2); // N+3
  assert.equal((await peek(p)).reason, 'woven');
  wall.close();
});

test('rewoven: withheld forever is capped, woven:false with withheldReason', async () => {
  clock = 0;
  const env = installEnv();
  const canvas = makeCanvas();
  const { wall, h } = await wovenWall(env, canvas);
  clock = 1000;
  const p = h.rewoven();
  canvas.clientWidth = 777;
  env.report('withheld', 'no-quad');
  for (clock = 1000; clock < 5800; clock += 100) env.runFrame(2);
  assert.equal(await peek(p), 'pending');
  clock = 5800;
  env.runFrame(2);
  assert.deepEqual({ ...(await peek(p)) }, { woven: false, confirmed: true, reason: 'no-quad', ms: 4800 });
  // Not terminal: the next call measures again.
  const q = h.rewoven();
  env.report('woven');
  env.runFrame(2);
  assert.equal(await peek(q), 'pending', 'a fresh call with no change waits three frames of woven reads');
  wall.close();
});

test('rewoven: removal still settles woven:false, unconfirmed (the terminal path is unchanged)', async () => {
  clock = 0;
  const env = installEnv();
  const { h } = await wovenWall(env, makeCanvas());
  const p = h.rewoven();
  h.remove();
  assert.deepEqual({ ...(await peek(p)) }, { woven: false, confirmed: false, reason: 'removed', ms: 0 });
  assert.equal(h.wovenState, 'pending', 'no live layer reads pending');
});

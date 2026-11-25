// The first woven frames of a page-sized scene store (1.59.0):
//   - every stereo frame, the SDK checks that each eye tile (getViewport) has the canvas box's
//     aspect, warns ONCE when it does not (a flat-shaped store = each eye shows half the scene),
//     and reports in one console.debug line how many stereo frames were wrong once it is right;
//   - it never resizes the store;
//   - firstWoven does not settle while the store is wrong, holds from when it became right, and
//     is capped ('store-capped') so a page that never fixes it is not left behind a cover;
//   - wall.displayInfo carries the last display read (and the last one this origin stored).
//
// Same stub approach as first-woven.test.mjs: recording fakes, an injected clock, no jsdom.

import test from 'node:test';
import assert from 'node:assert/strict';

let clock = 0;
Object.defineProperty(globalThis, 'performance', {
  value: { now: () => clock },
  configurable: true,
  writable: true,
});

let currentInfo = null; // what the fake layer's getDisplayInfo() answers (null = INFO)
const INFO = {
  displayWidthMeters: 0.6,
  displayHeightMeters: 0.34,
  displayPixelWidth: 7680,
  displayPixelHeight: 4320,
  recommendedViewScaleX: 0.5,
  recommendedViewScaleY: 0.5,
};

function makeCanvas(w = 400, h = 200) {
  return {
    style: {},
    width: 0,
    height: 0,
    clientWidth: w,
    clientHeight: h,
    parentElement: null,
    contains: () => false,
    getBoundingClientRect: () => ({ x: 0, y: 0, width: w, height: h, right: w, bottom: h, left: 0, top: 0 }),
    getContext: () => null,
  };
}

function installEnv({ report = false, displayModes = false, storage = null } = {}) {
  const created = [];
  class FakeDisplayLayer {
    constructor(session, canvas) {
      this.canvas = canvas;
      this.state = 'pending';
      created.push(this);
    }
    // What the browser does: split the store side by side.
    getViewport(view) {
      const w = Math.floor(this.canvas.width / 2);
      return { x: view.eye === 'right' ? w : 0, y: 0, width: w, height: this.canvas.height };
    }
    close() {
      this.closed = true;
    }
  }
  if (report) {
    Object.defineProperty(FakeDisplayLayer.prototype, 'wovenState', {
      get() {
        return this.state;
      },
      configurable: true,
    });
  }
  if (displayModes) {
    FakeDisplayLayer.prototype.getDisplayInfo = function () {
      return currentInfo || INFO;
    };
    FakeDisplayLayer.prototype.getRenderingModes = function () {
      return [{ index: 0, viewCount: 2 }];
    };
    FakeDisplayLayer.prototype.requestRenderingMode = function () {};
  }
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
  Object.defineProperty(globalThis, 'navigator', {
    value: { xr: { requestSession: async () => session } },
    configurable: true,
    writable: true,
  });
  globalThis.window = { XRDisplayLayer: FakeDisplayLayer, devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} };
  globalThis.XRDisplayLayer = FakeDisplayLayer;
  globalThis.document = undefined;
  globalThis.IntersectionObserver = undefined;
  globalThis.localStorage = storage ?? undefined;
  return {
    created,
    report(state) {
      for (const l of created) l.state = state;
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

/** Run fn with console.warn / console.debug recorded instead of printed. */
async function recording(fn) {
  const w = console.warn;
  const d = console.debug;
  const log = { warn: [], debug: [] };
  console.warn = (...a) => log.warn.push(a.map(String).join(' '));
  console.debug = (...a) => log.debug.push(a.map(String).join(' '));
  try {
    await fn(log);
  } finally {
    console.warn = w;
    console.debug = d;
  }
  return log;
}

installEnv();
const { createInline3D } = await import('../js/inline3d.js');
const newWall = () => createInline3D({ lazy: false, autoChrome: false });

test('a flat-shaped store while woven warns once, is never resized, and the fix is reported with a count', async () => {
  clock = 0;
  const env = installEnv();
  const wall = await newWall();
  const canvas = makeCanvas(400, 200);
  canvas.width = 400; // 1:1 to the box: still shaped for flat
  canvas.height = 200;
  wall.addScene(canvas, () => {}, { firstWovenHoldMs: 0 });
  const log = await recording(async () => {
    env.runFrame(2);
    env.runFrame(2);
    env.runFrame(2);
  });
  assert.equal(log.warn.length, 1, 'once, not per frame');
  assert.match(log.warn[0], /still shaped for FLAT, so each eye shows half the scene/);
  assert.match(log.warn[0], /400×200/);
  assert.deepEqual([canvas.width, canvas.height], [400, 200], 'the store is the page’s: never resized');

  canvas.width = 800; // the page resizes for side-by-side
  const log2 = await recording(async () => {
    env.runFrame(2);
    env.runFrame(2);
  });
  assert.equal(log2.warn.length, 0);
  assert.equal(log2.debug.length, 1, 'one line when it becomes right');
  assert.match(log2.debug[0], /3 stereo frame\(s\) so far were drawn into a wrong-shaped store/);
  wall.close();
});

test('a right-shaped store (rounding included) says nothing', async () => {
  clock = 0;
  const env = installEnv();
  const wall = await newWall();
  const canvas = makeCanvas(401, 200);
  canvas.width = 801; // eye 400×200 for a 401×200 box: rounding, not a wrong shape
  canvas.height = 200;
  wall.addScene(canvas, () => {}, { firstWovenHoldMs: 0 });
  const log = await recording(async () => env.runFrame(2));
  assert.equal(log.warn.length, 0);
  assert.equal(log.debug.length, 0);
  wall.close();
});

test('the SDK’s own renderers (bufferClamped) are not checked', async () => {
  clock = 0;
  const env = installEnv();
  const wall = await newWall();
  const canvas = makeCanvas(400, 200);
  canvas.width = 400;
  canvas.height = 200;
  const h = wall.addScene(canvas, () => {}, { firstWovenHoldMs: 0, bufferClamped: true });
  const log = await recording(async () => env.runFrame(2));
  assert.equal(log.warn.length, 0);
  assert.equal((await peek(h.firstWoven)).reason, 'hold-elapsed', 'not gated either');
  wall.close();
});

test('hold path: firstWoven waits while the store is wrong, then holds from when it became right', async () => {
  clock = 1000;
  const env = installEnv();
  const wall = await newWall();
  const canvas = makeCanvas(400, 200);
  canvas.width = 400;
  canvas.height = 200;
  const h = wall.addScene(canvas, () => {}, { firstWovenHoldMs: 100 });
  await recording(async () => {
    env.runFrame(2);
    clock = 1500; // past the hold, store still wrong
    env.runFrame(2);
  });
  assert.equal(await peek(h.firstWoven), 'pending', 'a wrong store is not safe to reveal');

  canvas.width = 800;
  await recording(async () => env.runFrame(2)); // right from t=1500
  assert.equal(await peek(h.firstWoven), 'pending', 'the hold restarts from the fix');
  clock = 1599;
  env.runFrame(2);
  assert.equal(await peek(h.firstWoven), 'pending');
  clock = 1600;
  env.runFrame(2);
  const r = await peek(h.firstWoven);
  assert.equal(r.woven, true);
  assert.equal(r.reason, 'hold-elapsed');
  wall.close();
});

test('hold path: a store that is never fixed settles woven, "store-capped", at the cap', async () => {
  clock = 0;
  const env = installEnv();
  const wall = await newWall();
  const canvas = makeCanvas(400, 200);
  canvas.width = 400;
  canvas.height = 200;
  const h = wall.addScene(canvas, () => {}, { firstWovenHoldMs: 100 });
  await recording(async () => {
    env.runFrame(2);
    clock = 4799; // cap = 4 × max(hold, the 1200 ms default)
    env.runFrame(2);
  });
  assert.equal(await peek(h.firstWoven), 'pending');
  await recording(async () => {
    clock = 4800;
    env.runFrame(2);
  });
  const r = await peek(h.firstWoven);
  assert.deepEqual({ woven: r.woven, reason: r.reason, confirmed: r.confirmed }, { woven: true, reason: 'store-capped', confirmed: false });
  wall.close();
});

test('wovenState path: a "woven" read does not settle while the store is wrong, nor until the report has caught up', async () => {
  clock = 0;
  const env = installEnv({ report: true });
  const wall = await newWall();
  const canvas = makeCanvas(400, 200);
  canvas.width = 400;
  canvas.height = 200;
  const h = wall.addScene(canvas, () => {});
  env.report('woven');
  await recording(async () => {
    env.runFrame(2);
    env.runFrame(2);
  });
  assert.equal(await peek(h.firstWoven), 'pending', 'woven, but woven wrong');
  canvas.width = 800;
  await recording(async () => env.runFrame(2)); // fixed this frame
  env.runFrame(2);
  env.runFrame(2);
  assert.equal(await peek(h.firstWoven), 'pending', 'the report trails the fix by a few frames');
  env.runFrame(2);
  const r = await peek(h.firstWoven);
  assert.deepEqual({ woven: r.woven, reason: r.reason, confirmed: r.confirmed }, { woven: true, reason: 'woven', confirmed: true });
  wall.close();
});

test('wovenState path: never fixed, the cap settles "store-capped"', async () => {
  clock = 0;
  const env = installEnv({ report: true });
  const wall = await newWall();
  const canvas = makeCanvas(400, 200);
  canvas.width = 400;
  canvas.height = 200;
  const h = wall.addScene(canvas, () => {});
  env.report('woven');
  await recording(async () => {
    env.runFrame(2);
    clock = 4800;
    env.runFrame(2);
  });
  const r = await peek(h.firstWoven);
  assert.deepEqual({ woven: r.woven, reason: r.reason }, { woven: true, reason: 'store-capped' });
  wall.close();
});

test('wall.displayInfo: null, then the SDK’s own first-layer read, stored for the next page on this origin', async () => {
  clock = 0;
  const store = new Map();
  const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
  const env = installEnv({ displayModes: true, storage });
  const wall = await newWall();
  assert.equal(wall.displayInfo, null, 'nothing read, nothing stored');
  const canvas = makeCanvas(400, 200);
  canvas.width = 800;
  canvas.height = 200;
  wall.addScene(canvas, () => {});
  env.runFrame(2); // the first frame releases the SDK's own read
  await flush();
  await flush();
  assert.equal(wall.displayInfo, INFO, 'the live answer, as read');
  wall.close();

  // The next page on this origin has it before any layer exists.
  installEnv({ displayModes: true, storage });
  const wall2 = await newWall();
  const cached = wall2.displayInfo;
  assert.equal(cached.cached, true);
  assert.equal(cached.recommendedViewScaleX, 0.5);
  assert.ok(Object.isFrozen(cached));
  wall2.close();
});

test('wall.displayInfo: blocked storage is not an error', async () => {
  const storage = {
    getItem() {
      throw new Error('SecurityError');
    },
    setItem() {
      throw new Error('SecurityError');
    },
  };
  const env = installEnv({ displayModes: true, storage });
  const wall = await newWall();
  assert.equal(wall.displayInfo, null);
  const canvas = makeCanvas(400, 200);
  canvas.width = 800;
  canvas.height = 200;
  wall.addScene(canvas, () => {});
  env.runFrame(2);
  await flush();
  await flush();
  assert.equal(wall.displayInfo, INFO);
  wall.close();
});

test('a display whose views halve the width only (viewScale 0.5 x 1): a box-shaped store is RIGHT, no warning', async () => {
  // The inline3d-tools checker's fake 2x1 panel (960x1080 per view on 1920x1080) found this: with
  // recommendedViewScaleX/Y = 0.5/1 the correct side-by-side store is exactly box-shaped.
  clock = 0;
  currentInfo = { ...INFO, recommendedViewScaleX: 0.5, recommendedViewScaleY: 1 };
  try {
    const env = installEnv({ displayModes: true });
    const wall = await newWall();
    const canvas = makeCanvas(640, 320);
    canvas.width = 640; // eye 320x320 x 2: what sceneBufferSize gives for this display
    canvas.height = 320;
    const h = wall.addScene(canvas, () => {}, { firstWovenHoldMs: 0 });
    const log = await recording(async () => {
      env.runFrame(2); // before the SDK's read: not judged
      await flush();
      await flush();
      env.runFrame(2);
      env.runFrame(2);
    });
    assert.equal(log.warn.filter((w) => /store is/.test(w)).length, 0, log.warn.join('\n'));
    assert.notEqual((await peek(h.firstWoven)).reason, 'store-capped');
    // ... and the same display still catches a store that IS wrong for it (twice too wide per eye).
    canvas.width = 1280;
    const log2 = await recording(async () => {
      env.runFrame(2);
    });
    assert.equal(log2.warn.length, 1);
    assert.match(log2.warn[0], /do not have the box aspect/);
    wall.close();
  } finally {
    currentInfo = null;
  }
});

test('a flat store on a 0.5 x 0.5 display is still caught once the display info is known', async () => {
  clock = 0;
  const env = installEnv({ displayModes: true });
  const wall = await newWall();
  const canvas = makeCanvas(400, 200);
  canvas.width = 400;
  canvas.height = 200;
  wall.addScene(canvas, () => {}, { firstWovenHoldMs: 0 });
  const log = await recording(async () => {
    env.runFrame(2);
    await flush();
    await flush();
    env.runFrame(2);
  });
  assert.equal(log.warn.length, 1);
  assert.match(log.warn[0], /still shaped for FLAT/);
  wall.close();
});

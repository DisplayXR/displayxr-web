// Tests for the display-mode surface — `inline3dDisplayModesSupported()`, the three
// pass-throughs, the `setStereoEnabled()` sugar, the AUTOMATIC 1-view rig collapse, the two
// re-emitted events, and the undock capability/fallback.
//
// Like the view-rig tests, the SDK's job here is PLUMBING, so what is worth pinning is not values
// but sequencing and ownership: that the capability probe demands all three methods, that a call
// with no live layer rejects instead of throwing, that the rig collapse is driven by the EVENT and
// never by the request (which is what makes a refused request a no-op), that the flattening is a
// COPY (a page's own descriptor is never written into, which is what makes the restore exact),
// that the latch survives a page driving `setViewRig` every frame and a lazy tile rebuilding its
// layer, and that `setStereoEnabled` is sugar over one mode request and nothing else. Hence
// recording stubs and no real browser.

import test from 'node:test';
import assert from 'node:assert/strict';

// ── environment ─────────────────────────────────────────────────────────────────────────

const DISPLAY_INFO = {
  displayWidthMeters: 0.6,
  displayHeightMeters: 0.34,
  displayPixelWidth: 3840,
  displayPixelHeight: 2160,
  recommendedViewScaleX: 0.5,
  recommendedViewScaleY: 1,
};

/**
 * A fresh mode list per environment, because `isActive` MOVES — the browser reports a switch by
 * changing which row is active and firing `renderingmodechange`, and the SDK reads the view count
 * back out of the list. A shared frozen constant would make the second test in a file see the
 * first one's panel.
 *
 * Mode 0 is the 1-view mode and it is REQUESTABLE: that is the shape this whole rework is about —
 * asking for it is how a page goes flat. Mode 2 needs four views and no browser can fill it.
 */
function makeModes() {
  return [
    {
      modeIndex: 0,
      name: '2D',
      viewCount: 1,
      viewScaleX: 1,
      viewScaleY: 1,
      tileColumns: 1,
      tileRows: 1,
      viewWidthPixels: 3840,
      viewHeightPixels: 2160,
      hardwareDisplay3D: false,
      isActive: false,
      isRequestable: true,
    },
    {
      modeIndex: 1,
      name: 'Side-by-side',
      viewCount: 2,
      viewScaleX: 0.5,
      viewScaleY: 1,
      tileColumns: 2,
      tileRows: 1,
      viewWidthPixels: 1920,
      viewHeightPixels: 2160,
      hardwareDisplay3D: true,
      isActive: true,
      isRequestable: true,
    },
    {
      modeIndex: 2,
      name: 'Quad',
      viewCount: 4,
      viewScaleX: 0.5,
      viewScaleY: 0.5,
      tileColumns: 2,
      tileRows: 2,
      viewWidthPixels: 1920,
      viewHeightPixels: 1080,
      hardwareDisplay3D: true,
      isActive: false,
      isRequestable: false, // the browser is fixed at 2 views
    },
  ];
}

/**
 * A recording XRDisplayLayer class.
 *   `displayModes:false` builds a browser that predates the API entirely.
 *   `partial:true`       builds one mid-implementation (two of the three methods) — the case the
 *                        all-three probe exists to refuse.
 *   `refuse`             mode indices `requestRenderingMode` rejects with NotSupportedError.
 *   `undock`             adds `undock()` + `getUndockCapabilities()` to the prototype.
 */
function makeLayerClass({
  viewRig = true,
  displayModes = true,
  partial = false,
  refuse = [],
  undock = false,
  undockCaps = { model: true, splat: false },
} = {}) {
  const created = [];
  const modes = makeModes();
  class FakeDisplayLayer {
    constructor(session, canvas, init) {
      this.session = session;
      this.canvas = canvas;
      this.init = init;
      this.rigs = [];
      this.modeRequests = [];
      this.undockRequests = [];
      this.closed = false;
      created.push(this);
    }
    getViewport() {
      return null;
    }
    close() {
      this.closed = true;
    }
  }
  const P = FakeDisplayLayer.prototype;
  if (viewRig) {
    P.setViewRig = function setViewRig(rig) {
      this.rigs.push(rig);
    };
  }
  if (displayModes) {
    P.getDisplayInfo = async function getDisplayInfo() {
      return DISPLAY_INFO;
    };
    P.getRenderingModes = async function getRenderingModes() {
      return modes;
    };
    if (!partial) {
      P.requestRenderingMode = function requestRenderingMode(i) {
        // The browser raises these SYNCHRONOUSLY — the SDK has to turn them into rejections.
        const mode = modes.find((m) => m.modeIndex === i);
        if (!mode) throw new TypeError('unknown modeIndex');
        if (mode.viewCount > 2) throw new TypeError('viewCount > 2');
        this.modeRequests.push(i);
        if (refuse.includes(i)) {
          const e = new Error('not forwardable');
          e.name = 'NotSupportedError';
          return Promise.reject(e);
        }
        return Promise.resolve();
      };
    }
  }
  if (undock) {
    P.getUndockCapabilities = async function getUndockCapabilities() {
      return undockCaps;
    };
    P.undock = function undockCall(init) {
      this.undockRequests.push(init);
      return new Promise(() => {}); // pending until the viewer exits
    };
  }
  return { FakeDisplayLayer, created, modes };
}

/** Install the globals createInline3D touches, and hand back the levers to drive them. */
function installEnv(opts = {}) {
  const { FakeDisplayLayer, created, modes } = makeLayerClass(opts);
  const observers = [];
  const listeners = new Map();
  const session = {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    requestReferenceSpace: async () => ({}),
    requestAnimationFrame: () => 1,
    end() {},
  };
  Object.defineProperty(globalThis, 'navigator', {
    value: { xr: { requestSession: async () => session } },
    configurable: true,
    writable: true,
  });
  globalThis.window = {
    XRDisplayLayer: FakeDisplayLayer,
    devicePixelRatio: 1,
    addEventListener() {},
    removeEventListener() {},
    setTimeout: (fn, ms) => setTimeout(fn, ms),
  };
  globalThis.XRDisplayLayer = FakeDisplayLayer;
  globalThis.document = undefined;
  globalThis.IntersectionObserver = class {
    constructor(cb) {
      this.cb = cb;
      this.targets = new Set();
      observers.push(this);
    }
    observe(t) {
      this.targets.add(t);
    }
    unobserve(t) {
      this.targets.delete(t);
    }
    disconnect() {
      this.targets.clear();
    }
  };
  return {
    session,
    created,
    modes,
    listenerCount: (type) => listeners.get(type)?.size ?? 0,
    fire(type, detail) {
      for (const fn of listeners.get(type) ?? []) fn({ type, detail });
    },
    /**
     * What the browser does when a mode actually goes active: the list moves, THEN the event
     * fires. Nothing in the SDK may act on a request before this.
     */
    goActive(i) {
      for (const m of modes) m.isActive = m.modeIndex === i;
      this.fire('renderingmodechange', { modeIndex: i });
    },
    intersect(el, isIntersecting) {
      for (const o of observers) o.cb([{ target: el, isIntersecting }]);
    },
  };
}

function makeCanvas() {
  return {
    style: {},
    width: 0,
    height: 0,
    clientWidth: 300,
    clientHeight: 150,
    parentElement: null,
    contains: () => false,
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 300, height: 150, right: 300, bottom: 150, left: 0, top: 0 }),
  };
}

/**
 * Let the SDK's own async work settle. Both the first mode read and the event handler are
 * `async` and deliberately unawaited by the caller (they run inside activation / dispatch), so a
 * test that asserts immediately after would be asserting on a half-applied state.
 */
const flush = () => new Promise((r) => setTimeout(r, 0));

/** Silence the once-only console.info notices so the test output stays readable. */
function quietInfo(fn) {
  const real = console.info;
  console.info = () => {};
  return Promise.resolve(fn()).finally(() => {
    console.info = real;
  });
}

installEnv();
const { createInline3D, inline3dDisplayModesSupported, inline3dUndockSupported, undockUrl } =
  await import('../js/inline3d.js');

const CAM_RIG = { type: 'camera', position: { x: 0, y: 0, z: 0 }, verticalFov: 0.8, ipdFactor: 2, parallaxFactor: 2 };

/** A live, non-lazy wall with one scene window whose first mode read has already landed. */
async function makeWall(env, opts = {}) {
  const wall = await createInline3D({ lazy: false, autoChrome: false });
  const canvas = makeCanvas();
  const handle = wall.addScene(canvas, () => {}, opts);
  await flush();
  return { wall, handle, canvas, layer: env.created[0] };
}

// ── 1. capability gating ────────────────────────────────────────────────────────────────

test('inline3dDisplayModesSupported is true when all three methods are on the prototype', () => {
  installEnv();
  assert.equal(inline3dDisplayModesSupported(), true);
});

test('inline3dDisplayModesSupported is false on a browser that predates the API', () => {
  installEnv({ displayModes: false });
  assert.equal(inline3dDisplayModesSupported(), false);
});

test('inline3dDisplayModesSupported demands ALL THREE — a partial browser is not supported', () => {
  installEnv({ partial: true });
  assert.equal(
    inline3dDisplayModesSupported(),
    false,
    'two of three would surface as "requestRenderingMode is not a function" inside a click handler'
  );
});

test('inline3dDisplayModesSupported is false with no XRDisplayLayer at all', () => {
  installEnv();
  globalThis.window.XRDisplayLayer = undefined;
  assert.equal(inline3dDisplayModesSupported(), false);
  installEnv();
});

// ── 2. the pass-throughs ────────────────────────────────────────────────────────────────

test('getDisplayInfo and getRenderingModes hand the runtime report through unreshaped', async () => {
  const env = installEnv();
  const { wall, handle } = await makeWall(env);
  assert.deepEqual(await handle.getDisplayInfo(), DISPLAY_INFO);
  assert.deepEqual(await handle.getRenderingModes(), env.modes);
  // The same names on the wall, because the panel is the document's, not a tile's.
  assert.deepEqual(await wall.getDisplayInfo(), DISPLAY_INFO);
  assert.deepEqual(await wall.getRenderingModes(), env.modes);
  wall.close();
});

test('requestRenderingMode forwards a 2-view mode', async () => {
  const env = installEnv();
  const { wall, handle, layer } = await makeWall(env);
  await handle.requestRenderingMode(1);
  assert.deepEqual(layer.modeRequests, [1]);
  wall.close();
});

test('requestRenderingMode forwards a ONE-view mode — that is how a page goes flat', async () => {
  const env = installEnv();
  const { wall, handle, layer } = await makeWall(env);
  await handle.requestRenderingMode(0);
  assert.deepEqual(layer.modeRequests, [0], 'viewCount 1 is requestable, not refused');
  wall.close();
});

test("the browser's SYNCHRONOUS TypeError for a >2-view mode arrives as a rejection", async () => {
  const env = installEnv();
  const { wall, handle } = await makeWall(env);
  // The point: one .catch() covers both failure shapes, so a page never needs a try/catch AND a
  // .catch() around the same call.
  await assert.rejects(() => handle.requestRenderingMode(2), TypeError);
  await assert.rejects(() => handle.requestRenderingMode(99), TypeError);
  wall.close();
});

test('a NotSupportedError from the browser propagates unchanged', async () => {
  const env = installEnv({ refuse: [0] });
  const { wall, handle } = await makeWall(env);
  await assert.rejects(() => handle.requestRenderingMode(0), { name: 'NotSupportedError' });
  wall.close();
});

test('a display-mode call on a browser without the API rejects with a clear Error, never throws', async () => {
  installEnv({ displayModes: false });
  const wall = await createInline3D({ lazy: false, autoChrome: false });
  const handle = wall.addScene(makeCanvas(), () => {});
  // Synchronously returning a promise (rather than throwing) is the contract: these sit behind
  // click handlers.
  const p = handle.getDisplayInfo();
  assert.ok(p instanceof Promise);
  await assert.rejects(() => p, /inline3dDisplayModesSupported/);
  wall.close();
});

test('a display-mode call with no live layer rejects and says WHY (lazy tile off screen)', async () => {
  const env = installEnv();
  const wall = await createInline3D({ lazy: true, autoChrome: false });
  const canvas = makeCanvas();
  const handle = wall.addScene(canvas, () => {});
  assert.equal(env.created.length, 0, 'a lazy tile has no layer until it intersects');
  await assert.rejects(() => handle.getRenderingModes(), /live weave layer/);
  await assert.rejects(() => wall.getDisplayInfo(), /live weave layer/);
  wall.close();
});

// ── 3. the AUTOMATIC rig collapse ───────────────────────────────────────────────────────
//
// The whole invariant of this rework: the rig follows the ACTIVE MODE, reported by the event —
// never a request. So every test here drives `goActive()`, and the refusal tests drive a request
// and assert that nothing moved.

test('a 1-view mode going active flattens the rig; a 2-view mode restores it', async () => {
  const env = installEnv();
  const { wall, handle, layer } = await makeWall(env);
  handle.setViewRig(CAM_RIG);
  assert.deepEqual(layer.rigs.at(-1), CAM_RIG);

  await quietInfo(async () => {
    env.goActive(0);
    await flush();
  });
  assert.equal(layer.rigs.at(-1).ipdFactor, 0);
  assert.equal(layer.rigs.at(-1).parallaxFactor, 0);
  assert.equal(layer.rigs.at(-1).verticalFov, CAM_RIG.verticalFov, 'only the two factors move');
  assert.equal(wall.stereoCollapsed, true);

  env.goActive(1);
  await flush();
  assert.deepEqual(layer.rigs.at(-1), CAM_RIG, 'restore is the rig the page last set, exactly');
  assert.equal(wall.stereoCollapsed, false);
  wall.close();
});

test("the flattening is a COPY — the page's own descriptor is never written into", async () => {
  const env = installEnv();
  const { wall, handle } = await makeWall(env);
  // A page driving a rig per frame reuses ONE object (cameraRigFromCamera's `out`). Zeroing it in
  // place would write the flattening into the page's state and the restore would restore 0.
  const reused = { ...CAM_RIG };
  handle.setViewRig(reused);
  await quietInfo(async () => {
    env.goActive(0);
    await flush();
  });
  assert.equal(reused.ipdFactor, 2, 'the caller keeps its factors');
  assert.equal(reused.parallaxFactor, 2);
  wall.close();
});

test('the latch survives a page that keeps calling setViewRig every frame', async () => {
  const env = installEnv();
  const { wall, handle, layer } = await makeWall(env);
  await quietInfo(async () => {
    env.goActive(0);
    await flush();
  });
  for (let i = 0; i < 3; i++) handle.setViewRig({ ...CAM_RIG, convergenceDiopters: i });
  for (const rig of layer.rigs.slice(-3)) {
    assert.equal(rig.ipdFactor, 0, 'a per-frame rig must not walk the page out of 2D');
    assert.equal(rig.parallaxFactor, 0);
  }
  // ...and the page's intent is still what comes back.
  env.goActive(1);
  await flush();
  assert.equal(layer.rigs.at(-1).convergenceDiopters, 2);
  assert.equal(layer.rigs.at(-1).ipdFactor, 2);
  wall.close();
});

test('a window with no rig of its own is flattened via the virtualDisplayHeight equivalent', async () => {
  const env = installEnv();
  const { wall, layer } = await makeWall(env, { virtualDisplayHeight: 0.4 });
  await quietInfo(async () => {
    env.goActive(0);
    await flush();
  });
  const flat = layer.rigs.at(-1);
  assert.equal(flat.type, 'display');
  assert.equal(flat.virtualDisplayHeight, 0.4, 'the scalar becomes its exact rig equivalent');
  assert.equal(flat.ipdFactor, 0);
  // Restore sends the same descriptor with the factors back at 1 — which IS the default rig.
  env.goActive(1);
  await flush();
  assert.equal(layer.rigs.at(-1).ipdFactor, 1);
  assert.equal(layer.rigs.at(-1).virtualDisplayHeight, 0.4);
  wall.close();
});

test('EVERY window collapses, not just the one that was asked — the mode is the display\'s', async () => {
  const env = installEnv();
  const wall = await createInline3D({ lazy: false, autoChrome: false });
  const a = wall.addScene(makeCanvas(), () => {});
  const b = wall.addScene(makeCanvas(), () => {});
  await flush();
  a.setViewRig({ ...CAM_RIG });
  b.setViewRig({ ...CAM_RIG });
  await quietInfo(async () => {
    env.goActive(0);
    await flush();
  });
  assert.equal(env.created[0].rigs.at(-1).ipdFactor, 0);
  assert.equal(env.created[1].rigs.at(-1).ipdFactor, 0);
  wall.close();
});

test('a lazy tile that rebuilds its layer while flat comes back FLAT, not in 3D', async () => {
  const env = installEnv();
  const wall = await createInline3D({ lazy: true, autoChrome: false });
  const canvas = makeCanvas();
  const handle = wall.addScene(canvas, () => {});
  env.intersect(canvas, true);
  await flush();
  handle.setViewRig(CAM_RIG);
  await quietInfo(async () => {
    env.goActive(0);
    await flush();
  });
  env.intersect(canvas, false); // scrolled away — the layer closes
  env.intersect(canvas, true); // ...and back: a NEW layer
  const rebuilt = env.created.at(-1);
  assert.equal(rebuilt.init.viewRig.ipdFactor, 0, 'the new layer is built with the flat rig');
  // And NOTHING is re-requested at the panel: the hardware state is the display's and survives a
  // tile scrolling away. Re-asserting it here would be this SDK moving the panel behind the
  // page's back.
  assert.deepEqual(rebuilt.modeRequests, []);
  wall.close();
});

test('a page that OPENS with a 1-view mode already active is collapsed by the first read', async () => {
  const env = installEnv();
  for (const m of env.modes) m.isActive = m.modeIndex === 0; // the panel was already flat
  const wall = await createInline3D({ lazy: false, autoChrome: false });
  let layer;
  await quietInfo(async () => {
    wall.addScene(makeCanvas(), () => {}, { virtualDisplayHeight: 0.4 });
    await flush();
    layer = env.created[0];
  });
  assert.equal(wall.stereoCollapsed, true, 'no event ever fired — the first mode read is the source');
  assert.equal(layer.rigs.at(-1).ipdFactor, 0);
  wall.close();
});

// A REFUSED REQUEST CHANGES NOTHING, IN EITHER DIRECTION. It is structural now rather than a
// rollback: the request touches no rig at all, so there is nothing to unwind — but the invariant
// is the one pages depend on, so it is still asserted from both directions.

test('a refused GOING-FLAT request leaves the rig, the latch and the mode untouched', async () => {
  const env = installEnv({ refuse: [0] });
  const { wall, handle, layer } = await makeWall(env);
  handle.setViewRig(CAM_RIG);
  const rigsBefore = layer.rigs.length;

  await assert.rejects(() => handle.requestRenderingMode(0), { name: 'NotSupportedError' });

  assert.equal(wall.stereoCollapsed, false, 'the latch must not move on a request');
  assert.equal(layer.rigs.length, rigsBefore, 'not one rig was pushed');
  assert.deepEqual(layer.rigs.at(-1), CAM_RIG);
  assert.deepEqual(layer.modeRequests, [0], 'the request was made, and it was refused');
  wall.close();
});

test('a refused COMING-BACK request leaves the window flat, not half-switched', async () => {
  const env = installEnv({ refuse: [1] });
  const { wall, handle, layer } = await makeWall(env);
  handle.setViewRig(CAM_RIG);
  await quietInfo(async () => {
    env.goActive(0);
    await flush();
  });
  assert.equal(wall.stereoCollapsed, true);

  await assert.rejects(() => handle.requestRenderingMode(1), { name: 'NotSupportedError' });
  assert.equal(wall.stereoCollapsed, true, 'refused ⇒ still flat, not stereo on a flat panel');
  assert.equal(layer.rigs.at(-1).ipdFactor, 0);
  wall.close();
});

// ── 4. setStereoEnabled — sugar, and only sugar ─────────────────────────────────────────

test('setStereoEnabled(false) requests the first requestable 1-view mode and nothing else', async () => {
  const env = installEnv();
  const { wall, handle, layer } = await makeWall(env);
  handle.setViewRig(CAM_RIG);
  const rigsBefore = layer.rigs.length;

  assert.equal(await handle.setStereoEnabled(false), false);
  assert.deepEqual(layer.modeRequests, [0]);
  assert.equal(layer.rigs.length, rigsBefore, 'the rig follows the EVENT, never the request');
  assert.equal(wall.stereoCollapsed, false, 'nothing is active yet — the browser has not said so');

  // ...and when the browser does say so, the rig moves.
  await quietInfo(async () => {
    env.goActive(0);
    await flush();
  });
  assert.equal(layer.rigs.at(-1).ipdFactor, 0);
  wall.close();
});

test('setStereoEnabled(true) requests the first requestable 2-view mode', async () => {
  const env = installEnv();
  const { wall, handle, layer } = await makeWall(env);
  await quietInfo(async () => {
    env.goActive(0);
    await flush();
  });
  assert.equal(await wall.setStereoEnabled(true), true);
  assert.deepEqual(layer.modeRequests, [1]);
  wall.close();
});

test('setStereoEnabled with no matching mode rejects instead of inventing one', async () => {
  const env = installEnv();
  env.modes[0].isRequestable = false; // this panel offers no requestable 1-view mode
  const { wall, handle, layer } = await makeWall(env);
  await assert.rejects(() => handle.setStereoEnabled(false), /no requestable 1-view mode/);
  assert.deepEqual(layer.modeRequests, [], 'nothing was asked of the browser');
  wall.close();
});

test('setStereoEnabled is idempotent — asking for the state you are in makes no request', async () => {
  const env = installEnv();
  const { wall, handle, layer } = await makeWall(env);
  assert.equal(await handle.setStereoEnabled(true), true);
  assert.deepEqual(layer.modeRequests, [], 'the 2-view mode is already active');
  wall.close();
});

// ── 5. the re-emitted events ────────────────────────────────────────────────────────────

test('on() delivers the new mode index and view count, and its unsubscribe works', async () => {
  const env = installEnv();
  const { wall } = await makeWall(env);
  const seen = [];
  const off = wall.on('renderingmodechange', (ev) => seen.push(ev));
  await quietInfo(async () => {
    env.goActive(0);
    await flush();
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, 'renderingmodechange');
  assert.equal(seen[0].modeIndex, 0);
  assert.equal(seen[0].viewCount, 1);
  assert.deepEqual(seen[0].detail, { modeIndex: 0 }, "the browser's own payload travels as-is");

  off();
  env.goActive(1);
  await flush();
  assert.equal(seen.length, 1, 'unsubscribed');
  wall.close();
});

test('hardwaredisplaystatechange re-emits the state and updates wall.hardwareDisplayState', async () => {
  const env = installEnv();
  const { wall } = await makeWall(env);
  const seen = [];
  wall.on('hardwaredisplaystatechange', (ev) => seen.push(ev));
  assert.equal(wall.hardwareDisplayState, null, 'null until the browser says — never a guess');

  env.fire('hardwaredisplaystatechange', { state: '2d' });
  assert.deepEqual(seen.map((s) => s.state), ['2d']);
  assert.equal(wall.hardwareDisplayState, '2d');

  // A bare string payload is read too — the shape has moved once already.
  env.fire('hardwaredisplaystatechange', '3d');
  assert.equal(wall.hardwareDisplayState, '3d');
  wall.close();
});

test('on() refuses an unknown event name rather than silently never firing', async () => {
  const env = installEnv();
  const { wall } = await makeWall(env);
  assert.throws(() => wall.on('modechange', () => {}), TypeError);
  wall.close();
});

test('onDisplayModeChange still delivers BOTH events through one callback', async () => {
  const env = installEnv();
  const { wall, handle } = await makeWall(env);
  const seen = [];
  const off = handle.onDisplayModeChange((ev) => seen.push(ev));
  await quietInfo(async () => {
    env.goActive(0);
    await flush();
  });
  env.fire('hardwaredisplaystatechange', { state: '2d' });
  assert.deepEqual(seen.map((s) => s.type), ['renderingmodechange', 'hardwaredisplaystatechange']);
  off();
  env.fire('hardwaredisplaystatechange', { state: '3d' });
  assert.equal(seen.length, 2);
  wall.close();
});

test("a page callback that throws does not take the session's dispatch with it", async () => {
  const env = installEnv();
  const { wall, handle } = await makeWall(env);
  const real = console.error;
  console.error = () => {};
  try {
    handle.on('hardwaredisplaystatechange', () => {
      throw new Error('page bug');
    });
    let alsoRan = false;
    handle.on('hardwaredisplaystatechange', () => {
      alsoRan = true;
    });
    assert.doesNotThrow(() => env.fire('hardwaredisplaystatechange', { state: '2d' }));
    assert.equal(alsoRan, true, 'the other listener still ran');
  } finally {
    console.error = real;
  }
  wall.close();
});

// ── 6. undock ───────────────────────────────────────────────────────────────────────────

test('wall.undock is NULL on a browser with no XRDisplayLayer.undock — the thing pages branch on', async () => {
  const env = installEnv();
  const { wall } = await makeWall(env);
  assert.equal(inline3dUndockSupported(), false);
  assert.equal(wall.undock, null);
  wall.close();
});

test('wall.undock carries the capabilities read off the first live layer', async () => {
  const env = installEnv({ undock: true, undockCaps: { model: true, splat: false } });
  const { wall } = await makeWall(env);
  assert.equal(inline3dUndockSupported(), true);
  await flush();
  assert.deepEqual(wall.undock, { model: true, splat: false });
  // ...and re-reading is cheap and idempotent.
  assert.deepEqual(await wall.refreshUndock(), { model: true, splat: false });
  wall.close();
});

test('undockUrl builds the v=1 protocol URL, percent-encoded and with no vh', () => {
  installEnv();
  // The fallback path is pure DOM arithmetic, so it gets the DOM it needs and nothing else.
  globalThis.window = {
    ...globalThis.window,
    devicePixelRatio: 2,
    screenX: 100,
    screenY: 50,
    outerWidth: 1000,
    innerWidth: 1000,
    outerHeight: 900,
    innerHeight: 800,
    location: { href: 'https://shop.example/p/1' },
  };
  const el = { getBoundingClientRect: () => ({ left: 10, top: 20, width: 300, height: 150 }) };
  const url = undockUrl(el, {
    src: '/assets/bag.glb',
    type: 'model',
    env: 'room',
    pose: { yaw: -40, pitch: 5 },
    title: 'A bag',
  });
  assert.ok(url.startsWith('displayxr-view://open?'));
  assert.match(url, /src=https%3A%2F%2Fshop\.example%2Fassets%2Fbag\.glb/, 'site-relative src resolved to absolute');
  assert.match(url, /title=A%20bag/);
  assert.ok(!url.includes('+'), "URLSearchParams' '+' for a space is NOT what the viewer decodes");
  assert.match(url, /rect=220%2C340%2C600%2C300/, '(screen+chrome+bcr)*dpr; chromeY = outerHeight-innerHeight');
  assert.match(url, /type=model/);
  assert.match(url, /env=room/);
  assert.match(url, /pose=-40%2C5/);
  assert.match(url, /transparent=1/);
  assert.match(url, /v=1/);
  assert.ok(!/[?&]vh=/.test(url), 'vh is deliberately never sent — it disables the viewer auto-fit');
  installEnv();
});

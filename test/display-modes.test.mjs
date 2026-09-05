// Tests for the display-mode surface — `inline3dDisplayModesSupported()`, the four
// passthroughs on the tile handle, `setStereoEnabled()` and `onDisplayModeChange()`.
//
// Like the view-rig tests, the SDK's job here is PLUMBING, so what is worth pinning is not
// values but sequencing and ownership: that the capability probe demands all four methods, that
// a call with no live layer rejects instead of throwing, that `setStereoEnabled(false)` flips the
// LENS and flattens the RIG together, that the flattening is a COPY (a page's own descriptor is
// never written into, which is what makes the restore exact), that the latch survives a page
// driving `setViewRig` every frame and a lazy tile rebuilding its layer, and that the session
// events fan in and unsubscribe. Hence recording stubs and no real browser.

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

const MODES = [
  {
    modeIndex: 0,
    modeName: '2D',
    viewCount: 1,
    viewScaleX: 1,
    viewScaleY: 1,
    tileColumns: 1,
    tileRows: 1,
    viewWidthPixels: 3840,
    viewHeightPixels: 2160,
    hardwareDisplay3D: false,
    isActive: true,
    isRequestable: false,
  },
  {
    modeIndex: 1,
    modeName: 'Side-by-side',
    viewCount: 2,
    viewScaleX: 0.5,
    viewScaleY: 1,
    tileColumns: 2,
    tileRows: 1,
    viewWidthPixels: 1920,
    viewHeightPixels: 2160,
    hardwareDisplay3D: true,
    isActive: false,
    isRequestable: true,
  },
  {
    modeIndex: 2,
    modeName: 'Quad',
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

/**
 * A recording XRDisplayLayer class.
 *   `displayModes:false` builds a browser that predates the API entirely.
 *   `partial:true`       builds one mid-implementation (three of the four methods) — the case
 *                        the all-four probe exists to refuse.
 *   `refuseLens:true`    makes requestDisplayMode reject, to check the rig still comes back.
 */
function makeLayerClass({ viewRig = true, displayModes = true, partial = false, refuseLens = false } = {}) {
  const created = [];
  class FakeDisplayLayer {
    constructor(session, canvas, init) {
      this.session = session;
      this.canvas = canvas;
      this.init = init;
      this.rigs = [];
      this.lensRequests = [];
      this.modeRequests = [];
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
      return MODES;
    };
    P.requestRenderingMode = function requestRenderingMode(i) {
      // The browser raises this one SYNCHRONOUSLY — the SDK has to turn it into a rejection.
      const mode = MODES.find((m) => m.modeIndex === i);
      if (!mode || mode.viewCount !== 2) throw new TypeError('viewCount != 2');
      this.modeRequests.push(i);
      return Promise.resolve();
    };
    if (!partial) {
      P.requestDisplayMode = function requestDisplayMode(m) {
        this.lensRequests.push(m);
        return refuseLens ? Promise.reject(new Error('NotSupportedError')) : Promise.resolve();
      };
    }
  }
  return { FakeDisplayLayer, created };
}

/** Install the globals createInline3D touches, and hand back the levers to drive them. */
function installEnv(opts = {}) {
  const { FakeDisplayLayer, created } = makeLayerClass(opts);
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
    listenerCount: (type) => listeners.get(type)?.size ?? 0,
    /** Fire a session event the way the browser would after a mode/lens change. */
    fire(type, detail) {
      for (const fn of listeners.get(type) ?? []) fn({ type, detail });
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
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 300, height: 150, right: 300, bottom: 150, left: 0, top: 0 }),
  };
}

/** Silence the once-only console.info notices so the test output stays readable. */
function quietInfo(fn) {
  const real = console.info;
  console.info = () => {};
  return Promise.resolve(fn()).finally(() => {
    console.info = real;
  });
}

const env = installEnv();
const { createInline3D, inline3dDisplayModesSupported } = await import('../js/inline3d.js');

const CAM_RIG = { type: 'camera', position: { x: 0, y: 0, z: 0 }, verticalFov: 0.8, ipdFactor: 2, parallaxFactor: 2 };

// ── 1. capability gating ────────────────────────────────────────────────────────────────

test('inline3dDisplayModesSupported is true when all four methods are on the prototype', () => {
  installEnv();
  assert.equal(inline3dDisplayModesSupported(), true);
});

test('inline3dDisplayModesSupported is false on a browser that predates the API', () => {
  installEnv({ displayModes: false });
  assert.equal(inline3dDisplayModesSupported(), false);
});

test('inline3dDisplayModesSupported demands ALL FOUR — a partial browser is not supported', () => {
  installEnv({ partial: true });
  assert.equal(
    inline3dDisplayModesSupported(),
    false,
    'three of four would surface as "requestDisplayMode is not a function" inside a click handler'
  );
});

test('inline3dDisplayModesSupported is false with no XRDisplayLayer at all', () => {
  installEnv();
  globalThis.window.XRDisplayLayer = undefined;
  assert.equal(inline3dDisplayModesSupported(), false);
  installEnv();
});

// ── 2. the passthroughs ─────────────────────────────────────────────────────────────────

test('getDisplayInfo and getRenderingModes hand the runtime report through unreshaped', async () => {
  installEnv();
  const wall = await createInline3D({ lazy: false, autoChrome: false });
  const handle = wall.addScene(makeCanvas(), () => {});
  assert.deepEqual(await handle.getDisplayInfo(), DISPLAY_INFO);
  assert.deepEqual(await handle.getRenderingModes(), MODES);
  wall.close();
});

test('requestRenderingMode forwards a 2-view mode', async () => {
  const e = installEnv();
  const wall = await createInline3D({ lazy: false, autoChrome: false });
  const handle = wall.addScene(makeCanvas(), () => {});
  await handle.requestRenderingMode(1);
  assert.deepEqual(e.created[0].modeRequests, [1]);
  wall.close();
});

test("the browser's SYNCHRONOUS TypeError for a non-2-view mode arrives as a rejection", async () => {
  installEnv();
  const wall = await createInline3D({ lazy: false, autoChrome: false });
  const handle = wall.addScene(makeCanvas(), () => {});
  // The point: one .catch() covers both failure shapes, so a page never needs a try/catch AND a
  // .catch() around the same call.
  await assert.rejects(() => handle.requestRenderingMode(2), TypeError);
  wall.close();
});

test('requestDisplayMode refuses anything that is not 2d or 3d, without reaching the layer', async () => {
  const e = installEnv();
  const wall = await createInline3D({ lazy: false, autoChrome: false });
  const handle = wall.addScene(makeCanvas(), () => {});
  await assert.rejects(() => handle.requestDisplayMode('flat'), TypeError);
  assert.deepEqual(e.created[0].lensRequests, []);
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
  const e = installEnv();
  const wall = await createInline3D({ lazy: true, autoChrome: false });
  const canvas = makeCanvas();
  const handle = wall.addScene(canvas, () => {});
  assert.equal(e.created.length, 0, 'a lazy tile has no layer until it intersects');
  await assert.rejects(() => handle.getRenderingModes(), /live weave layer/);
  wall.close();
});

// ── 3. setStereoEnabled — the composite ─────────────────────────────────────────────────

test('setStereoEnabled(false) flattens the rig AND flips the lens; (true) restores both', async () => {
  const e = installEnv();
  const wall = await createInline3D({ lazy: false, autoChrome: false });
  const handle = wall.addScene(makeCanvas(), () => {});
  handle.setViewRig(CAM_RIG);
  const layer = e.created[0];
  assert.deepEqual(layer.rigs.at(-1), CAM_RIG);

  await quietInfo(() => handle.setStereoEnabled(false));
  assert.deepEqual(layer.lensRequests, ['2d']);
  assert.equal(layer.rigs.at(-1).ipdFactor, 0);
  assert.equal(layer.rigs.at(-1).parallaxFactor, 0);
  assert.equal(layer.rigs.at(-1).verticalFov, CAM_RIG.verticalFov, 'only the two factors move');

  await handle.setStereoEnabled(true);
  assert.deepEqual(layer.lensRequests, ['2d', '3d']);
  assert.deepEqual(layer.rigs.at(-1), CAM_RIG, 'restore is the rig the page last set, exactly');
  wall.close();
});

test("the flattening is a COPY — the page's own descriptor is never written into", async () => {
  installEnv();
  const wall = await createInline3D({ lazy: false, autoChrome: false });
  const handle = wall.addScene(makeCanvas(), () => {});
  // A page driving a rig per frame reuses ONE object (cameraRigFromCamera's `out`). Zeroing it in
  // place would write the flattening into the page's state and the restore would restore 0.
  const reused = { ...CAM_RIG };
  handle.setViewRig(reused);
  await quietInfo(() => handle.setStereoEnabled(false));
  assert.equal(reused.ipdFactor, 2, 'the caller keeps its factors');
  assert.equal(reused.parallaxFactor, 2);
  wall.close();
});

test('the latch survives a page that keeps calling setViewRig every frame', async () => {
  const e = installEnv();
  const wall = await createInline3D({ lazy: false, autoChrome: false });
  const handle = wall.addScene(makeCanvas(), () => {});
  await quietInfo(() => handle.setStereoEnabled(false));
  const layer = e.created[0];
  for (let i = 0; i < 3; i++) handle.setViewRig({ ...CAM_RIG, convergenceDiopters: i });
  for (const rig of layer.rigs.slice(-3)) {
    assert.equal(rig.ipdFactor, 0, 'a per-frame rig must not walk the page out of 2D');
    assert.equal(rig.parallaxFactor, 0);
  }
  // ...and the page's intent is still what comes back.
  await handle.setStereoEnabled(true);
  assert.equal(layer.rigs.at(-1).convergenceDiopters, 2);
  assert.equal(layer.rigs.at(-1).ipdFactor, 2);
  wall.close();
});

test('a window with no rig of its own is flattened via the virtualDisplayHeight equivalent', async () => {
  const e = installEnv();
  const wall = await createInline3D({ lazy: false, autoChrome: false });
  const handle = wall.addScene(makeCanvas(), () => {}, { virtualDisplayHeight: 0.4 });
  await quietInfo(() => handle.setStereoEnabled(false));
  const flat = e.created[0].rigs.at(-1);
  assert.equal(flat.type, 'display');
  assert.equal(flat.virtualDisplayHeight, 0.4, 'the scalar becomes its exact rig equivalent');
  assert.equal(flat.ipdFactor, 0);
  // Restore sends the same descriptor with the factors back at 1 — which IS the default rig.
  await handle.setStereoEnabled(true);
  assert.equal(e.created[0].rigs.at(-1).ipdFactor, 1);
  assert.equal(e.created[0].rigs.at(-1).virtualDisplayHeight, 0.4);
  wall.close();
});

test('a lazy tile that rebuilds its layer while flat comes back FLAT, not in 3D', async () => {
  const e = installEnv();
  const wall = await createInline3D({ lazy: true, autoChrome: false });
  const canvas = makeCanvas();
  const handle = wall.addScene(canvas, () => {});
  e.intersect(canvas, true);
  handle.setViewRig(CAM_RIG);
  await quietInfo(() => handle.setStereoEnabled(false));
  e.intersect(canvas, false); // scrolled away — the layer closes
  e.intersect(canvas, true); // ...and back: a NEW layer
  const rebuilt = e.created.at(-1);
  assert.equal(rebuilt.init.viewRig.ipdFactor, 0, 'the new layer is built with the flat rig');
  assert.deepEqual(rebuilt.lensRequests, ['2d'], 'and the lens request is re-asserted on it');
  wall.close();
});

test('a refused lens request still puts the rig back — nobody can be left latched flat', async () => {
  const e = installEnv({ refuseLens: true });
  const wall = await createInline3D({ lazy: false, autoChrome: false });
  const handle = wall.addScene(makeCanvas(), () => {});
  handle.setViewRig(CAM_RIG);
  await quietInfo(() => handle.setStereoEnabled(false).catch(() => {}));
  await assert.rejects(() => handle.setStereoEnabled(true));
  assert.deepEqual(e.created[0].rigs.at(-1), CAM_RIG);
  wall.close();
});

test('setStereoEnabled is idempotent — asking for the state you are in does nothing', async () => {
  const e = installEnv();
  const wall = await createInline3D({ lazy: false, autoChrome: false });
  const handle = wall.addScene(makeCanvas(), () => {});
  assert.equal(await handle.setStereoEnabled(true), true);
  assert.deepEqual(e.created[0].lensRequests, [], 'already 3D: no lens request at all');
  wall.close();
});

// ── 4. the session events ───────────────────────────────────────────────────────────────

test('onDisplayModeChange subscribes to BOTH session events and unsubscribes cleanly', async () => {
  const e = installEnv();
  const wall = await createInline3D({ lazy: false, autoChrome: false });
  const handle = wall.addScene(makeCanvas(), () => {});
  const seen = [];
  const off = handle.onDisplayModeChange((ev) => seen.push(ev));
  assert.equal(e.listenerCount('renderingmodechange'), 1);
  assert.equal(e.listenerCount('hardwaredisplaystatechange'), 1);

  e.fire('renderingmodechange', { modeIndex: 1 });
  e.fire('hardwaredisplaystatechange', undefined);
  assert.deepEqual(
    seen.map((s) => s.type),
    ['renderingmodechange', 'hardwaredisplaystatechange']
  );
  assert.deepEqual(seen[0].detail, { modeIndex: 1 });
  assert.equal(seen[1].detail.type, 'hardwaredisplaystatechange', 'no detail ⇒ the event itself');

  off();
  assert.equal(e.listenerCount('renderingmodechange'), 0);
  assert.equal(e.listenerCount('hardwaredisplaystatechange'), 0);
  wall.close();
});

test("a page callback that throws does not take the session's dispatch with it", async () => {
  const e = installEnv();
  const wall = await createInline3D({ lazy: false, autoChrome: false });
  const handle = wall.addScene(makeCanvas(), () => {});
  const real = console.error;
  console.error = () => {};
  try {
    handle.onDisplayModeChange(() => {
      throw new Error('page bug');
    });
    assert.doesNotThrow(() => e.fire('renderingmodechange', {}));
  } finally {
    console.error = real;
  }
  wall.close();
});

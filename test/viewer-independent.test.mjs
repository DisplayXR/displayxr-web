// Tests for the viewer-independence declaration — the `viewerIndependent` option on every add*(),
// `handle.setViewerIndependent()` and `inline3dViewerIndependentSupported()` (runtime
// XR_DXR_display_info v25, XrViewLocateFixedViewerDXR, reached through the DisplayXR Browser's
// XRDisplayLayerInit.viewerIndependent / XRDisplayLayer.setViewerIndependent).
//
// Pure plumbing, like the rig: what is pinned is the DEFAULT per window kind, that the
// declaration reaches the layer init only on a browser that has the member, that it survives
// the lazy lifecycle, and that it never touches anything else in the init.

import test from 'node:test';
import assert from 'node:assert/strict';

// ── environment ─────────────────────────────────────────────────────────────────────────

/** A recording XRDisplayLayer class. `viewRig:false` builds the older browser (no setViewRig). */
function makeLayerClass({ viewRig = true, vi = true } = {}) {
  const created = [];
  class FakeDisplayLayer {
    constructor(session, canvas, init) {
      this.session = session;
      this.canvas = canvas;
      this.init = init;
      this.rigs = [];
      this.vi = [];
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
  // Defined on the PROTOTYPE, because that is where the SDK probes for it.
  if (viewRig) {
    FakeDisplayLayer.prototype.setViewRig = function setViewRig(rig) {
      this.rigs.push(rig);
    };
  }
  if (vi) {
    FakeDisplayLayer.prototype.setViewerIndependent = function setViewerIndependent(v) {
      this.vi.push(v);
    };
  }
  return { FakeDisplayLayer, created };
}

/** Install the globals createInline3D touches, and hand back the levers to drive them. */
function installEnv({ viewRig = true, vi = true } = {}) {
  const { FakeDisplayLayer, created } = makeLayerClass({ viewRig, vi });
  const observers = [];
  const session = {
    _rafs: [],
    addEventListener() {},
    removeEventListener() {},
    requestReferenceSpace: async () => ({}),
    requestAnimationFrame(cb) {
      session._rafs.push(cb);
      return session._rafs.length;
    },
    end() {},
  };
  // defineProperty, not assignment: Node ships its own `navigator` as a getter-only global.
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
  globalThis.XRDisplayLayer = FakeDisplayLayer; // _activate constructs off the bare global
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
    /** Report `el` as (not) intersecting, the way the browser drives the lazy lifecycle. */
    intersect(el, isIntersecting) {
      for (const o of observers) o.cb([{ target: el, isIntersecting }]);
    },
  };
}

/** A canvas stub: the core only reads its style, its box and its parent. */
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


/** An image/video canvas: the SDK owns its 2D context, so hand it one that swallows every call. */
function makeTileCanvas() {
  const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => ((t[k] = v), true) });
  return { ...makeCanvas(), getContext: () => ctx };
}

const env0 = installEnv();
const { createInline3D, inline3dViewerIndependentSupported } = await import('../js/inline3d.js');
void env0;

function initOf(e, i = 0) {
  return e.created[i].init;
}

test('inline3dViewerIndependentSupported follows the prototype method', () => {
  installEnv({ vi: false });
  assert.equal(inline3dViewerIndependentSupported(), false);
  installEnv({ vi: true });
  assert.equal(inline3dViewerIndependentSupported(), true);
});

test('defaults: image and video are viewer-independent, a scene is not', async () => {
  const e = installEnv();
  const wall = await createInline3D({ lazy: false, autoChrome: false });
  const hi = wall.addImage(makeTileCanvas(), { width: 2, height: 2 });
  const hv = wall.addVideo(makeTileCanvas(), { readyState: 0 });
  const hs = wall.addScene(makeCanvas(), () => {});
  assert.equal(hi.viewerIndependent, true);
  assert.equal(hv.viewerIndependent, true);
  assert.equal(hs.viewerIndependent, false);
  assert.equal(initOf(e, 0).viewerIndependent, true);
  assert.equal(initOf(e, 1).viewerIndependent, true);
  assert.equal(initOf(e, 2).viewerIndependent, false);
  wall.close();
});

test('the option overrides the default in both directions', async () => {
  const e = installEnv();
  const wall = await createInline3D({ lazy: false, autoChrome: false });
  wall.addVideo(makeTileCanvas(), { readyState: 0 }, { viewerIndependent: false });
  wall.addScene(makeCanvas(), () => {}, { viewerIndependent: true });
  assert.equal(initOf(e, 0).viewerIndependent, false);
  assert.equal(initOf(e, 1).viewerIndependent, true);
  wall.close();
});

test('an older browser gets an init without the member (byte-identical to before)', async () => {
  const e = installEnv({ vi: false });
  const wall = await createInline3D({ lazy: false, autoChrome: false });
  const h = wall.addVideo(makeTileCanvas(), { readyState: 0 });
  assert.equal('viewerIndependent' in initOf(e), false);
  assert.equal(h.setViewerIndependent(false), false, 'no live layer can take it');
  assert.equal(h.viewerIndependent, false, 'but the value is stored');
  wall.close();
});

test('setViewerIndependent reaches the live layer and survives a lazy rebuild', async () => {
  const e = installEnv();
  const wall = await createInline3D({ lazy: true, autoChrome: false });
  const canvas = makeCanvas();
  const h = wall.addScene(canvas, () => {});
  assert.equal(h.setViewerIndependent(true), false, 'dark lazy window: stored only');
  e.intersect(canvas, true);
  assert.equal(initOf(e, 0).viewerIndependent, true, 'the first layer is built with it');
  assert.equal(h.setViewerIndependent(false), true);
  assert.deepEqual(e.created[0].vi, [false]);
  e.intersect(canvas, false);
  e.intersect(canvas, true);
  assert.equal(initOf(e, 1).viewerIndependent, false, 'the rebuilt layer keeps the latest value');
  wall.close();
});

test('the declaration rides next to the rig, never instead of it', async () => {
  const e = installEnv();
  const wall = await createInline3D({ lazy: false, autoChrome: false });
  const rig = { type: 'camera', position: { x: 0, y: 0, z: 0 }, verticalFov: 0.8, convergenceDiopters: 1 };
  wall.addScene(makeCanvas(), () => {}, { viewRig: rig });
  assert.deepEqual(initOf(e), { viewRig: rig, viewerIndependent: false });
  wall.close();
});

test("untrackedFallback:'mono' flips the image/video default (that page follows tracking)", async () => {
  const e = installEnv();
  const wall = await createInline3D({ lazy: false, autoChrome: false, untrackedFallback: 'mono' });
  const hv = wall.addVideo(makeTileCanvas(), { readyState: 0 });
  const hx = wall.addVideo(makeTileCanvas(), { readyState: 0 }, { viewerIndependent: true });
  assert.equal(hv.viewerIndependent, false);
  assert.equal(hx.viewerIndependent, true, 'an explicit option still wins');
  assert.equal(initOf(e, 0).viewerIndependent, false);
  wall.close();
});

// Tests for the view-rig surface — `addScene({viewRig})`, `handle.setViewRig()`,
// `inline3dViewRigSupported()`, and the three.js rig builders.
//
// The SDK's whole job here is PASS-THROUGH: it builds descriptors and hands them to the
// browser, and every projection stays in the runtime. So what is worth pinning is not maths but
// plumbing — WHICH init a layer was constructed with, WHETHER a rig reached the layer, whether
// an unsupported browser stays quiet after saying its piece once, and whether a rig survives the
// lazy lifecycle destroying the layer under it. Hence recording stubs, and no three.js: a real
// XRDisplayLayer and a real WebGL context would hide exactly the calls being counted.

import test from 'node:test';
import assert from 'node:assert/strict';

import { makeTHREE } from './stubs.mjs';

// ── environment ─────────────────────────────────────────────────────────────────────────

/** A recording XRDisplayLayer class. `viewRig:false` builds the older browser (no setViewRig). */
function makeLayerClass({ viewRig = true } = {}) {
  const created = [];
  class FakeDisplayLayer {
    constructor(session, canvas, init) {
      this.session = session;
      this.canvas = canvas;
      this.init = init;
      this.rigs = [];
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
  return { FakeDisplayLayer, created };
}

/** Install the globals createInline3D touches, and hand back the levers to drive them. */
function installEnv({ viewRig = true } = {}) {
  const { FakeDisplayLayer, created } = makeLayerClass({ viewRig });
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

function withCapturedWarnings(fn) {
  const warns = [];
  const real = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    fn(warns);
  } finally {
    console.warn = real;
  }
  return warns;
}

const env = installEnv();
const { createInline3D, inline3dViewRigSupported } = await import('../js/inline3d.js');
const { EyeCamera, cameraRigFromCamera, displayRig } = await import('../js/inline3d-three.js');

const CAM_RIG = { type: 'camera', position: { x: 0, y: 0, z: 0 }, verticalFov: 0.8 };

// ── 1. capability gating ────────────────────────────────────────────────────────────────

test('inline3dViewRigSupported is false when the prototype has no setViewRig', () => {
  installEnv({ viewRig: false });
  assert.equal(inline3dViewRigSupported(), false);
});

test('inline3dViewRigSupported is true when the prototype carries the method', () => {
  installEnv({ viewRig: true });
  assert.equal(inline3dViewRigSupported(), true);
});

test('inline3dViewRigSupported is false with no XRDisplayLayer at all', () => {
  installEnv({ viewRig: true });
  globalThis.window.XRDisplayLayer = undefined;
  assert.equal(inline3dViewRigSupported(), false);
  installEnv({ viewRig: true }); // put the browser back for the tests below
});

// ── 2. setViewRig ───────────────────────────────────────────────────────────────────────

test('setViewRig on a browser without support warns ONCE and reports false', async () => {
  installEnv({ viewRig: false });
  const wall = await createInline3D({ lazy: false, autoChrome: false });
  const handle = wall.addScene(makeCanvas(), () => {});
  const warns = withCapturedWarnings(() => {
    for (let i = 0; i < 5; i++) assert.equal(handle.setViewRig(CAM_RIG), false);
  });
  assert.equal(warns.length, 1, 'a per-frame call must not warn per frame');
  assert.match(warns[0], /setViewRig/);
  wall.close();
});

test('setViewRig passes the rig straight through to the live layer', async () => {
  const e = installEnv({ viewRig: true });
  const wall = await createInline3D({ lazy: false, autoChrome: false });
  const handle = wall.addScene(makeCanvas(), () => {});
  const rigA = { ...CAM_RIG, convergenceDiopters: 2 };
  const rigB = { ...CAM_RIG, convergenceDiopters: 4 };
  assert.equal(handle.setViewRig(rigA), true);
  assert.equal(handle.setViewRig(rigB), true);
  assert.deepEqual(e.created[0].rigs, [rigA, rigB], 'the SDK must not reshape the descriptor');
  wall.close();
});

test('a rig set while a lazy window is dark builds the NEXT layer', async () => {
  const e = installEnv({ viewRig: true });
  const wall = await createInline3D({ lazy: true, autoChrome: false });
  const canvas = makeCanvas();
  const handle = wall.addScene(canvas, () => {});
  assert.equal(e.created.length, 0, 'a lazy window starts dark');

  // Scrolled away (never on screen): stored, nothing live to apply it to.
  assert.equal(handle.setViewRig(CAM_RIG), false);

  e.intersect(canvas, true);
  assert.equal(e.created.length, 1);
  assert.deepEqual(e.created[0].init, { viewRig: CAM_RIG }, 'the first located frame must already be on the rig');

  // …and the round trip a scrolling wall does constantly must not revert it.
  e.intersect(canvas, false);
  e.intersect(canvas, true);
  assert.equal(e.created.length, 2);
  assert.deepEqual(e.created[1].init, { viewRig: CAM_RIG });
  wall.close();
});

// ── 3. addScene forwarding ──────────────────────────────────────────────────────────────

test('addScene forwards viewRig into the layer init', async () => {
  const e = installEnv({ viewRig: true });
  const wall = await createInline3D({ lazy: false, autoChrome: false });
  wall.addScene(makeCanvas(), () => {}, { viewRig: CAM_RIG });
  assert.deepEqual(e.created[0].init, { viewRig: CAM_RIG });
  wall.close();
});

test('without a viewRig the scalar height is still what reaches the layer', async () => {
  const e = installEnv({ viewRig: true });
  const wall = await createInline3D({ lazy: false, autoChrome: false });
  wall.addScene(makeCanvas(), () => {});
  assert.deepEqual(e.created[0].init, { virtualDisplayHeight: 0.24 }, 'the default rig must not change');
  wall.close();
});

test('viewRig beats virtualDisplayHeight, and says so once', async () => {
  const e = installEnv({ viewRig: true });
  const wall = await createInline3D({ lazy: false, autoChrome: false });
  const warns = withCapturedWarnings(() => {
    wall.addScene(makeCanvas(), () => {}, { viewRig: CAM_RIG, virtualDisplayHeight: 0.12 });
    wall.addScene(makeCanvas(), () => {}, { viewRig: CAM_RIG, virtualDisplayHeight: 0.12 });
  });
  assert.equal(warns.length, 1, 'once per document, not once per window');
  assert.match(warns[0], /rig wins/);
  assert.deepEqual(e.created[0].init, { viewRig: CAM_RIG }, 'the height must not survive alongside the rig');
  wall.close();
});

test('an older browser gets the fallback height, not a rig it cannot read', async () => {
  const e = installEnv({ viewRig: false });
  const wall = await createInline3D({ lazy: false, autoChrome: false });
  wall.addScene(makeCanvas(), () => {}, { viewRig: CAM_RIG, virtualDisplayHeight: 0.12 });
  assert.deepEqual(
    e.created[0].init,
    { virtualDisplayHeight: 0.12 },
    'handing an unknown member to an older browser drops it to ITS default height, not the app’s',
  );
  wall.close();
});

// ── 4. cameraRigFromCamera / displayRig ─────────────────────────────────────────────────

/** A THREE namespace with only what the rig builders touch, and a camera with a known pose. */
function makeRigTHREE() {
  class Vector3 {
    set(x, y, z) {
      this.x = x;
      this.y = y;
      this.z = z;
      return this;
    }
  }
  class Quaternion {
    set(x, y, z, w) {
      this.x = x;
      this.y = y;
      this.z = z;
      this.w = w;
      return this;
    }
  }
  return { Vector3, Quaternion, MathUtils: { degToRad: (d) => (d * Math.PI) / 180 } };
}

function makeRigCamera(fov = 60, pose = { p: [1, 2, 3], q: [0, 0.7071, 0, 0.7071] }) {
  return {
    fov,
    updated: 0,
    updateMatrixWorld() {
      this.updated++;
    },
    matrixWorld: {
      decompose(p, q, s) {
        p.set(...pose.p);
        q.set(...pose.q);
        s.set(1, 1, 1);
      },
    },
  };
}

test('cameraRigFromCamera maps a camera onto the descriptor', () => {
  const THREE = makeRigTHREE();
  const cam = makeRigCamera(60);
  const rig = cameraRigFromCamera(THREE, cam, { convergence: 0.8 });
  assert.equal(rig.type, 'camera');
  assert.deepEqual(rig.position, { x: 1, y: 2, z: 3 });
  assert.deepEqual(rig.orientation, { x: 0, y: 0.7071, z: 0, w: 0.7071 });
  assert.ok(Math.abs(rig.verticalFov - Math.PI / 3) < 1e-12, 'fov is degrees in, radians out');
  assert.ok(Math.abs(rig.convergenceDiopters - 1.25) < 1e-12, 'diopters = 1/distance');
  assert.equal(rig.ipdFactor, 1);
  assert.equal(rig.parallaxFactor, 1);
  assert.equal(rig.metersToVirtual, 1);
  assert.equal(cam.updated, 1, 'the world matrix must be current before it is decomposed');
});

test('convergence 0 (and unset) means infinity, not a division', () => {
  const THREE = makeRigTHREE();
  assert.equal(cameraRigFromCamera(THREE, makeRigCamera()).convergenceDiopters, 0);
  assert.equal(cameraRigFromCamera(THREE, makeRigCamera(), { convergence: 0 }).convergenceDiopters, 0);
});

test('attach emits an identity pose and never reads the camera', () => {
  const THREE = makeRigTHREE();
  const cam = makeRigCamera(45);
  const rig = cameraRigFromCamera(THREE, cam, { convergence: 0.5, attach: true });
  assert.deepEqual(rig.position, { x: 0, y: 0, z: 0 });
  assert.deepEqual(rig.orientation, { x: 0, y: 0, z: 0, w: 1 });
  assert.equal(cam.updated, 0, 'the scene graph owns the world pose in the attach pattern');
  assert.ok(Math.abs(rig.verticalFov - Math.PI / 4) < 1e-12, 'the FOV is still the app camera’s');
});

test('cameraRigFromCamera reuses `out` instead of allocating per frame', () => {
  const THREE = makeRigTHREE();
  const out = {};
  const a = cameraRigFromCamera(THREE, makeRigCamera(), { out });
  const b = cameraRigFromCamera(THREE, makeRigCamera(90), { out });
  assert.equal(a, out);
  assert.equal(b, out);
  assert.ok(Math.abs(out.verticalFov - Math.PI / 2) < 1e-12, 'the latest call wins');
});

test('displayRig defaults to the rig virtualDisplayHeight is shorthand for', () => {
  const rig = displayRig();
  assert.deepEqual(rig, {
    type: 'display',
    position: { x: 0, y: 0, z: 0 },
    orientation: { x: 0, y: 0, z: 0, w: 1 },
    virtualDisplayHeight: 0.24,
    ipdFactor: 1,
    parallaxFactor: 1,
    perspectiveFactor: 1,
  });
});

test('displayRig copies the pose rather than aliasing a live vector', () => {
  const position = { x: 0.1, y: 0, z: 0 };
  const rig = displayRig({ position, virtualDisplayHeight: 0.12, perspectiveFactor: 2 });
  position.x = 99; // the caller mutates its own object next frame
  assert.equal(rig.position.x, 0.1);
  assert.equal(rig.virtualDisplayHeight, 0.12);
  assert.equal(rig.perspectiveFactor, 2);
});

// ── 5. EyeCamera.setLocalFromView (the attach pattern) ──────────────────────────────────

test('setLocalFromView writes the LOCAL matrix and leaves matrixWorld to three', () => {
  const { THREE } = makeTHREE();
  const eye = new EyeCamera(THREE);
  const proj = new Float32Array(16).map((_, i) => i + 1);
  const pose = new Float32Array(16).map((_, i) => 100 + i);
  const worldBefore = Array.from(eye.camera.matrixWorld.elements);

  eye.setLocalFromView({ projectionMatrix: proj, transform: { matrix: pose } });

  assert.deepEqual(Array.from(eye.camera.matrix.elements), Array.from(pose));
  assert.deepEqual(Array.from(eye.camera.projectionMatrix.elements), Array.from(proj));
  assert.deepEqual(
    Array.from(eye.camera.matrixWorld.elements),
    worldBefore,
    'writing matrixWorld here would flatten the parent out of the composition',
  );
  assert.equal(eye.camera.matrixWorldNeedsUpdate, true, 'nothing else tells three the local matrix moved');
});

test('setFromView still composes the world pose itself (the unparented path is unchanged)', () => {
  const { THREE } = makeTHREE();
  const eye = new EyeCamera(THREE);
  const pose = new Float32Array(16).map((_, i) => 7 + i);
  eye.setFromView({ projectionMatrix: new Float32Array(16), transform: { matrix: pose } });
  assert.deepEqual(Array.from(eye.camera.matrixWorld.elements), Array.from(pose));
});

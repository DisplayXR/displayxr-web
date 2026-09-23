// controls:'page' — the page drives the camera; the adapter keeps the eye math (#36, F1000 phase 1).
//
// Everything here runs against a RECORDING fake of the engine: what matters is what the adapter
// writes into the rig node and the RenderViews, and what rig it declares — not pixels (the
// headless gates cover those).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  attachPlayCanvasSplat,
  pageRigTRS,
  pageRigMatrix,
  pageViewAxis,
  pageViewRig,
  poseMatrix,
  mat4Mul,
  perspectiveFov,
  perspectiveOffAxis,
  quatFromMatrix,
} from '../js/inline3d-splat-playcanvas.js';
import {
  resolveControls,
  normalizeCameraPose,
  PAGE_COMFORT_DEPTH,
  PAGE_IGNORED_OPTIONS,
  MONO_NEAR,
  CAPTURE_FAR,
} from '../js/inline3d-splat-shared.js';
import { installDom, makeCanvas } from './stubs.mjs';

const near = (a, b, eps, what = '') => assert.ok(Math.abs(a - b) < eps, `${what} ${a} !~= ${b}`);
const nearArr = (a, b, eps, what = '') => {
  assert.equal(a.length, b.length, `${what} length`);
  for (let i = 0; i < a.length; i++) near(a[i], b[i], eps, `${what}[${i}]`);
};
const DEG = Math.PI / 180;

/** A rigid camera pose in model space: position + yaw about Y (GL convention, looks down −Z). */
function camMatrix(p, yawDeg = 0, scale = 1) {
  const h = (yawDeg * DEG) / 2;
  const m = poseMatrix(p, [0, Math.sin(h), 0, Math.cos(h)]);
  for (let i = 0; i < 12; i++) if (i % 4 !== 3) m[i] *= scale;
  return Float32Array.from(m);
}

// ── a recording engine fake ─────────────────────────────────────────────────────────────────

function makeFakePc() {
  const rec = { rig: [], views: [], xrProps: [], resource: null, queue: [] };
  class Entity {
    constructor(name, app) {
      this.name = name;
      this.app = app;
      this.children = [];
      this.enabled = true;
    }
    destroy() {}
    addChild(c) {
      this.children.push(c);
    }
    addComponent(type, data) {
      if (type === 'camera') {
        const cam = { setXrProperties: (p) => rec.xrProps.push(p) };
        Object.defineProperty(cam, 'xrViews', { set: (v) => (rec.xrViews = v), get: () => rec.xrViews });
        this.camera = { layers: [0, 1, 2, 4, 3], ...data, camera: cam };
      }
      if (type === 'gsplat') this.gsplat = { ...data, setParameter() {}, deleteParameter() {}, setWorkBufferModifier() {} };
    }
    setLocalPosition(x, y, z) {
      this.pos = [x, y, z];
      if (this.name === 'inline3d-rig') rec.rigPos = this.pos;
    }
    setLocalRotation(x, y, z, w) {
      this.rot = [x, y, z, w];
      if (this.name === 'inline3d-rig') rec.rigRot = this.rot;
    }
    setLocalScale(x, y, z) {
      this.scl = [x, y, z];
      if (this.name === 'inline3d-rig') rec.rigScale = this.scl;
    }
    setLocalEulerAngles() {}
  }
  class AppBase {
    constructor(canvas) {
      this.canvas = canvas;
      this.root = new Entity('root', this);
      this.scene = { gsplat: {}, layers: { getLayerById: () => ({ addMeshInstances() {} }) } };
      this.resolutionMode = 'fixed';
      this.graphicsDevice = {};
      this.assets = {
        add() {},
        remove() {},
        load: (a) => {
          a.resource = rec.queue.length ? rec.queue.shift() : rec.resource;
          queueMicrotask(() => a._ready?.(a));
        },
      };
    }
    init(o) {
      this.opts = o;
    }
    start() {}
    tick() {
      rec.ticks = (rec.ticks || 0) + 1;
    }
    destroy() {}
  }
  class Camera {}
  Object.defineProperty(Camera.prototype, 'xrViews', { get() { return null; }, set() {} });
  class RenderView {
    setView(proj, pose) {
      this.proj = Float64Array.from(proj);
      this.pose = Float64Array.from(pose);
      rec.views.push(this);
    }
    setViewport(x, y, w, h) {
      this.vp = [x, y, w, h];
    }
  }
  const pc = {
    DEVICETYPE_WEBGL2: 'webgl2',
    RESOLUTION_FIXED: 'fixed',
    SHADERLANGUAGE_GLSL: 'glsl',
    TONEMAP_NONE: 6,
    LAYERID_SKYBOX: 2,
    createGraphicsDevice: async (canvas) => ({ canvas }),
    AppOptions: class {},
    AppBase,
    Entity,
    Camera,
    RenderView,
    Color: class {},
    Asset: class {
      constructor(name, type, file) {
        Object.assign(this, { name, type, file });
      }
      ready(cb) {
        this._ready = cb;
      }
      once() {}
      unload() {}
    },
    ShaderChunks: { get: () => ({ get: () => '', set() {} }) },
  };
  return { pc, rec };
}

/** A flat resource: a grid of centres at z ∈ [2, 2.9] in model space (in front of +z). */
function fakeFlat(n = 1000, off = 0) {
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    c[i * 3] = off + (i % 10) * 0.1 - 0.45;
    c[i * 3 + 1] = off + (Math.floor(i / 10) % 10) * 0.1 - 0.45;
    c[i * 3 + 2] = off + 2 + Math.floor(i / 100) * 0.1;
  }
  return { centers: c, gsplatData: { numSplats: n, meta: {} } };
}

function fakeWall() {
  const rec = { rigs: [], opts: null };
  const wall = {
    supported: true,
    addScene: (cv, onFrame, opts) => {
      rec.onFrame = onFrame;
      rec.opts = opts;
      return {
        exclude() {},
        unexclude() {},
        remove() {},
        setViewRig: (r) => rec.rigs.push(JSON.parse(JSON.stringify(r))),
      };
    },
  };
  return { wall, rec };
}

/** Two runtime views: eyes at ±32 mm in RIG space (attach), an off-axis skew of ±0.1 NDC. */
function twoViews(canvas) {
  const views = [-1, 1].map((sg) => {
    const P = Float32Array.from(perspectiveFov(40, 1280 / 720, 0.01, 100));
    P[8] += -sg * 0.1;
    const T = Float32Array.from(poseMatrix([sg * 0.032, 0, 0], [0, 0, 0, 1]));
    return { eye: sg < 0 ? 'left' : 'right', projectionMatrix: P, transform: { matrix: T } };
  });
  const layer = {
    getViewport: (v) => {
      const half = Math.floor(canvas.width / 2);
      return { x: v.eye === 'left' ? 0 : half, y: 0, width: half, height: canvas.height };
    },
  };
  return { views, layer };
}

async function bootPage(extra = {}) {
  installDom();
  const { pc, rec } = makeFakePc();
  rec.queue = [fakeFlat()];
  const { wall, rec: wrec } = fakeWall();
  const canvas = makeCanvas(640, 360);
  const out = {};
  await attachPlayCanvasSplat(out, extra.noWall ? null : wall, canvas, 'a.sog', { playcanvas: pc, controls: 'page', ...extra }, extra.pending || []);
  return { out, rec, wrec, canvas, pc };
}

// ── 1. option validation ────────────────────────────────────────────────────────────────────

test("resolveControls: 'viewer' (default) and 'page'; anything else throws, at call time", () => {
  assert.deepEqual(resolveControls({}), { page: false, comfortDepth: PAGE_COMFORT_DEPTH, ignored: [] });
  assert.equal(resolveControls({ controls: 'viewer' }).page, false);
  assert.equal(resolveControls({ controls: 'page' }).page, true);
  assert.throws(() => resolveControls({ controls: 'orbit' }), /controls "orbit" — expected 'viewer' or 'page'/);
  assert.throws(() => resolveControls({ controls: 'page', rig: 'display' }), /IS the\s+rig|camera rig/);
});

test('comfortDepth: default 0.3 (the shim’s depth); must be in (0, 1]', () => {
  assert.equal(PAGE_COMFORT_DEPTH, 0.3);
  assert.equal(resolveControls({ controls: 'page', comfortDepth: 0.5 }).comfortDepth, 0.5);
  assert.equal(resolveControls({ controls: 'page', comfortDepth: 1 }).comfortDepth, 1);
  for (const bad of [0, -0.1, 1.01, NaN, Infinity, '0.3']) {
    assert.throws(() => resolveControls({ controls: 'page', comfortDepth: bad }), /comfortDepth/, String(bad));
  }
});

test('the ignore-with-info list: exactly the viewer-camera options that were passed', () => {
  for (const k of ['fit', 'virtualDisplayHeight', 'orbit', 'idleSpin', 'focusInput']) {
    assert.ok(PAGE_IGNORED_OPTIONS.includes(k), k);
  }
  const r = resolveControls({ controls: 'page', fit: 'cover', orbit: true, idleSpin: 8, focusInput: true, virtualDisplayHeight: 0.2, perf: 'balanced' });
  assert.deepEqual(r.ignored, ['fit', 'virtualDisplayHeight', 'orbit', 'idleSpin', 'focusInput']);
  assert.deepEqual(resolveControls({ fit: 'cover' }).ignored, [], 'only on controls:page');
});

test('normalizeCameraPose: validates, defaults near/far, copies', () => {
  const m = camMatrix([0, 0, 0]);
  const p = normalizeCameraPose(m, { verticalFovDeg: 60 });
  assert.equal(p.near, MONO_NEAR);
  assert.equal(p.far, CAPTURE_FAR);
  assert.equal(p.convergence, null);
  m[12] = 99;
  assert.equal(p.matrixWorld[12], 0, 'a private copy: the page may reuse its array');
  const bad = [
    [[1, 2, 3], { verticalFovDeg: 60 }, /16 numbers/],
    [Object.assign(camMatrix([0, 0, 0]), { 5: NaN }), { verticalFovDeg: 60 }, /matrixWorld\[5\]/],
    [Float32Array.from([-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), { verticalFovDeg: 60 }, /mirrored/],
    [new Float32Array(16), { verticalFovDeg: 60 }, /singular/],
    [camMatrix([0, 0, 0]), {}, /verticalFovDeg/],
    [camMatrix([0, 0, 0]), { verticalFovDeg: 180 }, /verticalFovDeg/],
    [camMatrix([0, 0, 0]), { verticalFovDeg: 60, near: 0 }, /near/],
    [camMatrix([0, 0, 0]), { verticalFovDeg: 60, near: 1, far: 1 }, /far/],
    [camMatrix([0, 0, 0]), { verticalFovDeg: 60, convergence: -2 }, /convergence/],
  ];
  for (const [mm, o, re] of bad) assert.throws(() => normalizeCameraPose(mm, o), re);
});

// ── 2. the pure rig math ────────────────────────────────────────────────────────────────────

test('pageRigTRS: rig = Rx(180°)·M under flipY (the OpenCV→GL flip the splat entity carries)', () => {
  const t = pageRigTRS(camMatrix([0, 0, 0]), true);
  nearArr(t.rotation.map(Math.abs), [1, 0, 0, 0], 1e-12, 'identity camera → the half-turn');
  assert.equal(t.scale, 1);
  const noFlip = pageRigTRS(camMatrix([1, 2, 3], 30), false);
  nearArr(noFlip.position, [1, 2, 3], 1e-6);
  const M = camMatrix([0.3, -0.2, -1.5], 25);
  const F = [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1];
  nearArr(Array.from(pageRigMatrix(M, true)), Array.from(mat4Mul(F, M)), 1e-6, 'F·M');
});

test('a uniform scale in M is kept (page units → splat units); non-uniform is flagged', () => {
  const t = pageRigTRS(camMatrix([0, 1, 0], 10, 0.4), true);
  near(t.scale, 0.4, 1e-6);
  assert.equal(t.uniform, true);
  const m = camMatrix([0, 0, 0]);
  m[0] = 2;
  assert.equal(pageRigTRS(m, true).uniform, false);
  const ax = pageViewAxis(camMatrix([1, 2, 3], 90, 0.4));
  near(ax.scale, 0.4, 1e-6);
  nearArr(ax.forward, [-1, 0, 0], 1e-6, 'yaw 90° looks down −X');
});

test('pageViewRig is the shim’s buildRig: attach, fov, 1/d, m2v = depth·d/0.5, factors', () => {
  for (const [d, depth] of [[2, 0.3], [0.5, 0.3], [150, 0.3], [4, 0.5], [1, 1]]) {
    const r = pageViewRig({ verticalFovDeg: 60, convergence: d, comfortDepth: depth });
    assert.equal(r.type, 'camera');
    assert.deepEqual(r.position, { x: 0, y: 0, z: 0 });
    assert.deepEqual(r.orientation, { x: 0, y: 0, z: 0, w: 1 });
    near(r.verticalFov, 60 * DEG, 1e-12);
    near(r.convergenceDiopters, 1 / d, 1e-12);
    near(r.metersToVirtual, (depth * d) / 0.5, 1e-12);
    near(r.ipdFactor * r.metersToVirtual * r.convergenceDiopters * 0.5, depth, 1e-12, 'comfort = depth by construction');
    assert.equal(r.ipdFactor, 1);
    assert.equal(r.parallaxFactor, 1);
  }
  const f = pageViewRig({ verticalFovDeg: 50, convergence: 3, comfortDepth: 0.3, ipdFactor: 0.5, parallaxFactor: 0.25 });
  assert.equal(f.ipdFactor, 0.5);
  assert.equal(f.parallaxFactor, 0.25);
});

// ── 3. the adapter, end to end on the fake ──────────────────────────────────────────────────

test('ignored options are named ONCE in a console.info; no orbit/wheel listeners; idle spin off', async (t) => {
  const info = t.mock.method(console, 'info', () => {});
  installDom();
  const { pc, rec } = makeFakePc();
  rec.queue = [fakeFlat()];
  const canvas = makeCanvas(640, 360);
  const bound = [];
  canvas.addEventListener = (type) => bound.push(type);
  const out = {};
  await attachPlayCanvasSplat(out, null, canvas, 'a.sog', { playcanvas: pc, controls: 'page', orbit: true, idleSpin: 8, fit: 'cover', focusInput: true }, []);
  assert.equal(info.mock.callCount(), 1);
  assert.match(info.mock.calls[0].arguments[0], /controls:'page'.*fit, orbit, idleSpin, focusInput are ignored/);
  assert.deepEqual(bound, [], 'no pointer/wheel/dblclick/keyboard handlers: input is the page’s');
  assert.equal(out.viewer.idleSpin, 0);
  assert.equal(out.rig.type, 'camera', 'rig forced to camera semantics');
  out.remove();
});

test('setPose / resetPose throw on controls:page; setCameraPose throws on the default controls', async () => {
  const { out } = await bootPage({ noWall: true });
  assert.throws(() => out.setPose({ yaw: 10 }), /controls:'page'.*setCameraPose/s);
  assert.throws(() => out.resetPose(), /controls:'page'/);
  out.remove();
  installDom();
  const { pc, rec } = makeFakePc();
  rec.queue = [fakeFlat()];
  const o2 = {};
  await attachPlayCanvasSplat(o2, null, makeCanvas(320, 180), 'a.sog', { playcanvas: pc, focusInput: false }, []);
  assert.throws(() => o2.setCameraPose(camMatrix([0, 0, 0]), { verticalFovDeg: 60 }), /needs addSplat\(…, \{ controls:'page' \}\)/);
  o2.remove();
});

test('pose plumbing: matrix → rig-node TRS → RenderView = (runtime proj untouched, view.transform)', async () => {
  const { out, rec, wrec, canvas } = await bootPage();
  const M = camMatrix([0.2, -0.1, -0.5], 20);
  out.setCameraPose(M, { verticalFovDeg: 45, near: 0.005, far: 500 });
  const { views, layer } = twoViews(canvas);
  rec.views.length = 0;
  wrec.onFrame(views, layer);
  // the rig node: F·M
  const want = pageRigTRS(M, true);
  nearArr(rec.rigPos, want.position, 1e-9, 'rig position');
  nearArr(rec.rigRot, want.rotation, 1e-9, 'rig rotation');
  nearArr(rec.rigScale, [1, 1, 1], 1e-9, 'rig scale');
  // the eyes: pose = view.transform (rig space); projection = the runtime's, untouched
  // (its near 0.01 / far 100 are inside the page's 0.005 / 500, so the depth clamp is a no-op).
  const [l, r] = rec.views.slice(-2);
  nearArr(Array.from(l.pose), Array.from(views[0].transform.matrix), 1e-7, 'left pose');
  nearArr(Array.from(r.pose), Array.from(views[1].transform.matrix), 1e-7, 'right pose');
  nearArr(Array.from(l.proj), Array.from(views[0].projectionMatrix), 1e-7, 'left proj (skew kept)');
  nearArr(Array.from(r.proj), Array.from(views[1].projectionMatrix), 1e-7, 'right proj');
  assert.deepEqual(l.vp, [0, 0, 640, 360]);
  assert.deepEqual(r.vp, [640, 0, 640, 360]);
  // eye WORLD (content) = rig × view.transform — the attach pattern.
  const eyeWorld = mat4Mul(pageRigMatrix(M, true), views[1].transform.matrix);
  const F = [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1];
  const expect = mat4Mul(F, mat4Mul(M, views[1].transform.matrix));
  nearArr(Array.from(eyeWorld), Array.from(expect), 1e-6, 'eye world = F · matrixWorld · view.transform');
  // the page's near/far are a floor/cap on the depth mapping only
  out.setCameraPose(M, { verticalFovDeg: 45, near: 0.05, far: 20 });
  wrec.onFrame(views, layer);
  const l2 = rec.views[rec.views.length - 2];
  near(l2.proj[0], views[0].projectionMatrix[0], 1e-7, 'frustum x unchanged');
  near(l2.proj[8], views[0].projectionMatrix[8], 1e-7, 'skew unchanged');
  near(l2.proj[14] / (l2.proj[10] - 1), 0.05, 1e-6, 'near floored to the page’s');
  out.remove();
});

test('the rig is declared EVERY frame: camera, attach, page fov, 1/d, 0.3·d/0.5', async () => {
  const { out, wrec, canvas } = await bootPage();
  assert.equal(wrec.opts.virtualDisplayHeight, undefined, 'no display-rig height on controls:page');
  assert.equal(wrec.opts.viewRig.type, 'camera', 'the layer starts on a camera rig');
  const d = out.rig.convergence;
  assert.ok(d > 0, `waterfall convergence ${d}`);
  assert.ok(['median-disparity', 'nearest-clump', 'default', 'block'].includes(out.rig.focusSource), out.rig.focusSource);
  out.setCameraPose(camMatrix([0, 0, 0]), { verticalFovDeg: 50 });
  const { views, layer } = twoViews(canvas);
  const before = wrec.rigs.length;
  for (let i = 0; i < 3; i++) wrec.onFrame(views, layer);
  assert.equal(wrec.rigs.length - before, 3, 'one push per frame');
  const r = wrec.rigs[wrec.rigs.length - 1];
  assert.equal(r.type, 'camera');
  assert.deepEqual(r.position, { x: 0, y: 0, z: 0 });
  near(r.verticalFov, 50 * DEG, 1e-12);
  near(r.convergenceDiopters, 1 / d, 1e-9);
  near(r.metersToVirtual, (0.3 * d) / 0.5, 1e-9);
  out.remove();
});

test('comfortDepth reaches the rig: m2v = comfortDepth·d/0.5, comfort = comfortDepth', async () => {
  const { out, wrec, canvas } = await bootPage({ comfortDepth: 0.5 });
  out.setCameraPose(camMatrix([0, 0, 0]), { verticalFovDeg: 50, convergence: 4 });
  const { views, layer } = twoViews(canvas);
  wrec.onFrame(views, layer);
  const r = wrec.rigs[wrec.rigs.length - 1];
  near(r.convergenceDiopters, 0.25, 1e-12);
  near(r.metersToVirtual, (0.5 * 4) / 0.5, 1e-12);
  near(r.ipdFactor * r.metersToVirtual * r.convergenceDiopters * 0.5, 0.5, 1e-12);
  out.remove();
});

test('convergence is STABLE while the camera moves; a page value wins that frame; setSource re-estimates', async () => {
  const { out, rec, wrec, canvas } = await bootPage();
  const { views, layer } = twoViews(canvas);
  const d0 = out.rig.convergence;
  const seen = new Set();
  for (let i = 0; i < 20; i++) {
    out.setCameraPose(camMatrix([Math.sin(i) * 3, 0.1 * i, -i], i * 17), { verticalFovDeg: 60 });
    wrec.onFrame(views, layer);
    seen.add(wrec.rigs[wrec.rigs.length - 1].convergenceDiopters);
  }
  // One value across 20 poses (to float32 round-off in the matrices' own scale): no re-estimation.
  assert.ok(Math.max(...seen) - Math.min(...seen) < 1e-6 && Math.abs([...seen][0] - 1 / d0) < 1e-6, [...seen].join());
  out.setCameraPose(camMatrix([0, 0, 0]), { verticalFovDeg: 60, convergence: 7 });
  wrec.onFrame(views, layer);
  near(wrec.rigs[wrec.rigs.length - 1].convergenceDiopters, 1 / 7, 1e-12, 'page convergence');
  near(out.rig.convergence, 7, 1e-12);
  const f = out.getFocus();
  nearArr(f, [0, 0, -7], 1e-9, 'focus = the convergence point on the view axis (model space)');
  out.setCameraPose(camMatrix([0, 0, 0]), { verticalFovDeg: 60 });
  wrec.onFrame(views, layer);
  near(wrec.rigs[wrec.rigs.length - 1].convergenceDiopters, 1 / d0, 1e-9, 'back to the adapter’s own');
  // setSource: a farther cloud → the waterfall runs again → a new, again stable, d.
  rec.queue = [fakeFlat(1000, 5)];
  await out.setSource('b.sog');
  const d1 = out.rig.convergenceDefault;
  assert.ok(Math.abs(d1 - d0) > 0.5, `re-estimated on setSource: ${d0} → ${d1}`);
  wrec.onFrame(views, layer);
  near(wrec.rigs[wrec.rigs.length - 1].convergenceDiopters, 1 / d1, 1e-9);
  assert.equal(out.getCameraPose().matrixWorld[12], 0, 'setSource does not touch the page’s pose');
  out.remove();
});

test('a scaled matrixWorld: convergence in PAGE units = waterfall d / scale', async () => {
  const { out, wrec, canvas } = await bootPage();
  const { views, layer } = twoViews(canvas);
  const dm = out.rig.convergenceDefault;
  out.setCameraPose(camMatrix([0, 0, 0], 0, 0.4), { verticalFovDeg: 60 });
  wrec.onFrame(views, layer);
  near(1 / wrec.rigs[wrec.rigs.length - 1].convergenceDiopters, dm / 0.4, 1e-5);
  out.remove();
});

test('setFocus(point) sets d = its distance along the view axis (eased, or snapped); null goes back', async () => {
  const { out, wrec, canvas } = await bootPage();
  const { views, layer } = twoViews(canvas);
  const d0 = out.rig.convergenceDefault;
  const fired = [];
  out.onFocusChange = (p, info) => fired.push({ p, info });
  out.setCameraPose(camMatrix([0, 0, 0]), { verticalFovDeg: 60 });
  out.setFocus([0.5, 0.3, -3], { snap: true });
  wrec.onFrame(views, layer);
  near(out.rig.convergence, 3, 1e-9, 'plane distance, not radius');
  assert.equal(out.rig.focusSource, 'set');
  assert.equal(fired.at(-1).info.focusSource, 'set');
  nearArr(fired.at(-1).p, [0, 0, -3], 1e-9);
  out.setFocus([0, 0, -5]);
  wrec.onFrame(views, layer);
  assert.ok(out.rig.convergence > 3 && out.rig.convergence < 5, `eased: ${out.rig.convergence}`);
  for (let i = 0; i < 200; i++) wrec.onFrame(views, layer);
  near(out.rig.convergence, 5, 1e-3);
  out.setFocus(null, { snap: true });
  wrec.onFrame(views, layer);
  near(out.rig.convergence, d0, 1e-9);
  out.setFocus([0, 0, 4], { snap: true }); // behind the camera: refused, unchanged
  near(out.rig.convergence, d0, 1e-9);
  out.remove();
});

test('mono: exactly the page camera — identity under the rig, symmetric fov × canvas aspect', async () => {
  const { out, rec } = await bootPage({ noWall: true });
  const M = camMatrix([0, 0.2, -1], 30);
  out.setCameraPose(M, { verticalFovDeg: 42, near: 0.02, far: 300 });
  rec.views.length = 0;
  out.viewer._drawMono();
  const v = rec.views.at(-1);
  nearArr(Array.from(v.pose), Array.from(poseMatrix([0, 0, 0], [0, 0, 0, 1])), 1e-12, 'eye = rig');
  nearArr(Array.from(v.proj), Array.from(perspectiveFov(42, 640 / 360, 0.02, 300)), 1e-9, 'plain projection');
  assert.equal(v.proj[8], 0, 'principal point centred (no capture window)');
  assert.equal(v.proj[9], 0);
  nearArr(rec.rigRot, pageRigTRS(M, true).rotation, 1e-9);
  out.remove();
});

test('last call wins; a page that stops calling keeps its last pose; getCameraPose returns a copy', async () => {
  const { out, rec, wrec, canvas } = await bootPage();
  assert.equal(out.getCameraPose(), null, 'null before the first call');
  const { views, layer } = twoViews(canvas);
  out.setCameraPose(camMatrix([1, 0, 0]), { verticalFovDeg: 60 });
  out.setCameraPose(camMatrix([2, 0, 0]), { verticalFovDeg: 61 });
  out.setCameraPose(camMatrix([3, 0, 0]), { verticalFovDeg: 62, convergence: 2 });
  wrec.onFrame(views, layer);
  nearArr(rec.rigPos, [3, 0, 0], 1e-9);
  const pos = rec.rigPos.slice();
  for (let i = 0; i < 90; i++) wrec.onFrame(views, layer); // > 1 s of frames with no call
  nearArr(rec.rigPos, pos, 1e-12, 'no snapping to anything');
  const g = out.getCameraPose();
  assert.equal(g.verticalFovDeg, 62);
  assert.equal(g.convergence, 2);
  g.matrixWorld[12] = 99;
  assert.equal(out.getCameraPose().matrixWorld[12], 3);
  out.remove();
});

test('before the first setCameraPose the camera sits at the rest pose, with the resolved lens', async () => {
  const { out } = await bootPage({ noWall: true });
  assert.equal(out.getCameraPose(), null);
  // identity rest → M = Rx(180°) in model space → rig = F·M = identity.
  nearArr(pageRigTRS(out.viewer.page.matrix, true).rotation.map(Math.abs), [0, 0, 0, 1], 1e-12);
  assert.ok(out.viewer.page.fov > 10 && out.viewer.page.fov < 120, `${out.viewer.page.fov}`);
  out.remove();
});

test('pick works through the page camera: the centre ray finds the centre of the cloud', async () => {
  const { out } = await bootPage({ noWall: true });
  // Model space: the cloud sits at +z (2..2.9) around x=y=0. A GL camera at the origin looking
  // down model +z = yaw 180°.
  out.setCameraPose(camMatrix([0, 0, 0], 180), { verticalFovDeg: 60 });
  const p = out.pick(320, 180);
  assert.ok(p, 'hit');
  assert.ok(Math.abs(p[0]) < 0.11 && Math.abs(p[1]) < 0.11 && p[2] >= 2 - 1e-6, JSON.stringify(p));
  out.remove();
});

test('calls queued before the adapter loaded replay: the LAST setCameraPose lands', async () => {
  const pose = normalizeCameraPose(camMatrix([4, 0, 0]), { verticalFovDeg: 33 });
  const { out, rec } = await bootPage({ noWall: true, pending: [['setCameraPose', [pose.matrixWorld, pose]]] });
  assert.equal(out.getCameraPose().verticalFovDeg, 33);
  nearArr(rec.rigPos, [4, 0, 0], 1e-9);
  out.remove();
});

// ── 4. ./splat (imports three + Spark, so read as source) ───────────────────────────────────

test('./splat: controls validated at call time for BOTH engines; Spark refuses controls:page by name', () => {
  const src = fs.readFileSync(new URL('../js/inline3d-splat.js', import.meta.url), 'utf8');
  const i = src.indexOf('resolveControls(opts)');
  const j = src.indexOf("resolveSplatEngine(opts) === 'playcanvas'");
  assert.ok(i > 0 && i < j, 'before the engine split');
  assert.match(src, /controls:'page' is not supported on Spark/);
  assert.match(src, /setPose: page \? pageOnly\('setPose'\)/, 'the deferred stub throws setPose on page');
  assert.match(src, /if \(pendingPose\) pendingPose\[1\] =/, 'the stub keeps ONE pending pose');
});

test('the adapter imports no private copy of the shim rig: pageViewRig goes through cameraRigFromPose', () => {
  const src = fs.readFileSync(new URL('../js/inline3d-splat-playcanvas.js', import.meta.url), 'utf8');
  assert.match(src, /export function pageViewRig[\s\S]{0,400}cameraRigFromPose\(/);
  // perspectiveOffAxis stays the only projection builder (mono page camera = perspectiveFov → it).
  assert.equal(typeof perspectiveOffAxis, 'function');
  assert.equal(typeof quatFromMatrix, 'function');
});

// ── 5. onBeforeFrame — the page's step inside the adapter's frame ──────────────────────────

test('onBeforeFrame: validated (a function, controls:page only)', () => {
  assert.throws(() => resolveControls({ controls: 'page', onBeforeFrame: 3 }), /must be a function/);
  assert.throws(() => resolveControls({ onBeforeFrame: () => {} }), /needs controls:'page'/);
  assert.doesNotThrow(() => resolveControls({ controls: 'page', onBeforeFrame: () => {} }));
});

test('onBeforeFrame: a pose set INSIDE it is the one THIS frame’s RenderViews use (3D), before any tick', async () => {
  let k = 0;
  const frames = [];
  let rec;
  let ticksAtCall = [];
  const onBeforeFrame = (frame) => {
    frames.push(frame);
    ticksAtCall.push(rec.ticks || 0);
    k++;
    out.setCameraPose(camMatrix([k, 0, 0]), { verticalFovDeg: 50 });
  };
  let out;
  installDom();
  const fake = makeFakePc();
  rec = fake.rec;
  rec.queue = [fakeFlat()];
  const { wall, rec: wrec } = fakeWall();
  const canvas = makeCanvas(640, 360);
  out = {};
  await attachPlayCanvasSplat(out, wall, canvas, 'a.sog', { playcanvas: fake.pc, controls: 'page', onBeforeFrame }, []);
  const { views, layer } = twoViews(canvas);
  for (let f = 1; f <= 3; f++) {
    const ticksBefore = rec.ticks || 0;
    wrec.onFrame(views, layer);
    assert.equal(ticksAtCall.at(-1), ticksBefore, 'called before this frame’s engine tick');
    // the rig node this frame drew with = the pose set inside this frame's callback
    nearArr(rec.rigPos, [k, 0, 0], 1e-12, `frame ${f}`);
    const eye = rec.views.at(-1);
    nearArr(Array.from(mat4Mul(pageRigMatrix(camMatrix([k, 0, 0]), true), eye.pose)).slice(12, 15), [k + 0.032, 0, 0], 1e-6, 'eye world');
  }
  assert.equal(frames.length, 3, 'once per frame');
  assert.equal(frames[0].views, views, 'the runtime views in 3D');
  assert.equal(frames[0].dt, 0);
  assert.ok(frames[1].dt >= 0 && typeof frames[1].time === 'number');
  out.remove();
});

test('onBeforeFrame: views null in mono; a throw is warned ONCE and the loop keeps rendering', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const dom = installDom();
  const fake = makeFakePc();
  fake.rec.queue = [fakeFlat()];
  const got = [];
  const out = {};
  await attachPlayCanvasSplat(out, null, makeCanvas(640, 360), 'a.sog', {
    playcanvas: fake.pc,
    controls: 'page',
    onBeforeFrame: (f) => {
      got.push(f.views);
      throw new Error('page bug');
    },
  }, []);
  const ticks0 = fake.rec.ticks || 0;
  for (let i = 0; i < 4; i++) dom.flushRaf();
  assert.ok(got.length >= 4);
  assert.ok(got.every((v) => v === null), 'mono: views null');
  assert.ok((fake.rec.ticks || 0) - ticks0 >= 4, 'frames kept rendering');
  assert.equal(warn.mock.calls.filter((c) => /onBeforeFrame threw/.test(String(c.arguments[0]))).length, 1);
  out.remove();
});

test('F1000 shape: inv(M_splat)·camera.matrixWorld carries a uniform 0.4 scale — accepted, kept on the rig', async () => {
  // M_splat = T(0, 49.548, 0)·Rx(180°)·S(2.5) (F1000's castle); the game camera at world (0, 69.966, −5).
  const Ms = new Float64Array([2.5, 0, 0, 0, 0, -2.5, 0, 0, 0, 0, -2.5, 0, 0, 49.548, 0, 1]);
  const { mat4Invert } = await import('../js/inline3d-splat-playcanvas.js');
  const cam = poseMatrix([0, 69.966, -5], [0, 0, 0, 1]);
  const M = mat4Mul(mat4Invert(Ms), cam);
  const pose = normalizeCameraPose(M, { verticalFovDeg: 60, near: 0.1, far: 1850 });
  near(pageRigTRS(pose.matrixWorld, true).scale, 0.4, 1e-9);
  assert.equal(pageRigTRS(pose.matrixWorld, true).uniform, true);
  const { out, rec } = await bootPage({ noWall: true });
  out.setCameraPose(M, { verticalFovDeg: 60, near: 0.1, far: 1850 });
  nearArr(rec.rigScale, [0.4, 0.4, 0.4], 1e-9, 'the rig node carries the scale');
  // camera in splat space: inv(Ms)·(0,69.966,−5) = ((0)/2.5, −(69.966−49.548)/2.5, 5/2.5)
  nearArr(Array.from(pose.matrixWorld).slice(12, 15), [0, -8.1672, 2], 1e-4, 'the plan’s rest (0, −8.167, 2.0)');
  out.remove();
});

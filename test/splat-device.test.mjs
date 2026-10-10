// addSplat(…, { engine: 'playcanvas', device }) — the opt-in WebGPU device (./inline3d-splat-device.js).
//
// The resolution rules are pure and tested as a table; the adapter is driven against a RECORDING
// fake of the engine (what device it asks for, what projections reach the RenderViews, what the
// handle reports). Pixels are the panel's job (docs/playcanvas-adapter.md § WebGPU (opt-in)).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SPLAT_DEVICES,
  resolveDeviceOption,
  glslOnlyOptions,
  resolveSplatDevice,
  platformFacts,
  adapterLabel,
  deviceLogLine,
  toClipWebGpu,
  patchGsplatFootprintWgslModule,
  wrapWgslFootprint,
  gpuBufferLimits,
  propagateStoresAcrossCameras,
  wrapFrameGraphStores,
  wrapGsplatManagerParams,
} from '../js/inline3d-splat-device.js';
import { getEffectChunks } from '../js/inline3d-splat-effects.js';
import { attachPlayCanvasSplat, perspectiveFov, poseMatrix } from '../js/inline3d-splat-playcanvas.js';
import { installDom, makeCanvas } from './stubs.mjs';

const near = (a, b, eps, what = '') => assert.ok(Math.abs(a - b) < eps, `${what} ${a} !~= ${b}`);

// ── 1. the option ───────────────────────────────────────────────────────────────────────────

test("device: 'webgl2' (default) | 'webgpu' | 'auto'; anything else throws", () => {
  assert.deepEqual([...SPLAT_DEVICES], ['webgl2', 'webgpu', 'auto']);
  assert.equal(resolveDeviceOption(undefined), 'webgl2');
  assert.equal(resolveDeviceOption(null), 'webgl2');
  for (const v of SPLAT_DEVICES) assert.equal(resolveDeviceOption(v), v);
  for (const bad of ['WebGPU', 'webgl', 'gpu', true, 1]) assert.throws(() => resolveDeviceOption(bad), /device '.*' — expected 'webgl2', 'webgpu' or 'auto'/, String(bad));
});

test('glslOnlyOptions: reveal (until WGSL effects), cursor depth, the N-camera path; NOT feather/antialias/etc.', () => {
  assert.deepEqual(glslOnlyOptions({}), []);
  // show's stage options: none of them forces WebGL2
  const stage = { feather: 28, antialias: true, renderScale: 0.6, captureFit: 'cover', perf: 'exact', rig: 'auto', firstWovenHoldMs: 1200, convergence: 1.2, displayRigLayers: ['UI'], controls: 'viewer' };
  assert.deepEqual(glslOnlyOptions(stage), []);
  assert.deepEqual(glslOnlyOptions({ reveal: 'assemble' }), ['reveal']);
  assert.deepEqual(glslOnlyOptions({ reveal: { type: 'sweep' } }), ['reveal']);
  assert.deepEqual(glslOnlyOptions({ reveal: false }), []);
  assert.deepEqual(glslOnlyOptions({ reveal: 'assemble' }, { wgslEffects: true }), [], 'WGSL effect chunks lift the reveal rule');
  assert.deepEqual(glslOnlyOptions({ cursor: 'depth' }), ["cursor:'depth'"]);
  assert.deepEqual(glslOnlyOptions({ cursor: { color: '#fff' } }), ["cursor:'depth'"]);
  assert.deepEqual(glslOnlyOptions({ playcanvasViewPath: 'cameras' }), ["playcanvasViewPath:'cameras'"]);
  assert.deepEqual(glslOnlyOptions({ reveal: 'fade', cursor: 'depth' }), ['reveal', "cursor:'depth'"]);
});

// ── 2. the resolution rules ─────────────────────────────────────────────────────────────────

const OK = { gpu: true, inline3d: true, displayxr: true, windows: true, glslOnly: [], viewCount: 2, adapter: { info: {} } };

test('resolveSplatDevice: the rule table', () => {
  const cases = [
    // [facts, device, reason pattern]
    [{ ...OK, requested: 'webgl2' }, 'webgl2', /^requested$/],
    [{ ...OK, requested: 'webgpu' }, 'webgpu', /^requested$/],
    [{ ...OK, requested: 'auto' }, 'webgpu', /^auto$/],
    [{ ...OK, requested: 'webgpu', gpu: false }, 'webgl2', /navigator\.gpu is absent/],
    [{ ...OK, requested: 'webgpu', adapter: null }, 'webgl2', /requestAdapter\(\) returned null/],
    [{ ...OK, requested: 'webgpu', viewCount: 1 }, 'webgl2', /the tile renders 1 view \(WebGPU splat stereo needs exactly 2\)/],
    [{ ...OK, requested: 'webgpu', viewCount: 4 }, 'webgl2', /the tile renders 4 views/],
    [{ ...OK, requested: 'webgpu', viewCount: 0 }, 'webgl2', /no stereo view list from the session/],
    [{ ...OK, requested: 'webgpu', inline3d: false, displayxr: false }, 'webgl2', /no inline-3D session/],
    [{ ...OK, requested: 'webgpu', glslOnly: ['reveal'] }, 'webgl2', /GLSL-only option reveal/],
    [{ ...OK, requested: 'webgpu', glslOnly: ['reveal', "cursor:'depth'"] }, 'webgl2', /GLSL-only options reveal, cursor:'depth'/],
    // 'webgpu' does not care about the platform; 'auto' does
    [{ ...OK, requested: 'webgpu', windows: false, displayxr: false }, 'webgpu', /^requested$/],
    [{ ...OK, requested: 'auto', windows: false }, 'webgl2', /auto: not Windows/],
    [{ ...OK, requested: 'auto', displayxr: false }, 'webgl2', /auto: not the DisplayXR Browser/],
    [{ ...OK, requested: 'auto', gpu: false }, 'webgl2', /navigator\.gpu is absent/],
    [{ ...OK, requested: 'auto', glslOnly: ['reveal'] }, 'webgl2', /GLSL-only/],
  ];
  for (const [f, device, reason] of cases) {
    const r = resolveSplatDevice(f);
    assert.equal(r.device, device, JSON.stringify(f));
    assert.match(r.reason, reason, JSON.stringify(f));
  }
});

test('resolveSplatDevice: asks for the view count, then the adapter, only when the cheap rules pass', () => {
  const base = { requested: 'webgpu', gpu: true, inline3d: true, displayxr: true, windows: true, glslOnly: [] };
  assert.deepEqual(resolveSplatDevice(base), { device: null, need: 'views' });
  assert.deepEqual(resolveSplatDevice({ ...base, viewCount: 2 }), { device: null, need: 'adapter' });
  // a cheap rule that fails never waits for views or an adapter
  assert.equal(resolveSplatDevice({ ...base, gpu: false }).device, 'webgl2');
  assert.equal(resolveSplatDevice({ ...base, glslOnly: ['reveal'] }).device, 'webgl2');
  assert.equal(resolveSplatDevice({ ...base, viewCount: 1 }).device, 'webgl2', 'a bad view count never probes an adapter');
});

test('platformFacts: navigator.gpu, the session, XRDisplayLayer, Windows', () => {
  const g = (nav, layer) => ({ navigator: nav, XRDisplayLayer: layer });
  const win = { gpu: {}, userAgentData: { platform: 'Windows' } };
  assert.deepEqual(platformFacts({ supported: true }, g(win, function () {})), { gpu: true, inline3d: true, displayxr: true, windows: true });
  assert.equal(platformFacts({ supported: false }, g(win, function () {})).displayxr, false, 'no session: not the DisplayXR tier');
  assert.equal(platformFacts({ supported: true }, g(win, undefined)).displayxr, false);
  assert.equal(platformFacts(null, g({ platform: 'Win32' })).windows, true);
  assert.equal(platformFacts(null, g({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })).windows, true);
  assert.equal(platformFacts(null, g({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Darwin' })).windows, false);
  assert.equal(platformFacts(null, g({ platform: 'Linux x86_64' })).gpu, false);
});

test('the boot line and adapter label', () => {
  assert.equal(adapterLabel({ info: { vendor: 'nvidia', architecture: 'ampere', description: 'RTX 3080' } }), 'nvidia/ampere (RTX 3080)');
  assert.equal(adapterLabel({ info: { vendor: 'intel' } }), 'intel');
  assert.equal(adapterLabel(null), 'unknown');
  assert.equal(deviceLogLine({ requested: 'webgpu', device: 'webgpu', reason: 'requested', adapter: 'nvidia/ampere' }), '[inline3d/splat] device=webgpu adapter=nvidia/ampere (requested webgpu)');
  assert.equal(deviceLogLine({ requested: 'webgpu', device: 'webgl2', reason: 'navigator.gpu is absent' }), '[inline3d/splat] device=webgl2 (requested webgpu; fallback: navigator.gpu is absent)');
  assert.equal(deviceLogLine({ requested: 'webgl2', device: 'webgl2', reason: 'requested' }), '[inline3d/splat] device=webgl2 (requested webgl2)');
});

// ── 3. the WebGPU pieces ────────────────────────────────────────────────────────────────────

test('toClipWebGpu: GL clip z -1..1 → WebGPU 0..1 (near → 0, far → 1), x / y / w untouched', () => {
  const n = 0.1;
  const f = 100;
  const P = perspectiveFov(50, 16 / 9, n, f);
  P[8] = 0.1; // an off-axis eye
  const Q = toClipWebGpu(P);
  const clip = (M, z) => {
    const v = [0, 0, z, 1];
    const o = [0, 0, 0, 0];
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) o[r] += M[c * 4 + r] * v[c];
    return o;
  };
  near(clip(Q, -n)[2] / clip(Q, -n)[3], 0, 1e-6, 'near');
  near(clip(Q, -f)[2] / clip(Q, -f)[3], 1, 1e-5, 'far');
  near(clip(P, -n)[2] / clip(P, -n)[3], -1, 1e-6, 'GL near (unchanged input)');
  for (const i of [0, 1, 3, 4, 5, 7, 8, 9, 11, 12, 13, 15]) assert.equal(Q[i], Math.fround(P[i]), `element ${i}`);
});

// The two WGSL footprint sites as playcanvas 2.22.3 writes them (anchors only).
const PROJECTOR = `
  let w1 = vec3f(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  let J1 = focal / vz;
  let J2 = -J1 / vz * v.xy;
  let tt1 = J1 * w1 + J2.y * w2;
  let p = viewProj * vec4f(c, 1.0); let h = viewportHeight;`;
const RASTER = `
  let focal = ub_view.viewport_size.x * center.projMat00;
  let J1 = focal / vp.z;
  let J2 = -J1 / vp.z * vp.xy;
  let J = mat3x3f(vec3f(J1, 0.0, J2.x), vec3f(0.0, J1, J2.y), vec3f(0.0, 0.0, 0.0));
  let m = ub_view.matrix_projection;`;

test('patchGsplatFootprintWgslModule: both 2.22.3 sites, idempotent, untouched on a miss', () => {
  const a = patchGsplatFootprintWgslModule(PROJECTOR);
  assert.equal(a.ok, true);
  assert.match(a.src, /let J1y = \(viewportHeight \* abs\(\(viewProj \* vec4f\(w1, 0\.0\)\)\.y\)\) \/ vz;/);
  assert.match(a.src, /let tt1 = J1y \* w1 \+ J2\.y \* w2;/);
  const b = patchGsplatFootprintWgslModule(RASTER);
  assert.equal(b.ok, true);
  assert.match(b.src, /ub_view\.viewport_size\.y \* abs\(ub_view\.matrix_projection\[1\]\[1\]\)/);
  assert.match(b.src, /vec3f\(0\.0, J1y, J2\.y\)/);
  assert.deepEqual(patchGsplatFootprintWgslModule(a.src), { src: a.src, ok: true }, 'idempotent');
  const miss = 'let J2 = something_else;';
  assert.deepEqual(patchGsplatFootprintWgslModule(miss), { src: miss, ok: false });
});

test('wrapWgslFootprint: patches at createShaderModule, counts, wraps a device once', () => {
  const seen = [];
  const dev = { limits: { maxTextureDimension2D: 16384 }, createShaderModule: (d) => (seen.push(d.code), {}) };
  const stats = wrapWgslFootprint(dev);
  assert.equal(wrapWgslFootprint(dev), stats, 'once per device');
  dev.createShaderModule({ code: PROJECTOR });
  dev.createShaderModule({ code: 'fn main() {}' });
  dev.createShaderModule({ code: 'let J2 = nope;' });
  assert.deepEqual({ ...stats }, { seen: 2, patched: 1 });
  assert.match(seen[0], /dxrFocalY/);
  assert.equal(seen[1], 'fn main() {}');
  assert.deepEqual(gpuBufferLimits(dev), { maxW: 16384, maxH: 16384, nameW: 'maxTextureDimension2D', nameH: 'maxTextureDimension2D', valueW: 16384, valueH: 16384 });
  assert.equal(gpuBufferLimits({}), null);
});

test('the WGSL twins the adapter takes from the effects module exist (overlay, feather, effects)', () => {
  const w = getEffectChunks('wgsl');
  assert.equal(typeof w.chunks.gsplatModifyVS, 'function', 'effects on WebGPU: so reveal is not GLSL-only');
  for (const src of [w.overlay.feather.vertex, w.overlay.snapshot.vertex]) assert.match(src, /@vertex/);
  for (const src of [w.overlay.feather.fragment, w.overlay.snapshot.scale, w.overlay.snapshot.add]) assert.match(src, /@fragment/);
  assert.match(w.overlay.snapshot.scale, /uniform dxrSnapOver/);
});

// ── 4. the adapter, against a recording engine ──────────────────────────────────────────────

function makeFakePc({ webgpuBoots = true } = {}) {
  const rec = { views: [], devices: [], modules: [], queue: [] };
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
        const cam = { setXrProperties() {} };
        Object.defineProperty(cam, 'xrViews', { set: (v) => (rec.xrViews = v), get: () => rec.xrViews });
        this.camera = { layers: [0, 1, 2, 4, 3], ...data, camera: cam };
      }
      if (type === 'gsplat') this.gsplat = { ...data, setParameter() {}, deleteParameter() {}, setWorkBufferModifier() {} };
    }
    setLocalPosition() {}
    setLocalRotation() {}
    setLocalScale() {}
    setLocalEulerAngles() {}
  }
  class AppBase {
    constructor(canvas) {
      this.canvas = canvas;
      this.root = new Entity('root', this);
      this.scene = { gsplat: {}, layers: { getLayerById: () => ({ addMeshInstances() {} }) } };
      this.resolutionMode = 'fixed';
      this.frameGraph = { renderPasses: [], compile() { rec.compiles = (rec.compiles || 0) + 1; } };
      rec.frameGraph = this.frameGraph;
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
      this.graphicsDevice = o.graphicsDevice;
    }
    start() {}
    tick() {}
    destroy() {}
  }
  class Camera {}
  Object.defineProperty(Camera.prototype, 'xrViews', { get() { return null; }, set() {} });
  class RenderView {
    setView(proj, pose) {
      this.proj = Float64Array.from(proj);
      rec.views.push(this);
    }
    setViewport() {}
  }
  const pc = {
    DEVICETYPE_WEBGL2: 'webgl2',
    DEVICETYPE_WEBGPU: 'webgpu',
    RESOLUTION_FIXED: 'fixed',
    SHADERLANGUAGE_GLSL: 'glsl',
    TONEMAP_NONE: 6,
    LAYERID_SKYBOX: 2,
    createGraphicsDevice: async (canvas, o) => {
      rec.devices.push(o.deviceTypes.slice());
      if (o.deviceTypes[0] === 'webgpu') {
        if (!webgpuBoots) return { isWebGL2: true, canvas }; // the engine fell back on its own
        const wgpu = { limits: { maxTextureDimension2D: 8192 }, createShaderModule: (d) => (rec.modules.push(d.code), {}), lost: new Promise(() => {}) };
        return { isWebGPU: true, wgpu, gpuAdapter: { info: { vendor: 'fake', architecture: 'gpu' } }, canvas };
      }
      return { isWebGL2: true, canvas };
    },
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

function fakeFlat(n = 1000) {
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    c[i * 3] = (i % 10) * 0.1 - 0.45;
    c[i * 3 + 1] = (Math.floor(i / 10) % 10) * 0.1 - 0.45;
    c[i * 3 + 2] = 2 + Math.floor(i / 100) * 0.1;
  }
  return { centers: c, gsplatData: { numSplats: n, meta: {} } };
}

function frames(count) {
  const sgs = count === 1 ? [0] : count === 2 ? [-1, 1] : Array.from({ length: count }, (_, i) => -1 + (2 * i) / (count - 1));
  return sgs.map((sg, i) => {
    const P = Float32Array.from(perspectiveFov(40, 1280 / 720, 0.01, 100));
    P[8] += -sg * 0.1;
    return { eye: count === 2 ? (i ? 'right' : 'left') : count === 1 ? 'none' : `v${i}`, _i: i, _n: count, projectionMatrix: P, transform: { matrix: Float32Array.from(poseMatrix([sg * 0.032, 0, 0], [0, 0, 0, 1])) } };
  });
}

/**
 * Boot a tile with a fake session that delivers `viewCount` views per frame — or `seq[i]` on frame
 * i (the last entry repeats). `activeViewCount`: the display's active mode, already read.
 */
async function boot({ device, viewCount = 2, seq = null, activeViewCount, gpu = true, adapter = true, webgpuBoots = true, extra = {} } = {}) {
  let frameNo = 0;
  const countAt = () => (seq ? seq[Math.min(frameNo++, seq.length - 1)] : viewCount);
  installDom();
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const nav = { platform: 'Win32' };
  if (gpu) nav.gpu = { requestAdapter: async () => (adapter ? { info: { vendor: 'fake' } } : null) };
  Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true });
  const logs = [];
  const info = console.info;
  const warn = console.warn;
  console.info = (...a) => logs.push(a.join(' '));
  console.warn = (...a) => logs.push(a.join(' '));
  const { pc, rec } = makeFakePc({ webgpuBoots });
  rec.queue = [fakeFlat(), fakeFlat()];
  const canvas = makeCanvas(640, 360);
  const wrec = {};
  const wall = {
    supported: true,
    ...(activeViewCount ? { _activeViewCount: activeViewCount } : {}),
    addScene: (cv, onFrame) => {
      wrec.onFrame = onFrame;
      return { exclude() {}, unexclude() {}, remove() {}, setViewRig() {} };
    },
  };
  const layer = {
    getViewport: (v) => {
      const w = Math.floor(canvas.width / v._n);
      return { x: v._i * w, y: 0, width: w, height: canvas.height };
    },
  };
  const out = {};
  // The session's frames run while the tile boots (the device choice waits for the first one).
  const timer = setInterval(() => wrec.onFrame?.(frames(countAt()), layer), 5);
  try {
    await attachPlayCanvasSplat(out, wall, canvas, 'a.sog', { playcanvas: pc, focusInput: false, orbit: false, ...(device ? { device } : {}), ...extra }, []);
    rec.views.length = 0;
    wrec.onFrame(frames(seq ? seq[seq.length - 1] : viewCount), layer);
  } finally {
    clearInterval(timer);
    console.info = info;
    console.warn = warn;
    if (saved) Object.defineProperty(globalThis, 'navigator', saved);
    else delete globalThis.navigator;
  }
  return { out, rec, logs, canvas };
}

test("default (no device): WebGL2 exactly as before — ['webgl2'], no boot line, handle.device 'webgl2'", async () => {
  const { out, rec, logs } = await boot();
  assert.deepEqual(rec.devices, [['webgl2']]);
  assert.equal(out.device, 'webgl2');
  assert.deepEqual({ ...out.deviceInfo }, { requested: 'webgl2', device: 'webgl2', reason: 'requested', adapter: null });
  assert.equal(logs.filter((l) => l.includes('device=')).length, 0, 'silent by default');
  assert.equal(rec.modules.length, 0);
});

test("device:'webgpu', 2 views, adapter: asks the engine for ['webgpu'] ONLY; clip-depth projections; one boot line", async () => {
  const { out, rec, logs, canvas } = await boot({ device: 'webgpu' });
  assert.deepEqual(rec.devices, [['webgpu']]);
  assert.equal(out.device, 'webgpu');
  assert.equal(out.deviceInfo.adapter, 'fake/gpu');
  assert.deepEqual(logs.filter((l) => l.includes('device=')), ['[inline3d/splat] device=webgpu adapter=fake/gpu (requested webgpu)']);
  // every RenderView projection is the runtime's, z row converted: z' = (z + w) / 2
  assert.equal(rec.views.length, 2);
  const P = frames(2)[0].projectionMatrix;
  for (let c = 0; c < 4; c++) near(rec.views[0].proj[c * 4 + 2], 0.5 * (P[c * 4 + 2] + P[c * 4 + 3]), 1e-6, `z row col ${c}`);
  near(rec.views[0].proj[8], P[8], 1e-7, 'x skew untouched');
  // the store is clamped against the DEVICE's maxTextureDimension2D, not a WebGL probe
  assert.ok(canvas.width <= 8192 && canvas.width > 0);
});

test('webgpu → WebGL2 fallbacks: no navigator.gpu, null adapter, 1 view, GLSL-only option, engine fell back', async () => {
  const cases = [
    [{ device: 'webgpu', gpu: false }, /navigator\.gpu is absent/, [['webgl2']]],
    [{ device: 'webgpu', adapter: false }, /requestAdapter\(\) returned null/, [['webgl2']]],
    [{ device: 'webgpu', viewCount: 4 }, /the tile renders 4 views/, [['webgl2']]],
    [{ device: 'webgpu', extra: { cursor: 'depth' } }, /GLSL-only option cursor:'depth'/, [['webgl2']]],
    [{ device: 'webgpu', webgpuBoots: false }, /WebGPU boot failed/, [['webgpu']]],
  ];
  const base = (await boot()).rec.views.map((v) => Array.from(v.proj)); // a default WebGL2 tile's projections
  for (const [o, why, asked] of cases) {
    const { out, rec, logs } = await boot(o);
    assert.equal(out.device, 'webgl2', JSON.stringify(o));
    assert.match(out.deviceInfo.reason, why, JSON.stringify(o));
    assert.deepEqual(rec.devices, asked, JSON.stringify(o));
    const line = logs.find((l) => l.includes('device='));
    assert.match(line, /^\[inline3d\/splat\] device=webgl2 \(requested webgpu; fallback: /);
    // WebGL2 projections are untouched: the same as a default tile's, element for element
    if (!o.viewCount) assert.deepEqual(rec.views.map((v) => Array.from(v.proj)), base, JSON.stringify(o));
  }
});

test('the WebGPU tile: setVideo rejects and makeSbsMaterial throws (GLSL materials, no twin yet)', async () => {
  const { out, logs } = await boot({ device: 'webgpu' });
  assert.equal(out.device, 'webgpu');
  assert.equal(logs.filter((l) => /device=webgpu: /.test(l) && !/adapter=/.test(l)).length, 0, 'nothing else said at boot');
  await assert.rejects(out.setVideo('a.mp4'), /setVideo\(\) draws through a GLSL material and is not available on device:'webgpu'/);
  assert.throws(() => out.makeSbsMaterial({}), /makeSbsMaterial\(\) is a GLSL material/);
});

test('the view gate counts the views the tile RENDERS: 1-view session frames (mono fallback) then 2 → webgpu', async () => {
  const { out, rec } = await boot({ device: 'webgpu', seq: [1, 1, 1, 1, 2] });
  assert.equal(out.device, 'webgpu', out.deviceInfo?.reason);
  assert.deepEqual(rec.devices, [['webgpu']]);
});

test("the view gate: the display's active mode, when already read, answers without waiting for a frame", async () => {
  const { out } = await boot({ device: 'webgpu', viewCount: 1, activeViewCount: 2 });
  assert.equal(out.device, 'webgpu', out.deviceInfo?.reason);
  const quad = await boot({ device: 'webgpu', viewCount: 4, activeViewCount: 4 });
  assert.equal(quad.out.device, 'webgl2');
  assert.match(quad.out.deviceInfo.reason, /the tile renders 4 views/);
});

// setLayerRig('display') on WebGPU turned an MSAA tile BLACK: each camera's passes sit in their own
// FramePassMultiView wrapper, compiled with a fresh render-target map, so the eye pass discarded the
// back buffer the display camera then loaded.
const pass = (rt, { clear = false, clearDepth = false } = {}) => ({
  renderTarget: rt,
  colorArrayOps: [{ clear, store: false }],
  depthStencilOps: { clearDepth, clearStencil: clearDepth, storeDepth: false, storeStencil: false },
});

test('propagateStoresAcrossCameras: a later camera that LOADS the target makes the earlier pass store it, across wrappers', () => {
  const eye = pass(null, { clear: true, clearDepth: true }); // the eye camera: clears the back buffer
  const display = pass(null, { clear: false, clearDepth: true }); // setLayerRig display: loads colour, own depth
  const post = pass(null, { clear: false, clearDepth: false }); // the post run: loads both
  const live = pass({ id: 'rt' }, { clear: true, clearDepth: true }); // the live outgoing target: its own
  const wrappers = [{ children: [live] }, { children: [eye] }, { children: [display] }, { children: [post] }];
  const n = propagateStoresAcrossCameras(wrappers);
  assert.equal(eye.colorArrayOps[0].store, true, 'eye colour stored for the display camera');
  assert.equal(eye.depthStencilOps.storeDepth, false, 'the display camera clears depth: nothing to keep');
  assert.equal(display.colorArrayOps[0].store, true);
  assert.equal(display.depthStencilOps.storeDepth, true, 'post loads depth');
  assert.equal(post.colorArrayOps[0].store, false, 'nothing after it');
  assert.equal(live.colorArrayOps[0].store, false, 'another target is untouched');
  assert.equal(n, 4);
  // one camera alone: nothing raised (a single tile without setLayerRig is unchanged)
  const solo = pass(null, { clear: true, clearDepth: true });
  assert.equal(propagateStoresAcrossCameras([{ children: [solo] }]), 0);
  assert.equal(solo.colorArrayOps[0].store, false);
});

test('wrapFrameGraphStores: runs after the engine compile, once per graph; installed on a WebGPU tile only', async () => {
  const eye = pass(null, { clear: true, clearDepth: true });
  const next = pass(null);
  const g = { renderPasses: [{ children: [eye] }, { children: [next] }], compile() { this.compiled = true; } };
  assert.equal(wrapFrameGraphStores(g), true);
  assert.equal(wrapFrameGraphStores(g), false, 'once');
  g.compile();
  assert.equal(g.compiled, true);
  assert.equal(eye.colorArrayOps[0].store, true);
  const gpu = await boot({ device: 'webgpu' });
  assert.equal(gpu.rec.frameGraph._dxrStores, true);
  const gl = await boot();
  assert.equal(gl.rec.frameGraph._dxrStores, undefined, 'WebGL2: the engine graph is untouched');
});

test("wrapGsplatManagerParams: each manager's update (its projector dispatch) sees its mesh instance's dxrFx_* values; the material is restored", () => {
  const mat = { parameters: { dxrFx_t_amount: { data: 1 }, other: { data: 7 } }, setParameter(k, v) { this.parameters[k] = { data: v }; }, deleteParameter(k) { delete this.parameters[k]; } };
  const seen = [];
  const mgr = (amount) => ({
    renderer: { meshInstance: { parameters: { dxrFx_t_amount: { data: amount }, engineOwn: { data: 99 } } } },
    update() { seen.push({ amount: mat.parameters.dxrFx_t_amount.data, own: mat.parameters.engineOwn }); return 5; },
  });
  const live = mgr(0.25);
  const eye = mgr(0.75);
  const director = { camerasMap: new Map([['live', { layersMap: new Map([[1, { gsplatManager: live }]]) }], ['eye', { layersMap: new Map([[0, { gsplatManager: eye }]]) }]]) };
  assert.equal(wrapGsplatManagerParams(director, () => mat), 2);
  assert.equal(wrapGsplatManagerParams(director, () => mat), 0, 'once per manager');
  assert.equal(live.update(), 5);
  eye.update();
  assert.deepEqual(seen, [{ amount: 0.25, own: undefined }, { amount: 0.75, own: undefined }], 'only the SDK effect values are carried over');
  assert.equal(mat.parameters.dxrFx_t_amount.data, 1, 'restored');
  assert.equal(mat.parameters.other.data, 7);
});

test('wrapGsplatManagerParams in the DWELL: no per-side values on any mesh instance → every projector sees the material at rest, untouched', () => {
  const rest = { dxrFx_transition_amount: { data: 1 } };
  const mat = { parameters: { ...rest }, writes: 0, setParameter(k, v) { this.writes++; this.parameters[k] = { data: v }; }, deleteParameter(k) { this.writes++; delete this.parameters[k]; } };
  const seen = [];
  const m = { renderer: { meshInstance: { parameters: {} } }, update() { seen.push(mat.parameters.dxrFx_transition_amount.data); } };
  wrapGsplatManagerParams({ camerasMap: new Map([['eye', { layersMap: new Map([[0, { gsplatManager: m }]]) }]]) }, mat);
  for (let i = 0; i < 3; i++) m.update();
  assert.deepEqual(seen, [1, 1, 1], 'the rest value (amount 1 = untouched photo) every frame');
  assert.equal(mat.writes, 0, 'the material is not written at all between transitions');
  // a transition's side values, then its removal (driveShared.remove deletes them): back to rest
  m.renderer.meshInstance.parameters.dxrFx_transition_amount = { data: 0.3 };
  m.update();
  delete m.renderer.meshInstance.parameters.dxrFx_transition_amount;
  m.update();
  assert.deepEqual(seen.slice(3), [0.3, 1]);
  assert.equal(mat.parameters.dxrFx_transition_amount.data, 1);
});

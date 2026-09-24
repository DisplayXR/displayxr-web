// addModel's PlayCanvas backend (the default from 1.12) and the ./model router — everything that
// decides a route, a string, a call or a number before the GPU is touched: engine resolution and
// the fallback, call-time option validation, the synchronous handle and its pre-load queue, the
// decoder wiring (Draco / Basis through the engine's readers, meshopt through the bufferView
// hook), framing from mesh-instance bounds, the lighting defaults, and the named-import engine
// module covering every engine member the adapters read.
//
// A RECORDING fake engine, no `playcanvas` and no `three` installed (the suite is dependency-free):
// the pixels, the Khronos MAE table and the real decoders are gated headless in the browser
// (docs/playcanvas-model-backend.md §Gates).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { addModel, resolveModelEngine, validateModelCall, MODEL_ENGINES } from '../js/inline3d-model-entry.js';
import {
  attachPlayCanvasModel,
  validatePlayCanvasModelOptions,
  normalizeDecoderPath,
  declaredExtensions,
  gltfJsonOf,
  meshoptBufferViewHook,
  neutralStudioRGBE,
  neutralStudioRadiance,
  roomRadiance,
  roomEquirect,
  roomRGBE,
  prepareTransmission,
  ROOM_ENVIRONMENT,
  ROOM_YAW_DEG,
  boundsOfEntity,
  aimDownAt,
  decoderError,
  PC_DECODERS,
  NEUTRAL_STUDIO,
} from '../js/inline3d-model-playcanvas.js';
import { PLAYCANVAS_SYSTEMS, PLAYCANVAS_HANDLERS, TONE_MAPPINGS } from '../js/inline3d-splat-playcanvas.js';
import { installDom, makeCanvas } from './stubs.mjs';

const JS = join(dirname(fileURLToPath(import.meta.url)), '..', 'js');

// ── a recording engine fake ─────────────────────────────────────────────────────────────────

function makeFakePc({ aabbs = [{ c: [0, 1, 0], h: [0.5, 1, 0.25] }], loadError = null } = {}) {
  const rec = { device: null, draco: [], basis: [], assets: [], ticks: 0, textures: [] };
  class Entity {
    constructor(name, app) {
      this.name = name;
      this.app = app;
      this.children = [];
    }
    addChild(c) {
      this.children.push(c);
    }
    addComponent(type, data) {
      if (type === 'camera') {
        this.camera = { layers: [0, 1, 2, 4, 3], renderSceneColorMap: false, ...data, camera: { setXrProperties() {} } };
      }
      if (type === 'light') this.light = data;
    }
    findComponents(type) {
      return type === 'render' ? this._renders || [] : [];
    }
    setLocalPosition() {}
    setLocalRotation(x, y, z, w) {
      this.rot = [x, y, z, w];
    }
    setLocalScale() {}
    setLocalEulerAngles() {}
    destroy() {}
  }
  class AppBase {
    constructor(canvas) {
      this.canvas = canvas;
      this.root = new Entity('root', this);
      this.scene = { gsplat: {}, layers: { getLayerById: () => ({ addMeshInstances() {} }) } };
      this.resolutionMode = 'fixed';
      this.graphicsDevice = {};
      this.assets = {
        add: (a) => rec.assets.push(a),
        load: (a) => {
          queueMicrotask(() => {
            if (loadError) {
              a._fire('error', loadError);
              return;
            }
            a.resource = {
              instantiateRenderEntity: () => {
                const e = new Entity('gltf', this);
                e._renders = [
                  {
                    meshInstances: aabbs.map(({ c, h, material }) => ({
                      aabb: { center: { x: c[0], y: c[1], z: c[2] }, halfExtents: { x: h[0], y: h[1], z: h[2] } },
                      ...(material ? { material } : {}),
                    })),
                  },
                ];
                return e;
              },
              animations: [],
            };
            a._fire('load');
          });
        },
      };
    }
    init(o) {
      this.opts = o;
    }
    start() {}
    tick() {
      rec.ticks++;
    }
    destroy() {
      rec.destroyed = true;
    }
  }
  class Camera {}
  Object.defineProperty(Camera.prototype, 'xrViews', { get() { return null; }, set() {} });
  const pc = {
    DEVICETYPE_WEBGL2: 'webgl2',
    RESOLUTION_FIXED: 'fixed',
    SHADERLANGUAGE_GLSL: 'glsl',
    TONEMAP_NONE: 'none',
    TONEMAP_NEUTRAL: 'neutral',
    LAYERID_SKYBOX: 2,
    PIXELFORMAT_RGBA8: 'rgba8',
    TEXTURETYPE_RGBE: 'rgbe',
    TEXTUREPROJECTION_EQUIRECT: 'equirect',
    ADDRESS_REPEAT: 'repeat',
    ADDRESS_CLAMP_TO_EDGE: 'clamp',
    createGraphicsDevice: async (canvas, o) => (rec.device = { canvas, o }),
    AppOptions: class {},
    AppBase,
    Entity,
    Camera,
    RenderView: class {},
    Color: class {
      constructor(r, g, b, a) {
        Object.assign(this, { r, g, b, a });
      }
    },
    Texture: class {
      constructor(device, o) {
        this.o = o;
        rec.textures.push(o);
      }
      destroy() {}
    },
    EnvLighting: {
      generateLightingSource: (src) => ({ src, destroy() {} }),
      generateAtlas: (l) => ({ atlasOf: l }),
    },
    Asset: class {
      constructor(name, type, file, data, options) {
        Object.assign(this, { name, type, file, data, options, _h: {} });
      }
      once(ev, cb) {
        this._h[ev] = cb;
      }
      _fire(ev, arg) {
        this._h[ev]?.(arg);
      }
    },
    ShaderChunks: { get: () => ({ get: () => '', set() {} }) },
    dracoInitialize: (c) => rec.draco.push(c),
    basisInitialize: (c) => rec.basis.push(c),
  };
  return { pc, rec };
}

/** A minimal GLB whose JSON chunk declares `exts`. */
function glb(exts = []) {
  const json = new TextEncoder().encode(JSON.stringify({ asset: { version: '2.0' }, extensionsUsed: exts }));
  const pad = (4 - (json.length % 4)) % 4;
  const len = 20 + json.length + pad;
  const buf = new ArrayBuffer(len);
  const v = new DataView(buf);
  v.setUint32(0, 0x46546c67, true);
  v.setUint32(4, 2, true);
  v.setUint32(8, len, true);
  v.setUint32(12, json.length + pad, true);
  v.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(buf, 20).set(json);
  for (let i = 0; i < pad; i++) new Uint8Array(buf)[20 + json.length + i] = 0x20;
  return buf;
}

/** fetch(): the model URL → `body`; decoder files → 200 unless listed in `missing`. */
function installFetch(body, { missing = [] } = {}) {
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    if (missing.some((m) => String(url).includes(m))) return { ok: false, status: 404, statusText: 'Not Found' };
    if (/\.(glb|gltf)$/.test(String(url))) return { ok: true, status: 200, arrayBuffer: async () => body };
    return { ok: true, status: 200 };
  };
  return seen;
}

function fakeWall() {
  const rec = {};
  return {
    rec,
    wall: {
      supported: true,
      addScene: (cv, onFrame, opts) => {
        rec.opts = opts;
        rec.onFrame = onFrame;
        return {
          firstWoven: Promise.resolve({ woven: true, confirmed: true, reason: 'fake', ms: 1 }),
          exclude: (el) => (rec.excluded = el),
          unexclude() {},
          remove: () => (rec.removed = true),
          setViewRig: (r) => (rec.rig = r),
        };
      },
    },
  };
}

// ── 1. routing ──────────────────────────────────────────────────────────────────────────────

test('engine: unset → playcanvas (the 1.12 default); "three" and "playcanvas" explicit; anything else throws', () => {
  assert.deepEqual(MODEL_ENGINES, ['playcanvas', 'three']);
  assert.deepEqual(resolveModelEngine({}), { engine: 'playcanvas', explicit: false, reason: 'default' });
  assert.equal(resolveModelEngine({ engine: 'three' }).engine, 'three');
  assert.equal(resolveModelEngine({ engine: 'playcanvas' }).explicit, true);
  assert.throws(() => resolveModelEngine({ engine: 'babylon' }), /unknown engine "babylon".*'playcanvas' or 'three'/);
  assert.throws(() => resolveModelEngine({ engine: 'PlayCanvas' }), /unknown engine/);
});

test('a three.js object in a three-only option picks three when no engine was named', () => {
  class GLTFLoader {}
  assert.equal(resolveModelEngine({ GLTFLoader }).engine, 'three');
  assert.equal(resolveModelEngine({ DRACOLoader: GLTFLoader }).engine, 'three');
  assert.equal(resolveModelEngine({ envMap: { isTexture: true } }).engine, 'three');
  // …but a URL envMap is a PlayCanvas option
  assert.equal(resolveModelEngine({ envMap: 'studio.hdr' }).engine, 'playcanvas');
});

test('call-time validation: bad canvas/src, PC-only options on engine:three, three objects on engine:playcanvas', () => {
  const canvas = makeCanvas();
  const r3 = { engine: 'three', explicit: true };
  const rp = { engine: 'playcanvas', explicit: true };
  assert.throws(() => validateModelCall(null, 'a.glb', {}, rp), /must be an HTMLCanvasElement/);
  assert.throws(() => validateModelCall(canvas, '', {}, rp), /must be the URL/);
  assert.throws(() => validateModelCall(canvas, 'a.glb', { engine: 'three', controls: 'page' }, r3), /`controls` is .*PlayCanvas-backend/);
  assert.throws(() => validateModelCall(canvas, 'a.glb', { engine: 'three', environmentRotation: 90, antialias: false }, r3), /`environmentRotation`, `antialias` are/);
  assert.doesNotThrow(() => validateModelCall(canvas, 'a.glb', { engine: 'three', controls: 'viewer', decoderPath: '/x/' }, r3));
  assert.throws(() => validateModelCall(canvas, 'a.glb', { engine: 'playcanvas', GLTFLoader: class {} }, rp), /`GLTFLoader` is a three.js object/);
  assert.throws(() => validateModelCall(canvas, 'a.glb', { engine: 'playcanvas', envMap: { isTexture: true } }, rp), /`envMap` is a three.js object/);
});

test('backend option validation throws at call time with the option named', () => {
  assert.throws(() => validatePlayCanvasModelOptions({ environment: 'sunset' }), /environment "sunset"/);
  assert.throws(() => validatePlayCanvasModelOptions({ KTX2Loader: class {} }), /`KTX2Loader` is a three.js loader/);
  assert.throws(() => validatePlayCanvasModelOptions({ envMap: { isTexture: true } }), /`envMap` is a three.js texture/);
  assert.throws(() => validatePlayCanvasModelOptions({ meshoptDecoder: {} }), /MeshoptDecoder/);
  assert.throws(() => validatePlayCanvasModelOptions({ controls: 'game' }), /@displayxr\/inline3d\/model: controls "game"/);
  assert.throws(() => validatePlayCanvasModelOptions({ onBeforeFrame: () => {} }), /onBeforeFrame needs controls:'page'/);
  for (const environment of ['room', 'neutral', 'studio', 'none']) assert.doesNotThrow(() => validatePlayCanvasModelOptions({ environment }));
  // The router's pre-module copy throws the same things synchronously from addModel itself.
  installDom();
  assert.throws(() => addModel(null, makeCanvas(), 'a.glb', { environment: 'sunset' }), /environment "sunset"/);
  assert.throws(() => addModel(null, makeCanvas(), 'a.glb', { controls: 'game' }), /controls "game"/);
});

// ── 2. the synchronous handle ───────────────────────────────────────────────────────────────

test('addModel returns the full handle synchronously; calls before load are queued and replayed', async () => {
  installDom();
  const { pc, rec } = makeFakePc();
  installFetch(glb());
  const { wall, rec: wrec } = fakeWall();
  const canvas = makeCanvas(400, 300);
  const h = addModel(wall, canvas, 'https://x/a.glb', { playcanvas: pc });
  for (const k of ['ready', 'firstWoven']) assert.equal(typeof h[k]?.then, 'function', k);
  for (const k of ['setPose', 'resetPose', 'remove', 'exclude', 'unexclude', 'setCameraPose', 'getCameraPose']) assert.equal(typeof h[k], 'function', k);
  assert.equal(h.backend, 'playcanvas');
  assert.equal(h.viewer, null, 'viewer appears one module-load later');
  const plate = { id: 'plate' };
  h.exclude(plate); // the next-line call a product page makes
  h.setPose({ yaw: 20 });
  assert.equal(await h.ready, h, 'ready resolves to the same handle');
  assert.equal(wrec.excluded, plate, 'queued exclude() reached the core handle');
  assert.equal(h.viewer.getPose().yaw, 20, 'queued setPose() replayed');
  assert.deepEqual(await h.firstWoven, { woven: true, confirmed: true, reason: 'fake', ms: 1 });
  assert.ok(h.engine && h.engine.app && h.engine.root, 'handle.engine = {app, root, camera}');
  assert.ok(h.model, 'model is the glTF root entity');
  assert.deepEqual(h.frame, { center: [0, 1, 0], extent: [1, 2, 0.5] });
  assert.equal(wrec.opts.virtualDisplayHeight, 0.24);
  h.remove();
  assert.equal(wrec.removed, true);
  assert.equal(rec.destroyed, true, 'remove() destroys the app');
});

test('remove() before the backend lands is queued and wins', async () => {
  installDom();
  const { pc, rec } = makeFakePc();
  installFetch(glb());
  const { wall, rec: wrec } = fakeWall();
  const h = addModel(wall, makeCanvas(), 'https://x/a.glb', { playcanvas: pc });
  h.remove();
  await h.ready;
  assert.equal(wrec.removed, true);
  assert.equal(h.model, null, 'nothing was instantiated after remove()');
  assert.equal(rec.assets.length, 0);
});

test('no wall: firstWoven says unsupported, the flat view runs', async () => {
  installDom();
  const { pc } = makeFakePc();
  installFetch(glb());
  const h = addModel(null, makeCanvas(), 'https://x/a.glb', { playcanvas: pc });
  await h.ready;
  assert.deepEqual(await h.firstWoven, { woven: false, confirmed: false, reason: 'unsupported', ms: 0 });
  assert.equal(h.viewer.is3D, false);
});

test('default engine with neither playcanvas nor three resolvable: ready rejects naming both installs', async () => {
  installDom();
  installFetch(glb());
  const warn = console.warn;
  console.warn = () => {};
  try {
    const h = addModel(null, makeCanvas(), 'https://x/a.glb');
    await assert.rejects(h.ready, /playcanvas.*could not be loaded.*neither could `three`.*npm i playcanvas/s);
    assert.equal((await h.firstWoven).reason, 'layer-failed');
    // Explicit engine:'playcanvas' never falls back, and says only playcanvas.
    const h2 = addModel(null, makeCanvas(), 'https://x/a.glb', { engine: 'playcanvas' });
    await assert.rejects(h2.ready, (e) => /could not be loaded/.test(e.message) && !/neither could/.test(e.message));
    // engine:'three' goes straight to three (not installed here → rejects), never touches playcanvas.
    const h3 = addModel(null, makeCanvas(), 'https://x/a.glb', { engine: 'three' });
    assert.equal(h3.backend, 'three');
    await assert.rejects(h3.ready);
  } finally {
    console.warn = warn;
  }
});

// ── 3. engine setup + lighting ──────────────────────────────────────────────────────────────

test('engine defaults: MSAA on, Khronos PBR Neutral tone mapping, no sky, neutral-studio envAtlas', async () => {
  installDom();
  const { pc, rec } = makeFakePc();
  installFetch(glb());
  const h = addModel(null, makeCanvas(), 'https://x/a.glb', { playcanvas: pc });
  await h.ready;
  assert.equal(rec.device.o.antialias, true);
  assert.equal(h.viewer.eye.camera.toneMapping, 'neutral');
  assert.ok(!h.viewer.eye.camera.layers.includes(pc.LAYERID_SKYBOX), 'sky layer off');
  const app = h.engine.app;
  assert.ok(app.scene.envAtlas, 'envAtlas set');
  assert.equal(app.scene.exposure, 1);
  const t = rec.textures[0];
  assert.equal(t.type, 'rgbe');
  assert.equal(t.projection, 'equirect');
  assert.equal(t.levels[0].length, t.width * t.height * 4);
  assert.deepEqual(app.opts.componentSystems.length, 0, 'fake has no systems — the names are looked up, not required');
});

test("environment:'studio' = three's three-point rig as directional lights aimed down −Y; 'none' = nothing", async () => {
  installDom();
  let { pc } = makeFakePc();
  installFetch(glb());
  let h = addModel(null, makeCanvas(), 'https://x/a.glb', { playcanvas: pc, environment: 'studio' });
  await h.ready;
  const lights = h.viewer.content.children.filter((e) => e.light);
  assert.equal(lights.length, 3);
  assert.equal(h.engine.app.scene.envAtlas, undefined);
  near(lights[0].light.intensity, 2.2 / Math.PI, 1e-9);
  ({ pc } = makeFakePc());
  h = addModel(null, makeCanvas(), 'https://x/a.glb', { playcanvas: pc, environment: 'none' });
  await h.ready;
  assert.equal(h.viewer.content.children.filter((e) => e.light).length, 0);
  assert.equal(h.engine.app.scene.envAtlas, undefined);
});

test("environment:'room' = three's RoomEnvironment regenerated in memory, untonemapped; the default stays the neutral studio", async () => {
  installDom();
  let { pc, rec } = makeFakePc();
  pc.Quat = class { setFromEulerAngles(x, y, z) { this.e = [x, y, z]; return this; } };
  installFetch(glb());
  let h = addModel(null, makeCanvas(), 'https://x/a.glb', { playcanvas: pc, environment: 'room' });
  await h.ready;
  assert.equal(h.viewer.eye.camera.toneMapping, 'none', "three's room look is untonemapped");
  assert.equal(rec.textures[0].name, 'inline3d-room');
  assert.equal(rec.textures[0].type, 'rgbe');
  assert.deepEqual(h.engine.app.scene.skyboxRotation.e, [0, ROOM_YAW_DEG, 0], "lined up with three's world");
  h = addModel(null, makeCanvas(), 'https://x/a.glb', { playcanvas: pc, environment: 'room', environmentRotation: 30 });
  await h.ready;
  assert.deepEqual(h.engine.app.scene.skyboxRotation.e, [0, ROOM_YAW_DEG + 30, 0]);
  ({ pc, rec } = makeFakePc());
  h = addModel(null, makeCanvas(), 'https://x/a.glb', { playcanvas: pc });
  await h.ready;
  assert.equal(h.viewer.eye.camera.toneMapping, 'neutral');
  assert.equal(rec.textures[0].name, 'inline3d-neutral-studio', 'default unchanged: the Sample-Viewer studio');
});

test('room radiance: the panels, the lit walls, grey, deterministic, cached', () => {
  const dir = (p) => { const l = Math.hypot(...p); return p.map((v) => v / l); };
  assert.equal(roomRadiance(0, 1, 0), 100, 'the ceiling panel straight up');
  for (const [px, py, pz, , , , e] of ROOM_ENVIRONMENT.panels) assert.equal(roomRadiance(...dir([px, py, pz])), e, `panel at ${px},${py},${pz}`);
  const floor = roomRadiance(0, -1, 0);
  assert.ok(floor > 0.1 && floor < 5, `the floor is lit by the point light, not emissive (${floor})`);
  for (let k = 0; k < 300; k++) {
    const t = Math.acos(1 - 2 * ((k + 0.5) / 300));
    const p = k * 2.399963;
    const v = roomRadiance(Math.sin(t) * Math.cos(p), Math.cos(t), Math.sin(t) * Math.sin(p));
    assert.ok(v >= 0 && v <= 100 && Number.isFinite(v));
  }
  const blurred = roomEquirect(64, 32);
  const sharp = roomEquirect(64, 32, 0);
  assert.ok(Math.max(...blurred) < Math.max(...sharp), 'the 0.04-rad blur softens the panels');
  const a = roomRGBE(64, 32);
  const b = roomRGBE(64, 32);
  assert.deepEqual(a, b);
  assert.notEqual(a, b, 'a copy per call (the engine may keep the array)');
  for (let i = 0; i < a.length; i += 4) assert.ok(a[i] === a[i + 1] && a[i] === a[i + 2], 'r = g = b');
});

test('KHR_materials_transmission: grab pass on, transmissive draws sorted first, per-eye grab chunk; plain models untouched', async () => {
  installDom();
  const engineChunk = 'uniform float x;\nvec3 evalRefractionColor(vec3 v, float g, float i) {\n\tvec4 projectionPoint = v4;\n\tvec2 uv = getGrabScreenPos(projectionPoint);\n}';
  const chunks = new Map();
  const glassMat = { useDynamicRefraction: true, getShaderChunks: () => chunks, update() {} };
  let { pc } = makeFakePc({ aabbs: [{ c: [0, 1, 0], h: [0.5, 1, 0.25], material: glassMat }, { c: [0, 0, 0], h: [1, 1, 1], material: { useDynamicRefraction: false } }] });
  pc.ShaderChunks = { get: () => ({ get: (k) => (k === 'refractionDynamicPS' ? engineChunk : '') }) };
  installFetch(glb(['KHR_materials_transmission']));
  let h = addModel(null, makeCanvas(), 'https://x/a.glb', { playcanvas: pc });
  await h.ready;
  assert.equal(h.viewer.eye.camera.renderSceneColorMap, true, 'the grab pass the material samples');
  const [glass, body] = h.model._renders[0].meshInstances;
  assert.equal(typeof glass.calculateSortDistance, 'function');
  assert.equal(body.calculateSortDistance, undefined);
  const near1 = glass.calculateSortDistance(glass, { x: 0, y: 1, z: 1 }, { x: 0, y: 0, z: -1 });
  const far1 = glass.calculateSortDistance(glass, { x: 0, y: 1, z: 5 }, { x: 0, y: 0, z: -1 });
  assert.ok(near1 > 1e5 && far1 > near1, 'ahead of blended draws, back-to-front among themselves');
  const patched = chunks.get('refractionDynamicPS');
  assert.match(patched, /vec2 uv = inline3dGrabUV\(projectionPoint\);/);
  assert.ok(patched.indexOf('vec2 inline3dGrabUV') < patched.indexOf('vec3 evalRefractionColor'), 'defined before use');
  assert.equal(prepareTransmission(pc, h.model, {}, new WeakSet()), 1, 'counts transmissive draws');
  ({ pc } = makeFakePc());
  installFetch(glb());
  h = addModel(null, makeCanvas(), 'https://x/a.glb', { playcanvas: pc });
  await h.ready;
  assert.equal(h.viewer.eye.camera.renderSceneColorMap, false, 'no grab pass without a transmissive material');
});

test('aimDownAt rotates the engine light axis (−Y) onto the given direction', () => {
  const rot = (q, v) => {
    const [x, y, z, w] = q;
    const [vx, vy, vz] = v;
    const ix = w * vx + y * vz - z * vy, iy = w * vy + z * vx - x * vz, iz = w * vz + x * vy - y * vx, iw = -x * vx - y * vy - z * vz;
    return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
  };
  for (const d of [[1, 0, 0], [0, 0, -1], [0.6, -0.8, 0], [-0.36, -0.48, -0.8], [0, -1, 0], [0, 1, 0]]) {
    const got = rot(aimDownAt(d), [0, -1, 0]);
    for (let i = 0; i < 3; i++) near(got[i], d[i], 1e-9, `d=${d}`);
  }
});

test('neutral studio: grey, non-negative, deterministic, brighter above than below', () => {
  const a = neutralStudioRGBE(64, 32);
  const b = neutralStudioRGBE(64, 32);
  assert.deepEqual(a, b);
  for (let i = 0; i < a.length; i += 4) assert.ok(a[i] === a[i + 1] && a[i] === a[i + 2], 'r = g = b');
  assert.ok(neutralStudioRadiance(0, 1, 0) > neutralStudioRadiance(0, -1, 0));
  for (let k = 0; k < 200; k++) {
    const t = Math.acos(1 - 2 * ((k + 0.5) / 200));
    const p = k * 2.399963;
    assert.ok(neutralStudioRadiance(Math.sin(t) * Math.cos(p), Math.cos(t), Math.sin(t) * Math.sin(p)) >= 0);
  }
  assert.equal(NEUTRAL_STUDIO.profile.length >= 2, true);
});

// ── 4. framing ──────────────────────────────────────────────────────────────────────────────

test('frame = union of the mesh-instance AABBs; opts.frame overrides; fitTo gets it', async () => {
  const { pc } = makeFakePc();
  const e = { findComponents: () => [{ meshInstances: [
    { aabb: { center: { x: 0, y: 0, z: 0 }, halfExtents: { x: 1, y: 1, z: 1 } } },
    { aabb: { center: { x: 3, y: 0, z: 0 }, halfExtents: { x: 1, y: 2, z: 1 } } },
  ] }] };
  assert.deepEqual(boundsOfEntity(pc, e), { center: [1.5, 0, 0], extent: [5, 4, 2] });
  assert.equal(boundsOfEntity(pc, { findComponents: () => [] }), null);
  installDom();
  installFetch(glb());
  const frame = { center: [9, 9, 9], extent: [1, 1, 1] };
  const h = addModel(null, makeCanvas(), 'https://x/a.glb', { playcanvas: pc, frame });
  await h.ready;
  assert.equal(h.frame, frame);
  const f = h.viewer.getFocus();
  assert.deepEqual([f.x, f.y, f.z], [9, 9, 9], 'focus snapped to the frame centre');
});

// ── 5. decoders ─────────────────────────────────────────────────────────────────────────────

test('an uncompressed asset wires no decoder and fetches no decoder file', async () => {
  installDom();
  const { pc, rec } = makeFakePc();
  const seen = installFetch(glb());
  const h = addModel(null, makeCanvas(), 'https://x/a.glb', { playcanvas: pc });
  await h.ready;
  assert.deepEqual(seen, ['https://x/a.glb'], 'the asset once, nothing else');
  assert.equal(rec.draco.length + rec.basis.length, 0);
  assert.equal(rec.assets[0].options, undefined);
  assert.ok(rec.assets[0].file.contents instanceof ArrayBuffer, 'the inspected bytes are handed to the engine (no second fetch)');
});

test("Draco and KTX2 wire the ENGINE's readers to three's file names under decoderPath (per-page, first wins)", async () => {
  installDom();
  const { pc, rec } = makeFakePc();
  const seen = installFetch(glb(['KHR_draco_mesh_compression', 'KHR_texture_basisu']));
  const h = addModel(null, makeCanvas(), 'https://x/a.glb', { playcanvas: pc, decoderPath: '/vendor' });
  await h.ready;
  assert.deepEqual(rec.draco, [{ jsUrl: '/vendor/draco/draco_wasm_wrapper.js', wasmUrl: '/vendor/draco/draco_decoder.wasm', lazyInit: true }]);
  assert.deepEqual(rec.basis, [{ glueUrl: '/vendor/basis/basis_transcoder.js', wasmUrl: '/vendor/basis/basis_transcoder.wasm', lazyInit: true }]);
  assert.ok(seen.includes('/vendor/draco/draco_decoder.wasm'), 'the files are pre-flighted');
  // a second tile with another path does not reconfigure the engine (one worker pool per page)
  const warn = console.warn;
  const warned = [];
  console.warn = (m) => warned.push(String(m));
  try {
    const h2 = addModel(null, makeCanvas(), 'https://x/b.glb', { playcanvas: pc, decoderPath: { draco: '/other/draco/' } });
    await h2.ready;
  } finally {
    console.warn = warn;
  }
  assert.equal(rec.draco.length, 1);
  assert.ok(warned.some((m) => /already configured from "\/vendor\/draco\/"/.test(m)));
});

test('a mis-served decoder folder rejects ready with the extension, the path and the option named', async () => {
  installDom();
  const { pc } = makeFakePc();
  installFetch(glb(['KHR_texture_basisu']), { missing: ['/nowhere/basis/basis_transcoder.wasm'] });
  const warn = console.warn;
  console.warn = () => {};
  try {
    const h = addModel(null, makeCanvas(), 'https://x/c.glb', { playcanvas: pc, decoderPath: { basis: '/nowhere/basis/' } });
    await assert.rejects(h.ready, (e) => {
      assert.equal(e.gltfExtension, 'KHR_texture_basisu');
      assert.equal(e.decoder, 'ktx2');
      assert.match(e.message, /decoderPath: \{ basis: '\/nowhere\/basis\/' \}/);
      assert.match(e.message, /HTTP 404 for \/nowhere\/basis\/basis_transcoder\.wasm/);
      assert.match(e.message, /three\/examples\/jsm\/libs\/basis\//);
      return true;
    });
  } finally {
    console.warn = warn;
  }
});

test('an engine load error mentioning draco is reported as the Draco decoder', async () => {
  installDom();
  const { pc } = makeFakePc({ loadError: 'Draco decode failed' });
  installFetch(glb(['KHR_draco_mesh_compression']));
  const warn = console.warn;
  console.warn = () => {};
  try {
    const h = addModel(null, makeCanvas(), 'https://x/d.glb', { playcanvas: pc, decoderPath: '/dd/' });
    await assert.rejects(h.ready, (e) => e.gltfExtension === 'KHR_draco_mesh_compression');
  } finally {
    console.warn = warn;
  }
});

test('meshopt: an injected MeshoptDecoder is used through the container bufferView hook', async () => {
  installDom();
  const { pc, rec } = makeFakePc();
  installFetch(glb(['EXT_meshopt_compression']));
  const calls = [];
  const dec = { ready: Promise.resolve(), decodeGltfBuffer: (...a) => calls.push(a) };
  const h = addModel(null, makeCanvas(), 'https://x/m.glb', { playcanvas: pc, meshoptDecoder: dec });
  await h.ready;
  const hook = rec.assets[0].options?.bufferView;
  assert.equal(typeof hook?.processAsync, 'function');
  // plain view → fall through to the engine
  let got;
  hook.processAsync({ buffer: 0 }, [], (e, r) => (got = [e, r]));
  assert.deepEqual(got, [null, null]);
  // compressed view → decoded from ext.buffer
  const src = new Uint8Array(32).fill(7);
  const result = await new Promise((res, rej) =>
    hook.processAsync(
      { buffer: 1, extensions: { EXT_meshopt_compression: { buffer: 0, byteOffset: 4, byteLength: 8, byteStride: 12, count: 3, mode: 'ATTRIBUTES' } } },
      [Promise.resolve(src)],
      (e, r) => (e ? rej(e) : res(r)),
    ),
  );
  assert.equal(result.length, 36);
  const [target, count, stride, source, mode, filter] = calls[0];
  assert.equal(target, result);
  assert.deepEqual([count, stride, source.length, source.byteOffset, mode, filter], [3, 12, 8, 4, 'ATTRIBUTES', 'NONE']);
});

test('meshoptBufferViewHook forwards a decode failure to the engine callback', async () => {
  const hook = meshoptBufferViewHook({ decodeGltfBuffer: () => { throw new Error('bad stream'); } });
  const err = await new Promise((res) =>
    hook.processAsync({ extensions: { EXT_meshopt_compression: { buffer: 0, byteLength: 1, byteStride: 4, count: 1, mode: 'ATTRIBUTES' } } }, [Promise.resolve(new Uint8Array(4))], (e) => res(e)),
  );
  assert.match(err.message, /bad stream/);
});

test('decoder helpers: path normalisation, extension set, glb/gltf JSON, error text', () => {
  assert.deepEqual(normalizeDecoderPath(), { draco: '/draco/', basis: '/basis/' });
  assert.deepEqual(normalizeDecoderPath('/v'), { draco: '/v/draco/', basis: '/v/basis/' });
  assert.deepEqual(normalizeDecoderPath({ draco: '/d', ktx2: '/k/' }), { draco: '/d/', basis: '/k/' });
  assert.deepEqual([...declaredExtensions({ extensionsUsed: ['A'], extensionsRequired: ['A', 'B'] })], ['A', 'B']);
  assert.deepEqual(gltfJsonOf(glb(['X'])).extensionsUsed, ['X']);
  assert.deepEqual(gltfJsonOf(new TextEncoder().encode('{"extensionsUsed":["Y"]}').buffer).extensionsUsed, ['Y']);
  const e = decoderError('meshopt', 'a.gltf', normalizeDecoderPath(), new Error('nope'));
  assert.match(e.message, /npm i meshoptimizer/);
  assert.equal(e.gltfExtension, PC_DECODERS.meshopt.ext);
});

// ── 6. controls:'page' on a model ───────────────────────────────────────────────────────────

test("controls:'page': setCameraPose drives the rig, declares an attach rig converged on the model", async () => {
  installDom();
  const { pc } = makeFakePc();
  installFetch(glb());
  const { wall, rec: wrec } = fakeWall();
  const h = addModel(wall, makeCanvas(640, 360), 'https://x/a.glb', { playcanvas: pc, controls: 'page' });
  assert.throws(() => addModel(wall, makeCanvas(), 'https://x/a.glb', { playcanvas: pc }).setCameraPose(new Float32Array(16), {}), /needs addModel\(…, \{ controls:'page' \}\)/);
  const M = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 5, 1]); // at (0,1,5) looking down −Z
  h.setCameraPose(M, { verticalFovDeg: 40 });
  await h.ready;
  assert.equal(h.getCameraPose().verticalFovDeg, 40);
  assert.throws(() => h.setPose({ yaw: 1 }), /controls:'page'/);
  assert.throws(() => h.setCameraPose(M, { verticalFovDeg: 0 }), /@displayxr\/inline3d\/model: setCameraPose — verticalFovDeg/);
  h.viewer._tick();
  assert.ok(wrec.rig, 'a view rig was declared');
  near(1 / wrec.rig.convergenceDiopters, 5, 1e-6, 'converged on the bounds centre, 5 m ahead');
});

// ── 7. the named-import engine module ───────────────────────────────────────────────────────

test('inline3d-playcanvas-engine.js exports every engine member the two adapters read', () => {
  const helper = readFileSync(join(JS, 'inline3d-playcanvas-engine.js'), 'utf8');
  const block = helper.slice(helper.indexOf('export {'), helper.indexOf("} from 'playcanvas'"));
  const exported = new Set([...block.replace(/\/\/[^\n]*/g, '').matchAll(/([A-Za-z_$][\w$]*)\s*,/g)].map((m) => m[1]));
  const used = new Set();
  for (const f of ['inline3d-splat-playcanvas.js', 'inline3d-model-playcanvas.js', 'inline3d-pc-look.js', 'inline3d-splat-effects.js', 'inline3d-splat-live.js']) {
    const src = readFileSync(join(JS, f), 'utf8').replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of src.matchAll(/\bpc\.([A-Za-z_$][\w$]*)/g)) used.add(m[1]);
  }
  for (const n of [...PLAYCANVAS_SYSTEMS, ...PLAYCANVAS_HANDLERS, ...Object.values(TONE_MAPPINGS)]) used.add(n);
  const missing = [...used].filter((n) => !exported.has(n));
  assert.deepEqual(missing, [], `add to js/inline3d-playcanvas-engine.js: ${missing.join(', ')}`);
});

test('the default model path imports neither three nor playcanvas statically (both are dynamic)', () => {
  for (const f of ['inline3d-model-entry.js', 'inline3d-model-playcanvas.js', 'inline3d-pc-look.js', 'inline3d-splat-playcanvas.js', 'inline3d-splat-shared.js', 'inline3d-splat-rig.js', 'inline3d-splat-effects.js', 'inline3d-splat-live.js', 'inline3d-sog.js', 'inline3d-splat-perf.js', 'inline3d-viewer.js', 'inline3d-three.js']) {
    const src = readFileSync(join(JS, f), 'utf8');
    const statics = [...src.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    for (const s of statics) assert.ok(s.startsWith('./'), `${f} statically imports ${s}`);
  }
});

function near(a, b, eps, what = '') {
  assert.ok(Math.abs(a - b) < eps, `${what} ${a} !~= ${b}`);
}

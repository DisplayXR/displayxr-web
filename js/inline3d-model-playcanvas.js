// inline3d-model-playcanvas.js — `addModel`'s default backend (1.12): a glTF/GLB rendered by the
// PlayCanvas engine instead of three.js.
//
// EXPERIMENTAL. Internal to `./model`, which imports this module DYNAMICALLY — so a page that
// passes `engine: 'three'` never resolves `playcanvas`, and a page on this default never resolves
// `three`. Not covered by the SDK's 1.x semver promise; see docs/sdk-stability.md and
// docs/playcanvas-model-backend.md (what differs from the three path, and why).
//
// WHAT IS THE SAME AS THE THREE PATH. The handle (`ready`, `remove`, `exclude/unexclude`,
// `setPose`, `resetPose`, `frame`, `model`, `viewer`, `firstWoven`), the framing (exact mesh
// bounds → the shared fit arithmetic), the pose model and its constants, the buffer-shape rule
// (double-width in 3D, 1:1 in mono), validate-before-clear + last-good replay, `feather`,
// `renderScale`, and the decoder contract: the asset's `extensionsUsed` decides which decoders
// are wired, the page SERVES the Draco and Basis files (never a CDN), and a decoder that is needed
// and missing rejects `ready` with an Error naming the extension, the option and the path.
//
// WHAT IS NOT.
//   · The tile host is the PlayCanvas splat adapter's (`PlayCanvasSplatViewer`, reused as is):
//     one AppBase per tile, one camera with N `RenderView`s, the EYES move and the model stays
//     put (the rig node carries the inverse pivot).
//   · LIGHTING. The reference is the Khronos glTF Sample Viewer, not three.js: an image-based
//     "neutral studio" environment, Khronos PBR Neutral tone mapping, exposure 1, sRGB output.
//     The environment is generated in memory (§ neutralStudioRGBE) — no HDRI to fetch or license —
//     and was fitted to the Sample Viewer's "Studio Neutral". three's path keeps RoomEnvironment
//     and no tone mapping (unchanged since 1.11); the two backends therefore do not look
//     identical, by design — docs/playcanvas-model-backend.md §Lighting has the MAE table.
//   · Decoders are the ENGINE's: Draco and Basis through the engine's own worker readers (fed the
//     SAME files three's `libs/draco/` and `libs/basis/` folders hold), meshopt through the
//     container's bufferView hook with meshoptimizer's `MeshoptDecoder` (the engine has no
//     meshopt reader in 2.22.3).
//
// ENGINE SHAPE:
//   AppBase (no XrManager, no input) on our own WebGL2 device, MSAA on
//   ├── content   ← the glTF's render entity (instantiateRenderEntity), never moved by the SDK
//   └── rig       ← inverse(pivot), written by the viewer's tick and nothing else
//       └── eye camera, N RenderViews, TONEMAP_NEUTRAL, no sky layer

import { PlayCanvasSplatViewer, pageRigTRS, pageViewAxis, pageViewRig } from './inline3d-splat-playcanvas.js';
import { resolveControls, normalizeCameraPose, now, MAX_DT_S } from './inline3d-splat-shared.js';

const TAG = '[inline3d/model]';

// ── the decoders ────────────────────────────────────────────────────────────────────────────

/**
 * One entry per compression extension. The FILES are the same ones three's addModel asks a page
 * to serve (three/examples/jsm/libs/{draco,basis}/): the engine's Draco worker takes Google's
 * wasm wrapper as its glue, and its Basis worker takes the Binomial transcoder three ships. So one
 * served folder works for either engine, and switching `engine` never moves a file.
 */
export const PC_DECODERS = Object.freeze({
  draco: Object.freeze({
    ext: 'KHR_draco_mesh_compression',
    label: 'Draco mesh compression',
    pathKey: 'draco',
    files: ['draco_wasm_wrapper.js', 'draco_decoder.wasm'],
    from: 'three/examples/jsm/libs/draco/',
  }),
  ktx2: Object.freeze({
    ext: 'KHR_texture_basisu',
    label: 'KTX2 / Basis Universal textures',
    pathKey: 'basis',
    files: ['basis_transcoder.js', 'basis_transcoder.wasm'],
    from: 'three/examples/jsm/libs/basis/',
  }),
  meshopt: Object.freeze({
    ext: 'EXT_meshopt_compression',
    label: 'meshopt compression',
    pathKey: null, // pure JS with inlined wasm: nothing to serve
    files: null,
    module: 'meshoptimizer/decoder',
  }),
});

export const PC_DECODER_KINDS = Object.freeze(['draco', 'ktx2', 'meshopt']);

const DEFAULT_DECODER_PATH = Object.freeze({ draco: '/draco/', basis: '/basis/' });

/** Same rule as the three path: a string is a parent of draco/ and basis/; an object per key. */
export function normalizeDecoderPath(v) {
  if (!v) return { ...DEFAULT_DECODER_PATH };
  if (typeof v === 'string') {
    const base = v.endsWith('/') ? v : `${v}/`;
    return { draco: `${base}draco/`, basis: `${base}basis/` };
  }
  const slash = (p) => (p.endsWith('/') ? p : `${p}/`);
  return {
    draco: slash(v.draco || DEFAULT_DECODER_PATH.draco),
    basis: slash(v.basis || v.ktx2 || DEFAULT_DECODER_PATH.basis),
  };
}

/** The glTF extensions an asset declares (used ∪ required). */
export function declaredExtensions(json) {
  const out = new Set();
  for (const key of ['extensionsUsed', 'extensionsRequired']) {
    const list = json?.[key];
    if (Array.isArray(list)) for (const name of list) out.add(name);
  }
  return out;
}

const GLB_MAGIC = 0x46546c67;
const GLB_CHUNK_JSON = 0x4e4f534a;

/** The glTF JSON of a .glb or .gltf buffer, or null. */
export function gltfJsonOf(buffer) {
  const view = new DataView(buffer);
  const text = new TextDecoder();
  if (buffer.byteLength >= 20 && view.getUint32(0, true) === GLB_MAGIC) {
    const len = view.getUint32(12, true);
    if (view.getUint32(16, true) !== GLB_CHUNK_JSON) return null;
    return JSON.parse(text.decode(new Uint8Array(buffer, 20, len)));
  }
  return JSON.parse(text.decode(new Uint8Array(buffer)));
}

/**
 * The error a page author can act on: which extension, which files to serve and where, which
 * option moves them — and, for the three-only loader options, the fact that they do not apply.
 */
export function decoderError(kind, src, paths, cause) {
  const spec = PC_DECODERS[kind];
  const lines = [`${TAG} ${src} needs the "${spec.ext}" decoder (${spec.label}) and it could not be used.`];
  if (spec.files) {
    const where = paths[spec.pathKey];
    lines.push(
      `Serve the decoder files from your own origin (the same files three.js ships) and point addModel at them:`,
      `    cp -r node_modules/${spec.from} <web-root>${where}`,
      `    addModel(wall, canvas, src, { decoderPath: { ${spec.pathKey}: '${where}' } })`,
      `Expected ${spec.files.map((f) => where + f).join(' and ')} — check they are actually served (a 404 there fails exactly like this).`,
    );
  } else {
    lines.push(
      `Nothing to serve for this one: the decoder is meshoptimizer's MeshoptDecoder (pure JS). Install it`,
      `    npm i meshoptimizer        (on a bare importmap, map "meshoptimizer/decoder")`,
      `or hand it in: addModel(…, { meshoptDecoder: MeshoptDecoder }).`,
    );
  }
  lines.push(`Underlying error: ${cause?.message || cause}`);
  const err = new Error(lines.join('\n'));
  err.cause = cause;
  err.decoder = kind;
  err.gltfExtension = spec.ext;
  return err;
}

/** Fetch each file once (cached per URL): a mis-served folder must reject `ready`, not decode nothing. */
const _preflight = new Map();
function preflight(urls) {
  return Promise.all(
    urls.map((u) => {
      let p = _preflight.get(u);
      if (!p) {
        p = fetch(u, { method: 'GET' }).then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status} for ${u}`);
          return true;
        });
        p.catch(() => _preflight.delete(u));
        _preflight.set(u, p);
      }
      return p;
    }),
  );
}

/**
 * The engine's Draco and Basis readers are configured ONCE per page (a module-level worker pool
 * in the engine). The first tile that needs one sets its path; a later tile asking for a
 * DIFFERENT path is warned (the engine cannot run two pools) and decodes with the first.
 */
const _engineDecoderPath = { draco: null, ktx2: null };

async function wireEngineDecoder(pc, kind, paths) {
  const spec = PC_DECODERS[kind];
  const dir = paths[spec.pathKey];
  const urls = spec.files.map((f) => dir + f);
  await preflight(urls);
  if (_engineDecoderPath[kind]) {
    if (_engineDecoderPath[kind] !== dir) {
      console.warn(
        `${TAG} decoderPath.${spec.pathKey} "${dir}" ignored: the engine's ${spec.label} reader is ` +
          `already configured from "${_engineDecoderPath[kind]}" on this page (one worker pool per page).`,
      );
    }
    return;
  }
  _engineDecoderPath[kind] = dir;
  if (kind === 'draco') {
    if (typeof pc.dracoInitialize !== 'function') throw new Error('this playcanvas build has no dracoInitialize()');
    pc.dracoInitialize({ jsUrl: urls[0], wasmUrl: urls[1], lazyInit: true });
  } else {
    if (typeof pc.basisInitialize !== 'function') throw new Error('this playcanvas build has no basisInitialize()');
    pc.basisInitialize({ glueUrl: urls[0], wasmUrl: urls[1], lazyInit: true });
  }
}

let _meshopt = null;
async function resolveMeshopt(injected) {
  const d = injected || (_meshopt ||= import('meshoptimizer/decoder').then((m) => m.MeshoptDecoder));
  const dec = await d;
  if (!dec || typeof dec.decodeGltfBuffer !== 'function') {
    throw new Error('the meshopt decoder has no decodeGltfBuffer() — expected meshoptimizer\'s MeshoptDecoder');
  }
  if (dec.ready) await dec.ready;
  return dec;
}

/**
 * The container's bufferView hook: decode EXT_meshopt_compression views with MeshoptDecoder;
 * every other view falls through to the engine (a null result). The compressed bytes live in
 * `ext.buffer`; the view's own buffer is the extension's `fallback` placeholder and is never read.
 */
export function meshoptBufferViewHook(decoder) {
  return {
    processAsync(bufferView, buffers, callback) {
      const ext = bufferView?.extensions?.EXT_meshopt_compression;
      if (!ext) {
        callback(null, null);
        return;
      }
      Promise.resolve(buffers[ext.buffer])
        .then((buf) => {
          const source = new Uint8Array(buf.buffer, buf.byteOffset + (ext.byteOffset || 0), ext.byteLength);
          const target = new Uint8Array(ext.count * ext.byteStride);
          decoder.decodeGltfBuffer(target, ext.count, ext.byteStride, source, ext.mode, ext.filter || 'NONE');
          callback(null, target);
        })
        .catch((err) => callback(err));
    },
  };
}

// ── lighting ────────────────────────────────────────────────────────────────────────────────

/**
 * THE DEFAULT ENVIRONMENT: a neutral photo studio, generated in memory as an equirect radiance
 * map — a floor-to-ceiling brightness profile plus a handful of soft area lights (spherical
 * Gaussians). The parameters were FITTED (least squares, solid-angle weighted) to the glTF Sample
 * Viewer's "Studio Neutral" environment, so that this backend's default lighting matches the
 * Khronos reference; the image itself is ours (a dozen numbers, not a copy of the HDRI), so the
 * SDK ships no asset and carries no attribution requirement. Grey by construction (r = g = b).
 *
 * `profile` is the radiance at evenly spaced polar angles from straight up (0) to straight down
 * (π); `lobes` are [amplitude, sharpness, polar, azimuth] with the direction
 * (sinθ·cosφ, cosθ, sinθ·sinφ) — Y up, the engine's equirect convention. A lobe's amplitude may
 * be negative (a dark backdrop); the result is clamped at 0.
 */
export const NEUTRAL_STUDIO = Object.freeze({
  profile: [5.003, 5.049, 3.917, 1.968, 1.378, 0.893, 0.8074, 0.7525, 0.6427, -0.1814],
  lobes: [
    [11.31, 4.869, 0.9712, 6.105],
    [1.759, 3.839, 1.404, 3.558],
    [0.9139, 1.621, 1.719, 6.239],
    [0.572, 7.846, 1.497, 6.066],
    [0.6379, 7.687, 1.42, 6.385],
    [-0.7782, 6.701, 1.13, 6.133],
    [-1.263, 8.179, 1.671, 6.188],
    [-1.456, 7.734, 1.256, 6.568],
    [-6.7, 0.8014, 0.449, 6.171],
    [0.4015, 3.915, 1.621, 5.688],
    [-0.5387, 6.494, 2.828, 5.614],
    [6.623, 1.864, 0.7199, 6.135],
    [0.2623, 6.922, 1.755, 5.903],
    [0.2597, 6.906, 1.566, 5.934],
    [0.1584, 6.954, 1.514, 6.179],
    [0.2272, 6.945, 1.422, 5.891],
    [0.03496, 6.974, 1.414, 6.205],
    [0.3804, 6.979, 1.393, 6.08],
  ],
});

/** Lobes as [amplitude, sharpness, mx, my, mz] — the trig done once per env, not per texel. */
const _lobeCache = new WeakMap();
function lobesOf(env) {
  let l = _lobeCache.get(env);
  if (!l) {
    l = env.lobes.map(([a, s, th, ph]) => [a, Math.exp(s), Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)]);
    _lobeCache.set(env, l);
  }
  return l;
}

/** Radiance of NEUTRAL_STUDIO (or `env`) toward unit direction (x, y, z). */
export function neutralStudioRadiance(x, y, z, env = NEUTRAL_STUDIO) {
  const prof = env.profile;
  const n = prof.length - 1;
  const theta = Math.acos(Math.max(-1, Math.min(1, y)));
  const t = (theta / Math.PI) * n;
  const i = Math.min(n - 1, Math.floor(t));
  const f = t - i;
  let v = prof[i] * (1 - f) + prof[i + 1] * f;
  for (const [a, k, mx, my, mz] of lobesOf(env)) v += a * Math.exp(k * (x * mx + y * my + z * mz - 1));
  return v > 0 ? v : 0;
}

/** RGBE-encode a grey radiance. */
function rgbe(v, out, o) {
  if (!(v > 1e-32)) {
    out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
    return;
  }
  let e = Math.ceil(Math.log2(v));
  let m = v / Math.pow(2, e);
  if (m >= 1) {
    m /= 2;
    e += 1;
  }
  const b = Math.min(255, Math.floor(m * 256));
  out[o] = out[o + 1] = out[o + 2] = b;
  out[o + 3] = e + 128;
}

/**
 * The equirect as RGBE bytes, row 0 = straight up. `u` runs with the azimuth φ = 2π·u, which is
 * the convention the fit used; the engine's own equirect orientation is applied through
 * `scene.skyboxRotation` (§ ENV_YAW_DEG), not baked in here.
 */
const _rgbeCache = new Map();
export function neutralStudioRGBE(width = 256, height = 128, env = NEUTRAL_STUDIO) {
  // Every tile on a page gets the same image: build it once (a copy per call, since the engine
  // may keep the array it is handed).
  const key = env === NEUTRAL_STUDIO ? `${width}x${height}` : null;
  if (key && _rgbeCache.has(key)) return _rgbeCache.get(key).slice();
  const out = new Uint8Array(width * height * 4);
  for (let r = 0; r < height; r++) {
    const theta = ((r + 0.5) / height) * Math.PI;
    const st = Math.sin(theta);
    const y = Math.cos(theta);
    for (let c = 0; c < width; c++) {
      const phi = ((c + 0.5) / width) * 2 * Math.PI;
      rgbe(neutralStudioRadiance(st * Math.cos(phi), y, st * Math.sin(phi), env), out, (r * width + c) * 4);
    }
  }
  if (key) _rgbeCache.set(key, out.slice());
  return out;
}

/**
 * Yaw (degrees about +Y) applied to the generated studio, as `scene.skyboxRotation`. Calibrated
 * headless against the Sample Viewer at its default `environmentRotation` (90°): a sweep over
 * 0/90/180/270 × mirrored, then ±15/±30, has a clean minimum at 0 on all four reference models
 * (the engine's equirect convention already lines up with the layout the fit used). Kept as a
 * named constant so a future engine that flips its convention is a one-line fix.
 */
export const ENV_YAW_DEG = 0;

/** Build the default environment on this app and set it as the scene's envAtlas. */
export function useNeutralStudio(pc, app, yawDeg) {
  return useRgbeEquirect(pc, app, 'inline3d-neutral-studio', neutralStudioRGBE(256, 128), 256, 128, yawDeg);
}

/** A grey RGBE equirect (row 0 = up) → prefiltered envAtlas on the scene. */
function useRgbeEquirect(pc, app, name, bytes, W, H, yawDeg) {
  const tex = new pc.Texture(app.graphicsDevice, {
    name,
    width: W,
    height: H,
    format: pc.PIXELFORMAT_RGBA8,
    type: pc.TEXTURETYPE_RGBE,
    projection: pc.TEXTUREPROJECTION_EQUIRECT,
    mipmaps: false,
    addressU: pc.ADDRESS_REPEAT,
    addressV: pc.ADDRESS_CLAMP_TO_EDGE,
    levels: [bytes],
  });
  return useLightingSource(pc, app, tex, true, yawDeg);
}

/** Any equirect/cube source → prefiltered envAtlas on the scene. */
function useLightingSource(pc, app, source, own, yawDeg = 0) {
  const lighting = pc.EnvLighting.generateLightingSource(source);
  const atlas = pc.EnvLighting.generateAtlas(lighting);
  lighting.destroy?.();
  if (own) source.destroy?.();
  app.scene.envAtlas = atlas;
  app.scene.skyboxIntensity = 1;
  app.scene.exposure = 1;
  // Always written (identity at 0): a later environment on the same scene must not inherit the
  // previous one's yaw (setRig switches room ↔ neutral on one app).
  if (pc.Quat) app.scene.skyboxRotation = new pc.Quat().setFromEulerAngles(0, yawDeg || 0, 0);
  return atlas;
}

/** A texture asset from a URL (an equirect .hdr/.png/.jpg for `envMap`). */
function loadTexture(pc, app, url) {
  return new Promise((resolve, reject) => {
    const a = new pc.Asset(`inline3d-env:${url}`, 'texture', { url });
    a.once('load', () => resolve(a.resource));
    a.once('error', (e) => reject(new Error(`${TAG} envMap ${url}: ${e}`)));
    app.assets.add(a);
    app.assets.load(a);
  });
}

// ── the room environment (environment: 'room') ─────────────────────────────────────────────

/**
 * `environment: 'room'` — three.js's procedural RoomEnvironment, regenerated here without three:
 * the same scene (a white room lit by one point light, six grey boxes, six emissive panels), shaded
 * the way three shades it when `PMREMGenerator.fromScene(new RoomEnvironment(), 0.04)` bakes it —
 * which is exactly what `addModel(…, { engine: 'three', environment: 'room' })` lights with.
 *
 * It exists so a page that chose `'room'` on the three path gets that look on this backend. It is
 * NOT the default: the default (`'neutral'`) is matched to the Khronos Sample Viewer, and three's
 * room is a different, brighter room (mean radiance ~0.97 vs ~0.89, most of it from a 100-nit
 * ceiling panel and two 50-nit wall panels).
 *
 * The scene's numbers (positions, rotations, scales, intensities) are three.js's
 * examples/jsm/environments/RoomEnvironment.js (MIT, © three.js authors), itself after
 * model-viewer's EnvironmentScene. No image is shipped: `roomRadiance` ray-casts the boxes per
 * texel. Checked against three r180's own bake (its PMREM, read back through `textureCubeUV`):
 * texel-to-texel ratio median 1.000 (p10 0.989, p90 1.006), solid-angle-weighted MAE 0.03 unblurred
 * and 0.04 with the 0.04-rad blur. Solids are [cx, cy, cz, angleY, sx, sy, sz] (boxes) and
 * [cx, cy, cz, sx, sy, sz, emissive] (panels), BoxGeometry(1) scaled — i.e. full extents.
 */
export const ROOM_ENVIRONMENT = Object.freeze({
  light: [0.418, 16.199, 0.3, 900, 28, 2], // point light: position, intensity (cd), cutoff distance, decay
  room: [-0.757, 13.219, 0.717, 31.713, 28.305, 28.591], // seen from inside
  boxes: [
    [-10.906, 2.009, 1.846, -0.195, 2.328, 7.905, 4.651],
    [-5.607, -0.754, -0.758, 0.994, 1.97, 1.534, 3.955],
    [6.167, 0.857, 7.803, 0.561, 3.927, 6.285, 3.687],
    [-2.017, 0.018, 6.124, 0.333, 2.002, 4.566, 2.064],
    [2.291, -0.756, -2.621, -0.286, 1.546, 1.552, 1.496],
    [-2.193, -0.369, -5.547, 0.516, 3.875, 3.487, 2.986],
  ],
  panels: [
    [-16.116, 14.37, 8.208, 0.1, 2.428, 2.739, 50],
    [-16.109, 18.021, -8.207, 0.1, 2.425, 2.751, 50],
    [14.904, 12.198, -1.832, 0.15, 4.265, 6.331, 17],
    [-0.462, 8.89, 14.52, 4.38, 5.441, 0.088, 43],
    [3.235, 11.486, -12.541, 2.5, 2.0, 0.1, 20],
    [0.0, 20.0, 0.0, 1.0, 0.1, 1.0, 100],
  ],
  blur: 0.04, // radians — the sigma addModel's three path passes to fromScene
});

/** Every solid as [cx, cy, cz, cosY, sinY, hx, hy, hz, kind (0 room, 1 lit box, 2 panel), emissive]. */
const _roomSolids = new WeakMap();
function roomSolids(env) {
  let out = _roomSolids.get(env);
  if (out) return out;
  const [rx, ry, rz, sx, sy, sz] = env.room;
  out = [[rx, ry, rz, 1, 0, sx / 2, sy / 2, sz / 2, 0, 0]];
  for (const [px, py, pz, a, bx, by, bz] of env.boxes) out.push([px, py, pz, Math.cos(a), Math.sin(a), bx / 2, by / 2, bz / 2, 1, 0]);
  for (const [px, py, pz, bx, by, bz, e] of env.panels) out.push([px, py, pz, 1, 0, bx / 2, by / 2, bz / 2, 2, e]);
  _roomSolids.set(env, out);
  return out;
}

/**
 * Radiance of the room seen from the origin toward unit direction (x, y, z): the nearest solid
 * along the ray. A panel is its emissive value; a wall or box (white, roughness 1, non-metal) is
 * three's direct physical shading from the one point light, unshadowed as in three (the scene casts
 * no shadows) — Lambert plus GGX at alpha 1 (D = 1/π, V = 0.5/(NL+NV), Schlick F0 0.04), with
 * three's inverse-square falloff and its (1 − (d/cutoff)⁴)² window.
 */
export function roomRadiance(x, y, z, env = ROOM_ENVIRONMENT) {
  let best = Infinity;
  let nx = 0;
  let ny = 0;
  let nz = 0;
  let emit = -1;
  let found = false;
  for (const b of roomSolids(env)) {
    const c = b[3];
    const s = b[4];
    // The ray in the solid's frame (a rotation about Y): local = Rᵀ(p − centre).
    const ox = -b[0];
    const oy = -b[1];
    const oz = -b[2];
    const o = [c * ox - s * oz, oy, s * ox + c * oz];
    const d = [c * x - s * z, y, s * x + c * z];
    let t0 = -Infinity;
    let t1 = Infinity;
    let a0 = 0;
    let a1 = 0;
    let miss = false;
    for (let i = 0; i < 3; i++) {
      const h = b[5 + i];
      if (Math.abs(d[i]) < 1e-12) {
        if (o[i] < -h || o[i] > h) {
          miss = true;
          break;
        }
        continue;
      }
      let n = (-h - o[i]) / d[i];
      let f = (h - o[i]) / d[i];
      let sn = -1; // the entry face's outward normal is −axis when the ray runs +axis
      if (n > f) {
        const t = n;
        n = f;
        f = t;
        sn = 1;
      }
      if (n > t0) {
        t0 = n;
        a0 = (i + 1) * sn;
      }
      if (f < t1) {
        t1 = f;
        a1 = -(i + 1) * sn;
      }
    }
    if (miss || t0 > t1 || t1 < 0) continue;
    const inside = b[8] === 0;
    const t = inside ? t1 : t0;
    if (!(t > 0) || t >= best) continue;
    best = t;
    found = true;
    if (b[8] === 2) {
      emit = b[9];
      continue;
    }
    emit = -1;
    const a = inside ? a1 : a0;
    const sg = (inside ? -1 : 1) * Math.sign(a); // the room is seen from inside: its normals point in
    const ax = Math.abs(a) - 1;
    const l0 = ax === 0 ? sg : 0;
    const l2 = ax === 2 ? sg : 0;
    nx = c * l0 + s * l2;
    ny = ax === 1 ? sg : 0;
    nz = -s * l0 + c * l2;
  }
  if (!found) return 0;
  if (emit >= 0) return emit;
  const [lx, ly, lz, I, cutoff, decay] = env.light;
  let tx = lx - x * best;
  let ty = ly - y * best;
  let tz = lz - z * best;
  const dist = Math.hypot(tx, ty, tz);
  tx /= dist;
  ty /= dist;
  tz /= dist;
  const nl = nx * tx + ny * ty + nz * tz;
  if (nl <= 0) return 0;
  const win = Math.max(0, Math.min(1, 1 - Math.pow(dist / cutoff, 4)));
  const E = (I / Math.max(Math.pow(dist, decay), 0.01)) * win * win * nl;
  const nv = Math.max(1e-4, -(nx * x + ny * y + nz * z));
  const hx = tx - x;
  const hy = ty - y;
  const hz = tz - z;
  const vh = Math.max(0, (tx * hx + ty * hy + tz * hz) / Math.hypot(hx, hy, hz));
  const F = 0.04 + 0.96 * Math.pow(1 - vh, 5);
  return (E / Math.PI) * (1 + F * (0.5 / (nl + nv)));
}

/**
 * The room as a float equirect (row 0 = up, the same convention as neutralStudioRGBE), blurred by a
 * Gaussian of `sigma` radians — separable on the sphere: σ in rows, σ/sinθ in columns (wrapping).
 */
export function roomEquirect(W = 256, H = 128, sigma = ROOM_ENVIRONMENT.blur, env = ROOM_ENVIRONMENT) {
  const out = new Float32Array(W * H);
  for (let r = 0; r < H; r++) {
    const th = ((r + 0.5) / H) * Math.PI;
    const st = Math.sin(th);
    const y = Math.cos(th);
    for (let c = 0; c < W; c++) {
      const ph = ((c + 0.5) / W) * 2 * Math.PI;
      out[r * W + c] = roomRadiance(st * Math.cos(ph), y, st * Math.sin(ph), env);
    }
  }
  if (!(sigma > 0)) return out;
  const perRow = Math.PI / H; // radians per row, and per column at the equator
  const tmp = new Float32Array(W * H);
  for (let r = 0; r < H; r++) {
    const st = Math.max(Math.sin(((r + 0.5) / H) * Math.PI), 1e-3);
    const sg = Math.min(sigma / perRow / st, W / 4);
    const R = Math.ceil(3 * sg);
    const k = [];
    let ks = 0;
    for (let i = -R; i <= R; i++) {
      const v = Math.exp(-(i * i) / (2 * sg * sg));
      k.push(v);
      ks += v;
    }
    for (let c = 0; c < W; c++) {
      let a = 0;
      for (let i = -R; i <= R; i++) a += k[i + R] * out[r * W + (((c + i) % W) + W) % W];
      tmp[r * W + c] = a / ks;
    }
  }
  const sg = sigma / perRow;
  const R = Math.ceil(3 * sg);
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      let a = 0;
      let ks = 0;
      for (let i = -R; i <= R; i++) {
        const rr = r + i;
        if (rr < 0 || rr >= H) continue;
        const v = Math.exp(-(i * i) / (2 * sg * sg));
        a += v * tmp[rr * W + c];
        ks += v;
      }
      out[r * W + c] = a / ks;
    }
  }
  return out;
}

/** The room as RGBE bytes (cached per size: every tile on a page gets the same image). */
const _roomCache = new Map();
export function roomRGBE(W = 256, H = 128) {
  const key = `${W}x${H}`;
  let bytes = _roomCache.get(key);
  if (!bytes) {
    const f = roomEquirect(W, H);
    bytes = new Uint8Array(W * H * 4);
    for (let i = 0; i < f.length; i++) rgbe(f[i], bytes, i * 4);
    _roomCache.set(key, bytes);
  }
  return bytes.slice();
}

/**
 * Yaw that lines the generated room up with three's world (its +X panel on +X, the ceiling panel
 * overhead). Calibrated headless against three r180's own `environment: 'room'` render on two
 * catalogue meshes: a sweep over 0/90/180/270 × mirrored has a clean minimum at 90, unmirrored, on
 * both. (The neutral studio's 0 is the Sample Viewer's orientation, a different frame.)
 */
export const ROOM_YAW_DEG = 90;

/** Build the room environment on this app and set it as the scene's envAtlas. */
export function useRoomEnvironment(pc, app, yawDeg = ROOM_YAW_DEG) {
  return useRgbeEquirect(pc, app, 'inline3d-room', roomRGBE(256, 128), 256, 128, yawDeg);
}

/** Each environment's tone mapping: the look it was matched to. */
export const ENVIRONMENT_TONE_MAPPING = Object.freeze({ neutral: 'neutral', room: 'none', studio: 'neutral', none: 'neutral' });

/**
 * `environment: 'studio'` — three's three-point rig, same directions and ratios. Engine lights
 * shine along their local −Y, so each is aimed by rotation (never lookAt). three's punctual
 * intensity is irradiance with a Lambert 1/π in the BRDF; the engine's has none — hence the /π.
 * three's hemisphere light becomes the scene ambient (its average over the upper hemisphere).
 */
export const STUDIO_LIGHTS = Object.freeze([
  { name: 'key', intensity: 2.2, position: [1, 1.4, 1.6] },
  { name: 'fill', intensity: 0.7, position: [-1.4, 0.4, 0.8] },
  { name: 'rim', intensity: 1.0, position: [-0.4, 0.8, -1.6] },
]);

/** Quaternion [x,y,z,w] rotating (0,−1,0) onto the unit vector `d`. */
export function aimDownAt(d) {
  // from a = (0,-1,0) to b = d: q = (a × b, 1 + a·b), normalised
  const [bx, by, bz] = d;
  const dot = -by;
  if (dot < -0.999999) return [1, 0, 0, 0]; // opposite: half turn about X
  const cx = -1 * bz - 0; // a × b = (ay*bz - az*by, az*bx - ax*bz, ax*by - ay*bx) with a=(0,-1,0)
  const cy = 0;
  const cz = 0 - -1 * bx;
  const w = 1 + dot;
  const l = Math.hypot(cx, cy, cz, w);
  return [cx / l, cy / l, cz / l, w / l];
}

function addStudioLights(pc, app, root) {
  for (const L of STUDIO_LIGHTS) {
    const e = new pc.Entity(`inline3d-${L.name}`, app);
    e.addComponent('light', { type: 'directional', color: new pc.Color(1, 1, 1), intensity: L.intensity / Math.PI, castShadows: false });
    const [x, y, z] = L.position;
    const l = Math.hypot(x, y, z);
    const q = aimDownAt([-x / l, -y / l, -z / l]);
    e.setLocalRotation(q[0], q[1], q[2], q[3]);
    root.addChild(e);
  }
  // three: HemisphereLight(white, 0x444444, 0.6) — mean of sky and (linear) ground over the
  // upper hemisphere, through the Lambert 1/π.
  const amb = (0.6 * (1 + 0.058)) / 2 / Math.PI;
  app.scene.ambientLight = new pc.Color(amb, amb, amb);
}

// ── KHR_materials_transmission / volume on this engine ─────────────────────────────────────

/**
 * The engine reads KHR_materials_transmission (and _volume) into `useDynamicRefraction` +
 * `BLEND_NORMAL`, and a dynamic-refraction material samples the camera's SCENE COLOUR MAP. Three
 * things the engine leaves to the app, all needed for a glass or transmissive glTF to look like
 * it does in the Khronos Sample Viewer (and three):
 *
 *  1. THE GRAB PASS. Nothing renders the scene colour map unless a camera asks for it; without it
 *     the material samples an unbound texture — the storm lantern's burner rendered as a MAGENTA
 *     blob inside its globe (measured). `viewer.useSceneColor()` asks, on every eye camera.
 *  2. PASS ORDER. Both references draw opaque → transmissive → blended. The engine puts a
 *     transmissive material in the ONE back-to-front transparent list with the blended ones, so a
 *     blended globe (depthWrite off) can be drawn before the transmissive body behind it, which
 *     then paints over it — the burner showed THROUGH the lantern's opaque-alpha globe. A sort
 *     distance that puts transmissive draws first (back-to-front among themselves) restores the
 *     order: object MAE 10.7 → 10.2 vs three, 11.2 → 10.8 vs the Sample Viewer.
 *  3. STEREO. The engine turns the refracted point's clip position into a grab-texture UV by
 *     mapping the VIEW's NDC over the WHOLE target (`getGrabScreenPos`). A stereo tile draws two
 *     views side by side into one target, so each eye would sample across both. The patched chunk
 *     measures the offset from THIS fragment instead (NDC delta ÷ NDC-per-pixel, from the
 *     derivatives), which is exact for any viewport and identical in mono.
 */
const GRAB_UV_FN = `
vec2 inline3dGrabUV(vec4 clipPos) {
	vec4 p0 = matrix_viewProjection * vec4(vPositionW, 1.0);
	vec2 n0 = p0.xy / p0.w;
	vec2 dn = clipPos.xy / clipPos.w - n0;
	vec2 perPx = vec2(dFdx(n0.x), dFdy(n0.y));
	vec2 off = vec2(abs(perPx.x) > 1e-9 ? dn.x / perPx.x : 0.0, abs(perPx.y) > 1e-9 ? dn.y / perPx.y : 0.0);
	return (gl_FragCoord.xy + off) * uScreenSize.zw;
}
`;
const _grabChunk = new WeakMap();
let _warnedGrabChunk = false;

/** The engine's refractionDynamicPS with the per-view grab UV (null if its shape is not the expected one). */
function stereoRefractionChunk(pc, device) {
  if (_grabChunk.has(device)) return _grabChunk.get(device);
  let out = null;
  try {
    const src = pc.ShaderChunks?.get?.(device, pc.SHADERLANGUAGE_GLSL)?.get?.('refractionDynamicPS');
    const call = /getGrabScreenPos\(\s*projectionPoint\s*\)/;
    const def = /vec3\s+evalRefractionColor\s*\(/;
    if (typeof src === 'string' && call.test(src) && def.test(src)) {
      out = src.replace(def, (m) => `${GRAB_UV_FN}\n${m}`).replace(call, 'inline3dGrabUV(projectionPoint)');
    }
  } catch {
    out = null;
  }
  if (!out && !_warnedGrabChunk) {
    _warnedGrabChunk = true;
    console.warn(`${TAG} this engine's refraction shader has an unexpected shape; transmissive materials keep the engine's grab UV (correct in mono, not per eye in stereo).`);
  }
  _grabChunk.set(device, out);
  return out;
}

/** Transmissive draws first, back-to-front among themselves (the engine's own key + an offset). */
function transmissiveFirst(mi, camPos, camFwd) {
  const c = mi.aabb.center;
  return 1e6 + (c.x - camPos.x) * camFwd.x + (c.y - camPos.y) * camFwd.y + (c.z - camPos.z) * camFwd.z;
}

/**
 * Apply 1–3 above to every dynamic-refraction mesh under `entity` not already handled (`seen`).
 * Returns how many transmissive mesh instances there are under it (handled now or before) —
 * the caller turns the grab pass on when that is > 0. Cheap to call again: handled ones are skipped.
 */
export function prepareTransmission(pc, entity, device, seen = new WeakSet()) {
  const renders = entity?.findComponents ? entity.findComponents('render') : [];
  let n = 0;
  for (const r of renders) {
    for (const mi of r.meshInstances || []) {
      const m = mi.material;
      if (!m?.useDynamicRefraction) continue;
      n++;
      if (seen.has(mi)) continue;
      seen.add(mi);
      mi.calculateSortDistance = transmissiveFirst;
      if (!seen.has(m)) {
        seen.add(m);
        const chunk = device ? stereoRefractionChunk(pc, device) : null;
        if (chunk && typeof m.getShaderChunks === 'function') {
          m.getShaderChunks(pc.SHADERLANGUAGE_GLSL).set('refractionDynamicPS', chunk);
          m.shaderChunksVersion = pc.CHUNKAPI_2_8 ?? '2.8';
          m.update?.();
        }
      }
    }
  }
  return n;
}

// ── framing ─────────────────────────────────────────────────────────────────────────────────

/** Union of the render mesh instances' world AABBs (content space, the file's own units). */
export function boundsOfEntity(pc, entity) {
  const renders = entity.findComponents ? entity.findComponents('render') : [];
  let min = null;
  let max = null;
  for (const r of renders) {
    for (const mi of r.meshInstances || []) {
      const b = mi.aabb;
      if (!b) continue;
      const c = b.center;
      const h = b.halfExtents;
      const lo = [c.x - h.x, c.y - h.y, c.z - h.z];
      const hi = [c.x + h.x, c.y + h.y, c.z + h.z];
      if (!lo.every(Number.isFinite) || !hi.every(Number.isFinite)) continue;
      if (!min) {
        min = lo;
        max = hi;
      } else {
        for (let i = 0; i < 3; i++) {
          if (lo[i] < min[i]) min[i] = lo[i];
          if (hi[i] > max[i]) max[i] = hi[i];
        }
      }
    }
  }
  if (!min) return null;
  return {
    center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
    extent: [Math.max(max[0] - min[0], 1e-6), Math.max(max[1] - min[1], 1e-6), Math.max(max[2] - min[2], 1e-6)],
  };
}

// ── option validation (pure; ./model calls it synchronously, before anything loads) ──────────

/** Options that only mean something on three's path: their values ARE three.js objects. */
export const THREE_ONLY_OPTIONS = Object.freeze(['GLTFLoader', 'DRACOLoader', 'KTX2Loader']);

export const ENVIRONMENTS = Object.freeze(['room', 'neutral', 'studio', 'none']);

/**
 * Throws, at call time, for an option this backend cannot honour — a three.js loader, a three
 * texture as `envMap`, an unknown `environment`, a bad `controls`. Returns the resolved controls.
 */
export function validatePlayCanvasModelOptions(opts = {}) {
  for (const k of THREE_ONLY_OPTIONS) {
    if (opts[k]) {
      throw new Error(
        `@displayxr/inline3d/model: \`${k}\` is a three.js loader and does nothing on the PlayCanvas ` +
          `backend (the default since 1.12), which decodes with the engine's own readers. Drop it and serve ` +
          `the decoder files at \`decoderPath\`, or pass engine:'three' to keep the 1.11 renderer.`,
      );
    }
  }
  const env = opts.environment;
  if (env !== undefined && !ENVIRONMENTS.includes(env)) {
    throw new Error(
      `@displayxr/inline3d/model: environment "${env}" — expected ${ENVIRONMENTS.map((e) => `'${e}'`).join(', ')}.`,
    );
  }
  const em = opts.envMap;
  if (em && typeof em === 'object' && (em.isTexture === true || em.isRenderTargetTexture === true)) {
    throw new Error(
      '@displayxr/inline3d/model: `envMap` is a three.js texture, and the PlayCanvas backend (the default ' +
        "since 1.12) cannot sample it. Pass a URL of an equirect image (.hdr/.png/.jpg) or a pc.Texture, " +
        "or pass engine:'three' to keep the PMREM texture.",
    );
  }
  if (em !== undefined && em !== null && typeof em !== 'string' && typeof em !== 'object') {
    throw new Error('@displayxr/inline3d/model: `envMap` must be a URL string or a pc.Texture.');
  }
  const md = opts.meshoptDecoder;
  if (md && typeof md.decodeGltfBuffer !== 'function' && typeof md.then !== 'function') {
    throw new Error("@displayxr/inline3d/model: `meshoptDecoder` must be meshoptimizer's MeshoptDecoder (it has decodeGltfBuffer()).");
  }
  let ctl;
  try {
    ctl = resolveControls(opts);
  } catch (err) {
    throw new Error(err.message.replace('@displayxr/inline3d/splat', '@displayxr/inline3d/model'));
  }
  return ctl;
}

// ── the backend ─────────────────────────────────────────────────────────────────────────────

/**
 * Fill `out` (the handle ./model already returned) with the PlayCanvas implementation, replay the
 * calls queued before this module arrived, and return the load promise (./model owns `ready`).
 *
 * @param {object} pc  the `playcanvas` module (or the SDK's named-import subset of it).
 */
export function attachPlayCanvasModel(out, wall, canvas, src, opts, pending = [], pc) {
  const {
    virtualDisplayHeight = 0.24,
    frame = null,
    idleSpin = 8,
    orbit = true,
    fit = 'contain',
    margin = 0.8,
    depthLimit = 4.0,
    fitSweep = true,
    renderScale = 1,
    feather = 0,
    environment = 'neutral',
    envMap = null,
    decoderPath = null,
    meshoptDecoder = null,
    observe,
    firstWovenHoldMs,
    preserveDrawingBuffer = false,
    antialias = true,
  } = opts;
  const ctl = validatePlayCanvasModelOptions(opts);
  const pageMode = ctl.page;
  if (pageMode && ctl.ignored.length) {
    console.info(`${TAG} controls:'page' — the page owns the camera, so ${ctl.ignored.join(', ')} ${ctl.ignored.length === 1 ? 'is' : 'are'} ignored.`);
  }
  const paths = normalizeDecoderPath(decoderPath);

  const viewer = new PlayCanvasSplatViewer(canvas, {
    pageCamera: pageMode,
    virtualDisplayHeight,
    fit,
    margin,
    depthLimit,
    fitSweep,
    orbit,
    idleSpin,
    renderScale,
    flipY: false, // glTF is already Y-up
    orbitMaxDeg: opts.orbitMaxDeg,
    orbitEase: opts.orbitEase,
    feather,
    nearClip: opts.nearClip,
    farClip: opts.farClip,
    sky: false,
    // Each environment's own look: 'room' is three's (untonemapped), the rest the Sample Viewer's.
    toneMapping: envMap ? 'neutral' : ENVIRONMENT_TONE_MAPPING[environment] || 'neutral',
  });

  let handle = null;
  let removed = false;
  let lastPagePose = null;

  Object.assign(out, {
    backend: 'playcanvas',
    engine: null,
    viewer,
    model: null,
    frame: null,
    setPose: (p) => viewer.setPose(p),
    resetPose: () => viewer.resetPose(),
    setCameraPose(matrixWorld, o) {
      if (!pageMode) {
        throw new Error("@displayxr/inline3d/model: setCameraPose() needs addModel(…, { controls:'page' }) — with the default controls the SDK owns the camera (use setPose).");
      }
      let pose;
      try {
        pose = normalizeCameraPose(matrixWorld, o);
      } catch (err) {
        throw new Error(err.message.replace('@displayxr/inline3d/splat', '@displayxr/inline3d/model'));
      }
      lastPagePose = pose;
      viewer.setPageCamera(pose);
      return out;
    },
    getCameraPose() {
      if (!lastPagePose) return null;
      return {
        matrixWorld: Float32Array.from(lastPagePose.matrixWorld),
        verticalFovDeg: lastPagePose.verticalFovDeg,
        near: lastPagePose.near,
        far: lastPagePose.far,
        convergence: lastPagePose.convergence,
      };
    },
    remove() {
      removed = true;
      handle?.remove();
      viewer.dispose(); // app.destroy(): the model, its textures and any page entities go with it
    },
    exclude: (el) => handle?.exclude(el),
    unexclude: (el) => handle?.unexclude(el),
  });

  if (wall && wall.supported) {
    handle = wall.addScene(canvas, viewer.onFrame, {
      ...(pageMode
        ? { viewRig: pageViewRig({ verticalFovDeg: viewer.page.fov, convergence: 2, comfortDepth: ctl.comfortDepth }) }
        : { virtualDisplayHeight }),
      onLayerLost: viewer.onLayerLost,
      ...(observe ? { observe } : {}),
      ...(firstWovenHoldMs !== undefined ? { firstWovenHoldMs } : {}),
    });
  } else {
    viewer.startMono();
  }
  if (typeof out._resolveFirstWoven === 'function') {
    out._resolveFirstWoven(
      handle ? handle.firstWoven : Promise.resolve(Object.freeze({ woven: false, confirmed: false, reason: 'unsupported', ms: 0 })),
    );
    delete out._resolveFirstWoven;
  }

  for (const [name, args] of pending) {
    if (name === 'remove') {
      out.remove();
      break;
    }
    out[name]?.(...args);
  }

  // controls:'page' — declare the attach rig every frame: convergence = the page's, else the
  // distance along the view axis to the model's bounds centre (else 2 page units until it loads).
  if (pageMode) {
    viewer.onTick = () => {
      let d = lastPagePose?.convergence ?? null;
      if (d === null && out.frame) {
        const ax = pageViewAxis(viewer.page.matrix);
        const c = out.frame.center;
        const dm = (c[0] - ax.origin[0]) * ax.forward[0] + (c[1] - ax.origin[1]) * ax.forward[1] + (c[2] - ax.origin[2]) * ax.forward[2];
        if (dm > 0) d = dm / (ax.scale || 1);
      }
      out.viewRig = pageViewRig({ verticalFovDeg: viewer.page.fov, convergence: d ?? 2, comfortDepth: ctl.comfortDepth }, out.viewRig || {});
      handle?.setViewRig?.(out.viewRig);
    };
    if (typeof opts.onBeforeFrame === 'function') {
      const cb = opts.onBeforeFrame;
      let lastT = 0;
      let warned = false;
      viewer._beforeFrame = (views) => {
        const t = now();
        const dt = lastT ? Math.min((t - lastT) / 1000, MAX_DT_S) : 0;
        lastT = t;
        try {
          cb({ time: t, views, dt });
        } catch (err) {
          if (!warned) {
            warned = true;
            console.warn(`${TAG} onBeforeFrame threw (warned once; frames keep rendering)`, err);
          }
        }
      };
    }
    // (pageRigTRS is the viewer's; referenced so a reader can find where the page matrix lands.)
    void pageRigTRS;
  }

  const load = (async () => {
    // Fetch + inspect first: which decoders does the asset declare?
    const res = await fetch(src);
    if (!res.ok) throw new Error(`${TAG} HTTP ${res.status} ${res.statusText} for ${src}`);
    const buffer = await res.arrayBuffer();
    if (removed) return out;
    let declared = null;
    try {
      declared = declaredExtensions(gltfJsonOf(buffer));
    } catch {
      declared = null; // not JSON / not a glb: let the engine say what it is
    }
    const wanted = PC_DECODER_KINDS.filter((k) => (k === 'meshopt' && meshoptDecoder) || (declared ? declared.has(PC_DECODERS[k].ext) : false));

    const app = await viewer.attachEngine(pc, { preserveDrawingBuffer, antialias, patchSplats: false });
    if (!app || removed) return out;
    out.engine = Object.freeze({ app, root: viewer.content, camera: viewer.eye || null });

    // Lighting before the model, so the first frame the model is in is lit.
    const yaw = Number.isFinite(opts.environmentRotation) ? opts.environmentRotation : 0;
    if (typeof envMap === 'string') useLightingSource(pc, app, await loadTexture(pc, app, envMap), true, yaw);
    else if (envMap && typeof envMap === 'object') useLightingSource(pc, app, envMap, false, yaw);
    else if (environment === 'room') useRoomEnvironment(pc, app, ROOM_YAW_DEG + yaw);
    else if (environment === 'neutral') useNeutralStudio(pc, app, ENV_YAW_DEG + yaw);
    else if (environment === 'studio') addStudioLights(pc, app, viewer.content);
    if (removed) return out;

    let containerOptions;
    for (const kind of wanted) {
      try {
        if (kind === 'meshopt') {
          const dec = await resolveMeshopt(meshoptDecoder);
          containerOptions = { bufferView: meshoptBufferViewHook(dec) };
        } else {
          await wireEngineDecoder(pc, kind, paths);
        }
      } catch (err) {
        throw decoderError(kind, src, paths, err);
      }
    }
    if (removed) return out;

    const asset = await new Promise((resolve, reject) => {
      const name = String(src).split('/').pop() || 'model.glb';
      const a = new pc.Asset(name, 'container', { url: src, filename: name, contents: buffer }, null, containerOptions);
      a.once('load', () => resolve(a));
      a.once('error', (e) => {
        const err = e instanceof Error ? e : new Error(String(e));
        const msg = String(err.message);
        const kind = /draco/i.test(msg) ? 'draco' : /basis|ktx2/i.test(msg) ? 'ktx2' : /meshopt/i.test(msg) ? 'meshopt' : wanted.length === 1 ? wanted[0] : null;
        reject(kind ? decoderError(kind, src, paths, err) : err);
      });
      app.assets.add(a);
      app.assets.load(a);
    });
    if (removed) return out;

    const entity = asset.resource.instantiateRenderEntity();
    // KHR_materials_transmission / volume: grab pass, pass order, per-eye grab UV (§ prepareTransmission).
    if (prepareTransmission(pc, entity, app.graphicsDevice) > 0) viewer.useSceneColor(true);
    viewer.content.addChild(entity);
    out.model = entity;
    out.container = asset.resource; // animations, materials, textures (engine types)
    const bounds = frame || boundsOfEntity(pc, entity);
    if (bounds) {
      out.frame = bounds;
      viewer.fitTo(bounds.center, bounds.extent);
    }
    return out;
  })();

  return load.catch((err) => {
    console.warn(`${TAG} failed to load (engine:playcanvas)`, src, err);
    throw err;
  });
}

// inline3d-model.js — a glTF/GLB model as an inline-3D window, in one call.
//
// EXPERIMENTAL. Not covered by the SDK's 1.x semver promise — see docs/sdk-stability.md.
//
//   import { createInline3D } from '@displayxr/inline3d';
//   import { addModel } from '@displayxr/inline3d/model';
//
//   const wall = await createInline3D();
//   const lamp = addModel(wall, canvas, 'lamp.glb', { virtualDisplayHeight: 0.3 });
//   lamp.exclude(document.getElementById('buy'));
//
// Deliberately the same options, the same handle and the same framing behaviour as ./splat, so a
// catalogue can switch a product between a captured splat and a vendor mesh by changing one word.
// That symmetry is the point: retailers already hold glTF for a slice of their catalogue, and
// rendering those unchanged is a far stronger claim than "re-capture everything".
//
// Requires `three` as a peer, and resolves GLTFLoader from `three/addons/`. That mapping is
// already mandatory for anyone using ./splat (Spark reaches into three/addons internally), so
// this adds no new requirement — but on a bare importmap it must be declared:
//
//   "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.180.0/examples/jsm/"
//
// You can also hand the class in directly (`opts.GLTFLoader`) and skip the specifier entirely.
//
// ── COMPRESSED ASSETS ───────────────────────────────────────────────────────────────────────
// "Render the catalogue unchanged" is only true if the catalogue's actual files load, and a real
// e-commerce GLB is nearly always Draco-compressed. A bare GLTFLoader cannot decode any of the
// three compression extensions — it throws, it does not degrade — so this module inspects the
// asset's `extensionsUsed` before parsing and attaches exactly the decoders it declares:
//
//   KHR_draco_mesh_compression  → DRACOLoader   (needs decoder files SERVED by your page)
//   KHR_texture_basisu          → KTX2Loader    (needs transcoder files SERVED by your page)
//   EXT_meshopt_compression     → MeshoptDecoder (pure JS, nothing to serve)
//
// Nothing is imported or instantiated for an asset that declares none of them — an uncompressed
// GLB costs exactly what it did before. The decoder BINARIES are deliberately not fetched from a
// CDN: pages that ship this SDK include offline kiosk builds, so the default looks for them on
// your own origin (`/draco/`, `/basis/`) and `opts.decoderPath` moves that. See
// docs/authoring-inline-3d.md#compressed-gltf.

import * as THREE from 'three';
import { EyeCamera, EdgeFeather } from './inline3d-three.js';
import { SceneViewer } from './inline3d-viewer.js';

/** Cached across calls so a grid of models resolves the loader module once. */
let _GLTFLoader = null;

async function resolveLoader(injected) {
  if (injected) return injected;
  if (!_GLTFLoader) {
    const mod = await import('three/addons/loaders/GLTFLoader.js');
    _GLTFLoader = mod.GLTFLoader;
  }
  return _GLTFLoader;
}

// ── the three compression extensions, and everything needed to talk about them ───────────────

/**
 * One entry per decoder: the glTF extension that demands it, where its class lives, where its
 * runtime files live, and which option overrides each. The error messages are generated from
 * this table, so a message can never name an option that does not exist.
 */
const DECODERS = {
  draco: {
    ext: 'KHR_draco_mesh_compression',
    label: 'Draco mesh compression',
    module: 'three/addons/loaders/DRACOLoader.js',
    exportName: 'DRACOLoader',
    option: 'DRACOLoader',
    pathKey: 'draco',
    files: 'three/examples/jsm/libs/draco/',
    attach: (loader, d) => loader.setDRACOLoader(d),
  },
  ktx2: {
    ext: 'KHR_texture_basisu',
    label: 'KTX2 / Basis Universal textures',
    module: 'three/addons/loaders/KTX2Loader.js',
    exportName: 'KTX2Loader',
    option: 'KTX2Loader',
    pathKey: 'basis',
    files: 'three/examples/jsm/libs/basis/',
    attach: (loader, d) => loader.setKTX2Loader(d),
  },
  meshopt: {
    ext: 'EXT_meshopt_compression',
    label: 'meshopt compression',
    module: 'three/addons/libs/meshopt_decoder.module.js',
    exportName: 'MeshoptDecoder',
    option: 'meshoptDecoder',
    pathKey: null, // pure JS + inlined wasm; nothing for the page to serve
    files: null,
    attach: (loader, d) => loader.setMeshoptDecoder(d),
  },
};

const DECODER_KINDS = /** @type {const} */ (['draco', 'ktx2', 'meshopt']);

/**
 * Where the decoder binaries are expected on YOUR origin. Not a CDN, on purpose — see the header.
 * `/draco/` and `/basis/` are the paths three's own examples use, and the ones every "copy these
 * two folders into public/" recipe on the web produces.
 */
const DEFAULT_DECODER_PATH = { draco: '/draco/', basis: '/basis/' };

/** `'/vendor/'` → `{draco:'/vendor/draco/', basis:'/vendor/basis/'}`; an object overrides per-key. */
function normalizeDecoderPath(v) {
  if (!v) return { ...DEFAULT_DECODER_PATH };
  if (typeof v === 'string') {
    const base = v.endsWith('/') ? v : `${v}/`;
    return { draco: `${base}draco/`, basis: `${base}basis/` };
  }
  return {
    draco: v.draco || DEFAULT_DECODER_PATH.draco,
    basis: v.basis || v.ktx2 || DEFAULT_DECODER_PATH.basis,
  };
}

/**
 * Decoders are SHARED across tiles, ref-counted by configuration key. A DRACOLoader owns a worker
 * pool; a catalogue grid of twelve products must not stand up twelve of them, and one tile's
 * `remove()` must not tear down the pool the other eleven are decoding on. Injected decoders never
 * enter this map — they belong to the caller, who disposes them.
 */
const _shared = new Map(); // key -> { refs, p: Promise<decoder> }

function acquireShared(key, make) {
  let e = _shared.get(key);
  if (!e) {
    e = { refs: 0, p: make() };
    // A failed build must not poison every later attempt with a rejected promise.
    e.p.catch(() => _shared.delete(key));
    _shared.set(key, e);
  }
  e.refs++;
  return e.p;
}

function releaseShared(key) {
  const e = _shared.get(key);
  if (!e || --e.refs > 0) return;
  _shared.delete(key);
  e.p.then((d) => d?.dispose?.()).catch(() => {});
}

/**
 * Import (or accept) a decoder and configure it. `injected` may be a class OR a ready instance —
 * MeshoptDecoder is a namespace object rather than a class, and a caller who already holds a
 * configured DRACOLoader should be able to hand THAT in rather than a constructor.
 *
 * `decoderPath` is applied only to instances WE construct. An instance you hand in is used exactly
 * as you configured it: silently rewriting its decoder path would make injection useless for the
 * one thing people inject for, which is pointing it somewhere unusual.
 */
async function buildDecoder(kind, paths, injected) {
  const spec = DECODERS[kind];
  let thing = injected;
  if (!thing) {
    const mod = await import(spec.module);
    thing = mod[spec.exportName];
    if (!thing) throw new Error(`${spec.module} has no export "${spec.exportName}"`);
  }
  if (typeof thing !== 'function') return thing; // already an instance (or the meshopt namespace)
  const d = new thing();
  if (kind === 'draco') d.setDecoderPath?.(paths.draco);
  if (kind === 'ktx2') d.setTranscoderPath?.(paths.basis);
  return d;
}

/** @returns {Promise<{decoder:object, key:string|null}>} `key` is set when the tile took a share. */
async function getDecoder(kind, paths, injected, renderer) {
  let decoder;
  let key = null;
  if (injected) {
    decoder = await buildDecoder(kind, paths, injected);
  } else {
    const p = DECODERS[kind].pathKey;
    key = `${kind}|${p ? paths[p] : ''}`;
    decoder = await acquireShared(key, () => buildDecoder(kind, paths, null));
  }
  if (kind === 'ktx2') {
    // MUST run with the renderer that will sample the texture: detectSupport reads the context's
    // compressed-texture extensions to pick a transcode target. Re-run per tile because the shared
    // instance may have been built against a sibling's context; it is a cheap flag assignment.
    decoder.detectSupport?.(renderer);
    // And then force the transcoder to load NOW, because KTX2 is the one decoder that fails
    // SILENTLY: GLTFLoader swallows a texture-load rejection, so a mis-served transcoder resolves
    // a model with ZERO textures and no error at all (measured on three r180 — 7 textures became
    // 0, `ready` resolved). init() turns that into a rejection naming the URL it could not fetch.
    await decoder.init?.();
  }
  return { decoder, key };
}

// ── asset inspection ─────────────────────────────────────────────────────────────────────────

const GLB_MAGIC = 0x46546c67; // 'glTF', little-endian
const GLB_CHUNK_JSON = 0x4e4f534a; // 'JSON'

/**
 * Fetch the asset ONCE and read its glTF JSON header. The bytes are handed to `loader.parse()`
 * afterwards, so inspecting costs no extra request — this replaces the loader's own fetch rather
 * than adding to it.
 */
async function fetchAndInspect(src) {
  const res = await fetch(src);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${src}`);
  const buffer = await res.arrayBuffer();
  return { buffer, json: gltfJsonOf(buffer) };
}

function gltfJsonOf(buffer) {
  const view = new DataView(buffer);
  const text = new TextDecoder();
  if (buffer.byteLength >= 20 && view.getUint32(0, true) === GLB_MAGIC) {
    const len = view.getUint32(12, true);
    if (view.getUint32(16, true) !== GLB_CHUNK_JSON) return null;
    return JSON.parse(text.decode(new Uint8Array(buffer, 20, len)));
  }
  return JSON.parse(text.decode(new Uint8Array(buffer))); // a .gltf is plain JSON
}

/** `extensionsUsed` ∪ `extensionsRequired`. Draco appears in both; meshopt sometimes only in one. */
function declaredExtensions(json) {
  const out = new Set();
  for (const key of ['extensionsUsed', 'extensionsRequired']) {
    const list = json?.[key];
    if (Array.isArray(list)) for (const name of list) out.add(name);
  }
  return out;
}

function urlBaseOf(src) {
  const extract = THREE.LoaderUtils?.extractUrlBase;
  if (extract) return extract(src);
  const i = src.lastIndexOf('/');
  return i < 0 ? './' : src.slice(0, i + 1);
}

// ── errors that tell a page author what to do ────────────────────────────────────────────────

/**
 * three's own messages for these failures ("No DRACOLoader instance provided.") name a class the
 * page never mentions and say nothing about the two things that actually fix it: which option to
 * pass, and which files to serve. This builds the message that does.
 *
 * @param {string} kind  a key of DECODERS
 * @param {string} src
 * @param {{draco:string,basis:string}} paths
 * @param {unknown} cause
 * @param {boolean} inspected  whether we managed to read the asset's extension list
 */
function decoderError(kind, src, paths, cause, inspected) {
  const spec = DECODERS[kind];
  const lines = [
    `[inline3d/model] ${src} needs the "${spec.ext}" decoder (${spec.label}) and it could not be used.`,
  ];
  if (spec.files) {
    const dir = spec.pathKey;
    const where = paths[dir];
    lines.push(
      `Serve three's decoder files from your own origin and point addModel at them:`,
      `    cp -r node_modules/${spec.files} <web-root>${where.startsWith('/') ? where : `/${dir}/`}`,
      `    addModel(wall, canvas, src, { decoderPath: { ${dir}: '${where}' } })`,
      `Currently looking in "${where}" — check that it is actually served (a 404 there fails exactly like this).`,
    );
  } else {
    lines.push(
      `Nothing to serve for this one — the meshopt decoder is pure JS, so this is a module-resolution failure.`,
    );
  }
  lines.push(
    `Or hand the decoder in: addModel(…, { ${spec.option}: X }) where X is ${spec.exportName} from '${spec.module}' (a class or a ready instance).`,
    `On a bare importmap, '${spec.module}' additionally needs a "three/addons/" prefix mapping.`,
  );
  if (!inspected) {
    lines.push(
      `(The asset's extension list could not be read up front, so the decoder was not attached automatically.)`,
    );
  }
  lines.push(`Underlying error: ${cause?.message || cause}`);
  const err = new Error(lines.join('\n'));
  err.cause = cause;
  err.decoder = kind;
  err.gltfExtension = spec.ext;
  return err;
}

/** Which decoder is a raw three.js failure about? Used when inspection failed and three threw. */
function kindFromMessage(msg) {
  if (/DRACOLoader|draco/i.test(msg)) return 'draco';
  if (/KTX2Loader|basisu|basis/i.test(msg)) return 'ktx2';
  if (/MeshoptDecoder|meshopt/i.test(msg)) return 'meshopt';
  return null;
}

/**
 * Load a glTF/GLB into an inline-3D window.
 *
 * @param {object} wall  the manager from createInline3D(), supported or not.
 * @param {HTMLCanvasElement} canvas
 * @param {string} src  URL of a .glb / .gltf.
 * @param {object} [opts]  every option ./splat takes, plus:
 * @param {'studio'|'none'} [opts.environment='studio']  built-in three-point lighting. Meshes
 *        arrive unlit otherwise — unlike splats, which carry their own baked appearance.
 * @param {object} [opts.envMap]  a PMREM-processed environment texture, if you have one. Better
 *        than `environment` for metal and glass; overrides it.
 * @param {unknown} [opts.GLTFLoader]  hand in the class instead of resolving `three/addons/`.
 * @param {string|{draco?:string,basis?:string}} [opts.decoderPath]  where YOUR PAGE serves three's
 *        Draco decoder and Basis transcoder (default `{draco:'/draco/', basis:'/basis/'}`). A
 *        string is treated as a parent directory holding `draco/` and `basis/`. Never a CDN by
 *        default: an offline build must not depend on one.
 * @param {unknown} [opts.DRACOLoader]  DRACOLoader class or instance, instead of `three/addons/`.
 * @param {unknown} [opts.KTX2Loader]  KTX2Loader class or instance. `detectSupport()` is called
 *        for you with this tile's renderer.
 * @param {unknown} [opts.meshoptDecoder]  MeshoptDecoder namespace, instead of `three/addons/`.
 * @returns {object} the same handle shape as addSplat: a TileHandle plus `viewer`, `model`,
 *          `setPose`, `resetPose`, `frame`, and `ready`.
 */
export function addModel(wall, canvas, src, opts = {}) {
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
    environment = 'studio',
    envMap = null,
    GLTFLoader: injectedLoader = null,
    decoderPath = null,
    DRACOLoader: injectedDraco = null,
    KTX2Loader: injectedKtx2 = null,
    meshoptDecoder: injectedMeshopt = null,
    observe,
  } = opts;

  const paths = normalizeDecoderPath(decoderPath);
  const injected = { draco: injectedDraco, ktx2: injectedKtx2, meshopt: injectedMeshopt };

  const viewer = new SceneViewer(THREE, canvas, {
    virtualDisplayHeight,
    fit,
    margin,
    depthLimit,
    fitSweep,
    orbit,
    idleSpin,
    renderScale,
    feather,
  }).useEyeCamera(EyeCamera, EdgeFeather);

  if (envMap) viewer.scene.environment = envMap;
  else if (environment === 'studio') addStudioLights(viewer.scene);

  /** Shared-decoder keys this tile holds a reference to, released in remove(). */
  const held = [];

  const out = {
    viewer,
    model: null,
    frame: null,
    setPose: (p) => viewer.setPose(p),
    resetPose: () => viewer.resetPose(),
    remove() {
      handle?.remove();
      viewer.dispose();
      if (out.model) disposeTree(out.model);
      while (held.length) releaseShared(held.pop());
    },
    exclude: (el) => handle?.exclude(el),
    unexclude: (el) => handle?.unexclude(el),
  };

  // Window first, content when it lands — same reasoning as ./splat: a grid should not appear
  // one tile at a time in download order.
  let handle = null;
  if (wall && wall.supported) {
    handle = wall.addScene(canvas, viewer.onFrame, {
      virtualDisplayHeight,
      ...(observe ? { observe } : {}),
    });
  } else {
    viewer.startMono();
  }

  out.ready = (async () => {
    const Loader = await resolveLoader(injectedLoader);
    const loader = new Loader();

    // Read the header before parsing, so decoders are attached from what the asset DECLARES
    // rather than from a guess or from a failure. If this can't be done (an exotic URL scheme,
    // a CORS setup fetch dislikes) we fall back to the loader's own fetch and rely on the
    // message-sniffing catch below — the guidance survives, the laziness does not.
    let inspected = null;
    try {
      inspected = await fetchAndInspect(src);
    } catch (err) {
      console.debug('[inline3d/model] could not inspect', src, '— falling back to loadAsync', err);
    }

    const declared = inspected?.json ? declaredExtensions(inspected.json) : null;
    const wanted = DECODER_KINDS.filter(
      (k) => injected[k] || (declared ? declared.has(DECODERS[k].ext) : false),
    );

    for (const kind of wanted) {
      let got;
      try {
        got = await getDecoder(kind, paths, injected[kind], viewer.renderer);
      } catch (err) {
        throw decoderError(kind, src, paths, err, !!declared);
      }
      if (got.key) held.push(got.key);
      DECODERS[kind].attach(loader, got.decoder);
    }

    let gltf;
    try {
      gltf = inspected
        ? await new Promise((res, rej) => loader.parse(inspected.buffer, urlBaseOf(src), res, rej))
        : await loader.loadAsync(src);
    } catch (err) {
      // A decoder that was attached can still fail at decode time — almost always because its
      // files 404 at `decoderPath`, and three's message then carries the URL it could not fetch,
      // which is why the message is asked first. Attributing by elimination is only safe with a
      // single candidate; with none or several, the original error is the honest answer.
      const kind = kindFromMessage(String(err?.message || err)) || (wanted.length === 1 ? wanted[0] : null);
      throw kind ? decoderError(kind, src, paths, err, !!declared) : err;
    }

    out.model = gltf.scene;
    viewer.content.add(gltf.scene);

    // Meshes have exact bounds, so unlike a splat there is nothing to be robust ABOUT: no
    // percentile trim, no flood-fill, no sidecar needed. Box3 is the whole story.
    const bounds = frame || boundsOf(gltf.scene);
    if (bounds) {
      out.frame = bounds;
      viewer.fitTo(bounds.center, bounds.extent);
    }
    return out;
  })().catch((err) => {
    console.warn('[inline3d/model] failed to load', src, err);
    throw err;
  });

  return out;
}

/** Exact model-space bounds of an object tree. */
function boundsOf(object3d) {
  const box = new THREE.Box3().setFromObject(object3d);
  if (!isFinite(box.min.x) || box.isEmpty()) return null;
  const c = box.getCenter(new THREE.Vector3());
  const e = box.getSize(new THREE.Vector3());
  return { center: [c.x, c.y, c.z], extent: [Math.max(e.x, 1e-6), Math.max(e.y, 1e-6), Math.max(e.z, 1e-6)] };
}

/**
 * A neutral three-point rig. Not a substitute for a real environment map on metal or glass, but
 * it has no external dependency and no download, which matters for a tile that may be one of
 * several on a page.
 */
function addStudioLights(scene) {
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(1, 1.4, 1.6);
  const fill = new THREE.DirectionalLight(0xffffff, 0.7);
  fill.position.set(-1.4, 0.4, 0.8);
  const rim = new THREE.DirectionalLight(0xffffff, 1.0);
  rim.position.set(-0.4, 0.8, -1.6);
  scene.add(key, fill, rim, new THREE.HemisphereLight(0xffffff, 0x444444, 0.6));
}

function disposeTree(root) {
  const seen = new Set();
  const dropTextures = (mat) => {
    if (!mat || seen.has(mat)) return;
    seen.add(mat);
    // Compressed (KTX2/Basis) textures are real GPU memory and a catalogue churns through them,
    // so a tile's remove() has to give them back — the material's own dispose() does not.
    for (const v of Object.values(mat)) if (v && v.isTexture) v.dispose?.();
    mat.dispose?.();
  };
  root.traverse((o) => {
    o.geometry?.dispose?.();
    const m = o.material;
    if (Array.isArray(m)) m.forEach(dropTextures);
    else dropTextures(m);
  });
}

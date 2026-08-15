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
    observe,
  } = opts;

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
    const gltf = await new Loader().loadAsync(src);
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
  root.traverse((o) => {
    o.geometry?.dispose?.();
    const m = o.material;
    if (Array.isArray(m)) m.forEach((x) => x?.dispose?.());
    else m?.dispose?.();
  });
}

// inline3d-splat.js — a 3D Gaussian splat as an inline-3D window, in one call.
//
// EXPERIMENTAL. Not covered by the SDK's 1.x semver promise — see docs/sdk-stability.md.
//
//   import { createInline3D } from '@displayxr/inline3d';
//   import { addSplat } from '@displayxr/inline3d/splat';
//
//   const wall = await createInline3D();
//   const shoe = await addSplat(wall, canvas, 'trail-runner.sog', { virtualDisplayHeight: 0.18 });
//   shoe.exclude(document.getElementById('buy'));   // crisp 2D button over the woven 3D
//
// Pass the wall whether or not inline-3D is supported: on an ordinary browser this renders a
// flat, orbitable view of the same asset, so a page needs no branch. Splats are photoreal in a
// way meshes are not for captured goods — leather grain, knit mesh, foil, glitter — which is
// exactly the material range that sells a product.
//
// Requires `three` (>=0.180, Spark's floor) and `@sparkjsdev/spark` as peers. Both are declared
// OPTIONAL in package.json: the core SDK stays dependency-free and only pages that import this
// subpath pay for them.

import * as THREE from 'three';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import { EyeCamera, EdgeFeather } from './inline3d-three.js';
import { SceneViewer, boundsFromPositions } from './inline3d-viewer.js';

/**
 * Sort at most this often, in ms. THE stereo optimisation in this module.
 *
 * Spark sorts splats back-to-front per render() call, and a stereo frame renders twice — so
 * the default of 0 buys two full sorts per frame. The eyes are ~63 mm apart; that does not
 * meaningfully change back-to-front order for a tabletop-sized subject, so one sort serves
 * both. 16 ms lands it at one per frame at 60 Hz.
 */
const DEFAULT_SORT_INTERVAL_MS = 16;

/** Cap on how many splat centres the fallback framing pass inspects. */
const FRAME_SAMPLE_CAP = 200000;

/**
 * Load a splat into an inline-3D window.
 *
 * @param {object} wall  the manager from createInline3D(), supported or not.
 * @param {HTMLCanvasElement} canvas
 * @param {string} src  URL of a .sog / .spz / .ply / .splat / .ksplat.
 * @param {object} [opts]
 * @param {number} [opts.virtualDisplayHeight=0.24]  metres of world the tile's height spans.
 * @param {{center:number[],extent:number[]}} [opts.frame]  precomputed subject bounds. STRONGLY
 *        preferred — see "Framing" below.
 * @param {boolean} [opts.flipY=true]  apply the 180° X flip that most splat exports need.
 * @param {number} [opts.idleSpin=8]  degrees/second of turntable once idle. 0 to disable.
 * @param {boolean} [opts.orbit=true]  drag to spin, wheel to zoom.
 * @param {'contain'|'height'|'cover'|'none'} [opts.fit='contain']
 * @param {number} [opts.margin=0.8]  fraction of the tile the subject may occupy — neither its
 *        width nor its height exceeds this, whatever its proportions.
 * @param {number} [opts.depthLimit=4.0]  backstop on total depth; rarely binds.
 * @param {boolean} [opts.fitSweep=true]  fit the horizontal against the box's diagonal, so a
 *        long subject still fits once the turntable turns it.
 * @param {number} [opts.renderScale=1]  per-eye buffer scale; 0.5–0.7 is usually free.
 * @param {number} [opts.feather=0]  edge fade in buffer px.
 * @param {number} [opts.sortIntervalMs=16]  see DEFAULT_SORT_INTERVAL_MS.
 * @param {Element} [opts.observe=canvas]  element whose visibility gates the lazy lifecycle.
 * @returns {object} a TileHandle (remove/exclude/unexclude) plus `viewer`, `mesh`, `setPose`,
 *          `resetPose`, `frame` (the bounds used, null until loaded) and `ready` (a promise).
 *          SYNCHRONOUS on purpose — it mirrors addImage, so a caller can wire up overlays and
 *          controls immediately instead of awaiting a download first.
 *
 * FRAMING. A splat has no natural "front" or size, so something must decide where the subject
 * is and how big to draw it. Pass `opts.frame` when you can: the native pipeline already
 * computes exactly these bounds with an opacity-weighted voxel flood-fill that separates the
 * subject from an air-gapped background, and baking that into a sidecar at conversion time
 * costs the page nothing. Without it we fall back to trimmed percentile bounds computed here —
 * good enough for a clean, isolated capture, weaker on a scene with a background wall.
 */
export function addSplat(wall, canvas, src, opts = {}) {
  const {
    virtualDisplayHeight = 0.24,
    frame = null,
    flipY = true,
    idleSpin = 8,
    orbit = true,
    fit = 'contain',
    margin = 0.8,
    depthLimit = 4.0,
    fitSweep = true,
    renderScale = 1,
    feather = 0,
    sortIntervalMs = DEFAULT_SORT_INTERVAL_MS,
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

  // Spark renders through the ordinary three.js pipeline, so splats and meshes co-exist and
  // sort against each other — which is what lets a product page mix a captured hero with a
  // GLB accessory in one scene.
  const spark = new SparkRenderer({ renderer: viewer.renderer, minSortIntervalMs: sortIntervalMs });
  viewer.scene.add(spark);

  const mesh = new SplatMesh({ url: src });
  // Most exporters write splats Y-down (the original 3DGS convention); three.js is Y-up. Without
  // this every capture arrives upside down, which reads as a broken asset rather than a
  // convention mismatch. w=0,x=1 is a half turn about X.
  if (flipY) mesh.quaternion.set(1, 0, 0, 0);
  viewer.content.add(mesh);

  // Create the window NOW and frame it when the asset lands. Waiting for the load first would
  // mean a grid of tiles appears one at a time in download order — and it is how addImage
  // already behaves: return a handle immediately, paint when the source is ready.
  let handle = null;
  if (wall && wall.supported) {
    handle = wall.addScene(canvas, viewer.onFrame, {
      virtualDisplayHeight,
      ...(observe ? { observe } : {}),
    });
  } else {
    viewer.startMono();
  }

  const out = {
    viewer,
    mesh,
    spark,
    frame: null,
    setPose: (p) => viewer.setPose(p),
    resetPose: () => viewer.resetPose(),
    remove() {
      handle?.remove();
      viewer.dispose();
      mesh.dispose?.();
    },
    exclude: (el) => handle?.exclude(el),
    unexclude: (el) => handle?.unexclude(el),
  };

  out.ready = mesh.initialized
    .then(() => {
      const bounds = frame || measureBounds(mesh, THREE);
      if (bounds) {
        out.frame = bounds;
        viewer.fitTo(bounds.center, bounds.extent);
      }
      return out;
    })
    .catch((err) => {
      // A failed load must not take the page down. The tile stays empty, `ready` rejects, and
      // the caller decides whether that is a placeholder or an error state.
      console.warn('[inline3d/splat] failed to load', src, err);
      throw err;
    });

  return out;
}

/**
 * Percentile bounds from the loaded splats — the fallback when no sidecar was supplied.
 *
 * Two cheats keep this off the critical path. Near-transparent splats are skipped: they are
 * overwhelmingly haze and floaters, and including them drags the box outwards. And above
 * FRAME_SAMPLE_CAP we stride: percentiles of a uniform subsample of 200k points are
 * indistinguishable from percentiles of two million, at a tenth of the cost.
 *
 * The result is lifted out of the mesh's LOCAL space through its own matrix, because by the
 * time this runs the Y-flip is already on the mesh — and the viewer centres content one level
 * above it. Skip that and every flipped capture frames to a point mirrored through the origin,
 * which looks like the subject drifting off the tile for no reason. Extents ride the matrix
 * columns rather than being re-projected onto world axes: same convention the native
 * ComputeAutoFrame uses, and exact for the axis-aligned flips that actually occur.
 */
export function measureSplatBounds(mesh, three = THREE) {
  return measureBounds(mesh, three);
}

function measureBounds(mesh, THREE) {
  const total = mesh.numSplats || 0;
  if (!total) return null;
  const stride = Math.max(1, Math.ceil(total / FRAME_SAMPLE_CAP));
  const xyz = new Float32Array(Math.ceil(total / stride) * 3);
  let k = 0;
  mesh.forEachSplat((index, center, scales, quaternion, opacity) => {
    if (index % stride !== 0) return;
    if (opacity !== undefined && opacity < 0.05) return;
    if (k + 3 > xyz.length) return;
    xyz[k++] = center.x;
    xyz[k++] = center.y;
    xyz[k++] = center.z;
  });
  const local = boundsFromPositions(xyz.subarray(0, k));
  if (!local) return null;

  mesh.updateMatrix();
  const m = mesh.matrix;
  const c = new THREE.Vector3(local.center[0], local.center[1], local.center[2]).applyMatrix4(m);
  const col = new THREE.Vector3();
  const e = [0, 1, 2].map(
    (axis) => col.setFromMatrixColumn(m, axis).length() * local.extent[axis],
  );
  return { center: [c.x, c.y, c.z], extent: e };
}

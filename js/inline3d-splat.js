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
import { EyeCamera, EdgeFeather, cameraRigFromCamera } from './inline3d-three.js';
import { SceneViewer, boundsFromPositions } from './inline3d-viewer.js';
import { readSogCamera } from './inline3d-sog.js';
import { applySplatPerf, splatPerfMeshOptions } from './inline3d-splat-perf.js';

export { applySplatPerf, SPLAT_PERF_PRESETS } from './inline3d-splat-perf.js';
export { readSogCamera, readSogMeta } from './inline3d-sog.js';

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
 * three.js floor for THIS subpath — Spark's own floor, above the package-wide >=0.150 that the
 * core and ./three ask for.
 *
 * npm cannot express a peer range per export, so the manifest has to state the LOWER bound and a
 * consumer on 0.16x installs cleanly, then fails somewhere inside a Spark worker with a message
 * about neither three nor versions. Checking here turns that into one sentence naming the actual
 * problem. Kept as a number: THREE.REVISION is a bare string like "180", not a semver triple.
 */
const THREE_MIN_REVISION = 180;

/**
 * Identify a splat container from its first bytes.
 *
 * Spark resolves a file's format from the URL PATH, and has a magic-byte sniffer it does not
 * apply to the fileBytes route — so bytes arrive as "Unknown file type" unless someone says what
 * they are. That is a trap for exactly the interesting case: a URL ending in `.sog` loads fine
 * while the identical bytes in a Blob do not.
 *
 * Rather than make every caller know Spark's type names (which are not the file extensions —
 * a `.sog` is `pcsogszip`), work it out here.
 */
function sniffFileType(bytes) {
  if (!bytes || bytes.length < 4) return undefined;
  const [b0, b1, b2, b3] = bytes;
  // PK 03 04 — a PKZip. A .sog from splat-transform is a zip of webp planes + meta.json.
  if (b0 === 0x50 && b1 === 0x4b && b2 === 0x03 && b3 === 0x04) return 'pcsogszip';
  // "ply" — ASCII header
  if (b0 === 0x70 && b1 === 0x6c && b2 === 0x79) return 'ply';
  // gzip — .spz is gzipped
  if (b0 === 0x1f && b1 === 0x8b) return 'spz';
  // "RAD0"
  if (b0 === 0x52 && b1 === 0x41 && b2 === 0x44 && b3 === 0x30) return 'rad';
  // .splat / .ksplat are raw arrays with no magic — indistinguishable by content, which is
  // exactly what `fileName` is for.
  return undefined;
}

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
 * @param {true|'balanced'|'aggressive'|object} [opts.perf]  cut overdraw. Unset (the default)
 *        changes nothing: every Spark default stays where Spark put it. `'balanced'` is the
 *        native renderer's pair — each quad shrunk to its own 1/255 alpha radius, plus the 1/255
 *        opacity cull — and is bit-exact; `'aggressive'` adds a sub-pixel cull and a tighter
 *        global σ, which do move pixels. Table + the bit-exactness conditions:
 *        ./inline3d-splat-perf.js.
 * @param {'auto'|'display'|'camera'} [opts.rig='auto']  which view rig. `auto` reads it off the
 *        asset: a `.sog` whose `meta.json` carries a `camera` block was lifted from a photograph
 *        and gets a CAMERA rig that conserves the recording camera (its FOV, its position, its
 *        principal point, in a metric scene); anything else is an object and gets the display
 *        rig with the auto-frame, which is what every existing page already has. Only read from
 *        BYTES. On the camera path the subject is NOT reframed and the idle turntable is off
 *        unless you asked for one.
 * @param {number} [opts.convergence]  camera rig only: the distance, in world metres, that sits
 *        ON the glass. Defaults to the distance from the capture camera to the measured subject
 *        centre.
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
  // Fail here, synchronously, and not through `ready`: a peer too old is an install-time mistake
  // in the page's dependencies, not a condition of this asset, and it will be true of every call.
  // Surfacing it as a load rejection would let a caller render an "asset unavailable" placeholder
  // over what is really a version problem.
  const rev = parseInt(THREE.REVISION, 10);
  if (Number.isFinite(rev) && rev < THREE_MIN_REVISION) {
    throw new Error(
      `@displayxr/inline3d/splat needs three >= 0.${THREE_MIN_REVISION} (Spark's floor); ` +
      `found 0.${THREE.REVISION}. The package-wide peer range is >=0.150 because the core and ` +
      `./three work there — this subpath does not. Upgrade three, or use ./model for meshes.`,
    );
  }

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
    perf = null,
    rig = 'auto',
    convergence,
    fileName,
    fileType,
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
  // Nothing happens unless the page asked: with no `perf` every Spark default stays where Spark
  // put it, so an existing page's pixels do not move. See ./inline3d-splat-perf.js for the table
  // of what each knob costs and whether it is bit-exact.
  const perfApplied = perf ? applySplatPerf(spark, perf) : null;

  // THE HANDLE IS DECLARED BEFORE THE LOADER, and that is load-bearing — not style.
  //
  // The loader below is an async IIFE that assigns `out.mesh`. An async function body runs
  // SYNCHRONOUSLY up to its first `await`, and the URL path has no await at all: `init = {url}`,
  // construct, add to the scene, assign. So with `out` declared after it, that assignment lands
  // in `out`'s temporal dead zone and throws ReferenceError — on the URL path only, which is
  // every ordinary page, while the Blob path (which awaits arrayBuffer()) sails through.
  //
  // The failure was near-invisible and cost days: the throw escapes into meshReady, so `ready`
  // rejects while the mesh is ALREADY in the scene from the line above — the splat renders, just
  // never framed, i.e. at raw model scale. A subject that reads "far too large" with no error on
  // the console and a fit pipeline that provably never executed.
  let handle = null;
  const out = {
    viewer,
    // null until the bytes are read and the mesh is constructed; use `ready` to await it.
    mesh: null,
    spark,
    frame: null,
    /**
     * The `.sog`'s `camera` block, once the bytes have been read — null for a URL source, a
     * non-`.sog`, or an asset that carries no block (which is most of them, and means "this is
     * an object, use the display rig"). See ./inline3d-sog.js.
     */
    camera: null,
    /** Which rig this window ended up on: `'display'` or `'camera'`. Null until `ready`. */
    rig: null,
    /** What `perf` actually applied, or null. Useful for a diagnostics readout. */
    perf: perfApplied,
    setPose: (p) => viewer.setPose(p),
    resetPose: () => viewer.resetPose(),
    remove() {
      handle?.remove();
      viewer.dispose();
      out.mesh?.dispose?.();
    },
    exclude: (el) => handle?.exclude(el),
    unexclude: (el) => handle?.unexclude(el),
  };

  // `src` may be a URL or the bytes themselves.
  //
  // Bytes matter for anything GENERATED rather than fetched: a freshly converted splat lives in
  // a Blob, and the obvious move — URL.createObjectURL() — hands Spark a `blob:…` URL with no
  // extension. Spark infers format partly from the URL, so that fails with "Unknown file type"
  // from inside its worker, which reads like a corrupt file rather than a missing hint. Passing
  // fileBytes lets it sniff the content instead. `fileName` is only needed to disambiguate
  // .splat/.ksplat, which content-sniffing cannot separate.
  let mesh = null;
  const meshReady = (async () => {
    let init;
    if (typeof src === 'string') {
      init = { url: src };
    } else {
      const buf = src instanceof Blob ? await src.arrayBuffer() : src;
      const fileBytes = new Uint8Array(buf);
      const sniffed = fileType || sniffFileType(fileBytes);
      init = {
        fileBytes,
        ...(sniffed ? { fileType: sniffed } : {}),
        ...(fileName ? { fileName } : {}),
      };
      // Read the camera block off the SAME bytes, before Spark takes them. Only possible on the
      // bytes path — a URL source would need a second fetch of ten megabytes to learn 200 of
      // them, so that is deliberately not done. (It is also not a limitation in practice: the
      // asset that HAS a camera block is a generated/streamed one, which is the bytes path.)
      if (rig !== 'display') out.camera = await readSogCamera(fileBytes);
    }
    mesh = new SplatMesh({ ...init, ...splatPerfMeshOptions(perf) });
    // Most exporters write splats Y-down (the original 3DGS convention); three.js is Y-up.
    // Without this every capture arrives upside down, which reads as a broken asset rather than
    // a convention mismatch. w=0,x=1 is a half turn about X.
    if (flipY) mesh.quaternion.set(1, 0, 0, 0);
    viewer.content.add(mesh);
    out.mesh = mesh;
    return mesh;
  })();

  // Create the window NOW and frame it when the asset lands. Waiting for the load first would
  // mean a grid of tiles appears one at a time in download order — and it is how addImage
  // already behaves: return a handle immediately, paint when the source is ready.
  if (wall && wall.supported) {
    handle = wall.addScene(canvas, viewer.onFrame, {
      virtualDisplayHeight,
      // The layer can go away for good (the session ends, the constructor refuses): take the
      // canvas flat rather than leave its last side-by-side frame on the page (web#28).
      onLayerLost: viewer.onLayerLost,
      ...(observe ? { observe } : {}),
    });
  } else {
    viewer.startMono();
  }

  // Await the MESH first, then its load. Reading `mesh.initialized` here directly would
  // dereference null: constructing from bytes is async (the Blob has to be read), so `mesh` does
  // not exist yet on this line — only inside meshReady.
  out.ready = meshReady
    .then((m) => m.initialized)
    .then(() => {
      // MEASURE FIRST, always. `frame` is only a fallback.
      //
      // A supplied frame has to survive two coordinate changes to be usable — the converter's
      // space to the file's, and the file's to whatever the loader normalises to internally —
      // and getting either wrong produces a subject that is mis-scaled and off-centre with no
      // error anywhere. That was got wrong twice here. Measuring the splats as they actually
      // sit in the loaded mesh cannot be in the wrong space by construction: it reads the same
      // positions the renderer draws. It costs one pass over (a sample of) the centres at load,
      // which is what the working reference sample has always done.
      const bounds = measureBounds(out.mesh, THREE) || (frame ? liftBounds(frame, out.mesh, THREE) : null);

      // WHICH RIG. `rig:'auto'` (the default) reads it off the ASSET: a `camera` block means the
      // splat was lifted from a photograph, and a photograph has a viewpoint to conserve — the
      // capture's own FOV, at the capture's own position, in a metric scene. No block means an
      // object, which is the display rig, the auto-frame, and everything this module did before.
      //
      // That is the subject-vs-viewpoint test from docs/authoring-inline-3d.md §"Which rig",
      // answered by the file instead of by the page. It is the one case where a splat viewer
      // cannot decide for itself: the same call site loads a product turntable and a lifted
      // photograph, and they want opposite rigs.
      const wantCamera = rig === 'camera' || (rig === 'auto' && !!out.camera);
      if (wantCamera && !out.camera) {
        console.warn(
          "[inline3d/splat] rig:'camera' but this source carries no camera block (a URL source " +
            'is never read for one — pass BYTES), so the display rig is used.',
          src,
        );
      }
      if (wantCamera && out.camera) {
        out.rig = 'camera';
        out.frame = bounds;
        // A turntable on a photograph is nonsense, so the default spin stops here — but only the
        // DEFAULT: a page that asked for one still gets it.
        if (!('idleSpin' in opts)) viewer.idleSpin = 0;
        applyCaptureCamera(viewer, out.camera, flipY);
        const conv = Number.isFinite(convergence) ? convergence : convergenceFor(viewer, bounds);
        // DECLARE the rig; the off-axis projection stays in the runtime, exactly as it does for
        // every other window in this SDK. The mono camera is already posed and FOV'd as the
        // capture, so it is the camera to describe.
        out.viewRig = cameraRigFromCamera(THREE, viewer.monoCamera, { convergence: conv });
        handle?.setViewRig(out.viewRig);
      } else if (bounds) {
        out.rig = 'display';
        out.frame = bounds;
        viewer.fitTo(bounds.center, bounds.extent);
      } else {
        out.rig = 'display';
        // Unframed means drawn at raw MODEL scale, which for a typical capture is several times
        // the tile. Say so: silence here is what made the same condition read as a fit bug.
        console.warn('[inline3d/splat] no usable bounds — subject is UNFRAMED (model scale)', src);
      }
      return out;
    })
    .catch((err) => {
      // A failed load must not take the page down: `ready` rejects and the caller decides whether
      // that is a placeholder or an error state.
      //
      // Detach the mesh, because failure can happen AFTER it joined the scene — and an unframed
      // mesh is not a blank tile, it is a subject at model scale spilling out of the window. An
      // error state the caller paints over a giant splat is worse than an empty one.
      if (mesh) viewer.content.remove(mesh);
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
/**
 * Pose and lens the viewer's mono camera AS THE RECORDING CAMERA.
 *
 * This is the 2D half of the camera rig, and the only place in this SDK that builds a projection
 * matrix itself. That is not a contradiction of "declare the rig, never compute": the 3D path
 * below sends a descriptor and consumes the runtime's views as always — but the mono fallback has
 * no runtime and no stereo, so SOMETHING has to render the capture, and the honest thing to
 * render is the capture's own frustum. Get it wrong and the flat view is a crop or a zoom of the
 * photograph, which reads as a framing bug.
 *
 * THE FLIP MOVES THE CAMERA TOO. `flipY` puts a 180° X rotation on the MESH (most exports are
 * Y-down; three is Y-up), so a rest pose recorded in the file's own frame has to ride the same
 * rotation or the camera ends up mirrored through the origin — the identity pose the gallery's
 * assets carry hides this completely, which is exactly why it is done properly here.
 *
 * ASPECT. The intrinsics fix the capture's aspect and the canvas has its own. The vertical is
 * kept and the horizontal is widened or narrowed to the canvas — `fit:'height'`'s convention, and
 * the one that keeps a face the same size whatever shape the tile is. The principal point rides
 * along, so a deconverged capture (`cx` off centre) keeps its lens shift.
 *
 * `updateProjectionMatrix` is REPLACED, not just called: the viewer recomputes it on every
 * resize, and three's symmetric version would silently throw the off-axis window away on the
 * first layout nudge.
 */
function applyCaptureCamera(viewer, cam, flipY) {
  const camera = viewer.monoCamera;
  const { fx, fy, cx, cy, width, height } = cam.intrinsics;

  const q = new THREE.Quaternion(
    cam.rest.rotation[0],
    cam.rest.rotation[1],
    cam.rest.rotation[2],
    cam.rest.rotation[3],
  );
  const p = new THREE.Vector3(cam.rest.position[0], cam.rest.position[1], cam.rest.position[2]);
  if (flipY) {
    const flip = new THREE.Quaternion(1, 0, 0, 0);
    p.applyQuaternion(flip);
    q.premultiply(flip);
  }
  camera.position.copy(p);
  camera.quaternion.copy(q);
  camera.fov = THREE.MathUtils.radToDeg(cam.verticalFov);
  // FAR, and why it is not the viewer's default. A deconverged capture parks its sky at the
  // lifter's depth cap and the refinement scatters some gaussians beyond it (239 m measured on a
  // street scene); anything past the far plane is CLIPPED in Spark's vertex shader and pops out
  // as a black hole the moment an orbit pushes it over. Spark composites by SORTING, not by
  // depth-testing, so there is no z precision to protect and a huge near:far ratio costs nothing.
  camera.far = Math.max(camera.far, 5000);
  camera.updateMatrixWorld(true);

  camera.updateProjectionMatrix = () => {
    const near = camera.near;
    // OpenCV's y grows DOWN the image, so the TOP edge is the `cy` side.
    const top = (near * cy) / fy;
    const bottom = -(near * (height - cy)) / fy;
    const box = viewer.canvas.getBoundingClientRect();
    const aspect = box.height > 0 ? box.width / box.height : width / height;
    const mid = (near * (width / 2 - cx)) / fx; // horizontal centre of the capture's frustum
    const half = ((top - bottom) * aspect) / 2;
    camera.projectionMatrix.makePerspective(mid - half, mid + half, top, bottom, near, camera.far);
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  };
  camera.updateProjectionMatrix();
}

/**
 * Default convergence for a camera rig: the distance from the capture camera to the middle of
 * what was captured.
 *
 * Convergence is the distance that lands ON the glass, and it is the one number a camera rig
 * cannot be left to guess — 0 means infinity, which puts the entire scene in front of the display
 * and is comfortable for almost nothing. The `camera` block does not carry one (it describes a
 * lens, not a presentation), so the measured subject centre is the honest stand-in: it is the
 * same "converge on the median scene point" the gallery derives from its own columns.
 */
function convergenceFor(viewer, bounds) {
  if (!bounds) return 0;
  const c = viewer.monoCamera.position;
  const d = Math.hypot(bounds.center[0] - c.x, bounds.center[1] - c.y, bounds.center[2] - c.z);
  return Number.isFinite(d) && d > 0 ? d : 0;
}

/** Map model-space bounds through a mesh's own transform, matching the native ComputeAutoFrame. */
function liftBounds(b, mesh, THREE) {
  if (!b || !mesh) return b;
  mesh.updateMatrix();
  const m = mesh.matrix;
  const c = new THREE.Vector3(b.center[0], b.center[1], b.center[2]).applyMatrix4(m);
  const col = new THREE.Vector3();
  const e = [0, 1, 2].map((axis) => col.setFromMatrixColumn(m, axis).length() * b.extent[axis]);
  return { center: [c.x, c.y, c.z], extent: e };
}

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

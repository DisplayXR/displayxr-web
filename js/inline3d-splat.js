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
import {
  toArray3,
  canvasNdc,
  bindFocusGestures,
  captureWindow,
  captureVerticalFovDeg,
  CAPTURE_FITS,
  playcanvasCannotRead,
  isStreamedUrl,
  STREAMED_NEEDS_PLAYCANVAS,
  resolveControls,
  normalizeCameraPose,
} from './inline3d-splat-shared.js';
import {
  resolveRig,
  planeDistance,
  sampleCloudRestSpace,
  rigNeedsCloud,
  sampleCloudCentres,
  RIG_SAMPLE_CAP,
  RIG_MIN_OPACITY,
  resolveSplatEngine,
} from './inline3d-splat-rig.js';

export { applySplatPerf, SPLAT_PERF_PRESETS } from './inline3d-splat-perf.js';
export { readSogCamera, readSogMeta } from './inline3d-sog.js';
export { resolveRig } from './inline3d-splat-rig.js';

/**
 * Sort at most this often, in ms. THE stereo optimisation in this module.
 *
 * Spark sorts splats back-to-front per render() call, and a stereo frame renders twice — so
 * the default of 0 buys two full sorts per frame. The eyes are ~63 mm apart; that does not
 * meaningfully change back-to-front order for a tabletop-sized subject, so one sort serves
 * both. 16 ms lands it at one per frame at 60 Hz.
 */
const DEFAULT_SORT_INTERVAL_MS = 16;

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
 * @param {true|'exact'|'balanced'|'aggressive'|object} [opts.perf]  cut overdraw. Unset (the
 *        default) changes nothing: every Spark default stays where Spark put it. `'exact'` is the
 *        bit-exact pair (each quad shrunk to its own 1/255 alpha radius, plus the 1/255 opacity
 *        cull) and buys little on a mostly-opaque capture; `'balanced'` (also `true`) and
 *        `'aggressive'` tighten the quad extent, which is the axis that measured. Every knob,
 *        what it costs in pixels, and the measurements: ./inline3d-splat-perf.js.
 * @param {'auto'|'display'|'camera'} [opts.rig='auto']  which view rig. `auto` asks the ASSET:
 *        the `camera` block's own `rig`, or — for a block that does not say — a camera rig,
 *        since a block at all means a camera was recorded. No block is a display rig with the
 *        auto-frame, which is what every existing page already has. Only read from BYTES. On the
 *        camera path the subject is NOT reframed and the idle turntable is off unless you asked
 *        for one. Full waterfall: ./inline3d-splat-rig.js.
 * @param {number[]} [opts.focus]  the point to converge on and orbit about, in the splat's own
 *        space. Top of the focus waterfall; below it the block's `focus.point`, then the median
 *        disparity of the cloud, then 2 m.
 * @param {number} [opts.convergence]  the straight-ahead shorthand for `focus`: a distance in
 *        world metres along the capture's view axis.
 * @param {object} [opts.intrinsics]  override the lens ({fx,fy,cx,cy,width,height}, one eye,
 *        OpenCV). Only consulted when the asset carries none.
 * @param {number} [opts.ipdFactor=1]  camera rig eye separation, ABSOLUTE.
 * @param {number} [opts.parallaxFactor=1]  camera rig head-tracking response, ABSOLUTE.
 * @param {boolean} [opts.focusInput=true]  bind double-click (focus what was clicked) and Space
 *        (back to the resolved focus).
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
  if (opts.captureFit !== undefined && !CAPTURE_FITS.includes(opts.captureFit)) {
    throw new Error(
      `@displayxr/inline3d/splat: captureFit "${opts.captureFit}" — expected ` +
        `${CAPTURE_FITS.map((f) => `'${f}'`).join(' or ')}.`,
    );
  }
  // WHO OWNS THE CAMERA. Validated here, synchronously, for both engines (an unknown `controls`
  // or a comfortDepth out of range is a page bug true of every call).
  const { page: pageControls } = resolveControls(opts);
  // WHICH ENGINE. Unset (or 'spark') is everything below, untouched. 'playcanvas' goes to
  // ./inline3d-splat-playcanvas.js, imported DYNAMICALLY so a page that never asks for it never
  // resolves `playcanvas` — see addSplatDeferred.
  if (resolveSplatEngine(opts) === 'playcanvas') {
    // A format that engine provably cannot read (a .spz URL, gzip bytes, a Spark-only fileType)
    // is a page bug: say so NOW rather than fail inside a loader later.
    const why = playcanvasCannotRead(src, opts);
    if (why) throw new Error(`@displayxr/inline3d/splat: ${why}`);
    return addSplatDeferred(wall, canvas, src, opts);
  }

  // controls:'page' is a PlayCanvas-backend feature (docs/playcanvas-adapter.md §controls:'page'):
  // on Spark it would need SceneViewer — which ./viewer and ./model share — to take an external
  // camera in both its mono and eye paths. Refused by name rather than half-supported.
  if (pageControls) {
    throw new Error(
      "@displayxr/inline3d/splat: controls:'page' is not supported on Spark (the default engine) — " +
        "pass engine:'playcanvas'. Spark's viewer owns its camera; see docs/playcanvas-adapter.md.",
    );
  }

  // A Streamed SOG on Spark is a page bug (Spark has no lod-meta.json reader): say so now, by
  // name, rather than let Spark fail on an "unknown file type" that reads like a corrupt asset.
  if (isStreamedUrl(src)) throw new Error(`@displayxr/inline3d/splat: ${STREAMED_NEEDS_PLAYCANVAS}`);

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
    captureFit = 'height',
    focusInput = true,
    convergence,
    fileName,
    fileType,
    observe,
    firstWovenHoldMs,
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
    backend: 'spark',
    /**
     * ADVANCED, not covered by the semver promise: the three.js objects behind this window, for
     * a page that wants to add its own content. `camera` is whichever camera draws the current
     * frame (an eye in 3D, the mono camera flat).
     */
    engine: Object.freeze({
      renderer: viewer.renderer,
      scene: viewer.scene,
      get camera() {
        return (viewer.is3D && viewer._eye?.camera) || viewer.monoCamera;
      },
    }),
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
    /**
     * What the WATERFALL resolved — the rig, the lens and the focus, each beside the step that
     * produced it (`rig.focusSource`, `rig.intrinsicsSource`, `rig.typeSource`). Null until
     * `ready`. See ./inline3d-splat-rig.js.
     */
    rig: null,
    /** What `perf` actually applied, or null. Useful for a diagnostics readout. */
    perf: perfApplied,
    setPose: (p) => viewer.setPose(p),
    resetPose: () => viewer.resetPose(),
    /**
     * Point the window at something — the orbit centre, the pivot plane and (on a camera rig)
     * the convergence, which are one thing.
     *
     * @param {number[]|{x:number,y:number,z:number}|null} point  in the SPLAT's own space: the
     *        same space the `camera` block's `focus.point` is in, so a host page can hand over a
     *        point it read from the asset's metadata without knowing anything about this SDK's
     *        scene graph. Null returns to whatever the waterfall resolved.
     * @param {object} [o]
     * @param {boolean} [o.snap=false]  arrive immediately instead of easing.
     */
    setFocus(point, o = {}) {
      if (!out.mesh || !out.rig) return out;
      const model = point == null ? out.rig.focusDefault : toArray3(point);
      out.rig.focus = model;
      out.rig.focusSource = point == null ? out.rig.focusDefaultSource : 'set';
      // Keep the two in step on BOTH rigs. A camera rig re-derives this from the eased focus
      // every frame (pushViewRig), but a display rig has no rig to push — and a `convergence`
      // left describing a focus that has since moved is exactly the kind of quietly stale
      // readback this handle exists to avoid.
      out.rig.convergence = planeDistance(out.rig.rest, model);
      viewer.setFocus(toContentSpace(out.mesh, model, THREE), o);
      return out;
    },
    /**
     * What is under a point on the canvas, in the splat's own space — the raycast behind the
     * double-click, exposed so a page can build its own gesture.
     *
     * @returns {number[]|null}
     */
    pick(clientX, clientY) {
      const p = pickPoint(clientX, clientY);
      return p ? toModelSpace(out.mesh, p, THREE) : null;
    },
    remove() {
      unbindFocusInput?.();
      viewer.onFocusChange = null;
      handle?.remove();
      viewer.dispose();
      out.mesh?.dispose?.();
    },
    exclude: (el) => handle?.exclude(el),
    unexclude: (el) => handle?.unexclude(el),
    /** Where the window is pointed, in the SPLAT's own space; null before load. */
    getFocus(o) {
      if (!out.mesh) return null;
      const f = viewer.getFocus(o);
      return toModelSpace(out.mesh, viewer.content.localToWorld(new THREE.Vector3(f.x, f.y, f.z)), THREE);
    },
    /** Called with the live focus, in the splat's own space, whenever it moves. */
    onFocusChange: null,
    /** Not on this backend: controls:'page' is a PlayCanvas-backend feature. */
    setCameraPose() {
      throw new Error(
        "@displayxr/inline3d/splat: setCameraPose() needs addSplat(…, { engine:'playcanvas', controls:'page' }).",
      );
    },
    getCameraPose: () => null,
    /** Not on this backend: the crossfading asset swap is a PlayCanvas-backend feature. */
    setSource() {
      throw new Error(
        "@displayxr/inline3d/splat: setSource() is implemented on the PlayCanvas backend " +
          "only; with the Spark backend, remove() this handle and addSplat() the new asset.",
      );
    },
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
      ...(firstWovenHoldMs !== undefined ? { firstWovenHoldMs } : {}),
    });
  } else {
    viewer.startMono();
  }
  // The core handle's `firstWoven`, forwarded; a page with no session is told so at once.
  out.firstWoven = handle ? handle.firstWoven : Promise.resolve(Object.freeze({ woven: false, confirmed: false, reason: 'unsupported', ms: 0 }));


  // ── focus: declaring it, and the two gestures that change it ──────────────────────────
  //
  // The rig descriptor is re-DECLARED whenever the focus moves, which is every frame while it
  // eases. That is the cheap half of the contract — `setViewRig` is a per-locate value, there is
  // nothing to tween and nothing to tear down — and it is the only thing the runtime needs to
  // re-converge. Nothing here computes an off-axis projection.
  let lastConvergence = Number.NaN;
  const rigScratch = { fwd: null, tmp: null };
  function pushViewRig(force) {
    if (!out.rig || out.rig.type !== 'camera') return;
    const cam = viewer.monoCamera;
    if (!rigScratch.fwd) {
      rigScratch.fwd = new THREE.Vector3();
      rigScratch.tmp = new THREE.Vector3();
    }
    const f = viewer.getFocus();
    // three looks down -z; the convergence is the focus's distance along that axis — the PLANE,
    // not the radius, because that is what a zero-disparity plane is.
    rigScratch.fwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
    const d = rigScratch.tmp.set(f.x, f.y, f.z).sub(cam.position).dot(rigScratch.fwd);
    if (!force && Math.abs(d - lastConvergence) < 1e-3) return;
    lastConvergence = d;
    out.rig.convergence = d;
    out.viewRig = cameraRigFromCamera(THREE, cam, {
      convergence: d > 0 ? d : 0,
      ipdFactor: out.rig.ipdFactor,
      parallaxFactor: out.rig.parallaxFactor,
      out: out.viewRig || {},
    });
    handle?.setViewRig(out.viewRig);
  }
  viewer.onFocusChange = () => {
    pushViewRig(false);
    const cb = out.onFocusChange;
    if (typeof cb === 'function' && out.mesh) cb(out.getFocus(), { focusSource: out.rig?.focusSource ?? null });
  };

  /**
   * What is under a point on the canvas.
   *
   * Spark's `SplatMesh.raycast` is the real answer and is used when it produces one — it is the
   * ordinary three.js hook, so it is `raycastable` (default true) and `minRaycastOpacity`
   * (default 0.2) that decide what counts as solid. When it returns nothing (a thin or very
   * transparent region, an older Spark, a mesh with raycasting turned off) this falls back to
   * the NEAREST GAUSSIAN TO THE RAY by angular distance, preferring the closest one inside a
   * small cone. That is an approximation and is documented as one: it picks a splat CENTRE
   * rather than a surface, so on a thick soft surface it lands a little behind where the cursor
   * appears to be. For a focus point — a plane to converge on and turn about — that is well
   * within the tolerance; do not build a measuring tool on it.
   */
  const PICK_CONE_RAD = 0.02;
  let raycaster = null;
  function pickPoint(clientX, clientY) {
    const mesh = out.mesh;
    if (!mesh) return null;
    // NDC from the CSS box (./inline3d-splat-shared.js says why the box and not the store).
    const ndc = canvasNdc(canvas, clientX, clientY);
    if (!ndc) return null;
    const cam = (viewer.is3D && viewer._eye?.camera) || viewer.monoCamera;
    if (!raycaster) raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, cam);
    if (mesh.raycastable !== false && typeof mesh.raycast === 'function') {
      const hits = [];
      try {
        mesh.raycast(raycaster, hits);
      } catch (err) {
        console.warn('[inline3d/splat] Spark raycast threw; falling back to nearest gaussian', err);
      }
      if (hits.length) {
        hits.sort((a, b) => a.distance - b.distance);
        if (hits[0].point) return hits[0].point.clone();
      }
    }
    return nearestGaussianToRay(mesh, raycaster.ray, THREE);
  }

  // ── input ─────────────────────────────────────────────────────────────────────────────
  let unbindFocusInput = null;
  function bindFocusInput() {
    if (focusInput === false || unbindFocusInput) return;
    const off = bindFocusGestures(canvas, {
      onDoubleClick: (e) => {
        const world = pickPoint(e.clientX, e.clientY);
        if (!world) return false;
        out.mesh.updateWorldMatrix(true, false);
        out.rig.focus = toArray3(out.mesh.worldToLocal(world.clone()));
        out.rig.focusSource = 'picked';
        out.rig.convergence = planeDistance(out.rig.rest, out.rig.focus);
        viewer.content.updateWorldMatrix(true, false);
        viewer.setFocus(toArray3(viewer.content.worldToLocal(world.clone())));
        return true;
      },
      onReset: () => out.setFocus(null),
    });
    unbindFocusInput =
      off &&
      (() => {
        off();
        unbindFocusInput = null;
      });
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
      // THE WATERFALL. Three questions — which rig, what lens, what is it looking at — each
      // answered by the best source that has an answer, with the step that answered it recorded
      // next to the value (`handle.rig.focusSource` and friends). js/inline3d-splat-rig.js holds
      // the arithmetic and the reasoning; this is the plumbing.
      //
      // One pass over the cloud feeds two of the three: the angular extent about the rest camera
      // is the lens, and the median of 1/z is the focus. Skipped entirely when the block already
      // answers both, so an asset that carries a full camera pays nothing for it.
      const cloud =
        !rigNeedsCloud(out.camera)
          ? null
          : sampleRestSpace(out.mesh, out.camera?.rest);
      const box = canvas.getBoundingClientRect();
      const resolved = resolveRig({
        camera: out.camera,
        opts,
        cloud,
        canvasAspect: box.height > 0 ? box.width / box.height : 4 / 3,
      });
      // What Space goes back to. Kept beside the live value so a pick can be undone without
      // re-running the waterfall (which would walk the cloud again).
      resolved.focusDefault = resolved.focus.slice();
      resolved.focusDefaultSource = resolved.focusSource;
      out.rig = resolved;
      out.frame = bounds;

      if (resolved.type === 'camera') {
        // A turntable on a photograph is nonsense, so the default spin stops here — but only the
        // DEFAULT: a page that asked for one still gets it.
        if (!('idleSpin' in opts)) viewer.idleSpin = 0;
        applyCaptureCamera(viewer, resolved, flipY, THREE, captureFit, () => pushViewRig(true));
        // The capture does not move; only what the rotation turns about does. Snapped, because
        // this is the asset arriving, not a gesture.
        viewer.setFocus(toContentSpace(out.mesh, resolved.focus, THREE), {
          snap: true,
          recentre: false,
        });
        pushViewRig(true);
      } else {
        if (bounds) viewer.fitTo(bounds.center, bounds.extent);
        else {
          // Unframed means drawn at raw MODEL scale, which for a typical capture is several
          // times the tile. Say so: silence here is what made the same condition read as a fit
          // bug.
          console.warn('[inline3d/splat] no usable bounds — subject is UNFRAMED (model scale)', src);
        }
        // A display rig takes the focus as its ORBIT CENTRE, which is the one thing the two rigs
        // share. Only when something actually said where to look: a bare `median-disparity`
        // guess has no business overriding an auto-frame that measured the subject.
        if (resolved.focusSource === 'caller' || resolved.focusSource === 'block') {
          viewer.setFocus(toContentSpace(out.mesh, resolved.focus, THREE), {
            snap: true,
            recentre: true,
          });
        }
      }
      bindFocusInput();
      return out;
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
 * The `engine: 'playcanvas'` handle, returned SYNCHRONOUSLY like the Spark one.
 *
 * The adapter module is loaded on demand, so for a moment the handle exists before its
 * implementation does. Rather than make every caller await something new, the handle starts as
 * stubs that QUEUE: `exclude()` (which a product page calls on the very next line), `setPose`,
 * `setFocus`, `remove` — and the adapter replays the queue into the real implementation, on the
 * SAME object, the moment it arrives. `ready` resolves to this object, as it does on Spark.
 * Fields (`viewer`, `mesh`, `rig`, …) are null until then; `viewer` in particular appears one
 * module-load later than on Spark.
 */
function addSplatDeferred(wall, canvas, src, opts) {
  const pending = [];
  const queue = (name) => (...args) => {
    pending.push([name, args]);
    return name === 'setFocus' ? out : undefined;
  };
  const page = opts.controls === 'page';
  const pageOnly = (name) => () => {
    throw new Error(
      `@displayxr/inline3d/splat: ${name}() is not available with controls:'page' — the page owns the ` +
        'camera. Drive it with handle.setCameraPose(matrixWorld, { verticalFovDeg, near, far }).',
    );
  };
  // Before the adapter lands, a page calling setCameraPose every frame keeps ONE pending pose
  // (validated now, so a bad call throws at its own line): last call wins, as it will after.
  let pendingPose = null;
  const out = {
    backend: 'playcanvas',
    engine: null,
    viewer: null,
    mesh: null,
    frame: null,
    camera: null,
    rig: null,
    perf: null,
    setPose: page ? pageOnly('setPose') : queue('setPose'),
    resetPose: page ? pageOnly('resetPose') : queue('resetPose'),
    setCameraPose(matrixWorld, o) {
      if (!page) {
        throw new Error(
          "@displayxr/inline3d/splat: setCameraPose() needs addSplat(…, { controls:'page' }) — " +
            'with the default controls the SDK owns the camera (use setPose).',
        );
      }
      const pose = normalizeCameraPose(matrixWorld, o);
      if (pendingPose) pendingPose[1] = [pose.matrixWorld, pose];
      else pending.push((pendingPose = ['setCameraPose', [pose.matrixWorld, pose]]));
      return out;
    },
    getCameraPose: () =>
      pendingPose
        ? {
            matrixWorld: Float32Array.from(pendingPose[1][1].matrixWorld),
            verticalFovDeg: pendingPose[1][1].verticalFovDeg,
            near: pendingPose[1][1].near,
            far: pendingPose[1][1].far,
            convergence: pendingPose[1][1].convergence,
          }
        : null,
    setFocus: queue('setFocus'),
    // A swap requested before the first asset has landed runs once it has (the adapter's own
    // setSource replaces this stub on the same object by then).
    setSource: (...args) => out.ready.then(() => out.setSource(...args)),
    getFocus: () => null,
    // A plain data slot the adapter reads at call time, so a callback assigned on the very next
    // line after addSplat — before the module has loaded — is the one that fires.
    onFocusChange: null,
    pick: () => null,
    // Splat accounting (resident / budget / first frame); null until the adapter has loaded.
    stats: () => null,
    remove: queue('remove'),
    exclude: queue('exclude'),
    unexclude: queue('unexclude'),
  };
  // `firstWoven` exists from the first line, like every other field a page reads right away; the
  // adapter settles it with the core handle's own once the module has loaded.
  out.firstWoven = new Promise((resolve) => {
    out._resolveFirstWoven = resolve;
  });
  // The ONE owner of `ready`: the adapter returns its load promise and never touches this field.
  out.ready = import('./inline3d-splat-playcanvas.js')
    .then((m) => m.attachPlayCanvasSplat(out, wall, canvas, src, opts, pending))
    .catch((err) => {
      // The adapter warns about its own load failures; this is for the module not arriving.
      if (!out.viewer) console.warn('[inline3d/splat] engine:playcanvas failed to start', err);
      if (out._resolveFirstWoven) {
        out._resolveFirstWoven(Object.freeze({ woven: false, confirmed: false, reason: 'layer-failed', ms: 0 }));
        delete out._resolveFirstWoven;
      }
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
function applyCaptureCamera(viewer, rig, flipY, THREE_, captureFit = 'height', onFov = null) {
  const three = THREE_ || THREE;
  const camera = viewer.monoCamera;
  const { width, height } = rig.intrinsics;

  const q = new three.Quaternion(
    rig.rest.rotation[0],
    rig.rest.rotation[1],
    rig.rest.rotation[2],
    rig.rest.rotation[3],
  );
  const p = new three.Vector3(rig.rest.position[0], rig.rest.position[1], rig.rest.position[2]);
  // TWO half-turns about X, and they are different things — conflating them points the camera
  // backwards at an empty scene, which is what the first version did.
  //
  //   · RIGHT-multiplied, ALWAYS: the convention change. The block's rotation is a camera pose
  //     in OpenCV axes (+y down, looking down +z); three's camera looks down -z with +y up. That
  //     is a rotation in the camera's OWN frame, so it composes on the right, and it applies
  //     whether or not the content was flipped.
  //   · LEFT-multiplied, only under `flipY`: the same rotation applied to the CONTENT, which is
  //     a world-space transform the camera has to ride along with.
  //
  // With the identity rest pose almost every capture carries, the two cancel exactly and the
  // camera sits at the origin looking down -z at a scene the flip has just put there.
  const flip = new three.Quaternion(1, 0, 0, 0);
  if (flipY) {
    p.applyQuaternion(flip);
    q.premultiply(flip);
  }
  q.multiply(flip);
  camera.position.copy(p);
  camera.quaternion.copy(q);
  camera.fov = captureVerticalFovDeg(rig.intrinsics, NaN, camera.near, 'height');
  // FAR, and why it is not the viewer's default. A deconverged capture parks its sky at the
  // lifter's depth cap and the refinement scatters some gaussians beyond it (239 m measured on a
  // street scene); anything past the far plane is CLIPPED in Spark's vertex shader and pops out
  // as a black hole the moment an orbit pushes it over. Spark composites by SORTING, not by
  // depth-testing, so there is no z precision to protect and a huge near:far ratio costs nothing.
  camera.far = Math.max(camera.far, 5000);
  camera.updateMatrixWorld(true);

  camera.updateProjectionMatrix = () => {
    const near = camera.near;
    const box = viewer.canvas.getBoundingClientRect();
    const aspect = box.height > 0 ? box.width / box.height : width / height;
    // The window is shared with the PlayCanvas backend (./inline3d-splat-shared.js), `captureFit`
    // included; on 'height' it is the same arithmetic this function always did.
    const w = captureWindow(rig.intrinsics, aspect, near, captureFit);
    camera.projectionMatrix.makePerspective(w.left, w.right, w.top, w.bottom, near, camera.far);
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    if (captureFit !== 'height') {
      const fov = captureVerticalFovDeg(rig.intrinsics, aspect, near, captureFit);
      if (fov !== camera.fov) {
        camera.fov = fov;
        onFov?.();
      }
    }
  };
  camera.updateProjectionMatrix();
}


/**
 * ONE walk over the cloud, in the REST CAMERA's frame — see `sampleCloudRestSpace` in
 * ./inline3d-splat-rig.js, which holds the sampling rules for every backend. This is only the
 * Spark adapter onto it: `forEachSplat` reports centres before the mesh's own transform, so
 * this is the file's own OpenCV frame, which is the frame `rest` and `intrinsics` are in.
 *
 * @returns {{tx:Float64Array,ty:Float64Array,invz:Float64Array,n:number}|null}
 */
function sampleRestSpace(mesh, rest) {
  const total = mesh?.numSplats || 0;
  if (!total || typeof mesh.forEachSplat !== 'function') return null;
  return sampleCloudRestSpace(total, sparkCentres(mesh), rest);
}

/** Spark's `forEachSplat` as the backend-neutral centre visitor ./inline3d-splat-rig.js walks. */
function sparkCentres(mesh) {
  return (visit) =>
    mesh.forEachSplat((index, center, scales, quaternion, opacity) =>
      visit(index, center.x, center.y, center.z, opacity),
    );
}

/** A point in the splat's own (model) space, in the viewer's CONTENT space. */
function toContentSpace(mesh, model, three) {
  const v = new three.Vector3(model[0], model[1], model[2]);
  mesh.updateWorldMatrix(true, false);
  mesh.localToWorld(v);
  const content = mesh.parent;
  if (content) {
    content.updateWorldMatrix(true, false);
    content.worldToLocal(v);
  }
  return [v.x, v.y, v.z];
}

/** The inverse: a WORLD point in the splat's own space. */
function toModelSpace(mesh, world, three) {
  const v = world.isVector3 ? world.clone() : new three.Vector3(world[0], world[1], world[2]);
  mesh.updateWorldMatrix(true, false);
  return toArray3(mesh.worldToLocal(v));
}

/**
 * The pick fallback: the gaussian whose CENTRE is closest to the ray.
 *
 * Nearest by ANGLE, then nearest along the ray among everything inside a small cone — so a near
 * surface wins over the sky behind it even when the sky happens to be a hair closer to the exact
 * ray. An approximation of a hit test, not a hit test: it returns a splat centre, so on a thick
 * soft surface it lands slightly behind the apparent one. Good enough to converge and orbit
 * about, which is all a focus is.
 */
function nearestGaussianToRay(mesh, ray, three, coneRad = 0.02) {
  const total = mesh?.numSplats || 0;
  if (!total || typeof mesh.forEachSplat !== 'function') return null;
  const stride = Math.max(1, Math.ceil(total / RIG_SAMPLE_CAP));
  mesh.updateWorldMatrix(true, false);
  const m = mesh.matrixWorld;
  const p = new three.Vector3();
  const rel = new three.Vector3();
  let bestInCone = null;
  let bestInConeT = Infinity;
  let bestAngle = Infinity;
  let bestAnyPoint = null;
  mesh.forEachSplat((index, center, scales, quaternion, opacity) => {
    if (index % stride !== 0) return;
    if (opacity !== undefined && opacity < RIG_MIN_OPACITY) return;
    p.copy(center).applyMatrix4(m);
    rel.copy(p).sub(ray.origin);
    const t = rel.dot(ray.direction);
    if (!(t > 0)) return;
    const perp = Math.sqrt(Math.max(0, rel.lengthSq() - t * t));
    const angle = perp / t;
    if (angle <= coneRad) {
      if (t < bestInConeT) {
        bestInConeT = t;
        bestInCone = p.clone();
      }
    } else if (!bestInCone && angle < bestAngle) {
      bestAngle = angle;
      bestAnyPoint = p.clone();
    }
  });
  return bestInCone || bestAnyPoint;
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
  const local = boundsFromPositions(sampleCloudCentres(total, sparkCentres(mesh)));
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

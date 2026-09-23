// inline3d-splat.js — a 3D Gaussian splat as an inline-3D window, in one call.
//
// EXPERIMENTAL. Not covered by the SDK's 1.x semver promise — see docs/sdk-stability.md.
//
//   import { createInline3D } from '@displayxr/inline3d';
//   import { addSplat } from '@displayxr/inline3d/splat';
//
//   const wall = await createInline3D();
//   const shoe = addSplat(wall, canvas, 'trail-runner.sog', { virtualDisplayHeight: 0.18 });
//   shoe.exclude(document.getElementById('buy'));   // crisp 2D button over the woven 3D
//   await shoe.ready;
//
// Pass the wall whether or not inline-3D is supported: on an ordinary browser this renders a
// flat, orbitable view of the same asset, so a page needs no branch. Splats are photoreal in a
// way meshes are not for captured goods — leather grain, knit mesh, foil, glitter — which is
// exactly the material range that sells a product.
//
// TWO BACKENDS, ONE HANDLE. This module is only the front door; it imports no renderer.
//
//   engine (unset)  → the PlayCanvas engine (./inline3d-splat-playcanvas.js). Optional peer
//                     `playcanvas >=2.22.3 <3`. Reads .sog, .ply and a Streamed-SOG lod-meta.json.
//   engine:'spark'  → three.js + Spark (./inline3d-splat-spark.js), the 1.x default and the kill
//                     switch. Optional peers `three >=0.180` + `@sparkjsdev/spark`. Also reads
//                     .spz / .splat / .ksplat.
//
// Both are loaded with a LITERAL dynamic import(), so a page pays only for the backend it uses: a
// default page makes zero requests for three/Spark, and an `engine:'spark'` page makes zero for
// playcanvas. `playcanvas` missing on a default page → falls back to Spark (one warning) when
// Spark's peers resolve, else `ready` rejects saying what to install.

import { resolveSplatEngine, sampleCloudCentres } from './inline3d-splat-rig.js';
import { boundsFromPositions } from './inline3d-viewer.js';
import { CAPTURE_FITS, playcanvasCannotRead } from './inline3d-splat-shared.js';

export { applySplatPerf, SPLAT_PERF_PRESETS } from './inline3d-splat-perf.js';
export { readSogCamera, readSogMeta } from './inline3d-sog.js';
export { resolveRig } from './inline3d-splat-rig.js';

const INSTALL_HINT =
  "@displayxr/inline3d/splat renders with the PlayCanvas engine by default and needs the " +
  "`playcanvas` package (npm i playcanvas, or an importmap entry for it) — or pass " +
  "engine:'spark' to use three.js + Spark instead.";

/** The real loaders. LITERAL specifiers, so a bundler can see and split each one. */
const LOADERS = {
  playcanvas: () => import('playcanvas'),
  adapter: () => import('./inline3d-splat-playcanvas.js'),
  spark: () => import('./inline3d-splat-spark.js'),
};

let warnedFallback = false;

/**
 * Resolve which backend renders this call, loading only what it needs.
 *
 * - `engine:'spark'` → the Spark module.
 * - `engine:'playcanvas'` → the engine + the adapter; the engine missing REJECTS (the page asked).
 * - unset → as 'playcanvas', but the engine missing FALLS BACK to Spark with one console warning
 *   when Spark's peers resolve; when they do not either, rejects with INSTALL_HINT.
 *
 * Exported for tests (the loaders are injectable); pages do not need it.
 *
 * @returns {Promise<{backend:'spark'|'playcanvas', mod:object, pc?:object}>}
 */
export async function loadSplatBackend(opts = {}, loaders = LOADERS) {
  const engine = resolveSplatEngine(opts);
  if (engine === 'spark') return { backend: 'spark', mod: await loaders.spark() };
  let pc = opts.playcanvas || null;
  let pcErr = null;
  if (!pc) {
    try {
      pc = await loaders.playcanvas();
    } catch (err) {
      pcErr = err;
    }
  }
  if (pc) return { backend: 'playcanvas', mod: await loaders.adapter(), pc };
  if (opts.engine !== undefined) throw new Error(INSTALL_HINT, { cause: pcErr });
  let mod;
  try {
    mod = await loaders.spark();
  } catch (sparkErr) {
    throw new Error(
      `${INSTALL_HINT} (Spark's peers \`three\` / \`@sparkjsdev/spark\` did not resolve either.)`,
      { cause: sparkErr },
    );
  }
  if (!warnedFallback) {
    warnedFallback = true;
    console.warn(
      '[inline3d/splat] `playcanvas` is not available, so this page renders with three.js + ' +
        "Spark (the fallback). Install `playcanvas` for the default engine, or pass engine:'spark' " +
        'to make this choice explicit and silence this warning.',
      pcErr,
    );
  }
  return { backend: 'spark', mod };
}

/**
 * Load a splat into an inline-3D window.
 *
 * SYNCHRONOUS on purpose — it mirrors addImage, so a caller can wire up overlays and controls
 * immediately instead of awaiting a download first. The backend module loads on demand, so for a
 * moment the handle exists before its implementation does: its methods QUEUE (`exclude()`, which
 * a product page calls on the very next line, `setPose`, `setFocus`, `remove`…) and the backend
 * replays them on the SAME object the moment it arrives. `ready` resolves to this object.
 * Fields (`viewer`, `mesh`, `rig`, `engine`, …) are null until then.
 *
 * Every option and method is documented in splat.d.ts; FRAMING, RIG and PERF in
 * docs/authoring-inline-3d.md; what differs between the backends in docs/playcanvas-adapter.md.
 *
 * @param {object} wall  the manager from createInline3D(), supported or not.
 * @param {HTMLCanvasElement} canvas
 * @param {string|Blob|ArrayBuffer|Uint8Array} src  URL or bytes.
 * @param {object} [opts]  see SplatOptions in splat.d.ts.
 * @returns {object} the SplatHandle.
 */
export function addSplat(wall, canvas, src, opts = {}) {
  // Everything decidable NOW throws NOW — a page bug is true of every call, not a condition of
  // one asset, and a rejection would let a caller paint "asset unavailable" over it.
  const engine = resolveSplatEngine(opts); // a typo'd engine
  if (opts.captureFit !== undefined && !CAPTURE_FITS.includes(opts.captureFit)) {
    throw new Error(
      `@displayxr/inline3d/splat: captureFit "${opts.captureFit}" — expected ` +
        `${CAPTURE_FITS.map((f) => `'${f}'`).join(' or ')}.`,
    );
  }
  if (engine === 'playcanvas') {
    // A format the default engine provably cannot read (a .spz URL, gzip bytes, a Spark-only
    // fileType) — say so here rather than fail inside a loader later.
    const why = playcanvasCannotRead(src, opts);
    if (why) throw new Error(`@displayxr/inline3d/splat: ${why}`);
  }
  const pending = [];
  const queue = (name) => (...args) => {
    pending.push([name, args]);
    return name === 'setFocus' ? out : undefined;
  };
  const out = {
    backend: null,
    engine: null,
    viewer: null,
    mesh: null,
    frame: null,
    camera: null,
    rig: null,
    perf: null,
    // A plain data slot the backend reads at call time, so a callback assigned on the very next
    // line after addSplat — before the backend has loaded — is the one that fires.
    onFocusChange: null,
    setPose: queue('setPose'),
    resetPose: queue('resetPose'),
    setFocus: queue('setFocus'),
    // A swap requested before the first asset has landed runs once it has (the backend's own
    // setSource replaces this stub on the same object by then).
    setSource: (...args) => out.ready.then(() => out.setSource(...args)),
    getFocus: () => null,
    pick: () => null,
    remove: queue('remove'),
    exclude: queue('exclude'),
    unexclude: queue('unexclude'),
  };
  // The ONE owner of `ready`: the backends return their load promise and never touch this field.
  out.ready = loadSplatBackend(opts)
    .catch((err) => {
      console.warn('[inline3d/splat] could not start a splat backend', err);
      throw err;
    })
    .then(({ backend, mod, pc }) =>
      backend === 'spark'
        ? mod.attachSparkSplat(out, wall, canvas, src, opts, pending)
        : mod.attachPlayCanvasSplat(out, wall, canvas, src, { ...opts, playcanvas: pc }, pending),
    );
  return out;
}

/**
 * Robust model-space bounds of a loaded splat, lifted through its own matrix.
 *
 * Takes a Spark `SplatMesh` (anything with `numSplats`, `forEachSplat` and a three-style
 * `matrix`); the second argument is accepted and ignored for compatibility — the arithmetic is
 * done on `matrix.elements` here, so this subpath never has to import three. On the PlayCanvas
 * backend the same bounds are `handle.frame`.
 *
 * @returns {{center:number[], extent:number[]}|null}
 */
export function measureSplatBounds(mesh, _three) {
  const total = mesh?.numSplats || 0;
  if (!total || typeof mesh.forEachSplat !== 'function') return null;
  const walk = (visit) =>
    mesh.forEachSplat((index, center, scales, quaternion, opacity) =>
      visit(index, center.x, center.y, center.z, opacity),
    );
  const local = boundsFromPositions(sampleCloudCentres(total, walk));
  if (!local) return null;
  mesh.updateMatrix?.();
  const m = mesh.matrix?.elements;
  if (!m) return local;
  const [x, y, z] = local.center;
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  const center = [
    (m[0] * x + m[4] * y + m[8] * z + m[12]) / w,
    (m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
    (m[2] * x + m[6] * y + m[10] * z + m[14]) / w,
  ];
  const extent = [0, 1, 2].map((a) => Math.hypot(m[a * 4], m[a * 4 + 1], m[a * 4 + 2]) * local.extent[a]);
  return { center, extent };
}

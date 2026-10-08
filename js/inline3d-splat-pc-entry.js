// inline3d-splat-pc-entry.js — `@displayxr/inline3d/splat/playcanvas`: addSplat on PlayCanvas only.
//
// EXPERIMENTAL, like ./splat. Same addSplat, same handle, same options, with the engine fixed to
// 'playcanvas'. The difference is what the page downloads: ./splat statically imports `three`
// and `@sparkjsdev/spark` because Spark is its default engine and its Spark path is synchronous,
// so a page passing engine:'playcanvas' there still pays for both (~1.7 MB gzipped). This entry
// imports neither, directly or transitively. `playcanvas` itself is still loaded on demand, when
// the first splat is added.
//
//   import { createInline3D } from '@displayxr/inline3d';
//   import { addSplat } from '@displayxr/inline3d/splat/playcanvas';
//
//   const wall = await createInline3D();
//   const scene = addSplat(wall, canvas, 'lake.sog', { reveal: 'sweep' });
//
// Not here: measureSplatBounds (it measures a Spark mesh — import it from ./splat).

import { resolveRevealOption } from './inline3d-splat-effects.js';
import { CAPTURE_FITS, guardedAttach, playcanvasCannotRead, resolveControls } from './inline3d-splat-shared.js';
import { addSplatDeferred } from './inline3d-splat-deferred.js';

export { applySplatPerf, SPLAT_PERF_PRESETS } from './inline3d-splat-perf.js';
export { readSogCamera, readSogMeta } from './inline3d-sog.js';
export { resolveRig } from './inline3d-splat-rig.js';

/** addSplat with `engine: 'playcanvas'`; the same validation, at the call, as ./splat's. */
export function addSplat(wall, canvas, src, opts = {}) {
  // One registration per canvas per wall: a second call on a live canvas warns once and returns
  // the first handle (see guardedAttach).
  return guardedAttach(wall, canvas, 'addSplat', opts, (o) => addSplatUnguarded(wall, canvas, src, o));
}

function addSplatUnguarded(wall, canvas, src, opts = {}) {
  if (opts.engine !== undefined && opts.engine !== 'playcanvas') {
    throw new Error(
      `@displayxr/inline3d/splat/playcanvas: engine "${opts.engine}" — this entry is PlayCanvas ` +
        "only. Import addSplat from '@displayxr/inline3d/splat' for Spark.",
    );
  }
  if (opts.captureFit !== undefined && !CAPTURE_FITS.includes(opts.captureFit)) {
    throw new Error(
      `@displayxr/inline3d/splat: captureFit "${opts.captureFit}" — expected ` +
        `${CAPTURE_FITS.map((f) => `'${f}'`).join(' or ')}.`,
    );
  }
  resolveControls(opts);
  resolveRevealOption(opts.reveal);
  const why = playcanvasCannotRead(src, opts);
  if (why) throw new Error(`@displayxr/inline3d/splat: ${why}`);
  return addSplatDeferred(wall, canvas, src, { ...opts, engine: 'playcanvas' });
}

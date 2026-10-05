// inline3d-splat-deferred.js — the engine:'playcanvas' handle, shared by both splat entries.
//
// Internal. ./splat (Spark by default) and ./splat/playcanvas (PlayCanvas only) both build their
// PlayCanvas handle here. This module must never import `three` or `@sparkjsdev/spark`, directly
// or through anything it imports: that is what lets ./splat/playcanvas keep both off the page
// (test/splat-pc-entry.test.mjs walks the import graph to hold it to that).

import { normalizeCameraPose } from './inline3d-splat-shared.js';
import { validateEffectCall } from './inline3d-splat-effects.js';

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
/** setRig's type/options shape, checked at the call before the adapter has loaded (it re-checks all of it). */
function validateSetRigArgs(type, o) {
  if (!['display', 'camera', 'auto'].includes(type)) {
    throw new Error(`@displayxr/inline3d/splat: setRig("${type}") — expected 'display', 'camera' or 'auto'.`);
  }
  if (o !== undefined && (o === null || typeof o !== 'object')) {
    throw new TypeError('@displayxr/inline3d/splat: setRig options must be an object.');
  }
}

export function addSplatDeferred(wall, canvas, src, opts) {
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
    prepareSource: (...args) => out.ready.then(() => out.prepareSource(...args)),
    // A rig switch before the first asset has landed: validated now (controls:'page' and a bad
    // type throw at the call's own line), applied once it has.
    setRig: page
      ? pageOnly('setRig')
      : (type, o) => {
          validateSetRigArgs(type, o);
          return out.ready.then(() => out.setRig(type, o));
        },
    // A video before the first asset has landed: controls:'page' throws at the call's own line,
    // the rest is validated by the adapter's setVideo, which runs once the asset is on screen.
    setVideo: page ? pageOnly('setVideo') : (src, o) => out.ready.then(() => out.setVideo(src, o)),
    // Effects before the adapter has loaded: validated NOW (a bad call throws at its own line),
    // then run once the first asset is on screen.
    playEffect: (name, o) => {
      validateEffectCall(name, o, 'play');
      return out.ready.then(() => out.playEffect(name, o));
    },
    setEffect: (name, params) => {
      validateEffectCall(name, params, 'set');
      pending.push(['setEffect', [name, params]]);
      return out;
    },
    stopEffect: queue('stopEffect'),
    // A layer-rig request before the adapter has loaded: queued, replayed in order once it has
    // (it needs no asset, only the engine's layers — which the adapter resolves lazily).
    setLayerRig: (...args) => {
      pending.push(['setLayerRig', args]);
      return out;
    },
    setLayerRigOptions: (...args) => {
      pending.push(['setLayerRigOptions', args]);
      return out;
    },
    layerRigState: () => ({ display: [], disabled: false, path: null, engaged: false, rounded: false, reason: 'the PlayCanvas adapter has not loaded yet', viewerDistance: 0.6, gain: null, planeM: null, photoConvergenceM: null, planeOffset: 0, located: null }),
    makeSbsMaterial: () => {
      throw new Error('@displayxr/inline3d/splat: makeSbsMaterial() needs the engine — call it after `await handle.ready`.');
    },
    effects: () => [],
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

// inline3d-model-entry.js — `@displayxr/inline3d/model`: a glTF/GLB model as an inline-3D window.
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
// WHICH ENGINE (1.12). PlayCanvas by default; `engine: 'three'` is the 1.11 renderer, unchanged
// (./inline3d-model.js, byte for byte — also importable directly as `@displayxr/inline3d/model/three`).
// BOTH are imported DYNAMICALLY from here, so a default page never resolves `three` and a
// three page never resolves `playcanvas`. The handle is returned synchronously on either engine;
// calls made before the backend has loaded (exclude() on the next line, above all) are queued
// and replayed, and `viewer` appears one module-load later — the same contract as
// `addSplat(…, { engine: 'playcanvas' })`.
//
// FALLBACK. With no `engine` given, a page that has three but not playcanvas keeps working: the
// engine import fails, one warning names what to install, and the tile renders on three. With
// neither, `ready` rejects naming both. An explicit `engine` never falls back.

/** The engines `addModel` renders with; the first is the default. */
export const MODEL_ENGINES = Object.freeze(['playcanvas', 'three']);

/**
 * Options whose VALUE is a three.js object. With no explicit `engine` they select three (the page
 * plainly has it, and handing a three loader to PlayCanvas can only be a mistake); with
 * `engine: 'playcanvas'` they throw.
 */
const THREE_ONLY = ['GLTFLoader', 'DRACOLoader', 'KTX2Loader'];
const isThreeTexture = (t) => !!t && typeof t === 'object' && (t.isTexture === true || t.isRenderTargetTexture === true);

/**
 * Which backend a call gets. Pure, synchronous.
 *
 * @returns {{engine:'playcanvas'|'three', explicit:boolean, reason:string}}
 */
export function resolveModelEngine(opts = {}) {
  const e = opts.engine;
  if (e !== undefined && e !== null) {
    if (!MODEL_ENGINES.includes(e)) {
      throw new Error(
        `@displayxr/inline3d/model: unknown engine "${e}" — expected ${MODEL_ENGINES.map((n) => `'${n}'`).join(' or ')} ` +
          `(default 'playcanvas').`,
      );
    }
    return { engine: e, explicit: true, reason: 'option' };
  }
  const threeOpt = THREE_ONLY.find((k) => opts[k]) || (isThreeTexture(opts.envMap) ? 'envMap' : null);
  if (threeOpt) return { engine: 'three', explicit: false, reason: `three.js object in \`${threeOpt}\`` };
  return { engine: 'playcanvas', explicit: false, reason: 'default' };
}

/** Options that exist only on the PlayCanvas backend: an error on an explicit engine:'three'. */
const PLAYCANVAS_ONLY = ['playcanvas', 'environmentRotation', 'controls', 'comfortDepth', 'onBeforeFrame', 'antialias', 'preserveDrawingBuffer', 'nearClip', 'farClip', 'orbitMaxDeg', 'orbitEase'];

/**
 * Everything that can be checked before a module loads. Throws at CALL time — a page bug is true
 * of every call and must not surface as an "asset failed" rejection.
 */
export function validateModelCall(canvas, src, opts, route) {
  if (!canvas || typeof canvas.getBoundingClientRect !== 'function') {
    throw new Error('@displayxr/inline3d/model: addModel(wall, canvas, src) — `canvas` must be an HTMLCanvasElement.');
  }
  if (typeof src !== 'string' || !src) {
    throw new Error('@displayxr/inline3d/model: addModel(wall, canvas, src) — `src` must be the URL of a .glb or .gltf.');
  }
  if (route.engine === 'three' && route.explicit) {
    const bad = PLAYCANVAS_ONLY.filter((k) => opts[k] !== undefined && !(k === 'controls' && opts[k] === 'viewer'));
    if (bad.length) {
      throw new Error(
        `@displayxr/inline3d/model: ${bad.map((k) => `\`${k}\``).join(', ')} ${bad.length === 1 ? 'is' : 'are'} PlayCanvas-backend ` +
          "options and do nothing on engine:'three'. Drop them, or drop engine:'three'.",
      );
    }
  }
  if (route.engine === 'playcanvas' && route.explicit) {
    const bad = THREE_ONLY.find((k) => opts[k]) || (isThreeTexture(opts.envMap) ? 'envMap' : null);
    if (bad) {
      throw new Error(
        `@displayxr/inline3d/model: \`${bad}\` is a three.js object and engine:'playcanvas' cannot use it. ` +
          "Drop it (the engine decodes with its own readers; serve the files at `decoderPath`), or pass engine:'three'.",
      );
    }
  }
}

/**
 * Load a glTF/GLB into an inline-3D window. See model.d.ts for every option.
 *
 * @returns {object} the handle, synchronously: `ready`, `firstWoven`, `setPose`, `resetPose`,
 *          `exclude`, `unexclude`, `remove` work at once; `viewer`, `model`, `frame`, `engine`
 *          fill in as the backend loads.
 */
export function addModel(wall, canvas, src, opts = {}) {
  const route = resolveModelEngine(opts);
  validateModelCall(canvas, src, opts, route);
  if (route.engine === 'playcanvas') {
    // The backend's own call-time checks (environment, envMap, controls, three loaders). Imported
    // lazily below, so this is the cheap pure copy that lives there — see validatePlayCanvasModelOptions.
    preValidatePlayCanvas(opts);
  } else if (route.reason !== 'option' && route.reason !== 'default') {
    console.info(`[inline3d/model] rendering ${src} with three.js: ${route.reason} (pass engine:'three' to say so explicitly).`);
  }

  const pending = [];
  const queue = (name) => (...args) => {
    pending.push([name, args]);
  };
  const page = opts.controls === 'page';
  let pendingPose = null;
  const out = {
    backend: route.engine,
    engine: null,
    viewer: null,
    model: null,
    frame: null,
    setPose: queue('setPose'),
    resetPose: queue('resetPose'),
    setCameraPose(matrixWorld, o) {
      if (!page) {
        throw new Error("@displayxr/inline3d/model: setCameraPose() needs addModel(…, { controls:'page' }) — with the default controls the SDK owns the camera (use setPose).");
      }
      if (pendingPose) pendingPose[1] = [matrixWorld, o];
      else pending.push((pendingPose = ['setCameraPose', [matrixWorld, o]]));
      return out;
    },
    getCameraPose: () => null,
    remove: queue('remove'),
    exclude: queue('exclude'),
    unexclude: queue('unexclude'),
  };
  out.firstWoven = new Promise((resolve) => {
    out._resolveFirstWoven = resolve;
  });
  const settleFirstWoven = (reason) => {
    if (typeof out._resolveFirstWoven === 'function') {
      out._resolveFirstWoven(Object.freeze({ woven: false, confirmed: false, reason, ms: 0 }));
      delete out._resolveFirstWoven;
    }
  };

  out.ready = (async () => {
    if (route.engine === 'three') return attachThree(out, wall, canvas, src, opts, pending);
    const mod = await import('./inline3d-model-playcanvas.js');
    let pc = opts.playcanvas || null;
    if (!pc) {
      try {
        pc = await import('./inline3d-playcanvas-engine.js');
      } catch (err) {
        if (route.explicit) throw playcanvasMissing(err, false);
        let three;
        try {
          three = await import('./inline3d-model.js');
        } catch (err3) {
          throw playcanvasMissing(err, err3);
        }
        console.warn(
          `[inline3d/model] \`playcanvas\` could not be loaded (${err?.message || err}); rendering ${src} with three.js instead. ` +
            "npm i playcanvas for the default renderer, or pass engine:'three' to silence this.",
        );
        out.backend = 'three';
        return attachThree(out, wall, canvas, src, opts, pending, three);
      }
    }
    return mod.attachPlayCanvasModel(out, wall, canvas, src, opts, pending, pc);
  })().catch((err) => {
    settleFirstWoven('layer-failed');
    throw err;
  });
  return out;
}

function playcanvasMissing(err, err3) {
  const e = new Error(
    '@displayxr/inline3d/model: addModel renders with PlayCanvas by default and `playcanvas` could not be loaded' +
      (err3 ? ' — and neither could `three` for the fallback' : '') +
      ". Install one: `npm i playcanvas` (default), or `npm i three` and pass engine:'three'. On a bare importmap, map " +
      '"playcanvas" (or "three" + "three/addons/"). ' +
      `Underlying error: ${err?.message || err}` +
      (err3 ? ` / ${err3?.message || err3}` : ''),
  );
  e.cause = err;
  return e;
}

/** Call-time checks for the PlayCanvas backend that need no module (mirrors the backend's own). */
function preValidatePlayCanvas(opts) {
  const env = opts.environment;
  if (env !== undefined && !['room', 'neutral', 'studio', 'none'].includes(env)) {
    throw new Error(`@displayxr/inline3d/model: environment "${env}" — expected 'room', 'neutral', 'studio' or 'none'.`);
  }
  if (opts.envMap !== undefined && opts.envMap !== null && typeof opts.envMap !== 'string' && typeof opts.envMap !== 'object') {
    throw new Error('@displayxr/inline3d/model: `envMap` must be a URL string or a pc.Texture.');
  }
  const c = opts.controls;
  if (c !== undefined && c !== 'viewer' && c !== 'page') {
    throw new Error(`@displayxr/inline3d/model: controls "${c}" — expected 'viewer' or 'page' (default 'viewer').`);
  }
  if (opts.onBeforeFrame !== undefined && (typeof opts.onBeforeFrame !== 'function' || c !== 'page')) {
    throw new Error("@displayxr/inline3d/model: onBeforeFrame must be a function, and needs controls:'page'.");
  }
  if (opts.meshoptDecoder && typeof opts.meshoptDecoder.decodeGltfBuffer !== 'function') {
    throw new Error("@displayxr/inline3d/model: `meshoptDecoder` must be meshoptimizer's MeshoptDecoder (it has decodeGltfBuffer()).");
  }
}

/**
 * engine:'three' — today's addModel (./inline3d-model.js), unchanged, behind this handle: its own
 * handle's fields are forwarded (getters, since it fills them as it loads) and the queued calls
 * are replayed into it.
 */
async function attachThree(out, wall, canvas, src, opts, pending, mod) {
  const m = mod || (await import('./inline3d-model.js'));
  const inner = m.addModel(wall, canvas, src, opts);
  for (const k of ['viewer', 'model', 'frame']) {
    Object.defineProperty(out, k, { get: () => inner[k], set: (v) => (inner[k] = v), enumerable: true, configurable: true });
  }
  out.backend = 'three';
  out.engine = null;
  out.setPose = inner.setPose;
  out.resetPose = inner.resetPose;
  out.remove = inner.remove;
  out.exclude = inner.exclude;
  out.unexclude = inner.unexclude;
  out.inner = inner;
  if (typeof out._resolveFirstWoven === 'function') {
    out._resolveFirstWoven(inner.firstWoven);
    delete out._resolveFirstWoven;
  }
  for (const [name, args] of pending) {
    if (name === 'remove') {
      inner.remove();
      break;
    }
    inner[name]?.(...args);
  }
  await inner.ready;
  return out;
}

// inline3d-pc-auto-release.js — when a page destroys a material on one of the SDK's PlayCanvas
// devices, release the programs it linked, without the page asking.
//
// Internal. PlayCanvasSplatViewer.attachEngine (./inline3d-splat-playcanvas.js) installs it on
// every app it creates, for ./splat (engine: 'playcanvas') and ./model. docs/content-lifecycle-rules.md
// § rule 1 has the why; `?dxrdiag=keepprograms` turns it off (A/B).
//
// WHY. `Material.destroy()` empties `material.variants` and destroys no program, and the engine's
// ProgramLibrary keeps every program it linked for the device's life. A page that swaps content
// under one live app (`entity.destroy()`, `asset.unload()`, which destroys the container's
// materials) therefore keeps every program it ever linked: measured 0 → 170 live programs over 28
// screen changes on a kiosk app, none deleted. `handle.releaseEntity` releases them on request;
// this does the same for every material the page destroys, so a page that follows the engine's
// own teardown is bounded too.
//
// HOW. Two methods on the engine's Material prototype, wrapped once (the prototype is shared by
// every app on the page, so both wrappers act only on devices registered here):
//   - getShaderVariant: the one place a material links a program. Records the material (weakly)
//     on its device, so a live material that holds a program keeps it (step 3);
//   - destroy: BEFORE the engine empties `variants`, collects the programs the material and its
//     mesh instances hold, and marks the material destroyed.
// The sweep runs once per frame that had a destroy, at the app's `frameend` (after render, so
// content added in the same frame has drawn and holds its programs), with a timer as backup for a
// stopped app. It destroys each collected program that nothing still uses:
//   1. no mesh instance under `app.root` or in a layer, and no material asset in the registry
//      (the keep set of ./inline3d-pc-release.js);
//   2. still registered on the device (not already destroyed, e.g. by releaseEntity);
//   3. no material that linked it is still alive. ProgramLibrary hands one Shader to every material
//      with the same key, and a material a page keeps off-scene to show again still has it in its
//      `variants`; destroying it under that material would leave a dead program there.
// `Shader.destroy()` also takes the program out of the library, so a later ask for that variant
// compiles it again. Cost: content shown again after release recompiles on its first draw
// (`handle.warmEntity` hides that).

import { liveShaders } from './inline3d-pc-release.js';

const states = new WeakMap(); // device -> { app, materials:Set<WeakRef>, pending:Set, scheduled, stats }
let patchedProto = null;

const deref = (r) => (typeof r?.deref === 'function' ? r.deref() : r);
const weak = (x) => (typeof WeakRef === 'function' ? new WeakRef(x) : x);

function collect(material) {
  const into = (s) => {
    const st = s && states.get(s.device);
    if (!st) return;
    st.pending.add(s);
    schedule(st);
  };
  material.variants?.forEach?.(into);
  material.meshInstances?.forEach?.((mi) => mi?._shaderCache?.forEach?.((si) => into(si?.shader)));
}

/** Programs some still-alive material on `st`'s device has linked. Prunes dead entries. */
function heldByLiveMaterials(st) {
  const held = new Set();
  for (const r of st.materials) {
    const m = deref(r);
    if (!m || m.__dxrDestroyed) {
      st.materials.delete(r);
      continue;
    }
    m.variants?.forEach?.((s) => s && held.add(s));
  }
  return held;
}

function schedule(st) {
  if (st.scheduled) return;
  st.scheduled = true;
  const run = (st.run ||= () => sweep(st));
  try {
    st.app.once?.('frameend', run);
  } catch {
    /* no event system: the timer below */
  }
  st.timer = setTimeout(run, 1000);
}

/** Destroy every collected program nothing still uses. Returns how many. Exported for tests. */
export function sweep(st) {
  if (!st || !st.scheduled) return 0;
  st.scheduled = false;
  clearTimeout(st.timer);
  if (st.run) st.app.off?.('frameend', st.run); // only ours: the page may listen to frameend too
  if (!st.pending.size || st.off) {
    st.pending.clear();
    return 0;
  }
  let keep;
  try {
    keep = liveShaders(st.app);
  } catch {
    st.pending.clear(); // an app mid-teardown: it frees everything itself
    return 0;
  }
  const held = heldByLiveMaterials(st);
  let n = 0;
  for (const s of st.pending) {
    if (keep.has(s) || held.has(s) || typeof s.destroy !== 'function') continue;
    const registered = s.device?.shaders;
    if (Array.isArray(registered) && !registered.includes(s)) continue; // already destroyed
    try {
      s.destroy();
      n++;
    } catch {
      /* a program the engine already tore down */
    }
  }
  st.pending.clear();
  st.stats.released += n;
  st.stats.sweeps++;
  st.onSweep?.(n);
  return n;
}

/**
 * The prototype has the shape this relies on (2.22.x): `getShaderVariant(params)` with
 * `params.device`, and a `destroy()` that clears `variants`. Returns a reason string, or null.
 */
export function materialShapeProblem(proto) {
  if (!proto || typeof proto.getShaderVariant !== 'function' || typeof proto.destroy !== 'function') return 'no Material.getShaderVariant/destroy';
  const d = Function.prototype.toString.call(proto.destroy);
  if (!/variants/.test(d)) return 'Material.destroy no longer clears variants';
  return null;
}

/** Wrap the engine's Material prototype once. Returns 'patched' | 'already' | 'skipped: …'. */
export function patchMaterialPrototype(proto) {
  if (patchedProto === proto || proto?.__dxrAutoRelease) return 'already';
  const problem = materialShapeProblem(proto);
  if (problem) return `skipped: ${problem}`;
  const getShaderVariant = proto.getShaderVariant;
  const destroy = proto.destroy;
  proto.getShaderVariant = function (params) {
    const s = getShaderVariant.apply(this, arguments);
    const st = states.get(params?.device ?? s?.device);
    if (st && !this.__dxrTracked) {
      this.__dxrTracked = true;
      st.materials.add(weak(this));
    }
    return s;
  };
  proto.destroy = function () {
    try {
      collect(this);
    } catch {
      /* never let the release break the engine's own teardown */
    }
    this.__dxrDestroyed = true;
    return destroy.apply(this, arguments);
  };
  proto.__dxrAutoRelease = true;
  patchedProto = proto;
  return 'patched';
}

/**
 * Release the programs of destroyed materials on `app`'s device. `Material` is the engine's
 * Material class (the one the page's own `import … from 'playcanvas'` also resolves to).
 * The result is kept on `device.__dxrAutoRelease`.
 */
export function installAutoProgramRelease(app, Material) {
  const device = app?.graphicsDevice;
  if (!device) return null;
  if (states.has(device)) return device.__dxrAutoRelease;
  const patched = patchMaterialPrototype(Material?.prototype);
  const result = patched === 'already' ? 'patched' : patched; // one prototype for every app on the page
  device.__dxrAutoRelease = result;
  if (result.startsWith('skipped')) return result;
  const st = { app, materials: new Set(), pending: new Set(), scheduled: false, timer: 0, off: false, stats: { released: 0, sweeps: 0 } };
  states.set(device, st);
  app.once?.('destroy', () => {
    st.off = true;
    clearTimeout(st.timer);
    st.pending.clear();
    st.materials.clear();
  });
  return result;
}

/** Programs released on `app`'s device so far (diagnostics), or null. */
export function autoReleaseStats(app) {
  const st = app?.graphicsDevice && states.get(app.graphicsDevice);
  return st ? { ...st.stats, pending: st.pending.size, materials: st.materials.size } : null;
}

/** The state for `app` (tests, and diag's per-sweep hook). */
export function autoReleaseState(app) {
  return (app?.graphicsDevice && states.get(app.graphicsDevice)) || null;
}

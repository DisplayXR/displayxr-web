// inline3d-pc-release.js — handle.releaseEntity: take content a page added under
// `handle.engine.root` out of a PlayCanvas tile and give back what it held on the GPU.
//
// Internal. PlayCanvasSplatViewer.releaseEntity (./inline3d-splat-playcanvas.js) calls it, for
// both ./splat (engine: 'playcanvas') and ./model. docs/content-lifecycle-rules.md has the why.
//
// WHY. `entity.destroy()` and `asset.unload()` free meshes, textures and materials, but NOT the
// shader programs those materials linked: the engine's ProgramLibrary caches every variant for
// the device's life, and `Material.destroy()` only empties `material.variants`. A page that swaps
// glTF content in and out (a product carousel, a catalogue) therefore keeps every program it ever
// linked, and a desktop driver keeps the linked program's compiled IR behind each one (about 5 MB
// per program, measured on one Linux driver). `Shader.destroy()` is the engine's own explicit
// release: it deletes the program and drops it from the ProgramLibrary cache, so a later ask for
// the same variant compiles it again instead of getting a dead one.
//
// ORDER (each step needs the one before):
//   1. collect the programs the entity's materials hold (`variants`, and each mesh instance's own
//      shader cache) BEFORE anything is destroyed: destroying a material empties `variants`;
//   2. destroy the entity;
//   3. the container (`asset`, optional): unloaded and taken out of the registry when nothing
//      left under `app.root` draws with one of its meshes or materials, after its own materials'
//      programs are collected too;
//   4. destroy each collected program that nothing still in the app uses: any mesh instance under
//      `app.root` (enabled or not), any layer's mesh instances, any material asset still in the
//      registry. ProgramLibrary returns one Shader for one key, so two materials with the same
//      options share a program; that is why this check exists.

/** Every program `materials` hold in `variants`, added to `into`. */
export function materialShaders(materials, into = new Set()) {
  for (const m of materials) m?.variants?.forEach?.((s) => s && into.add(s));
  return into;
}

/** The mesh instances of every render / model component under `entity` (itself included). */
function meshInstancesUnder(entity) {
  const out = [];
  if (!entity?.findComponents) return out;
  for (const kind of ['render', 'model']) {
    let comps = [];
    try {
      comps = entity.findComponents(kind) || [];
    } catch {
      comps = []; // a component system the app does not have
    }
    for (const c of comps) for (const mi of c.meshInstances || []) if (mi) out.push(mi);
  }
  return out;
}

/** A mesh instance's programs: its material's variants and its own shader cache. */
function noteMeshInstance(mi, into) {
  mi.material?.variants?.forEach?.((s) => s && into.add(s));
  mi._shaderCache?.forEach?.((si) => si?.shader && into.add(si.shader));
}

/** Every program something still in `app` may draw with (step 4's keep set). */
export function liveShaders(app) {
  const live = new Set();
  for (const mi of meshInstancesUnder(app.root)) noteMeshInstance(mi, live);
  for (const layer of app.scene?.layers?.layerList || []) for (const mi of layer.meshInstances || []) noteMeshInstance(mi, live);
  for (const a of app.assets?.list?.() || []) if (a?.type === 'material' && a.resource) materialShaders([a.resource], live);
  return live;
}

/** Does anything left under `app.root` draw with one of `container`'s meshes or materials? */
function containerInUse(app, container) {
  const mats = new Set((container?.materials || []).map((a) => a?.resource).filter(Boolean));
  const meshes = new Set();
  for (const r of container?.renders || []) for (const m of r?.resource?.meshes || []) meshes.add(m);
  if (!mats.size && !meshes.size) return false;
  for (const mi of meshInstancesUnder(app.root)) if (mats.has(mi.material) || meshes.has(mi.mesh)) return true;
  return false;
}

/**
 * Destroy `entity` and release what it held. With `asset` (the container it was instantiated
 * from), the container too, unless something else in the app still draws from it.
 * Returns { programs, container } — programs destroyed, and 'unloaded' | 'in-use' | null.
 */
export function releaseEntity(app, entity, { asset = null } = {}) {
  const result = { programs: 0, container: null };
  if (!app || !app.root) return result;
  const retired = new Set();
  if (entity) {
    for (const mi of meshInstancesUnder(entity)) noteMeshInstance(mi, retired);
    entity.destroy?.();
  }
  if (asset) {
    const container = asset.resource;
    if (container && containerInUse(app, container)) {
      result.container = 'in-use';
    } else {
      materialShaders((container?.materials || []).map((a) => a?.resource), retired);
      app.assets?.remove?.(asset);
      asset.unload?.();
      result.container = 'unloaded';
    }
  }
  if (!retired.size) return result;
  const live = liveShaders(app);
  for (const s of retired) {
    if (live.has(s) || typeof s.destroy !== 'function') continue;
    s.destroy();
    result.programs++;
  }
  return result;
}

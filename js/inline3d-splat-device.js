// inline3d-splat-device.js — `addSplat(…, { engine: 'playcanvas', device })`: which graphics API
// the tile's engine runs on, and the WebGPU-only pieces that path needs.
//
// Internal. Used by ./inline3d-splat-playcanvas.js (and ./inline3d-splat.js for the option check).
// Pure where it can be (the resolution rules, the matrix and WGSL rewrites), so the tests can hold
// each rule without a GPU.
//
// THE OPTION. `device: 'webgl2'` (the default: every existing page, byte for byte), `'webgpu'`, or
// `'auto'`. WebGPU is an OPT-IN: what it buys a splat tile is the engine's GPU sort, which removes
// the sort lag of the WebGL2 worker sort while the CAMERA ROTATES (orbit, idle spin, a crossfade's
// new photo). Pure head tracking gains nothing (docs/playcanvas-adapter.md § WebGPU (opt-in)).
//
// THE RULE. The SDK decides, never the engine: `createGraphicsDevice` silently appends WebGL2 to
// any device list, so the adapter asks for `['webgpu']` only after these rules say yes, and checks
// what it got. Every way to WebGPU falls back to WebGL2 with the same handle API, one console line
// and `handle.device` saying so:
//   - `navigator.gpu` absent, or `requestAdapter()` null;
//   - the tile does not render exactly 2 views — its RenderViews: the display's active rendering
//     mode, else the first stereo (2+) view list the session hands it; a 1-view list is the
//     session's mono fallback and does not count (PlayCanvas's WebGPU gsplat stereo projector is
//     two-view only; a 4-view quad would take a mono projection);
//   - an option the WebGPU path cannot draw (GLSL only, no WGSL twin): see glslOnlyOptions();
//   - the engine's WebGPU boot throws or comes back as another device;
//   - `'auto'` only: not Windows, or not the DisplayXR Browser (no XRDisplayLayer / no session).

/** The values `device` takes. */
export const SPLAT_DEVICES = Object.freeze(['webgl2', 'webgpu', 'auto']);

/** Validate `device` (undefined / null = the default, 'webgl2'). Throws on anything else. */
export function resolveDeviceOption(v) {
  if (v === undefined || v === null) return 'webgl2';
  if (!SPLAT_DEVICES.includes(v)) {
    throw new Error(`@displayxr/inline3d/splat: device '${v}' — expected 'webgl2', 'webgpu' or 'auto'.`);
  }
  return v;
}

/**
 * The addSplat options this tile cannot draw on WebGPU, by name (empty = none). Each one is GLSL
 * only in this SDK today:
 *   - `reveal` — an effect chunk (`gsplatModifyVS`, ./inline3d-splat-effects.js), unless WGSL
 *     effects module carries WGSL twins (`wgslEffects`: it does since they landed, so in practice
 *     `reveal` works on WebGPU; the rule stays for an effects build without them);
 *   - `cursor: 'depth'` — its sprite is a GLSL ShaderMaterial and its picks are synchronous;
 *   - `playcanvasViewPath: 'cameras'` — the diagnostic N-camera path: the WebGPU splat projector
 *     reads the camera's own projection, not `calculateProjection`, so its views would be wrong.
 * Not listed because they work on WebGPU: `feather`, setSource's overlay and every effect (WGSL
 * twins in ./inline3d-splat-effects-wgsl.js), `antialias` (4× MSAA), `renderScale`, `captureFit`,
 * `perf`, `rig`, `firstWovenHoldMs`, `convergence`, `displayRigLayers`, `controls: 'page'`.
 */
export function glslOnlyOptions(opts = {}, { wgslEffects = false } = {}) {
  const out = [];
  const r = opts.reveal;
  if (!wgslEffects && r !== undefined && r !== null && r !== false) out.push('reveal');
  if (opts.cursor === 'depth' || (opts.cursor && typeof opts.cursor === 'object')) out.push("cursor:'depth'");
  if (opts.playcanvasViewPath === 'cameras') out.push("playcanvasViewPath:'cameras'");
  return out;
}

/**
 * The resolution, as data. Every input is a fact the caller gathered; the result is
 * `{ device: 'webgl2' | 'webgpu', reason }` — `reason` is the one phrase the boot line prints.
 * `viewCount` / `adapter` may be `undefined` when not gathered yet: the rule that needs them then
 * answers `{ device: null, need: 'views' | 'adapter' }` so the caller can gather only what it must.
 *
 * @param {object} f
 * @param {'webgl2'|'webgpu'|'auto'} f.requested
 * @param {boolean} f.gpu            `navigator.gpu` present
 * @param {boolean} f.inline3d       an inline-3D session exists (wall.supported)
 * @param {boolean} f.displayxr      the DisplayXR Browser (XRDisplayLayer + a session)
 * @param {boolean} f.windows
 * @param {string[]} [f.glslOnly]    glslOnlyOptions()
 * @param {number} [f.viewCount]     RenderViews the tile draws in 3D (0 = none found)
 * @param {object|null} [f.adapter]  requestAdapter()'s answer
 */
export function resolveSplatDevice(f) {
  const requested = f.requested || 'webgl2';
  const gl = (reason) => ({ device: 'webgl2', reason });
  if (requested === 'webgl2') return gl('requested');
  if (requested === 'auto') {
    if (!f.windows) return gl('auto: not Windows');
    if (!f.displayxr) return gl('auto: not the DisplayXR Browser');
  }
  if (!f.gpu) return gl('navigator.gpu is absent');
  if (f.glslOnly && f.glslOnly.length) return gl(`GLSL-only option${f.glslOnly.length > 1 ? 's' : ''} ${f.glslOnly.join(', ')}`);
  if (!f.inline3d) return gl('no inline-3D session (WebGPU splat stereo needs exactly 2 views)');
  if (f.viewCount === undefined) return { device: null, need: 'views' };
  if (!(f.viewCount > 0)) return gl('no stereo view list from the session (WebGPU splat stereo needs exactly 2 views)');
  if (f.viewCount !== 2) return gl(`the tile renders ${f.viewCount} view${f.viewCount === 1 ? '' : 's'} (WebGPU splat stereo needs exactly 2)`);
  if (f.adapter === undefined) return { device: null, need: 'adapter' };
  if (!f.adapter) return gl('requestAdapter() returned null');
  return { device: 'webgpu', reason: requested === 'auto' ? 'auto' : 'requested' };
}

/** `adapter.info` as one short token for the boot line: `vendor/architecture (description)`. */
export function adapterLabel(adapter) {
  const i = adapter?.info || {};
  const head = [i.vendor, i.architecture].filter(Boolean).join('/');
  const tail = i.description || i.device || '';
  return (head || tail) ? `${head || '?'}${tail ? ` (${tail})` : ''}` : 'unknown';
}

/** The platform facts resolveSplatDevice needs, from the page. */
export function platformFacts(wall, g = globalThis) {
  const nav = g.navigator;
  const ua = String(nav?.userAgentData?.platform || nav?.platform || nav?.userAgent || '');
  const supported = !!(wall && wall.supported);
  return {
    gpu: !!nav?.gpu,
    inline3d: supported,
    displayxr: supported && typeof g.XRDisplayLayer === 'function',
    windows: /\bwin(32|64|dows)\b/i.test(ua),
  };
}

/** The one boot line. */
export function deviceLogLine(r) {
  if (r.device === 'webgpu') return `[inline3d/splat] device=webgpu adapter=${r.adapter || 'unknown'} (requested ${r.requested})`;
  return `[inline3d/splat] device=webgl2 (requested ${r.requested}${r.requested === 'webgl2' ? '' : `; fallback: ${r.reason}`})`;
}

// ── WebGPU clip space ──

/**
 * GL clip z (-1..1) → WebGPU clip z (0..1): z row := (z row + w row) / 2, column-major — the
 * engine's own depth-range matrix (Camera.applyShaderProjectionTransform). The runtime's
 * `XRView.projectionMatrix` is GL clip space and the engine uses `RenderView` projections AS IS,
 * so without this everything nearer than 2 × near is clipped and half the depth range is lost
 * (seen on the panel, auto3d shim P-W0). Frustum maths (fov / near / far read back from the
 * matrix) keeps the GL matrix.
 */
export function toClipWebGpu(m, out = new Float32Array(16)) {
  for (let c = 0; c < 4; c++) {
    out[c * 4] = m[c * 4];
    out[c * 4 + 1] = m[c * 4 + 1];
    out[c * 4 + 2] = 0.5 * (m[c * 4 + 2] + m[c * 4 + 3]);
    out[c * 4 + 3] = m[c * 4 + 3];
  }
  return out;
}

// ── the non-square-pixel footprint fix, in WGSL ──

/**
 * patchGsplatFootprint (./inline3d-splat-playcanvas.js) on the FINAL WGSL module code, for the
 * engine's two footprint sites. The effects module's chunk-level twin
 * (getEffectChunks('wgsl').chunks.gsplatCornerVS) reaches only the raster chunk (CPU sort); the
 * GPU-sort compute projector, WebGPU's default, is reachable only here, at createShaderModule
 * (docs/splat-effects.md § WGSL twins, GPU-sort difference 5 — fixed by this). Sites
 * (playcanvas 2.22.3), adapted from the auto3d shim (tools/auto3d-shim/playcanvas-adapter.js,
 * panel-proven 2026-10-08):
 *   - the compute projector (GPU sort, WebGPU's default): `let J1 = focal / vz; let J2 = -J1 / vz
 *     * v.xy; … let tt1 = J1 * w1 + J2.y * w2;` — the y focal is viewportHeight × |P[1][1]| =
 *     viewportHeight × |(viewProj × (w1, 0)).y| (w1 is the camera's world Y axis, so that product is
 *     P's column 1; the depth-range row does not enter);
 *   - the raster chunk (CPU sort): the GLSL shape, with the view uniform block's `viewport_size` /
 *     `matrix_projection` (`ub_view` in the final code; read off the focal line).
 * Square pixels are unchanged by either. A site is patched only when ALL its anchors match.
 * The rewritten lines are adapted from PlayCanvas engine WGSL gsplat chunks @ v2.22.3, MIT
 * (THIRD_PARTY_NOTICES.md).
 *
 * @returns {{src:string, ok:boolean}}
 */
export function patchGsplatFootprintWgslModule(src) {
  if (typeof src !== 'string') return { src, ok: false };
  if (src.includes('dxrFocalY')) return { src, ok: true };
  let out = src;
  let ok = false;
  const c1 = /let\s+J2\s*=\s*-J1\s*\/\s*vz\s*\*\s*v\.xy\s*;/;
  const c2 = /let\s+tt1\s*=\s*J1\s*\*\s*w1\s*\+\s*J2\.y\s*\*\s*w2\s*;/;
  if (c1.test(out) && c2.test(out) && /\bviewProj\b/.test(out) && /\bviewportHeight\b/.test(out) && /\blet\s+w1\b/.test(out)) {
    out = out
      .replace(c1, 'let J1y = (viewportHeight * abs((viewProj * vec4f(w1, 0.0)).y)) / vz; /* dxrFocalY */ let J2 = vec2f(-J1 / vz * v.x, -J1y / vz * v.y);')
      .replace(c2, 'let tt1 = J1y * w1 + J2.y * w2;');
    ok = true;
  }
  const r1 = /let\s+J2\s*=\s*-J1\s*\/\s*vp\.z\s*\*\s*vp\.xy\s*;/;
  const r2 = /vec3f\(\s*0\.0\s*,\s*J1\s*,\s*J2\.y\s*\)/;
  const f = /let\s+focal\s*=\s*([A-Za-z_]\w*)\.viewport_size\.x\s*\*\s*center\.projMat00/.exec(out);
  const ub = f && f[1];
  if (ub && r1.test(out) && r2.test(out) && out.includes(`${ub}.matrix_projection`)) {
    out = out
      .replace(r1, `let J1y = (${ub}.viewport_size.y * abs(${ub}.matrix_projection[1][1])) / vp.z; /* dxrFocalY */ let J2 = vec2f(-J1 / vp.z * vp.x, -J1y / vp.z * vp.y);`)
      .replace(r2, 'vec3f(0.0, J1y, J2.y)');
    ok = true;
  }
  return { src: out, ok };
}

/** Does this WGSL module carry a gsplat footprint site (patched or not)? */
export function isFootprintSite(code) {
  return typeof code === 'string' && code.indexOf('J2') >= 0 && /let\s+J2\s*=/.test(code);
}

/**
 * Apply patchGsplatFootprintWgslModule at the device's `createShaderModule` — the one door every WGSL
 * module goes through (ShaderChunks cannot reach the compute projector). Wrapped once per
 * GPUDevice; returns the counters `{ seen, patched }`. A device the engine RESTORES after a loss is
 * a new GPUDevice and is not wrapped: its splats keep the engine's single focal (half height in the
 * eyes) until the page reloads — the boot code warns on `device.lost`.
 */
export function wrapWgslFootprint(gpuDevice) {
  if (!gpuDevice || typeof gpuDevice.createShaderModule !== 'function') return null;
  if (gpuDevice._dxrFootprint) return gpuDevice._dxrFootprint;
  const stats = { seen: 0, patched: 0 };
  const csm = gpuDevice.createShaderModule;
  gpuDevice.createShaderModule = function (desc) {
    const code = desc && desc.code;
    if (isFootprintSite(code)) {
      stats.seen++;
      const p = patchGsplatFootprintWgslModule(code);
      if (p.ok) {
        stats.patched++;
        desc = { ...desc, code: p.src };
      }
    }
    return csm.call(this, desc);
  };
  gpuDevice._dxrFootprint = stats;
  return stats;
}

/**
 * The store limits on a WebGPU device, in ./inline3d-buffer-limit.js's shape: the DEVICE's
 * `maxTextureDimension2D` on both axes (a canvas texture over it fails `getCurrentTexture()`; there
 * is no separate viewport maximum). Null without one.
 */
export function gpuBufferLimits(gpuDevice) {
  const v = gpuDevice?.limits?.maxTextureDimension2D;
  if (!(v > 0)) return null;
  return { maxW: v, maxH: v, nameW: 'maxTextureDimension2D', nameH: 'maxTextureDimension2D', valueW: v, valueH: v };
}

// ── multi-camera frames on WebGPU ──

/**
 * After the engine's own FrameGraph.compile, carry "a LATER pass loads this target" back to the
 * pass before it ACROSS cameras (store color / depth / stencil). Pure, on the compiled pass list.
 *
 * Why: on WebGPU every camera with 2+ xrViews gets its own FramePassMultiView wrapper, and
 * playcanvas 2.22.3 compiles each wrapper's children with a fresh render-target map
 * (frame-graph.js `_compilePasses` ends in `renderTargetMap.clear()`). So the eye camera's
 * back-buffer pass never learns that the next camera (setLayerRig's display / post cameras, a
 * page's own overlay camera) LOADS that target: with MSAA (`antialias`) its multisampled colour is
 * resolved and DISCARDED (store false), and the next pass loads undefined contents and resolves
 * them over the canvas — the whole tile black, nothing logged. Without MSAA the colour survives but
 * the depth is discarded the same way. WebGL2 has no wrappers, so the engine's own pass does it.
 *
 * @param {Array<object>} renderPasses  frameGraph.renderPasses after compile()
 * @returns {number} how many store flags were raised
 */
export function propagateStoresAcrossCameras(renderPasses) {
  const flat = [];
  for (const p of renderPasses || []) {
    if (p && Array.isArray(p.children)) flat.push(...p.children);
    else if (p) flat.push(p);
  }
  const last = new Map();
  let raised = 0;
  for (const pass of flat) {
    const rt = pass.renderTarget;
    if (rt === undefined) continue; // a pass with no target (compute, a marker)
    const prev = last.get(rt);
    if (prev && prev !== pass) {
      const ops = pass.colorArrayOps || [];
      for (let j = 0; j < ops.length; j++) {
        const po = prev.colorArrayOps?.[j];
        if (po && !ops[j].clear && !po.store) {
          po.store = true;
          raised++;
        }
      }
      const d = pass.depthStencilOps;
      const pd = prev.depthStencilOps;
      if (d && pd) {
        if (!d.clearDepth && !pd.storeDepth) (pd.storeDepth = true), raised++;
        if (!d.clearStencil && !pd.storeStencil) (pd.storeStencil = true), raised++;
      }
    }
    last.set(rt, pass);
  }
  return raised;
}

/** Install propagateStoresAcrossCameras after the app's FrameGraph.compile (once per graph). */
export function wrapFrameGraphStores(frameGraph) {
  if (!frameGraph || frameGraph._dxrStores || typeof frameGraph.compile !== 'function') return false;
  const compile = frameGraph.compile;
  frameGraph.compile = function () {
    const r = compile.apply(this, arguments);
    propagateStoresAcrossCameras(this.renderPasses);
    return r;
  };
  frameGraph._dxrStores = true;
  return true;
}

// ── per-camera effect values on the GPU-sort projector ──

/** The SDK's effect uniforms (./inline3d-splat-effects.js prefixOf): the only names carried over. */
const FX_PARAM = /^dxrFx_/;

/**
 * Make each gsplat manager's PROJECTOR see the effect values set on that manager's mesh instance.
 *
 * Why: setSource's render-time transitions (the particle kinds' driveShared, the wavefront's
 * per-camera values) put each photo's values on the mesh instance of the manager that draws it —
 * the eye camera's (incoming) and the live camera's (outgoing). The raster reads mesh-instance
 * values, but WebGPU's GPU-sort compute projector copies only `scene.gsplat.material`'s parameters
 * (gsplat-projector.js `dispatch`), so both photos were projected untouched. The entity-scope
 * workaround that replaced it rewrote each photo's work buffer every frame and, measured offline,
 * dissolved the outgoing photo later and less than the render-time path (dust at raw 0.5: mean
 * luma 51–66 vs 27). Here each manager's `update()` — where its projector dispatches and uploads
 * its uniforms, synchronously — runs with its mesh instance's `dxrFx_*` values laid over the
 * material, which is restored right after. Wrapped once per manager; new managers (a live camera's)
 * are picked up on the next call.
 *
 * @returns {number} managers newly wrapped
 */
export function wrapGsplatManagerParams(director, material) {
  const cams = director?.camerasMap;
  if (!cams || typeof cams.values !== 'function') return 0;
  let n = 0;
  for (const cd of cams.values()) {
    const layers = cd?.layersMap;
    if (!layers || typeof layers.values !== 'function') continue;
    for (const ld of layers.values()) {
      const m = ld?.gsplatManager;
      if (!m || m._dxrMiParams || typeof m.update !== 'function') continue;
      const update = m.update;
      m.update = function () {
        const own = this.renderer?.meshInstance?.parameters;
        const mat = typeof material === 'function' ? material() : material;
        const keys = own && mat?.setParameter ? Object.keys(own).filter((k) => FX_PARAM.test(k)) : [];
        if (!keys.length) return update.apply(this, arguments);
        const saved = keys.map((k) => [k, mat.parameters?.[k] ? mat.parameters[k].data : undefined]);
        for (const k of keys) mat.setParameter(k, own[k].data);
        try {
          return update.apply(this, arguments);
        } finally {
          for (const [k, d] of saved) {
            if (d === undefined) mat.deleteParameter?.(k);
            else mat.setParameter(k, d);
          }
        }
      };
      m._dxrMiParams = true;
      n++;
    }
  }
  return n;
}

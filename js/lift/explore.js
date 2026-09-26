// lift/explore.js — render a lifted two-layer, image-aligned Gaussian scene ("Convert to 3D")
// into the SDK's per-view viewports: real head parallax from the runtime's tracked eyes, plus a
// capped drag orbit that relaxes home on release.
//
// EXPERIMENTAL. The gallery's Spatial View camera model (displayxr-gallery-pvt:
// src/lib/spatialView/camera.ts, reveal.ts, the wall's camera rig in SpatialView.tsx), rendered by
// the PlayCanvas engine — the SDK's `addSplat(…, { engine: 'playcanvas' })` renderer, at engine
// level (one AppBase, one gsplat component, one camera with N RenderViews). It replaced three +
// Spark in 2026-09 ("the PlayCanvas viewer is much better"). See docs/lift-explore.md.
//
//   import { createInline3D } from '@displayxr/inline3d';
//   import { createExplore } from './lift/explore.js';
//
//   const wall = await createInline3D();
//   const ex = await createExplore({ canvas, gl, ply, meta, orbit: { maxAngleDeg: 15, relax: true } });
//   await ex.fadeIn(500);        // `gl` = the lift canvas's one WebGL2 context (live DIBR's), optional
//   wall.addScene(canvas, (views, layer, frame) => ex.render({ views, layer, session: wall.session }));
//   canvas.addEventListener('pointerdown', (e) => ex.onPointerDown(e));   // + move / up / cancel
//   await ex.fadeOut(400);       // explore → live crossfade; render() then draws nothing
//
// THE CANVAS IS THE CALLER'S (addScene's contract): size its backing store for the layer — SBS,
// device px, `canvas.width = cssW·dpr·2` — and this module renders into `layer.getViewport(view)`.
// It never touches canvas.width/height (the engine runs RESOLUTION_FIXED and is never asked to
// resize anything).
//
// Requires the SDK's optional peer `playcanvas` (>= 2.22.3 < 3), exactly like
// `addSplat(…, { engine: 'playcanvas' })` — reached through ../inline3d-playcanvas-engine.js (named
// re-exports imported STATICALLY, so a bundler keeps only the members named below — a dynamic
// import would keep the whole slice, WebGPU backend included). The pure half lives in ./orbit.js
// and ./explore-gl.js and is unit-tested without the engine. The PLY is parsed by the engine's own
// PLY parser from in-memory bytes (`file.contents`, no URL, no blob: — the lift world's CSP never sees
// a fetch); the sort runs in the engine's blob worker (the built-in bundle swaps in an in-thread
// twin when the page's CSP blocks workers — tools/lift-builtin/build.mjs).

import {
  WebglGraphicsDevice,
  AppOptions,
  AppBase,
  CameraComponentSystem,
  GSplatComponentSystem,
  GSplatHandler,
  TextureHandler,
  ShaderChunks,
  SHADERLANGUAGE_GLSL,
  Asset,
  Entity,
  Color,
  RenderView,
  LAYERID_SKYBOX,
  TONEMAP_NONE,
} from '../inline3d-playcanvas-engine.js';
import { playcanvasPerfSettings, patchPlayCanvasQuadExtent } from '../inline3d-splat-perf.js';
import { LIFT_MODIFY_VS, patchGsplatFootprint, adoptGlState, releaseGlState, syncUnpackState } from './explore-gl.js';
import { readLiftSog } from './sog-input.js';
import {
  createOrbit,
  createOrbitGesture,
  createHeadTracker,
  rigFromMeta,
  fitWindow,
  frustumFor,
  coneLimit,
  NEAR,
  FAR,
  ORBIT_MAX_DEG,
  orbitRig,
  rigApply,
  perspectiveOffAxis,
  translation,
  comfortScale,
  depthGainForBudget,
  depthRangeFromCenters,
  IPD_M,
} from './orbit.js';

export * from './orbit.js';
export * from './explore-gl.js';

/** The engine members this module uses (tests / diagnostics). */
const pc = {
  WebglGraphicsDevice, AppOptions, AppBase, CameraComponentSystem, GSplatComponentSystem, GSplatHandler, TextureHandler,
  ShaderChunks, SHADERLANGUAGE_GLSL, Asset, Entity, Color, RenderView, LAYERID_SKYBOX, TONEMAP_NONE,
};

/** Default reveal (inflate) duration, ms — the gallery's REVEAL_MS. */
export const REVEAL_MS = 1400;
/** Depth kept at the START of the reveal, about the pivot. Not 0: a perfectly flat cloud has no
 *  depth ORDER, so the back-to-front composite goes arbitrary (gallery measured MAE 27 vs 2.6). */
export const FLAT_RESIDUAL = 0.05;
/** Effective splats per pixel on a lifted sheet, for the fade's coverage correction (measured on
 *  the dev harness's 1-gaussian-per-pixel, two-layer synthetic lift; see docs/lift-explore.md). */
export const FADE_OVERLAP = 5;
/** Longest frame step the easing integrates, s (a backgrounded tab must not teleport). */
const MAX_DT_S = 0.1;
/** The engine release this module was built and measured against (the SDK's npm peer floor). */
export const PLAYCANVAS_TESTED = '2.22.3';

const easeOutCubic = (x) => 1 - (1 - x) ** 3;
const DEG = Math.PI / 180;

let byteSeq = 0;
let warnedFootprint = false;

/**
 * Build the engine half on the caller's canvas: an AppBase (no XrManager, no input — the SDK owns
 * input) on a WebGL2 device, the gsplat component with the lift's PLY, and one camera entity whose
 * N RenderViews are the eyes (the engine's own WebXR stereo path driven without WebXR: one gsplat
 * manager, one sort, one work buffer for every view).
 *
 * With `gl` the device ADOPTS that context (`WebglGraphicsDevice` takes `options.gl`; it never
 * calls getContext and its destroy() never loses the context — the live DIBR owns it).
 */
export async function createPlayCanvasSplat({ canvas, gl = null, bytes, format = 'ply', perf = null, preserveDrawingBuffer = false }) {
  // WebGL2 only, constructed directly (createGraphicsDevice would drag the WebGPU backend into a
  // bundle). With `gl` the device adopts it: WebglGraphicsDevice takes `options.gl` @ 2.22.3.
  const device = new pc.WebglGraphicsDevice(canvas, {
    ...(gl ? { gl } : {}),
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    xrCompatible: false,
    preserveDrawingBuffer: !!preserveDrawingBuffer,
  });
  const opts = new pc.AppOptions();
  opts.graphicsDevice = device;
  opts.componentSystems = [pc.CameraComponentSystem, pc.GSplatComponentSystem];
  // TextureHandler too: a bundled .sog is loaded by the engine as texture SUB-ASSETS (its webp
  // planes). Without the handler they never decode, the parser swallows that (Promise.allSettled),
  // and the resource comes up with the right numSplats and NO data — an all-black explore.
  opts.resourceHandlers = [pc.GSplatHandler, pc.TextureHandler];
  const app = new pc.AppBase(canvas);
  app.init(opts);
  // RESOLUTION_FIXED is AppBase's default: the engine never resizes the canvas (the caller does).
  // No second rAF: render() drives app.tick().
  app.requestAnimationFrame = () => {};

  const chunks = pc.ShaderChunks.get(device, pc.SHADERLANGUAGE_GLSL);
  const corner = patchGsplatFootprint(chunks.get('gsplatCornerVS'));
  if (corner.ok) chunks.set('gsplatCornerVS', corner.src);
  else if (!warnedFootprint) {
    warnedFootprint = true;
    console.warn(`[lift/explore] this playcanvas build lacks the gsplatCornerVS lines the footprint fix rewrites (tested ${PLAYCANVAS_TESTED}); rendering unpatched.`);
  }
  const perfApplied = playcanvasPerfSettings(perf ?? undefined);
  if (perfApplied.quadExtent) {
    const q = patchPlayCanvasQuadExtent(chunks.get('gsplatCommonVS'), perfApplied.quadExtent);
    if (q.ok) chunks.set('gsplatCommonVS', q.src);
  }
  for (const [k, v] of Object.entries(perfApplied.settings || {})) app.scene.gsplat[k] = v;

  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // The extension picks the engine's parser (GSplatHandler: .ply → PLY, .sog → SogBundleParser).
  const url = `lift-${++byteSeq}.${format === 'sog' ? 'sog' : 'ply'}`;
  // In-memory bytes through the engine's own loader: `contents` short-circuits the fetch — PLY and
  // bundled SOG alike (the SDK's addSplat engine:'playcanvas' byte path does the same for .sog).
  const asset = new pc.Asset(url, 'gsplat', { url, filename: url, contents: new Response(u8) });
  app.assets.add(asset);
  // On a SHARED context the load itself draws: a .sog's loader runs a GPU pass (SogGenerateCenters,
  // the sort keys) in an async continuation, between the live DIBR's frames and OUTSIDE the
  // adoptGlState() that wraps our own draws — so it ran on whatever state the DIBR left (its
  // UNPACK_FLIP_Y upload, blend, viewport) and produced wrong centres: the scene drew, but sorted
  // wrong (a translucent, smeared foreground). Re-adopt the state before every render pass the
  // load issues. (A PLY builds its centres on the CPU; it never hit this.)
  // The same load also uploads its textures immediately (Texture.upload → setTexture), outside
  // any pass: resync the pixel-store to the engine's caches before each (see syncUnpackState).
  const origStart = gl ? device.startRenderPass : null;
  const origSetTexture = gl ? device.setTexture : null;
  if (origStart) {
    device.startRenderPass = function (rp) {
      adoptGlState(device);
      return origStart.call(this, rp);
    };
    device.setTexture = function (...a) {
      syncUnpackState(device);
      return origSetTexture.apply(this, a);
    };
  }
  try {
    await new Promise((resolve, reject) => {
      asset.ready(resolve);
      asset.once('error', (err) => reject(err instanceof Error ? err : new Error(String(err))));
      app.assets.load(asset);
    });
  } finally {
    if (origStart) {
      delete device.startRenderPass; // back to the prototype's
      delete device.setTexture;
    }
  }

  // EVERY entity gets its app explicitly (the default is the engine's global "current app").
  const splat = new pc.Entity('lift-splat', app);
  splat.addComponent('gsplat', { asset });
  app.root.addChild(splat);
  const rigNode = new pc.Entity('lift-rig', app);
  app.root.addChild(rigNode);
  const eye = new pc.Entity('lift-eye', app);
  eye.addComponent('camera', {
    clearColor: new pc.Color(0, 0, 0, 0),
    clearColorBuffer: true,
    clearDepthBuffer: true,
    nearClip: NEAR,
    farClip: FAR,
    fov: 45,
  });
  if (Array.isArray(eye.camera.layers)) eye.camera.layers = eye.camera.layers.filter((id) => id !== pc.LAYERID_SKYBOX);
  // Splat colours are display-referred already: no tone map (the SDK adapter's rule).
  eye.camera.toneMapping = pc.TONEMAP_NONE;
  rigNode.addChild(eye);

  // The lift's own modifier on the tile material (reveal / depth gain / fade).
  const mat = app.scene.gsplat.material;
  mat.getShaderChunks(pc.SHADERLANGUAGE_GLSL).set('gsplatModifyVS', LIFT_MODIFY_VS);
  mat.update();

  app.start();
  return {
    pc,
    app,
    device,
    asset,
    splat,
    rigNode,
    eye,
    material: mat,
    perf: perfApplied.applied,
    count: asset.resource?.numSplats ?? asset.resource?.gsplatData?.numSplats ?? 0,
  };
}

/**
 * @param {object} o
 * @param {HTMLCanvasElement} o.canvas  the caller's canvas (its backing store is the caller's).
 * @param {WebGL2RenderingContext} [o.gl]  an EXISTING context on that canvas (one canvas, one
 *        context: the live-DIBR renderer owns it). Given → the engine device adopts it, the GL
 *        state is re-synced before every draw and handed back neutral after it, the tile starts
 *        HIDDEN (drawing nothing, clearing nothing) until fadeIn(), and fades never clear — the
 *        other renderer's frame is underneath.
 * @param {ArrayBuffer|Uint8Array} [o.ply]  a standard binary 3DGS PLY (x,y,z,nx,ny,nz,f_dc_0..2,
 *        opacity(logit),scale_0..2(log),rot_0..3), both layers in one file. Or:
 * @param {ArrayBuffer|Uint8Array} [o.sog]  a bundled `.sog` (SOG v2) — e.g. a remote SHARP lift —
 *        loaded from memory the same way (no URL, no blob:). Its camera block v2 supplies the rig
 *        (intrinsics → focalPx/w/h, focus.point[2] → pivotZ, OpenCV axes) unless `o.meta` gives them.
 * @param {{focalPx:number,pivotZ:number,w:number,h:number,layers?:number,axes?:string}} [o.meta]
 *        required with `ply`; optional with `sog` (merged over the block's).
 * @param {{maxAngleDeg?:number,relax?:boolean,gain?:number}} [o.orbit]
 * @param {'opengl'|'opencv'} [o.axes]  PLY convention override (see LIFT_AXES in ./orbit.js).
 * @param {'cover'|'contain'|'stretch'} [o.fit='cover']  photo window vs the viewport aspect.
 * @param {'median'|'display'} [o.restHead='median']  see createHeadTracker.
 * @param {boolean} [o.clampHead=true]  keep the tracked head inside the orbit cone.
 * @param {number} [o.depthGain=1]  the depth STRENGTH. With a depth budget it is linear in
 *        parallax: the fg–bg spread between the nominal eye pair = depthBudget × strength (the gain
 *        S about the pivot plane is solved for it, depthGainForBudget); without one it is S itself.
 * @param {number|false} [o.depthBudget]  fraction of the photo width of fg–bg parallax at
 *        strength 1 (lift.js passes the module's, else DEPTH_BUDGET_DEFAULT). false / omitted =
 *        no budget (the depth as lifted, strength = S).
 * @param {boolean} [o.startFlat=false]  hold the scene flat (the photo) until fadeIn().
 * @param {boolean} [o.startHidden=!!o.gl]  draw nothing (and clear nothing) until fadeIn().
 * @param {number} [o.clearAlpha=0]  alpha of the clear (black unless `o.clearColor` [r,g,b] 0..1).
 * @param {boolean} [o.clear=true]  clear the canvas before drawing (outside a shared-context
 *        fade). false = always composite over whatever is already in the buffer.
 * @param {'exact'|'balanced'|'aggressive'|object} [o.perf={antiAlias:true}]  the SDK's splat perf
 *        presets (./inline3d-splat-perf.js playcanvasPerfSettings — the addSplat engine:'playcanvas'
 *        mapping). The default turns the engine's splat anti-aliasing on: the lift's hidden-layer
 *        splats are sub-pixel-thin where the band is stretched, and without it they draw as
 *        horizontal streaks (MAE vs the Spark renderer 3.7 → 2.1 on the office lift).
 * @param {{mode?:'auto'|'always'|'off', target?:number, tolerance?:number}} [o.comfort]  the
 *        comfort normalisation (see comfortScale); `o.space` ('metric'|'disparity') is what 'auto'
 *        keys on (lift.js passes the frozen frame's depth space).
 * @param {'nominal'|'tracked'} [o.eyes='nominal']  'nominal': the runtime's eye separation is
 *        normalised to 63 mm (the gallery rule — the web SDK knows no panel size); 'tracked': the
 *        view positions are taken as metres (a display rig sized to the physical tile).
 * @param {(ev:PointerEvent)=>void} [o.onClick]  a press that moved < 6 px.
 * @param {(ex:object)=>void} [o.onReady]
 */
export async function createExplore(o) {
  const { canvas, ply, sog } = o;
  if (!canvas) throw new Error('lift/explore: canvas is required');
  if (!ply && !sog) throw new Error('lift/explore: ply or sog bytes are required');
  // A .sog carries its own rig (camera block v2); explicit meta fields win over it.
  let meta = o.meta;
  if (sog) {
    const fromBlock = (await readLiftSog(sog, meta || {})).meta;
    meta = { ...fromBlock, ...(meta || {}) };
  }
  if (!meta) throw new Error('lift/explore: meta is required with a ply');
  // Comfort: scale the scene about the capture camera (see comfortScale). The rig is built from the
  // SCALED pivot, and the splat entity carries the same scale, so every distance below is in the
  // scaled scene (the window, the cone, the reveal's pivot plane).
  const sceneScale = comfortScale(meta, { ...(o.comfort || {}), space: o.space ?? meta.space });
  const rig = rigFromMeta(sceneScale === 1 ? meta : { ...meta, pivotZ: meta.pivotZ * sceneScale }, o.axes ?? meta.axes ?? meta.convention);
  const orbitOpts = o.orbit || {};
  const maxDeg = orbitOpts.maxAngleDeg ?? ORBIT_MAX_DEG;
  const orbit = createOrbit({ maxAngleDeg: maxDeg, relax: orbitOpts.relax !== false, gain: orbitOpts.gain });
  // stats.lastRelease: which event ended the last drag and how long until the next frame stepped
  // the relax (panel diagnostics: a hold shows up as a large firstFrameMs or a late `via`).
  const gesture = createOrbitGesture({
    orbit,
    onClick: (ev) => o.onClick?.(ev),
    onRelease: (via) => {
      stats.lastRelease = { via, at: performance.now(), firstFrameMs: null };
    },
  });
  const head = createHeadTracker({ rest: o.restHead, metresPerUnit: o.eyes === 'tracked' ? 1 : 0 });
  const limit = o.clampHead === false ? Infinity : coneLimit(rig, maxDeg);
  const fit = o.fit || 'cover';

  const shared = !!o.gl;
  const eng = await createPlayCanvasSplat({
    canvas,
    gl: o.gl || null,
    bytes: sog || ply,
    format: sog ? 'sog' : 'ply',
    perf: o.perf ?? { antiAlias: true },
  });
  const { pc, app, device, splat, rigNode, eye, material } = eng;
  if (shared) releaseGlState(o.gl); // device creation issued its own initial state

  // The PLY → capture-frame flip (OpenCV: +z forward, y down → 180° about X), on the splat entity:
  // world is then the capture frame for every convention (camera at the origin, looking −z).
  if (rig.axes.flip) splat.setLocalEulerAngles(180, 0, 0);
  if (sceneScale !== 1) splat.setLocalScale(sceneScale, sceneScale, sceneScale);

  // ── uniforms ──
  const U = { s: NaN, ox: NaN, oy: NaN, oz: NaN, fade: NaN };
  const oVec = new Float32Array(3);
  material.setParameter('uLiftD', rig.dPivot);
  const setUniforms = (s, ox, oy, oz, fadeMul) => {
    if (s === U.s && ox === U.ox && oy === U.oy && oz === U.oz && fadeMul === U.fade) return;
    U.s = s; U.ox = ox; U.oy = oy; U.oz = oz; U.fade = fadeMul;
    oVec[0] = ox; oVec[1] = oy; oVec[2] = oz;
    material.setParameter('uLiftS', s);
    material.setParameter('uLiftO', oVec);
    material.setParameter('uLiftD', rig.dPivot);
    material.setParameter('uLiftFade', fadeMul);
    material.update();
  };

  // ── depth budget: strength → the gain S that makes the nominal-pair parallax spread equal
  //    depthBudget × strength (orbit.js § Depth budget). The range: the generator's
  //    meta.depthRange, else the splat centres (a .sog input), else no budget.
  const budget = Number.isFinite(o.depthBudget) && o.depthBudget > 0 ? +o.depthBudget : 0;
  let range = meta.depthRange && meta.depthRange.near > 0 && meta.depthRange.far > meta.depthRange.near ? meta.depthRange : null;
  let rangeSource = range ? 'meta' : null;
  if (!range && budget) {
    try {
      const res = eng.asset && eng.asset.resource;
      range = depthRangeFromCenters(res && (res.centers || res.gsplatData?.getCenters?.()), rig.axes.fwd || 1);
      if (range) rangeSource = 'centers';
    } catch {
      range = null;
    }
  }
  const budgetGeo = range ? { near: range.near, far: range.far, d: rig.dPivot, k: sceneScale, fPx: rig.fPx, w: rig.w, ipd: IPD_M } : null;
  const budgetStats = { budget: budget || null, rangeSource, strength: NaN, gain: NaN, spread: NaN, capped: false };
  const gainFor = (strength) => {
    const s = Math.max(0, +strength || 0);
    let g = s;
    if (budget && budgetGeo) {
      const r = depthGainForBudget(budget * s, budgetGeo);
      g = r.gain;
      Object.assign(budgetStats, { spread: +r.spread.toFixed(5), capped: r.capped });
    }
    Object.assign(budgetStats, { strength: s, gain: +g.toFixed(4) });
    return g;
  };
  let depthGain = gainFor(Number.isFinite(o.depthGain) ? o.depthGain : 1);
  let reveal = o.startFlat ? { t0: Infinity, ms: REVEAL_MS } : null; // null = done
  let depthS = 1;
  let depthO = { x: 0, y: 0, z: 0 };
  const setDepth = (p, originWorld) => {
    depthS = FLAT_RESIDUAL + (depthGain - FLAT_RESIDUAL) * p;
    depthO = originWorld || { x: 0, y: 0, z: 0 };
  };
  setDepth(reveal ? 0 : 1);

  // Global opacity fade (fadeIn with opacity, fadeOut). `hidden` = draw nothing, clear nothing.
  // While a fade runs the frame is NOT cleared: in the shared-context crossfade the other
  // renderer's frame is underneath and the splats composite over it (premultiplied "over").
  let hidden = o.startHidden ?? shared;
  const clearFrames = o.clear !== false;
  // Opaque clear for an in-page lift: with the default transparent clear, pixels the splat sheet
  // does not fully cover (frame edges swung into view, sparse disocclusions) let the page's own
  // <img>/<video> — the flat picture — show through as a ghost double under the orbit.
  const cc = Array.isArray(o.clearColor) ? o.clearColor : [0, 0, 0];
  eye.camera.clearColor = new pc.Color(cc[0] ?? 0, cc[1] ?? 0, cc[2] ?? 0, Number.isFinite(o.clearAlpha) ? o.clearAlpha : 0);
  let fade = null; // { from, to, t0, ms, resolve }
  let fadeLevel = 1;
  let fadeMul = 1;
  const setOpacity = (c) => {
    // A per-SPLAT multiplier, not a layer alpha: an image-aligned lift is a dense sheet where
    // ~FADE_OVERLAP splats cover each pixel, so coverage ≈ 1 − (1 − m)^k and a linear m reads as
    // ~45 % visible at m = 0.1. Invert that so the requested value is the perceived coverage.
    const cov = Math.min(1, Math.max(0, c));
    fadeLevel = cov;
    fadeMul = cov >= 1 ? 1 : 1 - Math.pow(1 - cov, 1 / FADE_OVERLAP);
  };
  setOpacity(hidden ? 0 : 1);
  const stepFade = (t) => {
    if (!fade) return;
    const x = Math.min(1, Math.max(0, t - fade.t0) / fade.ms);
    setOpacity(fade.from + (fade.to - fade.from) * x);
    if (x >= 1) {
      const done = fade;
      fade = null;
      if (done.to <= 0) hidden = true;
      done.resolve();
    }
  };

  let lastT = 0;
  let disposed = false;
  let last = null; // { eyes, vps } — the last frame that drew, for replay
  const stats = { frames: 0, renderMs: 0, lastRenderMs: 0, splats: eng.count, sceneScale, lastRelease: null, depthBudget: budgetStats };
  let orbitNow = orbitRig(0, 0, rig.dPivot);

  const tick = () => {
    const t = performance.now();
    const dt = lastT ? Math.min((t - lastT) / 1000, MAX_DT_S) : 0;
    lastT = t;
    orbit.step(dt);
    const lr = stats.lastRelease;
    if (lr && lr.firstFrameMs === null) lr.firstFrameMs = Math.round(t - lr.at);
    orbitNow = orbitRig(orbit.yaw, orbit.pitch, rig.dPivot);
    return t;
  };

  const updateReveal = (t, mid) => {
    if (!reveal) return;
    const x = Number.isFinite(reveal.t0) ? Math.min(1, Math.max(0, t - reveal.t0) / reveal.ms) : 0;
    // Centre of projection = the viewer's head, in WORLD (= the capture frame): the head is in
    // rig space, so through the orbit rig.
    const originWorld = mid ? rigApply(orbitNow, mid) : null;
    if (x >= 1) {
      reveal = null;
      setDepth(1); // origin back to the capture camera; λ is 1 at s = gain from anywhere near it
    } else setDepth(easeOutCubic(x), originWorld);
  };

  // The eyes: N RenderViews on the one camera. Pose = the eye's translation in RIG space (identity
  // rotation — the frustum is off-axis); the engine composes the rig node's world transform in.
  const rvs = [];
  const projs = [];
  const poses = [];
  let frustumKey = '';
  const draw = (eyes, vps) => {
    const t0 = performance.now();
    rigNode.setLocalPosition(orbitNow.position[0], orbitNow.position[1], orbitNow.position[2]);
    rigNode.setLocalRotation(orbitNow.rotation[0], orbitNow.rotation[1], orbitNow.rotation[2], orbitNow.rotation[3]);
    if (rvs.length !== eyes.length) {
      rvs.length = 0;
      for (let i = 0; i < eyes.length; i++) {
        rvs.push(new pc.RenderView());
        projs[i] ||= new Float32Array(16);
        poses[i] ||= new Float32Array(16);
      }
      eye.camera.camera.xrViews = rvs.slice();
    }
    let mx = 0, my = 0, mz = 0;
    for (let i = 0; i < eyes.length; i++) {
      const e = eyes[i];
      const vp = vps[i];
      const f = frustumFor(rig, e, fitWindow(rig, vp.width / vp.height, fit));
      perspectiveOffAxis(f.l, f.r, f.t, f.b, NEAR, FAR, projs[i]);
      translation(e.x, e.y, e.z, poses[i]);
      rvs[i].setView(projs[i], poses[i]);
      rvs[i].setViewport(vp.x, vp.y, vp.width, vp.height);
      mx += e.x; my += e.y; mz += e.z;
    }
    // LOD and FOV compensation read camera.fov/near/far, which under xrViews come from the XR
    // properties — the frustum the views actually have (the SDK adapter's rule).
    const P = projs[0];
    const fov = (2 * Math.atan(1 / P[5])) / DEG;
    const aspectRatio = P[5] / P[0];
    const key = `${fov.toFixed(3)}|${aspectRatio.toFixed(3)}`;
    if (key !== frustumKey) {
      frustumKey = key;
      eye.camera.camera.setXrProperties({ fov, aspectRatio, nearClip: NEAR, farClip: FAR, horizontalFov: false });
    }
    // The camera NODE drives the sort (one sort, both eyes): park it at the eyes' midpoint.
    const n = Math.max(eyes.length, 1);
    eye.setLocalPosition(mx / n, my / n, mz / n);
    eye.setLocalRotation(0, 0, 0, 1);
    // Clear only when this renderer owns the frame: never mid-fade on a shared context (the other
    // renderer's frame is underneath), never with clear:false.
    eye.camera.clearColorBuffer = clearFrames && !(shared && fade);
    setUniforms(depthS, depthO.x, depthO.y, depthO.z, fadeMul);
    if (shared) adoptGlState(device);
    app.tick(performance.now());
    if (shared) releaseGlState(o.gl);
    const ms = performance.now() - t0;
    stats.frames++;
    stats.renderMs += ms;
    stats.lastRenderMs = ms;
  };

  const ex = {
    rig,
    /** The lift meta the rig was built from (with a `sog`: read off its camera block). */
    meta,
    /** The comfort normalisation applied (1 = none): the scene is scaled by this about the camera. */
    sceneScale,
    orbit,
    head,
    stats,
    /** Advanced: the PlayCanvas objects (app, device, splat entity, rig node, eye camera). */
    engine: { app, device, splat, rigNode, eye, material, pc },

    /**
     * Draw one frame. Call from the addScene callback with the runtime's views and layer.
     * `views` omitted/null = the flat fallback: one eye at the rest head, the whole canvas.
     * A short view list (the load-induced mono blip) or a missing viewport REPLAYS the last good
     * frame rather than clearing — a woven canvas that is not redrawn can smear (SceneViewer).
     */
    render({ views, layer } = {}) {
      if (disposed) return;
      const t = tick();
      stepFade(t);
      if (hidden) return;
      if (!views) {
        const vp = { x: 0, y: 0, width: canvas.width, height: canvas.height };
        updateReveal(t, null);
        draw([{ x: 0, y: 0, z: 0 }], [vp]);
        return;
      }
      const vps = [];
      let ok = views.length >= 2;
      for (const v of views) {
        const vp = layer && typeof layer.getViewport === 'function' ? layer.getViewport(v) : null;
        if (!vp || !(vp.width > 0) || !(vp.height > 0)) ok = false;
        vps.push(vp);
      }
      if (!ok) {
        if (last) draw(last.eyes, last.vps);
        return;
      }
      const tracked = head.update(
        views.map((v) => v.transform.position),
        limit,
      );
      updateReveal(t, tracked.mid);
      draw(tracked.eyes, vps);
      last = { eyes: tracked.eyes, vps: vps.map((v) => ({ x: v.x, y: v.y, width: v.width, height: v.height })) };
    },

    onPointerDown(ev) {
      gesture.down(ev);
      try {
        (ev.currentTarget || canvas).setPointerCapture?.(ev.pointerId);
      } catch {
        /* a synthetic / inactive pointer id throws; the gesture works without capture */
      }
    },
    onPointerMove(ev) {
      if (!gesture.active) return;
      gesture.move(ev, (ev.currentTarget || canvas).getBoundingClientRect());
    },
    /** pointerup / pointercancel / lostpointercapture: the relax starts HERE, synchronously. */
    onPointerUp(ev) {
      // Release first: the orbit is heading home before anything else runs.
      gesture.up(ev);
      if (ev.type !== 'lostpointercapture') {
        try {
          (ev.currentTarget || canvas).releasePointerCapture?.(ev.pointerId);
        } catch {
          /* not captured */
        }
      }
    },

    /** Page-driven orbit, degrees (clamped to the cap); becomes the pose a release relaxes to. */
    setTarget(yaw, pitch, opt) {
      orbit.setTarget(yaw, pitch, opt);
    },

    /**
     * Bring the scene in over `ms`. Two effects, chosen by opts:
     *   inflate  the gallery's reveal — the flat photo inflating into depth (ease-out cubic).
     *            Default ON standalone (the 2D photo is what was on screen), OFF on a shared
     *            context (the live-DIBR frame underneath already has depth; inflating from flat
     *            would read as depth collapsing and regrowing).
     *   opacity  a linear 0 → 1 ramp over whatever is underneath (never cleared meanwhile).
     *            Default ON on a shared context / from hidden, OFF standalone.
     * Returns a Promise that resolves when the fade (the longer of the two) has finished.
     */
    fadeIn(ms = REVEAL_MS, opts = {}) {
      const dur = Math.max(1, ms);
      const inflate = opts.inflate ?? !shared;
      const opacity = opts.opacity ?? (shared || hidden);
      hidden = false;
      if (inflate) {
        reveal = { t0: performance.now(), ms: dur };
        setDepth(0);
      }
      if (!opacity) {
        fade?.resolve();
        fade = null;
        setOpacity(1);
        return new Promise((resolve) => setTimeout(resolve, inflate ? dur : 0));
      }
      fade?.resolve();
      return new Promise((resolve) => {
        fade = { from: 0, to: 1, t0: performance.now(), ms: dur, resolve };
        setOpacity(0);
      });
    },

    /**
     * Opacity ramp to 0 over `ms` (no clears meanwhile), then stop drawing — render() becomes a
     * no-op that leaves the canvas to whoever draws next — until the next fadeIn(). Resolves when
     * hidden. For the explore → live crossfade.
     */
    fadeOut(ms = 400) {
      if (hidden) return Promise.resolve();
      const from = fade ? fadeLevel : 1;
      fade?.resolve();
      return new Promise((resolve) => {
        fade = { from, to: 0, t0: performance.now(), ms: Math.max(1, ms), resolve };
      });
    },

    /** Depth STRENGTH: with a depth budget, linear in parallax (0.5 = half the budget's spread,
     *  no regeneration — the gain about the pivot plane is re-solved); without one, the gain itself
     *  (1 = as lifted, 0 = flat, 2 = doubled). */
    setDepthGain(x) {
      if (!Number.isFinite(x)) return;
      depthGain = gainFor(x);
      if (!reveal) setDepth(1);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      fade?.resolve();
      fade = null;
      try {
        eye.camera.camera.xrViews = null;
      } catch {
        /* engine without the XR view plumbing */
      }
      // app.destroy() destroys the device; WebglGraphicsDevice.destroy() never loses the context
      // (checked @ 2.22.3), so the live DIBR keeps its context on the shared path.
      try {
        app.destroy();
      } catch (err) {
        console.warn('[lift/explore] app.destroy() threw', err);
      }
      if (shared) releaseGlState(o.gl);
    },
  };
  o.onReady?.(ex);
  return ex;
}

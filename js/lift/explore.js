// lift/explore.js — render a lifted two-layer, image-aligned Gaussian scene ("Convert to 3D")
// into the SDK's per-view viewports: real head parallax from the runtime's tracked eyes, plus a
// capped drag orbit that relaxes home on release.
//
// EXPERIMENTAL. The gallery's Spatial View (displayxr-gallery-pvt: src/lib/spatialView/camera.ts,
// reveal.ts, the wall's camera rig in SpatialView.tsx) ported into the SDK as one module, on the
// SDK's Spark path. See docs/lift-explore.md.
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
// It never touches canvas.width/height.
//
// Requires the SDK's optional peers `three` (>= 0.180) and `@sparkjsdev/spark` (2.x), exactly
// like ./inline3d-splat.js. Spark parses the PLY in its own worker (wasm), so loading 1.2 M
// splats does not block the page.

import * as THREE from 'three';
import { SparkRenderer, SplatMesh, dyno } from '@sparkjsdev/spark';
import { applySplatPerf, splatPerfMeshOptions } from '../inline3d-splat-perf.js';
import {
  createOrbit,
  createClickTracker,
  createHeadTracker,
  rigFromMeta,
  fitWindow,
  frustumFor,
  coneLimit,
  NEAR,
  FAR,
  ORBIT_MAX_DEG,
} from './orbit.js';

export * from './orbit.js';

/** Sort at most this often (ms): one sort serves both eyes (see inline3d-splat.js). */
const SORT_INTERVAL_MS = 16;
/** Default reveal (inflate) duration, ms — the gallery's REVEAL_MS. */
export const REVEAL_MS = 1400;
/** Depth kept at the START of the reveal, about the pivot. Not 0: a perfectly flat cloud has no
 *  depth ORDER, so the back-to-front composite goes arbitrary (gallery measured MAE 27 vs 2.6). */
export const FLAT_RESIDUAL = 0.05;
/** Effective splats per pixel on a lifted sheet, for the fade's coverage correction (measured on
 *  the dev harness's 1-gaussian-per-pixel, two-layer synthetic lift; see docs/lift-explore.md). */
const FADE_OVERLAP = 5;
/** Longest frame step the easing integrates, s (a backgrounded tab must not teleport). */
const MAX_DT_S = 0.1;

const easeOutCubic = (x) => 1 - (1 - x) ** 3;
const DEG = Math.PI / 180;

/**
 * Build the Spark half: a three.js renderer on the caller's canvas, a SparkRenderer, and the
 * mesh. Factored so the integrator can lift it next to addSplat's (they share the perf presets
 * and the sort-interval rule already; inline3d-splat.js is deliberately untouched here).
 */
export async function createSplatRenderer({ canvas, gl = null, bytes, fileType = 'ply', perf = null, sortIntervalMs = SORT_INTERVAL_MS }) {
  // A SHARED context (the lift canvas's one WebGL2 context, created by the live-DIBR renderer) is
  // taken as-is: three wraps it and never calls getContext itself. Its attributes are the
  // creator's (live-dibr: alpha, premultipliedAlpha, no antialias — the same as ours).
  const renderer = gl
    ? new THREE.WebGLRenderer({ canvas, context: gl })
    : new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, premultipliedAlpha: true });
  // MUST be 1: layer.getViewport() is in backing-store px and three multiplies by pixelRatio.
  renderer.setPixelRatio(1);
  renderer.autoClear = false;
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  // autoUpdate OFF — the stereo fix. With it on, Spark runs its update (splat GENERATION + sort
  // scheduling) from onBeforeRender on every render() call whose camera moved > 1 mm, and a
  // stereo frame alternates two cameras ~63 mm apart, so all 1.2 M splats were regenerated TWICE
  // per frame (measured: p95 frame 100-140 ms on 2 views vs a flat 60 fps mono). The caller drives
  // one update per frame from the eyes' midpoint instead: one generate, one sort, both eyes.
  const spark = new SparkRenderer({ renderer, minSortIntervalMs: sortIntervalMs, autoUpdate: false });
  scene.add(spark);
  const perfApplied = perf ? applySplatPerf(spark, perf) : null;
  const mesh = new SplatMesh({
    fileBytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
    fileType,
    ...splatPerfMeshOptions(perf),
  });
  await mesh.initialized;
  return { renderer, scene, spark, mesh, perf: perfApplied };
}

/**
 * One Spark update for this frame. Spark's PUBLIC update() forces a full splat regeneration on
 * every call (it passes autoUpdate:false, which disables the "nothing changed" skip) — at 1.2 M
 * splats that alone cost a mono frame 60 → ~25 fps. The private updateInternal with
 * autoUpdate:true is exactly what Spark's own onBeforeRender runs: regenerate only when the
 * viewpoint moved > 1 mm or a generator's version changed. Fall back to update() if a Spark
 * version renames it. Integrator: this is the one Spark-internal this module leans on.
 */
function sparkUpdate(spark, scene, camera) {
  const p =
    typeof spark.updateInternal === 'function'
      ? spark.updateInternal({ scene, camera, autoUpdate: true })
      : spark.update({ scene, camera });
  p?.catch?.((err) => console.warn('[lift/explore] spark update', err));
}

/**
 * The inflate reveal + depth gain, as one Spark objectModifier (a dyno graph, per splat on the
 * GPU, in the PLY's OBJECT space). The gallery's reveal.ts, generalised over the view-axis sign.
 *
 * Every splat is slid along the ray from a centre of projection `o` so its depth along the view
 * axis becomes t' = D + (t − D)·s — the plane t = D (the pivot) stays put — and its scales are
 * multiplied by the same λ, so its footprint seen FROM `o` does not change. From `o` the
 * modifier is therefore invisible; from the two eyes either side of it, only the disparity
 * changes. s = FLAT_RESIDUAL → gain is the reveal ("the photo inflates into depth"); s = gain at
 * rest is setDepthGain (a non-metric lift's strength knob), for free.
 *
 * `o` is the viewer's head: in this rig the rest head IS the capture camera (the origin), so it
 * only moves by the head offset while a reveal plays (fed per frame, as the gallery wall does).
 */
function attachDepthModifier(mesh, { dPivot, fwd }) {
  const s = dyno.dynoFloat(1, 'liftS'); // depth scale about the pivot
  const origin = dyno.dynoVec3(new THREE.Vector3(0, 0, 0), 'liftO');
  const originT = dyno.dynoFloat(0, 'liftOt'); // o's depth along the view axis
  const plane = dyno.dynoConst('float', dPivot);
  const sign = dyno.dynoConst('float', fwd);
  const one = dyno.dynoConst('float', 1);
  const eps = dyno.dynoConst('float', 1e-4);

  mesh.objectModifier = dyno.dynoBlock({ gsplat: dyno.Gsplat }, { gsplat: dyno.Gsplat }, ({ gsplat }) => {
    if (!gsplat) throw new Error('lift/explore: no gsplat input');
    // Spark's own idiom: splitGsplat(g).outputs.<field> (NOT destructuring the dyno itself).
    const parts = dyno.splitGsplat(gsplat).outputs;
    const t = dyno.mul(parts.z, sign); // depth along the view axis, > 0 in front of the camera
    const tFlat = dyno.add(plane, dyno.mul(dyno.sub(t, plane), s));
    const dt = dyno.sub(t, originT);
    const front = dyno.greaterThan(dt, eps);
    // Splats at or behind `o` keep λ = 1: projecting them through `o` flings them to infinity.
    const lambda = dyno.select(front, dyno.div(dyno.sub(tFlat, originT), dyno.max(dt, eps)), one);
    const out = dyno.combineGsplat({
      gsplat,
      center: dyno.add(origin, dyno.mul(dyno.sub(parts.center, origin), lambda)),
      scales: dyno.mul(parts.scales, lambda),
    });
    return { gsplat: out };
  });
  mesh.updateGenerator();
  mesh.updateVersion();

  let lastS = 1;
  return {
    /** A uniform change does NOTHING until updateVersion() — Spark regenerates on version. */
    set(sv, ox = 0, oy = 0, oz = 0) {
      const ot = fwd * oz;
      if (sv === lastS && origin.value.x === ox && origin.value.y === oy && originT.value === ot) return;
      lastS = sv;
      s.value = sv;
      origin.value.set(ox, oy, oz);
      originT.value = ot;
      mesh.updateVersion();
    },
    dispose() {
      mesh.objectModifier = undefined;
      try {
        mesh.updateGenerator();
      } catch {
        /* mesh already disposed */
      }
    },
  };
}

/**
 * @param {object} o
 * @param {HTMLCanvasElement} o.canvas  the caller's canvas (its backing store is the caller's).
 * @param {WebGL2RenderingContext} [o.gl]  an EXISTING context on that canvas (one canvas, one
 *        context: the live-DIBR renderer owns it). Given → three wraps it, `resetState()` runs
 *        before every draw (the other renderer moved GL state behind three's cache), nothing is
 *        restored afterwards, the tile starts HIDDEN (drawing nothing, clearing nothing) until
 *        fadeIn(), and fades never clear — the other renderer's frame is underneath.
 * @param {ArrayBuffer|Uint8Array} o.ply  a standard binary 3DGS PLY (x,y,z,nx,ny,nz,f_dc_0..2,
 *        opacity(logit),scale_0..2(log),rot_0..3), both layers in one file.
 * @param {{focalPx:number,pivotZ:number,w:number,h:number,layers?:number,axes?:string}} o.meta
 * @param {{maxAngleDeg?:number,relax?:boolean,gain?:number}} [o.orbit]
 * @param {'opengl'|'opencv'} [o.axes]  PLY convention override (see LIFT_AXES in ./orbit.js).
 * @param {'cover'|'contain'|'stretch'} [o.fit='cover']  photo window vs the viewport aspect.
 * @param {'median'|'display'} [o.restHead='median']  see createHeadTracker.
 * @param {boolean} [o.clampHead=true]  keep the tracked head inside the orbit cone.
 * @param {number} [o.depthGain=1]
 * @param {boolean} [o.startFlat=false]  hold the scene flat (the photo) until fadeIn().
 * @param {boolean} [o.startHidden=!!o.gl]  draw nothing (and clear nothing) until fadeIn().
 * @param {boolean} [o.clear=true]  clear the canvas before drawing (outside a shared-context
 *        fade). false = always composite over whatever is already in the buffer.
 * @param {'exact'|'balanced'|'aggressive'|object} [o.perf]  Spark overdraw presets.
 * @param {(ev:PointerEvent)=>void} [o.onClick]  a press that moved < 6 px.
 * @param {(ex:object)=>void} [o.onReady]
 */
export async function createExplore(o) {
  const { canvas, ply, meta } = o;
  if (!canvas) throw new Error('lift/explore: canvas is required');
  if (!ply) throw new Error('lift/explore: ply bytes are required');
  const rig = rigFromMeta(meta, o.axes);
  const orbitOpts = o.orbit || {};
  const maxDeg = orbitOpts.maxAngleDeg ?? ORBIT_MAX_DEG;
  const orbit = createOrbit({ maxAngleDeg: maxDeg, relax: orbitOpts.relax !== false, gain: orbitOpts.gain });
  const click = createClickTracker();
  const head = createHeadTracker({ rest: o.restHead });
  const limit = o.clampHead === false ? Infinity : coneLimit(rig, maxDeg);
  const fit = o.fit || 'cover';

  const shared = !!o.gl;
  const sr = await createSplatRenderer({ canvas, gl: o.gl || null, bytes: ply, perf: o.perf });
  const { renderer, scene, mesh } = sr;

  // scene ── orbit (at the focus point F, rotated) ── centering (−F) ── axes (PLY → scene) ── mesh
  // so yaw/pitch turn the lift about F = (0, 0, −dPivot): the screen centre at the pivot plane,
  // the same point head motion pivots about.
  const F = new THREE.Vector3(0, 0, -rig.dPivot);
  const orbitNode = new THREE.Group();
  const centering = new THREE.Group();
  const axesNode = new THREE.Group();
  orbitNode.position.copy(F);
  centering.position.copy(F).negate();
  if (rig.axes.flip) axesNode.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
  axesNode.add(mesh);
  centering.add(axesNode);
  orbitNode.add(centering);
  scene.add(orbitNode);

  const depth = attachDepthModifier(mesh, { dPivot: rig.dPivot, fwd: rig.axes.fwd });
  let depthGain = Number.isFinite(o.depthGain) ? o.depthGain : 1;
  let reveal = o.startFlat ? { t0: Infinity, ms: REVEAL_MS } : null; // null = done
  const setDepth = (p, headLocal) => {
    const sv = FLAT_RESIDUAL + (depthGain - FLAT_RESIDUAL) * p;
    if (headLocal) depth.set(sv, headLocal.x, headLocal.y, headLocal.z);
    else depth.set(sv);
  };
  setDepth(reveal ? 0 : 1);

  // One camera per view, reused. Identity rotation always: the frustum is off-axis.
  const cams = [];
  const camFor = (i) => (cams[i] ||= new THREE.PerspectiveCamera());
  const placeCamera = (cam, e, vpAspect) => {
    cam.position.set(e.x, e.y, e.z);
    cam.quaternion.identity();
    cam.updateMatrixWorld(true);
    const f = frustumFor(rig, e, fitWindow(rig, vpAspect, fit));
    cam.projectionMatrix.makePerspective(f.l, f.r, f.t, f.b, NEAR, FAR);
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
  };

  // Global opacity fade (fadeIn with opacity, fadeOut). `hidden` = draw nothing, clear nothing.
  // While a fade runs the frame is NOT cleared: in the shared-context crossfade the other
  // renderer's frame is underneath and the splats composite over it (premultiplied "over").
  let hidden = o.startHidden ?? shared;
  const clearFrames = o.clear !== false;
  let fade = null; // { from, to, t0, ms, resolve }
  const setOpacity = (c) => {
    // Spark folds mesh.opacity into its per-splat alpha and regenerates on change by itself. That
    // is a per-SPLAT multiplier, not a layer alpha: an image-aligned lift is a dense sheet where
    // ~FADE_OVERLAP splats cover each pixel, so coverage ≈ 1 − (1 − m)^k and a linear m reads as
    // ~45 % visible at m = 0.1. Invert that so the requested value is the perceived coverage.
    const cov = Math.min(1, Math.max(0, c));
    fadeLevel = cov;
    mesh.opacity = cov >= 1 ? 1 : 1 - Math.pow(1 - cov, 1 / FADE_OVERLAP);
  };
  let fadeLevel = 1;
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
  const tmp = new THREE.Vector3();
  const stats = { frames: 0, renderMs: 0, lastRenderMs: 0 };

  const tick = () => {
    const t = performance.now();
    const dt = lastT ? Math.min((t - lastT) / 1000, MAX_DT_S) : 0;
    lastT = t;
    orbit.step(dt);
    orbitNode.rotation.set(orbit.pitch * DEG, orbit.yaw * DEG, 0, 'YXZ');
    orbitNode.updateMatrixWorld(true);
    return t;
  };

  const updateReveal = (t, mid) => {
    if (!reveal) return;
    const x = Number.isFinite(reveal.t0) ? Math.min(1, Math.max(0, t - reveal.t0) / reveal.ms) : 0;
    let local = null;
    if (mid) {
      // Centre of projection = the viewer's head, in the mesh's object space.
      tmp.set(mid.x, mid.y, mid.z);
      mesh.updateWorldMatrix(true, false);
      mesh.worldToLocal(tmp);
      local = tmp;
    }
    if (x >= 1) {
      reveal = null;
      setDepth(1); // origin back to the capture camera; λ is 1 at s = gain from anywhere near it
    } else setDepth(easeOutCubic(x), local);
  };

  const centreCam = new THREE.PerspectiveCamera();
  const draw = (eyes, vps) => {
    const t0 = performance.now();
    // One Spark update per frame, from the midpoint of the eyes (see createSplatRenderer).
    let mx = 0, my = 0, mz = 0;
    for (const e of eyes) { mx += e.x; my += e.y; mz += e.z; }
    const n = Math.max(eyes.length, 1);
    placeCamera(centreCam, { x: mx / n, y: my / n, z: mz / n }, vps[0].width / vps[0].height);
    if (shared) renderer.resetState();
    sparkUpdate(sr.spark, scene, centreCam);
    // Clear only when this renderer owns the frame: never mid-fade on a shared context (the other
    // renderer's frame is underneath), never with clear:false.
    if (clearFrames && !(shared && fade)) renderer.clear();
    renderer.setScissorTest(true);
    for (let i = 0; i < eyes.length; i++) {
      const vp = vps[i];
      renderer.setViewport(vp.x, vp.y, vp.width, vp.height);
      renderer.setScissor(vp.x, vp.y, vp.width, vp.height);
      const cam = camFor(i);
      placeCamera(cam, eyes[i], vp.width / vp.height);
      renderer.render(scene, cam);
    }
    renderer.setScissorTest(false);
    const ms = performance.now() - t0;
    stats.frames++;
    stats.renderMs += ms;
    stats.lastRenderMs = ms;
  };

  const ex = {
    rig,
    orbit,
    head,
    stats,
    /** Advanced: the three/Spark objects. */
    engine: { renderer, scene, spark: sr.spark, mesh, THREE },

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
      click.down(ev.clientX, ev.clientY);
      try {
        (ev.currentTarget || canvas).setPointerCapture?.(ev.pointerId);
      } catch {
        /* a synthetic / inactive pointer id throws; the gesture works without capture */
      }
    },
    onPointerMove(ev) {
      if (!click.active) return;
      if (!click.move(ev.clientX, ev.clientY)) return; // still inside the click slop
      const box = (ev.currentTarget || canvas).getBoundingClientRect();
      const p = click.origin();
      orbit.drag((ev.clientX - p.x) / Math.max(box.width, 1), (ev.clientY - p.y) / Math.max(box.height, 1));
    },
    onPointerUp(ev) {
      const kind = click.up();
      try {
        (ev.currentTarget || canvas).releasePointerCapture?.(ev.pointerId);
      } catch {
        /* not captured */
      }
      if (kind === 'drag') orbit.release();
      else if (kind === 'click' && ev.type !== 'pointercancel') o.onClick?.(ev);
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

    /** Depth strength about the pivot plane: 1 = as lifted, 0 = flat, 2 = doubled. */
    setDepthGain(x) {
      if (!Number.isFinite(x)) return;
      depthGain = Math.max(0, x);
      if (!reveal) setDepth(1);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      fade?.resolve();
      fade = null;
      depth.dispose();
      scene.remove(orbitNode);
      mesh.dispose?.();
      // addSplat's handle.remove() leaks the SparkRenderer — dispose it explicitly here.
      sr.spark.dispose?.();
      // On a shared context three's dispose() only frees ITS objects; the context stays alive
      // for its owner (three calls loseContext only from forceContextLoss()).
      renderer.dispose();
    },
  };
  o.onReady?.(ex);
  return ex;
}

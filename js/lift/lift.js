// lift/lift.js — "Convert to 3D": lift any <video>, <img> or <canvas> on a page into 3D, in place.
//
//   const h = await lift(videoEl);            // live 3D while it plays, explorable 3D when paused
//   h.on('statechange', ({ state }) => …);
//   h.setDepth(1.3); h.explore(); h.resume(); h.remove();
//
// Two presentations, one canvas:
//   LIVE     — per-frame monocular depth (a video depth provider) + depth-image-based rendering:
//              every view is re-projected from the current frame. Cheap, always in sync.
//   EXPLORE  — the paused/ended frame (or a still) is lifted ONCE into a small 3D Gaussian scene
//              (still-depth provider → lift generator, with inpainting behind edges) and shown with a
//              bounded orbit. Expensive, so it only runs when the media stops.
// state.js decides which one is showing and when; this file wires it to the DOM, the providers and
// the inline-3D session.
//
// ── The session ──────────────────────────────────────────────────────────────────────────────
// One inline-3D session per document (inline3d.js warns on a second one: the element-rect channel
// is a whole-widget setter). So: pass `wall` to join the page's existing manager; otherwise every
// lift() in the document shares ONE private manager, closed when its last lift is removed. The
// lifted canvas is an ordinary addScene() window. On a browser without inline-3D the same render
// path runs off requestAnimationFrame with a single mono view and a full-canvas viewport — the 2D
// fallback — so the page still gets the converted picture (the stubs wobble it so you can tell).
//
// ── Providers ────────────────────────────────────────────────────────────────────────────────
// Depth / model source / live-DIBR / lift generator / explore renderer are separate modules with
// fixed contracts (docs/lift.md). `backend: 'stub'` swaps in js/lift/stubs/* — same contracts,
// no models — so the state machine and the sample run end-to-end without any ML.

import { createInline3D } from '../inline3d.js';
import { createLiftMachine, STATES } from './state.js';
import { mountCanvas, resolveMediaAt, findMediaInParentsAndSiblings, mediaSize } from './placement.js';
import { createChip } from './ui.js';

export { resolveMediaAt, STATES };

const FADE_MS = 350;
const MAX_EYE_PX = 2048; // cap on one view's backing width

// Literal import() calls (not a computed path) so bundlers can see and split them.
const BACKENDS = {
  real: {
    depth: () => import('./providers/depth-ort.js'),
    // index.js re-exports createModelSource + loadOrt + getRegistry and, by importing depth-ort.js /
    // inpaint-ort.js, registers the ORT providers in the shared registry.
    models: () => import('./providers/index.js'),
    dibr: () => import('./live-dibr.js'),
    gen: () => import('./gen/lift-gen.js'),
    explore: () => import('./explore.js'),
  },
  stub: {
    depth: () => import('./stubs/depth.js'),
    models: () => import('./stubs/models.js'),
    dibr: () => import('./stubs/live-dibr.js'),
    gen: () => import('./stubs/lift-gen.js'),
    explore: () => import('./stubs/explore.js'),
  },
};

async function loadBackend(name) {
  const b = BACKENDS[name];
  if (!b) throw new TypeError(`lift: unknown backend '${name}' (expected 'real' or 'stub')`);
  const [depth, models, dibr, gen, explore] = await Promise.all([b.depth(), b.models(), b.dibr(), b.gen(), b.explore()]);
  return { depth, models, dibr, gen, explore };
}

// ── the document's shared private manager ──────────────────────────────────────────────────
let shared = null; // { refs, promise }

async function acquireWall(given) {
  if (given) return { wall: given.supported === false ? null : given, release() {} };
  if (!shared) {
    shared = {
      refs: 0,
      promise: createInline3D({ lazy: true }).catch((error) => ({ supported: false, error })),
    };
  }
  const mine = shared;
  mine.refs++;
  const w = await mine.promise;
  let released = false;
  return {
    wall: w && w.supported ? w : null,
    release() {
      if (released) return;
      released = true;
      if (--mine.refs > 0) return;
      if (shared === mine) shared = null;
      if (w && w.supported) w.close();
    },
  };
}

/** 'auto' → a tier from what the device admits to. Providers get a concrete tier, never 'auto'. */
export function resolveQuality(q, nav = typeof navigator !== 'undefined' ? navigator : {}) {
  if (q === 'low' || q === 'medium' || q === 'high') return q;
  const mem = nav.deviceMemory || 4;
  const cores = nav.hardwareConcurrency || 4;
  const mobile = /Android|iPhone|iPad|Mobile/i.test(nav.userAgent || '');
  if (mobile) return mem >= 8 ? 'medium' : 'low';
  if (mem >= 8 && cores >= 8) return 'high';
  if (mem >= 4 && cores >= 4) return 'medium';
  return 'low';
}

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
/** The one view the 2D fallback renders: centred, no eye offset. */
const MONO_VIEW = Object.freeze({
  eye: 'none',
  projectionMatrix: IDENTITY,
  transform: { position: { x: 0, y: 0, z: 0, w: 1 }, orientation: { x: 0, y: 0, z: 0, w: 1 }, matrix: IDENTITY },
});

/**
 * Lift `element` into 3D in place.
 *
 * @param {HTMLVideoElement|HTMLImageElement|HTMLCanvasElement|Element} element  media, or any element
 *        at/near media (resolved the same way resolveMediaAt resolves a click).
 * @param {object} [opts]
 * @param {'auto'|'live'|'explore'} [opts.mode='auto']
 * @param {number} [opts.depth=1]  depth strength multiplier.
 * @param {'auto'|number} [opts.convergence='auto']  zero-disparity depth; passed to live-DIBR as given.
 * @param {'auto'|'low'|'medium'|'high'} [opts.quality='auto']
 * @param {object} [opts.wall]  an existing createInline3D() manager to join.
 * @param {{maxAngleDeg?:number, relax?:boolean}} [opts.orbit]
 * @param {'auto'|object} [opts.models='auto']  a ModelSource, or 'auto' for the default one.
 * @param {{video?:string, still?:string, inpaint?:string}} [opts.providers]
 * @param {'builtin'|'none'} [opts.ui='builtin']
 * @param {AbortSignal} [opts.signal]  aborting it removes the lift.
 * @param {'real'|'stub'} [opts.backend='real']  'stub' = js/lift/stubs/* (no models; dev/demo).
 * @returns {Promise<LiftHandle>}
 */
export async function lift(element, opts = {}) {
  let el = element;
  if (!el || el.nodeType !== 1) throw new TypeError('lift: expected an element');
  if (!/^(VIDEO|IMG|CANVAS)$/.test(el.tagName)) {
    el = findMediaInParentsAndSiblings(el);
    if (!el) throw new TypeError('lift: no <video>, <img> or <canvas> at that element');
  }
  const kind = el.tagName === 'VIDEO' ? 'video' : 'still';
  const o = {
    mode: opts.mode || 'auto',
    depth: Number.isFinite(opts.depth) ? opts.depth : 1,
    convergence: opts.convergence ?? 'auto',
    quality: resolveQuality(opts.quality || 'auto'),
    orbit: { maxAngleDeg: 15, relax: true, ...(opts.orbit || {}) },
    // What the caller asked for: the video provider keeps 'auto' (A2's warm-up picks 364×210 vs
    // 518×294 by measured frame time), everything else gets the concrete tier.
    qualityAsked: opts.quality || 'auto',
    models: opts.models || 'auto',
    ort: opts.ort || null,
    providers: { video: 'vda-small', still: 'moge3', inpaint: 'light-inpaint-v1', ...(opts.providers || {}) },
    ui: opts.ui === 'none' ? 'none' : 'builtin',
    backend: opts.backend || 'real',
  };

  // ── listeners ─────────────────────────────────────────────────────────────────────────
  const listeners = new Map();
  const emit = (type, detail) => {
    const set = listeners.get(type);
    if (!set) return;
    for (const cb of [...set]) {
      try {
        cb(detail);
      } catch (e) {
        console.error('[inline3d/lift] listener threw', e);
      }
    }
  };

  // ── placement + session ───────────────────────────────────────────────────────────────
  const { wall, release } = await acquireWall(opts.wall);
  const cols = wall ? 2 : 1; // SBS backing store while a session is live
  const placement = mountCanvas(el);
  const canvas = placement.canvas;
  let chip = null;

  // ── runtime state ─────────────────────────────────────────────────────────────────────
  let impl = null;
  let modelSource = null;
  let ort = null;
  let registry = null;
  let dibr = null;
  let videoProv = null;
  let stillProv = null;
  let stillLoading = null;
  let explore = null;
  let pendingExplore = null;
  let fadeInUntil = 0;
  let fadeOutUntil = 0;
  let abort = null; // current freeze/lift
  let loadAbort = new AbortController();
  let frozen = null; // { bitmap, depth }
  let liveGen = 0; // bumps on provider reset: stale live depth is dropped
  let inferBusy = false;
  let lastT = -1;
  let suspended = false;
  let disposed = false;
  let sceneHandle = null;
  let fallbackRaf = 0;
  let lastDpr = 0;
  let crop = null; // { canvas, ctx } when object-fit crops the media
  let dibrSource = null;
  let liveErrorWarned = false;

  const params = { depth: o.depth, convergence: o.convergence, dilate: 0 };
  // Providers report progress in their own shapes: a number, {loaded,total} (model download) or
  // {stage,progress} (lift-gen). Normalise to 0..1.
  const frac = (v) => {
    const x =
      typeof v === 'number' ? v : v && v.total > 0 ? v.loaded / v.total : v && Number.isFinite(v.progress) ? v.progress : 0;
    return Math.max(0, Math.min(1, x || 0));
  };
  /** Timings (ms) the page can show: see LiftHandle.stats. */
  const stats = {
    fps: 0,
    modelLoadMs: 0,
    liveDepthMs: 0,
    stillDepthMs: 0,
    generateMs: 0,
    exploreLoadMs: 0,
    pauseToExploreMs: 0,
    splats: 0,
  };
  let fpsFrames = 0;
  let fpsT0 = 0;
  let freezeT0 = 0;
  const progress = (phase, v, base = 0, span = 1) => {
    const value = frac(v);
    emit('progress', { phase, value });
    if (chip) chip.setProgress(base + span * value);
  };

  const machine = createLiftMachine({
    kind,
    mode: o.mode,
    isPaused: () => kind === 'still' || el.paused || el.ended,
    onState: (from, to, why) => {
      if (chip) chip.setState(to);
      emit('statechange', { state: to, from, reason: why });
    },
    onEffect: (name, payload) => runEffect(name, payload || {}),
  });

  // ── sizing ────────────────────────────────────────────────────────────────────────────
  // Explore draws ~1 M Gaussians per view: at dpr 2 that is 4× the fill of dpr 1 and misses 60 fps
  // on an M1 Pro (docs/lift-explore.md §Performance), so the backing store drops to dpr 1 while the
  // lifted scene is up, unless quality is 'high'. Live DIBR (a ~1 ms full-screen pass) keeps full dpr.
  function effectiveDpr() {
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    if (o.quality === 'high' || !explore) return dpr;
    return Math.min(dpr, 1);
  }
  function syncBacking(force) {
    const changed = placement.update();
    const dpr = effectiveDpr();
    if (!changed && !force && dpr === lastDpr) return;
    if (!changed && !force && machine.state === STATES.EXPLORE && fadeInUntil > performance.now()) return; // not mid-fade
    lastDpr = dpr;
    const f = placement.fit;
    let ew = Math.max(1, Math.round(f.dw * dpr));
    let eh = Math.max(1, Math.round(f.dh * dpr));
    if (ew > MAX_EYE_PX) {
      eh = Math.round((eh * MAX_EYE_PX) / ew);
      ew = MAX_EYE_PX;
    }
    if (canvas.width !== ew * cols) canvas.width = ew * cols;
    if (canvas.height !== eh) canvas.height = eh;
    // Crop when object-fit shows only part of the media (cover / none).
    const { w, h } = mediaSize(el);
    const partial = w > 0 && h > 0 && (f.sw < w - 0.5 || f.sh < h - 0.5 || f.sx > 0.5 || f.sy > 0.5);
    if (partial) {
      if (!crop) {
        const c = document.createElement('canvas');
        crop = { canvas: c, ctx: c.getContext('2d') };
      }
      crop.canvas.width = Math.max(1, Math.min(Math.round(f.sw), 1920));
      crop.canvas.height = Math.max(1, Math.round((crop.canvas.width * f.sh) / Math.max(1, f.sw)));
    } else crop = null;
  }

  /** What the providers and the DIBR read: the element, or a crop of its visible part. */
  function currentSource() {
    if (!crop) return el;
    const f = placement.fit;
    try {
      crop.ctx.drawImage(el, f.sx, f.sy, f.sw, f.sh, 0, 0, crop.canvas.width, crop.canvas.height);
    } catch {
      /* no frame yet */
    }
    return crop.canvas;
  }

  // ── the frame ─────────────────────────────────────────────────────────────────────────
  function frame(views, layer, session) {
    if (disposed) return;
    if (!el.isConnected) {
      machine.send('disconnected');
      return;
    }
    syncBacking(false);
    const st = machine.state;
    if (!dibr || st === STATES.IDLE || st === STATES.LOADING || st === STATES.SUSPENDED || st === STATES.ERROR) return;
    const src = currentSource();
    if (src !== dibrSource) {
      dibr.setSource(src);
      dibrSource = src;
    }
    if (kind === 'video' && st === STATES.LIVE && !suspended) maybeInfer(src);
    const ctx = { views, layer, session };
    const now = performance.now();
    if (!fpsT0) fpsT0 = now;
    if (++fpsFrames >= 30) {
      stats.fps = +((fpsFrames * 1000) / (now - fpsT0)).toFixed(1);
      fpsFrames = 0;
      fpsT0 = now;
    }
    const fadingOut = explore && fadeOutUntil > 0;
    const showExplore = explore && (st === STATES.EXPLORE || fadingOut);
    if (!showExplore || now < fadeInUntil || fadingOut) dibr.render(ctx);
    // The 2D fallback has no tracked eyes: explore's own flat path (one eye at the rest head, the
    // whole canvas) is `views: null` — handing it the single MONO_VIEW would read as the load-time
    // mono blip and replay nothing.
    if (showExplore) explore.render(session ? ctx : { views: null, layer, session });
    if (fadingOut && now >= fadeOutUntil) {
      disposeExplore();
    }
  }

  function maybeInfer(src) {
    if (inferBusy || !videoProv || el.readyState < 2) return;
    if (el.currentTime === lastT) return;
    lastT = el.currentTime;
    inferBusy = true;
    const g = liveGen;
    const t0 = performance.now();
    Promise.resolve()
      .then(() => videoProv.estimate({ source: src, t: el.currentTime }))
      .then((d) => {
        stats.liveDepthMs = +(performance.now() - t0).toFixed(1);
        if (!disposed && g === liveGen && d) dibr.setDepth(d);
      })
      .catch((error) => {
        if (!liveErrorWarned) {
          liveErrorWarned = true;
          emit('error', { error, fatal: false, phase: 'live' });
        }
      })
      .finally(() => {
        inferBusy = false;
      });
  }

  function startFallbackLoop() {
    if (fallbackRaf || disposed) return;
    const layer = { getViewport: () => ({ x: 0, y: 0, width: canvas.width, height: canvas.height }) };
    const views = [MONO_VIEW];
    const tick = () => {
      fallbackRaf = 0;
      if (disposed) return;
      frame(views, layer, null);
      fallbackRaf = requestAnimationFrame(tick);
    };
    fallbackRaf = requestAnimationFrame(tick);
  }

  // ── providers ─────────────────────────────────────────────────────────────────────────
  function makeProvider(which, name) {
    const quality = which === 'video' && o.qualityAsked === 'auto' ? 'auto' : o.quality;
    const popts = { kind: which, modelSource, ort, quality, model: name };
    // registry.getDepthProvider(name, opts) returns an INSTANCE: `name` is a registered provider
    // ('ort', 'native', …) or a model family / manifest name handed to the best provider as `model`.
    if (registry && typeof registry.getDepthProvider === 'function') {
      const p = registry.getDepthProvider(name, popts);
      if (p) return p;
    }
    return impl.depth.createDepthProvider(popts);
  }

  /** The inpainter, loaded lazily on the first lift; any failure → none (push-pull colour). */
  let inpainterP = null;
  function ensureInpainter(signal) {
    const name = o.providers.inpaint;
    if (!name || name === 'none' || !registry || typeof registry.getInpainter !== 'function') return Promise.resolve(undefined);
    if (!inpainterP) {
      inpainterP = (async () => {
        const ip = registry.getInpainter(name === 'iw3-light' ? 'light-inpaint-v1' : name, { modelSource, ort, quality: o.quality });
        if (ip && typeof ip.load === 'function') await ip.load({ signal });
        return ip || undefined;
      })().catch((error) => {
        emit('error', { error, fatal: false, phase: 'inpaint' });
        return undefined;
      });
    }
    return inpainterP;
  }

  function ensureStill(signal, base = 0, span = 1) {
    if (stillProv) return Promise.resolve(stillProv);
    if (!stillLoading) {
      const p = makeProvider('still', o.providers.still);
      stillLoading = Promise.resolve(p.load({ signal, onProgress: (v) => progress('models', v, base, span) })).then(
        () => (stillProv = p),
        (e) => {
          stillLoading = null;
          try {
            p.dispose();
          } catch {
            /* ignore */
          }
          throw e;
        }
      );
    }
    return stillLoading;
  }

  function mediaReady() {
    if (el.tagName === 'IMG') {
      if (el.complete && el.naturalWidth > 0) return Promise.resolve();
      return el.decode ? el.decode().catch(() => {}) : Promise.resolve();
    }
    if (el.tagName === 'VIDEO' && el.readyState < 2) {
      return new Promise((resolve) => el.addEventListener('loadeddata', () => resolve(), { once: true }));
    }
    return Promise.resolve();
  }

  async function doLoad() {
    const signal = loadAbort.signal;
    try {
      impl = await loadBackend(o.backend);
      const M = impl.models;
      const tLoad = performance.now();
      modelSource =
        o.models === 'auto'
          ? M.createModelSource({})
          : typeof o.models === 'string'
            ? M.createModelSource({ baseUrl: o.models })
            : o.models;
      try {
        if (o.ort && typeof o.ort.InferenceSession === 'function') ort = o.ort; // a module
        else if (typeof M.loadOrt === 'function') {
          const ortOpts = typeof o.ort === 'string' ? { baseUrl: o.ort } : o.ort || {};
          ort = await M.loadOrt(ortOpts);
        } else ort = null;
      } catch (e) {
        ort = null; // a provider that needs it will fail its own load() with a better message
      }
      registry = typeof M.getRegistry === 'function' ? M.getRegistry() : null;
      if (disposed) return;
      dibr = impl.dibr.createLiveDibr({ canvas });
      dibr.setParams(params);
      if (kind === 'video') {
        videoProv = makeProvider('video', o.providers.video);
        await videoProv.load({ signal, onProgress: (v) => progress('models', v) });
      } else {
        await ensureStill(signal);
      }
      await mediaReady();
      if (disposed) return;
      stats.modelLoadMs = Math.round(performance.now() - tLoad);
      syncBacking(true);
      machine.send('loaded');
    } catch (error) {
      if (!disposed) machine.send('fail', { error });
    }
  }

  const isStale = (gen) => disposed || gen !== machine.gen;

  async function doFreeze(gen) {
    abort = new AbortController();
    const signal = abort.signal;
    freezeT0 = performance.now();
    try {
      await mediaReady();
      if (isStale(gen)) return;
      const t = kind === 'video' ? el.currentTime : 0;
      const bitmap = await createImageBitmap(currentSource());
      if (isStale(gen)) return bitmap.close && bitmap.close();
      await ensureStill(signal, 0, 0.25);
      if (isStale(gen)) return bitmap.close && bitmap.close();
      progress('depth', 0, 0.25, 0.1);
      const tDepth = performance.now();
      let depth = await stillProv.estimate({ source: bitmap, t });
      stats.stillDepthMs = Math.round(performance.now() - tDepth);
      if (isStale(gen)) return bitmap.close && bitmap.close();
      progress('depth', 1, 0.25, 0.1);
      // Depth comes back at MODEL resolution (e.g. 770×434) and MoGe's focalPx is in that grid;
      // lift-gen wants focalPx in pixels of the RGB it is given (it rescales to its own raster).
      const fp = depth && depth.intrinsics && depth.intrinsics.focalPx;
      if (fp > 0 && depth.w > 0 && bitmap.width > 0 && depth.w !== bitmap.width) {
        depth = { ...depth, intrinsics: { ...depth.intrinsics, focalPx: (fp * bitmap.width) / depth.w, focalGridW: bitmap.width } };
      }
      if (frozen && frozen.bitmap && frozen.bitmap.close) frozen.bitmap.close();
      frozen = { bitmap, depth };
      // The frozen frame's better (still-model) depth also improves the live view shown meanwhile.
      if (dibr) dibr.setDepth(depth);
      machine.send('frozen', { gen });
    } catch (error) {
      if (!isStale(gen)) machine.send('lift-failed', { gen, error });
    }
  }

  async function doLift(gen) {
    const signal = abort ? abort.signal : undefined;
    try {
      const inpainter = await ensureInpainter(signal);
      if (isStale(gen)) return;
      const tGen = performance.now();
      const res = await impl.gen.generateLift({
        rgb: frozen.bitmap,
        depth: frozen.depth,
        inpainter,
        quality: o.quality,
        signal,
        onProgress: (v) => progress('lift', v, 0.35, 0.65),
      });
      stats.generateMs = Math.round(performance.now() - tGen);
      stats.splats = (res.meta && res.meta.splatCount) || 0;
      if (isStale(gen)) return;
      const tEx = performance.now();
      // Same canvas, same WebGL2 context: explore wraps live-DIBR's `gl` (never getContext itself).
      // lift-gen writes the OpenCV camera frame (meta.convention); explore defaults to OpenGL.
      const meta = res.meta || {};
      const ex = await impl.explore.createExplore({
        canvas,
        gl: dibr && dibr.gl,
        ply: res.ply,
        meta,
        axes: meta.axes || meta.convention || undefined,
        orbit: o.orbit,
      });
      stats.exploreLoadMs = Math.round(performance.now() - tEx);
      stats.pauseToExploreMs = Math.round(performance.now() - freezeT0);
      if (isStale(gen)) return ex.dispose();
      pendingExplore = ex;
      machine.send('lifted', { gen });
    } catch (error) {
      if (!isStale(gen)) machine.send('lift-failed', { gen, error });
    }
  }

  function disposeExplore() {
    fadeOutUntil = 0;
    if (explore) {
      try {
        explore.dispose();
      } catch {
        /* ignore */
      }
    }
    explore = null;
    if (!disposed) syncBacking(true); // live gets its full dpr back
  }

  // ── pointer → explore ─────────────────────────────────────────────────────────────────
  const onDown = (ev) => {
    if (!explore || machine.state !== STATES.EXPLORE) return;
    try {
      canvas.setPointerCapture(ev.pointerId);
    } catch {
      /* ignore */
    }
    canvas.style.cursor = 'grabbing';
    explore.onPointerDown(ev);
  };
  const onMove = (ev) => explore && machine.state === STATES.EXPLORE && explore.onPointerMove(ev);
  const onUp = (ev) => {
    canvas.style.cursor = machine.state === STATES.EXPLORE ? 'grab' : '';
    if (explore) explore.onPointerUp(ev);
  };
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);

  // ── effects (the machine's side of the contract) ──────────────────────────────────────
  function runEffect(name, p) {
    switch (name) {
      case 'load':
        doLoad();
        break;
      case 'startLive':
        canvas.style.visibility = '';
        break;
      case 'freeze':
        doFreeze(p.gen);
        break;
      case 'lift':
        doLift(p.gen);
        break;
      case 'enterExplore':
        if (explore) disposeExplore();
        explore = pendingExplore;
        pendingExplore = null;
        explore.fadeIn(FADE_MS);
        fadeInUntil = performance.now() + FADE_MS;
        placement.setInteractive(true);
        syncBacking(true); // explore may cap the backing store at dpr 1
        break;
      case 'exitExplore':
        placement.setInteractive(false);
        if (explore && p.crossfade && typeof explore.fadeOut === 'function') {
          explore.fadeOut(FADE_MS);
          fadeOutUntil = performance.now() + FADE_MS;
        } else disposeExplore();
        break;
      case 'cancelLift':
        if (abort) abort.abort();
        abort = null;
        if (pendingExplore) {
          pendingExplore.dispose();
          pendingExplore = null;
        }
        break;
      case 'resetProvider':
        liveGen++;
        lastT = -1;
        if (videoProv) videoProv.reset();
        break;
      case 'suspend':
        suspended = true;
        break;
      case 'resume':
        suspended = false;
        break;
      case 'pauseMedia':
        if (kind === 'video') el.pause();
        break;
      case 'playMedia':
        if (kind === 'video') {
          const r = el.play();
          if (r && r.catch) r.catch(() => {});
        }
        break;
      case 'liftError':
        emit('error', { error: p.error, fatal: false, phase: 'lift' });
        break;
      case 'fail':
        // Leave the page's own element showing; keep the chip so the user can dismiss it.
        canvas.style.visibility = 'hidden';
        placement.setInteractive(false);
        emit('error', { error: p.error, fatal: true });
        break;
      case 'dispose':
        teardown();
        break;
    }
  }

  // ── element + page events ─────────────────────────────────────────────────────────────
  const media = {
    pause: () => machine.send('pause'),
    play: () => machine.send('play'),
    seeked: () => machine.send('seeked'),
    ended: () => machine.send('ended'),
    emptied: () => machine.send('emptied'),
    loadstart: () => machine.send('emptied'),
  };
  if (kind === 'video') for (const [k, f] of Object.entries(media)) el.addEventListener(k, f);
  const onVis = () => machine.send(document.visibilityState === 'hidden' ? 'hidden' : 'visible');
  document.addEventListener('visibilitychange', onVis);
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => syncBacking(false)) : null;
  if (ro) ro.observe(el);
  const onWinResize = () => syncBacking(false);
  window.addEventListener('resize', onWinResize);
  // Removal is caught per frame too, but a lazy window scrolled off screen gets no frames.
  const mo =
    typeof MutationObserver === 'function'
      ? new MutationObserver(() => {
          if (!el.isConnected) machine.send('disconnected');
        })
      : null;
  if (mo) mo.observe(document.documentElement || document.body, { childList: true, subtree: true });
  const onAbort = () => machine.send('remove');
  if (opts.signal) {
    if (opts.signal.aborted) queueMicrotask(onAbort);
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }

  function teardown() {
    if (disposed) return;
    disposed = true;
    loadAbort.abort();
    if (abort) abort.abort();
    if (kind === 'video') for (const [k, f] of Object.entries(media)) el.removeEventListener(k, f);
    document.removeEventListener('visibilitychange', onVis);
    window.removeEventListener('resize', onWinResize);
    if (ro) ro.disconnect();
    if (mo) mo.disconnect();
    if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
    if (fallbackRaf) cancelAnimationFrame(fallbackRaf);
    fallbackRaf = 0;
    if (sceneHandle) sceneHandle.remove();
    sceneHandle = null;
    for (const x of [pendingExplore, explore, dibr, videoProv, stillProv]) {
      if (!x) continue;
      try {
        x.dispose();
      } catch {
        /* ignore */
      }
    }
    pendingExplore = explore = dibr = videoProv = stillProv = null;
    if (frozen && frozen.bitmap && frozen.bitmap.close) frozen.bitmap.close();
    frozen = null;
    if (chip) chip.dispose();
    placement.unmount();
    release();
  }

  // ── wire up ───────────────────────────────────────────────────────────────────────────
  if (o.ui === 'builtin') {
    chip = createChip(placement.shadow, {
      kind,
      onExplore: () => handle.explore(),
      onResume: () => handle.resume(),
      onExit: () => handle.remove(),
    });
  }
  syncBacking(true);
  if (wall) {
    sceneHandle = wall.addScene(canvas, (views, layer) => frame(views, layer, wall.session), {
      // The layer went away for good (session ended): keep the page working in 2D.
      onLayerLost: () => startFallbackLoop(),
    });
    if (chip && sceneHandle.exclude) sceneHandle.exclude(chip.el);
  } else startFallbackLoop();

  /** @type {LiftHandle} */
  const handle = {
    get state() {
      return machine.state;
    },
    element: el,
    canvas,
    /** The layout mode placement chose: standard | picture | aspectRatio | overlay. */
    layout: placement.layout,
    /** True when rendering through the inline-3D session, false in the 2D fallback. */
    woven: !!wall,
    /** Live timings: fps (frames drawn), modelLoadMs, liveDepthMs (last video estimate),
     *  stillDepthMs, generateMs (lift-gen), exploreLoadMs (PLY parse + upload), pauseToExploreMs,
     *  splats. Read-only snapshot. */
    get stats() {
      return { ...stats, state: machine.state };
    },
    on(type, cb) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(cb);
      return () => handle.off(type, cb);
    },
    off(type, cb) {
      const s = listeners.get(type);
      if (s) s.delete(cb);
    },
    /** Freeze the current frame and lift it (videos pause). No-op outside `live`. */
    explore() {
      machine.send('explore-request');
    },
    /** Back to live: plays a paused video (its `play` event crossfades explore → live). */
    resume() {
      machine.send('resume-request');
    },
    setDepth(x) {
      if (!Number.isFinite(x)) return;
      params.depth = x;
      if (dibr) dibr.setParams(params);
    },
    setConvergence(x) {
      params.convergence = x === 'auto' || Number.isFinite(x) ? x : 'auto';
      if (dibr) dibr.setParams(params);
    },
    remove() {
      machine.send('remove');
    },
  };

  machine.send('start');
  return handle;
}

/**
 * @typedef {object} LiftHandle
 * @property {string} state
 * @property {Element} element
 * @property {HTMLCanvasElement} canvas
 * @property {string} layout
 * @property {boolean} woven
 * @property {object} stats
 * @property {(type:'statechange'|'progress'|'error', cb:(detail:any)=>void) => () => void} on
 * @property {(type:string, cb:Function) => void} off
 * @property {() => void} explore
 * @property {() => void} resume
 * @property {(x:number) => void} setDepth
 * @property {(x:'auto'|number) => void} setConvergence
 * @property {() => void} remove
 */

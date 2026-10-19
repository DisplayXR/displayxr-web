// lift/lift.js — "Convert to 3D": lift any <video>, <img> or <canvas> on a page into 3D, in place.
//
//   const h = await lift(videoEl);            // 3D while it plays (the browser converts), explorable when paused
//   h.on('statechange', ({ state }) => …);
//   h.setDepth(1.3); h.explore(); h.resume(); h.remove();
//
// The conversion is the RUNTIME's (ADR-053 conversion providers): the DisplayXR Browser hands the
// page's video / picture to whatever the runtime's conversion stack offers. This SDK owns none:
// no model, no ONNX Runtime, no in-page depth or view synthesis. Two presentations, one element:
//   LIVE     — the browser converts and weaves the element IN PLACE (`dxr-lift="auto"`); the SDK
//              mounts no canvas, loads no model, runs no JS per frame.
//   EXPLORE  — the paused/ended frame (or a still) is lifted ONCE into a 3D Gaussian scene by the
//              runtime (`displayxr-lift://lift/gaussians`) — or by a LiftProvider the caller passes
//              (the remote SHARP demo) — and shown with a bounded orbit. state.js decides which
//              one is showing; this file wires it to the DOM, the provider and the inline-3D session.
// Where there is no converter (`liftCapabilities().native` false and no LiftProvider given) lift()
// rejects with a NativeLiftError (code 'unavailable'): the page keeps its own 2D element.
//
// ── The session ──────────────────────────────────────────────────────────────────────────────
// One inline-3D session per document (inline3d.js warns on a second one: the element-rect channel
// is a whole-widget setter). So: pass `wall` to join the page's existing manager; otherwise every
// lift() in the document shares ONE private manager, closed when its last lift is removed. The
// explore canvas is an ordinary addScene() window. On a browser without inline-3D the same render
// path runs off requestAnimationFrame with a single mono view and a full-canvas viewport — the 2D
// fallback — so the page still gets the converted picture.

import { createInline3D } from '../inline3d.js';
import { createLiftMachine, STATES, resolveLiftMode } from './state.js';
import { mountCanvas, resolveMediaAt, findMediaInParentsAndSiblings, mediaSize } from './placement.js';
import { createChip, shieldInput } from './ui.js';
import { liftCapabilities, ensureNativeProviders, createNativeLiveAttrs, defaultLiftProviderFor, normalizePriority, NativeLiftError } from './native.js';
import { getRegistry } from './providers/registry.js';

export { resolveMediaAt, STATES };

const FADE_MS = 350;
/** Native mode: the builtin chip hides after this long without pointer activity (`ui.autoHideMs`). */
const UI_AUTOHIDE_MS = 2500;
const MAX_EYE_PX = 2048; // cap on one view's backing width

/** Explore's default depth budget: the scene's fore-to-back disparity at the nominal eye pair, as a
 *  fraction of the image width. 0.018 = what the native module's live SBS gives at strength 1
 *  (tamarra 2000 px: 36 px fg-bg, panel A/B 2026-09-26), so a lift explored from a paused/still
 *  element reads as deep as the live 3D it came from. Explore used to spread a relative lift over
 *  0.7-3.0 m at f = 1.2 W, ~8 % of the width: 4-5x the live depth (David, panel: "the SOG has more
 *  depth than the already-lifted pictures"). */
export const EXPLORE_DEPTH_BUDGET = 0.018;
const NOMINAL_IPD_M = 0.063;

/**
 * The gain that scales an explore scene's depth (about its pivot, explore setDepthGain) so its
 * natural fore-to-back disparity at the nominal eye pair is at most `budget` x width. Only ever
 * reduces (a flatter-than-budget lift is left alone); 1 when the budget is off or the meta lacks
 * the intrinsics / depth range.
 * @param {{intrinsics?:{fx:number,width:number}, depthRange?:{near:number,far:number}}} meta
 * @param {number} budget  fraction of the width; 0 = off
 */
export function exploreBudgetGain(meta, budget) {
  if (!(budget > 0)) return 1;
  const it = meta && meta.intrinsics, dr = meta && meta.depthRange;
  if (!it || !dr || !(it.fx > 0) || !(it.width > 0) || !(dr.near > 0) || !(dr.far > dr.near)) return 1;
  const spread = (it.fx / it.width) * NOMINAL_IPD_M * (1 / dr.near - 1 / dr.far);
  return spread > budget ? budget / spread : 1;
}

/// A literal import() so bundlers can see and split it: the explore renderer (the PlayCanvas
// engine, the SDK's optional peer) loads on the first explore.
const loadExplore = () => import('./explore.js');

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

/**
 * 'auto' → a tier from what the device admits to. Providers get a concrete tier, never 'auto'.
 * 'auto' never picks 'high': on an M1 Pro, high = MoGe-3 1022×574 (2.8 s vs 1.3 s), a 1536-wide
 * lift (~1.2 M splats for 720p vs ~0.8 M) and a full-dpr explore store that misses 60 fps at dpr 2.
 * Ask for 'high' explicitly.
 */
export function resolveQuality(q, nav = typeof navigator !== 'undefined' ? navigator : {}) {
  if (q === 'low' || q === 'medium' || q === 'high') return q;
  const mem = nav.deviceMemory || 4;
  const cores = nav.hardwareConcurrency || 4;
  const mobile = /Android|iPhone|iPad|Mobile/i.test(nav.userAgent || '');
  if (mobile) return mem >= 8 ? 'medium' : 'low';
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
 * Rejects with a {@link NativeLiftError} (`code: 'unavailable'`) when nothing can convert it: the
 * runtime has no converter for this element (`liftCapabilities().native` false) and no
 * `providers.lift` was given. There is no in-page fallback.
 *
 * @param {HTMLVideoElement|HTMLImageElement|HTMLCanvasElement|Element} element  media, or any element
 *        at/near media (resolved the same way resolveMediaAt resolves a click).
 * @param {object} [opts]
 * @param {'auto'|'live'|'explore'} [opts.mode]  default 'live' for a video (pause never auto-lifts;
 *        explore() is explicit) and 'explore' for a picture. A stated mode is honoured (resolveLiftMode).
 * @param {number} [opts.depth=1]  depth strength multiplier (`dxr-lift-strength`; explore's depth gain).
 * @param {'auto'|number} [opts.convergence='auto']  zero-disparity depth (`dxr-lift-convergence`).
 * @param {'auto'|'low'|'medium'|'high'} [opts.quality='auto']  handed to the lift provider.
 * @param {object} [opts.wall]  an existing createInline3D() manager to join.
 * @param {{maxAngleDeg?:number, relax?:boolean}} [opts.orbit]
 * @param {{lift?:string|object}} [opts.providers]
 *        `lift`: the stage that turns the frozen frame into a Gaussian scene — omitted = the
 *        runtime's `native-gaussians` (when its caps list `gaussians`); a registered lift provider
 *        name (e.g. 'remote-sharp', DEMO ONLY); or a LiftProvider instance.
 * @param {object} [opts.remote]  options for a named lift provider's factory (remote-sharp:
 *        `{ endpoint, auth, timeoutMs, mode, getAuthHeaders, fields }`).
 * @param {'builtin'|'none'} [opts.ui='builtin']
 * @param {AbortSignal} [opts.signal]  aborting it removes the lift.
 * @param {'auto'|boolean|object} [opts.native='auto']  the browser's conversion stack
 *        (docs/lift.md § Vendor modules). 'auto': use it when liftCapabilities() says `native` and
 *        the element is a <video>/<img> — the browser then converts + weaves the element IN PLACE
 *        (`dxr-lift="auto"`). false: never. A caps object (from liftCapabilities()) skips the query.
 * @param {boolean} [opts.ownLiftAttr=false]  native: the caller owns the element's `dxr-lift*`
 *        attributes — remove()/exit REMOVES them instead of restoring their pre-lift values (the
 *        browser's built-in: its menu pre-sets `dxr-lift="auto"`).
 * @param {'high'|'normal'|'low'|'paused'} [opts.priority='normal']  native live: `dxr-lift-priority`.
 * @param {{pivotTargetM?:number, comfort?:'auto'|'always'|'off', eyes?:'nominal'|'tracked'}} [opts.explore]
 *        the explore view (docs/lift-explore.md § Comfort): a METRIC lift whose pivot is more than
 *        2× off `pivotTargetM` (default 2.0 m; dead-band ±100 %, so photos with a pivot in ~1–4 m
 *        are left untouched and only far scenes — e.g. a paused CG video frame — are rescaled)
 *        (`comfort:'auto'`, default; 'off' for A/B); `eyes:'tracked'` takes the runtime's eye
 *        positions as metres instead of normalising their separation to 63 mm (default 'nominal').
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
    depth: Number.isFinite(opts.depth) ? opts.depth : 1,
    convergence: opts.convergence ?? 'auto',
    quality: resolveQuality(opts.quality || 'auto'),
    orbit: { maxAngleDeg: 15, relax: true, ...(opts.orbit || {}) },
    exploreMaxDpr: Number.isFinite(opts.exploreMaxDpr) ? opts.exploreMaxDpr : null,
    providers: { ...(opts.providers || {}) },
    // `remoteSharp` is an alias (the gallery relay's docs use it)
    remote: [opts.remote, opts.remoteSharp].find((x) => x && typeof x === 'object') || {},
    ui: opts.ui === 'none' ? 'none' : 'builtin',
    // `ui: { autoHideMs }` — the builtin chip with options. null = the mode's default (see below).
    uiAutoHideMs: opts.ui && typeof opts.ui === 'object' && Number.isFinite(opts.ui.autoHideMs) ? Math.max(0, opts.ui.autoHideMs) : null,
    native: opts.native === undefined ? 'auto' : opts.native,
    priority: normalizePriority(opts.priority) || 'normal',
    explore: {
      pivotTargetM: Number.isFinite(opts.explore?.pivotTargetM) && opts.explore.pivotTargetM > 0 ? opts.explore.pivotTargetM : 2.0,
      comfort: ['auto', 'always', 'off'].includes(opts.explore?.comfort) ? opts.explore.comfort : 'auto',
      eyes: opts.explore?.eyes === 'tracked' ? 'tracked' : 'nominal',
      depthBudget: opts.explore?.depthBudget === 0 || opts.explore?.depthBudget === 'off'
        ? 0
        : Number.isFinite(opts.explore?.depthBudget) && opts.explore.depthBudget > 0 ? opts.explore.depthBudget : EXPLORE_DEPTH_BUDGET,
    },
  };

  // ── the runtime's conversion stack (docs/lift.md § Vendor modules) ─────────────────────────────
  let caps = null;
  if (o.native !== false && (el.tagName === 'VIDEO' || el.tagName === 'IMG')) {
    if (o.native && typeof o.native === 'object') caps = o.native;
    else if (o.native === true) caps = { native: true, state: 'ready', modes: [] };
    else caps = await liftCapabilities({ signal: opts.signal }).catch(() => null);
  }
  const native = !!(caps && caps.native);
  // Register the module's `native-gaussians` lift provider in the shared registry now, before any
  // provider is resolved.
  if (native) ensureNativeProviders(caps);
  if (native && !o.providers.lift) {
    const lp = defaultLiftProviderFor(caps, o.providers);
    if (lp) o.providers.lift = lp; // native-gaussians (a registered LiftProvider)
  }
  // Nothing can convert this element: no runtime converter and no provider the caller brought.
  // (A page that wants a still lifted without a runtime module passes `providers.lift`, e.g. the
  // remote SHARP demo; that is explore-only, there is no in-page live conversion.)
  if (!native && !o.providers.lift) {
    throw new NativeLiftError('lift: no converter is available for this element (the runtime offers none)', 'unavailable');
  }
  // Defaults (resolveLiftMode): a VIDEO is 'live' (pause never auto-lifts; explore is explicit); a
  // PICTURE goes straight to explore — no live conversion of a still.
  const machineMode = resolveLiftMode({ native: true, kind, mode: opts.mode });
  // Only a still the caller explicitly keeps 'live' behaves like a paused video (the browser
  // converts it in place; explore/resume toggle). Otherwise a still is a still.
  const machineKind = native && kind === 'still' && machineMode === 'live' ? 'video' : kind;
  const nativeStillExplore = kind === 'still' && machineMode === 'explore';
  // ownLiftAttr: the caller (the browser's built-in) owns the element's dxr-lift* state, so exit
  // REMOVES them rather than restoring a value its own menu pre-set (see createNativeLiveAttrs).
  const nativeLive = native
    ? createNativeLiveAttrs(el, { depth: o.depth, convergence: o.convergence, priority: o.priority, ownLiftAttr: !!opts.ownLiftAttr })
    : null;
  // A picture never gets a native live stream. The browser's menu pre-sets dxr-lift="auto" before
  // lift() runs; when we own the attributes, take it away NOW so the browser stops (or never
  // starts) converting the still — the explore view is all it gets. (A page-set value is left.)
  if (nativeLive && nativeStillExplore && opts.ownLiftAttr) nativeLive.drop();
  let nativeDetachPending = false;

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
  // Measured (M1 Pro, headless, GPU idle): the MONO 2D-fallback explore holds 60 fps at dpr 2
  // (1600×900, 0.8-1.2 M splats, orbit spinning), so only the woven SBS store — 2 views, where
  // A5 measured 26-53 fps at dpr 2 — is capped at dpr 1, and not at quality 'high'.
  if (o.exploreMaxDpr === null) o.exploreMaxDpr = wall && o.quality !== 'high' ? 1 : Infinity;
  const placement = mountCanvas(el);
  const canvas = placement.canvas;
  // The browser converts + weaves the element itself while live: keep it visible, the canvas
  // hidden (and out of the inline-3D session) until explore needs it.
  placement.setSourceHidden(false);
  canvas.style.visibility = 'hidden';
  let chip = null;

  // ── runtime state ─────────────────────────────────────────────────────────────────────
  let exploreGain = 1; // exploreBudgetGain of the current explore scene (1 = as generated)
  // The lift provider (native-gaussians, a registered one, or the caller's). `ownLiftProv`: we
  // created it, so we dispose it.
  let liftProv = null;
  let ownLiftProv = false;
  let explore = null;
  let pendingExplore = null;
  // The provider's output behind the explore scene — { ply|sog, meta } — kept for exportSog(). The
  // pending one becomes current on enterExplore; the current one survives a resume (it is still
  // the last lifted scene) until the next lift replaces it or the handle is removed.
  let pendingLifted = null;
  let lifted = null;
  let fadeInUntil = 0;
  let fadeOutUntil = 0;
  let abort = null; // current freeze/lift
  let sogAbort = null; // a downloadSog() export in flight
  const cancelSogExport = () => {
    if (sogAbort) sogAbort.abort();
    sogAbort = null;
  };
  let loadAbort = new AbortController();
  let frozen = null; // { bitmap, t }
  let suspended = false;
  let disposed = false;
  let sceneHandle = null;
  let fallbackRaf = 0;
  let lastDpr = 0;
  let crop = null; // { canvas, ctx } when object-fit crops the media

  const params = { depth: o.depth, convergence: o.convergence };
  // Providers report progress in their own shapes: a number, {loaded,total} or
  // {stage,progress}. Normalise to 0..1.
  const frac = (v) => {
    const x =
      typeof v === 'number' ? v : v && v.total > 0 ? v.loaded / v.total : v && Number.isFinite(v.progress) ? v.progress : 0;
    return Math.max(0, Math.min(1, x || 0));
  };
  /** Timings (ms) the page can show: see LiftHandle.stats. */
  const stats = {
    fps: 0,
    loadMs: 0,
    generateMs: 0,
    exploreLoadMs: 0,
    pauseToExploreMs: 0,
    splats: 0,
    // explore's comfort normalisation: the uniform scale applied about the camera (1 = none)
    exploreScale: 1,
    // 'native': the runtime's conversion stack (converts live, supplies the Gaussians on pause);
    // 'provider': only a caller-supplied lift provider (explore, no live conversion).
    // `provider`: the module's name from caps (native only).
    mode: native ? 'native' : 'provider',
    provider: (native && caps.provider) || null,
    // which stage produced the explore scene: the provider id ('native-gaussians', 'remote-sharp', ...)
    liftSource: null,
    // a lift provider's round trip (ms) and its own timings
    remoteMs: 0,
    remoteTimings: null,
  };
  let fpsFrames = 0;
  let fpsT0 = 0;
  let freezeT0 = 0;
  const progress = (phase, v, base = 0, span = 1, extra) => {
    const value = frac(v);
    emit('progress', extra ? { phase, value, ...extra } : { phase, value });
    if (chip) chip.setProgress(base + span * value);
  };

  const machine = createLiftMachine({
    kind: machineKind,
    mode: machineMode,
    isPaused: () => kind === 'still' || el.paused || el.ended,
    onState: (from, to, why) => {
      if (chip) chip.setState(to);
      emit('statechange', { state: to, from, reason: why });
    },
    onEffect: (name, payload) => runEffect(name, payload || {}),
  });

  // ── sizing ────────────────────────────────────────────────────────────────────────────
  // Explore draws ~1 M Gaussians per view; o.exploreMaxDpr (see above) caps the backing store while
  // the lifted scene is up; live (the browser's own weave of the element) is unaffected.
  function effectiveDpr() {
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    return explore ? Math.min(dpr, o.exploreMaxDpr) : dpr;
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

  /** What a freeze reads: the element, or a crop of its visible part. */
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
    if (st === STATES.IDLE || st === STATES.LOADING || st === STATES.SUSPENDED || st === STATES.ERROR) return;
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
    // The 2D fallback has no tracked eyes: explore's own flat path (one eye at the rest head, the
    // whole canvas) is `views: null` — handing it the single MONO_VIEW would read as the load-time
    // mono blip and replay nothing.
    if (showExplore) explore.render(session ? ctx : { views: null, layer, session });
    if (fadingOut && now >= fadeOutUntil) {
      disposeExplore();
    }
    if (captureWaiters.length) flushCapture();
  }

  // ── capture: the canvas as drawn, read back in the SAME task as the draw ──────────────────
  // The context has preserveDrawingBuffer:false (the woven canvas's zero-copy path wants it off),
  // so a screenshot taken between frames — CDP Page.captureScreenshot on the win box — can see
  // an empty canvas. handle.capture() resolves with the next frame's pixels instead.
  const captureWaiters = [];
  function flushCapture() {
    const waiters = captureWaiters.splice(0);
    try {
      // Explore's engine created the canvas's context, and getContext hands back that same one.
      const gl = explore ? canvas.getContext('webgl2') : null;
      if (!gl) throw new Error('no GL context yet');
      const w = canvas.width, h = canvas.height;
      const px = new Uint8Array(w * h * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const c2 = document.createElement('canvas');
      c2.width = w;
      c2.height = h;
      const ctx = c2.getContext('2d');
      const img = ctx.createImageData(w, h);
      for (let y = 0; y < h; y++) img.data.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
      ctx.putImageData(img, 0, 0);
      c2.toBlob((b) => waiters.forEach((x) => (b ? x.resolve(b) : x.reject(new Error('toBlob failed')))), 'image/png');
    } catch (error) {
      waiters.forEach((x) => x.reject(error));
    }
  }

  /** Put the canvas into the inline-3D session (or the 2D-fallback loop). Native mode does this only
   *  while explore is up: in native live the element itself is the woven tile. */
  function attachRenderer() {
    if (sceneHandle || fallbackRaf || disposed) return;
    if (wall) {
      sceneHandle = wall.addScene(canvas, (views, layer) => frame(views, layer, wall.session), {
        // The layer went away for good (session ended): keep the page working in 2D.
        onLayerLost: () => startFallbackLoop(),
      });
      if (chip && sceneHandle.exclude) sceneHandle.exclude(chip.el);
    } else startFallbackLoop();
  }
  function detachRenderer() {
    if (fallbackRaf) cancelAnimationFrame(fallbackRaf);
    fallbackRaf = 0;
    if (sceneHandle) sceneHandle.remove();
    sceneHandle = null;
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
  /** The lift provider for `providers.lift`: a registered name or a LiftProvider instance. */
  async function resolveLiftProvider() {
    const want = o.providers.lift;
    if (!want) return null;
    if (typeof want === 'object' && typeof want.generateLift === 'function') return want;
    if (typeof want !== 'string') throw new TypeError('lift: providers.lift must be a name or a LiftProvider');
    // The demo provider registers itself when its module loads (js/lift/index.js imports it too).
    if (want === 'remote-sharp') await import('./providers/lift-remote-sharp.js');
    const p = getRegistry().getLiftProvider(want, o.remote);
    if (!p) throw new Error(`lift: no lift provider registered as ${JSON.stringify(want)}`);
    ownLiftProv = true;
    return p;
  }

  /** Remote/provider progress → the chip ("Lifting with SHARP… 7s") and 'progress' events. */
  function providerProgress(p) {
    const stage = p && p.stage;
    const elapsedS = p && Number.isFinite(p.elapsedS) ? p.elapsedS : undefined;
    progress('lift', p, 0.05, 0.95, { stage, elapsedS, provider: liftProv && liftProv.id });
    if (chip && chip.setNote) {
      const who = liftProv && liftProv.id === 'remote-sharp' ? 'SHARP' : (liftProv && liftProv.id) || 'provider';
      const secs = elapsedS !== undefined ? ` ${Math.round(elapsedS)}s` : '';
      const cached = p && p.cacheHit === true ? ' (cached)' : '';
      chip.setNote(stage === 'downloading' ? `Downloading ${who} scene${cached}…${secs}` : `Lifting with ${who}…${secs}`);
    }
  }

  function mediaReady() {
    if (el.tagName === 'IMG') {
      if (el.complete && el.naturalWidth > 0) return Promise.resolve();
      return el.decode ? el.decode().catch(() => {}) : Promise.resolve();
    }
    if (el.tagName === 'VIDEO' && el.readyState < 2) {
      if (el.error) return Promise.reject(mediaError(el));
      return new Promise((resolve, reject) => {
        el.addEventListener('loadeddata', () => resolve(), { once: true });
        // A codec the browser lacks (e.g. H.264 in a build without proprietary codecs) never
        // reaches loadeddata; fail instead of sitting in `loading` forever.
        el.addEventListener('error', () => reject(mediaError(el)), { once: true });
      });
    }
    return Promise.resolve();
  }

  async function doLoad() {
    const signal = loadAbort.signal;
    try {
      const tLoad = performance.now();
      if (disposed) return;
      // The lift provider is resolved (and loaded) now so a bad name fails the lift up front. The
      // runtime's `native-gaussians` was registered above; there is nothing else to load: no model,
      // no ONNX Runtime, no view synthesis. The `dxr-lift` attributes go on at `startLive`.
      try {
        liftProv = await resolveLiftProvider();
        if (liftProv && typeof liftProv.load === 'function') await liftProv.load({ signal });
      } catch (error) {
        liftProv = null;
        emit('error', { error, fatal: false, phase: 'lift-provider' });
      }
      await mediaReady();
      if (disposed) return;
      stats.loadMs = Math.round(performance.now() - tLoad);
      syncBacking(true);
      machine.send('loaded');
    } catch (error) {
      if (!disposed) machine.send('fail', { error });
    }
  }

  const isStale = (gen) => disposed || gen !== machine.gen;
  // A result of abandoned explore work (play/resume/seek/hide bumped the generation meanwhile):
  // dropped silently — no error event, no state change — with a debug line for diagnostics.
  const dropped = (gen, what) => {
    if (!isStale(gen)) return false;
    if (!disposed) console.debug(`[inline3d/lift] dropped a late ${what} from abandoned gen ${gen} (now ${machine.gen})`);
    return true;
  };

  async function doFreeze(gen) {
    abort = new AbortController();
    freezeT0 = performance.now();
    try {
      // Explore needs a stage that makes Gaussians: the runtime's `native-gaussians` (the module's
      // caps list `gaussians`) or a provider the caller passed. Without one there is nothing to show.
      if (!liftProv) {
        throw new NativeLiftError(
          'explore needs a converter that produces Gaussians (the runtime offers none for this element)',
          'unsupported',
        );
      }
      loadExplore().catch(() => {}); // warm the engine while the frame is grabbed and lifted
      await mediaReady();
      if (isStale(gen)) return;
      const t = kind === 'video' ? el.currentTime : 0;
      const bitmap = await createImageBitmap(currentSource());
      if (dropped(gen, 'frame')) return bitmap.close && bitmap.close();
      if (frozen && frozen.bitmap && frozen.bitmap.close) frozen.bitmap.close();
      frozen = { bitmap, t };
      machine.send('frozen', { gen });
    } catch (error) {
      if (!dropped(gen, 'freeze error')) machine.send('lift-failed', { gen, error });
    }
  }

  async function doLift(gen) {
    const signal = abort ? abort.signal : undefined;
    try {
      const tGen = performance.now();
      const res = await liftProv.generateLift({
        rgb: frozen.bitmap,
        quality: o.quality,
        // the orbit the explore view allows (a provider may size its hidden layer for it)
        params: { maxOrbitDeg: o.orbit.maxAngleDeg },
        signal,
        onProgress: providerProgress,
      });
      if (!res || !(res.sog || res.ply)) throw new Error('lift provider returned neither sog nor ply');
      const source = liftProv.id || 'provider';
      stats.liftSource = source;
      stats.remoteMs = Math.round(performance.now() - tGen);
      stats.remoteTimings = res.meta && res.meta.timings ? { ...res.meta.timings, cacheHit: res.meta.cacheHit ?? null, serverMs: res.meta.serverMs ?? null } : null;
      if (chip && chip.setNote) chip.setNote(null);
      stats.generateMs = stats.remoteMs;
      stats.splats = (res.meta && res.meta.splatCount) || 0;
      // Diagnostics: the intrinsics the provider used (output-raster px, OpenCV convention), the
      // pivot depth and the horizontal FOV they imply.
      if (res.meta && res.meta.intrinsics) {
        const it = res.meta.intrinsics;
        stats.intrinsics = { ...it };
        stats.pivotZ = res.meta.pivotZ;
        if (it.fx && it.w) stats.fovXDeg = +(2 * Math.atan(it.w / (2 * it.fx)) * 180 / Math.PI).toFixed(2);
      }
      stats.genTimings = (res.meta && res.meta.timings) || null;
      if (dropped(gen, 'lift result')) return;
      const tEx = performance.now();
      // Explore creates its own WebGL2 context on the canvas (the engine). A PLY from the runtime
      // is the OpenCV camera frame (meta.convention / axes); explore defaults to OpenGL.
      const meta = res.meta || {};
      exploreGain = exploreBudgetGain(meta, o.explore.depthBudget);
      stats.exploreDepthGain = +exploreGain.toFixed(4);
      const exploreMod = await loadExplore();
      const ex = await exploreMod.createExplore({
        canvas,
        // a PLY from the runtime, or a .sog whose camera block is the rig (meta too)
        ...(res.sog ? { sog: res.sog } : { ply: res.ply }),
        meta,
        axes: meta.axes || meta.convention || undefined,
        clearAlpha: 1, // opaque: never let the page's flat media ghost through the lifted scene
        orbit: o.orbit,
        // the page's depth strength carries into explore (setDepth), times the budget gain that
        // brings the scene's natural spread down to the live path's (exploreBudgetGain)
        depthGain: params.depth * exploreGain,
        space: meta.space,
        comfort: { mode: o.explore.comfort, target: o.explore.pivotTargetM },
        eyes: o.explore.eyes,
      });
      stats.exploreScale = +(ex.sceneScale || 1).toFixed(4);
      stats.exploreLoadMs = Math.round(performance.now() - tEx);
      stats.pauseToExploreMs = Math.round(performance.now() - freezeT0);
      if (dropped(gen, 'explore scene')) return ex.dispose();
      pendingExplore = ex;
      pendingLifted = { ply: res.ply || null, sog: res.sog || null, meta: ex.meta || meta, sceneScale: ex.sceneScale || 1, source };
      machine.send('lifted', { gen });
    } catch (error) {
      if (!dropped(gen, 'lift error')) machine.send('lift-failed', { gen, error });
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
    if (nativeDetachPending) {
      // Native: explore is gone and the browser converts the element again — leave the session.
      nativeDetachPending = false;
      detachRenderer();
      canvas.style.visibility = 'hidden';
    }
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
  canvas.addEventListener('lostpointercapture', onUp); // capture lost before the up: relax now
  // Explore input stays OURS: the drag's pointerup and the click after it must never reach the
  // page's player (YouTube toggles play on click → an orbit drag unpaused the video). The canvas
  // only takes pointer input while interactive (explore), so this is always-on.
  const offShield = shieldInput(canvas);

  // ── effects (the machine's side of the contract) ──────────────────────────────────────
  function runEffect(name, p) {
    switch (name) {
      case 'load':
        doLoad();
        break;
      case 'startLive':
        if (nativeLive) nativeLive.apply(); // dxr-lift="auto": the browser converts + weaves in place
        break;
      case 'freeze':
        doFreeze(p.gen);
        break;
      case 'lift':
        doLift(p.gen);
        break;
      case 'enterExplore':
        // Explore owns the pixels now: the browser stops converting, the canvas joins the session.
        nativeDetachPending = false;
        if (nativeLive) nativeLive.setOff(true);
        placement.setSourceHidden(true);
        canvas.style.visibility = '';
        attachRenderer();
        if (chip && chip.setNote) chip.setNote(null);
        if (explore) disposeExplore();
        explore = pendingExplore;
        pendingExplore = null;
        if (pendingLifted) lifted = pendingLifted;
        pendingLifted = null;
        explore.fadeIn(FADE_MS);
        fadeInUntil = performance.now() + FADE_MS;
        placement.setInteractive(true);
        syncBacking(true); // explore may cap the backing store at dpr 1
        break;
      case 'exitExplore':
        cancelSogExport(); // a .sog export in flight must not hold up (or jank) the return to live
        placement.setInteractive(false);
        // The element comes back converted by the browser at once; the canvas fades out over it
        // and leaves the session when explore is disposed.
        nativeDetachPending = true;
        placement.setSourceHidden(false);
        if (nativeLive) nativeLive.setOff(false);
        if (explore && p.crossfade && typeof explore.fadeOut === 'function') {
          explore.fadeOut(FADE_MS);
          fadeOutUntil = performance.now() + FADE_MS;
        } else disposeExplore();
        break;
      case 'cancelLift':
        // Abandon, never await: the generation bump already made every late result stale (dropped());
        // the abort just stops the fetches / waits early.
        if (abort) abort.abort();
        abort = null;
        if (pendingExplore) {
          pendingExplore.dispose();
          pendingExplore = null;
        }
        pendingLifted = null;
        break;
      case 'resetProvider':
        break; // nothing temporal to reset: the runtime keeps the stream state
      case 'suspend':
        suspended = true;
        if (nativeLive) nativeLive.hold('paused');
        break;
      case 'resume':
        suspended = false;
        if (nativeLive) nativeLive.hold(null);
        break;
      case 'pauseMedia':
        if (kind === 'video') el.pause();
        break;
      case 'liftError':
        emit('error', { error: p.error, fatal: false, phase: 'lift' });
        break;
      case 'fail':
        // Leave the page's own element showing; keep the chip so the user can dismiss it.
        canvas.style.visibility = 'hidden';
        placement.setInteractive(false);
        placement.setSourceHidden?.(false);
        if (nativeLive) nativeLive.clear();
        emit('error', { error: p.error, fatal: true });
        break;
      case 'dispose':
        teardown();
        break;
    }
  }

  // ── element + page events ─────────────────────────────────────────────────────────────
  const media = {
    error: () => machine.send('fail', { error: mediaError(el) }),
    pause: () => machine.send('pause'),
    play: () => machine.send('play'),
    playing: () => machine.send('play'),
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
    offShield();
    loadAbort.abort();
    if (abort) abort.abort();
    cancelSogExport();
    if (kind === 'video') for (const [k, f] of Object.entries(media)) el.removeEventListener(k, f);
    document.removeEventListener('visibilitychange', onVis);
    window.removeEventListener('resize', onWinResize);
    if (ro) ro.disconnect();
    if (mo) mo.disconnect();
    if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
    detachRenderer();
    if (nativeLive) nativeLive.clear();
    for (const x of [pendingExplore, explore, ownLiftProv ? liftProv : null]) {
      if (!x) continue;
      try {
        x.dispose();
      } catch {
        /* ignore */
      }
    }
    pendingExplore = explore = liftProv = null;
    lifted = pendingLifted = null;
    if (frozen && frozen.bitmap && frozen.bitmap.close) frozen.bitmap.close();
    frozen = null;
    if (chip) chip.dispose();
    placement.unmount();
    release();
  }

  // ── wire up ───────────────────────────────────────────────────────────────────────────
  if (o.ui === 'builtin') {
    // Native mode: the browser crops the element's whole on-screen rect and weaves its conversion
    // back into it, so the chip (inside that rect) gets converted + woven like the video. It
    // auto-hides by default there until the browser splits planes for lift rects; the web path
    // (the SDK renders + weaves its own canvas, chip excluded) keeps it always visible.
    const autoHideMs = o.uiAutoHideMs ?? (native ? UI_AUTOHIDE_MS : 0);
    chip = createChip(
      placement.shadow,
      {
        kind: machineKind,
        onExplore: () => handle.explore(),
        onResume: () => handle.resume(),
        onExit: () => handle.remove(),
        onDownload: () => handle.downloadSog(),
      },
      { autoHideMs, activityRect: () => (el.isConnected ? el.getBoundingClientRect() : null) },
    );
  }
  syncBacking(true);

  // Native, not READY yet (runtime conversion-providers §7.4): the browser shows the element's own
  // 2D frame until its converter is up, and the chip says so with a spinner. This is a wait, never a
  // switch to the in-page converter; the browser pushes state changes (setLiftState) and lifts the
  // element by itself once its module is READY.
  let liftState = native ? (caps && caps.liftState) || (caps && caps.state === 'activating' ? 'waiting' : 'ready') : null;
  if (chip && chip.setWaiting) chip.setWaiting(liftState === 'waiting');

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
    /** True when the browser's vendor module converts this element (docs/lift.md § Vendor modules). */
    native,
    /** The capabilities native mode was decided on (null when not queried). */
    caps,
    /** Native only: the browser's coarse `waiting | ready | unavailable`; null on the web path. */
    get liftState() {
      return liftState;
    },
    /**
     * Native only: the browser's coarse lift state changed (`waiting | ready | unavailable`). While
     * `waiting` the chip shows a spinner over the element's own 2D frame. No-op on the web path.
     */
    setLiftState(s) {
      if (!native || !['waiting', 'ready', 'unavailable'].includes(s) || s === liftState) return;
      liftState = s;
      if (chip && chip.setWaiting) chip.setWaiting(s === 'waiting');
      emit('liftstatechange', { liftState: s });
    },
    /** Timings: fps (explore frames drawn), loadMs, generateMs (the lift provider's round trip),
     *  exploreLoadMs (PLY parse + upload), pauseToExploreMs, splats. Read-only snapshot. */
    /** Diagnostics only (not API): the live explore + provider. */
    _internals: () => ({ explore, liftProv, frozen, lifted, chip }),
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
    /** Leave explore (or an in-flight lift) NOW for the live view of the PAUSED frame — native:
     *  `dxr-lift="auto"` again. In-flight work is abandoned. Never plays the video (see play()). */
    resume() {
      machine.send('resume-request');
    },
    /** Start playback of a <video> (an explicit play). Its `play` event returns to live — from
     *  explore too, instantly. No-op for images. */
    play() {
      if (kind !== 'video') return Promise.resolve(false);
      const r = el.play();
      return r && r.then ? r.then(() => true, () => false) : Promise.resolve(true);
    },
    /** Explore: turn the lifted scene to (yaw, pitch) degrees, clamped to orbit.maxAngleDeg; with
     *  `relax` a drag release springs back to this pose. No-op outside explore. */
    setOrbit(yaw, pitch = 0) {
      if (explore && typeof explore.setTarget === 'function') explore.setTarget(+yaw || 0, +pitch || 0);
    },
    /** Depth strength: `dxr-lift-strength` for the live conversion, and in explore the lifted scene's depth about its
     *  pivot plane (explore setDepthGain: the pivot stays on the glass, only disparity scales). */
    setDepth(x) {
      if (!Number.isFinite(x)) return;
      params.depth = x;
      if (nativeLive) nativeLive.setStrength(x);
      if (explore && typeof explore.setDepthGain === 'function') explore.setDepthGain(x * exploreGain);
    },
    setConvergence(x) {
      params.convergence = x === 'auto' || Number.isFinite(x) ? x : 'auto';
      if (nativeLive) nativeLive.setConvergence(params.convergence);
    },
    /** Native live: how eagerly the browser converts this element (`dxr-lift-priority`). Returns
     *  false for an unknown value; a no-op (true) on the web path, which has one stream anyway. */
    setPriority(p) {
      if (!normalizePriority(p)) return false;
      o.priority = p;
      return nativeLive ? nativeLive.setPriority(p) : true;
    },
    get priority() {
      return o.priority;
    },
    /**
     * The lifted scene as a `.sog` (SOG v2, lossless webp planes) with the DisplayXR camera block
     * v2 — the gallery / addSplat / the gauss demo open it on the photo's own camera rig at the
     * lift's convergence (docs/lift.md § Download SOG). Rejects when nothing has been lifted yet.
     * `opts.camera` is merged onto the camera block (e.g. `{ focus: { point, source: 'manual' } }`).
     */
    async exportSog(opts = {}) {
      if (!lifted) throw new Error('[inline3d/lift] exportSog: nothing lifted yet (explore first)');
      // A provider's .sog (remote SHARP) is returned as the ORIGINAL bytes: it already carries the
      // worker's camera block. `opts.camera` overrides are not applied to it.
      if (lifted.sog) {
        if (opts.camera) console.warn('[inline3d/lift] exportSog: camera overrides are ignored for a remote lift (original bytes)');
        return new Blob([lifted.sog], { type: 'application/octet-stream' });
      }
      const { exportSog } = await import('./sog-export.js');
      // The file stays METRIC (the lift as generated). When explore applied its comfort scale k,
      // the block says so the way a camera rig expresses it — eye separation and head motion in
      // world units per real metre, ipd_factor = parallax_factor = 1/k — so a viewer that honours
      // the block opens it with the stereo the explore view had.
      const k = lifted.sceneScale || 1;
      const camera = k !== 1 ? { dxr: { ipd_factor: 1 / k, parallax_factor: 1 / k }, ...(opts.camera || {}) } : opts.camera;
      return exportSog({ ply: lifted.ply, meta: lifted.meta, camera, onProgress: opts.onProgress, signal: opts.signal });
    },
    /** exportSog() + save it as a file (`<element name>-3d.sog` unless `filename` is given). */
    async downloadSog(filename) {
      if (!lifted || sogBusy) return false;
      sogBusy = true;
      if (chip) chip.setBusy('download', true);
      // Leaving explore (play / resume) aborts it: the encode yields between planes and stops there.
      const ctl = (sogAbort = new AbortController());
      try {
        const blob = await handle.exportSog({ signal: ctl.signal });
        if (ctl.signal.aborted) return false;
        saveBlob(blob, filename || sogFileName(el));
        return true;
      } catch (error) {
        if (!ctl.signal.aborted) emit('error', { error, fatal: false, phase: 'export' });
        return false;
      } finally {
        if (sogAbort === ctl) sogAbort = null;
        sogBusy = false;
        if (chip) chip.setBusy('download', false);
      }
    },
    /** True once a scene has been lifted (exportSog() / downloadSog() have something to save). */
    get canExport() {
      return !!lifted;
    },
    remove() {
      machine.send('remove');
    },
  };
  let sogBusy = false;
  handle.capture = () =>
    new Promise((resolve, reject) => {
      if (disposed) return reject(new Error('[inline3d/lift] capture: removed'));
      const w = { resolve, reject };
      captureWaiters.push(w);
      setTimeout(() => {
        const i = captureWaiters.indexOf(w);
        if (i >= 0) {
          captureWaiters.splice(i, 1);
          reject(new Error('[inline3d/lift] capture: no frame drawn within 2 s'));
        }
      }, 2000);
    });

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
 * @property {boolean} native  the browser's vendor module converts this element (docs/lift.md § Vendor modules)
 * @property {object|null} caps
 * @property {(p:'high'|'normal'|'low'|'paused') => boolean} setPriority
 * @property {object} stats
 * @property {(type:'statechange'|'progress'|'error', cb:(detail:any)=>void) => () => void} on
 * @property {(type:string, cb:Function) => void} off
 * @property {() => void} explore
 * @property {() => void} resume
 * @property {(yaw:number, pitch?:number) => void} setOrbit
 * @property {(x:number) => void} setDepth
 * @property {(x:'auto'|number) => void} setConvergence
 * @property {(opts?:{camera?:object, onProgress?:(p:number)=>void}) => Promise<Blob>} exportSog
 * @property {(filename?:string) => Promise<boolean>} downloadSog
 * @property {boolean} canExport
 * @property {() => Promise<Blob>} capture  the next drawn frame of the canvas (both eyes, as a PNG)
 * @property {() => void} remove
 */

/** Turn a media element's MediaError into a readable Error (codec-less builds are the common case). */
function mediaError(el) {
  const codes = { 1: 'MEDIA_ERR_ABORTED', 2: 'MEDIA_ERR_NETWORK', 3: 'MEDIA_ERR_DECODE', 4: 'MEDIA_ERR_SRC_NOT_SUPPORTED' };
  const c = el.error?.code;
  const hint = c === 4 ? ' — the browser cannot play this source (unsupported codec/container; the DisplayXR Browser has no H.264/HEVC, use VP9/AV1)' : '';
  const e = new Error(`media: ${codes[c] || 'error'}${el.error?.message ? ` (${el.error.message})` : ''}${hint}`);
  e.name = 'MediaError'; e.code = c; return e;
}

/** `<media file name or id>-3d.sog`, filesystem-safe. */
function sogFileName(el) {
  let base = '';
  try {
    const src = el.currentSrc || el.src || '';
    if (src && !src.startsWith('blob:') && !src.startsWith('data:')) base = new URL(src, location.href).pathname.split('/').pop() || '';
  } catch {
    /* not a URL */
  }
  base = base.replace(/\.[a-z0-9]{2,5}$/i, '') || el.id || 'lift';
  return base.replace(/[^\w.-]+/g, '_').slice(0, 80) + '-3d.sog';
}

/** Save a Blob as a file through a detached <a download> (no DOM insertion, no popup). */
function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

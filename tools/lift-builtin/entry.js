// entry.js — the DisplayXR Browser's built-in "Convert to 3D".
//
// Built by tools/lift-builtin/build.mjs into ONE classic script (IIFE) the browser injects into its
// lift isolated world (displayxr-browser-pvt patches 0220/0221) once per document, right after
// `globalThis.__dxrLiftNative = true;`. Then, per context-menu pick:
//
//     __dxrLift.convertAt(x, y, 'image'|'video'|'canvas')   // x,y: visual-viewport CSS px
//
// It exposes exactly `globalThis.__dxrLift = { convertAt, cancelAll, setLiftState, status, version }`
// (frozen).
// Everything else — the SDK, the PlayCanvas engine slice — lives in this IIFE's closure. (The real isolation is
// Chromium's: isolated worlds share the DOM, never the JS heap, so page script cannot reach even
// `__dxrLift`.)
//
// Runtime files come from the browser's pak, never the network:
//   displayxr-lift://runtime/ort.jspi.min.mjs                 import()ed (module)
//   displayxr-lift://runtime/ort-wasm-simd-threaded.jspi.mjs  import()ed by the above
//   displayxr-lift://runtime/ort-wasm-simd-threaded.jspi.wasm fetched by the above
// and models from the browser's store, by manifest NAME, fetch()ed on this (main) thread — the
// store answers only fetch()/XHR from the lift world's main thread (isolated_world_origin), never a
// worker, import() or a URL handed to ORT:
//   displayxr-lift://models/<name>
//
// Vendor module (docs/lift.md § Vendor modules): the browser's menu decides native vs web and passes
// it as convertAt's 4th argument `{native, liftState}` (browser patch 0331); an older browser passes
// nothing and convertAt asks `liftCapabilities()` itself (GET displayxr-lift://caps — asked afresh on
// every pick, NEVER cached: a cached non-READY answer latched the in-page converter for the whole
// session after a cold boot). When the runtime converts, a <video>/<img> is converted by the BROWSER
// in place — lift() only sets `dxr-lift="auto"` and mounts the chip (Explore / Exit / ↓ SOG); no
// model and no ORT load until a pause, and then only if the module's own depth/gaussians endpoints
// fail. Up to caps.maxStreams native conversions may run side by side; a web (SDK-pipeline) lift is
// still exclusive (ORT sessions must not overlap).
//
// Readiness (runtime conversion-providers §7.4/§8.1): the browser's coarse state is
// `waiting | ready | unavailable`. `waiting` is a reason to WAIT — the element keeps its own 2D frame
// and the chip shows a spinner; the browser lifts it by itself once its converter is READY. Only
// `unavailable` takes the in-page path. The browser pushes every change with
// `__dxrLift.setLiftState(s)`; when it goes `unavailable` (an old runtime whose module never came
// up), a native lift that never reached READY is redone on the in-page path.
//
// Test hook: `globalThis.__dxrLiftConfig = { schemeMap: { 'displayxr-lift://runtime/': 'http://…/runtime/',
// 'displayxr-lift://models/': 'http://…/models/' }, workers: 'worker'|'main-thread' }` set BEFORE the
// bundle runs rewrites those prefixes (tools/lift-builtin/test/). The browser never sets it.

import { lift } from '../../js/lift/lift.js';
import { liftCapabilities } from '../../js/lift/native.js';
import { resolveMediaAt } from '../../js/lift/placement.js';
import { createModelSource, parseManifest } from '../../js/lift/providers/models.js';
import { loadOrt, ORT_VERSION } from '../../js/lift/providers/ort.js';
import MANIFEST from '../../js/lift/models.json';
import { probeWorkers, workerState, forceWorkerMode } from './workers.js';
import { decideLift, LIFT_STATES } from './decide.js';

/* global __DXR_LIFT_VERSION__ */
const VERSION = typeof __DXR_LIFT_VERSION__ === 'string' ? __DXR_LIFT_VERSION__ : 'dev';
const RUNTIME = 'displayxr-lift://runtime/';
const MODELS = 'displayxr-lift://models/';

(function install() {
  const G = globalThis;
  if (G.__dxrLift && G.__dxrLift.version) return; // injected twice into one document: keep the first

  const cfg = G.__dxrLiftConfig || {};
  const map = cfg.schemeMap || null;
  const rewrite = (u) => {
    if (!map || typeof u !== 'string') return u;
    for (const k of Object.keys(map)) if (u.startsWith(k)) return map[k] + u.slice(k.length);
    return u;
  };
  const runtimeBase = rewrite(RUNTIME);
  if (cfg.workers) forceWorkerMode(cfg.workers);

  // Model source: the SDK's own manifest (compiled in — it is byte-identical to the browser's
  // installer/models.json by contract), models fetched by NAME from the native store. `native:true`
  // is explicit rather than inferred from __dxrLiftNative so the built-in never silently falls
  // back to a 700 MB network download when the store refuses: a store failure surfaces as an
  // error in the chip. (createModelSource's native path does fall through to url() on a refusal;
  // with no baseUrl that is the public blob store — acceptable as the last resort it documents.)
  const nativeFetch = map
    ? (input, init) => G.fetch(typeof input === 'string' ? rewrite(input) : input, init)
    : undefined;
  let models = null;
  const getModels = () =>
    models ||
    (models = createModelSource({
      native: true,
      manifest: MANIFEST,
      ...(nativeFetch ? { fetch: nativeFetch } : {}),
    }));

  // ORT: the JSPI build from the pak. Single-threaded ALWAYS (a threaded ORT would spawn a worker
  // from displayxr-lift:// — cross-origin to the page — and a worker's fetch never reaches the
  // store), and never the proxy worker.
  let ortP = null;
  const getOrt = () =>
    ortP ||
    (ortP = loadOrt({ baseUrl: runtimeBase, bundle: 'jspi' }).then((ort) => {
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;
      return ort;
    }).catch((e) => { ortP = null; throw e; }));

  /** element → handle. One WEB lift per document at a time; native ones up to caps.maxStreams. */
  const lifts = new Map();
  let lastCaps = null;
  let chain = Promise.resolve();

  function toClient(x, y) {
    // The browser hands visual-viewport CSS px; elementsFromPoint wants layout-viewport client px.
    const vv = G.visualViewport;
    if (!vv || !vv.scale) return [x, y];
    return [vv.offsetLeft + x / vv.scale, vv.offsetTop + y / vv.scale];
  }

  const TAGS = { image: 'IMG', video: 'VIDEO', canvas: 'CANVAS' };

  function pick(x, y, mediaType) {
    const want = TAGS[mediaType];
    const el = resolveMediaAt(x, y, document);
    if (!want || (el && el.tagName === want)) return el;
    // The menu said what it hit; prefer an element of that kind at the point over a neighbour.
    for (const e of document.elementsFromPoint(x, y)) if (e.tagName === want) return e;
    return el;
  }

  function removeHandle(el) {
    const h = lifts.get(el);
    lifts.delete(el);
    if (h) try { h.remove(); } catch { /* already gone */ }
  }

  /** The browser's last pushed coarse state (null until the first push). */
  let pushedState = null;
  /** element → true once its native lift has seen READY (it never falls back after that). */
  const sawReady = new WeakMap();

  /**
   * What to do for this pick: the browser's own decision when it gave one (0331's 4th argument),
   * else a FRESH caps query. Never a cached answer.
   */
  async function decide(hint) {
    const caps = await liftCapabilities({ webFallback: false, ...(nativeFetch ? { fetch: nativeFetch } : {}) }).catch(() => ({ native: false, liftState: 'unavailable' }));
    return decideLift(caps, hint);
  }

  async function convert(x, y, mediaType, hint) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, reason: 'bad-point' };
    if (mediaType && !TAGS[mediaType]) return { ok: false, reason: 'bad-media-type' };
    const [cx, cy] = toClient(x, y);
    const el = pick(cx, cy, mediaType);
    if (!el) return { ok: false, reason: 'no-media-at-point' };
    // Toggle: converting a lifted element again turns it back.
    if (lifts.has(el)) {
      removeHandle(el);
      return { ok: true, action: 'removed' };
    }
    if (el.tagName === 'VIDEO' && el.mediaKeys) return { ok: false, reason: 'encrypted-media' };
    if (el.tagName === 'IMG' && !(el.complete && el.naturalWidth > 0)) return { ok: false, reason: 'image-not-loaded' };
    return liftElement(el, await decide(hint));
  }

  async function liftElement(el, caps) {
    lastCaps = caps;
    // The runtime's converter supersedes the SDK pipeline for <video>/<img> — while it warms too.
    const native = !!caps.native && (el.tagName === 'VIDEO' || el.tagName === 'IMG');

    // ONE web lift per document: ORT sessions must never be created concurrently (a second session
    // created while one runs kills the wasm instance — docs/lift.md), and the page has one inline-3D
    // session anyway. Converting another element replaces the current lift. Native conversions run
    // no ORT while live, so up to caps.maxStreams of them coexist (oldest evicted first); a web lift
    // still replaces everything, and a native one replaces any web lift.
    const maxNative = Math.max(1, Number.isFinite(caps.maxStreams) && caps.maxStreams > 0 ? caps.maxStreams : 1);
    for (const [other, oh] of [...lifts.entries()]) if (!native || !oh.native) removeHandle(other);
    if (native) {
      const keep = [...lifts.keys()];
      while (keep.length >= maxNative) removeHandle(keep.shift());
    }

    await probeWorkers(); // decides the gsplat sorter's + lift-gen's worker path before anything is created
    let ort;
    if (native) ort = getOrt; // lazy: loaded only if a native provider falls back on pause
    else {
      try {
        ort = await getOrt();
      } catch (e) {
        return { ok: false, reason: 'ort-load-failed: ' + ((e && e.message) || e) };
      }
    }
    let h;
    try {
      // ownLiftAttr: the built-in owns the element's lift state by definition — the browser's menu
      // (lift_trigger.cc) sets dxr-lift="auto" BEFORE this runs, and restoring that on Exit /
      // toggle-off left the element converting with no handle (a second Convert double-converted).
      h = await lift(el, { models: getModels(), ort, ui: 'builtin', native: native ? caps : false, ...(native ? { ownLiftAttr: true } : {}) });
    } catch (e) {
      return { ok: false, reason: 'lift-failed: ' + ((e && e.message) || e) };
    }
    lifts.set(el, h);
    if (h.native) {
      // A push that arrived while lift() was being set up wins over the pick-time answer.
      if (pushedState && pushedState !== h.liftState && h.setLiftState) h.setLiftState(pushedState);
      if (h.liftState === 'ready') sawReady.set(el, true);
    }
    h.on('statechange', ({ state }) => {
      if (state === 'disposed' && lifts.get(el) === h) lifts.delete(el);
    });
    h.on('error', ({ error, fatal }) => {
      if (fatal) console.warn('[DisplayXR lift]', (error && error.message) || error);
    });
    return { ok: true, action: 'lifted', element: el.tagName.toLowerCase(), workers: workerState.mode, mode: h.native ? 'native' : 'web', liftState: h.native ? h.liftState : null };
  }

  /** The browser's state push (OnLiftTaskStateChanged, forwarded to the lift world). */
  function onLiftState(s) {
    if (!LIFT_STATES.includes(s)) return;
    pushedState = s;
    const redo = [];
    for (const [el, h] of lifts) {
      if (!h.native) continue;
      if (h.setLiftState) h.setLiftState(s);
      if (s === 'ready') sawReady.set(el, true);
      // Unavailable = this runtime will not convert (an old runtime whose module never came up, or
      // none at all): only then does a waiting element take the in-page path.
      else if (s === 'unavailable' && !sawReady.get(el)) redo.push(el);
    }
    for (const el of redo) {
      removeHandle(el);
      chain = chain
        .then(() => (el.isConnected ? liftElement(el, { native: false, liftState: 'unavailable' }) : null))
        .then((r) => r && !r.ok && console.warn('[DisplayXR lift]', r.reason))
        .catch((e) => console.error('[DisplayXR lift]', e));
    }
  }

  const api = {
    version: VERSION,
    /**
     * Convert the media under (x, y) — visual-viewport CSS px — or turn it back if it is already
     * converted. Calls are serialised. Resolves {ok, reason?, action?}; never rejects.
     */
    convertAt(x, y, mediaType, hint) {
      const p = chain.then(() => convert(+x, +y, mediaType, hint)).catch((e) => ({ ok: false, reason: 'internal: ' + ((e && e.message) || e) }));
      chain = p;
      return p;
    },
    /**
     * The browser's coarse lift state changed: 'waiting' | 'ready' | 'unavailable'. Called by the
     * browser only (it runs in the lift world, which page script cannot reach).
     */
    setLiftState(s) {
      onLiftState(String(s));
    },
    /** Remove every lift in this document (elements are restored). */
    cancelAll() {
      for (const el of [...lifts.keys()]) removeHandle(el);
    },
    /** Plain-data snapshot for diagnostics (no handles, no elements). */
    status() {
      return {
        version: VERSION,
        ort: ORT_VERSION,
        workers: { ...workerState },
        caps: lastCaps ? { ...lastCaps } : null,
        liftState: pushedState,
        lifts: [...lifts.entries()].map(([el, h]) => ({ element: el.tagName.toLowerCase(), state: h.state, woven: !!h.woven, native: !!h.native, stats: { ...h.stats } })),
      };
    },
  };
  // Validate the compiled-in manifest once, loudly (a bad one is a packaging bug).
  try { parseManifest(MANIFEST); } catch (e) { console.error('[DisplayXR lift] bundled models.json invalid:', e); }
  Object.defineProperty(G, '__dxrLift', { value: Object.freeze(api), writable: false, configurable: false, enumerable: false });
})();

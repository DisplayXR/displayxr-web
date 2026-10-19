// entry.js — the DisplayXR Browser's built-in "Convert to 3D".
//
// Built by tools/lift-builtin/build.mjs into ONE classic script (IIFE) the browser injects into its
// lift isolated world (displayxr-browser-pvt patches 0220/0221) once per document. Then, per
// context-menu pick:
//
//     __dxrLift.convertAt(x, y, 'image'|'video'|'canvas')   // x,y: visual-viewport CSS px
//
// It exposes exactly `globalThis.__dxrLift = { convertAt, cancelAll, setLiftState, status, version }`
// (frozen).
// Everything else — the SDK, the PlayCanvas engine slice — lives in this IIFE's closure. (The real isolation is
// Chromium's: isolated worlds share the DOM, never the JS heap, so page script cannot reach even
// `__dxrLift`.)
//
// THE RUNTIME CONVERTS (ADR-053). This bundle carries no model, no ONNX Runtime and no in-page
// converter: there is nothing here to fall back to. The browser's menu decides whether the runtime's
// conversion stack takes the element and passes it as convertAt's 4th argument `{native, liftState}`
// (browser patch 0331); an older browser passes nothing and convertAt asks `liftCapabilities()`
// itself (GET displayxr-lift://caps — asked afresh on every pick, NEVER cached: a cached non-READY
// answer once latched the wrong path for the whole session after a cold boot). When the runtime
// converts, a <video>/<img> is converted by the BROWSER in place — lift() only sets
// `dxr-lift="auto"` and mounts the chip (Explore / Exit / ↓ SOG). Explore asks the runtime for a
// Gaussian scene (`displayxr-lift://lift/gaussians`). Up to caps.maxStreams conversions may run
// side by side.
//
// Readiness (runtime conversion-providers §7.4/§8.1): the browser's coarse state is
// `waiting | ready | unavailable`. `waiting` is a reason to WAIT — the element keeps its own 2D frame
// and the chip shows a spinner; the browser lifts it by itself once its converter is READY. Only
// `unavailable` ends the lift: the element stays the page's own 2D element. The browser pushes every
// change with `__dxrLift.setLiftState(s)`; when it goes `unavailable` (an old runtime whose module
// never came up) a lift that never reached READY is removed.
//
// Test hook: `globalThis.__dxrLiftConfig = { schemeMap: { 'displayxr-lift://': 'http://…/' }, workers:
// 'worker'|'main-thread' }` set BEFORE the bundle runs rewrites those prefixes
// (tools/lift-builtin/test/). The browser never sets it.

import { lift } from '../../js/lift/lift.js';
import { liftCapabilities } from '../../js/lift/native.js';
import { resolveMediaAt } from '../../js/lift/placement.js';
import { probeWorkers, workerState, forceWorkerMode } from './workers.js';
import { decideLift, LIFT_STATES } from './decide.js';

/* global __DXR_LIFT_VERSION__ */
const VERSION = typeof __DXR_LIFT_VERSION__ === 'string' ? __DXR_LIFT_VERSION__ : 'dev';

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
  if (cfg.workers) forceWorkerMode(cfg.workers);

  const nativeFetch = map
    ? (input, init) => G.fetch(typeof input === 'string' ? rewrite(input) : input, init)
    : undefined;

  /** element → handle. Up to caps.maxStreams conversions at a time (oldest evicted first). */
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
  /** element → true once its lift has seen READY. */
  const sawReady = new WeakMap();

  /**
   * What to do for this pick: the browser's own decision when it gave one (0331's 4th argument),
   * else a FRESH caps query. Never a cached answer.
   */
  async function decide(hint) {
    const caps = await liftCapabilities(nativeFetch ? { fetch: nativeFetch } : {}).catch(() => ({ native: false, liftState: 'unavailable' }));
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
    // The runtime converts <video> and <img>; nothing in this bundle converts a <canvas>.
    if (el.tagName === 'CANVAS') return { ok: false, reason: 'canvas-not-supported' };
    return liftElement(el, await decide(hint));
  }

  async function liftElement(el, caps) {
    lastCaps = caps;
    // The runtime's converter takes the element — while it warms too. When it does not (`unavailable`:
    // no converter in the runtime), there is no in-page path: the element stays the page's own 2D.
    if (!caps.native) return { ok: false, reason: 'converter-unavailable' };

    // Up to caps.maxStreams conversions coexist; the oldest is evicted for a new one.
    const maxNative = Math.max(1, Number.isFinite(caps.maxStreams) && caps.maxStreams > 0 ? caps.maxStreams : 1);
    const keep = [...lifts.keys()];
    while (keep.length >= maxNative) removeHandle(keep.shift());

    await probeWorkers(); // decides the gsplat sorter's worker path before anything is created
    let h;
    try {
      // ownLiftAttr: the built-in owns the element's lift state by definition — the browser's menu
      // (lift_trigger.cc) sets dxr-lift="auto" BEFORE this runs, and restoring that on Exit /
      // toggle-off left the element converting with no handle (a second Convert double-converted).
      h = await lift(el, { ui: 'builtin', native: caps, ownLiftAttr: true });
    } catch (e) {
      return { ok: false, reason: 'lift-failed: ' + ((e && e.message) || e) };
    }
    lifts.set(el, h);
    // A push that arrived while lift() was being set up wins over the pick-time answer.
    if (pushedState && pushedState !== h.liftState && h.setLiftState) h.setLiftState(pushedState);
    if (h.liftState === 'ready') sawReady.set(el, true);
    h.on('statechange', ({ state }) => {
      if (state === 'disposed' && lifts.get(el) === h) lifts.delete(el);
    });
    h.on('error', ({ error, fatal }) => {
      if (fatal) console.warn('[DisplayXR lift]', (error && error.message) || error);
    });
    return { ok: true, action: 'lifted', element: el.tagName.toLowerCase(), workers: workerState.mode, mode: 'native', liftState: h.liftState };
  }

  /** The browser's state push (OnLiftTaskStateChanged, forwarded to the lift world). */
  function onLiftState(s) {
    if (!LIFT_STATES.includes(s)) return;
    pushedState = s;
    const drop = [];
    for (const [el, h] of lifts) {
      if (h.setLiftState) h.setLiftState(s);
      if (s === 'ready') sawReady.set(el, true);
      // Unavailable = this runtime will not convert (an old runtime whose module never came up, or
      // none at all): a lift that never saw READY ends here, and the element is the page's own 2D.
      else if (s === 'unavailable' && !sawReady.get(el)) drop.push(el);
    }
    for (const el of drop) {
      removeHandle(el);
      console.warn('[DisplayXR lift] the runtime has no converter for this element; left as 2D');
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
        workers: { ...workerState },
        caps: lastCaps ? { ...lastCaps } : null,
        liftState: pushedState,
        lifts: [...lifts.entries()].map(([el, h]) => ({ element: el.tagName.toLowerCase(), state: h.state, woven: !!h.woven, native: !!h.native, stats: { ...h.stats } })),
      };
    },
  };
  Object.defineProperty(G, '__dxrLift', { value: Object.freeze(api), writable: false, configurable: false, enumerable: false });
})();

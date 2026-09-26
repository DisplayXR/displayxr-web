// call/lift.js — mono→3D for mono peers, through the SDK's lift() provider chain (RFC 0002 §5).
//
// This module never contains a depth model or vendor code. It decides WHETHER a mono peer is
// lifted, hands its <video> to `lift()` (`@displayxr/inline3d/lift`), and steers the lifted
// streams: priority from the active speaker and tile visibility, convergence from the call's one
// depth control, a cap on concurrent lifts, and a frame-time watch for the web provider.
//
// `lift` is NEVER a hard dependency. `mono3D: 'auto'` imports it lazily at runtime; a missing
// module (not installed, not built into this copy of the SDK), a failed import, or a device that
// can do neither native nor WebGPU lifting resolves to FLAT with one log line. A page can inject
// its own `lift` function (`mono3D: lift`) — that is how tests, bundled apps and pre-merge demos
// work.
//
// Pure except for `resolveLift`'s default importer — see test/call.test.mjs.

/** How a mono peer's lifted stream is scheduled. Mirrors lift()'s `LiftPriority`. */
export const LIFT_PRIORITY = Object.freeze({ speaker: 'high', other: 'normal', hidden: 'paused' });
const PRIORITIES = ['high', 'normal', 'low', 'paused'];

/** Convergence dead band: a depth slider this close to 0 hands lift 'auto'. */
const DEPTH_AUTO_BAND = 0.02;

/** Web-provider frame-time watch: warn when frames average slower than this for this long. */
const DEGRADED_FRAME_MS = 1000 / 20;
const DEGRADED_HOLD_MS = 3000;
const RECOVERED_FRAME_MS = 1000 / 28;

/**
 * `mono3D` option → `'auto' | 'off' | Function`. `false`/`'off'` → 'off'; a function is an
 * injected `lift`; anything else → 'auto'.
 */
export function normalizeMono3D(v) {
  if (typeof v === 'function') return v;
  if (v === false || v === 'off') return 'off';
  return 'auto';
}

/**
 * Where `mono3D: 'auto'` looks for the lift module: the `./lift` subpath of THIS copy of the SDK,
 * resolved relative to this file (js/call/ → js/lift/index.js), exactly as the package maps
 * `@displayxr/inline3d/lift`. The specifier is computed, so a bundler neither fails on a copy of
 * the SDK without lift nor pulls lift into every call bundle; a bundled app that wants lifting
 * passes `mono3D: lift` (imported itself) instead.
 */
export function defaultLiftSpecifier(base = import.meta.url) {
  return new URL('../lift/index.js', base).href;
}

function defaultImporter() {
  return import(/* @vite-ignore */ /* webpackIgnore: true */ defaultLiftSpecifier());
}

/**
 * Resolve the `mono3D` option to a usable lift function, or to null (flat) with a reason.
 *
 *   'off'      → { lift: null, reason: 'off' }
 *   function   → { lift: fn, capabilities: fn.liftCapabilities || null, source: 'injected' }
 *   'auto'     → import the lift module; then, when it has `liftCapabilities()`, require a native
 *                provider OR a WebGPU adapter for the web fallback (without it, the module has no
 *                live video path). Without `liftCapabilities`, a missing `navigator.gpu` is the
 *                same verdict. Any failure → { lift: null, reason }, never a throw.
 *
 * @param {'auto'|'off'|Function} mono3D
 * @param {{ importer?: () => Promise<any>, nav?: any, log?: (tag: string, o: object) => void, capsOpts?: object }} [o]
 * @returns {Promise<{ lift: Function|null, capabilities: Function|null, caps: object|null, source: string, reason: string|null }>}
 */
export async function resolveLift(mono3D, { importer = defaultImporter, nav = globalThis.navigator, log = null, capsOpts = { webFallback: true } } = {}) {
  const say = (tag, x) => log && log(tag, x);
  const flat = (reason, extra = {}) => {
    say('lift-unavailable', { reason, ...extra });
    return { lift: null, capabilities: null, caps: null, source: 'none', reason };
  };
  const m = normalizeMono3D(mono3D);
  if (m === 'off') return { lift: null, capabilities: null, caps: null, source: 'none', reason: 'off' };
  if (typeof m === 'function') {
    const capabilities = typeof m.liftCapabilities === 'function' ? m.liftCapabilities : null;
    return { lift: m, capabilities, caps: null, source: 'injected', reason: null };
  }
  let mod;
  try {
    mod = await importer();
  } catch (err) {
    return flat('import-failed', { message: String((err && err.message) || err).slice(0, 200) });
  }
  const lift = mod && typeof mod.lift === 'function' ? mod.lift : null;
  if (!lift) return flat('no-lift-export');
  const capabilities = typeof mod.liftCapabilities === 'function' ? mod.liftCapabilities : null;
  let caps = null;
  if (capabilities) {
    try {
      caps = await capabilities(capsOpts);
    } catch {
      caps = null;
    }
    const web = !!(caps && caps.webFallback && caps.webFallback.webgpu);
    if (caps && !caps.native && !web) return flat('no-provider', { native: false, webgpu: false });
  } else if (!(nav && nav.gpu)) return flat('no-webgpu');
  say('lift-ready', { native: !!(caps && caps.native), provider: (caps && caps.provider) || null });
  return { lift, capabilities, caps, source: 'module', reason: null };
}

/**
 * The call's ONE depth control ([-1, 1], + = push the picture back) as lift's convergence.
 * lift's `convergence` is the normalised disparity (0 = far, 1 = near) placed on the glass, so a
 * larger value puts more of the picture behind it. 0 (± a small band) = 'auto' (lift centres its
 * own subject); otherwise 0.5 + 0.5·depth, clamped to [0, 1].
 */
export function liftConvergenceFor(depth) {
  const d = Number.isFinite(+depth) && depth !== null ? Math.max(-1, Math.min(1, +depth)) : 0;
  if (Math.abs(d) < DEPTH_AUTO_BAND) return 'auto';
  return Math.round((0.5 + 0.5 * d) * 1000) / 1000;
}

/** A lifted tile's priority: hidden/offscreen → paused, the active speaker → high, else normal. */
export function liftPriorityFor({ id, speakerId, visible = true }) {
  if (!visible) return LIFT_PRIORITY.hidden;
  return id !== null && id !== undefined && id === speakerId ? LIFT_PRIORITY.speaker : LIFT_PRIORITY.other;
}

/**
 * THE HOOK FOR THE NATIVE PROVIDER'S PER-STREAM PRIORITY (`xrSetLiftStreamPriorityDXR`: HIGH =
 * every round, NORMAL = round-robin, LOW = every Nth, PAUSED = keep the last frame).
 *
 * Today it forwards to the lift handle's `setPriority()` when it has one: in native mode that is
 * the element's `dxr-lift-priority` attribute, which the browser maps onto the runtime's stream
 * priority; on the web path lift runs one stream per element and it is a no-op. A handle without
 * `setPriority` (an injected lift, an older lift build) is a no-op here — the call still works,
 * every stream is just scheduled equally. Nothing else in the call module talks priority, so this
 * one function is what changes if the native provider grows a different surface.
 *
 * @returns {boolean} true when the handle accepted it
 */
export function setLiftPriority(handle, level) {
  if (!handle || !PRIORITIES.includes(level)) return false;
  if (typeof handle.setPriority !== 'function') return false;
  try {
    return handle.setPriority(level) !== false;
  } catch {
    return false;
  }
}

/**
 * Frame-time watch for lifted tiles on the WEB provider (the native one runs in the display
 * service, off the page's frame budget). Feed it the page's frame intervals; it reports
 * `'degraded'` once when the smoothed interval stays above ~20 fps for 3 s, and `'recovered'`
 * once it is back above ~28 fps. Pure.
 */
export function createFrameWatch({ degradedMs = DEGRADED_FRAME_MS, recoveredMs = RECOVERED_FRAME_MS, holdMs = DEGRADED_HOLD_MS, alpha = 0.1 } = {}) {
  let ema = null;
  let slowFor = 0;
  let degraded = false;
  return {
    /** @param {number} dtMs  one frame interval @returns {'degraded'|'recovered'|null} */
    feed(dtMs) {
      if (!(dtMs > 0) || dtMs > 1000) return null; // a tab switch, not a frame
      ema = ema === null ? dtMs : ema + alpha * (dtMs - ema);
      if (!degraded) {
        slowFor = ema > degradedMs ? slowFor + dtMs : 0;
        if (slowFor >= holdMs) {
          degraded = true;
          return 'degraded';
        }
      } else if (ema < recoveredMs) {
        degraded = false;
        slowFor = 0;
        return 'recovered';
      }
      return null;
    },
    reset() {
      ema = null;
      slowFor = 0;
      degraded = false;
    },
    get frameMs() {
      return ema;
    },
    get degraded() {
      return degraded;
    },
  };
}

/**
 * The call's lifted streams: at most `max` at once, each one lift() handle per peer, steered as a
 * group (speaker → priority, depth → convergence). Pure apart from the `lift` it is given.
 *
 * @param {{ lift: Function, max?: number, log?: (tag: string, o: object) => void, options?: object }} o
 */
export function createLiftPool({ lift, max = 4, log = null, options = null } = {}) {
  // Page-supplied lift options (models, ort, quality, providers, …). The call owns the keys that
  // make it a call tile — mode, wall, ui, convergence, priority — so those always win.
  const extra = options && typeof options === 'object' ? options : {};
  const entries = new Map(); // id → { gen, handle|null, visible, priority, pending }
  let speakerId = null;
  let depth = 0;
  let gen = 0;
  const say = (tag, x) => log && log(tag, x);

  const apply = (id, e) => {
    if (!e.handle) return;
    const p = liftPriorityFor({ id, speakerId, visible: e.visible });
    if (p === e.priority) return;
    e.priority = p;
    const ok = setLiftPriority(e.handle, p);
    say('lift-priority', { peer: id, priority: p, applied: ok });
  };

  const pool = {
    get size() {
      return entries.size;
    },
    get max() {
      return max;
    },
    set max(n) {
      max = Math.max(0, n | 0);
    },
    has: (id) => entries.has(id),
    handle: (id) => (entries.get(id) && entries.get(id).handle) || null,
    priority: (id) => (entries.get(id) && entries.get(id).priority) || null,
    /** Is there a slot for `id` (it already holds one, or fewer than `max` are taken)? */
    canAcquire: (id) => entries.has(id) || entries.size < max,
    /**
     * Lift `element` for peer `id`. Resolves with the handle, or null when there is no slot, when
     * `release(id)` ran meanwhile (the late handle is removed), or when lift() rejects (`onError`
     * gets it). One pending/live stream per id: a second acquire returns the first.
     */
    acquire(id, element, { wall, visible = true, onError } = {}) {
      const cur = entries.get(id);
      if (cur) return cur.pending || Promise.resolve(cur.handle);
      if (entries.size >= max) return Promise.resolve(null);
      const my = ++gen;
      const priority = liftPriorityFor({ id, speakerId, visible });
      const e = { gen: my, handle: null, visible, priority, pending: null };
      entries.set(id, e);
      const opts = { quality: 'auto', ...extra, mode: 'live', wall, ui: 'none', convergence: liftConvergenceFor(depth), priority };
      say('lift-acquire', { peer: id, priority, convergence: opts.convergence });
      e.pending = Promise.resolve()
        .then(() => lift(element, opts))
        .then(
          (h) => {
            if (entries.get(id) !== e || e.gen !== my) {
              try {
                h && h.remove && h.remove();
              } catch {
                /* ignore */
              }
              return null;
            }
            e.pending = null;
            e.handle = h || null;
            // Converge on the CURRENT state (speaker/depth/visibility may have moved meanwhile).
            e.priority = null;
            apply(id, e);
            if (h && typeof h.setConvergence === 'function') h.setConvergence(liftConvergenceFor(depth));
            return e.handle;
          },
          (err) => {
            if (entries.get(id) === e) entries.delete(id);
            say('lift-failed', { peer: id, message: String((err && err.message) || err).slice(0, 200) });
            if (onError) onError(err);
            return null;
          }
        );
      return e.pending;
    },
    /** Remove peer `id`'s lift (a pending one is removed when it lands). */
    release(id) {
      const e = entries.get(id);
      if (!e) return;
      entries.delete(id);
      if (e.handle) {
        try {
          e.handle.remove();
        } catch {
          /* the session may be gone */
        }
      }
      say('lift-release', { peer: id });
    },
    releaseAll() {
      for (const id of [...entries.keys()]) pool.release(id);
    },
    setSpeaker(id) {
      speakerId = id === undefined ? null : id;
      for (const [pid, e] of entries) apply(pid, e);
    },
    setVisible(id, visible) {
      const e = entries.get(id);
      if (!e || e.visible === !!visible) return;
      e.visible = !!visible;
      apply(id, e);
    },
    /** The call's depth control → every lifted stream's convergence. */
    setDepth(v) {
      depth = v;
      const c = liftConvergenceFor(v);
      for (const e of entries.values()) if (e.handle && typeof e.handle.setConvergence === 'function') e.handle.setConvergence(c);
      return c;
    },
    /** True when any live lifted stream runs on the page (the web provider), not in the service. */
    get anyWeb() {
      for (const e of entries.values()) if (e.handle && !e.handle.native) return true;
      return false;
    },
    /** Snapshot for info()/tests. */
    list() {
      return [...entries].map(([id, e]) => ({ id, priority: e.priority, pending: !!e.pending, native: !!(e.handle && e.handle.native) }));
    },
  };
  return pool;
}

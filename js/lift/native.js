// lift/native.js — the DisplayXR Browser's VENDOR 2D→3D module, seen from the SDK.
//
// THE SUPERSEDE RULE (docs/lift.md § Vendor modules): when the runtime carries a vendor 2D→3D
// module (e.g. a DirectML/NPU converter) and the browser exposes it, it SUPERSEDES the SDK's open
// default for everything it covers:
//   live      the browser converts + weaves the <video>/<img> IN PLACE (the `dxr-lift` attribute);
//             the SDK mounts no DIBR, loads no model, runs no JS per frame;
//   depth     the paused frame's depth comes from `POST displayxr-lift://lift/depth` (the `native`
//             DepthProvider, priority 100) — the ORT still model is only the fallback;
//   gaussians when the module lists `gaussians`, the explore scene comes from
//             `POST displayxr-lift://lift/gaussians` (the `native-gaussians` LiftProvider) — the
//             local generator is only the fallback.
// Anything the module does not cover, or any error it returns, falls back to the open default.
//
// The browser exposes it ONLY to its lift isolated world (where the built-in runs, and where an
// extension-style content script would):
//   GET  displayxr-lift://caps            → {native, provider, modes, maxStreams, approxMsPerConvert, state}
//   POST displayxr-lift://lift/depth      image → depth map (see parseNativeDepthResponse)
//   POST displayxr-lift://lift/gaussians  image → .sog | .ply (404 when unsupported)
// Outside that world (any ordinary page, any other browser) the scheme does not resolve: `fetch`
// rejects, and that rejection IS the feature detection → `native: false`.

import { getRegistry } from './providers/registry.js';

export const NATIVE_BASE = 'displayxr-lift://';
export const NATIVE_CAPS_URL = NATIVE_BASE + 'caps';
export const NATIVE_DEPTH_URL = NATIVE_BASE + 'lift/depth';
export const NATIVE_GAUSSIANS_URL = NATIVE_BASE + 'lift/gaussians';

/** The element attributes the browser reads (docs/lift.md § Vendor modules → attributes). */
export const LIFT_ATTRS = Object.freeze({
  lift: 'dxr-lift',
  convergence: 'dxr-lift-convergence',
  strength: 'dxr-lift-strength',
  priority: 'dxr-lift-priority',
});
export const LIFT_PRIORITIES = Object.freeze(['high', 'normal', 'low', 'paused']);
const MODES = new Set(['depth', 'sbs', 'nview', 'gaussians']);
const CAPS_TIMEOUT_MS = 2000;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// ── capabilities ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalise the browser's caps JSON. Unknown modes are dropped; `native` is true only when the
 * browser says so AND the module is not `unavailable` (an `activating` module counts: the browser
 * queues the conversion until it is ready).
 */
export function parseNativeCaps(json) {
  const j = json && typeof json === 'object' ? json : {};
  const state = ['ready', 'activating', 'unavailable'].includes(j.state) ? j.state : j.native ? 'ready' : 'unavailable';
  const out = { native: j.native === true && state !== 'unavailable', state };
  if (typeof j.provider === 'string' && j.provider) out.provider = j.provider;
  out.modes = Array.isArray(j.modes) ? j.modes.filter((m) => MODES.has(m)) : [];
  if (Number.isFinite(j.maxStreams) && j.maxStreams >= 0) out.maxStreams = Math.floor(j.maxStreams);
  if (Number.isFinite(j.approxMsPerConvert) && j.approxMsPerConvert >= 0) out.approxMsPerConvert = +j.approxMsPerConvert;
  // the module's live disparity budget at strength 1 (fraction of the frame width), if it reports one
  if (Number.isFinite(j.depthBudget) && j.depthBudget > 0 && j.depthBudget < 0.5) out.depthBudget = +j.depthBudget;
  return out;
}

/** Per-document cache: document → { native: Promise, web: Map<ModelSource|'auto', Promise> }. */
let cache = new WeakMap();
const NO_DOC = {};
const docKey = () => (typeof document !== 'undefined' && document) || NO_DOC;

/** Test hook: forget every cached answer. */
export function _resetLiftCapabilities() {
  cache = new WeakMap();
}

async function queryNative(fetchImpl, signal, timeoutMs) {
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  if (signal) {
    if (signal.aborted) throw signal.reason || new DOMException('aborted', 'AbortError');
    signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(NATIVE_CAPS_URL, { signal: ctl.signal, cache: 'no-store' });
    if (!r || !r.ok) return { native: false, state: 'unavailable', modes: [] };
    return parseNativeCaps(await r.json());
  } catch (e) {
    if (signal && signal.aborted) throw e; // the CALLER aborted: not an answer
    return { native: false }; // the scheme does not resolve here → not the DXR Browser's lift world
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

async function webGpuAdapter(nav) {
  try {
    if (!nav || !nav.gpu || typeof nav.gpu.requestAdapter !== 'function') return false;
    return !!(await nav.gpu.requestAdapter());
  } catch {
    return false;
  }
}

async function queryWeb({ models, nav, signal, quality = 'medium' }) {
  const webgpu = await webGpuAdapter(nav);
  if (!webgpu) return { video: false, still: false, webgpu: false };
  let src = models;
  if (!src || src === 'auto' || typeof src === 'string') {
    const M = await import('./providers/models.js');
    src = M.createModelSource(typeof src === 'string' && src !== 'auto' ? { baseUrl: src } : {});
  }
  if (!src || typeof src.probe !== 'function') return { video: false, still: false, webgpu };
  try {
    await src.ready();
    const [video, still] = await Promise.all([
      src.probe(src.resolveName('vda-small', 'depth-video', 'medium'), { signal }),
      src.probe(src.resolveName('moge3', 'depth-still', quality), { signal }),
    ]);
    return { video: !!video, still: !!still, webgpu };
  } catch (e) {
    if (signal && signal.aborted) throw e;
    return { video: false, still: false, webgpu };
  }
}

/**
 * What 2D→3D this document can do, before any lift. Cheap and async; cached per document (pass
 * `refresh: true` to re-ask, e.g. after `state: 'activating'`).
 *
 *   native       the browser's vendor module is reachable from here (the lift world of the
 *                DisplayXR Browser) and not `unavailable` — it supersedes the web path;
 *   provider/modes/maxStreams/approxMsPerConvert/state   as the browser reports them;
 *   webFallback  the open web path: `webgpu` (a WebGPU adapter), `video` / `still` (that path's
 *                default depth model is reachable through the model source without downloading).
 *
 * @param {object} [o]
 * @param {AbortSignal} [o.signal]
 * @param {boolean} [o.refresh=false]
 * @param {boolean} [o.webFallback=true]  false skips the model probes (webFallback all false).
 * @param {'auto'|string|object} [o.models='auto']  the ModelSource to probe (as lift()'s `models`).
 * @param {'low'|'medium'|'high'} [o.quality='medium']  which still-model tier to probe.
 * @param {Function} [o.fetch] [o.navigator]  injectable for tests.
 */
export async function liftCapabilities(o = {}) {
  const fetchImpl = o.fetch || ((...a) => globalThis.fetch(...a));
  const nav = 'navigator' in o ? o.navigator : typeof navigator !== 'undefined' ? navigator : undefined;
  const key = docKey();
  let c = cache.get(key);
  if (!c || o.refresh) cache.set(key, (c = { native: null, web: new Map() }));
  if (!c.native) {
    const p = queryNative(fetchImpl, o.signal, o.timeoutMs || CAPS_TIMEOUT_MS);
    c.native = p;
    p.catch(() => { if (c.native === p) c.native = null; }); // an abort is not cached
  }
  const nativeCaps = await c.native;
  let web = { video: false, still: false, webgpu: false };
  if (o.webFallback !== false) {
    const mk = o.models || 'auto';
    let wp = c.web.get(mk);
    if (!wp) {
      wp = queryWeb({ models: mk, nav, signal: o.signal, quality: o.quality });
      c.web.set(mk, wp);
      wp.catch(() => { if (c.web.get(mk) === wp) c.web.delete(mk); });
    }
    web = await wp;
  }
  return { ...nativeCaps, webFallback: { ...web } };
}

/** Which lift provider lift() should default to for these caps (`null` = its own default). */
export function defaultLiftProviderFor(caps, providers = {}) {
  if (providers && providers.lift) return providers.lift; // the caller chose
  return caps && caps.native && Array.isArray(caps.modes) && caps.modes.includes('gaussians') ? 'native-gaussians' : null;
}

// ── attributes: native live mode ────────────────────────────────────────────────────────────

/** `'high'|'normal'|'low'|'paused'` → itself; anything else → null. */
export function normalizePriority(p) {
  return LIFT_PRIORITIES.includes(p) ? p : null;
}

const fmt = (x) => String(+(+x).toFixed(4));

/**
 * The element side of native live mode: sets / updates / restores the `dxr-lift*` attributes.
 * Pure DOM attribute work (setAttribute / getAttribute / removeAttribute), so it runs against a fake
 * element under `node --test`. `clear()` puts every attribute back EXACTLY as it was before
 * (including a value the page set itself) — unless `ownLiftAttr`: then the caller OWNS the
 * element's lift state, the pre-lift values are recorded as absent and `clear()` REMOVES every
 * `dxr-lift*` attribute. The browser's built-in needs that: its context menu sets
 * `dxr-lift="auto"` before lift() runs, and restoring that "auto" on exit left the element
 * converting with no handle (a second Convert then double-converted).
 *
 * @param {Element} el
 * @param {{depth?:number, convergence?:'auto'|number, priority?:string, ownLiftAttr?:boolean}} [o]
 */
export function createNativeLiveAttrs(el, o = {}) {
  const names = Object.values(LIFT_ATTRS);
  let own = !!o.ownLiftAttr;
  const prev = new Map(names.map((n) => [n, !own && el.hasAttribute(n) ? el.getAttribute(n) : null]));
  const st = {
    lift: 'auto',
    strength: Number.isFinite(o.depth) ? o.depth : 1,
    convergence: o.convergence === undefined ? 'auto' : o.convergence,
    priority: normalizePriority(o.priority) || 'normal',
  };
  let applied = false;
  let held = null; // a temporary priority (suspend) that overrides st.priority
  let off = false; // explore owns the pixels: dxr-lift="off"

  function write() {
    if (!applied) return;
    el.setAttribute(LIFT_ATTRS.lift, off ? 'off' : st.lift);
    el.setAttribute(LIFT_ATTRS.strength, fmt(st.strength));
    el.setAttribute(LIFT_ATTRS.convergence, st.convergence === 'auto' ? 'auto' : fmt(st.convergence));
    el.setAttribute(LIFT_ATTRS.priority, held || st.priority);
  }
  return {
    /** Start converting: dxr-lift="auto" + the current strength/convergence/priority. */
    apply() {
      applied = true;
      write();
    },
    get applied() {
      return applied;
    },
    /** Snapshot of what is (or would be) written. */
    get values() {
      return { lift: off ? 'off' : st.lift, strength: st.strength, convergence: st.convergence, priority: held || st.priority };
    },
    setStrength(x) {
      if (!Number.isFinite(x)) return;
      st.strength = Math.max(0, x);
      write();
    },
    setConvergence(x) {
      st.convergence = x === 'auto' || Number.isFinite(x) ? x : 'auto';
      write();
    },
    /** @returns {boolean} false for an unknown value (ignored). */
    setPriority(p) {
      const v = normalizePriority(p);
      if (!v) return false;
      st.priority = v;
      write();
      return true;
    },
    /** Temporarily force a priority (e.g. 'paused' while the tab is hidden); null lifts it. */
    hold(p) {
      held = p ? normalizePriority(p) : null;
      write();
    },
    /** The SDK's explore canvas owns the pixels (true) or the browser converts again (false). */
    setOff(on) {
      off = !!on;
      write();
    },
    /** Remove every dxr-lift* attribute now, whatever set it (a still that never goes live). */
    drop() {
      for (const n of names) el.removeAttribute(n);
    },
    /** Restore every attribute to its pre-lift value (ownLiftAttr: remove them all). Idempotent. */
    clear() {
      if (!applied) {
        // Never applied (e.g. removed while loading) but owned: the menu's pre-set attrs still go.
        if (own) {
          own = false; // once
          for (const n of names) el.removeAttribute(n);
        }
        return;
      }
      applied = false;
      for (const [n, v] of prev) {
        if (v === null) el.removeAttribute(n);
        else el.setAttribute(n, v);
      }
    },
  };
}

// ── native providers (the paused frame) ──────────────────────────────────────────────────────

/** A native-module failure. `code`: http | unsupported | format | encode | network | aborted. */
export class NativeLiftError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'NativeLiftError';
    this.code = code;
    this.fallback = code !== 'aborted';
    Object.assign(this, extra);
  }
}

function sizeOf(src) {
  const w = src.videoWidth || src.naturalWidth || src.displayWidth || src.codedWidth || src.width || 0;
  const h = src.videoHeight || src.naturalHeight || src.displayHeight || src.codedHeight || src.height || 0;
  return { w: +w || 0, h: +h || 0 };
}

/**
 * The frame as an image Blob for the native endpoints (JPEG: the module resamples anyway, and the
 * encode is ~10× cheaper than PNG). A Blob passes through.
 */
export async function encodeFrame(src, { type = 'image/jpeg', quality = 0.92, createCanvas } = {}) {
  if (typeof Blob !== 'undefined' && src instanceof Blob) return src;
  const { w, h } = sizeOf(src || {});
  if (!(w > 0 && h > 0)) throw new NativeLiftError('native lift: the frame has no size', 'encode');
  const c = createCanvas
    ? createCanvas(w, h)
    : typeof OffscreenCanvas === 'function'
      ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = c.getContext('2d');
  if (!ctx) throw new NativeLiftError('native lift: no 2D context to encode the frame', 'encode');
  ctx.drawImage(src, 0, 0, w, h);
  const blob =
    typeof c.convertToBlob === 'function'
      ? await c.convertToBlob({ type, quality })
      : await new Promise((res) => c.toBlob(res, type, quality));
  if (!blob) throw new NativeLiftError('native lift: frame encode failed', 'encode');
  return blob;
}

async function post(fetchImpl, url, blob, signal) {
  let r;
  try {
    r = await fetchImpl(url, { method: 'POST', body: blob, headers: { 'content-type': blob.type || 'application/octet-stream' }, signal });
  } catch (e) {
    if (signal && signal.aborted) throw new NativeLiftError('native lift: aborted', 'aborted');
    throw new NativeLiftError(`native lift: ${url} unreachable: ${(e && e.message) || e}`, 'network');
  }
  if (r.status === 404 || r.status === 501) throw new NativeLiftError(`native lift: ${url} not supported (HTTP ${r.status})`, 'unsupported', { status: r.status });
  if (!r.ok) throw new NativeLiftError(`native lift: ${url} → HTTP ${r.status}`, 'http', { status: r.status });
  return r;
}

const SEMANTICS = {
  metric: 'metric', 'metric-depth': 'metric', depth_m: 'metric', 'depth-m': 'metric', meters: 'metric', metres: 'metric',
  disparity: 'disparity', 'relative-disparity': 'disparity', 'inverse-depth': 'disparity', 'relative-inverse-depth': 'disparity',
};

function b64ToBytes(s) {
  if (typeof atob === 'function') {
    const bin = atob(s);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }
  return new Uint8Array(Buffer.from(s, 'base64'));
}

/**
 * The native depth answer → the DepthProvider contract ({data, w, h, space, intrinsics?}).
 * Accepted wire shapes (docs/lift.md § Vendor modules):
 *   binary  `application/octet-stream` body = w·h little-endian float32, row-major, with headers
 *           `X-DXR-Depth-Width`, `X-DXR-Depth-Height`, `X-DXR-Depth-Semantics`, optional
 *           `X-DXR-Depth-FocalPx` (in pixels of the w×h grid);
 *   json    `{ w, h, semantics, focalPx?, data }` — data a base64 float32 string or a number array.
 * `semantics` 'metric' (metres; 0 = invalid) or 'disparity' (relative inverse depth, bigger = nearer).
 * Anything else throws NativeLiftError('format') — the caller falls back to the ORT still model.
 */
export async function parseNativeDepthResponse(r) {
  const ct = ((r.headers && r.headers.get('content-type')) || '').toLowerCase();
  let w, h, sem, focal, data;
  if (ct.includes('json')) {
    const j = await r.json();
    w = +(j.w ?? j.width);
    h = +(j.h ?? j.height);
    sem = j.semantics;
    focal = +(j.focalPx ?? (j.intrinsics && j.intrinsics.focalPx));
    if (typeof j.data === 'string') {
      const u = b64ToBytes(j.data);
      data = new Float32Array(u.buffer, u.byteOffset, Math.floor(u.byteLength / 4));
    } else if (Array.isArray(j.data)) data = Float32Array.from(j.data);
  } else {
    const H = (k) => r.headers && r.headers.get(k);
    w = +H('x-dxr-depth-width');
    h = +H('x-dxr-depth-height');
    sem = H('x-dxr-depth-semantics');
    focal = +H('x-dxr-depth-focalpx');
    const buf = await r.arrayBuffer();
    if (buf.byteLength % 4 === 0) data = new Float32Array(buf);
  }
  const space = SEMANTICS[String(sem || '').toLowerCase()];
  if (!space) throw new NativeLiftError(`native depth: unknown semantics ${JSON.stringify(sem)}`, 'format');
  if (!(Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0)) throw new NativeLiftError(`native depth: bad size ${w}×${h}`, 'format');
  if (!data || data.length !== w * h) throw new NativeLiftError(`native depth: ${data ? data.length : 0} values for ${w}×${h}`, 'format');
  const out = { data, w, h, space };
  if (focal > 0) out.intrinsics = { focalPx: focal, fovXDeg: +((2 * Math.atan(w / (2 * focal)) * 180) / Math.PI).toFixed(2) };
  return out;
}

/**
 * The `native` DepthProvider (still frames only): POST the frame to `lift/depth`. On ANY failure it
 * falls back — for that frame and, after a 404/501, for the rest of the session — to `opts.fallback`
 * (default: the registry's `'ort'` provider with the same options, its model loaded on first use).
 *
 * @param {object} opts  the createDepthProvider options, plus:
 * @param {Function} [opts.fetch]
 * @param {() => Promise<any>} [opts.loadOrt]  lazy onnxruntime for the fallback (native mode never loads it up front)
 * @param {(o:object) => object} [opts.fallback]  factory for the fallback DepthProvider
 * @param {string} [opts.provider]  the module's name from caps (diagnostics)
 */
export function createNativeDepthProvider(opts = {}) {
  const fetchImpl = opts.fetch || ((...a) => globalThis.fetch(...a));
  const info = { backend: 'native', provider: opts.provider || null, calls: 0, fallbacks: 0, lastError: null, lastMs: 0, unsupported: false };
  let fb = null;
  let fbLoading = null;
  let disposed = false;

  async function fallback() {
    if (fb) return fb;
    if (!fbLoading) {
      fbLoading = (async () => {
        let o2 = { ...opts, kind: 'still' };
        delete o2.fallback;
        if (!o2.ort && typeof opts.loadOrt === 'function') o2 = { ...o2, ort: await opts.loadOrt() };
        const p = opts.fallback ? opts.fallback(o2) : getRegistry().getDepthProvider('ort', o2);
        await p.load({ signal: opts.signal });
        fb = p;
        return p;
      })();
      fbLoading.catch(() => { fbLoading = null; });
    }
    return fbLoading;
  }

  async function nativeEstimate(source, signal) {
    const blob = await encodeFrame(source);
    const t0 = now();
    const r = await post(fetchImpl, NATIVE_DEPTH_URL, blob, signal);
    const d = await parseNativeDepthResponse(r);
    info.lastMs = Math.round(now() - t0);
    return d;
  }

  return {
    id: 'native',
    kind: 'still',
    info,
    /** Nothing to load: the module lives in the runtime. (The fallback loads on first use.) */
    async load() {},
    async estimate({ source, t, signal } = {}) {
      if (disposed) throw new Error('native depth: disposed');
      if (!info.unsupported) {
        info.calls++;
        try {
          const d = await nativeEstimate(source, signal);
          info.source = 'native';
          return d;
        } catch (e) {
          if (e && e.code === 'aborted') throw e;
          info.lastError = (e && e.message) || String(e);
          if (e && e.code === 'unsupported') info.unsupported = true;
        }
      }
      info.fallbacks++;
      info.source = 'fallback';
      const p = await fallback();
      return p.estimate({ source, t });
    },
    reset() {
      if (fb) fb.reset();
    },
    dispose() {
      disposed = true;
      if (fb) {
        try {
          fb.dispose();
        } catch {
          /* ignore */
        }
      }
      fb = null;
    },
  };
}

/** `PK\x03\x04` (a .sog bundle is a zip) / `ply\n`. */
export function sniffSplatFormat(u8) {
  if (!u8 || u8.length < 4) return null;
  if (u8[0] === 0x50 && u8[1] === 0x4b && u8[2] === 0x03 && u8[3] === 0x04) return 'sog';
  if (u8[0] === 0x70 && u8[1] === 0x6c && u8[2] === 0x79 && (u8[3] === 0x0a || u8[3] === 0x0d)) return 'ply';
  return null;
}

/**
 * The `native-gaussians` LiftProvider (the remote-sharp contract, docs/lift.md § Provider
 * interfaces): `{ id, needsDepth:false, generateLift({rgb, signal, onProgress}) → {sog} | {ply, meta} }`.
 * A `.sog` carries its own camera block v2 (explore reads the rig off it); a `.ply` must come with
 * an `X-DXR-Lift-Meta` JSON header ({focalPx, pivotZ, w, h, …} — the generator's meta shape), else
 * it is a `format` error. Every error but an abort has `fallback: true` → lift.js lifts locally.
 */
export function createNativeGaussiansLift(opts = {}) {
  const fetchImpl = opts.fetch || ((...a) => globalThis.fetch(...a));
  let unsupported = false;
  return {
    id: 'native-gaussians',
    needsDepth: false,
    provider: opts.provider || null,
    async load() {},
    async generateLift({ rgb, signal, onProgress } = {}) {
      if (unsupported) throw new NativeLiftError('native gaussians: not supported by this module', 'unsupported');
      const t0 = now();
      const blob = await encodeFrame(rgb);
      if (onProgress) onProgress({ stage: 'lifting', progress: 0.1, elapsedS: 0 });
      let r;
      try {
        r = await post(fetchImpl, NATIVE_GAUSSIANS_URL, blob, signal);
      } catch (e) {
        if (e && e.code === 'unsupported') unsupported = true;
        throw e;
      }
      const u8 = new Uint8Array(await r.arrayBuffer());
      const fmtName = sniffSplatFormat(u8);
      const ms = Math.round(now() - t0);
      if (onProgress) onProgress({ stage: 'lifting', progress: 1, elapsedS: ms / 1000 });
      if (fmtName === 'sog') return { sog: u8, meta: { timings: { nativeMs: ms } } };
      if (fmtName === 'ply') {
        let meta = null;
        try {
          meta = JSON.parse((r.headers && r.headers.get('x-dxr-lift-meta')) || 'null');
        } catch {
          meta = null;
        }
        if (!meta || !(meta.focalPx > 0) || !(meta.w > 0) || !(meta.h > 0))
          throw new NativeLiftError('native gaussians: a .ply needs an X-DXR-Lift-Meta header with focalPx/w/h', 'format');
        if (!(meta.pivotZ > 0)) meta.pivotZ = 2;
        return { ply: u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength), meta: { ...meta, timings: { nativeMs: ms } } };
      }
      throw new NativeLiftError('native gaussians: response is neither a .sog nor a .ply', 'format');
    },
    dispose() {},
  };
}

/**
 * Register the native providers for these caps (idempotent). Depth: `native` at priority 100,
 * stills only (live video is converted by the browser, not by a provider). Gaussians:
 * `native-gaussians` at priority 100 when `modes` includes 'gaussians' (on registries that know
 * lift providers). Returns the names registered.
 */
export function ensureNativeProviders(caps, { registry = getRegistry(), fetch: fetchImpl } = {}) {
  const names = [];
  if (!caps || !caps.native) return names;
  const provider = caps.provider;
  registry.registerDepthProvider('native', (o) => createNativeDepthProvider({ ...o, provider, ...(fetchImpl ? { fetch: fetchImpl } : {}) }), {
    priority: 100,
    kinds: ['still'],
  });
  names.push('native');
  if (Array.isArray(caps.modes) && caps.modes.includes('gaussians') && typeof registry.registerLiftProvider === 'function') {
    registry.registerLiftProvider('native-gaussians', () => createNativeGaussiansLift({ provider, ...(fetchImpl ? { fetch: fetchImpl } : {}) }), {
      priority: 100,
    });
    names.push('native-gaussians');
  }
  return names;
}

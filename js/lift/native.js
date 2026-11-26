// lift/native.js — the DisplayXR Browser's VENDOR 2D→3D module, seen from the SDK.
//
// THE RUNTIME CONVERTS (ADR-053; docs/lift.md § Vendor modules): the runtime's conversion stack
// (an open provider by default, a vendor module when one is installed) is exposed by the browser,
// and it is this SDK's ONLY provider. There is no in-page converter to fall back to:
//   live      the browser converts + weaves the <video>/<img> IN PLACE (the `dxr-lift` attribute);
//             the SDK mounts no canvas, loads no model, runs no JS per frame;
//   depth     the paused frame's depth, if a caller wants it, comes from
//             `POST displayxr-lift://lift/depth` (the `native` DepthProvider);
//   gaussians when the module lists `gaussians`, the explore scene comes from
//             `POST displayxr-lift://lift/gaussians` (the `native-gaussians` LiftProvider).
// Anything the module does not cover, or any error it returns, is an error the caller sees.
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
/** How long explore waits for the runtime's Gaussians before it gives up (a cold model's warm is
 *  capped at 60 s by the runtime's watchdog, a conversion takes seconds once warm). */
export const NATIVE_GAUSSIANS_TIMEOUT_MS = 90000;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// ── capabilities ─────────────────────────────────────────────────────────────────────────────

/** The coarse lift state the browser exposes (never provider identity): one of these three. */
export const LIFT_STATES = Object.freeze(['waiting', 'ready', 'unavailable']);

/**
 * Normalise the browser's caps JSON. Unknown modes are dropped; `native` is true only when the
 * browser says so AND the module is not `unavailable` (an `activating` module counts: the browser
 * converts once it is ready, and the element shows its own 2D frame meanwhile).
 *
 * `liftState` is the coarse `waiting | ready | unavailable` the browser derives (its `liftState`
 * field; an older browser's `state` is mapped: activating → waiting). `waiting` is a reason to WAIT,
 * never a reason to take the in-page path (runtime conversion-providers §7.4); only `unavailable`
 * (no lift in the runtime, or an old runtime whose module never came up) is.
 */
export function parseNativeCaps(json) {
  const j = json && typeof json === 'object' ? json : {};
  const state = ['ready', 'activating', 'unavailable'].includes(j.state) ? j.state : j.native ? 'ready' : 'unavailable';
  const liftState = LIFT_STATES.includes(j.liftState) ? j.liftState : state === 'activating' ? 'waiting' : state;
  const out = { native: j.native === true && liftState !== 'unavailable', state, liftState };
  if (typeof j.provider === 'string' && j.provider) out.provider = j.provider;
  out.modes = Array.isArray(j.modes) ? j.modes.filter((m) => MODES.has(m)) : [];
  if (Number.isFinite(j.maxStreams) && j.maxStreams >= 0) out.maxStreams = Math.floor(j.maxStreams);
  if (Number.isFinite(j.approxMsPerConvert) && j.approxMsPerConvert >= 0) out.approxMsPerConvert = +j.approxMsPerConvert;
  // The Gaussians task's own readiness, when the browser reports it (web#341): `modes` lists
  // `gaussians` whenever a converter is INSTALLED, so it cannot tell a failed one from a ready one.
  // Shape: {gaussiansState: {state: ready|warming|installed|downloading|evicted|failed|..., reason?}}.
  const gs = j.gaussiansState;
  if (gs && typeof gs === 'object' && typeof gs.state === 'string' && gs.state) {
    out.gaussiansState = { state: gs.state };
    if (typeof gs.reason === 'string' && gs.reason) out.gaussiansState.reason = gs.reason;
  }
  return out;
}

/**
 * Kept for API compatibility: there is no cache any more. Every liftCapabilities() call asks the
 * browser afresh — a cached non-READY answer is exactly how a cold-booted runtime used to latch the
 * in-page converter for the whole session (runtime conversion-providers §8.1, fix 1).
 */
export function _resetLiftCapabilities() {}

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
    if (!r || !r.ok) return { native: false, state: 'unavailable', liftState: 'unavailable', modes: [] };
    return parseNativeCaps(await r.json());
  } catch (e) {
    if (signal && signal.aborted) throw e; // the CALLER aborted: not an answer
    return { native: false, liftState: 'unavailable' }; // the scheme does not resolve here → not the DXR Browser's lift world
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * What 2D→3D this document can do, right now. Cheap and async, and NEVER cached: the runtime's
 * module warms up after a cold boot, so an answer is only good for the moment it was given. A
 * caller that waits polls this at ≤ 2 Hz (or, in the browser's built-in, takes the browser's
 * state pushes) — it must not keep a non-READY answer beyond one poll interval.
 *
 *   native       the browser's conversion stack is reachable from here (the lift world of the
 *                DisplayXR Browser) and not `unavailable`;
 *   liftState    `waiting | ready | unavailable` (waiting: create anyway, show the 2D source);
 *   provider/modes/maxStreams/approxMsPerConvert/state   as the browser reports them.
 *
 * There is no web fallback to probe: this SDK carries no model of its own.
 *
 * @param {object} [o]
 * @param {AbortSignal} [o.signal]
 * @param {boolean} [o.refresh]  ignored (every call re-asks); kept for compatibility.
 * @param {Function} [o.fetch]  injectable for tests.
 */
export async function liftCapabilities(o = {}) {
  const fetchImpl = o.fetch || ((...a) => globalThis.fetch(...a));
  return queryNative(fetchImpl, o.signal, o.timeoutMs || CAPS_TIMEOUT_MS);
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

/** Below this 99th-percentile splat luminance a native Gaussians result is "black" (web#341). */
export const BLACK_SCENE_LUMA = 0.08;

/**
 * The colour of a 3DGS PLY, from a strided sample of its splats' degree-0 colour
 * (0.5 + C0·f_dc, clamped, Rec. 709 luma). Properties are read by name, so any layout works.
 * Returns null when the bytes are not a little-endian float PLY with f_dc_0..2 (no verdict).
 * @param {Uint8Array} u8
 * @param {number} [maxSamples]
 * @returns {{samples:number, p99:number, mean:number}|null}
 */
export function plyColourStats(u8, maxSamples = 4096) {
  const head = new TextDecoder().decode(u8.subarray(0, Math.min(u8.length, 16384)));
  const endTok = 'end_header\n';
  const end = head.indexOf(endTok);
  if (!head.startsWith('ply') || end < 0 || !/format binary_little_endian 1\.0/.test(head)) return null;
  const count = +(/element vertex (\d+)/.exec(head) || [])[1];
  if (!(count > 0)) return null;
  const sizeOf = { float: 4, float32: 4, double: 8, uchar: 1, uint8: 1, char: 1, int8: 1, short: 2, ushort: 2, int16: 2, uint16: 2, int: 4, uint: 4, int32: 4, uint32: 4 };
  let stride = 0;
  const off = {};
  const vtx = head.slice(head.indexOf('element vertex'), end).split('\nelement ')[0];
  for (const m of vtx.matchAll(/property (\S+) (\S+)/g)) {
    off[m[2]] = { at: stride, type: m[1] };
    stride += sizeOf[m[1]] ?? 4;
  }
  const keys = ['f_dc_0', 'f_dc_1', 'f_dc_2'];
  if (keys.some((k) => !off[k] || (off[k].type !== 'float' && off[k].type !== 'float32'))) return null;
  const base = end + endTok.length;
  if (u8.byteLength - base < count * stride) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset + base, count * stride);
  const step = Math.max(1, Math.floor(count / maxSamples));
  const C0 = 0.28209479177387814;
  const lum = [];
  let sum = 0;
  for (let i = 0; i < count; i += step) {
    const c = keys.map((k) => Math.min(1, Math.max(0, 0.5 + C0 * dv.getFloat32(i * stride + off[k].at, true))));
    const y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    if (!Number.isFinite(y)) continue;
    lum.push(y);
    sum += y;
  }
  if (!lum.length) return null;
  lum.sort((a, b) => a - b);
  return { samples: lum.length, p99: lum[Math.min(lum.length - 1, Math.floor(lum.length * 0.99))], mean: sum / lum.length };
}

/** A native-module failure. `code`: http | unsupported | format | encode | network | aborted | timeout | unavailable | black. */
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
 * Anything else throws NativeLiftError('format').
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
 * The `native` DepthProvider (still frames only): POST the frame to `lift/depth`. A failure rejects
 * with a NativeLiftError (after a 404/501 the module is marked unsupported for the session).
 *
 * @param {object} opts
 * @param {Function} [opts.fetch]
 * @param {string} [opts.provider]  the module's name from caps (diagnostics)
 */
export function createNativeDepthProvider(opts = {}) {
  const fetchImpl = opts.fetch || ((...a) => globalThis.fetch(...a));
  const info = { backend: 'native', provider: opts.provider || null, calls: 0, lastError: null, lastMs: 0, unsupported: false };
  let disposed = false;

  return {
    id: 'native',
    kind: 'still',
    info,
    /** Nothing to load: the module lives in the runtime. */
    async load() {},
    /** Rejects with a NativeLiftError when the module cannot answer: there is no in-page fallback. */
    async estimate({ source, signal } = {}) {
      if (disposed) throw new Error('native depth: disposed');
      if (info.unsupported) throw new NativeLiftError('native depth: not supported by this module', 'unsupported');
      info.calls++;
      try {
        const blob = await encodeFrame(source);
        const t0 = now();
        const r = await post(fetchImpl, NATIVE_DEPTH_URL, blob, signal);
        const d = await parseNativeDepthResponse(r);
        info.lastMs = Math.round(now() - t0);
        info.source = 'native';
        return d;
      } catch (e) {
        info.lastError = (e && e.message) || String(e);
        if (e && e.code === 'unsupported') info.unsupported = true;
        throw e;
      }
    },
    reset() {},
    dispose() {
      disposed = true;
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
 * it is a `format` error.
 */
export function createNativeGaussiansLift(opts = {}) {
  const fetchImpl = opts.fetch || ((...a) => globalThis.fetch(...a));
  const timeoutMs = opts.timeoutMs > 0 ? opts.timeoutMs : NATIVE_GAUSSIANS_TIMEOUT_MS;
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
      // Bounded (web#341): a converter that is installed but fails to load never answers this
      // POST with an error today (the browser reads its failed job as not-ready until its own
      // 180 s deadline), so the page would sit in `lifting` for minutes. Our own abort ends it
      // with a `timeout` error; the caller's signal still wins. A ticking elapsed count keeps
      // the chip visibly alive meanwhile.
      const ctl = new AbortController();
      let timedOut = false;
      const onAbort = () => ctl.abort();
      if (signal) {
        if (signal.aborted) throw new NativeLiftError('native lift: aborted', 'aborted');
        signal.addEventListener('abort', onAbort, { once: true });
      }
      const timer = setTimeout(() => {
        timedOut = true;
        ctl.abort();
      }, timeoutMs);
      const tick = onProgress ? setInterval(() => onProgress({ stage: 'lifting', progress: 0.1, elapsedS: (now() - t0) / 1000 }), 1000) : null;
      let r, u8;
      try {
        r = await post(fetchImpl, NATIVE_GAUSSIANS_URL, blob, ctl.signal);
        u8 = new Uint8Array(await r.arrayBuffer());
      } catch (e) {
        if (timedOut && !(signal && signal.aborted))
          throw new NativeLiftError(`native gaussians: no answer within ${Math.round(timeoutMs / 1000)} s`, 'timeout');
        if (signal && signal.aborted) throw new NativeLiftError('native lift: aborted', 'aborted');
        if (e && e.code === 'unsupported') unsupported = true;
        throw e;
      } finally {
        clearTimeout(timer);
        if (tick) clearInterval(tick);
        if (signal) signal.removeEventListener('abort', onAbort);
      }
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
        // "The generator's meta shape": the generator's PLY is OpenCV (camera at the origin looking
        // +z, y down). A header that names no convention means that — NOT explore's own 'opengl'
        // default, under which a +z scene sits behind the camera and explore draws solid black.
        if (!meta.axes && !meta.convention) meta.axes = 'opencv';
        // A scene whose every splat is black came from a black frame (web#341: a runtime readback
        // without its keyed mutex, runtime #2830). Say so rather than open an empty black scene.
        const col = plyColourStats(u8);
        if (col && col.p99 < BLACK_SCENE_LUMA) {
          throw new NativeLiftError(
            `native gaussians: the scene is black (99th-percentile splat luminance ${col.p99.toFixed(3)} over ${col.samples} samples) — the frame it was made from was black`,
            'black',
            { colour: col },
          );
        }
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

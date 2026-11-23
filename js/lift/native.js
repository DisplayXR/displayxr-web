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
import { liftMetaFromSogMeta } from './sog-input.js';

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

/**
 * Can Explore be offered for these caps? Explore opens a Gaussian scene, so it needs a stage that
 * makes one: the runtime's GAUSSIANS converter (caps `modes` lists 'gaussians' — the runtime
 * advertises it only with a photo → splats provider, on every OS) or a lift provider the page
 * passed. Depth alone is not enough: there is no depth-built explore scene. The chip hides its
 * Explore button when this is false and keeps Exit.
 */
export function exploreAvailable(caps, providers = {}) {
  return !!defaultLiftProviderFor(caps, providers);
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
 * The long side of the photo `native-gaussians` sends: the cloud SHARP client's 1536
 * (providers/lift-remote-sharp.js `maxSide`). Photo models infer far below a camera's native size,
 * so a 24 MP frame costs an encode, an upload and a runtime downscale for nothing.
 */
export const GAUSSIANS_MAX_SIDE = 1536;

/**
 * The frame as an image Blob for the native endpoints (JPEG: the module resamples anyway, and the
 * encode is ~10× cheaper than PNG). A Blob passes through. `maxSide` (0 = none) caps the long side,
 * aspect kept, never upscaling.
 */
export async function encodeFrame(src, opts = {}) {
  return (await encodeFrameSized(src, opts)).blob;
}

/**
 * encodeFrame + the size that was sent: `{blob, w, h, srcW, srcH}` (all 0 for a Blob passed
 * through: its pixels are not known here).
 */
export async function encodeFrameSized(src, { type = 'image/jpeg', quality = 0.92, maxSide = 0, createCanvas } = {}) {
  if (typeof Blob !== 'undefined' && src instanceof Blob) return { blob: src, w: 0, h: 0, srcW: 0, srcH: 0 };
  const { w: sw, h: sh } = sizeOf(src || {});
  if (!(sw > 0 && sh > 0)) throw new NativeLiftError('native lift: the frame has no size', 'encode');
  const s = maxSide > 0 ? Math.min(1, maxSide / Math.max(sw, sh)) : 1;
  const w = Math.max(1, Math.round(sw * s));
  const h = Math.max(1, Math.round(sh * s));
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
  return { blob, w, h, srcW: sw, srcH: sh };
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
  if (!r.ok) {
    // 502 is also how the browser reports a conversion the runtime said FAILED (XR_DXR_lift spec 6,
    // XR_ERROR_LIFT_CONVERSION_FAILED_DXR): at once, not after the endpoint's timeout.
    let detail = '';
    try {
      const d = r.headers && r.headers.get('x-dxr-lift-error');
      detail = d ? ` (${d})` : '';
    } catch {
      detail = '';
    }
    throw new NativeLiftError(`native lift: ${url} → HTTP ${r.status}${detail}`, 'http', { status: r.status });
  }
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
 * A JSON object the browser sent base64-encoded in a header (UTF-8 inside), or null.
 * `X-DXR-Lift-Camera` / `X-DXR-Lift-Facts` travel this way: a header value must be ASCII.
 */
export function decodeHeaderJson(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const j = JSON.parse(new TextDecoder().decode(b64ToBytes(value.trim())));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
  } catch {
    return null;
  }
}

/** The vertex count in a binary PLY's header, or 0. */
export function plyVertexCount(u8) {
  try {
    const head = new TextDecoder().decode(u8.subarray(0, Math.min(u8.length, 16384)));
    const end = head.indexOf('end_header');
    if (!head.startsWith('ply') || end < 0) return 0;
    const n = +(/element vertex (\d+)/.exec(head.slice(0, end)) || [])[1];
    return n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * A focal for a camera block that carries no intrinsics (the provider reported none and the
 * runtime assumes nothing): the splats' own robust angular extent. The 98th percentile of |x/z|
 * over the splats in front of the camera spans half the frame width `w`. 0 when the cloud says
 * nothing (fewer than 16 splats in front, or not a PLY this reader parses).
 */
export async function focalFromPlyExtent(plyU8, w) {
  if (!(w > 0)) return 0;
  const { parseGaussianPly } = await import('./sog-export.js');
  let s;
  try {
    s = parseGaussianPly(plyU8);
  } catch {
    return 0;
  }
  const t = [];
  const p = s.positions;
  const step = Math.max(1, Math.floor(s.count / 200000)); // a subsample is plenty for a percentile
  for (let i = 0; i < s.count; i += step) {
    const z = p[i * 3 + 2];
    if (z > 1e-6) t.push(Math.abs(p[i * 3] / z));
  }
  if (t.length < 16) return 0;
  t.sort((x, y) => x - y);
  const tx = t[Math.min(t.length - 1, Math.floor(t.length * 0.98))];
  return tx > 0 ? w / 2 / tx : 0;
}

/**
 * The lift meta for a runtime `.ply`, built the way the cloud path builds it from a `.sog`
 * (providers/lift-remote-sharp.js → readLiftSog → liftMetaFromSogMeta). The runtime's camera block
 * v2 (`X-DXR-Lift-Camera`, XR_DXR_lift spec 6: the same JSON object a SOG's meta.json carries as
 * `camera`) goes through the SAME parser, so explore frames a local lift exactly as a cloud one:
 * focalPx / w / h from `camera.intrinsics`, pivotZ = `camera.focus.point[2]`, axes 'opencv'.
 *
 *   camera   the runtime's block, a parsed JSON object; kept VERBATIM on `meta.cameraBlock`, which
 *            is what Download embeds (never a block rebuilt from pivotZ)
 *   facts    the provider's facts (`meta.facts`; `facts.intrinsics.source` = given / estimated / …)
 *   legacy   the `X-DXR-Lift-Meta` header ({focalPx, w, h}) of a browser or runtime without the
 *            block. Then, and only then, pivotZ falls back to 2.
 *   sent     {w, h} of the image POSTed (the block's intrinsics are in those pixels)
 *   ply      the PLY bytes (vertex count; the focal fallback when the block has no intrinsics)
 *
 * Returns null when there is neither a block nor a usable legacy meta.
 */
export async function nativeLiftMeta({ camera, facts, legacy, sent = {}, ply } = {}) {
  const u8 = ply instanceof Uint8Array ? ply : ply ? new Uint8Array(ply) : null;
  const count = u8 ? plyVertexCount(u8) : 0;
  if (camera && typeof camera === 'object') {
    const w = +sent.w || +legacy?.w || 0;
    const h = +sent.h || +legacy?.h || 0;
    const fallback = { w, h };
    if (!(+camera.intrinsics?.fx > 0)) {
      // No lens in the block: nothing was assumed upstream, and nothing is assumed here either.
      const f = u8 ? await focalFromPlyExtent(u8, w) : 0;
      if (f > 0) fallback.focalPx = f;
    }
    let meta;
    try {
      meta = liftMetaFromSogMeta({ version: 2, count, camera }, fallback);
    } catch (e) {
      throw new NativeLiftError(`native gaussians: the camera block is unusable (${e.message})`, 'format');
    }
    meta.cameraBlock = camera;
    if (facts) meta.facts = facts;
    meta.focalSource = facts?.intrinsics?.source ?? (meta.intrinsics ? null : 'splat-extent');
    return meta;
  }
  // An older browser or runtime: the {focalPx, w, h} header alone, and no screen plane.
  const meta = legacy && typeof legacy === 'object' ? { ...legacy } : null;
  if (!meta || !(meta.focalPx > 0) || !(meta.w > 0) || !(meta.h > 0)) return null;
  if (!(meta.pivotZ > 0)) meta.pivotZ = 2;
  // "The generator's meta shape": the generator's PLY is OpenCV (camera at the origin looking
  // +z, y down). A header that names no convention means that — NOT explore's own 'opengl'
  // default, under which a +z scene sits behind the camera and explore draws solid black.
  if (!meta.axes && !meta.convention) meta.axes = 'opencv';
  if (count && !meta.splatCount) meta.splatCount = count;
  return meta;
}

/**
 * The `native-gaussians` LiftProvider (the remote-sharp contract, docs/lift.md § Provider
 * interfaces): `{ id, needsDepth:false, generateLift({rgb, depth?, signal, onProgress}) → {sog} | {ply, meta} }`.
 *
 * It sends what the cloud SHARP client sends: a JPEG, long side ≤ GAUSSIANS_MAX_SIDE (1536), and a
 * focal (`?focalPx=`, in pixels of the JPEG sent) ONLY when the caller knows one. With none the
 * runtime's provider estimates it and says so in its facts: nothing here assumes a field of view.
 *
 * A `.sog` carries its own camera block v2 (explore reads the rig off it). A `.ply` comes with the
 * runtime's camera block (`X-DXR-Lift-Camera`, base64 JSON, XR_DXR_lift spec 6) and is framed by
 * the cloud path's parser (nativeLiftMeta). An older browser sends only `X-DXR-Lift-Meta`
 * ({focalPx, w, h}); a `.ply` with neither header is a `format` error.
 */
export function createNativeGaussiansLift(opts = {}) {
  const fetchImpl = opts.fetch || ((...a) => globalThis.fetch(...a));
  const maxSide = opts.maxSide === undefined ? GAUSSIANS_MAX_SIDE : +opts.maxSide || 0;
  let unsupported = false;
  return {
    id: 'native-gaussians',
    needsDepth: false,
    provider: opts.provider || null,
    async load() {},
    async generateLift({ rgb, depth, signal, onProgress } = {}) {
      if (unsupported) throw new NativeLiftError('native gaussians: not supported by this module', 'unsupported');
      const t0 = now();
      const enc = await encodeFrameSized(rgb, { maxSide, createCanvas: opts.createCanvas });
      // A focal only when the caller has one (lift-remote-sharp.js's rule), restated in pixels of
      // the JPEG sent. lift.js hands a still depth's focal in pixels of the frozen bitmap
      // (`focalGridW`); a raw depth map's is in its own grid (`w`).
      const fp = +depth?.intrinsics?.focalPx;
      const gridW = +depth?.intrinsics?.focalGridW || +depth?.w || enc.srcW || enc.w;
      const focalSent = fp > 0 && gridW > 0 && enc.w > 0 ? (fp * enc.w) / gridW : null;
      const url = focalSent ? `${NATIVE_GAUSSIANS_URL}?focalPx=${+focalSent.toFixed(3)}` : NATIVE_GAUSSIANS_URL;
      if (onProgress) onProgress({ stage: 'lifting', progress: 0.1, elapsedS: 0 });
      let r;
      try {
        r = await post(fetchImpl, url, enc.blob, signal);
      } catch (e) {
        if (e && e.code === 'unsupported') unsupported = true;
        throw e;
      }
      const u8 = new Uint8Array(await r.arrayBuffer());
      const fmtName = sniffSplatFormat(u8);
      const ms = Math.round(now() - t0);
      if (onProgress) onProgress({ stage: 'lifting', progress: 1, elapsedS: ms / 1000 });
      const sent = { w: enc.w, h: enc.h, bytes: enc.blob.size, focalPx: focalSent };
      if (fmtName === 'sog') return { sog: u8, meta: { sent, timings: { nativeMs: ms } } };
      if (fmtName === 'ply') {
        const H = (k) => (r.headers && r.headers.get(k)) || null;
        let legacy = null;
        try {
          legacy = JSON.parse(H('x-dxr-lift-meta') || 'null');
        } catch {
          legacy = null;
        }
        const meta = await nativeLiftMeta({
          camera: decodeHeaderJson(H('x-dxr-lift-camera')),
          facts: decodeHeaderJson(H('x-dxr-lift-facts')),
          legacy,
          sent,
          ply: u8,
        });
        if (!meta) {
          throw new NativeLiftError('native gaussians: a .ply needs an X-DXR-Lift-Camera (or X-DXR-Lift-Meta) header', 'format');
        }
        return { ply: u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength), meta: { ...meta, sent, timings: { nativeMs: ms } } };
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

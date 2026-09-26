// providers/lift-remote-sharp.js — DEMO ONLY: a REMOTE Gaussian-splat lift provider that sends the
// frozen frame to a SHARP worker (the gallery's Modal `sharp-sog` worker: Apple's SHARP, Leia's
// fork of the serving code) and gets back a SHARP-quality `.sog` for the explore view.
//
//   import { createRemoteSharpLift } from '@displayxr/inline3d/lift';
//   const h = await lift(img, { providers: { lift: 'remote-sharp' }, remote: { endpoint: '/api/sharp/predict' } });
//
// LICENCE: SHARP's weights are under Apple's ML Research Model License — research purposes only,
// no commercial product use, and the restriction follows derivatives. This provider exists for
// demos. It is opt-in (never the default), never bundled with any model, and must not ship in an
// OEM/product build. Needs the network; every lift is a round trip to a GPU worker (~8.5 s warm,
// ~40 s cold on an L4) — see docs/lift.md § Remote SHARP.
//
// THE LiftProvider CONTRACT (docs/lift.md § Provider interfaces):
//   { id, needsDepth, load?(), generateLift({rgb, depth?, signal, onProgress}) → {sog|ply, meta},
//     signIn?(), dispose() }
// A remote lift returns `sog` (the worker's bytes, untouched) instead of `ply`; `meta` is read off
// the file's own camera block v2 (intrinsics + focus), so the neutral explore view is the photo.
//
// WIRE: `POST endpoint` multipart/form-data — `mode` (mono), `image` (a JPEG of the frame, long
// side ≤ 1536 px: SHARP resamples to its fixed 1536² grid anyway), `focal_length_px` (only when the
// caller knows it, in pixels of the JPEG sent; the worker ignores it in `spatial` mode). Response:
// binary `.sog`. The default endpoint is a SAME-ORIGIN path: the page's server (samples/lift/serve.py
// --sharp, or the gallery's /api/sharp/predict) adds the worker's bearer token — a page never holds
// it. `auth: { kind: 'google', loginUrl }` instead signs the viewer in through a popup and sends
// their access token (the gallery's hosted endpoint).
//
// ERRORS are RemoteLiftError with a `code`; `fallback` is true for everything except a caller
// abort, and lift.js then lifts locally (MoGe + the generator).

import { getRegistry } from './registry.js';
import { readLiftSog } from '../sog-input.js';

export const REMOTE_SHARP_DEFAULTS = Object.freeze({
  endpoint: '/api/sharp/predict',
  warmIntervalMs: 5 * 60 * 1000, // pre-warm at most once per 5 min (the relay rate-limits it too)
  timeoutMs: 90000,
  mode: 'mono',
  maxSide: 1536,
  jpegQuality: 0.92,
  /** Hard cap on the upload: the gallery relay runs on Vercel, which rejects bodies > 4.5 MB
   *  before the route runs. A frame over it is re-encoded smaller (quality, then size). */
  maxBytes: 4_000_000,
  /** Typical warm round trip, ms: only shapes the 'waiting' progress curve. */
  expectedMs: 9000,
});

/** A remote lift failure. `code`: aborted | timeout | http | auth | forbidden | quota | too-large |
 *  network | format | encode | popup-blocked | popup-closed. `fallback`: lift.js may lift locally
 *  instead (everything but a caller abort — a 403/429 still gets the viewer a local 3D scene, with
 *  the reason on the chip). */
export class RemoteLiftError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'RemoteLiftError';
    this.code = code;
    this.fallback = code !== 'aborted';
    Object.assign(this, extra);
  }
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function sizeOf(src) {
  if (!src) return { w: 0, h: 0 };
  const w = src.videoWidth || src.naturalWidth || src.displayWidth || src.codedWidth || src.width || 0;
  const h = src.videoHeight || src.naturalHeight || src.displayHeight || src.codedHeight || src.height || 0;
  return { w: +w || 0, h: +h || 0 };
}

/**
 * The frame as a JPEG, long side ≤ maxSide. A Blob passes through untouched (w/h from `size`).
 * @returns {Promise<{blob:Blob, w:number, h:number, srcW:number, srcH:number}>}
 */
export async function encodeJpeg(rgb, { maxSide = REMOTE_SHARP_DEFAULTS.maxSide, quality = REMOTE_SHARP_DEFAULTS.jpegQuality, maxBytes = REMOTE_SHARP_DEFAULTS.maxBytes, size, createCanvas } = {}) {
  if (typeof Blob !== 'undefined' && rgb instanceof Blob) {
    if (maxBytes > 0 && rgb.size > maxBytes) {
      throw new RemoteLiftError(`remote lift: the image is ${(rgb.size / 1e6).toFixed(1)} MB, over the ${(maxBytes / 1e6).toFixed(1)} MB upload cap`, 'too-large');
    }
    const w = +size?.w || 0, h = +size?.h || 0;
    return { blob: rgb, w, h, srcW: w, srcH: h };
  }
  // Under the cap first by quality, then by size (a noisy 1536-px frame at q 0.92 is ~0.5-1.5 MB,
  // so this only bites on pathological input or a raised maxSide).
  let side = maxSide;
  let q = quality;
  for (let i = 0; i < 8; i++) {
    const r = await encodeOnce(rgb, side, q, createCanvas);
    if (!(maxBytes > 0) || r.blob.size <= maxBytes) return r;
    if (q > 0.72) q = Math.max(0.7, q - 0.1);
    else side = Math.round(Math.max(r.w, r.h) * 0.75);
  }
  throw new RemoteLiftError(`remote lift: could not encode the frame under ${(maxBytes / 1e6).toFixed(1)} MB`, 'too-large');
}

async function encodeOnce(rgb, maxSide, quality, createCanvas) {
  const { w: sw, h: sh } = sizeOf(rgb);
  if (!(sw > 0 && sh > 0)) throw new RemoteLiftError('remote lift: the frame has no size (not decoded yet?)', 'encode');
  const s = Math.min(1, maxSide / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * s));
  const h = Math.max(1, Math.round(sh * s));
  const canvas = createCanvas
    ? createCanvas(w, h)
    : typeof OffscreenCanvas === 'function'
      ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new RemoteLiftError('remote lift: no 2D context to encode the frame', 'encode');
  ctx.drawImage(rgb, 0, 0, w, h);
  const blob = typeof canvas.convertToBlob === 'function'
    ? await canvas.convertToBlob({ type: 'image/jpeg', quality })
    : await new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality));
  if (!blob) throw new RemoteLiftError('remote lift: JPEG encode failed', 'encode');
  return { blob, w, h, srcW: sw, srcH: sh, quality };
}

/** expiresAt → epoch ms. Numbers below 1e12 are epoch SECONDS (JWT `exp` style); 0 = unknown. */
export function normalizeExpiry(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string' && v) {
    const n = Number(v);
    if (Number.isFinite(n)) return normalizeExpiry(n);
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : 0;
  }
  return 0;
}

/**
 * Popup sign-in (`auth: { kind: 'google', loginUrl }`). Opens `loginUrl` in a centred ~480×640
 * popup and waits for `postMessage({ type: 'dxr-auth', accessToken, expiresAt })` FROM THAT ORIGIN
 * (anything else is ignored). The token is cached in memory (never storage) until 30 s before
 * `expiresAt`. A page that opens this outside a user gesture will usually be popup-blocked: call
 * `signIn()` from a click first (the sample's Sign-in button does).
 *
 * The opener must not be cut off by the page's own headers: `Cross-Origin-Opener-Policy:
 * same-origin` severs a cross-origin popup (it reads as closed at once and cannot post back).
 * Serve the page with `same-origin-allow-popups` (serve.py --allow-popups) when logging in.
 */
export function createPopupAuth({ loginUrl, win = typeof window !== 'undefined' ? window : undefined, width = 480, height = 640, timeoutMs = 300000, skewMs = 30000 } = {}) {
  if (!loginUrl) throw new TypeError("remote lift: auth kind 'google' needs a loginUrl");
  if (!win || typeof win.open !== 'function') throw new TypeError('remote lift: popup sign-in needs a window');
  const base = win.location && win.location.href ? win.location.href : undefined;
  const url = new URL(loginUrl, base);
  const origin = url.origin;
  // The popup posts only to the origin it is told (and the relay has allow-listed): tell it ours.
  const pageOrigin = win.location && win.location.origin ? win.location.origin : base ? new URL(base).origin : null;
  if (pageOrigin && !url.searchParams.has('origin')) url.searchParams.set('origin', pageOrigin);
  let cached = null; // { token, expiresAt }
  let pending = null;

  const valid = () => !!cached && (!cached.expiresAt || cached.expiresAt - skewMs > Date.now());

  function signIn() {
    if (pending) return pending;
    pending = new Promise((resolve, reject) => {
      const sx = +win.screenX || +win.screenLeft || 0;
      const sy = +win.screenY || +win.screenTop || 0;
      const ow = +win.outerWidth || width;
      const oh = +win.outerHeight || height;
      const left = Math.round(sx + Math.max(0, (ow - width) / 2));
      const top = Math.round(sy + Math.max(0, (oh - height) / 2));
      const t0 = Date.now();
      const popup = win.open(url.href, 'dxr-auth', `popup=yes,width=${width},height=${height},left=${left},top=${top}`);
      if (!popup) {
        reject(new RemoteLiftError('remote lift: the sign-in popup was blocked (call signIn() from a click)', 'popup-blocked'));
        return;
      }
      let done = false;
      const finish = (err, token) => {
        if (done) return;
        done = true;
        win.removeEventListener('message', onMsg);
        clearInterval(poll);
        clearTimeout(timer);
        try {
          if (!popup.closed) popup.close();
        } catch {
          /* cross-origin close can throw on some browsers; harmless */
        }
        if (err) reject(err);
        else resolve(token);
      };
      const onMsg = (ev) => {
        if (!ev || ev.origin !== origin) return; // only the login origin may hand us a token
        const d = ev.data;
        if (!d || typeof d !== 'object' || d.type !== 'dxr-auth') return;
        if (typeof d.accessToken !== 'string' || !d.accessToken) {
          finish(new RemoteLiftError(`remote lift: sign-in failed${d.error ? ` (${d.error})` : ''}`, 'auth'));
          return;
        }
        cached = { token: d.accessToken, expiresAt: normalizeExpiry(d.expiresAt), email: typeof d.email === 'string' ? d.email : null };
        finish(null, d.accessToken);
      };
      win.addEventListener('message', onMsg);
      const poll = setInterval(() => {
        let closed = false;
        try {
          closed = !!popup.closed;
        } catch {
          closed = false;
        }
        if (!closed) return;
        const hint = Date.now() - t0 < 1500
          ? ' — it closed at once: is the page served with Cross-Origin-Opener-Policy: same-origin? Use same-origin-allow-popups.'
          : '';
        finish(new RemoteLiftError(`remote lift: the sign-in popup was closed before signing in${hint}`, 'popup-closed'));
      }, 400);
      const timer = setTimeout(() => finish(new RemoteLiftError('remote lift: sign-in timed out', 'auth')), timeoutMs);
    }).finally(() => {
      pending = null;
    });
    return pending;
  }

  return {
    origin,
    /** The cached token if still valid, else a popup sign-in. `force` skips the cache. */
    async getToken({ force = false } = {}) {
      if (!force && valid()) return cached.token;
      return signIn();
    },
    signIn,
    clear() {
      cached = null;
    },
    get signedIn() {
      return valid();
    },
    /** The signed-in account's email, when the popup sent one. */
    get email() {
      return cached ? cached.email : null;
    },
  };
}

/**
 * @param {object} [o]
 * @param {string} [o.endpoint='/api/sharp/predict']  same-origin proxy by default.
 * @param {number} [o.timeoutMs=90000]  whole request (encode → last byte).
 * @param {'mono'|'sbs'|'spatial'} [o.mode='mono']
 * @param {undefined|{kind:'bearer', token:string}|{kind:'google', loginUrl:string}} [o.auth]
 *        undefined = no Authorization header (the proxy adds the worker's).
 * @param {() => (Record<string,string>|Promise<Record<string,string>>)} [o.getAuthHeaders]  extra
 *        headers per request (merged last).
 * @param {Record<string,string|number>} [o.fields]  extra form fields (e.g. `{ crop: 'left' }`).
 * @param {number} [o.maxSide=1536]  @param {number} [o.jpegQuality=0.92]
 * @param {typeof fetch} [o.fetch]  @param {Window} [o.window]  (tests)
 */
export function createRemoteSharpLift(o = {}) {
  const cfg = { ...REMOTE_SHARP_DEFAULTS, ...Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) };
  const fetchImpl = o.fetch || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
  if (!fetchImpl) throw new TypeError('remote lift: no fetch');
  const auth = o.auth || null;
  let popupAuth = null;
  if (auth && auth.kind === 'google') popupAuth = createPopupAuth({ loginUrl: auth.loginUrl, win: o.window });
  else if (auth && auth.kind !== 'bearer') throw new TypeError(`remote lift: unknown auth kind ${JSON.stringify(auth.kind)}`);
  let disposed = false;

  // Pre-warm: the hosted worker scales to zero and takes ~40 s to start, so the first lift of a
  // session paid the cold start on top of the ~8 s inference. `warm()` hits `<endpoint dir>/warm`
  // (same auth as predict; the relay forwards a health call that starts a container) so the cold
  // start overlaps with the user browsing. Fire-and-forget, throttled, never throws.
  let lastWarm = 0;
  async function warm() {
    if (disposed) return false;
    const t = now();
    if (t - lastWarm < cfg.warmIntervalMs) return false;
    lastWarm = t;
    try {
      const headers = await authHeaders(false);
      const url = cfg.endpoint.replace(/\/[^/]*$/, '/warm');
      const res = await fetchImpl(url, { method: 'GET', headers, credentials: 'same-origin', cache: 'no-store' });
      return !!(res && res.ok);
    } catch {
      return false;
    }
  }

  async function authHeaders(force) {
    const h = {};
    if (auth && auth.kind === 'bearer' && auth.token) h.Authorization = `Bearer ${auth.token}`;
    if (popupAuth) h.Authorization = `Bearer ${await popupAuth.getToken({ force })}`;
    if (typeof o.getAuthHeaders === 'function') Object.assign(h, (await o.getAuthHeaders()) || {});
    return h;
  }

  /**
   * @param {{rgb:ImageBitmap|HTMLCanvasElement|Blob, depth?:{intrinsics?:{focalPx?:number, focalGridW?:number}, w?:number},
   *          signal?:AbortSignal, onProgress?:(p:{stage:string, progress:number, elapsedS:number, loaded?:number, total?:number})=>void,
   *          size?:{w:number,h:number}}} a
   * @returns {Promise<{sog:ArrayBuffer, meta:object}>}
   */
  async function generateLift(a = {}) {
    if (disposed) throw new RemoteLiftError('remote lift: disposed', 'aborted');
    const t0 = now();
    const elapsedS = () => +((now() - t0) / 1000).toFixed(1);
    const report = (stage, progress, extra) => {
      try {
        a.onProgress?.({ stage, progress: Math.max(0, Math.min(1, progress)), elapsedS: elapsedS(), ...(extra || {}) });
      } catch {
        /* a progress listener must not break the lift */
      }
    };
    const ctl = new AbortController();
    let timedOut = false;
    const onAbort = () => ctl.abort();
    if (a.signal) {
      if (a.signal.aborted) throw new RemoteLiftError('remote lift: aborted', 'aborted');
      a.signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      ctl.abort();
    }, cfg.timeoutMs);
    let ticker = null;
    const stopTicker = () => {
      if (ticker) clearInterval(ticker);
      ticker = null;
    };
    const classify = (e) => {
      if (e instanceof RemoteLiftError) return e;
      if (ctl.signal.aborted) {
        return timedOut
          ? new RemoteLiftError(`remote lift: no answer within ${Math.round(cfg.timeoutMs / 1000)} s`, 'timeout', { cause: e })
          : new RemoteLiftError('remote lift: aborted', 'aborted', { cause: e });
      }
      return new RemoteLiftError(`remote lift: network error (${e && e.message ? e.message : e})`, 'network', { cause: e });
    };
    const guard = (p) =>
      new Promise((resolve, reject) => {
        // Resolve/reject on abort even if the awaited thing ignores the signal (encode, a stuck body).
        const off = () => reject(classify(new Error('aborted')));
        if (ctl.signal.aborted) return off();
        ctl.signal.addEventListener('abort', off, { once: true });
        Promise.resolve(p).then(
          (v) => { ctl.signal.removeEventListener('abort', off); resolve(v); },
          (e) => { ctl.signal.removeEventListener('abort', off); reject(e); },
        );
      });
    try {
      report('encoding', 0);
      const enc = await guard(encodeJpeg(a.rgb, { maxSide: cfg.maxSide, quality: cfg.jpegQuality, maxBytes: cfg.maxBytes, size: a.size, createCanvas: o.createCanvas }));
      const tEnc = now();
      // Focal, in pixels of the JPEG we send. lift.js hands the still depth's focal already in
      // pixels of the frozen bitmap (`focalGridW`); a raw depth map's is in its own grid (`w`).
      const fp = +a.depth?.intrinsics?.focalPx;
      const gridW = +a.depth?.intrinsics?.focalGridW || +a.depth?.w || enc.srcW || enc.w;
      const focalSent = fp > 0 && gridW > 0 && enc.w > 0 ? (fp * enc.w) / gridW : null;
      const form = new FormData();
      form.append('mode', cfg.mode);
      form.append('image', enc.blob, 'frame.jpg');
      if (focalSent && cfg.mode !== 'spatial') form.append('focal_length_px', String(+focalSent.toFixed(3)));
      for (const [k, v] of Object.entries(cfg.fields || {})) form.append(k, String(v));

      const send = async (retried) => {
        const headers = await guard(authHeaders(retried));
        report('uploading', 0.02, { bytes: enc.blob.size });
        const tReq = now();
        ticker = setInterval(() => {
          const x = now() - tReq;
          report('waiting', 0.05 + 0.85 * (1 - Math.exp(-x / cfg.expectedMs)));
        }, 250);
        let res;
        try {
          res = await guard(fetchImpl(cfg.endpoint, { method: 'POST', body: form, headers, signal: ctl.signal, credentials: 'same-origin' }));
        } finally {
          stopTicker();
        }
        if (res.status === 401 && popupAuth && !retried) {
          popupAuth.clear();
          return send(true); // one re-login, then give up
        }
        return { res, tReq };
      };
      const { res, tReq } = await send(false);
      const tHead = now();
      if (!res.ok) {
        let body = '';
        try {
          body = (await guard(res.text())).slice(0, 300);
        } catch {
          /* no body */
        }
        let detail = body;
        try {
          const j = JSON.parse(body);
          if (j && typeof j.error === 'string') detail = j.error;
        } catch {
          /* not JSON */
        }
        // The relay's codes (docs/sharp-relay.md in the gallery): 401 was already retried once.
        const st = res.status;
        const code = st === 401 ? 'auth' : st === 403 ? 'forbidden' : st === 429 ? 'quota' : st === 413 ? 'too-large' : 'http';
        const what =
          st === 401 ? 'sign-in required or expired'
          : st === 403 ? 'account not allowed'
          : st === 429 ? `quota reached${res.headers.get('retry-after') ? ` (retry in ${res.headers.get('retry-after')} s)` : ''}`
          : st === 413 ? 'image too large for the relay'
          : `${st} ${res.statusText || ''}`.trim();
        throw new RemoteLiftError(`remote lift: ${what}` + (detail ? ` — ${detail}` : ''), code, {
          status: st,
          retryAfterS: +res.headers.get('retry-after') || undefined,
        });
      }
      const total = +res.headers.get('content-length') || 0;
      // The gallery relay's cache verdict + its own time to first byte (absent via serve.py).
      const via = res.headers.get('x-dxr-sharp');
      const cacheHit = via ? via === 'cache-hit' : null;
      const serverMs = +res.headers.get('x-dxr-sharp-ms') || null;
      let bytes;
      if (res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader();
        const parts = [];
        let loaded = 0;
        for (;;) {
          const { done, value } = await guard(reader.read());
          if (done) break;
          parts.push(value);
          loaded += value.length;
          report('downloading', total ? 0.9 + 0.1 * (loaded / total) : 0.95, { loaded, total, cacheHit, serverMs });
        }
        bytes = new Uint8Array(loaded);
        let off = 0;
        for (const p of parts) {
          bytes.set(p, off);
          off += p.length;
        }
      } else {
        bytes = new Uint8Array(await guard(res.arrayBuffer()));
      }
      report('downloading', 1, { loaded: bytes.length, total: total || bytes.length, cacheHit, serverMs });
      const tEnd = now();
      const hdrFocal = +res.headers.get('x-sharp-focal-px');
      let parsed;
      try {
        parsed = await readLiftSog(bytes, { focalPx: hdrFocal > 0 ? hdrFocal : focalSent || undefined, w: enc.w, h: enc.h });
      } catch (e) {
        throw new RemoteLiftError(`remote lift: the answer is not a usable .sog (${e.message})`, 'format', { cause: e });
      }
      const meta = {
        ...parsed.meta,
        source: 'remote-sharp',
        cacheHit,
        serverMs,
        sent: { w: enc.w, h: enc.h, bytes: enc.blob.size, quality: enc.quality, focalPx: focalSent, mode: cfg.mode },
        sharp: {
          focalPx: hdrFocal > 0 ? hdrFocal : null,
          focalSource: res.headers.get('x-sharp-focal-source'),
        },
        timings: {
          encodeMs: Math.round(tEnc - t0),
          requestMs: Math.round(tHead - tReq),
          downloadMs: Math.round(tEnd - tHead),
          totalMs: Math.round(tEnd - t0),
          bytes: bytes.length,
        },
      };
      const sog = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;
      return { sog, meta };
    } catch (e) {
      throw classify(e);
    } finally {
      stopTicker();
      clearTimeout(timer);
      if (a.signal) a.signal.removeEventListener('abort', onAbort);
    }
  }

  return {
    id: 'remote-sharp',
    kind: 'lift',
    /** No local depth needed: lift.js skips the still model unless it has to fall back. */
    needsDepth: false,
    endpoint: cfg.endpoint,
    load() {
      // Warm the worker as soon as we can authenticate without a popup (bearer, no auth, or a
      // cached Google token); the popup case warms right after signIn() instead.
      if (!popupAuth || popupAuth.signedIn) void warm();
      return Promise.resolve();
    },
    generateLift,
    /** Popup sign-in now (auth kind 'google'); call it from a click so it is not popup-blocked. */
    async signIn() {
      const r = popupAuth ? await popupAuth.signIn() : null;
      void warm();
      return r;
    },
    /** Start the hosted worker's container ahead of the first lift (throttled; never throws). */
    warm,
    get signedIn() {
      return popupAuth ? popupAuth.signedIn : true;
    },
    get email() {
      return popupAuth ? popupAuth.email : null;
    },
    dispose() {
      disposed = true;
    },
  };
}

// Opt-in: registered at a NEGATIVE priority and flagged optIn, so no default lookup ever picks it —
// only `providers: { lift: 'remote-sharp' }` does.
try {
  getRegistry().registerLiftProvider('remote-sharp', (opts) => createRemoteSharpLift(opts), { priority: -1, optIn: true });
} catch {
  /* an older registry copy without lift providers on the page */
}

// call/wire.js — the pure half of @displayxr/inline3d/call: the wire format, the routing table,
// the convergence math, room ids and invite links. No DOM, no WebRTC, so every rule the module
// relies on is checkable under `node --test` (test/call.test.mjs).
//
// PREVIEW tier — see docs/sdk-stability.md and docs/rfcs/0002-video-call.md.

/** Wire-format version carried in every `hello`. Bumped only for an incompatible change. */
export const WIRE_VERSION = 1;

/** The SDK version string a `hello` reports (informational; never used for routing). */
export const CALL_SDK = 'inline3d-call/1';

/** Formats a sender may declare. Anything else — or no hello at all — is read as `'mono'`. */
export const CALL_FORMATS = Object.freeze(['sbs', 'mono']);

// The side-by-side geometry (what counts as a pair, eye crops, the mirror-and-swap self view)
// moved to js/camera/geometry.js in C2 — `/camera` owns it, `/call` consumes it. Re-exported here
// so every in-tree import and test path keeps resolving.
export { SBS_ASPECT_MIN, looksSbs, eyeCropRect, eyeOutputSize, mirrorSwapOps, mirrorSwapPixels } from '../camera/geometry.js';
export { CONVERGENCE_ALPHA, CONVERGENCE_MAX_FRACTION, DEPTH_RANGE_FRACTION } from '../camera/converge.js';

/** Default and hard cap of participants in a full-mesh call (including yourself). */
export const DEFAULT_MAX_PEERS = 4;
export const MESH_HARD_CAP = 4;

/** `hint` messages are rate-limited to this many per second, on the sender AND the receiver. */
export const HINT_MAX_HZ = 5;

/** Plausible subject distances, mm. A hint outside this is ignored as noise. */
export const SUBJECT_Z_MIN_MM = 150;
export const SUBJECT_Z_MAX_MM = 5000;

// ── room ids and invite links ──────────────────────────────────────────────────────────────

/** Room ids are base64url, at least 16 chars (96 bits). Generated ones are 22 chars (128 bits). */
export const ROOM_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
export const ROOM_ID_BYTES = 16;

/**
 * An unguessable, URL-safe room id: 128 random bits, base64url (22 chars). The id IS the only
 * access control an anonymous call has, so it comes from `crypto.getRandomValues`, never
 * `Math.random`.
 * @param {(a: Uint8Array) => Uint8Array} [getRandomValues]  injectable for tests
 */
export function newRoomId(getRandomValues) {
  const bytes = new Uint8Array(ROOM_ID_BYTES);
  const fill = getRandomValues || ((a) => globalThis.crypto.getRandomValues(a));
  fill(bytes);
  return base64url(bytes);
}

/** A random peer id: 64 bits, base64url (11 chars). Unique within a room, not a secret. */
export function newPeerId(getRandomValues) {
  const bytes = new Uint8Array(8);
  const fill = getRandomValues || ((a) => globalThis.crypto.getRandomValues(a));
  fill(bytes);
  return base64url(bytes);
}

export function base64url(bytes) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += A[(n >> 18) & 63] + A[(n >> 12) & 63] + A[(n >> 6) & 63] + A[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += A[(n >> 18) & 63] + A[(n >> 12) & 63];
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += A[(n >> 18) & 63] + A[(n >> 12) & 63] + A[(n >> 6) & 63];
  }
  return out;
}

export function isValidRoomId(room) {
  return typeof room === 'string' && ROOM_ID_RE.test(room);
}

/**
 * The room carried by an invite link, or null. Reads the URL FRAGMENT only (`#room=…`), which a
 * browser never sends to a server, so the room never lands in an access log. Accepts a full URL,
 * a bare fragment (`#room=…` / `room=…`), or a `Location`. Other fragment params are ignored.
 * @param {string | {hash?: string, href?: string}} link
 */
export function parseInviteLink(link) {
  if (!link) return null;
  let hash = '';
  if (typeof link === 'object') hash = link.hash || (link.href ? String(link.href).split('#')[1] || '' : '');
  else {
    const s = String(link);
    const at = s.indexOf('#');
    hash = at >= 0 ? s.slice(at + 1) : s.includes('=') && !s.includes('://') ? s : '';
  }
  hash = hash.replace(/^#/, '');
  for (const part of hash.split('&')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (decodeURIComponent(part.slice(0, eq)) !== 'room') continue;
    const room = decodeURIComponent(part.slice(eq + 1));
    return isValidRoomId(room) ? room : null;
  }
  return null;
}

/**
 * Build an invite link: `base` with its fragment replaced by `#room=<room>`. The query string is
 * kept (a sample's `?signal=` must survive the hop); any existing fragment is dropped.
 */
export function buildInviteLink(base, room) {
  if (!isValidRoomId(room)) throw new Error(`@displayxr/inline3d/call: invalid room id "${room}"`);
  const b = String(base || '').split('#')[0];
  return `${b}#room=${room}`;
}

// ── hello / hint / state ───────────────────────────────────────────────────────────────────

/**
 * Validate an incoming `hello`, filling the defaults a receiver may assume. Returns null for
 * something that is not a hello at all. Never throws: this reads data from another browser.
 *
 * `rectified` defaults to FALSE — a raw stereo camera (unrectified, possibly grayscale) is the
 * common case in the field, and a receiver must never assume more than it was told.
 */
export function normalizeHello(msg) {
  if (!msg || typeof msg !== 'object' || msg.type !== 'hello') return null;
  const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null);
  return {
    type: 'hello',
    v: typeof msg.v === 'number' ? msg.v : WIRE_VERSION,
    format: CALL_FORMATS.includes(msg.format) ? msg.format : 'mono',
    width: num(msg.width, 1, 16384),
    height: num(msg.height, 1, 16384),
    baselineMm: num(msg.baselineMm, 1, 1000),
    hfovDeg: num(msg.hfovDeg, 5, 170),
    rectified: msg.rectified === true,
    sdk: typeof msg.sdk === 'string' ? msg.sdk.slice(0, 64) : null,
  };
}

/** Build the `hello` this side sends. */
export function makeHello({ format, width, height, baselineMm, hfovDeg, rectified } = {}) {
  const h = {
    type: 'hello',
    v: WIRE_VERSION,
    format: CALL_FORMATS.includes(format) ? format : 'mono',
    width: width || 0,
    height: height || 0,
    rectified: !!rectified,
    sdk: CALL_SDK,
  };
  if (Number.isFinite(baselineMm)) h.baselineMm = baselineMm;
  if (Number.isFinite(hfovDeg)) h.hfovDeg = hfovDeg;
  return h;
}

/** `hint {subjectZmm}`: a number in range, or null (ignored). */
export function normalizeHint(msg) {
  if (!msg || msg.type !== 'hint') return null;
  const z = msg.subjectZmm;
  return typeof z === 'number' && Number.isFinite(z) && z >= SUBJECT_Z_MIN_MM && z <= SUBJECT_Z_MAX_MM
    ? { type: 'hint', subjectZmm: z }
    : null;
}

/** `state {muted, cameraOff, speaking}` — booleans only. */
export function normalizeState(msg) {
  if (!msg || msg.type !== 'state') return null;
  return { type: 'state', muted: msg.muted === true, cameraOff: msg.cameraOff === true, speaking: msg.speaking === true };
}

/**
 * A minimum-interval gate: `gate(nowMs)` is true at most `hz` times a second. Used on both ends
 * of `hint` so a chatty (or hostile) sender cannot drive the receiver's convergence at frame rate.
 */
export function rateGate(hz) {
  const minMs = 1000 / hz;
  let last = -Infinity;
  return (now) => {
    if (now - last < minMs) return false;
    last = now;
    return true;
  };
}

// ── routing (RFC §3) ───────────────────────────────────────────────────────────────────────

/**
 * How a remote tile is drawn. The ONE table every tile goes through:
 *
 * | remote sends | local wall woven      | local wall 2D / absent |
 * |--------------|-----------------------|------------------------|
 * | `sbs`        | `woven-sbs`           | `flat-left`            |
 * | `mono`       | `lifted` (or `flat`)  | `flat`                 |
 * | no hello     | treated as `mono`     | `flat`                 |
 *
 * A mono peer on a woven wall is `lifted` — one lift() stream per peer (call/lift.js) — when the
 * `mono3D` option is on, a lift function resolved (`lift: true`) and a lift slot is free. Otherwise
 * it is `flat`, and `mono3d` says why: `'off'` (the page turned it off), `'unavailable'` (no lift
 * module, no provider, or it is still loading), `'budget'` (every lift slot is taken), or
 * `'failed'` (lift() failed for this tile).
 *
 * @param {{ format?: string|null, woven: boolean, mono3D?: 'auto'|'off'|Function, lift?: boolean, overBudget?: boolean, failed?: boolean }} p
 * @returns {{ route: 'woven-sbs'|'flat-left'|'flat'|'lifted', mono3d?: 'unavailable'|'off'|'lifted'|'budget'|'failed' }}
 */
export function routeFor({ format, woven, mono3D = 'auto', lift = false, overBudget = false, failed = false }) {
  const fmt = format === 'sbs' ? 'sbs' : 'mono';
  if (fmt === 'sbs') return { route: woven ? 'woven-sbs' : 'flat-left' };
  if (!woven) return { route: 'flat' };
  if (mono3D === 'off' || mono3D === false) return { route: 'flat', mono3d: 'off' };
  if (!lift) return { route: 'flat', mono3d: 'unavailable' };
  if (failed) return { route: 'flat', mono3d: 'failed' };
  if (overBudget) return { route: 'flat', mono3d: 'budget' };
  return { route: 'lifted', mono3d: 'lifted' };
}

/**
 * The badge a tile shows for a route, from THIS side's point of view: `3D` for a woven stereo
 * pair, `2D→3D` for a mono peer this side lifts, `2D` for anything shown flat.
 */
export function badgeFor(route) {
  return route === 'woven-sbs' ? '3D' : route === 'lifted' ? '2D→3D' : '2D';
}

// ── convergence (RFC 0002 §3) — moved to js/camera/converge.js in C2 (the self view and the remote
// tiles share one convergence state); re-exported so in-tree imports and test paths keep resolving.
export { focalPx, convergenceShiftPx, clampShift, lowPass, createConvergence } from '../camera/converge.js';

// ── weave liveness (displayxr-browser-pvt#172) ─────────────────────────────────────────────

/**
 * Is the inline-3D session actually LIVE — delivering stereo frames — yet?
 *
 * Browser bug displayxr-browser-pvt#172: a woven canvas registered BEFORE the browser's weave
 * session is live gets the whole side-by-side frame in EACH eye (L|R|L|R, flat) until a reload.
 * A call's self view is created at page load, exactly the case. The core exposes no "weave is
 * live" signal, so the module watches the session's own frames (the frozen `wall.session` /
 * `wall.refSpace` fields) and registers woven tiles only once `need` CONSECUTIVE frames have
 * located two or more views — the runtime is up and locating eyes. A session with no reference
 * space (views never readable) counts as live after `needNoPose` frames. Pure: feed it view counts.
 *
 * @param {{need?: number, needNoPose?: number}} [o]
 */
export function createLiveGate({ need = 10, needNoPose = 30 } = {}) {
  let run = 0;
  let frames = 0;
  let live = false;
  return {
    /** @param {number|null} viewCount  views located this frame; null = no reference space */
    feed(viewCount) {
      if (live) return true;
      frames++;
      if (viewCount === null) live = frames >= needNoPose;
      else {
        // >= 1, not >= 2: the browser's inline session reports ONE view on the viewer pose
        // (per-eye views live on each layer), verified on a real panel.
        run = viewCount >= 1 ? run + 1 : 0;
        live = run >= need;
      }
      return live;
    },
    get live() {
      return live;
    },
  };
}

// ── sending ────────────────────────────────────────────────────────────────────────────────

/**
 * Video `maxBitrate` (kbps) for one outgoing stream in a mesh. Full mesh means one upload per
 * remote peer, so the per-peer budget falls as the call grows. SBS carries two eyes, so it gets
 * roughly twice mono's. Numbers from P0 (2560x720 VP9 30 fps at ~3-4 Mbps).
 */
export function maxBitrateKbps(format, remotePeers) {
  const n = Math.max(1, remotePeers | 0);
  const sbs = format === 'sbs';
  const table = sbs ? [6000, 4000, 3000] : [2500, 1800, 1400];
  return table[Math.min(n, table.length) - 1];
}

/** Exponential backoff with a cap, and ±20% jitter from `rand` (0..1). */
export function backoffMs(attempt, { baseMs = 1000, maxMs = 30000, rand = Math.random } = {}) {
  const raw = Math.min(maxMs, baseMs * Math.pow(2, Math.max(0, attempt)));
  return Math.round(raw * (0.8 + 0.4 * rand()));
}

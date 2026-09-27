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

/** A delivered frame wider than this (w / h) is a side-by-side pair (e.g. 1280x480, 2560x720). */
export const SBS_ASPECT_MIN = 2.5;

/** Default and hard cap of participants in a full-mesh call (including yourself). */
export const DEFAULT_MAX_PEERS = 4;
export const MESH_HARD_CAP = 4;

/** `hint` messages are rate-limited to this many per second, on the sender AND the receiver. */
export const HINT_MAX_HZ = 5;

/** Low-pass factor for the convergence shift (RFC §3): next = prev + α·(target − prev). */
export const CONVERGENCE_ALPHA = 0.2;

/** The convergence shift never exceeds this fraction of the per-eye width, either way. */
export const CONVERGENCE_MAX_FRACTION = 0.12;

/** `setDepth(v)`: v in [-1, 1] adds v times this fraction of the per-eye width to the shift. */
export const DEPTH_RANGE_FRACTION = 0.05;

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
 * | `mono`       | `mono3d` hook → `flat`| `flat`                 |
 * | no hello     | treated as `mono`     | `flat`                 |
 *
 * `mono3d` is the P2 lift() seam: `mono3D: 'auto'` asks for it, and in P1 it always resolves to
 * `flat` (reported as `{ route: 'flat', mono3d: 'unavailable' }`).
 *
 * @param {{ format?: string|null, woven: boolean, mono3D?: 'auto'|'off', lift?: boolean }} p
 * @returns {{ route: 'woven-sbs'|'flat-left'|'flat', mono3d?: 'unavailable'|'off'|'lifted' }}
 */
export function routeFor({ format, woven, mono3D = 'auto', lift = false }) {
  const fmt = format === 'sbs' ? 'sbs' : 'mono';
  if (fmt === 'sbs') return { route: woven ? 'woven-sbs' : 'flat-left' };
  if (!woven) return { route: 'flat' };
  if (mono3D === 'off') return { route: 'flat', mono3d: 'off' };
  // P2: lift() lands here. Until then the hook resolves to flat, and says so.
  return lift ? { route: 'lifted', mono3d: 'lifted' } : { route: 'flat', mono3d: 'unavailable' };
}

/** The badge a tile shows for a route: '3D' only when this side is actually weaving it. */
export function badgeFor(route) {
  return route === 'woven-sbs' || route === 'lifted' ? '3D' : '2D';
}

// ── convergence (RFC §3) ───────────────────────────────────────────────────────────────────

/** Focal length in px of an eye image `eyeWidthPx` wide with horizontal FOV `hfovDeg`. */
export function focalPx(eyeWidthPx, hfovDeg) {
  if (!(eyeWidthPx > 0) || !(hfovDeg > 0) || hfovDeg >= 180) return null;
  return eyeWidthPx / 2 / Math.tan(((hfovDeg / 2) * Math.PI) / 180);
}

/**
 * Per-eye horizontal shift, in SOURCE eye pixels, that puts a subject at `subjectZmm` on the
 * display plane: `f_px · baseline / (2 · subjectZ)`. A parallel stereo camera gives everything a
 * crossed disparity of `f·B/Z` (full, between the eyes); half of it comes off each eye.
 *
 * Positive = the left eye's crop moves RIGHT and the right eye's LEFT (content pushed back).
 * Returns 0 when anything it needs is unknown — the receiver then shows the pair as sent.
 */
export function convergenceShiftPx({ eyeWidthPx, hfovDeg, baselineMm, subjectZmm }) {
  const f = focalPx(eyeWidthPx, hfovDeg);
  if (f === null || !(baselineMm > 0) || !(subjectZmm > 0)) return 0;
  return (f * baselineMm) / (2 * subjectZmm);
}

/** Clamp a shift to ±CONVERGENCE_MAX_FRACTION of the per-eye width. */
export function clampShift(px, eyeWidthPx, maxFraction = CONVERGENCE_MAX_FRACTION) {
  const lim = Math.max(0, eyeWidthPx * maxFraction);
  return Math.max(-lim, Math.min(lim, px || 0));
}

/** One low-pass step: `prev + α(target − prev)`. Snaps when within 0.05 px so it can settle. */
export function lowPass(prev, target, alpha = CONVERGENCE_ALPHA) {
  const next = prev + alpha * (target - prev);
  return Math.abs(target - next) < 0.05 ? target : next;
}

/**
 * A tile's convergence state: the target from hello+hint, the page's depth offset, and the
 * smoothed value actually painted. `step()` once per painted frame.
 */
export function createConvergence() {
  const s = {
    hello: null,
    subjectZmm: null,
    depth: 0, // setDepth(), [-1, 1]
    current: 0,
    target(eyeWidthPx) {
      const auto =
        s.hello && s.subjectZmm
          ? convergenceShiftPx({
              eyeWidthPx,
              hfovDeg: s.hello.hfovDeg,
              baselineMm: s.hello.baselineMm,
              subjectZmm: s.subjectZmm,
            })
          : 0;
      return clampShift(auto + s.depth * DEPTH_RANGE_FRACTION * eyeWidthPx, eyeWidthPx);
    },
    step(eyeWidthPx) {
      s.current = lowPass(s.current, s.target(eyeWidthPx));
      return s.current;
    },
  };
  return s;
}

/**
 * The source rectangle of ONE eye, cropped to the tile's aspect and shifted by the convergence
 * offset. Never upscales past the source: a 640-wide eye (a real raw stereo camera) stays 640.
 *
 * @param {number} eyeW  source per-eye width (px)
 * @param {number} eyeH  source height
 * @param {number} aspect  the tile's (= the woven buffer's per-eye) aspect, w/h
 * @param {number} shift  per-eye shift in source px (see convergenceShiftPx); + = push back
 * @param {0|1} eye  0 = left, 1 = right
 * @returns {{sx:number, sy:number, sw:number, sh:number}} relative to that eye's half
 */
export function eyeCropRect(eyeW, eyeH, aspect, shift, eye) {
  const s = Math.abs(shift || 0);
  let sw = Math.min(eyeW - 2 * s, eyeH * aspect);
  sw = Math.max(1, sw);
  const sh = Math.min(eyeH, sw / aspect);
  sw = sh * aspect;
  const cx = (eyeW - sw) / 2 + (eye === 0 ? shift : -shift);
  return { sx: Math.max(0, Math.min(eyeW - sw, cx)), sy: (eyeH - sh) / 2, sw, sh };
}

/** The output per-eye size for a source eye and a tile aspect: no upscaling, even numbers. */
export function eyeOutputSize(eyeW, eyeH, aspect) {
  const w = Math.min(eyeW, eyeH * aspect);
  const h = w / aspect;
  return { w: Math.max(2, Math.round(w / 2) * 2), h: Math.max(2, Math.round(h / 2) * 2) };
}

// ── self view: the mirroring trap (RFC §3) ─────────────────────────────────────────────────

/**
 * The draw operations for a MIRRORED stereo self-view: each half mirrored AND the halves swapped.
 *
 * Why both: mirroring a scene horizontally means the reflected left eye sees what the original
 * right eye saw (mirrored), and vice versa. Mirroring each half IN PLACE keeps the eyes where they
 * were and inverts every disparity — the face goes pseudoscopic (inside-out). Mirror + swap keeps
 * crossed disparity crossed. (It is the same pixels as flipping the whole SBS frame; spelled out
 * per half so the intent survives refactoring.) The WIRE is never mirrored — only this preview.
 *
 * @param {number} W  full SBS frame width
 * @param {number} H  height
 * @returns {Array<{src:'L'|'R', sx:number, sw:number, dx:number, dw:number, mirror:true}>}
 */
export function mirrorSwapOps(W, H) {
  const half = W / 2;
  return [
    { src: 'R', sx: half, sw: half, sy: 0, sh: H, dx: 0, dw: half, mirror: true },
    { src: 'L', sx: 0, sw: half, sy: 0, sh: H, dx: half, dw: half, mirror: true },
  ];
}

/**
 * Apply mirrorSwapOps to a row-major single-channel frame (tests, and a reference for the canvas
 * path). Returns a new array.
 */
export function mirrorSwapPixels(px, W, H) {
  const out = new px.constructor(px.length);
  for (const op of mirrorSwapOps(W, H)) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < op.dw; x++) {
        const srcX = op.sx + (op.sw - 1 - x); // mirrored within the half
        out[y * W + op.dx + x] = px[y * W + srcX];
      }
    }
  }
  return out;
}

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

/** Does a delivered frame look like a side-by-side pair? (capture 'auto' only) */
export function looksSbs(width, height) {
  return width > 0 && height > 0 && width / height > SBS_ASPECT_MIN;
}

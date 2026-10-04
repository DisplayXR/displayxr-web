// call/options.js — `CallOptions` → the module's internal shape (RFC 0003 §2): defaults,
// validation, the C2 groups (`theme`, `invite`, `landing`, `liftOptions.max`) folded flat, and the
// 1.29 spellings accepted for one release with a warning. Pure (no DOM, no network) — see
// test/call.test.mjs. Internal: importable by path, not part of the `./call` entry.

import { isValidRoomId, parseInviteLink, DEFAULT_MAX_PEERS } from './wire.js';
import { clampMaxPeers } from './transport.js';
import { normalizeMono3D } from './lift.js';
import { dxrSignaling } from './signaling.js';
import { resolveCallAccent, THEME_VARS } from './ui.js';

const TAG = '[inline3d/call]';
const DEFAULT_BROWSER_URL = 'https://github.com/DisplayXR/displayxr-browser';

/**
 * The 1.29 option spellings and where they went (RFC 0003 §2). Accepted for one release with a
 * single console.warn per key; `normalizeCallOptions` folds them into the C2 shape. 1.31 drops
 * them. The `<dxr-call>` ATTRIBUTES keep their names — the element maps them to the new shapes.
 */
export const LEGACY_OPTIONS = Object.freeze({
  accent: 'theme.accent',
  tileAspect: 'theme.tileAspect',
  inviteBase: 'invite.base',
  updateUrl: 'invite.updateUrl',
  browserUrl: 'landing.browserUrl',
  maxLifted: 'liftOptions.max',
  calibration: "openCamera({ calibration }) of '@displayxr/inline3d/camera' (pass the camera as `camera`)",
  rectify: "openCamera({ rectify }) of '@displayxr/inline3d/camera'",
  log: 'debug: true (and diagnostics())',
  recoverSession: "nothing — a call always recovers the document's session (sharedInline3D())",
  wallOptions: "sharedInline3D(opts) — the document's wall is configured by the page",
  scrollIntoView: 'nothing — always on with ui: true',
});
const legacyWarned = new Set();
function warnLegacy(key) {
  if (legacyWarned.has(key)) return;
  legacyWarned.add(key);
  console.warn(`${TAG} option \`${key}\` is deprecated (removed in 1.31) — use ${LEGACY_OPTIONS[key]}`);
}

/**
 * Apply defaults and validate. Pure (no DOM, no network) — see test/call.test.mjs. The result is
 * the module's INTERNAL shape (flat), with the public groups (`theme`, `invite`, `landing`,
 * `liftOptions`) folded in and the 1.29 spellings accepted with a warning (LEGACY_OPTIONS).
 * @param {object} [opts]
 */
export function normalizeCallOptions(opts = {}) {
  for (const k of Object.keys(LEGACY_OPTIONS)) if (opts[k] !== undefined) warnLegacy(k);
  const theme = opts.theme && typeof opts.theme === 'object' ? opts.theme : {};
  const invite = opts.invite && typeof opts.invite === 'object' ? opts.invite : {};
  const landing = opts.landing && typeof opts.landing === 'object' ? opts.landing : {};
  const ui = opts.ui === undefined ? true : opts.ui === 'tiles' ? 'tiles' : !!opts.ui;
  const chrome = ui === true;
  const tileAspect = theme.tileAspect !== undefined ? theme.tileAspect : opts.tileAspect;
  const aspect = typeof tileAspect === 'number' && tileAspect > 0.3 && tileAspect < 4 ? tileAspect : 16 / 9;
  let room = opts.room === undefined || opts.room === null ? 'auto' : opts.room;
  if (room !== 'auto' && !isValidRoomId(room)) {
    const fromLink = parseInviteLink(room);
    if (!fromLink) throw new Error(`@displayxr/inline3d/call: room "${room}" is not a valid room id (16-64 base64url chars) or invite link`);
    room = fromLink;
  }
  const liftOptions = opts.liftOptions && typeof opts.liftOptions === 'object' ? { ...opts.liftOptions } : null;
  const maxLiftedRaw = liftOptions && liftOptions.max !== undefined ? liftOptions.max : opts.maxLifted;
  if (liftOptions) delete liftOptions.max;
  const accent = theme.accent !== undefined ? theme.accent : opts.accent;
  const cssVars = {};
  for (const [k, prop] of Object.entries(THEME_VARS)) {
    const v = k === 'accent' ? accent : theme[k];
    if (typeof v === 'string' && v) cssVars[prop] = k === 'accent' ? resolveCallAccent(v) : v;
    else if (typeof v === 'number' && k === 'radius') cssVars[prop] = `${v}px`;
  }
  const inviteBase = invite.base !== undefined ? invite.base : opts.inviteBase;
  const updateUrl = invite.updateUrl !== undefined ? invite.updateUrl : opts.updateUrl;
  const browserUrl = landing.browserUrl !== undefined ? landing.browserUrl : opts.browserUrl;
  return {
    room,
    // Default: the hosted DisplayXR signalling server (which also mints TURN credentials). A
    // publishable key (RFC 0003 §5a) rides along on connect; the server may ignore it today.
    signaling: opts.signaling || dxrSignaling(undefined, typeof opts.key === 'string' && opts.key ? { key: opts.key } : {}),
    iceServers: Array.isArray(opts.iceServers) ? opts.iceServers : undefined,
    // 'auto' | 'stereo' | 'mono' | deviceId | MediaStream | a StereoCamera from /camera.
    camera: opts.camera === undefined ? 'auto' : opts.camera,
    format: opts.format === 'sbs' ? 'sbs' : opts.format === 'mono' ? 'mono' : undefined,
    // Camera-side knobs (moved to /camera in C2; still forwarded to openCamera() for one release).
    calibration: opts.calibration && typeof opts.calibration === 'object' ? { ...opts.calibration } : {},
    rectify: typeof opts.rectify === 'function' ? opts.rectify : null,
    audio: opts.audio === undefined ? true : !!opts.audio,
    // Auto-convergence (camera/disparity.js): measure the disparity of the point between each SBS
    // peer's eyes and shift the eyes so it sits at the display plane. The depth slider stays an
    // offset on top. Off = the pair as sent (plus any `hint`).
    autoConverge: opts.autoConverge === undefined ? true : !!opts.autoConverge,
    mono3D: normalizeMono3D(opts.mono3D),
    maxPeers: clampMaxPeers(opts.maxPeers === undefined ? DEFAULT_MAX_PEERS : opts.maxPeers),
    // Extra lift() options for lifted tiles (models, ort, quality, providers). The call's own
    // keys (mode, wall, ui, convergence, priority) always win; `max` is the call's cap (below).
    liftOptions: liftOptions && Object.keys(liftOptions).length ? liftOptions : null,
    // Concurrent lifted tiles (`liftOptions.max`). Default = maxPeers (4): every mono peer can be lifted.
    maxLifted: Number.isFinite(+maxLiftedRaw) && maxLiftedRaw !== null && maxLiftedRaw !== undefined ? Math.max(0, Math.min(DEFAULT_MAX_PEERS, Math.floor(+maxLiftedRaw))) : DEFAULT_MAX_PEERS,
    // 'grid' | 'speaker' | 'none' (the page lays the tiles out; handle.tile(id) finds them).
    layout: opts.layout === 'speaker' ? 'speaker' : opts.layout === 'none' ? 'none' : 'grid',
    // true: full chrome | 'tiles': badges + plates only | false: nothing. `chrome` = the full set.
    ui,
    chrome,
    autoJoin: opts.autoJoin === undefined ? !chrome : !!opts.autoJoin,
    selfView: opts.selfView === undefined ? true : !!opts.selfView,
    tileAspect: aspect,
    // theme → the CSS custom properties written on the host, and the string table.
    cssVars,
    strings: theme.strings && typeof theme.strings === 'object' ? { ...theme.strings } : null,
    invite: {
      base: typeof inviteBase === 'string' ? inviteBase : null,
      updateUrl: updateUrl === undefined ? chrome : !!updateUrl,
    },
    landing: {
      browserUrl: typeof browserUrl === 'string' ? browserUrl : DEFAULT_BROWSER_URL,
      allow2D: landing.allow2D === undefined ? true : !!landing.allow2D,
    },
    debug: !!opts.debug,
    log: typeof opts.log === 'function' ? opts.log : opts.debug ? (tag, obj) => console.log(`${TAG} ${tag} ${JSON.stringify(obj)}`) : null,
    // Internal (tests): replaces the lift module importer behind `mono3D: 'auto'`.
    _liftImporter: typeof opts._liftImporter === 'function' ? opts._liftImporter : undefined,
  };
}

/** The 1.29 `./call` exports kept as deprecated wrappers for one release (removed in 1.31). */
export const DEPRECATED_CALL_EXPORTS = Object.freeze([
  'normalizeCallOptions', 'newRoomId', 'isValidRoomId', 'buildInviteLink', 'normalizeHello', 'makeHello', 'routeFor', 'badgeFor', 'createLiveGate',
  'convergenceShiftPx', 'lowPass', 'clampShift', 'eyeCropRect', 'mirrorSwapOps', 'mirrorSwapPixels', 'maxBitrateKbps', 'measureFocusDisparity',
  'preferVideoCodecs', 'sortCodecCapabilities', 'VIDEO_CODEC_ORDER', 'MeshTransport', 'clampMaxPeers', 'qrEncode', 'roomKey', 'SIGNAL_PROTOCOL',
  'WIRE_VERSION', 'CALL_SDK', 'PLATE_TEXT', 'CALL_ACCENTS', 'normalizeMono3D', 'resolveLift', 'createLiftPool', 'createFrameWatch',
  'liftConvergenceFor', 'liftPriorityFor', 'setLiftPriority', 'defaultLiftSpecifier', 'LIFT_PRIORITY',
]);

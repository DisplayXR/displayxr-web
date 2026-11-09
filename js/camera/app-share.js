// camera/app-share.js — recognising a "3D screen share" device: a running DisplayXR app's
// pre-weave side-by-side views, which the DisplayXR Browser lists as an ordinary `videoinput`
// (runtime ADR-061, `XR_DXR_app_share`). Pure, no DOM.
//
// It lives under /camera, not /call, because the camera probe must know it too: such a device is
// NOT a camera. Its label ("DisplayXR: <app> (3D)") matches stereoLabelHint's `\b3d\b`, so without
// this rule `camera: 'auto'` would open somebody's running app and send it as their face. Every
// probe path in capture.js leaves it out, whatever `exclude` says. `/call`'s share.js builds the
// discovery API on top of it.
//
// The device contract (ADR-061 decision 13): label `DisplayXR: <app> (3D)`, device id prefix
// `dxr-app:`, and on the opened track `getSettings().displayxrStereo.source === 'app'` (plus
// `appName`, `zeroDisparityShiftFrac`). Browsers that predate the hint fields still use the label
// and the id, so any ONE of the three is enough.
//
// Browsers WITHOUT the app-share device patch (DisplayXR Browser 1.9.x) list a development-gated
// app source through their stereo-CAMERA device factory instead: label `3D Camera (DisplayXR) -
// <app>`, id `dxr-stereo:…`, no `source` in the hint. That label shape proves nothing — such a
// browser appends ` - <displayName>` to EVERY entry whenever the runtime lists more than one, so
// the real camera next to the app reads `3D Camera (DisplayXR) - <camera>` too. What does tell
// them apart is the opened track: an app source advertises `baselineMm: 0` and
// `horizontalFovDeg: 0` (runtime ADR-061 decision 2); a real camera never has baseline 0. So
// `isAppShareHint` checks the hint, and `legacyAppCandidate` only ever names a CANDIDATE, which
// must be opened and verified before anything treats it as an app.

/** `deviceId` prefix of an app-share device (cameras use `dxr-stereo:`). */
export const APP_SHARE_ID_PREFIX = 'dxr-app:';

/** The label of an app-share device; group 1 is the app's name. */
export const APP_SHARE_LABEL_RE = /^DisplayXR: (.+) \(3D\)$/;

/**
 * The label a browser without the app-share device patch gives EVERY runtime stereo source when
 * there is more than one (cameras and apps alike); group 1 is the source's display name. A shape,
 * not an identity: see legacyAppCandidate.
 */
export const APP_SHARE_LEGACY_LABEL_RE = /^3D Camera \(DisplayXR\)\s+-\s+(.+)$/;

/**
 * Does a track's `displayxrStereo` hint describe a running app rather than a camera? True when
 * `source === 'app'`; with no `source` (browsers without the app-share device patch), when the
 * layout is side-by-side (or unstated) and BOTH `baselineMm` and `horizontalFovDeg` are exactly 0
 * — what an app source advertises (ADR-061 decision 2) and no real camera does. A `source` that is
 * anything else says "not an app". Never throws. Pure.
 * @param {unknown} hint
 * @returns {boolean}
 */
export function isAppShareHint(hint) {
  if (!hint || typeof hint !== 'object') return false;
  try {
    const h = /** @type {any} */ (hint);
    if (typeof h.source === 'string') return h.source === 'app';
    if (h.layout != null && h.layout !== 'side-by-side') return false;
    return h.baselineMm === 0 && h.horizontalFovDeg === 0;
  } catch {
    return false;
  }
}

/**
 * On a browser WITHOUT the app-share device patch: is this listed device a CANDIDATE app source
 * (`3D Camera (DisplayXR) - <name>`)? Returns `{ appName }` or null. A candidate is verified only
 * after opening (`isAppShareHint` on the track's settings) — the same label shape is given to real
 * cameras whenever the runtime lists more than one source. Never throws. Pure.
 * @param {unknown} device  a `MediaDeviceInfo`, `{ label }`, or a label string
 * @returns {{ appName: string } | null}
 */
export function legacyAppCandidate(device) {
  let label = '';
  try {
    label = typeof device === 'string' ? device : device && typeof device === 'object' ? /** @type {any} */ (device).label : '';
  } catch {
    return null;
  }
  const m = typeof label === 'string' ? APP_SHARE_LEGACY_LABEL_RE.exec(label.trim()) : null;
  const appName = m ? m[1].trim() : '';
  return appName ? { appName } : null;
}

/** The app name an app-share label carries, or null. Pure. */
export function appNameFromLabel(label) {
  const m = typeof label === 'string' ? APP_SHARE_LABEL_RE.exec(label.trim()) : null;
  return m ? m[1].trim() || null : null;
}

/**
 * Is this an app-share device rather than a camera? Takes a `MediaDeviceInfo` (or any
 * `{ label, deviceId }`), a label string, a track's settings (`{ displayxrStereo }`), or a
 * `MediaStreamTrack` (its label and settings). True on ANY of: the label shape, the `dxr-app:` id
 * prefix, or a `displayxrStereo` hint that `isAppShareHint` accepts (`source: 'app'`, or baseline
 * and FOV both 0). The legacy `3D Camera (DisplayXR) - <name>` label alone is NOT enough (cameras
 * get it too). Never throws. Pure.
 * @param {unknown} x
 * @returns {boolean}
 */
export function isAppShareDevice(x) {
  if (!x) return false;
  if (typeof x === 'string') return APP_SHARE_LABEL_RE.test(x.trim()) || x.startsWith(APP_SHARE_ID_PREFIX);
  if (typeof x !== 'object') return false;
  const o = /** @type {any} */ (x);
  try {
    if (typeof o.label === 'string' && APP_SHARE_LABEL_RE.test(o.label.trim())) return true;
    if (typeof o.deviceId === 'string' && o.deviceId.startsWith(APP_SHARE_ID_PREFIX)) return true;
    const hint = o.displayxrStereo || (typeof o.getSettings === 'function' ? (o.getSettings() || {}).displayxrStereo : null);
    if (isAppShareHint(hint)) return true;
    if (typeof o.getSettings === 'function') {
      const id = (o.getSettings() || {}).deviceId;
      if (typeof id === 'string' && id.startsWith(APP_SHARE_ID_PREFIX)) return true;
    }
  } catch {
    /* a hostile getter: not an app */
  }
  return false;
}

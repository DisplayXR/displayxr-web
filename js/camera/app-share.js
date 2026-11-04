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

/** `deviceId` prefix of an app-share device (cameras use `dxr-stereo:`). */
export const APP_SHARE_ID_PREFIX = 'dxr-app:';

/** The label of an app-share device; group 1 is the app's name. */
export const APP_SHARE_LABEL_RE = /^DisplayXR: (.+) \(3D\)$/;

/** The app name an app-share label carries, or null. Pure. */
export function appNameFromLabel(label) {
  const m = typeof label === 'string' ? APP_SHARE_LABEL_RE.exec(label.trim()) : null;
  return m ? m[1].trim() || null : null;
}

/**
 * Is this an app-share device rather than a camera? Takes a `MediaDeviceInfo` (or any
 * `{ label, deviceId }`), a label string, a track's settings (`{ displayxrStereo }`), or a
 * `MediaStreamTrack` (its label and settings). True on ANY of: the label shape, the `dxr-app:` id
 * prefix, or `displayxrStereo.source === 'app'`. Never throws. Pure.
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
    if (hint && typeof hint === 'object' && hint.source === 'app') return true;
    if (typeof o.getSettings === 'function') {
      const id = (o.getSettings() || {}).deviceId;
      if (typeof id === 'string' && id.startsWith(APP_SHARE_ID_PREFIX)) return true;
    }
  } catch {
    /* a hostile getter: not an app */
  }
  return false;
}

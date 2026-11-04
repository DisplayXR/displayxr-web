// call/share.js — 3D screen share, the page side: find the running DisplayXR apps the browser
// offers as share sources, and open one as a side-by-side content track for `handle.shareContent()`.
//
// PREVIEW tier (docs/sdk-stability.md). The device contract is runtime ADR-061 /
// `XR_DXR_app_share`: the DisplayXR Browser lists each shareable app as a `videoinput` labelled
// `DisplayXR: <app> (3D)` with a `dxr-app:` device id, and the opened track describes itself in
// `getSettings().displayxrStereo` (`source: 'app'`, `appName`, `zeroDisparityShiftFrac`). Browsers
// that predate those hint fields still use the label and the id, so detection takes any one of the
// three (camera/app-share.js) and a missing `zeroDisparityShiftFrac` reads as 0 — which is what the
// runtime sends in v1 anyway: the views are DISPLAY-REFERRED (zero disparity at the sender's display
// plane), so a receiver applies that known value and never measures the frames.
//
// App devices are listed only once the page holds camera permission (ADR-061 decision 17). The
// runtime asks the user on the SENDER's machine, every start ("Share <app> with <browser>?"), when
// `openAppShare()` opens the device; a Deny rejects it (`code: 'share-denied'`). The track ends
// (`ended`) when the app exits or the share is stopped from the runtime side.
//
// Browsers WITHOUT the app-share device patch (DisplayXR Browser 1.9.x) list an app through their
// stereo-camera factory as `3D Camera (DisplayXR) - <app>` — and, whenever the runtime lists more
// than one source, give the real camera the same shape. So when no ADR-form device exists,
// `listShareableApps()` returns those as CANDIDATES (`legacy: true`), and `openAppShare()` verifies
// the opened track (`isAppShareHint`: baseline 0 and FOV 0 is an app) — a real camera is closed
// again with `code: 'not-app-share'`.

import { isAppShareDevice, isAppShareHint, legacyAppCandidate, appNameFromLabel, APP_SHARE_ID_PREFIX, APP_SHARE_LABEL_RE, APP_SHARE_LEGACY_LABEL_RE } from '../camera/app-share.js';
import { sanitizeName, CONV_MAX_FRAC } from './wire.js';

export { isAppShareDevice, isAppShareHint, legacyAppCandidate, appNameFromLabel, APP_SHARE_ID_PREFIX, APP_SHARE_LABEL_RE, APP_SHARE_LEGACY_LABEL_RE };

/** The app name a label carries: the ADR form, else a legacy candidate's `<name>`. */
const nameOfLabel = (label) => sanitizeName(appNameFromLabel(label)) || sanitizeName((legacyAppCandidate(label) || {}).appName) || null;

/** What `openAppShare` asks for by default: the runtime's default stream (ADR-061 decision 5). */
const SHARE_CONSTRAINTS = Object.freeze({ width: 2560, height: 720, frameRate: 30 });

const mdOf = (o) => (o && o.mediaDevices) || (globalThis.navigator && navigator.mediaDevices) || null;

/**
 * The running apps this browser offers to share: `[{ deviceId, label, appName }]`, in the
 * browser's order. Empty without camera permission (the browser lists none before it), on any
 * other browser, or when nothing is shareable. Never rejects.
 *
 * On a browser without the app-share device patch (no ADR-form device listed), the entries are the
 * `3D Camera (DisplayXR) - <name>` CANDIDATES instead, marked `legacy: true`. A real camera can be
 * among them (that browser labels every source that way once there are two); `openAppShare()`
 * tells them apart and rejects a camera with `not-app-share`.
 * @param {{ mediaDevices?: MediaDevices }} [o]
 */
export async function listShareableApps(o = {}) {
  const md = mdOf(o);
  if (!md || typeof md.enumerateDevices !== 'function') return [];
  let list = [];
  try {
    list = await md.enumerateDevices();
  } catch {
    return [];
  }
  const videos = list.filter((d) => d && d.kind === 'videoinput');
  const apps = videos
    .filter((d) => isAppShareDevice(d))
    .map((d) => Object.freeze({ deviceId: d.deviceId, label: d.label || '', appName: sanitizeName(appNameFromLabel(d.label)) || sanitizeName(d.label) || null }));
  if (apps.length) return apps;
  return videos
    .filter((d) => d.deviceId && legacyAppCandidate(d))
    .map((d) => Object.freeze({ deviceId: d.deviceId, label: d.label || '', appName: nameOfLabel(d.label), legacy: true }));
}

/**
 * `cb(apps)` now and whenever the list changes (`devicechange`: an app started, exited, or the
 * page was just granted the camera). Returns the unsubscribe.
 * @param {(apps: Array<{deviceId: string, label: string, appName: string|null}>) => void} cb
 * @param {{ mediaDevices?: MediaDevices }} [o]
 */
export function watchShareableApps(cb, o = {}) {
  if (typeof cb !== 'function') throw new TypeError('@displayxr/inline3d/call: watchShareableApps(cb) takes a function');
  const md = mdOf(o);
  let last = null;
  let live = true;
  let seq = 0;
  const run = async () => {
    const mine = ++seq;
    const apps = await listShareableApps({ mediaDevices: md });
    if (!live || mine !== seq) return; // a newer read is in flight (devicechange bursts)
    const key = JSON.stringify(apps.map((a) => [a.deviceId, a.label, !!a.legacy]));
    if (key === last) return;
    last = key;
    try {
      cb(apps);
    } catch (err) {
      console.error('[inline3d/call] watchShareableApps listener threw', err);
    }
  };
  const onChange = () => void run();
  if (md && typeof md.addEventListener === 'function') md.addEventListener('devicechange', onChange);
  void run();
  return () => {
    live = false;
    if (md && typeof md.removeEventListener === 'function') md.removeEventListener('devicechange', onChange);
  };
}

/**
 * The content descriptor of an opened share track (what `shareContent` sends): side-by-side, its
 * size, the app name, and the KNOWN convergence — `frac` is the hint's `zeroDisparityShiftFrac`
 * (the disparity of the sender's display plane as a fraction of the per-eye width; 0 in v1, and 0
 * when the browser does not expose it yet). Pure.
 * @param {MediaStreamTrack} track
 * @param {string} [fallbackLabel]
 */
export function describeAppShare(track, fallbackLabel = '') {
  let st = {};
  try {
    st = (track && typeof track.getSettings === 'function' && track.getSettings()) || {};
  } catch {
    st = {};
  }
  const hint = st.displayxrStereo && typeof st.displayxrStereo === 'object' ? st.displayxrStereo : {};
  const z = hint.zeroDisparityShiftFrac;
  const frac = typeof z === 'number' && Number.isFinite(z) ? Math.max(-CONV_MAX_FRAC, Math.min(CONV_MAX_FRAC, z)) : 0;
  // The hint's name, else the label's: the ADR form, or a legacy candidate's ` - <name>`.
  const appName = sanitizeName(hint.appName) || nameOfLabel(track && track.label) || nameOfLabel(fallbackLabel) || null;
  return {
    kind: 'content',
    format: hint.layout && hint.layout !== 'side-by-side' ? 'mono' : 'sbs',
    width: st.width > 0 ? st.width : 0,
    height: st.height > 0 ? st.height : 0,
    convergence: { known: true, frac },
    appName,
  };
}

/**
 * Open one shareable app (a `deviceId` from `listShareableApps`) as a side-by-side track. This is
 * when the runtime asks the user on this machine; Deny rejects with `code: 'share-denied'`. A device
 * that turns out not to be an app share is closed again (`code: 'not-app-share'`) — on a browser
 * without the app-share device patch that is how a `legacy` candidate that is really a camera
 * (its track's baseline is not 0) is told apart from an app. The track is
 * yours: stop it when you stop sharing (`track.stop()`), or the runtime keeps the share open.
 *
 * @param {string} deviceId
 * @param {{ width?: number, height?: number, frameRate?: number, mediaDevices?: MediaDevices }} [o]
 * @returns {Promise<{ stream: MediaStream, track: MediaStreamTrack, descriptor: ReturnType<typeof describeAppShare> }>}
 */
export async function openAppShare(deviceId, o = {}) {
  if (typeof deviceId !== 'string' || !deviceId) throw Object.assign(new TypeError('@displayxr/inline3d/call: openAppShare(deviceId) needs a deviceId from listShareableApps()'), { code: 'not-app-share' });
  const md = mdOf(o);
  if (!md || typeof md.getUserMedia !== 'function') throw Object.assign(new Error('getUserMedia is not available (insecure context?)'), { code: 'share-failed' });
  const want = (v, d) => ({ ideal: Number.isFinite(v) && v > 0 ? v : d });
  let stream;
  try {
    stream = await md.getUserMedia({
      video: { deviceId: { exact: deviceId }, width: want(o.width, SHARE_CONSTRAINTS.width), height: want(o.height, SHARE_CONSTRAINTS.height), frameRate: want(o.frameRate, SHARE_CONSTRAINTS.frameRate) },
      audio: false,
    });
  } catch (err) {
    const denied = !!err && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError' || err.name === 'SecurityError');
    throw Object.assign(new Error(`could not share the app: ${(err && err.message) || err}`), { code: denied ? 'share-denied' : 'share-failed', cause: err });
  }
  const track = stream.getVideoTracks()[0] || null;
  let hint = null;
  try {
    hint = track && typeof track.getSettings === 'function' ? (track.getSettings() || {}).displayxrStereo : null;
  } catch {
    hint = null;
  }
  // A track whose hint describes a camera (a `source` other than 'app', or a real baseline) is not
  // an app, whatever its label or id; otherwise the label, the id or the hint must say "app".
  const cameraHint = !!hint && typeof hint === 'object' && !isAppShareHint(hint) && (typeof hint.source === 'string' || hint.baselineMm > 0);
  if (!track || cameraHint || !(isAppShareDevice(track) || deviceId.startsWith(APP_SHARE_ID_PREFIX))) {
    stream.getTracks().forEach((t) => t.stop());
    throw Object.assign(new Error('that device is not a shared DisplayXR app'), { code: 'not-app-share' });
  }
  try {
    track.contentHint = 'detail'; // resolution over frame rate: halving an SBS width halves each eye
  } catch {
    /* older engines */
  }
  return { stream, track, descriptor: describeAppShare(track) };
}

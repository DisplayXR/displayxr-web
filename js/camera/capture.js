// camera/capture.js — getting a camera (+ microphone) and knowing what it is (RFC §4).
//
// `camera: 'auto'` looks for a device that delivers a side-by-side PAIR — one device whose frame
// is wider than 2.5:1 (a USB stereo camera enumerates as one wide device: field data has one at
// 1280x480, i.e. 640x480 per eye, grayscale and UNRECTIFIED). Found → sent as `sbs`. Otherwise the
// default webcam, sent as `mono`. Per-eye width is whatever the camera gives; nothing is upscaled.
//
// Three field facts shape the probing:
//  - On some laptops the stereo camera is held EXCLUSIVELY by the eye tracker, so opening it
//    fails with NotReadableError ("Device in use"). That device is skipped silently — a call must
//    never fail because an optional camera is busy.
//  - Not every `videoinput` is a camera a person should be seen through. A hand-tracking camera
//    (and an eye tracker's or a depth sensor's IR stream) enumerates as an ordinary video input
//    and can even look like a pair by shape; on a Windows box with no stereo camera open, the
//    last-resort "try every device" loop opened one and sent it as the call's 3D picture. Labels
//    matching CAMERA_EXCLUDE_BUILTIN, plus the page's `exclude` list, are never opened by any probe
//    path (an excluded default is closed again), and are reported in `skipped` as `excluded`.
//  - Labels are empty until one getUserMedia has succeeded. Without them, permission is primed on
//    the DEFAULT camera with no constraints (a plain open of one lens of a phone's pair, or its
//    teardown, crashes some phones' camera HAL; any facing or size constraint lets the engine pick
//    a lens instead). Where the runtime's 3D camera is the default, the prime opens the pair
//    itself. NOTHING here assumes a list position: on Windows the DisplayXR Browser lists its
//    "3D Camera (DisplayXR)" LAST. A pair is recognised by the track's own `displayxrStereo`
//    description or by its label (stereoLabelHint), and after the prime the list is read again and
//    a named pair is opened by id BEFORE a default that is a pair only by its shape is kept. The
//    primed default is the fallback.
//  - A DisplayXR Browser also lists every shareable running DisplayXR APP as a side-by-side
//    `videoinput` ("DisplayXR: <app> (3D)", id `dxr-app:…`, runtime ADR-061) — 3D screen share.
//    It is a pair, it names itself "3D", and it is NOT a camera: no probe path opens one, whatever
//    `exclude` says (`exclude: false` included). Each is reported in `skipped` as `excluded` with
//    `reason: 'app-share'`. `/call`'s `listShareableApps()` / `openAppShare()` are how a page uses them.
//    A browser WITHOUT the app-share device patch lists such an app as a stereo camera instead
//    ("3D Camera (DisplayXR) - <app>", no `source` in the hint) and gives the REAL camera the same
//    label shape whenever there is more than one source — so the label cannot decide. Those are
//    opened like any named pair, and the opened track's hint decides: baseline 0 and FOV 0 is an
//    app (ADR-061 decision 2) → closed again, `reason: 'app-share'`, probing goes on.
//
// RECTIFICATION is not done here (P2): it needs the camera's calibration (intrinsics/extrinsics
// for the ACTIVE device), which comes from a plug-in or the runtime. P1 sends the raw pair with
// `rectified: false`, and the `rectify` hook (addCall option) is where a calibrated step plugs in:
// `(stream, info) => MediaStream | Promise<MediaStream>`, returning a rectified SBS stream.

import { looksSbs } from './geometry.js';
import { isAppShareDevice, isAppShareHint } from './app-share.js';

const MONO_CONSTRAINTS = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
// Ask a candidate stereo device for its widest mode; a 2560x720 or 3840x1080 pair comes back as
// itself, a 1280x480 one as 1280x480. `ideal`, never `min`: a smaller real pair is still a pair.
const PROBE_CONSTRAINTS = { width: { ideal: 3840 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };
export const AUDIO_CONSTRAINTS = Object.freeze({ echoCancellation: true, noiseSuppression: true, autoGainControl: true });

/** Errors that mean "the device exists but another process holds it" (an eye tracker, say). */
export function isBusyError(err) {
  return !!err && (err.name === 'NotReadableError' || err.name === 'TrackStartError' || /in use|busy/i.test(err.message || ''));
}

/** Errors that mean "the user (or a policy) refused this page the camera". */
export function isDeniedError(err) {
  return !!err && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError' || err.name === 'SecurityError');
}

/**
 * Why no camera could be opened, from the per-device failures. `'camera-busy'` when every device
 * that exists is held by another process — on a 3D laptop/monitor whose only camera is the eye
 * tracker's, that is the normal case while tracking, and the call should go audio-only and say so
 * rather than fail or send an empty picture. `'permission-denied'` when any attempt was refused
 * (a denied prompt, a policy, an insecure context's SecurityError); else `'no-camera'`. Pure.
 * @param {Array<{error: string, busy?: boolean, denied?: boolean}>} skipped
 */
export function noCameraCode(skipped) {
  // A device left out on purpose (`excluded`) says nothing about why the others failed.
  const tried = skipped.filter((s) => !s.excluded);
  if (tried.length && tried.every((s) => s.busy)) return 'camera-busy';
  if (tried.some((s) => s.denied)) return 'permission-denied';
  return 'no-camera';
}

/**
 * Labels of video inputs that are sensors, not cameras to be seen through: hand tracking, an eye
 * tracker's or a "tracking camera"'s IR stream, a depth camera. Generic words only. Applied on
 * every probe path unless `exclude: false`.
 */
// Generic words, plus the one hand tracker that enumerates under its bare brand name: on Windows
// an Ultraleap (Leap 2 / Leap Motion Controller) is a UVC "Ultraleap", nothing else in the label —
// the generic words alone let it through (win box, 2026-11-04: it was the browser's default camera).
export const CAMERA_EXCLUDE_BUILTIN = /\b(hand[- ]?track|tracking camera|eye[- ]?track|depth camera|ultraleap|leap motion|infrared|ir camera)/i;

/**
 * The exclusion list in force: the built-in pattern plus `exclude` (strings match a label
 * case-insensitively as a substring, or a deviceId exactly; RegExps test the label), or only the
 * app-share rule for `exclude: false`. Returns a predicate `(label, deviceId) => boolean`. An
 * app-share device (camera/app-share.js: a running app's views, not a camera) is ALWAYS excluded —
 * `exclude: false` turns the sensor list off, never that. Pure.
 * @param {false|null|undefined|ReadonlyArray<string|RegExp>|string|RegExp} exclude
 */
export function cameraExcluder(exclude) {
  const app = (label, deviceId) => isAppShareDevice({ label: String(label || ''), deviceId: typeof deviceId === 'string' ? deviceId : '' });
  if (exclude === false) return app;
  const list = [CAMERA_EXCLUDE_BUILTIN];
  for (const x of exclude == null ? [] : Array.isArray(exclude) ? exclude : [exclude]) {
    if (x instanceof RegExp || (typeof x === 'string' && x)) list.push(x);
  }
  return (label, deviceId) => {
    if (app(label, deviceId)) return true;
    const l = String(label || '');
    for (const x of list) {
      if (x instanceof RegExp) {
        x.lastIndex = 0; // a /g or /y pattern is stateful
        if (l && x.test(l)) return true;
      } else if ((l && l.toLowerCase().includes(x.toLowerCase())) || (deviceId && deviceId === x)) return true;
    }
    return false;
  };
}

/**
 * A label that names a stereo camera, tried first when probing. Never an app-share device's
 * ("DisplayXR: <app> (3D)" says "3D" but is a running app, not a camera). Pure.
 */
export function stereoLabelHint(label) {
  if (isAppShareDevice(String(label || ''))) return false;
  return /stereo|\b3d\b|\bsbs\b|dual/i.test(label || '');
}

/**
 * Open the camera. Never rejects for a busy optional device; rejects only when NO camera can be
 * opened at all (the caller then runs audio-only or reports the error).
 *
 * @param {'auto'|'stereo'|'mono'|string|MediaStream} want  'auto' | 'stereo' | 'mono' | a
 *        deviceId | a page-supplied MediaStream
 * @param {{ format?: 'sbs'|'mono', calibration?: {baselineMm?: number, hfovDeg?: number, rectified?: boolean},
 *           mediaDevices?: MediaDevices, log?: Function, exclude?: false|Array<string|RegExp> }} [o]
 *        `exclude`: devices no probe may open (see cameraExcluder); an explicit deviceId is the
 *        page's own choice and is opened regardless.
 * @returns {Promise<{ stream: MediaStream, format: 'sbs'|'mono', width: number, height: number,
 *           deviceId: string|null, label: string, owned: boolean, skipped: Array<{label: string, error: string}>,
 *           calibration: object }>}
 */
export async function openCamera(want = 'auto', o = {}) {
  const md = o.mediaDevices || (globalThis.navigator && navigator.mediaDevices);
  const log = o.log || (() => {});
  const skipped = [];
  const cal = o.calibration || {};
  const isExcluded = cameraExcluder(o.exclude);

  if (want && typeof want === 'object' && typeof want.getVideoTracks === 'function') {
    const t = want.getVideoTracks()[0];
    const st = t ? t.getSettings() : {};
    // A page-supplied stream carries a DECLARED format; aspect is never used to guess 3D-ness here.
    const format = o.format === 'sbs' ? 'sbs' : 'mono';
    return { stream: want, format, width: st.width || 0, height: st.height || 0, deviceId: st.deviceId || null, label: t ? t.label : '', owned: false, skipped, calibration: cal };
  }
  if (!md || !md.getUserMedia) throw Object.assign(new Error('getUserMedia is not available (insecure context?)'), { code: 'no-camera' });

  const open = async (constraints) => {
    const s = await md.getUserMedia({ video: constraints, audio: false });
    const t = s.getVideoTracks()[0];
    const st = t ? t.getSettings() : {};
    // Never hand back a 0x0 track: some engines open a device that then delivers nothing.
    if (!t || t.readyState === 'ended' || !(st.width > 0) || !(st.height > 0)) {
      s.getTracks().forEach((x) => x.stop());
      throw Object.assign(new Error('the camera opened but delivers no picture (0x0)'), { name: 'NotReadableError' });
    }
    // The DisplayXR Browser's "3D Camera (DisplayXR)" (the runtime's stereo camera, e.g. an SR
    // eye-tracking camera shared without stealing it) describes itself on the opened track:
    // `displayxrStereo: {layout, rectified, baselineMm, horizontalFovDeg}`.
    const stereo = st.displayxrStereo && st.displayxrStereo.layout === 'side-by-side' ? st.displayxrStereo : null;
    // A running app's views (3D screen share, ADR-061) describe themselves too: `source: 'app'`,
    // or — on a browser without the app-share device patch, which lists the app as a "3D Camera
    // (DisplayXR) - <app>" — baseline 0 and FOV 0, which no real camera advertises. Every probe
    // path checks this on the OPENED track (rejectOpened), since the label cannot tell them apart.
    const appShare = isAppShareDevice({ label: t.label || '', deviceId: st.deviceId || '' }) || isAppShareHint(st.displayxrStereo);
    return { stream: s, track: t, width: st.width, height: st.height, deviceId: st.deviceId || null, label: t.label || '', stereo, appShare };
  };
  const skip = (label, err) => {
    skipped.push({ label, error: `${err.name}: ${err.message}`, busy: isBusyError(err), denied: isDeniedError(err) });
    log('camera-skip', { label, error: err.name });
  };
  const stop = (r) => r && r.stream.getTracks().forEach((t) => t.stop());
  const listCameras = async () => {
    try {
      return (await md.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    } catch {
      return []; // no enumeration: the paths below still work
    }
  };
  // Excluded devices: never opened by id; a default that turns out to be one is closed again.
  const excludedIds = new Set();
  // `reason`: 'app-share' for a running app's views (never a camera), else 'excluded'.
  const exclude = (label, deviceId, reason = 'excluded') => {
    if (deviceId && excludedIds.has(deviceId)) return;
    if (deviceId) excludedIds.add(deviceId);
    skipped.push({ label, error: 'excluded', excluded: true, reason });
    log('camera-skip', { label, error: 'excluded', reason });
  };
  const isApp = (d) => isAppShareDevice({ label: d.label || '', deviceId: d.deviceId || '' });
  const listedExcluded = (d) => {
    if (isApp(d)) {
      exclude(d.label || '', d.deviceId, 'app-share');
      return true;
    }
    if (!d.label || !isExcluded(d.label, d.deviceId)) return false;
    exclude(d.label, d.deviceId);
    return true;
  };
  /** An opened device that must not be used: an app share (by its own hint too) or an excluded label. Closes it. */
  const rejectOpened = (r) => {
    if (r.appShare) {
      stop(r);
      exclude(r.label, r.deviceId, 'app-share');
      return true;
    }
    if (isExcluded(r.label, r.deviceId)) {
      stop(r);
      exclude(r.label, r.deviceId);
      return true;
    }
    return false;
  };
  // An open of the DEFAULT (no id): only after it opened is its label known. An excluded default
  // is closed and never opened again in this probe.
  let defaultExcluded = false;
  const openDefault = async (constraints) => {
    const r = await open(constraints);
    if (rejectOpened(r)) {
      defaultExcluded = true;
      return null;
    }
    return r;
  };
  // Ask an open camera for another mode without a second start; keep it as it is if it refuses.
  const withMode = async (r, constraints) => {
    try {
      await r.track.applyConstraints(constraints);
      const st = r.track.getSettings();
      if (st.width > 0 && st.height > 0) return { ...r, width: st.width, height: st.height };
    } catch {
      /* keep the mode it opened in */
    }
    return r;
  };
  // A track that declares itself a side-by-side pair IS one, whatever its aspect (a phone's portrait
  // eyes make a 1440x1280 pair). Shape is only the guess for an unknown device, e.g. a USB pair.
  const isPair = (r) => !!r && (!!r.stereo || looksSbs(r.width, r.height));
  const result = (r, format) => ({
    stream: r.stream, format, width: r.width, height: r.height, deviceId: r.deviceId, label: r.label, owned: true, skipped,
    calibration: {
      rectified: false,
      // A runtime stereo camera's own description, where the page gave none.
      ...(format === 'sbs' && r.stereo
        ? {
            rectified: !!r.stereo.rectified,
            ...(r.stereo.baselineMm > 0 ? { baselineMm: r.stereo.baselineMm } : {}),
            ...(r.stereo.horizontalFovDeg > 0 ? { hfovDeg: r.stereo.horizontalFovDeg } : {}),
          }
        : {}),
      ...cal,
    },
  });

  // `label:<text>`: the first camera whose label contains the text (case-insensitive) — a way to
  // force a device from a URL or a config, where a per-origin deviceId is useless. Labels need
  // permission: with none visible yet, the default camera is primed once and let go. Explicit like
  // a deviceId, so it opens an excluded device too.
  if (typeof want === 'string' && want.startsWith('label:')) {
    const needle = want.slice('label:'.length).trim().toLowerCase();
    let list = await listCameras();
    if (needle && list.length && list.every((d) => !d.label)) {
      try {
        stop(await open(true));
      } catch (err) {
        skip('default', err);
      }
      list = await listCameras();
    }
    // Never a running app's views: `label:3d` means a camera (open an app with openAppShare()).
    const d = needle ? list.find((x) => x.deviceId && !isApp(x) && (x.label || '').toLowerCase().includes(needle)) : null;
    if (!d) throw Object.assign(new Error(`camera unavailable: no camera labelled "${needle}"`), { code: noCameraCode(skipped), skipped });
    log('camera-label', { label: d.label, needle });
    want = d.deviceId;
  }

  // An explicit device id.
  if (typeof want === 'string' && !['auto', 'stereo', 'mono'].includes(want)) {
    let r;
    try {
      r = await open({ deviceId: { exact: want }, ...PROBE_CONSTRAINTS });
    } catch (err) {
      skip(want, err);
      throw Object.assign(new Error(`camera unavailable: ${err.message}`), { code: noCameraCode(skipped), skipped });
    }
    if (isPair(r)) return result(r, 'sbs');
    stop(r);
    return result(await open({ deviceId: { exact: want }, ...MONO_CONSTRAINTS }), 'mono');
  }

  // Fast path: when labels are already visible (camera permission persisted), open a device that
  // NAMES itself stereo — e.g. the DisplayXR Browser's "3D Camera (DisplayXR)" — directly. Every
  // camera start can take seconds (a busy capture stack took 7-20 s per start on a field box), and
  // the default-first probe below costs two or three of them before it reaches the pair.
  const tried = new Set();
  const tryNamedPairs = async (list) => {
    for (const d of list) {
      if (!d.deviceId || !stereoLabelHint(d.label) || tried.has(d.deviceId)) continue;
      tried.add(d.deviceId);
      if (listedExcluded(d)) continue;
      let r = null;
      try {
        r = await open({ deviceId: { exact: d.deviceId }, ...PROBE_CONSTRAINTS });
      } catch (err) {
        skip(d.label, err);
        continue;
      }
      if (rejectOpened(r)) continue; // an app that described itself only on its track
      if (isPair(r)) {
        log('camera-sbs', { label: r.label, width: r.width, height: r.height, direct: true });
        return r;
      }
      stop(r);
    }
    return null;
  };
  let mono = null;
  if (want !== 'mono') {
    let listed = await listCameras();
    let pair = await tryNamedPairs(listed);
    if (pair) return result(pair, 'sbs');
    // Labels visible but no stereo-named device: a runtime 3D camera can join the list late (after
    // a runtime restart), so read it once more before falling back.
    if (listed.some((d) => d.label) && !listed.some((d) => stereoLabelHint(d.label))) {
      listed = await listCameras();
      pair = await tryNamedPairs(listed);
      if (pair) return result(pair, 'sbs');
    }
    // No labels yet (no permission). Prime it on the default camera with NO constraints (a facing
    // or size constraint would let the engine pick a phone lens instead). Where the runtime's 3D
    // camera is the default this opens the pair itself; elsewhere (Windows lists it LAST) the list
    // is read again and a NAMED pair is opened by id. A default that is a pair only by its SHAPE is
    // kept as the pair only when no named one opens (it could be any wide sensor).
    if (listed.length && listed.every((d) => !d.label)) {
      let primed = null;
      try {
        primed = await openDefault(true);
      } catch (err) {
        skip('default', err);
      }
      if (primed && primed.stereo) return result(primed, 'sbs'); // the device says it is the pair
      if (primed && primed.deviceId) tried.add(primed.deviceId);
      const named = await tryNamedPairs(await listCameras());
      if (named) {
        stop(primed);
        return result(named, 'sbs');
      }
      if (primed && isPair(primed)) return result(primed, 'sbs');
      // The primed default is the fallback as is (one camera start); ask it for the usual mode.
      if (primed) mono = await withMode(primed, MONO_CONSTRAINTS);
    }
  }

  // The default camera: the fallback (and, with labels already visible, also the probe base).
  // With labels visible and an excluded device listed, the default is not opened blind — it may BE
  // the sensor (an idle Ultraleap is the default camera on some Windows boxes, and an eye tracker's
  // camera should not be started at all) — the first camera that is not excluded is opened by id.
  if (!mono && !defaultExcluded) {
    const listed = await listCameras();
    const anyExcluded = listed.filter(listedExcluded).length > 0; // every excluded device is noted, not just the first
    const first = anyExcluded ? listed.find((d) => d.deviceId && !excludedIds.has(d.deviceId)) || null : null;
    if (first) {
      if (first.deviceId) tried.add(first.deviceId);
      try {
        mono = await open({ deviceId: { exact: first.deviceId }, ...MONO_CONSTRAINTS });
        if (rejectOpened(mono)) mono = null;
      } catch (err) {
        skip(first.label, err);
      }
    } else {
      try {
        mono = await openDefault(MONO_CONSTRAINTS);
      } catch (err) {
        skip('default', err);
      }
    }
  }
  if (want === 'mono' && mono) return result(mono, 'mono');
  if (mono && isPair(mono)) return result(mono, 'sbs'); // the default IS the pair

  let devices = [];
  try {
    devices = (await md.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  } catch {
    /* no enumeration: keep the default */
  }
  // A label that names a pair first; never by list position (see the header).
  devices.sort((a, b) => Number(stereoLabelHint(b.label)) - Number(stereoLabelHint(a.label)));
  for (const d of devices) {
    if (!d.deviceId) continue; // no permission yet: an anonymous entry cannot be opened by id
    if (mono && d.deviceId === mono.deviceId) continue;
    if (tried.has(d.deviceId) || excludedIds.has(d.deviceId)) continue; // already opened (not a pair, or busy) or left out
    if (listedExcluded(d)) continue; // the last resort never opens a sensor (a hand-tracking camera)
    let r = null;
    try {
      r = await open({ deviceId: { exact: d.deviceId }, ...PROBE_CONSTRAINTS });
    } catch (err) {
      // NotReadableError = held by another process (e.g. an eye tracker). Skip, never fail.
      skip(d.label, err);
      continue;
    }
    if (rejectOpened(r)) continue;
    if (isPair(r) && want !== 'mono') {
      stop(mono);
      log('camera-sbs', { label: r.label, width: r.width, height: r.height });
      return result(r, 'sbs');
    }
    // No default could be used (excluded, busy): the first plain camera found is the fallback.
    if (!mono && !isPair(r)) {
      mono = await withMode(r, MONO_CONSTRAINTS);
      if (want === 'mono') return result(mono, 'mono');
      continue;
    }
    stop(r);
  }
  if (mono) {
    if (want === 'stereo') log('camera-no-stereo', { fallback: mono.label });
    return result(mono, 'mono');
  }
  const code = noCameraCode(skipped);
  throw Object.assign(
    new Error(code === 'camera-busy' ? 'camera unavailable: in use by another app (e.g. eye tracking) or unable to deliver a picture' : code === 'permission-denied' ? 'camera access was denied' : 'no camera could be opened'),
    { code, skipped }
  );
}

/**
 * The microphone, with echo cancellation and noise suppression. Null if unavailable/denied.
 * `deviceId`: that input exactly (`handle.setMic`).
 */
export async function openMic(o = {}) {
  const md = o.mediaDevices || (globalThis.navigator && navigator.mediaDevices);
  try {
    const s = await md.getUserMedia({ audio: { ...AUDIO_CONSTRAINTS, ...(o.deviceId ? { deviceId: { exact: o.deviceId } } : {}) }, video: false });
    return s.getAudioTracks()[0] || null;
  } catch (err) {
    (o.log || (() => {}))('mic-skip', { error: err && err.name });
    return null;
  }
}

// camera/capture.js — getting a camera (+ microphone) and knowing what it is (RFC §4).
//
// `camera: 'auto'` looks for a device that delivers a side-by-side PAIR — one device whose frame
// is wider than 2.5:1 (a USB stereo camera enumerates as one wide device: field data has one at
// 1280x480, i.e. 640x480 per eye, grayscale and UNRECTIFIED). Found → sent as `sbs`. Otherwise the
// default webcam, sent as `mono`. Per-eye width is whatever the camera gives; nothing is upscaled.
//
// Two field facts shape the probing:
//  - On some laptops the stereo camera is held EXCLUSIVELY by the eye tracker, so opening it
//    fails with NotReadableError ("Device in use"). That device is skipped silently — a call must
//    never fail because an optional camera is busy.
//  - Labels are empty until one getUserMedia has succeeded. Without them, permission is primed on
//    an environment-facing camera where there is one (a phone's front lens is the head tracker's,
//    and opening it while the tracker holds it can reset the whole camera stack), then the list
//    is read again and a stereo device is opened by id BEFORE the default. The default is the
//    fallback.
//
// RECTIFICATION is not done here (P2): it needs the camera's calibration (intrinsics/extrinsics
// for the ACTIVE device), which comes from a plug-in or the runtime. P1 sends the raw pair with
// `rectified: false`, and the `rectify` hook (addCall option) is where a calibrated step plugs in:
// `(stream, info) => MediaStream | Promise<MediaStream>`, returning a rectified SBS stream.

import { looksSbs } from './geometry.js';

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
  if (skipped.length && skipped.every((s) => s.busy)) return 'camera-busy';
  if (skipped.some((s) => s.denied)) return 'permission-denied';
  return 'no-camera';
}

/** A label that names a stereo camera, tried first when probing. Pure. */
export function stereoLabelHint(label) {
  return /stereo|\b3d\b|\bsbs\b|dual/i.test(label || '');
}

/**
 * Open the camera. Never rejects for a busy optional device; rejects only when NO camera can be
 * opened at all (the caller then runs audio-only or reports the error).
 *
 * @param {'auto'|'stereo'|'mono'|string|MediaStream} want  'auto' | 'stereo' | 'mono' | a
 *        deviceId | a page-supplied MediaStream
 * @param {{ format?: 'sbs'|'mono', calibration?: {baselineMm?: number, hfovDeg?: number, rectified?: boolean},
 *           mediaDevices?: MediaDevices, log?: Function }} [o]
 * @returns {Promise<{ stream: MediaStream, format: 'sbs'|'mono', width: number, height: number,
 *           deviceId: string|null, label: string, owned: boolean, skipped: Array<{label: string, error: string}>,
 *           calibration: object }>}
 */
export async function openCamera(want = 'auto', o = {}) {
  const md = o.mediaDevices || (globalThis.navigator && navigator.mediaDevices);
  const log = o.log || (() => {});
  const skipped = [];
  const cal = o.calibration || {};

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
    return { stream: s, track: t, width: st.width, height: st.height, deviceId: st.deviceId || null, label: t.label || '', stereo };
  };
  const skip = (label, err) => {
    skipped.push({ label, error: `${err.name}: ${err.message}`, busy: isBusyError(err), denied: isDeniedError(err) });
    log('camera-skip', { label, error: err.name });
  };
  const stop = (r) => r && r.stream.getTracks().forEach((t) => t.stop());
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
  const listCameras = async () => {
    try {
      return (await md.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    } catch {
      return []; // no enumeration: the paths below still work
    }
  };
  const tryNamedPairs = async (list) => {
    for (const d of list) {
      if (!d.deviceId || !stereoLabelHint(d.label) || tried.has(d.deviceId)) continue;
      tried.add(d.deviceId);
      let r = null;
      try {
        r = await open({ deviceId: { exact: d.deviceId }, ...PROBE_CONSTRAINTS });
      } catch (err) {
        skip(d.label, err);
        continue;
      }
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
    const listed = await listCameras();
    const pair = await tryNamedPairs(listed);
    if (pair) return result(pair, 'sbs');
    // No labels yet (no permission). Prime it on an environment-facing camera, so a phone does not
    // open its front lens (the head tracker's) just to learn the names; then open a pair by id.
    if (listed.length && listed.every((d) => !d.label)) {
      let primed = null;
      try {
        primed = await open({ ...MONO_CONSTRAINTS, facingMode: { ideal: 'environment' } });
      } catch (err) {
        skip('default', err);
      }
      if (primed && isPair(primed)) return result(primed, 'sbs');
      const named = await tryNamedPairs(await listCameras());
      if (named) {
        stop(primed);
        return result(named, 'sbs');
      }
      // A camera that faces the user (or does not say: a desktop webcam) is the fallback as is; a
      // rear one is not what a self view falls back to, so the default is opened below instead.
      if (primed && primed.track?.getSettings?.().facingMode !== 'environment') mono = primed;
      else stop(primed);
    }
  }

  // The default camera: the fallback (and, with labels already visible, also the probe base).
  if (!mono) {
    try {
      mono = await open(MONO_CONSTRAINTS);
    } catch (err) {
      skip('default', err);
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
  devices.sort((a, b) => Number(stereoLabelHint(b.label)) - Number(stereoLabelHint(a.label)));
  for (const d of devices) {
    if (!d.deviceId) continue; // no permission yet: an anonymous entry cannot be opened by id
    if (mono && d.deviceId === mono.deviceId) continue;
    if (tried.has(d.deviceId)) continue; // the fast path already opened it (not a pair, or busy)
    let r = null;
    try {
      r = await open({ deviceId: { exact: d.deviceId }, ...PROBE_CONSTRAINTS });
    } catch (err) {
      // NotReadableError = held by another process (e.g. an eye tracker). Skip, never fail.
      skip(d.label, err);
      continue;
    }
    if (isPair(r)) {
      stop(mono);
      log('camera-sbs', { label: r.label, width: r.width, height: r.height });
      return result(r, 'sbs');
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

/** The microphone, with echo cancellation and noise suppression. Null if unavailable/denied. */
export async function openMic(o = {}) {
  const md = o.mediaDevices || (globalThis.navigator && navigator.mediaDevices);
  try {
    const s = await md.getUserMedia({ audio: { ...AUDIO_CONSTRAINTS }, video: false });
    return s.getAudioTracks()[0] || null;
  } catch (err) {
    (o.log || (() => {}))('mic-skip', { error: err && err.name });
    return null;
  }
}

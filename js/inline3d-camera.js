// inline3d-camera.js — the stereo camera as its own primitive (RFC 0003 §4, phase C2).
//
// PREVIEW tier. Not covered by the SDK's 1.x semver promise — see docs/sdk-stability.md.
//
//   import { sharedInline3D } from '@displayxr/inline3d';
//   import { openCamera, addCameraView } from '@displayxr/inline3d/camera';
//
//   const cam = await openCamera({ prefer: 'stereo' });     // 'auto' | 'stereo' | 'mono' | deviceId | MediaStream
//   cam.format;   // 'sbs' | 'mono'
//   cam.stereo;   // { rectified, baselineMm, horizontalFovDeg } | null
//   cam.stream;   // the MediaStream: hand it to WebRTC, a MediaRecorder, a canvas
//
//   const view = addCameraView(await sharedInline3D(), canvas, cam, { mirror: true });  // a correct 3D self view
//   const photo = await cam.capturePhoto();   // { blob, suggestedName: 'photo-…_2x1.jpg', convergencePx, … }
//   const rec = cam.record({ mono: true });   // SBS + an optional left-eye copy (Decision 13)
//   const clip = await rec.stop();            // { blob, mono?, suggestedName: 'clip-…_2x1.webm', … }
//   cam.on('ended', () => …);                 // revoked, unplugged, or taken by another app
//   cam.close();
//
// WHAT IT OWNS. Device selection (the busy-device skip, the `displayxrStereo` hint, the > 2.5:1
// pair heuristic — camera/capture.js), calibration (`calibration` / `rectify`, moved here from
// `/call`), the MIRRORED self view (each half mirrored AND the halves swapped —
// camera/geometry.js), auto-convergence on the face (camera/disparity.js + camera/converge.js),
// and captured media: plain side-by-side with the layout in the file name (`_2x1`) and the
// stereo record INSIDE the file (XMP in a JPEG, a Tags element in a WebM — camera/metadata.js,
// Decision 9), so it plays in `/player` and anything else that understands side-by-side.
//
// NOT here (RFC §4): 2D→3D of a mono camera (`/lift` composes: `lift(videoEl)`), and any network
// code — `/call` consumes this module for its self view and capture; the call's `camera: cam`
// accepts a StereoCamera, and `camera: 'auto'` makes the call open one itself.
//
// PHOTOS STORE THE RAW RECTIFIED PAIR, with the convergence reported alongside (`convergencePx`,
// also in the file): baking the shift would crop the edges; a viewer re-converges from the
// number. `convergencePx` is the horizontal disparity (left-eye x − right-eye x, source px) of
// the subject the camera converged on — the face — and a viewer shifts the eyes toward each
// other by half of it each to put that subject at the display plane.

import { openCamera as openDevice } from './camera/capture.js';
import { eyeCropRect, eyeOutputSize, mirrorSwapOps } from './camera/geometry.js';
import { createConvergence } from './camera/converge.js';
import { lumaFromRgba, createDisparityTrack, createFocusTracker } from './camera/disparity.js';
import { resolvePairCursorOption } from './inline3d-cursor-option.js';
import { buildStereoXmp, jpegWithXmp, webmWithTags, stereoTagEntries, readJpegStereoMeta, readWebmStereoMeta, parseStereoXmp, readJpegXmp } from './camera/metadata.js';

export { readJpegStereoMeta, readWebmStereoMeta, parseStereoXmp, readJpegXmp };

const TAG = '[inline3d/camera]';
/** Stamped into every capture's metadata (`Software`), the twin of the call's `CALL_SDK`. */
export const CAMERA_SDK = 'inline3d-camera/1';
// Auto-convergence sampling: ~5 Hz on a copy whose eye is at most this wide (sub-pixel disparity
// on a face, a few ms per measurement — the same numbers as the call's remote tiles).
const AUTO_CONV_INTERVAL_MS = 200;
const AUTO_CONV_EYE_WIDTH = 240;
/** While a depth cursor hovers the view, the source is copied this often (it is what the cursor measures). */
const CURSOR_SAMPLE_MS = 66;
const FRAME_WAIT_MS = 4000;
// A self view whose layer the wall could not build (`firstWoven` → `woven:false, 'layer-failed'`)
// goes flat and re-registers a few times with backoff — the remote tile's rule (web#131).
const LAYER_RETRIES = 4;
const LAYER_RETRY_BASE_MS = 1500;
const LAYER_RETRY_MAX_MS = 20000;
const RECORD_MIME_CANDIDATES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];

const hasDoc = () => typeof document !== 'undefined' && document && typeof document.createElement === 'function';
const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
const extFor = (type) => (/jpe?g/.test(type) ? 'jpg' : /png/.test(type) ? 'png' : /webp/.test(type) ? 'webp' : /mp4/.test(type) ? 'mp4' : /webm/.test(type) ? 'webm' : 'bin');

/**
 * The file name a capture suggests: `<base>_2x1.<ext>` for a side-by-side pair (the layout suffix
 * `/player` and the rest of the SDK read — columns×rows), `<base>.<ext>` for mono. Pure.
 * @param {string} base  e.g. 'photo-20260101-120000'
 * @param {'sbs'|'mono'} layout
 * @param {string} type  a MIME type
 */
export function suggestedName(base, layout, type) {
  const safe = String(base || 'capture').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'capture';
  return `${safe}${layout === 'sbs' ? '_2x1' : ''}.${extFor(type)}`;
}

const asError = (message, code, extra = {}) => Object.assign(new Error(`${TAG} ${message}`), { code, ...extra });

/** Resolve once `video` has a decoded frame (readyState >= 2 and a size), or reject after a wait. */
function waitForFrame(video, ms = FRAME_WAIT_MS) {
  if (!video) return Promise.reject(asError('no video element (no document?)', 'no-frame'));
  if ((video.readyState || 0) >= 2 && video.videoWidth) return Promise.resolve();
  return new Promise((res, rej) => {
    let done = false;
    const ok = () => {
      if (done || (video.readyState || 0) < 2 || !video.videoWidth) return;
      done = true;
      clearTimeout(t);
      video.removeEventListener('loadeddata', ok);
      video.removeEventListener('playing', ok);
      video.removeEventListener('resize', ok);
      res();
    };
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      rej(asError('the camera delivered no frame in time', 'no-frame'));
    }, ms);
    video.addEventListener('loadeddata', ok);
    video.addEventListener('playing', ok);
    video.addEventListener('resize', ok);
    video.play?.().catch(() => {});
  });
}

/**
 * A small grayscale copy of the current frame (per-eye width <= `eyeMax`), for the disparity
 * measurement. `{ img, w, h, scale }` with `scale` = copy px per source px; null if unreadable.
 */
function grabLuma(video, scratch, eyeMax = AUTO_CONV_EYE_WIDTH) {
  const W = video.videoWidth;
  const H = video.videoHeight;
  if (!W || !H || (video.readyState || 0) < 2) return null;
  const s = Math.min(1, eyeMax / (W / 2));
  const w = Math.max(2, Math.round((W * s) / 2) * 2);
  const h = Math.max(2, Math.round(H * s));
  if (scratch.width !== w || scratch.height !== h) {
    scratch.width = w;
    scratch.height = h;
  }
  const g = scratch.getContext('2d', { willReadFrequently: true });
  try {
    g.drawImage(video, 0, 0, w, h);
    return { img: lumaFromRgba(g.getImageData(0, 0, w, h).data, w * h), w, h, scale: w / W };
  } catch {
    return null; // a frame that cannot be read yet (not decoded, tainted)
  }
}

// ── the camera ─────────────────────────────────────────────────────────────────────────────

class StereoCamera {
  constructor(r, { log = null } = {}) {
    this.format = r.format;
    this.stream = r.stream;
    this.width = r.width || 0;
    this.height = r.height || 0;
    this.deviceId = r.deviceId || null;
    this.label = r.label || '';
    this.owned = !!r.owned;
    this.skipped = Object.freeze([...(r.skipped || [])]);
    /** Internal: the hello-shaped calibration (`rectified`, `baselineMm`, `hfovDeg`). The call reads it. */
    this.calibration = Object.freeze({ ...(r.calibration || {}) });
    const c = this.calibration;
    this.stereo = this.format === 'sbs' ? Object.freeze({ rectified: !!c.rectified, baselineMm: c.baselineMm > 0 ? c.baselineMm : null, horizontalFovDeg: c.hfovDeg > 0 ? c.hfovDeg : null }) : null;
    this.state = 'live';
    this._log = log;
    this._listeners = new Map();
    this._scratch = null;
    this._views = new Set();
    // A detached <video> (never in the DOM — an in-DOM video is a second weave candidate) that
    // every view, photo and recording reads from. One per camera, shared.
    this.video = null;
    if (hasDoc()) {
      this.video = Object.assign(document.createElement('video'), { muted: true, playsInline: true, autoplay: true });
      this.video.srcObject = this.stream;
      this.video.play?.().catch(() => {});
    }
    this._onEnded = () => this._ended('ended');
    for (const t of this.stream.getVideoTracks()) t.addEventListener?.('ended', this._onEnded);
  }

  /** Source width of ONE eye (the whole frame for mono). */
  get eyeWidth() {
    return this.format === 'sbs' ? this.width / 2 : this.width;
  }

  log(tag, obj = {}) {
    if (this._log) this._log(tag, obj);
  }

  on(type, cb) {
    if (typeof cb !== 'function') throw new TypeError(`${TAG} on() takes a function`);
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(cb);
    return () => this._listeners.get(type)?.delete(cb);
  }

  off(type, cb) {
    this._listeners.get(type)?.delete(cb);
  }

  _emit(type, payload) {
    for (const cb of [...(this._listeners.get(type) || [])]) {
      try {
        cb(payload);
      } catch (err) {
        console.error(`${TAG} '${type}' listener threw`, err);
      }
    }
  }

  /** A track ended under us: revoked by the runtime, unplugged, taken by another app. Once. */
  _ended(reason) {
    if (this.state !== 'live') return;
    this.state = 'ended';
    this.log('ended', { reason });
    this._emit('ended', { reason });
  }

  /**
   * The disparity (left-eye x − right-eye x, source px) of the point between the eyes in the
   * CURRENT frame, or null (mono, no frame, no face/texture found). One measurement, ~ms.
   */
  async measureConvergence() {
    if (this.format !== 'sbs' || !this.video || !hasDoc()) return null;
    try {
      await waitForFrame(this.video);
    } catch {
      return null;
    }
    this._scratch = this._scratch || document.createElement('canvas');
    const g = grabLuma(this.video, this._scratch);
    if (!g) return null;
    const m = createFocusTracker().measure(g.img, g.w, g.h, 0);
    return m ? m.d / g.scale : null;
  }

  /** The stereo record a capture carries (camera/metadata.js), with `convergencePx` filled in. */
  _meta(convergencePx, width = this.width, height = this.height) {
    const s = this.stereo;
    return {
      layout: this.format,
      convergencePx,
      baselineMm: s ? s.baselineMm : null,
      horizontalFovDeg: s ? s.horizontalFovDeg : null,
      rectified: s ? s.rectified : null,
      eyeWidth: this.format === 'sbs' ? width / 2 : width,
      eyeHeight: height,
      software: CAMERA_SDK,
    };
  }

  /**
   * One frame as an image file: the RAW pair (never mirrored, never shifted) at the camera's full
   * size, with the stereo record written INTO a JPEG as XMP. `type` 'image/jpeg' (default) |
   * 'image/png' | 'image/webp' (the last two carry no metadata — the result still reports it).
   */
  async capturePhoto({ type = 'image/jpeg', quality = 0.92, name, convergencePx } = {}) {
    if (this.state === 'closed') throw asError('the camera is closed', 'closed');
    if (!this.video || !hasDoc()) throw asError('capturePhoto needs a document', 'no-frame');
    await waitForFrame(this.video);
    const W = this.video.videoWidth;
    const H = this.video.videoHeight;
    const conv = typeof convergencePx === 'number' && Number.isFinite(convergencePx) ? convergencePx : await this.measureConvergence();
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    c.getContext('2d').drawImage(this.video, 0, 0, W, H);
    let blob = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(asError('toBlob produced nothing', 'encode-failed'))), type, quality));
    const meta = this._meta(conv, W, H);
    let xmp = null;
    if (blob.type === 'image/jpeg' || /jpe?g/.test(type)) {
      xmp = buildStereoXmp(meta);
      blob = new Blob([jpegWithXmp(new Uint8Array(await blob.arrayBuffer()), xmp)], { type: 'image/jpeg' });
    }
    const out = {
      blob,
      type: blob.type || type,
      width: W,
      height: H,
      layout: this.format,
      convergencePx: conv,
      stereo: this.stereo,
      suggestedName: suggestedName(name || `photo-${stamp()}`, this.format, blob.type || type),
      xmp,
    };
    this.log('photo', { width: W, height: H, layout: this.format, convergencePx: conv, bytes: blob.size, name: out.suggestedName });
    return out;
  }

  /**
   * Record the camera: the SBS stream as sent (plus `audio` tracks if given), optionally a
   * left-eye MONO copy for 2D platforms (`mono: true`, Decision 13 — drawn eye-by-eye on a canvas
   * and captured, so it costs a canvas paint per frame while recording). `stop()` resolves with
   * the files; a WebM carries the stereo record as a Tags element.
   */
  record({ mimeType, mono = false, audio = null, videoBitsPerSecond, timesliceMs = 1000, name, fps = 30 } = {}) {
    if (this.state === 'closed') throw asError('the camera is closed', 'closed');
    if (typeof MediaRecorder !== 'function') throw asError('MediaRecorder is not available here', 'unsupported');
    const mime = mimeType || RECORD_MIME_CANDIDATES.find((m) => typeof MediaRecorder.isTypeSupported !== 'function' || MediaRecorder.isTypeSupported(m)) || '';
    if (mime && typeof MediaRecorder.isTypeSupported === 'function' && !MediaRecorder.isTypeSupported(mime)) throw asError(`${mime} is not a supported recording type here`, 'unsupported');
    const tracks = [...this.stream.getVideoTracks()];
    const audioTracks = audio && typeof audio.getAudioTracks === 'function' ? audio.getAudioTracks() : audio && audio.kind === 'audio' ? [audio] : [];
    tracks.push(...audioTracks);
    const sbs = new MediaStream(tracks);
    const opts = { ...(mime ? { mimeType: mime } : {}), ...(videoBitsPerSecond ? { videoBitsPerSecond } : {}) };
    const rec = new MediaRecorder(sbs, opts);
    const chunks = [];
    rec.ondataavailable = (e) => e.data && e.data.size && chunks.push(e.data);
    let monoRec = null;
    const monoChunks = [];
    let monoCanvas = null;
    let monoRaf = 0;
    const wantMono = !!mono && this.format === 'sbs' && hasDoc() && this.video;
    if (wantMono) {
      monoCanvas = document.createElement('canvas');
      const paintMono = () => {
        monoRaf = requestAnimationFrame(paintMono);
        const v = this.video;
        const W = v.videoWidth;
        const H = v.videoHeight;
        if (!W || !H || (v.readyState || 0) < 2) return;
        if (monoCanvas.width !== W / 2 || monoCanvas.height !== H) {
          monoCanvas.width = W / 2;
          monoCanvas.height = H;
        }
        monoCanvas.getContext('2d').drawImage(v, 0, 0, W / 2, H, 0, 0, W / 2, H);
      };
      paintMono();
      const ms = monoCanvas.captureStream(fps);
      for (const t of audioTracks) ms.addTrack(t);
      monoRec = new MediaRecorder(ms, opts);
      monoRec.ondataavailable = (e) => e.data && e.data.size && monoChunks.push(e.data);
    }
    const t0 = performance.now();
    const measured = [];
    // Sample the convergence a few times while recording: the record stores the median.
    const sampler = this.format === 'sbs' ? setInterval(() => this.measureConvergence().then((d) => d !== null && measured.push(d)), 1500) : 0;
    this.measureConvergence().then((d) => d !== null && measured.push(d));
    rec.start(timesliceMs);
    monoRec?.start(timesliceMs);
    this.log('record-start', { mimeType: mime, mono: wantMono, audio: audioTracks.length });

    const stopOne = (r, list) =>
      new Promise((res) => {
        if (!r || r.state === 'inactive') return res(list);
        r.onstop = () => res(list);
        r.stop();
      });
    const base = name || `clip-${stamp()}`;
    const camera = this;
    const handle = {
      get state() {
        return rec.state;
      },
      get mimeType() {
        return rec.mimeType || mime;
      },
      pause() {
        if (rec.state === 'recording') rec.pause();
        if (monoRec && monoRec.state === 'recording') monoRec.pause();
      },
      resume() {
        if (rec.state === 'paused') rec.resume();
        if (monoRec && monoRec.state === 'paused') monoRec.resume();
      },
      async stop() {
        clearInterval(sampler);
        if (monoRaf) cancelAnimationFrame(monoRaf);
        const [a, b] = await Promise.all([stopOne(rec, chunks), stopOne(monoRec, monoChunks)]);
        const type = rec.mimeType || mime || (a[0] && a[0].type) || 'video/webm';
        const sorted = [...measured].sort((x, y) => x - y);
        const conv = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
        const meta = camera._meta(conv);
        const tagged = /webm|matroska/.test(type);
        const finish = async (parts, layout) => {
          let blob = new Blob(parts, { type });
          if (tagged && blob.size) {
            try {
              blob = new Blob([webmWithTags(new Uint8Array(await blob.arrayBuffer()), stereoTagEntries({ ...meta, layout }))], { type });
            } catch (err) {
              camera.log('record-tag-failed', { message: String(err && err.message) });
            }
          }
          return blob;
        };
        const blob = await finish(a, camera.format);
        const out = {
          blob,
          type,
          layout: camera.format,
          durationMs: Math.round(performance.now() - t0),
          convergencePx: conv,
          stereo: camera.stereo,
          suggestedName: suggestedName(base, camera.format, type),
          tagged: tagged && blob.size > 0,
        };
        if (monoRec) {
          out.mono = await finish(b, 'mono');
          out.monoSuggestedName = suggestedName(base, 'mono', type);
        }
        camera.log('record-stop', { bytes: blob.size, mono: out.mono ? out.mono.size : null, ms: out.durationMs, convergencePx: conv, name: out.suggestedName });
        return out;
      },
    };
    return handle;
  }

  /** Stop the camera (only tracks this module opened; a page-supplied stream is left running). */
  close() {
    if (this.state === 'closed') return;
    this.state = 'closed';
    for (const t of this.stream.getVideoTracks()) t.removeEventListener?.('ended', this._onEnded);
    for (const v of [...this._views]) v.remove();
    if (this.owned) this.stream.getTracks().forEach((t) => t.stop());
    if (this.video) {
      this.video.srcObject = null;
    }
    this.log('closed', {});
  }
}

/**
 * Open the best camera. `prefer`: `'auto'` (default — a stereo device when one is present: the
 * DisplayXR Browser's "3D Camera", or a device delivering > 2.5:1 frames; else the default
 * webcam), `'stereo'` (prefer the pair, fall back to mono), `'mono'` (never probe), a `deviceId`,
 * or a `MediaStream` you own (then `format` declares what it is — 3D-ness is never guessed from
 * a stream). A camera held by another process (an eye tracker) is skipped, never fatal; the
 * promise rejects only when NO camera opens, with `code` `'camera-busy'` (every device is held),
 * `'permission-denied'`, or `'no-camera'`, and `skipped` listing every device tried.
 *
 * @param {object|string|MediaStream} [opts]  `{ prefer, format, calibration, rectify, debug }` (or just `prefer`)
 */
export async function openCamera(opts = {}) {
  const o = typeof opts === 'string' || (opts && typeof opts.getVideoTracks === 'function') ? { prefer: opts } : opts || {};
  const prefer = o.prefer === undefined || o.prefer === null ? 'auto' : o.prefer;
  const log = typeof o.log === 'function' ? o.log : o.debug ? (tag, obj) => console.log(`${TAG} ${tag} ${JSON.stringify(obj)}`) : null;
  const cal = o.calibration && typeof o.calibration === 'object' ? { ...o.calibration } : {};
  // `horizontalFovDeg` is the public spelling (RFC 0003 §4); the hello wire field is `hfovDeg`.
  if (cal.horizontalFovDeg > 0 && !(cal.hfovDeg > 0)) cal.hfovDeg = cal.horizontalFovDeg;
  delete cal.horizontalFovDeg;
  const r = await openDevice(prefer, { format: o.format, calibration: cal, mediaDevices: o.mediaDevices, log: log || undefined });
  if (r.format === 'sbs' && typeof o.rectify === 'function') {
    // A calibrated rectification step (plug-in or runtime supplied): its output is a rectified
    // SBS stream, and the record then says so. A throwing hook keeps the raw pair.
    try {
      const out = await o.rectify(r.stream, { width: r.width, height: r.height, deviceId: r.deviceId, label: r.label });
      if (out && typeof out.getVideoTracks === 'function') {
        r.stream = out;
        r.calibration = { ...r.calibration, rectified: true };
      }
    } catch (err) {
      log?.('rectify-failed', { message: String(err && err.message) });
      r.rectifyError = err;
    }
  }
  const cam = new StereoCamera(r, { log });
  if (r.rectifyError) cam.rectifyError = r.rectifyError;
  cam.log('open', { format: cam.format, width: cam.width, height: cam.height, label: cam.label, stereo: cam.stereo, skipped: cam.skipped.length });
  return cam;
}

/** Is `x` a StereoCamera from {@link openCamera}? (Duck-typed, so copies of the SDK interoperate.) */
export const isStereoCamera = (x) => !!x && typeof x === 'object' && typeof x.capturePhoto === 'function' && typeof x.record === 'function' && x.stream && typeof x.stream.getVideoTracks === 'function';

// ── the self view ──────────────────────────────────────────────────────────────────────────

/** Size a FLAT (never woven) canvas to its box × dpr. False if it has no box yet. */
function sizeFlat(canvas) {
  const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
  const w = Math.round((canvas.clientWidth || 0) * dpr);
  const h = Math.round((canvas.clientHeight || 0) * dpr);
  if (!w || !h) return false;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return true;
}

/**
 * Put a camera on a canvas as a self view. On a woven wall a stereo camera is a 3D tile —
 * mirrored CORRECTLY: each half mirrored AND the halves swapped (mirroring a side-by-side frame
 * half by half in place inverts every disparity and turns the face inside out); anywhere else
 * it is the left eye (or the mono frame), flat and mirrored. The stream itself is never touched.
 *
 * `autoConverge` measures the disparity of the point between the eyes a few times a second and
 * shifts the two eyes so the face sits at the display plane; `depth` ([-1, 1], + = push back)
 * is an offset on top — the same control as the call's.
 *
 * @param {object|null} wall  a `createInline3D()` / `sharedInline3D()` result (may be unsupported) or null
 * @param {HTMLCanvasElement} canvas  the tile — its CSS box is the shape the viewer sees
 * @param {StereoCamera} cam
 * On a 3D wall the view follows its tile's `firstWoven`: a window the wall will not weave
 * (`'layer-failed'`, `'session-ended'`) drops the view to the flat left eye — never the packed
 * pair — with `fallbackReason` saying why, and `onRouteChange(route, state)` tells the page (a
 * badge reads `route`). A refused layer is retried a few times; `_reroute(true, wall)` recovers.
 *
 * @param {{ mirror?: boolean, autoConverge?: boolean, depth?: number, aspect?: number, onRouteChange?: Function }} [opts]
 */
export function addCameraView(wall, canvas, cam, opts = {}) {
  if (!canvas || typeof canvas.getContext !== 'function') throw new TypeError(`${TAG} addCameraView(wall, canvas, cam, opts) needs a canvas`);
  if (!isStereoCamera(cam)) throw new TypeError(`${TAG} addCameraView: cam must be a StereoCamera from openCamera()`);
  const view = new CameraView(wall, canvas, cam, opts);
  cam._views?.add(view);
  return view;
}

class CameraView {
  constructor(wall, canvas, cam, o) {
    this.wall = wall || null;
    this.canvas = canvas;
    this.cam = cam;
    this.mirror = o.mirror === undefined ? true : !!o.mirror;
    this.aspect = typeof o.aspect === 'number' && o.aspect > 0.3 && o.aspect < 4 ? o.aspect : 16 / 9;
    this.autoConverge = !!o.autoConverge;
    this.conv = createConvergence();
    this.conv.depth = 0;
    this.setDepth(o.depth);
    this.route = null;
    this.handle = null;
    // Why a pair on a 3D-capable wall is shown FLAT (web#131): the wall said this tile's window
    // will not weave (`firstWoven` → woven:false — 'layer-failed', 'session-ended'). Null while
    // nothing has failed. A packed pair is never the visible fallback: the view paints one eye.
    this.fallbackReason = null;
    // The current registration's settled `firstWoven`, null while pending / not registered.
    this._fw = null;
    this._onRouteChange = typeof o.onRouteChange === 'function' ? o.onRouteChange : null;
    this._layerFails = 0;
    this._layerTimer = 0;
    this.buffer = null; // the SBS canvas the wall repaints the tile from (woven route)
    this.removed = false;
    this._raf = 0;
    this._loop = o._loop !== false;
    this._autoAt = 0;
    this._track = createDisparityTrack();
    this._focus = createFocusTracker();
    this._scratch = null;
    this._luma = null; // the latest grayscale source copy (auto-convergence and the depth cursor read it)
    this.disparityPx = null;
    // `cursor: 'depth'` (ADR-046 on a pair): validated now, its module loaded only on opt-in.
    this._cursorOpt = resolvePairCursorOption(o.cursor, '@displayxr/inline3d/camera');
    /** The depth cursor once its module has loaded; null without `cursor: 'depth'`. */
    this.cursor = null;
    if (this._cursorOpt) {
      import('./camera/pair-cursor.js').then((m) => {
        if (!this.removed) this.cursor = new m.PairCursor(this.canvas, this._cursorOpt);
      });
    }
    this._reroute(false);
    if (this._loop) this._start();
  }

  /**
   * True while the view is on the woven route: registered on a 3D wall, and the wall has not said
   * the tile will not weave (a failed layer drops the view to `'flat-left'`). Route is
   * `'woven-sbs'` (3D on the panel) | `'flat-left'` (a pair, shown flat) | `'flat'` (mono).
   */
  get woven() {
    return this.route === 'woven-sbs';
  }

  /**
   * What is actually on the panel, for diagnostics: `{ route, woven, reason, firstWoven,
   * layerRetries }`. `firstWoven` is the current registration's settled result, `'pending'`
   * before it settles, null off the woven route.
   */
  weaveState() {
    return {
      route: this.route,
      woven: this.woven,
      reason: this.fallbackReason,
      firstWoven: this.route === 'woven-sbs' ? (this._fw ? { ...this._fw } : 'pending') : null,
      layerRetries: this._layerFails,
    };
  }

  /** The per-eye convergence shift currently painted, source px. */
  get convergencePx() {
    return this.conv.current;
  }

  get depth() {
    return this.conv.depth;
  }

  setDepth(v) {
    const n = v === null || v === undefined || !Number.isFinite(+v) ? 0 : Math.max(-1, Math.min(1, +v));
    this.conv.depth = n;
    return n;
  }

  setMirror(on) {
    this.mirror = on === undefined ? !this.mirror : !!on;
    return this.mirror;
  }

  setAutoConverge(on) {
    this.autoConverge = on === undefined ? !this.autoConverge : !!on;
    if (!this.autoConverge) {
      this._track.reset();
      this._focus.reset();
      this.conv.measuredPx = null;
      this.disparityPx = null;
    }
    return this.autoConverge;
  }

  /**
   * Re-register on the wall (the call does this when the weave goes live, #172, or a session is
   * recovered). A FORCED reroute also clears a layer fallback (web#131): a wall that came back
   * gets a fresh registration. An unforced one keeps the view flat while a fallback stands.
   */
  _reroute(force, wall) {
    if (wall !== undefined) this.wall = wall;
    if (this.removed) return;
    if (force && this.fallbackReason) {
      this.fallbackReason = null;
      clearTimeout(this._layerTimer);
      this._layerTimer = 0;
    }
    const cam = this.cam;
    const live = cam.state === 'live' && cam.video;
    const wovenOk = cam.format === 'sbs' && live && this.wall && this.wall.supported && !this.fallbackReason;
    const route = wovenOk ? 'woven-sbs' : cam.format === 'sbs' ? 'flat-left' : 'flat';
    if (!force && route === this.route) return;
    const prev = this.route;
    this._unregister();
    this.route = route;
    if (route === 'woven-sbs') this._registerWoven();
    if (route !== prev) this._routeChanged();
  }

  _registerWoven() {
    if (!this.buffer) this.buffer = document.createElement('canvas');
    this._paintWoven(); // the first frame exists before the layer does
    const handle = this.wall.addImage(this.canvas, this.buffer);
    this.handle = handle;
    this._fw = null;
    const fw = handle && handle.firstWoven;
    if (!fw || typeof fw.then !== 'function') return;
    fw.then((res) => {
      // A result for a registration we already left (removed, re-registered) says nothing now.
      if (this.handle !== handle || this.removed || !res) return;
      this._fw = { woven: !!res.woven, confirmed: !!res.confirmed, reason: res.reason || null, ms: res.ms };
      this.cam.log?.('view-first-woven', { woven: !!res.woven, reason: res.reason || null });
      if (res.woven) {
        this._layerFails = 0;
        this._routeChanged(); // the state settled; the route did not move
      } else if (res.reason !== 'removed') this._layerLost(res.reason || 'layer-failed');
    });
  }

  /**
   * The wall said this window will not weave (web#131): the canvas must never be left showing the
   * packed pair under a 3D badge. Go flat (one eye, mirrored) and say why. A layer the browser
   * refused is retried a few times with backoff while the wall stays up (the remote tile's rule);
   * a session that ended waits for `_reroute(true, wall)` with the new wall.
   */
  _layerLost(reason) {
    this.fallbackReason = reason;
    this._reroute(false);
    if (reason !== 'layer-failed' || this._layerFails >= LAYER_RETRIES) return;
    const delay = Math.min(LAYER_RETRY_MAX_MS, LAYER_RETRY_BASE_MS * Math.pow(2, this._layerFails++));
    this.cam.log?.('view-layer-retry', { attempt: this._layerFails, inMs: delay });
    clearTimeout(this._layerTimer);
    this._layerTimer = setTimeout(() => {
      this._layerTimer = 0;
      if (this.removed || this.fallbackReason !== reason) return;
      this._reroute(true);
    }, delay);
  }

  _routeChanged() {
    if (!this._onRouteChange) return;
    try {
      this._onRouteChange(this.route, this.weaveState());
    } catch (err) {
      console.error(`${TAG} onRouteChange threw`, err);
    }
  }

  /** The wall's session ended: the layer is gone; paint flat until a wall comes back. */
  _onWallLost() {
    // The layer died with the session; `remove()` on it is harmless (try/catch) and keeps the
    // bookkeeping honest. Paint flat until a wall comes back (`_reroute(true, wall)`).
    this._reroute(true, { supported: false });
  }

  _unregister() {
    if (this.handle) {
      try {
        this.handle.remove();
      } catch {
        /* the session may be gone */
      }
      this.handle = null;
    }
  }

  _start() {
    const tick = () => {
      this._raf = requestAnimationFrame(tick);
      this.paint();
    };
    this._raf = requestAnimationFrame(tick);
  }

  /** Paint one frame (the view does this itself every animation frame). */
  paint() {
    if (this.removed) return;
    const v = this.cam.video;
    if (!v || this.cam.state === 'closed') return;
    if (this.route === 'woven-sbs') this._paintWoven();
    else this._paintFlat(v);
  }

  _paintFlat(v) {
    this.cursor?.idle(); // a flat picture has no depth to put a cursor at
    if (!sizeFlat(this.canvas)) return;
    const W = v.videoWidth;
    const H = v.videoHeight;
    if (!W || !H || (v.readyState || 0) < 2) return;
    const g = this.canvas.getContext('2d');
    const eyeW = this.route === 'flat-left' ? W / 2 : W;
    const r = eyeCropRect(eyeW, H, this.canvas.width / this.canvas.height, 0, 0);
    g.save();
    if (this.mirror) {
      g.translate(this.canvas.width, 0);
      g.scale(-1, 1);
    }
    g.drawImage(v, r.sx, r.sy, r.sw, r.sh, 0, 0, this.canvas.width, this.canvas.height);
    g.restore();
  }

  /**
   * The woven pair into `buffer`: mirrored (each half mirrored AND swapped — geometry.js
   * mirrorSwapOps) or as sent, cropped to the tile's aspect, with the convergence shift applied
   * per eye in SOURCE space before any mirroring — which is why the shift's meaning survives the
   * mirror (the pixels equal a whole-frame flip of the converged pair).
   */
  _paintWoven() {
    const v = this.cam.video;
    const W = v.videoWidth;
    const H = v.videoHeight;
    if (!W || !H || (v.readyState || 0) < 2 || !this.buffer) return;
    const eyeW = W / 2;
    const A = this.aspect;
    const { w: outW, h: outH } = eyeOutputSize(eyeW, H, A);
    const c = this.buffer;
    if (c.width !== 2 * outW || c.height !== outH) {
      c.width = 2 * outW;
      c.height = outH;
    }
    const hover = !!(this.cursor && this.cursor.hovering);
    if (this.autoConverge || hover) this._sample(v, hover);
    const shift = this.conv.step(eyeW);
    const g = c.getContext('2d');
    if (this.mirror) {
      for (const op of mirrorSwapOps(W, H)) {
        const eye = op.src === 'L' ? 0 : 1;
        const r = eyeCropRect(eyeW, H, A, shift, eye);
        const dx = op.dx === 0 ? 0 : outW;
        g.save();
        g.translate(dx + outW, 0);
        g.scale(-1, 1);
        g.drawImage(v, op.sx + r.sx, r.sy, r.sw, r.sh, 0, 0, outW, outH);
        g.restore();
      }
    } else {
      for (const eye of [0, 1]) {
        const r = eyeCropRect(eyeW, H, A, shift, eye);
        g.drawImage(v, eye * eyeW + r.sx, r.sy, r.sw, r.sh, eye * outW, 0, outW, outH);
      }
    }
    if (this.cursor) {
      const geo = { rL: eyeCropRect(eyeW, H, A, shift, 0), rR: eyeCropRect(eyeW, H, A, shift, 1), outW, outH, mirror: this.mirror };
      this.cursor.draw(g, this._luma, geo, performance.now() / 1000);
    }
  }

  /**
   * A small grayscale copy of the SOURCE frame (before our shift): ~5 Hz for auto-convergence,
   * ~15 Hz while a depth cursor hovers (it measures the same copy under the pointer).
   */
  _sample(v, hover = false) {
    const now = performance.now();
    if (now - this._autoAt < (hover ? CURSOR_SAMPLE_MS : AUTO_CONV_INTERVAL_MS)) return;
    this._autoAt = now;
    this._scratch = this._scratch || document.createElement('canvas');
    const g = grabLuma(v, this._scratch);
    if (g) this._luma = g;
    if (!this.autoConverge) return;
    const m = g ? this._focus.measure(g.img, g.w, g.h, now) : null;
    const d = this._track.push(m ? m.d / g.scale : null);
    this.conv.measuredPx = d;
    this.disparityPx = d;
  }

  /** Stop painting and leave the wall. The canvas keeps its last frame; the camera stays open. */
  remove() {
    if (this.removed) return;
    this.removed = true;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    clearTimeout(this._layerTimer);
    this._layerTimer = 0;
    this._unregister();
    this.cursor?.dispose();
    this.cursor = null;
    this.cam._views?.delete(this);
  }
}

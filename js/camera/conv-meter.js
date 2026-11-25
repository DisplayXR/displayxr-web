// camera/conv-meter.js — the frame grab and the measuring loop behind auto-convergence, shared by
// a call's SENDER (it measures its own raw, pre-encode frames and sends the result to every peer:
// docs/call.md "Auto-convergence is measured by the sender") and a receiver's FALLBACK (an older
// sender that sends nothing; the depth cursor's copy). Internal: importable by path, not part of
// any entry. The measurement itself is camera/disparity.js.

import { lumaFromRgba, createDisparityTrack, createFocusTracker, downsampleLuma } from './disparity.js';

/** Sampling interval and the per-eye width of the measured copy: enough for sub-pixel disparity on a face, a few ms per measurement. */
export const CONV_METER_INTERVAL_MS = 200;
export const CONV_METER_EYE_WIDTH = 240;

/** WebCodecs pixel formats whose plane 0 is luma (Y): read directly, no colour conversion. */
export const Y_PLANE_FORMATS = new Set(['I420', 'I420A', 'I422', 'I444', 'NV12']);

const nowMs = () => (globalThis.performance ? performance.now() : Date.now());

/**
 * A small grayscale copy of `video`'s current frame, per-eye width at most `eyeMax`.
 *
 * Preferred: WebCodecs. `new VideoFrame(video)` + an ASYNC `copyTo()`, reading the luma (Y) plane
 * directly: no synchronous GPU->CPU canvas readback on the paint path (that readback, not the
 * matching, was ~25 ms of a ~30 ms measurement). Otherwise a small canvas (`scratch`, reused) +
 * `getImageData`. Resolves null for a frame that cannot be read (not decoded yet, tainted, a
 * failed copy). Never rejects.
 *
 * `scale` = copy px per source px; `readMs` = main-thread time spent getting the pixels.
 *
 * @param {HTMLVideoElement} video
 * @param {{eyeMax?: number, scratch?: HTMLCanvasElement|null}} [o]
 * @returns {Promise<{img: Uint8Array, w: number, h: number, scale: number, via: 'videoframe'|'canvas', readMs: number}|null>}
 */
export async function grabLumaFrame(video, { eyeMax = CONV_METER_EYE_WIDTH, scratch = null } = {}) {
  const W = video ? video.videoWidth : 0;
  const H = video ? video.videoHeight : 0;
  if (!W || !H || (video.readyState || 0) < 2) return null;
  if (typeof VideoFrame === 'function') {
    let frame = null;
    try {
      frame = new VideoFrame(video);
    } catch {
      frame = null;
    }
    if (frame && Y_PLANE_FORMATS.has(frame.format)) {
      try {
        const fw = frame.visibleRect ? frame.visibleRect.width : frame.displayWidth;
        const fh = frame.visibleRect ? frame.visibleRect.height : frame.displayHeight;
        const buf = new Uint8Array(frame.allocationSize());
        const layout = await frame.copyTo(buf);
        const t0 = nowMs();
        const f = Math.max(1, Math.ceil(fw / 2 / eyeMax));
        const ds = downsampleLuma(buf, layout[0].offset, layout[0].stride, fw, fh, f);
        return { img: ds.img, w: ds.w, h: ds.h, scale: ds.w / fw, via: 'videoframe', readMs: nowMs() - t0 };
      } catch {
        return null;
      } finally {
        frame.close();
      }
    }
    if (frame) frame.close();
  }
  // Fallback: a small canvas + getImageData (synchronous readback).
  const t0 = nowMs();
  const s = Math.min(1, eyeMax / (W / 2));
  const w = Math.max(2, Math.round((W * s) / 2) * 2);
  const h = Math.max(2, Math.round(H * s));
  const c = scratch || (globalThis.document ? document.createElement('canvas') : null);
  if (!c) return null;
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  try {
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(video, 0, 0, w, h);
    const img = lumaFromRgba(g.getImageData(0, 0, w, h).data, w * h);
    return { img, w, h, scale: w / W, via: 'canvas', readMs: nowMs() - t0 };
  } catch {
    return null; // a frame that cannot be read (tainted, not decoded yet): skip it
  }
}

/**
 * The measuring loop: grab a copy at most every `intervalMs`, find the disparity of the point
 * between the subject's eyes (camera/disparity.js focus tracker), median-of-3 it. A failed grab or
 * measurement HOLDS the last value (a blink, a hand over the face). `reset()` forgets everything,
 * including a grab still in flight.
 *
 * `sample(video, at)` resolves null when it did not sample (too soon, still busy, or reset while
 * in flight), else `{ d, frac, luma, ncc, method, via, ms }`: `d` the held disparity in SOURCE px
 * (left x − right x; null until a first lock), `frac = d / (videoWidth / 2)` (resolution-free, what
 * goes on the wire), `luma` the copy (null if the grab failed), `ncc`/`method` of THIS measurement
 * (null when it failed), `ms` = read + match time.
 *
 * @param {{intervalMs?: number, eyeMax?: number, grab?: typeof grabLumaFrame, now?: () => number}} [o]
 */
export function createConvergenceMeter({ intervalMs = CONV_METER_INTERVAL_MS, eyeMax = CONV_METER_EYE_WIDTH, grab = grabLumaFrame, now = nowMs } = {}) {
  const focus = createFocusTracker();
  const track = createDisparityTrack();
  let lastAt = -Infinity;
  let busy = false;
  let gen = 0;
  let scratch = null;
  const meter = {
    get busy() {
      return busy;
    },
    /** The held disparity (source px), null until a first lock. */
    get d() {
      return track.value;
    },
    async sample(video, at = now()) {
      if (busy || at - lastAt < intervalMs) return null;
      lastAt = at;
      busy = true;
      const g0 = gen;
      try {
        if (!scratch && globalThis.document && typeof document.createElement === 'function') scratch = document.createElement('canvas');
        let got = null;
        try {
          got = await grab(video, { eyeMax, scratch });
        } catch {
          got = null;
        }
        if (g0 !== gen) return null; // reset() while the grab was in flight: a stale frame
        const t = now();
        const m = got ? focus.measure(got.img, got.w, got.h, at) : null;
        const d = track.push(m ? m.d / got.scale : null);
        const W = video && video.videoWidth;
        return {
          d,
          frac: d !== null && W > 0 ? d / (W / 2) : null,
          luma: got ? { img: got.img, w: got.w, h: got.h, scale: got.scale } : null,
          ncc: m ? m.c : null,
          method: m ? m.method : null,
          via: got ? got.via : null,
          ms: (got ? got.readMs : 0) + (now() - t),
        };
      } finally {
        if (g0 === gen) busy = false;
      }
    },
    reset() {
      gen++;
      busy = false;
      lastAt = -Infinity;
      focus.reset();
      track.reset();
    },
  };
  return meter;
}

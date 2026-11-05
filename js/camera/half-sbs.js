// camera/half-sbs.js — USB stereo webcams that send a half-width side-by-side frame: one 16:9
// image whose left and right halves are each an eye squeezed 2:1 in width.
//
// Shape cannot identify these: a 3840x2160 half-SBS frame looks exactly like a 4K webcam's, so they
// are listed by USB id. Asking one for a wide mode does not help either: the browser reaches
// 3840x1080 by cropping the middle rows of 3840x2160, which still reads as a pair but leaves each
// eye 2x too tall with half the vertical view. So the camera is read in its native mode and every
// frame is redrawn, eyes un-squeezed, into a true side-by-side track.

/** USB `vvvv:pppp` ids of cameras that send half-SBS (the browser's label ends with the id). */
export const HALF_SBS_USB_IDS = Object.freeze(['0733:011a']);

/** The widest eye sent: the runtime's own output for such a camera (2560x720 side by side). */
const MAX_EYE_WIDTH = 1280;
const NATIVE_CONSTRAINTS = { width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 30 }, resizeMode: 'none' };

/** Does this device label name a half-SBS camera? */
export function isHalfSbsCamera(label) {
  const l = String(label || '').toLowerCase();
  return HALF_SBS_USB_IDS.some((id) => l.includes(`(${id})`));
}

/** The full-SBS frame size for a half-SBS source: square-pixel eyes, no upscaling, even numbers. */
export function unsqueezedSize(width, height) {
  const eyeW = Math.min(MAX_EYE_WIDTH, width);
  const eyeH = Math.max(2, Math.round((eyeW * height) / width / 2) * 2);
  return { width: eyeW * 2, height: eyeH };
}

/**
 * Put `source` in its native mode and return a side-by-side track with the eyes un-squeezed, or
 * null when that cannot be done here (the engine has no MediaStreamTrackProcessor or the camera
 * refuses a 16:9 mode); the source is then left open as it is. Stopping the returned track stops
 * the source.
 *
 * @param {MediaStreamTrack} source
 * @returns {Promise<{stream: MediaStream, track: MediaStreamTrack, width: number, height: number}|null>}
 */
export async function unsqueezeHalfSbs(source) {
  if (typeof MediaStreamTrackProcessor !== 'function' || typeof document === 'undefined') return null;
  try {
    await source.applyConstraints(NATIVE_CONSTRAINTS);
  } catch {
    return null;
  }
  const st = source.getSettings();
  if (!(st.width > 0) || !(st.height > 0) || Math.abs(st.width / st.height - 16 / 9) > 0.01) return null;

  const { width, height } = unsqueezedSize(st.width, st.height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return null;
  const stream = canvas.captureStream(st.frameRate > 0 ? st.frameRate : 30);
  const track = stream.getVideoTracks()[0];
  const reader = new MediaStreamTrackProcessor({ track: source }).readable.getReader();

  let stopped = false;
  const stopTrack = track.stop.bind(track);
  track.stop = () => {
    stopped = true;
    reader.cancel().catch(() => {});
    source.stop();
    stopTrack();
  };
  (async () => {
    for (;;) {
      const { value: frame, done } = await reader.read();
      if (done) break;
      ctx.drawImage(frame, 0, 0, width, height);
      frame.close();
    }
  })()
    .catch(() => {})
    .finally(() => {
      if (stopped) return;
      // The camera went away: this track ends with it, like the device's own would.
      track.stop();
      track.dispatchEvent(new Event('ended'));
    });
  return { stream, track, width, height };
}

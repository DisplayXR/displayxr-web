// camera/converge.js — the convergence state of a side-by-side tile (RFC 0002 §3): the per-eye
// shift that puts a subject at the display plane, from a MEASURED disparity (camera/disparity.js),
// a sender's hint (focal length · baseline / distance), and the page's depth offset, low-passed
// per painted frame. Shared by `/camera` (the self view, capture metadata) and `/call` (remote
// tiles). Pure — see test/call.test.mjs and test/call-autoconv.test.mjs.

/** Low-pass factor for the convergence shift (RFC §3): next = prev + α·(target − prev). */
export const CONVERGENCE_ALPHA = 0.2;

/** The convergence shift never exceeds this fraction of the per-eye width, either way. */
export const CONVERGENCE_MAX_FRACTION = 0.12;

/** `setDepth(v)`: v in [-1, 1] adds v times this fraction of the per-eye width to the shift. */
export const DEPTH_RANGE_FRACTION = 0.05;

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
    // Auto-convergence (call/disparity.js): the MEASURED disparity of the point between the remote
    // person's eyes, in source eye pixels (left x − right x). When set it wins over the hint: it is
    // read off the frames, so it needs no calibration and cannot disagree with them.
    measuredPx: null,
    depth: 0, // setDepth(), [-1, 1]
    current: 0,
    target(eyeWidthPx) {
      const auto =
        s.measuredPx !== null
          ? s.measuredPx / 2 // half the disparity comes off each eye: the eyes land at zero parallax
          : s.hello && s.subjectZmm
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

// inline3d-frame-clock.js — the per-scene-window frame clock behind `handle.stats()` (web#278).
//
// Why it exists. An app that adapts its backing-buffer resolution to hold a frame rate needs to
// tell "my frame is expensive" from "the compositor delivers frames at this cadence whatever I
// do". On an Android 3D tablet a full-window woven canvas settled at a flat ~33.5 ms callback
// interval (every second vsync) that did not move with a 10x triangle count or a different eye
// width, while its onFrame used 4-6 ms of CPU. A scaler chasing 16.6 ms drove resolution to its
// floor and gained nothing. The core already counted frames; it did not report their clock.
//
// What it measures, per scene window:
//   - the interval between consecutive onFrame deliveries, on the XR frame timestamp (the `t` the
//     session hands requestAnimationFrame — the session's own clock, not when JS got round to it);
//   - the wall time onFrame itself took (performance.now() around the call). That is CPU time on
//     the main thread: WebGL commands are queued, so GPU cost is NOT in it.
//
// Guidelines, never guardrails: this reports numbers and changes nothing. It never throttles,
// clamps or skips a frame.
//
// Cost: two Float64Array rings of RING entries per scene window, allocated once. tick()/cb() write
// one slot and allocate nothing. read() (called from stats()) sorts copies into two scratch arrays
// that are also allocated once; only the returned report object is new.

export const RING = 120; // ~2 s at 60 Hz, ~4 s at 30 Hz: long enough for a stable p95, short enough to follow a change.

// Below this many intervals the percentiles are noise and `paced` stays null.
export const MIN_SAMPLES = 30;

// An interval longer than this is a pause (tab hidden, debugger, a layer that came back), not a
// frame interval; it is not recorded, and the next delivery starts a fresh pair.
export const PAUSE_MS = 1000;

/**
 * Create one window's frame clock.
 * @returns {{ tick(t:number, frameNo:number):void, cb(ms:number):void, reset():void,
 *   read(sessionHz?:number|null):FrameClockReport }}
 */
export function createFrameClock(size = RING) {
  const iv = new Float64Array(size);
  const cbs = new Float64Array(size);
  const sIv = new Float64Array(size);
  const sCb = new Float64Array(size);
  let ivN = 0;
  let ivAt = 0;
  let cbN = 0;
  let cbAt = 0;
  let lastT = NaN;
  let lastFrameNo = -2;

  return {
    /**
     * One onFrame delivery. `frameNo` is the manager's session-frame counter: an interval is only
     * recorded between deliveries on CONSECUTIVE session frames, so a window that sat out frames
     * (no layer, scrolled away) does not report the gap as one long frame.
     */
    tick(t, frameNo) {
      if (Number.isFinite(t) && Number.isFinite(lastT) && frameNo === lastFrameNo + 1) {
        const d = t - lastT;
        if (d > 0 && d < PAUSE_MS) {
          iv[ivAt] = d;
          ivAt = (ivAt + 1) % size;
          if (ivN < size) ivN++;
        }
      }
      lastT = t;
      lastFrameNo = frameNo;
    },
    /** The wall time one onFrame call took, in ms. */
    cb(ms) {
      if (!(ms >= 0) || !Number.isFinite(ms)) return;
      cbs[cbAt] = ms;
      cbAt = (cbAt + 1) % size;
      if (cbN < size) cbN++;
    },
    reset() {
      ivN = ivAt = cbN = cbAt = 0;
      lastT = NaN;
      lastFrameNo = -2;
    },
    /**
     * The report. `sessionHz` is what the session says its display runs at (XRSession.frameRate),
     * or null/undefined when it says nothing.
     */
    read(sessionHz) {
      const interval = ivN ? pcts(iv, ivN, sIv) : null;
      const cbMs = cbN ? pcts(cbs, cbN, sCb) : null;
      const hz = Number.isFinite(sessionHz) && sessionHz > 0 ? sessionHz : null;
      return {
        frameIntervalMs: interval,
        cbMs,
        frameClockSamples: ivN,
        displayHz: hz,
        displayHzSource: hz === null ? null : 'session',
        paced: pacedHint(interval, cbMs, ivN, hz),
      };
    },
  };
}

function pcts(src, n, scratch) {
  for (let i = 0; i < n; i++) scratch[i] = src[i];
  const a = scratch.subarray(0, n);
  a.sort();
  return { p50: round2(pick(a, 0.5)), p95: round2(pick(a, 0.95)) };
}

// Nearest-rank percentile on a sorted array.
function pick(a, p) {
  const i = Math.min(a.length - 1, Math.max(0, Math.ceil(p * a.length) - 1));
  return a[i];
}

function round2(x) {
  return Math.round(x * 100) / 100;
}

// The `paced` heuristic, computed from the numbers above — never guessed:
//
//   paced = the interval is STEADY       (p95 <= 1.15 x p50)
//       AND the callback is IDLE         (cb p50 <= 0.5 x interval p50)
//       AND, when the refresh is known,  the interval is QUANTISED: p50 within 8% of k x refresh
//                                        period for some whole k >= 1.
//
// true  -> the interval is set by the compositor's cadence, not by your callback; spending less
//          CPU will not shorten it. (It can still be GPU-bound: GPU work is not in cbMs. Changing
//          the resolution and seeing whether the interval moves is the decisive test.)
// false -> at least one condition failed: the interval wanders, the callback eats most of it, or
//          it is not a whole number of refresh periods.
// null  -> not enough data (fewer than MIN_SAMPLES intervals, or no callback timings).
export function pacedHint(interval, cbMs, samples, displayHz) {
  if (!interval || !cbMs || samples < MIN_SAMPLES || !(interval.p50 > 0)) return null;
  const steady = interval.p95 <= 1.15 * interval.p50;
  const idle = cbMs.p50 <= 0.5 * interval.p50;
  let quantised = true;
  if (displayHz) {
    const period = 1000 / displayHz;
    const k = Math.max(1, Math.round(interval.p50 / period));
    quantised = Math.abs(interval.p50 - k * period) <= 0.08 * k * period;
  }
  return steady && idle && quantised;
}

/**
 * @typedef {{ p50:number, p95:number }} Pctl
 * @typedef {{ frameIntervalMs: Pctl|null, cbMs: Pctl|null, frameClockSamples:number,
 *   displayHz:number|null, displayHzSource:'session'|null, paced:boolean|null }} FrameClockReport
 */

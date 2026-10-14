// inline3d-cursor-perf.js — what keeps the depth cursor responsive, dependency-free and internal
// (not a package subpath; ./three's DepthCursor is its only user):
//
//  - CursorAmortisedPick: the footprint pick spread over frames. The sprite is placed every frame
//    at the NEWEST pointer position with the last known depth; the pick only refreshes that depth,
//    a few rays a frame, so it never stretches the frame it runs in. The depth filter (rise 30 ms,
//    sink 250 ms) absorbs the cadence.
//  - CursorDebugStats: `cursor: { debug: true }` — per-frame cost, rays and frame interval as
//    rolling stats, printed at most once a second. Nothing is built without the option.
//
// The policy (ADR-046 Amendment 2: never behind the glass, the OS cursor on it, the hybrid anchor
// exact while moving) is untouched: it lives in CursorDepthPlacer, downstream of the pick.

/** Rays a frame ./model's three.js cursor casts (with a BVH, a ray costs a few microseconds). */
export const CURSOR_MODEL_RAYS_PER_FRAME = 3;

/**
 * The footprint pick, amortised: `raysPerFrame` rays a frame, cycling every (footprint point, eye)
 * slot. The slot order covers every footprint point once (alternating eyes) before it repeats a
 * point, so a full spatial sweep takes ceil(points / N) frames and both eyes twice that.
 *
 * Each slot keeps its last hit (a world point, or null for a miss) and the hotspot it was cast
 * from. A slot cast from a hotspot more than `reach` away (canvas heights) is stale — the pointer
 * has moved on — and is ignored, so a fast-moving pointer is judged on its freshest rays only and
 * a still one on the whole footprint.
 */
export class CursorAmortisedPick {
  /** @param {number} raysPerFrame  >= 1. */
  constructor(raysPerFrame) {
    this.raysPerFrame = Math.max(1, Math.floor(raysPerFrame) || 1);
    this._slots = []; // { point, u, v } | undefined (never cast)
    this._next = 0;
    this._n = 0; // slot count the ring was sized for
    /** Rays cast by the last step (diagnostics). */
    this.lastRays = 0;
  }

  /** Forget every slot (the next step starts a fresh sweep). */
  reset() {
    this._slots.length = 0;
    this._next = 0;
    this._n = 0;
  }

  /**
   * The (point, eye) of slot `k` among `points` × `eyes`: eye = (point + sweep) mod eyes, so each
   * sweep of `points` slots alternates eyes and the next sweep takes the other ones.
   */
  static slot(k, points, eyes) {
    const p = k % points;
    return [p, (p + Math.floor(k / points)) % eyes];
  }

  /**
   * Cast this frame's rays and return the nearest live hit, or null.
   * @param {Array<[number, number]>} footprint  canvas-normalised points, the hotspot first.
   * @param {number} eyes  how many views to cast from (1 or 2).
   * @param {(eye: number, u: number, v: number) => number[]|null} cast  one ray → its hit.
   * @param {number[]} forward  the viewing direction (unit): smaller dot = nearer the viewer.
   * @param {number} aspect  canvas width / height (u distances are scaled by it).
   * @param {number} reach  how far (canvas heights) the hotspot may have moved since a slot was cast.
   */
  step(footprint, eyes, cast, forward, aspect, reach) {
    const P = footprint.length;
    const E = Math.max(1, eyes | 0);
    const n = P * E;
    if (n !== this._n) {
      this.reset();
      this._n = n;
    }
    const [u0, v0] = footprint[0];
    const rays = Math.min(this.raysPerFrame, n);
    for (let i = 0; i < rays; i++) {
      const k = this._next;
      this._next = (k + 1) % n;
      const [p, e] = CursorAmortisedPick.slot(k, P, E);
      this._slots[k] = { point: cast(e, footprint[p][0], footprint[p][1]), u: u0, v: v0 };
    }
    this.lastRays = rays;
    const r2 = reach * reach;
    let best = Infinity, nearest = null;
    for (let k = 0; k < n; k++) {
      const s = this._slots[k];
      if (!s || !s.point) continue;
      const du = (s.u - u0) * aspect, dv = s.v - v0;
      if (du * du + dv * dv > r2) continue; // cast from where the pointer no longer is
      const q = s.point;
      const depth = q[0] * forward[0] + q[1] * forward[1] + q[2] * forward[2];
      if (depth < best) {
        best = depth;
        nearest = q;
      }
    }
    return nearest;
  }
}

/** `cursor.debug` → the stats mode: false (off), 'stats', or 'both' (stats + the OS cursor kept visible). */
export function cursorDebugMode(debug) {
  if (debug === 'both') return 'both';
  return debug ? 'stats' : false;
}

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const quantile = (a, q) => {
  if (!a.length) return 0;
  const s = Float64Array.from(a).sort();
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const max = (a) => (a.length ? Math.max(...a) : 0);
const stat = (a) => ({ mean: mean(a), p95: quantile(a, 0.95), max: max(a), n: a.length });
const f = (x, d = 2) => x.toFixed(d);

function describePick(p) {
  if (p.mode !== 'bvh') return p.mode;
  return `bvh (${p.built} built in ${f(p.buildMs, 1)} ms${p.refits ? `, ${p.refits} refits` : ''}${p.failed ? `, ${p.failed} failed` : ''}, ${p.plainCasts} plain casts)`;
}

/**
 * Rolling per-frame stats for `cursor: { debug }`, summarised and logged at most once per
 * `periodMs` — never per frame. `history` keeps the last 120 summaries (two minutes) for a
 * harness to read; `last` is the newest.
 */
export class CursorDebugStats {
  /**
   * @param {{tag?: string, periodMs?: number, log?: (line: string) => void, info?: (() => object)|null}} [opts]
   *        `info`: the hit test's own diagnostics (which pick answers), copied into each summary as `pick`.
   */
  constructor({ tag = '[inline3d] cursor', periodMs = 1000, log, info = null } = {}) {
    this.tag = tag;
    this.info = info;
    /** Which event feeds the pointer ('pointerrawupdate' / 'pointermove'), when the owner knows. */
    this.source = null;
    this.periodMs = periodMs;
    this.log = log || ((line) => console.info(line));
    /** @type {object|null} */
    this.last = null;
    /** @type {object[]} */
    this.history = [];
    this._start = null;
    this._prev = null;
    this._clear();
  }

  _clear() {
    this._update = [];
    this._rays = [];
    this._frame = [];
    this._age = [];
    this._samples = 0;
  }

  /**
   * One frame.
   * @param {number} updateMs  what DepthCursor.update() took.
   * @param {number} rays  rays it cast.
   * @param {number} nowMs  the frame time (performance.now()).
   * @param {number|null} pointerAgeMs  age of the pointer sample this frame used, when it is NEW
   *        this frame (null when the pointer has not moved since the last frame).
   * @param {number} [samples=0]  pointer samples received since the last frame.
   * @returns {object|null}  the summary when one was emitted this frame.
   */
  frame(updateMs, rays, nowMs, pointerAgeMs = null, samples = 0) {
    if (this._start === null) this._start = nowMs;
    if (this._prev !== null && nowMs > this._prev) this._frame.push(nowMs - this._prev);
    this._prev = nowMs;
    this._update.push(updateMs);
    this._rays.push(rays);
    if (pointerAgeMs !== null && pointerAgeMs >= 0 && Number.isFinite(pointerAgeMs)) this._age.push(pointerAgeMs);
    this._samples += samples;
    if (nowMs - this._start < this.periodMs) return null;
    const s = {
      frames: this._update.length,
      seconds: (nowMs - this._start) / 1000,
      updateMs: stat(this._update),
      rays: stat(this._rays),
      frameMs: stat(this._frame),
      pointerAgeMs: stat(this._age),
      samplesPerFrame: this._update.length ? this._samples / this._update.length : 0,
      pointerSource: this.source,
      pick: this.info ? this.info() : null,
    };
    this.last = s;
    this.history.push(s);
    if (this.history.length > 120) this.history.shift();
    this._start = nowMs;
    this._clear();
    this.log(
      `${this.tag} debug: ${s.frames} frames` +
        ` · update ${f(s.updateMs.mean)} ms avg / ${f(s.updateMs.p95)} p95 / ${f(s.updateMs.max)} max` +
        ` · rays ${f(s.rays.mean, 1)}/frame (max ${s.rays.max})` +
        ` · frame ${f(s.frameMs.mean, 1)} ms avg / ${f(s.frameMs.p95, 1)} p95 / ${f(s.frameMs.max, 1)} max` +
        (s.pointerAgeMs.n ? ` · pointer age ${f(s.pointerAgeMs.mean, 1)} ms avg / ${f(s.pointerAgeMs.max, 1)} max` : '') +
        ` · ${f(s.samplesPerFrame, 1)} pointer samples/frame${s.pointerSource ? ` (${s.pointerSource})` : ''}` +
        (s.pick ? ` · pick ${describePick(s.pick)}` : ''),
    );
    return s;
  }
}

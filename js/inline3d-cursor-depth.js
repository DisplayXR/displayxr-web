// inline3d-cursor-depth.js — the depth-aware cursor's placement maths, dependency-free.
//
// The OS cursor is flat: it is drawn at zero disparity, on the glass. Hover it over content that
// pops OUT of the glass and it is drawn on top of pixels whose disparity says they are in front
// of it — a depth violation, and it reads as a broken image. The fix is a cursor SPRITE drawn at
// the depth of the nearest content under it.
//
// This is a line-for-line port of the runtime's `u_cursor_depth` (displayxr-runtime ADR-046,
// extension XR_DXR_cursor_depth), so a web page and a native app place their cursors
// identically. The test file pins the same numbers as the runtime's C tests.
//
// Division of labour, as in the runtime: the PAGE knows its content, so it supplies the nearest
// content point under the cursor (a raycast, a depth readback, a depth map); this module decides
// where the sprite goes, how big it is, and how it moves over time. ./three's `DepthCursor` wires
// both for a three.js scene. Nothing here runs unless a page calls it — opt-in, zero cost
// otherwise.
//
// The geometry is solved from the VIEWS the page is about to render (projection + transform
// matrices, column-major, as an XRView carries them), never from rig internals, so it is
// correct for display rigs, camera rigs, any scale, and any view count >= 2:
//
//  - S, the canvas point under the cursor, is where the two outermost view rays through (u, v)
//    meet (every off-axis frustum frames the same canvas);
//  - E, the cyclopean eye, is the midpoint of those two views;
//  - a point's depth is t = its distance in front of E along the display normal over S's
//    (t = 1 on the canvas, t < 1 in front of it);
//  - the policy works in DISPARITY d = 1 - 1/t, in eye-baseline units (on-screen disparity =
//    baseline × d): 0 on the canvas, < 0 in front. The eye compares disparities, so the margin,
//    the clamp and the slew rates live there;
//  - the sprite goes at C = E + t (S - E) — on the cyclopean ray, so it never slides sideways
//    as it rises — with its height scaled by t so its apparent size is constant.

/** Default sprite height, as a fraction of the canvas height. */
export const CURSOR_DEFAULT_HEIGHT = 0.03;

/**
 * The runtime's defaults (u_cursor_depth_tuning_defaults), in the same units.
 * Disparities are in eye-baseline units; times in seconds.
 */
export const CURSOR_DEFAULT_TUNING = Object.freeze({
  /** How far in front of the content the cursor floats (~2 mm on screen at 65 mm IPD). */
  margin: 0.03,
  /** Comfort clamp: t >= 0.625, never more than ~3/8 of the way to the eye. */
  minDisparity: -0.6,
  maxDisparity: 0.6,
  /** Rising toward the viewer is fast — never lag behind content that comes forward. */
  riseTau: 0.03,
  /** Sinking away is slow — no flicker as the footprint crosses an edge. */
  sinkTau: 0.25,
  /** A gap longer than this re-primes (snaps) the filter. */
  stale: 0.5,
});

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const addScaled = (a, b, s) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const finite3 = (a) => Number.isFinite(a[0]) && Number.isFinite(a[1]) && Number.isFinite(a[2]);
const rotate = (m, v) => [
  m[0] * v[0] + m[4] * v[1] + m[8] * v[2],
  m[1] * v[0] + m[5] * v[1] + m[9] * v[2],
  m[2] * v[0] + m[6] * v[1] + m[10] * v[2],
];

/**
 * The ray from a view through canvas point (u, v) — origin and (unnormalised) direction in the
 * space of the view's transform. (u, v) is canvas-normalised: [0,1]², origin top-left, v down.
 *
 * Use this for the page's own hit test, so the rays it casts are exactly the rays the placement
 * is solved from.
 *
 * @param {{projectionMatrix: ArrayLike<number>, transformMatrix: ArrayLike<number>}} view
 * @param {number} u
 * @param {number} v
 * @returns {{origin: number[], direction: number[]}}
 */
export function cursorViewRay(view, u, v) {
  const p = view.projectionMatrix;
  const m = view.transformMatrix;
  // Any perspective projection maps view-space (X, Y, Z) to NDC x = (a X + c Z) / -Z, so the
  // view-space direction through NDC (x, y) is ((x + c) / a, (y + d) / b, -1).
  const x = 2 * u - 1;
  const y = 1 - 2 * v;
  const d = [(x + p[8]) / p[0], (y + p[9]) / p[5], -1];
  return { origin: [m[12], m[13], m[14]], direction: rotate(m, d) };
}

/**
 * Solve the cursor's line of sight from two views (normally the first and the last).
 * @returns {object|null} the geometry, or null when degenerate — coincident views (2D), parallel
 *   rays, (u, v) off the canvas, non-finite input.
 */
export function solveCursorGeometry(viewA, viewB, u, v) {
  if (!(u >= 0 && u <= 1 && v >= 0 && v <= 1)) return null;
  const ra = cursorViewRay(viewA, u, v);
  const rb = cursorViewRay(viewB, u, v);
  const p1 = ra.origin, d1 = ra.direction, p2 = rb.origin, d2 = rb.direction;
  if (!finite3(p1) || !finite3(p2) || !finite3(d1) || !finite3(d2)) return null;

  // Closest points of p1 + s d1 and p2 + r d2; the midpoint absorbs float noise.
  const w0 = sub(p1, p2);
  const aa = dot(d1, d1), bb = dot(d1, d2), cc = dot(d2, d2);
  const dd = dot(d1, w0), ee = dot(d2, w0);
  const den = aa * cc - bb * bb;
  if (dot(w0, w0) <= 0 || !(den > 1e-12 * aa * cc)) return null;
  const s = (bb * ee - cc * dd) / den;
  const r = (aa * ee - bb * dd) / den;
  if (!(s > 0 && r > 0)) return null;
  const q1 = addScaled(p1, d1, s), q2 = addScaled(p2, d2, r);
  const canvasPoint = [(q1[0] + q2[0]) / 2, (q1[1] + q2[1]) / 2, (q1[2] + q2[2]) / 2];
  const eye = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2, (p1[2] + p2[2]) / 2];

  const ma = viewA.transformMatrix;
  const fwd = rotate(ma, [0, 0, -1]);
  const fl = Math.hypot(fwd[0], fwd[1], fwd[2]);
  const forward = [fwd[0] / fl, fwd[1] / fl, fwd[2] / fl];
  const eyeToCanvas = dot(sub(canvasPoint, eye), forward);
  // Canvas height from view A's frustum: tan(up) - tan(down) = 2 / b.
  const canvasHeight = dot(sub(canvasPoint, p1), forward) * (2 / viewA.projectionMatrix[5]);
  if (!(eyeToCanvas > 0) || !(canvasHeight > 0) || !Number.isFinite(canvasHeight)) return null;

  return { eye, canvasPoint, forward, eyeToCanvas, canvasHeight, basis: orthonormalBasis(ma) };
}

/** The view's rotation as unit X/Y/Z columns (a transform with parent scale still works). */
function orthonormalBasis(m) {
  const col = (i) => {
    const c = [m[i], m[i + 1], m[i + 2]];
    const l = Math.hypot(c[0], c[1], c[2]) || 1;
    return [c[0] / l, c[1] / l, c[2] / l];
  };
  return { x: col(0), y: col(4), z: col(8) };
}

/**
 * Disparity of a point (eye-baseline units; 0 on the canvas, < 0 in front).
 * @returns {number|null} null when the point is not in front of the eye.
 */
export function cursorPointDisparity(g, point) {
  if (!finite3(point)) return null;
  const t = dot(sub(point, g.eye), g.forward) / g.eyeToCanvas;
  if (!(t > 0) || !Number.isFinite(t)) return null;
  return 1 - 1 / t;
}

/** Target disparity: content minus the margin, clamped; 0 (the canvas) with nothing under it. */
export function cursorTarget(tuning, hasContent, contentDisparity) {
  if (!hasContent || !Number.isFinite(contentDisparity)) return 0;
  return Math.min(tuning.maxDisparity, Math.max(tuning.minDisparity, contentDisparity - tuning.margin));
}

/**
 * Advance the filter toward `target`. `filter` is a plain object, `{}` to start (the first step
 * snaps). A call at a time not after the previous one does not advance it.
 * @param {number} nowSec  seconds (e.g. rAF timestamp / 1000).
 */
export function cursorFilterStep(filter, tuning, target, nowSec) {
  if (!filter.primed || nowSec < filter.last || nowSec - filter.last > tuning.stale) {
    filter.primed = true;
    filter.disparity = target;
    filter.last = nowSec;
    return target;
  }
  if (nowSec === filter.last) return filter.disparity;
  const dt = nowSec - filter.last;
  const tau = target < filter.disparity ? tuning.riseTau : tuning.sinkTau;
  const alpha = tau > 0 ? 1 - Math.exp(-dt / tau) : 1;
  filter.disparity += alpha * (target - filter.disparity);
  filter.last = nowSec;
  return filter.disparity;
}

/** Where to draw a sprite at `disparity`, and how tall, for `heightFraction` of the canvas. */
export function placeCursor(g, disparity, heightFraction) {
  const t = 1 / (1 - disparity);
  const hf = heightFraction > 0 && Number.isFinite(heightFraction) ? heightFraction : CURSOR_DEFAULT_HEIGHT;
  return { position: addScaled(g.eye, sub(g.canvasPoint, g.eye), t), height: hf * g.canvasHeight * t };
}

/**
 * The whole pipeline with its state: one per cursor.
 *
 *   const placer = new CursorDepthPlacer();
 *   // per frame, with the views you are about to render:
 *   const p = placer.update(views, { u, v, nearestPoint, cursorHeight: 0.03 }, now / 1000);
 *   if (p.active) drawSprite(p.position, p.basis, p.height);
 *
 * `views` are `{projectionMatrix, transformMatrix}` (or XRViews — `transform.matrix` is read
 * when `transformMatrix` is absent). `nearestPoint` is the content point under the cursor
 * FOOTPRINT nearest the viewer, in the views' space, or null for "nothing under it".
 */
export class CursorDepthPlacer {
  constructor(tuning = CURSOR_DEFAULT_TUNING) {
    this.tuning = tuning;
    this.filter = {};
  }

  update(views, hint, nowSec) {
    const inactive = { active: false, position: null, basis: null, height: 0, disparity: 0, targetDisparity: 0 };
    if (!views || views.length < 2 || !hint) return inactive;
    const a = asView(views[0]);
    const b = asView(views[views.length - 1]);
    const g = solveCursorGeometry(a, b, hint.u, hint.v);
    if (!g) return inactive;
    const content = hint.nearestPoint ? cursorPointDisparity(g, hint.nearestPoint) : null;
    const target = cursorTarget(this.tuning, content !== null, content);
    const disparity = cursorFilterStep(this.filter, this.tuning, target, nowSec);
    const { position, height } = placeCursor(g, disparity, hint.cursorHeight);
    return { active: true, position, basis: g.basis, height, disparity, targetDisparity: target, geometry: g };
  }
}

function asView(v) {
  return v.transformMatrix ? v : { projectionMatrix: v.projectionMatrix, transformMatrix: v.transform.matrix };
}

/**
 * The pointer half of a depth cursor, shared by every backend: tracks the pointer over the
 * canvas (canvas-normalised, v down) and hides the CSS cursor exactly while a sprite replaces it.
 * Constructing one adds two listeners; nothing else runs until a backend asks for `uv`.
 */
export class CursorPointer {
  /** @param {HTMLElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    /** `[u, v]` while the pointer is over the canvas, else null. */
    this.uv = null;
    this._hidden = false;
    this._prev = '';
    this._onMove = (e) => {
      const r = canvas.getBoundingClientRect();
      this.uv = r.width > 0 && r.height > 0 ? [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height] : null;
    };
    this._onLeave = () => {
      this.uv = null;
    };
    canvas.addEventListener('pointermove', this._onMove);
    canvas.addEventListener('pointerleave', this._onLeave);
  }

  /** Set the pointer directly (canvas-normalised, v down), or null — for scripted input. */
  set(u, v) {
    this.uv = u === null || u === undefined ? null : [u, v];
  }

  /** The canvas aspect (width / height), for a round footprint. */
  aspect() {
    const r = this.canvas.getBoundingClientRect();
    return r.height > 0 ? r.width / r.height : 1;
  }

  /** Hide (true) or restore (false) the CSS cursor; idempotent. */
  hideCss(hide) {
    if (hide === this._hidden) return;
    if (hide) {
      this._prev = this.canvas.style.cursor || '';
      this.canvas.style.cursor = 'none';
    } else {
      this.canvas.style.cursor = this._prev;
    }
    this._hidden = hide;
  }

  dispose() {
    this.canvas.removeEventListener('pointermove', this._onMove);
    this.canvas.removeEventListener('pointerleave', this._onLeave);
    this.hideCss(false);
  }
}

/**
 * The footprint ring every backend samples: the hotspot plus 8 points on a circle of radius
 * 0.75 × the sprite height (canvas heights), so the sprite and a margin are covered.
 * @returns {Array<[number, number]>} canvas-normalised points, the hotspot first.
 */
export function cursorFootprint(u, v, height, aspect) {
  const r = 0.75 * height;
  const out = [[u, v]];
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4;
    out.push([u + (r * Math.cos(a)) / aspect, v + r * Math.sin(a)]);
  }
  return out;
}

/**
 * The crosshair every backend draws: 8 segments in the sprite's own XY plane, unit = sprite
 * height (a "+" with a gap and a small square at the hotspot), as [x0, y0, x1, y1] tuples.
 */
export const CURSOR_CROSSHAIR = Object.freeze([
  [-0.5, 0, -0.15, 0], [0.15, 0, 0.5, 0], [0, -0.5, 0, -0.15], [0, 0.15, 0, 0.5],
  [-0.15, -0.15, 0.15, -0.15], [0.15, -0.15, 0.15, 0.15], [0.15, 0.15, -0.15, 0.15], [-0.15, 0.15, -0.15, -0.15],
]);

/**
 * The crosshair's segment endpoints in the views' space for a placement, as a flat
 * [x, y, z, x, y, z, …] array (16 points) — what a line renderer takes.
 */
export function cursorCrosshairPoints(placement, out = []) {
  out.length = 0;
  const { position: p, basis: b, height: h } = placement;
  for (const [x0, y0, x1, y1] of CURSOR_CROSSHAIR) {
    for (const [x, y] of [[x0, y0], [x1, y1]]) {
      out.push(
        p[0] + (b.x[0] * x + b.y[0] * y) * h,
        p[1] + (b.x[1] * x + b.y[1] * y) * h,
        p[2] + (b.x[2] * x + b.y[2] * y) * h,
      );
    }
  }
  return out;
}

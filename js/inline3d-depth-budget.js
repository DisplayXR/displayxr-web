// inline3d-depth-budget.js — how deep is this scene, in the units a 3D display cares about.
//
// Pure functions, dependency-free, re-exported by ./inline3d.js (the root), ./three and the
// `./depth` subpath. NOTHING HERE CHANGES A PIXEL: these are measurements, plus one-time warnings.
// The SDK never clamps, refuses or overrides a depth a page asked for. The one consumer that acts
// on a number from here is the OPT-IN `depth` option of ./model and ./splat, which feeds
// comfortDepthFactor's result into the display rig it declares (only ever lowering depth).
//
// The units are relative, which is what makes them portable across panels: disparity as a
// percentage of the TILE's width, or depth in TILE HEIGHTS on a display rig (where the canvas is a
// portal and world depth / virtualDisplayHeight equals physical depth / the tile's physical
// height). Depth ranges measured on a panel are in docs/authoring-inline-3d.md; they are reference
// points, not limits this module applies.
//
// The conversion on a display rig: physical depth z = depthH · h (h = the tile's physical height),
// on-screen disparity p = e · z / (V ∓ z) (e = 0.063 m, V = the nominal viewer distance, − in
// front, + behind), as a percentage of the tile width w = aspect · h. When h is unknown the
// small-depth limit p ≈ e · z / V is used, in which h cancels: pct ≈ 100 · e · depthH / (aspect · V).
//
// Comfort zones (vergence–accommodation conflict) are in DIOPTERS of vergence away from the glass:
// ΔD = 1/V − 1/z (> 0 behind, < 0 in front), and the on-screen disparity is p = e · V · ΔD. A zone
// is a max |ΔD| on each side; comfortZone() states it, comfortDepthFactor() says how much a display
// rig's depth would have to shrink for a subject to sit inside it (never more than 1: no zone here
// ever ADDS depth).

/** The eye separation every estimate here assumes (no browser surface reports a real one). */
export const DEPTH_EYE_SEPARATION_M = 0.063;

/** The viewer distance used when the display does not report its nominal viewer (desktop panel). */
export const DEPTH_DEFAULT_VIEWER_M = 0.6;

const num = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Disparity, % of the tile width, of a point `depthH` tile heights out of the glass on a display
 * rig. SIGNED like display space: `depthH > 0` is IN FRONT (toward the viewer) and gives a NEGATIVE
 * (crossed) disparity; `depthH < 0` is behind and gives a positive one — the same sign as
 * {@link cameraRigDisparityPct}.
 *
 * @param {object} o
 * @param {number} o.depthH  tile heights out of the glass (+ in front, − behind).
 * @param {number} o.aspect  the tile's width / height.
 * @param {number} [o.viewerM=0.6]  nominal viewer distance, metres.
 * @param {number} [o.heightM]  the tile's physical height, metres. Unset: the small-depth limit.
 * @param {number} [o.ipdFactor=1]  a display rig's ipdFactor (disparity scales with it).
 * @param {number} [o.eyeSeparationM=0.063]
 * @returns {number} %, −Infinity at or past the viewer, NaN on bad input.
 */
export function disparityPct({ depthH, aspect, viewerM = DEPTH_DEFAULT_VIEWER_M, heightM, ipdFactor = 1, eyeSeparationM = DEPTH_EYE_SEPARATION_M } = {}) {
  if (!num(depthH) || !num(aspect) || !(aspect > 0) || !num(viewerM) || !(viewerM > 0) || !num(ipdFactor)) return NaN;
  const h = num(heightM) && heightM > 0 ? heightM : 0;
  const denom = viewerM - depthH * h;
  if (!(denom > 0)) return -Infinity;
  if (depthH === 0) return 0;
  return (-100 * eyeSeparationM * ipdFactor * depthH) / (aspect * denom);
}

/**
 * Disparity, % of the tile width, of a point at distance `z` on a CAMERA rig:
 * `100 · b · (1/D − 1/z) / (2 · tan(verticalFov/2) · aspect)`, `b = 0.063 · ipdFactor · metersToVirtual`,
 * D the convergence distance. `+` = behind the glass, `−` = in front. Convergence 0 / unset is
 * infinity (1/D = 0): everything is in front.
 *
 * @param {object} o
 * @param {number} o.z  distance of the point along the camera's view axis, world units.
 * @param {number} [o.convergence]  zero-disparity distance, world units (0 = infinity).
 * @param {number} [o.convergenceDiopters]  or 1/distance, as the descriptor carries it.
 * @param {number} [o.ipdFactor=1] [o.metersToVirtual=1]
 * @param {number} o.verticalFov  FULL vertical angle, RADIANS (the descriptor's unit).
 * @param {number} o.aspect  the tile's width / height.
 * @returns {number} %, NaN on bad input.
 */
export function cameraRigDisparityPct({ z, convergence, convergenceDiopters, ipdFactor = 1, metersToVirtual = 1, verticalFov, aspect } = {}) {
  if (!num(z) || !(z > 0) || !num(verticalFov) || !(verticalFov > 0) || !num(aspect) || !(aspect > 0)) return NaN;
  if (!num(ipdFactor) || !num(metersToVirtual)) return NaN;
  const invD = num(convergenceDiopters) ? Math.max(0, convergenceDiopters) : num(convergence) && convergence > 0 ? 1 / convergence : 0;
  const b = DEPTH_EYE_SEPARATION_M * ipdFactor * metersToVirtual;
  return (100 * b * (invD - 1 / z)) / (2 * Math.tan(verticalFov / 2) * aspect);
}

/**
 * A depth report from a display-rig subject box (SceneViewer.getSubjectBounds' `front` / `back`,
 * display space: +z toward the viewer, glass at 0, units of the virtual display).
 *
 * `frontH` / `backH` are MAGNITUDES in tile heights: how far the nearest point sits in front of the
 * glass and the farthest behind it (0 when nothing is on that side). `frontPct` / `backPct` are the
 * matching disparity magnitudes, % of the tile width.
 *
 * @param {object} o
 * @param {number} o.front  z of the nearest surface.
 * @param {number} o.back  z of the farthest surface.
 * @param {number} o.virtualDisplayHeight  what one tile height is in those units.
 * @param {number} o.aspect  the tile's width / height.
 * @param {number} [o.viewerM=0.6] [o.heightM] [o.ipdFactor=1]  as {@link disparityPct}.
 */
export function depthBudgetFromBounds({ front, back, virtualDisplayHeight, aspect, viewerM = DEPTH_DEFAULT_VIEWER_M, heightM, ipdFactor = 1 } = {}) {
  const vH = virtualDisplayHeight;
  const ok = num(front) && num(back) && num(vH) && vH > 0;
  const frontH = ok ? Math.max(0, front / vH) : NaN;
  const backH = ok ? Math.max(0, -back / vH) : NaN;
  const common = { aspect, viewerM, heightM, ipdFactor };
  const frontPct = Math.abs(disparityPct({ depthH: frontH, ...common }));
  const backPct = Math.abs(disparityPct({ depthH: -backH, ...common }));
  return {
    frontH,
    backH,
    frontPct,
    backPct,
    basis: {
      rig: 'display',
      aspect,
      viewerM,
      heightM: num(heightM) && heightM > 0 ? heightM : null,
      ipdFactor,
      eyeSeparationM: DEPTH_EYE_SEPARATION_M,
    },
  };
}

// ── comfort zones ─────────────────────────────────────────────────────────────────────────────

/** The comfort zones comfortZone() knows by name; a positive number is a symmetric |ΔD| bound. */
const COMFORT_ZONES = Object.freeze(['shibata', 'percival']);

/** A `zone` comfortZone() accepts: a known name, or a finite number of diopters > 0. */
export function isComfortZone(zone) {
  return COMFORT_ZONES.includes(zone) || (num(zone) && zone > 0);
}

/**
 * The comfort zone for a viewer at `viewerM`: the largest vergence change, in diopters, that is
 * comfortable in front of the glass (`frontD`) and behind it (`behindD`), and the matching
 * on-screen disparity magnitudes in mm (`e · V · ΔD`).
 *
 * - `'shibata'` (default): Shibata et al. 2011, "The zone of comfort" (J. Vision 11(8):11). The
 *   near vergence limit is `Dv/1.035 + 0.626`, the far `Dv/1.129 − 0.442` (Dv = 1/V), so
 *   `frontD = (Dv/1.035 + 0.626) − Dv` and `behindD = Dv − (Dv/1.129 − 0.442)`. A far limit at or
 *   below 0 D (a distant viewer) leaves behind unbounded: `Infinity`. At 0.6 m: 0.57 D / 0.63 D.
 * - `'percival'`: Percival's zone, ±1/3 D on both sides.
 * - a number: a symmetric |ΔD| bound, diopters.
 *
 * @param {object} [o]
 * @param {number} [o.viewerM=0.6]  viewing distance, metres.
 * @param {'shibata'|'percival'|number} [o.zone='shibata']
 * @returns {{zone:'shibata'|'percival'|number, viewerM:number, frontD:number, behindD:number,
 *           frontMm:number, behindMm:number}}  NaN fields on bad input.
 */
export function comfortZone({ viewerM = DEPTH_DEFAULT_VIEWER_M, zone = 'shibata' } = {}) {
  let frontD = NaN;
  let behindD = NaN;
  if (num(viewerM) && viewerM > 0 && isComfortZone(zone)) {
    const Dv = 1 / viewerM;
    if (zone === 'shibata') {
      frontD = Dv / 1.035 + 0.626 - Dv;
      const far = Dv / 1.129 - 0.442;
      behindD = far > 0 ? Dv - far : Infinity;
    } else if (zone === 'percival') {
      frontD = behindD = 1 / 3;
    } else {
      frontD = behindD = zone;
    }
  }
  const mm = (d) => DEPTH_EYE_SEPARATION_M * viewerM * d * 1000;
  return { zone, viewerM, frontD, behindD, frontMm: mm(frontD), behindMm: mm(behindD) };
}

/**
 * How much a DISPLAY rig's depth would have to shrink for a subject to sit inside a comfort zone:
 * the largest `k ≤ 1` such that the subject's disparities scaled by `k` (a display rig's
 * ipdFactor, with parallaxFactor moved with it) stay within {@link comfortZone}. 1 = it already
 * fits; never above 1 — this only ever says "less".
 *
 * Exact geometry, at real proportions: the nearest point is `frontH` tile heights in front of the
 * glass, physically `frontH · tileHeightM`, so at `z = V − frontH · tileHeightM` from the viewer;
 * the farthest at `z = V + backH · tileHeightM`. Each side's `|ΔD| = |1/V − 1/z|` against the
 * zone's bound on that side gives `k = min(1, frontD/|ΔD_front|, behindD/ΔD_behind)` (a side with
 * no depth does not count). The SAME subject in tile heights asks more of a small, close screen —
 * a tablet at 0.4 m carries more vergence per tile height than a laptop at 0.6 m — which is the
 * whole reason this depends on the panel and not just on the scene.
 *
 * Returns 1 (no change) for any missing or invalid input — a non-finite depth, a height or
 * viewer distance ≤ 0, an unknown zone — and when the front reaches the viewer (no finite
 * disparity to scale): a measurement that cannot be made must never be read as "flatten it".
 *
 * @param {object} o
 * @param {number} o.frontH  MAGNITUDE, tile heights in front of the glass (0 = nothing in front).
 * @param {number} o.backH  MAGNITUDE, tile heights behind it.
 * @param {number} o.tileHeightM  the tile's (canvas's) physical height, metres.
 * @param {number} [o.viewerM=0.6]  NOMINAL viewer distance, metres.
 * @param {'shibata'|'percival'|number} [o.zone='shibata']
 * @returns {number} in (0, 1].
 */
export function comfortDepthFactor({ frontH, backH, tileHeightM, viewerM = DEPTH_DEFAULT_VIEWER_M, zone = 'shibata' } = {}) {
  if (!num(frontH) || !num(backH) || !num(tileHeightM) || !(tileHeightM > 0)) return 1;
  const z = comfortZone({ viewerM, zone });
  if (!num(z.frontD) || Number.isNaN(z.behindD)) return 1;
  const V = viewerM;
  const zf = V - Math.max(0, frontH) * tileHeightM;
  const zb = V + Math.max(0, backH) * tileHeightM;
  if (!(zf > 0)) return 1;
  const dFront = 1 / zf - 1 / V;
  const dBehind = 1 / V - 1 / zb;
  let k = 1;
  if (dFront > 0) k = Math.min(k, z.frontD / dFront);
  if (dBehind > 0) k = Math.min(k, z.behindD / dBehind);
  return k > 0 ? k : 1;
}

/**
 * The CAMERA-rig counterpart of {@link comfortDepthFactor}: the multiplier `m` on the eye
 * separation (the rig's ipdFactor) that puts the scene's nearest point (`zNear`) and farthest
 * (`zFar`, may be Infinity) at the edge of the comfort zone, at the given viewing distance.
 *
 * Measurement only; the page decides whether to apply it. Unlike the display-rig factor it can
 * exceed 1, because a camera rig's 1 is only physical in metre-scale worlds: `ipdFactor` 1 is
 * 63 mm × metersToVirtual in scene units, which is right for a real-sized room and far too little
 * for a scene authored in large units (it renders nearly flat).
 *
 * Method: the on-screen disparity as a fraction of the tile width is
 * `f = b · (1/D − 1/z) / (2 · tan(verticalFov/2) · aspect)` (b = 0.063 · ipdFactor ·
 * metersToVirtual; {@link cameraRigDisparityPct} / 100), physically `p = f · aspect · tileHeightM`
 * on the glass, which is `ΔD = p / (0.063 · V)` diopters of vergence. `m` = the smallest of
 * zone side / |ΔD side| over the sides with content (in front: z < D, behind: z > D).
 * Convergence 0 / unset is infinity: everything is in front.
 *
 * @param {object} o
 * @param {number} o.zNear  nearest scene point along the view axis, world units (> 0).
 * @param {number} o.zFar  farthest, world units (≥ zNear; Infinity allowed).
 * @param {number} [o.convergence]  zero-disparity distance, world units (0 = infinity).
 * @param {number} [o.convergenceDiopters]  or 1/distance; wins over `convergence`.
 * @param {number} o.verticalFov  FULL vertical angle, RADIANS.
 * @param {number} o.aspect  the tile's width / height.
 * @param {number} o.tileHeightM  the tile's physical height, metres.
 * @param {number} [o.viewerM=0.6] [o.zone='shibata'] [o.ipdFactor=1] [o.metersToVirtual=1]
 * @returns {number} > 0, no upper bound; Infinity when nothing is off the plane; NaN on bad input.
 */
export function cameraRigComfortFactor({
  zNear,
  zFar,
  convergence,
  convergenceDiopters,
  verticalFov,
  aspect,
  tileHeightM,
  viewerM = DEPTH_DEFAULT_VIEWER_M,
  zone = 'shibata',
  ipdFactor = 1,
  metersToVirtual = 1,
} = {}) {
  const farOk = num(zFar) || zFar === Infinity;
  if (!num(zNear) || !(zNear > 0) || !farOk || !(zFar >= zNear)) return NaN;
  if (!num(verticalFov) || !(verticalFov > 0) || !num(aspect) || !(aspect > 0) || !num(tileHeightM) || !(tileHeightM > 0)) return NaN;
  if (!num(ipdFactor) || !(ipdFactor > 0) || !num(metersToVirtual) || !(metersToVirtual > 0)) return NaN;
  const cz = comfortZone({ viewerM, zone });
  if (!num(cz.frontD)) return NaN;
  const invD = num(convergenceDiopters) ? Math.max(0, convergenceDiopters) : num(convergence) && convergence > 0 ? 1 / convergence : 0;
  const b = DEPTH_EYE_SEPARATION_M * ipdFactor * metersToVirtual;
  // ΔD of a point at z (+ behind, − in front): f · aspect · H / (e · V), the aspect cancelling.
  const dD = (z) => (b * (invD - 1 / z) * tileHeightM) / (2 * Math.tan(verticalFov / 2) * DEPTH_EYE_SEPARATION_M * viewerM);
  let m = Infinity;
  const front = -dD(zNear);
  const behind = dD(zFar);
  if (front > 0) m = Math.min(m, cz.frontD / front);
  if (behind > 0) m = Math.min(m, cz.behindD / behind);
  return m;
}

// ── ground-plane camera rig (web#274) ─────────────────────────────────────────────────────────

/**
 * A SUGGESTED camera rig for a tilted top-down view of a ground plane (a map, a strategy game, a
 * board) and a report of what it does on this panel. Guideline only: it returns numbers and never
 * touches a rig; the page decides what to apply.
 *
 * Geometry. The camera is `height` world units above the ground, its view axis `tiltDeg` from
 * straight down (0 = top-down; making-3d-look-right.md rule 2's 25–40° from face-on), and it looks
 * at the ground point on that axis. The suggested zero-disparity plane is the ground at the view
 * centre: `convergence d = height / cos(tilt)`. A ground point seen `α` above the axis has view-axis
 * depth `z = d / (1 − tan(tilt)·tan α)`, so the flat ground's INVERSE depth at the bottom / top
 * edges is `(1 ± k) / d`, `k = tan(tilt)·tan(fov/2)` (k ≥ 1: the top edge sees the horizon).
 *
 * The canvas-size factor. On a camera rig the on-glass disparity of a point at depth z is
 * `p = b · (1/D − 1/z) · tileHeightM / (2·tan(fov/2))`, `b = 0.063 m · ipdFactor ·
 * metersToVirtual` (cameraRigDisparityPct × the tile width). It scales with the canvas's PHYSICAL
 * height: the same rig on a canvas half as tall gives half the disparity. A formula without
 * `tileHeightM` is only right when the canvas exactly fills the camera's field of view from the
 * viewer (`tileHeightM = 2·viewerM·tan(fov/2)`). Read it from `handle.displayMetrics()`
 * (`canvasSizeM[1]`, and `nominalViewerM` for `viewerM`).
 *
 * Perceived depth, for a viewer at `viewerM` with 63 mm eyes: crossed disparity p puts a point
 * `viewerM·p / (e + p)` in front of the glass, uncrossed `viewerM·p / (e − p)` behind it
 * (Infinity once p ≥ e: the eyes would diverge).
 *
 * The zoom-in limit. `minHeight` is the lowest camera height (same tilt, convergence following
 * it) at which the top of an `objectHeight`-tall object standing on the near (bottom) edge stays
 * within the pop-out budget: `maxPopOutMm` if given, else the comfort zone's front side
 * (`comfortZone({ viewerM, zone }).frontMm`). Exact (a quadratic in the height), not iterated.
 *
 * @param {object} o
 * @param {number} o.height  camera height above the ground, world units (> 0).
 * @param {number} o.tiltDeg  view axis from straight down, DEGREES, [0, 90).
 * @param {number} [o.fovDeg]  FULL vertical field of view, DEGREES (three's `camera.fov`)…
 * @param {number} [o.verticalFov]  …or RADIANS, as the rig descriptor carries it.
 * @param {number} [o.tileHeightM]  the canvas's physical height, metres. Without it the physical
 *        fields (mm, minHeight, ipdFactorForBudget, comfortFactor) are NaN / null.
 * @param {number} [o.viewerM=0.6]  nominal viewer distance, metres.
 * @param {number} [o.objectHeight=0]  tallest thing that can stand at the near edge, world units.
 * @param {number} [o.ipdFactor=1] [o.metersToVirtual=1]  the rig's (absolute, camera-rig) factors.
 * @param {number} [o.maxPopOutMm]  pop-out budget, perceived mm in front of the glass.
 * @param {'shibata'|'percival'|number} [o.zone='shibata']  the budget when maxPopOutMm is unset.
 */
export function groundPlaneRig({
  height,
  tiltDeg,
  fovDeg,
  verticalFov,
  tileHeightM,
  viewerM = DEPTH_DEFAULT_VIEWER_M,
  objectHeight = 0,
  ipdFactor = 1,
  metersToVirtual = 1,
  maxPopOutMm,
  zone = 'shibata',
} = {}) {
  const fov = num(verticalFov) ? verticalFov : num(fovDeg) ? (fovDeg * Math.PI) / 180 : NaN;
  const bad =
    !num(height) || !(height > 0) || !num(tiltDeg) || !(tiltDeg >= 0 && tiltDeg < 90) || !(fov > 0 && fov < Math.PI) ||
    !num(viewerM) || !(viewerM > 0) || !num(objectHeight) || !(objectHeight >= 0) || !num(ipdFactor) || !(ipdFactor >= 0) ||
    !num(metersToVirtual) || !(metersToVirtual > 0);
  if (bad) return null;
  const tilt = (tiltDeg * Math.PI) / 180;
  const cosT = Math.cos(tilt);
  const tanHalf = Math.tan(fov / 2);
  const k = Math.tan(tilt) * tanHalf;
  const d = height / cosT;
  const e = DEPTH_EYE_SEPARATION_M;
  const H = num(tileHeightM) && tileHeightM > 0 ? tileHeightM : NaN;
  // On-glass disparity (metres, + = behind) per unit of (1/D − 1/z), for this rig's eye scale.
  const c = (e * ipdFactor * metersToVirtual * H) / (2 * tanHalf);
  const s = objectHeight * cosT; // how much nearer the object's top is than its foot, along the axis
  const zNearGround = d / (1 + k);
  const zFarGround = k < 1 ? d / (1 - k) : Infinity;
  const zObj = zNearGround - s;
  const pOf = (z) => (z === Infinity ? c / d : z > 0 ? c * (1 / d - 1 / z) : -Infinity);
  const groundNear = pOf(zNearGround);
  const groundFar = pOf(zFarGround);
  const objNear = pOf(zObj);
  const popOut = (p) => (p < 0 ? (viewerM * -p) / (e - p) : 0);
  const recess = (p) => (p > 0 ? (p < e ? (viewerM * p) / (e - p) : Infinity) : 0);
  const mm = (x) => x * 1000;

  // The budget, as on-glass crossed disparity (metres).
  let budget;
  let budgetSource;
  if (num(maxPopOutMm) && maxPopOutMm > 0) {
    const x = maxPopOutMm / 1000;
    budget = x < viewerM ? (e * x) / (viewerM - x) : Infinity;
    budgetSource = 'maxPopOutMm';
  } else {
    budget = comfortZone({ viewerM, zone }).frontMm / 1000;
    budgetSource = 'zone';
  }

  // minHeight: |p(top of object at the near edge)| = budget, with d = h / cos(tilt) following h.
  //   c·(1/(a·h − s) − cos/h) = B,  a = 1/(cos·(1+k))
  //   → (B/c)·a·h² − ((B/c)·s + k/(1+k))·h − cos·s = 0, the positive root.
  let minHeight = null;
  if (c > 0 && budget > 0 && Number.isFinite(budget)) {
    const r = budget / c;
    const a = 1 / (cosT * (1 + k));
    const A = r * a;
    const Bq = r * s + k / (1 + k);
    const C = cosT * s;
    minHeight = (Bq + Math.sqrt(Bq * Bq + 4 * A * C)) / (2 * A);
  } else if (c > 0 && budget === Infinity) {
    minHeight = objectHeight * cosT * cosT * (1 + k); // only "the object's top stays in front of the camera"
  }
  const nearMag = objNear < 0 ? -objNear : 0;
  const ipdFactorForBudget = nearMag > 0 && Number.isFinite(budget) ? (ipdFactor * budget) / nearMag : nearMag > 0 ? Infinity : null;
  const comfortFactor = Number.isFinite(H)
    ? cameraRigComfortFactor({
        zNear: zObj > 0 ? zObj : zNearGround,
        zFar: zFarGround,
        convergence: d,
        verticalFov: fov,
        aspect: 1,
        tileHeightM: H,
        viewerM,
        zone,
        ipdFactor: ipdFactor > 0 ? ipdFactor : 1,
        metersToVirtual,
      })
    : NaN;

  return {
    convergence: d,
    convergenceDiopters: 1 / d,
    verticalFov: fov,
    minHeight,
    ipdFactorForBudget,
    report: {
      nearEdgeInvDepthRatio: 1 + k,
      farEdgeInvDepthRatio: 1 - k,
      horizonInView: k >= 1,
      groundNearMm: mm(groundNear),
      groundFarMm: mm(groundFar),
      objectNearMm: zObj > 0 ? mm(objNear) : -Infinity,
      popOutMmNearEdge: zObj > 0 ? mm(popOut(objNear)) : Infinity,
      recessionMmFarEdge: mm(recess(groundFar)),
      budgetMm: mm(budget),
      budgetSource,
      comfortFactor,
      comfortProduct: ipdFactor * metersToVirtual * (1 / d) * viewerM,
    },
    basis: { tiltDeg, viewerM, tileHeightM: Number.isFinite(H) ? H : null, ipdFactor, metersToVirtual, objectHeight, eyeSeparationM: e, zone },
  };
}

// ── one-time warnings (never a behaviour change) ──────────────────────────────────────────────

const CONVERGENCE_MSG =
  '[inline3d] camera rig with convergenceDiopters 0: convergence at infinity puts the whole scene in front of the glass; ' +
  'set convergence to the subject\'s distance.';

/** Descriptors a rig builder already warned about, so setViewRig does not say it twice. */
const builderWarned = new WeakSet();
let builderWarnedOnce = false;

/** cameraRigFromCamera / cameraRigFromPose: warn once per page when convergence is 0 / unset. */
export function noteBuiltCameraRig(rig) {
  if (rig.convergenceDiopters > 0) return;
  if (!builderWarnedOnce) {
    builderWarnedOnce = true;
    console.warn(CONVERGENCE_MSG);
  }
  builderWarned.add(rig);
}

/**
 * What looks wrong about a view-rig descriptor: `[key, message]` pairs (key = 'convergence' |
 * 'factor' | 'fov'). Read only; the descriptor goes to the runtime exactly as given.
 */
export function viewRigWarnings(rig) {
  const out = [];
  if (!rig || typeof rig !== 'object') return out;
  if (rig.type === 'camera') {
    if (!(rig.convergenceDiopters > 0)) out.push(['convergence', CONVERGENCE_MSG]);
    if (rig.verticalFov > Math.PI) {
      out.push([
        'fov',
        `[inline3d] camera rig verticalFov ${rig.verticalFov} is more than π: it looks like DEGREES — the descriptor takes RADIANS ` +
          '(cameraRigFromCamera / cameraRigFromPose convert three\'s degrees for you).',
      ]);
    }
  } else if (rig.ipdFactor > 1 || rig.parallaxFactor > 1) {
    out.push([
      'factor',
      `[inline3d] display rig ipdFactor ${rig.ipdFactor ?? 1} / parallaxFactor ${rig.parallaxFactor ?? 1}: above 1 exaggerates ` +
        'depth past what the display shows by construction (1 = correct; below 1 = a comfort dial). Sent as given.',
    ]);
  }
  return out;
}

/** Warn each of viewRigWarnings(rig) once per `seen` set (one per handle). */
export function warnViewRigOnce(seen, rig) {
  if (!rig || typeof rig !== 'object') return;
  // The cheap common case first: called per frame by pages that drive a rig.
  if (rig.type === 'camera' ? rig.convergenceDiopters > 0 && !(rig.verticalFov > Math.PI) : !(rig.ipdFactor > 1 || rig.parallaxFactor > 1)) return;
  for (const [key, msg] of viewRigWarnings(rig)) {
    if (seen.has(key)) continue;
    seen.add(key);
    if (key === 'convergence' && builderWarned.has(rig)) continue; // the builder said it already
    console.warn(msg);
  }
}

/**
 * The hint for a `wovenState === 'withheld'` reason token (docs/woven-canvas-rules.md §3).
 */
export function withheldReasonHint(reason) {
  const r = String(reason || '');
  if (r.startsWith('cross-pass')) {
    return 'the canvas is inside its own render surface: a CSS effect on it or an ancestor (filter, opacity < 1, mask, clip-path, mix-blend-mode, backdrop-filter). Remove it (woven-canvas rule 7)';
  }
  if (r === 'no-quad') {
    return 'the canvas drew nothing the compositor can see: it is not drawing, is occluded, or a CSS effect on it or an ancestor (filter, opacity < 1, mask, clip-path, mix-blend-mode, backdrop-filter) hides it (woven-canvas rule 7)';
  }
  if (r === 'no-identity') return 'the canvas reached the browser without its identity: register it once, keep it mounted, cover it until firstWoven (woven-canvas rules 3-5)';
  if (r === 'no-join') return 'nothing joined this rect; harmless off screen, otherwise check the canvas is drawing and on screen';
  if (r === 'resolve-dropped') return "the browser could not resolve the canvas's GPU resource (a browser-side issue)";
  return 'see docs/woven-canvas-rules.md §3';
}

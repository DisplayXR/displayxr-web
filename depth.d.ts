// Type definitions for @displayxr/inline3d/depth — depth measurements (also re-exported by the
// root entry and, minus the warning helpers, by ./three).
//
// Measurements and pure helpers only: nothing here changes a pixel, clamps a rig or refuses a
// value (the opt-in `depth` option of ./model and ./splat is what applies comfortDepthFactor). The units are RELATIVE — disparity as % of the TILE's width, or depth in TILE HEIGHTS on
// a display rig — so they hold on any panel. Depth ranges measured on a panel are in
// docs/authoring-inline-3d.md, as reference points.

/** The eye separation every estimate assumes, metres (0.063). No browser surface reports a real one. */
export const DEPTH_EYE_SEPARATION_M: number;
/** The viewer distance used when the display reports no nominal viewer, metres (0.6, a desktop panel). */
export const DEPTH_DEFAULT_VIEWER_M: number;

/** What a depth report measured against. */
export interface DepthReportBasis {
  rig: 'display';
  /** The tile's width / height. */
  aspect: number;
  /** Nominal viewer distance used, metres. */
  viewerM: number;
  /** The tile's physical height, metres, or null (then the small-depth formula, which ignores it). */
  heightM: number | null;
  /** The display rig's ipdFactor in force (disparity scales with it). */
  ipdFactor: number;
  eyeSeparationM: number;
}

/**
 * How deep a display-rig subject is. `frontH` / `backH` are MAGNITUDES in tile heights (0 when
 * nothing is on that side); `frontPct` / `backPct` the matching disparity magnitudes, % of the
 * tile width.
 */
export interface DepthReport {
  frontH: number;
  backH: number;
  frontPct: number;
  backPct: number;
  basis: DepthReportBasis;
}

/**
 * Disparity, % of the tile width, of a point `depthH` tile heights out of the glass on a DISPLAY
 * rig: physical depth `z = depthH · heightM`, disparity `e · z / (V − z)` (e = 0.063 m × ipdFactor,
 * V = `viewerM`) over the tile width `aspect · heightM`. Without `heightM` the small-depth limit
 * `100 · e · depthH / (aspect · V)`. SIGNED: `depthH > 0` (in front) gives a NEGATIVE disparity,
 * behind a positive one — as {@link cameraRigDisparityPct}. −Infinity at or past the viewer.
 */
export function disparityPct(o: {
  depthH: number;
  aspect: number;
  /** Default 0.6. */
  viewerM?: number;
  heightM?: number;
  /** Default 1. */
  ipdFactor?: number;
  /** Default 0.063. */
  eyeSeparationM?: number;
}): number;

/**
 * Disparity, % of the tile width, of a point `z` world units down a CAMERA rig's view axis:
 * `100 · b · (1/D − 1/z) / (2 · tan(verticalFov/2) · aspect)`, `b = 0.063 · ipdFactor ·
 * metersToVirtual`. `+` = behind the glass, `−` = in front. `convergence` 0 / unset (and no
 * `convergenceDiopters`) is infinity: everything is in front. NaN on bad input.
 */
export function cameraRigDisparityPct(o: {
  z: number;
  /** Zero-disparity distance, world units (0 = infinity). */
  convergence?: number;
  /** Or the descriptor's 1 / distance; wins over `convergence`. */
  convergenceDiopters?: number;
  ipdFactor?: number;
  metersToVirtual?: number;
  /** FULL vertical angle, RADIANS. */
  verticalFov: number;
  aspect: number;
}): number;

/**
 * A {@link DepthReport} from a display-rig subject box: `front` / `back` as
 * `SceneViewer.getSubjectBounds()` reports them (display space, +z toward the viewer, glass at 0),
 * in the units where one tile height is `virtualDisplayHeight`.
 */
export function depthBudgetFromBounds(o: {
  front: number;
  back: number;
  virtualDisplayHeight: number;
  aspect: number;
  viewerM?: number;
  heightM?: number;
  ipdFactor?: number;
}): DepthReport;

/**
 * A comfort zone (vergence–accommodation): `'shibata'` (Shibata et al. 2011, "The zone of
 * comfort", J. Vision — the default), `'percival'` (±1/3 D), or a number: a symmetric |ΔD| bound,
 * diopters (> 0).
 */
export type ComfortZoneName = 'shibata' | 'percival' | number;

/**
 * A comfort zone at one viewing distance: the largest comfortable vergence change in front of the
 * glass (`frontD`) and behind it (`behindD`), diopters, and the matching on-screen disparities in
 * mm (`e · V · ΔD`). `behindD` is Infinity when the zone's far limit is past optical infinity.
 */
export interface ComfortZoneReport {
  zone: ComfortZoneName;
  viewerM: number;
  frontD: number;
  behindD: number;
  frontMm: number;
  behindMm: number;
}

/**
 * The comfort zone for a viewer at `viewerM` (default 0.6 m). Shibata: near vergence limit
 * `Dv/1.035 + 0.626`, far `Dv/1.129 − 0.442` (Dv = 1/V), so 0.57 D in front / 0.63 D behind at
 * 0.6 m; Percival: ±1/3 D. NaN fields on bad input (a distance ≤ 0, an unknown zone).
 */
export function comfortZone(o?: { viewerM?: number; zone?: ComfortZoneName }): ComfortZoneReport;

/**
 * How much a DISPLAY rig's depth would have to shrink for a subject to sit inside a comfort zone:
 * the largest `k ≤ 1` such that its disparities × k (ipdFactor, parallaxFactor moved with it)
 * stay within {@link comfortZone}. ONLY EVER LOWERS DEPTH: 1 = it already fits, never above 1.
 *
 * Exact geometry at real proportions: the nearest point at `V − frontH · tileHeightM` from the
 * viewer, the farthest at `V + backH · tileHeightM`, each side's `|1/V − 1/z|` against the zone.
 * Use the NOMINAL viewer distance (what the display is built for), not a live head distance. The
 * same depth in tile heights asks more of a small, close screen — a tablet at 0.4 m carries more
 * vergence per tile height than a laptop at 0.6 m — which is why the answer depends on the panel.
 *
 * Returns 1 (no change) for missing or invalid input, and when the front reaches the viewer.
 */
export function comfortDepthFactor(o: {
  /** MAGNITUDE, tile heights in front of the glass. */
  frontH: number;
  /** MAGNITUDE, tile heights behind it. */
  backH: number;
  /** The tile's (canvas's) physical height, metres. */
  tileHeightM: number;
  /** NOMINAL viewer distance, metres. Default 0.6. */
  viewerM?: number;
  /** Default 'shibata'. */
  zone?: ComfortZoneName;
}): number;

/**
 * The CAMERA-rig counterpart: the multiplier on the eye separation (ipdFactor) that puts the
 * scene's nearest (`zNear`) and farthest (`zFar`, may be Infinity) points at the edge of the
 * comfort zone. Measurement only; the page decides whether to apply it. Unlike the display-rig
 * factor it can EXCEED 1, because a camera rig's 1 (63 mm × metersToVirtual in scene units) is
 * only physical in metre-scale worlds — in large scene units it renders nearly flat.
 *
 * Disparity `f = b · (1/D − 1/z) / (2 · tan(verticalFov/2) · aspect)` of the tile width
 * (b = 0.063 · ipdFactor · metersToVirtual), on the glass `p = f · aspect · tileHeightM`, in
 * diopters `p / (0.063 · viewerM)`; the result is the smallest zone side / |ΔD| over the sides
 * with content. Convergence 0 / unset = infinity (everything in front). Infinity when nothing is
 * off the plane, NaN on bad input.
 */
export function cameraRigComfortFactor(o: {
  zNear: number;
  zFar: number;
  /** Zero-disparity distance, world units (0 = infinity). */
  convergence?: number;
  /** Or 1 / distance; wins over `convergence`. */
  convergenceDiopters?: number;
  /** FULL vertical angle, RADIANS. */
  verticalFov: number;
  aspect: number;
  tileHeightM: number;
  /** Default 0.6. */
  viewerM?: number;
  /** Default 'shibata'. */
  zone?: ComfortZoneName;
  /** Default 1. */
  ipdFactor?: number;
  /** Default 1. */
  metersToVirtual?: number;
}): number;

/** The hint `[inline3d]` logs for a `withheldReason` token (docs/woven-canvas-rules.md §3). */
export function withheldReasonHint(reason: string): string;


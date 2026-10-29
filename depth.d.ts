// Type definitions for @displayxr/inline3d/depth — depth measurements (also re-exported by the
// root entry and, minus the warning helpers, by ./three).
//
// Measurements and pure helpers only: nothing here changes a pixel, clamps a rig or refuses a
// value. The units are RELATIVE — disparity as % of the TILE's width, or depth in TILE HEIGHTS on
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

/** The hint `[inline3d]` logs for a `withheldReason` token (docs/woven-canvas-rules.md §3). */
export function withheldReasonHint(reason: string): string;


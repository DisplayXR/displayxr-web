// Type definitions for @displayxr/inline3d/depth — the depth budget (also re-exported by the root
// entry and, minus the warning helpers, by ./three).
//
// Measurements and pure helpers only: nothing here changes a pixel, clamps a rig or refuses a
// value. The budget is RELATIVE — disparity as % of the TILE's width, or depth in TILE HEIGHTS on
// a display rig — so one set of numbers holds on any panel:
//
//                     in front of the glass   behind the glass
//   comfortable       <= 0.6 % (~0.1 h)        <= 1.5 % (~0.27 h)
//   strong            <= 1.1 % (~0.18 h)       <= 2.3 % (~0.45 h)
//   hard limit        ~3.3 % either way        (and ~0 near the frame edges)

/**
 * One budget tier: disparity (% of the tile width) and the display-rig depth (tile heights) it
 * maps to on a 16:9 tile viewed from 0.6 m. The `%` figures are the budget; the `H` figures are
 * their usual translation (a narrower tile turns the same depth into more of its width).
 */
export interface DepthBudgetTier {
  readonly frontPct: number;
  readonly backPct: number;
  readonly frontH: number;
  readonly backH: number;
}

/** The relative depth budget. */
export const DEPTH_BUDGET: Readonly<{
  comfortable: DepthBudgetTier;
  strong: DepthBudgetTier;
  /** The hard human fusion limit, % of the tile width, either side. */
  limitPct: number;
}>;

/** The eye separation every estimate assumes, metres (0.063). No browser surface reports a real one. */
export const DEPTH_EYE_SEPARATION_M: number;
/** The viewer distance used when the display reports no nominal viewer, metres (0.6, a desktop panel). */
export const DEPTH_DEFAULT_VIEWER_M: number;

export type DepthBudgetName = 'comfortable' | 'strong' | 'beyond';

/** What a depth report measured against. */
export interface DepthReportBasis {
  rig: 'display';
  /** The tile's width / height. */
  aspect: number;
  /** Nominal viewer distance used, metres. */
  viewerM: number;
  /** `handle.depthReport()` only: whether `viewerM` came from the display or is the 0.6 m default. */
  viewerSource?: 'display' | 'default';
  /** The tile's physical height, metres, or null (then the small-depth formula, which ignores it). */
  heightM: number | null;
  /** The display rig's ipdFactor in force (disparity scales with it). */
  ipdFactor: number;
  eyeSeparationM: number;
}

/**
 * How deep a display-rig subject is. `frontH` / `backH` are MAGNITUDES in tile heights (0 when
 * nothing is on that side); `frontPct` / `backPct` the matching disparity magnitudes, % of the
 * tile width; `budget` the tier both fit in.
 */
export interface DepthReport {
  frontH: number;
  backH: number;
  frontPct: number;
  backPct: number;
  budget: DepthBudgetName;
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

/** The tier two disparity magnitudes (% of the tile width) fit in. */
export function depthBudgetClass(frontPct: number, backPct: number): DepthBudgetName;

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

/** `depthFit` on SceneViewer / addModel / addSplat: a depth budget in TILE HEIGHTS. A side left out is unbounded. */
export interface DepthFitOption {
  /** How far the nearest point may sit in front of the glass, tile heights (e.g. 0.1). */
  front?: number;
  /** How far the farthest point may sit behind it, tile heights (e.g. 0.27). */
  back?: number;
}

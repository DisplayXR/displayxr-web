// Type definitions for @displayxr/inline3d/cursor-depth — the depth-aware cursor's placement
// maths, dependency-free. A port of the runtime's u_cursor_depth (ADR-046, XR_DXR_cursor_depth):
// same geometry, same defaults, same numbers. For three.js, ./three's `DepthCursor` wires it up.

/** A view as an XRView carries it: column-major projection + transform matrices. */
export interface CursorView {
  projectionMatrix: ArrayLike<number>;
  transformMatrix: ArrayLike<number>;
}

/** Placement policy. Disparities in eye-baseline units (0 = on the glass, < 0 = in front); times in seconds. */
export interface CursorTuning {
  margin: number;
  minDisparity: number;
  maxDisparity: number;
  riseTau: number;
  sinkTau: number;
  stale: number;
}

/** The runtime's defaults: margin 0.03, clamp ±0.6, rise 30 ms, sink 250 ms, stale 0.5 s. */
export const CURSOR_DEFAULT_TUNING: Readonly<CursorTuning>;
/** Default sprite height, as a fraction of the canvas height (0.03). */
export const CURSOR_DEFAULT_HEIGHT: number;

/** The cursor's line of sight for one frame. */
export interface CursorGeometry {
  eye: number[];
  canvasPoint: number[];
  forward: number[];
  eyeToCanvas: number;
  canvasHeight: number;
  /** The display plane's unit axes: draw the sprite in its X/Y plane, facing +Z. */
  basis: { x: number[]; y: number[]; z: number[] };
}

/** The ray from a view through canvas point (u, v) (`[0,1]²`, origin top-left, v down). */
export function cursorViewRay(view: CursorView, u: number, v: number): { origin: number[]; direction: number[] };
/** Solve the line of sight from two views (the outermost pair); null when degenerate (2D, off-canvas). */
export function solveCursorGeometry(viewA: CursorView, viewB: CursorView, u: number, v: number): CursorGeometry | null;
/** A point's disparity; null when it is not in front of the eye. */
export function cursorPointDisparity(g: CursorGeometry, point: ArrayLike<number>): number | null;
/** Content minus the margin, clamped; 0 when nothing is under the cursor. */
export function cursorTarget(tuning: CursorTuning, hasContent: boolean, contentDisparity: number): number;
/** Advance a filter (`{}` to start; the first step snaps) toward `target` at `nowSec`. */
export function cursorFilterStep(filter: object, tuning: CursorTuning, target: number, nowSec: number): number;
/** Where to draw a sprite at `disparity`, and how tall. */
export function placeCursor(g: CursorGeometry, disparity: number, heightFraction: number): { position: number[]; height: number };

/** One frame's placement. `position`/`basis` are in the views' space; null when inactive. */
export interface CursorPlacement {
  active: boolean;
  position: number[] | null;
  basis: { x: number[]; y: number[]; z: number[] } | null;
  height: number;
  disparity: number;
  targetDisparity: number;
}

/** The whole pipeline with its filter state: one per cursor. Inactive with fewer than two views. */
export class CursorDepthPlacer {
  constructor(tuning?: CursorTuning);
  update(
    views: ArrayLike<CursorView | XRView>,
    hint: {
      /** Canvas-normalised pointer, v down. */
      u: number;
      v: number;
      /** Nearest content point under the cursor FOOTPRINT, in the views' space; null = nothing. */
      nearestPoint: ArrayLike<number> | null;
      /** Sprite height as a fraction of the canvas height (default 0.03). */
      cursorHeight?: number;
    },
    nowSec: number,
  ): CursorPlacement;
}

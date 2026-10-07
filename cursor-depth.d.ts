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

/** The runtime's defaults: margin 0.005 (~1.5 mm at 60 cm), clamp ±0.6, rise 30 ms, sink 250 ms, stale 0.5 s. */
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

/**
 * Where along the cursor's depth the sprite goes.
 * - `'hybrid'` (default): on the line of sight while the pointer MOVES (exactly over it), and
 *   world-FIXED while it is still, so it parallaxes with the content as the head moves.
 * - `'screen'`: always on the line of sight. Never parallaxes; on a head-tracked display it can
 *   read as "at the glass".
 * - `'world'`: always straight in front of the pointer's canvas point. Parallaxes; drifts ~mm off
 *   the pointer from an off-axis viewer.
 */
export type CursorAnchorMode = 'hybrid' | 'screen' | 'world';
export const CURSOR_ANCHOR_MODES: readonly CursorAnchorMode[];

/** `cursor: { … }` on ./model and ./splat (an object also means `'depth'`). */
export interface CursorOptions {
  /** Sprite height as a fraction of the canvas height (default 0.03). */
  height?: number;
  /** How far in front of the content it floats, in eye-baseline units (default 0.005). */
  margin?: number;
  /** Default `'hybrid'`. */
  anchor?: CursorAnchorMode;
  /** `'window'`: keep the cursor over DOM layered on the canvas, and hide the CSS cursor page-wide meanwhile. Default `'canvas'`. */
  pointerScope?: 'canvas' | 'window';
}
export const CURSOR_OPTION_KEYS: readonly (keyof CursorOptions)[];
/** `cursor` as ./model and ./splat accept it: null = off; throws on a bad value. */
export function resolveCursorOption(opt: unknown, who?: string): CursorOptions | null;

/** The crosshair as filled, outlined strokes in its own XY plane (unit = sprite height), non-indexed triangles. */
export function cursorCrosshairMesh(
  fill?: readonly number[],
  outline?: readonly number[],
): { positions: Float32Array; colors: Float32Array; count: number };
/** Column-major model matrix placing the unit crosshair for a placement. */
export function cursorModelMatrix(placement: CursorPlacement, out?: number[]): number[];

/** One frame's placement. `position`/`basis` are in the views' space; null when inactive. */
export interface CursorPlacement {
  active: boolean;
  position: number[] | null;
  basis: { x: number[]; y: number[]; z: number[] } | null;
  height: number;
  disparity: number;
  targetDisparity: number;
  /** Hybrid: true while the pointer is still and the sprite is held world-fixed. */
  anchored?: boolean;
}

/** The whole pipeline with its filter state: one per cursor. Inactive with fewer than two views. */
export class CursorDepthPlacer {
  constructor(tuning?: CursorTuning, opts?: { anchor?: CursorAnchorMode });
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

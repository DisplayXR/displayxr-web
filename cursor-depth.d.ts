// Type definitions for @displayxr/inline3d/cursor-depth — the depth-aware cursor's placement
// maths, dependency-free. A port of the runtime's u_cursor_depth (ADR-046, XR_DXR_cursor_depth):
// same geometry, same defaults, same numbers. For three.js, ./three's `DepthCursor` wires it up.
//
// The policy (ADR-046 Amendment 2), the same for every DisplayXR depth cursor: never behind the
// glass (`cursorTarget`), margin 0.015 eye baselines, drawn only past the draw threshold
// (`cursorShouldDraw`; otherwise the OS cursor is the cursor), the classic arrow at the OS cursor's
// size (`CURSOR_ARROW`, `cursorArrowMesh`, `cursorDefaultHeight`).

/** A view as an XRView carries it: column-major projection + transform matrices. */
export interface CursorView {
  projectionMatrix: ArrayLike<number>;
  transformMatrix: ArrayLike<number>;
}

/** Placement policy. Disparities in eye-baseline units (0 = on the glass, < 0 = in front); times in seconds. */
export interface CursorTuning {
  margin: number;
  minDisparity: number;
  /** Never above 0 in effect: `cursorTarget` never puts the cursor behind the glass, whatever this says. */
  maxDisparity: number;
  riseTau: number;
  sinkTau: number;
  stale: number;
}

/** The defaults: margin 0.015 (~1 mm at a 63–65 mm IPD), clamp [−0.6, 0], rise 30 ms, sink 250 ms, stale 0.5 s. */
export const CURSOR_DEFAULT_TUNING: Readonly<CursorTuning>;
/** Fallback sprite height, as a fraction of the canvas height (0.03), when the canvas's on-page size is unknown. */
export const CURSOR_DEFAULT_HEIGHT: number;
/** The OS arrow's height in CSS px (19): the drawn arrow's default size. */
export const CURSOR_ARROW_CSS_PX: number;
/** The default sprite height for a canvas `cssHeight` CSS px tall: 19 CSS px of it (capped at 0.5); the fallback when unknown. */
export function cursorDefaultHeight(cssHeight: number): number;
/** The draw threshold, eye-baseline units (−0.005): drawn only at or below it. */
export const CURSOR_DRAW_THRESHOLD: number;
/** …and only at ≥ this many panel pixels of on-screen disparity (0.5), where pixels are knowable. */
export const CURSOR_DRAW_MIN_PX: number;
/** Draw at this filtered disparity? `pxPerBaseline`: panel px of on-screen disparity per baseline unit, when known. */
export function cursorShouldDraw(disparity: number, pxPerBaseline?: number | null): boolean;

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
/** The policy: `d < 0 ? max(d − margin, minDisparity) : 0` — never behind the glass; 0 with nothing under the cursor. */
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
  /** Sprite height as a fraction of the canvas height (default: the OS arrow's 19 CSS px of the canvas). */
  height?: number;
  /** How far in front of out-of-screen content it floats, in eye-baseline units (default 0.015). */
  margin?: number;
  /** Default `'hybrid'`. */
  anchor?: CursorAnchorMode;
  /** `'window'`: keep the cursor over DOM layered on the canvas, and hide the CSS cursor page-wide meanwhile. Default `'canvas'`. */
  pointerScope?: 'canvas' | 'window';
}
export const CURSOR_OPTION_KEYS: readonly (keyof CursorOptions)[];
/** `cursor` as ./model and ./splat accept it: null = off; throws on a bad value. */
export function resolveCursorOption(opt: unknown, who?: string): CursorOptions | null;

/** A ring of 9 canvas-normalised points: (u, v) and 8 around it at 0.75 × height. */
export function cursorFootprint(u: number, v: number, height: number, aspect: number): Array<[number, number]>;
/** What the arrow covers: its tip (the hotspot) first, then a ring around its body (down-right of the tip). */
export function cursorArrowFootprint(u: number, v: number, height: number, aspect: number): Array<[number, number]>;
/** The classic arrow's outline polygon (12 × 19 px normalised): unit = its height, x right, y DOWN, the tip = the hotspot at (0, 0). */
export const CURSOR_ARROW: ReadonlyArray<readonly [number, number]>;
/** Its white fill: the outline inset by one px of 19. */
export const CURSOR_ARROW_FILL: ReadonlyArray<readonly [number, number]>;
/** CURSOR_ARROW (or `poly`) inset by `d`, in units of its height. */
export function cursorArrowInset(d: number, poly?: ReadonlyArray<readonly [number, number]>): Array<[number, number]>;
/** White, and the dark outline (RGBA, 0..1). */
export const CURSOR_FILL_COLOR: readonly number[];
export const CURSOR_OUTLINE_COLOR: readonly number[];
/** The arrow as a 3D mesh in its XY plane (y UP, tip at the origin, unit = sprite height): outline then fill, non-indexed triangles. */
export function cursorArrowMesh(
  fill?: readonly number[],
  outline?: readonly number[],
): { positions: Float32Array; colors: Float32Array; count: number };
/** @deprecated The crosshair is retired (ADR-046 Amendment 2); use `cursorArrowMesh`. Removed in 2.0. */
export function cursorCrosshairMesh(
  fill?: readonly number[],
  outline?: readonly number[],
): { positions: Float32Array; colors: Float32Array; count: number };
/** Column-major model matrix placing the unit sprite (tip at its origin) for a placement. */
export function cursorModelMatrix(placement: CursorPlacement, out?: number[]): number[];

/** One frame's placement. `position`/`basis` are in the views' space; null when not solved. */
export interface CursorPlacement {
  /** Draw the sprite this frame (the policy's draw threshold). False on the plane: the OS cursor is the cursor. */
  active: boolean;
  /** The geometry solved (two views, pointer on the canvas): position/basis/height are filled even when not drawn. */
  solved?: boolean;
  /** Panel px of on-screen disparity per baseline unit, when `canvasPx` was given. */
  pxPerBaseline?: number | null;
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
      /** Sprite height as a fraction of the canvas height (default 0.03; see `cursorDefaultHeight`). */
      cursorHeight?: number;
      /** The canvas's height in panel pixels, for the draw threshold's pixel floor. */
      canvasPx?: number;
    },
    nowSec: number,
  ): CursorPlacement;
}

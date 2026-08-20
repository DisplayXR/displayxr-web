// Type definitions for @displayxr/inline3d/viewer.
// EXPERIMENTAL — not covered by the 1.x semver promise. See docs/sdk-stability.md.

/** Model-space bounds of the subject a viewer frames on. */
export interface SubjectBounds {
  center: number[];
  extent: number[];
}

export interface SceneViewerOptions {
  /** Metres of world the tile's HEIGHT spans. Pass the same value to addScene. */
  virtualDisplayHeight?: number;
  /**
   * How `fitTo` sizes the subject. `contain` caps BOTH width and height at `margin` of the tile.
   * `height` pins height to `margin` and only guards against running off the sides, giving a
   * consistent apparent size across a catalogue.
   */
  fit?: 'contain' | 'height' | 'cover' | 'none';
  /** Fraction of the tile the subject may occupy (default 0.8). */
  margin?: number;
  /** Backstop on total subject depth, in display heights (default 4.0). Rarely binds. */
  depthLimit?: number;
  /**
   * Fit the horizontal against the box's DIAGONAL (width and depth) rather than width alone,
   * so a long subject still fits once the turntable turns it (default true).
   */
  fitSweep?: boolean;
  /** Drag to spin, wheel/pinch to zoom (default true). */
  orbit?: boolean;
  /** Degrees/second of turntable once idle. Ignored under prefers-reduced-motion. */
  idleSpin?: number;
  /** Per-eye buffer scale; 0.5–0.7 is usually free after the interlace (default 1). */
  renderScale?: number;
  /** Edge fade in buffer px (needs EdgeFeather from ./three). */
  feather?: number;
  /** Pitch clamp in degrees (default [-60, 60]). */
  pitchLimit?: number[];
}

export interface OrbitPose {
  yaw?: number;
  pitch?: number;
  zoom?: number;
}

/**
 * Robust model-space bounds from a flat [x,y,z,…] array. The cheap path; prefer bounds computed
 * at conversion time where you have them.
 *
 * Percentiles REJECT outliers, they do not measure extent: `lo`/`hi` bound a rejection window
 * `expand` core-extents wide, and the returned extent is the true min/max inside it. Returning
 * the trimmed box itself under-reports a dense subject by 10-15% — a uniform cube measures 0.899
 * of its real size — which a fit then turns into a subject overflowing its tile. `expand: 0`
 * restores the old percentile-only box.
 */
export function boundsFromPositions(
  xyz: ArrayLike<number>,
  opts?: { lo?: number; hi?: number; expand?: number },
): SubjectBounds | null;

/** A single framed object in an inline-3D window: SBS loop, framing, orbit, mono fallback. */
export declare class SceneViewer {
  constructor(THREE: object, canvas: HTMLCanvasElement, opts?: SceneViewerOptions);

  readonly canvas: HTMLCanvasElement;
  /** Put your three.js object in here. */
  readonly content: object;
  readonly scene: object;
  readonly renderer: object;
  readonly monoCamera: object;
  /** True while the side-by-side backing store is in use. */
  readonly is3D: boolean;

  /** Centre the subject on the zero-disparity plane and scale it to the tile. */
  fitTo(
    center: number[] | { x: number; y: number; z: number },
    extent: number[] | { x: number; y: number; z: number },
  ): void;

  setPose(pose?: OrbitPose): void;
  resetPose(): void;

  /**
   * Pass straight to `wall.addScene(canvas, viewer.onFrame, …)`. Pre-bound.
   *
   * Validates before it clears: a frame that cannot draw both eyes (a short view list from a
   * session falling back under load, a missing viewport) re-renders the last good frame from
   * cached matrices instead of clearing the canvas to black — the canvas is committed every
   * frame either way, so the tile never goes dark and never smears (web#12).
   */
  onFrame(views: readonly XRView[], layer: object): void;

  /** Supply the ./three glue so the 3D path can build its eye camera. Returns `this`. */
  useEyeCamera(EyeCameraClass: unknown, EdgeFeatherClass?: unknown): this;

  /** Flat single-camera loop for browsers without inline-3D. */
  startMono(): void;
  stopMono(): void;

  dispose(): void;
}

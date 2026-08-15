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
  /** How `fitTo` sizes the subject against the tile. */
  fit?: 'contain' | 'cover' | 'none';
  /** Fraction of the tile the subject fills when fit (default 0.9). */
  margin?: number;
  /** Max subject depth as a multiple of the display height — stereo comfort (default 1.0). */
  depthLimit?: number;
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
 * Robust model-space bounds from a flat [x,y,z,…] array. The cheap percentile path; prefer
 * bounds computed at conversion time where you have them.
 */
export function boundsFromPositions(
  xyz: ArrayLike<number>,
  opts?: { lo?: number; hi?: number },
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

  /** Pass straight to `wall.addScene(canvas, viewer.onFrame, …)`. Pre-bound. */
  onFrame(views: readonly XRView[], layer: object): void;

  /** Supply the ./three glue so the 3D path can build its eye camera. Returns `this`. */
  useEyeCamera(EyeCameraClass: unknown, EdgeFeatherClass?: unknown): this;

  /** Flat single-camera loop for browsers without inline-3D. */
  startMono(): void;
  stopMono(): void;

  dispose(): void;
}

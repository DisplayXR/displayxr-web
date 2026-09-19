// Type definitions for @displayxr/inline3d/splat.
// EXPERIMENTAL — not covered by the 1.x semver promise. See docs/sdk-stability.md.

import type { SceneViewer, SubjectBounds, OrbitPose } from './viewer.js';

/**
 * The knobs behind `SplatOptions.perf`. Every one is a Spark 2.1.0 setting except `alphaRadius`,
 * which is a patch to Spark's own vertex shader (there is no option for it). Bit-exact vs lossy,
 * and the defaults each one overrides, are tabled in `js/inline3d-splat-perf.js`.
 */
export interface SplatPerfOptions {
  /** Shrink each quad to the radius where its alpha reaches `alphaFloor`. Bit-exact by default. */
  alphaRadius?: boolean;
  /**
   * The alpha each splat's tail may be cut at, PER SPLAT. Defaults to `minAlpha`, which is the
   * bit-exact cut; above it this is a lossy crop that scales with each splat's own opacity.
   */
  alphaFloor?: number;
  /** Drop splats and fragments under this alpha. Spark's default is `0.5/255`. */
  minAlpha?: number;
  /** Quad extent in σ, globally. Spark's default is `Math.sqrt(8)`. */
  maxStdDev?: number;
  /** Drop splats smaller than this, in pixels. Spark's default is 0. */
  minPixelRadius?: number;
  /** Clamp on quad size in pixels — note it SQUASHES rather than crops. Default 512. */
  maxPixelRadius?: number;
  /** 1 = Gaussian falloff, 0 = flat. Not a perf knob; 0 costs MORE. */
  falloff?: number;
  /** Build LOD data at load, so Spark can substitute merged splats against a budget. */
  lod?: boolean | 'quality';
  /** LOD budget multiplier (needs `lod`). */
  lodSplatScale?: number;
  /** Absolute LOD budget in splats (needs `lod`). */
  lodSplatCount?: number;
  /** Minimum on-screen splat size multiplier (needs `lod`); up to ~5 is often invisible. */
  lodRenderScale?: number;
}

/** The `camera` block of a `.sog`'s `meta.json`, plus the fields this SDK derives from it. */
export interface SogCamera {
  convention: 'opencv';
  rest: { position: number[]; rotation: number[] };
  intrinsics: { fx: number; fy: number; cx: number; cy: number; width: number; height: number };
  stereo: { baseline_m: number } | null;
  /** Full vertical angle of the capture, in RADIANS. */
  verticalFov: number;
  /** Principal point off the frame centre, as a fraction of the frame, y UP (not OpenCV's). */
  principalOffset: { x: number; y: number };
}

export interface SplatOptions {
  /** Metres of world the tile's height spans (default 0.24). */
  virtualDisplayHeight?: number;
  /**
   * Precomputed subject bounds. Strongly preferred — bake these at conversion time, where the
   * full opacity-weighted subject detection is cheap, instead of paying for a weaker
   * approximation in the page.
   */
  frame?: SubjectBounds;
  /** Apply the 180° X flip most splat exports need (default true). */
  flipY?: boolean;
  /** Degrees/second of turntable once idle (default 8). */
  idleSpin?: number;
  orbit?: boolean;
  fit?: 'contain' | 'height' | 'cover' | 'none';
  /** Fraction of the tile the subject may occupy (default 0.8) — width AND height. */
  margin?: number;
  /** Backstop on total depth, in display heights (default 4.0). Rarely binds. */
  depthLimit?: number;
  /**
   * Fit the horizontal against the box's DIAGONAL (width and depth) rather than width alone,
   * so a long subject still fits once the turntable turns it (default true).
   */
  fitSweep?: boolean;
  /** Per-eye buffer scale; 0.5–0.7 is usually free (default 1). */
  renderScale?: number;
  feather?: number;
  /** Minimum ms between splat sorts. Defaults to 16 so both eyes share one sort per frame. */
  sortIntervalMs?: number;
  /**
   * Cut overdraw. UNSET changes nothing — every Spark default stays where Spark put it, so an
   * existing page's pixels do not move.
   *
   * `'exact'` is the bit-exact pair — each quad shrunk to where its own alpha reaches 1/255
   * (those fragments were already being discarded), plus the 1/255 peak-opacity cull. It buys
   * little on a mostly-opaque capture, which is what a lifted photograph is. `'balanced'` (or
   * `true`, −5…−20 % measured) and `'aggressive'` (−22 %) tighten the quad extent instead, which
   * is the axis that actually pays on the web; both move pixels.
   */
  perf?: true | 'exact' | 'balanced' | 'aggressive' | SplatPerfOptions;
  /**
   * Which view rig. `'auto'` (the default) reads it off the ASSET — a `.sog` carrying a `camera`
   * block was lifted from a photograph and gets a camera rig that conserves the recording
   * camera; anything else is an object and gets the display rig with the auto-frame. Only
   * detectable when `src` is BYTES.
   */
  rig?: 'auto' | 'display' | 'camera';
  /** Camera rig only: the distance in world metres that sits ON the glass. */
  convergence?: number;
  /**
   * Disambiguates .splat from .ksplat when passing BYTES — content-sniffing cannot separate
   * those two. Unnecessary for .sog/.ply/.spz, which are identifiable by magic number.
   */
  fileName?: string;
  /**
   * Container format, when passing bytes. Usually unnecessary — the magic number is sniffed —
   * but note Spark's names are not the file extensions: a `.sog` is `pcsogszip`.
   */
  fileType?: 'ply' | 'spz' | 'splat' | 'ksplat' | 'pcsogs' | 'pcsogszip' | 'rad';
  /** Element whose visibility gates the lazy create/close lifecycle. */
  observe?: Element;
}

/** What {@link addSplat} returns: a TileHandle plus the objects behind it. */
export interface SplatHandle {
  readonly viewer: SceneViewer;
  /** Spark's SplatMesh. */
  readonly mesh: object;
  /** Spark's SparkRenderer. */
  readonly spark: object;
  /** Bounds actually used for framing; null until `ready` resolves. */
  frame: SubjectBounds | null;
  /**
   * The `.sog`'s `camera` block — the recording camera, when the asset carries one. Null for a
   * URL source, a non-`.sog`, or an object splat (which is most of them).
   */
  camera: SogCamera | null;
  /** Which rig this window is on. Null until `ready` resolves. */
  rig: 'display' | 'camera' | null;
  /** The view-rig descriptor sent to the runtime, on the camera path. */
  viewRig?: object;
  /** What `perf` actually applied, or null. */
  perf: object | null;
  /** Resolves once the asset has loaded and been framed; rejects if the load failed. */
  readonly ready: Promise<SplatHandle>;

  setPose(pose?: OrbitPose): void;
  resetPose(): void;

  /** Close this window and release its GPU resources. */
  remove(): void;
  /** Mark a 2D element painted over this window so the weave leaves it crisp. */
  exclude(el: Element): void;
  unexclude(el: Element): void;
}

/**
 * Load a splat into an inline-3D window. Safe to call with an unsupported wall — it renders a
 * flat, orbitable view instead, so pages need no branch.
 */
export function addSplat(
  wall: object | null | undefined,
  canvas: HTMLCanvasElement,
  /**
   * A URL, or the bytes themselves.
   *
   * Prefer BYTES for anything generated rather than fetched. Spark reads a splat's format from
   * the URL path, so an object URL from URL.createObjectURL() — which has no extension — fails
   * with "Unknown file type" before it fetches anything, and that reads like a corrupt asset
   * rather than a missing hint. Given bytes, Spark sniffs the magic number instead.
   */
  src: string | Blob | ArrayBuffer,
  opts?: SplatOptions,
): SplatHandle;

/** Robust model-space bounds of a loaded SplatMesh, lifted through its own matrix. */
export function measureSplatBounds(mesh: object, three?: object): SubjectBounds | null;

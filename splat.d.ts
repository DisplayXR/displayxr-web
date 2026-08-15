// Type definitions for @displayxr/inline3d/splat.
// EXPERIMENTAL — not covered by the 1.x semver promise. See docs/sdk-stability.md.

import type { SceneViewer, SubjectBounds, OrbitPose } from './viewer.js';

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
   * Disambiguates .splat from .ksplat when passing BYTES — content-sniffing cannot separate
   * those two. Unnecessary for .sog/.ply/.spz, which are identifiable by magic number.
   */
  fileName?: string;
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

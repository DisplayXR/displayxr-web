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
  fit?: 'contain' | 'cover' | 'none';
  margin?: number;
  depthLimit?: number;
  /** Per-eye buffer scale; 0.5–0.7 is usually free (default 1). */
  renderScale?: number;
  feather?: number;
  /** Minimum ms between splat sorts. Defaults to 16 so both eyes share one sort per frame. */
  sortIntervalMs?: number;
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
  wall: object,
  canvas: HTMLCanvasElement,
  src: string,
  opts?: SplatOptions,
): SplatHandle;

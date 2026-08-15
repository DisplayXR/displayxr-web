// Type definitions for @displayxr/inline3d/model.
// EXPERIMENTAL — not covered by the 1.x semver promise. See docs/sdk-stability.md.

import type { SceneViewer, SubjectBounds, OrbitPose } from './viewer.js';

export interface ModelOptions {
  /** Metres of world the tile's height spans (default 0.24). */
  virtualDisplayHeight?: number;
  /** Precomputed subject bounds. Rarely needed for a mesh — Box3 is exact. */
  frame?: SubjectBounds;
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
  /** Built-in three-point lighting. Meshes arrive unlit; splats do not need this. */
  environment?: 'studio' | 'none';
  /** A PMREM-processed environment texture. Better than `environment` for metal; overrides it. */
  envMap?: object;
  /** Hand in the GLTFLoader class instead of resolving it from `three/addons/`. */
  GLTFLoader?: unknown;
  /** Element whose visibility gates the lazy create/close lifecycle. */
  observe?: Element;
}

/** What {@link addModel} returns — the same shape as addSplat's handle. */
export interface ModelHandle {
  readonly viewer: SceneViewer;
  /** The loaded glTF scene root; null until `ready` resolves. */
  model: object | null;
  /** Bounds used for framing; null until `ready` resolves. */
  frame: SubjectBounds | null;
  /** Resolves once the model has loaded and been framed; rejects if the load failed. */
  readonly ready: Promise<ModelHandle>;

  setPose(pose?: OrbitPose): void;
  resetPose(): void;

  remove(): void;
  exclude(el: Element): void;
  unexclude(el: Element): void;
}

/**
 * Load a glTF/GLB into an inline-3D window. Safe to call with an unsupported wall — it renders a
 * flat, orbitable view instead, so pages need no branch.
 */
export function addModel(
  wall: object | null | undefined,
  canvas: HTMLCanvasElement,
  src: string,
  opts?: ModelOptions,
): ModelHandle;

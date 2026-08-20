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

  /**
   * Where **your page** serves three's Draco decoder and Basis (KTX2) transcoder.
   *
   * `addModel` reads the asset's `extensionsUsed` before parsing and attaches only the decoders it
   * declares, so an uncompressed model never touches any of this. But a decoder that IS needed has
   * to come from somewhere, and the default is deliberately **not a CDN** — a page shipping an
   * offline build must not acquire a network dependency by loading a compressed file. Copy the
   * files out of `three` and serve them yourself:
   *
   * ```sh
   * cp -r node_modules/three/examples/jsm/libs/draco/ public/draco/
   * cp -r node_modules/three/examples/jsm/libs/basis/ public/basis/
   * ```
   *
   * A string is a parent directory holding `draco/` and `basis/`; an object overrides either key.
   * `EXT_meshopt_compression` needs nothing served — its decoder is pure JS.
   *
   * @default {draco:'/draco/', basis:'/basis/'}
   */
  decoderPath?: string | { draco?: string; basis?: string };
  /**
   * DRACOLoader class **or** a ready instance, instead of resolving `three/addons/`. A class is
   * constructed and pointed at `decoderPath`; an instance is used exactly as you configured it.
   */
  DRACOLoader?: unknown;
  /**
   * KTX2Loader class or instance. `detectSupport()` is called for you with this tile's renderer,
   * and the transcoder is loaded eagerly so a mis-served path throws instead of silently
   * resolving a model with no textures.
   */
  KTX2Loader?: unknown;
  /** The `MeshoptDecoder` namespace, instead of resolving `three/addons/`. Nothing to serve. */
  meshoptDecoder?: unknown;

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
 *
 * Compressed assets (Draco, meshopt, KTX2/Basis) load too: the asset's declared extensions decide
 * which decoders are imported, and nothing is imported for an asset that declares none. Draco and
 * KTX2 additionally need their runtime files served by your page — see {@link ModelOptions.decoderPath}.
 * When a decoder is needed and unavailable, `ready` rejects with an Error naming the glTF
 * extension, the option that fixes it and the path it looked in; the extension is also on the
 * error as `gltfExtension`.
 */
export function addModel(
  wall: object | null | undefined,
  canvas: HTMLCanvasElement,
  src: string,
  opts?: ModelOptions,
): ModelHandle;

// Type definitions for @displayxr/inline3d/model (and ./model/three).
// EXPERIMENTAL — not covered by the 1.x semver promise. See docs/sdk-stability.md.

import type { SceneViewer, SubjectBounds, OrbitPose } from './viewer.js';
import type { FirstWovenResult } from './index.js';
import type { PlayCanvasSplatViewer, SplatCameraPose, SplatFrameInfo } from './splat.js';

export interface ModelOptions {
  /**
   * Which engine renders the model (1.12). `'playcanvas'` is the DEFAULT (optional peer
   * `playcanvas >=2.22.3 <3`); `'three'` is the 1.11 renderer, byte for byte (optional peer
   * `three`). Both are imported dynamically, so a page loads only the engine it renders with.
   *
   * With no `engine`: a three.js object in `GLTFLoader` / `DRACOLoader` / `KTX2Loader` / `envMap`
   * selects three; otherwise PlayCanvas, falling back to three (one console warning) when
   * `playcanvas` cannot be imported, and rejecting `ready` naming both when neither can. An
   * explicit `engine` never falls back. Anything else throws at call time.
   */
  engine?: 'playcanvas' | 'three';
  /** Metres of world the tile's height spans (default 0.24). */
  virtualDisplayHeight?: number;
  /** Precomputed subject bounds. Rarely needed for a mesh — its bounds are exact. */
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
  /**
   * How the mesh is lit.
   *
   * PlayCanvas (default engine): `room` (default; `neutral` is an alias) is image-based lighting
   * from an in-memory neutral photo studio fitted to the Khronos glTF Sample Viewer's "Studio
   * Neutral", with Khronos PBR Neutral tone mapping and exposure 1 — the Sample Viewer's look.
   * three: `room` bakes three's procedural RoomEnvironment, untonemapped (unchanged since 1.11).
   *
   * Both: `studio` is the three-point punctual rig (metal renders dark under it — nothing to
   * reflect); `none` adds no light at all. Anything else throws on PlayCanvas.
   */
  environment?: 'room' | 'neutral' | 'studio' | 'none';
  /**
   * PlayCanvas only: yaw of the environment about +Y, degrees (default 0 = the Sample Viewer's
   * default orientation).
   */
  environmentRotation?: number;
  /**
   * Your own environment; overrides `environment`.
   * three: a PMREM-processed texture. PlayCanvas: a URL of an equirect image (.hdr/.png/.jpg) or
   * a `pc.Texture` (equirect or cubemap), prefiltered for you. A three texture on
   * `engine: 'playcanvas'` throws; with no `engine` it selects three.
   */
  envMap?: object | string;
  /** three only: hand in the GLTFLoader class instead of resolving it from `three/addons/`. */
  GLTFLoader?: unknown;

  /**
   * Where **your page** serves the Draco decoder and Basis (KTX2) transcoder — the SAME files on
   * both engines: three's `libs/draco/` (`draco_wasm_wrapper.js` + `draco_decoder.wasm`) and
   * `libs/basis/` (`basis_transcoder.js` + `.wasm`). The PlayCanvas engine's own Draco and Basis
   * workers load them.
   *
   * The asset's `extensionsUsed` decides which decoders are wired, so an uncompressed model never
   * touches any of this. The default is deliberately **not a CDN** — a page shipping an offline
   * build must not acquire a network dependency by loading a compressed file:
   *
   * ```sh
   * cp -r node_modules/three/examples/jsm/libs/draco/ public/draco/
   * cp -r node_modules/three/examples/jsm/libs/basis/ public/basis/
   * ```
   *
   * A string is a parent directory holding `draco/` and `basis/`; an object overrides either key.
   * On PlayCanvas the engine keeps ONE Draco and ONE Basis worker pool per page: the first tile
   * that needs one sets its path, and a later tile asking for another path is warned.
   *
   * @default {draco:'/draco/', basis:'/basis/'}
   */
  decoderPath?: string | { draco?: string; basis?: string };
  /** three only: DRACOLoader class **or** a ready instance, instead of resolving `three/addons/`. */
  DRACOLoader?: unknown;
  /** three only: KTX2Loader class or instance. */
  KTX2Loader?: unknown;
  /**
   * The `MeshoptDecoder` for `EXT_meshopt_compression`. Nothing to serve (pure JS). Default: three
   * resolves `three/addons/libs/meshopt_decoder.module.js`; PlayCanvas resolves
   * `meshoptimizer/decoder` (optional peer `meshoptimizer >=1`), only for an asset that declares it.
   */
  meshoptDecoder?: unknown;

  /** PlayCanvas only: the `playcanvas` module (or a namespace with the same members) to use. */
  playcanvas?: object;
  /** PlayCanvas only: MSAA on the tile's WebGL context (default true, as three's renderer). */
  antialias?: boolean;
  /** PlayCanvas only: the context's `preserveDrawingBuffer` (default false). */
  preserveDrawingBuffer?: boolean;
  /** PlayCanvas only: raise every projection's near plane to at least this (depth mapping only). */
  nearClip?: number;
  /** PlayCanvas only: lower every projection's far plane to at most this. */
  farClip?: number;
  /** PlayCanvas only: the drag's tilt cap in degrees (default 15, tilt-and-relax). */
  orbitMaxDeg?: number;
  /** PlayCanvas only: the orbit's easing time constants, seconds. */
  orbitEase?: { drag?: number; rest?: number };
  /**
   * PlayCanvas only: who owns the camera — the SDK's viewer (default) or the page, through
   * {@link ModelHandle.setCameraPose} every frame (the attach rig; converges on the model's bounds
   * centre unless the pose gives a `convergence`).
   */
  controls?: 'viewer' | 'page';
  /** `controls: 'page'`: the comfort depth of the declared rig, in (0, 1] (default 0.3). */
  comfortDepth?: number;
  /** `controls: 'page'` only: runs inside the adapter's frame, before the draw. */
  onBeforeFrame?: (frame: SplatFrameInfo) => void;

  /** Element whose visibility gates the lazy create/close lifecycle. */
  observe?: Element;
  /** Forwarded to the core window: see `TileOptions.firstWovenHoldMs`. */
  firstWovenHoldMs?: number;
}

/** What {@link addModel} returns — the same shape as addSplat's handle. */
export interface ModelHandle {
  /** Which engine renders this tile. Can change from `'playcanvas'` to `'three'` on the fallback. */
  readonly backend: 'playcanvas' | 'three';
  /**
   * three: the SceneViewer. PlayCanvas: the backend's viewer (the SceneViewer pose surface
   * without three). Null until the backend module has loaded — one module fetch after addModel
   * returns (1.11 returned it synchronously; `@displayxr/inline3d/model/three` still does).
   */
  readonly viewer: SceneViewer | PlayCanvasSplatViewer | null;
  /**
   * The loaded glTF root — a three `Object3D`, or on PlayCanvas the render `pc.Entity`
   * (`instantiateRenderEntity()`). Null until `ready` resolves.
   */
  model: object | null;
  /** PlayCanvas only: the container resource (animations, materials, textures). */
  readonly container?: unknown;
  /**
   * PlayCanvas only (ADVANCED, not covered by the semver promise): `app` is the tile's AppBase,
   * `root` the content root (the model's parent — add entities, lights or an `anim` component
   * under it), `camera` the eye camera. Null on three and until the engine has booted.
   */
  readonly engine: { readonly app: unknown; readonly root: unknown; readonly camera: unknown } | null;
  /** Bounds used for framing; null until `ready` resolves. */
  frame: SubjectBounds | null;
  /** Resolves once the model has loaded and been framed; rejects if the load failed. */
  readonly ready: Promise<ModelHandle>;

  /** Throws on `controls: 'page'`. */
  setPose(pose?: OrbitPose): void;
  /** Throws on `controls: 'page'`. */
  resetPose(): void;
  /** `controls: 'page'` only (throws otherwise): the camera for the next frame, model space. */
  setCameraPose(
    matrixWorld: ArrayLike<number>,
    opts: { verticalFovDeg: number; near?: number; far?: number; convergence?: number | null },
  ): ModelHandle;
  /** The last pose the page set (a copy), or null. */
  getCameraPose(): SplatCameraPose | null;

  remove(): void;
  exclude(el: Element): void;
  unexclude(el: Element): void;
  /**
   * The core window's `TileHandle.firstWoven`: when it is safe to reveal the canvas. Resolves
   * `{ woven: false, reason: 'unsupported' }` at once where there is no inline-3D session.
   */
  readonly firstWoven: Promise<FirstWovenResult>;
}

/**
 * Load a glTF/GLB into an inline-3D window. Safe to call with an unsupported wall — it renders a
 * flat, orbitable view instead, so pages need no branch. Renders with PlayCanvas by default
 * (1.12); pass `engine: 'three'` for the 1.11 renderer.
 *
 * Compressed assets (Draco, meshopt, KTX2/Basis) load too: the asset's declared extensions decide
 * which decoders are wired, and nothing is wired for an asset that declares none. Draco and
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

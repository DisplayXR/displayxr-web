// Type definitions for @displayxr/inline3d/lift — "Convert to 3D".
// EXPERIMENTAL — not covered by the 1.x semver promise. See docs/sdk-stability.md and docs/lift.md.

import type { Inline3D } from './index.js';

/** The lift state machine's states (docs/lift.md § State machine). */
export type LiftState =
  | 'idle'
  | 'loading'
  | 'live'
  | 'freezing'
  | 'lifting'
  | 'explore'
  | 'suspended'
  | 'error'
  | 'disposed';

export declare const STATES: Readonly<{
  IDLE: 'idle';
  LOADING: 'loading';
  LIVE: 'live';
  FREEZING: 'freezing';
  LIFTING: 'lifting';
  EXPLORE: 'explore';
  SUSPENDED: 'suspended';
  ERROR: 'error';
  DISPOSED: 'disposed';
}>;

export type LiftQuality = 'low' | 'medium' | 'high';

export interface LiftOptions {
  /** `auto`: live while playing, lift on pause/end. `live`: never lifts by itself. `explore`: lift once the models are in. Default `auto`. */
  mode?: 'auto' | 'live' | 'explore';
  /** Depth strength multiplier: live DIBR, and the explore scene's depth about its pivot. Default 1. */
  depth?: number;
  /** Zero-disparity plane for live DIBR: normalised disparity 0..1, or `auto` (default). */
  convergence?: 'auto' | number;
  /**
   * `auto` (default) resolves to `medium` on a desktop with ≥ 4 GB and ≥ 4 cores, `low` otherwise
   * or on a small phone; never `high`. The video depth model alone keeps `auto` (a warm-up picks its
   * resolution by measured frame time).
   */
  quality?: 'auto' | LiftQuality;
  /** An existing `createInline3D()` manager to join. Pass it if the page already has one. */
  wall?: Inline3D;
  /** Explore orbit: cap in degrees (default 15) and whether a release springs back (default true). */
  orbit?: { maxAngleDeg?: number; relax?: boolean; gain?: number };
  /** A {@link ModelSource}; a base URL string (`createModelSource({ baseUrl })`); or `auto` (default). */
  models?: 'auto' | string | ModelSource;
  /** onnxruntime-web: the module itself, a dist base URL, or `loadOrt` options. Default: jsDelivr, pinned. */
  ort?: unknown | string | LoadOrtOptions;
  /**
   * Model / provider names. `video` default `vda-small`; `still` default `moge3` (also `da3`,
   * `da2-small`, a manifest name, or a registered provider name); `inpaint` default `none`
   * (`light-inpaint-v1` enables the net).
   */
  providers?: { video?: string; still?: string; inpaint?: string };
  /** `builtin` (default): a small chip with progress and Explore / Resume / Exit. `none`: drive the handle yourself. */
  ui?: 'builtin' | 'none';
  /** Aborting removes the lift. */
  signal?: AbortSignal;
  /** `stub` swaps in js/lift/stubs/* (same contracts, no ML) — development and demos only. Default `real`. */
  backend?: 'real' | 'stub';
  /**
   * Load the still model while live runs so the first pause is faster. Live depth is HELD while it
   * compiles (onnxruntime-web cannot create a session while another runs). Default false.
   */
  prefetch?: boolean;
  /** Cap on devicePixelRatio for the canvas while explore is up. Default 1 on a woven (SBS) store unless quality is `high`, else uncapped. */
  exploreMaxDpr?: number;
  /**
   * The explore view. `comfort` `auto` (default) scales a METRIC lift about the camera so its pivot
   * lands at `pivotTargetM` (default 2.0 m) when it is more than 25 % off (the neutral image is
   * unchanged; parallax scales by pivot/target); `always` / `off` for A/B. `eyes` `nominal`
   * (default) normalises the runtime's eye separation to 63 mm; `tracked` takes the eye positions
   * as metres.
   */
  explore?: { pivotTargetM?: number; comfort?: 'auto' | 'always' | 'off'; eyes?: 'nominal' | 'tracked' };
  /**
   * The browser's vendor 2D→3D module (docs/lift.md § Vendor modules). `auto` (default): when
   * {@link liftCapabilities} reports `native` and the element is a `<video>`/`<img>`, the BROWSER
   * converts + weaves it in place (`dxr-lift="auto"`): no DIBR canvas, no model until a pause.
   * `false`: never. A caps object skips the query. Ignored with `backend: 'stub'`.
   */
  native?: 'auto' | boolean | LiftCapabilities;
  /** Native live: how eagerly the browser converts this element (`dxr-lift-priority`). Default `normal`. */
  priority?: LiftPriority;
}

export interface LiftProgress {
  phase: 'models' | 'depth' | 'lift';
  /** 0..1 within the phase. */
  value: number;
}

export interface LiftStats {
  state: LiftState;
  /** Frames drawn per second (the addScene callback or the 2D-fallback rAF). */
  fps: number;
  /** Load: backend + first depth model + media ready, ms. */
  modelLoadMs: number;
  /** Last live (video) depth estimate, ms. */
  liveDepthMs: number;
  /** Last still-model depth estimate, ms. */
  stillDepthMs: number;
  /** Last lift generation (incl. inpainting when enabled), ms. */
  generateMs: number;
  /** PLY parse + GPU upload for the explore renderer, ms. */
  exploreLoadMs: number;
  /** Freeze start → explore ready (excludes the 150 ms pause debounce), ms. */
  pauseToExploreMs: number;
  /** Gaussians in the last lift. */
  splats: number;
  /** The explore comfort scale applied about the camera (1 = none). */
  exploreScale: number;
  /** `native`: the browser's vendor module converts live; `web`: the SDK's own pipeline. */
  mode: 'native' | 'web';
  /** The vendor module's name (native mode), else null. */
  provider: string | null;
}

export interface LiftHandle {
  readonly state: LiftState;
  readonly element: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement;
  readonly canvas: HTMLCanvasElement;
  /** How the canvas was placed: next to the element, beside its `<picture>`, in a ratio box, or as an overlay. */
  readonly layout: 'standard' | 'picture' | 'aspectRatio' | 'overlay';
  /** True when rendering through the inline-3D session; false in the 2D fallback. */
  readonly woven: boolean;
  /** True when the browser's vendor module converts this element (native live mode). */
  readonly native: boolean;
  /** The capabilities native mode was decided on (null when not queried, e.g. a `<canvas>`). */
  readonly caps: LiftCapabilities | null;
  /** Native live: `dxr-lift-priority`. Returns false for an unknown value; a no-op on the web path. */
  setPriority(p: LiftPriority): boolean;
  readonly priority: LiftPriority;
  /** Snapshot of timings. */
  readonly stats: LiftStats;
  on(type: 'statechange', cb: (d: { state: LiftState; from: LiftState; reason: string }) => void): () => void;
  on(type: 'progress', cb: (d: LiftProgress) => void): () => void;
  on(type: 'error', cb: (d: { error: unknown; fatal: boolean; phase?: string }) => void): () => void;
  off(type: string, cb: (...a: any[]) => void): void;
  /** Freeze the current frame and lift it (a video pauses). No-op outside `live`. */
  explore(): void;
  /** Back to live: plays a paused video (its `play` event crossfades explore → live). */
  resume(): void;
  /** Explore: turn the lifted scene to (yaw, pitch) degrees, clamped to the orbit cap. */
  setOrbit(yaw: number, pitch?: number): void;
  /** Depth strength: live DIBR and, in explore, the lifted scene's depth about its pivot. */
  setDepth(x: number): void;
  setConvergence(x: 'auto' | number): void;
  /**
   * The last lifted scene as a `.sog` (SOG v2, lossless webp planes) carrying the DisplayXR camera
   * block v2 (rig `camera`, the lift's intrinsics, focus = the pivot), built in the page. Rejects
   * before the first lift. `camera` is merged onto the block.
   */
  exportSog(opts?: { camera?: Record<string, unknown>; onProgress?: (p: number) => void }): Promise<Blob>;
  /** exportSog() saved as a file (`<media name>-3d.sog` by default). Resolves false if nothing was saved. */
  downloadSog(filename?: string): Promise<boolean>;
  /** True once a scene has been lifted. */
  readonly canExport: boolean;
  /**
   * The canvas as the next frame draws it (the whole backing store — both eyes side by side when
   * woven), as a PNG, read back in the same task as the draw. For evidence captures: the canvas has
   * `preserveDrawingBuffer: false`, so a page screenshot between frames can show it empty.
   */
  capture(): Promise<Blob>;
  /** Unmount; the element is exactly as it was. */
  remove(): void;
}

/** Lift `element` (or the media at/near it) into 3D in place. */
export declare function lift(element: Element, opts?: LiftOptions): Promise<LiftHandle>;

/** The media element under a viewport point (looks through overlays, into open shadow roots and player chrome), or null. */
export declare function resolveMediaAt(x: number, y: number): HTMLVideoElement | HTMLImageElement | HTMLCanvasElement | null;

/** What `quality: 'auto'` resolves to on this device. */
export declare function resolveQuality(q?: 'auto' | LiftQuality, nav?: Partial<Navigator> & { deviceMemory?: number }): LiftQuality;

// ── Providers ────────────────────────────────────────────────────────────────────────────────

/** A depth map at MODEL resolution, row-major h × w. */
export interface DepthMap {
  data: Float32Array;
  w: number;
  h: number;
  /** `disparity`: relative, larger = nearer. `metric`: metres, 0 = invalid (e.g. sky). */
  space: 'disparity' | 'metric';
  /** `focalPx` is in pixels of THIS map's grid (w × h). */
  intrinsics?: { focalPx: number; fovXDeg?: number };
  mask?: Uint8Array;
}

export type DepthSource = HTMLVideoElement | HTMLImageElement | HTMLCanvasElement | VideoFrame | ImageBitmap;

export interface DepthProvider {
  readonly id?: string;
  readonly kind: 'video' | 'still';
  load(o?: { signal?: AbortSignal; onProgress?: (p: { loaded: number; total: number }) => void }): Promise<unknown>;
  /** Serialised: a call made while another is in flight waits for it. */
  estimate(o: { source: DepthSource; t?: number }): Promise<DepthMap>;
  /** Scene cut: drop temporal state (video). */
  reset(): void;
  dispose(): void;
}

export interface Inpainter {
  load(o?: { signal?: AbortSignal; onProgress?: (p: { loaded: number; total: number }) => void }): Promise<unknown>;
  /** rgb: planar CHW 0..1; masks: 1 = hole (background to the right / to the left). */
  inpaintTwoSided(rgbChw: Float32Array, maskRight: Float32Array, maskLeft: Float32Array, w: number, h: number): Promise<Float32Array>;
}

export interface ProviderFactoryOptions {
  kind?: 'video' | 'still';
  modelSource: ModelSource;
  ort?: unknown;
  quality?: 'auto' | LiftQuality;
  /** A model family (`vda-small`, `moge3`, `da3`, `da2-small`, `light-inpaint-v1`) or manifest name. */
  model?: string;
}

export interface LiftRegistry {
  /** Register (or replace, by name) a depth provider; the highest priority available one wins. */
  registerDepthProvider(
    name: string,
    factory: (o: ProviderFactoryOptions) => DepthProvider,
    o?: { priority?: number; kinds?: Array<'video' | 'still'>; available?: () => boolean },
  ): () => void;
  registerInpainter(name: string, factory: (o: ProviderFactoryOptions) => Inpainter, o?: { priority?: number; available?: () => boolean }): () => void;
  /** A registered provider name, or a model/family name handed to the best provider. Returns an instance. */
  getDepthProvider(name: string | null, opts: ProviderFactoryOptions): DepthProvider;
  getInpainter(name: string | null, opts: ProviderFactoryOptions): Inpainter;
  list(): Array<{ name: string; priority: number; kinds: string[] }>;
  listInpainters(): Array<{ name: string; priority: number; kinds: string[] }>;
}

/** The page-wide provider registry (shared by every copy of the SDK on the page). */
export declare function getRegistry(): LiftRegistry;

export interface ModelSource {
  ready(): Promise<unknown>;
  /** Download URL: baseUrl + path, else an absolute per-file url, else `${blobBaseUrl}/${sha256}.${format}`. */
  url(name: string): string;
  get(name: string, o?: { signal?: AbortSignal; onProgress?: (p: { loaded: number; total: number }) => void }): Promise<{ stream: ReadableStream<Uint8Array>; size: number; sha256: string; source: string }>;
  getBytes(name: string, o?: { signal?: AbortSignal; onProgress?: (p: { loaded: number; total: number }) => void }): Promise<{ bytes: Uint8Array; size: number; sha256: string; source: string }>;
  /** Is `name` in the manifest (after `ready()`)? */
  has(name: string): boolean;
  /** The manifest entry (io descriptor, role, files, …) for a model. */
  entry(name: string): Record<string, any>;
  readonly manifest: Record<string, any> | null;
  resolveName(nameOrFamily: string | null | undefined, role: 'depth-video' | 'depth-still' | 'inpaint', quality?: 'auto' | LiftQuality): string;
  /** Obtainable without a download? (native store HEAD, a verified cache stamp, else a HEAD on the URL.) Never rejects. */
  probe?(name: string, o?: { signal?: AbortSignal }): Promise<boolean>;
  clear(): Promise<void>;
}

export interface ModelSourceOptions {
  /** Where the model files live (joined with each manifest `path`). Omit to use the manifest's public blob store. */
  baseUrl?: string;
  /** A manifest object, or its URL. Default: the SDK's js/lift/models.json. */
  manifest?: string | object;
  /** Prefer the DisplayXR Browser's native model store. Default: auto-detected. */
  native?: boolean;
  /** sha256-verify network downloads. Default true. */
  verify?: boolean;
  /** Cache API bucket; `null` disables caching. */
  cacheName?: string | null;
}

export declare function createModelSource(o?: ModelSourceOptions): ModelSource;

export interface LoadOrtOptions {
  /** onnxruntime-web `dist/` URL. Default: jsDelivr, pinned to the tested build. */
  baseUrl?: string;
  /** `auto` picks the JSPI build when the browser has WebAssembly JSPI. */
  bundle?: 'auto' | 'jspi' | 'webgpu';
}

/** Import onnxruntime-web at runtime (never bundled). Memoised per URL. */
export declare function loadOrt(o?: LoadOrtOptions): Promise<any>;

// ── Vendor modules (native mode) ─────────────────────────────────────────────────────────────

export type LiftPriority = 'high' | 'normal' | 'low' | 'paused';

/** What {@link liftCapabilities} reports (docs/lift.md § Vendor modules). */
export interface LiftCapabilities {
  /** The browser's vendor 2D→3D module is reachable from this world and not `unavailable`: it supersedes the web path. */
  native: boolean;
  /** The module's name, e.g. `neurd-directml`. */
  provider?: string;
  modes?: Array<'depth' | 'sbs' | 'nview' | 'gaussians'>;
  /** In-place conversions the module can run at once. */
  maxStreams?: number;
  approxMsPerConvert?: number;
  state?: 'ready' | 'activating' | 'unavailable';
  /** The open web path: a WebGPU adapter, and whether its default video / still depth model is reachable without a download attempt. */
  webFallback: { video: boolean; still: boolean; webgpu: boolean };
}

/**
 * What 2D→3D this document can do — cheap, async, cached per document; call it before any lift
 * (e.g. to badge convertible media). `native` comes from `GET displayxr-lift://caps`, which only
 * resolves inside the DisplayXR Browser's lift world; anywhere else the fetch rejects → `native: false`.
 */
export declare function liftCapabilities(o?: {
  signal?: AbortSignal;
  /** Re-ask (e.g. after `state: 'activating'`). */
  refresh?: boolean;
  /** false skips the model probes (webFallback all false). Default true. */
  webFallback?: boolean;
  /** The ModelSource to probe, as lift()'s `models`. Default `auto`. */
  models?: 'auto' | string | ModelSource;
  /** Still-model tier to probe. Default `medium`. */
  quality?: LiftQuality;
  timeoutMs?: number;
}): Promise<LiftCapabilities>;

/** The attributes the DisplayXR Browser reads on a `<video>`/`<img>` it converts in place. */
export declare const LIFT_ATTRS: Readonly<{
  lift: 'dxr-lift';
  convergence: 'dxr-lift-convergence';
  strength: 'dxr-lift-strength';
  priority: 'dxr-lift-priority';
}>;
export declare const LIFT_PRIORITIES: ReadonlyArray<LiftPriority>;

/** A native-module failure; `fallback` is true for everything but an abort. */
export declare class NativeLiftError extends Error {
  code: 'http' | 'unsupported' | 'format' | 'encode' | 'network' | 'aborted';
  fallback: boolean;
  status?: number;
}

/**
 * The `native` DepthProvider (stills): `POST displayxr-lift://lift/depth`. Falls back per frame to
 * the ORT still provider on any error (for the rest of the session after a 404/501). Registered at
 * priority 100 by lift() when the module is present.
 */
export declare function createNativeDepthProvider(
  o?: ProviderFactoryOptions & { fetch?: typeof fetch; loadOrt?: () => Promise<unknown>; fallback?: (o: ProviderFactoryOptions) => DepthProvider; provider?: string },
): DepthProvider & { readonly info: Record<string, unknown> };

/**
 * The `native-gaussians` lift provider: `POST displayxr-lift://lift/gaussians` → `{ sog }` or
 * `{ ply, meta }` (a `.ply` needs an `X-DXR-Lift-Meta` header). `needsDepth: false`.
 */
export declare function createNativeGaussiansLift(o?: { fetch?: typeof fetch; provider?: string }): {
  readonly id: 'native-gaussians';
  readonly needsDepth: false;
  load(): Promise<void>;
  generateLift(o: { rgb: ImageBitmap | HTMLCanvasElement | Blob; signal?: AbortSignal; onProgress?: (p: { stage: string; progress: number; elapsedS?: number }) => void }): Promise<{ sog?: Uint8Array; ply?: ArrayBuffer; meta: Record<string, unknown> }>;
  dispose(): void;
};

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
  /**
   * A **video** defaults to **`live`** (the browser converts it in place; pause never lifts — the
   * Gaussian scene is built only on an explicit Explore); a **picture** defaults to **`explore`**
   * (straight to the splat view; chip = ↓ SOG + Exit). A mode you pass is honoured (`auto` on a
   * video lifts on pause; `live` on a picture keeps the browser's in-place conversion).
   */
  mode?: 'auto' | 'live' | 'explore';
  /** Depth strength multiplier (`dxr-lift-strength`), and the explore scene's depth about its pivot. Default 1. */
  depth?: number;
  /** Zero-disparity plane for the live conversion (`dxr-lift-convergence`): normalised disparity 0..1, or `auto` (default). */
  convergence?: 'auto' | number;
  /**
   * Handed to the lift provider. `auto` (default) resolves to `medium` on a desktop with ≥ 4 GB and
   * ≥ 4 cores, `low` otherwise or on a small phone; never `high`.
   */
  quality?: 'auto' | LiftQuality;
  /** An existing `createInline3D()` manager to join. Pass it if the page already has one. */
  wall?: Inline3D;
  /** Explore orbit: cap in degrees (default 15) and whether a release springs back (default true). */
  orbit?: { maxAngleDeg?: number; relax?: boolean; gain?: number };
  /**
   * The lift stage (frozen frame → Gaussian scene). Omitted = the runtime's `native-gaussians`
   * (when its caps list `gaussians`). A registered name — `remote-sharp` is the DEMO-ONLY remote
   * SHARP provider (Apple research-licence weights; docs/lift.md § Remote SHARP) — or a
   * {@link LiftProvider} instance. There is no in-page fallback: when the runtime offers no
   * converter and no provider is given, `lift()` rejects with a {@link NativeLiftError}
   * (`code: 'unavailable'`).
   */
  providers?: { lift?: 'remote-sharp' | (string & {}) | LiftProvider };
  /** Factory options for a NAMED lift provider (`providers.lift`), e.g. remote-sharp's endpoint/auth. */
  remote?: RemoteSharpLiftOptions;
  /** Alias of `remote`. */
  remoteSharp?: RemoteSharpLiftOptions;
  /**
   * `builtin` (default): a small chip with progress and Explore / Resume / Exit. `none`: drive the
   * handle yourself. An object is the builtin chip with options:
   * - `autoHideMs` — fade the chip out after this many ms without pointer activity over the element
   *   or the chip (a move/press shows it again; keyboard focus on a chip button pins it; progress
   *   and provider notes re-show it briefly). `0` disables. Default **2500 in native mode**, 0
   *   (always visible) otherwise. Why: the DisplayXR Browser's native lift crops the element's
   *   whole on-screen rect and weaves the conversion back into it, so a chip inside that rect is
   *   converted and woven like the video (docs/lift.md § Chrome over the tile).
   */
  ui?: 'builtin' | 'none' | { autoHideMs?: number };
  /** Aborting removes the lift. */
  signal?: AbortSignal;
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
   * The browser's conversion stack (docs/lift.md § Vendor modules). `auto` (default): when
   * {@link liftCapabilities} reports `native` and the element is a `<video>`/`<img>`, the BROWSER
   * converts + weaves it in place (`dxr-lift="auto"`): no canvas, no model, no per-frame JS.
   * `false`: never. A caps object skips the query.
   */
  native?: 'auto' | boolean | LiftCapabilities;
  /** Native live: how eagerly the browser converts this element (`dxr-lift-priority`). Default `normal`. */
  priority?: LiftPriority;
  /**
   * Native: the caller OWNS the element's `dxr-lift*` attributes (`dxr-lift`, `-strength`,
   * `-convergence`, `-priority`). `remove()` / chip Exit / a fatal error then REMOVE them instead of
   * restoring their pre-lift values. Default `false` (restore: a page's own attribute survives).
   * The browser's built-in Convert-to-3D passes `true`: its context menu sets `dxr-lift="auto"`
   * before `lift()` runs, and restoring that on exit left the element converting with no handle, so
   * a second Convert double-converted.
   */
  ownLiftAttr?: boolean;
}

export interface LiftProgress {
  phase: 'lift';
  /** 0..1 within the phase. */
  value: number;
  /** A lift provider's own stage (remote SHARP: encoding | uploading | waiting | downloading). */
  stage?: string;
  /** Seconds since the provider's request started. */
  elapsedS?: number;
  provider?: string;
}

export interface LiftStats {
  state: LiftState;
  /** Frames drawn per second (the addScene callback or the 2D-fallback rAF). */
  fps: number;
  /** Load: provider resolved + media ready, ms. */
  loadMs: number;
  /** The lift provider's round trip (the runtime's native-gaussians, or a remote one), ms. */
  generateMs: number;
  /** PLY parse + GPU upload for the explore renderer, ms. */
  exploreLoadMs: number;
  /** Freeze start → explore ready (excludes the 150 ms pause debounce), ms. */
  pauseToExploreMs: number;
  /** Gaussians in the last lift. */
  splats: number;
  /** The explore comfort scale applied about the camera (1 = none). */
  exploreScale: number;
  /** `native`: the runtime's conversion stack converts live; `provider`: only a caller-supplied lift provider (explore, no live conversion). */
  mode: 'native' | 'provider';
  /** The vendor module's name (native mode), else null. */
  provider: string | null;
  /** What produced the explore scene: the lift provider's id (`native-gaussians`, `remote-sharp`), or null before the first lift. */
  liftSource: string | null;
  /** The lift provider's round trip, ms (0 without one). */
  remoteMs: number;
  /** The provider's own timings (remote SHARP: encodeMs, requestMs, downloadMs, totalMs, bytes). */
  remoteTimings: Record<string, number> | null;
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
  /** The capabilities the lift was decided on (null when not queried). */
  readonly caps: LiftCapabilities | null;
  /** Native only: the browser's coarse lift state (`waiting` = the element's 2D frame + a spinner until the converter is READY); null without a runtime converter. */
  readonly liftState: 'waiting' | 'ready' | 'unavailable' | null;
  /** Native only: the browser reports a new coarse lift state. No-op without a runtime converter. */
  setLiftState(s: 'waiting' | 'ready' | 'unavailable'): void;
  /** Native live: `dxr-lift-priority`. Returns false for an unknown value. */
  setPriority(p: LiftPriority): boolean;
  readonly priority: LiftPriority;
  /** Snapshot of timings. */
  readonly stats: LiftStats;
  on(type: 'statechange', cb: (d: { state: LiftState; from: LiftState; reason: string }) => void): () => void;
  on(type: 'progress', cb: (d: LiftProgress) => void): () => void;
  on(type: 'liftstatechange', cb: (d: { liftState: 'waiting' | 'ready' | 'unavailable' }) => void): () => void;
  on(type: 'error', cb: (d: { error: unknown; fatal: boolean; phase?: string }) => void): () => void;
  off(type: string, cb: (...a: any[]) => void): void;
  /** Freeze the current frame and lift it (a video pauses). No-op outside `live`. */
  explore(): void;
  /** Leave explore (or an in-flight lift) for the live view of the PAUSED frame, in the same tick —
   *  native: `dxr-lift="auto"` again; in-flight explore work (lift request, .sog export) is abandoned, never awaited, and its late results are dropped. It never plays the
   *  video: playback starts only on an explicit play (the page's controls, or {@link play}). */
  resume(): void;
  /** Start playback of a `<video>` (an explicit play; resolves false if refused, or for an image).
   *  Its `play` event returns to live — from explore too, instantly. */
  play(): Promise<boolean>;
  /** Explore: turn the lifted scene to (yaw, pitch) degrees, clamped to the orbit cap. */
  setOrbit(yaw: number, pitch?: number): void;
  /** Depth strength: `dxr-lift-strength` for the live conversion and, in explore, the lifted scene's depth about its pivot. */
  setDepth(x: number): void;
  setConvergence(x: 'auto' | number): void;
  /**
   * The last lifted scene as a `.sog` (SOG v2, lossless webp planes) carrying the DisplayXR camera
   * block v2 (rig `camera`, the lift's intrinsics, focus = the pivot), built in the page. Rejects
   * before the first lift. `camera` is merged onto the block. After a REMOTE lift the worker's
   * original `.sog` bytes are returned as they came (its own camera block; `camera` is ignored).
   */
  exportSog(opts?: { camera?: Record<string, unknown>; onProgress?: (p: number) => void; signal?: AbortSignal }): Promise<Blob>;
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
  quality?: 'auto' | LiftQuality;
  /** A model family or manifest name, for a registered third-party provider. */
  model?: string;
}

/** The lift stage: frozen frame → a Gaussian scene. docs/lift.md § LiftProvider. */
export interface LiftProvider {
  readonly id?: string;
  /** false: the provider takes only the frame (the runtime's, a remote one). */
  readonly needsDepth?: boolean;
  load?(o?: { signal?: AbortSignal }): Promise<unknown>;
  generateLift(o: {
    rgb: ImageBitmap | HTMLCanvasElement | Blob;
    depth?: DepthMap & { intrinsics?: { focalPx: number; focalGridW?: number } };
    quality?: LiftQuality;
    params?: Record<string, unknown>;
    signal?: AbortSignal;
    onProgress?: (p: { stage: string; progress: number; elapsedS: number; loaded?: number; total?: number }) => void;
  }): Promise<{ ply?: ArrayBuffer; sog?: ArrayBuffer; meta: LiftSceneMeta }>;
  /** Interactive sign-in, when the provider has one (call it from a click). */
  signIn?(): Promise<unknown>;
  dispose?(): void;
}

export interface LiftSceneMeta {
  /** Focal of the unprojection, px of a w × h raster (principal point at the centre). */
  focalPx: number;
  /** Pivot / convergence depth, metres along the view axis. */
  pivotZ?: number;
  w: number;
  h: number;
  layers?: number;
  splatCount?: number;
  source?: string;
  axes?: 'opencv' | 'opengl';
  /** Remote SHARP via the gallery relay: served from its cache (`X-DXR-Sharp: cache-hit`); null when unknown. */
  cacheHit?: boolean | null;
  /** The relay's own time to first byte (`X-DXR-Sharp-Ms`). */
  serverMs?: number | null;
  [k: string]: unknown;
}

export type RemoteSharpAuth = { kind: 'bearer'; token: string } | { kind: 'google'; loginUrl: string };

export interface RemoteSharpLiftOptions {
  /** Default `/api/sharp/predict` — a same-origin proxy that adds the worker token (serve.py --sharp). */
  endpoint?: string;
  /** Whole request, ms. Default 90000. */
  timeoutMs?: number;
  /** Default `mono`. */
  mode?: 'mono' | 'sbs' | 'spatial';
  /**
   * Omitted: no Authorization header (the proxy's own). `bearer`: a token the page may hold.
   * `google`: popup sign-in at `loginUrl`, answered by `postMessage({type:'dxr-auth', accessToken,
   * expiresAt})` from that origin; cached in memory until expiry; a 401 re-opens it once.
   */
  auth?: RemoteSharpAuth;
  /** Extra headers per request (merged last). */
  getAuthHeaders?: () => Record<string, string> | Promise<Record<string, string>>;
  /** Extra multipart fields. */
  fields?: Record<string, string | number>;
  /** JPEG long side cap, px. Default 1536. */
  maxSide?: number;
  /** Default 0.92. */
  jpegQuality?: number;
  /** Hard upload cap, bytes (default 4e6: Vercel rejects bodies over 4.5 MB); re-encodes smaller to fit. */
  maxBytes?: number;
}

/** A remote lift failure. `fallback` is false only for a caller abort. */
export declare class RemoteLiftError extends Error {
  readonly code: 'aborted' | 'timeout' | 'http' | 'auth' | 'forbidden' | 'quota' | 'too-large' | 'network' | 'format' | 'encode' | 'popup-blocked' | 'popup-closed';
  readonly fallback: boolean;
  readonly status?: number;
  /** 429: the relay's Retry-After, seconds. */
  readonly retryAfterS?: number;
}

/** DEMO ONLY — the remote SHARP lift provider (Apple research-licence weights; not for product use). */
export declare function createRemoteSharpLift(o?: RemoteSharpLiftOptions): LiftProvider & {
  readonly id: 'remote-sharp';
  readonly endpoint: string;
  readonly signedIn: boolean;
  /** The signed-in account (popup `email`), or null. */
  readonly email: string | null;
  signIn(): Promise<string | null>;
};

/** The popup sign-in used by `auth: { kind: 'google' }`. */
export declare function createPopupAuth(o: { loginUrl: string; win?: Window; width?: number; height?: number; timeoutMs?: number }): {
  readonly origin: string;
  readonly signedIn: boolean;
  getToken(o?: { force?: boolean }): Promise<string>;
  signIn(): Promise<string>;
  clear(): void;
};

export interface LiftRegistry {
  /** Register a lift provider. `optIn` ones are only ever picked by name. */
  registerLiftProvider(
    name: string,
    factory: (o: RemoteSharpLiftOptions & Record<string, unknown>) => LiftProvider,
    o?: { priority?: number; optIn?: boolean; available?: () => boolean },
  ): () => void;
  /** By name, or (null / `auto`) the best non-opt-in one; null = none registered. */
  getLiftProvider(name: string | null, opts?: Record<string, unknown>): LiftProvider | null;
  listLiftProviders(): Array<{ name: string; priority: number; kinds: string[] }>;
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

// ── Vendor modules (native mode) ─────────────────────────────────────────────────────────────

export type LiftPriority = 'high' | 'normal' | 'low' | 'paused';

/** What {@link liftCapabilities} reports (docs/lift.md § Vendor modules). */
export interface LiftCapabilities {
  /** The browser's conversion stack is reachable from this world and not `unavailable`. */
  native: boolean;
  /** The module's name, e.g. `neurd-directml`. */
  provider?: string;
  modes?: Array<'depth' | 'sbs' | 'nview' | 'gaussians'>;
  /** In-place conversions the module can run at once. */
  maxStreams?: number;
  approxMsPerConvert?: number;
  state?: 'ready' | 'activating' | 'unavailable';
  /**
   * The coarse state to act on: `waiting` (the runtime's converter is warming — create anyway and
   * show the 2D source), `ready`, or `unavailable` (no runtime conversion here: the element stays
   * the page's own 2D element; `lift()` rejects).
   */
  liftState?: 'waiting' | 'ready' | 'unavailable';
}

/**
 * What 2D→3D this document can do right now — cheap, async, never cached (a warming runtime
 * module changes the answer; poll at ≤ 2 Hz while `liftState` is `waiting`). `native` comes from `GET displayxr-lift://caps`, which only
 * resolves inside the DisplayXR Browser's lift world; anywhere else the fetch rejects → `native: false`.
 */
export declare function liftCapabilities(o?: {
  signal?: AbortSignal;
  /** Ignored: every call re-asks. Kept for compatibility. */
  refresh?: boolean;
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

/** A native-module failure; `unavailable` = `lift()` found no converter at all. */
export declare class NativeLiftError extends Error {
  code: 'http' | 'unsupported' | 'unavailable' | 'format' | 'encode' | 'network' | 'aborted';
  fallback: boolean;
  status?: number;
}

/**
 * The `native` DepthProvider (stills): `POST displayxr-lift://lift/depth`. Rejects with a
 * {@link NativeLiftError} on any error (no in-page fallback; after a 404/501 the module is marked
 * unsupported for the session). Registered at priority 100 by lift() when the module is present.
 */
export declare function createNativeDepthProvider(
  o?: ProviderFactoryOptions & { fetch?: typeof fetch; provider?: string },
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

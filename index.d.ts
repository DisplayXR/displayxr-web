// Type definitions for @displayxr/inline3d — the DisplayXR inline-3D SDK.
// Public 1.0 surface. See docs/sdk-stability.md for the semver contract.

/** Options shared by every add*() call. */
export interface TileOptions {
  /** Per-eye buffer resolution in px (defaults to the CSS box × devicePixelRatio, dpr capped at 2). */
  width?: number;
  /** Per-eye buffer height in px (see `width`). */
  height?: number;
  /** Round each eye's corners, in BUFFER px (CSS radii can't cross the packed side-by-side pair). */
  cornerRadius?: number;
  /** Fade each eye's outer edges to transparent over this many buffer px. */
  feather?: number;
}

/** Extra options for {@link Inline3D.addScene}. */
export interface SceneOptions extends TileOptions {
  /**
   * Metre height of the virtual display this scene is authored for (default 0.24). The runtime
   * scales the eye poses it reports so the z=0 plane spans a display this tall — author in metres
   * and render the reported views as-is. Halving it doubles how much of the window an object fills.
   */
  virtualDisplayHeight?: number;
  /** Element whose visibility drives the lazy create/close lifecycle (defaults to the canvas). */
  observe?: Element;
}

/** The per-frame render callback passed to {@link Inline3D.addScene}. */
export type SceneFrameCallback = (
  views: readonly XRView[],
  layer: XRDisplayLayer,
  frame: XRFrame,
) => void;

/** The handle returned by every add*() call. */
export interface TileHandle {
  /** Remove this window: close its weave layer and stop driving it. */
  remove(): void;
  /**
   * Mark a 2D element painted OVER this window so the weave leaves it crisp 2D instead of
   * garbling it (browser#18). No-op on browsers without overlay exclusion.
   */
  exclude(el: Element): void;
  /** Stop excluding `el` from this window's weave. */
  unexclude(el: Element): void;
}

/** An open inline-3D session you add weaved windows to. Returned by {@link createInline3D}. */
export interface Inline3D {
  readonly supported: true;
  /** The underlying WebXR session. */
  readonly session: XRSession;
  /** The reference space the eye poses are reported in (may be null if none could be acquired). */
  readonly refSpace: XRReferenceSpace | null;
  /** Number of currently-active (weaving) windows. */
  readonly liveCount: number;

  /** Weave a still side-by-side 3D photo from a URL or decoded image source. */
  addImage(
    canvas: HTMLCanvasElement,
    source: string | HTMLImageElement | ImageBitmap | HTMLCanvasElement,
    opts?: TileOptions,
  ): TileHandle;

  /** Weave a side-by-side 3D video element (re-drawn each decoded frame). */
  addVideo(
    canvas: HTMLCanvasElement,
    video: HTMLVideoElement,
    opts?: TileOptions,
  ): TileHandle;

  /**
   * Weave a live-rendered stereo scene. Your callback receives the two eye views + the layer;
   * render each `layer.getViewport(view)` into the canvas's SBS backing (three.js: see the
   * `@displayxr/inline3d/three` helpers).
   */
  addScene(
    canvas: HTMLCanvasElement,
    onFrame: SceneFrameCallback,
    opts?: SceneOptions,
  ): TileHandle;

  /**
   * Register a PAGE-GLOBAL 2D overlay (a fixed/sticky header, a floating toolbar) excluded from
   * EVERY window's weave and re-applied when a window lazily re-activates. Register once instead
   * of calling {@link TileHandle.exclude} per tile. No-op without overlay exclusion (browser#18).
   */
  addGlobalOverlay(el: Element): void;
  /** Stop treating `el` as a page-global overlay and drop it from every live window. */
  removeGlobalOverlay(el: Element): void;

  /** Close the session and remove every window. */
  close(): void;
}

/** The shape {@link createInline3D} resolves to when inline-3D is unavailable. */
export interface Inline3DUnsupported {
  supported: false;
  error?: unknown;
}

/** Options for {@link createInline3D}. */
export interface CreateInline3DOptions {
  /** WebXR reference space for the eye poses (default `"viewer"`). */
  referenceSpace?: string;
  /**
   * Create each window's weave layer only while it is (near-)visible and close it when it scrolls
   * away, so a long wall only pays for what's on screen (default `true`). Set `false` for a single
   * always-on element.
   */
  lazy?: boolean;
  /** IntersectionObserver margin for lazy mode (default `"50% 0px"`). */
  rootMargin?: string;
}

/** The return of {@link startInline3D}. */
export interface StartInline3DResult {
  supported: boolean;
  /** The manager (present when supported). */
  wall?: Inline3D;
  /** The underlying WebXR session (present when supported). */
  session?: XRSession;
  /** Close the session (present when supported). */
  close?: () => void;
  error?: unknown;
}

/**
 * Cheap, synchronous "can this browser even attempt inline-3D?" gate — true only in the DisplayXR
 * Browser with the feature enabled. Use it to decide page UI up front.
 */
export function inline3DAvailable(): boolean;

/**
 * True when this browser supports 2D-overlay exclusion (browser#18) — putting a 2D element ON a
 * woven tile so it composites as crisp 2D over the woven 3D. Implies {@link inline3DAvailable}.
 * Sync + cheap.
 */
export function inline3dOverlaySupported(): boolean;

/** Open the page's inline-3D session and return a manager you add windows to. */
export function createInline3D(
  opts?: CreateInline3DOptions,
): Promise<Inline3D | Inline3DUnsupported>;

/**
 * Back-compatible single-scene helper: open a session, weave one canvas, drive a render callback
 * each frame. Equivalent to `createInline3D({lazy:false})` then `addScene(canvas, onFrame)`.
 */
export function startInline3D(
  canvas: HTMLCanvasElement,
  opts?: {
    onFrame?: SceneFrameCallback;
    referenceSpace?: string;
    virtualDisplayHeight?: number;
  },
): Promise<StartInline3DResult>;

// XRDisplayLayer is a DisplayXR-Browser extension to WebXR; declare the minimum the SDK exposes.
export interface XRDisplayLayer {
  getViewport(view: XRView): { x: number; y: number; width: number; height: number } | null;
  excludeElement?(el: Element): void;
  close(): void;
}

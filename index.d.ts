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

/**
 * A view-rig descriptor — what the runtime locates the eye views against. Two rigs, one shape:
 *
 * - **`"display"`** — the canvas is a PORTAL. Its plane is world `z = 0` and the viewer looks
 *   through it at a virtual display `virtualDisplayHeight` tall. This is the default rig and
 *   what `SceneOptions.virtualDisplayHeight` is shorthand for (identity pose, all factors 1).
 * - **`"camera"`** — an APP CAMERA whose frustum eye tracking perturbs. The runtime keeps your
 *   `verticalFov`, offsets the eyes, and skews each frustum so `convergenceDiopters` lands on
 *   the zero-disparity plane.
 *
 * Every field is optional; the runtime **clamps** an out-of-range value (once, with a warning)
 * rather than rejecting the rig. A descriptor applies per-locate, so animating one means sending
 * new values each frame — see {@link TileHandle.setViewRig} for the one-frame latency that
 * implies. Build one with `cameraRigFromCamera` / `displayRig` from
 * `@displayxr/inline3d/three`, or by hand.
 */
export interface XRViewRigInit {
  /** `"display"` (portal) or `"camera"` (app camera). */
  type?: 'display' | 'camera';
  /** Rig pose in the app's world units (default 0,0,0). */
  position?: DOMPointInit;
  /** Rig orientation as a quaternion (default identity). */
  orientation?: DOMPointInit;
  /** **Display rig.** Metres of virtual display; `m2v = this / the element's physical height`. */
  virtualDisplayHeight?: number;
  /** Eye separation — display rig: relative `[0,1]`; camera rig: absolute `>= 0`. */
  ipdFactor?: number;
  /** Head-tracking response — display rig: `[0,1]`; camera rig: absolute `>= 0`. */
  parallaxFactor?: number;
  /** **Display rig only**, `[0.1,10]`: exaggerates or flattens the off-axis skew. */
  perspectiveFactor?: number;
  /** **Camera rig.** `1 / (convergence distance in world units)`; `0` = infinity. */
  convergenceDiopters?: number;
  /** **Camera rig.** The FULL vertical angle, in RADIANS (three's `camera.fov` is degrees). */
  verticalFov?: number;
  /** **Camera rig.** Metres → world units on the eye; `0`/unset means 1. */
  metersToVirtual?: number;
}

/** Extra options for {@link Inline3D.addScene}. */
export interface SceneOptions extends TileOptions {
  /**
   * Metre height of the virtual display this scene is authored for (default 0.24). The runtime
   * scales the eye poses it reports so the z=0 plane spans a display this tall — author in metres
   * and render the reported views as-is. Halving it doubles how much of the window an object fills.
   */
  virtualDisplayHeight?: number;
  /**
   * A full {@link XRViewRigInit} instead of the scalar height — a posed display rig, or a camera
   * rig. **Supersedes `virtualDisplayHeight`** (which is one particular display rig); passing
   * both warns once and the rig wins **where rigs are supported** — which is the one reason to
   * pass the pair deliberately, since a browser without {@link inline3dViewRigSupported} then
   * falls back to the height you named rather than to its own default. The window weaves either
   * way. Replaceable per frame with {@link TileHandle.setViewRig}.
   */
  viewRig?: XRViewRigInit;
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
   *
   * @deprecated Legacy-browser mechanism. A browser with draw-order occlusion
   * ({@link inline3dOcclusionByDrawOrder}) composites 2D over woven 3D per-pixel with nothing
   * declared, so the call is accepted and ignored there — harmless everywhere, and still
   * needed on older DisplayXR Browsers. Keep it unless you ship to Phase-2 browsers only.
   */
  exclude(el: Element): void;
  /**
   * Stop excluding `el` from this window's weave.
   *
   * @deprecated See {@link TileHandle.exclude} — no-op on browsers with draw-order occlusion.
   */
  unexclude(el: Element): void;
  /**
   * Replace this window's view rig. Cheap enough to call every frame — a rig applies per-locate,
   * so animating one means sending new values, not tweening anything.
   *
   * Returns whether the rig reached a **live** layer. `false` means it was stored and will build
   * the next one (a window scrolled away in lazy mode), or that the browser has no rig support
   * ({@link inline3dViewRigSupported}) — in which case it warns once and the window keeps
   * weaving on the runtime's default display rig.
   *
   * **One frame of lag, by construction.** The browser locates views *before* the page's rAF, so
   * a rig set during frame N drives the views delivered in frame N+1. Invisible for a slider or
   * a settled camera; not for a camera that moves with the pointer — for that, send an
   * identity-posed camera rig and parent your eye cameras under the app camera
   * (`cameraRigFromCamera(THREE, cam, { attach: true })` + `EyeCamera.setLocalFromView`), so the
   * scene graph supplies this frame's world pose with no lag at all.
   */
  setViewRig(rig: XRViewRigInit): boolean;
  /**
   * Per-window frame counters, for diagnosing the load-induced mono fallback.
   *
   * `frames` counts `onFrame` deliveries; `monoFrames` counts the ones that carried fewer than
   * two views — a session under GPU pressure reporting a single view where it normally reports
   * two. `./viewer` replays its last good stereo frame for those rather than clearing (web#12);
   * a rising ratio is the machine telling you the session is falling back, and is worth
   * surfacing before it turns into a bug report about "blinking".
   *
   * Scene windows only — image/video windows always report `{ frames: 0, monoFrames: 0 }`.
   */
  stats(): { frames: number; monoFrames: number };
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
   *
   * @deprecated Legacy-browser mechanism. Where {@link inline3dOcclusionByDrawOrder} is true,
   * page chrome occludes every tile by itself: the element is stored and nothing is done to it
   * (no `will-change` promotion). Harmless everywhere; still required on older browsers.
   */
  addGlobalOverlay(el: Element): void;
  /**
   * Stop treating `el` as a page-global overlay and drop it from every live window.
   *
   * @deprecated See {@link Inline3D.addGlobalOverlay} — no-op with draw-order occlusion.
   */
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
  /**
   * Auto-exclude page chrome (default `true`): sticky/fixed elements near the top of
   * the DOM (headers, toolbars) are registered as page-global overlays automatically —
   * the bar plus its text/replaced descendants — so woven windows scroll UNDER the
   * chrome with no per-app wiring. Opt an element (and its subtree) out with
   * `data-inline3d-no-overlay`; set `false` to manage chrome exclusively via
   * `addGlobalOverlay()` / `data-inline3d-overlay`.
   *
   * Ignored where {@link inline3dOcclusionByDrawOrder} is true: nothing is scanned and the
   * SDK never touches your DOM's `will-change`, because the chrome already occludes the tiles.
   */
  autoChrome?: boolean;
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
 * True when a 2D element painted ON a woven tile composites as crisp 2D over the woven 3D
 * instead of being woven — by declaration (browser#18 overlay exclusion) or automatically
 * ({@link inline3dOcclusionByDrawOrder}). Same answer on both generations, so it stays true on
 * a draw-order-occlusion browser. Implies {@link inline3DAvailable}. Sync + cheap.
 */
export function inline3dOverlaySupported(): boolean;

/**
 * True when the browser occludes woven tiles with 2D content AUTOMATICALLY — anything that
 * paints over a tile (header, badge, dropdown, translucent scrim) composites per-pixel by draw
 * order, with nothing declared. When true this SDK's exclusion machinery is off: `autoChrome`
 * does not scan, `data-inline3d-overlay` is not watched, and {@link TileHandle.exclude} /
 * {@link Inline3D.addGlobalOverlay} are accepted but do nothing (no `will-change` promotion).
 *
 * You do not have to branch on it — the legacy calls are harmless where it is true and still
 * required where it is false. Branch only to skip work of your own. Reads a readonly capability
 * flag on `XRDisplayLayer`, never a version or UA string, and is `false` on any browser that
 * does not expose the flag (the safe answer: the legacy path runs).
 */
export function inline3dOcclusionByDrawOrder(): boolean;

/**
 * True when this browser accepts a full {@link XRViewRigInit} — {@link TileHandle.setViewRig} and
 * {@link SceneOptions.viewRig}, i.e. a posed display rig or a camera rig, instead of only the
 * scalar `virtualDisplayHeight`. Sync + cheap; implies {@link inline3DAvailable}.
 *
 * Reads a capability (the presence of `XRDisplayLayer.setViewRig`), never a version or UA string,
 * and is `false` on every browser that predates the rig API — where `virtualDisplayHeight` still
 * works. Branch on it only if a camera rig is load-bearing for your page: `setViewRig` no-ops
 * (warning once) rather than throwing, so a page that merely wants the extra control where it
 * exists can call it unconditionally.
 */
export function inline3dViewRigSupported(): boolean;

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
  /**
   * @deprecated Legacy-browser overlay exclusion (browser#18). Present-but-no-op on a browser
   * with draw-order occlusion, which is exactly why its presence cannot be used to detect the
   * generation — use {@link inline3dOcclusionByDrawOrder} (i.e. `occlusionByDrawOrder`).
   */
  excludeElement?(el: Element): void;
  /** @deprecated See {@link XRDisplayLayer.excludeElement}. */
  unexcludeElement?(el: Element): void;
  /**
   * Readonly capability flag: `true` when this browser composites 2D over woven 3D per-pixel by
   * draw order, making overlay exclusion unnecessary. Optional because it is absent on every
   * browser shipped so far — the SDK treats absent as `false` and runs the legacy path.
   */
  readonly occlusionByDrawOrder?: boolean;
  /**
   * Replace the rig the runtime locates this layer's views against. Optional because it is
   * absent on browsers that predate the rig API — its PRESENCE on the prototype is the
   * capability signal ({@link inline3dViewRigSupported}), which is why the browser exposes it as
   * a method: a Blink IDL attribute getter throws `Illegal invocation` when read off a prototype
   * (see {@link XRDisplayLayer.occlusionByDrawOrder}), so an attribute could not be probed at
   * all on the browser that has it.
   */
  setViewRig?(rig: XRViewRigInit): void;
  close(): void;
}

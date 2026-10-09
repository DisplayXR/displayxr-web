// Type definitions for @displayxr/inline3d — the DisplayXR inline-3D SDK.
// Public 1.0 surface. See docs/sdk-stability.md for the semver contract.

/** Options shared by every add*() call. */
export interface TileOptions {
  /**
   * Per-eye buffer resolution in px (defaults to the CSS box × devicePixelRatio, dpr capped at 2).
   * `addImage` / `addVideo` clamp the store to the device's GL limits — 2 × width and the height
   * within min(MAX_TEXTURE_SIZE, MAX_RENDERBUFFER_SIZE, MAX_VIEWPORT_DIMS), both axes by one
   * factor, warned once — explicit sizes included. An `addScene` canvas is the page's to size;
   * the SDK warns once if the browser clamped its drawing buffer below `canvas.width/height`.
   */
  width?: number;
  /** Per-eye buffer height in px (see `width`). */
  height?: number;
  /** Round each eye's corners, in BUFFER px (CSS radii can't cross the packed side-by-side pair). */
  cornerRadius?: number;
  /** Fade each eye's outer edges to transparent over this many buffer px. */
  feather?: number;
  /**
   * How long, in ms, this window's layer must have existed (and carried a stereo frame) before
   * {@link TileHandle.firstWoven} resolves `woven: true`. Default 1200 — the browser's measured
   * worst case for joining a canvas that is fresh to its compositor. Lower it only for a canvas
   * you know is not fresh; 0 means "the first stereo frame".
   */
  firstWovenHoldMs?: number;
  /**
   * Cover this canvas across a rect change, owned by the SDK. Default `'off'` on `addImage` /
   * `addVideo` / `addScene` (frozen defaults); `'auto'` on `./splat` and `./model`.
   *
   * Once the window has woven, a change of the canvas's CSS size, devicePixelRatio or PAGE position
   * (scrolling the document is not a move) raises a sibling element over the canvas on the frame
   * the change is seen, and cuts it when {@link TileHandle.rewoven} settles; a further change
   * while it is up restarts the wait. The cover is a 2D canvas, never a second woven canvas,
   * placed as the canvas's next sibling (`pointer-events: none`, `data-inline3d-cover`). It is
   * filled with `color` and, with `snapshot`, the last frame: the left eye, cover-fit to the new
   * box, captured once at the change with one `drawImage` (never `toDataURL`).
   *
   * - `'auto'` — `{ color: '#000', snapshot: true }`.
   * - `'off'` — nothing; a page that runs its own cover passes this.
   * - `{ color?, snapshot? }` — `color` any CSS color (default `'#000'`); `snapshot` default true.
   *
   * Before the first join nothing is raised: cover a fresh canvas yourself until `firstWoven`
   * (rule 5). A pure move is seen at the next session frame, so a move made after that frame's
   * callback can show for one frame.
   */
  rectCover?: RectCoverOption;
}

/** See {@link TileOptions.rectCover}. */
export type RectCoverOption = 'auto' | 'off' | { color?: string; snapshot?: boolean };

/**
 * The browser's per-frame report for one layer (`XRDisplayLayer.wovenState`, DisplayXR Browser
 * builds that carry it; absent elsewhere). A level, never latched.
 *
 * - `'pending'` — no presented frame has reported this layer yet (from construction, again after
 *   close(), and whenever the frame's reply does not list it).
 * - `'woven'` — the latest swapped frame put this layer's rect into the weave.
 * - `'withheld'` — it did not; {@link WovenWithheldReason} says why.
 */
export type WovenState = 'pending' | 'woven' | 'withheld';

/**
 * Why a layer reads `'withheld'` (`XRDisplayLayer.withheldReason`). The same tokens the browser
 * logs; what each means and whose fix it is: `docs/woven-canvas-rules.md` §3. A future browser may
 * add tokens, so treat an unknown string as "withheld, reason not listed".
 */
export type WovenWithheldReason =
  | 'no-quad'
  | 'no-identity'
  | 'no-join'
  | 'cross-pass:mono'
  | 'cross-pass:mono(cover,2:1)'
  | 'resolve-dropped'
  | (string & {});

/**
 * What {@link TileHandle.firstWoven} resolves to. Settles once and never rejects.
 *
 * - `woven: true, reason: 'woven'` (`confirmed: true`) — the BROWSER reported the layer woven
 *   (`XRDisplayLayer.wovenState`), after a stereo frame was drawn. No hold. Drop the poster.
 * - `woven: true, reason: 'hold-elapsed'` (`confirmed: false`) — a browser without that report:
 *   a stereo frame is on a layer that has existed for `firstWovenHoldMs`. Drop the poster.
 * - `woven: true, reason: 'hold-capped'` — `rewoven()`: the canvas kept resizing or moving, so
 *   it stopped waiting four holds after the call; with the report, also a 'woven' read that never
 *   qualified (see {@link TileHandle.rewoven}). Drop the cover; the rect may still be settling.
 * - `woven: false, confirmed: true`, `reason` a {@link WovenWithheldReason} or `'pending'` — the
 *   browser kept reporting the layer withheld (or never listed it) for the whole cap: four holds,
 *   at least 4.8 s. A safety release, not a loss: the canvas is NOT taken flat and `rewoven()`
 *   keeps working. Drop the cover; what shows is what the browser draws for that reason
 *   (`cross-pass:mono` is flat in place; `no-identity` can be the raw pair).
 * - `woven: false, confirmed: false` — the window will not weave (`'layer-failed'`,
 *   `'session-ended'`, `'removed'`; the subpaths add `'unsupported'`). The canvas is already flat
 *   (image/video) or its `onLayerLost` has run (scene). Drop the poster onto the 2D fallback.
 */
export interface FirstWovenResult {
  readonly woven: boolean;
  /**
   * `true` only when the BROWSER reported the state (`XRDisplayLayer.wovenState`). `false` on a
   * browser without that report: the result is then the SDK's worst-case hold.
   */
  readonly confirmed: boolean;
  readonly reason:
    | 'woven'
    | 'hold-elapsed'
    | 'hold-capped'
    | 'layer-failed'
    | 'session-ended'
    | 'removed'
    | 'unsupported'
    | 'pending'
    | WovenWithheldReason;
  /** Milliseconds from the add*() call to settling. */
  readonly ms: number;
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

/**
 * The panel's hardware display state, as reported by `hardwaredisplaystatechange`.
 *
 * There is no page-facing request for it: it is a CONSEQUENCE of the active rendering mode —
 * a `viewCount === 1` mode puts the panel flat, the 2-view mode puts it back.
 */
export type XRHardwareDisplayMode = '2d' | '3d';

/**
 * What the glasses-free display physically is. Resolved by {@link TileHandle.getDisplayInfo};
 * `null` there means the machine has no such display.
 *
 * `recommendedViewScaleX/Y` are **advisory**. The browser cannot resize a page's canvas, so
 * nothing applies them for you — a page honours them by sizing its own backing store. Ignoring
 * them costs sharpness or fill rate, never correctness.
 */
export interface XRDisplayInfo {
  displayWidthMeters: number;
  displayHeightMeters: number;
  displayPixelWidth: number;
  displayPixelHeight: number;
  recommendedViewScaleX: number;
  recommendedViewScaleY: number;
  /**
   * The runtime's NOMINAL viewer position, metres, in display space: origin at the panel
   * centre, +x right, +y up, +z out of the glass toward the viewer (w = 1). A constant of the
   * panel — where the runtime seats the viewer when nobody is tracked, and the distance its
   * camera rig is calibrated to (`z` is that rig's n) — NOT the live eye position.
   *
   * Absent on browsers that predate it (DisplayXR Browser patch 0221) and when the runtime
   * reports nothing usable, so read it as `info.nominalViewerPosition?.z ?? fallback`.
   */
  nominalViewerPosition?: DOMPointReadOnly;
}

/** {@link TileHandle.displayMetrics}: a window in physical units. Metres throughout. */
export interface DisplayMetrics {
  /** The canvas's CSS box on the panel, [width, height]. */
  canvasSizeM: [number, number];
  /** One CSS px on the panel (physical pixel pitch × devicePixelRatio). */
  metersPerCssPx: number;
  displaySizeM: [number, number];
  /** `nominalViewerPosition.z`, else the default. */
  nominalViewerM: number;
  /** Always the default today: no browser or runtime surface reports one. */
  eyeSeparationM: number;
  source: { size: 'display' | 'default'; viewer: 'display' | 'default'; eyeSeparation: 'default' };
}

/** What {@link TileHandle.displayMetrics} fills in when the display cannot say. */
export const DISPLAY_METRICS_DEFAULTS: Readonly<{
  displaySizeM: readonly [number, number];
  displayPixels: readonly [number, number];
  nominalViewerM: number;
  eyeSeparationM: number;
}>;

/** {@link TileHandle.displayMetrics} as a pure function of an XRDisplayInfo, a client rect and devicePixelRatio. */
export function displayMetricsFrom(
  info: XRDisplayInfo | null,
  rect: { width: number; height: number } | null,
  dpr?: number,
): DisplayMetrics;

/**
 * One rendering mode the DISPLAY can be put in, as reported by the runtime.
 *
 * The list is the display's, not the browser's. The DisplayXR Browser renders exactly **two**
 * views — no view synthesis exists anywhere in the stack — so a mode needing MORE than two is
 * reported with `isRequestable: false` and {@link TileHandle.requestRenderingMode} refuses it.
 * Show such rows (they are what the panel can do) but mark them unavailable. A `viewCount === 1`
 * mode IS requestable: the browser still submits two views and the runtime still weaves them —
 * it is the PANEL that goes flat, which is how a page reaches the 2D hardware state.
 */
export interface XRDisplayRenderingMode {
  modeIndex: number;
  name: string;
  /** @deprecated the browser reports `name`; kept for pages written against the earlier build. */
  modeName?: string;
  viewCount: number;
  /** Per-view render scale the runtime recommends for this mode — advisory, like the display's. */
  viewScaleX: number;
  viewScaleY: number;
  tileColumns: number;
  tileRows: number;
  viewWidthPixels: number;
  viewHeightPixels: number;
  /** True for a glasses-free 3D mode; false for a flat one. */
  hardwareDisplay3D: boolean;
  isActive: boolean;
  /** False when the browser cannot drive it — in practice, `viewCount > 2`. */
  isRequestable: boolean;
}

/** A rendering mode went active. Re-emitted on the wall and on every tile handle. */
export interface RenderingModeChange {
  type: 'renderingmodechange';
  /** The mode now active, or -1 if the browser named none and the list could not be read. */
  modeIndex: number;
  /** Its view count — the thing the automatic rig collapse turns on. Null if unknown. */
  viewCount: number | null;
  /** The full mode row, when it could be read back. */
  mode: XRDisplayRenderingMode | null;
  /** The browser's own event payload, unreshaped. */
  detail: unknown;
}

/** The panel's hardware display state changed. */
export interface HardwareDisplayStateChange {
  type: 'hardwaredisplaystatechange';
  state: XRHardwareDisplayMode | null;
  detail: unknown;
}

export type DisplayModeChange = RenderingModeChange | HardwareDisplayStateChange;

/**
 * Is anyone being tracked in front of the display? From the DisplayXR runtime (which may hand the
 * decision to the vendor plug-in), via the browser's `session.trackingState` (patch 0195).
 *
 * - `'tracking'` — a viewer is in the display's 3D zone.
 * - `'searching'` — the runtime's derived isTracking is FALSE: nobody is in the zone, **or** the
 *   display is in an untracked / 2D mode. It does **not** necessarily mean the tracker lost lock
 *   on a viewer who is still there, so do not word a page's UI as if it did.
 * - `'unknown'` — no opinion: this browser has no tracking-state surface, or the session ended.
 */
export type XRTrackingState = 'unknown' | 'tracking' | 'searching';

/** The tracking state changed. The callback is handed the STATE first, this object second. */
export interface TrackingStateChange {
  type: 'trackingstatechange';
  state: XRTrackingState;
}

/** What a page may lift into the floating native viewer. `null` = no `XRDisplayLayer.undock`. */
export interface UndockCapabilities {
  model: boolean;
  splat: boolean;
}

export interface UndockOptions {
  /** Absolute https URL (or http on loopback) of the asset the NATIVE viewer loads. */
  src: string;
  type: 'model' | 'splat';
  /** Lighting the page rendered with, so the viewer can match it. */
  env?: 'room' | 'studio' | 'sky' | 'none';
  /** The angle the page opened the asset at, so the undocked view opens at the same one. */
  pose?: { yaw: number; pitch?: number; zoom?: number };
  /** The page's fit margin, when it overrides the default. */
  margin?: number;
  title?: string;
}

export interface UndockHandle {
  /**
   * Resolves when the viewer exits. On the protocol FALLBACK it resolves immediately and
   * `detached` is true — a protocol launch is fire-and-forget and the page never hears back.
   */
  ended: Promise<void>;
  viewer: 'model' | 'splat';
  detached: boolean;
  /** The `displayxr-view:` URL, on the fallback path only. */
  url?: string;
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
  /**
   * Called once when this window's weave layer goes away for good — the session ended, or the
   * layer could not be created. You own a scene canvas's pixels, so this is the SDK's only way
   * to tell you that the side-by-side pair in it is no longer being woven and is now just
   * squeezed 2D on the page: take the canvas flat here (`SceneViewer.startMono`, or your own
   * mono path). NOT called when a lazy tile merely scrolls off screen — that layer is coming
   * back. A throw is caught and warned about.
   */
  /**
   * This caller sizes the canvas within the device's GL limits itself, so the core must not
   * inspect its drawing buffer. With it the core never calls `getContext()` on the canvas, which
   * matters for an engine that creates its context AFTER `addScene` (asynchronously): a core
   * `getContext()` would create it first, with the default attributes. The SDK's own renderers
   * pass it. Default false.
   */
  bufferClamped?: boolean;
  onLayerLost?: () => void;
  /**
   * Called INSIDE the ResizeObserver callback when the canvas's CSS box or devicePixelRatio
   * changes — after the frame's animation callbacks, before its paint. Resize your backing store
   * and draw one frame here (replay your last views) and the old store is never shown stretched
   * onto the new box, which is what waiting for the next frame shows. Called only on a real
   * change, never re-entrantly; a throw is caught and warned about once. Default: none, and then
   * no observer is attached to a scene canvas (unchanged).
   */
  onResize?: (box: { width: number; height: number; dpr: number }) => void;
}

/** The per-frame render callback passed to {@link Inline3D.addScene}. */
export type SceneFrameCallback = (
  views: readonly XRView[],
  layer: XRDisplayLayer,
  frame: XRFrame,
) => void;

/**
 * The handle returned by every add*() call.
 *
 * An add*() on a canvas that is still registered (not `remove()`d) on the same manager warns once
 * per canvas (1.38) and then proceeds as it always has: the layer is closed and rebuilt (a fresh
 * identity gap), or a subpath puts a second renderer on the context, and the call returns its own
 * new handle. Change what is in the canvas instead, or `remove()` first.
 */
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
   *
   * While a `viewCount === 1` mode is active the rig is stored **as given** and pushed **flat**
   * (a copy with `ipdFactor`/`parallaxFactor` at 0), so a page driving a rig every frame cannot
   * walk out of 2D, and the 2-view mode going active restores exactly this rig.
   */
  setViewRig(rig: XRViewRigInit): boolean;
  /**
   * The panel this window weaves on, or `null` where there is no glasses-free display.
   *
   * `null` is returned only once the layer has answered for real or the cap has passed, never for
   * "not ready yet". Called before this window's layer has delivered its first frame (right after
   * `add*()`, the natural place), the call waits for the release signal — where the browser
   * reports {@link TileHandle.wovenState}, the first `'woven'` read (a `'withheld'` read right
   * after the layer is built does not count: it comes before the weave session can answer);
   * elsewhere, the layer's first stereo frame; no first-woven hold — and asks then. If the layer
   * still answers `null` before the cap, that answer is not returned: the call is asked again on
   * each later release signal (the next `'woven'` read, or the next session frame once a stereo
   * frame has been drawn) and resolves with the first non-`null` answer. Once a read on this layer
   * has answered for real, later calls go straight to the layer. The cap is the first-woven cap
   * (four holds from the layer's construction, never under 4.8 s): past it the layer's `null` is
   * returned as a real absence. Without a live layer it settles at once, as below.
   *
   * Rejects with an `Error` on a browser without the display-mode API
   * ({@link inline3dDisplayModesSupported}) or while this window has no live layer (lazy mode,
   * tile off screen).
   */
  getDisplayInfo(): Promise<XRDisplayInfo | null>;
  /**
   * This window in physical units — canvas size in metres, metres per CSS px, the panel, the
   * nominal viewer distance, the eye separation — from {@link getDisplayInfo}, with anything not
   * measurable filled from {@link DISPLAY_METRICS_DEFAULTS} and flagged in `source`. Never rejects.
   * The canvas size is read at the call: call again after a resize.
   */
  displayMetrics(): Promise<DisplayMetrics>;
  /**
   * Every rendering mode the display can be put in. See {@link XRDisplayRenderingMode}.
   *
   * An empty list is returned only once the cap has passed, never for "not ready yet": like
   * {@link getDisplayInfo}, a call made before this window's layer has delivered its first frame
   * waits for the same release signal, an empty answer before the cap is asked again on the next
   * one, and the cap is the same. Rejects as {@link getDisplayInfo} does.
   */
  getRenderingModes(): Promise<ReadonlyArray<XRDisplayRenderingMode>>;
  /**
   * Ask the runtime to switch the display to `modeIndex`. A thin pass-through — it resolves and
   * rejects exactly as the browser does.
   *
   * Rejects with a `TypeError` for a mode whose `viewCount > 2` (the browser is fixed at two
   * views) or an unknown index — the browser raises those synchronously, and this pass-through
   * turns them into rejections so one `.catch()` covers every failure — and with a
   * `NotSupportedError` `DOMException` when the request was not forwardable. Success is signalled
   * by the session's `renderingmodechange` event, not by this promise.
   *
   * A `viewCount === 1` mode is requestable and is how a page goes flat.
   *
   * Made before this window's layer has delivered its first frame, the request waits for it (the
   * same release signal and cap as {@link getDisplayInfo}; forwarded once, not retried): before
   * then the browser has no weave session to forward it to.
   *
   * With the eased transition on (the default — see {@link ModeSwitchOptions}) a going-flat
   * request is HELD while the disparity ramps out, so the promise resolves when the request has
   * been forwarded rather than on the call; a request dropped by a reversal in that window
   * rejects with an `Error` named `superseded`.
   */
  requestRenderingMode(modeIndex: number): Promise<void>;
  /**
   * SUGAR over {@link TileHandle.requestRenderingMode}: `false` requests the first mode with
   * `viewCount === 1 && isRequestable`, `true` the first with `viewCount === 2 && isRequestable`.
   * It never touches the hardware display state directly (there is no such call) and never
   * touches your rig.
   *
   * **The rig collapse is not part of this call.** When a 1-view mode actually goes ACTIVE the
   * SDK zeroes every window's `ipdFactor`/`parallaxFactor` on the way to the layer and restores
   * them when a 2-view mode does — driven by `renderingmodechange`, so it happens however the
   * mode changed, and a **refused request changes nothing in either direction**. The flattening
   * is a copy pushed at the layer, never a write into your descriptor, so the restore is literally
   * the rig you last set — and it survives a per-frame `setViewRig` loop, a lazy tile rebuilding
   * its layer, and a window that never set a rig at all.
   *
   * Rejects with an `Error` when no such mode is listed, otherwise as `requestRenderingMode` does.
   */
  setStereoEnabled(enabled: boolean): Promise<boolean>;
  /** Listen for one display event, re-emitted on this handle. Returns an unsubscribe function. */
  on(type: 'renderingmodechange', cb: (e: RenderingModeChange) => void): () => void;
  on(type: 'hardwaredisplaystatechange', cb: (e: HardwareDisplayStateChange) => void): () => void;
  /**
   * Nobody-is-tracked changes, with the STATE as the first argument. The same subscription as the
   * manager's; silent forever on a browser without the surface. See {@link Inline3D.trackingState}.
   */
  on(type: 'trackingstatechange', cb: (state: XRTrackingState, e: TrackingStateChange) => void): () => void;
  /** Drop a listener registered with {@link TileHandle.on}. */
  off(type: 'renderingmodechange', cb: (e: RenderingModeChange) => void): void;
  off(type: 'hardwaredisplaystatechange', cb: (e: HardwareDisplayStateChange) => void): void;
  off(type: 'trackingstatechange', cb: (state: XRTrackingState, e: TrackingStateChange) => void): void;
  /** The manager's {@link Inline3D.trackingState}, read live. */
  readonly trackingState: XRTrackingState;
  /**
   * Both display events through one callback — the older shape, still supported. Returns an
   * unsubscribe function; inert (a no-op unsubscribe) on a browser without the API.
   */
  onDisplayModeChange(cb: (e: DisplayModeChange) => void): () => void;
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
  /**
   * The browser's report for this window's layer, read live ({@link WovenState}); `'pending'`
   * while the window has no live layer; `null` on a browser that does not report it (the
   * attribute is absent on mac, Linux, Android and Windows builds without it). Diagnostics:
   * `firstWoven` / `rewoven()` already settle on it.
   */
  readonly wovenState: WovenState | null;
  /** The why-token while {@link TileHandle.wovenState} is `'withheld'`, else `null`. */
  readonly withheldReason: WovenWithheldReason | null;
  /**
   * Resolves once, when it is safe to reveal this canvas: see {@link FirstWovenResult}. THE way to
   * release a poster held over a woven canvas — `await Promise.all([ready, handle.firstWoven])`
   * and cut, never fade. On a browser that reports `wovenState` it settles on that report
   * (`confirmed: true`, no hold); elsewhere it is the worst-case hold (`confirmed: false`).
   */
  readonly firstWoven: Promise<FirstWovenResult>;
  /** Callback form of {@link TileHandle.firstWoven}: called once, asynchronously. Returns an unsubscribe. */
  onFirstWoven(cb: (result: FirstWovenResult) => void): () => void;
  /**
   * {@link TileHandle.firstWoven}, measured from NOW. Cover an already-woven canvas across a rect
   * change (fullscreen, a layout resize, a move), then release on this ({@link TileOptions.rectCover}
   * does both for you). A change of the canvas's CSS size, devicePixelRatio or page position (since
   * 1.38; document scroll excluded) while pending restarts the hold (checked every frame, any
   * window kind). It settles anyway, `woven: true, reason:
   * 'hold-capped'`, four holds after the call, so a size that never stops animating cannot hold a
   * cover up for good. A second call while pending returns the same promise, restarted. Before the
   * first join it is `firstWoven`; on a window that will not weave it is that `woven: false` result.
   *
   * On a browser that reports `wovenState` it settles `confirmed: true, reason: 'woven'` on a
   * 'woven' read that follows a 'withheld'/'pending' read seen after the call, or three session
   * frames after the last box change (the report trails the join by 1–3 frames, so a 'woven' from
   * the old rect never settles it), or after a hold of steady 'woven' reads when nothing changed.
   * The cap stays: still 'withheld' four holds after the call (at least 4.8 s), it settles `woven:
   * false, confirmed: true, reason: <withheldReason>`.
   */
  rewoven(): Promise<FirstWovenResult>;
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

  // The panel is the DOCUMENT's, not a tile's, so the display API lives here; the same names are
  // on every tile handle, routed to whichever window currently holds a live layer.

  /**
   * The panel, or `null` where there is no glasses-free display — `null` only once the cap has
   * passed, never for "not ready yet" (a call before the live window has answered waits for its
   * release signal and is asked again while it answers `null`, capped). See
   * {@link TileHandle.getDisplayInfo}.
   */
  getDisplayInfo(): Promise<XRDisplayInfo | null>;
  /**
   * Every rendering mode the display can be put in; an empty list only once the cap has passed,
   * never for "not ready yet". See {@link TileHandle.getRenderingModes}.
   */
  getRenderingModes(): Promise<ReadonlyArray<XRDisplayRenderingMode>>;
  /** Switch the display to `modeIndex`. See {@link TileHandle.requestRenderingMode}. */
  requestRenderingMode(modeIndex: number): Promise<void>;
  /** Sugar: `false` -> a 1-view mode, `true` -> the 2-view mode. See {@link TileHandle.setStereoEnabled}. */
  setStereoEnabled(enabled: boolean): Promise<boolean>;
  on(type: 'renderingmodechange', cb: (e: RenderingModeChange) => void): () => void;
  on(type: 'hardwaredisplaystatechange', cb: (e: HardwareDisplayStateChange) => void): () => void;
  on(type: 'trackingstatechange', cb: (state: XRTrackingState, e: TrackingStateChange) => void): () => void;
  off(type: 'renderingmodechange', cb: (e: RenderingModeChange) => void): void;
  off(type: 'hardwaredisplaystatechange', cb: (e: HardwareDisplayStateChange) => void): void;
  off(type: 'trackingstatechange', cb: (state: XRTrackingState, e: TrackingStateChange) => void): void;
  /** As last REPORTED by `hardwaredisplaystatechange` — never what was last requested. */
  readonly hardwareDisplayState: XRHardwareDisplayMode | null;
  /**
   * Is anyone being tracked in front of the display right now? Mirrors `session.trackingState` as
   * last read — `'unknown'` where the browser has no such surface (silently), and again once the
   * session ends. Pages use it for "step back into view" hints; see
   * {@link CreateInline3DOptions.untrackedFallback} for having the SDK flatten image/video tiles.
   */
  readonly trackingState: XRTrackingState;
  /** The active mode as last read/reported. `viewCount: 0` means "not read yet". */
  readonly activeMode: { modeIndex: number; viewCount: number };
  /** True while the SDK is holding every window's rig flat because a 1-view mode is active. */
  readonly stereoCollapsed: boolean;
  /**
   * The eased 2D<->3D transition, live. `factor` is what every window's
   * `ipdFactor`/`parallaxFactor` is being multiplied by on the way to the layer (`1` in 3D, `0`
   * flat, in between mid-ramp); `active` is true while a page-initiated switch is in any of its
   * phases. Read-only and purely informational — the SDK adds no UI of its own for this.
   */
  readonly modeSwitch: { active: boolean; factor: number };

  /**
   * What this build can lift into the floating native viewer, or `null` on a browser with no
   * `XRDisplayLayer.undock` — that null is what a page branches on. Read off the first live
   * layer (`layer.getUndockCapabilities()`); `{model:false, splat:false}` is the pre-read value.
   */
  readonly undock: UndockCapabilities | null;
  /** Re-read {@link Inline3D.undock} off a live layer. */
  refreshUndock(): Promise<UndockCapabilities | null>;

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
  /** Always `'unknown'`: no session, nobody to track. Present so a page need not branch first. */
  trackingState: 'unknown';
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
  /** The eased 2D<->3D transition. On by default; see {@link ModeSwitchOptions}. */
  modeSwitch?: ModeSwitchOptions;
  /**
   * What the SDK does to the image and video windows it owns the pixels of while **nobody is
   * tracked** (`trackingState === 'searching'`). Default `'none'`.
   *
   * Whose job this is depends on the display's eye-tracking mode:
   * - **MANAGED** (the default, and Leia's): the vendor owns tracking loss. It eases the eyes
   *   together and reports `'searching'` only once the display is already 2D. Leave this at
   *   `'none'`: a flatten here would be a second transition.
   * - **MANUAL**: the vendor does nothing and the app handles tracking loss. Use `'mono'`.
   *
   * - `'none'` — nothing changes.
   * - `'mono'` — each `addImage` / `addVideo` window eases to its LEFT eye in both halves of its
   *   side-by-side buffer on `'searching'`, and back on `'tracking'`, over the mode switch's
   *   duration. The buffer is never reallocated and the layer never closed; `'unknown'` leaves it
   *   where it is.
   *
   * **Scene windows are never touched** — the page owns those pixels. Listen for
   * `trackingstatechange` and do the same for a scene.
   */
  untrackedFallback?: 'none' | 'mono';
  /**
   * The TRACKING EASE, as the default for every SDK renderer drawing through this session
   * (`./viewer`'s SceneViewer, `./splat` and `./model` on both engines). When a viewer is
   * acquired — the views jump from the runtime's nominal viewer to the tracked eyes — or lost,
   * the eye cameras glide from where they were drawn to the new views over `durationMs` instead
   * of snapping in one frame; everything parented to the views (parallax, display-rig layers)
   * follows. Triggered by a jump in the views around a `trackingState` edge (or, where the browser
   * reports no state, by a large one-frame jump); a no-op when the vendor already animates the eyes. On by default; `false` restores
   * the snap; a renderer's own `viewerEase` option overrides this. A page rendering its own
   * `addScene` can use the exported {@link ViewerEase}.
   */
  viewerEase?: ViewerEaseOption;
}

/** `true`/unset = on with defaults, `false` = off, or tune it. */
export type ViewerEaseOption =
  | boolean
  | {
      /** Default true. */
      enabled?: boolean;
      /** The glide, in ms (default 300). 0 disables. */
      durationMs?: number;
      /** 'smoothstep' (default) | 'linear' | 'easeOutCubic'. */
      easing?: 'smoothstep' | 'linear' | 'easeOutCubic' | string;
    };

/** One frame's matrices as an SDK renderer copies them out of an XRView (column-major). */
export interface ViewerEaseEntry {
  proj: Float32Array | Float64Array | number[];
  pose: Float32Array | Float64Array | number[];
}

/**
 * The tracking ease on its own, for a page that renders its own `addScene`: copy each view's
 * `projectionMatrix` and `transform.matrix` into an entry, call `apply(entries,
 * frame.session.trackingState)` once per LIVE frame, and render from the entries (keep using the
 * real XRView for `layer.getViewport`). It rewrites the entries only while an ease is running.
 */
export declare class ViewerEase {
  constructor(opts?: ViewerEaseOption & object);
  readonly enabled: boolean;
  readonly durationMs: number;
  readonly easing: string;
  /** Is an ease running right now? */
  readonly active: boolean;
  /** What the last apply() did: the weight of the old views (0 = passed through), the trigger, the jump (eye separations). */
  readonly last: { weight: number; reason: null | 'armed-jump' | 'jump' | 'easing'; jump: number };
  apply(entries: ViewerEaseEntry[], trackingState?: XRTrackingState | string | null, timeMs?: number): number;
  configure(opts?: ViewerEaseOption): void;
  /** Forget the previous frame (call after a resize or a view-count change you handle yourself). */
  reset(): void;
}
export function resolveViewerEaseOption(opt?: ViewerEaseOption): { enabled: boolean; durationMs: number; easing: string };
/** `frame.session.trackingState`, or null when the browser does not report one. */
export function frameTrackingState(frame: unknown): XRTrackingState | null;
/** 300. */
export const VIEWER_EASE_DEFAULT_MS: number;

/**
 * The eased 2D<->3D transition — on by default, and the same sequencer (and the same defaults)
 * the native DisplayXR apps use.
 *
 * Instead of snapping the stereo rig the moment the panel's mode changes, a **page-initiated**
 * switch ramps every window's `ipdFactor`/`parallaxFactor` between 0 and what the page asked for,
 * in the order that looks right:
 *
 * - **going flat** (a `viewCount === 1` target): the disparity ramps OUT first, and the mode
 *   request is forwarded only when it lands — so the panel flips on already-flat content. That is
 *   why `requestRenderingMode()` / `setStereoEnabled(false)` resolve a ramp later than they used
 *   to: they resolve when the request has actually been forwarded.
 * - **coming back** (a 2-view target): the request goes out at once, and the disparity eases in
 *   only once the panel REPORTS 3D — disparity on a still-flat panel is the double image the
 *   whole mode API exists to prevent.
 *
 * Interruptible: pressing the toggle again mid-ramp retargets from the disparity in force, and
 * reversing a going-flat switch that has not fired yet simply ramps back up without ever asking
 * the panel for anything (the dropped request rejects with an `Error` named `superseded`).
 *
 * A mode change the page did **not** request (another tab, the shell, a panel that opens flat)
 * always snaps — there is nothing to ramp from. This is aesthetic policy only; correctness is the
 * runtime's either way.
 */
export interface ModeSwitchOptions {
  /** Ramp duration in ms (default `180`, matching the native default of 0.18 s). `0` = instant. */
  durationMs?: number;
  /** Easing curve (default `'smoothstep'`, Hermite `3t^2 - 2t^3`). */
  easing?: 'smoothstep' | 'linear' | 'easeoutcubic';
  /** `false` restores the plain snap of 1.4.0 (default `true`). */
  enabled?: boolean;
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

/**
 * True when this browser exposes the DISPLAY-MODE API — {@link TileHandle.getDisplayInfo},
 * {@link TileHandle.getRenderingModes} and {@link TileHandle.requestRenderingMode}. Sync + cheap;
 * implies {@link inline3DAvailable}.
 *
 * Reads a capability (all three methods present on `XRDisplayLayer.prototype`), never a version or
 * UA string, and demands all three: a browser shipping half the set is one mid-implementation.
 * Everything the API drives is optional enhancement, so branch on this only to decide whether to
 * show display controls — the handle methods reject with a clear `Error` rather than throwing at
 * import or create time.
 */
export function inline3dDisplayModesSupported(): boolean;

/**
 * True when this browser can undock through `XRDisplayLayer.undock()` — i.e. without the
 * `displayxr-view:` protocol prompt the fallback needs. A page does not have to branch on it to
 * undock (the helper falls back on its own); it is the probe for whether {@link Inline3D.undock}
 * carries capabilities.
 */
export function inline3dUndockSupported(): boolean;

/**
 * Undock `target`'s asset into the floating native viewer over the desktop.
 *
 * **Call it synchronously inside the click.** Both paths need the transient user activation — the
 * API path to be allowed at all, the fallback to get Chrome's protocol dialog — and an `await`
 * before this call spends it.
 *
 * Rejects with an `Error` whose `name` is `'not-installed'`, `'src-not-allowed'`,
 * `'no-activation'` or `'busy'`.
 */
export function undock(target: Element, opts: UndockOptions): Promise<UndockHandle>;

/** True where a native DisplayXR viewer can exist at all (the viewers are Windows-only today). */
export function undockAvailable(): boolean;

/** The `displayxr-view:` URL the fallback path navigates to — exported for logging and tests. */
export function undockUrl(el: Element, opts: UndockOptions): string;

/** An element's rect in physical screen pixels — where the native viewer places its window. */
export function tileScreenRect(el: Element): { x: number; y: number; w: number; h: number; dpr: number };

/** Open the page's inline-3D session and return a manager you add windows to. */
export function createInline3D(
  opts?: CreateInline3DOptions,
): Promise<Inline3D | Inline3DUnsupported>;

/**
 * The document's shared manager: the live {@link createInline3D} result if one exists, else a new
 * one. One inline-3D session per document (woven-canvas rule 1) is the point: a module that needs
 * a wall it did not create (`mountCall`, `<dxr-call>`) uses this instead of opening a second
 * session, and a page that made its own wall first gets that same wall back here.
 *
 * `opts` apply only when this call creates the manager. An unsupported browser resolves to
 * `{ supported: false }` every time (nothing is cached; a later call re-probes). Two callers
 * racing before the first session resolves share one creation. Additive since 1.29.
 */
export function sharedInline3D(
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
  /**
   * The display-mode API. All three optional for the same reason as `setViewRig`: their presence
   * on the prototype IS the capability signal ({@link inline3dDisplayModesSupported}), and the
   * SDK demands all three before treating the browser as supporting any of them.
   */
  getDisplayInfo?(): Promise<XRDisplayInfo | null>;
  getRenderingModes?(): Promise<ReadonlyArray<XRDisplayRenderingMode>>;
  /** Throws `TypeError` **synchronously** for `viewCount > 2` or an unknown index. */
  requestRenderingMode?(modeIndex: number): Promise<void>;
  /** Undock this layer's asset into the floating native viewer. Optional; same probe rule. */
  undock?(init: UndockOptions): Promise<unknown>;
  getUndockCapabilities?(): Promise<UndockCapabilities>;
  close(): void;
}

// Type definitions for @displayxr/inline3d/three — optional three.js helpers.
// These take your imported THREE namespace as a constructor arg, so the SDK never
// bundles three.js (it is an optional peer dependency).

import type { XRViewRigInit } from './index.js';
export { disparityPct, cameraRigDisparityPct, depthBudgetFromBounds } from './depth.js';

/**
 * A reusable three.js camera driven directly by an XRView's matrices. Construct once with your
 * THREE namespace and reuse across frames/windows. Read `.camera` and render it as-is — author
 * your scene at metre scale, do no per-frame world scaling (the runtime's rig already scaled the
 * reported views).
 */
export class EyeCamera {
  /** @param THREE your imported three.js module namespace. */
  constructor(THREE: unknown);
  /** The three.js PerspectiveCamera to render (`renderer.render(scene, eye.camera)`). */
  readonly camera: unknown;
  /** Set the camera's projection + world pose straight from an XRView (call once per eye). */
  setFromView(view: XRView): void;
  /**
   * Set the camera from the two raw matrices an XRView carries, handed over separately.
   *
   * For re-drawing a frame you have already drawn: an `XRView` is valid only inside its own
   * frame callback, so a renderer that wants to repaint (a short view list, a backing store
   * just reallocated and cleared) must keep COPIES of these two matrices, not the view.
   * `setFromView` forwards to this, so both paths are the same code.
   */
  setFromMatrices(
    projectionMatrix: ArrayLike<number>,
    transformMatrix: ArrayLike<number>,
  ): void;
  /** Set the projection + LOCAL pose from an XRView — the attach pattern (see below). */
  setLocalFromView(view: XRView): void;
  /**
   * Like {@link EyeCamera.setFromMatrices}, but the transform becomes the camera's **local**
   * matrix and three composes `matrixWorld` from the parent — for the attach pattern: send an
   * identity-posed camera rig, parent the eye cameras under your app camera, and the scene graph
   * supplies this frame's world pose instead of the rig's one-frame-old one.
   *
   * `matrixAutoUpdate` is false but world composition still runs, so the eyes must be reached by
   * a normal traversal: `renderer.render(scene, eye.camera)` auto-updates a camera only when its
   * `parent` is null, so keep the app camera IN the scene (or call `scene.updateMatrixWorld()`).
   */
  setLocalFromMatrices(
    projectionMatrix: ArrayLike<number>,
    transformMatrix: ArrayLike<number>,
  ): void;
}

/** Options for {@link cameraRigFromCamera}. */
export interface CameraRigOptions {
  /** Zero-disparity distance in WORLD units — content there sits on the glass. 0 = infinity. */
  convergence?: number;
  /** Emit an IDENTITY pose for the attach pattern ({@link EyeCamera.setLocalFromMatrices}). */
  attach?: boolean;
  /** Eye separation, ABSOLUTE on a camera rig (default 1); 0 collapses to mono. */
  ipdFactor?: number;
  /** Head-tracking response, absolute likewise (default 1). */
  parallaxFactor?: number;
  /** Metres → world units on the eye (default 1). */
  metersToVirtual?: number;
  /** A descriptor to overwrite instead of allocating one (for a per-frame call). */
  out?: XRViewRigInit;
}

/** Options for {@link displayRig}. */
export interface DisplayRigOptions {
  /** Metres of virtual display — the zoom knob (default 0.24). */
  virtualDisplayHeight?: number;
  /** Rig pose in app world units (default 0,0,0). */
  position?: { x?: number; y?: number; z?: number };
  /** Rig orientation quaternion (default identity). */
  orientation?: { x?: number; y?: number; z?: number; w?: number };
  /** Eye separation as a RELATIVE `[0,1]` multiplier (default 1). */
  ipdFactor?: number;
  /** Head-tracking response, `[0,1]` (default 1). */
  parallaxFactor?: number;
  /** Off-axis skew strength, `[0.1,10]` (default 1) — an effect, not a correctness knob. */
  perspectiveFactor?: number;
  /** A descriptor to overwrite instead of allocating one. */
  out?: XRViewRigInit;
}

/**
 * Build a CAMERA-rig descriptor from a `THREE.PerspectiveCamera` for `handle.setViewRig()`: the
 * runtime keeps the camera's vertical FOV, offsets the eyes and skews each frustum so
 * `convergence` lands on the zero-disparity plane. The pose is decomposed from `matrixWorld`
 * (so a camera parented under a dolly still reports world space) unless `attach` is set, which
 * emits identity instead.
 *
 * Comfort rule: `ipdFactor × metersToVirtual × convergenceDiopters × N <= 1` (N = the nominal
 * viewer distance the display reports, 0.6 m on a desktop panel). Nothing enforces it: the
 * runtime applies an app-declared camera rig's gain as given (XR_DXR_view_rig §3) and clamps only
 * values outside a field's sanity range. `convergence` 0 / unset (infinity: the whole scene in
 * front of the glass) logs one console warning per page; the descriptor is built as asked.
 * {@link cameraRigDisparityPct} measures the disparity a rig gives.
 *
 * @param THREE your imported three.js module namespace.
 * @param camera a `THREE.PerspectiveCamera` (`.fov` degrees, `.matrixWorld`).
 */
export function cameraRigFromCamera(
  THREE: unknown,
  camera: unknown,
  opts?: CameraRigOptions,
): XRViewRigInit;

/**
 * The same CAMERA-rig descriptor as {@link cameraRigFromCamera}, from a plain pose instead of a
 * three.js camera — for a renderer that is not three. Agrees with cameraRigFromCamera to the bit
 * for the same pose.
 */
export function cameraRigFromPose(
  pose: {
    /** WORLD position. */
    position: { x: number; y: number; z: number };
    /** WORLD orientation quaternion. */
    orientation: { x: number; y: number; z: number; w: number };
    /** FULL vertical angle in DEGREES (three's `camera.fov` convention). */
    fov: number;
  },
  opts?: CameraRigOptions,
): XRViewRigInit;

/**
 * Build a DISPLAY-rig descriptor — the default rig, made explicit and posable: the canvas is a
 * portal onto a virtual display `virtualDisplayHeight` metres tall. Adds what the scalar
 * `SceneOptions.virtualDisplayHeight` cannot say: a pose, and the three factors.
 */
export function displayRig(opts?: DisplayRigOptions): XRViewRigInit;

/**
 * Fade a rendered eye's edges to transparent, so a 3D window dissolves into the page instead of
 * ending at a hard rectangle. Call once per eye, straight after `renderer.render(scene, eye.camera)`,
 * with the SAME viewport `layer.getViewport(view)`. Requires an alpha canvas
 * (`{ alpha: true }` + `setClearColor(0x000000, 0)` + no opaque `scene.background`).
 */
export class EdgeFeather {
  /**
   * @param THREE your imported three.js module namespace.
   * @param opts.px fade width in BUFFER px (the same units getViewport reports; default 24).
   */
  constructor(THREE: unknown, opts?: { px?: number });
  /** Fade this eye's edges. `vp` is the viewport rect from `layer.getViewport(view)`. */
  render(
    renderer: unknown,
    vp: { x: number; y: number; width: number; height: number },
  ): void;
}

import type { CursorRuntimeLink } from './cursor-depth.js';
import type { CursorAnchorMode, CursorPlacement, CursorShape, CursorShapeHit, CursorShapeOption, CursorSoftenOption, CursorSoftenParams, CursorSoftening, CursorView } from './cursor-depth.js';

/** One second of `debug` stats: each figure as `{ mean, p95, max, n }`. */
export interface CursorDebugSummary {
  frames: number;
  seconds: number;
  updateMs: { mean: number; p95: number; max: number; n: number };
  rays: { mean: number; p95: number; max: number; n: number };
  frameMs: { mean: number; p95: number; max: number; n: number };
  /** Age of the pointer sample a frame used, on frames where it was new. */
  pointerAgeMs: { mean: number; p95: number; max: number; n: number };
  samplesPerFrame: number;
}

/**
 * A hit test for {@link DepthCursor} that raycasts three.js objects (recursively): the first hit
 * along the ray as a world point, or null.
 */
export function raycastHitTest(
  THREE: unknown,
  targets: unknown[],
): (origin: number[], direction: number[]) => number[] | null;

/**
 * A cursor that rises to the depth of the content under it, so it is never drawn behind something
 * that pops out of the glass. Same maths and defaults as the runtime's XR_DXR_cursor_depth
 * (ADR-046, Amendment 2's policy). Tracks the pointer over `canvas`, hit-tests the cursor FOOTPRINT,
 * and — only while content under it comes OUT of the glass — draws the classic arrow (`object`, add
 * it to your scene; tip on the hotspot, the OS cursor's size) the margin in front of it, hiding the
 * CSS cursor exactly then. Over content on or behind the glass nothing is drawn: the CSS cursor is
 * the cursor, untouched. Never behind the glass.
 * Opt-in: nothing runs unless you construct one and call `update(views)` each frame.
 *
 * Head motion: while the pointer moves the arrow sits on the line of sight through it; while it is
 * still, it is held world-fixed (default `anchor: 'hybrid'`), so it parallaxes like content.
 */
export class DepthCursor {
  constructor(
    THREE: unknown,
    opts: {
      /** The woven canvas; the pointer is tracked over it. */
      canvas: HTMLElement;
      /** Nearest content point along a WORLD ray, or null. For splats return the expected depth along the ray. */
      hitTest: (origin: number[], direction: number[]) => number[] | null;
      /** Sprite height as a fraction of the canvas height (default: the OS arrow's 19 CSS px of the canvas, re-read each frame). */
      height?: number;
      /** Fill colour of the arrow (default 0xffffff; the outline is always dark). */
      color?: number;
      /** How far in front of out-of-screen content it floats, in eye-baseline units (default 0.015 ≈ 1 mm at a 63-65 mm IPD). */
      margin?: number;
      /** Default `'hybrid'`: exact while the pointer moves, world-fixed (parallaxing) while it is still. */
      anchor?: CursorAnchorMode;
      /** `'window'`: keep the cursor over DOM layered on the canvas; hides the CSS cursor page-wide meanwhile. */
      pointerScope?: 'canvas' | 'window';
      /** 0 (default): the whole footprint every frame. N: amortised — N rays a frame cycling the footprint (both eyes); the arrow still follows the newest pointer each frame. */
      raysPerFrame?: number;
      /**
       * Crosstalk softening of the LIFTED arrow (runtime ADR-046 Amendment 2 §B.7), in the arrow's own
       * shader: blur = 0.1 × its ghost offset (capped at 6% of its height, 8 px), opacity easing to
       * 0.5 over 0.03 baselines of lift; both zero on the glass. Default `'both'`; `'off'` = the crisp arrow.
       */
      soften?: CursorSoftenOption;
      /**
       * The sprite. Default `'auto'`: what the browser would show — the page's computed CSS cursor
       * under the pointer: every standard keyword has a sprite, `url(…)` images are drawn as
       * images, `none` draws nothing. A sprite name (or `'none'`) fixes it. `color` tints the arrow only.
       */
      shape?: CursorShapeOption;
      /** Per-frame override while the sprite draws: a shape name, or nothing for `shape`'s answer. */
      shapeFor?: (hit: CursorShapeHit) => CursorShape | 'none' | 'auto' | null | undefined;
      /** Attach pattern: the Object3D the eye cameras hang off; its world matrix carries the views to world. */
      viewSpace?: unknown;
      /** `true`: log update() cost, rays a frame and the frame interval once a second; `'both'`: also keep the OS cursor visible. */
      debug?: boolean | 'both';
    },
  );
  /** With `debug` only (else null): the rolling stats; `last` is the newest one-second summary, `history` the last 120. */
  readonly debugStats: { last: CursorDebugSummary | null; history: CursorDebugSummary[] } | null;
  /**
   * The arrow (a `THREE.Mesh`: dark outline, white fill, tip at its origin; depth test off, drawn last). Add it to the scene root.
   * While it is softened its geometry and material are a padded quad and the soft-arrow shader; otherwise the crisp mesh.
   */
  readonly object: unknown;
  /** The last placement, for diagnostics. */
  readonly placement: CursorPlacement | { active: false };
  /** The resolved softening parameters. */
  readonly soften: CursorSoftenParams;
  /** The last drawn frame's softening (diagnostics); null while nothing is drawn. */
  readonly softening: CursorSoftening | null;
  /** The sprite drawn last: a name, 'none' or 'image'. */
  readonly shape: CursorShape | 'none' | 'image';
  /** The runtime-drawn cursor link (runtime ADR-046 Amendment 4). */
  readonly runtime: CursorRuntimeLink;
  /** The layer this canvas weaves through, as last passed to `update(views, { layer })`. */
  layer: unknown;
  /**
   * Place the sprite for this frame — call with the views you are about to render, before rendering.
   * Pass `{ layer }` (addScene's second callback argument): where it says "runtime" (ADR-046
   * Amendment 4) the depth goes to the layer and the browser's own cursor is lifted by the runtime;
   * no sprite is drawn. A number is the time in ms, as before.
   */
  update(views: ArrayLike<XRView | CursorView> | null, opts?: number | { nowMs?: number; layer?: unknown }): CursorPlacement | { active: false; runtime?: boolean };
  /** Set the pointer directly (canvas-normalised, v down), or null — for scripted input. */
  setPointer(u: number | null, v?: number): void;
  /** Remove listeners, restore the CSS cursor, free the sprite's GPU resources. */
  dispose(): void;
}

// Type definitions for @displayxr/inline3d/three — optional three.js helpers.
// These take your imported THREE namespace as a constructor arg, so the SDK never
// bundles three.js (it is an optional peer dependency).

import type { XRViewRigInit } from './index.js';

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
 * Comfort rule, from the runtime: `ipdFactor × metersToVirtual × convergenceDiopters × N <= 1`
 * (N ≈ 0.5 m nominal viewing distance). Nothing here enforces it; the runtime clamps.
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

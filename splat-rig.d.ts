// Types for `@displayxr/inline3d/splat/rig` — EXPERIMENTAL (docs/sdk-stability.md): the rig and
// window math the splat viewers use, re-exported. Points are [x, y, z] in the splat's model space.

/** A capture's rest camera: position (model space) and rotation quaternion [x, y, z, w]. */
export interface RestCamera {
  position: readonly [number, number, number] | ArrayLike<number>;
  rotation: readonly [number, number, number, number] | ArrayLike<number>;
}

/** A model-space point in the rest camera's own frame (OpenCV: +x right, +y down, +z forward). */
export function toRestSpace(rest: RestCamera, p: ArrayLike<number>): [number, number, number];
/** A point `d` metres straight ahead of the rest camera, back in model space. */
export function aheadOfRest(rest: RestCamera, d: number): [number, number, number];
/** Distance from the rest camera to a model-space point along the view axis (the plane, not the ray). */
export function planeDistance(rest: RestCamera, p: ArrayLike<number>): number;
/**
 * Focus distance from median disparity: the median of 1/z, inverted (not the median of z).
 * `invz` holds 1/z per sampled splat (z forward, metres); the first `n` entries are used.
 * Null when `n` is 0 or the median is not positive.
 */
export function medianDisparityDistance(invz: ArrayLike<number>, n: number): number | null;
/** The nearest focus distance the viewers accept, in metres. */
export const FOCUS_MIN_M: number;
/** The farthest focus distance the viewers accept, in metres. */
export const FOCUS_MAX_M: number;

/** Capture intrinsics, in pixels of a `width` × `height` image (OpenCV convention, y down). */
export interface CaptureIntrinsics { fx: number; fy: number; cx: number; cy: number; width: number; height: number }
/**
 * The capture camera's off-axis window at the near plane: the projection the camera rigs draw the
 * flat view through. Principal point honoured. `captureFit` 'height' (default) keeps the capture's
 * vertical extent; 'cover' always fills the tile with photograph.
 * @param aspect canvas width / height (non-positive: the capture's own aspect).
 */
export function captureWindow(
  K: CaptureIntrinsics,
  aspect: number,
  near: number,
  captureFit?: 'height' | 'cover',
): { left: number; right: number; top: number; bottom: number };

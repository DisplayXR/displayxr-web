// Type definitions for @displayxr/inline3d/three — optional three.js helpers.
// These take your imported THREE namespace as a constructor arg, so the SDK never
// bundles three.js (it is an optional peer dependency).

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
}

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

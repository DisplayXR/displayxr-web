// inline3d-three.js — optional three.js glue for the inline-3D SDK.
//
// The core inline3d.js is dependency-free and hands a scene window the two eye XRViews each
// frame. This module removes the three.js-specific boilerplate: driving a camera from an
// XRView, and the one non-obvious bit — SCALING the scene to the canvas element's physical
// size.
//
//   import * as THREE from 'three';
//   import { createInline3D } from '../js/inline3d.js';
//   import { EyeCamera } from '../js/inline3d-three.js';
//
//   const eye = new EyeCamera(THREE);           // one reusable off-axis camera
//   wall.addScene(canvas, (views, layer) => {
//     renderer.clear();
//     renderer.setScissorTest(true);
//     for (const view of views) {
//       const vp = layer.getViewport(view);
//       renderer.setViewport(vp.x, vp.y, vp.width, vp.height);
//       renderer.setScissor(vp.x, vp.y, vp.width, vp.height);
//       eye.setFromView(view);
//       eye.fitToElement(world);                // scale scene → element rect (see below)
//       renderer.render(scene, eye.camera);
//     }
//     renderer.setScissorTest(false);
//   });
//
// WHY fitToElement EXISTS. An inline-3D session's views are in DISPLAY-LOCAL METERS: the
// canvas plane is world z=0 (the zero-disparity / "in focus" plane) and the eye sits a few
// tens of cm in front. The projection is an off-axis (Kooima) frustum scoped to the CANVAS
// ELEMENT's physical rect — often just a few centimetres of glass. So a scene authored at
// "1 metre" scale would put the viewer inside it. Author your scene at a fixed VIRTUAL
// height (default 0.24 m, matching the DisplayXR reference apps) inside a THREE.Group, and
// fitToElement rescales that group each frame to the element's real height — uniform scale
// about the origin, so z=0 content stays exactly on the zero-disparity plane.

/**
 * A reusable three.js camera driven directly by an XRView's matrices, plus the element-fit
 * scale helper. Construct once with your THREE namespace and reuse across frames/windows.
 */
export class EyeCamera {
  /** @param {object} THREE  your imported three.js module namespace. */
  constructor(THREE) {
    this._THREE = THREE;
    this.camera = new THREE.PerspectiveCamera();
    this.camera.matrixAutoUpdate = false; // matrices come straight from the XRView
    this._top = new THREE.Vector3();
    this._bot = new THREE.Vector3();
    this._pos = new THREE.Vector3();
  }

  /** Set the camera's projection + world pose from an XRView (call once per eye per frame). */
  setFromView(view) {
    const cam = this.camera;
    cam.projectionMatrix.fromArray(view.projectionMatrix);
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    cam.matrix.fromArray(view.transform.matrix);
    cam.matrixWorld.copy(cam.matrix);
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    return cam;
  }

  /**
   * The canvas element's world-space height at the display plane (z=0), in metres, recovered
   * from the current view by unprojecting NDC top/bottom onto z=0. No display-info needed —
   * the Kooima frustum maps z=0 exactly onto the element's physical rect.
   */
  elementHeight() {
    const cam = this.camera;
    this._pos.setFromMatrixPosition(cam.matrixWorld);
    let top = 0,
      bot = 0,
      ok = true;
    for (const [v, ndcY] of [
      [this._top, 1],
      [this._bot, -1],
    ]) {
      v.set(0, ndcY, 0.5).unproject(cam).sub(this._pos);
      if (Math.abs(v.z) < 1e-9) {
        ok = false;
        break;
      }
      const t = -this._pos.z / v.z;
      const y = this._pos.y + v.y * t;
      if (ndcY > 0) top = y;
      else bot = y;
    }
    return ok ? top - bot : 0;
  }

  /**
   * Uniformly scale `worldGroup` so a scene authored for a `virtualHeight`-metre display fits
   * the canvas element's real height. Call once per frame (after setFromView).
   * @param {THREE.Object3D} worldGroup  the group holding your scene content.
   * @param {number} [virtualHeight=0.24]  metres of virtual display the scene was composed for.
   */
  fitToElement(worldGroup, virtualHeight = 0.24) {
    const h = this.elementHeight();
    if (h > 1e-6) worldGroup.scale.setScalar(h / virtualHeight);
    return worldGroup;
  }
}

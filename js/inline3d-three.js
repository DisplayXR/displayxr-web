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
//   wall.addScene(canvas, (views, layer) => {   // addScene sets virtualDisplayHeight = 0.24 m
//     renderer.clear();
//     renderer.setScissorTest(true);
//     for (const view of views) {
//       const vp = layer.getViewport(view);
//       renderer.setViewport(vp.x, vp.y, vp.width, vp.height);
//       renderer.setScissor(vp.x, vp.y, vp.width, vp.height);
//       eye.setFromView(view);                  // projection + pose straight from the view
//       renderer.render(scene, eye.camera);     // author at metre scale; NO scaling here
//     }
//     renderer.setScissorTest(false);
//   });
//
// SCENE SCALE IS THE RUNTIME'S JOB (display-rig m2v). The inline-3D views the session reports
// are already scaled to your scene by the layer's `virtualDisplayHeight` (see addScene) — the
// runtime places each eye at eye_physical × (virtualDisplayHeight / element_physical_height),
// so the z=0 plane spans that virtual display. Author your scene in metres for a display that
// tall (0.24 m by default), put focused content at z=0 (positive z behind the glass, negative
// in front), and render `eye.camera` directly. No per-frame world scaling — that is the whole
// point of using the rig instead of re-deriving it in the app, and it mirrors the native
// reference apps (cube_handle), which supply one scale number and consume render-ready views.

/**
 * A reusable three.js camera driven directly by an XRView's matrices. Construct once with
 * your THREE namespace and reuse across frames/windows.
 */
export class EyeCamera {
  /** @param {object} THREE  your imported three.js module namespace. */
  constructor(THREE) {
    this._THREE = THREE;
    this.camera = new THREE.PerspectiveCamera();
    this.camera.matrixAutoUpdate = false; // matrices come straight from the XRView
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
}

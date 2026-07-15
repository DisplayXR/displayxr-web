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
//   // TWO bits of renderer setup are load-bearing (see "VIEWPORTS" below):
//   renderer.setPixelRatio(1);                  // getViewport() is already in device px
//   const dpr = window.devicePixelRatio || 1;   // SBS store: DOUBLE-WIDTH, device-res
//   renderer.setSize(canvas.clientWidth * dpr * 2, canvas.clientHeight * dpr, false);
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
// VIEWPORTS — the one trap. layer.getViewport() returns BACKING-STORE pixels, but three.js's
// setViewport()/setScissor() multiply what you pass them by the renderer's pixelRatio. So
// setPixelRatio(anything but 1) silently scales every eye viewport: at dpr 2 the left eye
// covers the WHOLE canvas and overflows vertically, and the weave then shows you a stretched
// slice of it. The tell is nasty — the scene still head-tracks perfectly (the pose and the
// off-axis projection are untouched), it is just zoomed and off-centre — so it looks like a
// projection/rig bug when it is purely a viewport one. Keep pixelRatio at 1 and size the
// backing store in device pixels yourself.
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

/**
 * Fade a rendered eye's edges to transparent, so a 3D window dissolves into the page instead of
 * ending at a hard rectangle. The WebGL counterpart of the SDK's `feather` option for
 * image/video windows (which the SDK bakes itself, since it owns those 2D buffers — for a scene,
 * YOU own the canvas, so the pass has to run here).
 *
 * PER EYE, and that is not a detail: each eye's image spans the WHOLE window, so each needs a
 * fade on all four of ITS OWN edges. A CSS mask/filter on the canvas fades only the element
 * box's outer edges — the left eye would get a fade on its left and none on its right, and the
 * split line would fade when it must not. Same reason cornerRadius is per-eye.
 *
 * Call once per eye, straight after renderer.render(scene, eye.camera), with the SAME viewport
 * still set. Multiplies the framebuffer by an edge ramp (dst *= ramp) via ZeroFactor/SrcAlpha
 * blending, so it works on whatever you drew without knowing anything about it.
 *
 * Requires a transparent canvas to fade INTO: WebGLRenderer({ alpha: true }),
 * renderer.setClearColor(0x000000, 0), and no opaque scene.background.
 *
 *   const feather = new EdgeFeather(THREE, { px: 28 });
 *   ...
 *   renderer.render(scene, eye.camera);
 *   feather.render(renderer, vp);      // vp = layer.getViewport(view)
 */
export class EdgeFeather {
  /**
   * @param {object} THREE  your imported three.js module namespace.
   * @param {object} [opts]
   * @param {number} [opts.px=24]  fade width in BUFFER px (the same units getViewport reports).
   */
  constructor(THREE, { px = 24 } = {}) {
    this._THREE = THREE;
    this.px = px;
    this._cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._mat = new THREE.ShaderMaterial({
      uniforms: { fx: { value: 0.1 }, fy: { value: 0.1 } },
      vertexShader: `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
      `,
      fragmentShader: `
        varying vec2 vUv;
        uniform float fx;
        uniform float fy;
        void main() {
          // 1 inside, ramping to 0 at each edge. smoothstep gives a soft, banding-free falloff.
          float ax = smoothstep(0.0, fx, vUv.x) * smoothstep(0.0, fx, 1.0 - vUv.x);
          float ay = smoothstep(0.0, fy, vUv.y) * smoothstep(0.0, fy, 1.0 - vUv.y);
          gl_FragColor = vec4(1.0, 1.0, 1.0, ax * ay);
        }
      `,
      // dst_new = src*0 + dst*src.a  =>  multiply the framebuffer (colour AND alpha) by the ramp.
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.ZeroFactor,
      blendDst: THREE.SrcAlphaFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.SrcAlphaFactor,
    });
    this._quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._mat);
    this._quad.frustumCulled = false;
    this._scene = new THREE.Scene();
    this._scene.add(this._quad);
  }

  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {{x:number,y:number,width:number,height:number}} vp  this eye's viewport.
   */
  render(renderer, vp) {
    if (!vp || this.px <= 0) return;
    // Ramp width as a fraction of THIS eye's viewport, so the fade is px-uniform on screen even
    // though the eye is horizontally squeezed (a half-width viewport stretched 2x by the weave).
    this._mat.uniforms.fx.value = Math.min(0.5, this.px / Math.max(1, vp.width));
    this._mat.uniforms.fy.value = Math.min(0.5, this.px / Math.max(1, vp.height));
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.render(this._scene, this._cam);
    renderer.autoClear = prevAutoClear;
  }
}

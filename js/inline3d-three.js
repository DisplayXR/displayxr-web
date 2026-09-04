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
//
// VIEW RIGS. virtualDisplayHeight is one number out of a whole descriptor. cameraRigFromCamera()
// and displayRig() below build the full thing — a posed portal, or an app CAMERA whose frustum
// the runtime perturbs with the viewer's eyes — for handle.setViewRig(). They fill in a
// descriptor and nothing else: no Kooima, no off-axis math, no scale, here or anywhere in this
// SDK. That stays in the runtime, which is the point of the extension.

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
    return this.setFromMatrices(view.projectionMatrix, view.transform.matrix);
  }

  /**
   * Set the camera from RAW matrices — the same two an XRView carries, handed over
   * separately.
   *
   * WHY THIS EXISTS AND NOT JUST setFromView. An `XRView` is valid only inside the frame
   * callback that produced it: hold one and its matrices are live views onto memory the UA
   * recycles. So a renderer that wants to re-draw a frame it has ALREADY drawn — because
   * this frame's view list arrived short, or because the backing store was just reallocated
   * and cleared — cannot keep the view; it has to keep a COPY of the two matrices and feed
   * them back here. `./viewer`'s last-good replay does exactly that (see SceneViewer.onFrame).
   *
   * Deliberately the single implementation of both: setFromView is a one-line forward, so
   * the replay path can never drift from the live one.
   *
   * @param {ArrayLike<number>} projectionMatrix  16 floats, column-major (view.projectionMatrix).
   * @param {ArrayLike<number>} transformMatrix   16 floats, column-major (view.transform.matrix).
   */
  setFromMatrices(projectionMatrix, transformMatrix) {
    const cam = this.camera;
    cam.projectionMatrix.fromArray(projectionMatrix);
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    cam.matrix.fromArray(transformMatrix);
    cam.matrixWorld.copy(cam.matrix);
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    return cam;
  }

  /** Set the camera's projection + LOCAL pose from an XRView — the attach pattern below. */
  setLocalFromView(view) {
    return this.setLocalFromMatrices(view.projectionMatrix, view.transform.matrix);
  }

  /**
   * Like setFromMatrices, but the view's transform is written as the camera's LOCAL matrix and
   * three composes `matrixWorld` from the parent — so the eye can hang off another object.
   *
   * WHY THIS EXISTS: the browser locates views BEFORE the page's rAF, so a view rig set during
   * frame N drives the views delivered in frame N+1. Send a camera rig with an IDENTITY pose
   * instead, parent both eye cameras under your app camera object, and the runtime's job shrinks
   * to what it is uniquely good at (the eye offsets and the tracking-perturbed frustum, in rig
   * space) while the app's own scene graph supplies the world pose — this frame's, not last
   * frame's. A camera whipping around under the pointer then has zero rig lag.
   *
   * That is a SCENE-GRAPH parent and nothing more. No projection math moves into the page: the
   * projectionMatrix is still the runtime's, untouched, and the local transform is still the eye
   * pose the runtime reported — it is simply interpreted in rig space rather than world space,
   * which is exactly what an identity-posed rig means.
   *
   *   appCamera.add(eyeL.camera); appCamera.add(eyeR.camera);   // once
   *   handle.setViewRig(cameraRigFromCamera(THREE, appCamera, { attach: true, convergence }));
   *   eyeL.setLocalFromView(views[0]);                          // per frame
   *
   * `matrixAutoUpdate` is false (the matrix is ours, not three's) but that does NOT opt out of
   * world composition: `updateMatrixWorld` still multiplies parent × local. So the eye cameras
   * must be reached by a normal traversal — `renderer.render(scene, eye.camera)` only
   * auto-updates a camera whose `parent` is null, so make sure the app camera is IN the scene
   * (or call `scene.updateMatrixWorld()` yourself) or the eyes will render at a stale pose.
   *
   * @param {ArrayLike<number>} projectionMatrix  16 floats, column-major (view.projectionMatrix).
   * @param {ArrayLike<number>} transformMatrix   16 floats, column-major (view.transform.matrix),
   *        read as a pose in the RIG's space.
   */
  setLocalFromMatrices(projectionMatrix, transformMatrix) {
    const cam = this.camera;
    cam.projectionMatrix.fromArray(projectionMatrix);
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    cam.matrix.fromArray(transformMatrix);
    // Hand the world matrices back to three. Marking the flag is the whole handshake: with
    // matrixAutoUpdate off, nothing else tells updateMatrixWorld that the local matrix moved,
    // and a parent that happens not to move that frame would leave the eye at its old world
    // pose (Camera.updateMatrixWorld re-derives matrixWorldInverse from matrixWorld, so both
    // stay consistent once it runs).
    cam.matrixWorldNeedsUpdate = true;
    return cam;
  }
}

// Scratch for cameraRigFromCamera's decompose. Module-scoped and lazily built from the caller's
// THREE, so a per-frame rig costs no allocation — the values are copied straight out into the
// descriptor before anything else can observe them, so sharing is safe.
let _scratch = null;
function scratch(THREE) {
  if (!_scratch) {
    _scratch = { p: new THREE.Vector3(), q: new THREE.Quaternion(), s: new THREE.Vector3() };
  }
  return _scratch;
}

/**
 * Build a CAMERA-rig descriptor from a three.js PerspectiveCamera.
 *
 * A camera rig says "here is an app camera; perturb its frustum with the viewer's eyes" — the
 * runtime keeps your vertical FOV, offsets the eyes, and skews each frustum so the convergence
 * distance lands on the zero-disparity plane. Contrast the DISPLAY rig ({@link displayRig}),
 * which says "the canvas is a portal onto a virtual display this tall". Neither computes
 * anything here: this function only fills in a descriptor, and every off-axis projection stays
 * in the runtime, where it is the same code the native apps use.
 *
 * CONVERGENCE IS THE ONE KNOB TO GET RIGHT. It is the distance at which content sits ON the
 * glass; everything nearer pops out, everything further recedes. Point it at whatever the viewer
 * is meant to be looking at (an orbit target, a hit-tested surface) — for an orbiting camera
 * that is usually just the orbit radius. Left at 0 it means infinity, which puts the entire
 * scene in front of the display and is comfortable for almost nothing.
 *
 * COMFORT. The runtime's rule is `ipdFactor × metersToVirtual × convergenceDiopters × N <= 1`
 * (N = nominal viewing distance, ~0.5 m): at 1 the viewer's eyes are parallel on infinitely far
 * content, and past it they diverge, which no one can fuse. With the defaults (factors 1,
 * metersToVirtual 1) that is `convergence >= ~0.5` world units. Nothing here enforces it — the
 * runtime clamps out-of-range values itself, once, with a warning — but a scene authored in
 * centimetres with a 0.1-unit convergence is the shape of the mistake.
 *
 * @param {object} THREE  your imported three.js module namespace.
 * @param {object} camera  a THREE.PerspectiveCamera (`.fov` in degrees, `.matrixWorld` current).
 * @param {object} [opts]
 * @param {number} [opts.convergence=0]  zero-disparity distance in WORLD units (0 = infinity).
 * @param {boolean} [opts.attach=false]  emit an IDENTITY pose, for the attach pattern above —
 *        you parent the eye cameras under this camera and three supplies the world pose.
 * @param {number} [opts.ipdFactor=1]  eye separation, ABSOLUTE on a camera rig (world units per
 *        metre of real IPD); 0 collapses to mono.
 * @param {number} [opts.parallaxFactor=1]  how far the rig tracks head motion, absolute likewise.
 * @param {number} [opts.metersToVirtual=1]  metres → world units on the eye.
 * @param {object} [opts.out]  a descriptor object to overwrite instead of allocating one.
 * @returns {object} an XRViewRigInit-shaped plain object.
 */
export function cameraRigFromCamera(THREE, camera, opts = {}) {
  const {
    convergence = 0,
    attach = false,
    ipdFactor = 1,
    parallaxFactor = 1,
    metersToVirtual = 1,
    out = {},
  } = opts;
  out.type = 'camera';
  if (attach) {
    // Identity pose: the rig IS the camera, so the runtime reports eyes in camera space and the
    // scene graph does the rest. Deliberately not "the camera's pose from a frame ago".
    out.position = { x: 0, y: 0, z: 0 };
    out.orientation = { x: 0, y: 0, z: 0, w: 1 };
  } else {
    // World pose, decomposed from the matrix rather than read off .position/.quaternion: those
    // are LOCAL, and an app camera parented under a rig/dolly (the usual way to build an orbit)
    // would then send the runtime a pose in the wrong space.
    camera.updateMatrixWorld();
    const { p, q, s } = scratch(THREE);
    camera.matrixWorld.decompose(p, q, s);
    out.position = { x: p.x, y: p.y, z: p.z };
    out.orientation = { x: q.x, y: q.y, z: q.z, w: q.w };
  }
  out.ipdFactor = ipdFactor;
  out.parallaxFactor = parallaxFactor;
  // Diopters, not distance: the wire unit is 1/distance so that "infinity" is representable as
  // a finite 0 instead of a sentinel.
  out.convergenceDiopters = convergence > 0 ? 1 / convergence : 0;
  out.verticalFov = THREE.MathUtils.degToRad(camera.fov); // three's fov is the FULL angle, in degrees
  out.metersToVirtual = metersToVirtual;
  return out;
}

/**
 * Build a DISPLAY-rig descriptor — the default rig, made explicit and posable.
 *
 * The display rig treats the canvas as a PORTAL: the element's plane is world z = 0 and the
 * viewer looks through it at a virtual display `virtualDisplayHeight` metres tall (the m2v knob
 * `addScene`'s scalar option sets). This adds what the scalar cannot say — a pose, so the portal
 * can be tilted or offset, and the three factors, so eye separation, head-tracking response and
 * perspective strength can be dialled independently.
 *
 * The factors are RELATIVE here (unlike a camera rig, where ipd/parallax are absolute):
 * `ipdFactor` and `parallaxFactor` are [0,1] multipliers on what the display would naturally do
 * — 1 is correct-by-construction, 0 is flat/frozen, and the values between are a comfort dial,
 * not a correctness one. `perspectiveFactor` is [0.1,10] and exaggerates or flattens the
 * off-axis skew; it is the one knob with no physical justification, so treat it as an effect.
 * The runtime clamps anything out of range (once, with a warning) rather than refusing the rig.
 *
 * @param {object} [opts]
 * @param {number} [opts.virtualDisplayHeight=0.24]  metres of virtual display (the zoom knob).
 * @param {{x?:number,y?:number,z?:number}} [opts.position]  rig pose, app world units.
 * @param {{x?:number,y?:number,z?:number,w?:number}} [opts.orientation]  rig orientation quat.
 * @param {number} [opts.ipdFactor=1] [opts.parallaxFactor=1] [opts.perspectiveFactor=1]
 * @param {object} [opts.out]  a descriptor object to overwrite instead of allocating one.
 * @returns {object} an XRViewRigInit-shaped plain object.
 */
export function displayRig(opts = {}) {
  const {
    virtualDisplayHeight = 0.24,
    position = { x: 0, y: 0, z: 0 },
    orientation = { x: 0, y: 0, z: 0, w: 1 },
    ipdFactor = 1,
    parallaxFactor = 1,
    perspectiveFactor = 1,
    out = {},
  } = opts;
  out.type = 'display';
  // Copied field by field, not aliased: a caller reusing `out` every frame must not end up
  // holding a live reference to a THREE.Vector3 it is also mutating.
  out.position = { x: position.x || 0, y: position.y || 0, z: position.z || 0 };
  out.orientation = {
    x: orientation.x || 0,
    y: orientation.y || 0,
    z: orientation.z || 0,
    w: orientation.w === undefined ? 1 : orientation.w,
  };
  out.virtualDisplayHeight = virtualDisplayHeight;
  out.ipdFactor = ipdFactor;
  out.parallaxFactor = parallaxFactor;
  out.perspectiveFactor = perspectiveFactor;
  return out;
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

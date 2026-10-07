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
// tall (0.24 m by default), put focused content at z=0 (POSITIVE z is toward the viewer, out
// of the glass; negative z is behind it), and render `eye.camera` directly. No per-frame world scaling — that is the whole
// point of using the rig instead of re-deriving it in the app, and it mirrors the native
// reference apps (cube_handle), which supply one scale number and consume render-ready views.
//
// VIEW RIGS. virtualDisplayHeight is one number out of a whole descriptor. cameraRigFromCamera()
// and displayRig() below build the full thing — a posed portal, or an app CAMERA whose frustum
// the runtime perturbs with the viewer's eyes — for handle.setViewRig(). They fill in a
// descriptor and nothing else: no Kooima, no off-axis math, no scale, here or anywhere in this
// SDK. That stays in the runtime, which is the point of the extension.

import {
  CursorDepthPlacer,
  CursorPointer,
  cursorCrosshairMesh,
  cursorFootprint,
  cursorModelMatrix,
  cursorViewRay,
  CURSOR_DEFAULT_HEIGHT,
  CURSOR_DEFAULT_TUNING,
} from './inline3d-cursor-depth.js';

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
 * WHICH RIG. Decide by what the USER moves, not by whether you hold a camera. If the user turns
 * a SUBJECT — a model, a splat, an avatar, a product hero, and yes, an orbit around one — use a
 * display rig and rotate the subject under a fixed portal: a display rig is scale-invariant, so a
 * figurine and an airframe get the same stereo. A camera rig is literal (two eyes 63 mm apart at
 * your camera), so its disparity falls off as baseline / framing distance and a big subject framed
 * from far away renders FLAT. Use a camera rig for a viewpoint the user moves through a world:
 * first person, a walkthrough, a game, a map, an editor, a ported VR app.
 *
 * CONVERGENCE IS THE ONE KNOB TO GET RIGHT. It is the distance at which content sits ON the
 * glass; everything nearer pops out, everything further recedes. Point it at whatever the viewer
 * is meant to be looking at (the subject's centre, a hit-tested surface) — with a moving camera
 * that is usually just the distance to it. Left at 0 it means infinity, which puts the entire
 * scene in front of the display and is comfortable for almost nothing.
 *
 * COMFORT. The runtime's rule is `ipdFactor × metersToVirtual × convergenceDiopters × N <= 1`
 * (N = nominal viewing distance, ~0.5 m): at 1 the viewer's eyes are parallel on infinitely far
 * content, and past it they diverge, which no one can fuse. With the defaults (factors 1,
 * metersToVirtual 1) that is `convergence >= ~0.5` world units. Nothing here enforces it — the
 * runtime clamps out-of-range values itself, once, with a warning — but a scene authored in
 * centimetres with a 0.1-unit convergence is the shape of the mistake.
 *
 * COMFORT IS NOT A DEPTH METER. It bounds where the depth budget SITS (it guards the background
 * against divergence), not how big the budget is. The budget is
 * `(baseline / tan(vFov/2)) * (1/z_near - 1/z_far)`, which convergence cancels out of exactly —
 * convergence slides the scene relative to the glass and never resizes its depth, which is why
 * ipdFactor/parallaxFactor here are ABSOLUTE rather than scaled by the convergence distance. A
 * window that weaves but looks FLAT is a budget problem (a 63 mm baseline framing a large subject
 * from far away) and comfort will report a healthy number while it happens. Do not rescale the
 * baseline to paper over it: a camera rig needing a scale correction is a scene that wanted a
 * display rig.
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
  const { attach = false, out = {} } = opts;
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
  // three's fov is the FULL angle, in degrees
  return fillCameraRig(out, THREE.MathUtils.degToRad(camera.fov), opts);
}

/**
 * The same CAMERA-rig descriptor as {@link cameraRigFromCamera}, from a plain pose instead of a
 * three.js camera — for a renderer that is not three (./splat's PlayCanvas backend), or a page
 * that keeps its camera as numbers.
 *
 * Field for field the descriptor cameraRigFromCamera builds, in the same key order, and the
 * degrees → radians step is the same multiplication three's `MathUtils.degToRad` does, so the
 * two agree to the bit for the same pose (pinned in test/view-rig.test.mjs).
 *
 * @param {object} pose
 * @param {{x:number,y:number,z:number}} pose.position  WORLD position.
 * @param {{x:number,y:number,z:number,w:number}} pose.orientation  WORLD orientation.
 * @param {number} pose.fov  FULL vertical angle, in DEGREES (three's `camera.fov` convention).
 * @param {object} [opts]  as cameraRigFromCamera.
 * @returns {object} an XRViewRigInit-shaped plain object.
 */
export function cameraRigFromPose(pose, opts = {}) {
  const { attach = false, out = {} } = opts;
  out.type = 'camera';
  if (attach) {
    out.position = { x: 0, y: 0, z: 0 };
    out.orientation = { x: 0, y: 0, z: 0, w: 1 };
  } else {
    const p = pose.position;
    const q = pose.orientation;
    out.position = { x: p.x, y: p.y, z: p.z };
    out.orientation = { x: q.x, y: q.y, z: q.z, w: q.w };
  }
  return fillCameraRig(out, pose.fov * DEG2RAD, opts);
}

/** three's `MathUtils.DEG2RAD`, so a pose-built rig matches a camera-built one to the bit. */
const DEG2RAD = Math.PI / 180;

/** The fields every camera rig carries after its pose. One writer, so the two builders agree. */
function fillCameraRig(out, verticalFovRad, opts) {
  const { convergence = 0, ipdFactor = 1, parallaxFactor = 1, metersToVirtual = 1 } = opts;
  out.ipdFactor = ipdFactor;
  out.parallaxFactor = parallaxFactor;
  // Diopters, not distance: the wire unit is 1/distance so that "infinity" is representable as
  // a finite 0 instead of a sentinel.
  out.convergenceDiopters = convergence > 0 ? 1 / convergence : 0;
  out.verticalFov = verticalFovRad;
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

// ── Depth-aware cursor ─────────────────────────────────────────────────────────────────────

/**
 * A hit test for {@link DepthCursor} that raycasts three.js objects: the first hit along the
 * ray, as a world point, or null.
 *
 * @param {object} THREE  your imported three.js module namespace.
 * @param {object[]} targets  the Object3Ds that count as content (searched recursively).
 */
export function raycastHitTest(THREE, targets) {
  const raycaster = new THREE.Raycaster();
  const o = new THREE.Vector3();
  const d = new THREE.Vector3();
  return (origin, direction) => {
    o.set(origin[0], origin[1], origin[2]);
    d.set(direction[0], direction[1], direction[2]).normalize();
    raycaster.set(o, d);
    const hit = raycaster.intersectObjects(targets, true)[0];
    return hit ? [hit.point.x, hit.point.y, hit.point.z] : null;
  };
}

/**
 * A cursor that rises to the depth of the content under it, so it is never drawn behind
 * something that pops out of the glass (a depth violation). The page supplies the content —
 * a hit test — and this does the rest: tracks the pointer over the canvas, hit-tests the
 * cursor FOOTPRINT (not just the hotspot), places a crosshair sprite with the same maths and
 * defaults as the runtime's XR_DXR_cursor_depth (ADR-046), and hides the CSS cursor exactly
 * while the sprite replaces it.
 *
 * Opt-in: nothing runs unless you construct one and call update(). In 2D (one view) or with the
 * pointer off the canvas it is inactive, the sprite is hidden and the CSS cursor is back.
 *
 *   const cursor = new DepthCursor(THREE, { canvas, hitTest: raycastHitTest(THREE, [model]) });
 *   scene.add(cursor.object);
 *   wall.addScene(canvas, (views, layer) => {
 *     cursor.update(views);            // first, with THIS frame's views
 *     // ... render every view as usual; the sprite draws last, depth test off ...
 *   });
 *
 * Head motion: the sprite sits on the line from the viewer through the pointer's point on the
 * canvas, so its image on the glass does not move when the head does — it stays under the
 * mouse like the OS cursor, and only its depth follows the content under that line of sight.
 *
 * The attach pattern (eye cameras parented under an app camera): pass `viewSpace` = that
 * parent, so the views' local transforms are carried into world space; keep `cursor.object` at
 * the scene root.
 */
export class DepthCursor {
  /**
   * @param {object} THREE  your imported three.js module namespace.
   * @param {object} opts
   * @param {HTMLElement} opts.canvas  the woven canvas (pointer is tracked over it).
   * @param {(origin:number[], direction:number[]) => number[]|null} opts.hitTest  nearest
   *        content point along a ray in WORLD space, or null. {@link raycastHitTest} for meshes;
   *        for splats return the renderer's expected depth along the ray (never raycast splats).
   * @param {number} [opts.height=0.03]  sprite height as a fraction of the canvas height.
   * @param {number} [opts.color=0xffd61a]  fill colour (the outline is always dark).
   * @param {number} [opts.margin=0.005]  how far in front of the content it floats, in eye-baseline
   *        units (0.005 ≈ 1.5 mm at 60 cm: it rests on the content).
   * @param {'hybrid'|'screen'|'world'} [opts.anchor='hybrid']  where along that depth: 'hybrid'
   *        follows the pointer exactly while it moves and stays world-fixed (parallaxes with the
   *        content) while it is still; 'screen' never parallaxes; 'world' always does.
   * @param {'canvas'|'window'} [opts.pointerScope='canvas']  'window' keeps the cursor over DOM
   *        layered on the canvas (overlay buttons) and hides the CSS cursor page-wide meanwhile.
   * @param {object} [opts.viewSpace]  Object3D whose world matrix maps view transforms to world.
   * @param {number} [opts.raysPerFrame=0]  0 = the whole footprint every frame (two eyes × 9
   *        points). N > 0 = an EXPENSIVE hit test (e.g. a gaussian-splat raycast, ~8 ms a ray):
   *        cast N rays a frame from the first eye, cycling through the footprint, and take the
   *        nearest of the most recent full cycle.
   */
  constructor(
    THREE,
    { canvas, hitTest, height = CURSOR_DEFAULT_HEIGHT, color = 0xffd61a, viewSpace = null, raysPerFrame = 0, margin, anchor = 'hybrid', pointerScope = 'canvas' },
  ) {
    this._THREE = THREE;
    this.canvas = canvas;
    this.hitTest = hitTest;
    this.height = height;
    this.viewSpace = viewSpace;
    this.raysPerFrame = raysPerFrame;
    this._ring = []; // amortised mode: the last hit per footprint point (null = a miss)
    this._next = 0;
    const tuning = margin > 0 && Number.isFinite(margin) ? { ...CURSOR_DEFAULT_TUNING, margin } : CURSOR_DEFAULT_TUNING;
    this.placer = new CursorDepthPlacer(tuning, { anchor });
    this.pointer = new CursorPointer(canvas, { scope: pointerScope });
    /** The last placement (diagnostics): `{active, position, height, disparity, targetDisparity, anchored}`. */
    this.placement = { active: false };

    // Filled strokes with a dark outline (a 1 px line reads too thin through the lens).
    const fill = [((color >> 16) & 255) / 255, ((color >> 8) & 255) / 255, (color & 255) / 255, 1];
    const m = cursorCrosshairMesh(fill);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(m.positions, 3));
    geom.setAttribute('color', new THREE.Float32BufferAttribute(m.colors, 4));
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.object = new THREE.Mesh(geom, mat);
    this.object.name = 'inline3d-cursor';
    this.object.matrixAutoUpdate = false;
    this.object.frustumCulled = false;
    this.object.renderOrder = 1e9; // last: never occluded, it is in front by construction
    this.object.visible = false;
  }

  /** Set the pointer position directly (canvas-normalised, v down), or null — for scripted input. */
  setPointer(u, v) {
    this.pointer.set(u, v);
  }

  /**
   * Place the sprite for this frame. Call with the views you are about to render.
   * @param {ArrayLike<XRView|{projectionMatrix:ArrayLike<number>,transformMatrix:ArrayLike<number>}>} views
   * @param {number} [nowMs=performance.now()]
   */
  update(views, nowMs = globalThis.performance ? globalThis.performance.now() : Date.now()) {
    const vs = this._worldViews(views);
    const uv = this.pointer.uv;
    let p = { active: false };
    if (uv && vs.length >= 2) {
      const [u, v] = uv;
      const nearestPoint = this._footprintHit(vs, u, v);
      p = this.placer.update(vs, { u, v, nearestPoint, cursorHeight: this.height }, nowMs / 1000);
    }
    this.placement = p;
    this.object.visible = !!p.active;
    if (p.active) {
      this.object.matrix.fromArray(cursorModelMatrix(p));
      this.object.matrixWorldNeedsUpdate = true;
    }
    this.pointer.hideCss(!!p.active);
    return p;
  }

  /** Remove listeners, give the CSS cursor back, free the sprite's GPU resources. */
  dispose() {
    this.pointer.dispose();
    this.object.visible = false;
    this.object.geometry.dispose();
    this.object.material.dispose();
  }

  // Nearest content point under the footprint, from the two outer views (or, amortised, from
  // the first eye over the last cycle of footprint points).
  _footprintHit(views, u, v) {
    const a = views[0], b = views[views.length - 1];
    const m = a.transformMatrix;
    const fl = Math.hypot(m[8], m[9], m[10]) || 1;
    const f = [-m[8] / fl, -m[9] / fl, -m[10] / fl];
    const fp = cursorFootprint(u, v, this.height, this.pointer.aspect());
    let candidates;
    if (this.raysPerFrame > 0) {
      const ring = this._ring;
      ring.length = fp.length;
      for (let i = 0; i < this.raysPerFrame; i++) {
        const k = this._next++ % fp.length;
        const ray = cursorViewRay(a, fp[k][0], fp[k][1]);
        ring[k] = this.hitTest(ray.origin, ray.direction);
      }
      candidates = ring;
    } else {
      candidates = [];
      for (const [su, sv] of fp) {
        for (const view of [a, b]) {
          const ray = cursorViewRay(view, su, sv);
          candidates.push(this.hitTest(ray.origin, ray.direction));
        }
      }
    }
    let best = Infinity, nearest = null;
    for (const p of candidates) {
      if (!p) continue;
      const depth = p[0] * f[0] + p[1] * f[1] + p[2] * f[2]; // smaller = nearer the viewer
      if (depth < best) {
        best = depth;
        nearest = p;
      }
    }
    return nearest;
  }

  _worldViews(views) {
    const out = [];
    if (!views) return out;
    const parent = this.viewSpace ? this.viewSpace.matrixWorld.elements : null;
    for (const v of views) {
      const t = v.transformMatrix || v.transform.matrix;
      out.push({ projectionMatrix: v.projectionMatrix, transformMatrix: parent ? mul4(parent, t) : t });
    }
    return out;
  }
}

/** Column-major 4x4 multiply, a × b. */
function mul4(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  }
  return o;
}

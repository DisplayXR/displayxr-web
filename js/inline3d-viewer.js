// inline3d-viewer.js — a framed, orbitable three.js object inside an inline-3D window.
//
// EXPERIMENTAL. Not covered by the SDK's 1.x semver promise — see docs/sdk-stability.md.
//
// inline3d.js hands a scene window the two eye XRViews each frame and stops there: what you
// render is your problem. That is the right boundary for the core, but every product that
// shows "one object in a tile, look around it, drag to spin" then rewrites the same five
// things — and gets at least one of them subtly wrong. This module is those five things:
//
//   1. The side-by-side render loop, with the pixelRatio/viewport rule that fails deceptively.
//   2. Auto-FRAMING: put the subject at z=0 (the zero-disparity plane, i.e. in focus) and size
//      it to the tile — including the depth clamp that a naive "fit" forgets.
//   3. Orbit + zoom, rotating about the SUBJECT rather than the world origin.
//   4. An idle turntable, because a still product reads as a photo.
//   5. The mono fallback, so the same page works in any browser.
//
// It is content-agnostic: put anything in `viewer.content`. `./splat` and `./model` are thin
// wrappers that load an asset into it. Use this directly if you have your own three.js content
// and just want the framing and interaction.
//
//   import * as THREE from 'three';
//   import { createInline3D } from '@displayxr/inline3d';
//   import { SceneViewer } from '@displayxr/inline3d/viewer';
//
//   const viewer = new SceneViewer(THREE, canvas, { virtualDisplayHeight: 0.18 });
//   viewer.content.add(myMesh);
//   viewer.fitTo(center, extent);              // model-space bounds of the subject
//   const wall = await createInline3D();
//   if (wall.supported) wall.addScene(canvas, viewer.onFrame, { virtualDisplayHeight: 0.18 });
//   else viewer.startMono();
//
// WHY FRAMING IS SCENE-GRAPH WORK AND NOT A RIG FIELD. The native display rig
// (XrDisplayRigDXR) carries a POSE as well as a virtual display height, and the native viewers
// auto-frame by setting both: pose.position = the subject's centre, virtualDisplayHeight = its
// extent. The web session exposes only the height. That costs nothing, because the SDK's
// authoring contract already says "put focused content at z=0" — so we move the content to the
// origin and scale it, instead of moving the display to the content. Identical framing, no
// browser or runtime change.

/**
 * Backstop on total subject depth, as a multiple of the display height. Generous on purpose:
 * depth placement is a z decision (see fitTo), not a scale one, so this only catches the
 * pathological case where a subject is so deep that no placement helps.
 */
const DEFAULT_DEPTH_LIMIT = 4.0;
/** Milliseconds of no interaction before the idle turntable starts. */
const IDLE_DELAY_MS = 2500;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Robust model-space bounds from a flat array of splat/vertex centres.
 *
 * A raw bounding box is useless on captured content: one stray floater a hundred metres out
 * and the subject shrinks to a speck. This drops the tails per axis and returns the core.
 *
 * This is the CHEAP path. The native viewers additionally run an opacity-weighted voxel
 * flood-fill (`getMainObjectBounds`) that isolates the dominant contiguous object from an
 * air-gap-separated background — which matters on image→splat scenes, where the background
 * wall is part of the reconstruction. That is deliberately NOT reimplemented here: it wants
 * every centre resident and a 64³ pass before the first frame. Compute it at conversion time
 * and pass the result to `fitTo()` instead; fall back to this when there is no such sidecar.
 * (Precedent: the Adreno/mobile native renderer ships exactly this percentile-only path.)
 *
 * @param {ArrayLike<number>} xyz  flat [x,y,z, x,y,z, …] centres in model space.
 * @param {object} [opts]
 * @param {number} [opts.lo=0.05] lower percentile to trim per axis.
 * @param {number} [opts.hi=0.95] upper percentile to trim per axis.
 * @returns {{center:number[], extent:number[]}|null} null if there is nothing to measure.
 */
export function boundsFromPositions(xyz, { lo = 0.05, hi = 0.95 } = {}) {
  const n = Math.floor(xyz.length / 3);
  if (n < 1) return null;
  // Below a few hundred points the percentiles are noise — just use the true box.
  const trim = n >= 512;
  const center = [0, 0, 0];
  const extent = [0, 0, 0];
  const axisVals = new Float64Array(n);
  for (let axis = 0; axis < 3; axis++) {
    for (let i = 0; i < n; i++) axisVals[i] = xyz[i * 3 + axis];
    // TypedArray sort is numeric and in-place — no comparator, no copy. That matters here:
    // this runs over every splat centre, and a boxed Array round-trip on a 500k-splat model
    // is the difference between a hitch and an imperceptible pause.
    const sorted = axisVals.sort();
    const loV = trim ? sorted[Math.floor(lo * (n - 1))] : sorted[0];
    const hiV = trim ? sorted[Math.floor(hi * (n - 1))] : sorted[n - 1];
    center[axis] = 0.5 * (loV + hiV);
    extent[axis] = Math.max(hiV - loV, 1e-6);
  }
  return { center, extent };
}

/**
 * A single framed object in an inline-3D window: SBS render loop, auto-framing, orbit, idle
 * turntable, and a mono fallback.
 */
export class SceneViewer {
  /**
   * @param {object} THREE  your imported three.js module namespace.
   * @param {HTMLCanvasElement} canvas
   * @param {object} [opts]
   * @param {number} [opts.virtualDisplayHeight=0.24]  metres of world the tile's HEIGHT spans.
   *        Pass the SAME value to addScene — this module frames against it but does not set it.
   * @param {'contain'|'height'|'cover'|'none'} [opts.fit='contain']  how fitTo() sizes the
   *        subject. `contain` caps BOTH dimensions at `margin` of the tile — neither width nor
   *        height exceeds it, whatever the subject's proportions. `height` instead pins the
   *        height to `margin` and only guards against running off the sides, which gives a
   *        consistent apparent size across a catalogue at the cost of letting wide subjects run
   *        to the edges.
   * @param {number} [opts.margin=0.8]  fraction of the tile the subject may occupy.
   * @param {number} [opts.depthLimit=4.0]  backstop on total subject depth, in display heights.
   *        Rarely binds — depth placement is a z decision, not a scale one. See fitTo().
   * @param {boolean} [opts.fitSweep=true]  fit the horizontal against the box's DIAGONAL
   *        (width and depth), so a long subject still fits once the turntable turns it.
   * @param {boolean} [opts.orbit=true]  drag to spin, wheel/pinch to zoom.
   * @param {number} [opts.idleSpin=0]  degrees/second of turntable after IDLE_DELAY_MS.
   *        Ignored under prefers-reduced-motion.
   * @param {number} [opts.renderScale=1]  per-eye buffer scale. After the interlace each eye
   *        receives roughly half the panel's samples, so 0.5–0.7 is usually free on a splat.
   * @param {number} [opts.feather=0]  edge fade in buffer px (needs ./three's EdgeFeather).
   * @param {number[]} [opts.pitchLimit=[-60,60]]  degrees; stops the viewer rolling under the
   *        subject, which reads as broken rather than as a feature.
   */
  constructor(THREE, canvas, opts = {}) {
    const {
      virtualDisplayHeight = 0.24,
      fit = 'contain',
      margin = 0.8,
      depthLimit = DEFAULT_DEPTH_LIMIT,
      fitSweep = true,
      orbit = true,
      idleSpin = 0,
      renderScale = 1,
      feather = 0,
      pitchLimit = [-60, 60],
    } = opts;

    this._THREE = THREE;
    this.canvas = canvas;
    this.vH = virtualDisplayHeight;
    this.fit = fit;
    this.margin = margin;
    this.depthLimit = depthLimit;
    this.fitSweep = fitSweep;
    this.renderScale = renderScale;
    this.pitchLimit = pitchLimit;
    this.idleSpin = idleSpin;

    // alpha + a zero-alpha clear so the tile can dissolve into the page rather than ending at
    // a hard rectangle. An opaque scene.background would defeat both this and the feather.
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setClearColor(0x000000, 0);
    // MUST be 1. layer.getViewport() reports BACKING-STORE px, but three.js multiplies whatever
    // you pass setViewport()/setScissor() by the renderer's pixelRatio — so any other value
    // silently scales every eye viewport (at dpr 2 the left eye covers the whole canvas). It
    // fails deceptively: the scene still head-tracks perfectly, it is merely zoomed and
    // off-centre, so it reads as a projection bug. We size the backing store ourselves below.
    this.renderer.setPixelRatio(1);
    this.renderer.autoClear = false;

    this.scene = new THREE.Scene();
    this.scene.background = null;

    // pivot ── rotated + scaled by orbit/fit
    //   └── centering ── translated by -subjectCentre
    //         └── content ── YOUR object goes here
    // Rotating the pivot therefore orbits about the SUBJECT, not the model's arbitrary origin.
    this._pivot = new THREE.Group();
    this._centering = new THREE.Group();
    this.content = new THREE.Group();
    this._centering.add(this.content);
    this._pivot.add(this._centering);
    this.scene.add(this._pivot);

    this._fitScale = 1;
    this._zoom = 1;
    this._yaw = 0;
    this._pitch = 0;
    this._targetYaw = 0;
    this._targetPitch = 0;
    this._lastInput = now(); // so the turntable waits out the load-in rather than starting mid-pop
    this._lastTick = 0;
    this._monoRaf = 0;
    this._mode = '3d'; // drives the backing-store shape; see _resize
    this._disposed = false;

    this._reduceMotion =
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

    this._eye = null; // lazily built (needs ./three); see _ensureEye
    this._feather = null;
    this._featherPx = feather;

    // Mono fallback camera. Deliberately a plain perspective camera: in 2D there is no display
    // plane to be in focus at, so we just look at the framed subject from the front.
    this.monoCamera = new THREE.PerspectiveCamera(35, 1, 0.001, 1000);

    this._onResize = () => this._resize();
    this._ro = typeof ResizeObserver === 'function' ? new ResizeObserver(this._onResize) : null;
    if (this._ro) this._ro.observe(canvas);
    else addEventListener('resize', this._onResize);

    if (orbit) this._bindOrbit();
    this._resize();

    // Bound so it can be passed straight to addScene without a wrapper closure.
    this.onFrame = this.onFrame.bind(this);
  }

  /**
   * Frame the subject: centre it on the zero-disparity plane and scale it to the tile.
   *
   * Two clamps, not one. The obvious one fits the subject's width and height to the tile. The
   * second clamps its DEPTH: a deep object scaled to fill the tile's height can extend a metre
   * of virtual space through the glass, which is uncomfortable to look at and pushes content
   * past where the display can hold focus. `depthLimit` caps that in display-height units.
   *
   * @param {number[]|{x:number,y:number,z:number}} center  subject centre, model space.
   * @param {number[]|{x:number,y:number,z:number}} extent  subject size, model space.
   */
  fitTo(center, extent) {
    const c = Array.isArray(center) ? center : [center.x, center.y, center.z];
    const e = Array.isArray(extent) ? extent : [extent.x, extent.y, extent.z];

    this._centering.position.set(-c[0], -c[1], -c[2]);

    if (this.fit === 'none') {
      this._fitScale = 1;
      this._pivot.position.z = 0;
    } else {
      const box = this.canvas.getBoundingClientRect();
      const aspect = box.height > 0 ? box.width / box.height : 1;
      const vH = this.vH;
      const vW = vH * aspect;
      const ex = Math.max(e[0], 1e-6);
      const ey = Math.max(e[1], 1e-6);
      const ez = Math.max(e[2], 1e-6);

      // THE HORIZONTAL EXTENT IS NOT THE WIDTH — it is the width the subject will occupy once
      // it turns. Both the idle turntable and drag-orbit rotate about Y, which swings DEPTH into
      // the horizontal, so fitting to `ex` alone means anything long fits face-on and then hangs
      // out of the tile the moment it moves. A fox 25 wide and 155 deep is 1.57x the tile width
      // at 90 degrees. Use the box's horizontal diagonal, which bounds every yaw.
      const horiz = this.fitSweep ? Math.hypot(ex, ez) : ex;

      let s;
      if (this.fit === 'cover') {
        s = Math.max((this.margin * vH) / ey, (this.margin * vW) / horiz);
      } else if (this.fit === 'contain') {
        s = Math.min((this.margin * vH) / ey, (this.margin * vW) / horiz);
      } else {
        // 'height' (the default): the subject occupies `margin` of the tile's HEIGHT, whatever
        // its proportions. This is the only mode that gives a consistent APPARENT SIZE across a
        // catalogue — 'contain' hands the decision to whichever axis happens to bind, so a wide
        // subject and a deep one end up visibly different sizes for no reason a shopper can see.
        s = (this.margin * vH) / ey;
        // Hard guard at the full tile width (not margin-reduced): a wide subject may run to the
        // edges, it may not run past them.
        if (horiz * s > vW) s = vW / horiz;
      }

      // DEPTH: the subject sits CENTRED on the zero-disparity plane, and that is the whole rule.
      //
      // It is the native convention — displayxr-demo-gaussiansplat sets the rig pose to the
      // subject centre on all three axes, and displayxr-demo-modelviewer states it outright:
      // "subject stays pinned + centered at the ZDP". Those apps also take vH straight from the
      // subject height (`kAutoFitVerticalComfort = 1.0`) with no width or depth constraint; the
      // margin and the swept-width fit above are this SDK's refinement, but the z convention is
      // theirs and matching it keeps web and native looking alike.
      //
      // A biased variant that slid the subject behind the glass was tried and dropped: on
      // hardware it read WORSE, and it moved content the wrong way besides. Do not re-add it
      // without a hardware comparison.
      this._pivot.position.z = 0;

      // Backstop only: something pathologically deep still gets scaled down.
      const sz = (this.depthLimit * vH) / ez;
      if (sz < s) s = sz;
      this._fitScale = s;
    }
    this._applyTransform();
    // Frame the mono camera on the same subject. Distance to make the frustum exactly vH tall
    // at z=0; the subject is vH×margin tall after the fit, so it lands with an even border.
    const fov = (this.monoCamera.fov * Math.PI) / 180;
    this.monoCamera.position.set(0, 0, 0.5 * this.vH / Math.tan(fov / 2));
    this.monoCamera.lookAt(0, 0, 0);
  }

  /** Set the orbit pose directly. Angles in degrees; zoom is a multiplier on the fit scale. */
  setPose({ yaw, pitch, zoom } = {}) {
    if (yaw !== undefined) this._targetYaw = this._yaw = yaw;
    if (pitch !== undefined) {
      this._targetPitch = this._pitch = clamp(pitch, this.pitchLimit[0], this.pitchLimit[1]);
    }
    if (zoom !== undefined) this._zoom = clamp(zoom, 0.2, 6);
    this._applyTransform();
  }

  /** Return to the framed default pose. */
  resetPose() {
    this.setPose({ yaw: 0, pitch: 0, zoom: 1 });
    this._lastInput = now();
  }

  /**
   * The per-frame callback for `wall.addScene`. Renders the scene once per eye into the
   * side-by-side halves the layer reports.
   */
  onFrame(views, layer) {
    if (this._disposed) return;
    // A lazily-activated tile can start weaving after the page already fell back to mono (or
    // after a scroll-away/scroll-back). Take the buffer back to the SBS shape when that happens
    // — otherwise the first 3D frames render into a 1:1 store and each eye is half a subject.
    if (this._mode !== '3d') this.stopMono();
    this._tick();
    const r = this.renderer;
    const eye = this._ensureEye();
    r.clear();
    r.setScissorTest(true);
    for (const view of views) {
      const vp = layer.getViewport(view);
      if (!vp) continue;
      r.setViewport(vp.x, vp.y, vp.width, vp.height);
      r.setScissor(vp.x, vp.y, vp.width, vp.height);
      if (eye) {
        eye.setFromView(view);
        r.render(this.scene, eye.camera);
      }
      if (this._feather) this._feather.render(r, vp);
    }
    r.setScissorTest(false);
  }

  /**
   * Supply the ./three glue. Optional: without it the 3D path cannot build its eye camera, so
   * `./splat` and `./model` pass it for you. Kept injectable so this module never imports
   * three.js itself and stays usable with any EyeCamera-shaped object.
   */
  useEyeCamera(EyeCameraClass, EdgeFeatherClass) {
    this._EyeCamera = EyeCameraClass;
    if (EdgeFeatherClass && this._featherPx > 0) {
      this._feather = new EdgeFeatherClass(this._THREE, { px: this._featherPx });
    }
    return this;
  }

  /** Drive a flat, single-camera render loop for browsers without inline-3D. */
  startMono() {
    if (this._monoRaf || this._disposed) return;
    this._mode = 'mono'; // BEFORE the resize — the mode is what picks the buffer shape
    this._resize();
    const loop = () => {
      if (this._disposed) return;
      this._monoRaf = requestAnimationFrame(loop);
      this._tick();
      const r = this.renderer;
      r.clear();
      r.setViewport(0, 0, this.canvas.width, this.canvas.height);
      r.render(this.scene, this.monoCamera);
    };
    this._monoRaf = requestAnimationFrame(loop);
  }

  stopMono() {
    if (this._monoRaf) cancelAnimationFrame(this._monoRaf);
    this._monoRaf = 0;
    this._mode = '3d';
    this._resize();
  }

  /** True while the side-by-side backing store is in use (the 3D path is driving this viewer). */
  get is3D() {
    return this._mode === '3d';
  }

  dispose() {
    this._disposed = true;
    this.stopMono();
    if (this._ro) this._ro.disconnect();
    else removeEventListener('resize', this._onResize);
    this._unbindOrbit();
    this.renderer.dispose();
  }

  // ── internals ─────────────────────────────────────────────────────────────────────────

  _ensureEye() {
    if (!this._eye && this._EyeCamera) this._eye = new this._EyeCamera(this._THREE);
    return this._eye;
  }

  _applyTransform() {
    const s = this._fitScale * this._zoom;
    this._pivot.scale.setScalar(s);
    this._pivot.rotation.set((this._pitch * Math.PI) / 180, (this._yaw * Math.PI) / 180, 0, 'YXZ');
  }

  /**
   * Size the drawing buffer. In 3D it is DOUBLE-WIDTH in device pixels, because
   * getViewport() splits canvas.width in half for the two eyes — the browser squashing that
   * 2:1 buffer into the 1:1 CSS box IS the side-by-side squeeze, and the weave un-squeezes it.
   * In mono it must stay 1:1 or the flat render is stretched.
   */
  _resize() {
    if (this._disposed) return;
    const box = this.canvas.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * this.renderScale;
    const w = Math.max(1, Math.round(box.width * dpr));
    const h = Math.max(1, Math.round(box.height * dpr));
    this.renderer.setSize(this._mode === 'mono' ? w : w * 2, h, false);
    this.monoCamera.aspect = box.width / box.height;
    this.monoCamera.updateProjectionMatrix();
  }

  /** Damping + idle turntable. Called once per rendered frame, 3D or mono. */
  _tick() {
    const t = now();
    const dt = this._lastTick ? Math.min((t - this._lastTick) / 1000, 0.1) : 0;
    this._lastTick = t;

    if (this.idleSpin && !this._reduceMotion && t - this._lastInput > IDLE_DELAY_MS) {
      this._targetYaw += this.idleSpin * dt;
    }
    // Critically-damped-ish approach. Instant snapping reads as jitter on a head-tracked
    // display, where the viewer is already moving relative to the content.
    const k = dt > 0 ? 1 - Math.pow(0.001, dt) : 1;
    this._yaw += (this._targetYaw - this._yaw) * k;
    this._pitch += (this._targetPitch - this._pitch) * k;
    this._applyTransform();
  }

  _bindOrbit() {
    const el = this.canvas;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    this._onDown = (ev) => {
      dragging = true;
      lastX = ev.clientX;
      lastY = ev.clientY;
      this._lastInput = now();
      el.setPointerCapture?.(ev.pointerId);
    };
    this._onMove = (ev) => {
      if (!dragging) return;
      const box = el.getBoundingClientRect();
      // A full drag across the tile is a half turn — predictable regardless of tile size.
      this._targetYaw += ((ev.clientX - lastX) / Math.max(box.width, 1)) * 180;
      this._targetPitch = clamp(
        this._targetPitch - ((ev.clientY - lastY) / Math.max(box.height, 1)) * 180,
        this.pitchLimit[0],
        this.pitchLimit[1],
      );
      lastX = ev.clientX;
      lastY = ev.clientY;
      this._lastInput = now();
    };
    this._onUp = (ev) => {
      dragging = false;
      this._lastInput = now();
      el.releasePointerCapture?.(ev.pointerId);
    };
    this._onWheel = (ev) => {
      ev.preventDefault();
      this._zoom = clamp(this._zoom * (ev.deltaY > 0 ? 0.92 : 1.087), 0.2, 6);
      this._lastInput = now();
      this._applyTransform();
    };

    el.style.touchAction = 'none'; // or the browser eats the drag as a scroll
    el.addEventListener('pointerdown', this._onDown);
    el.addEventListener('pointermove', this._onMove);
    el.addEventListener('pointerup', this._onUp);
    el.addEventListener('pointercancel', this._onUp);
    el.addEventListener('wheel', this._onWheel, { passive: false });
  }

  _unbindOrbit() {
    const el = this.canvas;
    if (!this._onDown) return;
    el.removeEventListener('pointerdown', this._onDown);
    el.removeEventListener('pointermove', this._onMove);
    el.removeEventListener('pointerup', this._onUp);
    el.removeEventListener('pointercancel', this._onUp);
    el.removeEventListener('wheel', this._onWheel);
  }
}

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

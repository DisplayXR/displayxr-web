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
//   import { EyeCamera } from '@displayxr/inline3d/three';
//   import { SceneViewer } from '@displayxr/inline3d/viewer';
//
//   const viewer = new SceneViewer(THREE, canvas, { virtualDisplayHeight: 0.18 });
//   viewer.useEyeCamera(EyeCamera);            // REQUIRED for stereo; ./splat and ./model do it
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
 * TWO STAGES, because one percentile box cannot do both jobs. A raw min/max is useless on
 * captured content — one stray floater a hundred metres out and the subject shrinks to a speck —
 * but a trimmed box is equally useless as an EXTENT, because the tail it drops on a dense subject
 * is the subject's own outer shell. Trimming 5% per axis under-reported seven scanned products by
 * 10-15%, which the fit then faithfully turned into a subject overflowing its tile.
 *
 * So: percentiles REJECT, true min/max MEASURES.
 *   1. Percentile core (lo..hi per axis) — an outlier-proof estimate of where the subject is.
 *   2. True min/max over centres inside `expand` x that core, centred on it.
 * A floater sits orders of magnitude outside the core and is still rejected; a shell splat sits
 * just past the percentile cut and is now kept.
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
 * @param {number} [opts.lo=0.05] lower percentile bounding the rejection core.
 * @param {number} [opts.hi=0.95] upper percentile bounding the rejection core.
 * @param {number} [opts.expand=2.5]  how many core-extents wide the acceptance window is. A real
 *        subject reaches well past its own percentile core; a floater does not sit at 2.5x it.
 *        Set 0 to get the old percentile-only box back.
 * @returns {{center:number[], extent:number[]}|null} null if there is nothing to measure.
 */
export function boundsFromPositions(xyz, { lo = 0.05, hi = 0.95, expand = 2.5 } = {}) {
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
  // Untrimmed already IS the true box, and expand 0 asks for the old behaviour.
  if (!trim || expand <= 0) return { center, extent };

  // Stage 2. Note the window is per-axis but membership is joint: a point must be inside on all
  // three axes to count, so a distant floater cannot widen one axis while sitting far off another.
  const wLo = [0, 0, 0];
  const wHi = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    const half = 0.5 * expand * extent[a];
    wLo[a] = center[a] - half;
    wHi[a] = center[a] + half;
  }
  const tLo = [Infinity, Infinity, Infinity];
  const tHi = [-Infinity, -Infinity, -Infinity];
  let kept = 0;
  for (let i = 0; i < n; i++) {
    const x = xyz[i * 3], y = xyz[i * 3 + 1], z = xyz[i * 3 + 2];
    if (x < wLo[0] || x > wHi[0] || y < wLo[1] || y > wHi[1] || z < wLo[2] || z > wHi[2]) continue;
    kept++;
    if (x < tLo[0]) tLo[0] = x; if (x > tHi[0]) tHi[0] = x;
    if (y < tLo[1]) tLo[1] = y; if (y > tHi[1]) tHi[1] = y;
    if (z < tLo[2]) tLo[2] = z; if (z > tHi[2]) tHi[2] = z;
  }
  // A window that somehow caught nothing leaves the core standing rather than returning junk.
  if (kept === 0) return { center, extent };
  const c2 = [0, 0, 0];
  const e2 = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    c2[a] = 0.5 * (tLo[a] + tHi[a]);
    e2[a] = Math.max(tHi[a] - tLo[a], 1e-6);
  }
  return { center: c2, extent: e2 };
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
    this._targetZoom = 1;
    this._yaw = 0;
    this._pitch = 0;
    this._targetYaw = 0;
    this._targetPitch = 0;
    this._lastInput = now(); // so the turntable waits out the load-in rather than starting mid-pop
    this._lastTick = 0;
    this._monoRaf = 0;
    this._mode = '3d'; // drives the backing-store shape; see _resize
    this._disposed = false;
    this._resizePending = false;
    // Last frame this viewer actually DREW, as raw matrices + viewport rects — never XRViews,
    // which are only valid inside their own frame callback. See _cacheGood / _replayLastGood.
    this._lastGood = null;
    this._vps = []; // scratch, reused per frame so validation allocates nothing
    this._warnedNoEye = false;

    this._reduceMotion =
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

    this._eye = null; // lazily built (needs ./three); see _ensureEye
    this._feather = null;
    this._featherPx = feather;

    // Mono fallback camera. Deliberately a plain perspective camera: in 2D there is no display
    // plane to be in focus at, so we just look at the framed subject from the front.
    this.monoCamera = new THREE.PerspectiveCamera(35, 1, 0.001, 1000);

    // Coalesced: ResizeObserver and window resize both fire in BURSTS during a drag-resize or a
    // zoom, and every genuine resize reallocates (and clears) the backing store. One rAF per
    // burst, exactly as the core does for its own windows (inline3d.js _onBoxChange).
    this._onResize = () => this._scheduleResize();
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
    if (zoom !== undefined) this._targetZoom = this._zoom = clamp(zoom, ZOOM_MIN, ZOOM_MAX);
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
   *
   * VALIDATE BEFORE YOU CLEAR — the dark-blink rule (web#12). `r.clear()` is the point of no
   * return: after it the canvas is transparent-black, and if the frame then fails to draw
   * anything over it, that empty buffer is what the weave consumes. Under GPU load the session
   * can hand this callback a SHORT view list (one view, or none — a per-frame mono fallback),
   * and the old loop cleared first and rendered what it could: a single origin-camera view whose
   * content is entirely near-plane-clipped, i.e. a fully transparent side-by-side buffer, i.e.
   * one dark woven tile. The blink was ours, not the weave's.
   *
   * So: everything that can disqualify a frame is checked while the canvas still holds the last
   * good image, and only a frame that WILL draw is allowed to clear. A frame that cannot draw
   * REPLAYS the last good one instead (see _replayLastGood) rather than skipping the commit —
   * the SDK's every-frame-repaint invariant is real (inline3d.js `_frame`: a canvas that isn't
   * redrawn can have its layer dropped from the aggregated frame and the weave then reads a
   * stale sub-rect, which smears). A one-frame-stale eye pose is imperceptible; a smear and a
   * black frame are not.
   */
  onFrame(views, layer) {
    if (this._disposed) return;
    // A lazily-activated tile can start weaving after the page already fell back to mono (or
    // after a scroll-away/scroll-back). Take the buffer back to the SBS shape when that happens
    // — otherwise the first 3D frames render into a 1:1 store and each eye is half a subject.
    if (this._mode !== '3d') this.stopMono();
    // Before the validation gate on purpose: a replayed frame still damps and still turns on the
    // turntable, so only the EYE pose is one frame stale, not the whole scene.
    this._tick();

    // 1. A short view list is the load-induced mono fallback. Stereo needs two.
    if (!views || views.length < 2) {
      this._replayLastGood();
      return;
    }

    // 2. No ./three glue: the 3D path has no eye camera to build. This used to clear and draw
    //    NOTHING, silently, forever — and this module's own header example omitted
    //    useEyeCamera() until now, so the failure was reachable by copy-paste. Both ends are
    //    fixed: the example passes it, and this says so once and renders the mono camera, which
    //    at least shows the subject (flat, both halves the same) instead of a dark tile.
    const eye = this._ensureEye();
    if (!eye && !this._warnedNoEye) {
      this._warnedNoEye = true;
      console.warn(
        '[inline3d] SceneViewer.onFrame without useEyeCamera(): falling back to the mono camera. ' +
          'Pass the ./three glue — viewer.useEyeCamera(EyeCamera, EdgeFeather) — for real ' +
          'off-axis stereo. (./splat and ./model do this for you.)',
      );
    }

    // 3. Every eye must have a viewport to render into. A missing or degenerate one means this
    //    frame cannot fill the buffer, so it must not empty it either.
    const vps = this._vps;
    vps.length = 0;
    for (const view of views) {
      const vp = layer && typeof layer.getViewport === 'function' ? layer.getViewport(view) : null;
      if (!vp || !(vp.width > 0) || !(vp.height > 0)) {
        this._replayLastGood();
        return;
      }
      vps.push(vp);
    }

    // Validated: this frame WILL draw over everything it clears.
    const r = this.renderer;
    r.clear();
    r.setScissorTest(true);
    for (let i = 0; i < views.length; i++) {
      const vp = vps[i];
      r.setViewport(vp.x, vp.y, vp.width, vp.height);
      r.setScissor(vp.x, vp.y, vp.width, vp.height);
      if (eye) {
        eye.setFromView(views[i]);
        r.render(this.scene, eye.camera);
      } else {
        r.render(this.scene, this.monoCamera);
      }
      if (this._feather) this._feather.render(r, vp);
    }
    r.setScissorTest(false);
    this._cacheGood(views, vps, !eye);
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
    this._resizePending = false;
    this._lastGood = null;
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

  /**
   * Remember the frame just drawn, so a frame that CANNOT draw has something to put on the
   * canvas instead of a clear (web#12).
   *
   * COPIES, never references. An `XRView` — and the `projectionMatrix` / `transform.matrix`
   * hanging off it — is valid only inside the frame callback that delivered it; the UA is free
   * to recycle that memory afterwards. Retaining one would give a replay that reads whatever
   * the next frame happened to write there, which is a worse bug than the blink. So each eye
   * gets two `Float32Array(16)` copies, allocated once and overwritten in place: the cache
   * costs 128 bytes an eye and zero allocations per frame.
   *
   * The buffer dimensions go in too, so a replay after a resize can scale the rects (the SBS
   * split is proportional, so the scaling is exact).
   */
  _cacheGood(views, vps, mono) {
    const el = this.renderer.domElement || this.canvas;
    let g = this._lastGood;
    if (!g || g.entries.length !== views.length) {
      g = this._lastGood = { entries: [], mono, bufW: 0, bufH: 0 };
      for (let i = 0; i < views.length; i++) {
        g.entries.push({
          proj: new Float32Array(16),
          pose: new Float32Array(16),
          x: 0,
          y: 0,
          width: 0,
          height: 0,
        });
      }
    }
    g.mono = mono;
    g.bufW = el.width || 0;
    g.bufH = el.height || 0;
    for (let i = 0; i < views.length; i++) {
      const e = g.entries[i];
      const vp = vps[i];
      if (!mono) {
        const view = views[i];
        e.proj.set(view.projectionMatrix);
        e.pose.set(view.transform.matrix);
      }
      e.x = vp.x;
      e.y = vp.y;
      e.width = vp.width;
      e.height = vp.height;
    }
  }

  /**
   * Re-render the last good frame from the cached matrices. Returns false when there is no
   * cache yet — and the caller must then do NOTHING, not clear: before the first good frame
   * the canvas holds either the page's own initial state or the mono fallback's output, both
   * of which are better than black.
   */
  _replayLastGood() {
    const g = this._lastGood;
    if (!g || this._disposed) return false;
    const r = this.renderer;
    const eye = g.mono ? null : this._ensureEye();
    const el = this.renderer.domElement || this.canvas;
    // A resize between the cache and the replay changes the buffer, not the split.
    const sx = g.bufW > 0 && el.width ? el.width / g.bufW : 1;
    const sy = g.bufH > 0 && el.height ? el.height / g.bufH : 1;
    const scaled = sx !== 1 || sy !== 1;
    r.clear();
    r.setScissorTest(true);
    for (const e of g.entries) {
      const vp = scaled
        ? {
            x: Math.round(e.x * sx),
            y: Math.round(e.y * sy),
            width: Math.max(1, Math.round(e.width * sx)),
            height: Math.max(1, Math.round(e.height * sy)),
          }
        : e;
      r.setViewport(vp.x, vp.y, vp.width, vp.height);
      r.setScissor(vp.x, vp.y, vp.width, vp.height);
      if (eye) {
        eye.setFromMatrices(e.proj, e.pose);
        r.render(this.scene, eye.camera);
      } else {
        r.render(this.scene, this.monoCamera);
      }
      if (this._feather) this._feather.render(r, vp);
    }
    r.setScissorTest(false);
    return true;
  }

  /** One rAF per burst of observer callbacks. See the _onResize comment. */
  _scheduleResize() {
    if (this._disposed || this._resizePending) return;
    this._resizePending = true;
    const run = () => {
      if (!this._resizePending) return;
      this._resizePending = false;
      this._resize();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else run();
  }

  /**
   * Put the last good frame back on a buffer that was just cleared, NOW — not on the next
   * animation frame. A ResizeObserver callback runs after rAF and before paint, so the frame
   * that reallocated the buffer is the frame that gets committed: without this the tile weaves
   * one black frame per box change, with nothing on the way to repaint it. Mirrors the core's
   * "repaint NOW: setting canvas.width cleared the buffer" (inline3d.js _onBoxChange).
   */
  _repaintAfterResize() {
    if (this._disposed) return;
    if (this._mode === 'mono') {
      const r = this.renderer;
      r.clear();
      r.setViewport(0, 0, this.canvas.width, this.canvas.height);
      r.render(this.scene, this.monoCamera);
      return;
    }
    this._replayLastGood();
  }

  _applyTransform() {
    const s = this._fitScale * this._zoom;
    this._pivot.scale.setScalar(s);
    // Order 'XYZ' == R = Rx(pitch) · Ry(yaw), and the order is the whole point.
    //
    // Yaw must act in the subject's OWN frame (spin it on its axis); pitch must act in the
    // VIEWER's frame (tilt it toward or away from you), and stay screen-horizontal however far
    // the subject has been spun. Rx outermost gives exactly that: Ry never moves the Y axis, so
    // the subject's up-vector after the pair is Rx(pitch)·(0,1,0) — independent of yaw.
    //
    // 'YXZ' (R = Ry · Rx) was the bug: it applies pitch INSIDE the yawed frame, so the pitch
    // axis is itself yawed. At yaw 90° that axis has swung onto world Z and dragging up/down
    // rolls the subject instead of tilting it. Correct head-on, wrong the moment you turn it —
    // which is why it survived review and only showed up when two controls were combined.
    this._pivot.rotation.set((this._pitch * Math.PI) / 180, (this._yaw * Math.PI) / 180, 0, 'XYZ');
  }

  /**
   * Size the drawing buffer. In 3D it is DOUBLE-WIDTH in device pixels, because
   * getViewport() splits canvas.width in half for the two eyes — the browser squashing that
   * 2:1 buffer into the 1:1 CSS box IS the side-by-side squeeze, and the weave un-squeezes it.
   * In mono it must stay 1:1 or the flat render is stretched.
   *
   * NON-DESTRUCTIVE (web#12). `setSize` writes `canvas.width`/`canvas.height` UNCONDITIONALLY,
   * and writing either one reallocates and CLEARS the drawing buffer even when the value does
   * not change. Since a ResizeObserver fires on plenty of things that leave the buffer's
   * dimensions exactly where they were (a sub-pixel reflow, a scrollbar appearing and going, a
   * sibling settling), the old unconditional call meant a black frame for every no-op. So:
   * compare first, and when it IS a real change, put the picture back before the frame commits.
   */
  _resize() {
    if (this._disposed) return;
    const box = this.canvas.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * this.renderScale;
    const w = Math.max(1, Math.round(box.width * dpr));
    const h = Math.max(1, Math.round(box.height * dpr));
    const bufW = this._mode === 'mono' ? w : w * 2;
    // Cheap and always correct to refresh, whether or not the backing store moves.
    this.monoCamera.aspect = box.width / box.height;
    this.monoCamera.updateProjectionMatrix();
    const el = this.renderer.domElement || this.canvas;
    if (el.width === bufW && el.height === h) return; // observer fired, geometry didn't move
    this.renderer.setSize(bufW, h, false);
    this._repaintAfterResize();
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
    // Zoom eases on the same curve. Multiplicatively, because zoom is a ratio: approaching 2x
    // linearly spends most of its time near the start and then lurches, while a ratio approach
    // covers equal PERCEPTUAL steps per frame.
    if (Math.abs(this._targetZoom - this._zoom) > 1e-4) {
      this._zoom *= Math.pow(this._targetZoom / this._zoom, k);
    } else {
      this._zoom = this._targetZoom;
    }
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
      //
      // BOTH axes must make the near face follow the cursor, and the signs are not symmetric.
      // Ry(+yaw) swings the near face toward +x (right), so yaw ADDS dx. Rx(+pitch) swings it
      // toward −y (down), so pitch must also ADD dy — subtracting it sends the face the wrong
      // way and reads as an inverted axis next to a correct one, which is worse than both being
      // inverted.
      this._targetYaw += ((ev.clientX - lastX) / Math.max(box.width, 1)) * 180;
      this._targetPitch = clamp(
        this._targetPitch + ((ev.clientY - lastY) / Math.max(box.height, 1)) * 180,
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
      // Scale by the delta's MAGNITUDE, not just its sign. The previous version applied a fixed
      // 8% step per event, which is roughly right for one mouse notch and badly wrong for a
      // trackpad: a two-finger flick emits dozens of small events, so an 8% step compounded per
      // event sent the subject to the clamp on a gesture the user read as gentle.
      //
      // deltaMode has to be normalised first or the same code means different things per browser:
      // Chrome reports pixels, Firefox reports LINES for a mouse wheel (deltaY 3, not 100), and
      // a page-mode device would otherwise be ~200x more sensitive than a trackpad.
      let px = ev.deltaY;
      if (ev.deltaMode === 1) px *= WHEEL_LINE_PX;
      else if (ev.deltaMode === 2) px *= WHEEL_PAGE_PX;
      // OS pointer acceleration can spike a single event past 500px. Clamping per event keeps one
      // hard flick from teleporting the subject while leaving the gesture's total travel intact,
      // since the events keep coming.
      px = clamp(px, -WHEEL_MAX_PX, WHEEL_MAX_PX);

      // exp() rather than a multiply-add: zoom is a ratio, so equal deltas should give equal
      // ratios in both directions. `1 + d` and `1 - d` are not inverses, and the asymmetry is
      // felt as zooming out being weaker than zooming in.
      this._targetZoom = clamp(this._targetZoom * Math.exp(-px * ZOOM_PER_PX), ZOOM_MIN, ZOOM_MAX);
      this._lastInput = now();
      // No _applyTransform() here: _tick() eases toward the target and applies it, which is what
      // makes a wheel notch glide instead of step.
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

/**
 * Wheel-zoom tuning.
 *
 * ZOOM_PER_PX is set so one ordinary mouse notch (~100 px in Chrome) is about a 10% step, which
 * puts a trackpad's 1-10 px events at a fraction of a percent each — small enough that the easing
 * reads as continuous rather than as a stack of jumps.
 */
// A deltaMode-1 "line" is sized to match a wheel DETENT, not a line of text. Firefox reports a
// notch as deltaY 3 in lines where Chrome reports it as ~100 in pixels, so 33 makes one physical
// notch feel the same in both; 16 (a text line) would make Firefox roughly half as responsive as
// Chrome for identical hardware.
const WHEEL_LINE_PX = 33;
const WHEEL_PAGE_PX = 400; // a "page" in deltaMode 2; rare, but it must not be unbounded
const WHEEL_MAX_PX = 120; // per-event ceiling, against OS pointer acceleration spikes
const ZOOM_PER_PX = 0.001;
const ZOOM_MIN = 0.2;
const ZOOM_MAX = 6;

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

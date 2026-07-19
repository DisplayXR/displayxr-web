// inline3d.js — the DisplayXR inline-3D SDK. Dependency-free.
//
// Turn any HTML <canvas> into a glasses-free-3D "window" on a DisplayXR display, inside an
// otherwise ordinary web page. One page, one WebXR session, MANY weaved windows — and any
// content:
//   • a still side-by-side (SBS) 3D photo          → wall.addImage(canvas, url)
//   • an SBS 3D video / movie                       → wall.addVideo(canvas, videoEl)
//   • a live-rendered stereo scene (three.js, WebGL) → wall.addScene(canvas, onFrame)
//
// The DisplayXR runtime batches every visible window into ONE weave call per frame, so a
// scrolling wall of many 3D windows stays cheap. This SDK keeps that easy: it owns the
// fiddly parts (the SBS buffer contract, correct feature-detection, the compositor-layer
// hint, and — for many windows — a lazy create/close lifecycle) so your page code is short.
//
// ── THE ONE CONTRACT ────────────────────────────────────────────────────────────────────
// A weaved window is a <canvas> whose BACKING BUFFER holds side-by-side stereo — the left
// eye in the left half, the right eye in the right half — while its on-screen CSS box is
// whatever shape you want the viewer to see. The weave un-squishes the two halves back onto
// the box. So a square 3D photo is a 2:1 buffer in a square box; a 16:9 3D movie is a 32:9
// buffer in a 16:9 box. addImage/addVideo maintain this for you; addScene hands you the two
// eye viewports and you render into them.
//
// On any non-DisplayXR browser (or a 2D monitor) createInline3D() resolves to
// { supported:false } and your page shows its normal 2D content — inline-3D is progressive
// enhancement, never a hard dependency.

const hasWebXR = () => typeof navigator !== 'undefined' && !!navigator.xr;
const hasLayer = () =>
  typeof window !== 'undefined' && typeof window.XRDisplayLayer === 'function';
// Overlay exclusion (browser#18): 2D DOM painted OVER a weaved window (hover plates,
// badges) would otherwise be woven along with the content and come out garbled. Browsers
// with XRDisplayLayer.excludeElement punch a per-pixel 2D hole in the weave there
// (final = M·weave + (1−M)·2D, M=0 inside the overlay rect). Older browsers: silent
// no-op — the page still works, the overlay just weaves like before.
const hasExclusion = () =>
  hasLayer() && 'excludeElement' in window.XRDisplayLayer.prototype;

/**
 * Cheap, synchronous "can this browser even attempt inline-3D?" gate — true only in the
 * DisplayXR Browser with the feature enabled. Use it to decide page UI up front.
 *
 * It deliberately does NOT call navigator.xr.isSessionSupported('inline-3d'): that is an
 * async round-trip to the OS weave service which resolves FALSE if it runs before the
 * service has bound (typically at page load), a false-negative that silently drops you to
 * 2D. The authoritative signal is whether createInline3D() actually acquires a session.
 */
export function inline3DAvailable() {
  return hasWebXR() && hasLayer();
}

/**
 * True when this browser supports 2D-overlay exclusion (browser#18) — putting a
 * 2D element ON a woven tile (hover plate, badge) so it composites as crisp 2D
 * over the woven 3D instead of being woven. Use it to choose the on-image
 * overlay path when available and a weave-safe fallback (e.g. a caption band
 * below the tile) otherwise. Implies inline3DAvailable(). Sync + cheap.
 */
export function inline3dOverlaySupported() {
  return hasExclusion();
}

/**
 * Open the page's inline-3D session and return a manager you add windows to.
 *
 * @param {object} [opts]
 * @param {string} [opts.referenceSpace='viewer']  WebXR reference space for the eye poses.
 * @param {boolean} [opts.lazy=true]  Create each window's weave layer only while it is
 *        (near-)visible and close it when it scrolls away — so a long wall only pays for
 *        what's on screen. Set false for a single always-on element.
 * @param {string} [opts.rootMargin='50% 0px']  IntersectionObserver margin for lazy mode;
 *        the default pre-arms a window half a viewport early so a fast scroll never shows a
 *        raw (un-woven) frame.
 * @returns {Promise<Inline3D | {supported:false, error?:Error}>}
 */
export async function createInline3D(opts = {}) {
  const { referenceSpace = 'viewer', lazy = true, rootMargin = '50% 0px' } = opts;
  if (!inline3DAvailable()) return { supported: false };
  let session;
  try {
    // requestSession is Blink-local and resolves immediately when the feature is present —
    // the correct detection path (see inline3DAvailable's note on isSessionSupported).
    session = await navigator.xr.requestSession('inline-3d');
  } catch (e) {
    return { supported: false, error: e };
  }
  let refSpace = null;
  try {
    refSpace = await session.requestReferenceSpace(referenceSpace);
  } catch {
    /* rAF still fires without a ref space; views are just null (fine for image/video). */
  }
  return new Inline3D(session, refSpace, { lazy, rootMargin });
}

/**
 * Back-compatible single-scene helper: open a session, weave one canvas, drive a render
 * callback with the two eye views each frame. Equivalent to
 *   createInline3D({lazy:false}) → addScene(canvas, onFrame).
 * Returns { supported, close() } (plus the manager as .wall) or { supported:false }.
 */
export async function startInline3D(
  canvas,
  { onFrame, referenceSpace = 'viewer', virtualDisplayHeight = 0.24 } = {}
) {
  const wall = await createInline3D({ referenceSpace, lazy: false });
  if (!wall.supported) return wall;
  // Forward the scene-scale knob: without it addScene's default applies, and a caller who
  // authored for a different virtual display size has no way to say so.
  wall.addScene(canvas, onFrame, { virtualDisplayHeight });
  return { supported: true, wall, session: wall.session, close: () => wall.close() };
}

class Inline3D {
  constructor(session, refSpace, { lazy, rootMargin }) {
    this.supported = true;
    this.session = session;
    this.refSpace = refSpace;
    this._windows = new Map(); // canvas -> window record
    this._globalOverlays = new Set(); // page-global overlays excluded from EVERY window
    // el -> Set(window) currently excluding it. Isolation (will-change) is a GLOBAL
    // property of the element while exclusion is PER-WINDOW, so the promotion has to
    // be reference-counted: without this the first window to drop an element
    // un-promotes it while other windows still need it isolated, and the element
    // silently falls back into the canvas layer (→ it lands in that tile's SBS weave
    // input and gets woven). Page-global overlays span many windows, so they are
    // exactly the case that breaks.
    this._isolatedBy = new WeakMap();
    this._running = true;
    this._lazy = lazy;
    this._observer =
      lazy && typeof IntersectionObserver === 'function'
        ? new IntersectionObserver((entries) => this._onIntersect(entries), { rootMargin })
        : null;
    session.addEventListener('end', () => this._teardown());
    session.requestAnimationFrame((t, f) => this._frame(t, f));
  }

  /** Number of windows whose weave layer is currently live (on-screen in lazy mode). */
  get liveCount() {
    let n = 0;
    for (const w of this._windows.values()) if (w.layer) n++;
    return n;
  }

  /**
   * Register a PAGE-GLOBAL 2D overlay (a fixed/sticky header, a floating toolbar) —
   * an element that lives OUTSIDE any tile's container and can overlap MANY tiles as
   * they scroll under it. It's excluded from every window's weave (current and future),
   * re-applied automatically whenever a lazy window re-activates, so you register it ONCE
   * instead of calling handle.exclude(el) per tile (which races window lifecycles).
   *
   * Note (browser#18, pre-#22): this keeps the element out of each tile's SBS weave input,
   * but the per-tile present can still seam page-global chrome that spans tile gaps during
   * scroll — the systematic fix is the DP-composited whole-window present (browser#22).
   * No-op on browsers without excludeElement (progressive enhancement).
   */
  addGlobalOverlay(el) {
    if (!el || this._globalOverlays.has(el)) return;
    this._globalOverlays.add(el);
    for (const win of this._windows.values()) if (win.layer) this._applyExclusion(win, el);
  }

  /** Stop treating `el` as a page-global overlay and drop it from every live window. */
  removeGlobalOverlay(el) {
    if (!el || !this._globalOverlays.delete(el)) return;
    for (const win of this._windows.values()) if (win.layer) this._dropExclusion(win, el);
  }

  /**
   * Weave a still side-by-side 3D image into `canvas`.
   * @param {HTMLCanvasElement} canvas  a 2D canvas; the SDK owns its backing buffer.
   * @param {string|HTMLImageElement|ImageBitmap|HTMLCanvasElement} source  full SBS content
   *        (left eye = left half). A URL string is loaded for you.
   * @param {object} [opts]
   * @param {number} [opts.width] [opts.height]  per-eye buffer resolution in px; defaults to
   *        the canvas's CSS box size × devicePixelRatio (so the box shape sets the aspect).
   * @param {number} [opts.cornerRadius=0]  round each eye's corners in buffer px (CSS
   *        border-radius can't: it would round the packed SBS square's outer corners and
   *        come out lopsided after the eye-split).
   * @param {number} [opts.feather=0]  fade each eye's outer edges to transparent over this
   *        many buffer px, so the 3D window dissolves into the page instead of ending at a
   *        hard rectangle. Same reason CSS can't do it: a mask/filter on the canvas applies
   *        across the packed SBS pair, so each eye would get an inner fade along the split
   *        line and only half its outer edge.
   * @returns {{remove():void}}
   */
  addImage(canvas, source, opts = {}) {
    const win = this._register(canvas, 'image', opts);
    win.ready = loadImage(source).then((img) => {
      win.img = img;
      win.repaint();
    });
    return this._handle(canvas, win);
  }

  /**
   * Weave a playing SBS 3D video into `canvas` (redrawn every frame while visible).
   * @param {HTMLCanvasElement} canvas  a 2D canvas; the SDK owns its backing buffer.
   * @param {HTMLVideoElement} video  a full-SBS 3D video, already play()-ing (left = left).
   * @param {object} [opts]  same width/height/cornerRadius as addImage.
   * @returns {{remove():void}}
   */
  addVideo(canvas, video, opts = {}) {
    const win = this._register(canvas, 'video', opts);
    win.video = video;
    return this._handle(canvas, win);
  }

  /**
   * Weave a live-rendered stereo scene into `canvas`. YOU own the canvas (its size, its
   * WebGL/2D context); the SDK only creates the weave layer and calls you each frame with
   * the two eye views. Render each view into `layer.getViewport(view)` (an {x,y,width,
   * height} into the canvas) using `view.projectionMatrix` + `view.transform.matrix`.
   * See inline3d-three.js for three.js glue (camera + element-scale helpers).
   * The session reports per-eye off-axis (Kooima) views already scaled to your scene by
   * `virtualDisplayHeight` (the display-rig m2v knob): author your scene in metres for a
   * display that tall, put focused content at z=0, and render the views DIRECTLY — the
   * runtime owns the projection AND the scale, so there is no per-frame world scaling in
   * your app.
   * @param {HTMLCanvasElement} canvas
   * @param {(views:XRView[], layer:XRDisplayLayer, frame:XRFrame)=>void} onFrame
   * @param {object} [opts]
   * @param {number} [opts.virtualDisplayHeight=0.24]  metres of virtual display the scene is
   *        composed for. Larger = the element shows a bigger slice of the world.
   * @param {Element} [opts.observe=canvas]  element whose visibility gates lazy create/close.
   * @returns {{remove():void}}
   */
  addScene(canvas, onFrame, opts = {}) {
    const win = this._register(canvas, 'scene', { virtualDisplayHeight: 0.24, ...opts });
    win.onFrame = onFrame;
    win.ownsBuffer = false; // the app sizes a scene canvas; we never touch canvas.width/height
    return this._handle(canvas, win);
  }

  /**
   * The handle every add*() returns. `exclude(el)` marks 2D DOM painted over this window
   * (a hover plate, a play badge) so the weave leaves it crisp 2D instead of garbling it
   * (browser#18). Queued if the layer isn't live yet (lazy mode) and re-applied on every
   * re-activate; a browser without excludeElement silently ignores it (the overlay weaves
   * like before — progressive enhancement, like the rest of this SDK). Prefer the
   * declarative `data-inline3d-overlay` attribute (see _startOverlayScan) unless you need
   * to exclude an element outside the window's container.
   */
  _handle(canvas, win) {
    return {
      remove: () => this._remove(canvas),
      exclude: (el) => {
        if (!el) return;
        win.excluded.add(el);
        this._applyExclusion(win, el);
      },
      unexclude: (el) => {
        if (!el || !win.excluded.delete(el)) return;
        this._dropExclusion(win, el);
      },
    };
  }

  close() {
    try {
      this.session.end();
    } catch {
      /* end() also fires our 'end' handler → _teardown */
    }
    this._teardown();
  }

  // ── internals ───────────────────────────────────────────────────────────────────────

  _register(canvas, kind, opts) {
    if (this._windows.has(canvas)) this._remove(canvas);
    // Own compositing layer: makes the canvas a distinct quad the weave can track. Harmless
    // when the compositor would have promoted it anyway.
    canvas.style.willChange = 'transform';
    canvas.style.transform = 'translateZ(0)';
    const win = {
      canvas,
      kind,
      layer: null,
      img: null,
      video: null,
      onFrame: null,
      ready: null,
      ownsBuffer: kind !== 'scene',
      cornerRadius: opts.cornerRadius || 0,
      feather: opts.feather || 0,
      reqW: opts.width || 0,
      reqH: opts.height || 0,
      virtualDisplayHeight: opts.virtualDisplayHeight || 0,
      observeEl: opts.observe || canvas,
      ctx: kind === 'scene' ? null : canvas.getContext('2d'),
      repaint: () => this._paint(win, null),
      // Overlay exclusion (browser#18): explicit handle.exclude() elements and
      // [data-inline3d-overlay] descendants found by the auto-scan. Applied to the
      // layer on every (re-)activate; the browser clears its own set on layer close.
      excluded: new Set(),
      autoExcluded: new Set(),
      overlayObserver: null,
    };
    this._windows.set(canvas, win);
    if (this._lazy && this._observer) {
      this._observer.observe(win.observeEl);
    } else {
      this._activate(win);
    }
    return win;
  }

  _remove(canvas) {
    const win = this._windows.get(canvas);
    if (!win) return;
    if (this._observer) this._observer.unobserve(win.observeEl);
    this._deactivate(win);
    this._windows.delete(canvas);
  }

  _onIntersect(entries) {
    for (const e of entries) {
      // The observed element may be a wrapper; find the window it belongs to.
      let win = null;
      for (const w of this._windows.values()) {
        if (w.observeEl === e.target) {
          win = w;
          break;
        }
      }
      if (!win) continue;
      if (e.isIntersecting) this._activate(win);
      else this._deactivate(win);
    }
  }

  _activate(win) {
    if (win.layer) return;
    try {
      // virtualDisplayHeight (display-rig m2v) tells the runtime what scale this
      // window's scene is authored at, so it returns render-ready scaled views.
      const init =
        win.virtualDisplayHeight > 0 ? { virtualDisplayHeight: win.virtualDisplayHeight } : {};
      win.layer = new XRDisplayLayer(this.session, win.canvas, init);
    } catch {
      win.layer = null;
      return;
    }
    // Re-apply overlay exclusions (browser#18): the browser's layer-side set died with
    // the previous layer (lazy close), so a re-activated window must re-declare its own
    // explicit exclusions, the page-global overlays, and the attribute-scanned overlays,
    // then resume watching for changes.
    for (const el of win.excluded) this._applyExclusion(win, el);
    for (const el of this._globalOverlays) this._applyExclusion(win, el);
    this._startOverlayScan(win);
    if (win.ownsBuffer) {
      this._sizeBuffer(win, /*sbs*/ true);
      this._paint(win, null); // first SBS paint (video will refresh each frame)
    }
  }

  _deactivate(win) {
    this._stopOverlayScan(win);
    if (win.layer) {
      try {
        win.layer.close();
      } catch {
        /* already closed */
      }
      win.layer = null;
    }
    // Leave a flat (left-eye-only) frame so an off-screen image/video still shows 2D.
    if (win.ownsBuffer && win.kind !== 'scene') {
      this._sizeBuffer(win, /*sbs*/ false);
      this._paint(win, null);
    }
  }

  // ── overlay exclusion (browser#18) ─────────────────────────────────────────────────

  _applyExclusion(win, el) {
    if (!win.layer || !hasExclusion()) return;
    // Force the overlay onto its OWN composited layer so the browser can grab it
    // as an isolated resource (the element rastered on transparency) and
    // composite it OVER the woven 3D — final = plate + (1−plate.a)·woven, true
    // 2D-over-3D. `will-change: transform` reliably promotes to a compositing
    // layer even in the single-render-pass weave config (a CSS filter does NOT —
    // its render surface is flattened away there). Remember we set it so
    // unexclude can restore.
    let refs = this._isolatedBy.get(el);
    if (!refs) {
      refs = new Set();
      this._isolatedBy.set(el, refs);
    }
    refs.add(win);
    if (!el.dataset.inline3dIsolated) {
      el.dataset.inline3dPriorWillChange = el.style.willChange || '';
      const wc = el.style.willChange && el.style.willChange !== 'auto'
        ? el.style.willChange + ', transform'
        : 'transform';
      el.style.willChange = wc;
      el.dataset.inline3dIsolated = '1';
    }
    try {
      win.layer.excludeElement(el);
    } catch {
      /* closed layer / detached element — the per-frame report drops empties anyway */
    }
  }

  _dropExclusion(win, el) {
    const refs = this._isolatedBy.get(el);
    if (refs) refs.delete(win);
    // Only un-promote once NO window needs this element isolated any more.
    if ((!refs || refs.size === 0) && el.dataset.inline3dIsolated) {
      el.style.willChange = el.dataset.inline3dPriorWillChange || '';
      delete el.dataset.inline3dPriorWillChange;
      delete el.dataset.inline3dIsolated;
    }
    if (!win.layer || !hasExclusion()) return;
    try {
      win.layer.unexcludeElement(el);
    } catch {
      /* ignore */
    }
  }

  // Declarative overlays: any element marked `data-inline3d-overlay` inside the window's
  // container (the canvas's parent — where an over-the-window plate must live to be
  // positioned over it) is auto-excluded while the window is live, and tracked through
  // add/remove/toggle by one MutationObserver per active window. Hidden overlays cost
  // nothing: a display:none element reports an empty rect browser-side, so show/hide of a
  // hover plate needs no attribute churn — mark it once, toggle `display` freely. (Hide
  // with display, not opacity/visibility: those still report a full rect, so the weave
  // hole would stay punched under an invisible plate.)
  _startOverlayScan(win) {
    if (!hasExclusion() || typeof MutationObserver !== 'function') return;
    const container = win.canvas.parentElement;
    if (!container) return;
    const sync = () => {
      const marked = new Set(container.querySelectorAll('[data-inline3d-overlay]'));
      for (const el of win.autoExcluded) {
        if (!marked.has(el)) {
          win.autoExcluded.delete(el);
          this._dropExclusion(win, el);
        }
      }
      for (const el of marked) {
        if (!win.autoExcluded.has(el)) {
          win.autoExcluded.add(el);
          this._applyExclusion(win, el);
        }
      }
    };
    sync();
    win.overlayObserver = new MutationObserver(sync);
    win.overlayObserver.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-inline3d-overlay'],
    });
  }

  _stopOverlayScan(win) {
    if (win.overlayObserver) {
      win.overlayObserver.disconnect();
      win.overlayObserver = null;
    }
    // The browser clears the layer-side set on close; mirror that so a re-activate
    // re-scans from scratch (the container's overlays may have changed while dark).
    win.autoExcluded.clear();
  }

  _sizeBuffer(win, sbs) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const boxW = win.reqW || Math.round((win.canvas.clientWidth || 256) * dpr);
    const boxH = win.reqH || Math.round((win.canvas.clientHeight || 256) * dpr);
    win.eyeW = boxW;
    win.eyeH = boxH;
    win.canvas.width = sbs ? boxW * 2 : boxW; // SBS = two eye tiles wide
    win.canvas.height = boxH;
    win.sbs = sbs;
  }

  _paint(win, _views) {
    if (win.kind === 'scene' || !win.ctx) return;
    const src = win.kind === 'video' ? win.video : win.img;
    if (!src) return;
    if (win.kind === 'video' && (src.readyState || 0) < 2) return; // no frame yet
    const c = win.canvas;
    const ctx = win.ctx;
    const srcW = src.videoWidth || src.naturalWidth || src.width;
    const srcH = src.videoHeight || src.naturalHeight || src.height;
    if (!srcW || !srcH) return;
    ctx.clearRect(0, 0, c.width, c.height);
    if (!win.sbs) {
      // Flat fallback: left eye only, stretched to the square buffer.
      drawEye(ctx, src, 0, 0, srcW / 2, srcH, 0, 0, c.width, c.height, win.cornerRadius, win.feather);
      return;
    }
    const halfDst = c.width / 2;
    // A single stretched draw maps SBS source → SBS buffer (left→left, right→right); the
    // per-eye path is only needed to bake decoration (rounded corners / edge feather), which
    // MUST be applied to each eye separately — see drawEye/featherEye.
    if (win.cornerRadius > 0 || win.feather > 0) {
      drawEye(ctx, src, 0, 0, srcW / 2, srcH, 0, 0, halfDst, c.height, win.cornerRadius, win.feather); // L
      drawEye(ctx, src, srcW / 2, 0, srcW / 2, srcH, halfDst, 0, halfDst, c.height, win.cornerRadius, win.feather); // R
    } else {
      ctx.drawImage(src, 0, 0, srcW, srcH, 0, 0, c.width, c.height);
    }
  }

  _frame(t, f) {
    if (!this._running) return;
    this.session.requestAnimationFrame((t2, f2) => this._frame(t2, f2));
    const pose = this.refSpace ? f.getViewerPose(this.refSpace) : null;
    const views = pose ? pose.views : null;
    for (const win of this._windows.values()) {
      if (!win.layer) continue;
      if (win.kind === 'scene') {
        if (views && win.onFrame) win.onFrame(views, win.layer, f);
      } else {
        // Repaint image AND video every frame. The weave reads each window's
        // composited canvas quad per frame; a canvas that isn't redrawn can have
        // its layer dropped from the aggregated frame, so the weave reads a stale
        // sub-rect and the window flickers to a horizontal smear. A still image's
        // redraw is one cheap GPU drawImage — keep it live.
        this._paint(win, views);
      }
    }
  }

  _teardown() {
    if (!this._running) return;
    this._running = false;
    if (this._observer) this._observer.disconnect();
    for (const win of this._windows.values()) {
      this._stopOverlayScan(win);
      if (win.layer) {
        try {
          win.layer.close();
        } catch {
          /* ignore */
        }
        win.layer = null;
      }
    }
    this._windows.clear();
  }
}

// ── small helpers ─────────────────────────────────────────────────────────────────────

function loadImage(source) {
  if (typeof source !== 'string') return Promise.resolve(source); // element/bitmap/canvas
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = source;
  });
}

// Draw one eye region with optional baked rounded corners. Corners are left transparent so
// the canvas's page background shows through (as a CSS radius would have).
function drawEye(ctx, src, sx, sy, sw, sh, dx, dy, dw, dh, radius, feather) {
  if (radius > 0 && ctx.roundRect) {
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(dx, dy, dw, dh, radius);
    ctx.clip();
    ctx.drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh);
    ctx.restore();
  } else {
    ctx.drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh);
  }
  if (feather > 0) {
    featherEye(ctx, dx, dy, dw, dh, feather);
  }
}

// Fade this EYE's outer edges to transparent, so the 3D window dissolves into the page
// instead of ending at a hard rectangle. Same spirit as the runtime feathering a 3D zone's
// edge — but note that is the hardware WISH MASK (lens control, never content); this is the
// content-side equivalent, and the two are independent.
//
// Per-eye, like cornerRadius, and for the same reason: the weave splits the element's rect
// down the middle, so anything applied across the whole (side-by-side) buffer gets halved —
// each eye would get an inner fade along the split line that must not exist, and only half
// its outer edge. A CSS mask/filter on the canvas has exactly that bug.
//
// destination-out with an alpha ramp erases toward transparent, so it works on top of
// whatever was just drawn (image, video frame) without knowing the content.
function featherEye(ctx, x, y, w, h, px) {
  const f = Math.min(px, Math.floor(Math.min(w, h) / 2));
  if (f <= 0) return;
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  const edges = [
    // [x, y, w, h, gradient-from, gradient-to]
    [x, y, w, f, [x, y], [x, y + f]],                       // top
    [x, y + h - f, w, f, [x, y + h], [x, y + h - f]],       // bottom
    [x, y, f, h, [x, y], [x + f, y]],                       // left
    [x + w - f, y, f, h, [x + w, y], [x + w - f, y]],       // right
  ];
  for (const [ex, ey, ew, eh, from, to] of edges) {
    const g = ctx.createLinearGradient(from[0], from[1], to[0], to[1]);
    g.addColorStop(0, 'rgba(0,0,0,1)');   // fully erased at the outer edge
    g.addColorStop(1, 'rgba(0,0,0,0)');   // untouched inside
    ctx.fillStyle = g;
    ctx.fillRect(ex, ey, ew, eh);
  }
  ctx.restore();
}

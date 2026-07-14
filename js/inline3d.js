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
export async function startInline3D(canvas, { onFrame, referenceSpace = 'viewer' } = {}) {
  const wall = await createInline3D({ referenceSpace, lazy: false });
  if (!wall.supported) return wall;
  wall.addScene(canvas, onFrame);
  return { supported: true, wall, session: wall.session, close: () => wall.close() };
}

class Inline3D {
  constructor(session, refSpace, { lazy, rootMargin }) {
    this.supported = true;
    this.session = session;
    this.refSpace = refSpace;
    this._windows = new Map(); // canvas -> window record
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
   * @returns {{remove():void}}
   */
  addImage(canvas, source, opts = {}) {
    const win = this._register(canvas, 'image', opts);
    win.ready = loadImage(source).then((img) => {
      win.img = img;
      win.repaint();
    });
    return { remove: () => this._remove(canvas) };
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
    return { remove: () => this._remove(canvas) };
  }

  /**
   * Weave a live-rendered stereo scene into `canvas`. YOU own the canvas (its size, its
   * WebGL/2D context); the SDK only creates the weave layer and calls you each frame with
   * the two eye views. Render each view into `layer.getViewport(view)` (an {x,y,width,
   * height} into the canvas) using `view.projectionMatrix` + `view.transform.matrix`.
   * See inline3d-three.js for three.js glue (camera + element-scale helpers).
   * @param {HTMLCanvasElement} canvas
   * @param {(views:XRView[], layer:XRDisplayLayer, frame:XRFrame)=>void} onFrame
   * @param {object} [opts]
   * @param {Element} [opts.observe=canvas]  element whose visibility gates lazy create/close.
   * @returns {{remove():void}}
   */
  addScene(canvas, onFrame, opts = {}) {
    const win = this._register(canvas, 'scene', opts);
    win.onFrame = onFrame;
    win.ownsBuffer = false; // the app sizes a scene canvas; we never touch canvas.width/height
    return { remove: () => this._remove(canvas) };
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
      reqW: opts.width || 0,
      reqH: opts.height || 0,
      observeEl: opts.observe || canvas,
      ctx: kind === 'scene' ? null : canvas.getContext('2d'),
      repaint: () => this._paint(win, null),
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
      win.layer = new XRDisplayLayer(this.session, win.canvas);
    } catch {
      win.layer = null;
      return;
    }
    if (win.ownsBuffer) {
      this._sizeBuffer(win, /*sbs*/ true);
      this._paint(win, null); // first SBS paint (video will refresh each frame)
    }
  }

  _deactivate(win) {
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
      drawEye(ctx, src, 0, 0, srcW / 2, srcH, 0, 0, c.width, c.height, win.cornerRadius);
      return;
    }
    const halfDst = c.width / 2;
    // A single stretched draw maps SBS source → SBS buffer (left→left, right→right); the
    // per-eye path is only needed to bake rounded corners.
    if (win.cornerRadius > 0) {
      drawEye(ctx, src, 0, 0, srcW / 2, srcH, 0, 0, halfDst, c.height, win.cornerRadius); // L
      drawEye(ctx, src, srcW / 2, 0, srcW / 2, srcH, halfDst, 0, halfDst, c.height, win.cornerRadius); // R
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
      } else if (win.kind === 'video') {
        this._paint(win, views); // pull the current video frame
      }
      // still images: painted once on activate; nothing to do per-frame.
    }
  }

  _teardown() {
    if (!this._running) return;
    this._running = false;
    if (this._observer) this._observer.disconnect();
    for (const win of this._windows.values()) {
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
function drawEye(ctx, src, sx, sy, sw, sh, dx, dy, dw, dh, radius) {
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
}

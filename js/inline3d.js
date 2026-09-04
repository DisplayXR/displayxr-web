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

// The document's single live manager. The browser's per-frame element-rect report is a
// WHOLE-WIDGET setter — each live session pushes the complete list of rects to weave — so two
// managers in one document overwrite each other frame by frame and neither one's tiles hold
// still. Tracked here only to warn: sequential sessions (a route change that closes one
// manager and opens the next) are legitimate and the common case, so nothing is refused.
let liveManager = null;

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
// View rigs (XR_DXR_view_rig, browser-side `XRDisplayLayer.setViewRig`). The browser has always
// chained a rig descriptor onto its per-frame xrLocateViews — a DISPLAY rig with an identity
// pose whose only knob was `virtualDisplayHeight`. setViewRig opens the whole descriptor: a
// posed display rig, or a CAMERA rig that puts the app's own camera in the runtime's hands.
//
// The capability signal is the METHOD's presence, and that is deliberate: a Blink IDL attribute
// getter throws `Illegal invocation` when read off the prototype (the trap documented at length
// under occlusionByDrawOrder below), so an attribute would be undetectable on exactly the
// browser that has it. `'setViewRig' in prototype` calls nothing and is safe.
const hasViewRig = () => {
  if (!hasLayer()) return false;
  try {
    return 'setViewRig' in window.XRDisplayLayer.prototype;
  } catch {
    return false; // a prototype that refuses to be probed is not a capability
  }
};
// ── draw-order occlusion (browser Phase 2, browser patches 0063/0064) ─────────────────────
//
// The browser composites ANY 2D content over a woven tile per-pixel BY DRAW ORDER — headers,
// badges, dropdowns, translucent scrims, even a full-tile plate — with nothing declared by the
// page. Every exclusion mechanism in this file (auto-chrome, page-global overlays,
// data-inline3d-overlay, handle.exclude) exists only to fake that on browsers without it, so
// where it is on, all of it stands down.
//
// DETECTION IS A CAPABILITY READ, NEVER A VERSION. `excludeElement` is still fully present on a
// Phase-2 browser (the browser change is viz-side; it touches no Blink file, and the declarations
// are collected as before and simply have no effect downstream), so `hasExclusion()` cannot tell
// the generations apart — and a UA/version gate is worthless for a page that pins an SDK for
// years. The signal is a capability flag the browser exposes; ABSENT today, so this reads false
// on everything currently shipping and the legacy path below runs unchanged.
//
// TWO THINGS THE FLAG'S SHAPE HAS TO RESPECT, both learned the hard way:
//  1. NEVER read the value off `XRDisplayLayer.prototype`. A Blink IDL attribute getter throws
//     `TypeError: Illegal invocation` when its receiver is the prototype instead of an instance,
//     so the "obvious" probe `!!XRDisplayLayer.prototype.occlusionByDrawOrder` would THROW on
//     precisely the browser it is meant to detect. `'x' in prototype` is safe (no getter call)
//     but reports only presence.
//  2. Presence is not the answer. The browser's split is switch-gated
//     (`--inline-3d-occlusion`, off by default until it becomes the default), so a build that
//     HAS the attribute can still legitimately report false, and the truth is process-wide
//     rather than per-layer.
// Hence the shape asked of the browser: a STATIC readonly boolean on the interface object,
// `XRDisplayLayer.occlusionByDrawOrder` — process-wide like the switch it reflects, readable
// with no session and no layer (a page decides its DOM before it ever creates one), and immune
// to (1) because there is no prototype receiver involved. Should the flag instead land as a
// per-instance attribute, sampleDrawOrderOcclusion() below picks it up off the first live layer.
let drawOrderOcclusion = null; // null = not decided yet for this document
function hasDrawOrderOcclusion() {
  if (drawOrderOcclusion !== null) return drawOrderOcclusion;
  if (!hasLayer()) return false;
  try {
    const v = window.XRDisplayLayer.occlusionByDrawOrder;
    if (typeof v === 'boolean') return (drawOrderOcclusion = v); // static flag: authoritative
  } catch {
    /* a capability flag that throws is no capability — fall through to the instance path */
  }
  return false; // undecided reads as false: the legacy path is the safe default
}

/**
 * Per-instance fallback: read the flag off a real layer, once, if that is the shape it landed
 * in. Presence is probed on the prototype with `in` (safe) and the VALUE is read from the
 * instance (the only legal receiver). Returns the decided value, or null if the browser exposes
 * no flag at all — in which case nothing is cached and the legacy path stays on.
 */
function sampleDrawOrderOcclusion(layer) {
  if (drawOrderOcclusion !== null) return drawOrderOcclusion;
  if (!layer || !hasLayer()) return null;
  if (!('occlusionByDrawOrder' in window.XRDisplayLayer.prototype)) return null;
  try {
    return (drawOrderOcclusion = !!layer.occlusionByDrawOrder);
  } catch {
    return null;
  }
}

// The "you don't need this any more" notice, at most once per document: the legacy calls stay
// live API (they must, so one page runs on both generations), so this is not a warning — it is
// the one line that stops an author debugging an exclusion that is correctly doing nothing.
let notedAutomaticOcclusion = false;
function noteAutomaticOcclusion() {
  if (notedAutomaticOcclusion) return;
  notedAutomaticOcclusion = true;
  console.info(
    '[inline3d] This browser composites 2D over woven 3D automatically, per-pixel by draw ' +
      'order — overlay exclusion is obsolete here, so exclude()/addGlobalOverlay()/' +
      'data-inline3d-overlay/autoChrome are accepted and ignored. Your 2D chrome already ' +
      'occludes the tiles correctly. The calls are harmless (keep them if you also ship to ' +
      'older DisplayXR Browsers); gate on inline3dOcclusionByDrawOrder() to drop them.'
  );
}

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
 * True when 2D painted ON a woven tile (hover plate, badge, sticky header) composites as
 * crisp 2D over the woven 3D instead of being woven — by declaration (browser#18 overlay
 * exclusion) or, on a newer browser, automatically. Use it to choose the on-image overlay
 * path when available and a weave-safe fallback (e.g. a caption band below the tile)
 * otherwise. That question has the same answer on both generations, so this stays true on a
 * draw-order-occlusion browser; ask inline3dOcclusionByDrawOrder() when you need to know
 * WHICH mechanism you are on. Implies inline3DAvailable(). Sync + cheap.
 */
export function inline3dOverlaySupported() {
  return hasExclusion() || hasDrawOrderOcclusion();
}

/**
 * True when the browser occludes woven tiles with 2D content AUTOMATICALLY — any 2D that
 * paints over a tile (header, badge, dropdown, translucent scrim) composites per-pixel by
 * draw order, with nothing declared. When true, this SDK's exclusion machinery is off:
 * `autoChrome` does not scan, `data-inline3d-overlay` is not watched, and
 * `exclude()`/`addGlobalOverlay()` are accepted (so one page runs on both generations) but do
 * nothing — including the `will-change` promotion they used to force on your elements.
 *
 * Pages need not branch on this at all: the legacy calls are harmless where it is true, and
 * still required where it is false. Branch only to skip work of your own — a `data-` attribute
 * you would otherwise maintain, a full-tile plate the legacy path has to refuse, or a
 * near-solid background you only keep because a translucent bar used to be risky.
 *
 * Sync + cheap. Reads a readonly capability flag on `XRDisplayLayer`, never a version or UA
 * string; false on every browser that has not exposed the flag, which is the safe answer (the
 * SDK then runs the legacy exclusion path, which is what such a browser needs).
 *
 * One caveat if the flag lands as a per-layer attribute rather than the static one this SDK asks
 * for: it can only be read once a layer exists, so a call made before the first window activates
 * answers false and the same call answers true a frame later. Nothing in the SDK depends on the
 * early answer, but a page that wants to branch its DOM up front should re-check (or just leave
 * the legacy calls in — they are harmless).
 */
export function inline3dOcclusionByDrawOrder() {
  return hasDrawOrderOcclusion();
}

/**
 * True when this browser accepts a full VIEW RIG descriptor — `handle.setViewRig(rig)` and
 * `addScene`'s `viewRig` option, i.e. a posed display rig or a camera rig, instead of only the
 * scalar `virtualDisplayHeight`. Sync + cheap; implies {@link inline3DAvailable}.
 *
 * Reads a capability (the presence of `XRDisplayLayer.prototype.setViewRig`), never a version or
 * UA string. False on every browser that predates the rig API — where `virtualDisplayHeight`
 * still works, which is why a page needs to branch on this only if a camera rig is load-bearing
 * for it: `setViewRig` no-ops loudly-once rather than throwing, so a page that just wants the
 * extra control when it is there can call it unconditionally.
 */
export function inline3dViewRigSupported() {
  return inline3DAvailable() && hasViewRig();
}

// One-shot notices about view rigs. Both are per-document, and both describe a situation that is
// identical on every frame — so warning per call would bury the page's own logs in a rAF loop.
let notedNoViewRig = false;
function noteNoViewRig() {
  if (notedNoViewRig) return;
  notedNoViewRig = true;
  console.warn(
    '[inline3d] This browser has no XRDisplayLayer.setViewRig, so the view rig was ignored ' +
      '(the window still weaves — the runtime keeps the default display rig, scaled by ' +
      "virtualDisplayHeight). Gate on inline3dViewRigSupported() if your page's framing " +
      'depends on the rig; further calls are silent.'
  );
}

let notedRigWinsOverHeight = false;
function noteRigWinsOverHeight() {
  if (notedRigWinsOverHeight) return;
  notedRigWinsOverHeight = true;
  console.warn(
    '[inline3d] addScene got BOTH viewRig and virtualDisplayHeight; the rig wins. ' +
      'virtualDisplayHeight is shorthand for exactly one rig (display, identity pose, all ' +
      'factors 1), so the two describe the same slot and there is no meaningful merge — put ' +
      'the height inside the rig (`{ type: "display", virtualDisplayHeight: … }`) to say it ' +
      'once.'
  );
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
 * @param {boolean} [opts.autoChrome=true]  Auto-exclude page chrome: sticky/fixed elements
 *        near the top of the DOM (headers, toolbars) are registered as page-global overlays
 *        automatically — the bar itself plus its text/replaced descendants — so woven
 *        windows scroll UNDER the chrome without any per-app wiring. Opt an element (and
 *        its subtree) out with `data-inline3d-no-overlay`; set false to manage chrome
 *        exclusively via addGlobalOverlay()/data-inline3d-overlay. Ignored (nothing is
 *        scanned, no `will-change` is set on your DOM) on a browser with draw-order
 *        occlusion, where chrome occludes tiles by itself.
 * @returns {Promise<Inline3D | {supported:false, error?:Error}>}
 */
export async function createInline3D(opts = {}) {
  const { referenceSpace = 'viewer', lazy = true, rootMargin = '50% 0px', autoChrome = true } = opts;
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
  return new Inline3D(session, refSpace, { lazy, rootMargin, autoChrome });
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

// Mutual rect-overlap fraction at which an overlay becomes indistinguishable from the canvas
// it sits on — the same >=70% the browser's own layer matcher uses. See _isFullTileOverlay.
const FULL_TILE_OVERLAP = 0.7;

/**
 * Elements inside `root` worth their own overlay plate: anything with a direct
 * non-whitespace text node, plus replaced/painted elements (img, svg, video,
 * canvas, form controls). See _scanChrome for why chrome text is plated
 * per-element instead of relying on the bar's own raster (browser#83).
 */
const CHROME_REPLACED = new Set(['IMG', 'SVG', 'VIDEO', 'CANVAS', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA']);
function chromeTextPlates(root) {
  const plates = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  for (let el = walker.nextNode(); el; el = walker.nextNode()) {
    if (el.closest('[data-inline3d-no-overlay]')) continue;
    if (CHROME_REPLACED.has(el.tagName.toUpperCase())) {
      plates.push(el);
      continue;
    }
    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE && child.nodeValue.trim()) {
        plates.push(el);
        break;
      }
    }
  }
  return plates;
}

class Inline3D {
  constructor(session, refSpace, { lazy, rootMargin, autoChrome = true }) {
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
    // Auto-chrome (sticky/fixed page furniture found by _scanChrome). Tracked apart
    // from _globalOverlays so pruning disconnected chrome never touches overlays the
    // app registered itself.
    this._autoChrome = autoChrome;
    this._autoChromeEls = new Set();
    this._lastChromeScan = 0;
    // Elements already reported as full-tile overlays, so the refusal is logged once per
    // element instead of on every re-activate / overlay-scan sync.
    this._fullTileWarned = new WeakSet();
    // Set once the legacy occlusion machinery has been retired (draw-order browser whose
    // capability flag could only be read from a live layer). See _standDownLegacyOcclusion.
    this._stoodDown = false;
    this._running = true;
    this._lazy = lazy;
    this._observer =
      lazy && typeof IntersectionObserver === 'function'
        ? new IntersectionObserver((entries) => this._onIntersect(entries), { rootMargin })
        : null;
    // Frame-loop bookkeeping: one loop, identified, so a restart can retire a stalled
    // predecessor instead of running two (see _requestFrame / _watchForStalledFrames).
    this._loopId = 0;
    this._framePending = false;
    this._frameCount = 0;
    this._frameWatchdog = null;
    this._suspended = null;
    if (liveManager && liveManager._running && liveManager !== this) {
      console.warn(
        '[inline3d] A second inline-3D session is live in this document. The browser\'s ' +
          'element-rect channel is a whole-widget setter, so both managers clobber each ' +
          "other's rect list every frame — tiles may flicker, ghost, or weave at a stale " +
          'rect. Use ONE createInline3D() per document and add every window to it; if you ' +
          'are switching views, close() the previous manager first.'
      );
    }
    liveManager = this;
    session.addEventListener('end', () => this._teardown());
    this._scanChrome(); // page chrome usually exists before the session does
    this._bindLifecycle();
    this._armDprWatch();
    this._requestFrame();
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
   *
   * @deprecated on a browser with draw-order occlusion (inline3dOcclusionByDrawOrder()):
   * page chrome occludes every tile there with nothing registered. The call is accepted and
   * stored, does nothing, and stays required on older browsers — so keep it unless your page
   * targets Phase-2 browsers only.
   */
  addGlobalOverlay(el) {
    if (!el || this._globalOverlays.has(el)) return;
    // Store it even where occlusion is automatic: the registration is API, a page may read
    // nothing back but must be able to run unchanged on both browser generations. The
    // exclusion below is a no-op there (see _applyExclusion).
    if (hasDrawOrderOcclusion()) noteAutomaticOcclusion();
    this._globalOverlays.add(el);
    for (const win of this._windows.values()) if (win.layer) this._applyExclusion(win, el);
  }

  /** Stop treating `el` as a page-global overlay and drop it from every live window. */
  removeGlobalOverlay(el) {
    if (!el || !this._globalOverlays.delete(el)) return;
    for (const win of this._windows.values()) if (win.layer) this._dropExclusion(win, el);
  }

  /**
   * Auto-chrome scan: find sticky/fixed page furniture and register it as page-global
   * overlays, no app wiring required. Runs at session start and again on every layer
   * activation (throttled) so late-mounted chrome is picked up as tiles churn.
   *
   * Two deliberate choices:
   *  - SHALLOW scan (top 3 DOM levels under <body>): page chrome lives there; a deep
   *    sticky element (a table header inside a scroller) is content, not chrome.
   *  - Besides the chrome element itself, its TEXT / replaced descendants are registered
   *    individually (browser#83): the browser re-composites an excluded element by
   *    geometrically matching its rect to a composited-layer quad (>=70% area overlap),
   *    and a full-width bar can raster as several cc tile quads — each a fraction of the
   *    bar's rect, so none match and the bar never stages. A near-solid bar hides that
   *    failure everywhere except its text (a uniform color weaves to itself). The small
   *    per-text plates each promote to their own layer and match ~1:1, closing the
   *    visible failure regardless of how the bar rasters.
   *
   * Opt-out: `data-inline3d-no-overlay` on an element skips it and its whole subtree.
   * Elements containing a woven window are never plated (that would hand the weave
   * input back to the compositor as crisp 2D).
   */
  _scanChrome() {
    // Draw-order occlusion makes this whole scan pointless work: the chrome already occludes
    // every tile per-pixel. Bail BEFORE the DOM walk, so a Phase-2 page pays neither the
    // querySelectorAll + getComputedStyle sweep (once a second, at every layer activation)
    // nor the `will-change` promotions it would hand out across the page's furniture.
    if (hasDrawOrderOcclusion()) return;
    if (!this._autoChrome || !hasExclusion() || typeof document === 'undefined') return;
    const now = Date.now();
    if (now - this._lastChromeScan < 1000) return; // activations burst during scroll
    this._lastChromeScan = now;
    const body = document.body;
    if (!body) return;
    const found = new Set();
    const candidates = body.querySelectorAll(':scope > *, :scope > * > *, :scope > * > * > *');
    for (const el of candidates) {
      if (el.closest('[data-inline3d-no-overlay]')) continue;
      const pos = getComputedStyle(el).position;
      if (pos !== 'fixed' && pos !== 'sticky') continue;
      let containsWindow = false;
      for (const canvas of this._windows.keys()) {
        if (el === canvas || el.contains(canvas)) {
          containsWindow = true;
          break;
        }
      }
      if (containsWindow) continue;
      found.add(el);
      for (const plate of chromeTextPlates(el)) found.add(plate);
    }
    // Prune auto-registrations that (a) left the document, or (b) NOW contain a woven
    // window (windows register after the constructor's first scan — leaving such a
    // wrapper plated would hand the tile back to the compositor as crisp 2D). Connected,
    // window-free elements are left alone even when no longer detected: a still-connected
    // element may also have been registered by the app, and _globalOverlays is one set —
    // never yank something the app might be counting on.
    for (const el of this._autoChromeEls) {
      let containsWindow = false;
      if (el.isConnected) {
        for (const canvas of this._windows.keys()) {
          if (el === canvas || el.contains(canvas)) {
            containsWindow = true;
            break;
          }
        }
      }
      if (!el.isConnected || containsWindow) {
        this._autoChromeEls.delete(el);
        this.removeGlobalOverlay(el);
      }
    }
    for (const el of found) {
      if (!this._globalOverlays.has(el)) {
        this._autoChromeEls.add(el);
        this.addGlobalOverlay(el);
      }
    }
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
   * @param {object} [opts.viewRig]  a full view-rig descriptor (XRViewRigInit) instead of the
   *        scalar height: a POSED display rig, or a CAMERA rig that hands the runtime your app
   *        camera's pose/FOV/convergence and lets eye tracking perturb its frustum. Supersedes
   *        virtualDisplayHeight (which is one particular display rig), and can be replaced per
   *        frame with `handle.setViewRig()`. Silently ignored on a browser without rig support
   *        — such a browser keeps its default display rig, so the window still weaves.
   * @param {Element} [opts.observe=canvas]  element whose visibility gates lazy create/close.
   * @returns {{remove():void}}
   */
  addScene(canvas, onFrame, opts = {}) {
    // The rig and the height describe the same one slot in the layer init, so warn where a
    // caller has said it twice — silently dropping one of two things the page explicitly asked
    // for is how a scene ends up framed at a scale nobody chose.
    if (opts.viewRig && opts.virtualDisplayHeight !== undefined) noteRigWinsOverHeight();
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
   *
   * On a browser with draw-order occlusion the overlay is already composited over the woven
   * 3D per-pixel, so exclude()/unexclude() are stored-and-ignored (see _applyExclusion).
   */
  _handle(canvas, win) {
    return {
      remove: () => this._remove(canvas),
      exclude: (el) => {
        if (!el) return;
        // Stored, not honoured, where occlusion is automatic — same reason as
        // addGlobalOverlay: one page, both browser generations.
        if (hasDrawOrderOcclusion()) noteAutomaticOcclusion();
        win.excluded.add(el);
        this._applyExclusion(win, el);
      },
      unexclude: (el) => {
        if (!el || !win.excluded.delete(el)) return;
        this._dropExclusion(win, el);
      },
      /**
       * Replace this window's VIEW RIG — the descriptor the runtime locates views against.
       * Cheap enough to call every frame (that is the intended use: a rig is per-locate, so
       * animating one means sending new values, not tweening anything).
       *
       * Remembered on the window as well as pushed at the layer, so the lazy lifecycle cannot
       * quietly lose it (see `viewRig` in _register). Returns whether it reached a LIVE layer:
       * false also means "stored, and it will build the next layer" for a window that is
       * currently scrolled away — which is the honest answer for a page driving this per frame,
       * and the reason it is a boolean rather than void.
       *
       * ONE FRAME OF LAG, by construction. The browser locates views BEFORE the page's rAF, so
       * the rig you set during frame N drives the views delivered in frame N+1. For a slow
       * knob (a slider, a settled camera) that is invisible; for a camera that moves with the
       * pointer it is not, and the fix is not to fight it — send an IDENTITY-posed camera rig
       * and parent your eye cameras under the app camera, so three composes the world pose with
       * zero lag (see `cameraRigFromCamera(..., {attach:true})` + `EyeCamera.setLocalFromView`).
       */
      setViewRig: (rig) => {
        win.viewRig = rig || null;
        if (!hasViewRig()) {
          noteNoViewRig();
          return false;
        }
        if (!win.layer) return false;
        try {
          win.layer.setViewRig(rig);
          return true;
        } catch {
          // A closed layer or a descriptor the browser refused. Neither is worth throwing over
          // in a per-frame call — the window keeps weaving on the rig it already has.
          return false;
        }
      },
      // Read-only counters, for pages that want to see the load-induced mono fallback rather
      // than wait for a bug report about "blinking". Scene windows only; 0/0 elsewhere.
      stats: () => ({ frames: win.frames, monoFrames: win.monoFrames }),
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
      // The rig this window's NEXT layer is built with. Latest wins, and it is kept on the
      // window rather than only pushed at the live layer because the lazy lifecycle destroys
      // and rebuilds layers behind the page's back: a tile that scrolls away and back would
      // otherwise silently revert to the default display rig mid-scene.
      viewRig: opts.viewRig || null,
      observeEl: opts.observe || canvas,
      ctx: kind === 'scene' ? null : canvas.getContext('2d'),
      repaint: () => this._paint(win, null),
      // Overlay exclusion (browser#18): explicit handle.exclude() elements and
      // [data-inline3d-overlay] descendants found by the auto-scan. Applied to the
      // layer on every (re-)activate; the browser clears its own set on layer close.
      excluded: new Set(),
      autoExcluded: new Set(),
      overlayObserver: null,
      // Box/dpr watch, live only while the window is (see _startSizeWatch).
      sizeObserver: null,
      resizePending: false,
      // Scene diagnostics (web#12), read back through the handle's stats(). frames counts
      // onFrame deliveries; monoFrames counts the ones that carried fewer than two views.
      frames: 0,
      monoFrames: 0,
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
    // Pick up page chrome (incl. late-mounted) before the exclusion loop below —
    // layers churn with scroll, so activations double as cheap rescan points.
    this._scanChrome();
    try {
      // What scale/pose the runtime should report views at. virtualDisplayHeight (display-rig
      // m2v) is the scalar shorthand; a viewRig is the whole descriptor and therefore replaces
      // it rather than combining with it. Building the layer WITH the rig (instead of
      // constructing then calling setViewRig) matters for a re-activated window: the layer's
      // very first located frame is already on the page's rig, so a tile scrolling back into
      // view never shows one frame of default framing.
      const init = win.viewRig
        ? { viewRig: win.viewRig }
        : win.virtualDisplayHeight > 0
          ? { virtualDisplayHeight: win.virtualDisplayHeight }
          : {};
      win.layer = new XRDisplayLayer(this.session, win.canvas, init);
    } catch {
      win.layer = null;
      return;
    }
    // First real layer: if the occlusion capability is per-instance, this is the earliest point
    // it can be read (see sampleDrawOrderOcclusion) — and if it says the browser occludes by
    // draw order, retire whatever legacy machinery already started before we could know.
    if (sampleDrawOrderOcclusion(win.layer) === true) this._standDownLegacyOcclusion();
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
    this._startSizeWatch(win);
  }

  _deactivate(win) {
    this._stopOverlayScan(win);
    this._stopSizeWatch(win);
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

  /**
   * Refuse a FULL-TILE overlay — an element whose rect is (near-)congruent with its own
   * window's canvas.
   *
   * The browser re-composites an excluded element by geometrically matching its rect to a
   * composited-layer quad (>=70% area overlap, see _scanChrome). A plate that covers the whole
   * tile matches the tile's OWN canvas quad, so the CANVAS gets staged as the overlay: it
   * leaves the weave input entirely and the tile presents its raw side-by-side buffer —
   * squished halves, no 3D. That is a destroyed tile, not a degraded one, so skip the
   * exclusion and say why instead of honouring it.
   *
   * The test is MUTUAL (>=70% of both rects) so page-global chrome stays legal: a sticky
   * header may cover a small tile completely, but the tile is a small fraction of the header,
   * so the header never looks congruent with any one canvas.
   *
   * Limit: it judges the rect it can measure now. A plate that is display:none at
   * registration measures empty (and excluding it is harmless while hidden), so a plate that
   * only becomes full-tile once shown slips through — the authoring rule stands on its own
   * (docs/authoring-inline-3d.md § 2D overlays ON a 3D window).
   */
  _isFullTileOverlay(win, el) {
    if (!el || typeof el.getBoundingClientRect !== 'function') return false;
    const e = el.getBoundingClientRect();
    const c = win.canvas.getBoundingClientRect();
    const eArea = e.width * e.height;
    const cArea = c.width * c.height;
    if (eArea <= 0 || cArea <= 0) return false; // hidden / detached — nothing to judge
    const iw = Math.min(e.right, c.right) - Math.max(e.left, c.left);
    const ih = Math.min(e.bottom, c.bottom) - Math.max(e.top, c.top);
    if (iw <= 0 || ih <= 0) return false;
    const inter = iw * ih;
    if (inter / eArea < FULL_TILE_OVERLAP || inter / cArea < FULL_TILE_OVERLAP) return false;
    if (!this._fullTileWarned.has(el)) {
      this._fullTileWarned.add(el);
      console.warn(
        '[inline3d] Refusing a full-tile overlay: this element covers its own woven canvas, ' +
          "and the browser's geometric matcher cannot tell the two apart — it would stage " +
          'the CANVAS as the overlay and the tile would show its raw side-by-side buffer ' +
          'instead of 3D. Make the overlay a PARTIAL region of the tile (a caption band, a ' +
          'badge, a corner plate), or move it outside the tile and register it with ' +
          'addGlobalOverlay().',
        el
      );
    }
    return true;
  }

  _applyExclusion(win, el) {
    // Automatic occlusion: nothing to declare, and nothing to promote. Returning here (before
    // the full-tile guard) is also why a full-tile plate is legal on such a browser — there is
    // no geometric matcher to confuse, so there is no refusal and no warning.
    if (hasDrawOrderOcclusion()) return;
    if (!win.layer || !hasExclusion()) return;
    if (this._isFullTileOverlay(win, el)) return;
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
    // Nothing was ever excluded or promoted, so there is nothing to undo — and in particular
    // this must not touch the element's `will-change`, which is the page's own here.
    if (hasDrawOrderOcclusion()) return;
    const refs = this._isolatedBy.get(el);
    if (refs) refs.delete(win);
    // Only un-promote once NO window needs this element isolated any more.
    if (!refs || refs.size === 0) this._unpromote(el);
    if (!win.layer || !hasExclusion()) return;
    try {
      win.layer.unexcludeElement(el);
    } catch {
      /* ignore */
    }
  }

  /**
   * Undo the SDK's own compositing promotion on `el`, restoring the `will-change` the page had
   * (which may be none). Only ever touches an element the SDK promoted — the marker dataset
   * flag is what says so. Returns whether there was anything to undo.
   */
  _unpromote(el) {
    if (!el || !el.dataset || !el.dataset.inline3dIsolated) return false;
    el.style.willChange = el.dataset.inline3dPriorWillChange || '';
    delete el.dataset.inline3dPriorWillChange;
    delete el.dataset.inline3dIsolated;
    return true;
  }

  /**
   * Retire the legacy occlusion machinery, once, on learning the browser occludes by draw order.
   *
   * Only reachable when the capability could not be read until the first layer existed (the
   * per-instance flag shape): by then one auto-chrome scan may have run and promoted page
   * furniture. Where the flag is readable up front — the shape this SDK asks for — nothing has
   * started and this finds nothing to do.
   *
   * Registrations the APP made are kept as API state (its `removeGlobalOverlay(el)` must still
   * find `el` registered); only the SDK's own side effects on the page's DOM are reversed. The
   * auto-chrome set is dropped entirely: it was never the app's, and nothing will re-add it.
   */
  _standDownLegacyOcclusion() {
    if (this._stoodDown) return;
    this._stoodDown = true;
    let retired = false;
    for (const win of this._windows.values()) {
      if (win.overlayObserver) {
        this._stopOverlayScan(win);
        retired = true;
      }
      for (const el of win.excluded) if (this._unpromote(el)) retired = true;
    }
    for (const el of this._autoChromeEls) {
      this._globalOverlays.delete(el);
      this._unpromote(el);
      retired = true;
    }
    this._autoChromeEls.clear();
    for (const el of this._globalOverlays) if (this._unpromote(el)) retired = true;
    this._isolatedBy = new WeakMap(); // every promotion is gone; the refcounts with them
    if (retired) noteAutomaticOcclusion(); // only worth saying if work was actually thrown away
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
    // No observer at all where occlusion is automatic: `data-inline3d-overlay` needs no
    // honouring, so a page keeps its attributes (harmless, portable) and pays no
    // MutationObserver per live tile.
    if (hasDrawOrderOcclusion()) return;
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

  /** The per-eye buffer size this window should have right now (explicit, or box × dpr). */
  _eyeSize(win) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    return {
      w: win.reqW || Math.round((win.canvas.clientWidth || 256) * dpr),
      h: win.reqH || Math.round((win.canvas.clientHeight || 256) * dpr),
    };
  }

  _sizeBuffer(win, sbs) {
    const { w: boxW, h: boxH } = this._eyeSize(win);
    win.eyeW = boxW;
    win.eyeH = boxH;
    win.canvas.width = sbs ? boxW * 2 : boxW; // SBS = two eye tiles wide
    win.canvas.height = boxH;
    win.sbs = sbs;
  }

  // ── box / devicePixelRatio changes ──────────────────────────────────────────────────
  //
  // _sizeBuffer runs at activate and deactivate ONLY, so a live window whose CSS box or
  // devicePixelRatio changes underneath it keeps its old backing store: the same SBS pixels
  // are stretched onto a differently-shaped box and the two eyes come out mis-squeezed, with
  // no error, until the tile happens to re-activate. A responsive reflow, a flex sibling
  // appearing, a browser zoom or a drag to a different-scale monitor all do it. So: watch the
  // box while the window is live, and re-derive the buffer when it actually moves.

  _startSizeWatch(win) {
    if (typeof ResizeObserver !== 'function') return;
    if (win.sizeObserver) return;
    // Scene canvases are the app's (ownsBuffer false) — never touch their width/height.
    // An explicit {width, height} is box-independent by definition, so nothing to watch.
    if (!win.ownsBuffer || (win.reqW && win.reqH)) return;
    win.sizeObserver = new ResizeObserver(() => this._onBoxChange(win));
    win.sizeObserver.observe(win.canvas);
  }

  _stopSizeWatch(win) {
    if (win.sizeObserver) {
      win.sizeObserver.disconnect();
      win.sizeObserver = null;
    }
    win.resizePending = false;
  }

  /**
   * Re-derive one live window's SBS buffer and repaint it. Debounced to one animation frame:
   * ResizeObserver and a dpr flip both fire in bursts during a drag-resize or a zoom, and
   * every resize reallocates the backing store and clears it.
   */
  _onBoxChange(win) {
    if (!win.layer || !win.ownsBuffer || win.resizePending) return;
    win.resizePending = true;
    const run = () => {
      if (!win.resizePending) return;
      win.resizePending = false;
      if (!win.layer || !win.ownsBuffer) return;
      const { w, h } = this._eyeSize(win);
      if (w === win.eyeW && h === win.eyeH) return; // observer fired, geometry didn't move
      this._sizeBuffer(win, /*sbs*/ true);
      this._paint(win, null); // repaint NOW: setting canvas.width cleared the buffer
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else run();
  }

  /**
   * devicePixelRatio is invisible to ResizeObserver — a browser zoom or a move to a
   * different-scale monitor leaves the CSS box the same number of CSS px while the buffer
   * that box deserves changes. A `(resolution: Ndppx)` query flips exactly when dpr leaves
   * its current value, so arm one, and re-arm it on the new value each time.
   */
  _armDprWatch() {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    this._disarmDprWatch();
    let q;
    try {
      q = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    } catch {
      return; // no resolution-query support: box changes are still covered
    }
    const onChange = () => {
      if (!this._running) return;
      this._armDprWatch(); // this query is stale the moment it fires
      for (const win of this._windows.values()) if (win.layer) this._onBoxChange(win);
    };
    try {
      q.addEventListener('change', onChange);
    } catch {
      return;
    }
    this._dprWatch = { q, onChange };
  }

  _disarmDprWatch() {
    if (!this._dprWatch) return;
    try {
      this._dprWatch.q.removeEventListener('change', this._dprWatch.onChange);
    } catch {
      /* ignore */
    }
    this._dprWatch = null;
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

  /**
   * Arm the next session frame. `force` starts a NEW loop even though one is nominally
   * pending: each loop carries an id and only the current id re-arms, so a stalled
   * predecessor (a bfcache restore whose callback never fired) is retired rather than
   * doubled if it ever does fire.
   */
  _requestFrame(force) {
    if (!this._running) return;
    if (this._framePending && !force) return;
    const id = force ? ++this._loopId : this._loopId;
    this._framePending = true;
    try {
      this.session.requestAnimationFrame((t, f) => {
        if (id !== this._loopId) return; // superseded loop — let it die here
        this._framePending = false;
        this._frameCount++;
        this._frame(t, f);
      });
    } catch {
      this._framePending = false; // session going away; 'end' → _teardown handles it
    }
  }

  _frame(t, f) {
    if (!this._running) return;
    this._requestFrame();
    const pose = this.refSpace ? f.getViewerPose(this.refSpace) : null;
    const views = pose ? pose.views : null;
    for (const win of this._windows.values()) {
      if (!win.layer) continue;
      if (win.kind === 'scene') {
        if (views && win.onFrame) {
          // Count the SHORT view lists and hand them over unchanged. Under GPU load the session
          // can report a single view (a per-frame mono fallback) where it normally reports two,
          // and a renderer that clears before it validates turns that into a dark tile
          // (web#12 — ./viewer now validates first and replays its last good frame instead).
          //
          // The core deliberately does NOT filter or synthesise: the contract is "here is what
          // the frame reported", and a window that can do something sensible with one view
          // (a mono preview, say) must be allowed to. What the core owes you is VISIBILITY —
          // this is otherwise invisible from the page, since nothing throws and nothing logs.
          win.frames++;
          if (views.length < 2) {
            win.monoFrames++;
            // 1-in-300 so a sustained rate is reported without the log itself becoming the load;
            // `% 300 === 1` also names the FIRST one immediately.
            if (win.monoFrames % 300 === 1 && typeof console !== 'undefined' && console.debug) {
              const pct = ((100 * win.monoFrames) / Math.max(1, win.frames)).toFixed(1);
              console.debug(
                `[inline3d] scene window: ${win.monoFrames} non-stereo view lists in ` +
                  `${win.frames} frames (${pct}%). The viewer replays its last good stereo ` +
                  'frame for these; a rising rate means the session is falling back under load.',
              );
            }
          }
          win.onFrame(views, win.layer, f);
        }
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

  // ── page lifecycle: bfcache, freeze, restore (browser#87) ───────────────────────────
  //
  // A weaved window's rect reaches the compositor from the session's own rAF: every frame the
  // live session pushes the full list of rects to weave, and the ONLY way to clear a rect is
  // to push a list without it. So a page that simply stops running frames leaves its last
  // list standing — the rects keep weaving over whatever is on screen now. Back/forward
  // navigation does exactly that: bfcache freezes the page mid-loop, the woven tiles stay
  // pinned where they were, and the next page inherits ghost 3D windows (browser#87).
  //
  // The fix is to make the LAST frames before suspension report an empty list: deactivate
  // every live window while frames still run, remember which ones were live, and restore them
  // on the way back. pagehide covers bfcache entry and unload; freeze covers a discarded
  // background tab where pagehide does not fire.

  _bindLifecycle() {
    if (typeof window === 'undefined') return;
    this._onPageHide = () => this._suspend();
    this._onPageShow = (e) => this._resume(!!(e && e.persisted));
    window.addEventListener('pagehide', this._onPageHide);
    window.addEventListener('pageshow', this._onPageShow);
    // Page Lifecycle API (Blink): a frozen tab never gets pagehide/pageshow.
    if (typeof document !== 'undefined' && 'onfreeze' in document) {
      this._onFreeze = () => this._suspend();
      this._onResume = () => this._resume(true);
      document.addEventListener('freeze', this._onFreeze);
      document.addEventListener('resume', this._onResume);
    }
  }

  _unbindLifecycle() {
    if (typeof window === 'undefined') return;
    if (this._onPageHide) window.removeEventListener('pagehide', this._onPageHide);
    if (this._onPageShow) window.removeEventListener('pageshow', this._onPageShow);
    if (this._onFreeze && typeof document !== 'undefined') {
      document.removeEventListener('freeze', this._onFreeze);
      document.removeEventListener('resume', this._onResume);
    }
    this._onPageHide = this._onPageShow = this._onFreeze = this._onResume = null;
    if (this._frameWatchdog) {
      clearTimeout(this._frameWatchdog);
      this._frameWatchdog = null;
    }
  }

  /** Close every live layer so the outgoing frames report an empty rect list. */
  _suspend() {
    if (!this._running || this._suspended) return;
    const was = [];
    for (const win of this._windows.values()) {
      if (win.layer) {
        was.push(win);
        this._deactivate(win);
      }
    }
    this._suspended = was;
  }

  /**
   * Coming back: re-arm the windows that were live. In lazy mode the IntersectionObserver
   * owns that decision, and re-observing re-delivers the CURRENT intersection state — so a
   * tile the user scrolled away from before leaving stays dark, and only what is actually on
   * screen re-weaves. Chrome is rescanned because a restored page may have remounted it.
   */
  _resume(persisted) {
    if (!this._running) return;
    const was = this._suspended;
    this._suspended = null;
    if (was) {
      for (const win of was) {
        if (!this._windows.has(win.canvas)) continue; // removed while we were away
        if (this._lazy && this._observer) {
          this._observer.unobserve(win.observeEl);
          this._observer.observe(win.observeEl);
        } else {
          this._activate(win);
        }
      }
    }
    this._lastChromeScan = 0; // the 1 s throttle must not swallow the restore rescan
    this._scanChrome();
    this._armDprWatch(); // the restore may be on a different-scale display
    if (persisted) this._watchForStalledFrames();
  }

  /**
   * A bfcache restore can hand back a session whose pending animation frame never arrives —
   * the loop was suspended between request and callback, and nothing re-issues it. The
   * manager then looks alive (`_running`) while no window ever paints again. Give it a second
   * to prove otherwise, then start a fresh loop (which retires the stalled one by id).
   */
  _watchForStalledFrames() {
    if (this._frameWatchdog || typeof setTimeout !== 'function') return;
    const before = this._frameCount;
    this._frameWatchdog = setTimeout(() => {
      this._frameWatchdog = null;
      if (!this._running || this._frameCount !== before) return; // frames arrived
      this._requestFrame(/*force*/ true);
    }, 1000);
  }

  _teardown() {
    if (!this._running) return;
    this._running = false;
    if (liveManager === this) liveManager = null;
    this._unbindLifecycle();
    this._disarmDprWatch();
    if (this._observer) this._observer.disconnect();
    for (const win of this._windows.values()) {
      this._stopOverlayScan(win);
      this._stopSizeWatch(win);
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

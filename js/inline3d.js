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

// Undock lives in its own module (it is a page-level action, not a per-frame concern, and it
// works standalone on a browser with no inline-3D at all). Imported here for ONE reason: to hand
// it a resolver so its API-first path can find the live XRDisplayLayer behind an element. The
// dependency runs one way — inline3d-undock.js imports nothing — so there is no cycle, and the
// three entry points are re-exported below so a page has a single import site.
import { undock, undockAvailable, undockUrl, tileScreenRect, setUndockLayerResolver } from './inline3d-undock.js';
export { undock, undockAvailable, undockUrl, tileScreenRect };

// The eased 2D<->3D transition. A pure state machine (no DOM, no WebXR) ported from the native
// `dxr::ModeSwitch`, so the browser eases the disparity around a mode switch the same way — and in
// the same ORDER — as the native apps and the demos. See _requestRenderingModeEased.
import {
  ModeSwitch,
  MODE_SWITCH_DEFAULT_DURATION_MS,
  MODE_SWITCH_DEFAULT_EASING,
  MODE_SWITCH_EASINGS,
  normaliseModeSwitchEasing,
} from './inline3d-mode-switch.js';

// The document's single live manager. The browser's per-frame element-rect report is a
// WHOLE-WIDGET setter — each live session pushes the complete list of rects to weave — so two
// managers in one document overwrite each other frame by frame and neither one's tiles hold
// still. Tracked here only to warn: sequential sessions (a route change that closes one
// manager and opens the next) are legitimate and the common case, so nothing is refused.
let liveManager = null;

// How the undock helper's API-first path finds the layer behind an element. Registered here
// because only this module knows the canvas -> window -> layer map; the helper stays importable
// on its own (with no resolver, every call takes the protocol fallback).
setUndockLayerResolver((el) => {
  const m = liveManager;
  if (!m || !m._running || !el) return null;
  // The canvas itself, then a woven canvas INSIDE the element (a card wrapping its tile), then
  // the element sitting inside a window's own container (a button in the tile's box). Anything
  // further away is not this window's rect and takes the fallback.
  // The session rides along: the viewer's exit is the XRSession's `undockend` event.
  const hit = (win) => ({ layer: win.layer, session: m.session });
  for (const win of m._windows.values()) if (win.canvas === el && win.layer) return hit(win);
  for (const win of m._windows.values()) {
    if (win.layer && typeof el.contains === 'function' && el.contains(win.canvas)) return hit(win);
  }
  for (const win of m._windows.values()) {
    const box = win.canvas.parentElement;
    if (win.layer && box && typeof box.contains === 'function' && box.contains(el)) return hit(win);
  }
  return null;
});

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
// Display modes — the display's own capabilities, and the one thing a page can ask it to
// change. Three methods, all on XRDisplayLayer, all promise-returning:
//
//   getDisplayInfo()          the panel: physical size, pixel size, the view scale it
//                             RECOMMENDS. Null on a machine with no glasses-free display.
//   getRenderingModes()       every mode the runtime can put the panel in — view count, tile
//                             grid, per-view pixels, whether it is a hardware-3D mode, which
//                             one is active, and whether the browser may request it.
//   requestRenderingMode(i)   switch the panel to mode i. The browser renders exactly TWO
//                             views, so a mode with viewCount > 2 is listed and refused; a
//                             ONE-view mode IS requestable and is how a page goes flat.
//
// THE HARDWARE DISPLAY STATE (2D/3D) IS NOT A SEPARATE CONTROL, and that is the whole shape of
// this API. It is a CONSEQUENCE of the active rendering mode: request a one-view mode and the
// browser puts the panel in its 2D state and reports that mode active (the runtime carries on
// weaving the same fixed two-view atlas); request the two-view mode and the panel goes back to
// 3D. The transition arrives as `hardwaredisplaystatechange`. There is deliberately NO
// page-facing request for the hardware state on its own: a page that could move the panel flat
// while still submitting stereo would be showing the woven atlas flat, which is a blurry double
// image rather than 2D. Tying the two together makes that state unreachable.
//
// Probed the same way as setViewRig, and for the same reason: these are METHODS, so reading
// them off the prototype is a plain data-property read that calls nothing (an IDL *attribute*
// getter would throw `Illegal invocation` on the very browser that has it). All three are
// required — a browser with a partial set is a browser mid-implementation, and treating it as
// supported would hand a page a `requestRenderingMode is not a function` at the worst moment.
const DISPLAY_MODE_METHODS = ['getDisplayInfo', 'getRenderingModes', 'requestRenderingMode'];
// The two display events, fired on the XRSession rather than the layer — so a page hears about a
// mode or hardware-state change even while its tile's layer is closed (lazy mode), and one
// subscription covers every window in the document.
const DISPLAY_EVENTS = ['renderingmodechange', 'hardwaredisplaystatechange'];
const hasDisplayModes = () => {
  if (!hasLayer()) return false;
  try {
    const proto = window.XRDisplayLayer.prototype;
    return DISPLAY_MODE_METHODS.every((m) => typeof proto[m] === 'function');
  } catch {
    return false; // a prototype that refuses to be probed is not a capability
  }
};
// Undock (XRDisplayLayer.undock / getUndockCapabilities) — lifting this window's asset out of
// the page into a floating native viewer over the desktop. Same METHOD probe, same reason. The
// helper in ./inline3d-undock.js falls back to the `displayxr-view:` OS protocol where this is
// absent, so a page never has to branch on it; what it IS good for is deciding whether to show
// an "undock" affordance at all (see `wall.undock`).
const hasUndock = () => {
  if (!hasLayer()) return false;
  try {
    return typeof window.XRDisplayLayer.prototype.undock === 'function';
  } catch {
    return false;
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

/**
 * True when this browser exposes the DISPLAY-MODE API — `getDisplayInfo()`,
 * `getRenderingModes()` and `requestRenderingMode()` on the tile handle, i.e. the page can read
 * what the panel is and ask it to change. Sync + cheap; implies {@link inline3DAvailable}.
 *
 * Reads a capability (the presence of all three methods on `XRDisplayLayer.prototype`), never a
 * version or UA string, and demands ALL THREE: a browser shipping half the set is one mid-
 * implementation, and calling it supported would surface as a `not a function` inside a click
 * handler rather than as a feature that is simply absent.
 *
 * Everything the API drives is optional enhancement — the window weaves identically without it —
 * so a page needs this only to decide whether to SHOW display controls. The handle methods
 * themselves reject with a clear Error rather than throwing at import or create time.
 */
export function inline3dDisplayModesSupported() {
  return inline3DAvailable() && hasDisplayModes();
}

/**
 * True when this browser can UNDOCK a window's asset into a floating native viewer through
 * `XRDisplayLayer.undock()` — i.e. without the `displayxr-view:` protocol prompt the fallback
 * path needs. Sync + cheap; implies {@link inline3DAvailable}.
 *
 * A page does not have to branch on this to undock (the helper falls back on its own); it is the
 * probe for whether `wall.undock` carries capabilities, and for a UI that wants to say WHICH
 * asset kinds this build can float.
 */
export function inline3dUndockSupported() {
  return inline3DAvailable() && hasUndock();
}

// The rig `virtualDisplayHeight` is shorthand for: a display rig, identity pose, all factors 1.
// Written out here because the automatic 1-view collapse has to be able to say "the default rig,
// but flat", and there is no way to express that as a scalar — the whole descriptor has to be sent.
function defaultDisplayRig(win) {
  return {
    type: 'display',
    position: { x: 0, y: 0, z: 0 },
    orientation: { x: 0, y: 0, z: 0, w: 1 },
    virtualDisplayHeight: win.virtualDisplayHeight > 0 ? win.virtualDisplayHeight : 0.24,
    ipdFactor: 1,
    parallaxFactor: 1,
    perspectiveFactor: 1,
  };
}

// The page's rig with the stereo dialled DOWN by `factor`: eye separation and head-tracking
// response scaled together, so `factor` 0 renders both eyes from the SAME place (the woven atlas
// carries one image twice) and `factor` 1 is exactly what the page asked for. Everything between
// is the eased 2D<->3D transition (see ModeSwitch) — which is why this is a scale and not a
// boolean: a flat panel and a full-disparity one are the two ENDS of one continuum.
//
// A COPY, never a mutation. A page driving a rig per frame reuses one descriptor object
// (cameraRigFromCamera's `out`), so scaling the factors in place would write the flattening into
// the page's own state and it would never come back — the restore would restore 0.
//
// An unset factor is the runtime's default of 1, so it scales like an explicit 1 rather than
// staying absent: a rig that says nothing about disparity still goes flat.
function scaledRig(rig, factor) {
  const ipd = Number.isFinite(rig.ipdFactor) ? rig.ipdFactor : 1;
  const parallax = Number.isFinite(rig.parallaxFactor) ? rig.parallaxFactor : 1;
  return { ...rig, ipdFactor: ipd * factor, parallaxFactor: parallax * factor };
}

// How often the fallback tick advances a transition when session frames are NOT arriving (a
// background tab, every tile scrolled away). Roughly one 60 Hz frame — the ramp is time-based, so
// this is a floor on smoothness, never on duration.
const MODE_SWITCH_TICK_MS = 16;

// Wall clock for the transition ramp, in ms. Read through the global on every call (never
// captured) so a test can install its own clock, and so a page that runs before `performance`
// exists still gets a monotonic-enough source. Frame COUNTS are deliberately not used: the ramp
// has to take the same time at 30 fps and at 144 fps.
function nowMs() {
  return typeof performance !== 'undefined' && performance && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

// The easing option, validated here rather than in the state machine: the sequencer falls back
// silently (it has no opinion about a caller's config), but a typo in `createInline3D` is worth
// exactly one warning — a page that asked for 'ease-in-out' and got smoothstep should know.
let notedModeSwitchEasing = false;
function resolveModeSwitchEasing(easing) {
  if (easing === undefined || easing === null) return MODE_SWITCH_DEFAULT_EASING;
  const known = normaliseModeSwitchEasing(easing);
  if (known) return known;
  if (!notedModeSwitchEasing) {
    notedModeSwitchEasing = true;
    console.warn(
      `[inline3d] createInline3D({ modeSwitch: { easing: ${JSON.stringify(easing)} } }) is not a ` +
        `curve this SDK knows (${MODE_SWITCH_EASINGS.join(' / ')}); using ` +
        `'${MODE_SWITCH_DEFAULT_EASING}'.`
    );
  }
  return MODE_SWITCH_DEFAULT_EASING;
}

// Why the SDK collapses the rig behind the page's back, said once, where the code is.
let notedAutoCollapse = false;
function noteAutoCollapse() {
  if (notedAutoCollapse) return;
  notedAutoCollapse = true;
  console.info(
    '[inline3d] The active rendering mode is 1-view, so this SDK has zeroed every window rig ' +
      '(ipdFactor/parallaxFactor -> 0) — both eyes now render from one place. The runtime keeps ' +
      'weaving the same two-view atlas whatever the page submits, so leaving stereo in it would ' +
      'put two slightly different images on a flat panel, i.e. a blurry double image instead of ' +
      '2D. Your rendering is unchanged; the flattening is a copy applied on the way to the layer ' +
      'and it is undone the moment a 2-view mode goes active again.'
  );
}

// ── reading the two display events ──────────────────────────────────────────────────────
//
// The payload is read DEFENSIVELY, in the shape the 0128-era handling already established: an
// event's own `detail` when it carries one, and otherwise the event object itself. A browser
// mid-implementation carried nothing at all and the state had to be read back — which still
// works, because an unreadable payload leaves the value unknown and the mode list answers it.
// `!== undefined` rather than `in`: a CustomEvent always HAS a `detail` property, and a null one
// is not a payload.
function eventDetail(e) {
  return e && e.detail !== undefined && e.detail !== null ? e.detail : undefined;
}
function eventPayloads(e) {
  const d = eventDetail(e);
  return d !== undefined ? [d, e] : [e];
}
/** The new active mode index an event carries — a bare number, `.modeIndex`, or `.mode`. -1 = not stated. */
function eventModeIndex(e) {
  for (const src of eventPayloads(e)) {
    if (typeof src === 'number' && Number.isFinite(src)) return src;
    if (src && typeof src === 'object') {
      const v = src.modeIndex !== undefined ? src.modeIndex : src.mode;
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
  }
  return -1;
}
/** The hardware display state an event carries — a bare '2d'/'3d' or `.state`. null = not stated. */
function eventHardwareState(e) {
  for (const src of eventPayloads(e)) {
    if (src === '2d' || src === '3d') return src;
    if (src && typeof src === 'object') {
      const v = src.state !== undefined ? src.state : src.hardwareDisplayState;
      if (v === '2d' || v === '3d') return v;
    }
  }
  return null;
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
    '[inline3d] addScene got BOTH viewRig and virtualDisplayHeight; on a browser with rig ' +
      'support the rig wins and the height is dropped. They describe the same slot — ' +
      'virtualDisplayHeight is shorthand for exactly one rig (display, identity pose, all ' +
      'factors 1) — so there is no merge. This is only worth passing as a PAIR deliberately: ' +
      'the height is what a browser without setViewRig will use, so a camera-rig scene can ' +
      'name its own fallback framing. Otherwise say it once, inside the rig.'
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
 * @param {object} [opts.modeSwitch]  The EASED 2D<->3D transition, on by default.
 *        `{ durationMs=180, easing='smoothstep'|'linear'|'easeoutcubic', enabled=true }` — the
 *        same defaults the native DisplayXR apps configure. Instead of snapping the stereo rig
 *        the moment the panel's mode changes, a page-initiated switch ramps every window's
 *        `ipdFactor`/`parallaxFactor` between 0 and what the page asked for, in the order that
 *        looks right: going FLAT ramps the disparity out first and only then asks the panel to
 *        switch, and coming BACK asks first and eases the disparity in once the panel reports
 *        3D. `enabled:false` restores the plain snap. It is aesthetic policy only — the runtime
 *        keeps the eye set coherent either way — and a mode change the page did NOT request
 *        (another tab, the shell, a panel opening flat) always snaps, because there is nothing
 *        to ramp from. Read the live state on `wall.modeSwitch`.
 * @returns {Promise<Inline3D | {supported:false, error?:Error}>} the manager, which also carries
 *        the display API (`getDisplayInfo` / `getRenderingModes` / `requestRenderingMode` /
 *        `setStereoEnabled`, `on`/`off`) and `undock` — `{model, splat}` on a browser with
 *        `XRDisplayLayer.undock`, `null` on one without.
 */
export async function createInline3D(opts = {}) {
  const {
    referenceSpace = 'viewer',
    lazy = true,
    rootMargin = '50% 0px',
    autoChrome = true,
    modeSwitch = null,
  } = opts;
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
  return new Inline3D(session, refSpace, { lazy, rootMargin, autoChrome, modeSwitch });
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
  constructor(session, refSpace, { lazy, rootMargin, autoChrome = true, modeSwitch = null }) {
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
    // ── display state ────────────────────────────────────────────────────────────────
    // What the panel is doing, as last REPORTED (the first getRenderingModes read, then every
    // renderingmodechange / hardwaredisplaystatechange). Never what was last requested: a
    // refused request must leave every one of these untouched.
    this._activeModeIndex = -1;
    this._activeViewCount = 0; // 0 = not read yet
    this._hardwareDisplayState = null; // '2d' | '3d' | null (never reported)
    this._modes = null; // last getRenderingModes() result, for the viewCount lookup
    // The rig-collapse latch, MANAGER-wide because the mode is the display's, not a window's.
    // While true every rig that leaves for a layer is pushed flat (a copy — each window's own
    // `viewRig` always holds what the page asked for, untouched).
    this._stereoCollapsed = false;
    this._displayListeners = new Map(); // event type -> Set(callback), for on()/off()
    this._primedDisplayState = false;
    // ── the eased 2D<->3D transition (opts.modeSwitch) ───────────────────────────────
    // The collapse above is a LATCH; what actually reaches each layer is that latch turned into a
    // SCALE — `_stereoFactor`, 0 (flat) to 1 (exactly the rig the page set). With the sequencer
    // off, or for a mode change the page did not request, the scale is only ever 0 or 1 and
    // nothing looks different. With it on, a page-initiated switch walks the scale across that
    // range over `durationMs` and holds the mode request until the right end of the ramp.
    const msOpts = modeSwitch && typeof modeSwitch === 'object' ? modeSwitch : {};
    this._msEnabled = msOpts.enabled !== false;
    this._modeSwitch = new ModeSwitch(
      (Number.isFinite(msOpts.durationMs) ? Math.max(0, msOpts.durationMs) : MODE_SWITCH_DEFAULT_DURATION_MS) / 1000,
      resolveModeSwitchEasing(msOpts.easing)
    );
    this._stereoFactor = 1; // what every window's ipd/parallax is multiplied by on the way out
    this._msFire = null; // a ->2D request HELD until the ramp-down lands
    this._msArmedUp = false; // a ->3D request went out; the up-ramp waits for the panel to say 3D
    this._msLastMs = null; // wall clock of the previous advance (null = the ramp has not ticked)
    this._msTick = null; // the frames-stopped fallback timer; see _armModeSwitchTick
    // Undock capabilities, refreshed off the first live layer (see _refreshUndock). Null is the
    // load-bearing value: it means this browser has no XRDisplayLayer.undock at all.
    this.undock = hasUndock() ? { model: false, splat: false } : null;
    this._undockRead = false;
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
    this._bindDisplayEvents();
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
   *        frame with `handle.setViewRig()`. Ignored on a browser without rig support, which
   *        falls back to `virtualDisplayHeight` if one was given (that pair is the one reason
   *        to pass both) — either way the window still weaves.
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
       *
       * While `setStereoEnabled(false)` is in force the rig you pass here is STORED AS GIVEN and
       * pushed FLAT (ipd/parallax 0) — the flattening is a latch on the way out, not a value
       * written into your descriptor, so a page driving a rig every frame cannot undo the 2D
       * state by simply carrying on, and `setStereoEnabled(true)` restores exactly what you last
       * asked for. During the eased 2D<->3D transition the same applies with a FRACTION in place
       * of the 0: what leaves for the layer is your rig scaled by `wall.modeSwitch.factor`.
       */
      setViewRig: (rig) => {
        win.viewRig = rig || null;
        return this._pushViewRig(win);
      },
      /**
       * The panel this window is weaving on: physical size in metres, pixel size, and the view
       * scale the runtime RECOMMENDS. Resolves null on a machine with no glasses-free display.
       *
       * `recommendedViewScaleX/Y` are ADVISORY. The browser cannot resize a page's canvas, so
       * nothing applies them for you: a page honours them by sizing its OWN backing store
       * (canvas.width/height, `renderer.setSize`) to `viewPixels x scale`. Ignoring them costs
       * sharpness or fill rate, never correctness.
       *
       * @returns {Promise<object|null>}
       */
      getDisplayInfo: () => this._layerCall(win, 'getDisplayInfo', 'getDisplayInfo()'),
      /**
       * Every rendering mode the runtime can put this display in, as reported by the runtime:
       * `{modeIndex, modeName, viewCount, viewScaleX, viewScaleY, tileColumns, tileRows,
       * viewWidthPixels, viewHeightPixels, hardwareDisplay3D, isActive, isRequestable}`.
       *
       * The list is the DISPLAY's, not the browser's, so it includes modes this browser cannot
       * drive: the browser is fixed at TWO views, so any mode with `viewCount !== 2` is reported
       * with `isRequestable: false` and `requestRenderingMode` refuses it. Show those rows — they
       * are what the panel can do — but mark them, don't offer them.
       *
       * @returns {Promise<ReadonlyArray<object>>}
       */
      getRenderingModes: () => this._getRenderingModes(win),
      /**
       * Ask the runtime to switch the display to the mode with this `modeIndex`. A thin
       * pass-through — it resolves and rejects exactly as the browser does.
       *
       * Rejects with a `TypeError` for a mode with `viewCount > 2` (the browser renders exactly
       * two views and cannot fill a 4-view atlas — no view synthesis exists anywhere in this
       * stack) or an unknown index, and with a `NotSupportedError` `DOMException` when the
       * request was not forwardable. The browser raises the TypeError SYNCHRONOUSLY; this
       * pass-through is async, so it reaches you as a rejection either way and one `.catch()`
       * covers both. On a browser without the API at all it rejects with a plain Error saying so.
       *
       * A ONE-VIEW MODE IS REQUESTABLE, and requesting it is how a page goes flat: the browser
       * puts the panel in its 2D hardware state and reports that mode active. The SDK then
       * collapses every window's rig automatically (see {@link setStereoEnabled}) off the
       * resulting `renderingmodechange` — so the request itself changes nothing about your
       * rendering, and a REFUSED request changes nothing at all.
       *
       * On success the session fires `renderingmodechange` — see {@link on}. That event, not
       * this promise, is when the new mode is in effect.
       *
       * EASED BY DEFAULT (`createInline3D({modeSwitch})`). A GOING-FLAT request (`viewCount === 1`)
       * is HELD while the disparity ramps out, and forwarded only when it lands — so this promise
       * resolves when the browser actually got the request, roughly `durationMs` later, and the
       * panel flips on already-flat content. A request that a reversal drops in that window
       * rejects with an `Error` named `superseded`; nothing was ever asked of the display. Coming
       * BACK is unchanged in timing: the request goes out at once and the disparity eases in when
       * the panel reports 3D.
       *
       * @param {number} modeIndex
       * @returns {Promise<void>}
       */
      requestRenderingMode: (modeIndex) => this._requestRenderingModeEased(modeIndex, win),
      /**
       * SUGAR over {@link requestRenderingMode}, and nothing more. `false` requests the first
       * mode with `viewCount === 1 && isRequestable`; `true` requests the first with
       * `viewCount === 2 && isRequestable`. It never touches the hardware display state
       * directly — there is no such call in this API — and it never touches your rig.
       *
       * THE RIG COLLAPSE IS NOT PART OF THIS CALL. When a 1-view mode actually goes ACTIVE the
       * SDK zeroes every window's `ipdFactor`/`parallaxFactor` on the way to the layer, and
       * restores them when a 2-view mode goes active; that is driven by the
       * `renderingmodechange` event (and by the first `getRenderingModes()` read), so it happens
       * however the mode changed — this call, another tab, the shell — and a request that is
       * REFUSED leaves everything exactly as it was, in both directions.
       *
       * The flattening is a COPY pushed at the layer, never a write into your descriptor: a page
       * driving `setViewRig` every frame keeps having its rig stored intact and pushed flat, and
       * the restore is exactly the rig it last asked for. A page that never set a rig gets the
       * exact descriptor equivalent of its `virtualDisplayHeight`.
       *
       * Rejects when no such mode is listed (a plain Error naming what was looked for), and
       * otherwise exactly as `requestRenderingMode` does. Resolves to the boolean asked for —
       * the request was accepted; the mode is in force when the event says so.
       *
       * Eased by default, exactly as {@link requestRenderingMode} is: `false` ramps the disparity
       * out before the request goes anywhere, `true` requests first and eases the disparity back
       * in once the panel reports 3D, and pressing the pair in quick succession reverses cleanly
       * rather than firing a stale switch.
       *
       * @param {boolean} enabled
       * @returns {Promise<boolean>}
       */
      setStereoEnabled: (enabled) => this._setStereoEnabled(enabled, win),
      /**
       * Subscribe to one display event, re-emitted on this handle:
       *
       *   `renderingmodechange`        `{type, modeIndex, viewCount, mode, detail}`
       *   `hardwaredisplaystatechange` `{type, state:'2d'|'3d', detail}`
       *
       * They originate on the XRSession, not on the layer — so they arrive even for a window
       * whose layer is currently closed, and a page that only wants to KNOW does not have to
       * hold a live tile. `detail` is the browser's own payload, kept as-is.
       *
       * Returns an unsubscribe function; `off(type, cb)` does the same. Inert (returns a no-op)
       * on a browser without the API.
       *
       * @param {'renderingmodechange'|'hardwaredisplaystatechange'} type
       * @param {(e:object) => void} cb
       * @returns {() => void}
       */
      on: (type, cb) => this.on(type, cb),
      /** Drop a listener registered with {@link on}. */
      off: (type, cb) => this.off(type, cb),
      /**
       * BOTH display events through one callback — the older shape, kept because pages use it.
       * The callback gets the same normalised object `on()` delivers (`{type, ...}` plus
       * `detail`). Returns an unsubscribe function.
       *
       * @param {(e:{type:string, detail:any}) => void} cb
       * @returns {() => void}
       */
      onDisplayModeChange: (cb) => this._onDisplayModeChange(cb),
      // Read-only counters, for pages that want to see the load-induced mono fallback rather
      // than wait for a bug report about "blinking". Scene windows only; 0/0 elsewhere.
      stats: () => ({ frames: win.frames, monoFrames: win.monoFrames }),
    };
  }

  // ── the display (wall level) ──────────────────────────────────────────────────────────
  //
  // The panel is the DOCUMENT's, not a tile's: one display, one active rendering mode, one
  // hardware state. These four are the same calls the tile handles carry (kept there because
  // pages use them), routed through whichever window currently holds a live layer — so they
  // keep working while a lazy tile is scrolled away, as long as ANY tile is live.

  /** The panel: physical size, pixel size, the view scale it recommends. Null where there is none. */
  getDisplayInfo() {
    return this._layerCall(this._liveWindow(null), 'getDisplayInfo', 'getDisplayInfo()');
  }

  /** Every rendering mode the runtime can put this display in. See the handle's doc comment. */
  getRenderingModes() {
    return this._getRenderingModes(null);
  }

  /** Ask the runtime to switch the display to `modeIndex`. Pass-through; see the handle's doc. */
  requestRenderingMode(modeIndex) {
    return this._requestRenderingModeEased(modeIndex, null);
  }

  /** Sugar over {@link requestRenderingMode}: false -> a 1-view mode, true -> the 2-view mode. */
  setStereoEnabled(enabled) {
    return this._setStereoEnabled(enabled, null);
  }

  /**
   * The hardware display state as last REPORTED by `hardwaredisplaystatechange` — `'2d'`,
   * `'3d'`, or `null` when the browser has not said yet. Never what was last requested.
   */
  get hardwareDisplayState() {
    return this._hardwareDisplayState;
  }

  /** The active mode's index and view count as last read/reported. `viewCount` 0 = not read yet. */
  get activeMode() {
    return { modeIndex: this._activeModeIndex, viewCount: this._activeViewCount };
  }

  /** True while the SDK is holding every window's rig flat because a 1-view mode is active. */
  get stereoCollapsed() {
    return this._stereoCollapsed;
  }

  /**
   * The eased 2D<->3D transition, live: `{active, factor}`.
   *
   * `factor` is what every window's `ipdFactor`/`parallaxFactor` is being multiplied by on the way
   * to the layer — `1` in 3D, `0` flat, in between mid-ramp. `active` is true while a
   * page-initiated switch is in any of its phases: ramping the disparity out, holding the ->2D
   * request until it lands, waiting for the panel to report 3D, or easing back in.
   *
   * Read-only and purely informational — a page that wants to grey a button or cross-fade some 2D
   * chrome alongside the panel can, and one that does not care never has to look. The SDK adds no
   * UI of its own for this, and never will: which key or button toggles the display is the page's.
   */
  get modeSwitch() {
    return { active: this._msTransitionActive(), factor: this._stereoFactor };
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

  // ── view rig + display modes ──────────────────────────────────────────────────────────

  /**
   * The rig this window's layer should actually be holding right now: what the page asked for,
   * scaled by the manager's current stereo factor (0 while a 1-view mode is active, 1 in 3D, and
   * everything between during an eased transition). Null means "say nothing" — leave the browser
   * on the `virtualDisplayHeight` shorthand it was built with.
   *
   * Used in BOTH directions (push at a live layer, build a new one), which is the point: a tile
   * that scrolls away and rebuilds while stereo is off must not come back in 3D.
   */
  _effectiveViewRig(win) {
    if (this._stereoFactor >= 1) {
      // `stereoSynthRig`: this window never had a rig of its own, so going flat had to SEND one
      // (there is no way to say "the default, but flat" as a scalar). Coming back therefore has
      // to send the un-flat version explicitly too — returning null here would leave the layer
      // holding the flattened rig forever. The descriptor it sends is the exact equivalent of the
      // `virtualDisplayHeight` the layer was built with, so nothing about the framing moves.
      return win.viewRig || (win.stereoSynthRig ? defaultDisplayRig(win) : null);
    }
    // Going flat has to SEND a descriptor even for a window that never had a rig of its own
    // (there is no way to say "the default, but flat" as a scalar), and that fact has to be
    // remembered: coming back must then send the un-flat version explicitly, or the layer would
    // hold the flattened rig forever. Recorded here rather than in the collapse itself because a
    // window CREATED while the panel is already flat goes down this path on its first activate.
    if (!win.viewRig) win.stereoSynthRig = true;
    return scaledRig(win.viewRig || defaultDisplayRig(win), this._stereoFactor);
  }

  /**
   * Latch (or release) the manager-wide rig collapse and push every window's rig again.
   *
   * Driven ONLY by what the display reports — the first `getRenderingModes()` read and every
   * `renderingmodechange` — never by a request. That is what makes a refused request a no-op in
   * both directions: nothing here runs unless the mode actually changed.
   *
   * THE REPORT OWNS THE FACTOR ONLY WHEN THE SEQUENCER DOES NOT. A mode change the page did not
   * ask for (another tab, the shell, a panel that opened flat) snaps, because there is nothing to
   * ramp FROM — the transition is a page-initiated aesthetic, not a correctness step. The two
   * exceptions are the two halves of a page-initiated switch: while a ramp is in flight it owns
   * the factor outright, and a report of 3D that a `->3D` request armed starts the up-ramp here
   * rather than snapping (the whole reason that request fires first and eases second).
   */
  _setStereoCollapsed(collapsed) {
    const next = !!collapsed;
    if (this._stereoCollapsed === next) return;
    this._stereoCollapsed = next;
    if (next) noteAutoCollapse();
    if (!next && this._msArmedUp) {
      this._msArmedUp = false;
      this._startUpRamp(); // the panel is in 3D at last — ease the disparity back in
    } else if (!this._modeSwitch.active()) {
      this._stereoFactor = next ? 0 : 1;
    }
    for (const win of this._windows.values()) {
      // Diagnostics only: the factors that were in force when the panel went flat. The restore
      // itself just re-pushes `win.viewRig`, which was never mutated.
      if (next) {
        const rig = win.viewRig || defaultDisplayRig(win);
        win.stereoSaved = { ipdFactor: rig.ipdFactor, parallaxFactor: rig.parallaxFactor };
      } else {
        win.stereoSaved = null;
      }
      this._pushViewRig(win);
    }
  }

  /**
   * Push the effective rig at the live layer. Returns whether it reached one — the boolean
   * `handle.setViewRig` documents ("false = stored, and it will build the next layer").
   */
  _pushViewRig(win) {
    if (!hasViewRig()) {
      noteNoViewRig();
      return false;
    }
    if (!win.layer) return false;
    const rig = this._effectiveViewRig(win);
    try {
      win.layer.setViewRig(rig);
      return true;
    } catch {
      // A closed layer or a descriptor the browser refused. Neither is worth throwing over in a
      // per-frame call — the window keeps weaving on the rig it already has.
      return false;
    }
  }

  /**
   * Forward one display-mode call to this window's live layer, as a promise.
   *
   * Two ways it cannot proceed, and they are DIFFERENT failures worth different messages: the
   * browser has no such API at all (nothing will ever make this work — check
   * `inline3dDisplayModesSupported()` first), or the API is there but this window has no live
   * layer yet (lazy mode, scrolled away, or called before the first activation — try again once
   * the tile is on screen). Neither throws synchronously: these sit behind click handlers and a
   * rejected promise is what a page can actually handle.
   */
  _layerCall(win, method, label, args = []) {
    if (!hasDisplayModes()) {
      return Promise.reject(
        new Error(
          `[inline3d] ${label} needs a DisplayXR Browser with the display-mode API ` +
            '(XRDisplayLayer.getDisplayInfo/getRenderingModes/requestRenderingMode). ' +
            'Gate on inline3dDisplayModesSupported().'
        )
      );
    }
    // `win` is null when the WALL-level call ran with no window live at all — the same failure
    // as a window whose layer is closed, and the same message covers both.
    if (!win || !win.layer) {
      return Promise.reject(
        new Error(
          `[inline3d] ${label} needs a live weave layer, and this window has none right now ` +
            '(lazy mode closes the layer while the tile is off screen). Call it once the tile ' +
            'is visible, or create the manager with { lazy: false }.'
        )
      );
    }
    // Wrapped so a SYNCHRONOUS throw from the browser (requestRenderingMode raises TypeError
    // that way for a non-2-view mode) arrives as a rejection like every other failure.
    try {
      return Promise.resolve(win.layer[method](...args));
    } catch (e) {
      return Promise.reject(e);
    }
  }

  /** The first window currently holding a live layer, or null. Every display call needs one. */
  _liveWindow(preferred) {
    if (preferred && preferred.layer) return preferred;
    for (const win of this._windows.values()) if (win.layer) return win;
    return preferred || null;
  }

  /**
   * `getRenderingModes()` with the manager's cache kept honest — every read updates the list the
   * event path looks `viewCount` up in, and the first one PRIMES the display state (a page can
   * open with the panel already flat, and the rig has to be collapsed for that too).
   */
  async _getRenderingModes(win) {
    const list = await this._layerCall(
      this._liveWindow(win),
      'getRenderingModes',
      'getRenderingModes()'
    );
    const modes = Array.isArray(list) ? list : [];
    this._modes = modes;
    const active = modes.find((m) => m.isActive);
    if (active) {
      this._activeModeIndex = active.modeIndex;
      this._activeViewCount = active.viewCount;
      if (active.viewCount === 1 || active.viewCount === 2) {
        this._setStereoCollapsed(active.viewCount === 1);
      }
    }
    this._primedDisplayState = true;
    return list;
  }

  /** `requestRenderingMode()` — a pass-through; see the handle's doc comment for the contract. */
  _requestRenderingMode(modeIndex, win) {
    return this._layerCall(
      this._liveWindow(win),
      'requestRenderingMode',
      'requestRenderingMode()',
      [modeIndex]
    );
  }

  // ── the eased 2D<->3D transition ──────────────────────────────────────────────────────
  //
  // Every PAGE-INITIATED mode request goes through here; a mode change reported from elsewhere
  // does not (see _setStereoCollapsed). The asymmetry below is the whole helper, and it is the
  // native `dxr::ModeSwitch` contract, unchanged:
  //
  //   -> 2D : ramp the disparity out FIRST, and fire the request only when it lands, so the panel
  //           flips on already-flat content instead of snapping a stereo image flat.
  //   -> 3D : fire the request FIRST and ease the disparity in afterwards — and in the browser,
  //           only once the panel REPORTS 3D, because until then the disparity would be going up
  //           on a flat panel, which is the double-image the whole mode API exists to prevent.
  //
  // Everything else is fall-through: the sequencer disabled, a browser with no `setViewRig` (there
  // is nothing to ramp), an unknown target or current view count, a `viewCount > 2` mode the
  // browser will refuse anyway, and a same-dimensionality change (2D->2D, 3D->3D) which needs no
  // flatten at all.

  /** True while a page-initiated transition is in flight in any of its phases. */
  _msTransitionActive() {
    return this._modeSwitch.active() || this._msArmedUp || this._msFire !== null;
  }

  /**
   * `requestRenderingMode()` with the transition applied. Resolves when the request has actually
   * been FORWARDED to the browser (so, for a ->2D switch, after the ramp) and rejects exactly as
   * the pass-through does — plus one new failure: an `Error` named `superseded` when a second
   * request replaced this one before it ever fired.
   */
  async _requestRenderingModeEased(modeIndex, win) {
    if (!this._msEnabled || !hasViewRig()) return this._requestRenderingMode(modeIndex, win);
    // The mode table is what says whether this index is 2D or 3D. It is normally already cached
    // (the first activation primes it), and a read that fails just means the sequencer has no
    // opinion — the request still goes out.
    let modes = this._modes;
    if (!Array.isArray(modes) || modes.length === 0) {
      try {
        modes = await this._getRenderingModes(win);
      } catch {
        modes = null;
      }
    }
    const target = (Array.isArray(modes) ? modes : []).find((m) => m && m.modeIndex === modeIndex);
    const targetViews = target && Number.isFinite(target.viewCount) ? target.viewCount : 0;
    const currentViews = this._activeViewCount;
    if (targetViews < 1 || targetViews > 2 || currentViews < 1) {
      return this._requestRenderingMode(modeIndex, win);
    }
    if (targetViews === 1) {
      if (currentViews === 1) return this._requestRenderingMode(modeIndex, win); // 2D -> 2D
      return this._rampDownThenRequest(modeIndex, win);
    }
    return this._requestThenRampUp(modeIndex, win);
  }

  /**
   * 3D -> 2D. Ramp the disparity to 0, THEN forward the request (see _advanceModeSwitch, which is
   * what actually fires it). The returned promise is the page's, and it settles on the forwarded
   * request — so `await wall.setStereoEnabled(false)` still means "the browser has it".
   *
   * A second ->2D request for the SAME mode mid-ramp is idempotent: the page gets the promise
   * already in flight rather than a superseded rejection, because mashing one button twice is not
   * an error. A different target retargets from the CURRENT disparity, seamlessly.
   */
  _rampDownThenRequest(modeIndex, win) {
    if (this._msFire && this._msFire.modeIndex === modeIndex) return this._msFire.promise;
    this._settlePendingDown('superseded', `a request for mode ${modeIndex} replaced it`);
    const pending = { modeIndex, win, resolve: null, reject: null, promise: null };
    pending.promise = new Promise((resolve, reject) => {
      pending.resolve = resolve;
      pending.reject = reject;
    });
    this._msFire = pending;
    this._modeSwitch.request({
      targetMode: modeIndex,
      targetViewCount: 1,
      currentMode: this._activeModeIndex,
      currentViewCount: this._activeViewCount,
      // The value ON SCREEN right now: the ramp's own output mid-flight, and the page's steady
      // rig (factor 1) when idle. Passing the sequencer's internal 0 while idle is the classic
      // first-press snap — there would be nothing to ramp down from.
      current: this._stereoFactor,
      steady: 1,
    });
    this._msLastMs = nowMs();
    this._armModeSwitchTick();
    return pending.promise;
  }

  /**
   * -> 3D. Forward the request NOW (the browser needs the panel moving before the disparity can
   * mean anything), then ease the disparity in — starting only when the panel REPORTS 3D, which
   * is `_setStereoCollapsed(false)` releasing the latch.
   *
   * The one case that does not wait: a REVERSAL of a ramp-down that never fired. The panel never
   * left 3D, so there is no report coming; the disparity just walks back up from wherever the
   * ramp got to, and the stale 2D request is dropped rather than fired.
   */
  _requestThenRampUp(modeIndex, win) {
    const reversal = this._msFire !== null;
    const noopReversal = reversal && modeIndex === this._activeModeIndex;
    this._settlePendingDown('superseded', `a request for mode ${modeIndex} reversed it`);
    // A reversal back to the mode that is STILL active asks the browser for nothing: the runtime
    // never changed mode, so the only thing owed is the disparity.
    const forwarded = noopReversal
      ? Promise.resolve(undefined)
      : this._requestRenderingMode(modeIndex, win);
    if (this._stereoFactor < 1) {
      if (this._stereoCollapsed) {
        // The panel is really flat: hold at 0 and wait for it to say otherwise.
        this._msArmedUp = true;
        this._modeSwitch.cancel();
        this._stereoFactor = 0;
      } else {
        this._startUpRamp();
      }
    }
    return forwarded.catch((err) => {
      // Refused. Nothing about the panel moved, so neither may the disparity: drop the armed
      // up-ramp and settle back on whatever the display last REPORTED.
      if (this._msArmedUp) {
        this._msArmedUp = false;
        if (!this._modeSwitch.active()) this._stereoFactor = this._stereoCollapsed ? 0 : 1;
      }
      throw err;
    });
  }

  /**
   * Start (or restart) the up-ramp from the current disparity to the page's steady rig. Used both
   * when the panel reports 3D after a `->3D` request and when a ->2D request was REFUSED — a
   * refusal must leave the page in 3D, not flat.
   *
   * No request is ever fired from here: whatever there was to send went out before the ramp
   * started, which is why `_msFire` is empty by construction.
   */
  _startUpRamp() {
    this._settlePendingDown('superseded', 'the display returned to 3D');
    this._modeSwitch.request({
      targetMode: this._activeModeIndex,
      targetViewCount: 2,
      currentMode: this._activeModeIndex, // equal ⇒ the sequencer fires nothing
      currentViewCount: 2,
      current: this._stereoFactor,
      steady: 1,
    });
    this._msLastMs = nowMs();
    this._armModeSwitchTick();
  }

  /** Settle a held ->2D request that will now never fire. Never throws into the caller. */
  _settlePendingDown(name, why) {
    const pending = this._msFire;
    if (!pending) return;
    this._msFire = null;
    const err = new Error(
      `[inline3d] the request for rendering mode ${pending.modeIndex} was never forwarded: ${why}. ` +
        'A ->2D switch is held until the disparity has ramped out, so a request that is reversed ' +
        'or replaced in that window is dropped rather than fired late.'
    );
    err.name = name;
    pending.reject(err);
  }

  /**
   * Advance the transition by WALL-CLOCK dt and act on what it says. Called from the session's
   * frame loop and from the fallback tick; both are safe because the ramp is time-based, so a
   * double advance in one frame moves it by dt = 0.
   *
   * Rigs are pushed only when the factor actually MOVED — an idle manager must not re-push every
   * frame, and a landed ramp pushes its last value once.
   */
  _advanceModeSwitch() {
    if (!this._modeSwitch.active()) {
      this._msLastMs = null;
      this._disarmModeSwitchTick();
      return;
    }
    const now = nowMs();
    const dt = typeof this._msLastMs === 'number' ? Math.max(0, (now - this._msLastMs) / 1000) : 0;
    this._msLastMs = now;
    const out = this._modeSwitch.update(dt);
    if (out.factor !== this._stereoFactor) {
      this._stereoFactor = out.factor;
      for (const win of this._windows.values()) this._pushViewRig(win);
    }
    if (out.fire && this._msFire) {
      const pending = this._msFire;
      this._msFire = null;
      this._requestRenderingMode(pending.modeIndex, pending.win).then(
        (v) => pending.resolve(v),
        (err) => {
          // The panel refused to go flat, so the page must not be left flat either — ease the
          // disparity back to steady before handing the rejection on.
          this._startUpRamp();
          pending.reject(err);
        }
      );
    }
    if (!this._modeSwitch.active()) {
      this._msLastMs = null;
      this._disarmModeSwitchTick();
    }
  }

  /**
   * A timer that advances the ramp when SESSION FRAMES are not arriving. The frame loop is the
   * normal driver, but a held ->2D request must not sit forever because every tile scrolled away,
   * the tab went background, or the page simply has no live layer — the page awaited a promise
   * and the browser is owed a request.
   */
  _armModeSwitchTick() {
    if (this._msTick !== null || typeof setTimeout !== 'function') return;
    this._msTick = setTimeout(() => {
      this._msTick = null;
      if (!this._running) return;
      this._advanceModeSwitch();
      if (this._modeSwitch.active()) this._armModeSwitchTick();
    }, MODE_SWITCH_TICK_MS);
  }

  _disarmModeSwitchTick() {
    if (this._msTick === null) return;
    if (typeof clearTimeout === 'function') clearTimeout(this._msTick);
    this._msTick = null;
  }

  /**
   * The sugar behind `setStereoEnabled` — pick a mode by view count and request it. Nothing
   * else: the rig follows the resulting `renderingmodechange` (eased, when a transition is
   * configured), not this call.
   */
  async _setStereoEnabled(enabled, win) {
    const want = enabled ? 2 : 1;
    const modes = await this._getRenderingModes(win);
    const list = Array.isArray(modes) ? modes : [];
    const mode = list.find((m) => m.viewCount === want && m.isRequestable);
    if (!mode) {
      throw new Error(
        `[inline3d] setStereoEnabled(${!!enabled}) found no requestable ${want}-view mode on ` +
          `this display (${list.length} mode(s) listed). It is sugar over requestRenderingMode() ` +
          'and cannot invent one — read getRenderingModes() and drive the list yourself.'
      );
    }
    // Already there ⇒ the request would be a no-op... UNLESS a transition is in flight, in which
    // case this is the user reversing the toggle and the disparity still has to walk back. Taking
    // the early-out there would leave a page that pressed 2D then 3D stuck part-way flat.
    if (mode.isActive && !this._msTransitionActive()) return !!enabled;
    await this._requestRenderingModeEased(mode.modeIndex, win);
    return !!enabled;
  }

  // ── display events ────────────────────────────────────────────────────────────────────

  /**
   * Subscribe the manager ONCE to each session event and fan out from there. One subscription
   * per document rather than one per caller, because the SDK has to act on these itself (the
   * automatic rig collapse) whether or not the page is listening.
   */
  _bindDisplayEvents() {
    const session = this.session;
    if (!session || typeof session.addEventListener !== 'function') return;
    if (!hasDisplayModes()) return;
    session.addEventListener('renderingmodechange', (e) => {
      this._onRenderingModeChange(e).catch(() => {});
    });
    session.addEventListener('hardwaredisplaystatechange', (e) => {
      this._onHardwareDisplayStateChange(e).catch(() => {});
    });
  }

  /**
   * The hardware display state moved. The browser's event is payload-free (an XRSessionEvent),
   * so the state is READ, not parsed: under the mode-only contract the page-facing active mode's
   * `hardwareDisplay3D` IS the hardware state by construction (a 1-view mode is presented for
   * exactly as long as the hardware is in the state it declares; a 2-view mode's default state
   * is what the runtime restored). A payload, if a future browser adds one, wins over the read.
   */
  _onHardwareDisplayStateChange(e) {
    const stated = eventHardwareState(e);
    const detail = eventDetail(e);
    const deliver = (state) => {
      if (state) this._hardwareDisplayState = state;
      this._emitDisplay({
        type: 'hardwaredisplaystatechange',
        state: state || this._hardwareDisplayState,
        detail,
      });
    };
    // A stated payload is delivered synchronously (a page can act in the same task); the
    // browser's payload-free event is delivered once the table has been read below.
    if (stated) deliver(stated);
    // Re-read the table either way and adopt what it says the active mode is. This is what
    // carries the 1-view -> 2-view RETURN: the browser presents a 1-view mode on top of the
    // runtime's unchanged 2-view mode, so when the page asks for the 2-view mode back the
    // runtime has no mode change to report and fires no renderingmodechange - only the
    // hardware moves. Read here, that return still restores the rig, and in the right order
    // (hardware back in 3D first, then the parallax comes back).
    // _getRenderingModes adopts the active mode (and moves the rig) itself; remember what was
    // active BEFORE the read so a change can still be told to the page afterwards.
    const prevIndex = this._activeModeIndex;
    const prevViews = this._activeViewCount;
    return this._getRenderingModes(null)
      .then((list) => {
        const active = (Array.isArray(list) ? list : []).find((m) => m.isActive) || null;
        if (active && (active.modeIndex !== prevIndex || active.viewCount !== prevViews)) {
          this._emitDisplay({
            type: 'renderingmodechange',
            modeIndex: this._activeModeIndex,
            viewCount: this._activeViewCount || null,
            mode: active,
            detail: null,
          });
        }
        if (!stated) {
          const read = active && typeof active.hardwareDisplay3D === 'boolean' ? (active.hardwareDisplay3D ? '3d' : '2d') : null;
          deliver(read);
        }
      })
      .catch(() => {
        // no live layer / no API: the stated payload already went out; a payload-free event is
        // still delivered with whatever was last known.
        if (!stated) deliver(null);
      });
  }

  /**
   * A rendering mode went active. Two jobs, in this order: learn its VIEW COUNT (which is what
   * the rig collapse turns on, and which only the mode list carries), then tell the page.
   *
   * The list is re-read rather than trusted from cache — it is the runtime's, and a mode can
   * change under us — but the read is best-effort: with no live layer the index the event
   * carried is all there is, and the event is still worth delivering.
   */
  async _onRenderingModeChange(e) {
    const detail = eventDetail(e);
    const evIndex = eventModeIndex(e);
    let mode = null;
    try {
      const list = await this._getRenderingModes(null);
      const arr = Array.isArray(list) ? list : [];
      mode = (evIndex >= 0 ? arr.find((m) => m.modeIndex === evIndex) : null) || arr.find((m) => m.isActive) || null;
    } catch {
      /* no live layer / no API — fall through to what the event itself said */
    }
    if (mode) {
      this._activeModeIndex = mode.modeIndex;
      this._activeViewCount = mode.viewCount;
    } else if (evIndex >= 0) {
      this._activeModeIndex = evIndex;
    }
    // Only ever driven by a REPORTED view count. An unknown one (the read failed) leaves the rig
    // exactly as it is — half-collapsing on a guess is worse than being one event late.
    if (this._activeViewCount === 1 || this._activeViewCount === 2) {
      this._setStereoCollapsed(this._activeViewCount === 1);
    }
    this._emitDisplay({
      type: 'renderingmodechange',
      modeIndex: this._activeModeIndex,
      viewCount: this._activeViewCount || null,
      mode,
      detail,
    });
  }

  /** Deliver one normalised display event to every listener. A throwing page handler is contained. */
  _emitDisplay(ev) {
    const set = this._displayListeners.get(ev.type);
    if (!set) return;
    for (const cb of [...set]) {
      try {
        cb(ev);
      } catch (err) {
        console.error(`[inline3d] ${ev.type} listener threw`, err);
      }
    }
  }

  /**
   * Listen for `renderingmodechange` / `hardwaredisplaystatechange` on this manager. See the
   * handle's `on()` doc for the payload shapes. Returns an unsubscribe function.
   */
  on(type, cb) {
    if (typeof cb !== 'function') throw new TypeError('[inline3d] on() takes (type, function).');
    if (!DISPLAY_EVENTS.includes(type)) {
      throw new TypeError(
        `[inline3d] on() knows ${DISPLAY_EVENTS.join(' / ')}, got ${JSON.stringify(type)}.`
      );
    }
    let set = this._displayListeners.get(type);
    if (!set) this._displayListeners.set(type, (set = new Set()));
    set.add(cb);
    return () => this.off(type, cb);
  }

  /** Drop a listener registered with {@link on}. */
  off(type, cb) {
    const set = this._displayListeners.get(type);
    if (set) set.delete(cb);
  }

  /** Both display events through one callback — the older shape. Returns an unsubscribe. */
  _onDisplayModeChange(cb) {
    if (typeof cb !== 'function') {
      throw new TypeError('[inline3d] onDisplayModeChange() takes a function.');
    }
    const offs = DISPLAY_EVENTS.map((type) => this.on(type, cb));
    return () => {
      for (const off of offs) off();
    };
  }

  // ── undock ────────────────────────────────────────────────────────────────────────────

  /**
   * Re-read `layer.getUndockCapabilities()` into `wall.undock`.
   *
   * `undock` starts as `{model:false, splat:false}` on a browser that HAS the API, because the
   * capabilities can only be read off a live layer and there is none at create time — false is
   * the honest pre-read value ("not known to work"), and `null` is reserved for the thing a page
   * actually branches on: no `XRDisplayLayer.undock` at all. Called automatically on the first
   * layer activation; call it again whenever a page wants a fresh answer.
   *
   * @returns {Promise<{model:boolean, splat:boolean}|null>}
   */
  async refreshUndock() {
    if (!hasUndock()) return (this.undock = null);
    const win = this._liveWindow(null);
    if (!win || !win.layer || typeof win.layer.getUndockCapabilities !== 'function') {
      return this.undock;
    }
    try {
      const caps = await win.layer.getUndockCapabilities();
      this.undock = { model: !!(caps && caps.model), splat: !!(caps && caps.splat) };
    } catch {
      /* a refusal is not a capability change — keep the last answer */
    }
    return this.undock;
  }

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
      // The automatic 1-view collapse (the latch itself is manager-wide — the mode is the
      // display's, not this window's). `stereoSaved` records the factors in force when the panel
      // went flat, for diagnostics; the restore just re-pushes `viewRig`, which the flattening
      // never touched. `stereoSynthRig` records that this window's LAYER has been handed an
      // explicit rig at least once, so coming back has to send the un-flat one explicitly.
      stereoSaved: null,
      stereoSynthRig: false,
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
      //
      // The rig is only offered to a browser that HAS rigs. An older one would take the init
      // object, find no member it knows, and fall back to its own default height — so a page
      // that passed both (a camera rig plus the height an older browser should use) would get
      // neither. Gating here is what makes that fallback pair actually work.
      //
      // _effectiveViewRig, not win.viewRig: while setStereoEnabled(false) is latched the rig is
      // the FLAT one, and a window with no rig of its own still gets one (the exact descriptor
      // equivalent of its virtualDisplayHeight, with the factors zeroed) — otherwise a tile that
      // scrolled away in 2D would rebuild itself in 3D behind the page's back.
      const rig = hasViewRig() ? this._effectiveViewRig(win) : null;
      const init = rig
        ? { viewRig: rig }
        : win.virtualDisplayHeight > 0
          ? { virtualDisplayHeight: win.virtualDisplayHeight }
          : {};
      win.layer = new XRDisplayLayer(this.session, win.canvas, init);
    } catch {
      win.layer = null;
      return;
    }
    // Nothing about the hardware state is re-asserted here, and that is the point: the panel's
    // mode is the DISPLAY's, it survives a tile scrolling away, and this SDK never requests it
    // behind the page's back. The rig went into the init above already flattened if a 1-view
    // mode is active (_effectiveViewRig), which is the only half a new layer has to be told.
    //
    // FIRST LAYER, FIRST READ. The display's capabilities can only be read off a live layer, so
    // this is the earliest point the SDK can learn (a) which mode is active — a page can open
    // with the panel already flat, and the rig has to be collapsed for that too — and (b) what
    // this build can undock. Both best-effort and unawaited: they run inside the scroll-driven
    // activation path and must never break it.
    if (!this._primedDisplayState && hasDisplayModes()) {
      this._primedDisplayState = true; // one attempt per manager, not one per activation
      this._getRenderingModes(win).catch(() => {
        this._primedDisplayState = false; // the read failed; let the next activation try again
      });
    }
    if (hasUndock() && this.undock && !this._undockRead) {
      this._undockRead = true;
      this.refreshUndock().catch(() => {});
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
    // The 2D<->3D ramp, on WALL-CLOCK dt (never a frame count, so it lasts the same wall time at
    // 30 fps and 144 fps). Before the windows, so the rig this frame's views are located against
    // is the ramped one. No-op — and pushes nothing — when no transition is in flight.
    this._advanceModeSwitch();
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
    // A transition in flight dies with the session: nothing will drive the ramp, and the held
    // request has nowhere to go — so the page's promise is settled rather than left pending.
    this._disarmModeSwitchTick();
    this._modeSwitch.cancel();
    this._msArmedUp = false;
    this._settlePendingDown('closed', 'the inline-3D session closed first');
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
    // Page listeners go with the session that fed them: a manager whose session has ended will
    // never emit again, and holding the callbacks would keep the page's closures alive.
    this._displayListeners.clear();
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
// edge — but note that is the hardware WISH MASK (it drives the hardware display state, never
// content); this is the content-side equivalent, and the two are independent.
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

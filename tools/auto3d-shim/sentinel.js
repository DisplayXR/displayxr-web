// DisplayXR auto-3D — the sentinel. PROTOTYPE, not a product.
//
// `function dxrSentinel(cfg, cap)`: the only part evaluated in every frame at document start
// (dist/auto3d-sentinel.js). The host calls it with the frozen per-frame `cfg` and the capability
// object `cap` (see core.js's header); neither is ever put on `window`. It is small on purpose:
// on a page with no engine it is all that ever runs, and the core (cap.loadCore()) is never parsed.
//
// What it owns:
//   - the DisplayXR check (inert anywhere else) and the double-injection marker: a value-only
//     `window[Symbol.for('dxr.auto3d')] = true`; the first injector wins (a dev extension and the
//     product injector in one browser);
//   - `S.intrinsics`: browser built-ins snapshotted before any page script can patch them (risk
//     R4 — the core and the chip load late);
//   - the `navigator.xr.requestSession` wrapper (risk R3): a page that asks for inline-3d /
//     immersive-* itself owns XR, and the core must hear of it even when the request comes first;
//   - engine DETECTION, and loading the core LAZILY, at most once, only when an engine is found:
//       three.js    the `__THREE_DEVTOOLS__` EventTarget (three r105+ announces its revision and
//                   every renderer / scene to it). The core loads synchronously inside the
//                   listener for the first 'register' / 'observe' event, and that event and every
//                   later one are forwarded to the core's three.js adapter.
//       PlayCanvas  the AppBase constructor's `AppBase._applications[canvas.id] = this`: a canvas
//                   `id` read arms a one-shot setter for exactly that key on Object.prototype for
//                   the rest of the task (removed at the next microtask checkpoint); the engine's
//                   assignment lands on it and hands over the app. The `id` read is watched with a
//                   PER-INSTANCE accessor on the canvas (never on Element.prototype: a prototype
//                   accessor slows every element's id read, risk R2), armed (a) on every <canvas>
//                   in the DOM at readystatechange → 'interactive' — before deferred / module
//                   scripts run, and `new Application(canvas)` reads the id BEFORE it creates the
//                   context (risk R1) — (b) on every <canvas> ADDED to the document, parser- or
//                   script-inserted, through one MutationObserver (childList + subtree on the
//                   document) from document start until an app is found / the traps come off / the
//                   first mutation after load + 10 s (it disconnects itself: no timer), and (c) on
//                   a canvas's first webgl / webgl2 / experimental-webgl getContext(). The first
//                   WebGL context also starts the
//                   globals search: `window.pc.app`, `pc.AppBase.getApplication()`, `window.app`,
//                   in the next microtask, at DOMContentLoaded / load, then every 500 ms, 40 times
//                   (once per document). There is NO `window.pc` accessor ('pc' in window stays
//                   false). A canvas trap is removed once an app is found, on a '2d' context, or
//                   10 s after load. The core loads only when an app is actually found.
//     Not seen (PlayCanvas): a canvas created by script with no global AND handed to
//     `new Application()` in the SAME task that inserted it (or before inserting it) — the
//     observer's callback is a microtask, so the id is read before the trap exists, and before the
//     context does. The sentinel says so, once, in the console. A canvas inserted in one task and
//     used in a later one (the launcher pattern: create, insert, await config / scripts, then
//     `new Application`) is armed by the observer and found.
//   - once a canvas goes live (any engine), the core calls S.settle(canvas): the PlayCanvas search
//     (poll, id traps, observer) stops, unless a DIFFERENT canvas has a WebGL context, and restarts if
//     one gets one later. S.disarm() (the core standing down for good) takes everything off for good.
//   - the page's opt-out, `<meta name="displayxr-auto3d" content="off">` (S.optedOut()): checked on
//     the first WebGL context and again when an engine is found; opted out = the core is never
//     loaded, the traps come off, one { status: 'optout' } report, one console line. Once the core
//     is loaded it asks S.optedOut() itself (before activating, and every 30 session frames).
//   - a USER block (cfg.decision === 'block', outside dev): detect-only. The core is NEVER loaded;
//     once an engine is detected the sentinel reports { status: 'off', engine } once (so the
//     browser can offer a re-enable) and takes its traps off. The requestSession wrapper stays
//     installed under block: it costs nothing and keeps the stand-down correct should the site be
//     enabled later in this document's life (a dev toggle). In dev the core still loads under
//     block (on detection): the HUD and Ctrl+Alt+3 need it.
//   - a page that owns XR (foreign) before any engine is found, outside dev: nothing to convert, so
//     the traps come off and the core is never loaded (the dev build still loads it, for the HUD).
//
// PAGE-VISIBLE surface (everything a page script could observe), with no engine on the page:
//   1. `window.__THREE_DEVTOOLS__` — a configurable, non-enumerable accessor holding an EventTarget
//      (only when cfg.engines.three !== false);
//   2. `HTMLCanvasElement.prototype.getContext` — replaced by a wrapper (the only prototype change;
//      only when cfg.engines.playcanvas !== false);
//   3. `navigator.xr.requestSession` — replaced by a wrapper (own property of the XRSystem);
//   4. an own, non-enumerable `id` accessor on armed <canvas> elements (none on a page without
//      canvases), plus, for the rest of a task in which an armed canvas's id was read, a one-shot
//      non-enumerable setter for that key on Object.prototype;
//   and the value-only symbol marker above. No timer, no listener beyond one 'readystatechange' and
//   the one MutationObserver on the document (not page-visible), no other window key, no prototype
//   descriptor anywhere else.
function dxrSentinel(cfg, cap) {
  const TAG = '[dxr-auto3d]';
  const MARK = Symbol.for('dxr.auto3d');
  if (window[MARK]) return; // another injector armed this document first
  if (typeof window.XRDisplayLayer !== 'function' || !navigator.xr) return; // not the DisplayXR Browser: inert
  try { Object.defineProperty(window, MARK, { value: true }); } catch (e) { return; }

  // Built-ins the sentinel itself calls after page scripts ran (R4): captured now, called through
  // the captured Reflect.apply (never `.call`, which a page can patch).
  const apply = Reflect.apply;
  const defProp = Object.defineProperty;
  const qsa = Document.prototype.querySelectorAll;
  const byTag = Document.prototype.getElementsByTagName;
  const getAttr = Element.prototype.getAttribute;
  const micro = queueMicrotask;
  const sTimeout = setTimeout, cTimeout = clearTimeout;
  const MO = typeof MutationObserver === 'function' ? MutationObserver : null;
  const perfNow = performance.now.bind(performance);
  const info = (...a) => console.info(TAG, ...a);

  // ------------------------------------------------------------ intrinsics (R4)
  const gopd = (o, k) => { const d = Object.getOwnPropertyDescriptor(o, k); return d ? Object.freeze(d) : null; };
  const intrinsics = Object.freeze({
    attachShadow: Element.prototype.attachShadow,
    showPopover: HTMLElement.prototype.showPopover || null,
    elementsFromPoint: Document.prototype.elementsFromPoint,
    canvasWidth: gopd(HTMLCanvasElement.prototype, 'width'),
    canvasHeight: gopd(HTMLCanvasElement.prototype, 'height'),
    elementId: gopd(Element.prototype, 'id'),
  });

  // ------------------------------------------------------------ navigator.xr: yield to the page (R3)
  // Our own requests go straight to the captured original (S.xrRequest), so the wrapper only ever
  // sees the page's (or the immersive shim's, which reaches the real XRSystem through this object).
  let foreign = null;
  const foreignCbs = [];
  const xrObj = navigator.xr;
  const xrReqOrig = xrObj.requestSession;
  const xrRequest = (mode, init) => apply(xrReqOrig, xrObj, [mode, init]);
  try {
    xrObj.requestSession = function (mode, init) {
      if (mode === 'inline-3d' || mode === 'immersive-vr' || mode === 'immersive-ar') {
        const reason = `the page requested '${mode}'`;
        if (!foreign) { foreign = reason; onForeignEarly(); }
        for (const cb of foreignCbs.slice()) { try { cb(reason); } catch (e) { /* the core logs its own */ } }
      }
      return apply(xrReqOrig, xrObj, [mode, init]);
    };
  } catch (e) { console.warn(TAG, 'could not watch navigator.xr.requestSession — SDK pages may conflict', e); }

  // ------------------------------------------------------------ state
  const en = cfg.engines || {};
  const blocked = cfg.decision === 'block' && !cfg.dev;
  let core = null;     // what dxrCore returned, once loaded
  let done = false;    // detection finished without a core (opted out / blocked and reported / foreign / load failed)

  // ------------------------------------------------------------ the page's opt-out
  let opted = false;
  function optedOut() {
    if (opted) return true;
    let list = null;
    try { list = apply(qsa, document, ['meta[name="displayxr-auto3d" i]']); } catch (e) { return false; }
    for (let i = 0; i < list.length; i++) {
      const c = apply(getAttr, list[i], ['content']);
      if (typeof c === 'string' && c.trim().toLowerCase() === 'off') {
        opted = true; // sticky for the document
        disarm();
        return true;
      }
    }
    return false;
  }

  // ------------------------------------------------------------ reports the sentinel makes itself
  const reported = new Set();
  const reportOnce = (r) => {
    if (reported.has(r.status)) return;
    reported.add(r.status);
    try { cap.report(r); } catch (e) { /* ignore */ }
  };
  const reportOff = (engine) => reportOnce({ status: 'off', engine });

  // Every detection signal goes through here. engine = null for a bare WebGL context (only the
  // opt-out is checked); a name when an engine is found (the core loads, unless blocked). Returns
  // the core, or null.
  function signal(engine) {
    if (core) return core;
    if (done) return null;
    if (optedOut()) {
      done = true;
      info('this page opted out (<meta name="displayxr-auto3d" content="off">): staying 2D');
      reportOnce({ status: 'optout' });
      return null;
    }
    if (!engine) return null;
    if (blocked) { done = true; disarm(); reportOff(engine); return null; }
    let make = null;
    try { make = cap.loadCore(); } catch (e) { console.warn(TAG, 'the core could not be loaded', e); }
    if (typeof make !== 'function') { done = true; disarm(); return null; }
    core = make(cfg, cap, S);
    return core;
  }
  // A page that owns XR before any engine was found: outside dev there is nothing left to detect.
  function onForeignEarly() {
    if (core || done || cfg.dev) return;
    done = true;
    disarm();
  }

  // ------------------------------------------------------------ three.js: __THREE_DEVTOOLS__
  let devtools = null;
  if (en.three !== false) {
    const onObserve = (e) => { const c = signal('three.js'); if (c && c.three) c.three.observe(e); };
    const onRegister = (e) => { const c = signal('three.js'); if (c && c.three) c.three.register(e); };
    const hooked = new WeakSet();
    const attachHook = (t) => {
      if (!t || typeof t.addEventListener !== 'function' || hooked.has(t)) return;
      hooked.add(t);
      t.addEventListener('observe', onObserve);
      t.addEventListener('register', onRegister);
    };
    devtools = window.__THREE_DEVTOOLS__ || new EventTarget();
    attachHook(devtools);
    try {
      // An accessor, so the real three.js devtools extension can still install its own object and
      // we keep listening on whatever is there.
      defProp(window, '__THREE_DEVTOOLS__', {
        configurable: true, enumerable: false,
        get: () => devtools,
        set: (v) => { devtools = v; attachHook(v); },
      });
    } catch (e) { window.__THREE_DEVTOOLS__ = devtools; }
  }

  // ------------------------------------------------------------ PlayCanvas
  const isApp = (a) =>
    !!a && typeof a === 'object' && typeof a.tick === 'function' && typeof a.on === 'function' &&
    typeof a.fire === 'function' && 'graphicsDevice' in a && !!a.systems;
  const nsOf = (pc) => (pc && typeof pc === 'object' && (pc.AppBase || pc.Application) ? pc : null);
  let pcFound = false;
  let retired = false;  // S.disarm(): nothing is armed again in this document
  function foundPC(app, how, ns) {
    if (pcFound) return;
    pcFound = true;
    disarmCanvases(); // the id traps have done their job
    stopPoll();
    unobserve();
    let g = null;
    try { g = window.pc; } catch (e) { /* ignore */ }
    const c = signal('PlayCanvas');
    if (c && c.playcanvas) c.playcanvas.consider(app, how, ns || nsOf(g));
  }

  // The per-instance canvas id traps (R1, R2).
  const ID = intrinsics.elementId;
  const armed = new Map(); // canvas -> the time its trap expires (Infinity until the page's load)
  let loaded = document.readyState === 'complete';
  let sweepT = 0;
  const keyTraps = new Set();
  function removeKeyTrap(key) {
    if (!keyTraps.has(key)) return;
    keyTraps.delete(key);
    try { delete Object.prototype[key]; } catch (e) { /* ignore */ }
  }
  function trapKey(key) {
    if (typeof key !== 'string' || keyTraps.has(key) || key === '__proto__' || key in Object.prototype) return;
    keyTraps.add(key);
    try {
      defProp(Object.prototype, key, {
        configurable: true, enumerable: false,
        get() { return undefined; },
        set(v) {
          removeKeyTrap(key);
          defProp(this, key, { value: v, writable: true, enumerable: true, configurable: true });
          if (isApp(v)) foundPC(v, 'AppBase constructor (canvas-id trap)');
        },
      });
    } catch (e) { keyTraps.delete(key); return; }
    micro(() => removeKeyTrap(key));
  }
  function arm(c) {
    if (done || pcFound || retired || armed.has(c) || !ID || !ID.get || !ID.set) return;
    try {
      defProp(c, 'id', {
        configurable: true, enumerable: false,
        get() {
          const v = apply(ID.get, this, []);
          if (!done && !pcFound) trapKey(v);
          return v;
        },
        set(v) { apply(ID.set, this, [v]); },
      });
    } catch (e) { return; }
    armed.set(c, loaded ? perfNow() + 10000 : Infinity);
    scheduleSweep();
  }
  function unarm(c) {
    if (!armed.delete(c)) return;
    try { delete c.id; } catch (e) { /* ignore */ }
  }
  function disarmCanvases() {
    for (const c of [...armed.keys()]) unarm(c);
    if (sweepT) { cTimeout(sweepT); sweepT = 0; }
  }
  function scheduleSweep() {
    if (sweepT || !loaded || !armed.size) return;
    let t = Infinity;
    for (const v of armed.values()) t = Math.min(t, v);
    sweepT = sTimeout(sweep, Math.max(0, t - perfNow()));
  }
  function sweep() {
    sweepT = 0;
    const n = perfNow();
    for (const [c, t] of [...armed]) if (t <= n) unarm(c);
    scheduleSweep();
  }

  // The globals search, started by the first WebGL context (once per document).
  let polling = false, polls = 0, pollT = 0, glCanvas = null;
  function lookGlobals() {
    if (done || pcFound) return;
    let pc = null;
    try { pc = window.pc; } catch (e) { /* ignore */ }
    if (pc && typeof pc === 'object') {
      const ns = nsOf(pc);
      try { if (isApp(pc.app)) { foundPC(pc.app, 'window.pc.app', ns); return; } } catch (e) { /* ignore */ }
      try { const a = pc.AppBase && pc.AppBase.getApplication && pc.AppBase.getApplication(); if (isApp(a)) { foundPC(a, 'pc.AppBase.getApplication()', ns); return; } } catch (e) { /* ignore */ }
    }
    try { if (isApp(window.app)) foundPC(window.app, 'window.app', nsOf(pc)); } catch (e) { /* ignore */ }
  }
  function startPoll() {
    if (polling || retired) return;
    polling = true; polls = 0;
    micro(lookGlobals);
    document.addEventListener('DOMContentLoaded', lookGlobals, { once: true });
    window.addEventListener('load', lookGlobals, { once: true });
    pollT = sTimeout(poll, 500);
  }
  function poll() {
    pollT = 0;
    if (done || pcFound) return;
    lookGlobals();
    if (done || pcFound) return;
    if (++polls < 40) { pollT = sTimeout(poll, 500); return; }
    if (core) return; // three.js (or another path) loaded the core: this canvas is accounted for
    // Nothing found, and nothing left that could find it: say why, once.
    info(`a WebGL canvas (${descCanvas(glCanvas)}) but no supported engine found — left 2D.`,
      'A three.js page announces itself (r105+); a PlayCanvas app is found through window.pc / window.app, or through its',
      'canvas id when the <canvas> is in the HTML before deferred / module scripts run. A canvas created by script with no',
      'global is not visible (an engine-side announce hook would fix it).');
  }
  function stopPoll() { if (pollT) { cTimeout(pollT); pollT = 0; } }

  // The parse-time observer (R1 (b) above). Cheap on purpose: the callback never walks the mutation
  // records (2,000 parser-inserted nodes cost ~0.5 ms to visit from JS); it reads ONE live
  // `document.getElementsByTagName('canvas')` collection, which the engine keeps cached, and arms any
  // canvas it has not seen yet. No timer: past its deadline (load + 10 s) the next mutation
  // disconnects it.
  let mo = null, canvasList = null;
  const moSeen = new WeakSet(); // arm each canvas at most once from here (a '2d' canvas stays unarmed)
  function onMutations() {
    if (done || pcFound || retired || (loaded && perfNow() > moDeadline)) { unobserve(); return; }
    const l = canvasList;
    for (let i = 0; i < l.length; i++) { const c = l[i]; if (!moSeen.has(c)) { moSeen.add(c); arm(c); } }
  }
  let moDeadline = Infinity;
  function observe() {
    if (mo || !MO || done || pcFound || retired) return;
    try { canvasList = apply(byTag, document, ['canvas']); mo = new MO(onMutations); mo.observe(document, { childList: true, subtree: true }); } catch (e) { mo = null; }
  }
  function unobserve() { if (mo) { try { mo.disconnect(); } catch (e) { /* ignore */ } mo = null; canvasList = null; } }

  // A canvas went live (S.settle): the PlayCanvas search has found what this document converts,
  // unless another canvas has a WebGL context (an app we have not found may still be there).
  let settledOn = null;
  function settle(canvas) {
    settledOn = canvas;
    for (const c of glCanvases) if (c !== canvas) return;
    disarmCanvases(); stopPoll(); unobserve();
    polling = false; // a WebGL context on another canvas later starts the search again
  }
  const glCanvases = [];
  const descCanvas = (c) => {
    if (!c) return 'canvas';
    let id = '';
    try { id = ID && ID.get ? apply(ID.get, c, []) : ''; } catch (e) { /* ignore */ }
    return 'canvas' + (id ? '#' + id : '');
  };

  const disarm = () => { retired = true; disarmCanvases(); stopPoll(); unobserve(); for (const k of [...keyTraps]) removeKeyTrap(k); };

  if (en.playcanvas !== false) {
    const GC = HTMLCanvasElement.prototype.getContext;
    const WEBGL = { webgl: 1, webgl2: 1, 'experimental-webgl': 1 };
    const seenGL = new WeakSet();
    const onContext = (c, type) => {
      if (done || pcFound) return;
      if (type === '2d') { unarm(c); return; }
      if (WEBGL[type] !== 1 || seenGL.has(c)) return;
      seenGL.add(c);
      if (!glCanvas) glCanvas = c;
      if (c !== settledOn) glCanvases.push(c);
      signal(null); // the first engine / WebGL signal: the page's opt-out
      if (done) return;
      arm(c);
      startPoll();
    };
    try {
      HTMLCanvasElement.prototype.getContext = function getContext(type) {
        const ctx = apply(GC, this, arguments);
        try { onContext(this, type); } catch (e) { /* never break the page's getContext */ }
        return ctx;
      };
    } catch (e) { console.warn(TAG, 'could not watch getContext — PlayCanvas apps may not be found', e); }

    // Every <canvas> already in the DOM, before deferred / module scripts run (R1).
    const armDom = () => {
      if (done || pcFound) return;
      if (optedOut()) return; // the report comes with the first WebGL / engine signal
      const list = apply(byTag, document, ['canvas']);
      for (let i = 0; i < list.length; i++) arm(list[i]);
    };
    const onReady = () => {
      const s = document.readyState;
      if (s === 'loading') return;
      if (!loaded && s === 'complete') {
        loaded = true;
        const t = perfNow() + 10000;
        moDeadline = t;
        for (const c of armed.keys()) armed.set(c, t);
        scheduleSweep();
      }
      if (!armedDom) { armedDom = true; armDom(); }
      if (loaded) document.removeEventListener('readystatechange', onReady);
    };
    let armedDom = false;
    if (loaded) moDeadline = perfNow() + 10000; // injected into an already-loaded document
    observe();
    if (document.readyState === 'loading') document.addEventListener('readystatechange', onReady);
    else onReady();
  }

  const S = Object.freeze({
    get devtools() { return devtools; }, // the __THREE_DEVTOOLS__ EventTarget the sentinel listens on
    intrinsics,
    xrRequest,
    foreign: () => foreign,       // why the page owns XR in this document, or null
    onForeign(cb) { foreignCbs.push(cb); },
    optedOut,                     // <meta name="displayxr-auto3d" content="off"> (sticky once seen)
    disarm,                       // take every trap off, for good (the core: standing down for this document)
    settle,                       // a canvas went live: stop the PlayCanvas search unless another canvas has WebGL
  });
}

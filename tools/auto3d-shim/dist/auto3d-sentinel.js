// DisplayXR auto-3D 0.5.1 — built by tools/auto3d-shim/build.mjs from displayxr-web. Do not edit: fix the source, rebuild, re-vendor.
(function (cfg, cap) {
'use strict';
function dxrSentinel(cfg, cap) {
  const TAG = '[dxr-auto3d]';
  const MARK = Symbol.for('dxr.auto3d');
  if (window[MARK]) return; // another injector armed this document first
  if (typeof window.XRDisplayLayer !== 'function' || !navigator.xr) return; // not the DisplayXR Browser: inert
  try { Object.defineProperty(window, MARK, { value: true }); } catch (e) { return; }

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

  const gopd = (o, k) => { const d = Object.getOwnPropertyDescriptor(o, k); return d ? Object.freeze(d) : null; };
  const intrinsics = Object.freeze({
    attachShadow: Element.prototype.attachShadow,
    showPopover: HTMLElement.prototype.showPopover || null,
    elementsFromPoint: Document.prototype.elementsFromPoint,
    canvasWidth: gopd(HTMLCanvasElement.prototype, 'width'),
    canvasHeight: gopd(HTMLCanvasElement.prototype, 'height'),
    elementId: gopd(Element.prototype, 'id'),
  });

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

  const en = cfg.engines || {};
  const blocked = cfg.decision === 'block' && !cfg.dev;
  let core = null;     // what dxrCore returned, once loaded
  let done = false;    // detection finished without a core (opted out / blocked and reported / foreign / load failed)

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

  const reported = new Set();
  const reportOnce = (r) => {
    if (reported.has(r.status)) return;
    reported.add(r.status);
    try { cap.report(r); } catch (e) { /* ignore */ }
  };
  const reportOff = (engine) => reportOnce({ status: 'off', engine });

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
  function onForeignEarly() {
    if (core || done || cfg.dev) return;
    done = true;
    disarm();
  }

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
      defProp(window, '__THREE_DEVTOOLS__', {
        configurable: true, enumerable: false,
        get: () => devtools,
        set: (v) => { devtools = v; attachHook(v); },
      });
    } catch (e) { window.__THREE_DEVTOOLS__ = devtools; }
  }

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
    info(`a WebGL canvas (${descCanvas(glCanvas)}) but no supported engine found — left 2D.`,
      'A three.js page announces itself (r105+); a PlayCanvas app is found through window.pc / window.app, or through its',
      'canvas id when the <canvas> is in the HTML before deferred / module scripts run. A canvas created by script with no',
      'global is not visible (an engine-side announce hook would fix it).');
  }
  function stopPoll() { if (pollT) { cTimeout(pollT); pollT = 0; } }

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
return dxrSentinel(cfg, cap);
})

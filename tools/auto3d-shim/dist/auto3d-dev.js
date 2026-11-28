// DisplayXR auto-3D 0.9.0 — built by tools/auto3d-shim/build.mjs from displayxr-web. Do not edit: fix the source, rebuild, re-vendor.
(() => {
'use strict';
function dxrDevHost(loadCore) {
  const LS_KEY = 'dxrAuto3D';
  const V = 1;
  const DEFAULT_DEPTH = { camera: 0.5, display: 1.0 };
  let dev = true;
  try { dev = localStorage.getItem('dxrAuto3DDev') !== '0'; } catch (e) { /* opaque origin */ }
  const rawTest = window.__dxrAuto3DTestCfg; // harness override, never persisted by itself
  const test = dev && rawTest && typeof rawTest === 'object' ? rawTest : null;

  const cur = loadCfg();
  function loadCfg() {
    let stored = {};
    try { stored = JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (e) { /* opaque origin */ }
    const ok = stored.v === V;
    const base = { v: V, enabled: true, convScale: 1, hud: true, ...(ok ? stored : {}) };
    const sd = ok ? stored.depths : null;
    base.depths = { ...DEFAULT_DEPTH, ...(sd && typeof sd === 'object' ? sd : {}) };
    if (!sd && ok && typeof stored.depth === 'number') base.depths.camera = stored.depth;
    delete base.depth;
    for (const k of Object.keys(DEFAULT_DEPTH)) if (!(base.depths[k] > 0)) base.depths[k] = DEFAULT_DEPTH[k];
    const known = (d) => d === 'allow' || d === 'offer' || d === 'block';
    base.decision = known(base.decision) ? base.decision : base.enabled ? 'allow' : 'block';
    if (test) {
      if ('enabled' in test) base.decision = test.enabled ? 'allow' : 'block';
      if (known(test.decision)) base.decision = test.decision;
      if (test.depths && typeof test.depths === 'object') base.depths = { ...base.depths, ...test.depths };
      for (const k of ['rig', 'convScale', 'hud']) if (k in test) base[k] = test[k];
    }
    base.enabled = base.decision === 'allow';
    return base;
  }

  const cfg = Object.freeze({
    decision: cur.decision,
    depths: Object.freeze({ ...cur.depths }),
    rig: cur.rig,
    convScale: cur.convScale,
    dev,
    engines: Object.freeze({ three: true, playcanvas: true, babylon: true }),
    test,
    hud: cur.hud !== false,
  });
  const cap = {
    loadCore,
    save(p) {
      if (!p || typeof p !== 'object') return;
      if (p.decision === 'allow' || p.decision === 'block' || p.decision === 'offer') { cur.decision = p.decision; cur.enabled = p.decision === 'allow'; }
      if (p.depths && typeof p.depths === 'object') cur.depths = { ...cur.depths, ...p.depths };
      if (p.rig === 'camera' || p.rig === 'display') cur.rig = p.rig;
      if (typeof p.convScale === 'number') cur.convScale = p.convScale;
      if (typeof p.hud === 'boolean') cur.hud = p.hud;
      try {
        const keep = { v: V, enabled: cur.enabled, depths: { ...cur.depths }, convScale: cur.convScale, rig: cur.rig, hud: cur.hud, decision: cur.decision };
        localStorage.setItem(LS_KEY, JSON.stringify(keep));
      } catch (e) { /* opaque origin */ }
    },
    report(r) {
      if (!dev) return;
      try { (window.__dxrAuto3DReports = window.__dxrAuto3DReports || []).push({ ...r, t: performance.now() }); } catch (e) { /* ignore */ }
    },
  };
  return { cfg, cap };
}
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
  const hasOwn = Object.prototype.hasOwnProperty;
  const Err = Error;
  const info = (...a) => console.info(TAG, ...a);

  const gopd = (o, k) => { const d = Object.getOwnPropertyDescriptor(o, k); return d ? Object.freeze(d) : null; };
  const intrinsics = Object.freeze({
    attachShadow: Element.prototype.attachShadow,
    showPopover: HTMLElement.prototype.showPopover || null,
    elementsFromPoint: Document.prototype.elementsFromPoint,
    canvasWidth: gopd(HTMLCanvasElement.prototype, 'width'),
    canvasHeight: gopd(HTMLCanvasElement.prototype, 'height'),
    elementId: gopd(Element.prototype, 'id'),
    attr: Object.freeze({ set: Element.prototype.setAttribute, remove: Element.prototype.removeAttribute, has: Element.prototype.hasAttribute }),
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
  const wantPC = en.playcanvas !== false, wantBJS = en.babylon !== false, wantGL = en.gl !== false;
  const blocked = cfg.decision === 'block' && !cfg.dev;
  let core = null;     // what dxrCore returned, once loaded
  let engineSeen = false; // an ENGINE adapter's signal (not only the GL-level fallback's)
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
    if (engine && engine !== 'WebGL') engineSeen = true;
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
    !!a && typeof a === 'object' && typeof a.on === 'function' && typeof a.fire === 'function' && !!a.systems &&
    ((typeof a.tick === 'function' && 'graphicsDevice' in a) ||
      (typeof a.init === 'function' && typeof a.start === 'function'));
  const nsOf = (pc) => (pc && typeof pc === 'object' && (pc.AppBase || pc.Application) ? pc : null);
  let pcFound = false;
  let retired = false;  // S.disarm(): nothing is armed again in this document
  function foundPC(app, how, ns) {
    if (pcFound || retired) return; // after S.disarm() nothing is found (a late 'load' look, a trap mid-flight)
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
          if (!done && !pcFound) { if (expired(this)) unarm(this); else trapKey(v); }
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
  function expired(c) { const t = armed.get(c); return t !== undefined && t <= perfNow(); }
  function sweepLazy() { if (!armed.size) return; const n = perfNow(); for (const [c, t] of [...armed]) if (t <= n) unarm(c); }
  function disarmCanvases() {
    for (const c of [...armed.keys()]) unarm(c);
    if (sweepT) { cTimeout(sweepT); sweepT = 0; }
  }
  function scheduleSweep() {
    if (sweepT || !loaded || !armed.size || !glCanvas) return; // no WebGL yet: lazy expiry only (above)
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

  let polling = false, looking = false, polls = 0, pollT = 0, glCanvas = null;
  function lookGlobals() {
    if (done || retired) return;
    if (wantBJS) lookBabylon();
    if (pcFound || !wantPC) return;
    let pc = null;
    try { pc = window.pc; } catch (e) { /* ignore */ }
    if (pc && typeof pc === 'object') {
      const ns = nsOf(pc);
      try { if (isApp(pc.app)) { foundPC(pc.app, 'window.pc.app', ns); return; } } catch (e) { /* ignore */ }
      try { const a = pc.AppBase && pc.AppBase.getApplication && pc.AppBase.getApplication(); if (isApp(a)) { foundPC(a, 'pc.AppBase.getApplication()', ns); return; } } catch (e) { /* ignore */ }
    }
    try { if (isApp(window.app)) foundPC(window.app, 'window.app', nsOf(pc)); } catch (e) { /* ignore */ }
  }
  function startPoll(timed) {
    if (polling || retired) return;
    if (!looking) {
      looking = true;
      micro(lookGlobals);
      document.addEventListener('DOMContentLoaded', lookGlobals, { once: true });
      window.addEventListener('load', lookGlobals, { once: true });
    }
    if (timed === false) return;
    polling = true; polls = 0;
    pollT = sTimeout(poll, 500);
  }
  function poll() {
    pollT = 0;
    if (done || pcFound || bjsFound || retired) return;
    lookGlobals();
    if (done || pcFound || bjsFound) return;
    if (++polls < 40) { pollT = sTimeout(poll, 500); return; }
    if (core && engineSeen) return; // three.js (or another path) loaded the core: this canvas is accounted for
    let tag = null;
    try { tag = glCanvas ? apply(getAttr, glCanvas, ['data-engine']) : null; } catch (e) { tag = null; }
    info(`a WebGL canvas (${descCanvas(glCanvas)}${tag ? `, data-engine="${tag}"` : ''}) but no supported engine found — left 2D.`,
      'A three.js page announces itself (r105+); a PlayCanvas app is found through window.pc / window.app, or through its',
      'canvas id when the <canvas> is in the HTML before deferred / module scripts run; a Babylon.js engine through its',
      'constructor (in the task that created its context) or BABYLON.EngineStore. A canvas created by script with no',
      'global is not visible (an engine-side announce hook would fix it).');
  }
  function stopPoll() { if (pollT) { cTimeout(pollT); pollT = 0; } }

  let mo = null, canvasList = null;
  const moSeen = new WeakSet(); // arm each canvas at most once from here (a '2d' canvas stays unarmed)
  function onMutations() {
    if (done || pcFound || retired || (loaded && perfNow() > moDeadline)) { unobserve(); sweepLazy(); return; }
    sweepLazy();
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
    polling = false; looking = false; // a WebGL context on another canvas later starts the search again
  }
  const glCanvases = [];
  const descCanvas = (c) => {
    if (!c) return 'canvas';
    let id = '';
    try { id = ID && ID.get ? apply(ID.get, c, []) : ''; } catch (e) { /* ignore */ }
    return 'canvas' + (id ? '#' + id : '');
  };

  const disarm = () => {
    retired = true; disarmCanvases(); stopPoll(); unobserve(); for (const k of [...keyTraps]) removeKeyTrap(k); for (const k of [...bjsKeys]) removeBjsKey(k);
    document.removeEventListener('DOMContentLoaded', lookGlobals);
    window.removeEventListener('load', lookGlobals);
  };

  const isBjsEngine = (e) =>
    !!e && typeof e === 'object' && typeof e.runRenderLoop === 'function' && Array.isArray(e.scenes) &&
    typeof e.getRenderWidth === 'function' && !!e.onNewSceneAddedObservable;
  const bjsSeen = new WeakSet();
  let bjsFound = false;
  function foundBabylon(engine, how, ns, canvas) {
    if (retired || bjsSeen.has(engine)) return;
    bjsSeen.add(engine);
    bjsFound = true;
    if (canvas) settle(canvas); // this canvas is accounted for: the PlayCanvas search stops unless another has a context
    else stopPoll();
    let B = ns;
    if (!B) { try { B = window.BABYLON; } catch (e) { B = null; } }
    const c = signal('Babylon.js');
    if (c && c.babylon) c.babylon.consider(engine, how, B && typeof B === 'object' && B.Engine ? B : null);
  }
  const STACK_FRAMES = 16;
  function bjsLikely(kind, attrs) {
    if (kind === 1) {
      try { return !!attrs && typeof attrs === 'object' && apply(hasOwn, attrs, ['lockstepMaxSteps']) && apply(hasOwn, attrs, ['timeStep']); } catch (e) { return false; }
    }
    let s = '', had = false, lim, raised = false;
    try {
      had = apply(hasOwn, Err, ['stackTraceLimit']); lim = Err.stackTraceLimit;
      if (!(lim >= STACK_FRAMES)) { Err.stackTraceLimit = STACK_FRAMES; raised = Err.stackTraceLimit === STACK_FRAMES; }
    } catch (e) { /* read-only: the page's limit */ }
    try { s = String(new Err().stack || ''); } catch (e) { s = ''; }
    if (raised) { try { if (had) Err.stackTraceLimit = lim; else delete Err.stackTraceLimit; } catch (e) { /* ignore */ } }
    return s.indexOf('_initializeContextAndSwapChain') >= 0;
  }
  const bjsKeys = new Set();
  function removeBjsKey(key) {
    if (!bjsKeys.delete(key)) return;
    try { delete Object.prototype[key]; } catch (e) { /* ignore */ }
  }
  function trapBjs(kind, canvas) {
    const key = kind === 2 ? '_context' : '_gl';
    if (bjsKeys.has(key) || key in Object.prototype) return;
    bjsKeys.add(key);
    try {
      defProp(Object.prototype, key, {
        configurable: true, enumerable: false,
        get() { return undefined; },
        set(v) {
          try { defProp(this, key, { value: v, writable: true, enumerable: true, configurable: true }); } catch (e) { return; }
          if (!isBjsEngine(this)) return;
          try { foundBabylon(this, kind === 2 ? 'WebGPUEngine (_context trap)' : 'Engine constructor (_gl trap)', null, canvas); } catch (e) { /* never break the page's engine */ }
        },
      });
    } catch (e) { bjsKeys.delete(key); return; }
    micro(() => removeBjsKey(key));
  }
  function lookBabylon() {
    let B = null;
    try { B = window.BABYLON; } catch (e) { return; }
    if (!B || typeof B !== 'object') return;
    let list = null;
    try { list = (B.EngineStore && B.EngineStore.Instances) || (B.Engine && B.Engine.Instances) || null; } catch (e) { list = null; }
    if (!list || typeof list.length !== 'number') return;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!isBjsEngine(e) || bjsSeen.has(e)) continue;
      let cv = null;
      try { cv = typeof e.getRenderingCanvas === 'function' ? e.getRenderingCanvas() : null; } catch (x) { cv = null; }
      foundBabylon(e, 'BABYLON.EngineStore.Instances', B, cv);
    }
  }

  const GL_WAIT_MS = 2000, GL_TRIES = 30;
  let GL2P = null, getParam = null;
  const glSeenCtx = new WeakSet();
  const CW = intrinsics.canvasWidth, CH = intrinsics.canvasHeight;
  const GL_HOOKS = ['useProgram', 'bindFramebuffer', 'viewport', 'scissor', 'enable', 'disable', 'activeTexture', 'bindTexture',
    'uniformMatrix4fv', 'uniform1i', 'uniform1iv', 'drawBuffers', 'framebufferTexture2D', 'framebufferRenderbuffer', 'texImage2D', 'texStorage2D',
    'getUniformLocation', 'generateMipmap', 'clear', 'clearBufferfv', 'clearBufferiv', 'clearBufferuiv', 'clearBufferfi', 'blitFramebuffer',
    'drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements'];
  function glRecord(canvas, ctx) {
    if (!ctx || glSeenCtx.has(ctx)) return;
    if (!GL2P) { GL2P = WebGL2RenderingContext.prototype; getParam = GL2P.getParameter; }
    if (!(ctx instanceof WebGL2RenderingContext)) return;
    glSeenCtx.add(ctx);
    const tex = new WeakMap(), loc = new WeakMap(), own = [], slot = Object.create(null), base = Object.create(null);
    const post = {
      texImage2D(gl, a) {
        if (a[0] !== 0x0DE1 || a.length < 8 || typeof a[3] !== 'number' || typeof a[4] !== 'number') return; // TEXTURE_2D, the sized form
        const t = apply(getParam, gl, [0x8069]); // TEXTURE_BINDING_2D (client-side state)
        if (!t) return;
        let sp = tex.get(t);
        if (!sp || sp.k !== 'img') tex.set(t, (sp = { k: 'img', l: {} }));
        sp.l[a[1]] = [a[2], a[3], a[4], a[6], a[7]];
      },
      texStorage2D(gl, a) {
        if (a[0] !== 0x0DE1) return;
        const t = apply(getParam, gl, [0x8069]);
        if (t) tex.set(t, { k: 'sto', levels: a[1], ifmt: a[2], w: a[3], h: a[4] });
      },
      getUniformLocation(gl, a, r) { if (r) loc.set(r, String(a[1])); },
    };
    for (const name of GL_HOOKS) {
      const orig = GL2P[name];
      if (typeof orig !== 'function') continue;
      const p = post[name];
      const b = p ? function () { const r = apply(orig, this, arguments); try { p(this, arguments, r); } catch (e) { /* never break the page's call */ } return r; } : orig;
      base[name] = b;
      try {
        defProp(ctx, name, { configurable: true, writable: true, enumerable: false, value: function () {
          const h = slot[name];
          return h ? h(this, arguments) : apply(b, this, arguments);
        } });
        own.push(name);
      } catch (e) { /* a frozen context: nothing recorded */ }
    }
    const r = { canvas, ctx, tries: 0, t: 0, dead: false, rec: { tex, loc, slot, base, unwrap() { for (const n in slot) delete slot[n]; for (const n of own) { try { delete ctx[n]; } catch (e) { /* ignore */ } } own.length = 0; } } };
    r.t = sTimeout(() => glCheck(r), GL_WAIT_MS);
  }
  function glDrop(r) { r.dead = true; if (r.t) { cTimeout(r.t); r.t = 0; } try { r.rec.unwrap(); } catch (e) { /* ignore */ } }
  function glCheck(r) {
    r.t = 0;
    if (r.dead) return;
    if (done || retired) { glDrop(r); return; }
    const c = r.canvas;
    let claimed = false;
    try { claimed = !!(core && core.claims && core.claims(c)); } catch (e) { claimed = false; }
    if (claimed) { glDrop(r); return; }
    let w = 0, h = 0;
    try { w = apply(CW.get, c, []); h = apply(CH.get, c, []); } catch (e) { /* ignore */ }
    if (c.isConnected && w * h > 300 * 150) {
      const k = signal('WebGL');
      if (k && k.gl) { r.dead = true; k.gl.consider(c, r.ctx, r.rec); }
      else glDrop(r);
      return;
    }
    if (++r.tries < GL_TRIES) r.t = sTimeout(() => glCheck(r), GL_WAIT_MS);
    else glDrop(r);
  }

  if (wantPC || wantBJS || wantGL) {
    const GC = HTMLCanvasElement.prototype.getContext;
    const WEBGL = { webgl: 1, webgl2: 1, 'experimental-webgl': 1, webgpu: 2 };
    const seenGL = new WeakSet();
    const onContext = (c, type, attrs) => {
      if (done) return;
      const kind = WEBGL[type];
      if (kind && wantBJS && !retired && bjsLikely(kind, attrs)) trapBjs(kind, c); // first: a Babylon engine assigns the context right after this call
      if (pcFound) return;
      sweepLazy();
      if (type === '2d') { unarm(c); return; }
      if (!kind || seenGL.has(c)) return;
      seenGL.add(c);
      if (kind === 1 && !glCanvas) glCanvas = c;
      if (c !== settledOn) glCanvases.push(c);
      signal(null); // the first engine / graphics-context signal: the page's opt-out
      if (done) return;
      if (wantPC) arm(c);
      if (kind === 2) { startPoll(false); return; } // WebGPU: the traps find the app / engine; no timer (above)
      scheduleSweep(); // the first WebGL context: traps armed before it (no timer until now) expire on time
      startPoll();
    };
    try {
      HTMLCanvasElement.prototype.getContext = function getContext(type) {
        const ctx = apply(GC, this, arguments);
        try { onContext(this, type, arguments[1]); } catch (e) { /* never break the page's getContext */ }
        try { if (wantGL && !done && !retired && type === 'webgl2') glRecord(this, ctx); } catch (e) { /* never break the page's getContext */ }
        return ctx;
      };
    } catch (e) { console.warn(TAG, 'could not watch getContext — PlayCanvas apps / Babylon.js engines may not be found', e); }
  }

  if (wantPC) {
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
const CORE = function (cfg, cap, S) {
function dxrCore(cfg, cap, S) {
  const TAG = '[dxr-auto3d]';
  const VERSION = '0.9.0'; // stamped by build.mjs from manifest.json

  const DEFAULT_DEPTH = { camera: 0.5, display: 1.0 };
  const DEPTH_MIN = 0.02, DEPTH_MAX = 1;
  const CONV_SCALE_MIN = 0.05, CONV_SCALE_MAX = 20;

  const TUNING = {
    eyeScale: 1,        // per-eye width / element DEVICE width: the SBS store is the element's full device size, each eye squeezed to half width (a 2-view lenticular resolves about half anyway; the weave un-squeezes)
    maxEyeDpr: 3,       // the device-pixel ratio the eye is sized at, at most
    maxSbsWidth: 3072,  // browser-pvt#24: wider SBS canvases drop off the zero-copy weave path
    maxSbsArea: 5760 * 5760, // Chromium's WebGL drawing-buffer area cap (kMaxArea): past it the buffer is silently scaled down while canvas.width keeps the value (@displayxr/inline3d MAX_DRAWING_BUFFER_AREA)
    minCssPx: 120,      // smaller canvases stay flat (icons, thumbnails)
    holdMs: 1200,       // keep the cover this long after the layer exists (woven-canvas rules, rule 5)
    withheldMs: 300,    // a live canvas the browser reports 'withheld' (not woven) for this long goes back to 2D; 0: off
    coverOpacity: 0.996, // the go-live cover's opacity: just under 1, so it is never an opaque occluder of the canvas (takeCover); 1 = opaque (A/B)
    coverMaxMs: 5000,   // ... but never longer than this, stereo or not (R6: a display with nobody seated)
    releaseMaxMs: 500,  // turn-off: release the layer this long after the stand at the latest, mono frame or not
    bindMaxMs: 500,     // go-live: create the layer this long after the flip at the latest, pair drawn or not (#339)
    rampMs: 500,        // depth fades in after the cover drops, and back to flat before a turn-off swaps to 2D
    convTarget: true,   // prefer the page's explicit target (controls / lookAt) over the estimator
    scaleSamples: 3,    // the rig's scale (m2v) is set ONCE per activation (v0.7.11): from this many consecutive estimator samples ...
    scaleSpread: 0.1,   // ... within this fraction of their median, on a quiet page (no resource for guardLoadQuietMs) ...
    scaleMaxWaitMs: 8000, // ... or from what there is this long after the flip (a page that never stops loading). Flat until then.
    openSceneMode: 'fixed', // 'fixed' (the legacy-WebXR rule, below) | 'percentile' (the 0.5.3 room rule: convRoomPercentile)
    openSceneConvM: 2,      // 'fixed': converge this far in front of the page camera, scene units read as METRES (Marble worlds and most three.js scenes are metric)
    openSceneRealDepth: 0.5, // 'fixed': the camera-rig depth that means the viewer's REAL IPD (ipdFactor 1); less scales the eye separation down (0.25 halves it)
    openWalk: true,       // the walk signal (walkTick); false: off (A/B)
    walkEveryFrames: 6,   // the motion classifier samples the page camera this often (session frames)
    walkTravel: 0.5,      // ... walks when its translation NOT explained by a pivot reaches this × the scene's scale (min(convergence, the bounded items' extent)) ...
    walkTurnDeg: 20,      // ... AND it has turned at least this much about a point near itself (|pivot| < walkPivotFrac × that scale): orbits, dollies, pans and turntables never do
    walkPivotFrac: 0.25,
    openSurround: true,   // the surround signal: inside the bounded items' union box with geometry on >= surroundSides of the 4 horizontal sides (a floor below does not count)
    surroundSides: 3,
    surroundRuns: 2,      // ... on this many consecutive estimates
    eyeAnchor: true,      // false: the runtime's views as they come (≤ 0.7.11), harness A/B
    eyeLeanMax: 0.5,
    nominalFallback: [0, 0.1, 0.6], // the nominal viewer (m, display space) when XRDisplayInfo has none: the runtime's on Leia SR + sim_display      // the scaled head deviation never exceeds this × the nearest surface in view (estimator / target scale only): leaning in cannot enter the model
    coreGlass: true,     // false: the portal at the frozen scale distance, as 0.7.x (A/B)
    strictObject: true,  // false: any page target not in an open scene is an object, as 0.7.13 (A/B)
    settleMs: 1000,      // the surface set must be unchanged for this long before the verdict ...
    settleMaxMs: 8000,   // ... or this long since the activation's first look (a page that never settles: not an object)
    objFitMax: 1.3,      // the subject's radius about the target is at most this x the frame's half-size there ...
    objFitMin: 0.08,     // ... at least this x (a speck is not the point of the page) ...
    objStandoff: 1.2,    // ... and the camera stands at least this x that radius from the target
    targetDrift: 0.05,   // the target may move at most this x its distance while we watch
    cursorDepth: true,   // the 3D cursor (cursorTick): report the depth under the pointer where the browser draws its cursor at depth
    zoomLocal: true,     // display rig: the portal distance is applied to the located eyes in the frame the page camera moves (eyeScale); false: through the rig, three frames late
    glassMetric: 'radial', morphMs: 700,        // a rig change after go-live is a MORPH of this length (rigMorph); 0: a cut
    overlayEveryFrames: 30, // page elements over the canvas that move with the camera (hotspots, labels): looked for this often
    glassFront: 1 / 3,   // the share of the core's DEPTH RANGE in front of the glass ...
    glassTrim: 0.05,     // ... the range taken between this percentile of the surface (by area) and its complement: a thin tail falls
    glassRule: 'range',  // 'surface' = the share of the surface area in front (the first cut; A/B)
    displayPivot: true, // display rig: the page's rotations pivot about the virtual display's centre (pivotOffset); false = the portal rides the page camera (0.5.4), harness A/B only
    convRoomPercentile: 0.7, // 'percentile' mode: converge at this percentile of the apparent-size-weighted in-view depths (0.5 = the median; see estimateSubjectDistance). 'fixed' mode reads it only for the scale-sanity note
    noViewsMs: 4000,    // no 2-view frame this long after the layer -> back to 2D, retry later
    eyesOffMs: 1000,    // the chip's dot goes amber only after this long continuously without 2-view frames ...
    eyesOnMs: 300,      // ... and back to green after this long with them (eye tracking flips isTracking every few s)
    fakeViews: false,   // TEST ONLY: synthesise a parallel-axis pair when the session reports none
    guardStandDown: false, // false (v0.8.0): a slow page stays in 3D and the guard only logs the rate; true: the 0.7 stand-down and retry
    guardFps: 15,       // frame-rate guard (guard.js): with guardStandDown, back to 2D when 3D runs below this over guardMs ... (David 2026-09-28: heavy splat
    guardMs: 2000,      // ... (and below 0.6 x the page's 2D rate, when it has one; was 0.8)
    guardWarmupMs: 4000, // ... no guard window starts within this long after the cover drop (a page still loading its assets)
    guardRetryMs: 6000,  // ... the first trip stands down, then retries once after at least this long, whatever the 2D rate ...
    guardSteadyMs: 2000, // ... once the page's own 2D rate has been steady this long (a page still streaming is not judged again yet) ...
    guardRetryMaxMs: 30000, // ... or after this long at the latest
    guardLoadQuietMs: 1000, // ... no window counts while the page is loading: the document not complete, or a resource
    guardLoadMaxMs: 20000,  // ... but only up to this long after the cover drop: a page that never stops loading is judged anyway
    glLimit: 0,         // TEST ONLY: > 0 stands in for the surface's size limit (WebGL or WebGPU) in realSizeFor
    gpuDepthRange: true, // TEST ONLY (A/B): false hands a WebGPU engine the runtime's GL-clip projection as is (no surface.toClip)
    gpuVerified: null,   // TEST ONLY: overrides three-adapter's GPU_VERIFIED (case three-webgpu-newer: a revision above it still converts, with the note)
    gpuClearFix: true,   // TEST ONLY (A/B): false draws three's WebGPURenderer eye pair on its direct (no frame-buffer target) path without the eye-1 clear fix (three-adapter eyeBegin)
    pcFootprint: true,  // TEST ONLY (A/B): false leaves the PlayCanvas gsplat footprint shaders (GLSL and WGSL) unpatched
    pcPostEffects: true, // TEST ONLY (A/B): false keeps a PlayCanvas camera with legacy post effects (camera.postEffects) 2D; 'unsplit' converts it with ONE chain over the pair (v0.7.9 runs the chain per eye)
    bindAfterCommit: true, // TEST ONLY (A/B): false creates the layer in the flip task, as v0.7.9 did (one stretched frame at go-live on the panel, #339)
    pcCameraFrame: true, // TEST ONLY (A/B): false leaves a PlayCanvas CameraFrame UNSPLIT under xrViews (both views through one post chain over the pair)
    chainMirror: true,   // TEST ONLY (A/B): false skips the three.js post-chain mirror probe (a chain that flips the picture left-right is then drawn pseudoscopic); 'force' draws every chain's eyes mirrored, whatever the probe found (dev, live: __dxrAuto3D.set('chainMirror', 'force'))
    pcTaaJitter: true,  // TEST ONLY (A/B): false applies no TAA jitter to the eye projections of a split CameraFrame
    pcCanvasTrap: true, // TEST ONLY (A/B): false lets a PlayCanvas page's own canvas.width / height writes through while converted
    bjsPostFx: true,    // TEST ONLY (A/B): false keeps a Babylon.js camera with post-processes 2D (true: the engine cascades the chain to the eye cameras)
    bjsWebGPU: true,    // TEST ONLY (A/B): false keeps a Babylon.js WebGPU engine 2D
    bjsEyeTarget: true, // TEST ONLY (A/B): false lets Babylon eyes draw straight into their halves (no eye target + pass)
    bjsIblHistory: true, // TEST ONLY (A/B): false leaves Babylon IBL shadows' accumulation history copied once per frame (the right eye's then mismatches its velocity)
    bjsCustomRT: true,  // TEST ONLY (A/B): false leaves a Babylon.js scene's customRenderTargets drawn once per frame from the page camera (not again per eye)
    bjsCustomRTOwnView: true,  // TEST ONLY (A/B): false draws every such target again per eye, even one drawn from a view of its own the same for both eyes (v0.7.1)
    bjsGBuffer: true,   // EXPERIMENTAL (Babylon.js): true draws the geometry buffer again for the right eye; false keeps a scene with one 2D; 'shared' (TEST ONLY, A/B) converts it without the second draw
  };
  const SITE_KEYS = ['v', 'enabled', 'decision', 'depth', 'depths', 'rig', 'convScale', 'hud'];
  const T = { ...TUNING };
  if (cfg.dev && cfg.test && typeof cfg.test === 'object') {
    for (const k of Object.keys(cfg.test)) if (!SITE_KEYS.includes(k)) T[k] = cfg.test[k];
  }
  const RAMP_MS = T.rampMs;
  const reducedMotion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  const applyMotion = () => { T.rampMs = reducedMotion && reducedMotion.matches ? 1 : RAMP_MS; };
  applyMotion();
  if (reducedMotion && reducedMotion.addEventListener) reducedMotion.addEventListener('change', applyMotion);

  const cd = cfg.depths || {};
  const site = {
    decision: cfg.decision === 'allow' || cfg.decision === 'offer' ? cfg.decision : 'block',
    depths: { camera: cd.camera > 0 ? cd.camera : DEFAULT_DEPTH.camera, display: cd.display > 0 ? cd.display : DEFAULT_DEPTH.display },
    rigChoice: cfg.rig === 'display' || cfg.rig === 'camera' ? cfg.rig : 'auto',
    rig: cfg.rig === 'display' ? 'display' : 'camera', // the ACTIVE rig (rigMode)
    convScale: typeof cfg.convScale === 'number' && cfg.convScale > 0 ? Math.min(CONV_SCALE_MAX, Math.max(CONV_SCALE_MIN, cfg.convScale)) : 1,
  };
  let once = null;
  const on = () => (once !== null ? once : site.decision === 'allow');
  const save = (partial) => { try { cap.save(partial); } catch (e) { warnOnce('save', 'could not save the site setting', e); } };

  const info = (...a) => console.info(TAG, ...a);
  const warned = new Set();
  const warnOnce = (key, ...a) => { if (!warned.has(key)) { warned.add(key); console.warn(TAG, ...a); } };
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const now = () => performance.now();
  const desc = (el) => {
    if (!el || !el.tagName) return String(el);
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    if (typeof el.className === 'string' && el.className.trim()) s += '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.');
    return s;
  };
  const HAS_RIG = 'setViewRig' in window.XRDisplayLayer.prototype;
  const surfaces = dxrSurface({ warnOnce }); // the per-graphics-API seam (surface.js)
  const CANVAS_W = S.intrinsics.canvasWidth;
  const CANVAS_H = S.intrinsics.canvasHeight;
  const realW = (c) => CANVAS_W.get.call(c);
  const realH = (c) => CANVAS_H.get.call(c);

  const tracked = [];           // WeakRef<state>, for state() and the HUD
  let gl = null;                // the GL-level fallback adapter (gl-adapter.js), once the parts are made
  let owner = null;             // the one canvas converted (or converting) — one inline-3D session per document
  let lastTarget = null;        // the last canvas we converted: the chip keeps pointing at it after release
  let candidate = null;         // while OFF (offer / block in dev): a canvas that would convert — the chip's target
  let foreign = null;           // why we stood down for good in this document (the page owns inline-3D / XR)
  const engines = [];           // adapter names, for the HUD / console

  const MARKER = 'data-dxr-auto3d';
  const LIFT_MARKERS = ['dxr-lift'];
  const ATTR = S.intrinsics.attr;
  function claim(st) {
    owner = st; lastTarget = st;
    if (!st.marked) { st.marked = true; try { ATTR.set.call(st.canvas, MARKER, 'live'); } catch (e) { /* ignore */ } }
  }
  function unclaim(st) {
    if (owner === st) owner = null;
    if (st.marked) { st.marked = false; try { ATTR.remove.call(st.canvas, MARKER); } catch (e) { /* ignore */ } }
  }
  function liftedBy(el) {
    for (let e = el; e;) {
      if (e.nodeType !== 1) { e = e.host || null; continue; } // a ShadowRoot -> its host; the Document -> done
      for (const n of LIFT_MARKERS) if (ATTR.has.call(e, n)) return n;
      e = e.parentNode;
    }
    return null;
  }
  function refuseLifted(st, n) {
    if (st.lifted) return;
    st.lifted = n;
    info(`not converting ${desc(st.canvas)}: element is lifted (Convert to 3D, [${n}])`);
    if (candidate === st) candidate = null;
    notify();
  }

  const xrRequest = S.xrRequest;
  function yieldTo(reason) {
    if (!foreign) { foreign = reason; info('standing down for this document:', reason); standDownForGood(); }
    if (owner) stand(owner, reason);
    notify();
  }

  function newState(engine, canvas, ad) {
    if (engine !== 'WebGL' && gl) { try { gl.yieldCanvas(canvas); } catch (e) { /* ignore */ } }
    const st = {
      engine, canvas, ad,
      active: false, pending: false, armed: null, binding: null, tries: 0, nextTry: 0, lastWhy: null, flatReason: null,
      session: null, ref: null, layer: null, layerAt: 0, rig: { position: { x: 0, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } },
      V: [0, 1].map(() => ({ proj: new Float32Array(16), pose: new Float32Array(16) })),
      haveViews: false, near: NaN, far: NaN, R: null,
      conv: { d: 0, src: 'estimator', via: null }, cover: null, savedStyle: null, displayOk: null,
      releasing: null, wakeOnRelease: false, eyeBack: 0, rigs: null, piv: null,
      lastTwoAt: 0, noDisplay: false, nd: false, eyesOn: false, twoRun: 0, shortRun: 0,
      stats: { calls: 0, stereo: 0, flat: 0, flatAfterEyes: 0, replays: 0, resizes: 0, xrFrames: 0, twoView: 0, shortView: 0 },
    };
    tracked.push(new WeakRef(st));
    return st;
  }
  function claims(canvas, except) {
    for (const w of tracked) { const st = w.deref(); if (st && st.canvas === canvas && st.engine !== except && !st.dead) return true; }
    return false;
  }
  function noteFlat(engine, canvas, reason) {
    const st = newState(engine, canvas, { label: () => engine, unqualified: () => reason, describe: () => ({ page: null }) });
    st.flatReason = reason;
    info(`${engine} canvas ${desc(canvas)} stays 2D:`, reason);
    notify();
    return st;
  }

  function realSizeFor(st) {
    const L = st.L, c = st.canvas;
    const cw = c.clientWidth, ch = c.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, T.maxEyeDpr);
    let eyeW, eyeH;
    if (cw > 0 && ch > 0) { eyeW = Math.max(2, Math.round(cw * dpr * T.eyeScale)); eyeH = Math.max(2, Math.round(ch * dpr)); }
    else { eyeW = Math.max(2, Math.round(L.w * L.pr * T.eyeScale)); eyeH = Math.max(2, Math.round(L.h * L.pr)); }
    if (st.lim === undefined) {
      const sf = surfaceOf(st);
      if (sf) st.lim = sf.limit(); // cached per canvas: a context's limits do not change
    }
    const lim = T.glLimit > 0 ? T.glLimit : st.lim || Infinity;
    return fitEyes(eyeW, eyeH, lim);
  }
  function fitEyes(eyeW, eyeH, lim) {
    const maxW = Math.min(T.maxSbsWidth, lim);
    const s = Math.min(1, maxW / (2 * eyeW), lim / eyeH, Math.sqrt(T.maxSbsArea / (2 * eyeW * eyeH)));
    if (s < 1) {
      eyeW = Math.max(2, Math.min(Math.floor(eyeW * s + 1e-9), Math.floor(maxW / 2)));
      eyeH = Math.max(2, Math.min(Math.floor(eyeH * s + 1e-9), Math.floor(lim)));
    }
    return { eyeW, eyeH, W: 2 * eyeW, H: eyeH };
  }
  function virtualizeCanvas(st, onWrite) {
    const c = st.canvas;
    const def = (prop, D, isW) => Object.defineProperty(c, prop, {
      configurable: true, enumerable: true,
      get() { return st.depth > 0 ? D.get.call(this) : Math.floor((isW ? st.L.w : st.L.h) * st.L.pr); },
      set(v) {
        if (st.depth > 0) { D.set.call(this, v); return; }
        warnOnce('rawsize', `the page wrote canvas.${prop} directly; mapped onto the side-by-side store`);
        if (isW) st.L.w = v / (st.L.pr || 1); else st.L.h = v / (st.L.pr || 1);
        onWrite();
      },
    });
    def('width', CANVAS_W, true);
    def('height', CANVAS_H, false);
  }
  function unvirtualizeCanvas(st) { try { delete st.canvas.width; delete st.canvas.height; } catch (e) { /* ignore */ } }
  const apiName = (sf) => (!sf ? 'the canvas' : sf.kind === 'webgpu' ? 'WebGPU' : 'WebGL');
  function surfaceOf(st) {
    if (!st.surf) { let s = null; try { s = st.ad.surface ? st.ad.surface(st) : null; } catch (e) { s = null; } st.surf = s || null; }
    return st.surf;
  }

  function considerActivation(st) {
    const t = now();
    guard.draw(st, t); // the page's 2D rate (the frame-rate guard's baseline)
    if (!on()) { if (!foreign && !owner) considerCandidate(st); return; }
    if (foreign || owner || guard.tripped || guard.retrying || st.lifted) return;
    if (t < st.nextTry) return;
    st.nextTry = t + 500;
    if (S.optedOut()) { standDownForGood(); notify(); return; } // <meta name="displayxr-auto3d" content="off">
    const lf = liftedBy(st.canvas); // Convert to 3D took it (first conversion, a chip click, the guard's retry)
    if (lf) { refuseLifted(st, lf); return; }
    const why = st.ad.unqualified(st);
    if (why) {
      if (why !== st.lastWhy) { st.lastWhy = why; info('not converting', desc(st.canvas), 'yet:', why); }
      return;
    }
    activate(st);
  }
  function considerCandidate(st) {
    const t = now();
    if (t < (st.candAt || 0)) return;
    st.candAt = t + 500;
    const lf = st.lifted || liftedBy(st.canvas);
    if (lf && !st.lifted) refuseLifted(st, lf); // never offered: a click would convert a lifted canvas
    const ok = !lf && !st.ad.unqualified(st);
    const next = ok ? st : candidate === st ? null : candidate;
    if (next !== candidate) { candidate = next; notify(); }
  }
  function canvasPlacement(c) {
    if (!c.isConnected) return 'canvas is not in the document';
    const rect = c.getBoundingClientRect();
    if (rect.width < T.minCssPx || rect.height < T.minCssPx) return `canvas is small (${rect.width | 0}x${rect.height | 0} CSS px)`;
    if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) return 'canvas is off screen';
    return null;
  }
  function cssEffect(canvas) {
    for (let e = canvas; e && e.nodeType === 1; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (parseFloat(s.opacity) < 1) return `opacity ${s.opacity} on ${desc(e)}`;
      if (s.filter && s.filter !== 'none') return `filter on ${desc(e)}`;
      if (s.backdropFilter && s.backdropFilter !== 'none') return `backdrop-filter on ${desc(e)}`;
      const mask = s.maskImage || s.webkitMaskImage;
      if (mask && mask !== 'none') return `mask on ${desc(e)}`;
      if (s.clipPath && s.clipPath !== 'none') return `clip-path on ${desc(e)}`;
      if (s.mixBlendMode && s.mixBlendMode !== 'normal') return `mix-blend-mode on ${desc(e)}`;
      if (e === canvas && ((s.borderRadius && s.borderRadius !== '0px') || (s.boxShadow && s.boxShadow !== 'none'))) return 'border-radius / box-shadow on the canvas';
    }
    return null;
  }
  async function activate(st) {
    claim(st); st.pending = true; st.lastWhy = null; st.tries++;
    info('converting', desc(st.canvas), `(${st.ad.label(st)})`);
    notify();
    let session = null;
    try {
      session = await xrRequest('inline-3d');
      if (!st.pending || foreign || !on()) { try { session.end(); } catch (e) { /* ignore */ } return; }
      const lf = liftedBy(st.canvas); // lifted while the session was being granted: nothing resized yet
      if (lf) { try { session.end(); } catch (e) { /* ignore */ } refuseLifted(st, lf); stand(st, 'the element was lifted (Convert to 3D)'); return; }
      st.session = session;
      st.ref = await session.requestReferenceSpace('viewer');
      session.addEventListener('end', () => { if (st.session === session) stand(st, 'the inline-3d session ended'); });
      st.armed = { at: now() };
      setTimeout(() => { if (st.armed) st.ad.flipIdle(st); }, 250);
    } catch (e) {
      warnOnce('session', 'inline-3d session refused — staying 2D:', e && e.message);
      if (session) { try { session.end(); } catch (e2) { /* ignore */ } }
      st.pending = false; unclaim(st);
      st.nextTry = now() + 10000;
      notify();
    }
  }
  function flip(st) {
    const ad = st.ad;
    const sf = surfaceOf(st);
    if (sf && sf.async && st.armed) {
      const a = st.armed;
      if (!a.pre) {
        a.pre = makeCover(st, false, true) || { el: null, ready: Promise.resolve() };
        a.pre.ready.then(() => { a.pre.done = true; if (st.armed === a) { try { ad.flipIdle(st); } catch (e) { /* the 250 ms flipIdle still runs */ } } });
        return;
      }
      if (!a.pre.done) return;
    }
    const pre = st.armed && st.armed.pre;
    st.armed = null;
    dropCover(st);
    if (pre && pre.el) { insertCover(st.canvas, pre.el); st.cover = { el: pre.el, fixed: pre.fixed }; } // read back one frame ago (above)
    else makeCover(st);       // the mono frame just drawn, over the canvas, until the join (rule 5)
    ad.beforeActive(st);
    st.active = true; st.pending = false;
    promote(st);
    ad.afterActive(st);
    const dr = depthRangeFor(st);
    st.near = dr.near; st.far = dr.far;
    try { st.session.updateRenderState({ depthNear: dr.near, depthFar: dr.far }); } catch (e) { /* ignore */ }
    st.rigScale = null; st.rigScaleWait = null; st.rigDecided = false; st.verdict = null; st.objLike = false; st.rigSwitch = null; st.glass = null; st.dp0 = 0; st.eyeK = 1; st.morph = null; st.anchorW = 1; // a new activation decides the rig's scale again (setScaleOnce)
    estimateConvergence(st, true);
    st.piv = null; // the display rig's pivot re-anchors on the page camera's axis (pivotOffset)
    buildRig(st, ad.rigFov(st));
    st.layer = null; st.layerAt = 0; st.coverDropAt = 0;
    st.stereo0 = st.stats.stereo; st.coverForced = false; // this activation's first stereo frame (status, forced cover)
    st.drawnAt = 0; // the no-views timer starts at the first draw / replay on the SBS store after the layer (drew())
    st.displayOk = null;
    st.lastTwoAt = 0; st.noDisplay = false; st.nd = false; st.eyesOn = false; st.twoRun = 0; st.shortRun = 0;
    st.rampK = T.rampMs > 0 ? 0 : 1; st.ramp = null; // flat under the cover; fades in once it drops
    if (!st.cover && st.rampK < 1) startRamp(st, 1);
    if (T.noLayer) {
      st.layerAt = now();
      guard.onFlip(st);
      if (T.fakeViews) { fakeViews(st); st.haveViews = true; }
      setTimeout(() => dropCover(st), T.holdMs);
    }
    else if (T.bindAfterCommit === false) { makeLayer(st); if (!st.active) return; } // TEST ONLY: v0.7.9's order
    else bindLayer(st); // once the side-by-side store and the cover are committed (#339)
    const session = st.session;
    const loop = (t, f) => {
      if (!st.active || st.session !== session) return;
      try { session.requestAnimationFrame(loop); } catch (e) { return; }
      onSessionFrame(st, f);
    };
    session.requestAnimationFrame(loop);
    ad.firstDraw(st);
    try { S.settle(st.canvas); } catch (e) { /* the sentinel's search is best-effort */ }
    info(`live on ${desc(st.canvas)}: SBS ${st.R.W}x${st.R.H} (eye ${st.R.eyeW}x${st.R.eyeH}), rig ${HAS_RIG ? rigMode() + (site.rigChoice === 'auto' ? ' (automatic: decided with the scale)' : '') : 'display (no setViewRig)'},`,
      `convergence ${st.conv.d.toPrecision(3)} units (${convText(st)}), depth ${depthOf()}`);
    st.convLogged = { d: st.conv.d, src: st.conv.src, via: st.conv.via }; st.convPrev = st.conv.d;
    notify();
  }
  function bindLayer(st) {
    const session = st.session, b = (st.binding = { drawn: false, frames: 0, at: now() });
    const step = () => {
      if (st.binding !== b) return;
      if (!st.active || st.session !== session) { st.binding = null; return; }
      if ((b.drawn && ++b.frames >= 2) || now() - b.at >= T.bindMaxMs) { st.binding = null; makeLayer(st); return; }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  function makeLayer(st) {
    const rig = buildRig(st, st.ad.rigFov(st));
    try {
      st.layer = new XRDisplayLayer(st.session, st.canvas, HAS_RIG ? { viewRig: { ...rig } } : { virtualDisplayHeight: 0.24 });
    } catch (e) {
      warnOnce('layer', 'new XRDisplayLayer() failed — staying 2D', e);
      stand(st, 'XRDisplayLayer refused the canvas');
      st.nextTry = Infinity;
      return;
    }
    st.layerAt = now(); st.coverDropAt = 0;
    guard.onFlip(st);
    st.drawnAt = 0; // the no-views timer starts at the first draw / replay on the SBS store from here
    if (!T.fakeViews) probeDisplay(st, st.layer); // fakeViews (tests) run where there is no display on purpose
    notify();
  }
  function stand(st, reason, opts) {
    if (st.releasing) { release(st); return; } // a second stand while one is staged: finish it now
    const was = st.active || st.pending || !!st.armed;
    const wasLive = st.active; // only a live canvas was resized to the SBS store
    st.active = false; st.pending = false; st.armed = null; st.binding = null;
    st.haveViews = false;
    const staged = !!(opts && opts.staged) && wasLive && !!st.layer && !!st.session && st.canvas.isConnected;
    if (staged) {
      const rel = (st.releasing = { at: now(), drawn: false, frames: 0 });
      let drew = false;
      try { drew = st.ad.restore(st, true) === true; } catch (e) { drew = true; }
      if (drew) rel.drawn = true;
      const step = () => {
        if (st.releasing !== rel) return;
        if (rel.drawn && ++rel.frames >= 2) { release(st); return; }
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
      setTimeout(() => { if (st.releasing === rel) release(st); }, T.releaseMaxMs); // a page that stopped drawing
    } else {
      closeLayer(st);
      st.ad.restore(st, wasLive);
      unpromote(st);
      dropCover(st);
      unclaim(st); // the store is mono and the layer gone: the marker goes last
    }
    if (was) info('back to 2D:', reason);
    notify();
  }
  function closeLayer(st) {
    if (st.layer) { try { st.layer.close(); } catch (e) { /* ignore */ } st.layer = null; }
    if (st.session) { const s = st.session; st.session = null; try { s.end().catch(() => {}); } catch (e) { /* ignore */ } }
  }
  function drew(st) {
    if (!st.active) return;
    if (st.binding) st.binding.drawn = true; // the SBS store holds a pair: the layer may follow (bindLayer)
    else if (!st.drawnAt) st.drawnAt = now();
  }
  function monoDrawn(st) { if (st.releasing) st.releasing.drawn = true; }
  function release(st) {
    const rel = st.releasing;
    if (!rel) return;
    st.releasing = null;
    closeLayer(st);
    unpromote(st);
    if (st.cover && st.cover.out) {
      const c = st.cover, t0 = now(); let n = 0;
      st.cover = null;
      const tick = () => { if (++n >= 6 && now() - t0 >= (T.outHoldMs || 150)) c.el.remove(); else requestAnimationFrame(tick); }; // outHoldMs: diagnostics only (a long hold shows what the cover holds)
      requestAnimationFrame(tick);
    }
    else dropCover(st);
    unclaim(st); // mono frame drawn (restore() at the stand), layer released: the marker goes last
    info(`layer released ${Math.round(now() - rel.at)} ms after the stand (${rel.drawn ? 'mono frame drawn first' : 'no mono frame: timed out'})`);
    if (st.wakeOnRelease) { st.wakeOnRelease = false; wake(st); }
    notify();
  }
  function wake(st) {
    if (!on() || foreign || owner) return;
    try { if (st.ad.wake) st.ad.wake(st); } catch (e) { warnOnce('wake', 'could not draw a frame on re-enable', e); }
  }
  function setEnabled(v, opts) {
    if (opts && opts.remember === false) once = !!v;
    else { once = null; site.decision = v ? 'allow' : 'block'; save({ decision: site.decision }); }
    info('auto-3D', on() ? 'ON' : 'OFF', 'for', location.origin);
    if (!on() && owner) turnOff(owner, 'turned off for this site');
    if (on() && owner) owner.offTok = null; // a turn-off still fading / covering out does not stand any more
    if (on() && owner && owner.active && owner.ramp && owner.ramp.to === 0) startRamp(owner, 1); // turned back on mid-fade: fade back up
    if (on()) {
      for (const w of tracked) {
        const st = w.deref();
        if (!st) continue;
        st.nextTry = 0; st.tries = 0; st.lastWhy = null;
        if (!st.offTok && !st.releasing) st.lifted = null; // the user asked: look again (a canvas still lifted is refused again)
        if (st.releasing) st.wakeOnRelease = true; else wake(st);
      }
    }
    notify();
  }
  function turnOff(st, reason) {
    const tok = (st.offTok = {});
    const go = () => { if (st.offTok === tok && owner === st) { st.offTok = null; stand(st, reason, { staged: true }); } };
    if (st.active && !st.cover && !st.releasing && T.rampMs > 0) startRamp(st, 0, go);
    else { st.offTok = null; stand(st, reason, { staged: true }); }
  }
  async function probeDisplay(st, layer) {
    const ask = async (name) => {
      if (typeof layer[name] !== 'function') return undefined;
      try { return await layer[name](); } catch (e) { return null; }
    };
    for (const wait of [0, 1500]) {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      if (st.layer !== layer) return;
      const di = await ask('getDisplayInfo');
      const modes = await ask('getRenderingModes');
      if (di === undefined && modes === undefined) return; // no display API on this build: fall back to the eye timeout
      if (di) st.di = di; // the nominal viewer and the panel's size (anchorEyes)
      if (di || (Array.isArray(modes) && modes.length)) { st.displayOk = true; return; }
    }
    if (st.layer !== layer) return;
    st.displayOk = false;
    st.noDisplay = true; // the chip's outline "no display" pill, report { flat, no-display }
    stand(st, 'no display behind the layer (getDisplayInfo() null, no rendering modes) — is another DisplayXR Browser holding it? (browser#162)');
    st.nextTry = now() + 30000;
  }
  function promote(st) {
    const c = st.canvas, s = c.style, cs = getComputedStyle(c);
    st.savedStyle = { willChange: s.willChange, transform: s.transform, pin: null };
    s.willChange = 'transform';
    if (cs.transform === 'none') s.transform = 'translateZ(0)';
    const isAuto = (p) => { try { const v = c.computedStyleMap().get(p); return !!v && String(v) === 'auto'; } catch (e) { return false; } };
    const pin = {};
    if (!s.width && isAuto('width')) pin.width = s.width = cs.width;
    if (!s.height && isAuto('height')) pin.height = s.height = cs.height;
    if (pin.width || pin.height) st.savedStyle.pin = pin;
  }
  function unpromote(st) {
    if (!st.savedStyle) return;
    const s = st.canvas.style, sv = st.savedStyle;
    s.willChange = sv.willChange;
    s.transform = sv.transform;
    if (sv.pin) for (const k of ['width', 'height']) if (sv.pin[k] && s[k] === sv.pin[k]) s[k] = ''; // unless the page set its own since
    st.savedStyle = null;
  }

  function onSessionFrame(st, frame) {
    const ad = st.ad;
    st.stats.xrFrames++;
    if (st.stats.xrFrames % 30 === 0 && !st.offTok && S.optedOut()) { standDownForGood(); turnOff(st, 'the page opted out (<meta name="displayxr-auto3d" content="off">)'); }
    if (st.stats.xrFrames % 30 === 15 && !st.offTok) { const lf = liftedBy(st.canvas); if (lf) { refuseLifted(st, lf); turnOff(st, 'the element was lifted (Convert to 3D)'); } }
    if (!st.canvas.isConnected) { stand(st, 'the canvas left the document'); return; }
    let views = null;
    try { const pose = st.ref ? frame.getViewerPose(st.ref) : null; views = pose ? pose.views : null; } catch (e) { /* no pose */ }
    const t = now();
    let two = false;
    if (views && views.length >= 2) {
      two = true;
      for (let i = 0; i < 2; i++) { st.V[i].proj.set(views[i].projectionMatrix); st.V[i].pose.set(views[i].transform.matrix); }
      st.haveViews = true; st.stats.twoView++;
      anchorEyes(st); // the nominal viewer on the page camera, the scaled lean clamped (camera rig; v0.7.12)
      st.eyeBack = Math.max(0, Math.min(st.V[0].pose[14], st.V[1].pose[14])) * (st.eyeK > 0 ? st.eyeK : 1) + (st.piv ? Math.hypot(st.piv.t[0], st.piv.t[1], st.piv.t[2]) : 0);
    } else {
      st.stats.shortView++;
      if (T.fakeViews && ad.hasCamera(st)) { fakeViews(st); st.haveViews = true; two = true; }
    }
    trackEyes(st, t, two);
    if (!st.haveViews && st.displayOk !== true && st.drawnAt && t - st.drawnAt > T.noViewsMs) {
      st.noDisplay = !st.lastTwoAt; // never a 2-view frame in this activation: most likely no weave slot
      stand(st, `no 2-view frame within ${T.noViewsMs} ms (nobody tracked, or this browser instance has no weave slot — browser#162)`, { staged: true });
      st.nextTry = st.tries < 3 ? t + 15000 : Infinity;
      return;
    }
    if (ad.hasCamera(st)) {
      const dr = depthRangeFor(st);
      if (dr.near !== st.near || dr.far !== st.far) {
        st.near = dr.near; st.far = dr.far;
        try { st.session.updateRenderState({ depthNear: dr.near, depthFar: dr.far }); } catch (e) { /* ending */ }
      }
      if (!estimateConvergence(st, false, true) && st.stats.xrFrames % (st.rigScale ? 30 : 10) === 0) estimateConvergence(st, false);
      if (!st.openLatched && st.stats.xrFrames % Math.max(1, T.walkEveryFrames | 0) === 0) walkTick(st);
      if (T.strictObject !== false && st.conv.src !== 'fixed' && !(st.verdict && st.verdict.done)) objectVerdict(st);
      if (st.stats.xrFrames % (st.verdict && st.verdict.done ? Math.max(1, T.overlayEveryFrames | 0) : 10) === 0) overlayTick(st);
      if (T.strictObject !== false && st.stats.xrFrames % 6 === 0) verdictWatch(st);
      cursorTick(st);
      tickRamp(st, t);
      tickRigSwitch(st);
      if (T.withheldMs > 0 && !st.cover && !st.releasing && st.layer) {
        let wsNow = null;
        try { if ('wovenState' in st.layer) wsNow = st.layer.wovenState; } catch (e) { wsNow = null; }
        if (wsNow !== 'withheld') st.withheldAt = 0;
        else if (!st.withheldAt) st.withheldAt = t;
        else if (t - st.withheldAt >= T.withheldMs) {
          st.withheldAt = 0;
          info(`the browser stopped weaving the canvas (withheld for ${T.withheldMs} ms): back to 2D, trying again shortly`);
          st.nextTry = now() + 3000;
          stand(st, 'the browser stopped weaving the canvas (wovenState withheld)');
          return;
        }
      }
      if (HAS_RIG && st.layer) { try { st.layer.setViewRig(buildRig(st, ad.rigFov(st))); } catch (e) { warnOnce('rig', 'setViewRig failed', e); } }
    }
    ad.redraw(st);
    if (st.outCoverDue && !ad.coverAfterDraw) takeOutCover(st);
    tickCover(st, t);
    guard.tick(st, t);
    chip.frame(st);
    if (st.stats.xrFrames % 20 === 0) notify();
  }

  function trackEyes(st, t, two) {
    if (two) {
      st.lastTwoAt = t; st.shortRun = 0;
      if (!st.twoRun) st.twoRun = t;
      if (!st.eyesOn && t - st.twoRun >= T.eyesOnMs) st.eyesOn = true;
    } else {
      st.twoRun = 0;
      if (!st.shortRun) st.shortRun = t;
      if (st.eyesOn && t - st.shortRun >= T.eyesOffMs) st.eyesOn = false;
    }
    const nd = st.active && !T.noLayer && (st.displayOk === false || (!st.lastTwoAt && T.coverMaxMs > 0 && st.layerAt > 0 && t - st.layerAt > T.coverMaxMs));
    if (nd !== st.nd) {
      st.nd = nd;
      if (nd) info(`no 2-view frame in the ${T.coverMaxMs} ms since the layer: 3D display not available to this window (another browser instance holding it?) — flat until one arrives`);
      notify();
    }
  }

  function takeOutCover(st) {
    const done = st.outCoverDue;
    if (!done) return;
    st.outCoverDue = null;
    makeCover(st, true);
    const el = st.cover && st.cover.el;
    const go = () => requestAnimationFrame(() => requestAnimationFrame(done));
    if (!el || el.isConnected) go(); // no cover, or the canvas cover (already painted in this task)
    else {
      const place = () => {
        if (!st.canvas.isConnected) { done(); return; }
        try { if (st.cover && st.cover.el === el) insertCover(st.canvas, el); } catch (e) {} // not if released meanwhile; done() always follows
        go();
      };
      const decode = () => { if (typeof el.decode === 'function') el.decode().then(place, place); else place(); };
      const ready = st.cover && st.cover.el === el ? st.cover.ready : null;
      if (ready) ready.then(decode, decode); else decode();
    }
  }

  const rigMode = () => (site.rig === 'display' ? 'display' : 'camera');
  const depthOf = (mode) => clamp(site.depths[mode || rigMode()] || DEFAULT_DEPTH[mode || rigMode()], DEPTH_MIN, DEPTH_MAX);
  function setDepth(v) { site.depths = { ...site.depths, [rigMode()]: clamp(v, DEPTH_MIN, DEPTH_MAX) }; }
  const convSource = (st) => (site.convScale !== 1 ? 'manual' : st.conv.src);
  const convText = (st) => convSource(st) + (st.conv.via ? ': ' + st.conv.via : '');
  function depthRangeFor(st) {
    const dr = st.ad.depthRange(st);
    return rigMode() === 'display' && st.eyeBack > 0 ? { near: dr.near, far: dr.far + st.eyeBack } : dr;
  }
  const rampK = (st) => (st.rampK === undefined ? 1 : st.rampK);
  function startRamp(st, to, done) {
    const r = (st.ramp = { from: rampK(st), to, t0: now(), done: done || null, held: 0 });
    if (done) setTimeout(() => { if (st.ramp === r || st.outCoverDue === done) { st.ramp = null; st.outCoverDue = null; st.rampK = to; done(); } }, T.rampMs + 1000);
  }
  function tickRamp(st, t) {
    const r = st.ramp;
    if (!r) return;
    const u = T.rampMs > 0 ? clamp((t - r.t0) / T.rampMs, 0, 1) : 1;
    st.rampK = r.from + (r.to - r.from) * u * u * (3 - 2 * u);
    if (u < 1) return;
    if (r.done && ++r.held < 3) return;
    st.ramp = null;
    if (r.done) st.outCoverDue = r.done; // the out-cover is made after this frame's draw, in the drawing task
  }
  function buildRig(st, verticalFov) {
    const r = buildRigMode(st, verticalFov, rigMode());
    return st.morph ? rigMorph(st, r) : ((st.anchorW = 1), r);
  }
  const lockedObject = (st) => !!(st.verdict && st.verdict.done && ((st.verdict.done.object && site.rig === 'display') || (st.verdict.done.like && !st.verdict.done.object)));
  function buildRigMode(st, verticalFov, mode) {
    if (!st.rigs) {
      st.rigs = {
        camera: st.rig,
        display: { type: 'display', position: { x: 0, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } },
      };
    }
    const d = rigDistance(st), ds = scaleDistance(st);
    const k = st.rigScale ? rampK(st) : 0;
    const dg = mode === 'display' || (st.objLike && st.conv.src !== 'fixed') ? coreGlass(st) * site.convScale : (st.glass = null, 0);
    if (mode === 'display') {
      const r = st.rigs.display;
      const dp = dg > 0 ? dg : ds;
      let dq = dp;
      if (dg > 0 && T.zoomLocal !== false) { if (st.morph || !(st.dp0 > 0)) st.dp0 = dp; dq = st.dp0; } else st.dp0 = 0;
      r.position.x = r.position.y = 0; r.position.z = -dq;
      r.orientation.x = r.orientation.y = r.orientation.z = 0; r.orientation.w = 1;
      r.virtualDisplayHeight = 2 * dq * Math.tan(verticalFov / 2);
      const dep = depthOf('display');
      r.ipdFactor = dep * k;
      r.parallaxFactor = dep * k;
      r.perspectiveFactor = 1;
      st.rig = r;
      return r;
    }
    st.dp0 = 0;
    const rig = st.rigs.camera;
    rig.type = 'camera';
    rig.position.x = rig.position.y = rig.position.z = 0;
    rig.orientation.x = rig.orientation.y = rig.orientation.z = 0; rig.orientation.w = 1;
    rig.verticalFov = verticalFov;
    rig.convergenceDiopters = 1 / (dg > 0 ? dg : d);
    if (st.conv.src === 'fixed') {
      rig.metersToVirtual = 1;
      const f = k * clamp(depthOf('camera') / (+T.openSceneRealDepth || 0.5), 0, 1);
      rig.ipdFactor = f;
      rig.parallaxFactor = f;
      st.rig = rig;
      return rig;
    }
    rig.metersToVirtual = (depthOf('camera') * ds) / 0.5;
    rig.ipdFactor = k;
    rig.parallaxFactor = k;
    st.rig = rig;
    return rig;
  }
  const rigDistance = (st) => Math.max(1e-6, (st.conv.d || 1) * site.convScale);
  const scaleDistance = (st) => Math.max(1e-6, ((st.rigScale && st.rigScale.d) || st.conv.d || 1) * site.convScale);
  function setScaleOnce(st, src, raw) {
    if (!st.active) return;
    const S = st.rigScale;
    if (src === 'fixed') {
      if (S && S.open) return;
      st.rigScale = { d: 0, open: true, basis: 'open scene' };
      decideAutoRig(st, src);
      info(`scale set: m2v 1 (open scene${S ? `; replaces ${scaleText(st, S)} (${S.basis})` : ''})`);
      scaleReady(st);
      return;
    }
    if (S) return;
    if (src === 'target' && raw > 0) {
      if (T.strictObject !== false && site.rigChoice === 'auto' && !st.openLatched && !objectVerdict(st)) return;
      st.rigScale = { d: raw, basis: `target${st.conv.via ? ': ' + st.conv.via : ''}` };
    } else {
      const W = st.rigScaleWait || (st.rigScaleWait = { t0: now(), xs: [] });
      if (src === 'estimator' && raw > 0) { W.xs.push(raw); if (W.xs.length > T.scaleSamples) W.xs.shift(); }
      const t = now(), xs = W.xs.slice().sort((a, b) => a - b), med = xs.length ? xs[xs.length >> 1] : 0;
      const consistent = xs.length >= T.scaleSamples && med > 0 && xs[xs.length - 1] - xs[0] <= T.scaleSpread * med;
      const quiet = !(guard.loading && guard.loading(t));
      const late = t - W.t0 >= T.scaleMaxWaitMs; // from this activation's first estimate (the flip)
      if (!(consistent && quiet) && !late) return;
      if (T.strictObject !== false && site.rigChoice === 'auto' && src === 'estimator' && !st.openLatched && !late && !objectVerdict(st)) return;
      const d = med > 0 ? med : st.conv.d || 1;
      st.rigScale = { d, basis: consistent && quiet ? `estimator: ${xs.length} consistent samples` : `estimator after ${(T.scaleMaxWaitMs / 1000).toFixed(0)} s${med > 0 ? (quiet ? ', samples not consistent' : ', page still loading') : ', no estimate'}` };
    }
    decideAutoRig(st, src);
    info(`scale set: ${scaleText(st, st.rigScale)} (${st.rigScale.basis}; distance ${st.rigScale.d.toPrecision(3)} units)`);
    scaleReady(st);
  }
  function scaleText(st, S) {
    if (S.open && rigMode() !== 'display') return 'm2v 1';
    const d = Math.max(1e-6, (S.d || st.conv.d || 1) * site.convScale);
    return rigMode() === 'display' ? `display portal ${(2 * d * Math.tan(st.ad.rigFov(st) / 2)).toPrecision(3)} units tall at ${d.toPrecision(3)}` : `m2v ${((depthOf('camera') * d) / 0.5).toPrecision(3)}`;
  }
  function walkHint(st) {
    try { const pl = document.pointerLockElement; if (pl && (pl === st.canvas || pl.contains(st.canvas))) return 'pointer lock on the canvas'; } catch (e) { /* ignore */ }
    try { return (st.ad.walkControls && st.ad.walkControls(st)) || null; } catch (e) { return null; }
  }
  function decideAutoRig(st, src) {
    if (site.rigChoice !== 'auto' || !HAS_RIG) return;
    if (lockedObject(st)) return;   // one rig per page: a page decided an object is not decided again
    let rig = 'camera', why;
    if (src === 'fixed' || st.openLatched) why = `open scene${st.openWhy ? ': ' + st.openWhy : ''}`;
    else if (src !== 'target' && T.strictObject === false) why = 'no page target (the estimator)';
    else {
      const w = walkHint(st);
      if (w) why = `the camera may walk: ${w}`;
      else {
        const o = {};
        let s = null;
        try { s = st.ad.sampler(st); } catch (e) { s = null; }
        if (s) estimateSubjectDistance(s, o);
        const v = T.strictObject !== false ? objectVerdict(st) : null;
        if (o.open) why = o.why;
        else if (o.surround) why = `surrounded: ${o.surround}`;
        else if (T.strictObject !== false && !(v && v.object)) why = v ? v.why : 'the scene has not settled';
        else { rig = 'display'; why = src === 'target' ? `object on a turntable (target: ${st.conv.via || 'the page'})` : 'an object seen from outside (no page target: the estimator)'; }
      }
    }
    setAutoRig(rig, why, !st.rigDecided);
    st.rigDecided = true;
  }
  function setAutoRig(rig, why, first) {
    const was = site.rig;
    site.rig = rig;
    if (was !== rig || first) info(`style: ${rig === 'display' ? 'Object on the glass (display rig)' : 'Scene camera (camera rig)'}, automatic: ${why}`);
    if (was !== rig) notify();
  }
  function scaleReady(st) { if (!st.cover && !st.coverForced && rampK(st) < 1 && !st.ramp && !st.releasing) startRamp(st, 1); }

  function objectVerdict(st) {
    const V = st.verdict || (st.verdict = { t0: now(), set: null, since: 0, tgt: null, moved: false, done: null });
    if (V.done) return V.done;
    const finish = (object, like, why) => {
      V.done = { object, like, why };
      st.objLike = like;
      info(`object test: ${object ? 'a simple object (display rig)' : like ? 'object-like, not certain (camera rig, core focus)' : 'not an object (camera rig)'} — ${why}`);
      return V.done;
    };
    if (typeof st.ad.coreSet !== 'function') return finish(false, false, 'this engine gives no surface to read');
    let s = null, set = null;
    try { s = st.ad.sampler(st); } catch (e) { s = null; }
    const t = now(), late = t - V.t0 >= T.settleMaxMs, d = st.conv.d || 0;
    if (!s || !(d > 0)) return late ? finish(false, false, 'no camera target to measure from') : null;
    const F = stageFrame(s, d);
    if (!V.tgt || Math.hypot(F.tx - V.tgt[0], F.ty - V.tgt[1], F.tz - V.tgt[2]) > 0.001 * d) V.tgtAt = now();
    V.tgt = [F.tx, F.ty, F.tz];
    V.moved = now() - V.tgtAt < T.settleMs;
    try { set = st.ad.coreSet(st, s, { d }); } catch (e) { set = null; }
    if (set !== V.set) { V.set = set; V.since = t; }
    const quiet = !(guard.loading && guard.loading(t));
    if (!late && (!set || t - V.since < T.settleMs || !quiet || V.moved)) return null;
    if (!late && !st.overlayTracked && !(st.ovl && st.ovl.looks >= 3) && t - V.t0 < 2500) return null;
    if (!set) return finish(false, false, 'no subject found in the scene');
    if (V.moved) return finish(false, false, 'the camera target moves (a follow camera, a pan or a scripted path)');
    let n = 0;
    for (const p of set.parts) n += p.k;
    const r = new Float32Array(n);
    let j = 0;
    for (const p of set.parts) {
      const m = p.m, q = p.pts, st4 = p.stride || 3;
      for (let i = 0, end = p.k * st4; i < end; i += st4) {
        const x = m[0] * q[i] + m[4] * q[i + 1] + m[8] * q[i + 2] + m[12] - F.tx;
        const y = m[1] * q[i] + m[5] * q[i + 1] + m[9] * q[i + 2] + m[13] - F.ty;
        const z = m[2] * q[i] + m[6] * q[i + 1] + m[10] * q[i + 2] + m[14] - F.tz;
        r[j++] = Math.hypot(x, y, z);
      }
    }
    const R = selectKth(r, n, Math.min(n - 1, Math.floor(0.95 * (n - 1))));
    V.R = R; V.Rf = F.Rf;
    V.F = F; // the frame the subject was recognised in: the stage test keeps using it (a zoom must not change which parts count)
    const fit = R / F.Rf;
    if (!(fit <= T.objFitMax)) return finish(false, false, `the scene is larger than the frame (${fit.toFixed(2)} x)`);
    if (!(fit >= T.objFitMin)) return finish(false, false, `the subject is a speck in the frame (${fit.toFixed(3)} x)`);
    if (!(d >= T.objStandoff * R)) return finish(false, false, `the camera is too close to, or inside, the subject (${(d / R).toFixed(2)} radii)`);
    if (set.other > 0) return finish(false, true, `${set.other} other part(s) in the scene besides the subject`);
    if (st.overlayTracked) return finish(false, true, 'page elements over the canvas follow the 3D scene (hotspots, labels)');
    return finish(true, true, `one compact subject, ${fit.toFixed(2)} x the frame, camera ${(d / R).toFixed(1)} radii away, nothing else in the scene`);
  }
  function cursorTick(st) {
    if (T.cursorDepth === false) return;
    const L = st.layer;
    if (!L || typeof L.setCursorDepth !== 'function' || typeof L.getCursorDepthSupport !== 'function') return;
    let C = st.cur;
    if (!C) {
      C = st.cur = { layer: null, support: 'none', sent: false, x: 0, y: 0, over: false, last: null };
      const mv = (e) => { C.x = e.clientX; C.y = e.clientY; C.over = true; };
      try {
        window.addEventListener('pointermove', mv, { capture: true, passive: true });
        document.addEventListener('pointerleave', () => { C.over = false; }, { capture: true, passive: true });
      } catch (e) { /* ignore */ }
    }
    if (C.layer !== L) {
      C.layer = L; C.support = 'pending'; C.sent = false;
      let p;
      try { p = Promise.resolve(L.getCursorDepthSupport()); } catch (e) { p = Promise.reject(e); }
      p.then((r) => { if (C.layer !== L) return; C.support = r === 'runtime' ? 'runtime' : 'none'; if (C.support === 'runtime' && !C.logged) { C.logged = true; info('3D cursor: the browser draws its cursor at the depth of the content under it'); } }, () => { if (C.layer === L) C.support = 'none'; });
    }
    if (C.support !== 'runtime') return;
    const withdraw = () => { C.last = null; if (!C.sent) return; C.sent = false; try { L.setCursorDepth(); } catch (e) { /* closed */ } };
    const set = st.glass && st.glass.set;
    if (!C.over || !set || !st.haveViews || rampK(st) < 1 || st.cover) { withdraw(); return; }
    let rect = null, s = null;
    try { rect = st.canvas.getBoundingClientRect(); } catch (e) { rect = null; }
    if (!rect || !(rect.width > 0 && rect.height > 0)) { withdraw(); return; }
    const u = (C.x - rect.left) / rect.width, v = (C.y - rect.top) / rect.height;
    if (!(u >= 0 && u <= 1 && v >= 0 && v <= 1)) { withdraw(); return; }
    try { s = st.ad.sampler(st); } catch (e) { s = null; }
    if (!s) { withdraw(); return; }
    const vm = s.viewMatrix || invert4(s.cameraPose);
    const E = [0, 1].map((i) => mul4(st.V[i].proj, mul4(invert4(eyeDrawn(st, i)), vm)));
    const sgn = st.V[0].pose[12] <= st.V[1].pose[12] ? 1 : -1;   // eye 0 is the left one
    const nx = 2 * u - 1, ny = 1 - 2 * v, asp = rect.width / rect.height, r2 = 0.05 * 0.05;
    let best = Infinity, any = false;
    for (const p of set.parts) {
      if (p.box) continue;
      const A = mul4(E[0], p.m), B = mul4(E[1], p.m), q = p.pts, st4 = p.stride || 3;
      for (let i = 0, end = p.k * st4; i < end; i += st4) {
        const x = q[i], y = q[i + 1], z = q[i + 2];
        const w0 = A[3] * x + A[7] * y + A[11] * z + A[15];
        if (!(w0 > 1e-9)) continue;
        const x0 = (A[0] * x + A[4] * y + A[8] * z + A[12]) / w0, dx = (x0 - nx) * asp;
        if (dx * dx > r2) continue;
        const dy = (A[1] * x + A[5] * y + A[9] * z + A[13]) / w0 - ny;
        if (dx * dx + dy * dy > r2) continue;
        const w1 = B[3] * x + B[7] * y + B[11] * z + B[15];
        if (!(w1 > 1e-9)) continue;
        const d = sgn * ((B[0] * x + B[4] * y + B[8] * z + B[12]) / w1 - x0);
        any = true;
        if (d < best) best = d;
      }
    }
    const msg = { u, v };
    if (any && isFinite(best)) msg.disparityPx = 0.5 * best * rect.width * (window.devicePixelRatio || 1);
    try { L.setCursorDepth(msg); C.sent = true; C.last = msg; } catch (e) { C.sent = false; }
  }
  function mul4(a, b) {
    const o = new Float64Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    return o;
  }
  function verdictWatch(st) {
  }
  function demote(st, why) {
    const V = st.verdict;
    if (!V || !V.done || !(V.done.object || V.done.like)) return;
    V.was = V.done; V.done = { object: false, like: false, why }; V.resumeSince = 0;
    st.objLike = false;
    info(`object test: no longer an object (camera rig) — ${why}`);
  }
  function overlayTick(st) {
    if (st.overlayTracked || !st.canvas || !st.canvas.isConnected) return;
    let s = null;
    try { s = st.ad.sampler(st); } catch (e) { s = null; }
    if (!s) return;
    const O = st.ovl || (st.ovl = { els: [], scanAt: -Infinity, pos: new WeakMap(), obs: new WeakMap(), self: new WeakSet(), cam: null, cr: null, looks: 0 });
    O.looks++;
    const cr = st.canvas.getBoundingClientRect(), t = now();
    if (!(cr.width > 0 && cr.height > 0)) return;
    if (t - O.scanAt > 2000) {
      O.scanAt = t; O.els = [];
      let root = st.canvas.parentElement;
      for (let i = 0; i < 2 && root && root.parentElement && root !== document.body; i++) root = root.parentElement;
      let host = null;
      try { const rn = st.canvas.getRootNode(); host = rn && rn.host ? rn.host : null; } catch (e) { host = null; }
      if (host && !O.declared) {
        O.declared = true;
        let hs = null;
        try { hs = host.querySelector('[slot^="hotspot"]'); } catch (e) { hs = null; }
        if (hs) {
          st.overlayTracked = true;
          info(`page overlays: the component declares hotspots over its 3D scene (${desc(hs)})`);
          if (site.rigChoice === 'auto' && site.rig === 'display') fadeRig(st, 'camera', 'page elements over the canvas follow the 3D scene (hotspots, labels)');
          return;
        }
      }
      const lists = [];
      if (root) lists.push(root.querySelectorAll('*'));
      if (host) { try { lists.push(host.querySelectorAll('*')); } catch (e) { /* ignore */ } }
      for (const all of lists) {
        for (let i = 0; i < all.length && i < 1500 && O.els.length < 80; i++) {
          const el = all[i];
          if (el === st.canvas || el.tagName === 'CANVAS' || el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.contains(st.canvas)) continue;
          if (el.hasAttribute('data-dxr-auto3d-hud') || el.hasAttribute('data-dxr-auto3d-chip')) continue;
          let cs = null;
          try { cs = getComputedStyle(el); } catch (e) { continue; }
          if (!cs || cs.visibility === 'hidden' || cs.display === 'none' || (cs.position !== 'absolute' && cs.position !== 'fixed' && cs.transform === 'none')) continue;
          const b = el.getBoundingClientRect();
          if (!(b.width > 0 && b.height > 0) || b.width > 0.4 * cr.width || b.height > 0.4 * cr.height) continue;
          if (b.right < cr.left || b.left > cr.right || b.bottom < cr.top || b.top > cr.bottom) continue;
          O.els.push(el);
        }
      }
    }
    const cp = s.cameraPose;
    let camMoved = false;
    if (O.cam) { let dsum = 0; for (let i = 0; i < 16; i++) dsum += Math.abs(cp[i] - O.cam[i]); camMoved = dsum > 1e-4; }
    const still = O.cr && Math.abs(cr.left - O.cr.left) < 0.5 && Math.abs(cr.top - O.cr.top) < 0.5 && Math.abs(cr.width - O.cr.width) < 0.5;
    const tanV = s.tanHalfFov !== undefined ? s.tanHalfFov : Math.tan(s.verticalFov / 2), tanH = tanV * (s.aspect || cr.width / cr.height);
    const sx = Math.hypot(cp[0], cp[1], cp[2]) || 1, sy = Math.hypot(cp[4], cp[5], cp[6]) || 1, sz = Math.hypot(cp[8], cp[9], cp[10]) || 1;
    let hit = null;
    for (const el of O.els) {
      if (!el.isConnected) continue;
      const b = el.getBoundingClientRect(), x = b.left + b.width / 2, y = b.top + b.height / 2, was = O.pos.get(el);
      const mv = was && Math.hypot(x - was[0], y - was[1]) > 2;
      O.pos.set(el, [x, y]);
      if (!was || !still) continue;
      if (mv && !camMoved) { O.self.add(el); O.obs.delete(el); continue; }   // moves on its own: a spinner, a CSS animation
      if (!camMoved || O.self.has(el)) continue;
      if (!mv) { O.obs.delete(el); continue; }                               // the camera moved, it did not: fixed UI
      const cx = (((x - cr.left) / cr.width) * 2 - 1) * tanH, cy = (1 - ((y - cr.top) / cr.height) * 2) * tanV;
      let dx = (cp[0] / sx) * cx + (cp[4] / sy) * cy - cp[8] / sz, dy = (cp[1] / sx) * cx + (cp[5] / sy) * cy - cp[9] / sz, dz = (cp[2] / sx) * cx + (cp[6] / sy) * cy - cp[10] / sz;
      const dl = Math.hypot(dx, dy, dz) || 1;
      dx /= dl; dy /= dl; dz /= dl;
      let L = O.obs.get(el);
      if (!L) O.obs.set(el, (L = []));
      L.push([cp[12], cp[13], cp[14], dx, dy, dz]);
      if (L.length > 16) L.shift();
      if (L.length >= 5 && pinnedTo3D(L, st.conv.d || 1)) { hit = el; break; }
    }
    O.cam = Float64Array.from(cp); O.cr = { left: cr.left, top: cr.top, width: cr.width };
    if (hit) {
      st.overlayTracked = true;
      info(`page overlays: an element over the canvas is pinned to a point of the 3D scene (${desc(hit)})`);
      if (site.rigChoice === 'auto' && site.rig === 'display') fadeRig(st, 'camera', 'page elements over the canvas follow the 3D scene (hotspots, labels)');
    }
  }
  function pinnedTo3D(L, scale) {
    let spread = 0;
    for (const r of L) spread = Math.max(spread, Math.hypot(r[0] - L[0][0], r[1] - L[0][1], r[2] - L[0][2]));
    if (spread < 0.03 * scale) return false;
    let a00 = 0, a01 = 0, a02 = 0, a11 = 0, a12 = 0, a22 = 0, b0 = 0, b1 = 0, b2 = 0;
    for (const [ox, oy, oz, dx, dy, dz] of L) {
      const m00 = 1 - dx * dx, m01 = -dx * dy, m02 = -dx * dz, m11 = 1 - dy * dy, m12 = -dy * dz, m22 = 1 - dz * dz;
      a00 += m00; a01 += m01; a02 += m02; a11 += m11; a12 += m12; a22 += m22;
      b0 += m00 * ox + m01 * oy + m02 * oz; b1 += m01 * ox + m11 * oy + m12 * oz; b2 += m02 * ox + m12 * oy + m22 * oz;
    }
    const c00 = a11 * a22 - a12 * a12, c01 = a02 * a12 - a01 * a22, c02 = a01 * a12 - a02 * a11;
    const det = a00 * c00 + a01 * c01 + a02 * c02;
    if (!(Math.abs(det) > 1e-9)) return false;
    const c11 = a00 * a22 - a02 * a02, c12 = a01 * a02 - a00 * a12, c22 = a00 * a11 - a01 * a01;
    const px = (c00 * b0 + c01 * b1 + c02 * b2) / det, py = (c01 * b0 + c11 * b1 + c12 * b2) / det, pz = (c02 * b0 + c12 * b1 + c22 * b2) / det;
    let minCos = 1;
    const f = L[0], fx = f[0] - px, fy = f[1] - py, fz = f[2] - pz, fl = Math.hypot(fx, fy, fz) || 1;
    for (const r of L) { const x = r[0] - px, y = r[1] - py, z = r[2] - pz; minCos = Math.min(minCos, (x * fx + y * fy + z * fz) / ((Math.hypot(x, y, z) || 1) * fl)); }
    if (minCos > Math.cos((12 * Math.PI) / 180) || fl > 4 * scale) return false;
    let err = 0;
    for (const [ox, oy, oz, dx, dy, dz] of L) {
      const vx = px - ox, vy = py - oy, vz = pz - oz, along = vx * dx + vy * dy + vz * dz;
      if (!(along > 0)) return false; // behind a camera
      err = Math.max(err, Math.hypot(vx - along * dx, vy - along * dy, vz - along * dz) / along);
    }
    return err < 0.02; // within ~1 degree of every ray
  }
  function fadeRig(st, rig, why) {
    if (site.rig === rig && !st.rigSwitch) return;
    if (!st.active || !st.rigScale || rampK(st) <= 0) { st.rigSwitch = null; setAutoRig(rig, why, false); return; }
    if (startMorph(st)) { st.rigSwitch = null; setAutoRig(rig, why, false); return; }   // a morph, not a fade
    st.rigSwitch = { rig, why };
    startRamp(st, 0);
  }
  function tickRigSwitch(st) {
    const W = st.rigSwitch;
    if (!W || st.ramp || rampK(st) > 0) return;
    st.rigSwitch = null;
    if (W.reset) { W.reset(); return; }   // the scale decision fades it back in (scaleReady)
    setAutoRig(W.rig, W.why, false);
    startRamp(st, 1);
  }

  function rigDisplayInfo(st) {
    const di = st.di, nom = nominalOf(st);
    const Hpx = di && di.displayPixelHeight, hm = di && di.displayHeightMeters;
    if (!nom || !(Hpx > 0 && hm > 0) || !(nom.z > 0)) return null;
    let h = 0;
    try { h = st.canvas.getBoundingClientRect().height * (window.devicePixelRatio || 1); } catch (e) { h = 0; }
    const H = (hm * h) / Hpx;
    return H > 0 && isFinite(H) ? { H, N: nom.z } : null;
  }
  function cameraForm(rig, w, I) {
    if (rig.type === 'display') {
      const p = rig.perspectiveFactor > 0 ? rig.perspectiveFactor : 1, es = (p * rig.virtualDisplayHeight) / I.H;
      return { z: rig.position.z + es * I.N, tanV: I.H / (2 * I.N) / p, invd: 1 / (es * I.N), e: (+rig.ipdFactor || 0) * es, q: (+rig.parallaxFactor || 0) * es, w: 0 };
    }
    const m = rig.metersToVirtual > 0 ? rig.metersToVirtual : 1;
    return { z: rig.position.z, tanV: Math.tan(rig.verticalFov / 2), invd: +rig.convergenceDiopters || 0, e: (+rig.ipdFactor || 0) * m, q: (+rig.parallaxFactor || 0) * m, w };
  }
  function startMorph(st) {
    const I = T.morphMs > 0 && st.active && st.rig && st.rigScale && rampK(st) >= 1 && !st.ramp ? rigDisplayInfo(st) : null;
    if (!I) return false;
    st.morph = { from: st.morph && st.morph.at ? { ...st.morph.at } : cameraForm(rigShown(st), st.rig.type === 'camera' ? 1 : 0, I), t0: now(), at: null };
    return true;
  }
  function rigShown(st) {
    const r = st.rig, k = st.eyeK > 0 ? st.eyeK : 1;
    if (!r || r.type !== 'display' || k === 1) return r;
    return { ...r, position: { x: 0, y: 0, z: r.position.z * k }, virtualDisplayHeight: r.virtualDisplayHeight * k };
  }
  function rigMorph(st, target) {
    const M = st.morph, I = rigDisplayInfo(st);
    const u0 = T.morphMs > 0 ? clamp((now() - M.t0) / T.morphMs, 0, 1) : 1;
    if (!I || u0 >= 1) { st.morph = null; st.anchorW = 1; return target; }
    const u = u0 * u0 * (3 - 2 * u0), a = M.from, b = cameraForm(target, target.type === 'camera' ? 1 : 0, I);
    const lerp = (x, y) => x + (y - x) * u;
    const c = { z: lerp(a.z, b.z), tanV: Math.tan(lerp(Math.atan(a.tanV), Math.atan(b.tanV))), invd: lerp(a.invd, b.invd), e: lerp(a.e, b.e), q: lerp(a.q, b.q), w: lerp(a.w, b.w) };
    const dt = a.tanV - b.tanV, xs = Math.abs(dt) > 1e-9 ? (b.z * b.tanV - a.z * a.tanV) / dt : NaN;
    if (isFinite(xs) && xs > 0 && c.tanV > 1e-9) c.z = ((xs + a.z) * a.tanV) / c.tanV - xs;
    const pa = a.invd > 0 ? 1 / a.invd - a.z : 0, pb = b.invd > 0 ? 1 / b.invd - b.z : 0;
    if (pa > 0 && pb > 0) { const pc = 1 / lerp(1 / pa, 1 / pb); if (pc + c.z > 1e-9) c.invd = 1 / (pc + c.z); }
    M.at = c;
    const r = st.rigs.morph || (st.rigs.morph = { type: 'camera', position: { x: 0, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } });
    const m = Math.max(c.e, c.q, 1e-9);
    r.position.z = c.z; r.verticalFov = 2 * Math.atan(c.tanV); r.convergenceDiopters = c.invd;
    r.metersToVirtual = m; r.ipdFactor = c.e / m; r.parallaxFactor = c.q / m;
    st.anchorW = c.w;
    st.rig = r;
    return r;
  }

  function coreGlass(st) {
    if (T.coreGlass === false || !st.active || typeof st.ad.coreSet !== 'function') { st.glass = null; return 0; }
    let s = null, set = null;
    try { s = st.ad.sampler(st); } catch (e) { s = null; }
    if (!s) return st.glass ? st.glass.d : 0;
    const vm = s.viewMatrix || invert4(s.cameraPose);
    try { set = st.ad.coreSet(st, s, { d: st.conv.d || 0, F: st.verdict && st.verdict.done ? st.verdict.F : null }); } catch (e) { warnOnce('core-set', 'could not read the scene surface: the glass stays at the scale distance', e); set = null; }
    if (!set || !set.parts || !set.parts.length) { st.glass = null; return 0; }
    const G = st.glass || (st.glass = { key: null, d: 0, buf: null, n: 0, logged: false });
    const kn = 16 * (set.parts.length + 1);
    let same = G.set === set && G.key && G.key.length === kn;
    if (!G.key || G.key.length !== kn) G.key = new Float64Array(kn);
    const K = G.key;
    for (let i = 0; i < 16; i++) { if (K[i] !== vm[i]) { same = false; K[i] = vm[i]; } }
    for (let j = 0; j < set.parts.length; j++) { const m = set.parts[j].m, o = 16 * (j + 1); for (let i = 0; i < 16; i++) { if (K[o + i] !== m[i]) { same = false; K[o + i] = m[i]; } } }
    if (same) return G.d;
    G.set = set;
    let total = 0;
    for (const p of set.parts) total += p.k;
    if (!G.buf || G.buf.length < total) G.buf = new Float32Array(total);
    const z = G.buf, near = s.near || 0;
    const cp = s.cameraPose || invert4(vm), radial = T.glassMetric !== 'axial' && !!cp, cx = cp ? cp[12] : 0, cy = cp ? cp[13] : 0, cz = cp ? cp[14] : 0;
    let n = 0;
    for (const p of set.parts) {
      const m = p.m, q = p.pts, st4 = p.stride || 3;
      const a = vm[2] * m[0] + vm[6] * m[1] + vm[10] * m[2], b = vm[2] * m[4] + vm[6] * m[5] + vm[10] * m[6];
      const c = vm[2] * m[8] + vm[6] * m[9] + vm[10] * m[10], e = vm[2] * m[12] + vm[6] * m[13] + vm[10] * m[14] + vm[14];
      let zlo = Infinity, zhi = -Infinity;
      if (radial) {
        for (let i = 0, end = p.k * st4; i < end; i += st4) {
          const x = q[i], y = q[i + 1], w = q[i + 2];
          const d = Math.hypot(m[0] * x + m[4] * y + m[8] * w + m[12] - cx, m[1] * x + m[5] * y + m[9] * w + m[13] - cy, m[2] * x + m[6] * y + m[10] * w + m[14] - cz);
          if (isFinite(d)) { z[n++] = d; if (d < zlo) zlo = d; if (d > zhi) zhi = d; }
        }
      } else
      for (let i = 0, end = p.k * st4; i < end; i += st4) {
        const d = -(a * q[i] + b * q[i + 1] + c * q[i + 2] + e);
        if (d > near && isFinite(d)) { z[n++] = d; if (d < zlo) zlo = d; if (d > zhi) zhi = d; }
      }
      p.zlo = zlo; p.zhi = zhi;
    }
    if (n < 16) { G.d = 0; return 0; }
    const gf = clamp(+T.glassFront || 1 / 3, 0.02, 0.98), tr = clamp(+T.glassTrim || 0, 0, 0.3);
    let dz;
    if (T.glassRule === 'surface') dz = selectKth(z, n, Math.min(n - 1, Math.floor(gf * (n - 1))));
    else { const lo = selectKth(z, n, Math.floor(tr * (n - 1))), hi = selectKth(z, n, Math.floor((1 - tr) * (n - 1))); G.lo = lo; G.hi = hi; dz = lo + gf * (hi - lo); }
    const d = Math.max(dz, 1e-6);
    G.d = d; G.n = n;
    if (!G.logged) {
      G.logged = true;
      info(`glass: core ${T.glassRule === 'surface' ? 'surface' : 'depth range'}, ${Math.round(gf * 100)}% in front at every angle (${n} points over ${set.parts.length} part(s)${set.note ? '; ' + set.note : ''}); now ${d.toPrecision(3)} units`);
    }
    return d;
  }
  function sampleSurface(cands, budget, maxTris) {
    let total = 0;
    for (const e of cands) {
      const m = e.m;
      if (e.pts) continue;
      if (!e.P) {
        const sx = Math.hypot(m[0], m[1], m[2]), sy = Math.hypot(m[4], m[5], m[6]), sz = Math.hypot(m[8], m[9], m[10]);
        const ex = (e.max[0] - e.min[0]) * sx, ey = (e.max[1] - e.min[1]) * sy, ez = (e.max[2] - e.min[2]) * sz;
        e.area = 2 * (ex * ey + ey * ez + ez * ex); total += e.area > 0 && isFinite(e.area) ? e.area : 0;
        continue;
      }
      const P = e.P, I = e.I && e.I.length >= 3 ? e.I : null, sp = e.stride || 3, nV = Math.floor(P.length / sp);
      const nTri = Math.floor((I ? I.length : nV) / 3), step = Math.max(1, Math.ceil(nTri / maxTris)), nt = Math.ceil(nTri / step);
      const tri = new Float32Array(nt * 9), cum = new Float64Array(nt);
      let k = 0, acc = 0;
      for (let t = 0; t < nTri; t += step) {
        const i0 = (I ? I[t * 3] : t * 3) * sp, i1 = (I ? I[t * 3 + 1] : t * 3 + 1) * sp, i2 = (I ? I[t * 3 + 2] : t * 3 + 2) * sp;
        if (i0 + 2 >= P.length || i1 + 2 >= P.length || i2 + 2 >= P.length) continue;
        const o9 = k * 9;
        tri[o9] = P[i0]; tri[o9 + 1] = P[i0 + 1]; tri[o9 + 2] = P[i0 + 2];
        tri[o9 + 3] = P[i1]; tri[o9 + 4] = P[i1 + 1]; tri[o9 + 5] = P[i1 + 2];
        tri[o9 + 6] = P[i2]; tri[o9 + 7] = P[i2 + 1]; tri[o9 + 8] = P[i2 + 2];
        const ax = tri[o9 + 3] - tri[o9], ay = tri[o9 + 4] - tri[o9 + 1], az = tri[o9 + 5] - tri[o9 + 2];
        const bx = tri[o9 + 6] - tri[o9], by = tri[o9 + 7] - tri[o9 + 1], bz = tri[o9 + 8] - tri[o9 + 2];
        const e1x = m[0] * ax + m[4] * ay + m[8] * az, e1y = m[1] * ax + m[5] * ay + m[9] * az, e1z = m[2] * ax + m[6] * ay + m[10] * az;
        const e2x = m[0] * bx + m[4] * by + m[8] * bz, e2y = m[1] * bx + m[5] * by + m[9] * bz, e2z = m[2] * bx + m[6] * by + m[10] * bz;
        const area = 0.5 * Math.hypot(e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x);
        acc += area > 0 && isFinite(area) ? area : 0;
        cum[k++] = acc;
      }
      e.tri = tri; e.cum = cum; e.nt = k; e.area = acc * step; total += e.area;
    }
    let seed = 0x9e3779b9;
    const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    const parts = [];
    for (const e of cands) {
      const m = e.m;
      if (e.pts) {
        const st4 = e.stride || 3, stepS = Math.max(1, Math.ceil(e.k / budget));
        let pts = e.pts, k = e.k;
        if (stepS > 1) { k = Math.floor(e.k / stepS); pts = new Float32Array(k * st4); for (let i = 0; i < k; i++) for (let c = 0; c < st4; c++) pts[i * st4 + c] = e.pts[i * stepS * st4 + c]; }
        if (k > 0) parts.push({ pts, k, stride: st4, m, name: e.name });
        continue;
      }
      if (!(total > 0) || !(e.area > 0) || !isFinite(e.area)) continue;
      const k = Math.max(8, Math.round((budget * e.area) / total)), pts = new Float32Array(k * 3);
      if (!e.P) {
        for (let i = 0; i < k; i++) for (let c = 0; c < 3; c++) pts[i * 3 + c] = e.min[c] + rnd() * (e.max[c] - e.min[c]);
      } else {
        const tri = e.tri, cum = e.cum, nt = e.nt, top = nt ? cum[nt - 1] : 0;
        if (!(top > 0)) continue;
        for (let i = 0; i < k; i++) {
          const r = rnd() * top;
          let lo = 0, hi = nt - 1;
          while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < r) lo = mid + 1; else hi = mid; }
          let u = rnd(), v = rnd();
          if (u + v > 1) { u = 1 - u; v = 1 - v; }
          const o9 = lo * 9;
          for (let c = 0; c < 3; c++) pts[i * 3 + c] = tri[o9 + c] + u * (tri[o9 + 3 + c] - tri[o9 + c]) + v * (tri[o9 + 6 + c] - tri[o9 + c]);
        }
        e.tri = e.cum = null;
      }
      parts.push({ pts, k, stride: 3, m, name: e.name, box: !e.P });
    }
    return parts;
  }
  function isStage(wx, wy, wz, wr, ex, ey, ez, F) {
    if (Math.hypot(wx - F.px, wy - F.py, wz - F.pz) <= wr) return 1;
    const big = Math.max(ex, ey, ez), thin = Math.min(ex, ey, ez);
    if (thin < 0.03 * big && wr > 1.5 * F.Rf) return 3;
    if (wr > 4 * F.Rf) return 2;
    return Math.hypot(wx - F.tx, wy - F.ty, wz - F.tz) - wr > 1.5 * F.Rf ? 4 : 0;
  }
  function stageFrame(s, d) {
    const cw = s.cameraPose, fl = Math.hypot(cw[8], cw[9], cw[10]) || 1;
    const tanV = s.tanHalfFov !== undefined ? s.tanHalfFov : Math.tan(s.verticalFov / 2);
    return { px: cw[12], py: cw[13], pz: cw[14], tx: cw[12] - (cw[8] / fl) * d, ty: cw[13] - (cw[9] / fl) * d, tz: cw[14] - (cw[10] / fl) * d,
      Rf: d > 0 ? d * tanV * Math.max(1, s.aspect || 1) : Infinity };
  }
  function selectKth(a, n, k) {
    let lo = 0, hi = n - 1;
    while (lo < hi) {
      const pv = a[(lo + hi) >> 1];
      let i = lo, j = hi;
      while (i <= j) {
        while (a[i] < pv) i++;
        while (a[j] > pv) j--;
        if (i <= j) { const t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; }
      }
      if (k <= j) hi = j; else if (k >= i) lo = i; else return a[k];
    }
    return a[k];
  }

  const PIVOT_CUT_COS = Math.cos(Math.PI / 6);
  const ZERO3 = Object.freeze([0, 0, 0]);
  function pivotOffset(st, m) {
    if (rigMode() !== 'display' || T.displayPivot === false || !m || (st.glass && st.glass.d > 0)) { st.piv = null; return null; }
    const d = scaleDistance(st), P = st.piv; // the portal's distance (buildRig places it at the scale distance)
    if (P && P.d === d) {
      let same = true;
      for (let k = 0; k < 16; k++) if (P.m[k] !== m[k]) { same = false; break; }
      if (same) return P.t;
    }
    const p = [m[12], m[13], m[14]];
    const fl = Math.hypot(m[8], m[9], m[10]) || 1;
    const f = [-m[8] / fl, -m[9] / fl, -m[10] / fl];
    let c = null;
    if (P) {
      const dp = [p[0] - P.p[0], p[1] - P.p[1], p[2] - P.p[2]];
      const u = [f[0] - P.f[0], f[1] - P.f[1], f[2] - P.f[2]];
      const uu = u[0] * u[0] + u[1] * u[1] + u[2] * u[2];
      const s = uu > 1e-12 ? -(dp[0] * u[0] + dp[1] * u[1] + dp[2] * u[2]) / uu : 0;
      const tr = [dp[0] + s * u[0], dp[1] + s * u[1], dp[2] + s * u[2]];
      const cut = f[0] * P.f[0] + f[1] * P.f[1] + f[2] * P.f[2] < PIVOT_CUT_COS || Math.hypot(tr[0], tr[1], tr[2]) > P.d;
      if (!cut) {
        const dd = d - P.d;
        c = [P.c[0] + tr[0] + f[0] * dd, P.c[1] + tr[1] + f[1] * dd, P.c[2] + tr[2] + f[2] * dd];
      }
    }
    let t = ZERO3;
    if (!c) c = [p[0] + f[0] * d, p[1] + f[1] * d, p[2] + f[2] * d]; // (re-)anchored on the page camera's axis: t = 0
    else {
      const w = [c[0] - f[0] * d - p[0], c[1] - f[1] * d - p[1], c[2] - f[2] * d - p[2]];
      const ax = (k) => { const x = m[k], y = m[k + 1], z = m[k + 2], n = x * x + y * y + z * z || 1; return (x * w[0] + y * w[1] + z * w[2]) / n; };
      t = [ax(0), ax(4), ax(8)];
    }
    st.piv = { m: Float64Array.from(m), p, f, c, d, t };
    return t;
  }
  function eyePose(st, i, m) {
    const src = st.V[i].pose, t = pivotOffset(st, m), k = eyeScale(st);
    const none = !t || t === ZERO3 || (t[0] === 0 && t[1] === 0 && t[2] === 0);
    if (none && k === 1) return src;
    const o = st.Vp || (st.Vp = [new Float32Array(16), new Float32Array(16)]);
    o[i].set(src);
    if (k !== 1) { o[i][12] *= k; o[i][13] *= k; o[i][14] *= k; }
    if (!none) { o[i][12] += t[0]; o[i][13] += t[1]; o[i][14] += t[2]; }
    return o[i];
  }
  function eyeScale(st) {
    if (!(st.dp0 > 0) || st.morph || !st.rig || st.rig.type !== 'display') return (st.eyeK = 1);
    const g = coreGlass(st) * site.convScale;
    return (st.eyeK = g > 0 ? g / st.dp0 : 1);
  }
  function eyeDrawn(st, i) {
    const k = st.eyeK > 0 ? st.eyeK : 1;
    if (k === 1) return st.V[i].pose;
    const o = st.Vd || (st.Vd = [new Float32Array(16), new Float32Array(16)]);
    o[i].set(st.V[i].pose); o[i][12] *= k; o[i][13] *= k; o[i][14] *= k;
    return o[i];
  }
  function latchOpen(st, why) {
    if (st.openLatched || lockedObject(st)) return;
    st.openLatched = true; st.openWhy = why; st.openByWalk = /^walk/.test(why);
    info(`open scene: ${why} — fixed focus for the rest of this page`);
    demote(st, `open scene: ${why}`);
    st.objLike = false;
    if (site.rigChoice === 'auto' && site.rig === 'display') fadeRig(st, 'camera', `open scene: ${why}`);
  }
  function walkTick(st) {
    if (T.openWalk === false || st.openLatched || !st.active) return;
    const why = walkSignal(st);
    if (why) { latchOpen(st, `walk: ${why}`); estimateConvergence(st, false); }
  }
  function walkSignal(st) {
    const c = walkHint(st);
    if (c) return c;
    let s = null;
    try { s = st.ad.sampler(st); } catch (e) { s = null; }
    if (!s || !s.cameraPose) return null;
    const m = s.cameraPose, fl = Math.hypot(m[8], m[9], m[10]) || 1;
    const p = [m[12], m[13], m[14]], f = [-m[8] / fl, -m[9] / fl, -m[10] / fl];
    const scale = Math.min(st.conv.d > 0 ? st.conv.d : Infinity, st.sceneExtent > 0 ? st.sceneExtent : Infinity);
    const W = st.walk;
    const S = (st.walk = { p, f, travel: W ? W.travel : 0, turn: W ? W.turn : 0 });
    if (!W || !isFinite(scale)) return null;
    const dp = [p[0] - W.p[0], p[1] - W.p[1], p[2] - W.p[2]];
    const u = [f[0] - W.f[0], f[1] - W.f[1], f[2] - W.f[2]];
    const uu = u[0] * u[0] + u[1] * u[1] + u[2] * u[2];
    const ang = Math.acos(clamp(f[0] * W.f[0] + f[1] * W.f[1] + f[2] * W.f[2], -1, 1));
    const sP = uu > 1e-12 ? -(dp[0] * u[0] + dp[1] * u[1] + dp[2] * u[2]) / uu : 0;
    const tr = Math.hypot(dp[0] + sP * u[0], dp[1] + sP * u[1], dp[2] + sP * u[2]);
    if (ang > Math.PI / 6 || Math.hypot(dp[0], dp[1], dp[2]) > scale) return null; // a cut
    S.travel += tr;
    if (ang > 1e-4 && Math.abs(sP) < (+T.walkPivotFrac || 0.25) * scale) S.turn += ang;
    if (S.travel >= (+T.walkTravel || 0.5) * scale && S.turn >= ((+T.walkTurnDeg || 20) * Math.PI) / 180) {
      return `the camera moved ${S.travel.toPrecision(3)} units and turned ${Math.round((S.turn * 180) / Math.PI)} deg about itself (scene scale ${scale.toPrecision(3)})`;
    }
    return null;
  }

  function anchorEyes(st) {
    st.anchor = null;
    const rig = st.rig;
    if (T.eyeAnchor === false || !rig || rig.type !== 'camera') return;
    const nom = nominalOf(st);
    if (!nom) return;
    const m2v = rig.metersToVirtual > 0 ? rig.metersToVirtual : 1, pf = +rig.parallaxFactor || 0, invd = +rig.convergenceDiopters || 0;
    const aw = st.anchorW === undefined ? 1 : clamp(st.anchorW, 0, 1); // 1; < 1 only while a rig morph is in flight (rigMorph)
    if (!(aw > 0)) return;
    const r = [aw * m2v * pf * (nom.x - nom.cx), aw * m2v * pf * (nom.y - nom.cy), 0];
    const A = st.V[0].pose, Bp = st.V[1].pose;
    const c = [(A[12] + Bp[12]) / 2, (A[13] + Bp[13]) / 2, (A[14] + Bp[14]) / 2];
    const dev = [c[0] - r[0], c[1] - r[1], c[2] - r[2]];
    if (Math.hypot(dev[0], dev[1], dev[2]) < 1e-6 * (1 + Math.hypot(r[0], r[1], r[2]) + Math.hypot(c[0], c[1], c[2]))) dev[0] = dev[1] = dev[2] = 0;
    const dl = Math.hypot(dev[0], dev[1], dev[2]);
    let lim = Infinity;
    if (st.conv.src !== 'fixed') {
      const nr = Math.min(st.conv.d > 0 ? st.conv.d : Infinity, st.nearSurf > 0 ? st.nearSurf : Infinity);
      if (isFinite(nr)) lim = (+T.eyeLeanMax || 0.5) * nr;
    }
    const k = 1 + ((dl > lim ? lim / dl : 1) - 1) * aw;
    for (const V of st.V) {
      const e = V.pose, P = V.proj;
      const n = [dev[0] * k + e[12] - c[0], dev[1] * k + e[13] - c[1], dev[2] * k + e[14] - c[2]];
      const a = 1 + e[14] * invd, b = 1 + n[2] * invd;
      if (invd > 0 && a > 0.05 && b > 0.05) {
        const p0 = P[0], p5 = P[5];
        P[8] -= ((n[0] - e[12]) * invd * p0) / a; P[9] -= ((n[1] - e[13]) * invd * p5) / a;
        P[0] = (p0 * b) / a; P[5] = (p5 * b) / a;
      }
      e[12] = n[0]; e[13] = n[1]; e[14] = n[2];
    }
    st.anchor = { r, dev: dl, lim: isFinite(lim) ? lim : null, clamped: k < 1 };
  }
  function nominalOf(st) {
    const di = st.di, rep = di && di.nominalViewerPosition;
    const W = di && di.displayPixelWidth, H = di && di.displayPixelHeight, wm = di && di.displayWidthMeters, hm = di && di.displayHeightMeters;
    if (!(W > 0 && H > 0 && wm > 0 && hm > 0)) {
      if (di && !st.anchorNoted) { st.anchorNoted = true; info('eye anchor: the display reports no panel size — eyes as the runtime places them'); }
      return null;
    }
    const fb = Array.isArray(T.nominalFallback) ? T.nominalFallback : [0, 0.1, 0.6];
    const reported = !!(rep && rep.z > 0);
    const nv = reported ? rep : { x: +fb[0] || 0, y: +fb[1] || 0, z: +fb[2] || 0.6 };
    if (!st.anchorNoted) {
      st.anchorNoted = true;
      info(`eye anchor: nominal viewer (${(+nv.x || 0).toFixed(3)}, ${(+nv.y || 0).toFixed(3)}, ${(+nv.z).toFixed(3)}) m ${reported ? 'as the display reports it' : 'by fallback (the display reports none; the runtime Leia SR / sim-display nominal)'} — the page camera is that viewer`);
    }
    if (!st.nomC || st.stats.xrFrames - st.nomC.at >= 30 || st.stats.xrFrames < st.nomC.at) {
      let cx = 0, cy = 0;
      try {
        const rc = st.canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1, sc = window.screen || {};
        const k = sc.width > 0 ? W / sc.width : dpr; // screen DIP -> panel pixels
        const chromeX = Math.max(0, (window.outerWidth - window.innerWidth) / 2), chromeY = Math.max(0, window.outerHeight - window.innerHeight);
        const x = (window.screenX - (sc.availLeft || 0) + chromeX) * k + (rc.left + rc.width / 2) * dpr;
        const y = (window.screenY - (sc.availTop || 0) + chromeY) * k + (rc.top + rc.height / 2) * dpr;
        cx = (x - W / 2) * (wm / W); cy = -(y - H / 2) * (hm / H);
      } catch (e) { /* the panel centre */ }
      st.nomC = { at: st.stats.xrFrames, cx: isFinite(cx) ? cx : 0, cy: isFinite(cy) ? cy : 0 };
    }
    return { x: +nv.x || 0, y: +nv.y || 0, z: +nv.z, cx: st.nomC.cx, cy: st.nomC.cy };
  }
  function estimateConvergence(st, snap, targetOnly) {
    const s = st.ad.sampler(st);
    if (!s) return false;
    let d = T.convTarget ? targetDepth(st, s) : 0, src = 'target', raw = d;
    if (!(d > 0)) {
      if (targetOnly) return false;
      src = 'estimator'; st.conv.via = null;
      const o = {};
      d = st.openLatched ? 0 : estimateSubjectDistance(s, o);
      raw = d > 0 && isFinite(d) ? d : 0; // a real estimate (not the fallback below)
      if (!st.openLatched) {
        if (o.near > 0) st.nearSurf = o.near; // the nearest surface in view (anchorEyes' lean clamp)
        if (o.extent > 0) st.sceneExtent = o.extent; // the bounded items' size (walkTick's scale)
        st.surroundRuns = !o.open && o.surround && T.openSurround !== false ? (st.surroundRuns || 0) + 1 : 0;
        if (st.surroundRuns >= Math.max(1, T.surroundRuns | 0)) latchOpen(st, `surrounded: ${o.surround}`);
      }
      if ((st.openLatched || o.open) && !lockedObject(st)) {
        if (!st.openLatched) latchOpen(st, o.why || 'the camera stands inside a world');
        src = 'fixed'; st.conv.via = 'open scene'; d = +T.openSceneConvM || 2;
        if (o.p > 0 && !st.scaleWarned && (o.p < 0.2 || o.p > 200)) {
          st.scaleWarned = true;
          info(`open scene: the ${Math.round(clamp(+T.convRoomPercentile || 0.7, 0.05, 0.95) * 100)}th-percentile depth in view is ${o.p.toPrecision(3)} units: the scene may not be metric; use Focus nearer / farther`);
        }
      } else if (!(d > 0) || !isFinite(d)) d = st.conv.d || Math.max(s.near * 50, 1);
    }
    d = src === 'fixed' || !(s.far * 0.9 > s.near * 2) ? Math.max(d, s.near * 2) : clamp(d, s.near * 2, s.far * 0.9);
    st.conv.d = snap || !st.conv.d || src === 'fixed' || (src === 'target' && st.conv.src === 'target') ? d : st.conv.d + (d - st.conv.d) * 0.25;
    const was = st.conv.src;
    st.conv.src = src;
    setScaleOnce(st, src, clamp(raw, s.near * 2, s.far * 0.9) || 0);
    if (was !== src && st.active) notify(); // the chip shows the source ('fixed')
    if (st.active && st.convLogged) settleLog(st);
    return true;
  }
  let settleLines = 0, settleAt = -Infinity;
  function settleLog(st) {
    const L = st.convLogged, d = st.conv.d, prev = st.convPrev;
    st.convPrev = d;
    const moved = st.conv.src !== L.src || st.conv.via !== L.via || Math.abs(d - L.d) > 0.05 * L.d;
    if (!moved || !(prev > 0) || Math.abs(d - prev) > 0.01 * d) return;
    if (settleLines >= 3 || now() - settleAt < 2000) return;
    settleLines++; settleAt = now();
    st.convLogged = { d, src: st.conv.src, via: st.conv.via };
    info(`convergence settled: ${d.toPrecision(3)} units (${convText(st)})`);
  }
  function targetDepth(st, s) {
    let t = null;
    try { t = st.ad.target ? st.ad.target(st) : null; } catch (e) { t = null; }
    if (!t || !isFinite(t.x) || !isFinite(t.y) || !isFinite(t.z)) return 0;
    if (st.openByWalk && /lookAt|setTarget/.test(t.via || '')) return 0;
    const vm = s.viewMatrix || invert4(s.cameraPose);
    const vx = vm[0] * t.x + vm[4] * t.y + vm[8] * t.z + vm[12];
    const vy = vm[1] * t.x + vm[5] * t.y + vm[9] * t.z + vm[13];
    const z = -(vm[2] * t.x + vm[6] * t.y + vm[10] * t.z + vm[14]);
    if (!(z > s.near * 2) || !(z < s.far * 0.9)) return 0;
    const tanV = s.tanHalfFov !== undefined ? s.tanHalfFov : Math.tan(s.verticalFov / 2);
    if (Math.hypot(vx, vy) / z > 0.25 * tanV) return 0;
    st.conv.via = t.via || null;
    return z;
  }
  function invert4(m) {
    const o = new Float64Array(16);
    const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3], a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
    const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11], a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
    const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
    const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12, b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
    const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (!det) return o;
    det = 1 / det;
    o[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det; o[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
    o[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det; o[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
    o[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det; o[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
    o[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det; o[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
    o[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det; o[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
    o[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det; o[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
    o[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det; o[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
    o[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det; o[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
    return o;
  }
  function estimateSubjectDistance(s, out) {
    const cw = s.cameraPose;
    const vm = s.viewMatrix || invert4(cw);
    const px = cw[12], py = cw[13], pz = cw[14];
    const tanV = s.tanHalfFov !== undefined ? s.tanHalfFov : Math.tan(s.verticalFov / 2), aspect = s.aspect || 1;
    const near = s.near;
    const fixedMode = T.openSceneMode !== 'percentile';
    let items = [];
    let n = 0, among = false, enclosing = 0, world = 0, bounded = 0;
    const B = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    let fx = -cw[8], fz = -cw[10];
    const fl = Math.hypot(fx, fz);
    if (fl > 1e-6) { fx /= fl; fz /= fl; } else { fx = 0; fz = -1; } // looking straight up / down: any heading
    let sides = 0;
    s.forEachBounds((wx, wy, wz, wr, inVolume, isSplat) => {
      if (n >= 4000) return false;
      n++;
      if (Math.hypot(wx - px, wy - py, wz - pz) <= wr) { enclosing++; if (isSplat) world++; return true; }
      if (inVolume) { among = true; enclosing++; world++; }
      else {
        B[0] = Math.min(B[0], wx - wr); B[1] = Math.min(B[1], wy - wr); B[2] = Math.min(B[2], wz - wr);
        B[3] = Math.max(B[3], wx + wr); B[4] = Math.max(B[4], wy + wr); B[5] = Math.max(B[5], wz + wr);
        const dx = wx - px, dz = wz - pz;
        if (Math.abs(wy - py) <= wr && Math.hypot(dx, dz) > 1e-6) {
          const fwd = dx * fx + dz * fz, right = -dx * fz + dz * fx; // right = forward × up
          sides |= Math.abs(fwd) >= Math.abs(right) ? (fwd > 0 ? 1 : 4) : (right > 0 ? 2 : 8);
        }
      }
      const vx = vm[0] * wx + vm[4] * wy + vm[8] * wz + vm[12];
      const vy = vm[1] * wx + vm[5] * wy + vm[9] * wz + vm[13];
      const z = -(vm[2] * wx + vm[6] * wy + vm[10] * wz + vm[14]);
      if (z <= near) return true;
      if (Math.abs(vx) - wr > z * tanV * aspect * 1.2 || Math.abs(vy) - wr > z * tanV * 1.2) return true; // out of view
      items.push({ z, r: wr, x: wx, y: wy, w: wz, v: !!inVolume });
      if (!inVolume) bounded++;
      return true;
    });
    if (out) {
      let nr = Infinity;
      for (const it of items) if (!it.v) nr = Math.min(nr, Math.max(it.z - it.r, near));
      out.near = isFinite(nr) ? nr : 0;
      out.extent = B[3] >= B[0] ? Math.hypot(B[3] - B[0], B[4] - B[1], B[5] - B[2]) / 2 : 0;
      const inside = px >= B[0] && px <= B[3] && py >= B[1] && py <= B[4] && pz >= B[2] && pz <= B[5];
      const nSides = ((sides & 1) && 1) + ((sides & 2) && 1) + ((sides & 4) && 1) + ((sides & 8) && 1);
      out.surround = fixedMode && inside && nSides >= Math.max(1, T.surroundSides | 0) ? `geometry on ${nSides} of 4 sides at the camera's height, inside the scene's bounds` : '';
    }
    if (fixedMode && (world || (enclosing && !bounded))) {
      if (out) {
        out.open = true; out.p = items.length ? weightedPercentile(items, clamp(+T.convRoomPercentile || 0.7, 0.05, 0.95)) : 0;
        out.why = world ? 'the camera stands inside a world (a splat volume holds it)' : 'the camera stands inside a world (nothing bounded in view)';
      }
      return 0;
    }
    if (!items.length) return 0;
    let cx = 0, cy = 0, cz = 0, ws = 0;
    for (const it of items) { const k = it.r * it.r + 1e-12; cx += it.x * k; cy += it.y * k; cz += it.w * k; ws += k; }
    cx /= ws; cy /= ws; cz /= ws;
    let R = 0;
    for (const it of items) R = Math.max(R, Math.hypot(it.x - cx, it.y - cy, it.w - cz) + it.r);
    if (!among && Math.hypot(cx - px, cy - py, cz - pz) > R) return -(vm[2] * cx + vm[6] * cy + vm[10] * cz + vm[14]);
    return weightedPercentile(items, among ? clamp(+T.convRoomPercentile || 0.5, 0.05, 0.95) : 0.5);
  }
  function weightedPercentile(items, q) {
    items.sort((a, b) => a.z - b.z);
    let tot = 0;
    for (const it of items) { it.k = Math.min(1, (it.r / it.z) ** 2); tot += it.k; }
    let acc = 0;
    for (const it of items) { acc += it.k; if (acc >= tot * q) return it.z; }
    return items[items.length - 1].z;
  }
  function fakeViews(st) {
    const p = st.ad.fakeViewParams(st);
    const d = Math.max(1e-6, (st.conv.d || 1) * site.convScale);
    const b = (0.063 * depthOf('camera') * d) / 0.5;
    const nr = p.near, fr = p.far, t = p.t, a = p.aspect;
    for (let i = 0; i < 2; i++) {
      const ex = (i === 0 ? -0.5 : 0.5) * b;
      const sh = (-ex * nr) / d;
      const o = st.V[i].proj, l = -t * a + sh, r = t * a + sh;
      o.fill(0);
      o[0] = (2 * nr) / (r - l); o[5] = nr / t; o[8] = (r + l) / (r - l);
      o[10] = -(fr + nr) / (fr - nr); o[11] = -1; o[14] = (-2 * fr * nr) / (fr - nr);
      const q = st.V[i].pose;
      q.fill(0); q[0] = q[5] = q[10] = q[15] = 1; q[12] = ex;
    }
  }

  function coverBackground(el) {
    for (let e = el.parentElement; e; e = e.parentElement) {
      const bg = getComputedStyle(e).backgroundColor;
      if (bg && bg !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(bg)) return bg;
    }
    return '#fff';
  }
  function makeCover(st, eyeOnly, pre) {
    try {
      const cv = st.canvas, cs = getComputedStyle(cv);
      const c = document.createElement('canvas');
      const dpr = window.devicePixelRatio || 1;
      c.setAttribute('data-dxr-auto3d-cover', '');
      const fixed = cs.position === 'fixed';
      const box = fixed ? cv.getBoundingClientRect() : { left: cv.offsetLeft, top: cv.offsetTop, width: cv.offsetWidth, height: cv.offsetHeight };
      c.width = Math.max(1, Math.round(box.width * dpr));
      c.height = Math.max(1, Math.round(box.height * dpr));
      Object.assign(c.style, {
        position: fixed ? 'fixed' : 'absolute', left: box.left + 'px', top: box.top + 'px', width: box.width + 'px', height: box.height + 'px',
        zIndex: cs.zIndex, pointerEvents: 'none', margin: '0', padding: '0', border: '0', background: coverBackground(cv),
      });
      const sf = surfaceOf(st);
      let ready = null;
      if (eyeOnly && st.R) {
        let got = false;
        try { got = sf ? sf.readEye(st, c) : false; } catch (e) { got = false; }
        if (got && typeof got.then === 'function') {
          c.getContext('2d').drawImage(cv, 0, 0, st.R.eyeW, st.R.eyeH, 0, 0, c.width, c.height);
          ready = got.then((ok) => {
            st.outCoverVia = ok ? 'readback' : 'drawImage';
            if (!ok) warnOnce('outcover', `could not read the flat frame back from ${apiName(sf)} — the 3D->2D cover may be blank`);
          }, () => { st.outCoverVia = 'drawImage'; });
        } else if (got) st.outCoverVia = 'readback';
        else {
          st.outCoverVia = 'drawImage';
          warnOnce('outcover', `could not read the flat frame back from ${apiName(sf)} — the 3D->2D cover may be blank`);
          if (sf) sf.flush();
          c.getContext('2d').drawImage(cv, 0, 0, st.R.eyeW, st.R.eyeH, 0, 0, c.width, c.height);
        }
      }
      else if (pre) {
        let got = false;
        try { got = sf ? sf.readFrame(st, c) : false; } catch (e) { got = false; }
        if (got && typeof got.then === 'function') ready = got.then((ok) => { if (!ok) warnOnce('incover', `could not read the mono frame back from ${apiName(sf)} — the 2D->3D cover may be blank`); });
        else { if (sf) sf.flush(); c.getContext('2d').drawImage(cv, 0, 0, c.width, c.height); } // no read-back (no COPY_SRC, HDR): the drawing task's drawImage
      }
      else { if (sf) sf.flush(); c.getContext('2d').drawImage(cv, 0, 0, c.width, c.height); } // the mono frame drawn in this same task
      if (T.coverImg !== false) {
        const img = document.createElement('img');
        img.setAttribute('data-dxr-auto3d-cover', ''); img.alt = '';
        if (eyeOnly) img.decoding = 'sync';
        if (ready) ready = ready.then(() => { img.src = c.toDataURL('image/png'); });
        else img.src = c.toDataURL('image/png');
        img.style.cssText = c.style.cssText; img.style.objectFit = 'fill';
        if (!eyeOnly && T.coverOpacity > 0 && T.coverOpacity < 1) img.style.opacity = String(T.coverOpacity);
        if (pre) return { el: img, fixed, ready: (ready || Promise.resolve()).then(() => (typeof img.decode === 'function' ? img.decode() : null)).then(() => true, () => true) };
        if (!eyeOnly) insertCover(cv, img); // the out-cover is inserted by its caller, once decoded
        st.cover = ready ? { el: img, fixed, out: !!eyeOnly, ready } : { el: img, fixed, out: !!eyeOnly };
        return;
      }
      if (pre) return { el: c, fixed, ready: (ready || Promise.resolve()).then(() => true) };
      insertCover(cv, c);
      st.cover = { el: c, fixed };
    } catch (e) { if (pre) return null; st.cover = null; }
  }
  function insertCover(cv, el) {
    if (cv.parentNode) cv.parentNode.insertBefore(el, cv.nextSibling);
    else (document.body || document.documentElement).appendChild(el);
  }
  function tickCover(st, t) {
    const cv = st.cover;
    if (!cv) {
      if (st.coverForced && st.stats.stereo > (st.stereo0 || 0)) { st.coverForced = false; if (st.rampK < 1 && !st.ramp && st.rigScale) startRamp(st, 1); }
      return;
    }
    let joined = true, ws = null;
    try { if (st.layer && 'wovenState' in st.layer) { ws = st.layer.wovenState; joined = ws === 'woven'; } } catch (e) { joined = true; }
    if (!cv.out && st.layerAt > 0 && t - st.layerAt >= T.holdMs && st.stats.stereo > 0 && joined) {
      dropCover(st); // a hard cut, never a fade: the picture under it is flat (rampK 0) and fades in from here
      st.coverDropAt = t; // the frame-rate guard's warm-up counts from here
      info(`cover released ${Math.round(t - st.layerAt)} ms after the layer (hold ${T.holdMs} ms${ws ? `, the browser reports the canvas ${ws}` : ''})`);
      if (st.rampK < 1 && st.rigScale) startRamp(st, 1); // else it fades in once the scale is set (scaleReady)
      return;
    }
    if (!cv.out && T.coverMaxMs > 0 && st.layerAt > 0 && t - st.layerAt >= T.coverMaxMs && ws !== null && !joined && st.stats.stereo > 0) {
      info(`the browser did not weave the canvas within ${T.coverMaxMs} ms (it reports ${ws}): staying 2D`);
      st.nextTry = now() + 30000;
      stand(st, `the browser did not weave the canvas (wovenState ${ws})`);
      return;
    }
    if (!cv.out && T.coverMaxMs > 0 && st.layerAt > 0 && t - st.layerAt >= T.coverMaxMs) {
      dropCover(st);
      st.coverDropAt = t;
      st.coverForced = true;
      info(`cover released at its ${T.coverMaxMs} ms maximum with no 2-view frame yet (nobody tracked?): flat until the eyes arrive`);
      return;
    }
    if (cv.fixed) {
      const rect = st.canvas.getBoundingClientRect();
      Object.assign(cv.el.style, { left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', height: rect.height + 'px' });
    }
  }
  function dropCover(st) { if (st.cover) { st.cover.el.remove(); st.cover = null; } }

  const flatNote = () => {
    for (const w of tracked) { const st = w.deref(); if (st && st.flatReason) return st; }
    return null;
  };
  const liftedNote = () => {
    for (const w of tracked) { const st = w.deref(); if (st && st.lifted) return st; }
    return null;
  };
  function statusOf() {
    const st = owner;
    if (foreign) return { status: 'standdown', reason: foreign };
    if (S.optedOut()) return { status: 'optout' };
    if (guard.tripped) return { status: 'guard', reason: guard.tripped };
    if (guard.retrying) return { status: 'converting', engine: (st || lastTarget || {}).engine, reason: guard.retrying };
    if (st && st.active && st.nd) return { status: 'flat', engine: st.engine, reason: 'no-display' };
    if (st && st.active && st.stats.stereo <= (st.stereo0 || 0)) return { status: 'converting', engine: st.engine, waiting: true };
    if (st && st.active) return { status: 'live', engine: st.engine };
    if (st && (st.pending || st.armed)) return { status: 'converting', engine: st.engine };
    if (!st && !candidate) { const lf = liftedNote(); if (lf) return { status: 'standdown', engine: lf.engine, reason: 'lifted' }; }
    if (!on()) return { status: site.decision === 'offer' && once === null ? 'offer' : 'off' };
    if (!st && lastTarget && lastTarget.noDisplay) return { status: 'flat', engine: lastTarget.engine, reason: 'no-display' };
    const flat = flatNote();
    if (flat) return { status: 'flat', engine: flat.engine, reason: flat.flatReason };
    return { status: 'idle' };
  }
  function status() {
    const s = statusOf(), t = lastTarget || candidate;
    return {
      state: s.status, reason: s.reason || null, waiting: !!s.waiting, engine: s.engine || (t ? t.engine : null), canvas: t ? t.canvas : null,
      rig: rigMode(), rigAuto: site.rigChoice === 'auto', depth: depthOf(), depths: { camera: depthOf('camera'), display: depthOf('display') },
      convScale: site.convScale, convSource: owner && owner.active ? convSource(owner) : null,
      convText: owner && owner.active ? convText(owner) : null, convergence: owner && owner.active ? owner.conv.d * site.convScale : null, rigSupported: HAS_RIG, haveViews: !!(owner && owner.haveViews), tracking: !!(owner && owner.eyesOn),
      enabled: on(), cover: t && t.cover ? t.cover.el : null, coverUp: !!(t && t.cover && !t.cover.out),
      layerAt: t && t.layer ? t.layerAt : 0, holdMs: T.holdMs, ramping: !!(owner && owner.ramp), retrying: !!guard.retrying,
    };
  }
  let lastReport = '';
  const listeners = [];
  let chip = null, dev = null; // created below, before any adapter can call notify()
  function notify() {
    const s = statusOf();
    const key = `${s.status}|${s.engine || ''}|${s.reason || ''}`;
    if (key !== lastReport) {
      lastReport = key;
      try { cap.report(s.waiting ? { status: s.status, engine: s.engine } : s); } catch (e) { warnOnce('report', 'could not report the status', e); }
    }
    if (chip) chip.update(status());
    if (dev) dev.hud();
    for (const cb of listeners.slice()) { try { cb(); } catch (e) { warnOnce('onchange', 'a status listener threw', e); } }
  }
  const remember = (opts) => !(opts && opts.remember === false);
  const ctl = Object.freeze({
    status,
    setEnabled(v, opts) { setEnabled(v, opts); },
    setRig(m, opts) {
      site.rig = m === 'display' ? 'display' : 'camera';
      site.rigChoice = site.rig; // the user chose: no automatic rig for this document (and the site, when remembered)
      info(`${site.rig} rig for`, location.origin);
      if (remember(opts)) save({ rig: site.rig });
      notify();
    },
    setDepth(v, opts) {
      setDepth(+v);
      if (remember(opts)) save({ depths: { ...site.depths } });
      notify();
    },
    nudgeFocus(dir, opts) {
      site.convScale = dir > 0 ? clamp(site.convScale * 1.15, CONV_SCALE_MIN, CONV_SCALE_MAX) : dir < 0 ? clamp(site.convScale / 1.15, CONV_SCALE_MIN, CONV_SCALE_MAX) : 1;
      if (remember(opts)) save({ convScale: site.convScale });
      notify();
    },
    reset(opts) {
      setDepth(DEFAULT_DEPTH[rigMode()]);
      site.convScale = 1;
      if (remember(opts)) save({ depths: { ...site.depths }, convScale: site.convScale });
      notify();
    },
    onChange(cb) { listeners.push(cb); return () => { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); }; },
  });

  let retired = false;
  function standDownForGood() {
    if (retired) return;
    retired = true;
    try { S.disarm(); } catch (e) { /* ignore */ }
  }

  window.addEventListener('pagehide', () => { if (owner) stand(owner, 'pagehide'); });

  const meta = {}; // per-engine facts adapters publish (three.js revision, PlayCanvas detection path, …)
  const core = {
    VERSION, TAG, HAS_RIG, DEFAULT_DEPTH, DEPTH_MIN, DEPTH_MAX, CONV_SCALE_MIN, CONV_SCALE_MAX, T, site, cfg,
    intrinsics: S.intrinsics,
    get owner() { return owner; },
    get foreign() { return foreign; },
    get retired() { return retired; }, // stood down for good: the adapters' detection entry points are no-ops
    get lastTarget() { return lastTarget; },
    on, meta, tracked, engines,
    registerEngine(name) { if (!engines.includes(name)) engines.push(name); },
    info, warnOnce, clamp, now, desc, realW, realH, CANVAS_W, CANVAS_H,
    newState, noteFlat, claims, considerActivation, canvasPlacement, cssEffect, flip, stand, monoDrawn, drew, yieldTo, notify, turnOff, save, standDownForGood, wake,
    realSizeFor, fitEyes, virtualizeCanvas, unvirtualizeCanvas,
    buildRig, pivotOffset, eyePose, sampleSurface, isStage, stageFrame, estimateSubjectDistance, estimateConvergence, invert4, fakeViews,
    makeCover, dropCover, takeOutCover, surfaces, surfaceOf, readGlEye: surfaces.readGlEye,
    rigMode, depthOf, convSource, convText, rampK, flatNote, statusOf, setEnabled,
  };
  const guard = dxrGuard(core);
  chip = dxrChip(ctl, S);
  core.chip = chip; // dev.js: __dxrAuto3D.chip()
  dev = cfg.dev ? dxrDev(core, ctl) : null;
  const en = cfg.engines || {};
  const three = en.three === false ? null : dxrThree(core);
  const playcanvas = en.playcanvas === false ? null : dxrPlayCanvas(core);
  const babylon = en.babylon === false ? null : dxrBabylon(core);
  gl = en.gl === false ? null : dxrGl(core);

  S.onForeign(yieldTo);
  if (S.foreign()) yieldTo(S.foreign());
  info(`core armed (v${VERSION})`, on() ? '' : '(OFF for this site)');
  notify();
  return { ctl, three, playcanvas, babylon, gl, claims: (c) => claims(c, 'WebGL') };
}
function dxrSurface(core) {
  const { warnOnce } = core;

  function readGlEye(gl, st, target) {
    if (!gl || !st.R || typeof gl.readPixels !== 'function' || (gl.isContextLost && gl.isContextLost())) return false;
    const bw = gl.drawingBufferWidth, bh = gl.drawingBufferHeight;
    const w = Math.min(st.R.eyeW, bw), h = Math.min(st.R.eyeH, bh);
    if (!(w > 0 && h > 0)) return false;
    const gl2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
    const px = new Uint8Array(w * h * 4);
    const fb = gl.getParameter(gl.FRAMEBUFFER_BINDING); // WebGL2: the DRAW binding
    const rfb = gl2 ? gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) : null;
    const pack = gl.getParameter(gl.PACK_ALIGNMENT);
    const pbo = gl2 ? gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING) : null;
    const p2 = gl2 ? [gl.PACK_ROW_LENGTH, gl.PACK_SKIP_PIXELS, gl.PACK_SKIP_ROWS].map((k) => [k, gl.getParameter(k)]) : [];
    try {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (pack !== 4) gl.pixelStorei(gl.PACK_ALIGNMENT, 4);
      if (pbo) gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      for (const [k, v] of p2) if (v) gl.pixelStorei(k, 0);
      gl.readPixels(0, bh - h, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    } catch (e) { return false; } finally {
      for (const [k, v] of p2) if (v) gl.pixelStorei(k, v);
      if (pbo) gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
      if (pack !== 4) gl.pixelStorei(gl.PACK_ALIGNMENT, pack);
      if (gl2) { gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fb); gl.bindFramebuffer(gl.READ_FRAMEBUFFER, rfb); }
      else gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    }
    let any = 0;
    for (let i = 0; i < px.length; i += 4) { any |= px[i] | px[i + 1] | px[i + 2] | px[i + 3]; px[i + 3] = 255; }
    if (!any) return false; // an all-zero read is a cleared buffer, not a picture
    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    tmp.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px.buffer), w, h), 0, 0);
    const g = target.getContext('2d');
    g.save();
    g.translate(0, target.height); g.scale(1, -1); // flip: the read is bottom-up
    g.drawImage(tmp, 0, 0, w, h, 0, 0, target.width, target.height);
    g.restore();
    return true;
  }
  function gl(ctx) {
    let lim;
    return {
      kind: 'webgl',
      limit() {
        if (lim === undefined) {
          let v = Infinity;
          try { const vp = ctx.getParameter(ctx.MAX_VIEWPORT_DIMS); v = Math.min(ctx.getParameter(ctx.MAX_TEXTURE_SIZE), ctx.getParameter(ctx.MAX_RENDERBUFFER_SIZE), vp[0], vp[1]); } catch (e) { v = Infinity; }
          lim = v > 0 ? v : Infinity; // a context's limits do not change
        }
        return lim;
      },
      flush() {}, // the default framebuffer is readable as drawn, in the drawing task
      readEye: (st, target) => readGlEye(ctx, st, target),
      readFrame: () => false, // the core's drawImage of the canvas, in the drawing task
      async: false,
      toClip: (m) => m,
    };
  }

  function toClipGpu(m, out) {
    for (let c = 0; c < 4; c++) {
      out[c * 4] = m[c * 4]; out[c * 4 + 1] = m[c * 4 + 1];
      out[c * 4 + 2] = 0.5 * (m[c * 4 + 2] + m[c * 4 + 3]);
      out[c * 4 + 3] = m[c * 4 + 3];
    }
    return out;
  }
  function readGpuEye(o, st, target, full) {
    const { device, context } = o;
    if (!device || !context || (!full && !st.R) || typeof context.getCurrentTexture !== 'function') return false;
    let tex = null;
    try { tex = context.getCurrentTexture(); } catch (e) { return false; }
    const U = typeof GPUTextureUsage !== 'undefined' ? GPUTextureUsage : null;
    if (!tex || !U || !(tex.usage & U.COPY_SRC)) { warnOnce('gpu-copysrc', 'WebGPU canvas without COPY_SRC: no cover read-back (covers via drawImage in the drawing task)'); return false; }
    const fmt = String(tex.format || '');
    const bgra = /^bgra8unorm/.test(fmt);
    if (!bgra && !/^rgba8unorm/.test(fmt)) { warnOnce('gpu-format', `WebGPU canvas format ${fmt} (HDR?): no cover read-back, the covers may be blank`); return false; }
    const w = full ? tex.width : Math.min(st.R.eyeW, tex.width), h = full ? tex.height : Math.min(st.R.eyeH, tex.height);
    if (!(w > 0 && h > 0)) return false;
    const bpr = Math.ceil((w * 4) / 256) * 256;
    let buf = null;
    try {
      o.flush(); // the engine's commands for this frame are queued before the copy
      buf = device.createBuffer({ size: bpr * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const enc = device.createCommandEncoder();
      enc.copyTextureToBuffer({ texture: tex, origin: { x: 0, y: 0, z: 0 } }, { buffer: buf, bytesPerRow: bpr, rowsPerImage: h }, { width: w, height: h, depthOrArrayLayers: 1 });
      device.queue.submit([enc.finish()]);
    } catch (e) { if (buf) { try { buf.destroy(); } catch (e2) { /* ignore */ } } return false; }
    const premul = o.alphaMode === 'premultiplied';
    return buf.mapAsync(GPUMapMode.READ).then(() => {
      const src = new Uint8Array(buf.getMappedRange());
      const px = new Uint8ClampedArray(w * h * 4);
      let any = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0, s = y * bpr, d = y * w * 4; x < w; x++, s += 4, d += 4) {
          let r = src[s], g = src[s + 1], b = src[s + 2];
          const a = src[s + 3];
          if (bgra) { const t = r; r = b; b = t; }
          if (premul && a > 0 && a < 255) { r = (r * 255) / a; g = (g * 255) / a; b = (b * 255) / a; }
          any |= r | g | b | a;
          px[d] = r; px[d + 1] = g; px[d + 2] = b; px[d + 3] = 255;
        }
      }
      buf.unmap(); buf.destroy();
      if (!any) return false; // a cleared texture, not a picture
      const tmp = document.createElement('canvas');
      tmp.width = w; tmp.height = h;
      tmp.getContext('2d').putImageData(new ImageData(px, w, h), 0, 0);
      const g = target.getContext('2d');
      g.clearRect(0, 0, target.width, target.height);
      g.drawImage(tmp, 0, 0, w, h, 0, 0, target.width, target.height);
      return true;
    }, () => { try { buf.destroy(); } catch (e) { /* ignore */ } return false; });
  }
  function gpu(o) {
    const s = {
      kind: 'webgpu',
      limit() { const v = o.device && o.device.limits && o.device.limits.maxTextureDimension2D; return v > 0 ? v : 8192; },
      flush() { if (typeof o.flush === 'function') { try { o.flush(); } catch (e) { warnOnce('gpu-flush', 'could not submit the frame before a read', e); } } },
      readEye: (st, target) => readGpuEye({ ...o, flush: s.flush }, st, target, false),
      readFrame: (st, target) => readGpuEye({ ...o, flush: s.flush }, st, target, true),
      async: true,
      toClip: toClipGpu,
    };
    return s;
  }

  return { gl, gpu, readGlEye, toClipGpu };
}
function dxrGuard(core) {
  const T = core.T;
  const RING = 60, MAX_DT = 250, MIN_BASE = 20, ARM_MS = 1000;
  const GUARD_REL = 0.6; // trip only below this fraction of the page's own 2D rate, when it has one
  const g = new WeakMap(); // st -> { ring[], base, readyAt, last, dts[], sum }
  const of = (st) => { let s = g.get(st); if (!s) g.set(st, (s = { ring: [], base: 0, readyAt: 0, last: 0, dts: [], sum: 0 })); return s; };
  const resetWindow = (s) => { s.readyAt = 0; s.last = 0; s.dts.length = 0; s.sum = 0; };
  const api = { tripped: null, retrying: null };
  let retried = false; // the one retry this document gets
  let retryTimer = 0, retryAt = 0;
  const waitDraws = []; // page draw times during the retry wait (any canvas): the steadiness test

  let lastResourceEnd = 0, loadNoted = false;
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (e.responseEnd > lastResourceEnd) lastResourceEnd = e.responseEnd;
    }).observe({ type: 'resource', buffered: true });
  } catch (e) { /* no Resource Timing: the readyState test alone */ }
  const loading = (t) => document.readyState !== 'complete' || (lastResourceEnd > 0 && t - lastResourceEnd < T.guardLoadQuietMs);
  api.loading = loading; // also the core's scale decision (v0.7.11): it waits for a quiet page

  document.addEventListener('visibilitychange', () => {
    for (const w of core.tracked) { const st = w.deref(); const s = st && g.get(st); if (s) { resetWindow(s); s.ring.length = 0; } }
  });

  const rateOf = (ring) => {
    let n = 0, sum = 0;
    for (let i = 1; i < ring.length; i++) { const dt = ring[i] - ring[i - 1]; if (dt > 0 && dt <= MAX_DT) { n++; sum += dt; } }
    return { n, fps: n ? (1000 * n) / sum : 0 };
  };

  api.draw = (st, t) => {
    if (st.active || st.releasing) return; // the staged stand's mono frame is not a page draw
    if (api.retrying) { waitDraws.push(t); while (waitDraws.length && t - waitDraws[0] > T.guardSteadyMs + 500) waitDraws.shift(); }
    const r = of(st).ring;
    r.push(t);
    if (r.length > RING) r.shift();
  };

  api.onFlip = (st) => {
    const s = of(st);
    const r = rateOf(s.ring);
    s.base = r.n >= MIN_BASE ? r.fps : 0;
    s.ring.length = 0;
    resetWindow(s);
  };

  api.tick = (st, t) => {
    if (api.tripped || api.retrying) return;
    const s = of(st);
    const settled = st.active && !st.cover && !st.ramp && !st.releasing && !st.offTok && core.rampK(st) === 1;
    if (!settled || document.hidden) { resetWindow(s); return; }
    if (!s.readyAt) s.readyAt = t;
    const prev = s.last;
    s.last = t;
    const warm = (st.coverDropAt || st.layerAt || 0) + T.guardWarmupMs;
    if (t - s.readyAt < ARM_MS || t < warm || !prev) return;
    if (t - (st.coverDropAt || st.layerAt || 0) < T.guardLoadMaxMs && loading(t)) {
      s.dts.length = 0; s.sum = 0;
      if (!loadNoted) { loadNoted = true; core.info('frame-rate guard: the page is still loading, not judging the frame rate yet'); }
      return;
    }
    const dt = t - prev;
    if (!(dt > 0) || dt > MAX_DT) return; // a hitch (GC, tab switch, debugger) is not a rate
    s.dts.push(dt); s.sum += dt;
    if (s.sum < T.guardMs) return;
    const fps = (1000 * s.dts.length) / s.sum;
    if (fps < T.guardFps && (!s.base || fps < GUARD_REL * s.base)) {
      if (T.guardStandDown === true) { trip(st, fps, s.base); return; }
      if (!s.noted) { s.noted = true; core.info(`${in3D(fps, s.base)}: staying in 3D (the guard only notes)`); }
    }
    while (s.dts.length && s.sum - s.dts[0] >= T.guardMs) s.sum -= s.dts.shift();
  };

  const in3D = (fps, base) => `frame-rate guard: ${fps.toFixed(1)} fps in 3D over ${(T.guardMs / 1000).toFixed(1)} s` +
    (base ? ` (2D ran at ${base.toFixed(1)})` : ' (no 2D baseline)');
  const hold = (v) => { for (const w of core.tracked) { const o = w.deref(); if (o) { o.nextTry = v; if (!v) o.tries = 0; } } };
  function trip(st, fps, base) {
    if (!retried) {
      retried = true;
      const why = `${in3D(fps, base)} — retrying once in ${(T.guardRetryMs / 1000).toFixed(1)} s (the page may still have been loading)`;
      api.retrying = why;
      hold(Infinity);
      waitDraws.length = 0;
      retryAt = core.now() + T.guardRetryMs;
      retryTimer = setTimeout(poll, T.guardRetryMs);
      core.turnOff(st, why); // logs the one "back to 2D: …" line
      core.notify();
      return;
    }
    block(`${in3D(fps, base)}, after one retry — 2D for the rest of this page`);
    core.turnOff(st, api.tripped); // logs the one "back to 2D: …" line
    core.notify();
  }
  function steady(t) {
    const B = 4, bw = T.guardSteadyMs / B, n = new Array(B).fill(0);
    let total = 0;
    for (const d of waitDraws) { const i = Math.floor((t - d) / bw); if (i >= 0 && i < B) { n[i]++; total++; } }
    if (total < 8) return { ok: true, why: `the page draws little in 2D (${total} frames in ${(T.guardSteadyMs / 1000).toFixed(1)} s)` };
    const lo = Math.min(...n), hi = Math.max(...n), fps = (1000 * total) / T.guardSteadyMs;
    return { ok: lo > 0 && hi / lo <= 1.3, why: `2D steady at ${fps.toFixed(1)} fps` };
  }
  function poll() {
    retryTimer = 0;
    if (!api.retrying || api.tripped) return;
    const t = core.now(), s = steady(t);
    if (s.ok || t - retryAt >= T.guardRetryMaxMs - T.guardRetryMs) { retry(s.ok ? s.why : 'the 2D rate never settled — retrying anyway'); return; }
    retryTimer = setTimeout(poll, 250);
  }
  function retry(why) {
    retryTimer = 0;
    if (!api.retrying || api.tripped) return;
    api.retrying = null;
    waitDraws.length = 0;
    core.info(`frame-rate guard: retrying once (${why})`);
    hold(0);
    for (const w of core.tracked) { const o = w.deref(); if (o) core.wake(o); }
    core.notify();
  }
  function block(why) {
    api.tripped = why;
    api.retrying = null;
    clearTimeout(retryTimer); retryTimer = 0;
    hold(Infinity);
    core.standDownForGood();
  }

  return api;
}
function dxrChip(ctl, S) {
  const I = S.intrinsics;
  const doc = document;
  const TAG = '[dxr-auto3d]';
  const INSET = 8;
  const PILL_W = 38, CARET_W = 22;            // + 2 px border = 40 collapsed, 62 expanded (<= 64)
  const H_FINE = 24, H_COARSE = 44;           // + border, inside 28 / 44
  const NO_DISPLAY = '3D display not available to this window';
  const LIVE_EXPAND_MS = 3000, OFF_EXPAND_MS = 5000, FS_IDLE_MS = 3000, IDLE_TICK_MS = 500, HIT_EVERY = 30;
  const mq = (q) => { try { return matchMedia(q); } catch (e) { return { matches: false, addEventListener() {} }; } };
  const coarseMq = mq('(pointer: coarse)');
  const now = () => performance.now();

  let s = null;                 // last ctl.status()
  let view = 'hidden';          // what the chip shows
  let host = null, root = null, wrap, pill, dot, caret, menu, live, els = {};
  let corner = null, rectKey = '', frames = 0, canvasObserved = null, ro = null;
  let expandedUntil = 0, expandTimer = 0, hovering = false, menuOpen = false, announced = false;
  let idleTimer = 0, fsIdle = false, fsIdleTimer = 0, rafPending = false;
  let down = null;              // { id, x, y, moved } — a press on the pill / caret

  const CSS = `
.wrap{position:fixed;left:0;top:0;box-sizing:border-box;display:flex;align-items:stretch;height:${H_FINE + 2}px;width:${PILL_W + 2}px;
  margin:0;padding:0;border:1px solid rgba(255,255,255,.35);border-radius:14px;background-color:rgba(16,17,22,.85);
  pointer-events:auto;font:12px/1 system-ui,-apple-system,"Segoe UI",sans-serif;color:#fff;user-select:none;-webkit-user-select:none;
  touch-action:none;cursor:default;transition:background-color .2s linear,border-color .2s linear}
.wrap.hide{display:none}
.wrap.exp{width:${PILL_W + CARET_W + 2}px}
.wrap.outline{background-color:rgba(16,17,22,.45);border-color:rgba(255,255,255,.85)}
button{all:unset;box-sizing:border-box;display:flex;align-items:center;justify-content:center;color:inherit;font:inherit;cursor:pointer}
.pill{width:${PILL_W}px;gap:5px;padding:0 0 0 2px;font-weight:600;letter-spacing:.02em}
.dot{width:6px;height:6px;box-sizing:border-box;border-radius:50%;background-color:#34c759;border:1px solid #34c759}
.dot.a{background-color:#ffb020;border-color:#ffb020}
.dot.o{background-color:transparent;border-color:#fff}
.caret{width:${CARET_W}px;display:none;border-left:1px solid rgba(255,255,255,.25);font-size:10px}
.wrap.exp .caret{display:flex}
.pill:focus-visible,.caret:focus-visible{outline:2px solid #fff;outline-offset:-3px;border-radius:12px}
.menu{position:fixed;inset:auto;left:0;top:0;margin:0;box-sizing:border-box;width:236px;padding:6px 0;overflow:visible;
  border:1px solid rgba(255,255,255,.35);border-radius:8px;background-color:rgb(16,17,22);color:#fff;
  font:12px/1.3 system-ui,-apple-system,"Segoe UI",sans-serif;pointer-events:auto;display:none}
.menu.open{display:block}
.menu button{width:100%;justify-content:space-between;padding:6px 12px;text-align:left}
.menu button:focus-visible,.menu button:hover{background-color:rgba(255,255,255,.12)}
.menu [role=menuitemradio]::before{content:"";width:8px;height:8px;margin-right:8px;box-sizing:border-box;border-radius:50%;border:1px solid #fff;flex:none}
.menu [role=menuitemradio][aria-checked=true]::before{background-color:#fff}
.menu [role=menuitemradio]{justify-content:flex-start}
.sw{width:26px;height:14px;box-sizing:border-box;border-radius:7px;border:1px solid #fff;display:flex;align-items:center;padding:0 2px}
.sw::after{content:"";width:8px;height:8px;border-radius:50%;background-color:#fff}
[aria-checked=true] .sw{justify-content:flex-end;background-color:#34c759;border-color:#34c759}
.row{display:flex;align-items:center;gap:8px;padding:4px 12px}
.row>span{flex:none;width:40px;color:rgba(255,255,255,.75)}
.row input{flex:1;min-width:0;margin:0;accent-color:#34c759}
.row output{width:30px;text-align:right;font-variant-numeric:tabular-nums}
.row.focus button{width:auto;flex:1;justify-content:center;padding:4px 0;border:1px solid rgba(255,255,255,.35);border-radius:4px}
.row.focus button[aria-pressed=true]{background-color:rgba(255,255,255,.2)}
.head{padding:4px 12px 2px;color:rgba(255,255,255,.75)}
.sep{height:1px;margin:4px 0;background-color:rgba(255,255,255,.2)}
.menu .hidden{display:none}
.sr{position:fixed;left:-10000px;top:0;width:1px;height:1px;overflow:hidden}
@media (pointer:coarse){.wrap{height:${H_COARSE}px;border-radius:22px}}
@media (prefers-reduced-motion:reduce){.wrap{transition:none}}
`;
  const HTML = `
<div class="wrap hide" part="chip">
  <button class="pill" tabindex="-1" aria-pressed="false" aria-haspopup="menu" aria-label="3D view">3D<span class="dot"></span></button>
  <button class="caret" tabindex="-1" aria-haspopup="menu" aria-expanded="false" aria-label="3D view settings">&#x2304;</button>
</div>
<div class="menu" role="menu" aria-label="3D view settings" popover="manual">
  <button role="menuitemcheckbox" tabindex="-1" data-k="site" aria-checked="false">3D on this site<span class="sw"></span></button>
  <div class="sep" role="separator"></div>
  <div class="row" role="group" aria-label="Depth"><span>Depth</span><input type="range" tabindex="-1" min="0.02" max="1" step="0.01" aria-label="Depth" data-k="depth"><output>0.50</output></div>
  <div role="group" aria-label="Style" data-g="style">
    <div class="head" aria-hidden="true">Style</div>
    <button role="menuitemradio" tabindex="-1" data-k="camera" aria-checked="false">Scene camera</button>
    <button role="menuitemradio" tabindex="-1" data-k="display" aria-checked="false">Object on the glass</button>
  </div>
  <div class="row focus" role="group" aria-label="Focus"><span>Focus</span>
    <button role="menuitem" tabindex="-1" data-k="nearer">nearer</button><button role="menuitem" tabindex="-1" data-k="auto">auto</button><button role="menuitem" tabindex="-1" data-k="farther">farther</button>
  </div>
  <div class="sep" role="separator"></div>
  <button role="menuitem" tabindex="-1" data-k="reset">Reset depth and focus</button>
  <button role="menuitem" tabindex="-1" data-k="once">Just this time (don't remember)</button>
</div>
<div class="sr" aria-live="polite"></div>`;

  let wired = false; // the document / window listeners: once per document, whatever the host
  function build() {
    if (host) return true;
    const de = doc.documentElement;
    if (!de || typeof I.attachShadow !== 'function') return false;
    els = {};
    host = doc.createElement('div');
    host.setAttribute('data-dxr-auto3d-chip', '');
    host.setAttribute('popover', 'manual');
    host.setAttribute('style', 'all:initial!important;position:fixed!important;inset:auto!important;left:0!important;top:0!important;' +
      'width:0!important;height:0!important;margin:0!important;padding:0!important;border:0!important;' +
      'background:transparent!important;overflow:visible!important;display:block!important;pointer-events:none!important');
    try { root = I.attachShadow.call(host, { mode: 'closed' }); } catch (e) { console.warn(TAG, 'chip: attachShadow failed', e); host = null; return false; }
    const style = doc.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);
    const t = doc.createElement('template');
    t.innerHTML = HTML;
    root.appendChild(t.content);
    wrap = root.querySelector('.wrap'); pill = root.querySelector('.pill'); dot = root.querySelector('.dot');
    caret = root.querySelector('.caret'); menu = root.querySelector('.menu'); live = root.querySelector('.sr');
    for (const el of root.querySelectorAll('[data-k]')) els[el.getAttribute('data-k')] = el;
    els.out = root.querySelector('output'); els.style = root.querySelector('[data-g=style]');
    wireInput();
    wireMenu();
    de.appendChild(host);
    show();
    if (!wired) {
      wired = true;
      for (const [t2, o] of [['scroll', true], ['resize', false]]) window.addEventListener(t2, schedule, { capture: o, passive: true });
      doc.addEventListener('fullscreenchange', onFullscreen);
      doc.addEventListener('pointerdown', (e) => { if (menuOpen && host && !e.composedPath().includes(host)) closeMenu(false); }, true);
    }
    return true;
  }
  function rebuild() {
    if (!host) return;
    if (menuOpen) closeMenu(false);
    const old = host;
    host = null; root = null;
    try { old.remove(); } catch (e) { /* ignore */ }
    if (!build()) return;
    if (announced) live.textContent = '3D view on';
    rectKey = '';
    render();
    place();
  }
  function show() {
    try {
      if (I.showPopover) { I.showPopover.call(host); I.showPopover.call(menu); }
      else host.style.setProperty('z-index', '2147483647', 'important'); // no popover API: plain fixed
    } catch (e) { console.warn(TAG, 'chip: showPopover failed', e); }
    try {
      const b = getComputedStyle(host, '::backdrop');
      const clear = (v) => !v || v === 'none' || v === 'transparent' || v === 'rgba(0, 0, 0, 0)';
      if (!(clear(b.backgroundColor) && clear(b.backgroundImage) && clear(b.backdropFilter) && clear(b.filter))) {
        const sh = new CSSStyleSheet();
        sh.replaceSync('[data-dxr-auto3d-chip]::backdrop{background:transparent!important;backdrop-filter:none!important;filter:none!important}');
        doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sh];
      }
    } catch (e) { /* no ::backdrop support: nothing to neutralise */ }
  }

  const STOP = ['pointerdown', 'pointerup', 'pointermove', 'pointercancel', 'pointerover', 'pointerout', 'gotpointercapture', 'lostpointercapture',
    'mousedown', 'mouseup', 'mousemove', 'mouseover', 'mouseout', 'click', 'dblclick', 'auxclick', 'contextmenu', 'wheel',
    'touchstart', 'touchmove', 'touchend', 'touchcancel', 'keydown', 'keyup', 'keypress', 'input', 'change', 'focusin', 'focusout',
    'dragstart', 'selectstart'];
  function wireInput() {
    for (const t of STOP) root.addEventListener(t, (e) => e.stopPropagation(), { passive: t === 'wheel' || t.startsWith('touch') ? true : false });
    wrap.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      down = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
      try { e.target.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ }
    });
    wrap.addEventListener('mousedown', (e) => e.preventDefault());
    wrap.addEventListener('pointermove', (e) => { if (down && e.pointerId === down.id && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) down.moved = true; });
    wrap.addEventListener('pointerenter', () => { hovering = true; render(); });
    wrap.addEventListener('pointerleave', () => { hovering = false; render(); });
    pill.addEventListener('click', (e) => {
      const drag = down && down.moved; down = null;
      if (drag) return; // a drag that ended on the pill is not a click
      e.preventDefault();
      if (view === 'live') ctl.setEnabled(false);
      else if (view === 'off' || view === 'offer') ctl.setEnabled(true);
      else if (view === 'nodisplay') openMenu(); // nothing to switch on here: the menu still offers "3D on this site"
    });
    caret.addEventListener('click', (e) => { const drag = down && down.moved; down = null; if (!drag) toggleMenu(); });
    pill.addEventListener('contextmenu', (e) => { e.preventDefault(); openMenu(); });
    caret.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  const items = () => [...menu.querySelectorAll('button,input')].filter((el) => el.offsetParent !== null || el.getClientRects().length);
  function wireMenu() {
    menu.addEventListener('click', (e) => {
      const b = e.target.closest && e.target.closest('button[data-k]');
      if (!b) return;
      const k = b.getAttribute('data-k'), st = s || ctl.status();
      if (k === 'site') ctl.setEnabled(!st.enabled);
      else if (k === 'camera' || k === 'display') ctl.setRig(k);
      else if (k === 'nearer') ctl.nudgeFocus(-1);
      else if (k === 'auto') ctl.nudgeFocus(0);
      else if (k === 'farther') ctl.nudgeFocus(+1);
      else if (k === 'reset') ctl.reset();
      else if (k === 'once') { closeMenu(true); ctl.setEnabled(!st.enabled, { remember: false }); }
    });
    els.depth.addEventListener('input', () => ctl.setDepth(+els.depth.value, { remember: false }));
    els.depth.addEventListener('change', () => ctl.setDepth(+els.depth.value));
    menu.addEventListener('keydown', (e) => {
      const list = items(), i = list.indexOf(root.activeElement);
      const go = (j) => { const el = list[(j + list.length) % list.length]; if (el) el.focus(); };
      switch (e.key) {
        case 'ArrowDown': go(i + 1); break;
        case 'ArrowUp': go(i - 1); break;
        case 'Home': go(0); break;
        case 'End': go(list.length - 1); break;
        case 'Escape': closeMenu(true); break;
        case 'Tab': closeMenu(true); break;
        default: return; // Enter / Space click natively; Left / Right move the slider natively
      }
      e.preventDefault();
    });
  }
  function toggleMenu() { if (menuOpen) closeMenu(true); else openMenu(); }
  function openMenu() {
    if (view === 'hidden' || !host) return;
    menuOpen = true;
    caret.setAttribute('aria-expanded', 'true');
    syncMenu();
    menu.classList.add('open');
    placeMenu();
    render();
    const first = items()[0];
    if (first) first.focus({ preventScroll: true });
  }
  function closeMenu(refocus) {
    if (!menuOpen) return;
    menuOpen = false;
    menu.classList.remove('open');
    caret.setAttribute('aria-expanded', 'false');
    if (refocus && view !== 'hidden') pill.focus({ preventScroll: true });
    else if (root.activeElement && root.activeElement.blur) root.activeElement.blur();
    render();
  }
  function syncMenu() {
    if (!s) return;
    els.site.setAttribute('aria-checked', String(!!s.enabled));
    if (root.activeElement !== els.depth) els.depth.value = String(s.depth);
    els.out.textContent = (+s.depth).toFixed(2);
    els.style.classList.toggle('hidden', !s.rigSupported);
    els.camera.setAttribute('aria-checked', String(s.rig === 'camera'));
    els.display.setAttribute('aria-checked', String(s.rig === 'display'));
    els.auto.setAttribute('aria-pressed', String(s.convScale === 1));
    const fixed = s.convSource === 'fixed';
    if (els.auto.textContent !== (fixed ? 'auto (fixed)' : 'auto')) els.auto.textContent = fixed ? 'auto (fixed)' : 'auto';
    const src = s.convText ? `Focus ${(+s.convergence).toPrecision(3)} units (${s.convText})` : '';
    els.auto.title = fixed ? `Open scene: fixed focus 2 m ahead, at real scale${src ? ' — ' + src : ''}` : src;
    els.once.textContent = `${s.enabled ? 'Off' : 'On'} just this time (don't remember)`;
  }
  function placeMenu() {
    if (!menuOpen || !s || !s.canvas) return;
    const r = s.canvas.getBoundingClientRect(), w = wrap.getBoundingClientRect();
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    const vw = doc.documentElement.clientWidth || innerWidth, vh = doc.documentElement.clientHeight || innerHeight;
    const right = corner === 'tr' || corner === 'br', top = corner === 'tr' || corner === 'tl';
    let x = right ? w.right - mw : w.left, y = top ? w.bottom + 4 : w.top - 4 - mh;
    const inside = x >= r.left + INSET && x + mw <= r.right - INSET && y >= r.top + INSET && y + mh <= r.bottom - INSET &&
      mw * mh < 0.5 * r.width * r.height;
    if (!inside) {
      const fits = (a, b) => a >= 0 && b >= 0 && a + mw <= vw && b + mh <= vh;
      const xs = right ? r.right - mw : r.left;
      const opts = [[xs, r.bottom + 4], [xs, r.top - 4 - mh], [r.right + 4, w.top], [r.left - 4 - mw, w.top]];
      const hit = opts.find(([a, b]) => fits(a, b));
      if (hit) [x, y] = hit;
      else { x = Math.min(Math.max(0, x), vw - mw); y = Math.min(Math.max(0, y), vh - mh); }
    }
    setPx(menu, 'left', x);
    setPx(menu, 'top', y);
  }

  function viewOf(st) {
    if (!st || !st.canvas) return 'hidden';
    if (st.retrying) return st.enabled ? 'live' : 'off';
    if (st.state === 'flat' && st.reason === 'no-display') return st.enabled ? 'nodisplay' : 'off';
    if (st.state === 'live' || st.waiting) {
      if (!st.enabled) return 'off'; // turning off: fading out / staged under the out-cover
      if (st.coverUp && !(st.layerAt && now() >= st.layerAt + st.holdMs)) return 'hidden'; // R6
      return 'live';
    }
    if (st.state === 'off') return 'off';
    if (st.state === 'offer') return 'offer';
    return 'hidden'; // converting, idle, flat, standdown, optout, guard
  }
  function refresh(st) {
    s = st;
    const prev = view, next = viewOf(st);
    view = next;
    if (next !== prev) {
      if (next === 'live') {
        expandFor(LIVE_EXPAND_MS);
        if (!announced && build()) { announced = true; live.textContent = '3D view on'; }
      } else if (next === 'off' && prev === 'live') expandFor(OFF_EXPAND_MS);
      else if (next === 'hidden') { expandedUntil = 0; if (menuOpen) closeMenu(false); }
      rectKey = ''; // re-run the hit test for the new state
    }
    if (next !== 'hidden' && !build()) return;
    observe(next !== 'hidden' ? st.canvas : null);
    idle(next === 'offer' || next === 'off' || next === 'nodisplay' || !!st.retrying); // no session loop (or not one we can count on): poll the placement
    if (menuOpen) syncMenu();
    render();
    place();
  }
  function expandFor(ms) {
    expandedUntil = now() + ms;
    clearTimeout(expandTimer);
    expandTimer = setTimeout(render, ms + 20);
  }
  const setA = (el, k, v) => { if (el.getAttribute(k) !== v) el.setAttribute(k, v); };
  const setPx = (el, k, v) => { const t = Math.round(v) + 'px'; if (el.style[k] !== t) el.style[k] = t; };
  function render() {
    if (!host) return;
    const vis = view !== 'hidden' && corner !== null && !fsIdle;
    wrap.classList.toggle('hide', !vis);
    if (!vis) return;
    const on = view === 'live';
    wrap.classList.toggle('outline', !on);
    wrap.classList.toggle('exp', menuOpen || hovering || now() < expandedUntil);
    setA(dot, 'class', 'dot ' + (!on ? 'o' : s.tracking && !s.ramping && !s.retrying ? 'g' : 'a'));
    setA(pill, 'aria-pressed', String(on));
    const nd = view === 'nodisplay';
    setA(pill, 'aria-label', nd ? NO_DISPLAY : on ? '3D view: on. Turn off for this site' : view === 'offer' ? '3D view available. Turn on for this site' : '3D view: off. Turn on for this site');
    if (nd) setA(wrap, 'title', NO_DISPLAY); else if (wrap.hasAttribute('title')) wrap.removeAttribute('title');
  }

  const boxH = () => (coarseMq.matches ? H_COARSE : H_FINE) + 2;
  const BOX_W = PILL_W + CARET_W + 2; // hit-test the EXPANDED box: expanding never grows over page UI
  function boxAt(c, r) {
    const h = boxH();
    const x = c === 'tr' || c === 'br' ? r.right - INSET - BOX_W : r.left + INSET;
    const y = c === 'tr' || c === 'tl' ? r.top + INSET : r.bottom - INSET - h;
    return { x, y, w: BOX_W, h };
  }
  function clearAt(b, cv, cover) {
    const pts = [[b.x + 1, b.y + 1], [b.x + b.w - 1, b.y + 1], [b.x + 1, b.y + b.h - 1], [b.x + b.w - 1, b.y + b.h - 1], [b.x + b.w / 2, b.y + b.h / 2]];
    for (const [x, y] of pts) {
      let first = null;
      for (const el of I.elementsFromPoint.call(doc, x, y)) { if (el !== host) { first = el; break; } }
      if (!first || (first !== cv && first !== cover)) return false;
    }
    return true;
  }
  function place() {
    if (!host) return;
    if (view === 'hidden' || !s || !s.canvas || !s.canvas.isConnected) { if (corner !== null) { corner = null; render(); } return; }
    if (!host.isConnected) { doc.documentElement.appendChild(host); show(); }
    const r = s.canvas.getBoundingClientRect();
    const key = `${r.left},${r.top},${r.width},${r.height},${innerWidth},${innerHeight},${coarseMq.matches}`;
    if (key !== rectKey || frames % HIT_EVERY === 0) {
      rectKey = key;
      const was = corner;
      corner = null;
      if (r.width > 2 * INSET + BOX_W && r.height > 2 * INSET + boxH()) {
        for (const c of ['tr', 'br', 'tl', 'bl']) if (clearAt(boxAt(c, r), s.canvas, s.cover)) { corner = c; break; }
      }
      if (corner !== was) render();
    }
    if (corner === null) return;
    const b = boxAt(corner, r);
    const w = wrap.classList.contains('exp') ? BOX_W : PILL_W + 2;
    const x = corner === 'tr' || corner === 'br' ? b.x + b.w - w : b.x;
    setPx(wrap, 'left', x);
    setPx(wrap, 'top', b.y);
    if (menuOpen) placeMenu();
  }
  function schedule() {
    if (rafPending || view === 'hidden') return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; rectKey = ''; place(); });
  }
  function observe(cv) {
    if (cv === canvasObserved) return;
    if (ro) ro.disconnect();
    canvasObserved = cv;
    if (!cv || typeof ResizeObserver !== 'function') return;
    if (!ro) ro = new ResizeObserver(schedule);
    ro.observe(cv);
  }
  function idle(onoff) {
    if (onoff && !idleTimer) idleTimer = setInterval(() => { frames = 0; refresh(ctl.status()); }, IDLE_TICK_MS);
    else if (!onoff && idleTimer) { clearInterval(idleTimer); idleTimer = 0; }
  }

  const fsOurs = () => { const f = doc.fullscreenElement; return !!(f && s && s.canvas && (f === s.canvas || f.contains(s.canvas))); };
  function onPointerActivity() {
    if (!fsOurs()) return;
    if (fsIdle) { fsIdle = false; render(); }
    clearTimeout(fsIdleTimer);
    fsIdleTimer = setTimeout(() => { if (fsOurs()) { fsIdle = true; render(); } }, FS_IDLE_MS);
  }
  let fsHost = false; // the host was rebuilt for a fullscreen element over our canvas
  function onFullscreen() {
    if (fsOurs()) {
      window.addEventListener('pointermove', onPointerActivity, { capture: true, passive: true });
      onPointerActivity();
      rebuild(); // after the fullscreen element: fresh on top
      fsHost = true;
    } else {
      window.removeEventListener('pointermove', onPointerActivity, true); clearTimeout(fsIdleTimer); if (fsIdle) { fsIdle = false; render(); }
      if (fsHost) { fsHost = false; rebuild(); } // the reverse: a fresh host for the page without fullscreen
    }
    schedule();
  }

  ctl.onChange(() => refresh(ctl.status()));
  return {
    update() { /* the chip listens through ctl.onChange */ },
    frame() {
      frames++;
      refresh(ctl.status());
    },
    inspect() {
      const r = host && !wrap.classList.contains('hide') ? wrap.getBoundingClientRect() : null;
      return {
        root, host, state: view, corner, menu: menuOpen,
        rect: r ? { left: r.left, top: r.top, width: r.width, height: r.height } : null,
        menuRect: menuOpen ? (({ left, top, width, height }) => ({ left, top, width, height }))(menu.getBoundingClientRect()) : null,
      };
    },
  };
}
function dxrDev(core, ctl) {
  const { VERSION, HAS_RIG, T, site, meta, tracked, engines, now, desc, realW, realH, rigMode, depthOf, convSource, convText, rampK, flatNote } = core;
  let hudOn = core.cfg.hud !== false;

  let hudEl = null, hudUntil = 0, hudPending = false;
  function hud(flash) {
    if (flash) hudUntil = now() + 2500;
    const st = core.owner, foreign = core.foreign, enabled = core.on();
    const busy = st && (st.active || st.pending || st.armed);
    const flat = !busy && !foreign && enabled ? flatNote() : null;
    if (!hudOn || !(busy || flat || foreign || now() < hudUntil)) { if (hudEl) { hudEl.remove(); hudEl = null; } return; }
    if (!document.body) { if (!hudPending) { hudPending = true; document.addEventListener('DOMContentLoaded', () => { hudPending = false; hud(); }, { once: true }); } return; }
    if (!hudEl) {
      hudEl = document.createElement('div');
      hudEl.setAttribute('data-dxr-auto3d-hud', '');
      Object.assign(hudEl.style, {
        position: 'fixed', left: '8px', bottom: '8px', zIndex: '2147483647', font: '12px/1.4 monospace', color: '#fff',
        background: 'rgba(0,0,0,.72)', padding: '4px 8px', borderRadius: '4px', pointerEvents: 'none', whiteSpace: 'pre',
      });
      document.body.appendChild(hudEl);
    }
    let text;
    if (!enabled) text = 'DXR auto-3D: OFF for this site  (Ctrl+Alt+3)';
    else if (st && st.active) {
      const s = st.stats;
      text = `DXR auto-3D ● ${HAS_RIG ? rigMode() : 'display'} rig · depth ${depthOf().toFixed(2)} · conv ${(st.conv.d * site.convScale).toPrecision(3)} (${convText(st)})` +
        ` · 3D ${s.stereo} · flat ${s.flat} · replay ${s.replays}` +
        (st.nd ? ' · no 3D display for this window' : st.haveViews ? (st.eyesOn ? '' : ' · eyes lost') : ' · waiting for eyes');
    } else if (busy) text = 'DXR auto-3D: converting…';
    else if (foreign) text = `DXR auto-3D: standing down (${foreign})`;
    else if (flat) text = `DXR auto-3D: 2D (${flat.engine}) — ${flat.flatReason}`;
    else text = `DXR auto-3D: ON (${rigMode()} rig) — no ${engines.join(' / ') || '3D'} scene converted yet`;
    hudEl.textContent = text;
  }
  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey && e.altKey) || e.shiftKey || e.metaKey) return;
    let hit = true;
    switch (e.code) {
      case 'Digit3': ctl.setEnabled(!core.on()); break;
      case 'KeyP': ctl.setRig(rigMode() === 'camera' ? 'display' : 'camera'); break;
      case 'Equal': ctl.setDepth(depthOf() * 1.25); break; // the ACTIVE rig's depth (joint ipd + parallax on both rigs)
      case 'Minus': ctl.setDepth(depthOf() / 1.25); break;
      case 'Digit0': ctl.nudgeFocus(+1); break;
      case 'Digit9': ctl.nudgeFocus(-1); break;
      case 'Digit8': ctl.reset(); break; // the active rig's default
      case 'KeyD': hudOn = !hudOn; core.save({ hud: hudOn }); break;
      default: hit = false;
    }
    if (hit) { e.preventDefault(); e.stopImmediatePropagation(); hud(true); }
  }, true);

  window.__dxrAuto3D = {
    version: VERSION,
    get cfg() { return { ...T, ...site, enabled: core.on(), hud: hudOn }; },
    set(k, v) {
      if (k === 'enabled') ctl.setEnabled(v);
      else if (k === 'depth') ctl.setDepth(+v); // the active rig's
      else if (k === 'rig') ctl.setRig(v);
      else if (k === 'convScale') { site.convScale = core.clamp(+v || 1, core.CONV_SCALE_MIN, core.CONV_SCALE_MAX); core.save({ convScale: site.convScale }); }
      else if (k === 'hud') { hudOn = !!v; core.save({ hud: hudOn }); }
      else T[k] = v;
      hud(true);
    },
    state() {
      const renderers = [];
      for (const w of tracked) {
        const st = w.deref();
        if (!st) continue;
        const rect = st.canvas.getBoundingClientRect();
        const d = st.ad.describe(st);
        renderers.push({
          engine: st.engine,
          canvas: desc(st.canvas),
          css: [Math.round(rect.width), Math.round(rect.height)],
          page: d.page,
          real: [realW(st.canvas), realH(st.canvas)],
          eye: st.R ? [st.R.eyeW, st.R.eyeH] : null,
          active: st.active, pending: !!(st.pending || st.armed), haveViews: st.haveViews, eyesOn: !!st.eyesOn, noDisplay: !!(st.nd || st.noDisplay),
          convergence: st.conv.d, convergenceSource: convSource(st), convergenceVia: st.conv.via, verdict: st.verdict && st.verdict.done ? { ...st.verdict.done, R: st.verdict.R, Rf: st.verdict.Rf } : null, overlayTracked: !!st.overlayTracked, cursor: st.cur ? { support: st.cur.support, over: st.cur.over, last: st.cur.last } : null, morphing: !!st.morph, rigNow: st.rig ? { type: st.rig.type, k: st.rig.type === 'display' && st.eyeK > 0 ? st.eyeK : 1, z: (st.rig.position ? st.rig.position.z : 0) * (st.rig.type === 'display' && st.eyeK > 0 ? st.eyeK : 1), vfov: st.rig.verticalFov, diopters: st.rig.convergenceDiopters, m2v: st.rig.metersToVirtual, ipd: st.rig.ipdFactor, par: st.rig.parallaxFactor, vdh: st.rig.virtualDisplayHeight * (st.rig.type === 'display' && st.eyeK > 0 ? st.eyeK : 1) } : null, glass: st.glass && st.glass.d > 0 ? { d: st.glass.d, lo: st.glass.lo, hi: st.glass.hi, n: st.glass.n, parts: st.glass.set ? st.glass.set.parts.length : 0, note: st.glass.set ? st.glass.set.note : null, list: st.glass.set ? st.glass.set.parts.map((p) => [p.name || '', p.k, +(+p.zlo).toFixed(1), +(+p.zhi).toFixed(1)]) : null } : null, openLatched: !!st.openLatched, openWhy: st.openWhy || null, anchor: st.anchor ? { ...st.anchor } : null, nearSurf: st.nearSurf || null, eyeShear: st.haveViews ? st.V.map((v) => [v.proj[8], v.proj[9]]) : null, eyeMid: st.haveViews ? [0, 1, 2].map((k) => (st.V[0].pose[12 + k] + st.V[1].pose[12 + k]) / 2) : null, rigScale: st.rigScale ? { ...st.rigScale } : null,
          rig: st.active ? JSON.parse(JSON.stringify(st.rig)) : null, releasing: !!st.releasing, lifted: st.lifted || null,
          pivot: st.piv ? { t: [...st.piv.t], c: [...st.piv.c], d: st.piv.d } : null,
          eyeAt: st.eyeAt ? Array.from(st.eyeAt) : null, // eye 0's world position, as last composed by the adapter
          rampK: st.active ? rampK(st) : null, ramping: !!st.ramp, drawnAt: st.drawnAt || null,
          why: st.lastWhy, flatReason: st.flatReason, stats: { ...st.stats },
          ...(d.extra || {}),
        });
      }
      return { version: VERSION, engines: engines.slice(), ...meta, enabled: core.on(), foreign: core.foreign, rigSupported: HAS_RIG, rigMode: rigMode(), depth: depthOf(), depths: { camera: depthOf('camera'), display: depthOf('display') }, renderers };
    },
    async probe() {
      const L = core.owner && core.owner.layer;
      if (!L) return { layer: false };
      const ask = async (name) => {
        if (typeof L[name] !== 'function') return 'absent';
        try { return await Promise.race([L[name](), new Promise((r) => setTimeout(() => r('timeout 2s'), 2000))]); }
        catch (e) { return 'rejected: ' + (e && (e.name + ' ' + e.message)); }
      };
      return { layer: true, displayInfo: await ask('getDisplayInfo'), renderingModes: await ask('getRenderingModes') };
    },
    chip: () => (core.chip && core.chip.inspect ? core.chip.inspect() : null),
  };
  return { hud };
}
function dxrThree(core) {
  core.registerEngine('three.js');
  const { info, warnOnce, desc, realW, realH } = core;
  const vec2 = () => ({ x: 0, y: 0, set(x, y) { this.x = x; this.y = y; return this; } });

  const states = new WeakMap(); // renderer -> state
  let revision = null;
  Object.defineProperty(core.meta, 'revision', { enumerable: true, get: () => revision });

  const onObserve = (e) => {
    if (core.retired) return;
    const o = e && e.detail;
    if (!o) return;
    if (o.isScene) { hookLookAt(o); return; }
    if (o.isWebGPURenderer) { trackCommon(o); return; }
    if (o.isWebGLRenderer || (o.domElement && typeof o.render === 'function' && typeof o.getContext === 'function')) track(o);
  };
  const GPU_MIN = 178, GPU_VERIFIED = 187;
  const COMMON_API = ['render', 'setSize', 'setPixelRatio', 'getPixelRatio', 'getSize', 'getDrawingBufferSize', 'setViewport', 'setScissor', 'setScissorTest', 'getRenderTarget', 'setRenderTarget', 'getContext'];
  function missingHooks(r) {
    const miss = [];
    if (!r.backend) miss.push('backend');
    if (!('autoClearColor' in r)) miss.push('autoClearColor');
    for (const k of COMMON_API) if (typeof r[k] !== 'function') miss.push(k + '()');
    if (typeof r.hasInitialized !== 'function' && !('_initialized' in r)) miss.push('hasInitialized() / _initialized');
    if (!('needsFrameBufferTarget' in r) && typeof r._getFrameBufferTarget !== 'function') miss.push('needsFrameBufferTarget / _getFrameBufferTarget()');
    return miss;
  }
  const seenCommon = new WeakSet();
  function trackCommon(r) {
    if (seenCommon.has(r)) return;
    seenCommon.add(r);
    if (!(r.domElement instanceof HTMLCanvasElement)) { warnOnce('webgpu', 'WebGPURenderer seen (no canvas element) — not converted, left 2D'); return; }
    const rev = parseInt(revision, 10);
    const miss = missingHooks(r);
    let why = null;
    if (!(rev >= GPU_MIN)) why = `WebGPURenderer r${revision || '?'} — the driver needs r${GPU_MIN} or later`;
    else if (miss.length) why = `WebGPURenderer r${rev} without what the driver uses: ${miss.join(', ')}`;
    if (why) { core.noteFlat('three.js', r.domElement, why); return; }
    const verified = core.T.gpuVerified || GPU_VERIFIED;
    if (rev > verified) warnOnce('webgpu-rev', `WebGPURenderer r${rev} is newer than the last verified r${verified}; converting (every hook the driver uses is present)`);
    track(r, true);
  }
  const onRegister = (e) => { if (core.retired) return; if (e && e.detail && e.detail.revision) revision = e.detail.revision; };

  const lookAts = new WeakMap(); // camera -> { x, y, z } (world), the last lookAt
  const hookedProtos = new WeakSet();
  function hookLookAt(obj) {
    let p = Object.getPrototypeOf(obj);
    while (p && !Object.prototype.hasOwnProperty.call(p, 'lookAt')) p = Object.getPrototypeOf(p);
    if (!p || hookedProtos.has(p) || typeof p.lookAt !== 'function') return;
    hookedProtos.add(p);
    const orig = p.lookAt;
    try {
      p.lookAt = function (x, y, z) {
        if (this && this.isCamera) {
          const v = x && typeof x === 'object' ? x : null;
          const t = v ? { x: v.x, y: v.y, z: v.z } : { x, y, z };
          if (isFinite(t.x) && isFinite(t.y) && isFinite(t.z)) lookAts.set(this, t);
        }
        return orig.apply(this, arguments);
      };
    } catch (e) { warnOnce('lookat', 'could not watch camera.lookAt — convergence falls back to the estimator', e); }
  }
  const CONTROL_GLOBALS = ['controls', 'orbitControls', 'cameraControls'];
  const WALK_GLOBALS = ['controls', 'fpsControls', 'firstPersonControls', 'flyControls', 'pointerLockControls', 'cameraControls'];
  function walkKind(c) {
    if (!c || typeof c !== 'object') return null;
    if (typeof c.isLocked === 'boolean' && typeof c.lock === 'function' && typeof c.unlock === 'function') return 'PointerLockControls';
    if (typeof c.movementSpeed === 'number' && typeof c.lookSpeed === 'number') return 'FirstPersonControls';
    if (typeof c.movementSpeed === 'number' && typeof c.rollSpeed === 'number') return 'FlyControls';
    return null;
  }

  const ad = {
    label: (st) => `three r${revision || '?'}` + (st && st.common ? ` (WebGPURenderer, ${backendOf(st) || 'not initialised'})` : ''),
    unqualified(st) {
      if (st.viewJitter) return st.flatReason;
      if (st.common) {
        if (!ready(st)) return 'WebGPURenderer not initialised yet';
        if (st.gpuPostfx) return st.flatReason;
      }
      const camera = st.qualifyCam;
      if (!camera || !camera.isPerspectiveCamera || camera.isArrayCamera) return 'the screen camera is not a PerspectiveCamera';
      const where = core.canvasPlacement(st.canvas);
      if (where) return where;
      if (!(st.L.w > 0 && st.L.h > 0)) return 'renderer has no size yet';
      return core.cssEffect(st.canvas);
    },
    hasCamera: (st) => !!st.mainCam,
    depthRange: (st) => ({ near: st.mainCam.near, far: st.mainCam.far }),
    rigFov: (st) => { const cam = st.mainCam; return 2 * Math.atan(Math.tan(((cam.fov || 50) * Math.PI) / 360) / (cam.zoom || 1)); },
    sampler(st) {
      const scene = st.lastScene, cam = st.mainCam;
      if (!scene || !cam || !cam.matrixWorldInverse) return null;
      return {
        cameraPose: cam.matrixWorld.elements,
        viewMatrix: cam.matrixWorldInverse.elements,
        tanHalfFov: Math.tan(((cam.fov || 50) * Math.PI) / 360) / (cam.zoom || 1),
        aspect: cam.aspect || 1,
        near: cam.near, far: cam.far,
        forEachBounds: (cb) => forEachBounds(scene, cam, cb),
      };
    },
    coreSet: (st, s, ref) => coreSet(st, s, ref),
    fakeViewParams(st) {
      const cam = st.mainCam;
      return {
        near: cam.near, far: cam.far,
        t: (cam.near * Math.tan(((cam.fov || 50) * Math.PI) / 360)) / (cam.zoom || 1),
        aspect: st.L.w / (st.L.h || 1),
      };
    },
    beforeActive: (st) => core.virtualizeCanvas(st, () => { if (applyRealSize(st)) repaintNow(st); }),
    afterActive(st) {
      applyRealSize(st);
      const camera = st.mainCam;
      if (camera.parent === null) camera.updateMatrixWorld();
    },
    firstDraw(st) {
      if (st.idleOps) {
        const ops = st.idleOps.map((op) => (op[0] === 'clear' ? op : ['render', op[1], op[2], isMainPerspective(st, op[2]), false, st.chainQuads.has(op[1])]));
        st.idleOps = null;
        replay(st, ops);
        st.lastOps = ops;
        return;
      }
      if (st.postfx && st.monoOps && st.monoOps.length) {
        const ops = st.monoOps.map((op) => (op[0] === 'clear' ? op : ['render', op[1], op[2], false]));
        replay(st, ops);
        st.lastOps = ops;
        return;
      }
      if (st.gpuChain && st.chainOp) {
        const src = st.monoOps && st.monoOps.length ? st.monoOps : [['render', st.chainOp[0], st.chainOp[1]]];
        const ops = src.map((op) => (op[0] === 'clear' ? op : ['render', op[1], op[2], false, false, st.chainQuads.has(op[1])]));
        replay(st, ops);
        st.lastOps = ops;
        return;
      }
      renderFlat(st, st.lastScene, st.mainCam); // repaint NOW: the resize just cleared the store
      st.lastOps = [['render', st.lastScene, st.mainCam, true]];
    },
    redraw(st) {
      if (st.frame.drew) st.lastOps = st.frame.ops.length <= 32 ? st.frame.ops : null;
      else if (st.lastOps) replay(st, st.lastOps);
      st.frame = { drew: false, ops: [] };
    },
    coverAfterDraw: true,
    surface(st) {
      const r = st.r;
      if (st.common) {
        if (!ready(st) || !r.backend) return null;
        if (r.backend.isWebGPUBackend) {
          return core.surfaces.gpu({
            get device() { return r.backend.device; }, get context() { return r.getContext(); },
            flush() {},
            get alphaMode() { const a = typeof r.alpha === 'boolean' ? r.alpha : r.backend.parameters && r.backend.parameters.alpha; return a === false ? 'opaque' : 'premultiplied'; },
          });
        }
        const gl = r.backend.gl || r.getContext();
        return gl ? core.surfaces.gl(gl) : null;
      }
      const gl = r && typeof r.getContext === 'function' ? r.getContext() : null;
      return gl ? core.surfaces.gl(gl) : null;
    },
    restore(st, wasLive) {
      const last = st.lastOps;
      st.lastOps = null; st.frame = { drew: false, ops: [] }; st.idleOps = null;
      disposeChain(st);
      core.unvirtualizeCanvas(st);
      if (wasLive) {
        try {
          st.call('setPixelRatio', st.L.pr);
          st.call('setSize', st.L.w, st.L.h, false);
          st.call('setViewport', ...st.L.vp);
          st.call('setScissor', ...st.L.sc);
          st.call('setScissorTest', st.L.scTest);
          const mono = last && last.length ? last.map((op) => (op[0] === 'clear' ? op : ['render', op[1], op[2]]))
            : st.lastMono ? [['render', st.lastMono.scene, st.lastMono.camera]] : null;
          if (mono) { monoReplay(st, mono); st.monoOps = mono; }
        } catch (e) { /* the page's next frame repaints */ }
      }
      return true; // drawn now (or cleared by the resize): never the side-by-side pair
    },
    flipIdle(st) {
      if (st.armed && st.lastMono) {
        const { scene, camera } = st.lastMono;
        const ops = st.monoOps && st.monoOps.length ? st.monoOps : [['render', scene, camera]];
        monoReplay(st, ops); // the page's whole last frame: the cover is taken from it
        st.idleOps = ops;
        flip(st, scene, camera);
      }
    },
    wake(st) {
      const ops = st.monoOps;
      if (!ops || !ops.length || st.active) return;
      const r = st.r;
      const prevRT = st.call('getRenderTarget');
      if (prevRT !== null) st.call('setRenderTarget', null);
      try {
        for (const op of ops) { if (op[0] === 'clear') r.clear(op[1], op[2], op[3]); else r.render(op[1], op[2]); }
      } finally { if (prevRT !== null) st.call('setRenderTarget', prevRT); }
    },
    target(st) {
      const cam = st.mainCam;
      if (!cam) return null;
      for (const k of CONTROL_GLOBALS) {
        try {
          const c = window[k];
          if (c && c.object === cam && c.target && c.target.isVector3) return { x: c.target.x, y: c.target.y, z: c.target.z, via: `window.${k}.target` };
        } catch (e) { /* ignore */ }
      }
      const l = lookAts.get(cam);
      return l ? { x: l.x, y: l.y, z: l.z, via: 'camera.lookAt' } : null;
    },
    walkControls(st) {
      const cam = st.mainCam;
      if (!cam) return null;
      for (const k of WALK_GLOBALS) {
        try {
          const c = window[k];
          if (!c || (c.object !== cam && c.camera !== cam)) continue;
          const kind = walkKind(c);
          if (kind) return `${kind} (window.${k})`;
        } catch (e) { /* ignore */ }
      }
      return null;
    },
    describe: (st) => ({
      page: { w: st.L.w, h: st.L.h, pr: st.L.pr, canvasWidthSeenByPage: st.canvas.width },
      extra: st.common ? {
        renderer: 'WebGPURenderer', backend: backendOf(st), surface: st.surf ? st.surf.kind : null, clearPath: st.clearPath || null,
        coordinateSystem: ready(st) ? st.r.coordinateSystem : null, outCoverVia: st.outCoverVia || null,
        eyeProj0: st.eyes ? Array.from(st.eyes[0].projectionMatrix.elements) : null, // what three draws eye 0 with
        eyeCoord0: st.eyes ? st.eyes[0].coordinateSystem : null,
        gpuChain: st.gpuChain, nodeFrame: !!st.nf, ppSubs: st.ppSubs.slice(), ppTarget: st.ppRT || null, gpuUnsplit: st.gpuTemporal, // RenderPipeline split per eye (renderGpuChain)
      } : st.postfx ? {
        chainMirror: st.mirrorX === undefined ? null : st.mirrorX, mirrorCorr: st.mirrorCorr, // [as drawn, mirrored] (probeMirror)
        mirrorWhy: st.mirrorWhy, mirrorAsks: st.mirrorAsks,
      } : undefined,
    }),
  };

  const ready = (st) => !st.common || (typeof st.r.hasInitialized === 'function' ? st.r.hasInitialized() === true : st.r._initialized === true);
  const backendOf = (st) => { const b = st.common && ready(st) ? st.r.backend : null; return !b ? null : b.isWebGPUBackend ? 'webgpu' : b.isWebGLBackend ? 'webgl2' : 'unknown'; };
  function track(r, common = false) {
    if (states.has(r)) return;
    const canvas = r.domElement;
    if (!(canvas instanceof HTMLCanvasElement)) { warnOnce('offscreen', 'renderer on an OffscreenCanvas — not supported, left 2D'); return; }
    const st = core.newState('three.js', canvas, ad);
    Object.assign(st, {
      r, depth: 0, orig: {}, common,
      nestPersp: null, gpuPostfx: false, clearPath: null,
      gpuChain: false, chainQuads: new WeakSet(), chainOp: null, nf: undefined, ppEye: null, ppSizing: false, curNode: null,
      ppSubs: [0, 0], ppRT: null, gpuTemporal: null,
      L: { w: 0, h: 0, pr: 1, vp: [0, 0, 0, 0], sc: [0, 0, 0, 0], scTest: false }, // what the PAGE believes
      eyes: null, eyesFor: null, m4: null,
      mainCam: null, lastScene: null, lastMono: null, qualifyCam: null,
      frame: { drew: false, ops: [] }, lastOps: null,
      monoOps: null, monoCur: null, monoOpen: false, idleOps: null, // the page's last MONO frame (draws before / between conversions)
      postfx: false, seedTask: null, twins: new Map(), texTwin: new Map(), chainStereo: false,
      viewOk: false, viewJitter: false, seedMiss: null, missLogged: null,
      viewHist: [], viewSteps: 0, viewWait: null, // the view at the end of each frame (viewTrend)
      mirrorX: undefined, mirrorCorr: null, mirrorNext: 0, mirrorGiveUp: null, mirrorWhy: null, mirrorAsks: 0,
    });
    states.set(r, st);
    wrap(st);
    try {
      const s = st.call('getSize', vec2());
      st.L.w = s.x; st.L.h = s.y;
      st.L.pr = st.call('getPixelRatio');
      st.L.vp = [0, 0, st.L.w, st.L.h];
      st.L.sc = [0, 0, st.L.w, st.L.h];
      st.L.scTest = !!st.call('getScissorTest');
    } catch (e) { /* an old three without these: the page's own setSize fills L in */ }
    info(`three.js r${revision || '?'} ${common ? 'WebGPURenderer' : 'renderer'} found on`, desc(canvas));
  }

  function wrap(st) {
    const r = st.r;
    st.call = (name, ...a) => {
      const f = st.orig[name] || r[name];
      st.depth++;
      try { return f.apply(r, a); } finally { st.depth--; }
    };
    const W = (name, impl) => {
      const f = r[name];
      if (typeof f !== 'function') return;
      st.orig[name] = f;
      r[name] = function (...a) { return impl(...a); };
    };
    const top = () => st.depth === 0;
    const v4 = (x, y, w, h) => (x && x.isVector4 ? [x.x, x.y, x.z, x.w] : [x, y, w, h]);

    W('setSize', (w, h, updateStyle = true) => {
      if (!top()) return st.call('setSize', w, h, updateStyle);
      st.L.w = w; st.L.h = h; st.L.vp = [0, 0, w, h]; // three resets the viewport on setSize
      if (!st.active) return st.call('setSize', w, h, updateStyle);
      if (updateStyle !== false) { st.canvas.style.width = w + 'px'; st.canvas.style.height = h + 'px'; }
      if (applyRealSize(st)) repaintNow(st);
    });
    W('setPixelRatio', (v) => {
      if (!top() || v === undefined) return st.call('setPixelRatio', v);
      st.L.pr = v;
      if (!st.active) return st.call('setPixelRatio', v);
      if (applyRealSize(st)) repaintNow(st);
    });
    W('setDrawingBufferSize', (w, h, pr) => {
      if (!top()) return st.call('setDrawingBufferSize', w, h, pr);
      st.L.w = w; st.L.h = h; st.L.pr = pr; st.L.vp = [0, 0, w, h];
      if (!st.active) return st.call('setDrawingBufferSize', w, h, pr);
      if (applyRealSize(st)) repaintNow(st);
    });
    const real = () => st.common && !top();
    W('getSize', (t) => {
      const inner = real();
      const out = st.call('getSize', t);
      if (st.active && out && !inner) { if (typeof out.set === 'function') out.set(st.L.w, st.L.h); else { out.width = st.L.w; out.height = st.L.h; } }
      else if (inner && st.ppSizing && out && typeof out.set === 'function') { const pr = st.call('getPixelRatio') || 1; out.set(st.R.eyeW / pr, st.R.eyeH / pr); }
      return out;
    });
    W('getPixelRatio', () => (st.active && !real() ? st.L.pr : st.call('getPixelRatio')));
    W('getDrawingBufferSize', (t) => {
      const inner = real();
      const out = st.call('getDrawingBufferSize', t);
      if (st.active && out && typeof out.set === 'function' && !inner) {
        if (sparkIn > 0 && st.inEye && st.R) out.set(st.R.eyeW, st.R.eyeH);
        else out.set(Math.floor(st.L.w * st.L.pr), Math.floor(st.L.h * st.L.pr));
      } else if (inner && st.ppSizing && out && typeof out.set === 'function') out.set(st.R.eyeW, st.R.eyeH); // a chain node sizing itself for one eye
      return out;
    });
    W('setViewport', (x, y, w, h) => {
      if (!top()) return st.call('setViewport', x, y, w, h);
      st.L.vp = v4(x, y, w, h);
      if (!st.active) return st.call('setViewport', x, y, w, h);
    });
    W('getViewport', (t) => {
      const inner = real();
      const out = st.call('getViewport', t);
      if (st.active && out && typeof out.set === 'function' && !inner) out.set(...st.L.vp);
      return out;
    });
    W('setScissor', (x, y, w, h) => {
      if (!top()) return st.call('setScissor', x, y, w, h);
      st.L.sc = v4(x, y, w, h);
      if (!st.active) return st.call('setScissor', x, y, w, h);
    });
    W('getScissor', (t) => {
      const inner = real();
      const out = st.call('getScissor', t);
      if (st.active && out && typeof out.set === 'function' && !inner) out.set(...st.L.sc);
      return out;
    });
    W('setScissorTest', (b) => {
      if (!top()) return st.call('setScissorTest', b);
      st.L.scTest = !!b;
      if (!st.active) return st.call('setScissorTest', b);
    });
    W('getScissorTest', () => (st.active && !real() ? st.L.scTest : st.call('getScissorTest')));
    W('clear', (color, depth, stencil) => {
      const rt = st.call('getRenderTarget');
      if (top() && st.active && st.postfx && rt && st.twins.has(rt)) return clearChain(st, rt, color, depth, stencil);
      if (!top() || rt !== null) return st.call('clear', color, depth, stencil);
      if (!st.active) { recordMono(st, ['clear', color, depth, stencil]); return st.call('clear', color, depth, stencil); }
      st.frame.drew = true;
      st.frame.ops.push(['clear', color, depth, stencil]);
      forEyes(st, () => st.call('clear', color, depth, stencil));
    });
    W('render', (scene, camera) => {
      if (st.common && !top()) return nestedRender(st, scene, camera);
      if (!top() || !scene || !camera) return st.call('render', scene, camera);
      if (st.common && !ready(st)) return st.call('render', scene, camera);
      if (st.common) { st.nestPersp = null; if (st.nf === undefined) hookNodeFrame(st); }
      st.stats.calls++;
      const target = st.call('getRenderTarget');
      const toScreen = target === null;
      const xrLive = !!(r.xr && r.xr.enabled && r.xr.isPresenting);
      if (!st.active) {
        const before = st.r.info && st.r.info.autoReset === false ? drawnSoFar(st) : 0;
        const out = st.call('render', scene, camera);
        if (!toScreen && !xrLive) {
          const why = seedWhy(st, target, camera);
          if (why === null) markSeed(st, scene, camera, target, drawnSoFar(st) - before);
          else if (why) noteSeedMiss(st, why);
        }
        if (toScreen && !xrLive) {
          recordMono(st, ['render', scene, camera]);
          const persp = camera.isPerspectiveCamera && !camera.isArrayCamera;
          if (persp) {
            if (st.seedTask) st.seedTask.direct = true; // the scene also went straight to the screen: not a composer
            st.lastMono = { scene, camera }; st.sawPersp = true;
            hookLookAt(camera); // fallback for a page that built no Scene before its camera (rare)
            if (st.armed) flip(st, scene, camera);
            else { st.qualifyCam = camera; core.considerActivation(st); }
          } else if (st.common && st.nestPersp && (st.gpuChain || !st.sawPersp)) {
            gpuChainFrame(st, scene, camera); // WebGPURenderer + a RenderPipeline / PostProcessing chain
          } else if (st.common && st.seedTask && !st.seedTask.direct) {
            gpuPostfx(st, WHY_GPU_TOPCHAIN); // the page's own chain of top-level render() calls: flat, not split
          } else if (st.seedTask && !st.seedTask.direct) {
            const sd = st.seedTask, main = sd.main; // the seed that drew the most: the scene (markSeed)
            st.postfx = true; st.sawPersp = true;
            st.lastMono = { scene: main.scene, camera: main.camera };
            hookLookAt(main.camera);
            st.qualifyCam = main.camera;
            if (st.mirrorX === undefined) probeMirror(st, sd, scene, camera);
            if (sd.view && !st.viewOk) sd.toScreen = true;
            else if (st.mirrorX === undefined) { /* qualified on a later frame, or by probeMirror's give-up */ }
            else if (st.armed) flip(st, main.scene, main.camera);
            else core.considerActivation(st);
          } else if (!st.sawPersp && (!st.lastWhy || (st.seedMiss && st.seedMiss !== st.missLogged))) {
            st.lastWhy = 'the screen camera is not a PerspectiveCamera';
            st.missLogged = st.seedMiss;
            info('not converting', desc(st.canvas), 'yet:', st.lastWhy, st.seedMiss
              ? `(the scene went into a render target first, but not as a post chain's input: ${st.seedMiss})`
              : '(a post-processing chain, or an ortho-only scene)');
          }
        }
        return out;
      }
      if (xrLive) { core.stand(st, 'the renderer is presenting WebXR'); return st.call('render', scene, camera); }
      if (!toScreen) {
        if (st.postfx) {
          if (isSeed(st, target, camera)) {
            st.mainCam = camera; st.chainStereo = st.haveViews;
            const before = st.r.info && st.r.info.autoReset === false ? drawnSoFar(st) : 0;
            const out = renderIntoChain(st, scene, camera, target, true);
            markSeed(st, scene, camera, target, drawnSoFar(st) - before);
            st.lastScene = st.seedTask.main.scene;
            return out;
          }
          if (st.twins.has(target) || taintedSwaps(st, scene)) return renderIntoChain(st, scene, camera, target, false);
        }
        return st.call('render', scene, camera); // shadow / picking / other targets: untouched, mono
      }
      st.frame.drew = true;
      if (st.gpuChain && st.chainQuads.has(scene)) {
        st.frame.ops.push(['render', scene, camera, false, false, true]);
        const out = renderGpuChain(st, scene, camera);
        takeCover(st);
        return out;
      }
      if (st.postfx && !isMainPerspective(st, camera) && taintedSwaps(st, scene)) {
        st.frame.ops.push(['render', scene, camera, false, true]);
        const out = renderPostScreen(st, scene, camera);
        takeCover(st);
        return out;
      }
      const stereo = isMainPerspective(st, camera);
      st.frame.ops.push(['render', scene, camera, stereo]);
      const out = stereo ? renderStereo(st, scene, camera) : renderFlat(st, scene, camera);
      if (stereo) takeCover(st); // after the scene draw, never after a background/HUD pass alone
      if (st.common && !stereo && st.nestPersp && st.nestPersp.camera === st.mainCam) {
        const why = gpuChainWhy(st);
        if (why) { gpuPostfx(st, why); core.stand(st, why); }
        else { st.gpuChain = true; st.chainQuads.add(scene); st.chainOp = [scene, camera]; }
      }
      return out;
    });
    if (st.common) {
      W('renderAsync', (scene, camera) => {
        if (top() && ready(st)) { try { r.render(scene, camera); return Promise.resolve(); } catch (e) { return Promise.reject(e); } }
        return st.call('renderAsync', scene, camera);
      });
    }
    W('dispose', (...a) => {
      if (st.active || st.pending || st.armed) core.stand(st, 'the page disposed the renderer');
      return st.call('dispose', ...a);
    });
  }
  function flip(st, scene, camera) {
    st.mainCam = camera; st.lastScene = scene;
    core.flip(st);
  }
  const WHY_GPU_TOPCHAIN = 'WebGPU post chain drawn as top-level render() calls into targets — not split (three.js RenderPipeline / pass() chains are)';
  const WHY_GPU_NOFRAME = 'WebGPU RenderPipeline — the renderer has no node frame to run the chain once per eye; left 2D';
  const GPU_UNSPLIT = new Set(['TRAANode', 'TAAUNode', 'AfterImageNode', 'RecurrentDenoiseNode', 'TemporalReprojectNode',
    'StereoPassNode', 'AnaglyphPassNode', 'ParallaxBarrierPassNode', 'StereoCompositePassNode']);
  const whyUnsplit = (t) => `WebGPU RenderPipeline with a node of type ${t} — not split (${/Stereo|Anaglyph|Parallax/.test(t) ? 'the page already makes its own stereo pair' : 'it carries a history from frame to frame, which each eye would read from the other'})`;
  function noteNested(st, scene, camera) {
    if (st.nestPersp || !camera || !camera.isPerspectiveCamera || camera.isArrayCamera) return;
    if (st.call('getRenderTarget') !== null) st.nestPersp = { camera, scene };
  }
  function nestedRender(st, scene, camera) {
    noteNested(st, scene, camera);
    const i = st.ppEye;
    if (i === null) return st.call('render', scene, camera);
    const sz = st.ppSizing, acc = st.r.autoClearColor;
    const n = st.curNode, ownClears = !!(n && 'autoClearColor' in n);
    st.ppSizing = false;
    if (st.acc !== undefined && !ownClears) st.r.autoClearColor = st.acc;
    try {
      const rt = camera === st.mainCam && st.eyes && core.T.gpuChainSwap !== false ? st.call('getRenderTarget') : null; // gpuChainSwap: test only (the control)
      if (!rt) return st.call('render', scene, camera);
      st.ppSubs[i]++; st.ppRT = [rt.width, rt.height]; // diagnostics (state(): ppTarget)
      return st.call('render', scene, aimEye(st, camera, st.eyes, i, false));
    } finally {
      st.ppSizing = sz;
      if (st.acc !== undefined && !ownClears) st.r.autoClearColor = acc;
    }
  }
  function hookNodeFrame(st) {
    if (st.nf !== undefined) return st.nf;
    let nf = null;
    try { const nodes = st.r._nodes; nf = nodes && nodes.nodeFrame; } catch (e) { nf = null; }
    if (!nf || typeof nf.updateBeforeNode !== 'function' || typeof nf.frameId !== 'number') return (st.nf = null);
    const f = nf.updateBeforeNode;
    nf.updateBeforeNode = function (node) {
      let t = null;
      try { t = node && node.constructor && node.constructor.type; } catch (e) { t = null; }
      if (t && !st.gpuTemporal && GPU_UNSPLIT.has(t)) st.gpuTemporal = t;
      if (st.ppEye === null) return f.call(this, node);
      const sz = st.ppSizing, cn = st.curNode;
      st.ppSizing = core.T.gpuChainEyeSize !== false; st.curNode = node;
      try { return f.call(this, node); } finally { st.ppSizing = sz; st.curNode = cn; }
    };
    return (st.nf = nf);
  }
  function gpuChainWhy(st) {
    if (!st.nf) return WHY_GPU_NOFRAME;
    if (st.gpuTemporal) return whyUnsplit(st.gpuTemporal);
    return null;
  }
  function gpuChainFrame(st, quad, ortho) {
    const why = gpuChainWhy(st);
    if (why) { gpuPostfx(st, why); return; }
    const { scene, camera } = st.nestPersp;
    if (!st.gpuChain) info('three.js canvas', desc(st.canvas), 'draws through a WebGPU RenderPipeline: splitting it per eye');
    st.gpuChain = true; st.chainQuads.add(quad); st.chainOp = [quad, ortho];
    st.sawPersp = true;
    st.lastMono = { scene, camera };
    hookLookAt(camera);
    st.qualifyCam = camera;
    if (st.armed) flip(st, scene, camera);
    else core.considerActivation(st);
  }
  function gpuPostfx(st, why) {
    if (st.gpuPostfx) return;
    st.gpuPostfx = true; st.flatReason = why;
    info('three.js canvas', desc(st.canvas), 'stays 2D:', why);
    if (st.pending || st.armed) core.stand(st, why);
    core.notify();
  }
  function renderGpuChain(st, quad, ortho) {
    const camera = st.mainCam;
    if (!st.haveViews || !camera || !st.nf) {
      if (st.haveViews && st.stats.twoView > 0) st.stats.flatAfterEyes++;
      return renderFlat(st, quad, ortho);
    }
    if (typeof camera.updateWorldMatrix === 'function') camera.updateWorldMatrix(true, false);
    else if (camera.parent === null) camera.updateMatrixWorld();
    eyeCameras(st, camera);
    const nf = st.nf, f0 = nf.frameId;
    st.ppSubs = [0, 0];
    st.inEye = true;
    try {
      for (let i = 0; i < 2; i++) {
        setEyeViewport(st, i);
        eyeBegin(st, i, 'direct');
        if (!st.L.scTest) st.call('setScissorTest', false);
        if (i === 1) nf.frameId = f0 + 0.5; // never reached by three's own ++: every frame node runs again
        st.ppEye = i;
        try { st.call('render', quad, ortho); } finally { st.ppEye = null; }
      }
    } finally {
      st.ppEye = null; st.inEye = false;
      nf.frameId = f0;
      eyeEnd(st);
      st.call('setScissorTest', false);
    }
    const [a, b] = st.ppSubs;
    if ((a > 0 && b > 0) || core.T.gpuChainSwap === false) st.stats.stereo++; // (the control: drawn per eye, unswapped)
    else {
      st.stats.flat++;
      if (st.nestPersp && st.nestPersp.camera !== camera) st.mainCam = st.nestPersp.camera;
    }
    if (st.gpuTemporal) { const why = whyUnsplit(st.gpuTemporal); gpuPostfx(st, why); core.stand(st, why); }
    core.drew(st);
  }
  function recordMono(st, op) {
    if (!st.monoOpen) {
      st.monoOpen = true;
      const cur = (st.monoCur = []);
      queueMicrotask(() => { st.monoOpen = false; if (cur.length && cur.length <= 32) st.monoOps = cur; });
    }
    st.monoCur.push(op);
  }
  function monoReplay(st, ops) {
    const prevRT = st.call('getRenderTarget');
    if (prevRT !== null) st.call('setRenderTarget', null);
    try {
      for (const op of ops) { if (op[0] === 'clear') st.call('clear', op[1], op[2], op[3]); else st.call('render', op[1], op[2]); }
    } finally { if (prevRT !== null) st.call('setRenderTarget', prevRT); }
  }

  function applyRealSize(st) {
    const R = core.realSizeFor(st);
    st.R = R;
    const pr1 = st.call('getPixelRatio') === 1;
    if (pr1 && realW(st.canvas) === R.W && realH(st.canvas) === R.H) return false;
    st.stats.resizes++;
    if (!pr1) st.call('setPixelRatio', 1);
    st.call('setSize', R.W, R.H, false);
    return true;
  }

  function isMainPerspective(st, camera) {
    if (!camera.isPerspectiveCamera || camera.isArrayCamera) return false;
    const [x, y, w, h] = st.L.vp;
    return x === 0 && y === 0 && Math.abs(w - st.L.w) < 1 && Math.abs(h - st.L.h) < 1;
  }
  function setEyeViewport(st, i) {
    const R = st.R, L = st.L;
    const sx = R.eyeW / (L.w || 1), sy = R.eyeH / (L.h || 1), ox = i * R.eyeW;
    const [vx, vy, vw, vh] = L.vp;
    st.call('setViewport', ox + vx * sx, vy * sy, vw * sx, vh * sy);
    const [cx, cy, cw, ch] = L.scTest ? L.sc : [0, 0, L.w, L.h];
    const x0 = Math.max(0, cx * sx), y0 = Math.max(0, cy * sy);
    const x1 = Math.min(R.eyeW, (cx + cw) * sx), y1 = Math.min(R.eyeH, (cy + ch) * sy);
    st.call('setScissor', ox + x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0));
    st.call('setScissorTest', true); // confines three's autoClear to this eye's half
  }
  function forEyes(st, fn) {
    try { for (let i = 0; i < 2; i++) { setEyeViewport(st, i); fn(i); } }
    finally { st.call('setScissorTest', false); }
  }
  function perspectiveClass(cam) {
    for (let p = Object.getPrototypeOf(cam); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
      if (Object.prototype.hasOwnProperty.call(p, 'setFocalLength')) return p.constructor; // PerspectiveCamera.prototype
    }
    return cam.constructor;
  }
  function eyeCameras(st, camera) {
    if (st.eyes && st.eyesFor === camera.constructor) return st.eyes;
    const P = perspectiveClass(camera);
    const mk = () => {
      const e = new P();
      e.name = 'dxr-auto3d-eye';
      e.matrixAutoUpdate = false;                                        // the matrices are the runtime's
      if ('matrixWorldAutoUpdate' in e) e.matrixWorldAutoUpdate = false; // and render() must not recompose them
      return e;
    };
    st.eyes = [mk(), mk()];
    st.eyesFor = camera.constructor;
    st.m4 = camera.matrixWorld.clone(); // a Matrix4 of the page's own three, as scratch
    return st.eyes;
  }
  const invertFrom = (m, src) => { if (typeof m.invert === 'function') m.copy(src).invert(); else m.getInverse(src); return m; };
  const reversedDepth = (st) => {
    const d = st.r.state && st.r.state.buffers && st.r.state.buffers.depth;
    return !!(d && typeof d.getReversed === 'function' && d.getReversed());
  };
  function toReversedZ(e) {
    for (const c of [0, 4, 8, 12]) e[c + 2] = (e[c + 3] - e[c + 2]) / 2;
  }
  function eyeProjection(st, e, i, rev, view, mirror) {
    const m = e.projectionMatrix.elements;
    e.projectionMatrix.fromArray(st.V[i].proj);
    if (mirror) conjX(m);
    if (view) applyView(m, view);
    if (st.common) {
      e.coordinateSystem = st.r.coordinateSystem;
      if (st.r.reversedDepthBuffer === true) { toReversedZ(m); e._reversedDepth = true; }
      else {
        const sf = core.surfaceOf(st);
        if (sf && sf.kind === 'webgpu' && core.T.gpuDepthRange !== false) sf.toClip(m, m);
      }
    } else if (rev) {
      toReversedZ(m);
      e._reversedDepth = true;
    }
    if (e.projectionMatrixInverse) invertFrom(e.projectionMatrixInverse, e.projectionMatrix);
  }

  function clearPathFor(st) {
    if (!st.common) return null;
    const r = st.r;
    let fb = true;
    try {
      if (typeof r.needsFrameBufferTarget === 'boolean') fb = r.needsFrameBufferTarget; // r182+: side-effect free
      else if (typeof r._getFrameBufferTarget === 'function') fb = st.call('_getFrameBufferTarget') !== null; // r178-r181 (sized by the real store: st.call)
    } catch (e) { fb = true; }
    return (st.clearPath = fb ? 'fb' : 'direct');
  }
  function eyeBegin(st, i, cp) {
    if (cp !== 'direct' || core.T.gpuClearFix === false) return;
    if (i === 0) { if (!st.L.scTest) st.call('setScissorTest', false); }
    else { st.acc = st.r.autoClearColor; st.r.autoClearColor = false; }
  }
  function eyeEnd(st) { if (st.acc !== undefined) { st.r.autoClearColor = st.acc; st.acc = undefined; } }

  const frameInfo = (st) => (st.r.info && st.r.info.render && typeof st.r.info.render.frame === 'number' ? st.r.info.render : null);
  function eyeFrame(fi, i, f) {
    if (!fi) return f;
    if (i === 0) return { f0: fi.frame, hi: fi.frame };
    f.hi = Math.max(f.hi, fi.frame);
    fi.frame = f.f0;
    return f;
  }
  const endFrame = (fi, f) => { if (fi && f && fi.frame < f.hi) fi.frame = f.hi; };

  let sparkIn = 0;
  const sparkHooked = new WeakSet();
  function hookSpark(st, scene) {
    const n = st.stats.stereo + st.stats.flat;
    if (scene === st.sparkScene && n - st.sparkScan < 60) return;
    st.sparkScene = scene; st.sparkScan = n;
    const ch = scene && scene.children;
    if (!ch) return;
    for (const o of ch) {
      if (!o || sparkHooked.has(o) || !isSparkRenderer(o) || typeof o.onBeforeRender !== 'function') continue;
      sparkHooked.add(o);
      const f = o.onBeforeRender;
      o.onBeforeRender = function () { sparkIn++; try { return f.apply(this, arguments); } finally { sparkIn--; } };
    }
  }
  function renderStereo(st, scene, camera) {
    st.mainCam = camera; st.lastScene = scene;
    hookSpark(st, scene);
    if (!st.haveViews) { // no eyes yet: flat into both halves, never a blank tile
      if (st.stats.twoView > 0) st.stats.flatAfterEyes++;
      return renderFlat(st, scene, camera);
    }
    if (typeof camera.updateWorldMatrix === 'function') camera.updateWorldMatrix(true, false);
    else if (camera.parent === null) camera.updateMatrixWorld();
    const eyes = eyeCameras(st, camera);
    const rev = reversedDepth(st);
    const cp = clearPathFor(st);
    const sm = st.r.shadowMap, smAuto = sm ? sm.autoUpdate : undefined;
    const fi = frameInfo(st);
    let fr = null;
    st.inEye = true;
    try {
      for (let i = 0; i < 2; i++) {
        fr = eyeFrame(fi, i, fr);
        const e = eyes[i];
        st.m4.fromArray(core.eyePose(st, i, camera.matrixWorld.elements)); // + the display rig's pivot (core.pivotOffset)
        e.matrixWorld.multiplyMatrices(camera.matrixWorld, st.m4); // attach pattern: identity rig pose
        if (i === 0) st.eyeAt = e.matrixWorld.elements.slice(12, 15); // diagnostics (dev state(): eyeAt)
        e.matrix.copy(e.matrixWorld);
        invertFrom(e.matrixWorldInverse, e.matrixWorld);
        eyeProjection(st, e, i, rev, viewOf(camera));             // the runtime's off-axis frustum + the page's view window
        e.near = camera.near; e.far = camera.far; e.fov = camera.fov; e.aspect = camera.aspect; e.zoom = camera.zoom;
        if (e.layers && camera.layers) e.layers.mask = camera.layers.mask;
        setEyeViewport(st, i);
        eyeBegin(st, i, cp);
        if (i === 1 && sm) sm.autoUpdate = false; // shadow maps are view-independent: render them once
        st.call('render', scene, e);
      }
    } finally {
      st.inEye = false;
      eyeEnd(st);
      endFrame(fi, fr);
      if (sm) sm.autoUpdate = smAuto;
      st.call('setScissorTest', false);
    }
    st.stats.stereo++;
    core.drew(st);
  }
  function renderFlat(st, scene, camera) {
    hookSpark(st, scene);
    const cp = clearPathFor(st);
    const sm = st.r.shadowMap, smAuto = sm ? sm.autoUpdate : undefined;
    const fi = frameInfo(st);
    let fr = null;
    st.inEye = true;
    try {
      for (let i = 0; i < 2; i++) {
        fr = eyeFrame(fi, i, fr);
        setEyeViewport(st, i);
        eyeBegin(st, i, cp);
        if (i === 1 && sm) sm.autoUpdate = false;
        st.call('render', scene, camera);
      }
    } finally {
      st.inEye = false;
      eyeEnd(st);
      endFrame(fi, fr);
      if (sm) sm.autoUpdate = smAuto;
      st.call('setScissorTest', false);
    }
    st.stats.flat++;
    core.drew(st);
  }
  function replay(st, ops) {
    const prevRT = st.call('getRenderTarget');
    if (prevRT !== null) st.call('setRenderTarget', null);
    let drew = false;
    try {
      for (const op of ops) {
        if (op[0] === 'clear') forEyes(st, () => st.call('clear', op[1], op[2], op[3]));
        else if (op[5]) renderGpuChain(st, op[1], op[2]);
        else if (op[4]) renderPostScreen(st, op[1], op[2]);
        else if (op[3]) renderStereo(st, op[1], op[2]);
        else renderFlat(st, op[1], op[2]);
      }
      st.stats.replays++;
      drew = true;
    } catch (e) {
      warnOnce('replay', 'replaying the last frame threw; idle frames will not be redrawn', e);
      st.lastOps = null;
    } finally {
      if (prevRT !== null) st.call('setRenderTarget', prevRT);
    }
    if (drew) takeCover(st); // the whole replayed frame, HUD passes included
  }
  function takeCover(st) {
    if (st.outCoverDue) core.takeOutCover(st); // clears outCoverDue: at most once per frame
  }
  function repaintNow(st) {
    const ops = st.frame.ops.length ? st.frame.ops : st.lastOps;
    if (ops && ops.length) replay(st, ops);
  }

  const TEX_PROPS = ['map', 'alphaMap', 'emissiveMap', 'envMap', 'lightMap', 'aoMap'];
  function seedWhy(st, rt, camera) {
    if (!rt || rt.isWebGLCubeRenderTarget || rt.isWebGL3DRenderTarget || rt.isWebGLArrayRenderTarget) return '';
    if (!camera || !camera.isPerspectiveCamera || camera.isArrayCamera) return '';
    if (st.active && st.mainCam && camera !== st.mainCam) return 'not the page camera';
    const L = st.L;
    if (!(L.w > 0 && L.h > 0 && rt.width > 0 && rt.height > 0)) return 'the renderer or the target has no size yet';
    const a = L.w / L.h, near = (x) => Math.abs(x - a) / a < 0.1;
    const tgt = `target ${Math.round(rt.width)}x${Math.round(rt.height)}`;
    if (!near(rt.width / rt.height)) return `${tgt} is not shaped like the ${L.w}x${L.h} canvas`;
    if (!near(camera.aspect || a)) return `camera aspect ${(+camera.aspect).toFixed(3)} is not the canvas's ${a.toFixed(3)}`;
    if (!(rt.width >= 0.5 * L.w * L.pr && rt.height >= 0.5 * L.h * L.pr)) return `${tgt} is under half the canvas's ${Math.round(L.w * L.pr)}x${Math.round(L.h * L.pr)} px`;
    return null;
  }
  const isSeed = (st, rt, camera) => seedWhy(st, rt, camera) === null;
  function markSeed(st, scene, camera, rt, drawn = 0) {
    const prev = st.seedTask, view = viewSnap(camera);
    const mixed = !!prev && (prev.mixed || (prev.camera === camera && !sameView(prev.view, view)));
    const main = !prev || drawn > prev.main.drawn ? { scene, camera, rt, drawn } : prev.main;
    st.seedTask = { scene, camera, rt, view, mixed, n: prev ? prev.n + 1 : 1, main };
    if (prev) return;
    queueMicrotask(() => { // a page draws its frame in one task
      const sd = st.seedTask;
      st.seedTask = null;
      if (!sd || !sd.view) return;
      if (sd.mixed || !sameView(sd.view, viewSnap(sd.camera))) { viewJitter(st); return; }
      const trend = viewTrend(st, sd.view, sd.rt);
      if (trend === 'jitter') { viewJitter(st); return; }
      if (st.viewOk) return;
      if (trend === 'framing') { viewReady(st, sd); return; }
      clearTimeout(st.viewWait);
      st.viewWait = setTimeout(() => { if (!st.viewOk && !st.viewJitter) viewReady(st, sd); }, 1000);
    });
  }
  function viewReady(st, sd) {
    st.viewOk = true;
    clearTimeout(st.viewWait);
    if (sd.toScreen && st.mirrorX !== undefined && !st.active && !st.pending && !st.armed) { st.qualifyCam = sd.main.camera; core.considerActivation(st); }
  }
  const drawnSoFar = (st) => { const ri = st.r.info && st.r.info.render; return ri ? (ri.triangles || 0) + (ri.points || 0) + (ri.lines || 0) : 0; };
  function noteSeedMiss(st, why) {
    if (st.seedMiss === null) queueMicrotask(() => { st.seedMiss = null; });
    st.seedMiss = why;
  }

  const viewOf = (cam) => (cam && cam.view && cam.view.enabled ? cam.view : null);
  const viewSnap = (cam) => { const v = viewOf(cam); return v ? [v.fullWidth, v.fullHeight, v.offsetX, v.offsetY, v.width, v.height] : null; };
  const sameView = (p, q) => (p === null || q === null ? p === q : p.every((x, i) => x === q[i]));
  function applyView(m, v) {
    const a = v.fullWidth / v.width, c = v.fullHeight / v.height;
    if (!(isFinite(a) && isFinite(c))) return;
    const b = a * (1 - (2 * v.offsetX) / v.fullWidth) - 1;
    const d = 1 - c * (1 - (2 * v.offsetY) / v.fullHeight);
    for (let k = 0; k < 16; k += 4) {
      const w = m[k + 3];
      m[k] = a * m[k] + b * w;
      m[k + 1] = c * m[k + 1] + d * w;
    }
  }
  const MIRROR_ROWS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9], MIRROR_BINS = 64, MIRROR_PW = 192, MIRROR_HP = 6;
  const conjX = (m) => { for (const k of [1, 2, 3, 4, 8, 12]) m[k] = -m[k]; return m; };
  function probeMirror(st, sd, pass, passCam) {
    if (core.T.chainMirror === false) { st.mirrorX = false; st.mirrorWhy = 'probe off (chainMirror: false)'; return; }
    const t = performance.now();
    if (t < st.mirrorNext) return;
    st.mirrorNext = t + 250;
    st.mirrorAsks++;
    const r = st.r, gl = typeof r.getContext === 'function' ? r.getContext() : null;
    const main = sd.main; // the frame's main seed: the scene, not an overlay seeded after it (markSeed)
    const RT = main.rt && main.rt.isWebGLRenderTarget ? main.rt.constructor : null;
    if (!gl || !RT || typeof r.readRenderTargetPixels !== 'function') {
      st.mirrorX = false; st.mirrorWhy = `cannot probe: ${!gl ? 'no WebGL context' : !RT ? 'the seed is not a WebGLRenderTarget' : 'no readRenderTargetPixels'}`;
      return;
    }
    if (!st.mirrorGiveUp) {
      st.mirrorGiveUp = setTimeout(() => {
        if (st.mirrorX !== undefined) return;
        st.mirrorX = false; st.mirrorWhy = `undecided after 3 s (${st.mirrorAsks} asks; last: ${st.mirrorWhy}): taken as not mirrored`;
        if (!st.active && !st.pending && !st.armed && st.qualifyCam) core.considerActivation(st);
      }, 3000);
    }
    try {
      const ph = Math.max(8, Math.round((MIRROR_PW * st.L.h) / (st.L.w || 1)));
      const out = drawRows(st, RT, MIRROR_PW, ph, pass, passCam);   // the chain's output: its screen pass, drawn again
      const scn = drawRows(st, RT, MIRROR_PW, ph, main.scene, main.camera); // the scene, as the page camera sees it
      const o = highPass(out), s = highPass(scn), f = [];
      for (let k = 0; k < MIRROR_ROWS.length; k++) for (let b = MIRROR_BINS - 1; b >= 0; b--) f.push(s[k * MIRROR_BINS + b]);
      const so = spread(o), ss = spread(s);
      if (so < 0.5 || ss < 0.5) { // ask again later
        st.mirrorWhy = `blank frame (structure: screen ${so.toFixed(2)}, scene ${ss.toFixed(2)}; screen pass ${out.stats}; scene ${scn.stats}, ` +
          `${sd.n} seed(s) this frame, the main one (${main.drawn} primitives) a ${main.scene.type} of ${main.scene.children ? main.scene.children.length : 0} children, camera layers ${main.camera.layers ? main.camera.layers.mask : '?'})`;
        return;
      }
      const asDrawn = corr(s, o), mirrored = corr(f, o);
      st.mirrorCorr = [+asDrawn.toFixed(3), +mirrored.toFixed(3)];
      if (Math.max(asDrawn, mirrored) <= 0.4 || Math.abs(mirrored - asDrawn) < 0.25) { st.mirrorWhy = 'ambiguous'; return; } // ask again later
      st.mirrorX = mirrored > asDrawn;
      st.mirrorWhy = 'decided';
      if (st.mirrorX) info(`the post chain on ${desc(st.canvas)} mirrors its picture left-right (r ${mirrored.toFixed(2)} mirrored vs ${asDrawn.toFixed(2)} as drawn): each eye is drawn mirrored to match`);
    } catch (e) {
      warnOnce('mirror', 'could not compare the post chain with its scene: taken as not mirrored', e);
      st.mirrorX = false; st.mirrorWhy = `error: ${e && e.message}`;
    }
  }
  function highPass(v) {
    const out = [];
    for (let k = 0; k < v.length; k += MIRROR_BINS) {
      for (let b = 0; b < MIRROR_BINS; b++) {
        const lo = Math.max(0, b - MIRROR_HP), hi = Math.min(MIRROR_BINS - 1, b + MIRROR_HP);
        let s = 0;
        for (let j = lo; j <= hi; j++) s += v[k + j];
        out.push(v[k + b] - s / (hi - lo + 1));
      }
    }
    return out;
  }
  function drawRows(st, RT, pw, ph, scene, camera) {
    const r = st.r, rt = new RT(pw, ph), px = new Uint8Array(pw * ph * 4), out = [];
    const prev = st.call('getRenderTarget');
    const sm = r.shadowMap, smAuto = sm ? sm.autoUpdate : undefined;
    try {
      if (sm) sm.autoUpdate = false; // the page's own draw this frame rendered them
      st.call('setRenderTarget', rt);
      st.call('clear', true, true, true);
      st.call('render', scene, camera);
      const ri = r.info && r.info.render; // reset by render() itself (info.autoReset): this draw alone
      r.readRenderTargetPixels(rt, 0, 0, pw, ph, px);
      let lo = 255, hi = 0, sum = 0;
      for (let i = 0; i < px.length; i += 4) { const l = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]; lo = Math.min(lo, l); hi = Math.max(hi, l); sum += l; }
      out.stats = `${ri ? ri.calls : '?'} calls, ${ri ? ri.triangles : '?'} triangles, luminance ${lo.toFixed(0)}..${hi.toFixed(0)} (mean ${(sum / (px.length / 4)).toFixed(0)})`;
    } finally {
      if (sm) sm.autoUpdate = smAuto;
      st.call('setRenderTarget', prev);
      rt.dispose();
    }
    for (const f of MIRROR_ROWS) binRow(px, Math.min(ph - 1, Math.floor(f * ph)) * pw * 4, pw, out);
    return out;
  }
  function binRow(px, at, w, out) {
    for (let b = 0; b < MIRROR_BINS; b++) {
      const x0 = Math.floor((b * w) / MIRROR_BINS), x1 = Math.max(x0 + 1, Math.floor(((b + 1) * w) / MIRROR_BINS));
      let s = 0;
      for (let x = x0; x < x1; x++) { const i = at + x * 4; s += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]; }
      out.push(s / (x1 - x0));
    }
  }
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const spread = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) * (x - m)))); };
  function corr(a, b) {
    const ma = mean(a), mb = mean(b);
    let ab = 0, aa = 0, bb = 0;
    for (let i = 0; i < a.length; i++) { const x = a[i] - ma, y = b[i] - mb; ab += x * y; aa += x * x; bb += y * y; }
    return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
  }

  const VIEW_FRAMES = 8;
  function viewTrend(st, v, rt) {
    const bw = (rt && rt.width) || st.L.w * st.L.pr || 1, bh = (rt && rt.height) || st.L.h * st.L.pr || 1;
    const e = { x: (v[2] / (v[0] || 1)) * bw, y: (v[3] / (v[1] || 1)) * bh, w: v[4] / (v[0] || 1), h: v[5] / (v[1] || 1) };
    const hist = st.viewHist, prev = hist[hist.length - 1];
    hist.push(e);
    if (hist.length > VIEW_FRAMES) hist.shift();
    if (!prev) return 'unknown';
    const dx = e.x - prev.x, dy = e.y - prev.y;
    if (e.w !== prev.w || e.h !== prev.h || (dx === 0 && dy === 0) || Math.abs(dx) >= 1 || Math.abs(dy) >= 1) { st.viewSteps = 0; return 'framing'; }
    st.viewSteps++;
    const run = hist.slice(-Math.min(st.viewSteps + 1, VIEW_FRAMES)); // this run of sub-pixel steps
    const turns = (k) => {
      let n = 0;
      for (let i = 2; i < run.length; i++) {
        const a = run[i - 1][k] - run[i - 2][k], b = run[i][k] - run[i - 1][k];
        if (a * b < 0) n++;
      }
      return n;
    };
    const span = (k) => Math.max(...run.map((p) => p[k])) - Math.min(...run.map((p) => p[k]));
    if (Math.min(turns('x'), turns('y')) >= 2 && span('x') <= 1.5 && span('y') <= 1.5) return 'jitter';
    return st.viewSteps >= VIEW_FRAMES - 1 ? 'framing' : 'unknown';
  }
  const WHY_JITTER = 'the scene pass jitters camera.setViewOffset (TAA / SSAA) — not split';
  function viewJitter(st) {
    if (st.viewJitter) return;
    st.viewJitter = true; st.flatReason = WHY_JITTER;
    info('three.js canvas', desc(st.canvas), 'stays 2D:', WHY_JITTER);
    if (st.active) core.stand(st, WHY_JITTER, { staged: true });
    else if (st.pending || st.armed) core.stand(st, WHY_JITTER);
    core.notify();
  }
  function passMaterials(obj) {
    const mats = [];
    let meshes = 0, seen = 0;
    const stack = [obj];
    while (stack.length) {
      const o = stack.pop();
      if (++seen > 64) return null;
      if (o.isMesh || o.isPoints || o.isLine || o.isSprite) {
        if (++meshes > 8) return null;
        const m = o.material;
        if (Array.isArray(m)) { for (const x of m) if (x) mats.push(x); } else if (m) mats.push(m);
      }
      const ch = o.children;
      if (ch) for (let i = 0; i < ch.length; i++) stack.push(ch[i]);
    }
    if (obj.overrideMaterial) mats.push(obj.overrideMaterial);
    return mats;
  }
  function taintedSwaps(st, obj) {
    if (!st.texTwin.size) return null;
    const mats = passMaterials(obj);
    if (!mats) return null;
    let out = null;
    const hit = (holder, key, tex) => {
      const tw = tex && tex.isTexture ? st.texTwin.get(tex) : null;
      if (tw) (out || (out = [])).push([holder, key, tex, tw]);
    };
    for (const m of mats) {
      const u = m.uniforms;
      if (u) {
        for (const k in u) {
          const e = u[k], v = e && e.value;
          if (!v) continue;
          if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) hit(v, i, v[i]); } else hit(e, 'value', v);
        }
      }
      for (const k of TEX_PROPS) hit(m, k, m[k]);
    }
    return out;
  }
  const swapIn = (sw) => { if (sw) for (const s of sw) s[0][s[1]] = s[3]; };
  const swapOut = (sw) => { if (sw) for (let i = sw.length - 1; i >= 0; i--) { const s = sw[i]; s[0][s[1]] = s[2]; } };
  function twinOf(st, rt) {
    let tw = st.twins.get(rt);
    if (!tw) {
      tw = rt.clone();
      st.twins.set(rt, tw);
      const a = rt.textures || [rt.texture], b = tw.textures || [tw.texture];
      for (let i = 0; i < a.length; i++) if (a[i] && b[i]) st.texTwin.set(a[i], b[i]);
      if (rt.texture && tw.texture) st.texTwin.set(rt.texture, tw.texture);
    }
    if (rt.depthTexture && !tw.depthTexture) tw.depthTexture = rt.depthTexture.clone();
    if (rt.depthTexture && tw.depthTexture) st.texTwin.set(rt.depthTexture, tw.depthTexture);
    if (tw.width !== rt.width || tw.height !== rt.height) tw.setSize(rt.width, rt.height, rt.depth);
    if (tw.viewport && rt.viewport) tw.viewport.copy(rt.viewport);
    if (tw.scissor && rt.scissor) tw.scissor.copy(rt.scissor);
    tw.scissorTest = rt.scissorTest;
    return tw;
  }
  const mirroredPose = new Float32Array(16);
  const mirrorOf = (st) => (core.T.chainMirror === 'force' ? true : !!st.mirrorX);
  function aimEye(st, camera, eyes, i, rev) {
    const e = eyes[i], mirror = mirrorOf(st);
    let pose = core.eyePose(st, i, camera.matrixWorld.elements);
    if (mirror) {
      mirroredPose.set(pose);
      conjX(mirroredPose);
      const t = st.piv && st.piv.t;
      if (t) mirroredPose[12] += 2 * t[0];
      pose = mirroredPose;
    }
    st.m4.fromArray(pose);
    e.matrixWorld.multiplyMatrices(camera.matrixWorld, st.m4);
    e.matrix.copy(e.matrixWorld);
    invertFrom(e.matrixWorldInverse, e.matrixWorld);
    eyeProjection(st, e, i, rev, viewOf(camera), mirror);
    e.near = camera.near; e.far = camera.far; e.fov = camera.fov; e.aspect = camera.aspect; e.zoom = camera.zoom;
    if (e.layers && camera.layers) e.layers.mask = camera.layers.mask;
    return e;
  }
  function renderIntoChain(st, scene, camera, rt, seed) {
    const stereo = seed && st.haveViews;
    let eyes = null, rev = false;
    if (stereo) {
      if (typeof camera.updateWorldMatrix === 'function') camera.updateWorldMatrix(true, false);
      else if (camera.parent === null) camera.updateMatrixWorld();
      eyes = eyeCameras(st, camera); rev = reversedDepth(st);
    }
    const tw = twinOf(st, rt);
    const face = st.call('getActiveCubeFace'), level = st.call('getActiveMipmapLevel');
    const sw = seed ? null : taintedSwaps(st, scene); // read before the left draw: the same textures
    const sm = st.r.shadowMap, smAuto = sm ? sm.autoUpdate : undefined;
    const fi = frameInfo(st); // the eye pair is one renderer frame here too (see eyeFrame)
    let fr = null;
    try {
      fr = eyeFrame(fi, 0, fr);
      st.call('render', scene, stereo ? aimEye(st, camera, eyes, 0, rev) : camera);
      swapIn(sw);
      st.call('setRenderTarget', tw, face, level);
      if (sm) sm.autoUpdate = false; // shadow maps are view-independent: rendered by the left draw
      fr = eyeFrame(fi, 1, fr);
      st.call('render', scene, stereo ? aimEye(st, camera, eyes, 1, rev) : camera);
    } finally {
      endFrame(fi, fr);
      swapOut(sw);
      if (sm) sm.autoUpdate = smAuto;
      st.call('setRenderTarget', rt, face, level);
    }
  }
  function clearChain(st, rt, color, depth, stencil) {
    const tw = twinOf(st, rt);
    const face = st.call('getActiveCubeFace'), level = st.call('getActiveMipmapLevel');
    st.call('clear', color, depth, stencil);
    try { st.call('setRenderTarget', tw, face, level); st.call('clear', color, depth, stencil); }
    finally { st.call('setRenderTarget', rt, face, level); }
  }
  function renderPostScreen(st, scene, camera) {
    const sw = taintedSwaps(st, scene);
    const sm = st.r.shadowMap, smAuto = sm ? sm.autoUpdate : undefined;
    const fi = frameInfo(st);
    let fr = null;
    try {
      fr = eyeFrame(fi, 0, fr);
      setEyeViewport(st, 0);
      st.call('render', scene, camera);
      setEyeViewport(st, 1);
      swapIn(sw);
      if (sm) sm.autoUpdate = false;
      fr = eyeFrame(fi, 1, fr);
      st.call('render', scene, camera);
    } finally {
      endFrame(fi, fr);
      swapOut(sw);
      if (sm) sm.autoUpdate = smAuto;
      st.call('setScissorTest', false);
    }
    if (st.chainStereo) st.stats.stereo++; else st.stats.flat++;
    core.drew(st);
  }
  function disposeChain(st) {
    for (const tw of st.twins.values()) { try { tw.dispose(); } catch (e) { /* ignore */ } }
    st.twins.clear(); st.texTwin.clear(); st.chainStereo = false;
  }

  function forEachBounds(scene, cam, cb) {
    let more = true;
    scene.traverseVisible((o) => {
      if (!more) return;
      const splat = isSplatMesh(o);
      if (!splat && !(o.isMesh || o.isPoints || o.isLine || o.isSprite)) return;
      if (cam.layers && o.layers && typeof cam.layers.test === 'function' && !cam.layers.test(o.layers)) return;
      if (splat) { more = splatBounds(o, cam, cb); return; }
      if (isSparkRenderer(o)) return; // Spark's draw quad, not scene content
      let bs = o.boundingSphere || null;
      const g = o.geometry;
      if (!bs && g) {
        if (!g.boundingSphere && typeof g.computeBoundingSphere === 'function') { try { g.computeBoundingSphere(); } catch (e) { /* ignore */ } }
        bs = g.boundingSphere;
      }
      if (!bs || !(bs.radius >= 0) || !isFinite(bs.radius)) return;
      const m = o.matrixWorld.elements, c = bs.center;
      more = cb(xfX(m, c.x, c.y, c.z), xfY(m, c.x, c.y, c.z), xfZ(m, c.x, c.y, c.z), bs.radius * maxScale(m)) !== false;
    });
  }
  const xfX = (m, x, y, z) => m[0] * x + m[4] * y + m[8] * z + m[12];
  const xfY = (m, x, y, z) => m[1] * x + m[5] * y + m[9] * z + m[13];
  const xfZ = (m, x, y, z) => m[2] * x + m[6] * y + m[10] * z + m[14];
  const maxScale = (m) => Math.sqrt(Math.max(m[0] * m[0] + m[1] * m[1] + m[2] * m[2], m[4] * m[4] + m[5] * m[5] + m[6] * m[6], m[8] * m[8] + m[9] * m[9] + m[10] * m[10]));

  const SPLAT_SAMPLES = 50000, SPLAT_POINTS = 1500, SPLAT_RESAMPLE_MS = 1000;
  const splatCache = new WeakMap(); // SplatMesh -> { src, n, at, cost, pts: Float32Array [x y z r]*, k, cx, cy, cz, r }
  const isSplatMesh = (o) => !!o && !o.isMesh && typeof o.forEachSplat === 'function' && typeof o.getBoundingBox === 'function' && 'numSplats' in o;
  const isSparkRenderer = (o) => typeof o.updateInternal === 'function' && 'orderingTexture' in o;
  function splatCount(o, src) {
    try {
      const n = src && typeof src.getNumSplats === 'function' ? src.getNumSplats() : src && src.numSplats !== undefined ? src.numSplats : o.numSplats;
      return n > 0 && isFinite(n) ? n : 0;
    } catch (e) { return 0; }
  }
  function splatSample(o) {
    const src = o.splats || o.packedSplats || o.extSplats || null, n = splatCount(o, src);
    const c = splatCache.get(o);
    if (!n) return null; // not loaded yet
    if (c && c.src === src && c.n === n) return c.k ? c : null;
    const now = performance.now();
    if (c && c.src === src && now - c.at < Math.max(SPLAT_RESAMPLE_MS, 20 * c.cost)) return c.k ? c : null;
    const step = Math.max(1, Math.ceil(n / SPLAT_SAMPLES));
    const pts = new Float32Array(Math.ceil(n / step) * 4);
    let k = 0;
    const take = (ctr, sc) => {
      if (k >= pts.length || !ctr || !isFinite(ctr.x) || !isFinite(ctr.y) || !isFinite(ctr.z)) return;
      const r = sc ? Math.max(sc.x, sc.y, sc.z) : 0;
      pts[k] = ctr.x; pts[k + 1] = ctr.y; pts[k + 2] = ctr.z; pts[k + 3] = r > 0 && isFinite(r) ? r : 1e-4;
      k += 4;
    };
    const walk = () => o.forEachSplat((i, ctr, sc) => { if (i % step === 0) take(ctr, sc); });
    try {
      if (src && typeof src.getSplat === 'function') for (let i = 0; i < n; i += step) { const s = src.getSplat(i); take(s.center, s.scales); }
      else walk();
    } catch (e) {
      k = 0;
      try { walk(); } catch (e2) { warnOnce('spark-bounds', 'could not read Spark splat centres: convergence falls back', e2); k = 0; }
    }
    const e = { src, n, at: now, cost: performance.now() - now, pts, k: k / 4, cx: 0, cy: 0, cz: 0, r: 0 };
    splatCache.set(o, e);
    if (!e.k) return null;
    for (let i = 0; i < k; i += 4) { e.cx += pts[i]; e.cy += pts[i + 1]; e.cz += pts[i + 2]; }
    e.cx /= e.k; e.cy /= e.k; e.cz /= e.k;
    const d = new Float32Array(e.k);
    for (let i = 0, j = 0; i < k; i += 4, j++) d[j] = Math.hypot(pts[i] - e.cx, pts[i + 1] - e.cy, pts[i + 2] - e.cz) + pts[i + 3];
    d.sort();
    e.r = d[Math.min(e.k - 1, Math.floor(e.k * 0.98))];
    return e;
  }
  function splatBounds(o, cam, cb) {
    const S = splatSample(o);
    if (!S) return true;
    const m = o.matrixWorld.elements, sc = maxScale(m), cw = cam.matrixWorld.elements;
    const wx = xfX(m, S.cx, S.cy, S.cz), wy = xfY(m, S.cx, S.cy, S.cz), wz = xfZ(m, S.cx, S.cy, S.cz), wr = S.r * sc;
    if (Math.hypot(wx - cw[12], wy - cw[13], wz - cw[14]) > wr) return cb(wx, wy, wz, wr) !== false;
    const vm = cam.matrixWorldInverse.elements, p = S.pts;
    const tanV = Math.tan(((cam.fov || 50) * Math.PI) / 360) / (cam.zoom || 1), tanH = tanV * (cam.aspect || 1), near = cam.near || 0;
    const ahead = [];
    for (let i = 0; i < S.k * 4; i += 4) {
      const x = xfX(m, p[i], p[i + 1], p[i + 2]), y = xfY(m, p[i], p[i + 1], p[i + 2]), z = xfZ(m, p[i], p[i + 1], p[i + 2]);
      const vz = -(vm[2] * x + vm[6] * y + vm[10] * z + vm[14]);
      if (!(vz > near)) continue;
      const vx = vm[0] * x + vm[4] * y + vm[8] * z + vm[12], vy = vm[1] * x + vm[5] * y + vm[9] * z + vm[13];
      if (Math.abs(vx) > vz * tanH * 1.2 || Math.abs(vy) > vz * tanV * 1.2) continue;
      ahead.push(i);
    }
    const step = Math.max(1, ahead.length / SPLAT_POINTS);
    for (let j = 0; j < ahead.length; j += step) {
      const i = ahead[Math.floor(j)];
      if (cb(xfX(m, p[i], p[i + 1], p[i + 2]), xfY(m, p[i], p[i + 1], p[i + 2]), xfZ(m, p[i], p[i + 1], p[i + 2]), p[i + 3] * sc, true) === false) return false;
    }
    return true;
  }

  const CORE_POINTS = 12000, CORE_TRIS = 24000, CORE_CHECK_MS = 500;
  const coreCache = new WeakMap(); // state -> { at, key, set }
  function positionsOf(pos) {
    if (!pos || !(pos.count >= 3)) return null;
    const arr = pos.array;
    if (arr instanceof Float32Array && pos.itemSize === 3 && !pos.isInterleavedBufferAttribute && !pos.normalized) return arr.length >= 9 ? arr : null;
    const has = arr ? arr.length > 0 : !!(pos.data && pos.data.array && pos.data.array.length);
    if (!has || typeof pos.getX !== 'function') return null;
    const out = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) { out[i * 3] = pos.getX(i); out[i * 3 + 1] = pos.getY(i); out[i * 3 + 2] = pos.getZ(i); }
    return out;
  }
  function coreSet(st, s, ref) {
    const scene = st.lastScene, cam = st.mainCam;
    if (!scene || !cam) return null;
    const now = performance.now(), C = coreCache.get(st);
    if (C && now - C.at < CORE_CHECK_MS) return C.set;
    const F = (ref && ref.F) || core.stageFrame(s, ref && ref.d > 0 ? ref.d : 0);
    const found = [];
    let key = '', skipped = 0, other = 0;
    scene.traverseVisible((o) => {
      const splat = isSplatMesh(o);
      if (!splat && !(o.isMesh || o.isPoints)) return;
      if (isSparkRenderer(o)) return;
      if (cam.layers && o.layers && typeof cam.layers.test === 'function' && !cam.layers.test(o.layers)) return;
      const m = o.matrixWorld.elements, sc = maxScale(m);
      if (splat) {
        const S = splatSample(o);
        if (!S) return;
        const wx = xfX(m, S.cx, S.cy, S.cz), wy = xfY(m, S.cx, S.cy, S.cz), wz = xfZ(m, S.cx, S.cy, S.cz);
        if (Math.hypot(wx - F.px, wy - F.py, wz - F.pz) <= S.r * sc) { skipped++; return; } // a splat world: no core
        found.push({ o, splat: S }); key += `s${o.id}:${S.n};`;
        return;
      }
      const g = o.geometry, mat = Array.isArray(o.material) ? o.material[0] : o.material;
      if (!g || (mat && (mat.isShadowMaterial || mat.visible === false || (mat.transparent && mat.opacity < 0.05)))) return;
      if (!g.boundingBox && typeof g.computeBoundingBox === 'function') { try { g.computeBoundingBox(); } catch (e) { /* ignore */ } }
      if (!g.boundingSphere && typeof g.computeBoundingSphere === 'function') { try { g.computeBoundingSphere(); } catch (e) { /* ignore */ } }
      const bs = o.boundingSphere || g.boundingSphere, bb = o.boundingBox || g.boundingBox;
      if (!bs || !bb || !(bs.radius > 0) || !isFinite(bs.radius)) return;
      const c = bs.center;
      const sg = core.isStage(xfX(m, c.x, c.y, c.z), xfY(m, c.x, c.y, c.z), xfZ(m, c.x, c.y, c.z), bs.radius * sc, bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z, F);
      if (sg) { skipped++; if (sg === 2 || sg === 4) other++; return; }
      const pos = g.attributes && g.attributes.position;
      found.push({ o, g, pos, bb });
      key += `${o.id}:${g.id}:${pos ? pos.count + '.' + (pos.version || 0) : 0};`;
    });
    if (C && C.key === key) { C.at = now; return C.set; }
    const t0 = performance.now(), cands = [];
    let boxed = 0;
    for (const e of found) {
      const m = e.o.matrixWorld.elements;
      if (e.splat) { cands.push({ m, pts: e.splat.pts, k: e.splat.k, stride: 4 }); continue; }
      const P = e.o.isSkinnedMesh || e.o.isInstancedMesh ? null : positionsOf(e.pos);
      if (e.o.isPoints) { if (P) cands.push({ m, pts: P, k: Math.floor(P.length / 3), stride: 3 }); continue; }
      if (!P) { boxed++; cands.push({ m, min: [e.bb.min.x, e.bb.min.y, e.bb.min.z], max: [e.bb.max.x, e.bb.max.y, e.bb.max.z] }); continue; }
      { const mt = Array.isArray(e.o.material) ? e.o.material[0] : e.o.material; cands.push({ m, P, I: e.g.index && e.g.index.count >= 3 ? e.g.index.array : null, name: `${e.o.name || e.o.type}|${mt ? mt.type + (mt.transparent ? ' transp ' + (+mt.opacity).toFixed(2) : '') + (mt.depthWrite === false ? ' noDepthWrite' : '') : ''}|ro${e.o.renderOrder}` }); }
    }
    const parts = core.sampleSurface(cands, CORE_POINTS, CORE_TRIS);
    const set = parts.length ? { parts, other, note: `${found.length} mesh(es) read${boxed ? `, ${boxed} by bounding box` : ''}, ${skipped} left out as stage (${other} of them other geometry); ${(performance.now() - t0).toFixed(1)} ms` } : null;
    coreCache.set(st, { at: now, key, set });
    return set;
  }

  info(`three.js adapter armed (core v${core.VERSION})`);
  return { observe: onObserve, register: onRegister };
}
function dxrPlayCanvas(core) {
  core.registerEngine('PlayCanvas');
  const { info, warnOnce, desc, realW, realH } = core;
  const DEG = Math.PI / 180;

  const apps = new WeakMap(); // app -> state; null before the device exists, false when not convertible
  const via = new WeakMap();  // app -> how it was found
  let pcNS = null;            // the engine namespace, when the page has one (UMD / editor builds)
  core.meta.playcanvas = { detected: [] };

  const isApp = (a) =>
    !!a && typeof a === 'object' && typeof a.on === 'function' && typeof a.fire === 'function' && !!a.systems &&
    ((typeof a.tick === 'function' && 'graphicsDevice' in a) ||
      (typeof a.init === 'function' && typeof a.start === 'function'));

  const lookAts = new WeakMap(); // entity -> { x, y, z }
  const hookedProtos = new WeakSet();
  function hookLookAt(node) {
    let p = node && Object.getPrototypeOf(node);
    while (p && !Object.prototype.hasOwnProperty.call(p, 'lookAt')) p = Object.getPrototypeOf(p);
    if (!p || hookedProtos.has(p) || typeof p.lookAt !== 'function') return;
    hookedProtos.add(p);
    const orig = p.lookAt;
    try {
      p.lookAt = function (x, y, z) {
        const v = x && typeof x === 'object' ? x : null;
        const t = v ? { x: v.x, y: v.y, z: v.z } : { x, y, z };
        if (isFinite(t.x) && isFinite(t.y) && isFinite(t.z)) lookAts.set(this, t);
        return orig.apply(this, arguments);
      };
    } catch (e) { warnOnce('pc-lookat', 'could not watch entity.lookAt — convergence falls back to the estimator', e); }
  }
  function hookRoot(app) {
    if (app.root) { hookLookAt(app.root); return; }
    try {
      Object.defineProperty(app, 'root', {
        configurable: true, enumerable: true,
        get() { return undefined; },
        set(v) {
          Object.defineProperty(app, 'root', { value: v, writable: true, enumerable: true, configurable: true });
          if (v) hookLookAt(v);
        },
      });
    } catch (e) { /* the engine's own field: fine, lookAt calls before the first frame are missed */ }
  }
  const TARGET_FIELDS = [['pivotPoint', 'orbit-camera pivotPoint'], ['focusPoint', 'CameraControls focusPoint']];

  function consider(app, how, ns) {
    if (core.retired) return; // stood down for good: no app is taken on after that
    if (!pcNS && ns && typeof ns === 'object' && (ns.AppBase || ns.Application)) pcNS = ns;
    if (!isApp(app) || apps.has(app)) return;
    apps.set(app, null);
    hookRoot(app);
    via.set(app, how);
    core.meta.playcanvas.detected.push(how);
    info('PlayCanvas app found via', how);
    app.on('postrender', () => onPostRender(app));
    app.on('prerender', () => onPreRender(app));
    app.on('destroy', () => { const st = apps.get(app); if (st && (st.active || st.pending || st.armed)) core.stand(st, 'the page destroyed the app'); });
  }

  function stateFor(app) {
    let st = apps.get(app);
    if (st !== null && st !== undefined) return st || null; // false = seen and not convertible
    const dev = app.graphicsDevice;
    if (!dev || !app.root) return null; // still in the constructor / init
    const canvas = dev.canvas;
    if (!(canvas instanceof HTMLCanvasElement)) { warnOnce('pc-offscreen', 'PlayCanvas on an OffscreenCanvas — not supported, left 2D'); apps.set(app, false); return null; }
    st = core.newState('PlayCanvas', canvas, ad);
    Object.assign(st, {
      app, dev, depth: 0, cam: null, views: null, rvKind: null, frustumKey: '',
      L: { w: realW(canvas), h: realH(canvas), pr: 1 }, // what the PAGE believes: its mono store, in pixels
      frame: { drew: false }, footprint: { patched: 0, seen: 0 },
    });
    apps.set(app, st);
    wrapDevice(st);
    info(`PlayCanvas app on ${desc(canvas)} (${dev.isWebGPU ? 'WebGPU' : 'WebGL2'}, found via ${via.get(app)})`);
    return st;
  }

  function wrapDevice(st) {
    const dev = st.dev;
    const orig = dev.setResolution;
    st.setRes = (w, h) => {
      if (dev.isWebGPU && typeof dev.submit === 'function' && (realW(st.canvas) !== w || realH(st.canvas) !== h)) {
        try { dev.submit(); } catch (e) { warnOnce('pc-gpu-submit', 'could not submit the frame before a resize', e); }
      }
      st.depth++; try { orig.call(dev, w, h); } finally { st.depth--; }
    };
    dev.setResolution = function (w, h) {
      if (!st.active || st.depth > 0) { if (!st.active) { st.L.w = w; st.L.h = h; } return orig.call(dev, w, h); }
      st.L.w = w; st.L.h = h;
      if (applyRealSize(st)) st.app.renderNextFrame = true;
    };
    if (dev.isWebGPU) { wrapWgsl(st); return; }
    const gl = dev.gl;
    if (gl && typeof gl.shaderSource === 'function' && !dev.isWebGPU) {
      const ss = gl.shaderSource;
      gl.shaderSource = function (sh, src) {
        if (typeof src === 'string' && src.indexOf('J2') >= 0 && /vec2\s+J2\s*=/.test(src)) {
          st.footprint.seen++;
          if (nativeFootprint(src)) st.footprint.native = (st.footprint.native || 0) + 1;
          else if (core.T.pcFootprint !== false) {
            const p = patchGsplatFootprint(src);
            if (p.ok) { st.footprint.patched++; src = p.src; }
          }
        }
        return ss.call(this, sh, src);
      };
    }
  }
  function wrapWgsl(st) {
    const w = st.dev.wgpu;
    if (!w || typeof w.createShaderModule !== 'function') return;
    const csm = w.createShaderModule;
    w.createShaderModule = function (desc) {
      const code = desc && desc.code;
      if (typeof code === 'string' && code.indexOf('J2') >= 0 && /let\s+J2\s*=/.test(code)) {
        st.footprint.seen++;
        if (nativeFootprint(code)) st.footprint.native = (st.footprint.native || 0) + 1;
        else if (core.T.pcFootprint !== false) {
          const p = patchGsplatFootprintWgsl(code);
          if (p.ok) { st.footprint.patched++; desc = { ...desc, code: p.src }; }
        }
      }
      return csm.call(this, desc);
    };
  }
  function applyRealSize(st) {
    const R = core.realSizeFor(st);
    st.R = R;
    if (realW(st.canvas) === R.W && realH(st.canvas) === R.H) return false;
    st.stats.resizes++;
    st.setRes(R.W, R.H);
    return true;
  }

  function pickCamera(app, st) {
    const list = (app.systems.camera && app.systems.camera.cameras) || [];
    const cams = list.filter((c) => c && c.enabled && c.entity && c.entity.enabled && (!c.renderTarget || queueOf(c)));
    if (!cams.length) return { why: 'no enabled camera renders to the canvas' };
    if (cams.length > 1) return { why: `${cams.length} cameras render to the canvas (UI / multi-view) — not split in this prototype`, flat: true };
    const c = cams[0];
    if (!c.camera || !('xrViews' in c.camera)) return { why: 'this PlayCanvas engine has no Camera.xrViews (added in 2.20) — left 2D', flat: true };
    if (c.projection === 1) return { why: 'the camera is orthographic', flat: true };
    const pe = queueOf(c);
    const noPe = pe && postEffectsBlocker(st, c, pe);
    if (noPe) return { why: noPe, flat: true };
    const fp = getFP(c);
    let cf = null;
    if (fp && fp.length) {
      if (pe) return { why: 'post effects and frame passes on the same camera — not split', flat: true };
      if (st && st.cf && fp === st.cf.list) cf = st.cf.A;
      else if (fp.length === 1 && isCameraFramePass(fp[0])) cf = core.T.pcCameraFrame === false ? null : fp[0]; // false: TEST ONLY, unsplit
      else return { why: 'frame passes on the camera that are not one CameraFrame — not split', flat: true };
    }
    return { cam: c, cf, pe: pe && core.T.pcPostEffects !== 'unsplit' ? pe : null }; // 'unsplit': TEST ONLY (A/B)
  }
  function pageCam(st) {
    const c = st.cam.camera;
    const fov = c._fov !== undefined ? c._fov : c.fov;
    const hfov = c._horizontalFov !== undefined ? c._horizontalFov : c.horizontalFov;
    const near = c._nearClip !== undefined ? c._nearClip : c.nearClip;
    const far = c._farClip !== undefined ? c._farClip : c.farClip;
    const aspect = st.L.w / (st.L.h || 1);
    const vfov = hfov ? 2 * Math.atan(Math.tan((fov * DEG) / 2) / aspect) : fov * DEG;
    return { vfov, near, far, aspect };
  }

  function qualify(st) {
    const app = st.app;
    if (app.xr && app.xr.active) return 'the app is presenting WebXR';
    const pick = pickCamera(app, st);
    if (!pick.cam) return pick.flat ? flatWhy(st, pick.why) : pick.why;
    st.qualifyCam = pick.cam;
    const where = core.canvasPlacement(st.canvas);
    if (where) return where;
    if (!(st.L.w > 0 && st.L.h > 0)) return 'canvas has no size yet';
    if (core.T.pcNeeds3D !== false && !has3D(st, pick.cam)) return flatWhy(st, NOTHING_3D); // false: TEST ONLY
    return core.cssEffect(st.canvas);
  }

  const ad = {
    label: (st) => `PlayCanvas ${pcNS && pcNS.version ? pcNS.version : '2.x'}, ${via.get(st.app)}`,
    unqualified(st) {
      const why = qualify(st);
      if (why !== st.flatReason) st.flatReason = null;
      return why;
    },
    hasCamera: (st) => !!st.cam,
    depthRange(st) { const p = pageCam(st); return { near: p.near, far: p.far }; },
    rigFov: (st) => pageCam(st).vfov,
    sampler(st) {
      if (!st.cam) return null;
      const p = pageCam(st);
      return {
        cameraPose: st.cam.entity.getWorldTransform().data,
        verticalFov: p.vfov, aspect: p.aspect, near: p.near, far: p.far,
        forEachBounds: (cb) => forEachBounds(st, cb),
      };
    },
    coreSet: (st, s, ref) => coreSet(st, s, ref),
    fakeViewParams(st) { const p = pageCam(st); return { near: p.near, far: p.far, t: p.near * Math.tan(p.vfov / 2), aspect: p.aspect }; },
    beforeActive(st) {
      st.L.w = realW(st.canvas); st.L.h = realH(st.canvas);
    },
    afterActive(st) {
      st.cam = st.qualifyCam;
      trapCanvasSize(st);
      applyRealSize(st);
      bindViews(st);
      const pick = pickCamera(st.app, st);
      syncCameraFrame(st, pick.cf || null);
      syncPostEffects(st, pick.pe || null);
    },
    firstDraw(st) { st.app.renderNextFrame = true; },
    redraw(st) {
      if (!st.frame.drew) st.stats.replays++;
      st.frame.drew = false;
      st.app.renderNextFrame = true;
    },
    restore(st, wasLive) {
      uninstallCameraFrame(st);
      uninstallPostEffects(st);
      restoreShadows(st);
      if (st.cam && st.cam.camera) { try { st.cam.camera.xrViews = null; } catch (e) { /* ignore */ } }
      st.cam = null; st.views = null; st.frustumKey = '';
      if (wasLive) {
        try { if (realW(st.canvas) !== st.L.w || realH(st.canvas) !== st.L.h) st.setRes(st.L.w, st.L.h); } catch (e) { /* ignore */ }
        st.app.renderNextFrame = true; // the mono frame: drawn on the engine's next tick, reported from postrender
      }
      untrapCanvasSize(st);
      return false;
    },
    wake(st) { st.app.renderNextFrame = true; }, // re-enabled: one frame, whose postrender considers activation
    coverAfterDraw: true,
    surface(st) {
      const d = st.dev;
      if (!d) return null;
      if (d.isWebGPU) {
        if (!d.wgpu || !d.gpuContext) return null;
        return core.surfaces.gpu({
          get device() { return d.wgpu; }, get context() { return d.gpuContext; },
          flush: () => { if (typeof d.submit === 'function') d.submit(); },
          get alphaMode() { return d.canvasConfig ? d.canvasConfig.alphaMode : 'opaque'; },
        });
      }
      return d.gl ? core.surfaces.gl(d.gl) : null;
    },
    target(st) {
      const e = st.cam && st.cam.entity;
      if (!e) return null;
      const list = e.script && (e.script.scripts || e.script._scripts);
      if (Array.isArray(list)) {
        for (const sc of list) {
          if (!sc || sc.enabled === false) continue;
          for (const [f, via] of TARGET_FIELDS) {
            if (!(f in sc)) continue;
            let p = null;
            try { p = sc[f]; } catch (err) { p = null; }
            if (p && isFinite(p.x) && isFinite(p.y) && isFinite(p.z)) return { x: p.x, y: p.y, z: p.z, via };
          }
        }
      }
      const l = lookAts.get(e);
      return l ? { x: l.x, y: l.y, z: l.z, via: 'entity.lookAt' } : null;
    },
    walkControls(st) {
      const e = st.cam && st.cam.entity;
      const list = e && e.script && (e.script.scripts || e.script._scripts);
      if (!Array.isArray(list)) return null;
      for (const sc of list) {
        if (!sc || sc.enabled === false) continue;
        let name = '';
        try { name = (sc.__scriptType && sc.__scriptType.__name) || (sc.constructor && (sc.constructor.__name || sc.constructor.scriptName)) || ''; } catch (err) { name = ''; }
        if (/fly|first.?person|fps|walk|free.?cam/i.test(name)) return `script '${name}' on the camera`;
      }
      return null;
    },
    flipIdle(st) { st.app.renderNextFrame = true; }, // flips on the postrender of that frame
    describe: (st) => ({
      page: { w: st.L.w, h: st.L.h, pr: 1 },
      extra: {
        detection: via.get(st.app), renderView: st.rvKind, camera: st.cam ? st.cam.entity.name : null,
        footprint: { ...st.footprint }, device: st.dev.isWebGPU ? 'webgpu' : 'webgl2', autoRender: st.app.autoRender,
        surface: st.surf ? st.surf.kind : null, outCoverVia: st.outCoverVia || null,
        eyeProj0: st.views && st.views[0] ? Array.from(st.views[0].projMat.data) : null, // what the engine draws eye 0 with
        cameraFrame: describeCameraFrame(st), postEffects: describePostEffects(st), pageSizeWrites: st.pageSizeWrites || 0,
      },
    }),
  };
  const NOTHING_3D = 'nothing 3D for the camera to render (screen-space UI only)';
  function has3D(st, cam) {
    const app = st.app, comp = app.scene && app.scene.layers;
    if (!comp || typeof comp.getLayerById !== 'function' || !Array.isArray(cam.layers)) return true; // unknown shape: do not block
    for (const id of cam.layers) {
      const layer = comp.getLayerById(id);
      if (!layer || layer.enabled === false) continue;
      let mis = layer.meshInstances;
      if (!mis) mis = [...(layer.opaqueMeshInstances || []), ...(layer.transparentMeshInstances || [])];
      for (const mi of mis) {
        if (!mi || mi.visible === false) continue;
        if (isMiniStats(mi)) continue; // the engine's stats overlay: screen-space, wherever it is added
        let n = mi.node, el = null;
        for (let k = 0; n && k < 3 && !el; k++, n = n.parent) el = n.element || null;
        if (el && typeof el._isScreenSpace === 'function' && el._isScreenSpace()) continue;
        return true;
      }
    }
    try { for (const g of app.root.findComponents('gsplat')) if (g.enabled && g.entity.enabled) return true; } catch (e) { return true; }
    const im = app.scene.immediate;
    if (im && ((im.allBatches && im.allBatches.size > 0) || (im.batchesMap && im.batchesMap.size > 0))) return true;
    return false;
  }
  const isMiniStats = (mi) => !!(mi && mi.node && mi.node.name === 'MiniStatsMesh');
  function flatWhy(st, why) {
    if (st.flatReason !== why) { st.flatReason = why; info('PlayCanvas canvas stays 2D:', why); core.notify(); }
    return why;
  }

  function onPostRender(app) {
    const st = stateFor(app);
    if (!st) return;
    st.frame.drew = true;
    if (st.active) { core.drew(st); if (st.outCoverDue) core.takeOutCover(st); return; } // the flat pair was just drawn
    if (st.releasing) { core.monoDrawn(st); return; } // the mono frame after a staged stand-down
    if (st.armed) {
      const pick = pickCamera(app, st);
      if (!pick.cam) { core.stand(st, pick.why); if (pick.flat) flatWhy(st, pick.why); return; }
      st.qualifyCam = pick.cam;
      core.flip(st); // this task just drew the mono frame: it is the cover
      return;
    }
    core.considerActivation(st);
  }
  function onPreRender(app) {
    const st = stateFor(app); // created here at the latest: before the first frame compiles any shader
    if (!st || !st.active) return;
    const pick = pickCamera(app, st);
    if (pick.cam !== st.cam) {
      const why = pick.cam ? 'the page switched cameras' : pick.why;
      core.stand(st, why, { staged: true }); // this frame now renders mono; the layer goes after it
      if (pick.flat) flatWhy(st, pick.why);
      st.nextTry = core.now() + 1000;
      return;
    }
    syncCameraFrame(st, pick.cf || null); // the page may switch its CameraFrame on or off, or rebuild it
    syncPostEffects(st, pick.pe || null); // or add / remove a legacy post effect, or switch its queue on or off
    updateViews(st);
  }

  function makeViews(st) {
    if (pcNS && typeof pcNS.RenderView === 'function') { st.rvKind = 'engine'; return [new pcNS.RenderView(), new pcNS.RenderView()]; }
    const M4 = st.app.root.getWorldTransform().constructor;
    const V4 = st.cam.rect.constructor;
    const nm = st.app.root._normalMatrix;
    const M3 = nm && typeof nm.setFromMat4 === 'function' ? nm.constructor : null;
    const mat3 = () => (M3 ? new M3() : {
      data: new Float32Array(9),
      setFromMat4(m) { const s = m.data, d = this.data; d[0] = s[0]; d[1] = s[1]; d[2] = s[2]; d[3] = s[4]; d[4] = s[5]; d[5] = s[6]; d[6] = s[8]; d[7] = s[9]; d[8] = s[10]; return this; },
    });
    class RenderView {
      constructor() {
        this._positionData = new Float32Array(3); this._viewport = new V4(); this._projMat = new M4();
        this._projViewOffMat = new M4(); this._viewMat = new M4(); this._viewOffMat = new M4();
        this._viewMat3 = mat3(); this._viewInvMat = new M4(); this._viewInvOffMat = new M4();
      }
      get viewport() { return this._viewport; }
      get projMat() { return this._projMat; }
      get projViewOffMat() { return this._projViewOffMat; }
      get viewOffMat() { return this._viewOffMat; }
      get viewInvOffMat() { return this._viewInvOffMat; }
      get viewMat3() { return this._viewMat3; }
      get positionData() { return this._positionData; }
      setView(projMat, viewInvMat, viewMat) {
        this._projMat.set(projMat); this._viewInvMat.set(viewInvMat);
        if (viewMat) this._viewMat.set(viewMat); else this._viewMat.copy(this._viewInvMat).invert();
      }
      setViewport(x, y, w, h) { this._viewport.set(x, y, w, h); }
      updateTransforms(parent) {
        if (parent) { this._viewInvOffMat.mul2(parent, this._viewInvMat); this._viewOffMat.copy(this._viewInvOffMat).invert(); }
        else { this._viewInvOffMat.copy(this._viewInvMat); this._viewOffMat.copy(this._viewMat); }
        this._viewMat3.setFromMat4(this._viewOffMat);
        this._projViewOffMat.mul2(this._projMat, this._viewOffMat);
        this._positionData[0] = this._viewInvOffMat.data[12]; this._positionData[1] = this._viewInvOffMat.data[13]; this._positionData[2] = this._viewInvOffMat.data[14];
      }
    }
    st.rvKind = 'clone';
    return [new RenderView(), new RenderView()];
  }
  function bindViews(st) {
    st.views = makeViews(st);
    st.frustumKey = '';
    st.flatProj = new Float64Array(16);
    st.eyeInv = [new Float64Array(16), new Float64Array(16)];
    st.clipProj = [new Float64Array(16), new Float64Array(16)]; // WebGPU: the eye projections in clip z 0..1
    updateViews(st); // before the first draw: never a frame with an unset view
    st.cam.camera.xrViews = st.views.slice();
  }
  function updateViews(st) {
    const R = st.R, local = st.cam.entity.getLocalTransform().data;
    const sf = core.surfaceOf(st);
    const clip = sf && sf.kind === 'webgpu' && core.T.gpuDepthRange !== false ? sf : null;
    let P0;
    if (st.haveViews) {
      const world = st.cam.entity.getWorldTransform().data;
      for (let i = 0; i < 2; i++) {
        const pose = core.eyePose(st, i, world);
        mul4(local, pose, st.eyeInv[i]);
        if (i === 0) st.eyeAt = [0, 1, 2].map((k) => world[k] * pose[12] + world[4 + k] * pose[13] + world[8 + k] * pose[14] + world[12 + k]); // diagnostics (dev state(): eyeAt)
        st.views[i].setView(clip ? clip.toClip(st.V[i].proj, st.clipProj[i]) : st.V[i].proj, st.eyeInv[i]);
        st.views[i].setViewport(i * R.eyeW, 0, R.eyeW, R.eyeH);
      }
      P0 = st.V[0].proj;
      st.stats.stereo++;
    } else {
      const p = pageCam(st);
      perspective(p.vfov, p.aspect, p.near, p.far, st.flatProj);
      const fp = clip ? clip.toClip(st.flatProj, st.clipProj[0]) : st.flatProj;
      for (let i = 0; i < 2; i++) {
        st.views[i].setView(fp, local);
        st.views[i].setViewport(i * R.eyeW, 0, R.eyeW, R.eyeH);
      }
      P0 = st.flatProj;
      st.stats.flat++;
      if (st.stats.twoView > 0) st.stats.flatAfterEyes++;
    }
    const f = frustumFromProjection(P0);
    const key = `${f.fov.toFixed(4)}|${f.aspectRatio.toFixed(4)}|${f.nearClip}|${f.farClip}`;
    if (key !== st.frustumKey) { st.frustumKey = key; st.cam.camera.setXrProperties({ ...f, horizontalFov: false }); }
    if (st.cf) cameraFrameJitter(st);
    offsetShadows(st);
  }

  function queueOf(c) {
    const q = c && c.postEffects;
    if (!q || !q.enabled || !Array.isArray(q.effects) || !q.effects.length) return null;
    const e0 = q.effects[0];
    return e0 && e0.inputTarget && c.renderTarget === e0.inputTarget && !q.destinationRenderTarget ? q : null;
  }
  function postEffectsBlocker(st, c, q) {
    if (core.T.pcPostEffects === false) return 'post effects on the camera — per-eye split switched off'; // TEST ONLY
    if (st && st.peFailed) return 'the camera\'s post effects could not be run per eye';
    const r = c.rect;
    if (r && (r.x !== 0 || r.y !== 0 || r.z !== 1 || r.w !== 1)) return 'post effects on a camera with a viewport rect — not split';
    for (const e of q.effects) {
      const fx = e && e.effect;
      if (!fx || typeof fx.render !== 'function' || !e.inputTarget || !e.inputTarget.colorBuffer) return 'a post effect of an unknown shape on the camera — not split';
      if (fx.needsDepthBuffer) return 'a post effect that reads the scene depth on the camera — not split per eye';
    }
    const dev = st && st.dev;
    if (dev && !dev.isWebGPU && !(dev.gl && typeof dev.gl.blitFramebuffer === 'function')) return 'post effects on the camera — no framebuffer blit on this device';
    return null;
  }
  function syncPostEffects(st, q) {
    let P = st.pe;
    if (P && P.queue !== q) { uninstallPostEffects(st); P = null; }
    if (!q) return;
    const cam = st.cam;
    if (!P) {
      P = st.pe = { queue: q, cam, orig: null, fn: null, eye: [], rect: null, frames: 0, mono: 0, names: '' };
      P.fn = function () {
        if (st.pe === P && st.active && st.views && perEyeEffects(st, P)) return undefined;
        P.mono++;
        return typeof P.orig === 'function' ? P.orig.apply(this, arguments) : undefined;
      };
    }
    if (cam.onPostprocessing !== P.fn) { P.orig = cam.onPostprocessing; cam.onPostprocessing = P.fn; }
    const names = q.effects.map((e) => e.name || '?').join(', ');
    if (names !== P.names) { P.names = names; info(`legacy post effects run per eye: ${names}`); }
    const src = q.effects[0].inputTarget, dev = st.dev;
    if (st.R && (src.width !== st.R.W || src.height !== st.R.H) && dev.width === st.R.W && dev.height === st.R.H && typeof q.resizeRenderTargets === 'function') {
      try { q.resizeRenderTargets(); } catch (e) { warnOnce('pc-pe-size', 'could not resize the post-effect targets to the side-by-side store', e); }
    }
  }
  function uninstallPostEffects(st) {
    const P = st.pe;
    if (!P) return;
    st.pe = null;
    try { if (P.cam.onPostprocessing === P.fn) P.cam.onPostprocessing = P.orig; } catch (e) { /* ignore */ }
    for (const rt of P.eye) { try { rt.destroyTextureBuffers(); rt.destroy(); } catch (e) { /* ignore */ } }
    P.eye.length = 0;
  }
  function perEyeEffects(st, P) {
    const fx = P.queue.effects, n = fx.length, R = st.R;
    const src = n ? fx[0].inputTarget : null;
    if (!src || !R || P.failed || src.width !== R.W || src.height !== R.H) return false;
    try {
      const w = R.eyeW, h = R.eyeH;
      for (let j = 0; j < n; j++) {
        const like = fx[j].inputTarget, t = like.colorBuffer;
        let rt = P.eye[j];
        if (rt && rt.colorBuffer.format !== t.format) { rt.destroyTextureBuffers(); rt.destroy(); rt = null; }
        if (!rt) {
          const tex = new t.constructor(st.dev, { name: `DxrPostEffectEye-${j}`, width: w, height: h, format: t.format, mipmaps: false,
            minFilter: t.minFilter, magFilter: t.magFilter, addressU: t.addressU, addressV: t.addressV });
          rt = P.eye[j] = new like.constructor({ name: `DxrPostEffectEye-${j}`, colorBuffer: tex, depth: false });
        } else if (rt.width !== w || rt.height !== h) rt.resize(w, h);
      }
      while (P.eye.length > n) { const rt = P.eye.pop(); rt.destroyTextureBuffers(); rt.destroy(); }
      const rect = P.rect || (P.rect = P.cam.rect.clone());
      for (let i = 0; i < 2; i++) {
        if (!copyEye(st, src, P.eye[0], i)) throw new Error('the eye copy is not available on this device');
        for (let j = 0; j < n; j++) {
          const last = j === n - 1;
          if (last) rect.set(i * 0.5, 0, 0.5, 1);
          fx[j].effect.render(P.eye[j], last ? null : P.eye[j + 1], last ? rect : null);
        }
      }
    } catch (e) {
      P.failed = true; st.peFailed = true;
      warnOnce('pc-pe', 'could not run the post effects per eye — the canvas goes back to 2D', e);
      return false;
    }
    P.frames++;
    return true;
  }
  function copyEye(st, src, dst, i) {
    const dev = st.dev, w = dst.width, h = dst.height;
    if (typeof dev.initRenderTarget === 'function') dev.initRenderTarget(dst);
    if (dev.isWebGPU) {
      const enc = typeof dev.getCommandEncoder === 'function' ? dev.getCommandEncoder() : dev.commandEncoder;
      const s = src.colorBuffer.impl && src.colorBuffer.impl.gpuTexture, d = dst.colorBuffer.impl && dst.colorBuffer.impl.gpuTexture;
      if (!enc || !s || !d) return false;
      enc.copyTextureToTexture({ texture: s, origin: [i * w, 0, 0] }, { texture: d }, { width: w, height: h, depthOrArrayLayers: 1 });
      return true;
    }
    const gl = dev.gl, si = src.impl, di = dst.impl;
    const sfb = si && (si._glResolveFrameBuffer || si._glFrameBuffer), dfb = di && di._glFrameBuffer;
    if (!gl || !sfb || !dfb) return false;
    const pr = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING), pd = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, sfb);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dfb);
    dev.setScissor(0, 0, w, h); // a blit is scissored; through the device, whose cache then stays right
    gl.blitFramebuffer(i * w, 0, i * w + w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, pr);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, pd);
    return true;
  }
  function describePostEffects(st) {
    const P = st.pe;
    if (!P) return null;
    const src = P.queue.effects[0] && P.queue.effects[0].inputTarget;
    return { effects: P.queue.effects.map((e) => e.name || '?'), source: src ? [src.width, src.height] : null, samples: src ? src.samples : 0,
      eye: P.eye.map((rt) => [rt.width, rt.height]), frames: P.frames, mono: P.mono, hooked: P.cam.onPostprocessing === P.fn };
  }

  const isCameraFramePass = (p) => !!p && typeof p === 'object' && !!p.cameraFrame && !!p.composePass && !!p.sceneOptions &&
    typeof p.setupRenderPasses === 'function' && typeof p.update === 'function' && Array.isArray(p.beforePasses) && !!frameBase(p);
  const frameBases = new WeakMap();
  function frameBase(p) {
    const K = p && p.constructor;
    if (typeof K !== 'function') return null;
    if (frameBases.has(K)) return frameBases.get(K);
    let B = Object.getPrototypeOf(K);
    try { if (!(typeof B === 'function' && B.prototype && typeof B.prototype.render === 'function' && Array.isArray(new B(p.device).beforePasses))) B = null; } catch (e) { B = null; }
    frameBases.set(K, B);
    return B;
  }
  const HALTON = [[0.5, 0.333333], [0.25, 0.666667], [0.75, 0.111111], [0.125, 0.444444], [0.625, 0.777778], [0.375, 0.222222], [0.875, 0.555556], [0.0625, 0.888889],
    [0.5625, 0.037037], [0.3125, 0.37037], [0.8125, 0.703704], [0.1875, 0.148148], [0.6875, 0.481481], [0.4375, 0.814815], [0.9375, 0.259259], [0.03125, 0.592593]]; // renderer.js _haltonSequence

  function syncCameraFrame(st, want) {
    const C = st.cf;
    if (C && C.A === want && getFP(st.cam) === C.list) return;
    if (!C && !want) return;
    if (C) uninstallCameraFrame(st);
    if (want) {
      try { installCameraFrame(st, want); } catch (e) {
        warnOnce('pc-cf', 'could not split the CameraFrame per eye — standing down', e);
        uninstallCameraFrame(st);
        core.stand(st, 'CameraFrame could not be split per eye', { staged: true });
      }
    }
  }
  function installCameraFrame(st, A) {
    const cam = st.cam, sc = cam.camera, dev = st.dev, FP = frameBase(A);
    if (!st.eyeSrc) st.eyeSrc = { get width() { return st.R ? st.R.eyeW : realW(st.canvas) >> 1; }, get height() { return st.R ? st.R.eyeH : realH(st.canvas); } };
    const C = (st.cf = {
      A, B: null, list: null, n: 0, frames: 0, shared: false, seen: [null, null], steps: new Map(), stores: new Map(), clears: null, taaEye0: null, jit: [0, 0, 0, 0], prev: [null, null],
      vp: [{ x: 0, y: 0, z: 1, w: 1 }, { x: 0, y: 0, z: 1, w: 1 }],
      saved: { idx: dev.xrCurrentViewIndex, prev: sc._viewProjPrevious && sc._viewProjPrevious.clone(), inv: sc._viewProjInverse && sc._viewProjInverse.clone(), jit: Array.isArray(sc._jitters) ? sc._jitters.slice() : null },
    });
    const mark = (name, fn) => { const m = new FP(dev); m.name = name; m.execute = fn; return m; };
    C.mS = [0, 1].map((i) => mark(`DxrEye${i}Scene`, () => eyeScene(st, i)));
    C.mA = [0, 1].map((i) => mark(`DxrEye${i}After`, () => eyeAfter(st, i)));
    C.mEnd = mark('DxrEyeEnd', () => eyeEnd(st));
    C.shared = sharedEffects(A);
    hookPass(st, A, 0);
    if (!C.shared) {
      C.B = new A.constructor(st.app, A.cameraFrame, cam, A.options);
      hookPass(st, C.B, 1);
      syncB(st);
    }
    const proxy = (i) => {
      const p = new FP(dev);
      p.name = `DxrEye${i}`;
      p.executeEnabled = false;
      p.beforePasses = i ? (C.shared ? [C.mS[1], C.mEnd] : [C.mS[1], C.B, C.mEnd]) : [C.mS[0], A];
      p.frameUpdate = () => {
        if (st.cf !== C) return;
        if (C.shared) { if (i === 1) p.beforePasses = [C.mS[1], ...(C.A.internalBeforePasses || []), ...C.A.beforePasses, C.mEnd]; return; } // after A's frameUpdate: its current passes
        if (i === 0) { if (A.layersDirty) C.B.layersDirty = true; } else syncB(st);
      };
      p.destroy = () => { if (st.cf === C && i === 0) uninstallCameraFrame(st, true); }; // CameraFrame.disable(): the page destroys its pass
      return p;
    };
    C.list = [proxy(0), proxy(1)];
    setFP(cam, C.list);
    hookMiniStats(st);
    info('CameraFrame split per eye:', JSON.stringify(describeCameraFrame(st)));
  }
  function hookPass(st, P, i) {
    const own = Object.prototype.hasOwnProperty.call(P, 'setupRenderPasses');
    const orig = P.setupRenderPasses;
    P.setupRenderPasses = function (o) { const r = orig.call(this, o); if (st.cf && (st.cf.A === this || st.cf.B === this)) adoptPasses(st, this, i); return r; };
    P.__dxrSetup = own ? orig : null;
    if (i === 0) {
      const ownD = Object.prototype.hasOwnProperty.call(P, 'destroy'), d = P.destroy;
      P.destroy = function () { if (st.cf && st.cf.A === this) uninstallCameraFrame(st, true, true); return d.apply(this, arguments); };
      P.__dxrDestroy = ownD ? d : null;
    }
    adoptPasses(st, P, i);
  }
  function adoptPasses(st, P, i) {
    const C = st.cf;
    if (P.sceneOptions) P.sceneOptions.resizeSource = st.eyeSrc; // scenePass / prePass hold this object (<= 2.23)
    setResizeSource(P, st.eyeSrc); // 2.24 copies the options into each pass
    const cp = P.composePass;
    if (cp) {
      cp.viewport = C.vp[i]; cp.scissor = C.vp[i];
      cp.afterPasses = [C.mA[i]];
      if (i === 1) { cp.setClearColor(undefined); cp.setClearDepth(undefined); cp.setClearStencil(undefined); }
    }
    if (C.shared) return; // the camera-use flags are switched per eye by the markers
    for (const pass of P.beforePasses) {
      const steps = pass && pass.layerRenderSteps;
      if (steps) for (const s of steps) { if (i === 1) s.firstCameraUse = false; else s.lastCameraUse = false; }
    }
  }
  function unhookPass(st, P, cam) {
    if (P.__dxrSetup === undefined) return;
    if (P.__dxrSetup) P.setupRenderPasses = P.__dxrSetup; else delete P.setupRenderPasses;
    delete P.__dxrSetup;
    if (P.__dxrDestroy !== undefined) { if (P.__dxrDestroy) P.destroy = P.__dxrDestroy; else delete P.destroy; delete P.__dxrDestroy; }
    if (P.sceneOptions) P.sceneOptions.resizeSource = cam.renderTarget;
    setResizeSource(P, cam.renderTarget);
    const cp = P.composePass;
    if (cp) { cp.viewport = undefined; cp.scissor = undefined; cp.afterPasses = []; }
    if (typeof P.updateCameraUseFlags === 'function') P.updateCameraUseFlags();
  }
  function syncB(st) {
    const C = st.cf, cf = C.A.cameraFrame;
    if (!C.B) return;
    if (!cf || cf.renderPassCamera !== C.A || typeof cf.update !== 'function') return;
    cf.renderPassCamera = C.B;
    try { cf.update(); } finally { cf.renderPassCamera = C.A; }
  }
  function uninstallCameraFrame(st, pageDestroys, fromA) {
    const C = st.cf;
    if (!C) return;
    st.cf = null;
    const cam = st.cam || st.qualifyCam, sc = cam && cam.camera, dev = st.dev;
    try {
      const cur = cam && getFP(cam);
      if (cam && cur === C.list) setFP(cam, pageDestroys ? [] : [C.A]);
      else if (cam && pageDestroys && Array.isArray(cur) && cur.some((p) => C.list.includes(p))) setFP(cam, cur.filter((p) => !C.list.includes(p) && p !== C.A)); // 2.24 disable(): the page's filtered copy
    } catch (e) { /* ignore */ }
    try { unhookPass(st, C.A, cam); } catch (e) { /* ignore */ }
    if (C.B) { try { unhookPass(st, C.B, cam); C.B.destroy(); } catch (e) { warnOnce('pc-cf-b', 'eye 1 CameraFrame passes did not destroy cleanly', e); } }
    if (pageDestroys) { if (!fromA) { try { C.A.destroy(); } catch (e) { /* the page's own pass */ } } }
    else if (C.A.sceneDepthTexture && cam) {
      const sp = cam.shaderParams;
      sp.sceneDepthMapLinear = true; sp.sceneDepthMapPacked = false; sp.sceneDepthMapReciprocal = true;
    }
    if (C.shared) sharedEyeRestore(C);
    if (C.sbsDepth) { try { C.sbsDepth.tex.destroy(); } catch (e) { /* ignore */ } C.sbsDepth = null; }
    if (C.depthSrc) { for (const rt of C.depthSrc.values()) { try { rt.destroy(); } catch (e) { /* ignore */ } } C.depthSrc = null; }
    if (C.taaEye0) { try { C.taaEye0.rt.destroyTextureBuffers(); C.taaEye0.rt.destroy(); } catch (e) { /* ignore */ } C.taaEye0 = null; }
    try { dev.xrCurrentViewIndex = C.saved.idx; } catch (e) { /* ignore */ }
    if (sc) {
      try {
        if (C.saved.prev) sc._viewProjPrevious.copy(C.saved.prev);
        if (C.saved.inv) sc._viewProjInverse.copy(C.saved.inv);
        if (C.saved.jit) for (let k = 0; k < 4; k++) sc._jitters[k] = C.saved.jit[k];
      } catch (e) { /* ignore */ }
    }
    if (st.views && st.R) for (let k = 0; k < 2; k++) st.views[k].setViewport(k * st.R.eyeW, 0, st.R.eyeW, st.R.eyeH);
  }
  const statsHooked = new WeakSet();
  function hookMiniStats(st) {
    const app = st.app, scene = app && app.scene;
    if (!scene || typeof scene.on !== 'function' || statsHooked.has(app)) return;
    statsHooked.add(app);
    scene.on('prerender:layer', (camera, layer, transparent) => {
      const s = apps.get(app);
      if (!s || !s.cf || !s.active || !s.dev || s.dev.xrCurrentViewIndex !== 1 || !layer) return;
      const mis = layer.meshInstances;
      if (!Array.isArray(mis)) return;
      for (const mi of mis) if (isMiniStats(mi) && mi.transparent === transparent && mi.shaderPassMask === 0) mi.shaderPassMask = 0xffffffff;
    });
  }
  const isFogPass = (p) => !!p && typeof p.execute === 'function' && !!p.cameraComponent &&
    !!p.invViewId && !!p.projScaleId && !!p.cameraPosId && !!p.cameraFwdId;
  const fogWrapped = new WeakSet();
  function wrapFogPasses(st, root) {
    const seen = new Set(), stack = [root];
    while (stack.length) {
      const p = stack.pop();
      if (!p || typeof p !== 'object' || seen.has(p)) continue;
      seen.add(p);
      if (isFogPass(p) && !fogWrapped.has(p)) wrapFog(st, p);
      for (const k of ['beforePasses', 'internalBeforePasses', 'afterPasses']) if (Array.isArray(p[k])) stack.push(...p[k]);
    }
  }
  function wrapFog(st, pass) {
    fogWrapped.add(pass);
    const orig = pass.execute;
    pass.execute = function () {
      const cc = this.cameraComponent, eye = eyeCameraFor(st, cc);
      if (!eye) return orig.apply(this, arguments);
      this.cameraComponent = eye;
      if (st.cf) st.cf.fogRuns = (st.cf.fogRuns || 0) + 1;
      try { return orig.apply(this, arguments); } finally { this.cameraComponent = cc; }
    };
  }
  function eyeCameraFor(st, cc) {
    const C = st.cf, i = st.dev && st.dev.xrCurrentViewIndex;
    if (!C || !st.active || !st.views || !st.V || !st.haveViews || (i !== 0 && i !== 1) || !cc || !cc.camera || core.T.pcFogPerEye === false) return null;
    const v = st.views[i], P = st.V[i].proj, cam = cc.camera;
    if (!v || !P || !v.viewInvOffMat || !v.viewOffMat) return null;
    if (typeof cam.updateViewTransforms === 'function') { try { cam.updateViewTransforms(); } catch (e) { /* the engine updates them per frame anyway */ } }
    const E = (C.fogEye || (C.fogEye = [0, 1].map(() => ({ ws: new Float32Array(16), pos: { x: 0, y: 0, z: 0 }, fwd: { x: 0, y: 0, z: -1 }, proj: null, node: null, cam: null, cc: null, of: null }))))[i];
    const W = v.viewInvOffMat.data, ws = E.ws;
    const kx = -P[8] / P[0], ky = -P[9] / P[5];
    for (let k = 0; k < 16; k++) ws[k] = W[k];
    for (let r = 0; r < 3; r++) ws[8 + r] = W[8 + r] + kx * W[r] + ky * W[4 + r];
    E.pos.x = W[12]; E.pos.y = W[13]; E.pos.z = W[14];
    const fl = Math.hypot(W[8], W[9], W[10]) || 1;
    E.fwd.x = -W[8] / fl; E.fwd.y = -W[9] / fl; E.fwd.z = -W[10] / fl;
    if (!E.proj) { const M4 = v.projMat.constructor; E.proj = new M4(); }
    for (let k = 0; k < 16; k++) E.proj.data[k] = P[k]; // GL clip z: the passes read [0] / [5] and project light bounds with it
    if (!E.node) E.node = { getWorldTransform: () => ({ data: E.ws }), getPosition: () => E.pos, get forward() { return E.fwd; } };
    if (E.of !== cc) {
      const pass = (t, k) => { const val = Reflect.get(t, k, t); return typeof val === 'function' ? val.bind(t) : val; };
      E.cam = new Proxy(cam, { get: (t, k) => (k === '_node' ? E.node : k === 'projectionMatrix' ? E.proj : k === 'viewMatrix' ? st.views[i].viewOffMat : pass(t, k)) });
      E.cc = new Proxy(cc, { get: (t, k) => (k === 'camera' ? E.cam : pass(t, k)) });
      E.of = cc;
    }
    return E.cc;
  }
  function eyeScene(st, i) {
    const C = st.cf;
    if (!C || !st.views) return;
    const P = i && !C.shared ? C.B : C.A, sc = st.cam.camera, R = st.R;
    st.dev.xrCurrentViewIndex = i;
    if (i === 0 || !C.shared) wrapFogPasses(st, P);
    const rt = P.rt, w = rt ? rt.width : R.eyeW, h = rt ? rt.height : R.eyeH;
    for (const v of st.views) v.setViewport(0, 0, w, h);
    const vp = C.vp[C.shared ? 0 : i]; vp.x = i * R.eyeW; vp.y = 0; vp.z = R.eyeW; vp.w = R.eyeH;
    if (C.shared) sharedEye(st, C, i);
    if (taaOf(P) && sc._viewProjPrevious) {
      if (typeof sc.updateViewTransforms === 'function') sc.updateViewTransforms();
      const cur = st.views[i].projViewOffMat;
      const prev = C.prev[i] || (C.prev[i] = cur.clone());
      sc._viewProjPrevious.copy(prev);
      sc._viewProjInverse.invert(cur);
      prev.copy(cur);
      for (let k = 0; k < 4; k++) sc._jitters[k] = C.jit[k];
    }
  }
  function eyeAfter(st, i) {
    const R = st.R, C = st.cf;
    if (st.views && R) for (let k = 0; k < 2; k++) st.views[k].setViewport(k * R.eyeW, 0, R.eyeW, R.eyeH);
    if (!C) return;
    sbsSceneDepth(st, C, C.shared ? st.dev.xrCurrentViewIndex : i);
  }
  function eyeEnd(st) {
    const C = st.cf;
    if (!C) return;
    st.dev.xrCurrentViewIndex = C.saved.idx;
    if (C.shared) sharedEyeRestore(C);
    C.frames++;
  }
  function cameraFrameJitter(st) {
    const C = st.cf, A = C.A, j = C.jit, sc = st.cam.camera;
    j[2] = j[0]; j[3] = j[1];
    if (!taaOf(A) || !(sc.jitter > 0) || core.T.pcTaaJitter === false) { j[0] = j[1] = 0; return; }
    const o = HALTON[C.n++ % HALTON.length];
    const w = (A.rt && A.rt.width) || st.R.eyeW, h = (A.rt && A.rt.height) || st.R.eyeH;
    j[0] = (sc.jitter * (o[0] * 2 - 1)) / w; j[1] = (sc.jitter * (o[1] * 2 - 1)) / h;
    for (const v of st.views) { v.projMat.data[8] += j[0]; v.projMat.data[9] += j[1]; }
  }
  const fpKey = (o) => (o && 'framePasses' in o ? 'framePasses' : o && 'renderPasses' in o ? 'renderPasses' : null);
  function getFP(c) {
    const k = fpKey(c);
    if (k && c[k]) return c[k];
    const k2 = c && c.camera && fpKey(c.camera);
    return k2 ? c.camera[k2] : undefined;
  }
  function setFP(c, v) { const k = fpKey(c); if (k) c[k] = v; else if (c.camera && fpKey(c.camera)) c.camera[fpKey(c.camera)] = v; }
  const sharedEffects = (A) => {
    const fx = A && A.cameraFrame && A.cameraFrame.effects;
    return Array.isArray(fx) && fx.some((e) => e && typeof e.createPasses === 'function');
  };
  const taaOf = (P) => (P && (P.taaPass || (Array.isArray(P.beforePasses) && P.beforePasses.find((p) => p && Array.isArray(p.historyTextures) && Array.isArray(p.historyRenderTargets) && typeof p.update === 'function')))) || null;
  const hasEffect = (P, id) => !!(P && (P[`${id}Pass`] || (Array.isArray(P._passEffects) && P._passEffects.some((e) => e && e.id === id)) ||
    (P.cameraFrame && Array.isArray(P.cameraFrame._activeEffects) && P.cameraFrame._activeEffects.some((e) => e && e.id === id))));
  function setResizeSource(P, src) {
    for (const pass of [P.scenePass, P.prePass, P.scenePassTransparent]) {
      const o = pass && pass.options;
      if (o && typeof o === 'object' && 'resizeSource' in o && o !== P.sceneOptions) o.resizeSource = src;
    }
  }
  function sharedEye(st, C, i) {
    const A = C.A, cp = A.composePass;
    for (const pass of A.beforePasses) {
      const steps = pass && pass.layerRenderSteps;
      if (!steps) continue;
      for (const s of steps) {
        let o = C.steps.get(s);
        if (!o) C.steps.set(s, (o = { f: s.firstCameraUse, l: s.lastCameraUse }));
        s.firstCameraUse = i ? false : o.f; s.lastCameraUse = i ? o.l : false;
      }
    }
    if (cp && cp.colorArrayOps) {
      const c0 = cp.colorArrayOps[0], ds = cp.depthStencilOps;
      if (!C.clears || C.clears.cp !== cp) C.clears = { cp, c: c0 ? c0.clear : false, d: ds ? ds.clearDepth : false, s: ds ? ds.clearStencil : false };
      if (c0) c0.clear = i ? false : C.clears.c;
      if (ds) { ds.clearDepth = i ? false : C.clears.d; ds.clearStencil = i ? false : C.clears.s; }
      C.seen[i] = { vp: { ...C.vp[0] }, clears: !!(c0 && c0.clear) };
    }
    for (const p of core.T.pcEyeStore === false ? [] : [cp, A.afterPass]) { // false: TEST ONLY (A/B)
      const c0 = p && p.colorArrayOps && p.colorArrayOps[0], ds = p && p.depthStencilOps;
      if (!c0) continue;
      let o = C.stores.get(p);
      if (!o) C.stores.set(p, (o = { s: c0.store, d: ds ? ds.storeDepth : false }));
      c0.store = i ? o.s : true;
      if (ds) ds.storeDepth = i ? o.d : true;
    }
    const taa = taaOf(A);
    if (!taa || core.T.pcTaaEyeHistory === false) return;
    const k = taa.historyIndex, out = taa.historyRenderTargets[k], H = C.taaEye0 || (C.taaEye0 = taaHistory(st, taa));
    if (!H || !out) return;
    if (i === 0) {
      if (H.tex.width !== out.width || H.tex.height !== out.height) H.rt.resize(out.width, out.height);
      H.slot = 1 - k; H.saved = taa.historyTextures[H.slot]; taa.historyTextures[H.slot] = H.tex;
    } else if (H.saved) {
      taa.historyTextures[H.slot] = H.saved; H.saved = null;
      try { st.dev.copyRenderTarget(out, H.rt, true, false); } catch (e) { warnOnce('pc-taa-copy', 'could not keep eye 0\'s TAA history', e); }
    }
  }
  function taaHistory(st, taa) {
    try {
      const t0 = taa.historyTextures[0], r0 = taa.historyRenderTargets[0];
      const tex = new t0.constructor(st.dev, { name: 'DxrTaaHistoryEye0', width: t0.width, height: t0.height, format: t0.format, mipmaps: false,
        minFilter: t0.minFilter, magFilter: t0.magFilter, addressU: t0.addressU, addressV: t0.addressV });
      return { tex, rt: new r0.constructor({ colorBuffer: tex, depth: false }), slot: 0, saved: null };
    } catch (e) { warnOnce('pc-taa-eye', 'no eye-0 TAA history: eye 0 reads eye 1\'s', e); return null; }
  }
  function sharedEyeRestore(C) {
    for (const [s, o] of C.steps) { s.firstCameraUse = o.f; s.lastCameraUse = o.l; }
    C.steps.clear();
    const K = C.clears;
    if (K && K.cp.colorArrayOps) {
      if (K.cp.colorArrayOps[0]) K.cp.colorArrayOps[0].clear = K.c;
      if (K.cp.depthStencilOps) { K.cp.depthStencilOps.clearDepth = K.d; K.cp.depthStencilOps.clearStencil = K.s; }
    }
    C.clears = null;
    for (const [p, o] of C.stores) {
      const c0 = p.colorArrayOps && p.colorArrayOps[0];
      if (c0) c0.store = o.s;
      if (p.depthStencilOps) p.depthStencilOps.storeDepth = o.d;
    }
    C.stores.clear();
    const H = C.taaEye0, taa = H && H.saved && taaOf(C.A);
    if (taa) { taa.historyTextures[H.slot] = H.saved; H.saved = null; }
  }
  function sbsSceneDepth(st, C, i) {
    if (core.T.pcSbsDepth === false || (i !== 0 && i !== 1)) return; // false: TEST ONLY (A/B)
    const P = i && !C.shared ? C.B : C.A, tex = P && P.sceneDepthTexture, dev = st.dev;
    if (!tex || !dev.scope) return;
    const id = dev.scope.resolve('uSceneDepthMap');
    if (id.value !== tex) return; // not what the engine published for this eye
    const w = tex.width, h = tex.height;
    let D = C.sbsDepth;
    try {
      if (!D || D.tex.format !== tex.format) {
        if (D) D.tex.destroy();
        D = C.sbsDepth = { tex: new tex.constructor(dev, { name: 'DxrSceneDepthSbs', width: 2 * w, height: h, format: tex.format, mipmaps: false,
          minFilter: tex.minFilter, magFilter: tex.magFilter, addressU: tex.addressU, addressV: tex.addressV }) };
      } else if (D.tex.width !== 2 * w || D.tex.height !== h) D.tex.resize(2 * w, h);
      if (!copyIntoHalf(st, C, tex, D.tex, i * w)) return;
    } catch (e) { warnOnce('pc-sbs-depth', 'could not lay the scene depth side by side (after-pass depth reads stay per-eye-sized)', e); return; }
    id.setValue(D.tex);
    C.sbsDepthRuns = (C.sbsDepthRuns || 0) + 1;
  }
  function copyIntoHalf(st, C, tex, dst, x) {
    const dev = st.dev;
    if (dev.isWebGPU) {
      const enc = typeof dev.getCommandEncoder === 'function' ? dev.getCommandEncoder() : dev.commandEncoder;
      const s = tex.impl && tex.impl.gpuTexture, d = dst.impl && dst.impl.gpuTexture;
      if (!enc || !s || !d) return false;
      enc.copyTextureToTexture({ texture: s }, { texture: d, origin: [x, 0, 0] }, { width: tex.width, height: tex.height, depthOrArrayLayers: 1 });
      return true;
    }
    if (typeof dev.copyTextureToTexture !== 'function') return false;
    const src = C.depthSrc || (C.depthSrc = new Map());
    let rt = src.get(tex);
    if (!rt) {
      const K = (C.A.rt && C.A.rt.constructor) || null;
      if (!K) return false;
      for (const [t, r] of src) { if (t !== C.A.sceneDepthTexture && !(C.B && t === C.B.sceneDepthTexture)) { try { r.destroy(); } catch (e) { /* ignore */ } src.delete(t); } }
      src.set(tex, (rt = new K({ name: 'DxrSceneDepthSrc', colorBuffer: tex, depth: false })));
    }
    return dev.copyTextureToTexture(tex, dst, { destX: x, destY: 0, sourceRenderTarget: rt }) !== false;
  }
  function describeCameraFrame(st) {
    const C = st.cf;
    if (!C) return null;
    const one = (P) => P && {
      target: P.rt ? [P.rt.width, P.rt.height] : null, taa: !!taaOf(P), bloom: hasEffect(P, 'bloom'), ssao: hasEffect(P, 'ssao'), dof: hasEffect(P, 'dof'),
      prepass: !!P.prePass, sceneDepth: !!P.sceneDepthTexture,
      compose: P.composePass ? { vp: P.composePass.viewport ? { ...P.composePass.viewport } : null, clears: !!(P.composePass.colorArrayOps && P.composePass.colorArrayOps[0] && P.composePass.colorArrayOps[0].clear) } : null,
    };
    const eye = (i) => { const o = one(C.A); if (o && o.compose && C.seen[i]) o.compose = { ...C.seen[i] }; return o; };
    return { mode: C.shared ? 'shared' : 'pair', eyes: C.shared ? [eye(0), eye(1)] : [one(C.A), one(C.B)], frames: C.frames, jitter: C.jit.slice(0, 2), fogPerEye: C.fogRuns || 0, sbsDepth: C.sbsDepthRuns || 0 };
  }

  function trapCanvasSize(st) {
    if (st.trapped || core.T.pcCanvasTrap === false) return;
    const c = st.canvas;
    const def = (prop, D, isW) => Object.defineProperty(c, prop, {
      configurable: true, enumerable: true,
      get() { return D.get.call(this); },
      set(v) {
        if (!st.active || st.depth > 0) { D.set.call(this, v); return; }
        const n = Math.max(0, Math.floor(+v || 0));
        if (isW) st.L.w = n; else st.L.h = n;
        st.pageSizeWrites = (st.pageSizeWrites || 0) + 1;
        warnOnce('pc-rawsize', 'the page writes canvas.width / height itself (not device.setResolution): kept the side-by-side store, recorded as the page\'s size');
        if (applyRealSize(st)) st.app.renderNextFrame = true;
      },
    });
    def('width', core.CANVAS_W, true);
    def('height', core.CANVAS_H, false);
    st.trapped = true;
  }
  function untrapCanvasSize(st) {
    if (!st.trapped) return;
    st.trapped = false;
    try { delete st.canvas.width; delete st.canvas.height; } catch (e) { /* ignore */ }
  }

  const shadowOrig = new WeakMap(); // light component -> { orig, wrote }
  function offsetShadows(st) {
    if (core.T.pcShadowOffset === false) return;
    const d = st.haveViews ? Math.max(0, (st.V[0].pose[14] + st.V[1].pose[14]) / 2) * (st.eyeK > 0 ? st.eyeK : 1) + (st.piv ? Math.hypot(st.piv.t[0], st.piv.t[1], st.piv.t[2]) : 0) : 0;
    if (!st.shadowLights || ++st.shadowScan >= 30) {
      st.shadowScan = 0;
      try { st.shadowLights = st.app.root.findComponents('light'); } catch (e) { st.shadowLights = []; }
      if (!st.shadowTouched) st.shadowTouched = new Set();
    }
    for (const lc of st.shadowLights) {
      if (!lc || !lc.castShadows) continue;
      let rec = shadowOrig.get(lc);
      const cur = lc.shadowDistance;
      if (!rec) {
        if (!(d > 0.01)) continue; // nothing to offset: leave the light untouched
        shadowOrig.set(lc, (rec = { orig: cur, wrote: NaN }));
        st.shadowTouched.add(lc);
      } else if (cur !== rec.wrote) rec.orig = cur; // the page set its own value since our last write
      const want = rec.orig + d;
      if (Math.abs(want - cur) > 0.01) { lc.shadowDistance = want; rec.wrote = lc.shadowDistance; }
    }
  }
  function restoreShadows(st) {
    if (!st.shadowTouched) return;
    for (const lc of st.shadowTouched) {
      const rec = shadowOrig.get(lc);
      if (!rec) continue;
      try { if (lc.shadowDistance === rec.wrote || rec.wrote !== rec.wrote) lc.shadowDistance = rec.orig; } catch (e) { /* ignore */ }
      shadowOrig.delete(lc);
    }
    st.shadowTouched = null; st.shadowLights = null;
  }

  function layersMeet(a, b) {
    if (!a || !b) return true;
    for (let i = 0; i < a.length; i++) if (b.indexOf(a[i]) >= 0) return true;
    return false;
  }
  function forEachBounds(st, cb) {
    const root = st.app.root, camLayers = st.cam.layers;
    let more = true;
    const meshes = (comp) => {
      if (!more || !comp || !comp.enabled || !comp.entity || !comp.entity.enabled || !layersMeet(comp.layers, camLayers)) return;
      const mis = comp.meshInstances || [];
      for (const mi of mis) {
        if (!more) return;
        if (!mi || mi.visible === false) continue;
        const bb = mi.aabb;
        if (!bb) continue;
        const r = Math.hypot(bb.halfExtents.x, bb.halfExtents.y, bb.halfExtents.z);
        if (!(r >= 0) || !isFinite(r)) continue;
        more = cb(bb.center.x, bb.center.y, bb.center.z, r) !== false;
      }
    };
    for (const c of root.findComponents('render')) meshes(c);
    for (const c of root.findComponents('model')) meshes(c);
    for (const g of root.findComponents('gsplat')) {
      if (!more) break;
      if (!g.enabled || !g.entity.enabled || !layersMeet(g.layers, camLayers)) continue;
      const bb = g.customAabb;
      if (!bb) continue;
      const m = g.entity.getWorldTransform().data, c = bb.center;
      const wx = m[0] * c.x + m[4] * c.y + m[8] * c.z + m[12];
      const wy = m[1] * c.x + m[5] * c.y + m[9] * c.z + m[13];
      const wz = m[2] * c.x + m[6] * c.y + m[10] * c.z + m[14];
      const s = Math.sqrt(Math.max(m[0] * m[0] + m[1] * m[1] + m[2] * m[2], m[4] * m[4] + m[5] * m[5] + m[6] * m[6], m[8] * m[8] + m[9] * m[9] + m[10] * m[10]));
      const r = Math.hypot(bb.halfExtents.x, bb.halfExtents.y, bb.halfExtents.z) * s;
      if (!(r >= 0) || !isFinite(r)) continue;
      more = cb(wx, wy, wz, r, false, true) !== false; // a splat volume: holding the camera, it is a world (core estimateSubjectDistance)
    }
  }

  const CORE_POINTS = 12000, CORE_TRIS = 24000, CORE_CHECK_MS = 500;
  const coreCache = new WeakMap(); // state -> { at, key, set }
  function splatCentres(g) {
    const cands = [g.resource, g._resource, g.instance && g.instance.resource, g.instance && g.instance.splat, g._placement && g._placement.resource, g._assetReference && g._assetReference.asset && g._assetReference.asset.resource, g.asset && st0AssetResource(g)];
    for (const r of cands) {
      if (!r) continue;
      let c = null;
      try { c = r.centers || r._centers || (r.gsplatData && (r.gsplatData._centers || (typeof r.gsplatData.getCenters === 'function' ? r.gsplatData.getCenters() : null))); } catch (e) { c = null; }
      if (c && c.length >= 48) return c;
    }
    return null;
  }
  function st0AssetResource(g) {
    try { const a = typeof g.asset === 'object' ? g.asset : null; return a && a.resource ? a.resource : null; } catch (e) { return null; }
  }
  function coreSet(st, s, ref) {
    const now = performance.now(), C = coreCache.get(st);
    if (C && now - C.at < CORE_CHECK_MS) return C.set;
    const root = st.app.root, camLayers = st.cam.layers;
    const F = (ref && ref.F) || core.stageFrame(s, ref && ref.d > 0 ? ref.d : 0);
    const found = [];
    let key = '', skipped = 0, other = 0;
    const meshes = (comp) => {
      if (!comp || !comp.enabled || !comp.entity || !comp.entity.enabled || !layersMeet(comp.layers, camLayers)) return;
      for (const mi of comp.meshInstances || []) {
        if (!mi || mi.visible === false || !mi.mesh || !mi.node) continue;
        const bb = mi.aabb;
        if (!bb) continue;
        const h = bb.halfExtents, r = Math.hypot(h.x, h.y, h.z);
        if (!(r > 0) || !isFinite(r)) continue;
        const sg = core.isStage(bb.center.x, bb.center.y, bb.center.z, r, h.x, h.y, h.z, F);
        if (sg) { skipped++; if (sg === 2 || sg === 4) other++; continue; }
        found.push({ mi });
        key += `${mi.mesh.id}:${mi.node._guid || ''};`;
      }
    };
    for (const c of root.findComponents('render')) meshes(c);
    for (const c of root.findComponents('model')) meshes(c);
    for (const g of root.findComponents('gsplat')) {
      if (!g.enabled || !g.entity.enabled || !layersMeet(g.layers, camLayers)) continue;
      const ctr = splatCentres(g);
      let bb = g.customAabb || (g.instance && g.instance.resource && g.instance.resource.aabb) || (g.resource && g.resource.aabb) || null;
      if (!bb) continue;
      const m = g.entity.getWorldTransform().data, c = bb.center;
      const sc = Math.sqrt(Math.max(m[0] * m[0] + m[1] * m[1] + m[2] * m[2], m[4] * m[4] + m[5] * m[5] + m[6] * m[6], m[8] * m[8] + m[9] * m[9] + m[10] * m[10]));
      const wx = m[0] * c.x + m[4] * c.y + m[8] * c.z + m[12], wy = m[1] * c.x + m[5] * c.y + m[9] * c.z + m[13], wz = m[2] * c.x + m[6] * c.y + m[10] * c.z + m[14];
      if (Math.hypot(wx - F.px, wy - F.py, wz - F.pz) <= Math.hypot(bb.halfExtents.x, bb.halfExtents.y, bb.halfExtents.z) * sc) { skipped++; continue; } // a splat world: no core
      found.push({ g, ctr, m, bb });
      key += `g${g.entity._guid || ''}:${ctr ? ctr.length : 'box'};`;
    }
    if (C && C.key === key) { C.at = now; return C.set; }
    const t0 = performance.now(), cands = [];
    let boxed = 0;
    for (const e of found) {
      if (e.g && e.ctr) { cands.push({ m: e.m, pts: e.ctr, k: Math.floor(e.ctr.length / 3), stride: 3 }); continue; }
      if (e.g) {
        const c = e.bb.center, h = e.bb.halfExtents;
        boxed++;
        cands.push({ m: e.m, min: [c.x - h.x, c.y - h.y, c.z - h.z], max: [c.x + h.x, c.y + h.y, c.z + h.z] });
        continue;
      }
      const mi = e.mi, mesh = mi.mesh, m = mi.node.getWorldTransform().data;
      let P = null, I = null;
      if (!mi.skinInstance) {
        try {
          const pa = [];
          if (mesh.getPositions(pa) >= 3 && pa.length >= 9) {
            P = pa;
            const prim = mesh.primitive && mesh.primitive[0];
            if (prim && prim.indexed) { const ia = []; if (mesh.getIndices(ia) >= 3) I = prim.base || prim.count < ia.length ? ia.slice(prim.base || 0, (prim.base || 0) + prim.count) : ia; }
          }
        } catch (err) { P = null; }
      }
      if (!P) {
        const lb = mesh.aabb;
        if (!lb) continue;
        boxed++;
        cands.push({ m, min: [lb.center.x - lb.halfExtents.x, lb.center.y - lb.halfExtents.y, lb.center.z - lb.halfExtents.z], max: [lb.center.x + lb.halfExtents.x, lb.center.y + lb.halfExtents.y, lb.center.z + lb.halfExtents.z] });
        continue;
      }
      cands.push({ m, P, I });
    }
    const parts = core.sampleSurface(cands, CORE_POINTS, CORE_TRIS);
    const set = parts.length ? { parts, other, note: `${found.length} part(s) read${boxed ? `, ${boxed} by bounding box` : ''}, ${skipped} left out as stage (${other} of them other geometry); ${(performance.now() - t0).toFixed(1)} ms` } : null;
    coreCache.set(st, { at: now, key, set });
    return set;
  }

  function mul4(a, b, o) {
    for (let c = 0; c < 4; c++) {
      const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
      o[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
      o[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
      o[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
      o[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
    }
    return o;
  }
  function perspective(vfov, aspect, n, f, o) {
    const t = 1 / Math.tan(vfov / 2);
    o.fill(0);
    o[0] = t / aspect; o[5] = t; o[10] = -(f + n) / (f - n); o[11] = -1; o[14] = (-2 * f * n) / (f - n);
    return o;
  }
  function frustumFromProjection(P) {
    return {
      fov: (2 * Math.atan(1 / P[5])) / DEG,
      aspectRatio: P[5] / P[0],
      nearClip: P[14] / (P[10] - 1),
      farClip: Math.abs(P[10] + 1) < 1e-9 ? 1e4 : P[14] / (P[10] + 1),
    };
  }
  const nativeFootprint = (src) => /\bJ1\.y\b/.test(src) && !/dxrFocalY/.test(src);
  function patchGsplatFootprint(src) {
    if (typeof src !== 'string') return { src, ok: false };
    if (src.includes('dxrFocalY')) return { src, ok: true };
    const r1 = /vec2\s+J2\s*=\s*-J1\s*\/\s*vp\.z\s*\*\s*vp\.xy\s*;/;
    const r2 = /0\.0\s*,\s*J1\s*,\s*J2\.y\s*,/;
    if (!r1.test(src) || !r2.test(src)) return { src, ok: false };
    return {
      src: src
        .replace(r1, 'float J1y = (viewport_size.y * matrix_projection[1][1]) / vp.z; /* dxrFocalY */ ' +
          'vec2 J2 = vec2(-J1 / vp.z * vp.x, -J1y / vp.z * vp.y);')
        .replace(r2, '0.0, J1y, J2.y,'),
      ok: true,
    };
  }

  function patchGsplatFootprintWgsl(src) {
    if (typeof src !== 'string') return { src, ok: false };
    if (src.includes('dxrFocalY')) return { src, ok: true };
    let out = src, ok = false;
    const c1 = /let\s+J2\s*=\s*-J1\s*\/\s*vz\s*\*\s*v\.xy\s*;/, c2 = /let\s+tt1\s*=\s*J1\s*\*\s*w1\s*\+\s*J2\.y\s*\*\s*w2\s*;/;
    if (c1.test(out) && c2.test(out) && /\bviewProj\b/.test(out) && /\bviewportHeight\b/.test(out) && /\blet\s+w1\b/.test(out)) {
      out = out
        .replace(c1, 'let J1y = (viewportHeight * abs((viewProj * vec4f(w1, 0.0)).y)) / vz; /* dxrFocalY */ let J2 = vec2f(-J1 / vz * v.x, -J1y / vz * v.y);')
        .replace(c2, 'let tt1 = J1y * w1 + J2.y * w2;');
      ok = true;
    }
    const r1 = /let\s+J2\s*=\s*-J1\s*\/\s*vp\.z\s*\*\s*vp\.xy\s*;/, r2 = /vec3f\(\s*0\.0\s*,\s*J1\s*,\s*J2\.y\s*\)/;
    const f = /let\s+focal\s*=\s*([A-Za-z_]\w*)\.viewport_size\.x\s*\*\s*center\.projMat00/.exec(out);
    const ub = f && f[1];
    if (ub && r1.test(out) && r2.test(out) && out.includes(`${ub}.matrix_projection`)) {
      out = out
        .replace(r1, `let J1y = (${ub}.viewport_size.y * abs(${ub}.matrix_projection[1][1])) / vp.z; /* dxrFocalY */ let J2 = vec2f(-J1 / vp.z * vp.x, -J1y / vp.z * vp.y);`)
        .replace(r2, 'vec3f(0.0, J1y, J2.y)');
      ok = true;
    }
    return { src: out, ok };
  }

  info(`PlayCanvas adapter armed (core v${core.VERSION})`);
  return { consider };
}
function dxrBabylon(core) {
  core.registerEngine('Babylon.js');
  const { info, warnOnce, desc, realW, realH } = core;
  const RIG_MODE_CUSTOM = 22; // Camera.RIG_MODE_CUSTOM: the scene renders the rig cameras, no rig maths of its own
  const RECENT_MS = 250;      // a scene "renders to the canvas" when it rendered this recently

  const engines = new WeakMap(); // engine -> state; null before it has a canvas; false when not convertible
  const via = new WeakMap();     // engine -> how it was found
  const sceneAt = new WeakMap(); // scene -> its last render (performance.now())
  const hookedScenes = new WeakSet();
  let bjsNS = null;              // window.BABYLON, when the page has it (UMD)
  core.meta.babylon = { detected: [] };

  const isEngine = (e) =>
    !!e && typeof e === 'object' && typeof e.runRenderLoop === 'function' && Array.isArray(e.scenes) &&
    typeof e.getRenderWidth === 'function' && !!e.onNewSceneAddedObservable;

  function consider(engine, how, ns) {
    if (core.retired) return;
    if (!bjsNS && ns && typeof ns === 'object' && ns.Engine) bjsNS = ns;
    if (!isEngine(engine) || engines.has(engine)) return;
    engines.set(engine, null);
    via.set(engine, how);
    core.meta.babylon.detected.push(how);
    info('Babylon.js engine found via', how);
    try {
      for (const s of engine.scenes) hookScene(engine, s);
      engine.onNewSceneAddedObservable.add((s) => hookScene(engine, s));
      if (engine.onDisposeObservable) engine.onDisposeObservable.add(() => { const st = engines.get(engine); if (st && (st.active || st.pending || st.armed)) core.stand(st, 'the page disposed the engine'); });
    } catch (e) { warnOnce('bjs-hook', 'could not watch the Babylon.js engine — left 2D', e); }
  }
  function hookScene(engine, scene) {
    if (!scene || hookedScenes.has(scene) || !scene.onBeforeRenderObservable || !scene.onAfterRenderObservable) return;
    hookedScenes.add(scene);
    scene.onBeforeRenderObservable.add(() => onBeforeRender(engine, scene));
    scene.onAfterRenderObservable.add(() => onAfterRender(engine, scene));
    if (scene.onActiveCameraChanged) scene.onActiveCameraChanged.add(() => onCameraChanged(engine, scene));
    if (scene.onBeforeCameraRenderObservable) scene.onBeforeCameraRenderObservable.add((cam) => onBeforeCamera(engine, scene, cam));
    if (scene.onAfterCameraRenderObservable) scene.onAfterCameraRenderObservable.add((cam) => { if (cam && cam.__dxrVp && cam.viewport !== cam.__dxrVp) cam.viewport = cam.__dxrVp; });
    const pm = scene.postProcessManager;
    if (pm && typeof pm._finalizeFrame === 'function' && !Object.prototype.hasOwnProperty.call(pm, '_finalizeFrame')) {
      const fin = pm._finalizeFrame;
      pm._finalizeFrame = function (doNotPresent, targetTexture) {
        const cam = scene.activeCamera;
        if (!targetTexture && cam && cam.__dxrVp && cam.viewport !== cam.__dxrVp) { try { engine.setViewport(cam.__dxrVp); } catch (e) { /* ignore */ } }
        return fin.apply(this, arguments);
      };
    }
    if (scene.onDisposeObservable) {
      scene.onDisposeObservable.add(() => {
        const st = engines.get(engine);
        if (st && st.scene === scene && (st.active || st.pending || st.armed)) core.stand(st, 'the page disposed the scene');
        if (st && st.lastScene === scene) st.lastScene = null;
      });
    }
    hookCameras(scene);
  }

  const setTargets = new WeakMap(); // camera -> { x, y, z }
  const hookedProtos = new WeakSet();
  function hookSetTarget(cam) {
    let p = cam && Object.getPrototypeOf(cam);
    while (p && !Object.prototype.hasOwnProperty.call(p, 'setTarget')) p = Object.getPrototypeOf(p);
    if (!p || hookedProtos.has(p) || typeof p.setTarget !== 'function') return;
    hookedProtos.add(p);
    const orig = p.setTarget;
    try {
      p.setTarget = function (t) {
        if (t && isFinite(t.x) && isFinite(t.y) && isFinite(t.z)) setTargets.set(this, { x: t.x, y: t.y, z: t.z });
        return orig.apply(this, arguments);
      };
    } catch (e) { warnOnce('bjs-settarget', 'could not watch camera.setTarget — convergence falls back to the estimator', e); }
  }
  function hookCameras(scene) {
    for (const c of scene.cameras || []) hookSetTarget(c);
    if (typeof scene.addCamera !== 'function' || Object.prototype.hasOwnProperty.call(scene, 'addCamera')) return;
    const add = scene.addCamera;
    try {
      scene.addCamera = function (c) { hookSetTarget(c); return add.apply(this, arguments); };
    } catch (e) { /* setup-time setTarget calls are missed: the estimator stands in */ }
  }

  function stateFor(engine) {
    let st = engines.get(engine);
    if (st) return st;
    if (st === false || st === undefined) return null;
    const canvas = typeof engine.getRenderingCanvas === 'function' ? engine.getRenderingCanvas() : null;
    if (!canvas) return null; // still in the constructor
    if (!(canvas instanceof HTMLCanvasElement)) { warnOnce('bjs-offscreen', 'Babylon.js on an OffscreenCanvas — not supported, left 2D'); engines.set(engine, false); return null; }
    st = core.newState('Babylon.js', canvas, ad);
    Object.assign(st, {
      eng: engine, scene: null, lastScene: null, cam: null, rigOn: null, eyes: null, qualify: null,
      L: { w: realW(canvas), h: realH(canvas), pr: 1 }, // what the PAGE believes: its own store, in pixels
      frame: { drew: false, idle: 0, n: 0 }, replaying: false, vp: null, gbufEyes: 0, rtEyes: 0, rtProbes: new Map(), rtFrame: 0, rtFixed: 0, rtUnlatched: 0, scale: 0, hw0: 1, follows: false, pxGui: false,
      tmp: { mrh: new Float64Array(16), e: new Float64Array(16), p: new Float64Array(16) },
    });
    engines.set(engine, st);
    info(`Babylon.js engine on ${desc(canvas)} (${engine.isWebGPU ? 'WebGPU' : 'WebGL' + (engine.webGLVersion || '')}, found via ${via.get(engine)})`);
    return st;
  }

  function sceneOf(st) {
    const t = core.now() - RECENT_MS;
    const live = st.eng.scenes.filter((s) => s && !s.isDisposed && hookedScenes.has(s) && (sceneAt.get(s) || 0) > t);
    if (!live.length) return { why: 'no scene has rendered yet' };
    if (live.length > 1) return { why: `${live.length} scenes render to the canvas — not split in this prototype`, flat: true };
    return { scene: live[0] };
  }
  function pickCamera(st, scene) {
    const ac = scene.activeCameras;
    if (ac && ac.length > 1) return { why: `${ac.length} active cameras render the scene (split screen / UI camera) — not split in this prototype`, flat: true };
    const cam = (ac && ac.length === 1 ? ac[0] : null) || scene.activeCamera;
    if (!cam) return { why: 'the scene has no active camera' };
    if (cam.mode === 1) return { why: 'the camera is orthographic', flat: true };
    if (cam.cameraRigMode !== 0 && cam !== st.rigOn) return { why: 'the camera has its own rig (a stereoscopic / VR camera)', flat: true };
    if (cam.outputRenderTarget) return { why: 'the camera renders into a texture', flat: true };
    const vp = vpOf(cam);
    if (!(vp.w > 0 && vp.h > 0) || vp.x < -1e-6 || vp.y < -1e-6 || vp.x + vp.w > 1 + 1e-6 || vp.y + vp.h > 1 + 1e-6) return { why: `the camera viewport lies outside the canvas (${vp.x}, ${vp.y}, ${vp.w} x ${vp.h})`, flat: true };
    if (scene.customRenderFunction) return { why: 'scene.customRenderFunction — the page renders the scene itself', flat: true };
    const fx = sceneFxWhy(scene) || postFxWhy(cam);
    if (fx) return { why: fx, flat: true };
    if (!cameraBase(cam)) return { why: 'no Babylon Camera class reachable from the page camera', flat: true };
    return { cam };
  }
  function sceneFxWhy(scene) {
    if (scene.prePassRenderer && scene.prePassRenderer.enabled) return 'the prepass renderer is on (SSAO2 / SSR / motion blur / subsurface) — not split per eye';
    if (scene._geometryBufferRenderer && core.T.bjsGBuffer === false) return 'a geometry buffer renderer is on (SSAO / SSR / GI / IBL shadows) — not split per eye (bjsGBuffer off)';
    const dr = scene._depthRenderer;
    if (dr && typeof dr === 'object' && Object.keys(dr).length) return 'a depth renderer is on (depth of field / SSAO / a depth effect) — not split per eye';
    return null;
  }
  const TEMPORAL_CLASS = /^(MotionBlur|ScreenSpaceReflection|SSR|TAA)/, TEMPORAL_NAME = /^(TAA|SSR|MotionBlur)/i;
  function postFxWhy(cam) {
    const pps = (cam._postProcesses || []).filter(Boolean);
    if (!pps.length) return null;
    if (core.T.bjsPostFx === false) return `${pps.length} post-process(es) on the camera — left unsplit (bjsPostFx off)`; // TEST ONLY (A/B)
    for (const pp of pps) {
      let n = '';
      try { n = typeof pp.getClassName === 'function' ? pp.getClassName() : ''; } catch (e) { n = ''; }
      if (TEMPORAL_CLASS.test(n) || TEMPORAL_NAME.test(pp.name || '')) return `a temporal post-process on the camera (${n || pp.name}) — one history for both eyes, not split`;
    }
    return null;
  }
  const bases = new WeakMap();
  function cameraBase(cam) {
    const K = cam && cam.constructor;
    if (K && bases.has(K)) return bases.get(K);
    let found = null;
    for (let p = Object.getPrototypeOf(cam); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
      if (!Object.prototype.hasOwnProperty.call(p, 'getClassName')) continue;
      let n = null;
      try { n = p.getClassName.call(cam); } catch (e) { n = null; }
      if (n === 'Camera' && typeof p.constructor === 'function') { found = p.constructor; break; }
    }
    if (K) bases.set(K, found);
    return found;
  }
  function vpOf(cam) {
    const v = cam && cam.viewport;
    return v ? { x: +v.x || 0, y: +v.y || 0, w: v.width === undefined ? 1 : +v.width, h: v.height === undefined ? 1 : +v.height } : { x: 0, y: 0, w: 1, h: 1 };
  }
  function subAspect(st) { const v = vpOf(st.cam); return (st.L.w * v.w) / ((st.L.h * v.h) || 1); }
  function vfovOf(st) {
    const c = st.cam;
    return c.fovMode === 1 ? 2 * Math.atan(Math.tan(c.fov / 2) / subAspect(st)) : c.fov; // FOVMODE_HORIZONTAL_FIXED
  }
  function rigFovOf(st) {
    const h = vpOf(st.cam).h || 1;
    return h === 1 ? vfovOf(st) : 2 * Math.atan(Math.tan(vfovOf(st) / 2) / h);
  }
  function rangeOf(st) {
    const c = st.cam;
    const near = c.minZ > 0 ? c.minZ : 0.1;
    const far = c.maxZ > 0 && !c.ignoreCameraMaxZ ? c.maxZ : 1e4; // 0 = an infinite far plane
    return { near, far: Math.max(far, near * 2) };
  }

  const ad = {
    label: (st) => `Babylon.js ${engineVersion(st)}, ${via.get(st.eng)}`,
    unqualified(st) {
      const eng = st.eng;
      if (eng.isWebGPU && core.T.bjsWebGPU === false) return flatWhy(st, 'WebGPU engine — left 2D (bjsWebGPU off)'); // TEST ONLY (A/B)
      if (eng.isWebGPU && eng.snapshotRendering) return flatWhy(st, 'WebGPU snapshot rendering (GPU bundles recorded with the page camera) — not split per eye');
      const sc = sceneOf(st);
      if (!sc.scene) return sc.flat ? flatWhy(st, sc.why) : sc.why;
      const pick = pickCamera(st, sc.scene);
      if (!pick.cam) return pick.flat ? flatWhy(st, pick.why) : pick.why;
      st.flatReason = null;
      st.qualify = { scene: sc.scene, cam: pick.cam };
      const where = core.canvasPlacement(st.canvas);
      if (where) return where;
      if (!(realW(st.canvas) > 0 && realH(st.canvas) > 0)) return 'canvas has no size yet';
      return core.cssEffect(st.canvas);
    },
    hasCamera: (st) => !!st.cam,
    depthRange: (st) => rangeOf(st),
    rigFov: (st) => rigFovOf(st),
    sampler(st) {
      if (!st.cam) return null;
      const r = rangeOf(st);
      return {
        cameraPose: cameraRH(st, new Float64Array(16)),
        verticalFov: vfovOf(st), aspect: subAspect(st), near: r.near, far: r.far,
        forEachBounds: (cb) => forEachBounds(st, cb),
      };
    },
    fakeViewParams(st) { const r = rangeOf(st), v = rigFovOf(st); return { near: r.near, far: r.far, t: r.near * Math.tan(v / 2), aspect: st.L.w / (st.L.h || 1) }; },
    beforeActive(st) {
      st.L.w = realW(st.canvas); st.L.h = realH(st.canvas); st.L.pr = 1;
      st.hw0 = hwLevel(st);
      st.follows = followsResize(st);
    },
    afterActive(st) {
      st.scene = st.qualify.scene; st.cam = st.qualify.cam; st.lastScene = st.scene;
      applySize(st);
      installRig(st, st.cam);
    },
    firstDraw(st) { replaySoon(st); },
    redraw(st) {
      if (st.frame.drew) st.frame.idle = 0;
      else if (++st.frame.idle >= 2) { st.stats.replays++; replay(st); }
      st.frame.drew = false;
    },
    restore(st, wasLive) {
      uninstallRig(st);
      unScale(st);
      st.cam = null; st.scene = null;
      if (wasLive) replaySoon(st); // the mono frame: the page's next render (or ours, if it draws no more), reported from onAfterRender
      return false;
    },
    wake(st) { if (!st.active) replaySoon(st); }, // re-enabled: one frame, whose onAfterRender considers activation
    flipIdle(st) { replay(st); },                  // armed, page idle: one mono frame, flipped on its onAfterRender
    coverAfterDraw: true,
    surface(st) {
      const eng = st.eng;
      if (!eng) return null;
      if (eng.isWebGPU) {
        if (!eng._device || !eng._context) return null;
        return core.surfaces.gpu({
          get device() { return eng._device; }, get context() { return eng._context; },
          flush: () => { if (typeof eng.flushFramebuffer === 'function') eng.flushFramebuffer(); },
          get alphaMode() { return eng.premultipliedAlpha === false ? 'opaque' : 'premultiplied'; },
        });
      }
      return eng._gl ? core.surfaces.gl(eng._gl) : null;
    },
    target(st) {
      const c = st.cam;
      if (!c) return null;
      const ok = (p) => p && isFinite(p.x) && isFinite(p.y) && isFinite(p.z);
      if (typeof c.alpha === 'number' && typeof c.beta === 'number' && typeof c.radius === 'number') {
        let t = null;
        try { t = c.target; } catch (e) { t = null; }
        if (ok(t)) return { x: t.x, y: t.y, z: t.z, via: 'ArcRotateCamera target' };
      }
      const lt = c.lockedTarget;
      if (lt) {
        let p = null;
        try { p = typeof lt.getAbsolutePosition === 'function' ? lt.getAbsolutePosition() : lt; } catch (e) { p = null; }
        if (ok(p)) return { x: p.x, y: p.y, z: p.z, via: 'camera.lockedTarget' };
      }
      const s = setTargets.get(c);
      return s ? { x: s.x, y: s.y, z: s.z, via: 'camera.setTarget' } : null;
    },
    describe: (st) => ({
      page: { w: st.L.w, h: st.L.h, pr: 1 },
      extra: {
        detection: via.get(st.eng), version: engineVersion(st), device: st.eng.isWebGPU ? 'webgpu' : 'webgl' + (st.eng.webGLVersion || ''),
        camera: st.cam ? `${st.cam.name} (${className(st.cam)})` : null, rigOn: st.rigOn ? st.rigOn.name : null,
        handedness: st.scene ? (st.scene.useRightHandedSystem ? 'right' : 'left') : null, reverseDepth: !!st.eng.useReverseDepthBuffer,
        viewport: st.vp ? [st.vp.x, st.vp.y, st.vp.w, st.vp.h] : null, gbufferPerEye: st.gbufEyes || 0, customRtPerEye: st.rtEyes || 0, customRtOwnView: st.rtFixed || 0, customRtOwnViewReleased: st.rtUnlatched || 0, customRtProbes: st.rtProbes ? st.rtProbes.size : 0, eyeTargets: !!st.eyeTargetsOn,
        hwScale: hwLevel(st), scale: st.scale || 1, followsResize: st.follows, pixelGui: st.pxGui, postProcesses: st.cam ? (st.cam._postProcesses || []).filter(Boolean).length : 0,
        surface: st.surf ? st.surf.kind : null, outCoverVia: st.outCoverVia || null, autoRender: st.frame.idle < 2,
        eyeProj0: st.eyes ? Array.from(st.eyes[0].__dxrP.m) : null, // what the engine draws eye 0 with
      },
    }),
  };
  function flatWhy(st, why) {
    if (st.flatReason !== why) { st.flatReason = why; info('Babylon.js canvas stays 2D:', why); core.notify(); }
    return why;
  }
  const className = (o) => { try { return typeof o.getClassName === 'function' ? o.getClassName() : (o.constructor && o.constructor.name) || '?'; } catch (e) { return '?'; } };
  function engineVersion(st) {
    let v = null;
    try { v = (bjsNS && bjsNS.Engine && bjsNS.Engine.Version) || (st.eng.constructor && st.eng.constructor.Version); } catch (e) { v = null; }
    return v || '?';
  }
  const hwLevel = (st) => { try { return st.eng.getHardwareScalingLevel(); } catch (e) { return 1; } };

  function onBeforeRender(engine, scene) {
    const st = stateFor(engine);
    if (!st) return;
    sceneAt.set(scene, core.now());
    if (!st.active) return;
    if (scene !== st.scene) {
      core.stand(st, 'another scene renders to the canvas', { staged: true });
      st.nextTry = core.now() + 1000;
      return;
    }
    const pick = pickCamera(st, scene);
    if (!pick.cam) {
      core.stand(st, pick.why, { staged: true }); // this frame now renders mono; the layer goes after it
      if (pick.flat) flatWhy(st, pick.why);
      st.nextTry = core.now() + 1000;
      return;
    }
    if (pick.cam !== st.rigOn) moveRig(st, pick.cam);
    applySize(st);
    syncRig(st);
    if (st.haveViews) st.stats.stereo++;
    else { st.stats.flat++; if (st.stats.twoView > 0) st.stats.flatAfterEyes++; }
  }
  function onAfterRender(engine, scene) {
    const st = stateFor(engine);
    if (!st) return;
    if (!st.replaying) { st.frame.drew = true; st.frame.n++; }
    if (st.active) {
      if (scene !== st.scene) return;
      core.drew(st);
      if (st.outCoverDue) core.takeOutCover(st);
      return;
    }
    if (st.releasing) { core.monoDrawn(st); return; } // the mono frame after a staged stand-down
    st.lastScene = scene;
    if (st.armed) {
      const sc = sceneOf(st);
      const pick = sc.scene === scene ? pickCamera(st, scene) : { why: sc.why || 'the page switched scenes', flat: sc.flat };
      if (!pick.cam) { core.stand(st, pick.why); if (pick.flat) flatWhy(st, pick.why); return; }
      st.qualify = { scene, cam: pick.cam };
      core.flip(st); // this task just drew the mono frame: it is the cover
      return;
    }
    core.considerActivation(st);
  }
  function onBeforeCamera(engine, scene, cam) {
    const st = engines.get(engine);
    if (!st || !st.active || st.scene !== scene || !st.eyes || (cam !== st.eyes[0] && cam !== st.eyes[1])) return;
    if (st.rigOn && scene.postProcessesEnabled !== false && (cam._postProcesses || []).some(Boolean)) cam.viewport = st.rigOn.viewport;
    eyeRenderTargets(st, scene, cam === st.eyes[0] ? 0 : 1);
    if (cam !== st.eyes[1]) return;
    const gbr = scene._geometryBufferRenderer;
    if (!gbr || core.T.bjsGBuffer === false || core.T.bjsGBuffer === 'shared' || !scene._renderTargets || typeof gbr.getGBuffer !== 'function') return;
    try {
      scene._renderTargets.pushNoDuplicate(gbr.getGBuffer());
      iblHistory(engine, scene, cam);
      if (!st.gbufEyes++) info('geometry buffer drawn again for the right eye (EXPERIMENTAL): GI / IBL shadows / SSAO / SSR see each eye\'s own view');
    } catch (e) { warnOnce('bjs-gbuf', 'could not draw the geometry buffer for the right eye', e); }
  }
  const RT_OWN_VIEW_FRAMES = 3;
  function eyeRenderTargets(st, scene, eye) {
    const list = scene.customRenderTargets;
    if (!list || !list.length || core.T.bjsCustomRT === false || !scene._renderTargets) return;
    try {
      if (eye === 0) st.rtFrame++;
      const names = [], probe = core.T.bjsCustomRTOwnView !== false;
      for (const rt of list) {
        if (!rt || rt.activeCamera || rt.refreshRate !== 1 || (rt.renderList && !rt.renderList.length)) continue;
        if (probe && viewProbe(st, scene, rt).own) continue;
        scene._renderTargets.pushNoDuplicate(rt);
        names.push(rt.name || '?');
      }
      if (names.length && !st.rtEyes++) info(`render target(s) the page draws from its camera, drawn again for each eye: ${names.slice(0, 4).join(', ')}`);
    } catch (e) { warnOnce('bjs-customrt', "could not draw the page's render targets for each eye", e); }
  }
  function sameM(a, b) {
    for (let k = 0; k < 32; k++) if (Math.abs(a[k] - b[k]) > 1e-6) return false;
    return true;
  }
  function readVP(out, v, p) {
    for (let k = 0; k < 16; k++) { out[k] = v.m[k]; out[16 + k] = p.m[k]; }
  }
  function viewProbe(st, scene, rt) {
    let p = st.rtProbes.get(rt);
    if (p) return p;
    const vp = () => new Float64Array(32);
    p = { v: [vp(), vp()], e: [vp(), vp()], mine: [false, false], at: [-1, -1], same: 0, own: false, ob: null, obs: null,
      mv: vp(), mc: vp(), back: 0, disp: null, dispObs: null };
    st.rtProbes.set(rt, p);
    const disp = rt.onDisposeObservable;
    if (core.T.bjsRtProbeDispose !== false && disp && typeof disp.add === 'function') {
      p.disp = disp;
      p.dispObs = disp.add(() => dropViewProbe(st, rt));
    }
    const ob = (rt._objectRenderer && rt._objectRenderer.onBeforeRenderingManagerRenderObservable) || rt.onBeforeRenderObservable;
    if (!ob || typeof ob.add !== 'function') return p;
    p.ob = ob;
    p.obs = ob.add((pass) => {
      try {
        if (pass || !st.eyes) return;
        const cam = scene.activeCamera, i = cam === st.eyes[0] ? 0 : cam === st.eyes[1] ? 1 : -1;
        if (!cam || (i < 0 && !p.own) || (i >= 0 && p.own)) return; // eye draws decide a latch; the single draw re-checks one
        const sv = scene.getViewMatrix(), sp = scene.getProjectionMatrix(), cv = cam.getViewMatrix(), cp = cam.getProjectionMatrix();
        if (!sv || !sp || !cv || !cp || !sv.m || !sp.m || !cv.m || !cp.m) return;
        if (i < 0) {
          if (core.T.bjsCustomRTOwnViewRecheck === false) return;
          readVP(p.mv, sv, sp); readVP(p.mc, cv, cp);
          p.back = sameM(p.mv, p.mc) ? p.back + 1 : 0;
          if (p.back < RT_OWN_VIEW_FRAMES) return;
          p.own = false; p.same = 0; p.back = 0;
          if (st.rtUnlatched++ < 4) info(`render target ${rt.name || '?'} now draws from the camera: drawn again for each eye`);
          return;
        }
        readVP(p.v[i], sv, sp); readVP(p.e[i], cv, cp);
        p.mine[i] = !sameM(p.v[i], p.e[i]);
        p.at[i] = st.rtFrame;
        if (i !== 1 || p.at[0] !== st.rtFrame) return;
        const fixed = p.mine[0] && p.mine[1] && sameM(p.v[0], p.v[1]) && !sameM(p.e[0], p.e[1]);
        p.same = fixed ? p.same + 1 : 0;
        if (p.same < RT_OWN_VIEW_FRAMES) return;
        p.own = true;
        if (st.rtFixed++ < 4) info(`render target ${rt.name || '?'} draws from a view of its own, the same for both eyes (a light, a probe): drawn once, as the page does`);
      } catch (e) { /* the probe only ever withholds a redraw */ }
    });
    return p;
  }
  function unhookViewProbe(p) {
    try { if (p.ob && p.obs) p.ob.remove(p.obs); } catch (e) { /* ignore */ }
    try { if (p.disp && p.dispObs) p.disp.remove(p.dispObs); } catch (e) { /* ignore */ }
  }
  function dropViewProbe(st, rt) {
    const p = st.rtProbes.get(rt);
    if (!p) return;
    unhookViewProbe(p);
    st.rtProbes.delete(rt);
  }
  function dropViewProbes(st) {
    for (const p of st.rtProbes.values()) unhookViewProbe(p);
    st.rtProbes.clear();
  }
  function iblHistory(engine, scene, cam) {
    const mgr = scene.postProcessRenderPipelineManager;
    const map = mgr && mgr._renderPipelines;
    if (!map || core.T.bjsIblHistory === false) return; // TEST ONLY (A/B)
    let did = false;
    for (const k of Object.keys(map)) {
      const p = map[k];
      let n = '';
      try { n = p && typeof p.getClassName === 'function' ? p.getClassName() : ''; } catch (e) { n = ''; }
      const acc = n === 'IBLShadowsRenderPipeline' ? p._accumulationPass : null;
      if (!acc || acc.enabled === false) continue;
      for (const t of [acc._oldAccumulationCopy, acc._oldPositionCopy]) {
        if (t && typeof t.render === 'function' && (typeof t.isReady !== 'function' || t.isReady())) { t.render(); did = true; }
      }
    }
    if (did) {
      try { engine.setViewport(cam.__dxrVp || cam.viewport); } catch (e) { /* the pass sets its own next */ }
      const st = engines.get(engine);
      if (st && !st.iblLogged) { st.iblLogged = true; info('IBL shadows: the accumulation history is copied again before the right eye (each eye reprojects the other eye\'s shadows)'); }
    }
  }
  function onCameraChanged(engine, scene) {
    const st = engines.get(engine);
    if (!st || !st.active || st.scene !== scene) return;
    const pick = pickCamera(st, scene);
    if (pick.cam) { if (pick.cam !== st.rigOn) moveRig(st, pick.cam); return; }
    core.stand(st, pick.why, { staged: true });
    if (pick.flat) flatWhy(st, pick.why);
    st.nextTry = core.now() + 1000;
  }

  function replay(st) {
    const scene = st.scene || st.lastScene;
    if (!scene || scene.isDisposed || st.replaying) return;
    const eng = st.eng, frame = !!eng.isWebGPU; // WebGPU submits at endFrame: a bare scene.render() would never reach the canvas
    st.replaying = true;
    try {
      if (frame) eng.beginFrame();
      try { scene.render(false, true); } finally { if (frame) eng.endFrame(); }
    } catch (e) { warnOnce('bjs-replay', 'replaying the scene threw; idle frames will not be redrawn', e); } finally { st.replaying = false; }
  }
  function replaySoon(st) {
    const n = st.frame.n;
    requestAnimationFrame(() => { if (st.frame.n === n) replay(st); });
  }

  function applySize(st) {
    const c = st.canvas, cw = c.clientWidth, ch = c.clientHeight;
    const kPage = st.hw0 > 0 ? 1 / st.hw0 : 1;
    let k = kPage;
    if (st.follows && cw > 0 && ch > 0) {
      const sf = core.surfaceOf(st);
      if (st.lim === undefined && sf) st.lim = sf.limit();
      const lim = core.T.glLimit > 0 ? core.T.glLimit : st.lim || Infinity;
      const dpr = Math.min(window.devicePixelRatio || 1, core.T.maxEyeDpr);
      st.pxGui = pixelGui(st.scene);
      if (!st.pxGui) k = Math.max(kPage, dpr);
      k = Math.min(k, Math.min(core.T.maxSbsWidth, lim) / cw, lim / ch, Math.sqrt(core.T.maxSbsArea / (cw * ch))); // core fitEyes' caps, one factor
    }
    const want = k / kPage;
    if (Math.abs(want - (st.scale || 1)) > 1e-3) setScale(st, want);
    const w = realW(c), h = realH(c);
    st.L.w = Math.round(w / (st.scale || 1)); st.L.h = Math.round(h / (st.scale || 1));
    const eyeW = Math.max(1, w >> 1);
    st.R = { eyeW, eyeH: h, W: 2 * eyeW, H: h };
  }
  function followsResize(st) {
    const c = st.canvas, hw = st.hw0 > 0 ? st.hw0 : 1;
    const cw = c.clientWidth, ch = c.clientHeight;
    return cw > 0 && ch > 0 && Math.abs(realW(c) - cw / hw) <= 1 && Math.abs(realH(c) - ch / hw) <= 1;
  }
  function pixelGui(scene) {
    const layers = (scene && scene.layers) || [];
    for (const l of layers) {
      const t = l && l.texture;
      if (!t || typeof t.getClassName !== 'function') continue;
      let n = '';
      try { n = t.getClassName(); } catch (e) { n = ''; }
      if (n === 'AdvancedDynamicTexture' && !t.adjustToEngineHardwareScalingLevel && !t.idealWidth && !t.idealHeight) return true;
    }
    return false;
  }
  function setScale(st, s) {
    const eng = st.eng;
    if (Math.abs(s - 1) <= 1e-3) { unScale(st); return; }
    if (!st.scale) {
      const orig = eng.setHardwareScalingLevel;
      st.hwOwn = Object.prototype.hasOwnProperty.call(eng, 'setHardwareScalingLevel') ? orig : null;
      eng.setHardwareScalingLevel = function (level) {
        if (!st.scale) return orig.apply(this, arguments);
        st.hw0 = level;
        this._hardwareScalingLevel = level / st.scale;
        this.resize();
      };
    }
    st.scale = s;
    eng._hardwareScalingLevel = st.hw0 / s;
    try { eng.resize(); } catch (e) { warnOnce('bjs-scale', 'could not resize the store for the eyes', e); }
    st.stats.resizes++;
    info(`store ${realW(st.canvas)}x${realH(st.canvas)}: x${s.toFixed(3)} the page's (hardware scaling ${eng._hardwareScalingLevel.toFixed(3)}, the page's ${st.hw0}) — ` +
      (s < 1 ? `the side-by-side width limit is ${core.T.maxSbsWidth} (area ${core.T.maxSbsArea})` : "the element's device pixels"));
  }
  function unScale(st) {
    if (!st.scale) return;
    const eng = st.eng;
    st.scale = 0;
    if (st.hwOwn) eng.setHardwareScalingLevel = st.hwOwn; else { try { delete eng.setHardwareScalingLevel; } catch (e) { /* ignore */ } }
    st.hwOwn = null;
    eng._hardwareScalingLevel = st.hw0;
    try { eng.resize(); } catch (e) { /* the page's next resize puts it back */ }
  }

  function makeEyes(st, cam) {
    const Cam = cameraBase(cam), scene = cam.getScene();
    const Mx = cam.getViewMatrix().constructor;
    const Vp = cam.viewport.constructor;
    const ident = () => (typeof Mx.Identity === 'function' ? Mx.Identity() : new Mx());
    return [0, 1].map((i) => {
      const e = new Cam(`dxr-auto3d-eye-${i}`, typeof cam.position.clone === 'function' ? cam.position.clone() : cam.position, scene, false);
      Object.defineProperty(e, '__dxrEye', { value: i });
      e.isRigCamera = true;
      e._isLeftCamera = i === 0; e._isRightCamera = i === 1;
      e.viewport = e.__dxrVp = new Vp(i * 0.5, 0, 0.5, 1); // __dxrVp: the eye's own (viewport may stand in for the page's, onBeforeCamera)
      e.__dxrV = ident(); e.__dxrP = ident();
      e.freezeProjectionMatrix(e.__dxrP);
      e._isSynchronizedViewMatrix = () => false; // recomputed on every read (cheap; values compared before marking)
      e._getViewMatrix = () => eyeView(st, i, e);
      return e;
    });
  }
  function postProcessClass(st, scene) {
    if (bjsNS && typeof bjsNS.PostProcess === 'function') return bjsNS.PostProcess;
    const seen = [...(scene.postProcesses || [])];
    for (const c of scene.cameras || []) for (const pp of c._postProcesses || []) if (pp) seen.push(pp);
    for (const pp of seen) {
      for (let q = Object.getPrototypeOf(pp); q && q !== Object.prototype; q = Object.getPrototypeOf(q)) {
        if (!Object.prototype.hasOwnProperty.call(q, 'getClassName')) continue;
        let n = null;
        try { n = q.getClassName.call(pp); } catch (e) { n = null; }
        if (n === 'PostProcess' && typeof q.constructor === 'function') return q.constructor;
      }
    }
    return null;
  }
  const EYE_PASS = {
    0: {
      vs: 'attribute vec2 position; uniform vec2 scale; varying vec2 vUV; const vec2 madd = vec2(0.5, 0.5);\n' +
        'void main(void) { vUV = (position * madd + madd) * scale; gl_Position = vec4(position, 0.0, 1.0); }',
      fs: 'varying vec2 vUV; uniform sampler2D textureSampler;\nvoid main(void) { gl_FragColor = texture2D(textureSampler, vUV); }',
    },
    1: {
      vs: 'attribute position: vec2<f32>; uniform scale: vec2<f32>; varying vUV: vec2<f32>; const madd = vec2(0.5, 0.5);\n' +
        '@vertex\nfn main(input : VertexInputs) -> FragmentInputs {\nvertexOutputs.vUV = (vertexInputs.position * madd + madd) * uniforms.scale; vertexOutputs.position = vec4(vertexInputs.position, 0.0, 1.0);\n}',
      fs: 'varying vUV: vec2f; var textureSamplerSampler: sampler; var textureSampler: texture_2d<f32>;\n' +
        '@fragment\nfn main(input: FragmentInputs) -> FragmentOutputs { fragmentOutputs.color = textureSample(textureSampler, textureSamplerSampler, input.vUV); }',
    },
  };
  function eyePassShader(scene) {
    const lang = scene.getEngine().isWebGPU ? 1 : 0; // ShaderLanguage.WGSL / GLSL
    const effects = [];
    for (const m of scene.materials || []) { try { effects.push(m && typeof m.getEffect === 'function' ? m.getEffect() : null); } catch (x) { /* ignore */ } }
    const pps = [...(scene.postProcesses || [])];
    for (const c of scene.cameras || []) for (const pp of c._postProcesses || []) if (pp) pps.push(pp);
    for (const pp of pps) { try { effects.push(pp && typeof pp.getEffect === 'function' ? pp.getEffect() : null); } catch (x) { /* ignore */ } }
    for (const m of (scene.meshes || []).slice(0, 64)) { try { const sm = m && m.subMeshes && m.subMeshes[0]; effects.push(sm ? sm.effect : null); } catch (x) { /* ignore */ } }
    for (const e of effects) {
      const E = e && e.constructor;
      if (!E || typeof E.RegisterShader !== 'function') continue;
      try { E.RegisterShader('dxrEyePass', EYE_PASS[lang].fs, EYE_PASS[lang].vs, lang); } catch (x) { return -1; }
      return lang;
    }
    return -1;
  }
  const EYE_TARGET_TRIES = 60;
  function makeEyeTargets(st, scene) {
    if (st.eyeTargets !== undefined || core.T.bjsEyeTarget === false) return;
    st.eyeTargets = null;
    const PP = postProcessClass(st, scene);
    const lang = PP ? eyePassShader(scene) : -1;
    if (!PP || lang < 0) {
      const n = (st.eyeTargetTries = (st.eyeTargetTries || 0) + 1);
      if (n < EYE_TARGET_TRIES) { st.eyeTargets = undefined; st.eyeTargetRetryAt = core.now() + 1000; }
      if (n === 1 || n === EYE_TARGET_TRIES) info(`eye targets: ${PP ? 'no Effect class' : 'no PostProcess class'} reachable${n < EYE_TARGET_TRIES ? ' yet (trying again each second, for a minute)' : ' after a minute'} — the eyes draw straight into their halves (screen-space lookups keyed to the canvas may misplace)`);
      return;
    }
    if (st.eyeTargetTries) info(`eye targets: made on try ${st.eyeTargetTries + 1}`);
    const eng = scene.getEngine();
    let samples = 1;
    try { const aa = eng.getCreationOptions && eng.getCreationOptions().antialias; samples = aa && (eng.isWebGPU || eng.webGLVersion > 1) ? Math.min(4, (eng.getCaps().maxMSAASamples) || 1) : 1; } catch (e) { samples = 1; }
    try {
      st.eyeTargets = [0, 1].map((i) => {
        const pp = new PP(`dxr-auto3d-eye-${i}-target`, 'dxrEyePass', null, null, { width: 2, height: 2 }, null, 1, eng, false, null, 0, 'dxrEyePass', undefined, false, 5, lang);
        pp.samples = samples;
        return pp;
      });
    } catch (e) { st.eyeTargets = null; warnOnce('bjs-eyert', 'could not make the eye targets — the eyes draw straight into their halves', e); }
  }
  function syncEyeTargets(st) {
    if (st.eyeTargets === undefined && st.eyeTargetRetryAt && st.rigOn && core.now() >= st.eyeTargetRetryAt) makeEyeTargets(st, st.rigOn.getScene());
    const T = st.eyeTargets, cam = st.rigOn;
    if (!T || !st.eyes || !cam) return;
    const W = realW(st.canvas), H = realH(st.canvas);
    for (let i = 0; i < 2; i++) {
      const pp = T[i], e = st.eyes[i], v = e.__dxrVp;
      pp._options = { width: Math.max(1, Math.round(W * v.width)), height: Math.max(1, Math.round(H * v.height)) };
      if (e._rigPostProcess !== pp && typeof pp.isReady === 'function' && pp.isReady()) {
        e._rigPostProcess = pp;
        st.eyeTargetsOn = true;
      }
    }
    if (st.eyeTargetsOn && (st.eyes[0]._postProcesses || []).indexOf(T[0]) < 0) {
      cam._cascadePostProcessesToRigCams();
      for (const e of st.eyes) e.isIntermediate = false; // defensive: the cascade marks a lone rig post-process of the engine's 'pass' effect intermediate (a VR rig's); ours is dxrEyePass, so it should not
      if (!st.eyeTargetsLogged) { st.eyeTargetsLogged = true; info('eye targets on: each eye renders into its own target and is copied into its half'); }
    }
  }
  function disposeEyeTargets(st) {
    const T = st.eyeTargets;
    st.eyeTargets = undefined; st.eyeTargetsOn = false; st.eyeTargetTries = 0; st.eyeTargetRetryAt = 0;
    if (st.eyes) for (const e of st.eyes) { e._rigPostProcess = null; e._postProcesses = []; }
    if (T) for (const pp of T) { try { pp.dispose(); } catch (e) { /* ignore */ } }
  }

  function installRig(st, cam) {
    try {
      if (st.eyes && st.eyes.some((e) => typeof e.isDisposed === 'function' && e.isDisposed())) st.eyes = null;
      if (!st.eyes) st.eyes = makeEyes(st, cam);
      for (const e of st.eyes) e.rigParent = cam;
      st.rigMode0 = cam.cameraRigMode;
      cam.cameraRigMode = RIG_MODE_CUSTOM;
      cam._rigCameras.push(st.eyes[0], st.eyes[1]);
      st.rigOn = cam;
      makeEyeTargets(st, cam.getScene());
      syncRig(st);
      if (typeof cam._cascadePostProcessesToRigCams === 'function') cam._cascadePostProcessesToRigCams();
    } catch (e) {
      warnOnce('bjs-rig', 'could not put the eye cameras on the page camera — standing down', e);
      uninstallRig(st);
      core.stand(st, 'the eye cameras could not be installed', { staged: true });
    }
  }
  function detachRig(st) {
    const cam = st.rigOn;
    st.rigOn = null;
    if (!cam || !st.eyes) return;
    const list = cam._rigCameras || [];
    for (const e of st.eyes) { const k = list.indexOf(e); if (k >= 0) list.splice(k, 1); e._postProcesses = []; e._rigPostProcess = null; }
    st.eyeTargetsOn = false; // re-attached on the next camera (syncEyeTargets)
    if (!list.length && cam.cameraRigMode === RIG_MODE_CUSTOM) cam.cameraRigMode = st.rigMode0 || 0;
  }
  function moveRig(st, cam) {
    detachRig(st);
    st.cam = cam;
    installRig(st, cam);
    info(`the page switched cameras: the eyes follow ${cam.name} (${className(cam)})`);
  }
  function uninstallRig(st) {
    detachRig(st);
    disposeEyeTargets(st);
    dropViewProbes(st);
    if (st.eyes) {
      for (const e of st.eyes) { e._postProcesses = []; try { e.dispose(); } catch (err) { /* ignore */ } }
      st.eyes = null;
    }
  }
  function syncRig(st) {
    const cam = st.rigOn;
    if (!cam || !st.eyes) return;
    const v = (st.vp = vpOf(cam));
    for (let i = 0; i < 2; i++) {
      const e = st.eyes[i], ev = e.__dxrVp;
      if (e.viewport !== ev) e.viewport = ev;
      e.layerMask = cam.layerMask; e.minZ = cam.minZ; e.maxZ = cam.maxZ;
      ev.x = i * 0.5 + v.x * 0.5; ev.y = v.y; ev.width = v.w * 0.5; ev.height = v.h;
    }
    syncEyeTargets(st);
  }

  function cameraRH(st, out) {
    const w = st.cam.getWorldMatrix().m;
    for (let k = 0; k < 16; k++) out[k] = w[k];
    if (!st.scene.useRightHandedSystem) { out[8] = -out[8]; out[9] = -out[9]; out[10] = -out[10]; out[11] = -out[11]; }
    return out;
  }
  function eyeView(st, i, e) {
    const V = e.__dxrV, P = e.__dxrP;
    const cam = st.rigOn;
    if (!cam || !st.scene) return V;
    if (st.haveViews) {
      const T = st.tmp, lh = !st.scene.useRightHandedSystem;
      const mrh = cameraRH(st, T.mrh);
      const pose = core.eyePose(st, i, mrh);
      mul4(mrh, pose, T.e);
      if (lh) { T.e[8] = -T.e[8]; T.e[9] = -T.e[9]; T.e[10] = -T.e[10]; T.e[11] = -T.e[11]; } // × H: the eye's own frame, left-handed
      writeMat(V, core.invert4(T.e));
      if (i === 0) st.eyeAt = [T.e[12], T.e[13], T.e[14]]; // diagnostics (dev state(): eyeAt)
      eyeProjection(st, st.V[i].proj, lh, T.p);
      writeMat(P, T.p);
    } else {
      writeMat(V, cam.getViewMatrix().m);
      writeMat(P, cam.getProjectionMatrix().m);
    }
    return V;
  }
  function eyeProjection(st, src, lh, out) {
    for (let k = 0; k < 16; k++) out[k] = src[k];
    const v = st.vp;
    if (v && (v.w !== 1 || v.h !== 1)) for (let c = 0; c < 4; c++) { out[c * 4] /= v.w; out[c * 4 + 1] /= v.h; } // the whole canvas's -> the camera's viewport (rigFovOf)
    if (lh) { out[8] = -out[8]; out[9] = -out[9]; out[10] = -out[10]; out[11] = -out[11]; } // P × H
    const eng = st.eng;
    if (eng.useReverseDepthBuffer) { out[2] = -out[2]; out[6] = -out[6]; out[10] = -out[10]; out[14] = -out[14]; } // near -> 1, far -> -1 (near / far swapped)
    if (eng.isNDCHalfZRange) for (let c = 0; c < 4; c++) out[c * 4 + 2] = 0.5 * (out[c * 4 + 2] + out[c * 4 + 3]);
    return out;
  }
  function writeMat(M, src) {
    const m = M.m;
    let diff = false;
    for (let k = 0; k < 16; k++) {
      const v = m instanceof Float32Array ? Math.fround(src[k]) : src[k];
      if (m[k] !== v) { diff = true; break; }
    }
    if (!diff) return;
    for (let k = 0; k < 16; k++) m[k] = src[k];
    M.markAsUpdated();
  }

  function forEachBounds(st, cb) {
    const scene = st.scene, mask = st.cam.layerMask;
    const list = scene.meshes || [];
    for (let k = 0; k < list.length && k < 4000; k++) {
      const m = list[k];
      try {
        if (!m || !m.isVisible || m.visibility === 0 || m.infiniteDistance || !(m.layerMask & mask) || (typeof m.isEnabled === 'function' && !m.isEnabled())) continue;
        if (typeof m.getTotalVertices === 'function' && m.getTotalVertices() === 0 && !(m.getBoundingInfo && m.getBoundingInfo().boundingSphere.radiusWorld > 0)) continue;
        const bs = m.getBoundingInfo && m.getBoundingInfo().boundingSphere;
        if (!bs) continue;
        const c = bs.centerWorld, r = bs.radiusWorld;
        if (!(r >= 0) || !isFinite(r) || !isFinite(c.x)) continue;
        if (cb(c.x, c.y, c.z, r) === false) return;
      } catch (e) { /* a mesh mid-dispose */ }
    }
  }

  function mul4(a, b, o) {
    for (let c = 0; c < 4; c++) {
      const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
      o[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
      o[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
      o[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
      o[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
    }
    return o;
  }

  info(`Babylon.js adapter armed (core v${core.VERSION})`);
  return { consider };
}
function dxrGl(core) {
  const { info, warnOnce, now, realW, realH, CANVAS_W, CANVAS_H } = core;
  const ENGINE = 'WebGL';
  const GL2 = typeof WebGL2RenderingContext === 'function' ? WebGL2RenderingContext.prototype : null;
  const apply = Reflect.apply;

  const FRAMEBUFFER = 0x8D40, DRAW_FB = 0x8CA9, READ_FB = 0x8CA8, TEXTURE_2D = 0x0DE1, TEXTURE0 = 0x84C0;
  const SCISSOR_TEST = 0x0C11, COLOR_BIT = 0x4000, DEPTH_BIT = 0x0100, STENCIL_BIT = 0x0400, NEAREST = 0x2600, LINEAR = 0x2601;
  const COLOR_ATT0 = 0x8CE0, DEPTH_ATT = 0x8D00, STENCIL_ATT = 0x8D20, DEPTH_STENCIL_ATT = 0x821A;
  const ATT_TYPE = 0x8CD0, ATT_NAME = 0x8CD1, ATT_LEVEL = 0x8CD2, RENDERBUFFER = 0x8D41, TEXTURE = 0x1702;
  const RB_W = 0x8D42, RB_H = 0x8D43, RB_FMT = 0x8D44, RB_SAMPLES = 0x8CAB;
  const VERTEX_SHADER = 0x8B31, SHADER_TYPE = 0x8B4F, ACTIVE_UNIFORMS = 0x8B86;
  const TEX_BINDING_2D = 0x8069, ACTIVE_TEXTURE = 0x84E0, FB_BINDING = 0x8CA6, READ_FB_BINDING = 0x8CAA, CURRENT_PROGRAM = 0x8B8D;
  const RB_BINDING = 0x8CA7, VIEWPORT = 0x0BA2, SCISSOR_BOX = 0x0C10, MAX_UNITS = 0x8B4D, MAX_DRAW_BUFFERS = 0x8824, MAX_COLOR_ATT = 0x8CDF;
  const MIN_FILTER = 0x2801, MAG_FILTER = 0x2800, WRAP_S = 0x2802, WRAP_T = 0x2803, CMP_MODE = 0x884C, CMP_FUNC = 0x884D;
  const SAMPLERS = new Set([0x8B5E, 0x8B62, 0x8DCA, 0x8DD2]); // sampler2D, sampler2DShadow, isampler2D, usampler2D (TEXTURE_2D units)

  const IDENT = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  function mul4(a, b, o) {
    o = o || new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    return o;
  }
  const near = (a, b, e = 1e-4) => Math.abs(a - b) <= e * Math.max(1, Math.abs(a), Math.abs(b));
  function classify(m) {
    if (near(m[3], 0) && near(m[7], 0) && near(m[11], 0) && near(m[15], 1)) {
      const c0 = Math.hypot(m[0], m[1], m[2]), c1 = Math.hypot(m[4], m[5], m[6]), c2 = Math.hypot(m[8], m[9], m[10]);
      const ortho = near(c0, c1, 1e-3) && near(c1, c2, 1e-3) && Math.abs(m[0] * m[4] + m[1] * m[5] + m[2] * m[6]) < 1e-3 * c0 * c1;
      return ortho ? 'rigid' : 'affine';
    }
    const n3 = Math.hypot(m[3], m[7], m[11]), n2 = Math.hypot(m[2], m[6], m[10]);
    if (n3 < 1e-9) return null;
    const cross = Math.hypot(m[6] * m[11] - m[10] * m[7], m[10] * m[3] - m[2] * m[11], m[2] * m[7] - m[6] * m[3]);
    if (n2 < 1e-9 * Math.max(1, n3) || cross < 1e-3 * n2 * n3) {
      if (near(m[3], 0) && near(m[7], 0) && near(Math.abs(m[11]), 1) && near(m[15], 0) && near(m[4], 0) && near(m[1], 0) && near(m[2], 0) && near(m[6], 0)) return 'P';
      return 'clip';
    }
    return null;
  }
  function frustumOf(P) {
    let n = P[14] / (P[10] - 1), f = P[14] / (P[10] + 1);
    if (!(n > 0)) n = Math.abs(P[14] / (P[10] + 1)) || 0.1;
    if (!(f > n) || !isFinite(f)) f = n * 1e4;
    return { near: n, far: f, fov: 2 * Math.atan(1 / Math.abs(P[5] || 1)), tan: 1 / Math.abs(P[5] || 1), aspect: Math.abs(P[5] / (P[0] || 1)) };
  }
  function eyeClipFallback(C, t, sx, sy, o) {
    o.set(C);
    const n3 = Math.hypot(C[3], C[7], C[11]) || 1;
    const a = Math.hypot(C[0], C[4], C[8]) / n3, b = Math.hypot(C[1], C[5], C[9]) / n3;
    for (let k = 0; k < 4; k++) { o[k * 4] -= sx * C[k * 4 + 3]; o[k * 4 + 1] -= sy * C[k * 4 + 3]; }
    o[12] -= a * t[0] * C[15] + sx * t[2] * C[15]; o[13] -= b * t[1] * C[15] + sy * t[2] * C[15];
    o[15] += t[2] * C[15];
    return o;
  }

  const GLX = {
    cameraOf(st, pi, aspect) {
      const out = st.camBuf; out.length = 0;
      for (const [loc, e] of pi.clip) {
        if (!e.vs) continue;
        const m = e.m;
        let r;
        if (e.kind === 'P') r = Math.abs(m[5] / (m[0] || 1e-9));
        else { const n0 = Math.hypot(m[0], m[4], m[8]), n1 = Math.hypot(m[1], m[5], m[9]); r = n1 / (n0 || 1e-9); }
        if (Math.abs(r / aspect - 1) <= (e.kind === 'P' ? 0.02 : 0.05)) out.push(loc, e);
      }
      return out;
    },
    isSeedTarget: (st, fi) => fi.w > 0 && fi.h > 0 && Math.abs((fi.w / fi.h) / (st.L.w / st.L.h) - 1) < 0.03 && fi.w >= 0.45 * st.L.w,
    isInfinite: (pi) => pi.infinite,
    single: () => false,
    target: (st) => orbitTarget(st),
  };

  const NEAR_LOOSEN = 0.25;
  const DEV = !!core.cfg.dev;
  const states = new Map(); // gl -> st
  let registered = false;

  function consider(canvas, gl, rec) {
    if (core.retired || !GL2 || !(gl instanceof WebGL2RenderingContext) || states.has(gl)) return;
    if (!rec || !rec.slot || !rec.base) return; // only a context the sentinel recorded from its creation (sentinel.js GL_HOOKS)
    if (core.claims(canvas, ENGINE)) { try { rec.unwrap(); } catch (e) { /* ignore */ } return; }
    if (!registered) { registered = true; core.registerEngine(ENGINE); }
    const st = core.newState(ENGINE, canvas, ad);
    st.gl = gl; st.rec = rec;
    st.L = { w: realW(canvas), h: realH(canvas), pr: 1 };
    st.camBuf = [];
    st.g = newGlState(gl);
    st.depth = 0;
    states.set(gl, st);
    hook(st);
    info(`WebGL canvas ${core.desc(canvas)} handed to the GL-level adapter (no engine adapter claimed it): watching its draws`);
    core.notify();
  }
  function yieldCanvas(canvas) {
    for (const st of states.values()) {
      if (st.canvas !== canvas || st.dead) continue;
      retire(st, 'an engine adapter claimed the canvas');
    }
  }
  function retire(st, why) {
    if (st.dead) return;
    if (st.active || st.pending || st.armed) core.stand(st, why);
    unhook(st);
    st.dead = true; st.flatReason = why;
    try { st.rec.unwrap(); } catch (e) { /* ignore */ }
    states.delete(st.gl);
    info(`GL-level adapter left ${core.desc(st.canvas)}: ${why}`);
    core.notify();
  }

  function newGlState(gl) {
    const g = {
      prog: null, dfb: null, rfb: null, vp: [0, 0, 1, 1], sc: [0, 0, 1, 1], scOn: false, unit: 0, units: [],
      progs: new WeakMap(), fbos: new WeakMap(), chain: new WeakSet(), chainTex: new WeakSet(), texFbo: new WeakMap(),
      twins: new WeakMap(), twinFbos: new WeakMap(), drawBufs: new WeakMap(), noTwin: new WeakSet(),
      frame: newFrame(), frames: 0, camFrames: 0, lastCamFrame: -1, pres: false, queued: false,
      P: null, Pframe: -1, origins: [], aff: new Map(), affPrev: null, tgt: null, tgtAt: 0,
      copy: null, mono: null, internal: 0, drewSince: false, lastViewports: 0, calls: {},
    };
    try {
      g.prog = gl.getParameter(CURRENT_PROGRAM);
      g.dfb = gl.getParameter(FB_BINDING); g.rfb = gl.getParameter(READ_FB_BINDING);
      g.vp = Array.from(gl.getParameter(VIEWPORT)); g.sc = Array.from(gl.getParameter(SCISSOR_BOX)); g.scOn = gl.isEnabled(SCISSOR_TEST);
      g.unit = gl.getParameter(ACTIVE_TEXTURE) - TEXTURE0;
      const n = Math.min(32, gl.getParameter(MAX_UNITS) | 0);
      for (let u = 0; u < n; u++) { GL2.activeTexture.call(gl, TEXTURE0 + u); g.units[u] = gl.getParameter(TEX_BINDING_2D); }
      GL2.activeTexture.call(gl, TEXTURE0 + g.unit);
    } catch (e) { /* a lost context: the adapter never qualifies */ }
    return g;
  }
  const newFrame = () => ({ draws: 0, cam: 0, camScreen: 0, camChain: 0, doubled: 0, single: 0, screen: 0, vps: new Set(), clip: {} });

  function progInfo(st, p) {
    const g = st.g;
    let pi = g.progs.get(p);
    if (pi) return pi;
    pi = { clip: new Map(), aff: new Map(), vsNames: null, samplers: new Map(), units: new Map(), infinite: false, id: ++progIds };
    g.progs.set(p, pi);
    const gl = st.gl;
    g.internal++;
    try {
      const shs = gl.getAttachedShaders(p) || [];
      for (const sh of shs) {
        if (gl.getShaderParameter(sh, SHADER_TYPE) !== VERTEX_SHADER) continue;
        const src = gl.getShaderSource(sh) || '';
        pi.vsNames = new Set([...src.matchAll(/uniform\s+(?:(?:highp|mediump|lowp)\s+)?mat4\s+(\w+)/g)].map((m) => m[1]));
        pi.infinite = /gl_Position\s*=[^;]*\.xyww/.test(src);
      }
      const n = gl.getProgramParameter(p, ACTIVE_UNIFORMS) | 0;
      for (let i = 0; i < n; i++) {
        const u = gl.getActiveUniform(p, i);
        if (!u || !SAMPLERS.has(u.type)) continue;
        const base = u.name.replace(/\[0\]$/, '');
        for (let k = 0; k < Math.max(1, u.size); k++) {
          const name = u.size > 1 ? `${base}[${k}]` : u.name;
          pi.samplers.set(name, true);
          const l = GL2.getUniformLocation.call(gl, p, name);
          if (l) { const v = gl.getUniform(p, l); pi.units.set(name, typeof v === 'number' ? v : 0); }
        }
      }
    } catch (e) { /* a program we cannot read: treated as no camera, no samplers */ } finally { g.internal--; }
    return pi;
  }
  let progIds = 0;
  const inVS = (st, pi, loc) => {
    if (!pi.vsNames) return true;
    const name = st.rec.loc.get(loc);
    return name === undefined ? true : pi.vsNames.has(name.replace(/\[.*$/, ''));
  };

  function fboInfo(st, fb) {
    const g = st.g;
    let fi = g.fbos.get(fb);
    if (fi) return fi;
    const gl = st.gl;
    fi = { w: 0, h: 0, atts: [] };
    g.internal++;
    try {
      const nCol = Math.min(8, gl.getParameter(MAX_COLOR_ATT) | 0);
      const points = [];
      for (let i = 0; i < nCol; i++) points.push(COLOR_ATT0 + i);
      points.push(DEPTH_STENCIL_ATT, DEPTH_ATT, STENCIL_ATT);
      for (const a of points) {
        const type = gl.getFramebufferAttachmentParameter(DRAW_FB, a, ATT_TYPE);
        if (!type) continue;
        const obj = gl.getFramebufferAttachmentParameter(DRAW_FB, a, ATT_NAME);
        if (!obj) continue;
        if (a === DEPTH_ATT || a === STENCIL_ATT) { if (fi.atts.some((x) => x.a === DEPTH_STENCIL_ATT && x.obj === obj)) continue; }
        const e = { a, kind: type === TEXTURE ? 'tex' : 'rb', obj, level: type === TEXTURE ? gl.getFramebufferAttachmentParameter(DRAW_FB, a, ATT_LEVEL) : 0 };
        if (e.kind === 'tex') {
          const sp = st.rec.tex.get(obj);
          const sz = sp ? (sp.k === 'sto' ? [sp.w >> e.level, sp.h >> e.level] : sp.l[e.level] ? [sp.l[e.level][1], sp.l[e.level][2]] : null) : null;
          e.spec = sp || null;
          if (sz && !fi.w) { fi.w = sz[0]; fi.h = sz[1]; }
          g.texFbo.set(obj, fb);
        } else {
          const prev = gl.getParameter(RB_BINDING);
          GL2.bindRenderbuffer.call(gl, RENDERBUFFER, obj);
          e.rb = [gl.getRenderbufferParameter(RENDERBUFFER, RB_SAMPLES) | 0, gl.getRenderbufferParameter(RENDERBUFFER, RB_FMT), gl.getRenderbufferParameter(RENDERBUFFER, RB_W), gl.getRenderbufferParameter(RENDERBUFFER, RB_H)];
          GL2.bindRenderbuffer.call(gl, RENDERBUFFER, prev);
          if (!fi.w) { fi.w = e.rb[2]; fi.h = e.rb[3]; }
        }
        fi.atts.push(e);
      }
    } catch (e) { /* unreadable: not a chain candidate */ } finally { g.internal--; }
    g.fbos.set(fb, fi);
    return fi;
  }
  function markChain(st, fb) {
    const g = st.g;
    if (g.chain.has(fb)) return;
    g.chain.add(fb);
    const fi = g.fbos.get(fb);
    if (fi) for (const e of fi.atts) if (e.kind === 'tex') g.chainTex.add(e.obj);
  }
  function samplesChain(st, pi) {
    const g = st.g;
    for (const u of pi.units.values()) { const t = g.units[u]; if (t && g.chainTex.has(t)) return true; }
    return false;
  }

  function twinTex(st, tex) {
    const g = st.g, gl = st.gl;
    let t = g.twins.get(tex);
    if (t) return t;
    const sp = st.rec.tex.get(tex);
    if (!sp) return null;
    t = gl.createTexture();
    const prev = g.units[g.unit] || null;
    GL2.bindTexture.call(gl, TEXTURE_2D, t);
    if (sp.k === 'sto') GL2.texStorage2D.call(gl, TEXTURE_2D, sp.levels, sp.ifmt, sp.w, sp.h);
    else for (const lv of Object.keys(sp.l)) { const a = sp.l[lv]; GL2.texImage2D.call(gl, TEXTURE_2D, +lv, a[0], a[1], a[2], 0, a[3], a[4], null); }
    GL2.bindTexture.call(gl, TEXTURE_2D, tex);
    const params = [MIN_FILTER, MAG_FILTER, WRAP_S, WRAP_T, CMP_MODE, CMP_FUNC].map((k) => [k, gl.getTexParameter(TEXTURE_2D, k)]);
    GL2.bindTexture.call(gl, TEXTURE_2D, t);
    for (const [k, v] of params) if (typeof v === 'number') GL2.texParameteri.call(gl, TEXTURE_2D, k, v);
    GL2.bindTexture.call(gl, TEXTURE_2D, prev);
    g.twins.set(tex, t);
    (st.made || (st.made = [])).push(t);
    return t;
  }
  function twinRb(st, rb, spec) {
    const g = st.g, gl = st.gl;
    let t = g.twins.get(rb);
    if (t) return t;
    t = gl.createRenderbuffer();
    const prev = gl.getParameter(RB_BINDING);
    GL2.bindRenderbuffer.call(gl, RENDERBUFFER, t);
    if (spec[0] > 0) GL2.renderbufferStorageMultisample.call(gl, RENDERBUFFER, spec[0], spec[1], spec[2], spec[3]);
    else GL2.renderbufferStorage.call(gl, RENDERBUFFER, spec[1], spec[2], spec[3]);
    GL2.bindRenderbuffer.call(gl, RENDERBUFFER, prev);
    g.twins.set(rb, t);
    (st.made || (st.made = [])).push(t);
    return t;
  }
  function twinFbo(st, fb) {
    const g = st.g, gl = st.gl;
    if (g.noTwin.has(fb)) return null;
    let t = g.twinFbos.get(fb);
    if (t) return t;
    const fi = fboInfo(st, fb);
    g.internal++;
    try {
      const objs = [];
      for (const e of fi.atts) {
        const o = e.kind === 'tex' ? twinTex(st, e.obj) : twinRb(st, e.obj, e.rb);
        if (!o) { g.noTwin.add(fb); warnOnce('gl-notwin', 'GL-level: a render target could not be twinned (texture specified before the recorder saw it): that pass is drawn once'); return null; }
        objs.push(o);
      }
      t = gl.createFramebuffer();
      GL2.bindFramebuffer.call(gl, DRAW_FB, t);
      fi.atts.forEach((e, i) => {
        if (e.kind === 'tex') GL2.framebufferTexture2D.call(gl, DRAW_FB, e.a, TEXTURE_2D, objs[i], e.level);
        else GL2.framebufferRenderbuffer.call(gl, DRAW_FB, e.a, RENDERBUFFER, objs[i]);
      });
      const db = g.drawBufs.get(fb);
      if (db) GL2.drawBuffers.call(gl, db);
      GL2.bindFramebuffer.call(gl, DRAW_FB, g.dfb);
      g.twinFbos.set(fb, t);
      (st.made || (st.made = [])).push(t);
      return t;
    } catch (e) { g.noTwin.add(fb); return null; } finally { g.internal--; }
  }
  function disposeTwins(st) {
    const g = st.g, gl = st.gl;
    for (const o of st.made || []) { try { if (o instanceof WebGLTexture) gl.deleteTexture(o); else if (o instanceof WebGLRenderbuffer) gl.deleteRenderbuffer(o); else gl.deleteFramebuffer(o); } catch (e) { /* ignore */ } }
    st.made = [];
    g.twins = new WeakMap(); g.twinFbos = new WeakMap(); g.noTwin = new WeakSet();
  }

  const eyeOut = [new Float32Array(16), new Float32Array(16)], tmpA = new Float32Array(16), tmpB = new Float32Array(16);
  function eyeMatrix(st, i, e, pi) {
    const m = e.m, o = eyeOut[i];
    if (!st.haveViews) { o.set(m); return o; }
    const E = core.eyePose(st, i, null) || IDENT;
    const V = st.V[i].proj;
    const fy = st.rig && st.rig.type === 'camera' && st.rig.verticalFov > 0 ? 1 / Math.tan(st.rig.verticalFov / 2) : 0;
    const k = fy > 0 && V[5] > 0 ? Math.min(2, Math.max(0.5, V[5] / fy)) : 1; // the runtime's focal change (a lean in), as a ratio
    const P = e.kind === 'P' ? m : st.g.P;
    if (!P) return eyeClipFallback(m, [E[12], E[13], E[14]], V[8], V[9], o);
    tmpA.set(P); tmpA[0] *= k; tmpA[5] *= k; tmpA[8] += V[8]; tmpA[9] += V[9];
    if (GLX.isInfinite(pi)) { // at infinity: the shear only (no eye shift reaches a skybox)
      if (e.kind === 'P') { o.set(tmpA); return o; }
    }
    const inv = invRigid(E, tmpB); // inv(E): a rigid eye pose
    mul4(tmpA, inv, o);
    if (e.kind === 'P') return o;
    const iP = st.g.Pinv || (st.g.Pinv = core.invert4(P));
    mul4(o, iP, tmpA); mul4(tmpA, m, o);
    return o;
  }
  function invRigid(E, o) {
    o[0] = E[0]; o[1] = E[4]; o[2] = E[8]; o[3] = 0;
    o[4] = E[1]; o[5] = E[5]; o[6] = E[9]; o[7] = 0;
    o[8] = E[2]; o[9] = E[6]; o[10] = E[10]; o[11] = 0;
    o[12] = -(E[0] * E[12] + E[1] * E[13] + E[2] * E[14]);
    o[13] = -(E[4] * E[12] + E[5] * E[13] + E[6] * E[14]);
    o[14] = -(E[8] * E[12] + E[9] * E[13] + E[10] * E[14]);
    o[15] = 1;
    return o;
  }

  const HOOKS = ['useProgram', 'bindFramebuffer', 'viewport', 'scissor', 'enable', 'disable', 'activeTexture', 'bindTexture',
    'uniformMatrix4fv', 'uniform1i', 'uniform1iv', 'drawBuffers', 'framebufferTexture2D', 'framebufferRenderbuffer', 'texImage2D',
    'generateMipmap', 'clear', 'clearBufferfv', 'clearBufferiv', 'clearBufferuiv', 'clearBufferfi', 'blitFramebuffer',
    'drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements'];
  function hook(st) {
    const g = st.g, rec = st.rec;
    for (const name of HOOKS) {
      const o = rec.base[name], h = HANDLERS[name];
      if (typeof o !== 'function' || !h) continue;
      rec.slot[name] = (self, args) => {
        if (g.internal > 0 || st.dead) return apply(o, self, args);
        if (DEV) g.calls[name] = (g.calls[name] || 0) + 1;
        return h(st, o, self, args);
      };
    }
  }
  function unhook(st) {
    unvirtualizeBuffer(st);
    for (const name of HOOKS) delete st.rec.slot[name];
  }
  const live = (st) => st.active && !st.releasing;

  const HANDLERS = {
    useProgram(st, o, gl, a) { st.g.prog = a[0]; return apply(o, gl, a); },
    bindFramebuffer(st, o, gl, a) {
      const g = st.g;
      if (a[0] === FRAMEBUFFER || a[0] === DRAW_FB) g.dfb = a[1];
      if (a[0] === FRAMEBUFFER || a[0] === READ_FB) g.rfb = a[1];
      return apply(o, gl, a);
    },
    viewport(st, o, gl, a) { const v = st.g.vp; v[0] = a[0]; v[1] = a[1]; v[2] = a[2]; v[3] = a[3]; return apply(o, gl, a); },
    scissor(st, o, gl, a) { const v = st.g.sc; v[0] = a[0]; v[1] = a[1]; v[2] = a[2]; v[3] = a[3]; return apply(o, gl, a); },
    enable(st, o, gl, a) { if (a[0] === SCISSOR_TEST) st.g.scOn = true; return apply(o, gl, a); },
    disable(st, o, gl, a) { if (a[0] === SCISSOR_TEST) st.g.scOn = false; return apply(o, gl, a); },
    activeTexture(st, o, gl, a) { st.g.unit = a[0] - TEXTURE0; return apply(o, gl, a); },
    bindTexture(st, o, gl, a) { if (a[0] === TEXTURE_2D) st.g.units[st.g.unit] = a[1]; return apply(o, gl, a); },
    uniformMatrix4fv(st, o, gl, a) {
      const g = st.g, loc = a[0], d = a[2];
      if (g.prog && loc && d && typeof d.length === 'number') {
        const off = a[3] | 0, len = a[4] ? a[4] : d.length - off;
        const pi = progInfo(st, g.prog);
        if (len === 16) {
          let e = pi.clip.get(loc) || pi.aff.get(loc);
          const m = e ? e.m : new Float32Array(16);
          for (let i = 0; i < 16; i++) m[i] = d[off + i];
          if (a[1]) { for (let r = 0; r < 4; r++) for (let c = r + 1; c < 4; c++) { const x = m[c * 4 + r]; m[c * 4 + r] = m[r * 4 + c]; m[r * 4 + c] = x; } }
          const kind = classify(m);
          if (kind === 'P' || kind === 'clip') { pi.aff.delete(loc); if (!e || e.kind !== kind || !pi.clip.has(loc)) pi.clip.set(loc, e = { m, kind, vs: inVS(st, pi, loc) }); }
          else { pi.clip.delete(loc); if (kind === 'rigid' && inVS(st, pi, loc)) pi.aff.set(loc, e = { m, kind }); else pi.aff.delete(loc); }
        } else { pi.clip.delete(loc); pi.aff.delete(loc); }
      }
      return apply(o, gl, a);
    },
    uniform1i(st, o, gl, a) {
      const g = st.g;
      if (g.prog && a[0]) { const pi = progInfo(st, g.prog), name = st.rec.loc.get(a[0]); if (name !== undefined && pi.samplers.has(name)) pi.units.set(name, a[1] | 0); }
      return apply(o, gl, a);
    },
    uniform1iv(st, o, gl, a) {
      const g = st.g;
      if (g.prog && a[0] && a[1]) {
        const pi = progInfo(st, g.prog), name = st.rec.loc.get(a[0]);
        if (name !== undefined) { const base = name.replace(/\[0\]$/, ''); for (let i = 0; i < a[1].length; i++) { const n = i === 0 && pi.samplers.has(name) ? name : `${base}[${i}]`; if (pi.samplers.has(n)) pi.units.set(n, a[1][i] | 0); } }
      }
      return apply(o, gl, a);
    },
    drawBuffers(st, o, gl, a) {
      const g = st.g;
      if (g.dfb) { g.drawBufs.set(g.dfb, Array.from(a[0])); const t = g.twinFbos.get(g.dfb); if (t) { g.internal++; try { GL2.bindFramebuffer.call(gl, DRAW_FB, t); GL2.drawBuffers.call(gl, a[0]); GL2.bindFramebuffer.call(gl, DRAW_FB, g.dfb); } finally { g.internal--; } } }
      return apply(o, gl, a);
    },
    framebufferTexture2D(st, o, gl, a) { return refb(st, o, gl, a); },
    framebufferRenderbuffer(st, o, gl, a) { return refb(st, o, gl, a); },
    texImage2D(st, o, gl, a) {
      const r = apply(o, gl, a);
      const g = st.g, tex = g.units[g.unit];
      const tw = tex && g.twins.get(tex);
      if (tw && a[0] === TEXTURE_2D && a.length >= 8 && typeof a[3] === 'number') {
        g.internal++;
        try { GL2.bindTexture.call(gl, TEXTURE_2D, tw); GL2.texImage2D.call(gl, TEXTURE_2D, a[1], a[2], a[3], a[4], 0, a[6], a[7], null); GL2.bindTexture.call(gl, TEXTURE_2D, tex); } finally { g.internal--; }
        g.fbos = new WeakMap(); // sizes changed: re-read every framebuffer
      }
      return r;
    },
    generateMipmap(st, o, gl, a) {
      const r = apply(o, gl, a);
      const g = st.g, tex = g.units[g.unit], tw = tex && a[0] === TEXTURE_2D && g.twins.get(tex);
      if (tw && live(st)) { g.internal++; try { GL2.bindTexture.call(gl, TEXTURE_2D, tw); GL2.generateMipmap.call(gl, TEXTURE_2D); GL2.bindTexture.call(gl, TEXTURE_2D, tex); } finally { g.internal--; } }
      return r;
    },
    clear(st, o, gl, a) { return onClear(st, o, gl, a); },
    clearBufferfv(st, o, gl, a) { return onClear(st, o, gl, a); },
    clearBufferiv(st, o, gl, a) { return onClear(st, o, gl, a); },
    clearBufferuiv(st, o, gl, a) { return onClear(st, o, gl, a); },
    clearBufferfi(st, o, gl, a) { return onClear(st, o, gl, a); },
    blitFramebuffer(st, o, gl, a) { return onBlit(st, o, gl, a); },
    drawArrays(st, o, gl, a) { return onDraw(st, o, gl, a); },
    drawElements(st, o, gl, a) { return onDraw(st, o, gl, a); },
    drawArraysInstanced(st, o, gl, a) { return onDraw(st, o, gl, a); },
    drawElementsInstanced(st, o, gl, a) { return onDraw(st, o, gl, a); },
    drawRangeElements(st, o, gl, a) { return onDraw(st, o, gl, a); },
  };
  function refb(st, o, gl, a) {
    const r = apply(o, gl, a);
    const g = st.g, fb = a[0] === READ_FB ? g.rfb : g.dfb;
    if (g.trace) g.trace.push({ attach: `${fb ? idOf(fb) : '-'} ${a[1].toString(16)} <- ${a[3] ? idOf(a[3]) : 'null'}` });
    if (fb) {
      g.fbos.delete(fb);
      const t = g.twinFbos.get(fb);
      if (t) { g.twinFbos.delete(fb); g.internal++; try { gl.deleteFramebuffer(t); } finally { g.internal--; } }
      if (g.chain.has(fb)) { g.chain.delete(fb); markChainLater(st, fb); }
    }
    return r;
  }
  function markChainLater(st, fb) { (st.rechain || (st.rechain = new Set())).add(fb); }

  function noteScreen(st) {
    const g = st.g;
    g.pres = true;
    if (!g.queued) { g.queued = true; queueMicrotask(() => { g.queued = false; frameEnd(st); }); }
  }
  function frameEnd(st) {
    const g = st.g;
    if (!g.pres || st.dead) return;
    g.pres = false;
    const f = g.frame;
    g.frames++;
    if (f.cam > 0) { g.camFrames++; g.lastCamFrame = g.frames; }
    g.lastViewports = f.vps.size;
    st.lastFrame = f;
    g.frame = newFrame();
    if (g.trace) { st.lastTrace = g.trace; g.trace = null; }
    if (g.traceNext) { g.traceNext = false; g.trace = []; }
    orbitTick(st);
    if (!st.active) {
      if (!st.pending && !st.armed) st.L = { w: realW(st.canvas), h: realH(st.canvas), pr: 1 };
      core.considerActivation(st);
      if (st.pending || st.armed) copyBuffer(st, 'mono');
      if (st.armed) core.flip(st);
      return;
    }
    if (st.releasing) return;
    if (g.scrDirty) { g.scrDirty = false; composeScreens(st); }
    copyBuffer(st, 'copy');
    g.drewSince = true;
    if (f.cam > 0 && f.doubled > 0) {
      if (st.haveViews) st.stats.stereo++;
      else { st.stats.flat++; if (st.stats.twoView > 0) st.stats.flatAfterEyes++; }
    }
    core.drew(st);
    if (st.outCoverDue) { g.internal++; st.depth++; try { core.takeOutCover(st); } finally { st.depth--; g.internal--; } }
  }

  function onDraw(st, o, gl, a) {
    const g = st.g, f = g.frame;
    f.draws++;
    const tgt = g.dfb, prog = g.prog;
    if (!prog) return apply(o, gl, a);
    const pi = progInfo(st, prog);
    let chain = false, fi = null;
    if (tgt) {
      chain = g.chain.has(tgt);
      if (!chain) {
        fi = fboInfo(st, tgt);
        const aspect = fi.w > 0 ? fi.w / fi.h : 1;
        const cam = pi.clip.size ? GLX.cameraOf(st, pi, aspect) : st.camBuf;
        if ((cam.length && GLX.isSeedTarget(st, fi)) || samplesChain(st, pi) || (st.rechain && st.rechain.has(tgt))) { markChain(st, tgt); chain = true; if (st.rechain) st.rechain.delete(tgt); }
      }
    } else noteScreen(st);
    if (chain) { const i3 = fi || (fi = fboInfo(st, tgt)); for (const e of i3.atts) if (e.kind === 'tex' && !g.chainTex.has(e.obj)) { g.chainTex.add(e.obj); g.texFbo.set(e.obj, tgt); } }
    let aspect = st.L.w / (st.L.h || 1);
    if (tgt) { const i2 = fi || fboInfo(st, tgt); if (i2.w > 0 && i2.h > 0) aspect = i2.w / i2.h; } else if (g.vp[2] > 0 && g.vp[3] > 0) aspect = g.vp[2] / g.vp[3];
    const cam = pi.clip.size && (chain || !tgt) ? GLX.cameraOf(st, pi, aspect) : (st.camBuf.length = 0, st.camBuf);
    if (DEV && pi.clip.size && f.draws < 4000) { // diagnostics (dev builds only) (state().renderers[].gl.last.clip): what projecting matrices the draws carry, per target size
      const key = (tgt ? `${(fi || fboInfo(st, tgt)).w}x${(fi || fboInfo(st, tgt)).h}` : 'screen') + (chain ? '*' : '');
      for (const e of pi.clip.values()) { const k = `${key} ${e.kind}${e.vs ? '' : '(fs)'} ${(e.kind === 'P' ? Math.abs(e.m[5] / (e.m[0] || 1)) : Math.hypot(e.m[1], e.m[5], e.m[9]) / (Math.hypot(e.m[0], e.m[4], e.m[8]) || 1)).toFixed(3)}`; f.clip[k] = (f.clip[k] || 0) + 1; }
    }
    if (cam.length) {
      f.cam++;
      f.vps.add((tgt ? 'fb:' : 'screen:') + g.vp.join(','));
      if (tgt) f.camChain++; else f.camScreen++;
      noteAff(st, pi);
      for (let i = 1; i < cam.length; i += 2) if (cam[i].kind === 'P') { const m = cam[i].m; if (!g.P || !arrEq(g.P, m)) { g.P = Float32Array.from(m); g.Pinv = null; } g.Pframe = g.frames; break; }
      noteOrigin(st, pi, cam);
    }
    if (g.trace) g.trace.push({ p: pi.id, t: tgt ? idOf(tgt) : 'screen', sz: tgt ? `${(fi || fboInfo(st, tgt)).w}x${(fi || fboInfo(st, tgt)).h}` : '', chain, cam: cam.length / 2, tw: tgt ? !!g.twinFbos.get(tgt) : null, nt: tgt ? g.noTwin.has(tgt) : null, att: tgt ? (fi || fboInfo(st, tgt)).atts.map((e) => `${e.a.toString(16)}:${idOf(e.obj)}`).join(' ') : '',
      s: [...pi.units.entries()].map(([n, u]) => { const tx = g.units[u]; return `${n}@${u}:${tx ? idOf(tx) : '-'}${tx && g.chainTex.has(tx) ? (g.twins.get(tx) ? '*T' : '*') : ''}${tx && !g.chainTex.has(tx) ? '[' + Object.prototype.toString.call(tx) + ' fb=' + (g.texFbo.get(tx) ? idOf(g.texFbo.get(tx)) : '-') + ']' : ''}`; }).join(' '), at3: tgt ? (fi || fboInfo(st, tgt)).atts.map((e) => `${e.kind}:${idOf(e.obj)}:${g.chainTex.has(e.obj)}`).join(' ') : '' });
    if (!live(st) || (tgt && !chain) || GLX.single(st, pi, tgt)) { f.single++; return apply(o, gl, a); }
    f.doubled++; if (!tgt) f.screen++;
    const twin = tgt ? twinFbo(st, tgt) : null;
    if (tgt && !twin) { f.single++; return apply(o, gl, a); }
    const scr = tgt ? null : eyeScreens(st);
    if (!tgt && !scr) { f.single++; return apply(o, gl, a); }
    const swaps = chainUnits(st, pi);
    g.internal++;
    let res;
    try {
      for (let i = 0; i < 2; i++) {
        for (let j = 0; j < cam.length; j += 2) GL2.uniformMatrix4fv.call(gl, cam[j], false, eyeMatrix(st, i, cam[j + 1], pi));
        if (!tgt) GL2.bindFramebuffer.call(gl, DRAW_FB, scr[i].fb);
        if (i === 1) {
          if (tgt) GL2.bindFramebuffer.call(gl, DRAW_FB, twin);
          for (const u of swaps) { GL2.activeTexture.call(gl, TEXTURE0 + u); GL2.bindTexture.call(gl, TEXTURE_2D, g.twins.get(g.units[u]) || g.units[u]); }
          if (swaps.length) GL2.activeTexture.call(gl, TEXTURE0 + g.unit);
        }
        res = apply(o, gl, a);
      }
    } finally {
      for (let j = 0; j < cam.length; j += 2) GL2.uniformMatrix4fv.call(gl, cam[j], false, cam[j + 1].m);
      GL2.bindFramebuffer.call(gl, DRAW_FB, tgt);
      if (swaps.length) { for (const u of swaps) { GL2.activeTexture.call(gl, TEXTURE0 + u); GL2.bindTexture.call(gl, TEXTURE_2D, g.units[u]); } GL2.activeTexture.call(gl, TEXTURE0 + g.unit); }
      g.internal--;
    }
    if (!tgt) g.scrDirty = true;
    return res;
  }
  const ids = new WeakMap(); let nid = 0;
  const idOf = (o) => { let i = ids.get(o); if (!i) ids.set(o, (i = ++nid)); return i; };
  const arrEq = (a, b) => { for (let i = 0; i < 16; i++) if (a[i] !== b[i]) return false; return true; };
  function chainUnits(st, pi) {
    const g = st.g, out = [];
    for (const u of pi.units.values()) { const t = g.units[u]; if (t && g.chainTex.has(t) && g.twins.get(t) && !out.includes(u)) out.push(u); }
    for (const u of pi.units.values()) { const t = g.units[u]; if (t && g.chainTex.has(t) && !g.twins.get(t)) { const fb = g.texFbo.get(t); if (fb && twinFbo(st, fb) && !out.includes(u)) out.push(u); } }
    return out;
  }
  function onClear(st, o, gl, a) {
    const g = st.g, tgt = g.dfb;
    if (!live(st)) return apply(o, gl, a);
    if (tgt) {
      const r = apply(o, gl, a);
      if (g.chain.has(tgt)) {
        const t = twinFbo(st, tgt);
        if (t) { g.internal++; try { GL2.bindFramebuffer.call(gl, DRAW_FB, t); apply(o, gl, a); GL2.bindFramebuffer.call(gl, DRAW_FB, tgt); } finally { g.internal--; } }
      }
      return r;
    }
    const scr = eyeScreens(st);
    if (!scr) return apply(o, gl, a);
    g.internal++;
    try { for (let i = 0; i < 2; i++) { GL2.bindFramebuffer.call(gl, DRAW_FB, scr[i].fb); apply(o, gl, a); } } finally { GL2.bindFramebuffer.call(gl, DRAW_FB, null); g.internal--; }
    g.scrDirty = true;
  }
  function onBlit(st, o, gl, a) {
    const g = st.g, src = g.rfb, dst = g.dfb;
    if (g.trace) g.trace.push({ blit: `${src ? idOf(src) : 'screen'}->${dst ? idOf(dst) : 'screen'}`, mask: a[8], src: [a[0], a[1], a[2], a[3]], dst: [a[4], a[5], a[6], a[7]] });
    if (!dst) noteScreen(st);
    const srcChain = src && g.chain.has(src);
    if (srcChain && dst && !g.chain.has(dst)) { fboInfo(st, dst); markChain(st, dst); }
    if (!live(st)) return apply(o, gl, a);
    if (dst && !srcChain) return apply(o, gl, a);
    if (!dst && !src) return apply(o, gl, a); // the screen onto itself
    const tsrc = srcChain ? twinFbo(st, src) : src, tdst = dst ? twinFbo(st, dst) : null;
    if (dst && (!tsrc || !tdst)) return apply(o, gl, a);
    g.internal++;
    try {
      if (dst) {
        apply(o, gl, a);
        GL2.bindFramebuffer.call(gl, READ_FB, tsrc); GL2.bindFramebuffer.call(gl, DRAW_FB, tdst);
        apply(o, gl, a);
      } else {
        const scr = eyeScreens(st);
        if (!scr) return apply(o, gl, a);
        for (let i = 0; i < 2; i++) {
          if (i === 1 && tsrc) GL2.bindFramebuffer.call(gl, READ_FB, tsrc);
          GL2.bindFramebuffer.call(gl, DRAW_FB, scr[i].fb);
          apply(o, gl, a);
        }
        g.scrDirty = true;
      }
    } finally { GL2.bindFramebuffer.call(gl, READ_FB, src); GL2.bindFramebuffer.call(gl, DRAW_FB, dst); g.internal--; }
  }

  function eyeScreens(st) {
    const g = st.g, gl = st.gl;
    const w = Math.max(1, Math.floor(st.L.w)), h = Math.max(1, Math.floor(st.L.h));
    if (g.scr && g.scr[0].w === w && g.scr[0].h === h) return g.scr;
    g.internal++;
    try {
      freeScreens(st);
      const at = gl.getContextAttributes ? gl.getContextAttributes() || {} : {};
      const ds = at.stencil ? 0x88F0 /* DEPTH24_STENCIL8 */ : at.depth !== false ? 0x81A6 /* DEPTH_COMPONENT24 */ : 0;
      const prevT = g.units[g.unit] || null, prevR = gl.getParameter(RB_BINDING);
      g.scr = [0, 1].map(() => {
        const e = { w, h, ok: true, tex: gl.createTexture(), fb: gl.createFramebuffer(), rb: ds ? gl.createRenderbuffer() : null };
        GL2.bindTexture.call(gl, TEXTURE_2D, e.tex);
        GL2.texStorage2D.call(gl, TEXTURE_2D, 1, at.alpha === false ? 0x8051 /* RGB8 */ : 0x8058 /* RGBA8 */, w, h);
        GL2.texParameteri.call(gl, TEXTURE_2D, MIN_FILTER, LINEAR); GL2.texParameteri.call(gl, TEXTURE_2D, MAG_FILTER, LINEAR);
        GL2.bindFramebuffer.call(gl, DRAW_FB, e.fb);
        GL2.framebufferTexture2D.call(gl, DRAW_FB, COLOR_ATT0, TEXTURE_2D, e.tex, 0);
        if (e.rb) {
          GL2.bindRenderbuffer.call(gl, RENDERBUFFER, e.rb);
          GL2.renderbufferStorage.call(gl, RENDERBUFFER, ds, w, h);
          GL2.framebufferRenderbuffer.call(gl, DRAW_FB, ds === 0x88F0 ? DEPTH_STENCIL_ATT : DEPTH_ATT, RENDERBUFFER, e.rb);
        }
        return e;
      });
      GL2.bindTexture.call(gl, TEXTURE_2D, prevT); GL2.bindRenderbuffer.call(gl, RENDERBUFFER, prevR);
      GL2.bindFramebuffer.call(gl, DRAW_FB, g.dfb);
      return g.scr;
    } catch (e) { warnOnce('gl-scr', 'GL-level: could not make the eyes\' screens', e); g.scr = null; return null; } finally { g.internal--; }
  }
  function freeScreens(st) {
    const g = st.g, gl = st.gl;
    if (!g.scr) return;
    for (const e of g.scr) { try { gl.deleteTexture(e.tex); gl.deleteFramebuffer(e.fb); if (e.rb) gl.deleteRenderbuffer(e.rb); } catch (x) { /* ignore */ } }
    g.scr = null;
  }
  function composeScreens(st) {
    const scr = st.g.scr, R = st.R;
    if (!scr || !R) return;
    paint(st, scr[0], 0, 0, scr[0].w, scr[0].h, 0, 0, R.eyeW, R.eyeH);
    paint(st, scr[1], 0, 0, scr[1].w, scr[1].h, R.eyeW, 0, 2 * R.eyeW, R.eyeH);
  }

  function copyBuffer(st, which) {
    const g = st.g, gl = st.gl;
    const w = GL2_DBW(gl), h = GL2_DBH(gl);
    if (!(w > 0 && h > 0)) return;
    let c = g[which];
    g.internal++;
    try {
      if (!c || c.w !== w || c.h !== h) {
        if (c) { gl.deleteTexture(c.tex); gl.deleteFramebuffer(c.fb); }
        c = g[which] = { w, h, tex: gl.createTexture(), fb: gl.createFramebuffer(), ok: false };
        const prevT = g.units[g.unit] || null;
        GL2.bindTexture.call(gl, TEXTURE_2D, c.tex);
        GL2.texStorage2D.call(gl, TEXTURE_2D, 1, 0x8058 /* RGBA8 */, w, h);
        GL2.bindTexture.call(gl, TEXTURE_2D, prevT);
        GL2.bindFramebuffer.call(gl, DRAW_FB, c.fb);
        GL2.framebufferTexture2D.call(gl, DRAW_FB, COLOR_ATT0, TEXTURE_2D, c.tex, 0);
      }
      GL2.bindFramebuffer.call(gl, READ_FB, null); GL2.bindFramebuffer.call(gl, DRAW_FB, c.fb);
      const sc = g.scOn; if (sc) GL2.disable.call(gl, SCISSOR_TEST);
      GL2.blitFramebuffer.call(gl, 0, 0, w, h, 0, 0, w, h, COLOR_BIT, NEAREST);
      if (sc) GL2.enable.call(gl, SCISSOR_TEST);
      c.ok = true;
    } catch (e) { warnOnce('gl-copy', 'GL-level: could not copy the screen', e); } finally {
      GL2.bindFramebuffer.call(gl, READ_FB, g.rfb); GL2.bindFramebuffer.call(gl, DRAW_FB, g.dfb); g.internal--;
    }
  }
  function paint(st, c, sx0, sy0, sx1, sy1, dx0, dy0, dx1, dy1) {
    const g = st.g, gl = st.gl;
    if (!c || !c.ok) return false;
    g.internal++;
    try {
      if (!msaa(st)) {
        GL2.bindFramebuffer.call(gl, READ_FB, c.fb); GL2.bindFramebuffer.call(gl, DRAW_FB, null);
        const sc = g.scOn; if (sc) GL2.disable.call(gl, SCISSOR_TEST);
        GL2.blitFramebuffer.call(gl, sx0, sy0, sx1, sy1, dx0, dy0, dx1, dy1, COLOR_BIT, (sx1 - sx0 === dx1 - dx0 && sy1 - sy0 === dy1 - dy0) ? NEAREST : LINEAR);
        if (sc) GL2.enable.call(gl, SCISSOR_TEST);
        GL2.bindFramebuffer.call(gl, READ_FB, g.rfb); GL2.bindFramebuffer.call(gl, DRAW_FB, g.dfb);
      } else quad(st, c, sx0 / c.w, sy0 / c.h, sx1 / c.w, sy1 / c.h, dx0, dy0, dx1, dy1);
      return true;
    } catch (e) { warnOnce('gl-paint', 'GL-level: could not repaint the screen', e); return false; } finally { g.internal--; }
  }
  const msaa = (st) => { if (st.msaa === undefined) { const at = st.gl.getContextAttributes && st.gl.getContextAttributes(); st.msaa = !!(at && at.antialias); } return st.msaa; };
  function quad(st, c, u0, v0, u1, v1, dx0, dy0, dx1, dy1) {
    const gl = st.gl;
    if (!st.qp) {
      const vs = '#version 300 es\nuniform vec4 r;out vec2 uv;void main(){vec2 p=vec2(float(gl_VertexID&1),float(gl_VertexID>>1))*2.0;uv=mix(r.xy,r.zw,p);gl_Position=vec4(p*2.0-1.0,0.0,1.0);}';
      const fs = '#version 300 es\nprecision mediump float;uniform sampler2D t;in vec2 uv;out vec4 o;void main(){o=texture(t,uv);}';
      const mk = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
      const p = gl.createProgram(); gl.attachShader(p, mk(VERTEX_SHADER, vs)); gl.attachShader(p, mk(0x8B30, fs)); gl.linkProgram(p);
      st.qp = { p, r: GL2.getUniformLocation.call(gl, p, 'r'), t: GL2.getUniformLocation.call(gl, p, 't'), vao: gl.createVertexArray() };
    }
    const q = st.qp;
    const caps = [0x0BE2 /* BLEND */, 0x0B71 /* DEPTH_TEST */, 0x0B90 /* STENCIL_TEST */, 0x0B44 /* CULL_FACE */, SCISSOR_TEST, 0x8C89 /* RASTERIZER_DISCARD */];
    const was = caps.map((k) => gl.isEnabled(k));
    const vao = gl.getParameter(0x85B5 /* VERTEX_ARRAY_BINDING */), prog = gl.getParameter(CURRENT_PROGRAM), at = gl.getParameter(ACTIVE_TEXTURE);
    const cm = gl.getParameter(0x0C23 /* COLOR_WRITEMASK */), vp = gl.getParameter(VIEWPORT), dfb = gl.getParameter(FB_BINDING);
    GL2.activeTexture.call(gl, TEXTURE0); const t0 = gl.getParameter(TEX_BINDING_2D), s0 = gl.getParameter(0x8919 /* SAMPLER_BINDING */);
    try {
      for (const k of caps) gl.disable(k);
      gl.colorMask(true, true, true, true);
      GL2.bindFramebuffer.call(gl, DRAW_FB, null);
      gl.bindVertexArray(q.vao); GL2.useProgram.call(gl, q.p);
      GL2.bindTexture.call(gl, TEXTURE_2D, c.tex); gl.bindSampler(0, null);
      gl.uniform4f(q.r, u0, v0, u1, v1); GL2.uniform1i.call(gl, q.t, 0);
      GL2.viewport.call(gl, dx0, dy0, dx1 - dx0, dy1 - dy0);
      GL2.drawArrays.call(gl, 0x0005 /* TRIANGLE_STRIP */, 0, 4);
    } finally {
      caps.forEach((k, i) => (was[i] ? gl.enable(k) : gl.disable(k)));
      gl.colorMask(cm[0], cm[1], cm[2], cm[3]);
      GL2.bindTexture.call(gl, TEXTURE_2D, t0); gl.bindSampler(0, s0); GL2.activeTexture.call(gl, at);
      gl.bindVertexArray(vao); GL2.useProgram.call(gl, prog);
      GL2.viewport.call(gl, vp[0], vp[1], vp[2], vp[3]); GL2.bindFramebuffer.call(gl, DRAW_FB, dfb);
    }
  }
  const DBW = GL2 && Object.getOwnPropertyDescriptor(GL2, 'drawingBufferWidth');
  const DBH = GL2 && Object.getOwnPropertyDescriptor(GL2, 'drawingBufferHeight');
  const GL2_DBW = (gl) => (DBW ? DBW.get.call(gl) : gl.drawingBufferWidth);
  const GL2_DBH = (gl) => (DBH ? DBH.get.call(gl) : gl.drawingBufferHeight);
  function virtualizeBuffer(st) {
    const gl = st.gl, g = st.g;
    const def = (k, D) => { try { Object.defineProperty(gl, k, { configurable: true, enumerable: false, get() { return g.internal > 0 || st.depth > 0 || !st.active ? D.get.call(this) : Math.floor(k === 'drawingBufferWidth' ? st.L.w : st.L.h); } }); } catch (e) { /* ignore */ } };
    if (DBW) def('drawingBufferWidth', DBW);
    if (DBH) def('drawingBufferHeight', DBH);
  }
  function unvirtualizeBuffer(st) { try { delete st.gl.drawingBufferWidth; delete st.gl.drawingBufferHeight; } catch (e) { /* ignore */ } }

  function noteOrigin(st, pi, cam) {
    const o = st.g.origins;
    if (o.length >= 512) return;
    for (let j = 1; j < cam.length; j += 2) {
      const e = cam[j];
      if (e.kind === 'clip' && e.m[15] > 0) { o.push(0, 0, -e.m[15]); return; }
      let best = null;
      for (const a of pi.aff.values()) if (-a.m[14] > 0 && (!best || -a.m[14] > -best[14])) best = a.m;
      if (best) { o.push(best[12], best[13], best[14]); return; }
    }
  }
  function orbitTick(st) {
    const g = st.g;
    const cur = new Map();
    for (const [k, m] of g.aff) cur.set(k, m);
    g.aff = new Map();
    const prev = g.affPrev;
    g.affPrev = cur;
    if (!cur.size) { g.ow = 'no rigid matrices'; return; }
    const D = prev ? motion(cur, prev) : null;
    if (D && g.tgt) { const p = g.tgt; g.tgt = [D[0] * p[0] + D[4] * p[1] + D[8] * p[2] + D[12], D[1] * p[0] + D[5] * p[1] + D[9] * p[2] + D[13], D[2] * p[0] + D[6] * p[1] + D[10] * p[2] + D[14]]; }
    if (!g.affRef || g.frames - g.affRefAt > 90) { g.affRef = cur; g.affRefAt = g.frames; return; }
    const A = motion(cur, g.affRef);
    if (!A) { g.ow = `no motion (${cur.size} keys)`; return; }
    const u = [A[8], A[9], A[10] - 1], t = [A[12], A[13], A[14]];
    const uu = u[0] * u[0] + u[1] * u[1] + u[2] * u[2];
    if (uu < 1e-4) return; // under ~0.6 degrees since the reference: keep accumulating
    g.affRef = cur; g.affRefAt = g.frames;
    const d = (t[0] * u[0] + t[1] * u[1] + t[2] * u[2]) / uu;
    if (!(d > 0)) { g.ow = `pivot behind (d ${d.toPrecision(3)})`; return; }
    const res = Math.hypot(t[0] - d * u[0], t[1] - d * u[1], t[2] - d * u[2]);
    g.ow = `turn: d ${d.toPrecision(4)} res ${(res / (d * Math.sqrt(uu))).toFixed(3)}`;
    if (res > 0.15 * d * Math.sqrt(uu)) return; // not a turn about a point of the axis (a walk, a pan + turn)
    g.tgt = g.tgt && Math.abs(g.tgt[0]) + Math.abs(g.tgt[1]) < 0.05 * d ? [0, 0, g.tgt[2] + 0.5 * (-d - g.tgt[2])] : [0, 0, -d];
    g.tgtAt = now();
  }
  function motion(cur, prev) {
    const deltas = [];
    for (const [k, m] of cur) {
      const p = prev.get(k);
      if (!p) continue;
      deltas.push(mul4(m, invAffine(p), new Float32Array(16)));
      if (deltas.length >= 12) break;
    }
    const moving = deltas.filter((D) => Math.abs(D[12]) + Math.abs(D[13]) + Math.abs(D[14]) + Math.abs(D[8]) + Math.abs(D[9]) + Math.abs(D[10] - 1) > 1e-6);
    if (!moving.length) return null;
    let D = moving[0], votes = -1;
    for (const a of moving) {
      let v = 0;
      for (const b of moving) { let d = 0; for (let i = 0; i < 16; i++) d += Math.abs(a[i] - b[i]); if (d < 1e-3 * (1 + Math.abs(a[14]))) v++; }
      if (v > votes) { votes = v; D = a; }
    }
    return D;
  }
  function invAffine(m) {
    const s2 = m[0] * m[0] + m[1] * m[1] + m[2] * m[2] || 1;
    const o = invRigid(m, new Float32Array(16));
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[i * 4 + j] /= s2;
    o[12] /= s2; o[13] /= s2; o[14] /= s2;
    return o;
  }
  function orbitTarget(st) {
    const t = st.g.tgt;
    return t ? { x: t[0], y: t[1], z: t[2], via: 'orbit pivot (the camera\'s own motion)' } : null;
  }
  function noteAff(st, pi) {
    const g = st.g;
    if (g.aff.size >= 24) return;
    for (const [loc, e] of pi.aff) { const k = pi.id + ':' + (st.rec.loc.get(loc) || '?'); if (!g.aff.has(k)) g.aff.set(k, Float32Array.from(e.m)); }
  }

  const ad = {
    label: () => 'WebGL2 (GL level)',
    unqualified(st) {
      if (st.dead) return st.flatReason || 'left';
      const g = st.g;
      if (core.claims(st.canvas, ENGINE)) { retire(st, 'an engine adapter claimed the canvas'); return 'an engine adapter claimed the canvas'; }
      const where = core.canvasPlacement(st.canvas);
      if (where) return where;
      if (g.frames < 3) return `watching the WebGL stream (${g.frames} frames so far)`;
      if (g.lastCamFrame < 0 || g.frames - g.lastCamFrame > 30) return 'no perspective camera draw seen at the WebGL level (a 2D / orthographic canvas)';
      if (!g.P && !(st.lastFrame && st.lastFrame.cam)) return 'no camera projection recognised';
      if (g.lastViewports > 1) return 'the screen is drawn in several viewports';
      if (!(st.L.w > 0 && st.L.h > 0)) return 'canvas has no size yet';
      return core.cssEffect(st.canvas);
    },
    hasCamera: (st) => !!st.g.P || (st.g.frames - st.g.lastCamFrame) < 120,
    depthRange: (st) => { const P = st.g.P; if (!P) return { near: 0.1, far: 1000 }; const f = frustumOf(P); return { near: f.near * NEAR_LOOSEN, far: f.far }; },
    rigFov: (st) => (st.g.P ? frustumOf(st.g.P).fov : Math.PI / 4),
    sampler(st) {
      const P = st.g.P;
      if (!P) return null;
      const f = frustumOf(P);
      const pts = st.g.origins.slice();
      st.g.origins.length = 0;
      if (pts.length) st.lastOrigins = pts; // the last frames that had any
      const use = pts.length ? pts : st.lastOrigins || [];
      return {
        cameraPose: IDENT, viewMatrix: IDENT, tanHalfFov: f.tan, aspect: f.aspect, near: f.near * NEAR_LOOSEN, far: f.far,
        forEachBounds(cb) { for (let i = 0; i < use.length; i += 3) if (cb(use[i], use[i + 1], use[i + 2], 0) === false) return; },
      };
    },
    target: (st) => GLX.target(st),
    fakeViewParams(st) { const f = frustumOf(st.g.P || IDENT); return { near: f.near, far: f.far, t: f.near * f.tan, aspect: st.L.w / (st.L.h || 1) }; },
    beforeActive(st) {
      st.L = { w: realW(st.canvas), h: realH(st.canvas), pr: 1 };
      core.virtualizeCanvas(st, () => { if (applyRealSize(st)) repaint(st); });
    },
    afterActive(st) {
      st.made = st.made || [];
      applyRealSize(st);
      virtualizeBuffer(st);
    },
    firstDraw(st) {
      const c = st.g.mono, R = st.R;
      if (!c) return;
      paint(st, c, 0, 0, c.w, c.h, 0, 0, R.eyeW, R.eyeH);
      paint(st, c, 0, 0, c.w, c.h, R.eyeW, 0, 2 * R.eyeW, R.eyeH);
      copyBuffer(st, 'copy');
      core.drew(st);
    },
    redraw(st) {
      const g = st.g;
      if (g.drewSince) { g.drewSince = false; return; }
      const c = g.copy, R = st.R;
      if (!c || !R || c.w !== R.W || c.h !== R.H) return;
      if (paint(st, c, 0, 0, c.w, c.h, 0, 0, c.w, c.h)) {
        st.stats.replays++;
        core.drew(st);
        if (st.outCoverDue) { g.internal++; st.depth++; try { core.takeOutCover(st); } finally { st.depth--; g.internal--; } }
      }
    },
    coverAfterDraw: true,
    surface: (st) => core.surfaces.gl(st.gl),
    restore(st, wasLive) {
      const g = st.g, gl = st.gl;
      core.unvirtualizeCanvas(st);
      unvirtualizeBuffer(st);
      if (wasLive) {
        st.depth++;
        try {
          const c = g.copy, R = st.R;
          const w = Math.floor(st.L.w), h = Math.floor(st.L.h);
          if (realW(st.canvas) !== w) CANVAS_W.set.call(st.canvas, w);
          if (realH(st.canvas) !== h) CANVAS_H.set.call(st.canvas, h);
          if (c && R) paint(st, c, 0, 0, Math.min(R.eyeW, c.w), Math.min(R.eyeH, c.h), 0, 0, w, h);
        } catch (e) { /* the page's next frame repaints */ } finally { st.depth--; }
      }
      disposeTwins(st);
      freeScreens(st);
      g.copy = null;
      return true;
    },
    flipIdle(st) {
      if (!st.armed || !st.g.mono) return;
      const c = st.g.mono;
      paint(st, c, 0, 0, c.w, c.h, 0, 0, c.w, c.h); // the page's last frame back on the screen: the cover is taken from it
      core.flip(st);
    },
    wake(st) {
      const c = st.g.mono || st.g.copy;
      if (!c || st.active) return;
      paint(st, c, 0, 0, c.w, c.h, 0, 0, GL2_DBW(st.gl), GL2_DBH(st.gl));
      noteScreen(st);
    },
    describe: (st) => ({
      page: { w: st.L.w, h: st.L.h, pr: 1, canvasWidthSeenByPage: st.canvas.width },
      extra: { gl: glStats(st) },
    }),
  };
  function glStats(st) {
    const g = st.g, f = st.lastFrame || newFrame();
    return {
      frames: g.frames, camFrames: g.camFrames, calls: g.calls, P: g.P ? Array.from(g.P, (x) => +x.toPrecision(5)) : null,
      last: { clip: f.clip, draws: f.draws, cam: f.cam, camScreen: f.camScreen, camChain: f.camChain, doubled: f.doubled, single: f.single, screen: f.screen, viewports: [...f.vps] },
      ow: g.ow, affKeys: g.affPrev ? [...g.affPrev.keys()] : null, twins: (st.made || []).length, target: g.tgt ? g.tgt.map((x) => +x.toPrecision(4)) : null, msaa: st.msaa === undefined ? null : st.msaa,
    };
  }
  function applyRealSize(st) {
    const R = core.realSizeFor(st);
    st.R = R;
    if (realW(st.canvas) === R.W && realH(st.canvas) === R.H) return false;
    st.stats.resizes++;
    st.depth++;
    try { CANVAS_W.set.call(st.canvas, R.W); CANVAS_H.set.call(st.canvas, R.H); } finally { st.depth--; }
    return true;
  }
  function repaint(st) {
    const c = st.g.copy, R = st.R;
    if (c && R) paint(st, c, 0, 0, c.w, c.h, 0, 0, R.W, R.H);
  }

  if (core.cfg.dev) {
    window.__dxrGlState = () => [...states.values()][0];
    window.__dxrGlId = (o) => idOf(o);
    window.__dxrGlTrace = (fetch) => { for (const st of states.values()) { if (fetch) return st.lastTrace || null; st.g.traceNext = true; } return null; };
    window.__dxrGlGrab = (which) => {
      for (const st of states.values()) {
        const c = st.g[which || 'copy'];
        if (!c || !c.ok) continue;
        const gl = st.gl, g = st.g, px = new Uint8Array(c.w * c.h * 4);
        g.internal++;
        try {
          GL2.bindFramebuffer.call(gl, READ_FB, c.fb);
          gl.readPixels(0, 0, c.w, c.h, 0x1908 /* RGBA */, 0x1401 /* UNSIGNED_BYTE */, px);
        } finally { GL2.bindFramebuffer.call(gl, READ_FB, g.rfb); g.internal--; }
        const cv = document.createElement('canvas'); cv.width = c.w; cv.height = c.h;
        const id = new ImageData(c.w, c.h), row = c.w * 4;
        for (let y = 0; y < c.h; y++) { id.data.set(px.subarray((c.h - 1 - y) * row, (c.h - y) * row), y * row); }
        for (let i = 3; i < id.data.length; i += 4) id.data[i] = 255;
        cv.getContext('2d').putImageData(id, 0, 0);
        return { w: c.w, h: c.h, png: cv.toDataURL('image/png') };
      }
      return null;
    };
  }
  return { consider, yieldCanvas, GLX, states };
}
return dxrCore(cfg, cap, S);
};
const h = dxrDevHost(() => CORE);
dxrSentinel(h.cfg, h.cap);
})();

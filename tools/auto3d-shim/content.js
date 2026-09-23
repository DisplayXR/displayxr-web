// DisplayXR auto-3D for existing three.js pages — PROTOTYPE, not a product.
//
// Runs in the page's MAIN world at document_start (the same injection tools/immersive-shim uses)
// and turns an ordinary, already-published three.js page into a woven inline-3D window with NO
// change to the page: no SDK import, no WebXR, no source edit.
//
// How it finds three.js on a bundled / minified page: three (r105+) announces every WebGLRenderer
// and Scene it constructs to a global `__THREE_DEVTOOLS__` EventTarget ('observe'), if one exists.
// This script defines it before any page script runs, so every renderer reaches it. render(),
// setSize() & co. are instance properties, so they are wrapped per instance.
//
// What a converted renderer does:
//   - its canvas backing store becomes the side-by-side (SBS) pair the weave expects, while the page
//     keeps seeing its mono size (getSize / getPixelRatio / getViewport / canvas.width … are
//     virtualised, so the common `canvas.width !== clientWidth * dpr` resize check stays quiet);
//   - each render(scene, perspectiveCamera) to the screen becomes one render per eye, into its
//     half, from the eye poses + off-axis projections the session reports (attach pattern:
//     eye world = page camera × view.transform, the rig pose is identity);
//   - anything else aimed at the screen (an ortho HUD pass, a post-processing chain's final quad) is
//     drawn identically into both halves: flat, but never a broken tile;
//   - a camera rig is pushed every session frame from the page camera, with an auto convergence
//     distance and a metersToVirtual that scales with it, so depth reads the same whatever units
//     the scene was authored in (comfort = ipd × m2v × diopters × 0.5 = cfg.depth);
//   - a frame the page did not draw (render-on-demand pages) is replayed from the page's last
//     screen draws, so the tile is redrawn every frame (woven-canvas rules) and head motion still
//     looks around.
//
// It stands down for anything that owns inline-3D itself: an SDK page (requestSession
// 'inline-3d'), a WebXR session (immersive-vr / immersive-ar — tools/immersive-shim serves those),
// a renderer that is presenting through renderer.xr. One inline-3D session per document.
//
// Hotkeys (Ctrl+Alt+…, chosen clear of the immersive shim's): 3 on/off for this site · = / - depth ·
//   0 / 9 convergence farther / nearer · 8 reset · D HUD.
// window.__dxrAuto3D exposes cfg / set(k, v) / state().
(() => {
  'use strict';
  const TAG = '[dxr-auto3d]';
  const VERSION = '0.1.0';
  if (window.__dxrAuto3D) return;
  if (typeof window.XRDisplayLayer !== 'function' || !navigator.xr) return; // not the DisplayXR Browser: inert

  // ------------------------------------------------------------ config (per origin)
  const DEFAULTS = {
    v: 1,
    enabled: true,      // auto-convert qualifying three.js canvases on this origin
    depth: 0.3,         // comfort number ipd×m2v×diopters×0.5 (runtime rule: <= 1). The runtime's qwerty rig sits at 0.25
    convScale: 1,       // multiplier on the auto convergence distance
    eyeScale: 0.5,      // per-eye width / element device width: a 2-view lenticular resolves about half anyway (porting pitfall 26)
    maxSbsWidth: 3072,  // browser-pvt#24: wider SBS canvases drop off the zero-copy weave path
    minCssPx: 120,      // smaller canvases stay flat (icons, thumbnails)
    holdMs: 1200,       // keep the cover this long after the layer exists (woven-canvas rules, rule 5)
    noViewsMs: 4000,    // no 2-view frame this long after the layer -> back to 2D, retry later
    hud: true,
    fakeViews: false,   // TEST ONLY: synthesise a parallel-axis pair when the session reports none
  };
  const LS_KEY = 'dxrAuto3D';
  let cfg = loadCfg();
  function loadCfg() {
    let stored = {};
    try { stored = JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (e) { /* opaque origin */ }
    const base = stored.v === DEFAULTS.v ? { ...DEFAULTS, ...stored } : { ...DEFAULTS };
    const test = window.__dxrAuto3DTestCfg; // harness override, never persisted
    return test && typeof test === 'object' ? { ...base, ...test } : base;
  }
  function saveCfg() {
    try {
      const keep = { v: cfg.v, enabled: cfg.enabled, depth: cfg.depth, convScale: cfg.convScale, hud: cfg.hud };
      localStorage.setItem(LS_KEY, JSON.stringify(keep));
    } catch (e) { /* opaque origin */ }
  }

  // ------------------------------------------------------------ small helpers
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
  const CANVAS_W = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width');
  const CANVAS_H = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'height');
  const realW = (c) => CANVAS_W.get.call(c);
  const realH = (c) => CANVAS_H.get.call(c);
  // A duck-typed Vector2 for three's getSize(target), which only calls target.set().
  const vec2 = () => ({ x: 0, y: 0, set(x, y) { this.x = x; this.y = y; return this; } });

  // ------------------------------------------------------------ document-level state
  const states = new WeakMap(); // renderer -> state
  const tracked = [];           // WeakRef<state>, for state() and the HUD
  let owner = null;             // the one renderer converted (or converting) — one inline-3D session per document
  let foreign = null;           // why we stood down for good in this document (the page owns inline-3D / XR)
  let revision = null;

  // ------------------------------------------------------------ navigator.xr: yield to the page
  // Our own requests go straight to the captured original, so the wrapper only ever sees the
  // page's (or the immersive shim's, which reaches the real XRSystem through this same object).
  const xrObj = navigator.xr;
  const xrReqOrig = xrObj.requestSession;
  const xrRequest = (mode, init) => xrReqOrig.call(xrObj, mode, init);
  try {
    xrObj.requestSession = function (mode, init) {
      if (mode === 'inline-3d' || mode === 'immersive-vr' || mode === 'immersive-ar') yieldTo(`the page requested '${mode}'`);
      return xrReqOrig.call(xrObj, mode, init);
    };
  } catch (e) { warnOnce('xrwrap', 'could not watch navigator.xr.requestSession — SDK pages may conflict', e); }
  function yieldTo(reason) {
    if (!foreign) { foreign = reason; info('standing down for this document:', reason); }
    if (owner) stand(owner, reason);
    hud();
  }

  // ------------------------------------------------------------ the three.js devtools hook
  let devtools = window.__THREE_DEVTOOLS__ || null;
  const onObserve = (e) => {
    const o = e && e.detail;
    if (!o || o.isScene) return;
    if (o.isWebGPURenderer) { warnOnce('webgpu', 'WebGPURenderer seen — not converted by this prototype, left 2D'); return; }
    if (o.isWebGLRenderer || (o.domElement && typeof o.render === 'function' && typeof o.getContext === 'function')) track(o);
  };
  const onRegister = (e) => { if (e && e.detail && e.detail.revision) revision = e.detail.revision; };
  const hooked = new WeakSet();
  const attachHook = (t) => {
    if (!t || typeof t.addEventListener !== 'function' || hooked.has(t)) return;
    hooked.add(t);
    t.addEventListener('observe', onObserve);
    t.addEventListener('register', onRegister);
  };
  if (!devtools) devtools = new EventTarget();
  attachHook(devtools);
  try {
    // An accessor, so the real three.js devtools extension can still install its own object and we
    // keep listening on whatever is there.
    Object.defineProperty(window, '__THREE_DEVTOOLS__', {
      configurable: true, enumerable: false,
      get: () => devtools,
      set: (v) => { devtools = v; attachHook(v); },
    });
  } catch (e) { window.__THREE_DEVTOOLS__ = devtools; }

  // ------------------------------------------------------------ per-renderer wrapping
  function track(r) {
    if (states.has(r)) return;
    const canvas = r.domElement;
    if (!(canvas instanceof HTMLCanvasElement)) { warnOnce('offscreen', 'renderer on an OffscreenCanvas — not supported, left 2D'); return; }
    const st = {
      r, canvas, depth: 0, orig: {},
      active: false, pending: false, armed: null, tries: 0, nextTry: 0, lastWhy: null,
      L: { w: 0, h: 0, pr: 1, vp: [0, 0, 0, 0], sc: [0, 0, 0, 0], scTest: false }, // what the PAGE believes
      R: null,                                                                     // the real SBS store
      session: null, ref: null, layer: null, layerAt: 0, rig: { position: { x: 0, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } },
      V: [0, 1].map(() => ({ proj: new Float32Array(16), pose: new Float32Array(16) })),
      haveViews: false, eyes: null, eyesFor: null, m4: null,
      mainCam: null, lastScene: null, lastMono: null, near: NaN, far: NaN,
      frame: { drew: false, ops: [] }, lastOps: null,
      conv: { d: 0 }, cover: null, savedStyle: null,
      stats: { calls: 0, stereo: 0, flat: 0, replays: 0, resizes: 0, xrFrames: 0, twoView: 0, shortView: 0 },
    };
    states.set(r, st);
    tracked.push(new WeakRef(st));
    wrap(st);
    try {
      const s = st.call('getSize', vec2());
      st.L.w = s.x; st.L.h = s.y;
      st.L.pr = st.call('getPixelRatio');
      st.L.vp = [0, 0, st.L.w, st.L.h];
      st.L.sc = [0, 0, st.L.w, st.L.h];
      st.L.scTest = !!st.call('getScissorTest');
    } catch (e) { /* an old three without these: the page's own setSize fills L in */ }
    info(`three.js r${revision || '?'} renderer found on`, desc(canvas));
  }

  function wrap(st) {
    const r = st.r;
    // Call an original with the depth guard up: three's own nested calls (setPixelRatio -> setSize,
    // setSize -> setViewport, render -> clear / setRenderTarget, a Reflector's onBeforeRender) then
    // pass straight through the wrappers instead of being re-mapped a second time.
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
    // Getters answer with the PAGE's numbers while converted, even when called from inside a render
    // (an effect sizing itself in onBeforeRender must see the mono canvas it was written for).
    W('getSize', (t) => {
      const out = st.call('getSize', t);
      if (st.active && out) { if (typeof out.set === 'function') out.set(st.L.w, st.L.h); else { out.width = st.L.w; out.height = st.L.h; } }
      return out;
    });
    W('getPixelRatio', () => (st.active ? st.L.pr : st.call('getPixelRatio')));
    W('getDrawingBufferSize', (t) => {
      const out = st.call('getDrawingBufferSize', t);
      if (st.active && out && typeof out.set === 'function') out.set(Math.floor(st.L.w * st.L.pr), Math.floor(st.L.h * st.L.pr));
      return out;
    });
    W('setViewport', (x, y, w, h) => {
      if (!top()) return st.call('setViewport', x, y, w, h);
      st.L.vp = v4(x, y, w, h);
      if (!st.active) return st.call('setViewport', x, y, w, h);
    });
    W('getViewport', (t) => {
      const out = st.call('getViewport', t);
      if (st.active && out && typeof out.set === 'function') out.set(...st.L.vp);
      return out;
    });
    W('setScissor', (x, y, w, h) => {
      if (!top()) return st.call('setScissor', x, y, w, h);
      st.L.sc = v4(x, y, w, h);
      if (!st.active) return st.call('setScissor', x, y, w, h);
    });
    W('getScissor', (t) => {
      const out = st.call('getScissor', t);
      if (st.active && out && typeof out.set === 'function') out.set(...st.L.sc);
      return out;
    });
    W('setScissorTest', (b) => {
      if (!top()) return st.call('setScissorTest', b);
      st.L.scTest = !!b;
      if (!st.active) return st.call('setScissorTest', b);
    });
    W('getScissorTest', () => (st.active ? st.L.scTest : st.call('getScissorTest')));
    W('clear', (color, depth, stencil) => {
      if (!top() || !st.active || st.call('getRenderTarget') !== null) return st.call('clear', color, depth, stencil);
      st.frame.drew = true;
      st.frame.ops.push(['clear', color, depth, stencil]);
      forEyes(st, () => st.call('clear', color, depth, stencil));
    });
    W('render', (scene, camera) => {
      if (!top() || !scene || !camera) return st.call('render', scene, camera);
      st.stats.calls++;
      const toScreen = st.call('getRenderTarget') === null;
      const xrLive = !!(r.xr && r.xr.enabled && r.xr.isPresenting);
      if (!st.active) {
        const out = st.call('render', scene, camera);
        if (toScreen && !xrLive) {
          const persp = camera.isPerspectiveCamera && !camera.isArrayCamera;
          if (persp) {
            st.lastMono = { scene, camera }; st.sawPersp = true;
            // Flip / qualify only on the scene draw itself — never on an ortho background, HUD or
            // post quad drawn in the same frame (the throttle would otherwise keep landing on it).
            if (st.armed) flip(st, scene, camera);
            else considerActivation(st, camera);
          } else if (!st.sawPersp && !st.lastWhy) {
            st.lastWhy = 'the screen camera is not a PerspectiveCamera';
            info('not converting', desc(st.canvas), 'yet:', st.lastWhy, '(a post-processing chain, or an ortho-only scene)');
          }
        }
        return out;
      }
      if (xrLive) { stand(st, 'the renderer is presenting WebXR'); return st.call('render', scene, camera); }
      if (!toScreen) return st.call('render', scene, camera); // shadow / post-processing / picking targets: untouched, mono
      st.frame.drew = true;
      const stereo = isMainPerspective(st, camera);
      st.frame.ops.push(['render', scene, camera, stereo]);
      return stereo ? renderStereo(st, scene, camera) : renderFlat(st, scene, camera);
    });
    W('dispose', (...a) => {
      if (st.active || st.pending || st.armed) stand(st, 'the page disposed the renderer');
      return st.call('dispose', ...a);
    });
  }

  // ------------------------------------------------------------ sizing
  function realSizeFor(st) {
    const L = st.L;
    let eyeW = Math.max(2, Math.round(L.w * L.pr * cfg.eyeScale));
    let eyeH = Math.max(2, Math.round(L.h * L.pr));
    if (2 * eyeW > cfg.maxSbsWidth) {
      const s = cfg.maxSbsWidth / (2 * eyeW);
      eyeW = Math.max(2, Math.floor(eyeW * s));
      eyeH = Math.max(2, Math.floor(eyeH * s));
    }
    return { eyeW, eyeH, W: 2 * eyeW, H: eyeH };
  }
  // Returns true when the backing store actually changed (and was therefore cleared).
  function applyRealSize(st) {
    const R = realSizeFor(st);
    st.R = R;
    const pr1 = st.call('getPixelRatio') === 1;
    // A no-op setSize still writes canvas.width, which reallocates and CLEARS the buffer (porting pitfall 18).
    if (pr1 && realW(st.canvas) === R.W && realH(st.canvas) === R.H) return false;
    st.stats.resizes++;
    if (!pr1) st.call('setPixelRatio', 1);
    st.call('setSize', R.W, R.H, false);
    return true;
  }
  // The page's view of canvas.width / height stays the mono store three would have made.
  function virtualize(st) {
    const c = st.canvas;
    const def = (prop, D, isW) => Object.defineProperty(c, prop, {
      configurable: true, enumerable: true,
      get() { return st.depth > 0 ? D.get.call(this) : Math.floor((isW ? st.L.w : st.L.h) * st.L.pr); },
      set(v) {
        if (st.depth > 0) { D.set.call(this, v); return; }
        warnOnce('rawsize', `the page wrote canvas.${prop} directly; mapped onto the side-by-side store`);
        if (isW) st.L.w = v / (st.L.pr || 1); else st.L.h = v / (st.L.pr || 1);
        if (applyRealSize(st)) repaintNow(st);
      },
    });
    def('width', CANVAS_W, true);
    def('height', CANVAS_H, false);
  }
  function unvirtualize(st) { try { delete st.canvas.width; delete st.canvas.height; } catch (e) { /* ignore */ } }

  // ------------------------------------------------------------ drawing
  function isMainPerspective(st, camera) {
    if (!camera.isPerspectiveCamera || camera.isArrayCamera) return false;
    if (camera.view && camera.view.enabled) return false; // setViewOffset (tiles, TAA jitter): not ours to split
    const [x, y, w, h] = st.L.vp;
    return x === 0 && y === 0 && Math.abs(w - st.L.w) < 1 && Math.abs(h - st.L.h) < 1;
  }
  // The page's logical viewport / scissor, mapped into eye half i of the SBS store.
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
  // A GL projection (z_ndc -1..1) to three's reversed-Z form (near 1, far 0): z row := (w row − z row) / 2.
  // Touches only the depth row, so the runtime's off-axis x / y terms survive exactly. Checked against
  // three r180 Matrix4.makePerspective(…, reversedDepth): c = n/(f−n), d = f·n/(f−n).
  function toReversedZ(e) {
    for (const c of [0, 4, 8, 12]) e[c + 2] = (e[c + 3] - e[c + 2]) / 2;
  }

  function renderStereo(st, scene, camera) {
    st.mainCam = camera; st.lastScene = scene;
    if (!st.haveViews) return renderFlat(st, scene, camera); // no eyes yet: flat into both halves, never a blank tile
    // This frame's camera pose, parents included, before the eyes are composed from it. The scene
    // itself is updated by three inside each eye's render(), as it would be for the page's own.
    if (typeof camera.updateWorldMatrix === 'function') camera.updateWorldMatrix(true, false);
    else if (camera.parent === null) camera.updateMatrixWorld();
    const eyes = eyeCameras(st, camera);
    const rev = reversedDepth(st);
    const sm = st.r.shadowMap, smAuto = sm ? sm.autoUpdate : undefined;
    try {
      for (let i = 0; i < 2; i++) {
        const e = eyes[i];
        st.m4.fromArray(st.V[i].pose);
        e.matrixWorld.multiplyMatrices(camera.matrixWorld, st.m4); // attach pattern: identity rig pose
        e.matrix.copy(e.matrixWorld);
        invertFrom(e.matrixWorldInverse, e.matrixWorld);
        e.projectionMatrix.fromArray(st.V[i].proj);               // the runtime's off-axis frustum, untouched
        if (rev) {
          // Marked BEFORE render: on a reversed-depth renderer three otherwise calls
          // updateProjectionMatrix() on any camera not marked, which would replace the runtime's
          // off-axis frustum with a symmetric one (porting guide: never do that to an eye camera).
          toReversedZ(e.projectionMatrix.elements);
          e._reversedDepth = true;
        }
        if (e.projectionMatrixInverse) invertFrom(e.projectionMatrixInverse, e.projectionMatrix);
        e.near = camera.near; e.far = camera.far; e.fov = camera.fov; e.aspect = camera.aspect; e.zoom = camera.zoom;
        if (e.layers && camera.layers) e.layers.mask = camera.layers.mask;
        setEyeViewport(st, i);
        if (i === 1 && sm) sm.autoUpdate = false; // shadow maps are view-independent: render them once
        st.call('render', scene, e);
      }
    } finally {
      if (sm) sm.autoUpdate = smAuto;
      st.call('setScissorTest', false);
    }
    st.stats.stereo++;
  }
  function renderFlat(st, scene, camera) {
    const sm = st.r.shadowMap, smAuto = sm ? sm.autoUpdate : undefined;
    try {
      for (let i = 0; i < 2; i++) {
        setEyeViewport(st, i);
        if (i === 1 && sm) sm.autoUpdate = false;
        st.call('render', scene, camera);
      }
    } finally {
      if (sm) sm.autoUpdate = smAuto;
      st.call('setScissorTest', false);
    }
    st.stats.flat++;
  }
  // Redraw the page's last screen draws (render-on-demand pages, or a resize that just cleared the
  // store). Stereo draws re-run with THIS frame's eyes, so an idle page still looks around.
  function replay(st, ops) {
    const prevRT = st.call('getRenderTarget');
    if (prevRT !== null) st.call('setRenderTarget', null);
    try {
      for (const op of ops) {
        if (op[0] === 'clear') forEyes(st, () => st.call('clear', op[1], op[2], op[3]));
        else if (op[3]) renderStereo(st, op[1], op[2]);
        else renderFlat(st, op[1], op[2]);
      }
      st.stats.replays++;
    } catch (e) {
      warnOnce('replay', 'replaying the last frame threw; idle frames will not be redrawn', e);
      st.lastOps = null;
    } finally {
      if (prevRT !== null) st.call('setRenderTarget', prevRT);
    }
  }
  function repaintNow(st) {
    const ops = st.frame.ops.length ? st.frame.ops : st.lastOps;
    if (ops && ops.length) replay(st, ops);
  }

  // ------------------------------------------------------------ activation
  function considerActivation(st, camera) {
    if (!cfg.enabled || foreign || owner) return;
    const t = now();
    if (t < st.nextTry) return;
    st.nextTry = t + 500;
    const why = unqualified(st, camera);
    if (why) {
      if (why !== st.lastWhy) { st.lastWhy = why; info('not converting', desc(st.canvas), 'yet:', why); }
      return;
    }
    activate(st);
  }
  function unqualified(st, camera) {
    if (!camera.isPerspectiveCamera || camera.isArrayCamera) return 'the screen camera is not a PerspectiveCamera';
    const c = st.canvas;
    if (!c.isConnected) return 'canvas is not in the document';
    const rect = c.getBoundingClientRect();
    if (rect.width < cfg.minCssPx || rect.height < cfg.minCssPx) return `canvas is small (${rect.width | 0}x${rect.height | 0} CSS px)`;
    if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) return 'canvas is off screen';
    if (!(st.L.w > 0 && st.L.h > 0)) return 'renderer has no size yet';
    return cssEffect(c);
  }
  // woven-canvas rules, rule 7: a render surface on the canvas or on any ancestor breaks the join.
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
    owner = st; st.pending = true; st.lastWhy = null; st.tries++;
    info('converting', desc(st.canvas), `(three r${revision || '?'})`);
    hud();
    let session = null;
    try {
      session = await xrRequest('inline-3d');
      if (!st.pending || foreign || !cfg.enabled) { try { session.end(); } catch (e) { /* ignore */ } return; }
      st.session = session;
      st.ref = await session.requestReferenceSpace('viewer');
      session.addEventListener('end', () => { if (st.session === session) stand(st, 'the inline-3d session ended'); });
      st.armed = { at: now() };
      // Flip on the page's next draw, in its own task (the mono frame it just drew is the cover). A
      // render-on-demand page may not draw again, so flip from here after a short wait if it does not.
      setTimeout(() => {
        if (st.armed && st.lastMono) {
          const { scene, camera } = st.lastMono;
          st.call('render', scene, camera);
          flip(st, scene, camera);
        }
      }, 250);
    } catch (e) {
      warnOnce('session', 'inline-3d session refused — staying 2D:', e && e.message);
      if (session) { try { session.end(); } catch (e2) { /* ignore */ } }
      st.pending = false; if (owner === st) owner = null;
      st.nextTry = now() + 10000;
      hud();
    }
  }
  function flip(st, scene, camera) {
    st.armed = null;
    makeCover(st);            // the mono frame just drawn, over the canvas, until the join (rule 5)
    virtualize(st);
    st.active = true; st.pending = false;
    promote(st);
    applyRealSize(st);
    st.mainCam = camera; st.lastScene = scene;
    st.near = camera.near; st.far = camera.far;
    try { st.session.updateRenderState({ depthNear: camera.near, depthFar: camera.far }); } catch (e) { /* ignore */ }
    if (camera.parent === null) camera.updateMatrixWorld();
    estimateConvergence(st, scene, camera, true);
    const rig = buildRig(st, camera);
    try {
      // cfg.noLayer is TEST ONLY: everything but the weave binding, so a 2D instance shows the raw pair.
      st.layer = cfg.noLayer ? null : new XRDisplayLayer(st.session, st.canvas, HAS_RIG ? { viewRig: rig } : { virtualDisplayHeight: 0.24 });
    } catch (e) {
      warnOnce('layer', 'new XRDisplayLayer() failed — staying 2D', e);
      stand(st, 'XRDisplayLayer refused the canvas');
      st.nextTry = Infinity;
      return;
    }
    st.layerAt = now();
    st.displayOk = null;
    if (st.layer && !cfg.fakeViews) probeDisplay(st, st.layer); // fakeViews (tests) run where there is no display on purpose
    if (cfg.noLayer) {
      // TEST ONLY: no layer means no session frames, so seed the fake eyes here and lift the cover
      // on a timer — the canvas then shows the raw side-by-side pair a 2D instance can screenshot.
      if (cfg.fakeViews) { fakeViews(st); st.haveViews = true; }
      setTimeout(() => dropCover(st), cfg.holdMs);
    }
    const session = st.session;
    const loop = (t, f) => {
      if (!st.active || st.session !== session) return;
      try { session.requestAnimationFrame(loop); } catch (e) { return; }
      onSessionFrame(st, f);
    };
    session.requestAnimationFrame(loop);
    renderFlat(st, scene, camera); // repaint NOW: the resize just cleared the store
    st.lastOps = [['render', scene, camera, true]];
    info(`live on ${desc(st.canvas)}: SBS ${st.R.W}x${st.R.H} (eye ${st.R.eyeW}x${st.R.eyeH}), rig ${HAS_RIG ? 'camera' : 'display (no setViewRig)'},`,
      `convergence ${st.conv.d.toPrecision(3)} units, depth ${cfg.depth}`);
    hud();
  }
  function stand(st, reason) {
    const was = st.active || st.pending || !!st.armed;
    const wasLive = st.active; // only a live renderer was resized to the SBS store
    st.active = false; st.pending = false; st.armed = null;
    if (st.layer) { try { st.layer.close(); } catch (e) { /* ignore */ } st.layer = null; }
    if (st.session) { const s = st.session; st.session = null; try { s.end().catch(() => {}); } catch (e) { /* ignore */ } }
    st.haveViews = false; st.lastOps = null; st.frame = { drew: false, ops: [] };
    unvirtualize(st);
    if (wasLive) {
      try {
        st.call('setPixelRatio', st.L.pr);
        st.call('setSize', st.L.w, st.L.h, false);
        st.call('setViewport', ...st.L.vp);
        st.call('setScissor', ...st.L.sc);
        st.call('setScissorTest', st.L.scTest);
        if (st.lastMono) st.call('render', st.lastMono.scene, st.lastMono.camera); // the resize cleared it
      } catch (e) { /* the page's next frame repaints */ }
    }
    unpromote(st);
    dropCover(st);
    if (owner === st) owner = null;
    if (was) info('back to 2D:', reason);
    hud();
  }
  // Is there a display behind this layer at all? Measured on an instance with no weave slot
  // (browser#162): getDisplayInfo() resolves null and getRenderingModes() resolves []. There a
  // bound canvas is withheld from the page and never woven — a blank tile — so go back to 2D at
  // once. With a display present, keep the layer even before any eyes are tracked: the woven tile
  // is simply flat until a viewer sits down.
  async function probeDisplay(st, layer) {
    const ask = async (name) => {
      if (typeof layer[name] !== 'function') return undefined;
      try { return await layer[name](); } catch (e) { return null; }
    };
    for (const wait of [0, 1500]) {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      if (st.layer !== layer) return;
      const info = await ask('getDisplayInfo');
      const modes = await ask('getRenderingModes');
      if (info === undefined && modes === undefined) return; // no display API on this build: fall back to the eye timeout
      if (info || (Array.isArray(modes) && modes.length)) { st.displayOk = true; return; }
    }
    if (st.layer !== layer) return;
    st.displayOk = false;
    stand(st, 'no display behind the layer (getDisplayInfo() null, no rendering modes) — is another DisplayXR Browser holding it? (browser#162)');
    st.nextTry = now() + 30000;
  }
  function promote(st) {
    // The SDK's compositing hint (inline3d.js _register): a distinct quad the weave can track.
    const s = st.canvas.style;
    st.savedStyle = { willChange: s.willChange, transform: s.transform };
    s.willChange = 'transform';
    if (getComputedStyle(st.canvas).transform === 'none') s.transform = 'translateZ(0)';
  }
  function unpromote(st) {
    if (!st.savedStyle) return;
    st.canvas.style.willChange = st.savedStyle.willChange;
    st.canvas.style.transform = st.savedStyle.transform;
    st.savedStyle = null;
  }

  // ------------------------------------------------------------ the session frame
  function onSessionFrame(st, frame) {
    st.stats.xrFrames++;
    if (!st.canvas.isConnected) { stand(st, 'the canvas left the document'); return; }
    let views = null;
    try { const pose = st.ref ? frame.getViewerPose(st.ref) : null; views = pose ? pose.views : null; } catch (e) { /* no pose */ }
    const t = now();
    if (views && views.length >= 2) {
      // COPIES: an XRView is valid only inside this callback (porting pitfall 9).
      for (let i = 0; i < 2; i++) { st.V[i].proj.set(views[i].projectionMatrix); st.V[i].pose.set(views[i].transform.matrix); }
      st.haveViews = true; st.stats.twoView++;
    } else {
      st.stats.shortView++;
      if (cfg.fakeViews && st.mainCam) { fakeViews(st); st.haveViews = true; }
    }
    if (!st.haveViews && st.displayOk !== true && t - st.layerAt > cfg.noViewsMs) {
      stand(st, `no 2-view frame within ${cfg.noViewsMs} ms (nobody tracked, or this browser instance has no weave slot — browser#162)`);
      st.nextTry = st.tries < 3 ? t + 15000 : Infinity;
      return;
    }
    const cam = st.mainCam;
    if (cam) {
      // The depth range follows the camera (porting guide §4 — a camera's far often moves once, after load).
      if (cam.near !== st.near || cam.far !== st.far) {
        st.near = cam.near; st.far = cam.far;
        try { st.session.updateRenderState({ depthNear: cam.near, depthFar: cam.far }); } catch (e) { /* ending */ }
      }
      if (st.stats.xrFrames % 30 === 0) estimateConvergence(st, st.lastScene, cam, false);
      // Pushed every frame and before any draw: a rig drives the NEXT locate.
      if (HAS_RIG && st.layer) { try { st.layer.setViewRig(buildRig(st, cam)); } catch (e) { warnOnce('rig', 'setViewRig failed', e); } }
    }
    // Redraw every frame (woven-canvas rules): a page that drew nothing since the last session frame
    // gets its last screen draws replayed.
    if (st.frame.drew) st.lastOps = st.frame.ops.length <= 32 ? st.frame.ops : null;
    else if (st.lastOps) replay(st, st.lastOps);
    st.frame = { drew: false, ops: [] };
    tickCover(st, t);
    if (st.stats.xrFrames % 20 === 0) hud();
  }

  // ------------------------------------------------------------ the rig
  function buildRig(st, cam) {
    const rig = st.rig;
    const d = Math.max(1e-6, (st.conv.d || 1) * cfg.convScale);
    rig.type = 'camera';
    // attach: identity pose — the page camera's matrixWorld supplies THIS frame's pose at draw time.
    rig.position.x = rig.position.y = rig.position.z = 0;
    rig.orientation.x = rig.orientation.y = rig.orientation.z = 0; rig.orientation.w = 1;
    rig.verticalFov = 2 * Math.atan(Math.tan(((cam.fov || 50) * Math.PI) / 360) / (cam.zoom || 1));
    rig.convergenceDiopters = 1 / d;
    // metersToVirtual grows with the convergence distance: the depth budget is then the same for a
    // 10 cm product and a 150 m airliner (what a display rig gives an authored page), and
    // comfort = ipd × m2v × diopters × 0.5 = cfg.depth by construction.
    rig.metersToVirtual = (cfg.depth * d) / 0.5;
    rig.ipdFactor = 1;
    rig.parallaxFactor = 1;
    return rig;
  }
  function estimateConvergence(st, scene, cam, snap) {
    if (!scene || !cam || !cam.matrixWorldInverse) return;
    let d = subjectDistance(scene, cam);
    if (!(d > 0) || !isFinite(d)) d = st.conv.d || Math.max(cam.near * 50, 1);
    d = clamp(d, cam.near * 2, cam.far * 0.9);
    // Eased: a convergence that snaps pulls the whole scene through the glass in one frame.
    st.conv.d = snap || !st.conv.d ? d : st.conv.d + (d - st.conv.d) * 0.25;
  }
  // Where the viewer is meant to look, from the scene graph alone. Objects whose bounding sphere
  // holds the camera (a sky, a floor, a room) are not a subject. If the camera sees the rest from
  // outside, converge on its centre (a viewer page); if it stands among it, take the
  // apparent-size-weighted median depth of what is in view (a world).
  function subjectDistance(scene, cam) {
    const vm = cam.matrixWorldInverse.elements, cw = cam.matrixWorld.elements;
    const px = cw[12], py = cw[13], pz = cw[14];
    const tanV = Math.tan(((cam.fov || 50) * Math.PI) / 360) / (cam.zoom || 1), aspect = cam.aspect || 1;
    const items = [];
    let n = 0;
    scene.traverseVisible((o) => {
      if (n >= 4000 || !(o.isMesh || o.isPoints || o.isLine || o.isSprite)) return;
      if (cam.layers && o.layers && typeof cam.layers.test === 'function' && !cam.layers.test(o.layers)) return;
      let bs = o.boundingSphere || null;
      const g = o.geometry;
      if (!bs && g) {
        if (!g.boundingSphere && typeof g.computeBoundingSphere === 'function') { try { g.computeBoundingSphere(); } catch (e) { /* ignore */ } }
        bs = g.boundingSphere;
      }
      if (!bs || !(bs.radius >= 0) || !isFinite(bs.radius)) return;
      n++;
      const m = o.matrixWorld.elements, c = bs.center;
      const wx = m[0] * c.x + m[4] * c.y + m[8] * c.z + m[12];
      const wy = m[1] * c.x + m[5] * c.y + m[9] * c.z + m[13];
      const wz = m[2] * c.x + m[6] * c.y + m[10] * c.z + m[14];
      const s = Math.sqrt(Math.max(m[0] * m[0] + m[1] * m[1] + m[2] * m[2], m[4] * m[4] + m[5] * m[5] + m[6] * m[6], m[8] * m[8] + m[9] * m[9] + m[10] * m[10]));
      const wr = bs.radius * s;
      if (Math.hypot(wx - px, wy - py, wz - pz) <= wr) return;
      const vx = vm[0] * wx + vm[4] * wy + vm[8] * wz + vm[12];
      const vy = vm[1] * wx + vm[5] * wy + vm[9] * wz + vm[13];
      const z = -(vm[2] * wx + vm[6] * wy + vm[10] * wz + vm[14]);
      if (z <= cam.near) return;
      if (Math.abs(vx) - wr > z * tanV * aspect * 1.2 || Math.abs(vy) - wr > z * tanV * 1.2) return; // out of view
      items.push({ z, r: wr, x: wx, y: wy, w: wz });
    });
    if (!items.length) return 0;
    let cx = 0, cy = 0, cz = 0, ws = 0;
    for (const it of items) { const k = it.r * it.r + 1e-12; cx += it.x * k; cy += it.y * k; cz += it.w * k; ws += k; }
    cx /= ws; cy /= ws; cz /= ws;
    let R = 0;
    for (const it of items) R = Math.max(R, Math.hypot(it.x - cx, it.y - cy, it.w - cz) + it.r);
    if (Math.hypot(cx - px, cy - py, cz - pz) > R) return -(vm[2] * cx + vm[6] * cy + vm[10] * cz + vm[14]);
    items.sort((a, b) => a.z - b.z);
    let tot = 0;
    for (const it of items) { it.k = Math.min(1, (it.r / it.z) ** 2); tot += it.k; }
    let acc = 0;
    for (const it of items) { acc += it.k; if (acc >= tot * 0.5) return it.z; }
    return items[items.length - 1].z;
  }
  // TEST ONLY (cfg.fakeViews): a parallel-axis pair with sheared frusta converging at the rig's
  // distance, so the SBS plumbing can be exercised on an instance whose session reports no eyes.
  // A real session never takes this path: the runtime owns the off-axis math.
  function fakeViews(st) {
    const cam = st.mainCam;
    const d = Math.max(1e-6, (st.conv.d || 1) * cfg.convScale);
    const b = (0.063 * cfg.depth * d) / 0.5;
    const nr = cam.near, fr = cam.far;
    const t = (nr * Math.tan(((cam.fov || 50) * Math.PI) / 360)) / (cam.zoom || 1);
    const a = st.L.w / (st.L.h || 1);
    for (let i = 0; i < 2; i++) {
      const ex = (i === 0 ? -0.5 : 0.5) * b;
      const sh = (-ex * nr) / d;
      const o = st.V[i].proj, l = -t * a + sh, r = t * a + sh;
      o.fill(0);
      o[0] = (2 * nr) / (r - l); o[5] = nr / t; o[8] = (r + l) / (r - l);
      o[10] = -(fr + nr) / (fr - nr); o[11] = -1; o[14] = (-2 * fr * nr) / (fr - nr);
      const p = st.V[i].pose;
      p.fill(0); p[0] = p[5] = p[10] = p[15] = 1; p[12] = ex;
    }
  }

  // ------------------------------------------------------------ the cover (woven-canvas rules, rule 5)
  function coverBackground(el) {
    for (let e = el.parentElement; e; e = e.parentElement) {
      const bg = getComputedStyle(e).backgroundColor;
      if (bg && bg !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(bg)) return bg;
    }
    return '#fff';
  }
  // A STILL of the last mono frame, taken in the task that drew it. It is not refreshed afterwards:
  // measured on a weave-less instance, drawImage() from a canvas that has an XRDisplayLayer bound
  // returns an empty image, so a live feed would blank the cover. It sits in the canvas's own
  // stacking context (next sibling, same z-index), so page chrome drawn over the canvas stays over it.
  function makeCover(st) {
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
      c.getContext('2d').drawImage(cv, 0, 0, c.width, c.height); // the mono frame drawn in this same task
      if (cv.parentNode) cv.parentNode.insertBefore(c, cv.nextSibling);
      else (document.body || document.documentElement).appendChild(c);
      st.cover = { el: c, fixed };
    } catch (e) { st.cover = null; }
  }
  function tickCover(st, t) {
    const cv = st.cover;
    if (!cv) return;
    if (t - st.layerAt >= cfg.holdMs && st.stats.stereo > 0) {
      dropCover(st); // a hard cut, never a fade
      info(`cover released ${Math.round(t - st.layerAt)} ms after the layer (hold ${cfg.holdMs} ms)`);
      return;
    }
    if (cv.fixed) {
      const rect = st.canvas.getBoundingClientRect();
      Object.assign(cv.el.style, { left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', height: rect.height + 'px' });
    }
  }
  function dropCover(st) { if (st.cover) { st.cover.el.remove(); st.cover = null; } }

  // ------------------------------------------------------------ HUD + hotkeys
  let hudEl = null, hudUntil = 0;
  function hud(flash) {
    if (flash) hudUntil = now() + 2500;
    const st = owner;
    const busy = st && (st.active || st.pending || st.armed);
    if (!cfg.hud || !(busy || now() < hudUntil)) { if (hudEl) { hudEl.remove(); hudEl = null; } return; }
    if (!document.body) return;
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
    if (!cfg.enabled) text = 'DXR auto-3D: OFF for this site  (Ctrl+Alt+3)';
    else if (st && st.active) {
      const s = st.stats;
      text = `DXR auto-3D ● depth ${cfg.depth.toFixed(2)} · conv ${(st.conv.d * cfg.convScale).toPrecision(3)} · 3D ${s.stereo} · flat ${s.flat} · replay ${s.replays}` +
        (st.haveViews ? '' : ' · waiting for eyes');
    } else if (busy) text = 'DXR auto-3D: converting…';
    else text = foreign ? `DXR auto-3D: standing down (${foreign})` : 'DXR auto-3D: ON — no three.js scene converted yet';
    hudEl.textContent = text;
  }
  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey && e.altKey) || e.shiftKey || e.metaKey) return;
    let hit = true;
    switch (e.code) {
      case 'Digit3':
        cfg.enabled = !cfg.enabled;
        info('auto-3D', cfg.enabled ? 'ON' : 'OFF', 'for', location.origin);
        if (!cfg.enabled && owner) stand(owner, 'turned off for this site');
        if (cfg.enabled) for (const w of tracked) { const st = w.deref(); if (st) { st.nextTry = 0; st.tries = 0; } }
        break;
      case 'Equal': cfg.depth = clamp(cfg.depth * 1.25, 0.02, 1); break;
      case 'Minus': cfg.depth = clamp(cfg.depth / 1.25, 0.02, 1); break;
      case 'Digit0': cfg.convScale = clamp(cfg.convScale * 1.15, 0.05, 20); break;
      case 'Digit9': cfg.convScale = clamp(cfg.convScale / 1.15, 0.05, 20); break;
      case 'Digit8': cfg.depth = DEFAULTS.depth; cfg.convScale = DEFAULTS.convScale; break;
      case 'KeyD': cfg.hud = !cfg.hud; break;
      default: hit = false;
    }
    if (hit) { e.preventDefault(); e.stopImmediatePropagation(); saveCfg(); hud(true); }
  }, true);
  window.addEventListener('pagehide', () => { if (owner) stand(owner, 'pagehide'); });

  // ------------------------------------------------------------ diagnostics
  window.__dxrAuto3D = {
    version: VERSION,
    get cfg() { return cfg; },
    set(k, v) { cfg[k] = v; saveCfg(); hud(true); },
    state() {
      const renderers = [];
      for (const w of tracked) {
        const st = w.deref();
        if (!st) continue;
        const rect = st.canvas.getBoundingClientRect();
        renderers.push({
          canvas: desc(st.canvas),
          css: [Math.round(rect.width), Math.round(rect.height)],
          page: { w: st.L.w, h: st.L.h, pr: st.L.pr, canvasWidthSeenByPage: st.canvas.width },
          real: [realW(st.canvas), realH(st.canvas)],
          active: st.active, pending: !!(st.pending || st.armed), haveViews: st.haveViews,
          convergence: st.conv.d, rig: st.active ? { ...st.rig } : null,
          why: st.lastWhy, stats: { ...st.stats },
        });
      }
      return { version: VERSION, revision, enabled: cfg.enabled, foreign, rigSupported: HAS_RIG, renderers };
    },
    // What the live layer's display API answers (diagnostics only).
    async probe() {
      const L = owner && owner.layer;
      if (!L) return { layer: false };
      const ask = async (name) => {
        if (typeof L[name] !== 'function') return 'absent';
        try { return await Promise.race([L[name](), new Promise((r) => setTimeout(() => r('timeout 2s'), 2000))]); }
        catch (e) { return 'rejected: ' + (e && (e.name + ' ' + e.message)); }
      };
      return { layer: true, displayInfo: await ask('getDisplayInfo'), renderingModes: await ask('getRenderingModes') };
    },
  };
  info(`armed (v${VERSION}): three.js pages on this origin will be converted to inline-3D`, cfg.enabled ? '' : '(OFF for this site)');
})();

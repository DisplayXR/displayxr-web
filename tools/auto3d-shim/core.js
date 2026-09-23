// DisplayXR auto-3D — engine-agnostic core. PROTOTYPE, not a product.
//
// Loaded by the extension as the FIRST of three MAIN-world content scripts at document_start
// (manifest.json: core.js → three-adapter.js → playcanvas-adapter.js). MV3 content scripts cannot
// be ES modules, and a dynamic import() of a chrome-extension:// URL is asynchronous — it would
// land after the page's first scripts and miss the three.js devtools hook / the PlayCanvas
// constructor trap. So these files are plain scripts, run in order in the page's own world, and
// the core hands its API to the adapters on a symbol-keyed, non-enumerable window property
// (`window[Symbol.for('dxr.auto3d.core')]`). No bundler, no build step.
//
// What lives here (everything that is not about one engine):
//   - document state: one inline-3D session per document (`owner`), standing down for good when
//     the page owns inline-3D / WebXR itself (`foreign`), the per-origin config + kill switch;
//   - the session + layer lifecycle: activate → armed → flip → per-frame → stand;
//   - the side-by-side (SBS) sizing rule and the canvas.width/height virtualisation helper;
//   - the camera rig (unchanged from the three.js prototype) and the convergence estimator, as an
//     interface fed by the engine (`estimateSubjectDistance(sampler)`);
//   - the cover (woven-canvas rules, rule 5: firstWoven-style hold), HUD, hotkeys, diagnostics.
//
// What an adapter supplies (an object `ad` on each tracked state `st`, see ADAPTER CONTRACT below):
// how to find the camera, draw a flat / stereo frame, resize the backing store, replay an idle
// frame, and walk the scene's bounds.
//
// Every number and behaviour is the three.js prototype's (content.js v0.1.0, PR #47); the split is
// verified frame-for-frame by tools/auto3d-shim/test (parity: MAE 0.000).
(() => {
  'use strict';
  const KEY = Symbol.for('dxr.auto3d.core');
  if (window[KEY] || window.__dxrAuto3D) return;
  if (typeof window.XRDisplayLayer !== 'function' || !navigator.xr) return; // not the DisplayXR Browser: inert

  const TAG = '[dxr-auto3d]';
  const VERSION = '0.2.0';

  // ------------------------------------------------------------ config (per origin)
  const DEFAULTS = {
    v: 1,
    enabled: true,      // auto-convert qualifying canvases on this origin
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

  // ------------------------------------------------------------ document-level state
  const tracked = [];           // WeakRef<state>, for state() and the HUD
  let owner = null;             // the one canvas converted (or converting) — one inline-3D session per document
  let foreign = null;           // why we stood down for good in this document (the page owns inline-3D / XR)
  const engines = [];           // adapter names, for the HUD / console

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

  // ------------------------------------------------------------ ADAPTER CONTRACT
  // newState(engine, canvas, ad) returns the per-canvas state `st`. The adapter keeps its own
  // fields on `st` too. `ad` implements (all called with st):
  //   label()                  -> string for the console ("three.js r180")
  //   unqualified()            -> null, or why this canvas is not converted YET (re-asked ~2/s)
  //   hasCamera()              -> is there a camera to drive the rig from
  //   depthRange()             -> { near, far } of the page camera
  //   rigFov()                 -> vertical FOV (radians) of the page camera, zoom included
  //   sampler()                -> convergence sampler (see estimateSubjectDistance) or null
  //   fakeViewParams()         -> { near, far, t, aspect } (TEST ONLY fake views)
  //   beforeActive()           -> e.g. virtualise canvas.width (runs before st.active = true)
  //   afterActive()            -> resize the store to st.R, bind the per-eye path
  //   firstDraw()              -> repaint NOW (a resize just cleared the store)
  //   redraw()                 -> per session frame: redraw / replay so the tile is drawn every frame
  //   restore(wasLive)         -> undo afterActive/beforeActive (stand-down)
  //   flipIdle()               -> the armed canvas has not drawn for 250 ms: draw + flip now
  //   describe()               -> { page, real } for state()
  function newState(engine, canvas, ad) {
    const st = {
      engine, canvas, ad,
      active: false, pending: false, armed: null, tries: 0, nextTry: 0, lastWhy: null, flatReason: null,
      session: null, ref: null, layer: null, layerAt: 0, rig: { position: { x: 0, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } },
      V: [0, 1].map(() => ({ proj: new Float32Array(16), pose: new Float32Array(16) })),
      haveViews: false, near: NaN, far: NaN, R: null,
      conv: { d: 0 }, cover: null, savedStyle: null, displayOk: null,
      stats: { calls: 0, stereo: 0, flat: 0, flatAfterEyes: 0, replays: 0, resizes: 0, xrFrames: 0, twoView: 0, shortView: 0 },
    };
    tracked.push(new WeakRef(st));
    return st;
  }

  // ------------------------------------------------------------ sizing
  // L is what the PAGE believes: { w, h, pr } (three: CSS-ish size × pixel ratio; PlayCanvas: pixels, pr 1).
  function realSizeFor(L) {
    let eyeW = Math.max(2, Math.round(L.w * L.pr * cfg.eyeScale));
    let eyeH = Math.max(2, Math.round(L.h * L.pr));
    if (2 * eyeW > cfg.maxSbsWidth) {
      const s = cfg.maxSbsWidth / (2 * eyeW);
      eyeW = Math.max(2, Math.floor(eyeW * s));
      eyeH = Math.max(2, Math.floor(eyeH * s));
    }
    return { eyeW, eyeH, W: 2 * eyeW, H: eyeH };
  }
  // The page's view of canvas.width / height stays the mono store it would have made. Reads and
  // writes made while st.depth > 0 (the adapter's own calls into the engine) see the real store.
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

  // ------------------------------------------------------------ activation
  function considerActivation(st) {
    if (!cfg.enabled || foreign || owner) return;
    const t = now();
    if (t < st.nextTry) return;
    st.nextTry = t + 500;
    const why = st.ad.unqualified(st);
    if (why) {
      if (why !== st.lastWhy) { st.lastWhy = why; info('not converting', desc(st.canvas), 'yet:', why); }
      return;
    }
    activate(st);
  }
  // Where the canvas is: in the document, big enough, on screen.
  function canvasPlacement(c) {
    if (!c.isConnected) return 'canvas is not in the document';
    const rect = c.getBoundingClientRect();
    if (rect.width < cfg.minCssPx || rect.height < cfg.minCssPx) return `canvas is small (${rect.width | 0}x${rect.height | 0} CSS px)`;
    if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) return 'canvas is off screen';
    return null;
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
    info('converting', desc(st.canvas), `(${st.ad.label(st)})`);
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
      setTimeout(() => { if (st.armed) st.ad.flipIdle(st); }, 250);
    } catch (e) {
      warnOnce('session', 'inline-3d session refused — staying 2D:', e && e.message);
      if (session) { try { session.end(); } catch (e2) { /* ignore */ } }
      st.pending = false; if (owner === st) owner = null;
      st.nextTry = now() + 10000;
      hud();
    }
  }
  // Called by the adapter in the task that just drew the page's mono frame.
  function flip(st) {
    const ad = st.ad;
    st.armed = null;
    makeCover(st);            // the mono frame just drawn, over the canvas, until the join (rule 5)
    ad.beforeActive(st);
    st.active = true; st.pending = false;
    promote(st);
    ad.afterActive(st);
    const dr = ad.depthRange(st);
    st.near = dr.near; st.far = dr.far;
    try { st.session.updateRenderState({ depthNear: dr.near, depthFar: dr.far }); } catch (e) { /* ignore */ }
    estimateConvergence(st, true);
    const rig = buildRig(st, ad.rigFov(st));
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
    ad.firstDraw(st);
    info(`live on ${desc(st.canvas)}: SBS ${st.R.W}x${st.R.H} (eye ${st.R.eyeW}x${st.R.eyeH}), rig ${HAS_RIG ? 'camera' : 'display (no setViewRig)'},`,
      `convergence ${st.conv.d.toPrecision(3)} units, depth ${cfg.depth}`);
    hud();
  }
  function stand(st, reason) {
    const was = st.active || st.pending || !!st.armed;
    const wasLive = st.active; // only a live canvas was resized to the SBS store
    st.active = false; st.pending = false; st.armed = null;
    if (st.layer) { try { st.layer.close(); } catch (e) { /* ignore */ } st.layer = null; }
    if (st.session) { const s = st.session; st.session = null; try { s.end().catch(() => {}); } catch (e) { /* ignore */ } }
    st.haveViews = false;
    st.ad.restore(st, wasLive);
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
      const di = await ask('getDisplayInfo');
      const modes = await ask('getRenderingModes');
      if (di === undefined && modes === undefined) return; // no display API on this build: fall back to the eye timeout
      if (di || (Array.isArray(modes) && modes.length)) { st.displayOk = true; return; }
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
    const ad = st.ad;
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
      if (cfg.fakeViews && ad.hasCamera(st)) { fakeViews(st); st.haveViews = true; }
    }
    if (!st.haveViews && st.displayOk !== true && t - st.layerAt > cfg.noViewsMs) {
      stand(st, `no 2-view frame within ${cfg.noViewsMs} ms (nobody tracked, or this browser instance has no weave slot — browser#162)`);
      st.nextTry = st.tries < 3 ? t + 15000 : Infinity;
      return;
    }
    if (ad.hasCamera(st)) {
      // The depth range follows the camera (porting guide §4 — a camera's far often moves once, after load).
      const dr = ad.depthRange(st);
      if (dr.near !== st.near || dr.far !== st.far) {
        st.near = dr.near; st.far = dr.far;
        try { st.session.updateRenderState({ depthNear: dr.near, depthFar: dr.far }); } catch (e) { /* ending */ }
      }
      if (st.stats.xrFrames % 30 === 0) estimateConvergence(st, false);
      // Pushed every frame and before any draw: a rig drives the NEXT locate.
      if (HAS_RIG && st.layer) { try { st.layer.setViewRig(buildRig(st, ad.rigFov(st))); } catch (e) { warnOnce('rig', 'setViewRig failed', e); } }
    }
    // Redraw every frame (woven-canvas rules): the adapter replays the page's last frame when the
    // page drew nothing since the last session frame.
    ad.redraw(st);
    tickCover(st, t);
    if (st.stats.xrFrames % 20 === 0) hud();
  }

  // ------------------------------------------------------------ the rig
  function buildRig(st, verticalFov) {
    const rig = st.rig;
    const d = Math.max(1e-6, (st.conv.d || 1) * cfg.convScale);
    rig.type = 'camera';
    // attach: identity pose — the page camera's world transform supplies THIS frame's pose at draw time.
    rig.position.x = rig.position.y = rig.position.z = 0;
    rig.orientation.x = rig.orientation.y = rig.orientation.z = 0; rig.orientation.w = 1;
    rig.verticalFov = verticalFov;
    rig.convergenceDiopters = 1 / d;
    // metersToVirtual grows with the convergence distance: the depth budget is then the same for a
    // 10 cm product and a 150 m airliner (what a display rig gives an authored page), and
    // comfort = ipd × m2v × diopters × 0.5 = cfg.depth by construction.
    rig.metersToVirtual = (cfg.depth * d) / 0.5;
    rig.ipdFactor = 1;
    rig.parallaxFactor = 1;
    return rig;
  }
  function estimateConvergence(st, snap) {
    const s = st.ad.sampler(st);
    if (!s) return;
    let d = estimateSubjectDistance(s);
    if (!(d > 0) || !isFinite(d)) d = st.conv.d || Math.max(s.near * 50, 1);
    d = clamp(d, s.near * 2, s.far * 0.9);
    // Eased: a convergence that snaps pulls the whole scene through the glass in one frame.
    st.conv.d = snap || !st.conv.d ? d : st.conv.d + (d - st.conv.d) * 0.25;
  }
  // 4x4 column-major inverse (for samplers that only give the camera pose).
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
  // Where the viewer is meant to look, from the scene's bounds alone. Objects whose bounding sphere
  // holds the camera (a sky, a floor, a room) are not a subject. If the camera sees the rest from
  // outside, converge on its centre (a viewer page); if it stands among it, take the
  // apparent-size-weighted median depth of what is in view (a world).
  //
  // sampler = {
  //   cameraPose,    column-major 4x4 camera-to-world (the eye rig is attached to it)
  //   viewMatrix?,   its inverse, if the engine already has one (else inverted here)
  //   verticalFov,   radians, zoom included          tanHalfFov?  tan(verticalFov/2), if the engine has it
  //   aspect, near, far,
  //   forEachBounds(cb)  calls cb(wx, wy, wz, worldRadius) per drawable in view layers; stop when cb returns false
  // }
  function estimateSubjectDistance(s) {
    const cw = s.cameraPose;
    const vm = s.viewMatrix || invert4(cw);
    const px = cw[12], py = cw[13], pz = cw[14];
    const tanV = s.tanHalfFov !== undefined ? s.tanHalfFov : Math.tan(s.verticalFov / 2), aspect = s.aspect || 1;
    const near = s.near;
    const items = [];
    let n = 0;
    s.forEachBounds((wx, wy, wz, wr) => {
      if (n >= 4000) return false;
      n++;
      if (Math.hypot(wx - px, wy - py, wz - pz) <= wr) return true;
      const vx = vm[0] * wx + vm[4] * wy + vm[8] * wz + vm[12];
      const vy = vm[1] * wx + vm[5] * wy + vm[9] * wz + vm[13];
      const z = -(vm[2] * wx + vm[6] * wy + vm[10] * wz + vm[14]);
      if (z <= near) return true;
      if (Math.abs(vx) - wr > z * tanV * aspect * 1.2 || Math.abs(vy) - wr > z * tanV * 1.2) return true; // out of view
      items.push({ z, r: wr, x: wx, y: wy, w: wz });
      return true;
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
    const p = st.ad.fakeViewParams(st);
    const d = Math.max(1e-6, (st.conv.d || 1) * cfg.convScale);
    const b = (0.063 * cfg.depth * d) / 0.5;
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
  // A canvas the adapter can see but will not convert for a structural reason (post-effects,
  // several cameras, WebGPU) — shown on the HUD so a tester knows why the page is flat.
  const flatNote = () => {
    for (const w of tracked) { const st = w.deref(); if (st && st.flatReason) return st; }
    return null;
  };
  function hud(flash) {
    if (flash) hudUntil = now() + 2500;
    const st = owner;
    const busy = st && (st.active || st.pending || st.armed);
    const flat = !busy && !foreign && cfg.enabled ? flatNote() : null;
    if (!cfg.hud || !(busy || flat || now() < hudUntil)) { if (hudEl) { hudEl.remove(); hudEl = null; } return; }
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
    else if (foreign) text = `DXR auto-3D: standing down (${foreign})`;
    else if (flat) text = `DXR auto-3D: 2D (${flat.engine}) — ${flat.flatReason}`;
    else text = `DXR auto-3D: ON — no ${engines.join(' / ') || '3D'} scene converted yet`;
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
  const meta = {}; // per-engine facts adapters publish (three.js revision, PlayCanvas detection path, …)
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
        const d = st.ad.describe(st);
        renderers.push({
          engine: st.engine,
          canvas: desc(st.canvas),
          css: [Math.round(rect.width), Math.round(rect.height)],
          page: d.page,
          real: [realW(st.canvas), realH(st.canvas)],
          eye: st.R ? [st.R.eyeW, st.R.eyeH] : null,
          active: st.active, pending: !!(st.pending || st.armed), haveViews: st.haveViews,
          convergence: st.conv.d, rig: st.active ? { ...st.rig } : null,
          why: st.lastWhy, flatReason: st.flatReason, stats: { ...st.stats },
          ...(d.extra || {}),
        });
      }
      return { version: VERSION, engines: engines.slice(), ...meta, enabled: cfg.enabled, foreign, rigSupported: HAS_RIG, renderers };
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

  const core = {
    VERSION, TAG, DEFAULTS, HAS_RIG,
    get cfg() { return cfg; },
    get owner() { return owner; },
    get foreign() { return foreign; },
    meta,
    registerEngine(name) { if (!engines.includes(name)) engines.push(name); },
    info, warnOnce, clamp, now, desc, realW, realH, CANVAS_W, CANVAS_H,
    newState, considerActivation, canvasPlacement, cssEffect, flip, stand, yieldTo, hud,
    realSizeFor, virtualizeCanvas, unvirtualizeCanvas,
    buildRig, estimateSubjectDistance, estimateConvergence, invert4, fakeViews,
    makeCover, dropCover,
  };
  Object.defineProperty(window, KEY, { value: Object.freeze(core), configurable: false, enumerable: false, writable: false });
  info(`core armed (v${VERSION})`, cfg.enabled ? '' : '(OFF for this site)');
})();

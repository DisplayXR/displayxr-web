// DisplayXR auto-3D — engine-agnostic core. PROTOTYPE, not a product.
//
// One PART of the build (build.mjs): `function dxrCore(cfg, cap, S)`, concatenated with guard.js,
// chip.js, dev.js, three-adapter.js and playcanvas-adapter.js into ONE function body
// (dist/auto3d-core.js), so every part shares one lexical scope and nothing is handed over on
// `window`. The sentinel (sentinel.js) runs first, at document start, and calls it with:
//   cfg  frozen data from the host for this frame: { decision: 'allow'|'offer'|'block',
//        depths: { camera, display } (each DEPTH_MIN..DEPTH_MAX = 0.02..1), rig: 'camera'|'display',
//        convScale (CONV_SCALE_MIN..CONV_SCALE_MAX = 0.05..20, 1 = automatic), dev,
//        engines: { three, playcanvas }, test }
//        The host validates cap.save against the same ranges. A user 'block' outside dev never
//        reaches the core (the sentinel stays detect-only).
//   cap  the host's capabilities, closures only: { loadCore(), save(partial), report({status, engine?, reason?}) }
//   S    what the sentinel owns: { intrinsics, xrRequest, foreign(), onForeign(cb), optedOut(), disarm(),
//        settle(canvas), devtools }. The core calls S.settle(canvas) when a canvas goes live (the
//        PlayCanvas search is over unless another canvas has a WebGL context) and S.disarm() when it
//        stands down for good (the page owns XR, opted out, the frame-rate guard blocked).
// and gets back { ctl, three: { observe, register }, playcanvas: { consider } }.
//
// What lives here (everything that is not about one engine):
//   - document state: one inline-3D session per document (`owner`), standing down for good when
//     the page owns inline-3D / WebXR itself (`foreign`), the site decision (`site`, `on()`);
//   - the session + layer lifecycle: activate → armed → flip → per-frame → stand;
//   - the side-by-side (SBS) sizing rule and the canvas.width/height virtualisation helper;
//   - the camera rig (unchanged from the three.js prototype) and the convergence estimator, as an
//     interface fed by the engine (`estimateSubjectDistance(sampler)`);
//   - the cover (woven-canvas rules, rule 5: firstWoven-style hold) and the depth fades;
//   - `ctl`, the controller the chip and the dev hotkeys share, and `notify()`, which fans every
//     status change out to the chip, the dev HUD and the host (`cap.report`, transitions only).
// The HUD, the hotkeys and `window.__dxrAuto3D` are dev.js (only when cfg.dev).
//
// What an adapter supplies (an object `ad` on each tracked state `st`, see ADAPTER CONTRACT below):
// how to find the camera, draw a flat / stereo frame, resize the backing store, replay an idle
// frame, and walk the scene's bounds.
//
// Every number and behaviour is the three.js prototype's (content.js v0.1.0, PR #47); the split is
// verified frame-for-frame by tools/auto3d-shim/test (parity: MAE 0.000).
function dxrCore(cfg, cap, S) {
  const TAG = '[dxr-auto3d]';
  const VERSION = '__DXR_AUTO3D_VERSION__'; // stamped by build.mjs from manifest.json

  // The default depth PER RIG (David's call, 2026-09-27). One number per rig, one meaning: the
  // comfort number, i.e. the disparity of content at infinity in units of the viewer's IPD.
  //   camera rig: ipd × m2v × diopters × 0.5 — 0.5 (panel pass 2026-09-28; 0.3 read shallow. The runtime's qwerty rig sits at 0.25).
  //   display rig: ipdFactor (= parallaxFactor) — 1.0, the physically true portal (natural IPD,
  //     full head parallax). The runtime's display-rig contract is [0, 1] (XR_DXR_view_rig.h), so
  //     1.0 is also the ceiling: there is no headroom above it on either rig.
  const DEFAULT_DEPTH = { camera: 0.5, display: 1.0 };
  const DEPTH_MIN = 0.02, DEPTH_MAX = 1;
  // The convergence scale (a multiplier on the automatic convergence distance; 1 = automatic) is
  // clamped to this range everywhere it is set. The host mirrors it when it validates cap.save.
  const CONV_SCALE_MIN = 0.05, CONV_SCALE_MAX = 20;

  // ------------------------------------------------------------ tuning (constants)
  // Not per site. Overridable only by the harness, through cfg.test, and only in a dev build
  // (risk R8: fakeViews / noLayer / coverImg / outHoldMs are page-controllable otherwise).
  const TUNING = {
    eyeScale: 1,        // per-eye width / element DEVICE width (P0.2: was 0.5 of the page's store — a 1x page on a 2.5x panel got 519-px eyes)
    maxEyeDpr: 3,       // the device-pixel ratio the eye is sized at, at most
    maxSbsWidth: 3072,  // browser-pvt#24: wider SBS canvases drop off the zero-copy weave path
    minCssPx: 120,      // smaller canvases stay flat (icons, thumbnails)
    holdMs: 1200,       // keep the cover this long after the layer exists (woven-canvas rules, rule 5)
    coverMaxMs: 5000,   // ... but never longer than this, stereo or not (R6: a display with nobody seated)
    releaseMaxMs: 500,  // turn-off: release the layer this long after the stand at the latest, mono frame or not
    rampMs: 500,        // depth fades in after the cover drops, and back to flat before a turn-off swaps to 2D
    convTarget: true,   // prefer the page's explicit target (controls / lookAt) over the estimator
    noViewsMs: 4000,    // no 2-view frame this long after the layer -> back to 2D, retry later
    eyesOffMs: 1000,    // the chip's dot goes amber only after this long continuously without 2-view frames ...
    eyesOnMs: 300,      // ... and back to green after this long with them (eye tracking flips isTracking every few s)
    fakeViews: false,   // TEST ONLY: synthesise a parallel-axis pair when the session reports none
    guardFps: 40,       // frame-rate guard (guard.js): back to 2D when 3D runs below this over guardMs ...
    guardMs: 2000,      // ... (and below 0.8 x the page's 2D rate, when it has one)
    guardWarmupMs: 4000, // ... no guard window starts within this long after the cover drop (a page still loading its assets)
    guardRetryMs: 6000,  // ... the first trip stands down, then retries once after this long, whatever the 2D rate
    glLimit: 0,         // TEST ONLY: > 0 stands in for the GL size limits in realSizeFor
  };
  // Keys of the harness config that are the SITE's (the dev host applies them), not tuning.
  const SITE_KEYS = ['v', 'enabled', 'decision', 'depth', 'depths', 'rig', 'convScale', 'hud'];
  const T = { ...TUNING };
  if (cfg.dev && cfg.test && typeof cfg.test === 'object') {
    for (const k of Object.keys(cfg.test)) if (!SITE_KEYS.includes(k)) T[k] = cfg.test[k];
  }
  // prefers-reduced-motion: no depth fade, but 1 ms, never 0 — rampMs 0 skips the turn-off's
  // out-cover (turnOff), and the raw side-by-side flash comes back (risk R5).
  const RAMP_MS = T.rampMs;
  const reducedMotion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  const applyMotion = () => { T.rampMs = reducedMotion && reducedMotion.matches ? 1 : RAMP_MS; };
  applyMotion();
  if (reducedMotion && reducedMotion.addEventListener) reducedMotion.addEventListener('change', applyMotion);

  // ------------------------------------------------------------ the site (this document's copy)
  // What the host decided for this site, and what the user changes here. Written back through
  // cap.save (the host validates and keys it); never read back from the page.
  const cd = cfg.depths || {};
  const site = {
    decision: cfg.decision === 'allow' || cfg.decision === 'offer' ? cfg.decision : 'block',
    depths: { camera: cd.camera > 0 ? cd.camera : DEFAULT_DEPTH.camera, display: cd.display > 0 ? cd.display : DEFAULT_DEPTH.display },
    rig: cfg.rig === 'display' ? 'display' : 'camera',
    convScale: typeof cfg.convScale === 'number' && cfg.convScale > 0 ? Math.min(CONV_SCALE_MAX, Math.max(CONV_SCALE_MIN, cfg.convScale)) : 1,
  };
  // "Just this time" (setEnabled(v, { remember: false })): true / false overrides the decision for
  // this document only; null follows it.
  let once = null;
  const on = () => (once !== null ? once : site.decision === 'allow');
  const save = (partial) => { try { cap.save(partial); } catch (e) { warnOnce('save', 'could not save the site setting', e); } };

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
  // Snapshotted by the sentinel before any page script could patch them (risk R4).
  const CANVAS_W = S.intrinsics.canvasWidth;
  const CANVAS_H = S.intrinsics.canvasHeight;
  const realW = (c) => CANVAS_W.get.call(c);
  const realH = (c) => CANVAS_H.get.call(c);

  // ------------------------------------------------------------ document-level state
  const tracked = [];           // WeakRef<state>, for state() and the HUD
  let owner = null;             // the one canvas converted (or converting) — one inline-3D session per document
  let lastTarget = null;        // the last canvas we converted: the chip keeps pointing at it after release
  let candidate = null;         // while OFF (offer / block in dev): a canvas that would convert — the chip's target
  let foreign = null;           // why we stood down for good in this document (the page owns inline-3D / XR)
  const engines = [];           // adapter names, for the HUD / console

  // ------------------------------------------------------------ navigator.xr: yield to the page
  // The requestSession wrapper lives in the sentinel (risk R3: a page may ask for inline-3d before
  // the core exists). Our own requests go straight to the captured original through S.xrRequest, so
  // the wrapper only ever sees the page's (or the immersive shim's). The sentinel calls yieldTo on
  // every such request (wired at the end of dxrCore, with a catch-up for one made before we loaded).
  const xrRequest = S.xrRequest;
  function yieldTo(reason) {
    if (!foreign) { foreign = reason; info('standing down for this document:', reason); standDownForGood(); }
    if (owner) stand(owner, reason);
    notify();
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
  //   restore(wasLive)         -> undo afterActive/beforeActive (stand-down); returns true when the
  //                               mono frame is already drawn, else calls core.monoDrawn(st) once it is
  //   flipIdle()               -> the armed canvas has not drawn for 250 ms: draw + flip now
  //   wake()                   -> re-enabled: draw one mono frame now, so a render-on-demand page
  //                               reaches considerActivation without waiting for input
  //   target()                 -> the page's explicit convergence target in world space
  //                               ({ x, y, z, via }) or null (controls .target, an orbit script, lookAt)
  //   describe()               -> { page, real } for state()
  //   gl()                     -> the page's WebGL context for this canvas (read-backs, GL limits)
  // and calls core.drew(st) after every draw / replay on the live SBS store (the first one starts
  // the no-views timer).
  function newState(engine, canvas, ad) {
    const st = {
      engine, canvas, ad,
      active: false, pending: false, armed: null, tries: 0, nextTry: 0, lastWhy: null, flatReason: null,
      session: null, ref: null, layer: null, layerAt: 0, rig: { position: { x: 0, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } },
      V: [0, 1].map(() => ({ proj: new Float32Array(16), pose: new Float32Array(16) })),
      haveViews: false, near: NaN, far: NaN, R: null,
      conv: { d: 0, src: 'estimator', via: null }, cover: null, savedStyle: null, displayOk: null,
      releasing: null, wakeOnRelease: false, eyeBack: 0, rigs: null,
      lastTwoAt: 0, noDisplay: false, nd: false, eyesOn: false, twoRun: 0, shortRun: 0,
      stats: { calls: 0, stereo: 0, flat: 0, flatAfterEyes: 0, replays: 0, resizes: 0, xrFrames: 0, twoView: 0, shortView: 0 },
    };
    tracked.push(new WeakRef(st));
    return st;
  }

  // ------------------------------------------------------------ sizing
  // st.L is what the PAGE believes: { w, h, pr } (three: CSS-ish size × pixel ratio; PlayCanvas:
  // pixels, pr 1). The eye is sized from the ELEMENT's device pixels, whatever store the page keeps
  // (P0.2: Spark's hello-world renders at pixel ratio 1 on a 2.5× panel, a 1038-px store, so a
  // store-sized eye was 519 px — "a little low res"): eyeW = CSS width × min(devicePixelRatio,
  // maxEyeDpr) × eyeScale, eyeH = CSS height × the same ratio. The page keeps seeing its own mono
  // store (the adapters virtualise it; restore() puts it back). With no layout box (not rendered),
  // the page's store stands in. The SBS store then fits the zero-copy width cap AND the context's own
  // limits (a 2× wide store is over MAX_TEXTURE_SIZE / MAX_VIEWPORT_DIMS on many Android GPUs); one
  // scale for both axes, so the eye keeps its aspect.
  function realSizeFor(st) {
    const L = st.L, c = st.canvas;
    const cw = c.clientWidth, ch = c.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, T.maxEyeDpr);
    let eyeW, eyeH;
    if (cw > 0 && ch > 0) { eyeW = Math.max(2, Math.round(cw * dpr * T.eyeScale)); eyeH = Math.max(2, Math.round(ch * dpr)); }
    else { eyeW = Math.max(2, Math.round(L.w * L.pr * T.eyeScale)); eyeH = Math.max(2, Math.round(L.h * L.pr)); }
    if (st.glLim === undefined) {
      const gl = st.ad.gl(st);
      if (gl) {
        let v = Infinity;
        try { const vp = gl.getParameter(gl.MAX_VIEWPORT_DIMS); v = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), vp[0], vp[1]); } catch (e) { v = Infinity; }
        st.glLim = v > 0 ? v : Infinity; // cached per canvas: a context's limits do not change
      }
    }
    const lim = T.glLimit > 0 ? T.glLimit : st.glLim || Infinity;
    const s = Math.min(1, Math.min(T.maxSbsWidth, lim) / (2 * eyeW), lim / eyeH);
    if (s < 1) {
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
    const t = now();
    guard.draw(st, t); // the page's 2D rate (the frame-rate guard's baseline)
    if (!on()) { if (!foreign && !owner) considerCandidate(st); return; }
    if (foreign || owner || guard.tripped || guard.retrying) return;
    if (t < st.nextTry) return;
    st.nextTry = t + 500;
    if (S.optedOut()) { standDownForGood(); notify(); return; } // <meta name="displayxr-auto3d" content="off">
    const why = st.ad.unqualified(st);
    if (why) {
      if (why !== st.lastWhy) { st.lastWhy = why; info('not converting', desc(st.canvas), 'yet:', why); }
      return;
    }
    activate(st);
  }
  // While OFF nothing converts, but the chip still needs a canvas to offer 3D on (offer mode, and
  // the 'off' pill in dev): the same qualification, throttled the same way, on its own clock.
  function considerCandidate(st) {
    const t = now();
    if (t < (st.candAt || 0)) return;
    st.candAt = t + 500;
    const ok = !st.ad.unqualified(st);
    const next = ok ? st : candidate === st ? null : candidate;
    if (next !== candidate) { candidate = next; notify(); }
  }
  // Where the canvas is: in the document, big enough, on screen.
  function canvasPlacement(c) {
    if (!c.isConnected) return 'canvas is not in the document';
    const rect = c.getBoundingClientRect();
    if (rect.width < T.minCssPx || rect.height < T.minCssPx) return `canvas is small (${rect.width | 0}x${rect.height | 0} CSS px)`;
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
    owner = st; lastTarget = st; st.pending = true; st.lastWhy = null; st.tries++;
    info('converting', desc(st.canvas), `(${st.ad.label(st)})`);
    notify();
    let session = null;
    try {
      session = await xrRequest('inline-3d');
      if (!st.pending || foreign || !on()) { try { session.end(); } catch (e) { /* ignore */ } return; }
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
      notify();
    }
  }
  // Called by the adapter in the task that just drew the page's mono frame.
  function flip(st) {
    const ad = st.ad;
    st.armed = null;
    dropCover(st);
    makeCover(st);            // the mono frame just drawn, over the canvas, until the join (rule 5)
    ad.beforeActive(st);
    st.active = true; st.pending = false;
    promote(st);
    ad.afterActive(st);
    const dr = depthRangeFor(st);
    st.near = dr.near; st.far = dr.far;
    try { st.session.updateRenderState({ depthNear: dr.near, depthFar: dr.far }); } catch (e) { /* ignore */ }
    estimateConvergence(st, true);
    const rig = buildRig(st, ad.rigFov(st));
    try {
      // T.noLayer is TEST ONLY: everything but the weave binding, so a 2D instance shows the raw pair.
      st.layer = T.noLayer ? null : new XRDisplayLayer(st.session, st.canvas, HAS_RIG ? { viewRig: { ...rig } } : { virtualDisplayHeight: 0.24 });
    } catch (e) {
      warnOnce('layer', 'new XRDisplayLayer() failed — staying 2D', e);
      stand(st, 'XRDisplayLayer refused the canvas');
      st.nextTry = Infinity;
      return;
    }
    st.layerAt = now(); st.coverDropAt = 0;
    st.stereo0 = st.stats.stereo; st.coverForced = false; // this activation's first stereo frame (status, forced cover)
    guard.onFlip(st);
    st.drawnAt = 0; // the no-views timer starts at the first draw / replay on the SBS store (drew())
    st.displayOk = null;
    st.lastTwoAt = 0; st.noDisplay = false; st.nd = false; st.eyesOn = false; st.twoRun = 0; st.shortRun = 0;
    st.rampK = T.rampMs > 0 ? 0 : 1; st.ramp = null; // flat under the cover; fades in once it drops
    if (!st.cover && st.rampK < 1) startRamp(st, 1);
    if (st.layer && !T.fakeViews) probeDisplay(st, st.layer); // fakeViews (tests) run where there is no display on purpose
    if (T.noLayer) {
      // TEST ONLY: no layer means no session frames, so seed the fake eyes here and lift the cover
      // on a timer — the canvas then shows the raw side-by-side pair a 2D instance can screenshot.
      if (T.fakeViews) { fakeViews(st); st.haveViews = true; }
      setTimeout(() => dropCover(st), T.holdMs);
    }
    const session = st.session;
    const loop = (t, f) => {
      if (!st.active || st.session !== session) return;
      try { session.requestAnimationFrame(loop); } catch (e) { return; }
      onSessionFrame(st, f);
    };
    session.requestAnimationFrame(loop);
    ad.firstDraw(st);
    try { S.settle(st.canvas); } catch (e) { /* the sentinel's search is best-effort */ }
    info(`live on ${desc(st.canvas)}: SBS ${st.R.W}x${st.R.H} (eye ${st.R.eyeW}x${st.R.eyeH}), rig ${HAS_RIG ? rigMode() : 'display (no setViewRig)'},`,
      `convergence ${st.conv.d.toPrecision(3)} units (${convSource(st)}${st.conv.via ? ': ' + st.conv.via : ''}), depth ${depthOf()}`);
    notify();
  }
  // Back to 2D. Two orders:
  //
  //  - immediate (the default): the layer and the session go at once. Used when the page needs the
  //    session back (it asked for inline-3D / WebXR itself), the canvas or the document is going
  //    away, or nothing was woven (no display, never live).
  //  - staged (opts.staged, a LIVE canvas that stays on screen: the site turned off, the camera
  //    switched, no eyes): MONO FIRST, RELEASE AFTER. The store goes back to its mono size and a
  //    mono frame is drawn while the layer is still bound; the layer is closed and the session ended
  //    only on the second animation frame after that frame was drawn, i.e. once it has been
  //    committed. Closing first would let the browser stop weaving (layer.close() reaches it on its
  //    own channel) while the last COMMITTED frame is still the side-by-side pair: that pair, unwoven,
  //    is the raw-SBS flash (woven-canvas rules §1). With this order the frames around the switch are
  //    either the woven pair or the page's own mono pixels. The one in-between frame, a mono store
  //    under a still-bound layer, is withheld by the browser (its resource changed, so it cannot
  //    join: the page's pixels, i.e. mono) rather than woven. The join-window cover, if still up,
  //    stays until the release.
  function stand(st, reason, opts) {
    if (st.releasing) { release(st); return; } // a second stand while one is staged: finish it now
    const was = st.active || st.pending || !!st.armed;
    const wasLive = st.active; // only a live canvas was resized to the SBS store
    st.active = false; st.pending = false; st.armed = null;
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
      if (owner === st) owner = null;
    }
    if (was) info('back to 2D:', reason);
    notify();
  }
  function closeLayer(st) {
    if (st.layer) { try { st.layer.close(); } catch (e) { /* ignore */ } st.layer = null; }
    if (st.session) { const s = st.session; st.session = null; try { s.end().catch(() => {}); } catch (e) { /* ignore */ } }
  }
  // The adapter drew (or replayed) a frame on the live SBS store: starts the no-views timer once.
  function drew(st) { if (st.active && !st.drawnAt) st.drawnAt = now(); }
  // The adapter's mono frame after a staged stand has been drawn (PlayCanvas draws it on its next tick).
  function monoDrawn(st) { if (st.releasing) st.releasing.drawn = true; }
  function release(st) {
    const rel = st.releasing;
    if (!rel) return;
    st.releasing = null;
    closeLayer(st);
    unpromote(st);
    if (st.cover && st.cover.out) {
      // Held until layer.close() has landed AND the canvas has re-rastered as a plain 2D layer at its
      // mono size (the resize clears it; a cover dropped before that shows a blank, white frame).
      const c = st.cover, t0 = now(); let n = 0;
      st.cover = null;
      const tick = () => { if (++n >= 6 && now() - t0 >= (T.outHoldMs || 150)) c.el.remove(); else requestAnimationFrame(tick); }; // outHoldMs: diagnostics only (a long hold shows what the cover holds)
      requestAnimationFrame(tick);
    }
    else dropCover(st);
    if (owner === st) owner = null;
    info(`layer released ${Math.round(now() - rel.at)} ms after the stand (${rel.drawn ? 'mono frame drawn first' : 'no mono frame: timed out'})`);
    if (st.wakeOnRelease) { st.wakeOnRelease = false; wake(st); }
    notify();
  }
  function wake(st) {
    if (!on() || foreign || owner) return;
    try { if (st.ad.wake) st.ad.wake(st); } catch (e) { warnOnce('wake', 'could not draw a frame on re-enable', e); }
  }
  // The site switch. remember: false is "Just this time": it overrides the site decision for this
  // document only and saves nothing.
  function setEnabled(v, opts) {
    if (opts && opts.remember === false) once = !!v;
    else { once = null; site.decision = v ? 'allow' : 'block'; save({ decision: site.decision }); }
    info('auto-3D', on() ? 'ON' : 'OFF', 'for', location.origin);
    if (!on() && owner) turnOff(owner, 'turned off for this site');
    if (on() && owner) owner.offTok = null; // a turn-off still fading / covering out does not stand any more
    if (on() && owner && owner.active && owner.ramp && owner.ramp.to === 0) startRamp(owner, 1); // turned back on mid-fade: fade back up
    if (on()) {
      // A render-on-demand page draws nothing until input, so nothing would ever reach
      // considerActivation: ask each adapter for one frame (finding 1 of the first panel run).
      for (const w of tracked) {
        const st = w.deref();
        if (!st) continue;
        st.nextTry = 0; st.tries = 0; st.lastWhy = null;
        if (st.releasing) st.wakeOnRelease = true; else wake(st);
      }
    }
    notify();
  }
  // A LIVE canvas back to 2D without a visible jump, shared by the site switch and the frame-rate
  // guard: fade to flat first (both eyes on the page camera), THEN swap to the mono canvas under the
  // out-cover (the staged stand). The swap is then between two identical pictures.
  function turnOff(st, reason) {
    const tok = (st.offTok = {});
    const go = () => { if (st.offTok === tok && owner === st) { st.offTok = null; stand(st, reason, { staged: true }); } };
    if (st.active && !st.cover && !st.releasing && T.rampMs > 0) startRamp(st, 0, go);
    else { st.offTok = null; stand(st, reason, { staged: true }); }
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
    st.noDisplay = true; // the chip's outline "no display" pill, report { flat, no-display }
    stand(st, 'no display behind the layer (getDisplayInfo() null, no rendering modes) — is another DisplayXR Browser holding it? (browser#162)');
    st.nextTry = now() + 30000;
  }
  function promote(st) {
    // The SDK's compositing hint (inline3d.js _register): a distinct quad the weave can track.
    const c = st.canvas, s = c.style, cs = getComputedStyle(c);
    st.savedStyle = { willChange: s.willChange, transform: s.transform, pin: null };
    s.willChange = 'transform';
    if (cs.transform === 'none') s.transform = 'translateZ(0)';
    // A canvas with no CSS size is laid out at its STORE size: the SBS store (2 × the device-pixel eye)
    // would grow it on the page, and the next realSizeFor would read that. Pin its current used size
    // (the same box: no layout change) while converted; unpromote() takes the pin back out.
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

  // ------------------------------------------------------------ the session frame
  function onSessionFrame(st, frame) {
    const ad = st.ad;
    st.stats.xrFrames++;
    if (st.stats.xrFrames % 30 === 0 && !st.offTok && S.optedOut()) { standDownForGood(); turnOff(st, 'the page opted out (<meta name="displayxr-auto3d" content="off">)'); }
    if (!st.canvas.isConnected) { stand(st, 'the canvas left the document'); return; }
    let views = null;
    try { const pose = st.ref ? frame.getViewerPose(st.ref) : null; views = pose ? pose.views : null; } catch (e) { /* no pose */ }
    const t = now();
    let two = false;
    if (views && views.length >= 2) {
      two = true;
      // COPIES: an XRView is valid only inside this callback (porting pitfall 9).
      for (let i = 0; i < 2; i++) { st.V[i].proj.set(views[i].projectionMatrix); st.V[i].pose.set(views[i].transform.matrix); }
      st.haveViews = true; st.stats.twoView++;
      // How far behind the page camera the runtime put the eyes (a display rig backs them off to the
      // nominal viewing distance): the far plane is pushed out by that much so nothing new clips.
      st.eyeBack = Math.max(0, Math.min(st.V[0].pose[14], st.V[1].pose[14]));
    } else {
      st.stats.shortView++;
      if (T.fakeViews && ad.hasCamera(st)) { fakeViews(st); st.haveViews = true; two = true; }
    }
    trackEyes(st, t, two);
    // Timed from the first draw on the SBS store, not from the layer: a render-on-demand page (or
    // one busy loading) may not draw for a while after activation, and a runtime has nothing to
    // locate eyes for until the tile has content. No draw yet = no timeout (the join-window cover,
    // which only drops after a stereo frame, keeps the page's own mono picture up meanwhile).
    if (!st.haveViews && st.displayOk !== true && st.drawnAt && t - st.drawnAt > T.noViewsMs) {
      st.noDisplay = !st.lastTwoAt; // never a 2-view frame in this activation: most likely no weave slot
      stand(st, `no 2-view frame within ${T.noViewsMs} ms (nobody tracked, or this browser instance has no weave slot — browser#162)`, { staged: true });
      st.nextTry = st.tries < 3 ? t + 15000 : Infinity;
      return;
    }
    if (ad.hasCamera(st)) {
      // The depth range follows the camera (porting guide §4 — a camera's far often moves once, after load).
      const dr = depthRangeFor(st);
      if (dr.near !== st.near || dr.far !== st.far) {
        st.near = dr.near; st.far = dr.far;
        try { st.session.updateRenderState({ depthNear: dr.near, depthFar: dr.far }); } catch (e) { /* ending */ }
      }
      // The page's explicit target is cheap and followed every frame; the estimator walks the scene,
      // so it runs every 30 frames, as before.
      if (!estimateConvergence(st, false, true) && st.stats.xrFrames % 30 === 0) estimateConvergence(st, false);
      tickRamp(st, t);
      // Pushed every frame and before any draw: a rig drives the NEXT locate.
      if (HAS_RIG && st.layer) { try { st.layer.setViewRig(buildRig(st, ad.rigFov(st))); } catch (e) { warnOnce('rig', 'setViewRig failed', e); } }
    }
    // Redraw every frame (woven-canvas rules): the adapter replays the page's last frame when the
    // page drew nothing since the last session frame.
    ad.redraw(st);
    // The out-cover must be read in the task that drew the flat pair (preserveDrawingBuffer false):
    // three.js draws inside redraw() above (or the page drew in this same animation frame); an
    // adapter whose engine draws later, on its own tick (PlayCanvas), sets coverAfterDraw and calls
    // takeOutCover from its post-draw hook instead.
    if (st.outCoverDue && !ad.coverAfterDraw) takeOutCover(st);
    tickCover(st, t);
    guard.tick(st, t);
    chip.frame(st);
    if (st.stats.xrFrames % 20 === 0) notify();
  }

  // The two-view state, per session frame. lastTwoAt: the last 2-view frame of this activation (0:
  // none yet). eyes: the DEBOUNCED "eyes tracked" the chip's dot shows — eye tracking flips
  // isTracking 0/1 every few seconds in normal use, and a dot that followed every flip would blink.
  // Amber only after eyesOffMs continuously without 2-view frames, green after eyesOnMs with them.
  // nd: live but no display for this window (P0.2) — the layer found none (displayOk false), or no
  // 2-view frame has arrived in the coverMaxMs since the layer (a second browser instance whose
  // session got XR_ERROR_LIMIT_REACHED stays mono). The chip shows the outline pill and the core
  // reports { status: 'flat', reason: 'no-display' }; the noViewsMs stand-down is unchanged.
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
    const nd = st.active && !T.noLayer && (st.displayOk === false || (!st.lastTwoAt && T.coverMaxMs > 0 && t - st.layerAt > T.coverMaxMs));
    if (nd !== st.nd) {
      st.nd = nd;
      if (nd) info(`no 2-view frame in the ${T.coverMaxMs} ms since the layer: 3D display not available to this window (another browser instance holding it?) — flat until one arrives`);
      notify();
    }
  }

  function takeOutCover(st) {
    // Turn-off, depth already faded to flat: cover the canvas with one eye of the frame just drawn
    // (flat, so it IS the mono picture), then swap to the mono canvas and release the layer under it.
    // Without it, the one frame of mono canvas under a still-bound layer is woven as a pair.
    const done = st.outCoverDue;
    if (!done) return;
    st.outCoverDue = null;
    makeCover(st, true);
    const el = st.cover && st.cover.el;
    const go = () => requestAnimationFrame(() => requestAnimationFrame(done));
    if (!el || el.isConnected) go(); // no cover, or the canvas cover (already painted in this task)
    else {
      // The <img> goes in only once decoded: inserted earlier, its box paints its CSS background
      // for the frame(s) before the image lands (a blank/white flash at 3D->2D on the panel).
      const place = () => {
        if (!st.canvas.isConnected) { done(); return; }
        try { if (st.cover && st.cover.el === el) insertCover(st.canvas, el); } catch (e) {} // not if released meanwhile; done() always follows
        go();
      };
      if (typeof el.decode === 'function') el.decode().then(place, place); else place();
    }
  }

  // ------------------------------------------------------------ the rig
  const rigMode = () => (site.rig === 'display' ? 'display' : 'camera');
  // The ACTIVE rig's depth: the one the HUD shows and Ctrl+Alt+= / - move.
  const depthOf = (mode) => clamp(site.depths[mode || rigMode()] || DEFAULT_DEPTH[mode || rigMode()], DEPTH_MIN, DEPTH_MAX);
  function setDepth(v) { site.depths = { ...site.depths, [rigMode()]: clamp(v, DEPTH_MIN, DEPTH_MAX) }; }
  const convSource = (st) => (site.convScale !== 1 ? 'manual' : st.conv.src);
  function depthRangeFor(st) {
    const dr = st.ad.depthRange(st);
    return rigMode() === 'display' && st.eyeBack > 0 ? { near: dr.near, far: dr.far + st.eyeBack } : dr;
  }
  // The rig pushed every frame. Both are DECLARED, never computed: the runtime owns the off-axis
  // math and hands back render-ready views (attach pattern: the rig lives in the page camera's
  // space, so eye world = page camera world × view.transform on either rig).
  // ------------------------------------------------------------ the depth fade
  // rampK scales the rig's ipd and parallax factors: 0 = both eyes on the page camera (a flat,
  // mono-identical picture), 1 = the configured depth. Smoothstep over T.rampMs.
  const rampK = (st) => (st.rampK === undefined ? 1 : st.rampK);
  function startRamp(st, to, done) {
    const r = (st.ramp = { from: rampK(st), to, t0: now(), done: done || null, held: 0 });
    // A page whose session frames stop must still finish a turn-off.
    if (done) setTimeout(() => { if (st.ramp === r || st.outCoverDue === done) { st.ramp = null; st.outCoverDue = null; st.rampK = to; done(); } }, T.rampMs + 1000);
  }
  function tickRamp(st, t) {
    const r = st.ramp;
    if (!r) return;
    const u = T.rampMs > 0 ? clamp((t - r.t0) / T.rampMs, 0, 1) : 1;
    st.rampK = r.from + (r.to - r.from) * u * u * (3 - 2 * u);
    if (u < 1) return;
    // At the target: a rig drives the NEXT locate, so let two frames with it reach the screen first.
    if (r.done && ++r.held < 3) return;
    st.ramp = null;
    if (r.done) st.outCoverDue = r.done; // the out-cover is made after this frame's draw, in the drawing task
  }
  function buildRig(st, verticalFov) {
    if (!st.rigs) {
      st.rigs = {
        camera: st.rig,
        display: { type: 'display', position: { x: 0, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } },
      };
    }
    const d = Math.max(1e-6, (st.conv.d || 1) * site.convScale);
    if (rigMode() === 'display') {
      // DISPLAY rig, for object-centric scenes (the P key of legacy WebXR apps): the canvas is a
      // portal onto a virtual display. Framing: the portal sits on the convergence plane, square to
      // the page camera, and is exactly as tall as the page camera's view there — what the author
      // framed at the subject is what the portal shows, and it sits on the glass. The runtime then
      // places the eyes at the viewer's real distance (m2v = height / physical canvas height), so
      // the FOV becomes the display's own and depth is scale-invariant (a figurine and an airliner
      // get the same stereo). Comfort: a display rig's comfort number is its ipdFactor (content at
      // infinity is ipdFactor × IPD of disparity), so `depth` keeps one meaning on both rigs.
      // ONE joint control, as on the camera rig (where metersToVirtual scales the eye separation AND
      // the head motion together): ipdFactor = parallaxFactor = depth. Depth 1 is the true portal;
      // less flattens the stereo and damps the look-around by the same factor.
      const r = st.rigs.display;
      r.position.x = r.position.y = 0; r.position.z = -d;
      r.orientation.x = r.orientation.y = r.orientation.z = 0; r.orientation.w = 1;
      r.virtualDisplayHeight = 2 * d * Math.tan(verticalFov / 2);
      const k = rampK(st);
      const dep = depthOf('display');
      r.ipdFactor = dep * k;
      r.parallaxFactor = dep * k;
      r.perspectiveFactor = 1;
      st.rig = r;
      return r;
    }
    const rig = st.rigs.camera;
    rig.type = 'camera';
    // attach: identity pose — the page camera's world transform supplies THIS frame's pose at draw time.
    rig.position.x = rig.position.y = rig.position.z = 0;
    rig.orientation.x = rig.orientation.y = rig.orientation.z = 0; rig.orientation.w = 1;
    rig.verticalFov = verticalFov;
    rig.convergenceDiopters = 1 / d;
    // metersToVirtual grows with the convergence distance: the depth budget is then the same for a
    // 10 cm product and a 150 m airliner (what a display rig gives an authored page), and
    // comfort = ipd × m2v × diopters × 0.5 = the camera rig's depth by construction.
    rig.metersToVirtual = (depthOf('camera') * d) / 0.5;
    // Scaled by the fade (1 when settled): 0 puts both eyes on the page camera, i.e. the mono picture.
    const k = rampK(st);
    rig.ipdFactor = k;
    rig.parallaxFactor = k;
    st.rig = rig;
    return rig;
  }
  // Convergence: the page's explicit target when it has one and the camera is actually looking at
  // it, else the scene estimator. Returns false when there was nothing to go on (targetOnly: no
  // usable target).
  function estimateConvergence(st, snap, targetOnly) {
    const s = st.ad.sampler(st);
    if (!s) return false;
    let d = T.convTarget ? targetDepth(st, s) : 0, src = 'target';
    if (!(d > 0)) {
      if (targetOnly) return false;
      src = 'estimator'; st.conv.via = null;
      d = estimateSubjectDistance(s);
      if (!(d > 0) || !isFinite(d)) d = st.conv.d || Math.max(s.near * 50, 1);
    }
    d = clamp(d, s.near * 2, s.far * 0.9);
    // Eased: a convergence that snaps pulls the whole scene through the glass in one frame.
    st.conv.d = snap || !st.conv.d ? d : st.conv.d + (d - st.conv.d) * 0.25;
    st.conv.src = src;
    return true;
  }
  // The target's depth along the camera's view axis, or 0 when there is no target or the camera is
  // not looking at it (conservative: a lookAt the camera has since moved away from is stale). A
  // camera that looked at the point has it on its axis; allow a quarter of the half-FOV of drift.
  function targetDepth(st, s) {
    let t = null;
    try { t = st.ad.target ? st.ad.target(st) : null; } catch (e) { t = null; }
    if (!t || !isFinite(t.x) || !isFinite(t.y) || !isFinite(t.z)) return 0;
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
  //   forEachBounds(cb)  calls cb(wx, wy, wz, worldRadius, among?) per drawable in view layers; stop when cb returns false.
  //                      among = true: the item is a piece of a volume that holds the camera (a room-scale splat
  //                      world fed as its splats in view): the camera stands among the items, so the median rule applies
  // }
  function estimateSubjectDistance(s) {
    const cw = s.cameraPose;
    const vm = s.viewMatrix || invert4(cw);
    const px = cw[12], py = cw[13], pz = cw[14];
    const tanV = s.tanHalfFov !== undefined ? s.tanHalfFov : Math.tan(s.verticalFov / 2), aspect = s.aspect || 1;
    const near = s.near;
    const items = [];
    let n = 0, among = false;
    s.forEachBounds((wx, wy, wz, wr, inVolume) => {
      if (n >= 4000) return false;
      n++;
      if (Math.hypot(wx - px, wy - py, wz - pz) <= wr) return true;
      if (inVolume) among = true;
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
    if (!among && Math.hypot(cx - px, cy - py, cz - pz) > R) return -(vm[2] * cx + vm[6] * cy + vm[10] * cz + vm[14]);
    items.sort((a, b) => a.z - b.z);
    let tot = 0;
    for (const it of items) { it.k = Math.min(1, (it.r / it.z) ** 2); tot += it.k; }
    let acc = 0;
    for (const it of items) { acc += it.k; if (acc >= tot * 0.5) return it.z; }
    return items[items.length - 1].z;
  }
  // TEST ONLY (T.fakeViews): a parallel-axis pair with sheared frusta converging at the rig's
  // distance, so the SBS plumbing can be exercised on an instance whose session reports no eyes.
  // A real session never takes this path: the runtime owns the off-axis math.
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
  function makeCover(st, eyeOnly) {
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
      if (eyeOnly && st.R) {
        // Left eye of the flat pair. drawImage() of the layer-bound canvas is EMPTY on the panel
        // (above), so the adapter reads it back from the page's GL context (readPixels) instead.
        let got = false;
        try { got = !!(st.ad.readEye && st.ad.readEye(st, c)); } catch (e) { got = false; }
        if (!got) {
          warnOnce('outcover', 'could not read the flat frame back from WebGL — the 3D->2D cover may be blank');
          c.getContext('2d').drawImage(cv, 0, 0, st.R.eyeW, st.R.eyeH, 0, 0, c.width, c.height);
        }
      }
      else c.getContext('2d').drawImage(cv, 0, 0, c.width, c.height); // the mono frame drawn in this same task
      if (T.coverImg !== false) {
        // An <img>, not a <canvas> (panel run 2026-09-27): a canvas congruent with the tile is woven with
        // it (weave dumps showed the mono cover as the SBS input = David's 'big double image' at go-live).
        // An <img> stays plain 2D over the tile. T.coverImg = false restores the canvas cover.
        const img = document.createElement('img');
        img.setAttribute('data-dxr-auto3d-cover', ''); img.alt = '';
        // 'sync' keeps cc from checker-imaging it: a large image is otherwise skipped on its first
        // raster, and the box paints only its background for a frame (the page-colour flash at 3D->2D).
        if (eyeOnly) img.decoding = 'sync';
        img.src = c.toDataURL('image/png');
        img.style.cssText = c.style.cssText; img.style.objectFit = 'fill';
        if (!eyeOnly) insertCover(cv, img); // the out-cover is inserted by its caller, once decoded
        st.cover = { el: img, fixed, out: !!eyeOnly };
        return;
      }
      insertCover(cv, c);
      st.cover = { el: c, fixed };
    } catch (e) { st.cover = null; }
  }
  function insertCover(cv, el) {
    if (cv.parentNode) cv.parentNode.insertBefore(el, cv.nextSibling);
    else (document.body || document.documentElement).appendChild(el);
  }
  // Copies the LEFT eye (store rect 0,0,eyeW,eyeH) of the default framebuffer's CURRENT contents into
  // the 2D canvas `target`, scaled to it, forced opaque. Must run in the task that drew it (the pages'
  // preserveDrawingBuffer is false). Leaves every GL binding / pack parameter it touches as it found it.
  // false = could not (no context, lost, readPixels threw, or the read came back all zero).
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
      // GL origin is bottom-left: the store's top rows (canvas y 0..h) are GL rows bh-h..bh.
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
  function tickCover(st, t) {
    const cv = st.cover;
    if (!cv) {
      // Dropped at coverMaxMs with no stereo frame: the depth fades in from the first one instead.
      if (st.coverForced && st.stats.stereo > (st.stereo0 || 0)) { st.coverForced = false; if (st.rampK < 1 && !st.ramp) startRamp(st, 1); }
      return;
    }
    if (!cv.out && t - st.layerAt >= T.holdMs && st.stats.stereo > 0) {
      dropCover(st); // a hard cut, never a fade: the picture under it is flat (rampK 0) and fades in from here
      st.coverDropAt = t; // the frame-rate guard's warm-up counts from here
      info(`cover released ${Math.round(t - st.layerAt)} ms after the layer (hold ${T.holdMs} ms)`);
      if (st.rampK < 1) startRamp(st, 1);
      return;
    }
    if (!cv.out && T.coverMaxMs > 0 && t - st.layerAt >= T.coverMaxMs) {
      // R6: a display is there (displayOk) but nobody is tracked, so no stereo frame ever comes and the
      // cover would stay up forever. Drop it anyway: with no views the pair under it is flat (both eyes
      // on the page camera), i.e. the mono picture, and the chip shows amber. rampK stays 0 until the
      // first stereo frame (above), so depth never pops in un-faded.
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

  // ------------------------------------------------------------ status, notify, ctl
  // A canvas the adapter can see but will not convert for a structural reason (post-effects,
  // several cameras, WebGPU) — the reason a tester (HUD) or the host (report) gets for a flat page.
  const flatNote = () => {
    for (const w of tracked) { const st = w.deref(); if (st && st.flatReason) return st; }
    return null;
  };
  // One status for the chip, the dev HUD and the host. Report statuses:
  //   'live' | 'converting' | 'standdown' | 'optout' | 'guard' | 'offer' | 'off' | 'flat' | 'idle'
  function statusOf() {
    const st = owner;
    if (foreign) return { status: 'standdown', reason: foreign };
    if (S.optedOut()) return { status: 'optout' };
    if (guard.tripped) return { status: 'guard', reason: guard.tripped };
    if (guard.retrying) return { status: 'converting', engine: (st || lastTarget || {}).engine, reason: guard.retrying };
    if (st && st.active && st.nd) return { status: 'flat', engine: st.engine, reason: 'no-display' };
    // Live but no stereo frame drawn yet (nobody tracked): not 3D to anyone, so 'converting'. The chip
    // still shows (amber) once the cover is down: `waiting`.
    if (st && st.active && st.stats.stereo <= (st.stereo0 || 0)) return { status: 'converting', engine: st.engine, waiting: true };
    if (st && st.active) return { status: 'live', engine: st.engine };
    if (st && (st.pending || st.armed)) return { status: 'converting', engine: st.engine };
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
      rig: rigMode(), depth: depthOf(), depths: { camera: depthOf('camera'), display: depthOf('display') },
      convScale: site.convScale, rigSupported: HAS_RIG, haveViews: !!(owner && owner.haveViews), tracking: !!(owner && owner.eyesOn),
      // For the chip (read-only facts; it never touches the state): the site switch, the cover over
      // the target (in- or out-cover) and when the layer came up (it keys its live moment off
      // layerAt + holdMs, risk R6: the cover may stay up with nobody seated), the depth fade.
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
  // The controller the chip and the dev hotkeys share. Every call notifies; remember: false saves nothing.
  const ctl = Object.freeze({
    status,
    setEnabled(v, opts) { setEnabled(v, opts); },
    setRig(m, opts) {
      site.rig = m === 'display' ? 'display' : 'camera';
      info(`${site.rig} rig for`, location.origin);
      if (remember(opts)) save({ rig: site.rig });
      notify();
    },
    // The ACTIVE rig's depth (joint ipd + parallax on both rigs).
    setDepth(v, opts) {
      setDepth(+v);
      if (remember(opts)) save({ depths: { ...site.depths } });
      notify();
    },
    // Convergence: +1 farther (x 1.15), -1 nearer, 0 back to automatic (scale 1).
    nudgeFocus(dir, opts) {
      site.convScale = dir > 0 ? clamp(site.convScale * 1.15, CONV_SCALE_MIN, CONV_SCALE_MAX) : dir < 0 ? clamp(site.convScale / 1.15, CONV_SCALE_MIN, CONV_SCALE_MAX) : 1;
      if (remember(opts)) save({ convScale: site.convScale });
      notify();
    },
    // The active rig's default depth and the automatic convergence.
    reset(opts) {
      setDepth(DEFAULT_DEPTH[rigMode()]);
      site.convScale = 1;
      if (remember(opts)) save({ depths: { ...site.depths }, convScale: site.convScale });
      notify();
    },
    onChange(cb) { listeners.push(cb); return () => { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); }; },
  });

  // Standing down for the rest of the document (the page owns XR, opted out, the guard blocked): the
  // sentinel's detection traps and polls have nothing left to find.
  let retired = false;
  function standDownForGood() {
    if (retired) return;
    retired = true;
    try { S.disarm(); } catch (e) { /* ignore */ }
  }

  // Product behaviour, not a dev feature (risk R8): leaving the page releases the session at once.
  window.addEventListener('pagehide', () => { if (owner) stand(owner, 'pagehide'); });

  // ------------------------------------------------------------ the parts
  const meta = {}; // per-engine facts adapters publish (three.js revision, PlayCanvas detection path, …)
  const core = {
    VERSION, TAG, HAS_RIG, DEFAULT_DEPTH, DEPTH_MIN, DEPTH_MAX, CONV_SCALE_MIN, CONV_SCALE_MAX, T, site, cfg,
    intrinsics: S.intrinsics,
    get owner() { return owner; },
    get foreign() { return foreign; },
    get lastTarget() { return lastTarget; },
    on, meta, tracked, engines,
    registerEngine(name) { if (!engines.includes(name)) engines.push(name); },
    info, warnOnce, clamp, now, desc, realW, realH, CANVAS_W, CANVAS_H,
    newState, considerActivation, canvasPlacement, cssEffect, flip, stand, monoDrawn, drew, yieldTo, notify, turnOff, save, standDownForGood, wake,
    realSizeFor, virtualizeCanvas, unvirtualizeCanvas,
    buildRig, estimateSubjectDistance, estimateConvergence, invert4, fakeViews,
    makeCover, dropCover, takeOutCover, readGlEye,
    rigMode, depthOf, convSource, rampK, flatNote, statusOf, setEnabled,
  };
  const guard = dxrGuard(core);
  chip = dxrChip(ctl, S);
  core.chip = chip; // dev.js: __dxrAuto3D.chip()
  dev = cfg.dev ? dxrDev(core, ctl) : null;
  const en = cfg.engines || {};
  const three = en.three === false ? null : dxrThree(core);
  const playcanvas = en.playcanvas === false ? null : dxrPlayCanvas(core);

  // The page may have asked for inline-3D / WebXR before the core was loaded.
  S.onForeign(yieldTo);
  if (S.foreign()) yieldTo(S.foreign());
  info(`core armed (v${VERSION})`, on() ? '' : '(OFF for this site)');
  notify();
  return { ctl, three, playcanvas };
}

// DisplayXR auto-3D 0.5.0 — built by tools/auto3d-shim/build.mjs from displayxr-web. Do not edit: fix the source, rebuild, re-vendor.
(function (cfg, cap, S) {
'use strict';
function dxrCore(cfg, cap, S) {
  const TAG = '[dxr-auto3d]';
  const VERSION = '0.5.0'; // stamped by build.mjs from manifest.json

  const DEFAULT_DEPTH = { camera: 0.3, display: 1.0 };
  const DEPTH_MIN = 0.02, DEPTH_MAX = 1;
  const CONV_SCALE_MIN = 0.05, CONV_SCALE_MAX = 20;

  const TUNING = {
    eyeScale: 0.5,      // per-eye width / element device width: a 2-view lenticular resolves about half anyway (porting pitfall 26)
    maxSbsWidth: 3072,  // browser-pvt#24: wider SBS canvases drop off the zero-copy weave path
    minCssPx: 120,      // smaller canvases stay flat (icons, thumbnails)
    holdMs: 1200,       // keep the cover this long after the layer exists (woven-canvas rules, rule 5)
    releaseMaxMs: 500,  // turn-off: release the layer this long after the stand at the latest, mono frame or not
    rampMs: 500,        // depth fades in after the cover drops, and back to flat before a turn-off swaps to 2D
    convTarget: true,   // prefer the page's explicit target (controls / lookAt) over the estimator
    noViewsMs: 4000,    // no 2-view frame this long after the layer -> back to 2D, retry later
    fakeViews: false,   // TEST ONLY: synthesise a parallel-axis pair when the session reports none
    guardFps: 40,       // frame-rate guard (guard.js): back to 2D when 3D runs below this over guardMs ...
    guardMs: 2000,      // ... (and below 0.8 x the page's 2D rate, when it has one)
    glLimit: 0,         // TEST ONLY: > 0 stands in for the GL size limits in realSizeFor
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
    rig: cfg.rig === 'display' ? 'display' : 'camera',
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
  const CANVAS_W = S.intrinsics.canvasWidth;
  const CANVAS_H = S.intrinsics.canvasHeight;
  const realW = (c) => CANVAS_W.get.call(c);
  const realH = (c) => CANVAS_H.get.call(c);

  const tracked = [];           // WeakRef<state>, for state() and the HUD
  let owner = null;             // the one canvas converted (or converting) — one inline-3D session per document
  let lastTarget = null;        // the last canvas we converted: the chip keeps pointing at it after release
  let candidate = null;         // while OFF (offer / block in dev): a canvas that would convert — the chip's target
  let foreign = null;           // why we stood down for good in this document (the page owns inline-3D / XR)
  const engines = [];           // adapter names, for the HUD / console

  const xrRequest = S.xrRequest;
  function yieldTo(reason) {
    if (!foreign) { foreign = reason; info('standing down for this document:', reason); }
    if (owner) stand(owner, reason);
    notify();
  }

  function newState(engine, canvas, ad) {
    const st = {
      engine, canvas, ad,
      active: false, pending: false, armed: null, tries: 0, nextTry: 0, lastWhy: null, flatReason: null,
      session: null, ref: null, layer: null, layerAt: 0, rig: { position: { x: 0, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } },
      V: [0, 1].map(() => ({ proj: new Float32Array(16), pose: new Float32Array(16) })),
      haveViews: false, near: NaN, far: NaN, R: null,
      conv: { d: 0, src: 'estimator', via: null }, cover: null, savedStyle: null, displayOk: null,
      releasing: null, wakeOnRelease: false, eyeBack: 0, rigs: null,
      stats: { calls: 0, stereo: 0, flat: 0, flatAfterEyes: 0, replays: 0, resizes: 0, xrFrames: 0, twoView: 0, shortView: 0 },
    };
    tracked.push(new WeakRef(st));
    return st;
  }

  function realSizeFor(st) {
    const L = st.L;
    let eyeW = Math.max(2, Math.round(L.w * L.pr * T.eyeScale));
    let eyeH = Math.max(2, Math.round(L.h * L.pr));
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

  function considerActivation(st) {
    const t = now();
    guard.draw(st, t); // the page's 2D rate (the frame-rate guard's baseline)
    if (!on()) { if (!foreign && !owner) considerCandidate(st); return; }
    if (foreign || owner || guard.tripped) return;
    if (t < st.nextTry) return;
    st.nextTry = t + 500;
    if (S.optedOut()) { notify(); return; } // <meta name="displayxr-auto3d" content="off">
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
    const ok = !st.ad.unqualified(st);
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
      setTimeout(() => { if (st.armed) st.ad.flipIdle(st); }, 250);
    } catch (e) {
      warnOnce('session', 'inline-3d session refused — staying 2D:', e && e.message);
      if (session) { try { session.end(); } catch (e2) { /* ignore */ } }
      st.pending = false; if (owner === st) owner = null;
      st.nextTry = now() + 10000;
      notify();
    }
  }
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
      st.layer = T.noLayer ? null : new XRDisplayLayer(st.session, st.canvas, HAS_RIG ? { viewRig: { ...rig } } : { virtualDisplayHeight: 0.24 });
    } catch (e) {
      warnOnce('layer', 'new XRDisplayLayer() failed — staying 2D', e);
      stand(st, 'XRDisplayLayer refused the canvas');
      st.nextTry = Infinity;
      return;
    }
    st.layerAt = now();
    guard.onFlip(st);
    st.drawnAt = 0; // the no-views timer starts at the first draw / replay on the SBS store (drew())
    st.displayOk = null;
    st.rampK = T.rampMs > 0 ? 0 : 1; st.ramp = null; // flat under the cover; fades in once it drops
    if (!st.cover && st.rampK < 1) startRamp(st, 1);
    if (st.layer && !T.fakeViews) probeDisplay(st, st.layer); // fakeViews (tests) run where there is no display on purpose
    if (T.noLayer) {
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
    info(`live on ${desc(st.canvas)}: SBS ${st.R.W}x${st.R.H} (eye ${st.R.eyeW}x${st.R.eyeH}), rig ${HAS_RIG ? rigMode() : 'display (no setViewRig)'},`,
      `convergence ${st.conv.d.toPrecision(3)} units (${convSource(st)}${st.conv.via ? ': ' + st.conv.via : ''}), depth ${depthOf()}`);
    notify();
  }
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
  function drew(st) { if (st.active && !st.drawnAt) st.drawnAt = now(); }
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
    if (owner === st) owner = null;
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
      if (di || (Array.isArray(modes) && modes.length)) { st.displayOk = true; return; }
    }
    if (st.layer !== layer) return;
    st.displayOk = false;
    stand(st, 'no display behind the layer (getDisplayInfo() null, no rendering modes) — is another DisplayXR Browser holding it? (browser#162)');
    st.nextTry = now() + 30000;
  }
  function promote(st) {
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

  function onSessionFrame(st, frame) {
    const ad = st.ad;
    st.stats.xrFrames++;
    if (st.stats.xrFrames % 30 === 0 && !st.offTok && S.optedOut()) turnOff(st, 'the page opted out (<meta name="displayxr-auto3d" content="off">)');
    if (!st.canvas.isConnected) { stand(st, 'the canvas left the document'); return; }
    let views = null;
    try { const pose = st.ref ? frame.getViewerPose(st.ref) : null; views = pose ? pose.views : null; } catch (e) { /* no pose */ }
    const t = now();
    if (views && views.length >= 2) {
      for (let i = 0; i < 2; i++) { st.V[i].proj.set(views[i].projectionMatrix); st.V[i].pose.set(views[i].transform.matrix); }
      st.haveViews = true; st.stats.twoView++;
      st.eyeBack = Math.max(0, Math.min(st.V[0].pose[14], st.V[1].pose[14]));
    } else {
      st.stats.shortView++;
      if (T.fakeViews && ad.hasCamera(st)) { fakeViews(st); st.haveViews = true; }
    }
    if (!st.haveViews && st.displayOk !== true && st.drawnAt && t - st.drawnAt > T.noViewsMs) {
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
      if (!estimateConvergence(st, false, true) && st.stats.xrFrames % 30 === 0) estimateConvergence(st, false);
      tickRamp(st, t);
      if (HAS_RIG && st.layer) { try { st.layer.setViewRig(buildRig(st, ad.rigFov(st))); } catch (e) { warnOnce('rig', 'setViewRig failed', e); } }
    }
    ad.redraw(st);
    if (st.outCoverDue && !ad.coverAfterDraw) takeOutCover(st);
    tickCover(st, t);
    guard.tick(st, t);
    chip.frame(st);
    if (st.stats.xrFrames % 20 === 0) notify();
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
      if (typeof el.decode === 'function') el.decode().then(place, place); else place();
    }
  }

  const rigMode = () => (site.rig === 'display' ? 'display' : 'camera');
  const depthOf = (mode) => clamp(site.depths[mode || rigMode()] || DEFAULT_DEPTH[mode || rigMode()], DEPTH_MIN, DEPTH_MAX);
  function setDepth(v) { site.depths = { ...site.depths, [rigMode()]: clamp(v, DEPTH_MIN, DEPTH_MAX) }; }
  const convSource = (st) => (site.convScale !== 1 ? 'manual' : st.conv.src);
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
    if (!st.rigs) {
      st.rigs = {
        camera: st.rig,
        display: { type: 'display', position: { x: 0, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } },
      };
    }
    const d = Math.max(1e-6, (st.conv.d || 1) * site.convScale);
    if (rigMode() === 'display') {
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
    rig.position.x = rig.position.y = rig.position.z = 0;
    rig.orientation.x = rig.orientation.y = rig.orientation.z = 0; rig.orientation.w = 1;
    rig.verticalFov = verticalFov;
    rig.convergenceDiopters = 1 / d;
    rig.metersToVirtual = (depthOf('camera') * d) / 0.5;
    const k = rampK(st);
    rig.ipdFactor = k;
    rig.parallaxFactor = k;
    st.rig = rig;
    return rig;
  }
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
    st.conv.d = snap || !st.conv.d ? d : st.conv.d + (d - st.conv.d) * 0.25;
    st.conv.src = src;
    return true;
  }
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
        let got = false;
        try { got = !!(st.ad.readEye && st.ad.readEye(st, c)); } catch (e) { got = false; }
        if (!got) {
          warnOnce('outcover', 'could not read the flat frame back from WebGL — the 3D->2D cover may be blank');
          c.getContext('2d').drawImage(cv, 0, 0, st.R.eyeW, st.R.eyeH, 0, 0, c.width, c.height);
        }
      }
      else c.getContext('2d').drawImage(cv, 0, 0, c.width, c.height); // the mono frame drawn in this same task
      if (T.coverImg !== false) {
        const img = document.createElement('img');
        img.setAttribute('data-dxr-auto3d-cover', ''); img.alt = '';
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
  function tickCover(st, t) {
    const cv = st.cover;
    if (!cv) return;
    if (!cv.out && t - st.layerAt >= T.holdMs && st.stats.stereo > 0) {
      dropCover(st); // a hard cut, never a fade: the picture under it is flat (rampK 0) and fades in from here
      info(`cover released ${Math.round(t - st.layerAt)} ms after the layer (hold ${T.holdMs} ms)`);
      if (st.rampK < 1) startRamp(st, 1);
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
  function statusOf() {
    const st = owner;
    if (foreign) return { status: 'standdown', reason: foreign };
    if (S.optedOut()) return { status: 'optout' };
    if (guard.tripped) return { status: 'guard', reason: guard.tripped };
    if (st && st.active) return { status: 'live', engine: st.engine };
    if (st && (st.pending || st.armed)) return { status: 'converting', engine: st.engine };
    if (!on()) return { status: site.decision === 'offer' && once === null ? 'offer' : 'off' };
    const flat = flatNote();
    if (flat) return { status: 'flat', engine: flat.engine, reason: flat.flatReason };
    return { status: 'idle' };
  }
  function status() {
    const s = statusOf(), t = lastTarget || candidate;
    return {
      state: s.status, engine: s.engine || (t ? t.engine : null), canvas: t ? t.canvas : null,
      rig: rigMode(), depth: depthOf(), depths: { camera: depthOf('camera'), display: depthOf('display') },
      convScale: site.convScale, rigSupported: HAS_RIG, haveViews: !!(owner && owner.haveViews),
      enabled: on(), cover: t && t.cover ? t.cover.el : null, coverUp: !!(t && t.cover && !t.cover.out),
      layerAt: t && t.layer ? t.layerAt : 0, holdMs: T.holdMs, ramping: !!(owner && owner.ramp),
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
      try { cap.report(s); } catch (e) { warnOnce('report', 'could not report the status', e); }
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

  window.addEventListener('pagehide', () => { if (owner) stand(owner, 'pagehide'); });

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
    newState, considerActivation, canvasPlacement, cssEffect, flip, stand, monoDrawn, drew, yieldTo, notify, turnOff, save,
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

  S.onForeign(yieldTo);
  if (S.foreign()) yieldTo(S.foreign());
  info(`core armed (v${VERSION})`, on() ? '' : '(OFF for this site)');
  notify();
  return { ctl, three, playcanvas };
}
function dxrGuard(core) {
  const T = core.T;
  const RING = 60, MAX_DT = 250, MIN_BASE = 20, ARM_MS = 1000;
  const g = new WeakMap(); // st -> { ring[], base, readyAt, last, dts[], sum }
  const of = (st) => { let s = g.get(st); if (!s) g.set(st, (s = { ring: [], base: 0, readyAt: 0, last: 0, dts: [], sum: 0 })); return s; };
  const resetWindow = (s) => { s.readyAt = 0; s.last = 0; s.dts.length = 0; s.sum = 0; };
  const api = { tripped: null };

  document.addEventListener('visibilitychange', () => {
    for (const w of core.tracked) { const st = w.deref(); const s = st && g.get(st); if (s) { resetWindow(s); s.ring.length = 0; } }
  });

  api.draw = (st, t) => {
    if (st.active) return;
    const r = of(st).ring;
    r.push(t);
    if (r.length > RING) r.shift();
  };

  api.onFlip = (st) => {
    const s = of(st);
    let n = 0, sum = 0;
    for (let i = 1; i < s.ring.length; i++) { const dt = s.ring[i] - s.ring[i - 1]; if (dt > 0 && dt <= MAX_DT) { n++; sum += dt; } }
    s.base = n >= MIN_BASE ? (1000 * n) / sum : 0;
    s.ring.length = 0;
    resetWindow(s);
  };

  api.tick = (st, t) => {
    if (api.tripped) return;
    const s = of(st);
    const settled = st.active && !st.cover && !st.ramp && !st.releasing && !st.offTok && core.rampK(st) === 1;
    if (!settled || document.hidden) { resetWindow(s); return; }
    if (!s.readyAt) s.readyAt = t;
    const prev = s.last;
    s.last = t;
    if (t - s.readyAt < ARM_MS || !prev) return;
    const dt = t - prev;
    if (!(dt > 0) || dt > MAX_DT) return; // a hitch (GC, tab switch, debugger) is not a rate
    s.dts.push(dt); s.sum += dt;
    if (s.sum < T.guardMs) return;
    const fps = (1000 * s.dts.length) / s.sum;
    if (fps < T.guardFps && (!s.base || fps < 0.8 * s.base)) { trip(st, fps, s.base); return; }
    while (s.dts.length && s.sum - s.dts[0] >= T.guardMs) s.sum -= s.dts.shift();
  };

  function trip(st, fps, base) {
    api.tripped = `frame-rate guard: ${fps.toFixed(1)} fps in 3D over ${(T.guardMs / 1000).toFixed(1)} s` +
      (base ? ` (2D ran at ${base.toFixed(1)})` : ' (no 2D baseline)') + ' — 2D for the rest of this page';
    for (const w of core.tracked) { const o = w.deref(); if (o) o.nextTry = Infinity; }
    core.turnOff(st, api.tripped); // logs the one "back to 2D: …" line
    core.notify();
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
  <div class="row" role="group" aria-label="Depth"><span>Depth</span><input type="range" tabindex="-1" min="0.02" max="1" step="0.01" aria-label="Depth" data-k="depth"><output>0.30</output></div>
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

  function build() {
    if (host) return true;
    const de = doc.documentElement;
    if (!de || typeof I.attachShadow !== 'function') return false;
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
    for (const [t2, o] of [['scroll', true], ['resize', false]]) window.addEventListener(t2, schedule, { capture: o, passive: true });
    doc.addEventListener('fullscreenchange', onFullscreen);
    doc.addEventListener('pointerdown', (e) => { if (menuOpen && !e.composedPath().includes(host)) closeMenu(false); }, true);
    return true;
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
    if (st.state === 'live') {
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
    idle(next === 'offer' || next === 'off'); // no session loop: poll the placement
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
    setA(dot, 'class', 'dot ' + (!on ? 'o' : s.haveViews && !s.ramping ? 'g' : 'a'));
    setA(pill, 'aria-pressed', String(on));
    setA(pill, 'aria-label', on ? '3D view: on. Turn off for this site' : view === 'offer' ? '3D view available. Turn on for this site' : '3D view: off. Turn on for this site');
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
  function onFullscreen() {
    if (fsOurs()) { window.addEventListener('pointermove', onPointerActivity, { capture: true, passive: true }); onPointerActivity(); }
    else { window.removeEventListener('pointermove', onPointerActivity, true); clearTimeout(fsIdleTimer); if (fsIdle) { fsIdle = false; render(); } }
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
  const { VERSION, HAS_RIG, T, site, meta, tracked, engines, now, desc, realW, realH, rigMode, depthOf, convSource, rampK, flatNote } = core;
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
      text = `DXR auto-3D ● ${HAS_RIG ? rigMode() : 'display'} rig · depth ${depthOf().toFixed(2)} · conv ${(st.conv.d * site.convScale).toPrecision(3)} (${convSource(st)})` +
        ` · 3D ${s.stereo} · flat ${s.flat} · replay ${s.replays}` +
        (st.haveViews ? '' : ' · waiting for eyes');
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
          active: st.active, pending: !!(st.pending || st.armed), haveViews: st.haveViews,
          convergence: st.conv.d, convergenceSource: convSource(st), convergenceVia: st.conv.via,
          rig: st.active ? JSON.parse(JSON.stringify(st.rig)) : null, releasing: !!st.releasing,
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
    const o = e && e.detail;
    if (!o) return;
    if (o.isScene) { hookLookAt(o); return; }
    if (o.isWebGPURenderer) { warnOnce('webgpu', 'WebGPURenderer seen — not converted by this prototype, left 2D'); return; }
    if (o.isWebGLRenderer || (o.domElement && typeof o.render === 'function' && typeof o.getContext === 'function')) track(o);
  };
  const onRegister = (e) => { if (e && e.detail && e.detail.revision) revision = e.detail.revision; };

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

  const ad = {
    label: () => `three r${revision || '?'}`,
    unqualified(st) {
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
        const ops = st.idleOps.map((op) => (op[0] === 'clear' ? op : ['render', op[1], op[2], isMainPerspective(st, op[2])]));
        st.idleOps = null;
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
    readEye: (st, target) => core.readGlEye(ad.gl(st), st, target),
    gl: (st) => (st.r && typeof st.r.getContext === 'function' ? st.r.getContext() : null),
    restore(st, wasLive) {
      const last = st.lastOps;
      st.lastOps = null; st.frame = { drew: false, ops: [] }; st.idleOps = null;
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
    describe: (st) => ({ page: { w: st.L.w, h: st.L.h, pr: st.L.pr, canvasWidthSeenByPage: st.canvas.width } }),
  };

  function track(r) {
    if (states.has(r)) return;
    const canvas = r.domElement;
    if (!(canvas instanceof HTMLCanvasElement)) { warnOnce('offscreen', 'renderer on an OffscreenCanvas — not supported, left 2D'); return; }
    const st = core.newState('three.js', canvas, ad);
    Object.assign(st, {
      r, depth: 0, orig: {},
      L: { w: 0, h: 0, pr: 1, vp: [0, 0, 0, 0], sc: [0, 0, 0, 0], scTest: false }, // what the PAGE believes
      eyes: null, eyesFor: null, m4: null,
      mainCam: null, lastScene: null, lastMono: null, qualifyCam: null,
      frame: { drew: false, ops: [] }, lastOps: null,
      monoOps: null, monoCur: null, monoOpen: false, idleOps: null, // the page's last MONO frame (draws before / between conversions)
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
    info(`three.js r${revision || '?'} renderer found on`, desc(canvas));
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
      if (!top() || st.call('getRenderTarget') !== null) return st.call('clear', color, depth, stencil);
      if (!st.active) { recordMono(st, ['clear', color, depth, stencil]); return st.call('clear', color, depth, stencil); }
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
          recordMono(st, ['render', scene, camera]);
          const persp = camera.isPerspectiveCamera && !camera.isArrayCamera;
          if (persp) {
            st.lastMono = { scene, camera }; st.sawPersp = true;
            hookLookAt(camera); // fallback for a page that built no Scene before its camera (rare)
            if (st.armed) flip(st, scene, camera);
            else { st.qualifyCam = camera; core.considerActivation(st); }
          } else if (!st.sawPersp && !st.lastWhy) {
            st.lastWhy = 'the screen camera is not a PerspectiveCamera';
            info('not converting', desc(st.canvas), 'yet:', st.lastWhy, '(a post-processing chain, or an ortho-only scene)');
          }
        }
        return out;
      }
      if (xrLive) { core.stand(st, 'the renderer is presenting WebXR'); return st.call('render', scene, camera); }
      if (!toScreen) return st.call('render', scene, camera); // shadow / post-processing / picking targets: untouched, mono
      st.frame.drew = true;
      const stereo = isMainPerspective(st, camera);
      st.frame.ops.push(['render', scene, camera, stereo]);
      const out = stereo ? renderStereo(st, scene, camera) : renderFlat(st, scene, camera);
      if (stereo) takeCover(st); // after the scene draw, never after a background/HUD pass alone
      return out;
    });
    W('dispose', (...a) => {
      if (st.active || st.pending || st.armed) core.stand(st, 'the page disposed the renderer');
      return st.call('dispose', ...a);
    });
  }
  function flip(st, scene, camera) {
    st.mainCam = camera; st.lastScene = scene;
    core.flip(st);
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
    if (camera.view && camera.view.enabled) return false; // setViewOffset (tiles, TAA jitter): not ours to split
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

  function renderStereo(st, scene, camera) {
    st.mainCam = camera; st.lastScene = scene;
    if (!st.haveViews) { // no eyes yet: flat into both halves, never a blank tile
      if (st.stats.twoView > 0) st.stats.flatAfterEyes++;
      return renderFlat(st, scene, camera);
    }
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
    core.drew(st);
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
    core.drew(st);
  }
  function replay(st, ops) {
    const prevRT = st.call('getRenderTarget');
    if (prevRT !== null) st.call('setRenderTarget', null);
    let drew = false;
    try {
      for (const op of ops) {
        if (op[0] === 'clear') forEyes(st, () => st.call('clear', op[1], op[2], op[3]));
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

  function forEachBounds(scene, cam, cb) {
    let more = true;
    scene.traverseVisible((o) => {
      if (!more || !(o.isMesh || o.isPoints || o.isLine || o.isSprite)) return;
      if (cam.layers && o.layers && typeof cam.layers.test === 'function' && !cam.layers.test(o.layers)) return;
      let bs = o.boundingSphere || null;
      const g = o.geometry;
      if (!bs && g) {
        if (!g.boundingSphere && typeof g.computeBoundingSphere === 'function') { try { g.computeBoundingSphere(); } catch (e) { /* ignore */ } }
        bs = g.boundingSphere;
      }
      if (!bs || !(bs.radius >= 0) || !isFinite(bs.radius)) return;
      const m = o.matrixWorld.elements, c = bs.center;
      const wx = m[0] * c.x + m[4] * c.y + m[8] * c.z + m[12];
      const wy = m[1] * c.x + m[5] * c.y + m[9] * c.z + m[13];
      const wz = m[2] * c.x + m[6] * c.y + m[10] * c.z + m[14];
      const s = Math.sqrt(Math.max(m[0] * m[0] + m[1] * m[1] + m[2] * m[2], m[4] * m[4] + m[5] * m[5] + m[6] * m[6], m[8] * m[8] + m[9] * m[9] + m[10] * m[10]));
      more = cb(wx, wy, wz, bs.radius * s) !== false;
    });
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
    !!a && typeof a === 'object' && typeof a.tick === 'function' && typeof a.on === 'function' &&
    typeof a.fire === 'function' && 'graphicsDevice' in a && !!a.systems;

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
    st.setRes = (w, h) => { st.depth++; try { orig.call(dev, w, h); } finally { st.depth--; } };
    dev.setResolution = function (w, h) {
      if (!st.active || st.depth > 0) { if (!st.active) { st.L.w = w; st.L.h = h; } return orig.call(dev, w, h); }
      st.L.w = w; st.L.h = h;
      if (applyRealSize(st)) st.app.renderNextFrame = true;
    };
    const gl = dev.gl;
    if (gl && typeof gl.shaderSource === 'function' && !dev.isWebGPU) {
      const ss = gl.shaderSource;
      gl.shaderSource = function (sh, src) {
        if (typeof src === 'string' && src.indexOf('J2') >= 0 && /vec2\s+J2\s*=/.test(src)) {
          st.footprint.seen++;
          const p = patchGsplatFootprint(src);
          if (p.ok) { st.footprint.patched++; src = p.src; }
        }
        return ss.call(this, sh, src);
      };
    }
  }
  function applyRealSize(st) {
    const R = core.realSizeFor(st);
    st.R = R;
    if (realW(st.canvas) === R.W && realH(st.canvas) === R.H) return false;
    st.stats.resizes++;
    st.setRes(R.W, R.H);
    return true;
  }

  function pickCamera(app) {
    const list = (app.systems.camera && app.systems.camera.cameras) || [];
    const cams = list.filter((c) => c && c.enabled && c.entity && c.entity.enabled && !c.renderTarget);
    if (!cams.length) return { why: 'no enabled camera renders to the canvas' };
    if (cams.length > 1) return { why: `${cams.length} cameras render to the canvas (UI / multi-view) — not split in this prototype`, flat: true };
    const c = cams[0];
    if (c.projection === 1) return { why: 'the camera is orthographic', flat: true };
    const pe = c.postEffects;
    if (c.postEffectsEnabled !== false && pe && Array.isArray(pe.effects) && pe.effects.length) return { why: 'post effects on the camera — needs per-eye targets (next)', flat: true };
    const fp = c.framePasses || (c.camera && c.camera.framePasses);
    if (fp && fp.length) return { why: 'CameraFrame / frame passes on the camera — needs per-eye targets (next)', flat: true };
    return { cam: c };
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

  const ad = {
    label: (st) => `PlayCanvas ${pcNS && pcNS.version ? pcNS.version : '2.x'}, ${via.get(st.app)}`,
    unqualified(st) {
      const app = st.app;
      if (st.dev.isWebGPU) return flatWhy(st, 'WebGPU device — the prototype drives WebGL2 apps only');
      if (app.xr && app.xr.active) return 'the app is presenting WebXR';
      const pick = pickCamera(app);
      if (!pick.cam) return pick.flat ? flatWhy(st, pick.why) : pick.why;
      st.flatReason = null;
      st.qualifyCam = pick.cam;
      const where = core.canvasPlacement(st.canvas);
      if (where) return where;
      if (!(st.L.w > 0 && st.L.h > 0)) return 'canvas has no size yet';
      return core.cssEffect(st.canvas);
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
    fakeViewParams(st) { const p = pageCam(st); return { near: p.near, far: p.far, t: p.near * Math.tan(p.vfov / 2), aspect: p.aspect }; },
    beforeActive() {},
    afterActive(st) {
      st.cam = st.qualifyCam;
      applyRealSize(st);
      bindViews(st);
    },
    firstDraw(st) { st.app.renderNextFrame = true; },
    redraw(st) {
      if (!st.frame.drew) st.stats.replays++;
      st.frame.drew = false;
      st.app.renderNextFrame = true;
    },
    restore(st, wasLive) {
      restoreShadows(st);
      if (st.cam && st.cam.camera) { try { st.cam.camera.xrViews = null; } catch (e) { /* ignore */ } }
      st.cam = null; st.views = null; st.frustumKey = '';
      if (wasLive) {
        try { if (realW(st.canvas) !== st.L.w || realH(st.canvas) !== st.L.h) st.setRes(st.L.w, st.L.h); } catch (e) { /* ignore */ }
        st.app.renderNextFrame = true; // the mono frame: drawn on the engine's next tick, reported from postrender
      }
      return false;
    },
    wake(st) { st.app.renderNextFrame = true; }, // re-enabled: one frame, whose postrender considers activation
    coverAfterDraw: true,
    readEye: (st, target) => core.readGlEye(ad.gl(st), st, target),
    gl: (st) => (st.dev && st.dev.gl) || null,
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
    flipIdle(st) { st.app.renderNextFrame = true; }, // flips on the postrender of that frame
    describe: (st) => ({
      page: { w: st.L.w, h: st.L.h, pr: 1 },
      extra: {
        detection: via.get(st.app), renderView: st.rvKind, camera: st.cam ? st.cam.entity.name : null,
        footprint: { ...st.footprint }, device: st.dev.isWebGPU ? 'webgpu' : 'webgl2', autoRender: st.app.autoRender,
      },
    }),
  };
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
      const pick = pickCamera(app);
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
    const pick = pickCamera(app);
    if (pick.cam !== st.cam) {
      const why = pick.cam ? 'the page switched cameras' : pick.why;
      core.stand(st, why, { staged: true }); // this frame now renders mono; the layer goes after it
      if (pick.flat) flatWhy(st, pick.why);
      st.nextTry = core.now() + 1000;
      return;
    }
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
    updateViews(st); // before the first draw: never a frame with an unset view
    st.cam.camera.xrViews = st.views.slice();
  }
  function updateViews(st) {
    const R = st.R, local = st.cam.entity.getLocalTransform().data;
    let P0;
    if (st.haveViews) {
      for (let i = 0; i < 2; i++) {
        mul4(local, st.V[i].pose, st.eyeInv[i]);
        st.views[i].setView(st.V[i].proj, st.eyeInv[i]);
        st.views[i].setViewport(i * R.eyeW, 0, R.eyeW, R.eyeH);
      }
      P0 = st.V[0].proj;
      st.stats.stereo++;
    } else {
      const p = pageCam(st);
      perspective(p.vfov, p.aspect, p.near, p.far, st.flatProj);
      for (let i = 0; i < 2; i++) {
        st.views[i].setView(st.flatProj, local);
        st.views[i].setViewport(i * R.eyeW, 0, R.eyeW, R.eyeH);
      }
      P0 = st.flatProj;
      st.stats.flat++;
      if (st.stats.twoView > 0) st.stats.flatAfterEyes++;
    }
    const f = frustumFromProjection(P0);
    const key = `${f.fov.toFixed(4)}|${f.aspectRatio.toFixed(4)}|${f.nearClip}|${f.farClip}`;
    if (key !== st.frustumKey) { st.frustumKey = key; st.cam.camera.setXrProperties({ ...f, horizontalFov: false }); }
    offsetShadows(st);
  }

  const shadowOrig = new WeakMap(); // light component -> { orig, wrote }
  function offsetShadows(st) {
    if (core.T.pcShadowOffset === false) return;
    const d = st.haveViews ? Math.max(0, (st.V[0].pose[14] + st.V[1].pose[14]) / 2) : 0;
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
      more = cb(wx, wy, wz, r) !== false;
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

  info(`PlayCanvas adapter armed (core v${core.VERSION})`);
  return { consider };
}
return dxrCore(cfg, cap, S);
})

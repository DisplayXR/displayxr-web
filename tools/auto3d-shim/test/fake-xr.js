// TEST ONLY — a fake DisplayXR inline-3d session for the headless harness (no DisplayXR Browser,
// no display). Injected before the shim, in the page's main world, at document start.
//
//   navigator.xr.isSessionSupported('inline-3d') -> true
//   navigator.xr.requestSession('inline-3d')     -> a session whose requestAnimationFrame rides the
//     window's, and whose frames carry TWO views: identity eye poses and the same symmetric
//     perspective with an off-axis skew of ±SKEW in P[8] (column-major [2][0], the slot three.js /
//     WebXR / PlayCanvas use for the frustum's horizontal shift) — the P0 spike's test pattern. A
//     skew of s moves every pixel by s NDC whatever its depth, so the right half must equal the left
//     half shifted right by s × eyeWidth px (64 px for s = 0.1 on a 640 px eye).
//   window.XRDisplayLayer — setViewRig / getDisplayInfo / getRenderingModes / close, recording.
//
// Commit model (window.__fakeXRTrackCommits = true): what the browser would PRESENT. Every frame,
// after all rAF callbacks (a ResizeObserver callback, which runs after them and before paint), a
// small copy of the bound canvas is taken: that is the frame this document commits. The browser
// weaves a bound canvas; layer.close() stops the weave AT ONCE (it reaches the browser on its own
// channel, not with the next commit), so from that moment the last committed frame is on screen
// unwoven until the next commit lands. The harness then asserts that neither the frame committed
// before close() nor the next few is a side-by-side pair (unless the cover hides the canvas). The
// same holds the other way at go-live: new XRDisplayLayer() also reaches the browser ahead of the
// task's commit, so the frame committed before it must already be the side-by-side store under the
// cover (layers[i].committedAtCreate vs storeAtCreate). While no layer is open, every canvas on the
// page is watched, each on its own, so on a page with several the check reads the one that goes live.
// Everything the harness asserts on is on window.__fakeXR.
//
// window.__fakeXROpts (per case):
//   viewsAfterMs: N   frames carry NO views until N ms after the layer was created (Infinity: never)
//                     — nobody tracked yet / a runtime with nothing to locate eyes for yet.
//   noDisplayApi: true  the layer has no getDisplayInfo / getRenderingModes (an older build), so the
//                     shim cannot tell "no display" from "no eyes yet" and relies on its eye timeout.
//   noDisplay: true   the layer's display API answers "no display" (getDisplayInfo() null, no
//                     rendering modes): an instance with no weave slot (browser#162).
//   flipViewsMs: N    from the layer on, frames alternate N ms WITH two views / N ms with none (eye
//                     tracking flipping isTracking 0/1: the chip's dot must not blink).
//   viewsStopAfterMs: N  no views from N ms after the layer on (the viewer left).
//   frameCostMs: N    every session rAF callback first burns N ms of CPU, but only while a layer
//                     exists and is open — the cost of converting (the frame-rate guard's case).
//   eyeZ: Z           both eye poses carry a +Z translation (camera looks down −Z: the eyes sit Z
//                     BEHIND the page camera, as a display rig puts them at the viewer's distance).
//   eyeX: X           the left eye pose sits −X, the right +X along the camera's x axis (a real
//                     inter-eye baseline: two distinct viewpoints, for view-dependent engines such as
//                     a splat sorter). Adds depth-dependent parallax on top of the skew.
//   skew: S           the off-axis skew instead of ±0.1 (0: none). eyeX / eyeZ / skew are read every
//                     frame, so a harness may change them on window.__fakeXROpts mid-run (the
//                     PlayCanvas examples run's viewpoint probe: skew 0 + eyeX, halves must differ).
//   headM: [x, y, z]  the viewer's head offset in metres (y up, +z toward the viewer) on every eye pose;
//                     with it, eyeX / eyeZ / headM are multiplied by the camera rig's metersToVirtual, as
//                     the runtime does: the eyes sit head × m2v from the page camera (#319 'teleport').
//   nominal: [x, y, z]  the RUNTIME MODEL (v0.7.12): getDisplayInfo() reports this nominal viewer and the 8K
//                     panel's size, and the eyes are placed as the runtime's camera rig places them
//                     (dxr_camera3d_compute_view): head (headM, else the nominal; display space) relative to
//                     the CANVAS centre (the same screen-rect estimate the shim makes), its centre pulled
//                     toward the canvas axis by parallaxFactor, eyes ± eyeX × ipdFactor, minus the nominal z,
//                     × metersToVirtual; each projection sheared by eye × convergenceDiopters
//                     (dxr_offaxis_projection). skew is ignored.
//   reportNominal: false  with nominal: the runtime model at that nominal, but getDisplayInfo() does NOT report it
//                     (the real panel: DisplayXR Browser 1.10.6 reports the panel size only).
//   (default)         getDisplayInfo() = the real panel's shape (size + view scale, no nominal), and the legacy
//                     views carry the runtime's rest offset at its nominal (0, 0.1, 0.6) m (the shim's anchor
//                     takes it off again). noRest: no rest offset; noPanel: the pre-0.7.12 answer (no size).
//   pixelAspect: K    the eye's projection aspect is K × (eye width / eye height): a store pixel is K
//                     times as wide as it is tall, as on the panel (K = 2: the eye is stored at half
//                     width and the weave un-squeezes it). A round object is then K times as tall as
//                     wide in store pixels (the gsplat footprint cases measure exactly that).
(() => {
  const SKEW = 0.1;
  const OPTS = window.__fakeXROpts || {};
  const CANVAS_W = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width');
  const CANVAS_H = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'height');
  const H = (window.__fakeXR = { skew: SKEW, sessions: [], sessionObjs: [], layers: [], rigPushes: 0, lastRig: null, frames: 0, renderStates: [], closes: [], committed: null, history: [], watch: null, committedBy: new Map() });
  let openLayer = null; // the FakeLayer not yet closed (kept off H: the harness reads H.layers by value)
  // The canvas the harness reads pixels from: the last one bound to a layer, else the page's first.
  window.__fakeXRCanvas = () => H.watch || document.querySelector('canvas:not([data-dxr-auto3d-cover])');
  const coverUp = () => { const c = document.querySelector('[data-dxr-auto3d-cover]'); return !!(c && c.offsetWidth > 0 && c.offsetHeight > 0); };

  // ------------------------------------------------------------ commit model (see header)
  const SW = 128, SH = 72;
  function snap(c) {
    const w = CANVAS_W.get.call(c), h = CANVAS_H.get.call(c);
    const t = document.createElement('canvas'); t.width = SW; t.height = SH;
    const g = t.getContext('2d', { willReadFrequently: true });
    g.drawImage(c, 0, 0, SW, SH);
    const d = g.getImageData(0, 0, SW, SH).data;
    let b = ''; for (let i = 0; i < d.length; i += 8192) b += String.fromCharCode.apply(null, d.subarray(i, i + 8192));
    return { at: performance.now(), w, h, covered: coverUp(), px: btoa(b) };
  }
  if (window.__fakeXRTrackCommits) {
    const probe = document.createElement('div');
    Object.assign(probe.style, { position: 'fixed', left: '-10px', top: '0', width: '1px', height: '1px', pointerEvents: 'none' });
    const ro = new ResizeObserver(() => {
      // The bound canvas once there is a layer (H.committed, history, the close() frames). While no
      // layer is open, also every canvas the page has, each on its own (H.committedBy): the layer
      // about to be made reads the frame committed before it on ITS canvas, whichever of a page's
      // canvases goes live (go-live: what the browser holds when the layer arrives).
      const main = H.watch || document.querySelector('canvas:not([data-dxr-auto3d-cover])');
      const cs = new Set(main ? [main] : []);
      if (!openLayer) for (const c of document.querySelectorAll('canvas:not([data-dxr-auto3d-cover])')) cs.add(c);
      for (const c of cs) {
        let s = null;
        try { s = snap(c); } catch (e) { continue; } // a 0x0 canvas, a lost context
        H.committedBy.set(c, s);
        if (c !== main) continue;
        H.committed = s;
        H.history.push(s); if (H.history.length > 12) H.history.shift();
        for (const cl of H.closes) if (cl.after.length < 8) cl.after.push(s);
      }
    });
    const tick = () => { probe.style.width = probe.style.width === '1px' ? '2px' : '1px'; requestAnimationFrame(tick); };
    const start = () => { document.documentElement.appendChild(probe); ro.observe(probe); requestAnimationFrame(tick); };
    if (document.documentElement) start(); else document.addEventListener('DOMContentLoaded', start, { once: true });
  }

  function proj(vfov, aspect, n, f, skew) {
    const t = 1 / Math.tan(vfov / 2), o = new Float32Array(16);
    o[0] = t / aspect; o[5] = t; o[8] = skew; o[10] = -(f + n) / (f - n); o[11] = -1; o[14] = (-2 * f * n) / (f - n);
    return o;
  }
  const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  // headM (see the header): eyeX / eyeZ / headM scaled by the pushed camera rig's metersToVirtual.
  const eyeMatrix = (i) => {
    const m = IDENTITY.slice(), h = Array.isArray(OPTS.headM) ? OPTS.headM : null;
    const k = h && H.lastRig && H.lastRig.metersToVirtual > 0 ? H.lastRig.metersToVirtual : 1;
    m[12] = ((i ? 1 : -1) * (+OPTS.eyeX || 0) + (h ? +h[0] || 0 : 0)) * k;
    m[13] = (h ? +h[1] || 0 : 0) * k;
    m[14] = ((+OPTS.eyeZ || 0) + (h ? +h[2] || 0 : 0)) * k;
    return m;
  };

  // The runtime model (OPTS.nominal, see the header).
  const PANEL = { displayWidthMeters: 0.6981, displayHeightMeters: 0.3927, displayPixelWidth: 7680, displayPixelHeight: 4320 };
  function canvasCentreM(c) {
    const r = c.getBoundingClientRect(), dpr = window.devicePixelRatio || 1, sc = window.screen || {};
    const W = PANEL.displayPixelWidth, Hh = PANEL.displayPixelHeight, k = sc.width > 0 ? W / sc.width : dpr;
    const chromeX = Math.max(0, (window.outerWidth - window.innerWidth) / 2), chromeY = Math.max(0, window.outerHeight - window.innerHeight);
    const x = (window.screenX - (sc.availLeft || 0) + chromeX) * k + (r.left + r.width / 2) * dpr;
    const y = (window.screenY - (sc.availTop || 0) + chromeY) * k + (r.top + r.height / 2) * dpr;
    return [(x - W / 2) * (PANEL.displayWidthMeters / W), -(y - Hh / 2) * (PANEL.displayHeightMeters / Hh)];
  }
  function runtimeViews(L, vfov, aspect, n, f) {
    const nom = OPTS.nominal, rig = (L && L.rig) || {}, C = L ? canvasCentreM(L.canvas) : [0, 0];
    const h = Array.isArray(OPTS.headM) ? OPTS.headM : nom, ex = +OPTS.eyeX || 0;
    const m2v = rig.metersToVirtual > 0 ? rig.metersToVirtual : 1, pf = rig.parallaxFactor !== undefined ? +rig.parallaxFactor : 1;
    const ipdF = rig.ipdFactor !== undefined ? +rig.ipdFactor : 1, invd = +rig.convergenceDiopters || 0;
    const raw = [h[0] - C[0], h[1] - C[1], h[2]];
    const ctr = [pf * raw[0], pf * raw[1], nom[2] + pf * (raw[2] - nom[2])];
    const ro = Math.tan(vfov / 2) * aspect, uo = Math.tan(vfov / 2);
    H.runtime = { C, m2v, pf, ipdF, invd };
    return [-1, 1].map((sgn, i) => {
      const e = [m2v * (ctr[0] + sgn * ex * ipdF), m2v * ctr[1], m2v * (ctr[2] - nom[2])];
      const s = [e[0] * invd, e[1] * invd, e[2] * invd], dn = 1 + s[2];
      const tr = (ro - s[0]) / dn, tl = (ro + s[0]) / dn, tu = (uo - s[1]) / dn, td = (uo + s[1]) / dn;
      const P = new Float32Array(16);
      P[0] = 2 / (tr + tl); P[5] = 2 / (tu + td); P[8] = (tr - tl) / (tr + tl); P[9] = (tu - td) / (tu + td);
      P[10] = -(f + n) / (f - n); P[11] = -1; P[14] = (-2 * f * n) / (f - n);
      const M = IDENTITY.slice(); M[12] = e[0]; M[13] = e[1]; M[14] = e[2];
      return { eye: i ? 'right' : 'left', projectionMatrix: P, transform: { matrix: M } };
    });
  }

  class FakeLayer {
    constructor(session, canvas, opts) {
      this.session = session; this.canvas = canvas; this.closed = false;
      this.rig = opts && opts.viewRig ? JSON.parse(JSON.stringify(opts.viewRig)) : null;
      session._layer = this;
      H.watch = canvas;
      // Go-live (commit model): new XRDisplayLayer() reaches the browser on its own channel, ahead of
      // this task's commit, and a canvas the page has had for a while is joined at once. So the frame
      // the browser may weave first is the one committed BEFORE this call: it must already be the
      // side-by-side store, under the cover. A mono frame there, woven, gives each eye half of the
      // picture at twice the width (#339).
      const cm = H.committedBy.get(canvas) || null;
      openLayer = this;
      H.layers.push({ canvas: canvas.id || canvas.tagName, opts: JSON.parse(JSON.stringify(opts || {})), at: performance.now(), coverAtCreate: coverUp(), closedAt: null,
        storeAtCreate: { w: CANVAS_W.get.call(canvas), h: CANVAS_H.get.call(canvas) }, committedAtCreate: cm ? { w: cm.w, h: cm.h, covered: cm.covered, ago: performance.now() - cm.at } : null });
      this._rec = H.layers[H.layers.length - 1];
      if (this.rig) H.lastRig = this.rig;
      if (OPTS.noDisplayApi) { this.getDisplayInfo = undefined; this.getRenderingModes = undefined; }
      // OPTS.wovenByCover: the browser's verdict (wovenState), modelled on what the compositor does: a
      // canvas under a page element marked [data-test-opaque-cover] has no quad to join ('withheld').
      // Absent otherwise, as on a browser without the attribute.
      if (OPTS.wovenByCover) Object.defineProperty(this, 'wovenState', { get: () => (document.querySelector('[data-test-opaque-cover]') ? 'withheld' : 'woven') });
      if (OPTS.noDisplay) { this.getDisplayInfo = () => Promise.resolve(null); this.getRenderingModes = () => Promise.resolve([]); }
    }
    setViewRig(rig) { this.rig = JSON.parse(JSON.stringify(rig)); H.lastRig = this.rig; H.rigPushes++; }
    // The runtime-drawn cursor (ADR-046 Amendment 4): OPTS.noCursor withholds it, as an older browser does.
    getCursorDepthSupport() { return Promise.resolve(OPTS.noCursor ? 'none' : 'runtime'); }
    setCursorDepth(d) { H.cursor = d ? { ...d } : null; H.cursorCalls = (H.cursorCalls || 0) + 1; }
    // The REAL panel's shape by default (DisplayXR Browser 1.10.6 on the 8K Dell): the panel size and the
    // view scale, NO nominalViewerPosition. OPTS.nominal: reported too. OPTS.noPanel: the pre-0.7.12 fake's
    // answer (no size, so no eye anchor).
    getDisplayInfo() {
      if (Array.isArray(OPTS.nominal) && OPTS.reportNominal !== false) { const [x, y, z] = OPTS.nominal; return Promise.resolve({ fake: true, ...PANEL, recommendedViewScaleX: 0.5, recommendedViewScaleY: 0.5, nominalViewerPosition: { x, y, z, w: 1 } }); }
      if (OPTS.noPanel) return Promise.resolve({ fake: true, displayPixelWidth: 3840, displayPixelHeight: 2160 });
      return Promise.resolve({ fake: true, ...PANEL, recommendedViewScaleX: 0.5, recommendedViewScaleY: 0.5 });
    }
    getRenderingModes() { return Promise.resolve([{ name: 'fake-stereo', viewCount: 2 }]); }
    close() {
      if (this.closed) return;
      this.closed = true;
      if (openLayer === this) openLayer = null;
      this._rec.closedAt = performance.now();
      // The frame last committed is what the browser now shows unwoven (commit model).
      // `before`: the frames committed while the layer was open (the pair baseline for the harness).
      H.closes.push({ at: performance.now(), committed: H.committed, before: H.history.slice(), after: [] });
    }
  }
  window.XRDisplayLayer = FakeLayer;

  class FakeSession extends EventTarget {
    constructor(mode) {
      super();
      this.mode = mode; this.ended = false; this._layer = null;
      this.renderState = { depthNear: 0.1, depthFar: 1000 };
    }
    requestReferenceSpace(type) { return Promise.resolve({ type }); }
    updateRenderState(s) { Object.assign(this.renderState, s); H.renderStates.push({ ...s }); }
    requestAnimationFrame(cb) {
      return window.requestAnimationFrame((t) => {
        if (this.ended) return;
        if (OPTS.frameCostMs && this._layer && !this._layer.closed) { const t0 = performance.now(); while (performance.now() - t0 < OPTS.frameCostMs) { /* burn */ } }
        cb(t, this._frame());
      });
    }
    cancelAnimationFrame(id) { window.cancelAnimationFrame(id); }
    end() {
      if (!this.ended) { this.ended = true; this.dispatchEvent(new Event('end')); }
      return Promise.resolve();
    }
    _frame() {
      H.frames++;
      const L = this._layer, c = L && L.canvas;
      const w = c ? CANVAS_W.get.call(c) : 2, h = c ? CANVAS_H.get.call(c) : 1;
      const aspect = (w / 2 / (h || 1)) * (+OPTS.pixelAspect || 1);
      const vfov = L && L.rig && L.rig.verticalFov ? L.rig.verticalFov : (50 * Math.PI) / 180;
      const { depthNear: n, depthFar: f } = this.renderState;
      if (OPTS.viewsAfterMs && (!L || performance.now() - L._rec.at < OPTS.viewsAfterMs)) { H.noViewFrames = (H.noViewFrames || 0) + 1; return { session: this, getViewerPose: () => ({ views: [] }) }; }
      if (L && (OPTS.flipViewsMs || OPTS.viewsStopAfterMs)) {
        const dt = performance.now() - L._rec.at;
        if ((OPTS.viewsStopAfterMs && dt >= OPTS.viewsStopAfterMs) || (OPTS.flipViewsMs && Math.floor(dt / OPTS.flipViewsMs) % 2 === 1)) {
          H.noViewFrames = (H.noViewFrames || 0) + 1; return { session: this, getViewerPose: () => ({ views: [] }) };
        }
      }
      if (Array.isArray(OPTS.nominal)) { const views = runtimeViews(L, vfov, aspect, n, f); return { session: this, getViewerPose: () => ({ views }) }; }
      const sk = OPTS.skew !== undefined ? +OPTS.skew : SKEW; // read live: a harness may change it mid-run
      const views = [+sk, -sk].map((s, i) => ({
        eye: i ? 'right' : 'left',
        projectionMatrix: proj(vfov, aspect, n, f, s),
        transform: { matrix: eyeMatrix(i) },
      }));
      // The runtime's REST offset (v0.7.12): its camera rig puts a viewer at the nominal (0, 0.1, 0.6) m —
      // the Leia SR plug-in's, which the browser does not report — at m2v x pf x (nominal - canvas centre)
      // off the camera, frustum sheared to match. Added to the legacy pattern so the shim's eye anchor has
      // something real to take off (the cases' views are then what they were). OPTS.noRest: not added (the
      // pre-split script, which has no anchor; a fake with no panel size).
      if (L && L.rig && L.rig.type === 'camera' && !OPTS.noRest && !OPTS.noPanel && !OPTS.noDisplayApi && !OPTS.noDisplay) {
        const C = canvasCentreM(L.canvas), rig = L.rig, m2v = rig.metersToVirtual > 0 ? rig.metersToVirtual : 1;
        const pf = rig.parallaxFactor !== undefined ? +rig.parallaxFactor : 1, invd = +rig.convergenceDiopters || 0;
        const r = [m2v * pf * (0 - C[0]), m2v * pf * (0.1 - C[1])];
        for (const v of views) {
          v._baseProj = Array.from(v.projectionMatrix); // TEST ONLY: the frustum before the rest offset (what the shim's anchor restores)
          const M = v.transform.matrix, P = v.projectionMatrix, a = 1 + M[14] * invd;
          if (invd > 0 && a > 0.05) { P[8] -= (r[0] * invd * P[0]) / a; P[9] -= (r[1] * invd * P[5]) / a; }
          M[12] += r[0]; M[13] += r[1];
        }
        H.rest = r;
      }
      return { session: this, getViewerPose: () => ({ views }) };
    }
  }
  const xr = new EventTarget(); // XRSystem is an EventTarget (PlayCanvas's XrManager listens for devicechange)
  Object.assign(xr, {
    isSessionSupported: (mode) => Promise.resolve(mode === 'inline-3d'),
    requestSession(mode) {
      if (mode !== 'inline-3d') return Promise.reject(new DOMException(`fake: ${mode} not supported`, 'NotSupportedError'));
      const s = new FakeSession(mode);
      H.sessions.push({ mode, at: performance.now() });
      H.sessionObjs.push(s);
      return Promise.resolve(s);
    },
  });
  Object.defineProperty(navigator, 'xr', { value: xr, configurable: true });
})();

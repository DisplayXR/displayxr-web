// inline3d-check — a FAKE DisplayXR inline-3D environment, injected at document start (before any
// page script) so @displayxr/inline3d believes it runs in the DisplayXR Browser.
//
// What it provides (the surface js/inline3d.js probes and calls):
//   navigator.xr.requestSession('inline-3d')  -> a session whose requestAnimationFrame rides the
//       window's, with renderState, requestReferenceSpace, trackingState 'tracking', end().
//   navigator.xr.isSessionSupported           -> true for 'inline-3d' (and the call is RECORDED: the
//       docs say never to gate on it).
//   window.XRDisplayLayer(session, canvas, init) with setViewRig, getViewport, getDisplayInfo,
//       getRenderingModes, requestRenderingMode, setViewerIndependent, close, and the static
//       occlusionByDrawOrder = true (a current, draw-order-occlusion browser).
//
// The views are GEOMETRIC, not a test pattern: two eyes 63 mm apart at the nominal viewer distance
// (0.65 m) in front of a 0.3456 m wide panel, Kooima off-axis frusta through the canvas's own rect,
// scaled by the layer's rig exactly as the runtime does (display rig: m2v = virtualDisplayHeight /
// the element's physical height; camera rig: eye offset ±ipd·m2v/2, frustum skewed so the
// convergence distance has zero disparity). So a subject on z = 0 has zero disparity, a subject in
// front is crossed, behind is uncrossed — the harness can measure the page's depth in millimetres.
//
// XRView / XRViewport fields are prototype GETTERS, as on the real browser, so a page that copies
// them with Object.assign / spread gets nothing here too (a black canvas on the real browser that
// works in a harness returning plain objects).
//
// Everything the harness reads is on window.__dxrCheck.
(() => {
  if (window.__dxrCheck) return;
  const CFG = window.__DXR_CHECK_CFG || {};
  const DISPLAY = { widthM: 0.3456, heightM: 0.1944, px: [1920, 1080], viewerM: 0.65, eyeSepM: 0.063 };
  const CANVAS_W = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width');
  const CANVAS_H = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'height');
  const now = () => performance.now();

  const H = (window.__dxrCheck = {
    display: DISPLAY,
    sessionRequests: [], // { at, mode, ok }
    liveSessions: 0,
    maxLiveSessions: 0,
    isSessionSupportedCalls: [],
    layers: [], // records, see FakeLayer
    frames: 0,
    framesWithViews: 0,
    viewportCalls: 0,
    modeRequests: [],
    activeModeIndex: 1,
    errors: [],
  });

  // ---------------------------------------------------------------- tiny mat4 (column-major)
  function quatToMat(q) {
    const x = q.x || 0, y = q.y || 0, z = q.z || 0, w = q.w === undefined ? 1 : q.w;
    const n = Math.hypot(x, y, z, w) || 1;
    const X = x / n, Y = y / n, Z = z / n, W = w / n;
    return [
      1 - 2 * (Y * Y + Z * Z), 2 * (X * Y + Z * W), 2 * (X * Z - Y * W), 0,
      2 * (X * Y - Z * W), 1 - 2 * (X * X + Z * Z), 2 * (Y * Z + X * W), 0,
      2 * (X * Z + Y * W), 2 * (Y * Z - X * W), 1 - 2 * (X * X + Y * Y), 0,
      0, 0, 0, 1,
    ];
  }
  function poseMatrix(pos, quat, eye) {
    const m = quatToMat(quat || {});
    const px = (pos && pos.x) || 0, py = (pos && pos.y) || 0, pz = (pos && pos.z) || 0;
    m[12] = px + m[0] * eye[0] + m[4] * eye[1] + m[8] * eye[2];
    m[13] = py + m[1] * eye[0] + m[5] * eye[1] + m[9] * eye[2];
    m[14] = pz + m[2] * eye[0] + m[6] * eye[1] + m[10] * eye[2];
    return new Float32Array(m);
  }
  function invertRigid(m) {
    // rotation transpose, translation -R^T t
    const r = new Float32Array(16);
    r[0] = m[0]; r[1] = m[4]; r[2] = m[8];
    r[4] = m[1]; r[5] = m[5]; r[6] = m[9];
    r[8] = m[2]; r[9] = m[6]; r[10] = m[10];
    r[12] = -(m[0] * m[12] + m[1] * m[13] + m[2] * m[14]);
    r[13] = -(m[4] * m[12] + m[5] * m[13] + m[6] * m[14]);
    r[14] = -(m[8] * m[12] + m[9] * m[13] + m[10] * m[14]);
    r[15] = 1;
    return r;
  }
  function frustum(l, r, b, t, n, f) {
    const o = new Float32Array(16);
    o[0] = (2 * n) / (r - l); o[5] = (2 * n) / (t - b);
    o[8] = (r + l) / (r - l); o[9] = (t + b) / (t - b);
    o[10] = -(f + n) / (f - n); o[11] = -1; o[14] = (-2 * f * n) / (f - n);
    return o;
  }
  const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);

  // ---------------------------------------------------------------- XR object shapes (getters)
  class FakeRigidTransform {
    constructor(m) { this._m = m; }
    get matrix() { return this._m; }
    get position() { return new DOMPointReadOnly(this._m[12], this._m[13], this._m[14], 1); }
    get orientation() {
      const m = this._m, tr = m[0] + m[5] + m[10];
      let x, y, z, w;
      if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; w = 0.25 * s; x = (m[6] - m[9]) / s; y = (m[8] - m[2]) / s; z = (m[1] - m[4]) / s; }
      else if (m[0] > m[5] && m[0] > m[10]) { const s = Math.sqrt(1 + m[0] - m[5] - m[10]) * 2; w = (m[6] - m[9]) / s; x = 0.25 * s; y = (m[4] + m[1]) / s; z = (m[8] + m[2]) / s; }
      else if (m[5] > m[10]) { const s = Math.sqrt(1 + m[5] - m[0] - m[10]) * 2; w = (m[8] - m[2]) / s; x = (m[4] + m[1]) / s; y = 0.25 * s; z = (m[9] + m[6]) / s; }
      else { const s = Math.sqrt(1 + m[10] - m[0] - m[5]) * 2; w = (m[1] - m[4]) / s; x = (m[8] + m[2]) / s; y = (m[9] + m[6]) / s; z = 0.25 * s; }
      return new DOMPointReadOnly(x, y, z, w);
    }
    get inverse() { return new FakeRigidTransform(invertRigid(this._m)); }
  }
  class FakeXRView {
    constructor(eye, index, proj, xf) { this._eye = eye; this._i = index; this._p = proj; this._t = new FakeRigidTransform(xf); }
    get eye() { return this._eye; }
    get projectionMatrix() { return this._p; }
    get transform() { return this._t; }
    get recommendedViewportScale() { return null; }
    requestViewportScale() {}
  }
  class FakeXRViewport {
    constructor(x, y, w, h) { this._v = [x, y, w, h]; }
    get x() { return this._v[0]; }
    get y() { return this._v[1]; }
    get width() { return this._v[2]; }
    get height() { return this._v[3]; }
  }

  // ---------------------------------------------------------------- views from a layer's rig
  function computeViews(session, L) {
    const c = L.canvas;
    const r = c.getBoundingClientRect();
    const cssW = r.width || CANVAS_W.get.call(c) / 2 || 1;
    const cssH = r.height || CANVAS_H.get.call(c) || 1;
    const aspect = cssW / cssH;
    const n = num(session.renderState.depthNear, 0.1), f = num(session.renderState.depthFar, 1000);
    const rig = L.rig || {};
    const type = rig.type === 'camera' ? 'camera' : 'display';
    const out = [];
    if (type === 'display') {
      const vdh = num(rig.virtualDisplayHeight, num(L.init.virtualDisplayHeight, 0.24));
      // Physical: the viewport is centred on the panel; one CSS px = displayWidth / panel px.
      const mpp = DISPLAY.widthM / DISPLAY.px[0];
      const elemHm = Math.max(1e-6, cssH * mpp);
      const m2v = vdh / elemHm;
      const cx = (r.left + cssW / 2 - innerWidth / 2) * mpp;
      const cy = -(r.top + cssH / 2 - innerHeight / 2) * mpp;
      const ipd = DISPLAY.eyeSepM * Math.max(0, num(rig.ipdFactor, 1));
      const W = vdh * aspect, Hh = vdh;
      for (let i = 0; i < 2; i++) {
        const ex = ((i ? 1 : -1) * ipd) / 2;
        const e = [(ex - cx) * m2v, (0 - cy) * m2v, DISPLAY.viewerM * m2v];
        const l = ((-W / 2 - e[0]) * n) / e[2], rr = ((W / 2 - e[0]) * n) / e[2];
        const b = ((-Hh / 2 - e[1]) * n) / e[2], t = ((Hh / 2 - e[1]) * n) / e[2];
        out.push(new FakeXRView(i ? 'right' : 'left', i, frustum(l, rr, b, t, n, f), poseMatrix(rig.position, rig.orientation, e)));
      }
    } else {
      const vfov = num(rig.verticalFov, (50 * Math.PI) / 180);
      const invC = Math.max(0, num(rig.convergenceDiopters, 0));
      const m2v = num(rig.metersToVirtual, 0) || 1;
      const ipd = DISPLAY.eyeSepM * Math.max(0, num(rig.ipdFactor, 1)) * m2v;
      const tY = Math.tan(vfov / 2), tX = tY * aspect;
      for (let i = 0; i < 2; i++) {
        const ex = ((i ? 1 : -1) * ipd) / 2;
        const l = (-tX - ex * invC) * n, rr = (tX - ex * invC) * n;
        out.push(new FakeXRView(i ? 'right' : 'left', i, frustum(l, rr, -tY * n, tY * n, n, f), poseMatrix(rig.position, rig.orientation, [ex, 0, 0])));
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- the layer
  const MODES = () => [
    { index: 0, viewCount: 1, tileColumns: 1, tileRows: 1, viewWidthPixels: 1920, viewHeightPixels: 1080, hardwareDisplay3D: false, isActive: H.activeModeIndex === 0, isRequestable: true, name: '2D' },
    { index: 1, viewCount: 2, tileColumns: 2, tileRows: 1, viewWidthPixels: 960, viewHeightPixels: 1080, hardwareDisplay3D: true, isActive: H.activeModeIndex === 1, isRequestable: true, name: 'Stereo' },
  ];
  class FakeLayer {
    constructor(session, canvas, init) {
      if (!(canvas instanceof HTMLCanvasElement)) throw new TypeError('XRDisplayLayer: not a canvas');
      if (!session || session.ended) throw new DOMException('session ended', 'InvalidStateError');
      this.session = session;
      this.canvas = canvas;
      this.init = init ? { ...init } : {};
      this.rig = init && init.viewRig ? { ...init.viewRig } : null;
      this.closed = false;
      session._layers.push(this);
      const sameCanvasLive = H.layers.filter((x) => x.canvas === canvas && !x.layer.closed).length;
      const rec = {
        layer: this,
        canvas,
        selector: window.__dxrProbe ? window.__dxrProbe.selectorOf(canvas) : canvas.id || 'canvas',
        createdAt: now(),
        closedAt: null,
        init: safeClone(this.init),
        rigs: this.rig ? [safeClone(this.rig)] : [],
        rigPushes: 0,
        sameCanvasLiveAtCreate: sameCanvasLive,
        coverAtCreate: null,
        joinSamples: 0,
        joinExposed: 0,
        lastJoinSampleAt: 0,
      };
      this._rec = rec;
      H.layers.push(rec);
      // Cover state as the first frame after construction paints (a cover the page adds in the same
      // task as add*() counts).
      requestAnimationFrame(() => {
        try { rec.coverAtCreate = window.__dxrProbe.occlusionAudit(canvas, 3, 3); } catch (e) { rec.coverAtCreate = { error: String(e) }; }
      });
    }
    setViewRig(rig) {
      this.rig = rig ? { ...rig } : null;
      this._rec.rigPushes++;
      if (this._rec.rigs.length < 5 || this._rec.rigPushes % 60 === 0) this._rec.rigs.push(safeClone(this.rig));
      else this._rec.rigs[this._rec.rigs.length - 1] = safeClone(this.rig);
    }
    setViewerIndependent(v) { this._rec.viewerIndependent = !!v; }
    getViewport(view) {
      H.viewportCalls++;
      if (!view || typeof view._i !== 'number') return null;
      // Like the real browser: canvas.width split down the middle (NOT the drawing buffer).
      const w = CANVAS_W.get.call(this.canvas), h = CANVAS_H.get.call(this.canvas);
      const half = Math.floor(w / 2);
      return new FakeXRViewport(view._i * half, 0, half, h);
    }
    getDisplayInfo() {
      return Promise.resolve({
        displayWidthMeters: DISPLAY.widthM,
        displayHeightMeters: DISPLAY.heightM,
        displayPixelWidth: DISPLAY.px[0],
        displayPixelHeight: DISPLAY.px[1],
        recommendedViewScaleX: 0.5,
        recommendedViewScaleY: 1,
        nominalViewerPosition: new DOMPointReadOnly(0, 0, DISPLAY.viewerM, 1),
      });
    }
    getRenderingModes() { return Promise.resolve(MODES()); }
    requestRenderingMode(i) {
      H.modeRequests.push({ at: now(), index: i });
      const m = MODES()[i];
      if (!m) return Promise.reject(new DOMException('no such mode', 'NotSupportedError'));
      const was = H.activeModeIndex;
      H.activeModeIndex = i;
      if (was !== i) {
        setTimeout(() => {
          for (const s of liveSessions) {
            const e1 = new Event('renderingmodechange'); e1.mode = MODES()[i]; e1.modeIndex = i; s.dispatchEvent(e1);
            const e2 = new Event('hardwaredisplaystatechange'); e2.state = m.hardwareDisplay3D ? '3d' : '2d'; s.dispatchEvent(e2);
          }
        }, 0);
      }
      return Promise.resolve();
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      this._rec.closedAt = now();
    }
  }
  Object.defineProperty(FakeLayer, 'occlusionByDrawOrder', { value: true, enumerable: true });
  window.XRDisplayLayer = FakeLayer;

  function safeClone(o) {
    if (!o) return o;
    const out = {};
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (v && typeof v === 'object' && 'x' in v) out[k] = { x: v.x, y: v.y, z: v.z, w: v.w };
      else if (typeof v !== 'function') out[k] = v;
    }
    return out;
  }

  // ---------------------------------------------------------------- the session
  const liveSessions = new Set();
  class FakeSession extends EventTarget {
    constructor(mode) {
      super();
      this.mode = mode;
      this.ended = false;
      this._layers = [];
      this.renderState = { depthNear: 0.1, depthFar: 1000, inlineVerticalFieldOfView: null, baseLayer: null };
      this.inputSources = [];
      this.visibilityState = 'visible';
      this.trackingState = 'tracking';
      this.environmentBlendMode = 'opaque';
      liveSessions.add(this);
      H.liveSessions = liveSessions.size;
      H.maxLiveSessions = Math.max(H.maxLiveSessions, liveSessions.size);
    }
    requestReferenceSpace(type) {
      return Promise.resolve({ type, getOffsetReferenceSpace() { return this; }, addEventListener() {}, removeEventListener() {} });
    }
    updateRenderState(s) { Object.assign(this.renderState, s || {}); }
    requestAnimationFrame(cb) {
      return window.requestAnimationFrame((t) => {
        if (this.ended) return;
        cb(t, this._frame());
      });
    }
    cancelAnimationFrame(id) { window.cancelAnimationFrame(id); }
    end() {
      if (!this.ended) {
        this.ended = true;
        liveSessions.delete(this);
        H.liveSessions = liveSessions.size;
        for (const L of this._layers) L.close();
        this.dispatchEvent(new Event('end'));
      }
      return Promise.resolve();
    }
    _primaryLayer() {
      for (let i = this._layers.length - 1; i >= 0; i--) if (!this._layers[i].closed) return this._layers[i];
      return null;
    }
    _frame() {
      H.frames++;
      const session = this;
      const L = this._primaryLayer();
      let views = null;
      return {
        session,
        getViewerPose() {
          if (!L) return null;
          if (!views) { views = computeViews(session, L); H.framesWithViews++; }
          return { views, transform: new FakeRigidTransform(poseMatrix(null, null, [0, 0, 0])), emulatedPosition: false };
        },
        getPose() { return null; },
      };
    }
  }

  const xr = new EventTarget();
  xr.isSessionSupported = (mode) => {
    H.isSessionSupportedCalls.push({ at: now(), mode, stack: (new Error().stack || '').split('\n').slice(2, 5).join(' | ') });
    return Promise.resolve(mode === 'inline-3d' || mode === 'inline');
  };
  xr.requestSession = (mode) => {
    if (mode !== 'inline-3d' && mode !== 'inline') {
      H.sessionRequests.push({ at: now(), mode, ok: false });
      return Promise.reject(new DOMException(`${mode} is not supported here`, 'NotSupportedError'));
    }
    H.sessionRequests.push({ at: now(), mode, ok: true });
    return Promise.resolve(new FakeSession(mode));
  };
  Object.defineProperty(navigator, 'xr', { value: xr, configurable: true });

  // ---------------------------------------------------------------- commit-time snapshots
  // A ResizeObserver callback runs after every rAF callback and before paint: the one moment a
  // WebGL drawing buffer without preserveDrawingBuffer is still readable, and exactly what the
  // document commits this frame (the technique of tools/auto3d-shim/test/fake-xr.js).
  const pending = []; // { index, maxW, resolve }
  function snapCanvas(c, maxW) {
    const bw = CANVAS_W.get.call(c), bh = CANVAS_H.get.call(c);
    if (!bw || !bh) return { bufW: bw, bufH: bh, sw: 0, sh: 0, rgba: '' };
    const sw = Math.max(2, Math.min(maxW, bw) & ~1);
    const sh = Math.max(1, Math.round((bh * sw) / bw));
    const t = document.createElement('canvas');
    t.width = sw; t.height = sh;
    const g = t.getContext('2d', { willReadFrequently: true });
    g.drawImage(c, 0, 0, sw, sh);
    const d = g.getImageData(0, 0, sw, sh).data;
    let b = '';
    for (let i = 0; i < d.length; i += 8192) b += String.fromCharCode.apply(null, d.subarray(i, i + 8192));
    return { bufW: bw, bufH: bh, sw, sh, rgba: btoa(b) };
  }
  function tinyContent(c) {
    // Fraction of 48x24 samples that hold anything (alpha and not the dominant colour).
    const t = document.createElement('canvas'); t.width = 48; t.height = 24;
    const g = t.getContext('2d', { willReadFrequently: true });
    g.drawImage(c, 0, 0, 48, 24);
    const d = g.getImageData(0, 0, 48, 24).data;
    const hist = new Map();
    for (let i = 0; i < d.length; i += 4) { const k = (d[i] >> 4) | ((d[i + 1] >> 4) << 4) | ((d[i + 2] >> 4) << 8) | ((d[i + 3] >> 4) << 12); hist.set(k, (hist.get(k) || 0) + 1); }
    let dom = 0, best = -1; for (const [k, v] of hist) if (v > best) { best = v; dom = k; }
    const dr = (dom & 15) * 16, dg = ((dom >> 4) & 15) * 16, db = ((dom >> 8) & 15) * 16, da = ((dom >> 12) & 15) * 16;
    let n = 0; for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - dr) + Math.abs(d[i + 1] - dg) + Math.abs(d[i + 2] - db) + Math.abs(d[i + 3] - da) > 48) n++;
    return n / (d.length / 4);
  }
  H.snap = (index, maxW = 640) => new Promise((resolve) => pending.push({ index, maxW, resolve }));
  // The layer-loss probe: end every live session, as the browser does when the weave service goes
  // away. The SDK then closes each layer, paints image/video windows mono and calls a scene's
  // onLayerLost; whatever each canvas shows afterwards is what a user would be left looking at.
  H.endSessions = () => { const n = liveSessions.size; for (const s of [...liveSessions]) s.end(); return n; };

  const probe = document.createElement('div');
  Object.assign(probe.style, { position: 'fixed', left: '-10px', top: '0', width: '1px', height: '1px', pointerEvents: 'none' });
  const ro = new ResizeObserver(() => {
    // 1. requested snapshots
    while (pending.length) {
      const p = pending.shift();
      const rec = H.layers[p.index];
      try { p.resolve(rec ? snapCanvas(rec.canvas, p.maxW) : null); } catch (e) { p.resolve({ error: String(e) }); }
    }
    // 2. join-window exposure: during a new layer's first 1.2 s (the browser's measured worst-case
    //    join), would the raw side-by-side pair be on screen? (uncovered, and the canvas holds pixels)
    const t = now();
    for (const rec of H.layers) {
      if (rec.layer.closed || t - rec.createdAt > 1250 || t - rec.lastJoinSampleAt < 90) continue;
      rec.lastJoinSampleAt = t;
      try {
        const a = window.__dxrProbe.occlusionAudit(rec.canvas, 3, 2);
        if (!a.visible || a.total === 0) continue;
        rec.joinSamples++;
        if (a.coveredFraction < 0.5 && tinyContent(rec.canvas) > 0.01) rec.joinExposed++;
      } catch { /* ignore */ }
    }
  });
  const tick = () => { probe.style.width = probe.style.width === '1px' ? '2px' : '1px'; requestAnimationFrame(tick); };
  const start = () => { document.documentElement.appendChild(probe); ro.observe(probe); requestAnimationFrame(tick); };
  if (document.documentElement) start(); else document.addEventListener('DOMContentLoaded', start, { once: true });

  // ---------------------------------------------------------------- summary for the harness
  H.summary = () => ({
    sessionRequests: H.sessionRequests,
    liveSessions: H.liveSessions,
    maxLiveSessions: H.maxLiveSessions,
    isSessionSupportedCalls: H.isSessionSupportedCalls,
    frames: H.frames,
    framesWithViews: H.framesWithViews,
    viewportCalls: H.viewportCalls,
    modeRequests: H.modeRequests,
    activeModeIndex: H.activeModeIndex,
    layers: H.layers.map((r, i) => ({
      index: i,
      selector: r.selector,
      createdAt: r.createdAt,
      closedAt: r.closedAt,
      open: !r.layer.closed,
      ageMs: now() - r.createdAt,
      init: r.init,
      rig: r.layer.rig ? safeClone(r.layer.rig) : null,
      rigPushes: r.rigPushes,
      sameCanvasLiveAtCreate: r.sameCanvasLiveAtCreate,
      coverAtCreate: r.coverAtCreate,
      joinSamples: r.joinSamples,
      joinExposed: r.joinExposed,
      viewerIndependent: !!r.viewerIndependent,
    })),
    now: now(),
  });
  H.layerCanvas = (i) => (H.layers[i] ? H.layers[i].canvas : null);
})();

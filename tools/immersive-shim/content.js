// DisplayXR immersive-vr shim — validation SPIKE, not a product.
//
// Runs in the page's MAIN world at document_start and replaces navigator.xr so that
// requestSession('immersive-vr') is served by the DisplayXR Browser's shipped inline-3d
// path (a sensorless inline session + XRDisplayLayer on the app's own canvas), woven
// in-tab. The page needs no changes. Design + rationale:
//   displayxr-browser-pvt/docs/design/immersive-vr-emulation.md
//
// What it emulates (v1 scope of that design):
//   - isSessionSupported('immersive-vr') -> true
//   - XRWebGLLayer with a REAL opaque framebuffer (FBO, resolved + drawn into the canvas
//     at frame end); WebGL1 falls back to framebuffer=null (app draws into the canvas)
//   - two XRViews with the runtime's off-axis projection + eye poses, verbatim
//   - reference spaces viewer / local / local-floor / bounded-floor / unbounded
//   - the qwerty device's TWO controllers as XRInputSources (WMR profile, HMD-parented; Z/X focus)
//   - THE QWERTY DEVICE, mirrored: the runtime's keyboard/mouse rig for hosted legacy apps
//     (src/xrt/drivers/qwerty). WASDQE move, arrows / RMB-drag look, Shift sprint, +/- speed,
//     P camera<->display toggle (dxr_rig_toggle math), wheel = convergence / vHeight,
//     Shift+wheel = IPD+parallax, Space reset, V 2D/3D, 1/2/3 rendering mode, Tab HUD,
//     T/F/G/H thumbstick, N/B menu/system, MMB squeeze, LMB select.
//     The product replaces this with the runtime's own qwerty device + input providers
//     (design §4.3 amendment, browser-pvt#63); the feel must not change.
//   - a feature-detect log: every session property a page touches is recorded
//
// Shim-only hotkeys (Ctrl+Alt+...): 0 legacy default, 1-5 presets, [ ] m2v, , . ipd, ; ' parallax,
//   L dump log, F flatten, H HUD, P fullscreen/in-place (next session), Q qwerty on/off.
// Config persists in localStorage['dxrImmersiveShim']; window.__dxrImmersiveShim exposes it.
(() => {
  'use strict';
  const TAG = '[dxr-immersive-shim]';
  if (window.__dxrImmersiveShim) return;
  const realXR = navigator.xr;
  const NativeXRWebGLLayer = window.XRWebGLLayer;
  if (!realXR || typeof window.XRDisplayLayer !== 'function') {
    return; // not a DisplayXR Browser: inert, stock behaviour
  }

  // ---------------------------------------------------------------- config
  const DEFAULTS = {
    v: 3,                       // bump to invalidate a persisted cfg when defaults change
    preset: 'legacy',
    present: 'fullscreen',      // 'fullscreen' | 'inplace'
    floorY: -1.6,               // where local-floor's origin sits below the plane (app units)
    nullFramebuffer: false,     // force the (1a) design: framebuffer=null, app draws the canvas
    maxSbsWidth: 3072,          // browser-pvt#24: wider SBS canvases drop off the zero-copy weave path
    qwerty: true,               // mirror the runtime's qwerty device (keys/mouse drive the rig)
    hud: true, log: true,
  };
  const PIXEL_PITCH_FALLBACK = 0.3442 / 3840; // metres per device px if getDisplayInfo() is absent
  const NOMINAL_VIEW_DISTANCE = 0.6;          // runtime nominal viewer z (qwerty_device.c nominal_viewer_z)

  let cfg = loadCfg();
  function loadCfg() {
    try { const st = JSON.parse(localStorage.getItem('dxrImmersiveShim') || '{}'); return st.v === DEFAULTS.v ? { ...DEFAULTS, ...st } : { ...DEFAULTS }; }
    catch (e) { return { ...DEFAULTS }; }
  }
  function saveCfg() { try { localStorage.setItem('dxrImmersiveShim', JSON.stringify(cfg)); } catch (e) {} }

  // ------------------------------------------------------ feature-detect log
  const seen = new Map();
  function touch(what) {
    if (!cfg.log) return;
    if (!seen.has(what)) { seen.set(what, 0); console.info(TAG, 'page touched:', what); }
    seen.set(what, seen.get(what) + 1);
  }
  function dumpLog() {
    const rows = [...seen.entries()].map(([k, v]) => ({ surface: k, hits: v }));
    console.table(rows);
    return rows;
  }

  // ------------------------------------------------------------- math bits
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const norm = v => { const l = Math.hypot(v.x, v.y, v.z) || 1; return { x: v.x / l, y: v.y / l, z: v.z / l }; };
  const neg = v => ({ x: -v.x, y: -v.y, z: -v.z });
  const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
  const qmul = (a, b) => ({ x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y, y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x, z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w, w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z });
  const qnorm = q => { const l = Math.hypot(q.x, q.y, q.z, q.w) || 1; return { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l }; };
  const qaxis = (ax, ang) => { const h = ang / 2, s = Math.sin(h); return { x: ax.x * s, y: ax.y * s, z: ax.z * s, w: Math.cos(h) }; };
  function qrot(q, v) { // rotate v by q
    const u = { x: q.x, y: q.y, z: q.z }; const s = q.w; const c1 = cross(u, v); const c2 = cross(u, c1);
    return { x: v.x + 2 * s * c1.x + 2 * c2.x, y: v.y + 2 * s * c1.y + 2 * c2.y, z: v.z + 2 * s * c1.z + 2 * c2.z };
  }
  function m4(arr) { return new DOMMatrix(Array.from(arr)); }
  function quatFromMatrix(M) {
    // DOMMatrix mIJ: I = column, J = row. R[r][c] = M['m'+(c+1)+(r+1)].
    const r00 = M.m11, r01 = M.m21, r02 = M.m31;
    const r10 = M.m12, r11 = M.m22, r12 = M.m32;
    const r20 = M.m13, r21 = M.m23, r22 = M.m33;
    const t = r00 + r11 + r22; let x, y, z, w;
    if (t > 0) { const s = Math.sqrt(t + 1) * 2; w = 0.25 * s; x = (r21 - r12) / s; y = (r02 - r20) / s; z = (r10 - r01) / s; }
    else if (r00 > r11 && r00 > r22) { const s = Math.sqrt(1 + r00 - r11 - r22) * 2; w = (r21 - r12) / s; x = 0.25 * s; y = (r01 + r10) / s; z = (r02 + r20) / s; }
    else if (r11 > r22) { const s = Math.sqrt(1 + r11 - r00 - r22) * 2; w = (r02 - r20) / s; x = (r01 + r10) / s; y = 0.25 * s; z = (r12 + r21) / s; }
    else { const s = Math.sqrt(1 + r22 - r00 - r11) * 2; w = (r10 - r01) / s; x = (r02 + r20) / s; y = (r12 + r21) / s; z = 0.25 * s; }
    return { x, y, z, w };
  }
  function rigidFromMatrix(M) {
    return new XRRigidTransform({ x: M.m41, y: M.m42, z: M.m43, w: 1 }, quatFromMatrix(M));
  }
  function quatToMatrix(q) { const { x, y, z, w } = q; return new DOMMatrix([1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0, 2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0, 2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0, 0, 0, 0, 1]); }
  function lookAlong(dir) {
    // quaternion rotating -Z onto dir (y-up), as {x,y,z,w}
    const f = norm(dir); const up = Math.abs(f.y) > 0.99 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 };
    const r = norm(cross(up, neg(f))); const u = cross(neg(f), r);
    const M = new DOMMatrix([r.x, r.y, r.z, 0, u.x, u.y, u.z, 0, -f.x, -f.y, -f.z, 0, 0, 0, 0, 1]);
    return quatFromMatrix(M);
  }
  const err = (name, msg) => new DOMException(msg, name);

  // ------------------------------------------- dxr::ModeSwitch, ported 1:1
  // displayxr-common common/mode_switch.{h,cpp}: eases the rig ipdFactor around a 2D<->3D
  // switch and owns the sequencing asymmetry — 3D->2D ramps to 0 FIRST then fires the mode
  // request; 2D->3D fires FIRST then eases up. 0.18 s SmoothStep, wall-clock, retargetable.
  class ModeSwitch {
    constructor() { this.phase = 'idle'; this.targetMode = 0; this.firePending = false; this.fireAtEnd = false; this.from = 0; this.to = 0; this.cur = 0; this.t = 1; this.dur = 0.18; this.easing = 'smoothstep'; }
    configure(dur, easing = 'smoothstep') { this.dur = dur > 0 ? dur : 0; this.easing = easing; }
    ease(t) { if (t <= 0) return 0; if (t >= 1) return 1; if (this.easing === 'linear') return t; if (this.easing === 'easeoutcubic') { const u = 1 - t; return 1 - u * u * u; } return t * t * (3 - 2 * t); }
    active() { return this.phase !== 'idle'; }
    ipd() { return this.cur; }
    request(targetMode, targetVC, currentMode, currentVC, currentIpd, steadyIpd) {
      const toMono = targetVC <= 1, fromMono = currentVC <= 1;
      this.targetMode = targetMode; this.from = currentIpd;
      if (toMono && !fromMono) { this.phase = 'rampDownThenFire'; this.to = 0; this.fireAtEnd = true; this.firePending = false; }
      else if (!toMono && fromMono) { this.phase = 'fireThenRampUp'; this.from = 0; this.to = steadyIpd; this.firePending = true; this.fireAtEnd = false; }
      else { this.phase = 'fireThenRampUp'; this.to = toMono ? currentIpd : steadyIpd; this.firePending = targetMode !== currentMode; this.fireAtEnd = false; }
      this.t = this.dur > 0 ? 0 : 1; this.cur = this.from;
    }
    update(dt) {
      let fire = false;
      if (this.phase !== 'idle') {
        if (this.t < 1 && this.dur > 0) { this.t += dt / this.dur; if (this.t > 1) this.t = 1; } else this.t = 1;
        this.cur = this.from + (this.to - this.from) * this.ease(this.t);
        if (this.phase === 'fireThenRampUp') { if (this.firePending) { this.firePending = false; fire = true; } if (this.t >= 1) this.phase = 'idle'; }
        else if (this.t >= 1) { if (this.fireAtEnd) { this.fireAtEnd = false; fire = true; } this.phase = 'idle'; }
      }
      return { ipd: this.cur, fire, mode: this.targetMode };
    }
  }

  // ------------------------------------------------- qwerty device, mirrored
  // Numbers and semantics from qwerty_device.c / qwerty_win32.c / dxr_view_math.c.
  const QW = {
    cameraMode: true,
    pos: { x: 0, y: 0, z: NOMINAL_VIEW_DISTANCE }, ori: { x: 0, y: 0, z: 0, w: 1 },
    cam: { spread: 1, parallax: 1, conv: 0.5, halfTanVfov: 0.3249, m2v: 1 },   // 0.5 dp = 2 m, tan(18deg)
    disp: { spread: 1, parallax: 1, vH: 1.3, persp: 1 },
    moveSpeed: 0.0233, lookSpeed: 0.02, sprint: false,                           // per 60 Hz frame: 1.4 m/s walk, Shift x3.05 = 4.3 m/s run
    k: { f: 0, b: 0, l: 0, r: 0, u: 0, d: 0, ll: 0, lr: 0, lu: 0, ld: 0 },
    yawDelta: 0, pitchDelta: 0, lastMs: 0, mouseLook: false, dirty: true,
    reset() {   // qwerty_reset_view_state + the (0, 1.6, 0.6)-from-nominal reseed, in LOCAL terms
      Object.assign(this, { cameraMode: true, pos: { x: 0, y: 0, z: NOMINAL_VIEW_DISTANCE }, ori: { x: 0, y: 0, z: 0, w: 1 },
        cam: { spread: 1, parallax: 1, conv: 0.5, halfTanVfov: 0.3249, m2v: 1 }, disp: { spread: 1, parallax: 1, vH: 1.3, persp: 1 }, dirty: true });
    },
    integrate(nowMs) {   // qwerty_device.c per-frame integration (dt in 60 Hz frames, 100 ms cap)
      let dtf = 1; if (this.lastMs) dtf = clamp(nowMs - this.lastMs, 0, 100) / (1000 / 60); this.lastMs = nowMs;
      const k = this.k; const moving = k.f || k.b || k.l || k.r || k.u || k.d || k.ll || k.lr || k.lu || k.ld || this.yawDelta || this.pitchDelta;
      if (!moving) return;
      const mov = this.moveSpeed * (this.sprint ? Math.pow(1.25, 5) : 1) * dtf;
      let pd = { x: mov * (k.r - k.l), y: 0, z: mov * (k.b - k.f) };
      pd = qrot(this.ori, pd); pd.y += mov * (k.u - k.d);
      this.pos = { x: this.pos.x + pd.x, y: this.pos.y + pd.y, z: this.pos.z + pd.z };
      const yaw = this.lookSpeed * dtf * (k.ll - k.lr) + this.yawDelta;
      const pitch = this.lookSpeed * dtf * (k.lu - k.ld) + this.pitchDelta;
      this.yawDelta = 0; this.pitchDelta = 0;
      const xr = qaxis({ x: 1, y: 0, z: 0 }, pitch), yr = qaxis({ x: 0, y: 1, z: 0 }, yaw);
      this.ori = qnorm(qmul(yr, qmul(this.ori, xr)));   // local-space pitch, base-space yaw
      this.dirty = true;
    },
    look(dx, dy) { if (!this.mouseLook) return; this.yawDelta += (-dx * 0.1) * this.lookSpeed; this.pitchDelta += (-dy * 0.1) * this.lookSpeed; },
    toggle(info) {   // P: dxr_rig_toggle — disturbance-free, the convergence plane stays put
      const { H, N } = info; const tanHalfPhys = H / (2 * N);
      if (this.cameraMode) {
        const c = this.cam; const persp = tanHalfPhys / c.halfTanVfov; const f = c.m2v * c.conv * N; const invd = Math.max(c.conv, 1e-6);
        this.disp = { spread: c.spread * f, parallax: c.parallax * f, vH: clamp(2 * c.halfTanVfov / invd, 0.1, 10), persp: clamp(persp, 0.1, 10) };
        const fwd = qrot(this.ori, { x: 0, y: 0, z: 1 / invd });                 // camera -> plane is -Z by 1/invd
        this.pos = { x: this.pos.x - fwd.x, y: this.pos.y - fwd.y, z: this.pos.z - fwd.z };
      } else {
        const d = this.disp; const es = d.persp * (d.vH / H); const dWorld = es * N;
        this.cam = { halfTanVfov: tanHalfPhys / d.persp, m2v: 1, spread: d.spread * es, parallax: d.parallax * es, conv: clamp(1 / dWorld, 0, 2) };
        const fwd = qrot(this.ori, { x: 0, y: 0, z: dWorld });
        this.pos = { x: this.pos.x + fwd.x, y: this.pos.y + fwd.y, z: this.pos.z + fwd.z };
      }
      this.cameraMode = !this.cameraMode; this.dirty = true;
      console.info(TAG, 'qwerty: view mode ->', this.cameraMode ? 'Camera' : 'Display');
    },
    adjustViewFactor(mult, info) {   // Shift+wheel: IPD + parallax together
      if (this.cameraMode) { const c = this.cam; const f = (c.m2v || 1) * c.conv * info.N; const max = f > 0 ? 1 / f : Infinity; c.spread = c.parallax = clamp(c.spread * mult, 0.01, max); }
      else { const d = this.disp; d.spread = d.parallax = clamp(d.spread * mult, 0.01, 1); }
      this.dirty = true;
    },
    adjustConvergence(dir, info) {   // wheel in camera mode: +-0.05 dp, comfort-clamped
      if (!this.cameraMode) return; const c = this.cam; const ipd = Math.max(c.spread, 1); const max = 1 / (ipd * (c.m2v || 1) * info.N);
      c.conv = clamp(c.conv + dir * 0.05, 0, max); this.dirty = true;
    },
    adjustVHeight(mult) { if (this.cameraMode) return; this.disp.vH = clamp(this.disp.vH * mult, 0.1, 10); this.dirty = true; },
    changeSpeed(steps) { this.moveSpeed = clamp(this.moveSpeed * Math.pow(1.25, steps), 1e-5, 1); },
    ipdOverride: null,   // dxr::ModeSwitch output while a 2D<->3D switch is in flight
    rig() {   // -> XRViewRigInit (patch 0124)
      const position = { ...this.pos }, orientation = { ...this.ori };
      const ipdOf = v => this.ipdOverride !== null ? this.ipdOverride : v;
      if (this.cameraMode) {
        const c = this.cam;
        return { type: 'camera', position, orientation, verticalFov: 2 * Math.atan(c.halfTanVfov), convergenceDiopters: c.conv, metersToVirtual: c.m2v, ipdFactor: ipdOf(c.spread), parallaxFactor: c.parallax };
      }
      const d = this.disp;
      return { type: 'display', position, orientation, virtualDisplayHeight: d.vH, ipdFactor: clamp(ipdOf(d.spread), 0, 1), parallaxFactor: clamp(d.parallax, 0, 1), perspectiveFactor: d.persp };
    },
    seedPreset(name, info) {   // presets re-expressed as qwerty states
      const H = info.H, N = info.N; this.reset();
      switch (name) {
        case 'legacy': break;                                                            // the runtime's own defaults
        case 'portal':   this.cameraMode = false; this.disp.vH = H;       this.pos = { x: 0, y: 0, z: 0 }; break;
        case 'room':     this.cameraMode = false; this.disp.vH = 2.0 * H; this.pos = { x: 0, y: 0, z: 0 }; break;
        case 'tabletop': this.cameraMode = false; this.disp.vH = 3.3 * H; this.pos = { x: 0, y: 0, z: 0 }; break;
        case 'wide':     this.cam.halfTanVfov = Math.tan(22.5 * Math.PI / 180); this.cam.parallax = 0.3; break;
        case 'scene':    this.cam.conv = 1 / 2.5; this.cam.halfTanVfov = H / (2 * N); break;
      }
      this.dirty = true;
    },
  };
  const PRESETS = ['legacy', 'portal', 'room', 'tabletop', 'wide', 'scene'];
  function applyPreset(name) {
    if (!PRESETS.includes(name)) return;
    cfg.preset = name; saveCfg();
    if (active) { QW.seedPreset(name, active._info()); active.refreshRig(); }
    hud();
  }

  // ------------------------------------------------------- reference spaces
  class ShimReferenceSpace extends EventTarget {
    constructor(type, fromPlane /* DOMMatrix: plane space -> this space */, bounds) {
      super(); this._type = type; this._fromPlane = fromPlane; this._isShim = true;
      if (bounds) this.boundsGeometry = bounds;
    }
    getOffsetReferenceSpace(originOffset) {
      touch('XRReferenceSpace.getOffsetReferenceSpace');
      const off = m4(originOffset.matrix);
      return new ShimReferenceSpace(this._type, off.inverse().multiply(this._fromPlane), this.boundsGeometry);
    }
    get onreset() { return this._onreset || null; }
    set onreset(f) { if (this._onreset) this.removeEventListener('reset', this._onreset); this._onreset = f; if (f) this.addEventListener('reset', f); }
  }
  class ShimSpace { constructor(kind) { this._kind = kind; } } // targetRay / grip

  // ------------------------------------------------------ the session itself
  let active = null;
  const inlineSessions = new Set();   // page inline sessions parked while a converted session is live

  function makeSession(mode, init) {
    const requested = new Set([...(init.requiredFeatures || []), ...(init.optionalFeatures || [])]);
    const required = new Set(init.requiredFeatures || []);
    const GRANTABLE = new Set(['viewer', 'local', 'local-floor', 'bounded-floor', 'unbounded', 'dom-overlay']);
    for (const f of required) {
      if (!GRANTABLE.has(f)) throw err('NotSupportedError', `${TAG} required feature '${f}' is not supported by the in-tab emulation`);
    }
    const enabledFeatures = ['viewer', 'local', ...[...requested].filter(f => GRANTABLE.has(f) && f !== 'viewer' && f !== 'local')];

    const target = new EventTarget();
    const S = {};                       // the underlying session object
    let realSession = null, realViewerSpace = null, layer = null;
    let gl = null, canvas = null, glLayer = null, ended = false;
    let lastViews = null;               // last real XRView pair (plane space)
    let oneView = false;                // an emulated 1-view (2D) rendering mode is active
    const modeSwitch = new ModeSwitch(); let lastFrameMs = 0;   // eased 2D<->3D, as the cube apps / demos do
    let displayInfo = null;             // XRDisplayInfo from 0128, if available
    const renderState = { depthNear: 0.1, depthFar: 1000, baseLayer: null, inlineVerticalFieldOfView: null, passthroughFullyObscured: undefined };
    // NOTE: no `layers` key on purpose -> engines take their XRWebGLLayer branch.
    const savedCanvasStyle = {};
    const input = makeInput();
    const rafMap = new Map(); let rafSeq = 0;
    let resizeObs = null;

    // ---- geometry of the element, in metres and app units
    function pitch() {
      return displayInfo && displayInfo.displayPixelWidth ? displayInfo.displayWidthMeters / displayInfo.displayPixelWidth : PIXEL_PITCH_FALLBACK;
    }
    function elementDevicePx() {
      const r = canvas.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1;
      return { w: Math.max(2, Math.round(r.width * dpr)), h: Math.max(2, Math.round(r.height * dpr)), rect: r, dpr };
    }
    function elementPhysical() { const e = elementDevicePx(); return { w: e.w * pitch(), h: e.h * pitch() }; }
    S._info = () => ({ H: canvas ? elementPhysical().h : 0.1936, N: NOMINAL_VIEW_DISTANCE });

    // ---- rig
    function rigInit() { return QW.rig(); }
    S.refreshRig = () => { if (layer && typeof layer.setViewRig === 'function') { try { layer.setViewRig(rigInit()); QW.dirty = false; } catch (e) { console.warn(TAG, 'setViewRig failed', e); } } };

    // ---- reference spaces (plane space P: origin = element centre, z=0 = the glass)
    function fromPlaneFor(type) {
      switch (type) {
        case 'viewer': case 'local': case 'unbounded': return new DOMMatrix();
        case 'local-floor': case 'bounded-floor': return new DOMMatrix().translate(0, -cfg.floorY, 0);
      }
      return null;
    }
    S.requestReferenceSpace = (type) => {
      touch(`requestReferenceSpace(${type})`);
      const M = fromPlaneFor(type);
      if (!M || !enabledFeatures.includes(type)) return Promise.reject(err('NotSupportedError', `${TAG} reference space '${type}' not enabled`));
      const bounds = type === 'bounded-floor' ? [[-0.75, 0.75], [0.75, 0.75], [0.75, -0.75], [-0.75, -0.75]].map(([x, z]) => new DOMPointReadOnly(x, 0, z, 1)) : undefined;
      return Promise.resolve(new ShimReferenceSpace(type, M, bounds));
    };

    // ---- frames
    function planePoseIn(ref) { return rigidFromMatrix(ref._fromPlane); }
    function eyeCentroid() {
      if (!lastViews || lastViews.length < 2) return { x: 0, y: 0, z: NOMINAL_VIEW_DISTANCE };
      const a = lastViews[0].transform.position, b = lastViews[1].transform.position;
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
    }
    function makeViews(realViews, ref) {
      return realViews.map((v, i) => {
        const M = ref._fromPlane.multiply(m4(v.transform.matrix));
        return { eye: i === 0 ? 'left' : 'right', projectionMatrix: v.projectionMatrix, transform: rigidFromMatrix(M),
                 recommendedViewportScale: null, requestViewportScale() {}, isFirstPersonObserver: false, _index: i };
      });
    }
    function makeFrame(t, realFrame) {
      const F = { session: proxy, predictedDisplayTime: t, trackedAnchors: undefined };
      F.getViewerPose = (ref) => {
        touch('XRFrame.getViewerPose');
        if (!ref || !ref._isShim) throw err('InvalidStateError', `${TAG} unknown reference space`);
        const rp = realViewerSpace ? realFrame.getViewerPose(realViewerSpace) : null;
        if (!rp || !rp.views || rp.views.length < 2) return null;
        lastViews = rp.views;
        // In a 1-view (2D) mode the browser flips the hardware but keeps weaving the pair; feed the
        // left view to both halves so the woven result is one flat picture (runtime legacy-2D rule).
        const views = oneView ? [rp.views[0], rp.views[0]] : rp.views;
        return { transform: planePoseIn(ref), views: makeViews(views, ref), emulatedPosition: false, linearVelocity: null, angularVelocity: null };
      };
      F.getPose = (space, base) => {
        touch('XRFrame.getPose');
        if (!base || !base._isShim) return null;
        if (space && space._isShim) return { transform: rigidFromMatrix(base._fromPlane.multiply(space._fromPlane.inverse())), emulatedPosition: false };
        if (space instanceof ShimSpace) return input.pose(space._kind, base);
        return null;
      };
      F.getHitTestResults = () => { touch('XRFrame.getHitTestResults'); return []; };
      F.getJointPose = () => { touch('XRFrame.getJointPose'); return null; };
      F.fillPoses = () => { touch('XRFrame.fillPoses'); return false; };
      return F;
    }
    S.requestAnimationFrame = (cb) => {
      touch('requestAnimationFrame');
      if (ended) return 0;
      const id = ++rafSeq;
      const realId = realSession.requestAnimationFrame((t, realFrame) => {
        rafMap.delete(id);
        const nowMs = performance.now(); const dt = lastFrameMs ? clamp((nowMs - lastFrameMs) / 1000, 0, 0.1) : 1 / 60; lastFrameMs = nowMs;
        if (modeSwitch.active()) {
          const r = modeSwitch.update(dt);
          QW.ipdOverride = modeSwitch.active() ? r.ipd : null; QW.dirty = true;   // steady ipd resumes when the ramp lands
          if (r.fire) S._fireMode(r.mode);
          hud();
        }
        if (cfg.qwerty && layer) { QW.integrate(nowMs); if (QW.dirty) S.refreshRig(); }
        const frame = makeFrame(t, realFrame);
        input.beginFrame(frame, clamp(dt * 60, 0, 6));
        try { cb(t, frame); } finally { if (glLayer) glLayer._endFrame(); input.endFrame(); }
      });
      rafMap.set(id, realId);
      return id;
    };
    S.cancelAnimationFrame = (id) => { const r = rafMap.get(id); if (r !== undefined) { realSession.cancelAnimationFrame(r); rafMap.delete(id); } };

    // ---- render state / base layer
    S.updateRenderState = (st = {}) => {
      touch('updateRenderState');
      if (ended) throw err('InvalidStateError', 'session ended');
      if ('layers' in st && st.layers) throw err('NotSupportedError', `${TAG} the layers module is not supported (v1)`);
      if (st.depthNear !== undefined) renderState.depthNear = st.depthNear;
      if (st.depthFar !== undefined) renderState.depthFar = st.depthFar;
      try { realSession.updateRenderState({ depthNear: renderState.depthNear, depthFar: renderState.depthFar }); } catch (e) {}
      if (st.baseLayer !== undefined) {
        if (st.baseLayer && !(st.baseLayer instanceof ShimXRWebGLLayer)) throw err('TypeError', `${TAG} baseLayer must be an XRWebGLLayer created for this session`);
        renderState.baseLayer = st.baseLayer;
        if (st.baseLayer) attachLayer(st.baseLayer);
      }
    };
    function attachLayer(L) {
      glLayer = L; gl = L.context; canvas = gl.canvas;
      if (!(canvas instanceof HTMLCanvasElement)) throw err('NotSupportedError', `${TAG} OffscreenCanvas is not supported (v1)`);
      if (!canvas.isConnected) {
        // Headset-authored pages often never attach the XRWebGLLayer canvas (the runtime
        // owned present). Adopt it: only a composited element can be woven.
        console.warn(TAG, 'XRWebGLLayer canvas is not in the DOM — adopting it into <body> (design §3.3 amendment)');
        canvas.dataset.dxrShimAdopted = '1';
        (document.body || document.documentElement).appendChild(canvas);
        touch('canvas adopted (was detached)');
      }
      presentCanvas();
      QW.seedPreset(cfg.preset, S._info());
      // virtualDisplayHeight on the layer init marks this canvas as the SCENE layer (the one
      // whose rect scopes the rig views); the viewRig carries the actual rig.
      const rig = rigInit();
      const init = { virtualDisplayHeight: elementPhysical().h, viewRig: rig };
      try { layer = new XRDisplayLayer(realSession, canvas, init); }
      catch (e) { console.warn(TAG, 'XRDisplayLayer with viewRig failed, retrying without', e); layer = new XRDisplayLayer(realSession, canvas, { virtualDisplayHeight: init.virtualDisplayHeight }); }
      S._real = realSession; S._realViewer = () => realViewerSpace; S._layer = () => layer;
      if (typeof layer.getDisplayInfo === 'function') layer.getDisplayInfo().then(d => { displayInfo = d; L._resize(); QW.seedPreset(cfg.preset, S._info()); S.refreshRig(); }).catch(() => {});
      L._resize();
      S._syncMode();
      input.attach(canvas);
      const onResize = () => { L._resize(); QW.dirty = true; };
      resizeObs = new ResizeObserver(onResize); resizeObs.observe(canvas);
      window.addEventListener('resize', onResize); document.addEventListener('fullscreenchange', onResize);
      S._offResize = () => { window.removeEventListener('resize', onResize); document.removeEventListener('fullscreenchange', onResize); };
      console.info(TAG, 'converted session live on', canvas, 'preset', cfg.preset, 'present', cfg.present, 'qwerty', cfg.qwerty);
    }
    function presentCanvas() {
      // Fullscreen: the converted session owns the canvas geometry (100vw x 100vh) — engines
      // refuse to resize while presenting (three.js setSize early-returns), so a canvas left at
      // its pre-fullscreen CSS size leaves an unrendered band. In place: keep the page's geometry.
      if (cfg.present === 'fullscreen' || canvas.dataset.dxrShimAdopted) {
        for (const k of ['position', 'inset', 'width', 'height', 'zIndex', 'margin']) savedCanvasStyle[k] = canvas.style[k];
        Object.assign(canvas.style, { position: 'fixed', inset: '0', width: '100vw', height: '100vh', zIndex: '2147483000', margin: '0' });
      }
    }
    function unpresentCanvas() { for (const k in savedCanvasStyle) canvas.style[k] = savedCanvasStyle[k]; if (canvas.dataset.dxrShimAdopted) { canvas.remove(); delete canvas.dataset.dxrShimAdopted; } }

    // ---- element geometry for the layer
    S._viewSize = () => { const e = elementDevicePx(); return { w: e.w, h: e.h }; };
    S._planePointFromClient = (cx, cy) => {
      // client px -> plane-space metres
      const e = elementDevicePx(); const r = e.rect; const ph = elementPhysical();
      const u = (cx - r.left) / r.width - 0.5, v = 0.5 - (cy - r.top) / r.height;
      return { x: u * ph.w, y: v * ph.h, z: 0 };
    };
    S._eyeCentroid = eyeCentroid;

    // ---- rendering-mode control (0128), used by V and 1/2/3
    S._modes = async () => (layer && typeof layer.getRenderingModes === 'function') ? layer.getRenderingModes() : [];
    S._syncMode = async () => { try { const modes = await S._modes(); const cur = modes.find(m => m.isActive); oneView = !!(cur && cur.viewCount === 1); hud(); } catch (e) {} };
    S._fireMode = async (modeIndex) => { try { await layer.requestRenderingMode(modeIndex); console.info(TAG, 'rendering mode ->', modeIndex); } catch (e) { console.warn(TAG, 'requestRenderingMode', e.message); } await S._syncMode(); };
    S._requestMode = async (m, modes) => {
      // dxr::ModeSwitch sequencing; currentIpd = the ramp's value if one is in flight, else the steady rig ipd (v1.1.1 rule)
      const cur = modes.find(x => x.isActive) || modes[0];
      const steady = QW.cameraMode ? QW.cam.spread : QW.disp.spread;
      const currentIpd = modeSwitch.active() ? modeSwitch.ipd() : steady;
      const idx = x => x.modeIndex !== undefined ? x.modeIndex : modes.indexOf(x);
      modeSwitch.request(idx(m), m.viewCount, idx(cur), cur.viewCount, currentIpd, steady);
      QW.ipdOverride = currentIpd; QW.dirty = true;
    };
    S._oneView = () => oneView;
    S._flatten = async () => {
      const modes = await S._modes(); if (!modes.length) { console.warn(TAG, 'no rendering-mode control on this browser'); return; }
      const cur = modes.find(m => m.isActive); const want = modes.find(m => m.isRequestable && m.viewCount === (cur && cur.viewCount === 1 ? 2 : 1));
      if (want) await S._requestMode(want, modes);
    };
    S._setMode = async (i) => { const modes = await S._modes(); const m = modes[i]; if (m && m.isRequestable) await S._requestMode(m, modes); else console.info(TAG, 'rendering mode', i, 'not requestable here'); };

    // ---- lifecycle
    S.end = () => {
      touch('end');
      if (ended) return Promise.resolve();
      ended = true; active = null;
      try { if (resizeObs) resizeObs.disconnect(); if (S._offResize) S._offResize(); } catch (e) {}
      try { if (layer) layer.close(); } catch (e) {}
      try { if (glLayer) glLayer._dispose(); } catch (e) {}
      try { input.detach(); } catch (e) {}
      try { if (document.fullscreenElement) document.exitFullscreen(); } catch (e) {}
      if (canvas) unpresentCanvas();
      const p = realSession ? realSession.end().catch(() => {}) : Promise.resolve();
      const ev = new Event('end'); ev.session = proxy; target.dispatchEvent(ev);
      for (const i of inlineSessions) i.flush();
      hud();
      return p;
    };
    S.requestHitTestSource = () => Promise.reject(err('NotSupportedError', 'hit-test is not supported'));
    S.requestHitTestSourceForTransientInput = S.requestHitTestSource;
    S.updateTargetFrameRate = () => Promise.resolve();

    // ---- attributes
    const attrs = {
      mode: () => mode, renderState: () => renderState, inputSources: () => input.sources,
      visibilityState: () => document.visibilityState === 'visible' ? 'visible' : 'hidden',
      environmentBlendMode: () => 'opaque', interactionMode: () => 'world-space',
      enabledFeatures: () => enabledFeatures, isSystemKeyboardSupported: () => false,
      frameRate: () => undefined, supportedFrameRates: () => undefined,
      domOverlayState: () => enabledFeatures.includes('dom-overlay') ? { type: cfg.present === 'fullscreen' ? 'screen' : 'floating' } : null,
      preferredReflectionFormat: () => 'srgba8', depthUsage: () => undefined, depthDataFormat: () => undefined,
      persistentAnchors: () => [],
    };
    for (const [k, g] of Object.entries(attrs)) Object.defineProperty(S, k, { get: g, enumerable: true });
    S.addEventListener = target.addEventListener.bind(target);
    S.removeEventListener = target.removeEventListener.bind(target);
    S.dispatchEvent = target.dispatchEvent.bind(target);
    for (const ev of ['end', 'inputsourceschange', 'select', 'selectstart', 'selectend', 'squeeze', 'squeezestart', 'squeezeend', 'visibilitychange', 'frameratechange']) {
      let h = null;
      Object.defineProperty(S, 'on' + ev, { get: () => h, set: f => { if (h) target.removeEventListener(ev, h); h = typeof f === 'function' ? f : null; if (h) target.addEventListener(ev, h); } });
    }
    document.addEventListener('visibilitychange', () => { if (!ended) target.dispatchEvent(new Event('visibilitychange')); });

    // feature-detect logging proxy
    const proxy = new Proxy(S, {
      get(t, p, r) { if (typeof p === 'string' && !(p in t)) touch(`session.${p} (absent)`); else if (typeof p === 'string' && !p.startsWith('_')) touch(`session.${p}`); return Reflect.get(t, p, r); },
      has(t, p) { if (typeof p === 'string') touch(`'${p}' in session`); return Reflect.has(t, p); },
    });

    // ---- input: the qwerty device's TWO controllers, mirrored, exposed as XRInputSources
    // qwerty_device.c / qwerty_win32.c: WMR-profile controllers parented to the HMD at
    // (-/+0.2, -0.3, -0.5); focus = hold Z (left) / X (right) / both — qwerty uses Ctrl/Alt,
    // which a browser cannot mirror (Ctrl+W closes the tab and pages cannot cancel it);
    // WASDQE / arrows / RMB-look act on the focused controller(s) instead of the HMD; mouse
    // XY translates a focused controller (0.2 x speed per px); LMB trigger, MMB squeeze,
    // T/F/G/H thumbstick, V thumbstick-click (when focused), N menu, C follow-HMD toggle,
    // R reset pose. Unfocused, buttons go to the default (right) controller.
    function makeInput() {
      const mkCtrl = (hand) => {
        const gamepad = { id: 'dxr-qwerty-' + hand, index: -1, connected: true, mapping: 'xr-standard', timestamp: 0,
          buttons: [0, 1, 2, 3, 4].map(() => ({ pressed: false, touched: false, value: 0 })), axes: [0, 0, 0, 0], hapticActuators: [] };
        const src = { handedness: hand, targetRayMode: 'tracked-pointer', targetRaySpace: new ShimSpace('ray:' + hand), gripSpace: new ShimSpace('grip:' + hand),
          profiles: ['microsoft-mixed-reality', 'generic-trigger-squeeze-touchpad-thumbstick'], gamepad, hand: null, skipRendering: false };
        return { hand, src, gamepad, follow: true,
          off: { x: hand === 'left' ? -0.2 : 0.2, y: -0.3, z: -0.5 }, ori: { x: 0, y: 0, z: 0, w: 1 },   // HMD-relative when follow, else plane-space
          speed: 0.01, lookSpeed: 0.05, k: { f: 0, b: 0, l: 0, r: 0, u: 0, d: 0, ll: 0, lr: 0, lu: 0, ld: 0 }, yawDelta: 0, pitchDelta: 0, dx: 0, dy: 0, stick: { x: 0, y: 0 } };
      };
      const C = { left: mkCtrl('left'), right: mkCtrl('right') };
      const sources = [C.left.src, C.right.src]; Object.defineProperty(sources, 'item', { value: i => sources[i] });
      const focus = { z: false, x: false, ctrl: false, alt: false };
      // qwerty: Ctrl = left, Alt = right (both = both). Ctrl/Alt drive the MOUSE + buttons here; keyboard
      // movement of a controller needs Z/X instead, because Ctrl+W closes the tab and pages cannot cancel it.
      const targets = () => { const L = focus.z || focus.ctrl, R = focus.x || focus.alt; return L && R ? [C.left, C.right] : L ? [C.left] : R ? [C.right] : []; };
      const keyTargets = () => focus.z && focus.x ? [C.left, C.right] : focus.z ? [C.left] : focus.x ? [C.right] : [];
      const btnTargets = () => { const t = targets(); return t.length ? t : [C.right]; };                                  // qwerty default_qctrl = right
      let el = null, queue = [], announced = false;
      const btn = (c, i, down) => { const b = c.gamepad.buttons[i]; b.pressed = down; b.touched = down; b.value = down ? 1 : 0; };
      const hmdPose = () => ({ pos: QW.pos, ori: QW.ori });
      const worldPose = (c) => {   // controller pose in plane space
        if (!c.follow) return { pos: c.off, ori: c.ori };
        const h = hmdPose(); const p = qrot(h.ori, c.off);
        return { pos: { x: h.pos.x + p.x, y: h.pos.y + p.y, z: h.pos.z + p.z }, ori: qnorm(qmul(h.ori, c.ori)) };
      };
      const setFollow = (c, follow) => {   // qwerty_follow_hmd: re-express the pose so it does not jump
        if (c.follow === follow) return;
        const w = worldPose(c); const h = hmdPose();
        if (follow) { const inv = { x: -h.ori.x, y: -h.ori.y, z: -h.ori.z, w: h.ori.w }; c.off = qrot(inv, { x: w.pos.x - h.pos.x, y: w.pos.y - h.pos.y, z: w.pos.z - h.pos.z }); c.ori = qnorm(qmul(inv, w.ori)); }
        else { c.off = w.pos; c.ori = w.ori; }
        c.follow = follow;
      };
      const resetCtrl = (c) => { c.off = { x: c.hand === 'left' ? -0.2 : 0.2, y: -0.3, z: -0.5 }; c.ori = { x: 0, y: 0, z: 0, w: 1 }; };
      const integrateCtrl = (c, dtf) => {   // same integration as the HMD (qwerty_device.c), in the controller's own frame
        const k = c.k; const moving = k.f || k.b || k.l || k.r || k.u || k.d || k.ll || k.lr || k.lu || k.ld || c.yawDelta || c.pitchDelta || c.dx || c.dy;
        if (!moving) return;
        const mov = c.speed * (QW.sprint ? Math.pow(1.25, 5) : 1) * dtf;
        let pd = { x: mov * (k.r - k.l), y: 0, z: mov * (k.b - k.f) }; pd = qrot(c.ori, pd); pd.y += mov * (k.u - k.d);
        c.off = { x: c.off.x + pd.x + c.dx, y: c.off.y + pd.y + c.dy, z: c.off.z + pd.z }; c.dx = c.dy = 0;
        const yaw = c.lookSpeed * dtf * (k.ll - k.lr) + c.yawDelta, pitch = c.lookSpeed * dtf * (k.lu - k.ld) + c.pitchDelta; c.yawDelta = c.pitchDelta = 0;
        c.ori = qnorm(qmul(qaxis({ x: 0, y: 1, z: 0 }, yaw), qmul(c.ori, qaxis({ x: 1, y: 0, z: 0 }, pitch))));
      };
      const KEYS = { KeyW: 'f', KeyS: 'b', KeyA: 'l', KeyD: 'r', KeyE: 'u', KeyQ: 'd', ArrowLeft: 'll', ArrowRight: 'lr', ArrowUp: 'lu', ArrowDown: 'ld' };
      const SHIM_HOTKEYS = new Set(['0', '1', '2', '3', '4', '5', '[', ']', ',', '.', ';', "'", 'l', 'L', 'f', 'F', 'h', 'H', 'p', 'P', 'q', 'Q', 'x', 'X']);
      function onKey(e) {
        if (!active) return;
        if (e.ctrlKey && e.altKey && SHIM_HOTKEYS.has(e.key)) return;   // shim hotkeys live on Ctrl+Alt
        const down = e.type === 'keydown'; let handled = true; const T = targets();
        if (e.code === 'KeyZ') focus.z = down;
        else if (e.code === 'KeyX') focus.x = down;
        else if (e.code === 'ControlLeft' || e.code === 'ControlRight') focus.ctrl = down;
        else if (e.code === 'AltLeft' || e.code === 'AltRight') focus.alt = down;
        else if (KEYS[e.code]) { if (e.ctrlKey || e.altKey) { handled = false; } else { const KT = keyTargets(); if (KT.length) KT.forEach(c => { c.k[KEYS[e.code]] = down ? 1 : 0; }); else if (cfg.qwerty) QW.k[KEYS[e.code]] = down ? 1 : 0; } }
        else if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') QW.sprint = down;
        else if (down && (e.code === 'NumpadAdd' || e.code === 'Equal')) { if (T.length) T.forEach(c => { c.speed = clamp(c.speed * 1.25, 1e-5, 1); }); else QW.changeSpeed(1); }
        else if (down && (e.code === 'NumpadSubtract' || e.code === 'Minus')) { if (T.length) T.forEach(c => { c.speed = clamp(c.speed / 1.25, 1e-5, 1); }); else QW.changeSpeed(-1); }
        else if (cfg.qwerty && down && e.code === 'KeyP' && !T.length) { QW.toggle(S._info()); S.refreshRig(); }
        else if (cfg.qwerty && down && e.code === 'Space' && !T.length) { QW.reset(); S.refreshRig(); }
        else if (e.code === 'KeyV') { if (T.length) T.forEach(c => btn(c, 3, down)); else if (down) S._flatten(); }
        else if (down && !T.length && (e.code === 'Digit1' || e.code === 'Digit2' || e.code === 'Digit3')) S._setMode(+e.code.slice(-1) - 1);
        else if (down && e.code === 'Tab') { cfg.hud = !cfg.hud; saveCfg(); }
        else if (e.code === 'KeyT') btnTargets().forEach(c => { c.stick.y = down ? 1 : 0; });
        else if (e.code === 'KeyG') btnTargets().forEach(c => { c.stick.y = down ? -1 : 0; });
        else if (e.code === 'KeyF') btnTargets().forEach(c => { c.stick.x = down ? -1 : 0; });
        else if (e.code === 'KeyH') btnTargets().forEach(c => { c.stick.x = down ? 1 : 0; });
        else if (e.code === 'KeyN') btnTargets().forEach(c => btn(c, 4, down));
        else if (down && e.code === 'KeyC') { const list = T.length ? T : [C.left, C.right]; const bothOff = !C.left.follow && !C.right.follow; list.forEach(c => setFollow(c, T.length ? !c.follow : bothOff)); }
        else if (down && e.code === 'KeyR') (T.length ? T : [C.left, C.right]).forEach(resetCtrl);
        else handled = false;
        if (handled) { e.preventDefault(); e.stopImmediatePropagation(); QW.dirty = true; hud(); }
      }
      function onWheel(e) {
        if (!active) return; const steps = -Math.sign(e.deltaY); if (!steps) return;
        const T = targets();
        if (T.length) T.forEach(c => { c.speed = clamp(c.speed * Math.pow(1.25, steps), 1e-5, 1); });
        else if (cfg.qwerty) { const info = S._info(); if (e.shiftKey) QW.adjustViewFactor(steps > 0 ? 1.1 : 1 / 1.1, info); else if (QW.cameraMode) QW.adjustConvergence(steps, info); else QW.adjustVHeight(steps > 0 ? 1.05 : 1 / 1.05); }
        else return;
        e.preventDefault(); e.stopImmediatePropagation(); hud();
      }
      // The converted session owns the cursor like a hosted app: pointer lock for the whole session
      // (raw, unaccelerated deltas for look and controller translation; cursor hidden). Acquired
      // from the Enter-VR click and re-acquired on any click; Esc releases it (Chrome's rule).
      function lockPointer() {
        if (!el || document.pointerLockElement === el) return;
        const plain = () => { try { const r2 = el.requestPointerLock(); if (r2 && r2.catch) r2.catch(() => {}); } catch (e) {} };
        try { const r = el.requestPointerLock({ unadjustedMovement: true }); if (r && r.catch) r.catch(() => plain()); } catch (e) { plain(); }
      }
      function unlockPointer() { if (document.pointerLockElement === el) document.exitPointerLock(); }
      // Fullscreen: the session owns the cursor (locked throughout). Windowed: lock only for the
      // duration of a right-drag (head look; controller rotate under Ctrl/Alt). Controller translation
      // (Ctrl/Alt + move) keeps the cursor: a lock needs a click, and trigger clicks are momentary.
      const sessionLock = () => !!document.fullscreenElement;
      const onLockChange = () => { if (document.pointerLockElement !== el) { QW.mouseLook = false; focus.ctrl = focus.alt = false; } hud(); };
      const lockEsc = () => { if (navigator.keyboard && navigator.keyboard.lock && document.fullscreenElement) navigator.keyboard.lock(['Escape']).catch(() => {}); };
      const unlockEsc = () => { if (navigator.keyboard && navigator.keyboard.unlock) { try { navigator.keyboard.unlock(); } catch (e) {} } };
      const onFsChange = () => { if (!sessionLock()) { unlockPointer(); unlockEsc(); } else { lockPointer(); lockEsc(); } };
      const onEsc = (e) => { if (!active || e.code !== 'Escape' || e.type !== 'keydown') return; if (document.pointerLockElement === el) { unlockPointer(); e.preventDefault(); e.stopImmediatePropagation(); } };
      const onBlur = () => { QW.k = { f: 0, b: 0, l: 0, r: 0, u: 0, d: 0, ll: 0, lr: 0, lu: 0, ld: 0 }; QW.sprint = false; QW.mouseLook = false; focus.z = focus.x = focus.ctrl = focus.alt = false; [C.left, C.right].forEach(c => { c.k = { f: 0, b: 0, l: 0, r: 0, u: 0, d: 0, ll: 0, lr: 0, lu: 0, ld: 0 }; }); };
      const handlers = {
        pointermove: e => {
          const T = targets();
          if (QW.mouseLook) { const yaw = (-e.movementX * 0.1), pitch = (-e.movementY * 0.1); if (T.length) T.forEach(c => { c.yawDelta += yaw * c.lookSpeed; c.pitchDelta += pitch * c.lookSpeed; }); else if (cfg.qwerty) QW.look(e.movementX, e.movementY); }
          else if (T.length) T.forEach(c => { c.dx += e.movementX * 0.2 * c.speed; c.dy += -e.movementY * 0.2 * c.speed; });   // qwerty: focused controller XY translation
        },
        pointerdown: e => { if (e.button === 0) btnTargets().forEach(c => { btn(c, 0, true); queue.push(['selectstart', c]); }); if (e.button === 2) { QW.mouseLook = true; e.preventDefault(); } if (sessionLock()) lockPointer(); else if (e.button === 2) { el.style.cursor = 'none'; try { el.setPointerCapture(e.pointerId); } catch (e2) {} } /* windowed: hide the cursor for the drag, no lock (no Esc bubble) */ if (e.button === 1) { btnTargets().forEach(c => { btn(c, 1, true); queue.push(['squeezestart', c]); }); e.preventDefault(); } },
        pointerup: e => { if (e.button === 0) btnTargets().forEach(c => { btn(c, 0, false); queue.push(['selectend', c], ['select', c]); }); if (e.button === 2) { QW.mouseLook = false; el.style.cursor = ''; try { el.releasePointerCapture(e.pointerId); } catch (e2) {} } if (!sessionLock() && e.buttons === 0) unlockPointer(); if (e.button === 1) btnTargets().forEach(c => { btn(c, 1, false); queue.push(['squeezeend', c], ['squeeze', c]); }); },
        pointercancel: () => { QW.mouseLook = false; if (el) el.style.cursor = ''; },
        contextmenu: e => e.preventDefault(),
      };
      return {
        sources, controllers: C, focus,
        attach(canvas) {
          el = canvas; if (sessionLock()) lockPointer(); for (const [k, f] of Object.entries(handlers)) el.addEventListener(k, f, { passive: k !== 'contextmenu' && k !== 'pointerdown' });
          window.addEventListener('keydown', onKey, true); window.addEventListener('keyup', onKey, true);
          window.addEventListener('wheel', onWheel, { capture: true, passive: false }); window.addEventListener('blur', onBlur); document.addEventListener('pointerlockchange', onLockChange); document.addEventListener('fullscreenchange', onFsChange); window.addEventListener('keydown', onEsc, true); lockEsc();
        },
        detach() {
          if (!el) return; for (const [k, f] of Object.entries(handlers)) el.removeEventListener(k, f); el = null;
          window.removeEventListener('keydown', onKey, true); window.removeEventListener('keyup', onKey, true);
          window.removeEventListener('wheel', onWheel, true); window.removeEventListener('blur', onBlur); document.removeEventListener('pointerlockchange', onLockChange); document.removeEventListener('fullscreenchange', onFsChange); window.removeEventListener('keydown', onEsc, true); unlockPointer(); unlockEsc();
        },
        beginFrame(frame, dtf) {
          [C.left, C.right].forEach(c => { integrateCtrl(c, dtf); c.gamepad.axes[2] = c.stick.x; c.gamepad.axes[3] = -c.stick.y; c.gamepad.timestamp = performance.now(); });
          if (!announced) { announced = true; const ev = new Event('inputsourceschange'); ev.session = proxy; ev.added = [C.left.src, C.right.src]; ev.removed = []; target.dispatchEvent(ev); }
          const q = queue; queue = [];
          for (const [type, c] of q) { const ev = new Event(type); ev.frame = frame; ev.inputSource = c.src; target.dispatchEvent(ev); }
        },
        endFrame() {},
        pose(kind, base) {
          const c = kind.endsWith('left') ? C.left : C.right; const w = worldPose(c);
          const M = base._fromPlane.multiply(new DOMMatrix().translate(w.pos.x, w.pos.y, w.pos.z).multiply(quatToMatrix(w.ori)));
          return { transform: rigidFromMatrix(M), emulatedPosition: false, linearVelocity: null, angularVelocity: null };
        },
      };
    }

    // ---- start
    S._start = async () => {
      realSession = await realXR.requestSession('inline-3d');
      try { realViewerSpace = await realSession.requestReferenceSpace('viewer'); } catch (e) { console.warn(TAG, 'viewer ref space failed', e); }
      realSession.addEventListener('end', () => { if (!ended) S.end(); });
      realSession.addEventListener('renderingmodechange', () => S._syncMode());
      realSession.addEventListener('hardwaredisplaystatechange', () => S._syncMode());
      try { realSession.updateRenderState({ depthNear: renderState.depthNear, depthFar: renderState.depthFar }); } catch (e) {}
      active = S; S._entryUrl = location.href; hud();
      return proxy;
    };
    S._ctrl = () => input.controllers; S._focus = () => input.focus;
    S._isShimSession = true; S._proxy = proxy;
    return S;
  }

  // ------------------------------------------------------------ XRWebGLLayer
  class ShimXRWebGLLayer {
    constructor(session, ctx, init = {}) {
      const S = session && session._isShimSession ? session : null;
      if (!S) { touch('XRWebGLLayer(native session)'); return new NativeXRWebGLLayer(session, ctx, init); }
      touch('new XRWebGLLayer');
      this._s = S; this.context = ctx; this._isGL2 = (typeof WebGL2RenderingContext !== 'undefined') && ctx instanceof WebGL2RenderingContext;
      this.antialias = init.antialias !== undefined ? !!init.antialias : true;
      this.ignoreDepthValues = false; this.fixedFoveation = null;
      this._depth = init.depth !== undefined ? !!init.depth : true; this._stencil = !!init.stencil;
      this._fsf = clamp(init.framebufferScaleFactor || 1, 0.5, 1);
      this._null = cfg.nullFramebuffer || !this._isGL2;
      this._fbo = null; this._w = 0; this._h = 0;
      if (this._null) console.info(TAG, 'XRWebGLLayer: framebuffer=null mode (app draws the canvas)', this._isGL2 ? '(forced)' : '(WebGL1)');
    }
    get framebuffer() { touch('XRWebGLLayer.framebuffer'); return this._null ? null : this._fbo; }
    get framebufferWidth() { touch('XRWebGLLayer.framebufferWidth'); return this._w; }
    get framebufferHeight() { touch('XRWebGLLayer.framebufferHeight'); return this._h; }
    getViewport(view) {
      touch('XRWebGLLayer.getViewport');
      const half = Math.floor(this._w / 2);
      return { x: view && view._index === 1 ? half : 0, y: 0, width: half, height: this._h };
    }
    static getNativeFramebufferScaleFactor() { touch('XRWebGLLayer.getNativeFramebufferScaleFactor'); return 1.0; }
    _resize() {
      const { w, h } = this._s._viewSize();            // per-eye = element device px
      // The canvas backing store IS the weave input (2x1 SBS). Keep it on the zero-copy
      // path: wide SBS canvases (> ~3072 px) fall off it (browser-pvt#24), so scale down.
      const s = Math.min(this._fsf, cfg.maxSbsWidth / (2 * w), 1);
      const fw = Math.max(2, Math.round(2 * w * s)), fh = Math.max(2, Math.round(h * s));
      const gl = this.context, canvas = gl.canvas;
      if (canvas.width !== fw || canvas.height !== fh) { canvas.width = fw; canvas.height = fh; }
      if (fw === this._w && fh === this._h) return;
      this._w = fw; this._h = fh;
      if (this._null) return;
      this._dispose();
      const prevFb = gl.getParameter(gl.FRAMEBUFFER_BINDING), prevRb = gl.getParameter(gl.RENDERBUFFER_BINDING), prevTex = gl.getParameter(gl.TEXTURE_BINDING_2D);
      const samples = this.antialias ? Math.min(4, gl.getParameter(gl.MAX_SAMPLES)) : 0;
      // resolve target: single-sample texture the quad pass samples from
      this._tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this._tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, fw, fh);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this._resolveFbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, this._resolveFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._tex, 0);
      // the app-facing opaque framebuffer
      this._fbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo);
      if (samples) {
        this._color = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, this._color);
        gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, fw, fh);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, this._color);
      } else {
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._tex, 0);
      }
      if (this._depth || this._stencil) {
        this._ds = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, this._ds);
        const fmt = this._stencil ? gl.DEPTH24_STENCIL8 : gl.DEPTH_COMPONENT24, att = this._stencil ? gl.DEPTH_STENCIL_ATTACHMENT : gl.DEPTH_ATTACHMENT;
        if (samples) gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, fmt, fw, fh); else gl.renderbufferStorage(gl.RENDERBUFFER, fmt, fw, fh);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, att, gl.RENDERBUFFER, this._ds);
      }
      this._samples = samples;
      const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (st !== gl.FRAMEBUFFER_COMPLETE) console.error(TAG, 'opaque framebuffer incomplete', st);
      gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb); gl.bindRenderbuffer(gl.RENDERBUFFER, prevRb); gl.bindTexture(gl.TEXTURE_2D, prevTex);
      if (!this._prog) this._makeQuad();
      console.info(TAG, `opaque framebuffer ${fw}x${fh} (per-eye ${Math.floor(fw / 2)}x${fh}, scale ${s.toFixed(2)}, samples ${samples})`);
    }
    _makeQuad() {
      const gl = this.context;
      const vs = '#version 300 es\nout vec2 uv; void main(){ vec2 p = vec2((gl_VertexID<<1)&2, gl_VertexID&2); uv = p; gl_Position = vec4(p*2.0-1.0, 0.0, 1.0); }';
      const fs = '#version 300 es\nprecision mediump float; in vec2 uv; uniform sampler2D t; out vec4 o; void main(){ o = texture(t, uv); }';
      const mk = (type, src) => { const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh); if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) console.error(TAG, gl.getShaderInfoLog(sh)); return sh; };
      const p = gl.createProgram(); gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) console.error(TAG, gl.getProgramInfoLog(p));
      this._prog = p; this._vao = gl.createVertexArray();
    }
    _endFrame() {
      if (this._null || !this._fbo) return;
      const gl = this.context, canvas = gl.canvas;
      const S = { fbR: gl.getParameter(gl.READ_FRAMEBUFFER_BINDING), fbD: gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING), prog: gl.getParameter(gl.CURRENT_PROGRAM), vao: gl.getParameter(gl.VERTEX_ARRAY_BINDING),
        vp: gl.getParameter(gl.VIEWPORT), scissor: gl.isEnabled(gl.SCISSOR_TEST), depth: gl.isEnabled(gl.DEPTH_TEST), blend: gl.isEnabled(gl.BLEND), cull: gl.isEnabled(gl.CULL_FACE), stencil: gl.isEnabled(gl.STENCIL_TEST),
        active: gl.getParameter(gl.ACTIVE_TEXTURE), cmask: gl.getParameter(gl.COLOR_WRITEMASK) };
      gl.activeTexture(gl.TEXTURE0); S.tex0 = gl.getParameter(gl.TEXTURE_BINDING_2D);
      if (this._samples) { // resolve MSAA -> texture (both are ours, same size: always legal)
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this._fbo); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this._resolveFbo);
        if (S.scissor) gl.disable(gl.SCISSOR_TEST);
        gl.blitFramebuffer(0, 0, this._w, this._h, 0, 0, this._w, this._h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      }
      // textured quad into the default framebuffer (works whether or not it is multisampled)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.disable(gl.SCISSOR_TEST); gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE); gl.disable(gl.STENCIL_TEST); gl.colorMask(true, true, true, true);
      gl.useProgram(this._prog); gl.bindVertexArray(this._vao); gl.bindTexture(gl.TEXTURE_2D, this._tex);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindTexture(gl.TEXTURE_2D, S.tex0); gl.activeTexture(S.active); gl.bindVertexArray(S.vao); gl.useProgram(S.prog);
      gl.viewport(S.vp[0], S.vp[1], S.vp[2], S.vp[3]); gl.colorMask(S.cmask[0], S.cmask[1], S.cmask[2], S.cmask[3]);
      for (const [cap, on] of [[gl.SCISSOR_TEST, S.scissor], [gl.DEPTH_TEST, S.depth], [gl.BLEND, S.blend], [gl.CULL_FACE, S.cull], [gl.STENCIL_TEST, S.stencil]]) on ? gl.enable(cap) : gl.disable(cap);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, S.fbR); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, S.fbD);
    }
    _dispose() { const gl = this.context; for (const k of ['_fbo', '_resolveFbo']) if (this[k]) { gl.deleteFramebuffer(this[k]); this[k] = null; } for (const k of ['_color', '_ds']) if (this[k]) { gl.deleteRenderbuffer(this[k]); this[k] = null; } if (this._tex) { gl.deleteTexture(this._tex); this._tex = null; } }
  }
  window.XRWebGLLayer = ShimXRWebGLLayer;

  // Layers module: explicit NON-support (design §3.2). Engines gate on the GLOBAL, not on
  // renderState.layers — three.js r17x: `'createProjectionLayer' in XRWebGLBinding.prototype`
  // (xrdinosaurs.com, 2026-09-08) — so expose a binding whose prototype lacks it. Native sessions
  // still get the native binding (constructor returns it); a converted session gets a clean error.
  const NativeXRWebGLBinding = window.XRWebGLBinding;
  if (typeof NativeXRWebGLBinding === 'function') {
    class ShimXRWebGLBinding {
      constructor(session, ctx) {
        if (session && session._isShimSession) { touch('new XRWebGLBinding (refused)'); throw err('NotSupportedError', `${TAG} the layers module is not supported for a converted session (v1)`); }
        touch('XRWebGLBinding(native session)'); return new NativeXRWebGLBinding(session, ctx);
      }
    }
    window.XRWebGLBinding = ShimXRWebGLBinding;
  }

  // --------------------------------------------------------------- XRSystem
  const shimXR = new EventTarget();
  shimXR.isSessionSupported = (mode) => {
    touch(`isSessionSupported(${mode})`);
    if (mode === 'immersive-vr') return Promise.resolve(true);
    if (mode === 'immersive-ar') return Promise.resolve(false);
    return realXR.isSessionSupported(mode);
  };
  shimXR.requestSession = (mode, init = {}) => {
    touch(`requestSession(${mode})`);
    if (mode !== 'immersive-vr') {
      if (mode === 'immersive-ar') return Promise.reject(err('NotSupportedError', `${TAG} immersive-ar is not supported`));
      if (mode !== 'inline') return realXR.requestSession(mode, init);
      return realXR.requestSession(mode, init).then(inl => {
        // Park the inline session's frame loop while a converted session owns the canvas; resume after.
        const realRaf = inl.requestAnimationFrame.bind(inl), realCancel = inl.cancelAnimationFrame.bind(inl);
        const parked = new Map(); let seq = 0;
        const raf = (cb) => { if (!active) return realRaf(cb); const id = -(++seq); parked.set(id, cb); return id; };
        const cancel = (id) => { if (id < 0) parked.delete(id); else realCancel(id); };
        inlineSessions.add({ flush() { for (const cb of parked.values()) realRaf(cb); parked.clear(); } });
        return new Proxy(inl, { get(t, k) { if (k === 'requestAnimationFrame') return raf; if (k === 'cancelAnimationFrame') return cancel; const v = Reflect.get(t, k); return typeof v === 'function' ? v.bind(t) : v; }, set(t, k, v) { t[k] = v; return true; } });
      });
    }
    if (active) return Promise.reject(err('InvalidStateError', 'There is already an active, immersive XRSession'));
    let S;
    try { S = makeSession(mode, init); } catch (e) { return Promise.reject(e); }
    if (cfg.present === 'fullscreen' && !document.fullscreenElement) {
      // must ride the activating gesture: request synchronously, before any await
      try { document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(e => console.warn(TAG, 'fullscreen refused', e.message)); } catch (e) {}
    }
    return S._start();
  };
  Object.defineProperty(shimXR, 'ondevicechange', { get: () => realXR.ondevicechange, set: v => { realXR.ondevicechange = v; } });
  shimXR.supportsSession = (mode) => shimXR.isSessionSupported(mode).then(ok => { if (!ok) throw err('NotSupportedError', 'unsupported'); });
  try { Object.defineProperty(navigator, 'xr', { value: shimXR, configurable: true, enumerable: true }); }
  catch (e) { console.error(TAG, 'could not replace navigator.xr', e); return; }

  // --------------------------------------------------------------- hotkeys + HUD
  // Exit VR = leave the experience. Sites have no generic "home", so end the session and
  // reload: the page comes back in its pre-Enter-VR state. soft = end only (site's 2D fallback).
  function exitVR(soft) {
    if (!active) return; const a = active, url = a._entryUrl || location.href;
    setTimeout(() => { a.end().finally(() => { if (!soft) { if (location.href !== url) location.href = url; else location.reload(); } }); }, 0);
  }
  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
  }
  let hudEl = null, hudText = null;
  function hud() {
    if (!cfg.hud || !active) { if (hudEl) hudEl.remove(); hudEl = null; hudText = null; return; }
    if (!document.body) { document.addEventListener('DOMContentLoaded', hud, { once: true }); return; }
    if (!hudEl) {
      hudEl = document.createElement('div'); hudEl.id = 'dxr-immersive-shim-hud';
      Object.assign(hudEl.style, { position: 'fixed', right: '8px', top: '8px', zIndex: '2147483647', font: '12px/1.4 monospace', color: '#fff', background: 'rgba(0,0,0,.6)', padding: '4px 8px', borderRadius: '4px', whiteSpace: 'pre', display: 'flex', gap: '10px', alignItems: 'flex-start', pointerEvents: 'none' });
      hudText = document.createElement('span'); hudEl.appendChild(hudText);
      const mkBtn = (label, title, onClick) => { const b = document.createElement('button'); b.textContent = label; b.title = title; Object.assign(b.style, { pointerEvents: 'auto', cursor: 'pointer', font: '12px monospace', color: '#fff', background: 'rgba(255,255,255,.15)', border: '1px solid rgba(255,255,255,.4)', borderRadius: '3px', padding: '2px 8px' }); b.addEventListener('pointerdown', e => e.stopPropagation()); b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); onClick(); }); return b; };
      const box = document.createElement('span'); Object.assign(box.style, { display: 'flex', gap: '6px' });
      box.appendChild(mkBtn('⛶ F11', 'Toggle fullscreen (F11)', toggleFullscreen));
      box.appendChild(mkBtn('✕ Exit VR', 'Exit VR: end the session and return to the page as it was before Enter VR (Ctrl+Alt+X)', () => exitVR(false)));
      hudEl.appendChild(box); document.body.appendChild(hudEl);
    }
    const q = QW; const f = x => (+x).toFixed(2);
    const rigLine = q.cameraMode
      ? `CAMERA conv=${f(q.cam.conv)}dp vfov=${(2 * Math.atan(q.cam.halfTanVfov) * 180 / Math.PI).toFixed(0)}° ipd=${f(q.cam.spread)} par=${f(q.cam.parallax)}`
      : `DISPLAY vH=${f(q.disp.vH)}m ipd=${f(q.disp.spread)} par=${f(q.disp.parallax)} persp=${f(q.disp.persp)}`;
    const ramp = QW.ipdOverride !== null ? ` ramp ipd=${(+QW.ipdOverride).toFixed(2)}` : '';
    hudText.textContent = `DXR ${active ? '3D' : 'idle'}${active && active._oneView() ? ' [2D]' : ''}${ramp} | ${cfg.preset} | ${rigLine}`;
  }
  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey && e.altKey)) return; let hit = true;
    switch (e.key) {
      case '0': applyPreset('legacy'); break; case '1': applyPreset('portal'); break; case '2': applyPreset('room'); break; case '3': applyPreset('tabletop'); break; case '4': applyPreset('wide'); break; case '5': applyPreset('scene'); break;
      case '[': if (QW.cameraMode) QW.cam.m2v = clamp(QW.cam.m2v / 1.25, 0.05, 20); else QW.disp.vH = clamp(QW.disp.vH / 1.25, 0.1, 10); break;
      case ']': if (QW.cameraMode) QW.cam.m2v = clamp(QW.cam.m2v * 1.25, 0.05, 20); else QW.disp.vH = clamp(QW.disp.vH * 1.25, 0.1, 10); break;
      case ',': if (active) QW.adjustViewFactor(1 / 1.1, active._info()); break; case '.': if (active) QW.adjustViewFactor(1.1, active._info()); break;
      case ';': (QW.cameraMode ? QW.cam : QW.disp).parallax = clamp((QW.cameraMode ? QW.cam : QW.disp).parallax - 0.1, 0, 4); break;
      case "'": (QW.cameraMode ? QW.cam : QW.disp).parallax = clamp((QW.cameraMode ? QW.cam : QW.disp).parallax + 0.1, 0, 4); break;
      case 'l': case 'L': dumpLog(); break;
      case 'f': case 'F': if (active) active._flatten(); break;
      case 'h': case 'H': cfg.hud = !cfg.hud; break;
      case 'p': case 'P': cfg.present = cfg.present === 'fullscreen' ? 'inplace' : 'fullscreen'; break;
      case 'q': case 'Q': cfg.qwerty = !cfg.qwerty; break;
      case 'x': case 'X': exitVR(e.shiftKey); break;
      default: hit = false;
    }
    if (hit) { e.preventDefault(); e.stopImmediatePropagation(); saveCfg(); QW.dirty = true; if (active) active.refreshRig(); hud(); }
  }, true);

  window.__dxrImmersiveShim = {
    get cfg() { return cfg; }, set(k, v) { cfg[k] = v; saveCfg(); QW.dirty = true; if (active) active.refreshRig(); hud(); },
    preset: applyPreset, log: dumpLog, qwerty: QW, get session() { return active ? active._proxy : null; }, version: '0.3.16',
    get real() { return active ? { session: active._real, viewer: active._realViewer(), layer: active._layer() } : null; },
  };
  if (cfg.log && typeof AudioBufferSourceNode !== 'undefined') {   // diagnostic: ambient-audio stops (xrdinosaurs report)
    const P = AudioBufferSourceNode.prototype; const os = P.start, ost = P.stop;
    P.start = function (...a) { console.info(TAG, 'audio start loop=' + this.loop + ' dur=' + (this.buffer ? this.buffer.duration.toFixed(1) : '?') + ' ctx=' + this.context.state, new Error().stack.split(String.fromCharCode(10)).slice(2, 4).join(' | ')); this.addEventListener('ended', () => console.info(TAG, 'audio ENDED loop=' + this.loop + ' ctx=' + this.context.state)); return os.apply(this, a); };
    P.stop = function (...a) { console.info(TAG, 'audio STOP called', new Error().stack.split(String.fromCharCode(10)).slice(2, 4).join(' | ')); return ost.apply(this, a); };
    document.addEventListener('visibilitychange', () => console.info(TAG, 'document visibility', document.visibilityState));
  }
  console.info(TAG, 'armed: immersive-vr will be served in-tab via inline-3d', cfg);
  hud();
})();

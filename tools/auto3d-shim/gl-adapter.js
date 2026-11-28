// DisplayXR auto-3D — the GL-LEVEL adapter (v0.9.0). PROTOTYPE, not a product.
//
// `function dxrGl(core)`, a part of the core bundle (build.mjs). The fallback for a WebGL2 canvas whose
// engine no other adapter recognises (Sketchfab's own engine, a hand-written renderer): it converts by
// BEHAVIOUR at the level of the WebGL calls, never by a site list. It never takes a canvas the three.js,
// PlayCanvas or Babylon.js adapter has (core.claims), and yields at once if one of them claims it later.
//
// HOW A FRAME IS DRAWN TWICE. The page keeps drawing its own frame, mono, into its own render targets;
// the adapter wraps the context's methods (own properties of that one context, never a prototype) and
// re-issues the draws that depend on the camera, once per eye:
//   - a CHAIN target is a framebuffer the page draws its picture into: one whose size has the page's
//     aspect and is at least half its size, drawn with the CAMERA (a seed), or any target drawn by a draw
//     that samples a chain texture (bloom mips, TAA history, a resolve), learned as the page draws;
//   - each chain target gets a TWIN (same size, same formats, its attachments twinned), so each eye has a
//     whole pipeline at the page's own resolution: post-processing (SSAO, TAA, bloom, DOF) runs per eye
//     and stays correct, with no seam;
//   - a draw into a chain target runs twice: eye 0 into the page's target, eye 1 into the twin with every
//     chain texture it samples swapped for its twin; a draw to the SCREEN runs once per eye into that eye's
//     own offscreen screen (the page's size, its viewport untouched: gl_FragCoord reads as in 2D), and the
//     two are composed into the halves of the 2:1 side-by-side store (core.realSizeFor) at the frame's end;
//   - everything else (shadow maps, environment / PMREM passes, picking, any target not shaped like the
//     screen that samples no chain texture) is drawn ONCE, as the page drew it.
// THE CAMERA MATRIX is recognised by value (cameraOf): a mat4 uniform in the vertex shader that projects
// (a pure perspective P, or a VP / MVP) and whose x : y focal ratio is the target's aspect (so a square
// spot-light shadow projection is not the camera). Per eye it becomes P_eye · inv(E_eye) [· inv(P) · C]:
// E_eye is the core's located eye in the page camera's space (core.eyePose), and P_eye is the page's own P
// with the runtime's per-eye shears added (rows 2 and 3, the depth convention, are never touched: reversed
// or logarithmic depth keeps working). A VP / MVP with no P in the frame gets the clip-space form of the
// same correction (eyeClipFallback).
//
// EXTENSION POINTS (what a GL-level adapter for another renderer changes, e.g. a map engine):
//   GLX.cameraOf(st, pi, target)       which uniform values are the camera (default: by value, above)
//   GLX.isSeedTarget(st, fi)           which framebuffers hold the picture (default: screen-shaped)
//   GLX.isInfinite(pi)                 draws at infinity (skyboxes: gl_Position.xyww): shear only, no eye shift
//   GLX.single(st, pi, target)         a draw that must stay single even on a chain target (default: none)
//   GLX.target(st)                     the convergence target (default: the orbit pivot read from the
//                                      camera's own motion, orbitTick)
// They are plain functions on one object so another engine's file can replace one without forking this.
//
// THE CORE'S MACHINERY, unchanged: one session per document, the go-live cover and the layer after the
// commit, the 2:1 store, wovenState, the rig (camera rig: the display rig's strict object test needs a
// surface, which the WebGL stream does not give, so objectVerdict says 'this engine gives no surface to
// read' and the rig stays the camera's), the convergence tiers (the orbit pivot as the page's target,
// else the estimator over the draws' origins), the depth fade, the out-cover, the guard.
//
// REDRAW EVERY FRAME: the default framebuffer is copied (blit) at the end of every page frame; a session
// frame the page drew nothing for replays that copy (a viewer that stops drawing once its accumulation
// settles). The copy is also the go-live cover's source on flipIdle, the mono frame at turn-off and the
// out-cover's pixels.
//
// PAGE-VISIBLE: the sentinel's own-property wrappers on the context (sentinel.js GL_HOOKS, from its creation;
// this adapter only attaches handlers to them), drawingBufferWidth / drawingBufferHeight own accessors while
// live (they report the page's mono size), the core's
// canvas width / height virtualisation while live, and the store's real size (2:1). Nothing in the DOM
// beyond what the core adds for every engine (the cover, the chip, data-dxr-auto3d).
function dxrGl(core) {
  const { info, warnOnce, now, realW, realH, CANVAS_W, CANVAS_H } = core;
  const ENGINE = 'WebGL';
  const GL2 = typeof WebGL2RenderingContext === 'function' ? WebGL2RenderingContext.prototype : null;
  const apply = Reflect.apply;

  // ------------------------------------------------------------ GL constants (numbers: no prototype reads)
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

  // ------------------------------------------------------------ small maths (column-major)
  const IDENT = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  function mul4(a, b, o) {
    o = o || new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    return o;
  }
  const near = (a, b, e = 1e-4) => Math.abs(a - b) <= e * Math.max(1, Math.abs(a), Math.abs(b));
  // 'P' (a perspective projection: row 3 = [0 0 ±1 0], no x/y cross terms), 'clip' (a VP / MVP: row 3
  // parallel to row 2's direction), 'rigid' / 'affine' (row 3 = [0 0 0 1]), or null.
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
  // A perspective P's near / far (GL convention; reversed / infinite: far = near x 1e4) and vertical FOV.
  function frustumOf(P) {
    let n = P[14] / (P[10] - 1), f = P[14] / (P[10] + 1);
    if (!(n > 0)) n = Math.abs(P[14] / (P[10] + 1)) || 0.1;
    if (!(f > n) || !isFinite(f)) f = n * 1e4;
    return { near: n, far: f, fov: 2 * Math.atan(1 / Math.abs(P[5] || 1)), tan: 1 / Math.abs(P[5] || 1), aspect: Math.abs(P[5] / (P[0] || 1)) };
  }
  // The clip-space form of the eye correction, for a VP / MVP with no P to factor out: the eye's shift t
  // (page camera space) and the runtime's extra shear (sx, sy) applied to the rows, x and y focal read
  // off the matrix (|row.xyz| / |row3.xyz|). Depth (row 2) is left as the page made it.
  function eyeClipFallback(C, t, sx, sy, o) {
    o.set(C);
    const n3 = Math.hypot(C[3], C[7], C[11]) || 1;
    const a = Math.hypot(C[0], C[4], C[8]) / n3, b = Math.hypot(C[1], C[5], C[9]) / n3;
    for (let k = 0; k < 4; k++) { o[k * 4] -= sx * C[k * 4 + 3]; o[k * 4 + 1] -= sy * C[k * 4 + 3]; }
    o[12] -= a * t[0] * C[15] + sx * t[2] * C[15]; o[13] -= b * t[1] * C[15] + sy * t[2] * C[15];
    o[15] += t[2] * C[15];
    return o;
  }

  // ------------------------------------------------------------ extension points
  const GLX = {
    // The camera matrices of a draw: [[loc, value, kind], ...] among the program's projecting mat4s in the
    // vertex shader whose y : x focal ratio is the target's aspect (2 %; 5 % for a VP / MVP).
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

  // ------------------------------------------------------------ entry point (the sentinel's GL signal)
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
  // Another adapter claimed this canvas (core.newState): back off for good.
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

  // ------------------------------------------------------------ per-context state
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

  // Program facts, lazily: the vertex shader's mat4 names, the sampler uniforms and their units, the
  // projecting mat4 values the page has uploaded (by location), the affine ones (for the orbit pivot and
  // the estimator's origins).
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

  // Framebuffer facts (with it bound to DRAW_FRAMEBUFFER): size and attachments, cached until the page
  // re-attaches something.
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
  // Does this draw sample a chain texture? (the program's sampler uniforms' units, TEXTURE_2D bindings)
  function samplesChain(st, pi) {
    const g = st.g;
    for (const u of pi.units.values()) { const t = g.units[u]; if (t && g.chainTex.has(t)) return true; }
    return false;
  }

  // ------------------------------------------------------------ twins (live only)
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
    // the page's sampling state, read from its texture
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
  // The twin of a chain framebuffer (attachments twinned, the page's draw buffers), or null when one of
  // its attachments cannot be twinned (a texture specified in a way the recorder did not see): that
  // target is then drawn once, and the right eye reads the left eye's picture there (logged once).
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
    // WeakMaps cannot be walked: the twins made are kept in a list for this.
    for (const o of st.made || []) { try { if (o instanceof WebGLTexture) gl.deleteTexture(o); else if (o instanceof WebGLRenderbuffer) gl.deleteRenderbuffer(o); else gl.deleteFramebuffer(o); } catch (e) { /* ignore */ } }
    st.made = [];
    g.twins = new WeakMap(); g.twinFbos = new WeakMap(); g.noTwin = new WeakSet();
  }

  // ------------------------------------------------------------ the per-eye camera matrices
  // Eye i's matrix for a camera uniform value m of kind 'P' or 'clip'. Before the views (or flat under
  // the cover), the page's own value.
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
    // P_eye: the page's P, the runtime's shears added, its focal scaled by k; rows 2 / 3 untouched.
    tmpA.set(P); tmpA[0] *= k; tmpA[5] *= k; tmpA[8] += V[8]; tmpA[9] += V[9];
    if (GLX.isInfinite(pi)) { // at infinity: the shear only (no eye shift reaches a skybox)
      if (e.kind === 'P') { o.set(tmpA); return o; }
    }
    const inv = invRigid(E, tmpB); // inv(E): a rigid eye pose
    mul4(tmpA, inv, o);
    if (e.kind === 'P') return o;
    // VP / MVP with the frame's P: P_eye · inv(E) · inv(P) · C
    const iP = st.g.Pinv || (st.g.Pinv = core.invert4(P));
    mul4(o, iP, tmpA); mul4(tmpA, m, o);
    return o;
  }
  function invRigid(E, o) {
    // transpose the rotation, t' = -R^T t
    o[0] = E[0]; o[1] = E[4]; o[2] = E[8]; o[3] = 0;
    o[4] = E[1]; o[5] = E[5]; o[6] = E[9]; o[7] = 0;
    o[8] = E[2]; o[9] = E[6]; o[10] = E[10]; o[11] = 0;
    o[12] = -(E[0] * E[12] + E[1] * E[13] + E[2] * E[14]);
    o[13] = -(E[4] * E[12] + E[5] * E[13] + E[6] * E[14]);
    o[14] = -(E[8] * E[12] + E[9] * E[13] + E[10] * E[14]);
    o[15] = 1;
    return o;
  }

  // ------------------------------------------------------------ the hooks
  // Attached to the sentinel's wrappers (rec.slot, installed on the context when it was created, so calls
  // through method references the engine cached are seen too); `o` is the page's call as it would run
  // without us (rec.base). st.g.internal > 0: our own calls, passed straight through.
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
  // The page re-attached something to the bound framebuffer: its facts are read again; a twin is rebuilt.
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

  // ------------------------------------------------------------ frames
  function noteScreen(st) {
    const g = st.g;
    g.pres = true;
    if (!g.queued) { g.queued = true; queueMicrotask(() => { g.queued = false; frameEnd(st); }); }
  }
  // The end of a page frame (the microtask after a draw to the screen): still the drawing task, so the
  // default framebuffer is readable (the go-live cover, the out-cover, the copy).
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

  // ------------------------------------------------------------ the draw
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
    // The camera: by value, for this target's aspect (the page's believed screen for the default framebuffer).
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
    // ---- doubled: eye 0 then eye 1
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
    // a chain texture sampled before its twin exists: make it (its framebuffer is twinned on its next draw)
    for (const u of pi.units.values()) { const t = g.units[u]; if (t && g.chainTex.has(t) && !g.twins.get(t)) { const fb = g.texFbo.get(t); if (fb && twinFbo(st, fb) && !out.includes(u)) out.push(u); } }
    return out;
  }
  // Clears: a chain target's twin is cleared too; a scissored clear of the screen is mapped per eye.
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
  // Blits: chain -> chain (a resolve) is repeated twin -> twin, and its destination joins the chain;
  // chain -> screen is drawn per eye into each half.
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
        // to the screen: into each eye's screen, as the page asked (the halves are composed at the frame's end)
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

  // ------------------------------------------------------------ the eyes' screens
  // While live, what the page draws to the screen goes to one offscreen 'screen' per eye, at the size the
  // page believes its drawing buffer has, with its own viewport and scissor untouched: a pass that reads
  // gl_FragCoord (a resolution uniform, a dither, a TAA resolve) sees exactly the coordinates it would in
  // 2D. The two are composed into the halves of the 2:1 store at the frame's end (composeScreens).
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

  // ------------------------------------------------------------ the copy of the screen (replay, covers)
  // which: 'mono' (the page's last mono frame, before the flip) or 'copy' (the last side-by-side frame).
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
  // Draws a copy onto the screen: src rect (in the copy) -> dst rect (in the store). Blit when the
  // default framebuffer is single-sampled, else a textured full-screen triangle.
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
  // The textured-triangle repaint for a multisampled screen (blit cannot write one): every piece of
  // state it touches is read first and put back.
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
  // The real drawing-buffer size (the prototype getters: our virtualised own accessors are bypassed).
  const DBW = GL2 && Object.getOwnPropertyDescriptor(GL2, 'drawingBufferWidth');
  const DBH = GL2 && Object.getOwnPropertyDescriptor(GL2, 'drawingBufferHeight');
  const GL2_DBW = (gl) => (DBW ? DBW.get.call(gl) : gl.drawingBufferWidth);
  const GL2_DBH = (gl) => (DBH ? DBH.get.call(gl) : gl.drawingBufferHeight);
  // While live the page reads its mono store from drawingBufferWidth / Height (it sizes its passes from it).
  function virtualizeBuffer(st) {
    const gl = st.gl, g = st.g;
    const def = (k, D) => { try { Object.defineProperty(gl, k, { configurable: true, enumerable: false, get() { return g.internal > 0 || st.depth > 0 || !st.active ? D.get.call(this) : Math.floor(k === 'drawingBufferWidth' ? st.L.w : st.L.h); } }); } catch (e) { /* ignore */ } };
    if (DBW) def('drawingBufferWidth', DBW);
    if (DBH) def('drawingBufferHeight', DBH);
  }
  function unvirtualizeBuffer(st) { try { delete st.gl.drawingBufferWidth; delete st.gl.drawingBufferHeight; } catch (e) { /* ignore */ } }

  // ------------------------------------------------------------ convergence: origins and the orbit pivot
  // The estimator's points: each camera draw's model origin in camera space (a P with a rigid model-view
  // in the vertex shader: its translation, the farthest of them as the spike did; an MVP: its clip w).
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
  // Per page frame: the camera's motion between frames, read from the rigid model-view / view matrices
  // the camera draws upload (any static object's MV moves exactly as the view: MV_t · inv(MV_t-1) = Δ).
  // An orbit turns about the point of the view axis that Δ leaves in place: that is the page's target.
  // Between turns it is carried by Δ (a dolly brings it nearer); a pan takes it off the axis, where the
  // core stops using it until the next turn re-reads it.
  function orbitTick(st) {
    const g = st.g;
    const cur = new Map();
    // the frame's rigid matrices, by program + location (only the ones the camera draws used)
    for (const [k, m] of g.aff) cur.set(k, m);
    g.aff = new Map();
    const prev = g.affPrev;
    g.affPrev = cur;
    if (!cur.size) { g.ow = 'no rigid matrices'; return; }
    // this frame's motion (carries the target), and the motion since the reference frame (reads a turn:
    // a slow turntable turns too little per frame for float32 matrices to place its pivot)
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
  // The camera motion between two frames' sets of rigid matrices: the one most of them agree on, identity
  // excluded (a static model matrix reads as no motion), or null.
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
  // inverse of a rigid x uniform-scale matrix
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
  // The rigid matrices a camera draw used, kept per frame for orbitTick (keyed by program + location).
  function noteAff(st, pi) {
    const g = st.g;
    if (g.aff.size >= 24) return;
    for (const [loc, e] of pi.aff) { const k = pi.id + ':' + (st.rec.loc.get(loc) || '?'); if (!g.aff.has(k)) g.aff.set(k, Float32Array.from(e.m)); }
  }

  // ------------------------------------------------------------ the adapter hooks the core calls
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
    // The page's near / far from its P, near loosened 4x: a viewer that fits its clip planes tightly round the
    // model (Sketchfab: near ~ 0.9 x the distance to the model's front) would otherwise put its own orbit target
    // inside the core's 2 x near guard and pin the convergence there. Only the core's clamps read it: the eye
    // matrices keep the page's own depth rows.
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
      // the mono frame just copied, into both halves: the flat pair under the cover
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
          // the left eye of the last pair (flat by now: the depth faded out first), as the mono frame
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
  // The 2:1 store (core.realSizeFor), the page keeping its mono view of it.
  function applyRealSize(st) {
    const R = core.realSizeFor(st);
    st.R = R;
    if (realW(st.canvas) === R.W && realH(st.canvas) === R.H) return false;
    st.stats.resizes++;
    st.depth++;
    try { CANVAS_W.set.call(st.canvas, R.W); CANVAS_H.set.call(st.canvas, R.H); } finally { st.depth--; }
    return true;
  }
  // A resize while live cleared the store: the last pair, rescaled, until the page's next frame.
  function repaint(st) {
    const c = st.g.copy, R = st.R;
    if (c && R) paint(st, c, 0, 0, c.w, c.h, 0, 0, R.W, R.H);
  }

  // DEV ONLY: the last side-by-side frame as drawn (the copy), as a PNG data URL, for the live probes
  // (test/gl-level/probe-skf.mjs): a page that keeps preserveDrawingBuffer false reads back empty between frames.
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

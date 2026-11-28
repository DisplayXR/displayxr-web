// DisplayXR auto-3D — the GENERIC WebGL tap (v0.8.3). PROTOTYPE, not a product.
//
// `function dxrGlTap(core)`, a part of the core bundle (build.mjs). Engine-agnostic: it knows WebGL,
// not any site or renderer. It returns `tap(gl, hooks)`, which wraps ONE context (own, non-enumerable
// properties on that context object: nothing on any prototype, nothing on any other context) and
//
//   OBSERVES, per page frame (the draws of one task: the frame ends at the microtask checkpoint after
//   the first draw, i.e. right after the page's rAF callback, with the drawing buffer still intact):
//   how many draws hit the screen (the default framebuffer, or a framebuffer whose colour attachment is
//   the drawing buffer's size), how many of them carry a CLIP matrix (a mat4 uniform that produces clip
//   coordinates: perspective P, VP or MVP; affine / orthographic matrices do not count), and, for each
//   such draw, the clip position of its model origin (column 3 of that matrix: u = x·w-ish, v, w). The
//   frame summary goes to hooks.frame(F) in that microtask.
//
//   DRAWS SIDE BY SIDE while tap.stereo = { k: [kL, kR], C } is set: every screen draw is issued once
//   per eye, into the left / right half of the target (viewport halved, scissored to the half):
//     - a draw with clip matrices: each clip matrix M of the program is replaced for that eye by
//         M' = M + k · (row3 − C · e_w)  (added to row 0 only; e_w = (0, 0, 0, 1) in M's input space)
//       i.e. clip x' = clip x + k · (w − C): content at view depth C keeps its place, content at depth z
//       moves k · (1 − C / z) in NDC (→ k at infinity). That is exactly an off-axis eye: an eye shifted
//       along the camera's x axis by e with its frustum sheared to converge at C, where k = P00 · e / C.
//       Only row 0 changes, so the depth convention (reversed-Z, log depth, clip control) and the
//       engine's own jitter terms are untouched, and the frustum is complete in each half (the shear
//       is in the matrix, not a viewport shift: nothing uncovered at the inner edges, no seam);
//     - a draw with NO clip matrix (screen-space text, icons, full-screen passes): drawn into both
//       halves unchanged, i.e. at the glass in both eyes — unless it samples a texture this tap filled
//       side by side (a screen-sized framebuffer drawn in stereo: TAINTED), which is copied once,
//       through, with the page's own viewport (its halves are already the eyes);
//     - draws into other framebuffers (shadow maps, glyph atlases, picking targets) are left alone.
//   A scissored clear of the screen is issued once per half. Every piece of state the page can read
//   back (program uniforms, viewport, scissor box, scissor enable) is restored after each draw.
//
// Not handled (counted in F.skipped, drawn once as the page issued them): WEBGL_multi_draw draws and
// clip matrices delivered through uniform buffers / vec4 arrays. A program whose clip matrix was
// uploaded before the tap was installed is not known to have one until the page uploads it again.
//
// tap(gl, hooks) -> { stereo, frames, uninstall(), stats() }
//   hooks.frame(F)   per page frame, in the drawing task: F = { draws, screen, clip, flat, through,
//                    skipped, offscreen, tiles: [[u, v, w], …] (≤ 4096), p11: [...] , stereo: bool }
function dxrGlTap(core) {
  const near1 = (a, b, e) => Math.abs(a - b) <= e * Math.max(1, Math.abs(a), Math.abs(b));
  // column-major m[c*4 + r]; row r = (m[r], m[4 + r], m[8 + r], m[12 + r])
  function isClip(m, o) {
    const r30 = m[o + 3], r31 = m[o + 7], r32 = m[o + 11], r33 = m[o + 15];
    if (Math.abs(r30) < 1e-9 && Math.abs(r31) < 1e-9 && Math.abs(r32) < 1e-9 && near1(r33, 1, 1e-6)) return false; // affine
    const n3 = Math.hypot(r30, r31, r32);
    if (n3 < 1e-12) return false;
    // rows 2 and 3 (xyz) parallel, or row 2 (xyz) zero (an infinite / reversed far plane): a projection of view depth
    const a = m[o + 2], b = m[o + 6], c = m[o + 10], n2 = Math.hypot(a, b, c);
    const cross = Math.hypot(b * r32 - c * r31, c * r30 - a * r32, a * r31 - b * r30);
    return n2 < 1e-9 * n3 || cross < 1e-3 * n2 * n3;
  }
  const DRAWS = ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements'];

  return function tap(gl, hooks) {
    const G = gl;
    const O = {}; // originals, bound to the prototype functions
    const own = []; // own props we defined (uninstall deletes them)
    const FB = G.FRAMEBUFFER, DRAW_FB = 0x8CA9, COLOR0 = G.COLOR_ATTACHMENT0, SCISSOR = G.SCISSOR_TEST, TEX2D = G.TEXTURE_2D;
    const s = { prog: null, fbo: null, vp: [0, 0, G.drawingBufferWidth, G.drawingBufferHeight], sc: [0, 0, G.drawingBufferWidth, G.drawingBufferHeight], scOn: false, unit: 0, units: [], rb: null };
    try {
      s.prog = G.getParameter(G.CURRENT_PROGRAM);
      s.fbo = G.getParameter(G.FRAMEBUFFER_BINDING);
      const v = G.getParameter(G.VIEWPORT); if (v) s.vp = [v[0], v[1], v[2], v[3]];
      const b = G.getParameter(G.SCISSOR_BOX); if (b) s.sc = [b[0], b[1], b[2], b[3]];
      s.scOn = G.isEnabled(SCISSOR);
      s.unit = G.getParameter(G.ACTIVE_TEXTURE) - G.TEXTURE0;
      s.units[s.unit] = G.getParameter(G.TEXTURE_BINDING_2D);
    } catch (e) { /* a lost context: defaults */ }
    const texSize = new WeakMap(), rbSize = new WeakMap(), fboSize = new WeakMap(), fboColor = new WeakMap();
    // program -> Map(key -> { loc, m: Float32Array(16) }), clip matrices only. key = the uniform's NAME when the
    // tap saw the location handed out (a page may ask for a location again every frame: a new object for the
    // same uniform), else the location object itself (handed out before the tap was installed).
    const progU = new WeakMap();
    const locName = new WeakMap();
    let taint = new WeakSet(); // textures this tap filled side by side (cleared when stereo ends: clearTaint)
    const T = {
      stereo: null, frames: 0, F: null, sampleVerts: true,
      uninstall() { for (const k of own) { try { delete G[k]; } catch (e) { /* ignore */ } } own.length = 0; T.stereo = null; },
    };
    // Every wrapper records its call while recording is on (T.record), for replay() (below).
    const def = (name, fn) => {
      const orig = G[name];
      if (typeof orig !== 'function') return;
      O[name] = orig;
      const rec = !NO_REPLAY.test(name);
      const w = function () { if (recOn && rec && !replaying) record(G, name, arguments); return fn.apply(this, arguments); };
      try { Object.defineProperty(G, name, { configurable: true, writable: true, enumerable: false, value: w }); own.push(name); } catch (e) { /* frozen */ }
    };
    const call = (name, ...a) => O[name].apply(G, a);

    // ---- recording and replay
    // REPLAY: a frame the page did not draw (the flip on a page that is idle, the first stereo frame, a
    // fade step, the mono frame of a turn-off, an eye pair that moved) is made by replaying the page's
    // last screen frame: every call it made on this context in that task, in order, through the same
    // wrappers (so the replay is side by side when stereo is on), arguments copied at record time.
    // Never replayed: object creation / deletion, queries, shader compilation, texture uploads (the
    // texture keeps its last contents) and buffer uploads over REPLAY_MAX_UPLOAD bytes (likewise). Around a replay the context state the page could have changed since that
    // frame (bindings, enables, blend / depth / stencil / mask state, viewport, scissor) is saved and
    // put back, so the page's own state caches stay true.
    const NO_REPLAY = /^(create|delete|get|is[A-Z]|check|read|validate|compile|link|attach|detach|shaderSource|bindAttribLocation|finish|makeXRCompatible|tex(Image|SubImage|Storage)|compressedTex|copyTex|generateMipmap|pixelStorei|transformFeedbackVaryings|uniformBlockBinding|fenceSync|clientWaitSync|waitSync|beginQuery|endQuery|drawingBuffer|getExtension)/;
    const REPLAY_MAX_UPLOAD = 512 * 1024;
    let recOn = false, replaying = false, cur = [], last = null, curBig = false;
    const copyArg = (a) => {
      if (a && typeof a === 'object') {
        if (ArrayBuffer.isView(a)) return a instanceof DataView ? new DataView(a.buffer.slice(a.byteOffset, a.byteOffset + a.byteLength)) : a.slice();
        if (a instanceof ArrayBuffer) return a.slice(0);
        if (Array.isArray(a)) return a.slice();
      }
      return a;
    };
    function record(target, name, args) {
      if (cur.length > 60000) return;
      // a big upload is not recorded (the buffer keeps its contents: a replay reuses them); the frame still is
      if ((name === 'bufferData' || name === 'bufferSubData') && args[1] && typeof args[1] === 'object' && (args[1].byteLength || 0) > REPLAY_MAX_UPLOAD) return;
      const a = new Array(args.length);
      for (let i = 0; i < args.length; i++) a[i] = copyArg(args[i]);
      cur.push(target, name, a);
    }
    const SAVE_ENABLES = ['BLEND', 'DEPTH_TEST', 'CULL_FACE', 'SCISSOR_TEST', 'STENCIL_TEST', 'POLYGON_OFFSET_FILL', 'SAMPLE_ALPHA_TO_COVERAGE', 'DITHER', 'RASTERIZER_DISCARD'].filter((k) => G[k] !== undefined);
    const SAVE_PARAMS = ['CURRENT_PROGRAM', 'ARRAY_BUFFER_BINDING', 'FRAMEBUFFER_BINDING', 'READ_FRAMEBUFFER_BINDING', 'RENDERBUFFER_BINDING', 'ACTIVE_TEXTURE', 'VIEWPORT', 'SCISSOR_BOX',
      'BLEND_SRC_RGB', 'BLEND_DST_RGB', 'BLEND_SRC_ALPHA', 'BLEND_DST_ALPHA', 'BLEND_EQUATION_RGB', 'BLEND_EQUATION_ALPHA', 'BLEND_COLOR', 'DEPTH_FUNC', 'DEPTH_WRITEMASK', 'COLOR_WRITEMASK',
      'CULL_FACE_MODE', 'FRONT_FACE', 'STENCIL_FUNC', 'STENCIL_REF', 'STENCIL_VALUE_MASK', 'STENCIL_FAIL', 'STENCIL_PASS_DEPTH_FAIL', 'STENCIL_PASS_DEPTH_PASS', 'STENCIL_WRITEMASK',
      'STENCIL_BACK_FUNC', 'STENCIL_BACK_REF', 'STENCIL_BACK_VALUE_MASK', 'STENCIL_BACK_FAIL', 'STENCIL_BACK_PASS_DEPTH_FAIL', 'STENCIL_BACK_PASS_DEPTH_PASS', 'STENCIL_BACK_WRITEMASK',
      'COLOR_CLEAR_VALUE', 'DEPTH_CLEAR_VALUE', 'STENCIL_CLEAR_VALUE', 'POLYGON_OFFSET_FACTOR', 'POLYGON_OFFSET_UNITS', 'LINE_WIDTH', 'DEPTH_RANGE', 'VERTEX_ARRAY_BINDING', 'UNIFORM_BUFFER_BINDING'].filter((k) => G[k] !== undefined);
    function saveState() {
      const P = (k) => { try { return G.getParameter(G[k]); } catch (e) { return undefined; } };
      const o = { en: SAVE_ENABLES.map((k) => G.isEnabled(G[k])) };
      for (const k of SAVE_PARAMS) o[k] = P(k);
      if (vaoExt) { try { o.vaoOES = G.getParameter(vaoExt.VERTEX_ARRAY_BINDING_OES); } catch (e) { /* ignore */ } }
      o.tex = [];
      const n = Math.min(32, Math.max(s.units.length, 1));
      for (let u = 0; u < n; u++) { call('activeTexture', G.TEXTURE0 + u); o.tex.push([P('TEXTURE_BINDING_2D'), P('TEXTURE_BINDING_CUBE_MAP'), G.TEXTURE_BINDING_3D !== undefined ? P('TEXTURE_BINDING_3D') : null, G.TEXTURE_BINDING_2D_ARRAY !== undefined ? P('TEXTURE_BINDING_2D_ARRAY') : null]); }
      call('activeTexture', o.ACTIVE_TEXTURE);
      return o;
    }
    function restoreState(o) {
      const g = G, C = (n, ...a) => { try { (O[n] || g[n]).apply(g, a); } catch (e) { /* ignore */ } };
      SAVE_ENABLES.forEach((k, i) => C(o.en[i] ? 'enable' : 'disable', g[k]));
      for (let u = 0; u < o.tex.length; u++) {
        C('activeTexture', g.TEXTURE0 + u);
        const t = o.tex[u];
        C('bindTexture', g.TEXTURE_2D, t[0]); C('bindTexture', g.TEXTURE_CUBE_MAP, t[1]);
        if (g.TEXTURE_3D !== undefined) { C('bindTexture', g.TEXTURE_3D, t[2]); C('bindTexture', g.TEXTURE_2D_ARRAY, t[3]); }
      }
      C('activeTexture', o.ACTIVE_TEXTURE);
      if (o.VERTEX_ARRAY_BINDING !== undefined) C('bindVertexArray', o.VERTEX_ARRAY_BINDING);
      if (vaoExt && o.vaoOES !== undefined) { try { vaoExt.__dxrOrig.bindVertexArrayOES.call(vaoExt, o.vaoOES); } catch (e) { /* ignore */ } }
      C('useProgram', o.CURRENT_PROGRAM);
      C('bindBuffer', g.ARRAY_BUFFER, o.ARRAY_BUFFER_BINDING);
      if (o.UNIFORM_BUFFER_BINDING !== undefined) C('bindBuffer', g.UNIFORM_BUFFER, o.UNIFORM_BUFFER_BINDING);
      if (o.READ_FRAMEBUFFER_BINDING !== undefined) { C('bindFramebuffer', 0x8CA8, o.READ_FRAMEBUFFER_BINDING); C('bindFramebuffer', 0x8CA9, o.FRAMEBUFFER_BINDING); }
      else C('bindFramebuffer', g.FRAMEBUFFER, o.FRAMEBUFFER_BINDING);
      C('bindRenderbuffer', g.RENDERBUFFER, o.RENDERBUFFER_BINDING);
      const v = o.VIEWPORT, b = o.SCISSOR_BOX;
      if (v) C('viewport', v[0], v[1], v[2], v[3]);
      if (b) C('scissor', b[0], b[1], b[2], b[3]);
      C('blendFuncSeparate', o.BLEND_SRC_RGB, o.BLEND_DST_RGB, o.BLEND_SRC_ALPHA, o.BLEND_DST_ALPHA);
      C('blendEquationSeparate', o.BLEND_EQUATION_RGB, o.BLEND_EQUATION_ALPHA);
      if (o.BLEND_COLOR) C('blendColor', o.BLEND_COLOR[0], o.BLEND_COLOR[1], o.BLEND_COLOR[2], o.BLEND_COLOR[3]);
      C('depthFunc', o.DEPTH_FUNC); C('depthMask', o.DEPTH_WRITEMASK);
      if (o.COLOR_WRITEMASK) C('colorMask', o.COLOR_WRITEMASK[0], o.COLOR_WRITEMASK[1], o.COLOR_WRITEMASK[2], o.COLOR_WRITEMASK[3]);
      C('cullFace', o.CULL_FACE_MODE); C('frontFace', o.FRONT_FACE);
      C('stencilFuncSeparate', g.FRONT, o.STENCIL_FUNC, o.STENCIL_REF, o.STENCIL_VALUE_MASK); C('stencilFuncSeparate', g.BACK, o.STENCIL_BACK_FUNC, o.STENCIL_BACK_REF, o.STENCIL_BACK_VALUE_MASK);
      C('stencilOpSeparate', g.FRONT, o.STENCIL_FAIL, o.STENCIL_PASS_DEPTH_FAIL, o.STENCIL_PASS_DEPTH_PASS); C('stencilOpSeparate', g.BACK, o.STENCIL_BACK_FAIL, o.STENCIL_BACK_PASS_DEPTH_FAIL, o.STENCIL_BACK_PASS_DEPTH_PASS);
      C('stencilMaskSeparate', g.FRONT, o.STENCIL_WRITEMASK); C('stencilMaskSeparate', g.BACK, o.STENCIL_BACK_WRITEMASK);
      if (o.COLOR_CLEAR_VALUE) C('clearColor', o.COLOR_CLEAR_VALUE[0], o.COLOR_CLEAR_VALUE[1], o.COLOR_CLEAR_VALUE[2], o.COLOR_CLEAR_VALUE[3]);
      C('clearDepth', o.DEPTH_CLEAR_VALUE); C('clearStencil', o.STENCIL_CLEAR_VALUE);
      C('polygonOffset', o.POLYGON_OFFSET_FACTOR, o.POLYGON_OFFSET_UNITS); C('lineWidth', o.LINE_WIDTH);
      if (o.DEPTH_RANGE) C('depthRange', o.DEPTH_RANGE[0], o.DEPTH_RANGE[1]);
      // the shadows follow the restored state
      s.prog = o.CURRENT_PROGRAM; s.fbo = o.FRAMEBUFFER_BINDING; s.unit = o.ACTIVE_TEXTURE - g.TEXTURE0;
      if (v) s.vp = [v[0], v[1], v[2], v[3]];
      if (b) s.sc = [b[0], b[1], b[2], b[3]];
      s.scOn = o.en[SAVE_ENABLES.indexOf('SCISSOR_TEST')];
      for (let u = 0; u < o.tex.length; u++) s.units[u] = o.tex[u][0];
    }
    // Replays the last recorded screen frame now (its frame hook runs before this returns, with
    // F.replay set); false when there is none.
    T.replay = function () {
      if (!last || replaying || queued || (G.isContextLost && G.isContextLost())) return false;
      const saved = saveState();
      replaying = true;
      F = newF(); F.replay = true;
      const L = last;
      try {
        for (let i = 0; i < L.length; i += 3) { const tg = L[i], fn = tg[L[i + 1]]; try { fn.apply(tg, L[i + 2]); } catch (e) { /* a deleted object: GL drops the call */ } }
      } finally {
        replaying = false;
        restoreState(saved);
        // a replayed call on an object the page has deleted since raises a GL error: never let the page
        // read ours (an engine that checks getError may stop drawing)
        try { for (let i = 0; i < 16 && O.getError.call(G) !== G.NO_ERROR; i++); } catch (e) { /* lost */ }
      }
      const f = F; F = null;
      T.frames++; T.F = f;
      try { hooks.frame(f); } catch (e) { core.warnOnce('gltap-frame', "the WebGL tap's frame hook failed", e); }
      return true;
    };
    Object.defineProperty(T, 'record', { get: () => recOn, set: (v) => { recOn = !!v; if (!recOn) { cur = []; last = null; } } });
    Object.defineProperty(T, 'canReplay', { get: () => !!last });

    // ---- the page frame
    let F = null, queued = false;
    const newF = () => ({ draws: 0, screen: 0, clip: 0, flat: 0, through: 0, skipped: 0, offscreen: 0, tiles: [], verts: [], wq: [], p11: [], stereo: !!T.stereo });
    function touch() {
      if (!F) F = newF();
      if (!queued && !replaying) { queued = true; queueMicrotask(endFrame); }
    }
    function endFrame() {
      queued = false;
      const f = F; F = null;
      if (recOn) { if (f && f.screen > 0 && !curBig) last = cur; cur = []; curBig = false; }
      if (!f) return;
      T.frames++;
      T.F = f;
      try { hooks.frame(f); } catch (e) { core.warnOnce('gltap-frame', 'the WebGL tap\'s frame hook failed', e); }
    }

    // ---- targets
    const dbw = () => G.drawingBufferWidth, dbh = () => G.drawingBufferHeight;
    function sizeOfFbo(f) {
      let z = fboSize.get(f);
      if (z === undefined) {
        z = null;
        try { // a framebuffer made before the tap: ask what is attached
          const prev = s.fbo;
          if (prev !== f) call('bindFramebuffer', FB, f);
          const t = G.getFramebufferAttachmentParameter(FB, COLOR0, G.FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE);
          const o = G.getFramebufferAttachmentParameter(FB, COLOR0, G.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME);
          if (t === G.RENDERBUFFER && o) { const p = G.getParameter(G.RENDERBUFFER_BINDING); call('bindRenderbuffer', G.RENDERBUFFER, o); z = [G.getRenderbufferParameter(G.RENDERBUFFER, G.RENDERBUFFER_WIDTH), G.getRenderbufferParameter(G.RENDERBUFFER, G.RENDERBUFFER_HEIGHT)]; call('bindRenderbuffer', G.RENDERBUFFER, p); }
          else if (t === G.TEXTURE && o) { z = texSize.get(o) || null; fboColor.set(f, o); }
          if (prev !== f) call('bindFramebuffer', FB, prev);
        } catch (e) { z = null; }
        fboSize.set(f, z);
      }
      return z;
    }
    const isScreen = () => {
      if (!s.fbo) return true;
      const z = sizeOfFbo(s.fbo);
      return !!z && z[0] === dbw() && z[1] === dbh();
    };
    const targetW = () => (s.fbo ? (sizeOfFbo(s.fbo) || [dbw()])[0] : dbw());
    const targetH = () => (s.fbo ? (sizeOfFbo(s.fbo) || [0, dbh()])[1] : dbh());

    // ---- state shadows
    def('useProgram', function (p) { s.prog = p; return call('useProgram', p); });
    def('bindFramebuffer', function (t, f) { if (t === FB || t === DRAW_FB) s.fbo = f; return call('bindFramebuffer', t, f); });
    def('viewport', function (x, y, w, h) { s.vp = [x, y, w, h]; return call('viewport', x, y, w, h); });
    def('scissor', function (x, y, w, h) { s.sc = [x, y, w, h]; return call('scissor', x, y, w, h); });
    def('enable', function (c) { if (c === SCISSOR) s.scOn = true; return call('enable', c); });
    def('disable', function (c) { if (c === SCISSOR) s.scOn = false; return call('disable', c); });
    def('activeTexture', function (u) { s.unit = u - G.TEXTURE0; return call('activeTexture', u); });
    def('bindTexture', function (t, x) { if (t === TEX2D) s.units[s.unit] = x; return call('bindTexture', t, x); });
    def('texImage2D', function () {
      const a = arguments, x = s.units[s.unit];
      if (x && a[0] === TEX2D && a[1] === 0) { if (a.length >= 8) texSize.set(x, [a[3], a[4]]); else if (a[5] && a[5].width) texSize.set(x, [a[5].width, a[5].height]); }
      return O.texImage2D.apply(G, a);
    });
    def('texStorage2D', function (t, l, f, w, h) { const x = s.units[s.unit]; if (x && t === TEX2D) texSize.set(x, [w, h]); return call('texStorage2D', t, l, f, w, h); });
    def('bindRenderbuffer', function (t, r) { s.rb = r; return call('bindRenderbuffer', t, r); });
    def('renderbufferStorage', function (t, f, w, h) { if (s.rb) rbSize.set(s.rb, [w, h]); return call('renderbufferStorage', t, f, w, h); });
    def('renderbufferStorageMultisample', function (t, n, f, w, h) { if (s.rb) rbSize.set(s.rb, [w, h]); return call('renderbufferStorageMultisample', t, n, f, w, h); });
    def('framebufferTexture2D', function (t, att, tt, tex, l) {
      if (att === COLOR0 && s.fbo && (t === FB || t === DRAW_FB)) { fboColor.set(s.fbo, tex); fboSize.set(s.fbo, (tex && texSize.get(tex)) || null); }
      return call('framebufferTexture2D', t, att, tt, tex, l);
    });
    def('framebufferRenderbuffer', function (t, att, rt, rb) {
      if (att === COLOR0 && s.fbo && (t === FB || t === DRAW_FB)) { fboColor.delete(s.fbo); fboSize.set(s.fbo, (rb && rbSize.get(rb)) || null); }
      return call('framebufferRenderbuffer', t, att, rt, rb);
    });
    def('getUniformLocation', function (p, name) {
      const l = O.getUniformLocation.call(G, p, name);
      if (l) { try { locName.set(l, String(name)); } catch (e) { /* ignore */ } }
      return l;
    });
    def('uniformMatrix4fv', function (loc, tr, d, off, len) {
      try {
        const p = s.prog, o = off | 0;
        if (p && loc && d && d.length - o >= 16) {
          let M = progU.get(p);
          const key = locName.get(loc) || loc;
          if (d.length - o > 16 || tr) { if (M) M.delete(key); } // arrays / transposed: not ours
          else if (isClip(d, o)) {
            if (!M) progU.set(p, (M = new Map()));
            let e = M.get(key); if (!e) M.set(key, (e = { loc, m: new Float32Array(16) }));
            e.loc = loc;
            const m = e.m; for (let i = 0; i < 16; i++) m[i] = d[o + i];
          } else if (M) M.delete(key);
        }
      } catch (e) { /* never break the upload */ }
      return O.uniformMatrix4fv.apply(G, arguments);
    });
    def('clear', function (mask) {
      if (T.stereo && s.scOn && isScreen()) {
        const sc = s.sc, W = targetW();
        try { for (let i = 0; i < 2; i++) { call('scissor', i * W / 2 + sc[0] / 2, sc[1], sc[2] / 2, sc[3]); call('clear', mask); } }
        finally { call('scissor', sc[0], sc[1], sc[2], sc[3]); }
        return;
      }
      return call('clear', mask);
    });

    // ---- draws
    const tmp = new Float32Array(16);
    function eyeMatrix(m, k, C) {
      tmp.set(m);
      tmp[0] += k * m[3]; tmp[4] += k * m[7]; tmp[8] += k * m[11]; tmp[12] += k * m[15] - k * C;
      return tmp;
    }
    function samplesTainted() {
      for (let i = 0; i < s.units.length; i++) { const x = s.units[i]; if (x && taint.has(x)) return true; }
      return false;
    }
    function inHalves(fn, args, M) {
      const vp = s.vp, sc = s.sc, scOn = s.scOn, W = targetW(), H = targetH(), st = T.stereo;
      const C = st.C > 0 ? st.C : 1;
      try {
        if (!scOn) call('enable', SCISSOR);
        for (let i = 0; i < 2; i++) {
          if (M) { const k = +st.k[i] || 0; for (const e of M.values()) O.uniformMatrix4fv.call(G, e.loc, false, eyeMatrix(e.m, k, C)); }
          const x0 = i * W / 2;
          call('viewport', x0 + vp[0] / 2, vp[1], vp[2] / 2, vp[3]);
          let a = x0, b = x0 + W / 2, y0 = 0, y1 = H;
          if (scOn) { a = Math.max(a, x0 + sc[0] / 2); b = Math.min(b, x0 + (sc[0] + sc[2]) / 2); y0 = sc[1]; y1 = sc[1] + sc[3]; }
          call('scissor', a, y0, Math.max(0, b - a), Math.max(0, y1 - y0));
          fn.apply(G, args);
        }
      } finally {
        if (M) for (const e of M.values()) O.uniformMatrix4fv.call(G, e.loc, false, e.m);
        call('viewport', vp[0], vp[1], vp[2], vp[3]);
        call('scissor', sc[0], sc[1], sc[2], sc[3]);
        if (!scOn) call('disable', SCISSOR);
      }
      if (s.fbo) { const c = fboColor.get(s.fbo); if (c) taint.add(c); }
    }
    // ---- vertex samples: WHERE the drawn surface is, not only where each tile's model origin is (an
    // origin is often a corner of a bounding box, off the surface). The first HEAD_BYTES of every
    // ARRAY_BUFFER upload are kept (a copy; never the page's array), and at a screen draw with a clip
    // matrix the program's position attribute (the attribute its gl_Position statement multiplies) is
    // read from that copy with the draw's own vertex layout: up to VERTS_PER_DRAW of its first vertices,
    // transformed by the clip matrix, go to F.verts as [u, v, w] (clip x, y, w). Queries only on the
    // client-side vertex state; nothing waits on the GPU.
    const HEAD_BYTES = 4096, VERTS_PER_DRAW = 6;
    const bufHead = new WeakMap(), posAttr = new WeakMap(), layouts = new WeakMap();
    let arrayBuf = null;
    try { arrayBuf = G.getParameter(G.ARRAY_BUFFER_BINDING); } catch (e) { /* ignore */ }
    def('bindBuffer', function (t, b) { if (t === G.ARRAY_BUFFER) arrayBuf = b; return call('bindBuffer', t, b); });
    def('bufferData', function (t, d) {
      if (t === G.ARRAY_BUFFER && arrayBuf) {
        try {
          if (d && typeof d === 'object' && arguments.length <= 3) {
            const u8 = ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, Math.min(d.byteLength, HEAD_BYTES)) : new Uint8Array(d, 0, Math.min(d.byteLength, HEAD_BYTES));
            bufHead.set(arrayBuf, u8.slice());
          } else bufHead.delete(arrayBuf);
          layouts.delete(arrayBuf);
        } catch (e) { /* ignore */ }
      }
      return O.bufferData.apply(G, arguments);
    });
    def('bufferSubData', function (t, off, d) {
      if (t === G.ARRAY_BUFFER && arrayBuf && off < HEAD_BYTES) {
        try {
          const h = bufHead.get(arrayBuf);
          if (h && d && typeof d === 'object' && arguments.length <= 3) {
            const u8 = ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : new Uint8Array(d);
            h.set(u8.subarray(0, Math.max(0, Math.min(u8.length, h.length - off))), off);
            layouts.delete(arrayBuf);
          }
        } catch (e) { /* ignore */ }
      }
      return O.bufferSubData.apply(G, arguments);
    });
    function positionAttrib(prog) {
      let a = posAttr.get(prog);
      if (a !== undefined) return a;
      a = -1;
      try {
        const sh = G.getAttachedShaders(prog) || [];
        let src = '';
        for (const x of sh) if (G.getShaderParameter(x, G.SHADER_TYPE) === G.VERTEX_SHADER) src = G.getShaderSource(x) || '';
        const attrs = [...src.matchAll(/\b(?:attribute|in)\s+(?:highp\s+|mediump\s+|lowp\s+)?(vec[234])\s+(\w+)/g)].map((m) => ({ type: m[1], name: m[2] }));
        const gp = (src.match(/gl_Position\s*=([^;]*)/) || ['', ''])[1];
        let pick = attrs.find((x) => new RegExp('\\b' + x.name + '\\b').test(gp)) || attrs.find((x) => x.type !== 'vec2') || null;
        if (pick) a = O.getAttribLocation.call(G, prog, pick.name);
      } catch (e) { a = -1; }
      posAttr.set(prog, a);
      return a;
    }
    const TYPES = { 0x1406: [4, 'getFloat32', 0], 0x1402: [2, 'getInt16', 32767], 0x1403: [2, 'getUint16', 65535], 0x1400: [1, 'getInt8', 127], 0x1401: [1, 'getUint8', 255] };
    function samplePositions(loc) {
      let buf, size, type, norm, stride, off;
      try {
        buf = G.getVertexAttrib(loc, G.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING);
        if (!buf || !G.getVertexAttrib(loc, G.VERTEX_ATTRIB_ARRAY_ENABLED)) return null;
        const head = bufHead.get(buf);
        if (!head) return null;
        size = G.getVertexAttrib(loc, G.VERTEX_ATTRIB_ARRAY_SIZE); type = G.getVertexAttrib(loc, G.VERTEX_ATTRIB_ARRAY_TYPE);
        norm = G.getVertexAttrib(loc, G.VERTEX_ATTRIB_ARRAY_NORMALIZED); stride = G.getVertexAttrib(loc, G.VERTEX_ATTRIB_ARRAY_STRIDE);
        off = G.getVertexAttribOffset(loc, G.VERTEX_ATTRIB_ARRAY_POINTER);
        const key = off + '/' + stride + '/' + type + '/' + size + '/' + (norm ? 1 : 0);
        let L = layouts.get(buf);
        if (!L) layouts.set(buf, (L = new Map()));
        let P = L.get(key);
        if (P !== undefined) return P;
        P = null;
        const T0 = TYPES[type];
        if (T0 && size >= 2) {
          const st = stride || T0[0] * size, dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
          const n = Math.min(VERTS_PER_DRAW * 4, Math.floor((head.length - off - T0[0] * size) / st) + 1);
          if (n >= 1) {
            P = new Float32Array(Math.min(n, VERTS_PER_DRAW) * 4); // x, y, z, w (w = 1 unless the attribute has 4 components)
            const step = Math.max(1, Math.floor(n / VERTS_PER_DRAW));
            for (let i = 0, j = 0; j < P.length / 4 && i < n; i += step, j++) {
              for (let c = 0; c < 4; c++) {
                if (c >= size) { P[j * 4 + c] = c === 3 ? 1 : 0; continue; }
                let v = dv[T0[1]](off + i * st + c * T0[0], true);
                if (norm && T0[2]) v = Math.max(-1, v / T0[2]);
                P[j * 4 + c] = v;
              }
            }
          }
        }
        L.set(key, P);
        return P;
      } catch (e) { return null; }
    }
    // Which of a program's clip matrices get the eye shear. A matrix whose model origin projects to w > 0
    // (a model-view-projection: the tile's) is the one that places the geometry; a pure projection
    // (w of the origin 0: it projects camera-relative vectors, e.g. a billboard's or a label's screen
    // offset) beside it is left alone, or that offset would be sheared too. A program with only pure
    // projections (P with a separate model-view) has them all sheared.
    const eyeSets = new WeakMap();
    function eyeSet(M0) {
      if (M0.size === 1) return M0;
      let mvp = 0;
      for (const e of M0.values()) if (e.m[15] > 1e-6 * (Math.abs(e.m[3]) + Math.abs(e.m[7]) + Math.abs(e.m[11]) + 1e-30)) mvp++;
      if (!mvp || mvp === M0.size) return M0;
      let sub = eyeSets.get(M0);
      if (!sub) eyeSets.set(M0, (sub = new Map()));
      sub.clear();
      for (const [k, e] of M0) if (e.m[15] > 1e-6 * (Math.abs(e.m[3]) + Math.abs(e.m[7]) + Math.abs(e.m[11]) + 1e-30)) sub.set(k, e);
      return sub;
    }
    function onDraw(fn, args) {
      touch();
      const f = F;
      f.draws++;
      if (!isScreen()) { f.offscreen++; return fn.apply(G, args); }
      f.screen++;
      const M0 = s.prog ? progU.get(s.prog) : null;
      const M = M0 && M0.size ? eyeSet(M0) : null;
      if (M) {
        f.clip++;
        if (f.tiles.length < 4096) {
          for (const e of M.values()) {
            const m = e.m;
            if (m[15] > 1e-9) {
              f.tiles.push([m[12], m[13], m[15]]);
              const n3 = Math.hypot(m[3], m[7], m[11]);
              if (n3 > 0 && f.p11.length < 256) f.p11.push(Math.hypot(m[1], m[5], m[9]) / n3);
              if (T.sampleVerts && f.verts.length < 4096) {
                const loc = positionAttrib(s.prog), Pp = loc >= 0 ? samplePositions(loc) : null;
                if (Pp) for (let i = 0; i < Pp.length; i += 4) {
                  const x = Pp[i], y = Pp[i + 1], z = Pp[i + 2], q = Pp[i + 3];
                  if (!(q > 0)) continue;
                  // the point's own homogeneous weight: (u, v, w) scaled back to a weight of 1, so depths compare
                  f.verts.push([(m[0] * x + m[4] * y + m[8] * z + m[12] * q) / q, (m[1] * x + m[5] * y + m[9] * z + m[13] * q) / q, (m[3] * x + m[7] * y + m[11] * z + m[15] * q) / q]);
                  if (f.wq.length < 64) f.wq.push(q);
                }
              }
              break;
            }
          }
        }
      } else f.flat++;
      if (!T.stereo) return fn.apply(G, args);
      if (!M && samplesTainted()) { f.through++; return fn.apply(G, args); }
      return inHalves(fn, args, M);
    }
    for (const dn of DRAWS) { if (typeof G[dn] === 'function') { const o = G[dn]; def(dn, function () { return onDraw(o, arguments); }); } }
    // ANGLE_instanced_arrays (WebGL 1): the extension object's own draw entry points, wrapped the same way
    // (own properties on that object).
    let vaoExt = null;
    // Extension entry points that change what a replayed draw reads (vertex arrays, instancing) are
    // recorded too: every method of those extension objects becomes an own, recording wrapper.
    const wrapExt = (x, drawNames) => {
      if (x.__dxrOrig) return;
      const orig = {};
      Object.defineProperty(x, '__dxrOrig', { value: orig });
      const names = new Set();
      for (let p = x; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) for (const k of Object.getOwnPropertyNames(p)) names.add(k);
      for (const k of names) {
        let fx; try { fx = x[k]; } catch (e) { continue; }
        if (typeof fx !== 'function' || k === 'constructor' || k.startsWith('__')) continue;
        orig[k] = fx;
        const isDraw = drawNames.includes(k), rec = !/^(create|delete|is[A-Z])/.test(k);
        Object.defineProperty(x, k, { configurable: true, writable: true, enumerable: false, value: function () {
          if (recOn && rec && !replaying) record(x, k, arguments);
          return isDraw ? onDraw(fx.bind(x), arguments) : fx.apply(x, arguments);
        } });
      }
    };
    def('getExtension', function (name) {
      const x = O.getExtension.call(G, name);
      try {
        if (x && /^OES_vertex_array_object$/i.test(String(name))) { wrapExt(x, []); vaoExt = x; }
        if (x && /^(ANGLE_instanced_arrays)$/i.test(String(name))) wrapExt(x, ['drawArraysInstancedANGLE', 'drawElementsInstancedANGLE']);
        if (x && /^WEBGL_multi_draw/i.test(String(name)) && !x.__dxrTap) {
          Object.defineProperty(x, '__dxrTap', { value: true });
          for (const k of Object.keys(Object.getPrototypeOf(x))) {
            const fx = x[k];
            if (/^multiDraw/.test(k) && typeof fx === 'function') Object.defineProperty(x, k, { configurable: true, writable: true, enumerable: false, value: function () { touch(); F.draws++; F.skipped++; return fx.apply(x, arguments); } });
          }
        }
      } catch (e) { /* the extension still works */ }
      return x;
    });
    // Every other WebGL entry point of the context: a recording pass-through (a replay needs the whole frame).
    for (let p = Object.getPrototypeOf(G); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
      for (const k of Object.getOwnPropertyNames(p)) {
        if (k === 'constructor' || O[k]) continue;
        let v; try { v = G[k]; } catch (e) { continue; }
        if (typeof v !== 'function') continue;
        def(k, function () { return O[k].apply(G, arguments); });
      }
    }
    T.clearTaint = () => { taint = new WeakSet(); };
    return T;
  };
}

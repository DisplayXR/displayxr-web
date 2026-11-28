// SPIKE (feasibility, not product): an ENGINE-AGNOSTIC WebGL-level hook.
// Injected at document start in every frame (main world). Two modes, window.__glpCfg:
//   { mode: 'stats' }  wrap the WebGL prototypes, record per-frame draw / FBO / uniform statistics
//                      and every mat4 uniform upload (name, value, classification) -> window.__glp
//   { mode: 'stereo', sep: 0.03, conv: 'auto'|<number> }
//                      per-draw doubling: every draw whose program holds a CLIP-PRODUCING mat4
//                      (P, VP or MVP: row 3 != [0 0 0 1] and rows 2/3 xyz parallel) and whose
//                      target is the default framebuffer or a screen-sized FBO is issued TWICE,
//                      into the left and right half of the viewport, with that matrix's x row
//                      corrected per eye:  row0' = row0 + d * e_w - (d / C) * row3
//                      (an eye shifted by e along view x, converged at view depth C, d = P00 * e;
//                      P00 is read off the matrix itself: |row0.xyz| / |row3.xyz|). Only the x row
//                      changes, so depth conventions (reversed-Z, log depth) are untouched.
//                      Draws with no clip matrix (post passes, full-screen quads, 2D overlays) are
//                      drawn once with the page's own viewport.
// Nothing here is page-invisible: it is a probe.
(() => {
  const W = self; // a window, or a (dedicated) worker: the same hook runs in both
  if (W.__glp) return;
  const IN_WORKER = typeof W.document === 'undefined';
  const cfg = Object.assign({ allStages: true, mode: 'stats', sep: 0.03, conv: 'auto', maxSamples: 400 }, W.__glpCfg || {});
  const T0 = performance.now();
  const G = (W.__glp = {
    cfg, inWorker: IN_WORKER, installedAt: T0, readyStateAtInstall: IN_WORKER ? 'worker' : document.readyState, href: String(location.href),
    contexts: [], workers: [], offscreen: [], transfers: 0, frames: [], shaders: { count: 0, kw: {}, mat4Decl: {}, blocks: {} },
    mat4: {}, errors: [], unseenContexts: null, stereoStats: { doubled: 0, single: 0, fboDoubled: 0, convSamples: [] }, workerReports: {},
  });
  const err = (e) => { if (G.errors.length < 20) G.errors.push(String(e && e.stack || e).slice(0, 300)); };

  // ---- workers: wrap the constructor so the hook also runs INSIDE every worker the page starts ----
  // (a bootstrap blob: our source, then the page's script; classic: importScripts, module: import()).
  // Reports come back on a BroadcastChannel, never on the page's own message port.
  try {
    const OW = W.Worker;
    if (OW) {
      W.Worker = function Worker(url, opts) {
        const abs = new URL(String(url), String(location.href)).href;
        const rec = { url: abs.slice(0, 160), type: (opts && opts.type) || 'classic', t: +(performance.now() - T0).toFixed(1), injected: false };
        G.workers.push(rec);
        const src = W.__glpSrc;
        if (src && cfg.workers !== false) {
          try {
            // a URL worker loses its own base URL inside a blob: shim location / importScripts / fetch back to it
            const fix = abs.startsWith('blob:') ? '' : '(function(O){var L=new URL(O);try{Object.defineProperty(WorkerGlobalScope.prototype,"location",{configurable:true,get:function(){return L;}});}catch(e){}'
              + 'var I=self.importScripts;self.importScripts=function(){return I.apply(self,[].map.call(arguments,function(u){return new URL(u,O).href;}));};'
              + 'var F=self.fetch;if(F)self.fetch=function(u,o){return F.call(self,(typeof u==="string")?new URL(u,O).href:u,o);};})(' + JSON.stringify(abs) + ');';
            const pre = fix + 'self.__glpSrc=' + JSON.stringify(src) + ';self.__glpCfg=' + JSON.stringify(cfg) + ';self.__glpParent=' + JSON.stringify(abs.slice(0, 100) + '#' + G.workers.length) + ';\n' + src + '\n';
            const body = rec.type === 'module' ? pre + 'await import(' + JSON.stringify(abs) + ');' : pre + 'importScripts(' + JSON.stringify(abs) + ');';
            const b = URL.createObjectURL(new Blob([body], { type: 'text/javascript' }));
            rec.injected = true;
            return new OW(b, opts);
          } catch (e) { err(e); }
        }
        return new OW(url, opts);
      };
      W.Worker.prototype = OW.prototype;
    }
  } catch (e) { err(e); }
  try {
    const bc = new BroadcastChannel('__glp');
    if (IN_WORKER) setInterval(() => { try { bc.postMessage({ from: W.__glpParent, summary: G.summary ? G.summary(90) : null }); } catch (e) { err(e); } }, 1500);
    else bc.onmessage = (ev) => { if (ev.data && ev.data.from) G.workerReports[ev.data.from] = ev.data.summary; };
  } catch (e) { err(e); }

  // ---- getContext: which canvases get WebGL, when, with what (HTMLCanvasElement and OffscreenCanvas) ----
  const seen = new WeakMap(); // ctx -> info
  const note = (canvas, type, attrs, ctx, kind) => {
    if (ctx && /webgl/.test(type) && !seen.has(ctx)) {
      let a = null; try { a = attrs ? JSON.parse(JSON.stringify(attrs)) : null; } catch (e) { a = '?'; }
      const info = { kind, type, attrs: a, t: +(performance.now() - T0).toFixed(1), readyState: IN_WORKER ? 'worker' : document.readyState,
        w: canvas.width, h: canvas.height, inDom: !!canvas.isConnected, stack: (new Error().stack || '').split('\n').slice(3, 6).map((s) => s.trim().slice(0, 140)) };
      seen.set(ctx, info); G.contexts.push(info); info.idx = G.contexts.length - 1;
    }
  };
  let GC = null;
  try {
    if (W.HTMLCanvasElement) {
      const tc = HTMLCanvasElement.prototype.transferControlToOffscreen;
      if (tc) HTMLCanvasElement.prototype.transferControlToOffscreen = function () { G.transfers++; (G.transferred || (G.transferred = [])).push({ w: this.width, h: this.height, cssW: this.clientWidth, cssH: this.clientHeight }); return tc.apply(this, arguments); };
      GC = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, attrs) { const ctx = GC.apply(this, arguments); try { note(this, type, attrs, ctx, 'canvas'); } catch (e) { err(e); } return ctx; };
    }
    if (W.OffscreenCanvas) {
      const og = OffscreenCanvas.prototype.getContext;
      OffscreenCanvas.prototype.getContext = function (type, attrs) { const ctx = og.apply(this, arguments); try { if (!/webgl/.test(type)) { if (G.offscreen.length < 30) G.offscreen.push({ type, w: this.width, h: this.height }); else G.offscreenMore = (G.offscreenMore || 0) + 1; } note(this, type, attrs, ctx, 'offscreen'); } catch (e) { err(e); } return ctx; };
    }
  } catch (e) { err(e); }
  G.checkUnseen = () => { // a WebGL context we did not hand out = the engine got around the wrap
    const out = [];
    if (IN_WORKER || !GC) return out;
    for (const c of document.querySelectorAll('canvas')) {
      let c2 = null; try { c2 = GC.call(c, '2d'); } catch (e) { out.push({ transferredOrBusy: true, w: c.width, h: c.height }); continue; }
      if (c2) continue; // had no other context (we just made a 2d one: probe-only side effect)
      for (const t of ['webgl2', 'webgl', 'experimental-webgl']) {
        let ctx = null; try { ctx = GC.call(c, t); } catch (e) { /* other type */ }
        if (ctx) { out.push({ type: t, w: c.width, h: c.height, wrapped: seen.has(ctx) }); break; }
      }
    }
    G.unseenContexts = out; return out;
  };

  // ---- frame bookkeeping (rAF timestamp = frame id) ----
  let cur = null, curTs = -1, lastDrawT = 0;
  const newFrame = (ts) => {
    cur = { ts: +ts.toFixed(1), draws: 0, drawsDefault: 0, drawsFbo: {}, clears: 0, bindFbo: 0, useProgram: 0, programs: new Set(), m4: 0, ubo: 0, uboBytes: 0,
      v4arr: 0, readPixels: 0, multiDraw: 0, instanced: 0, cpuMs: 0, viewports: new Set(), clipDraws: 0, noClipDraws: 0, pushed: false };
    G.idleFrames = (G.idleFrames || 0) + 1;
  };
  const RAF = W.requestAnimationFrame ? W.requestAnimationFrame.bind(W) : (cb) => setTimeout(() => cb(performance.now()), 16);
  if (W.requestAnimationFrame) W.requestAnimationFrame = function (cb) {
    return RAF(function (ts) {
      if (ts !== curTs) { curTs = ts; newFrame(ts); }
      const t = performance.now();
      try { return cb.apply(this, arguments); } finally { if (cur) cur.cpuMs += performance.now() - t; }
    });
  };
  newFrame(0);

  // ---- matrix classification ----
  const near = (a, b, e = 1e-4) => Math.abs(a - b) <= e * Math.max(1, Math.abs(a), Math.abs(b));
  // column-major m[c*4+r]; row r = [m[r], m[4+r], m[8+r], m[12+r]]
  function classify(m) {
    const r3 = [m[3], m[7], m[11], m[15]];
    if (near(r3[0], 0) && near(r3[1], 0) && near(r3[2], 0) && near(r3[3], 1)) {
      // affine: rigid if upper 3x3 orthonormal
      const c0 = Math.hypot(m[0], m[1], m[2]), c1 = Math.hypot(m[4], m[5], m[6]), c2 = Math.hypot(m[8], m[9], m[10]);
      const ortho = near(c0, c1, 1e-3) && near(c1, c2, 1e-3) && Math.abs(m[0] * m[4] + m[1] * m[5] + m[2] * m[6]) < 1e-3 * c0 * c1;
      if (ortho && near(c0, 1, 1e-3)) return 'rigid';
      if (ortho) return 'similarity';
      // orthographic projection: diagonal-ish, no rotation
      if (Math.abs(m[1]) + Math.abs(m[2]) + Math.abs(m[4]) + Math.abs(m[6]) + Math.abs(m[8]) + Math.abs(m[9]) < 1e-6) return 'ortho-or-scale';
      return 'affine';
    }
    const n3 = Math.hypot(m[3], m[7], m[11]); const n2 = Math.hypot(m[2], m[6], m[10]);
    if (n3 < 1e-9) return 'projective-other';
    const cross = Math.hypot(m[6] * m[11] - m[10] * m[7], m[10] * m[3] - m[2] * m[11], m[2] * m[7] - m[6] * m[3]);
    if (n2 < 1e-9 * Math.max(1, n3) || cross < 1e-3 * n2 * n3) {
      // pure perspective P: row0 = [a 0 s 0], row3 = [0 0 -1 0]
      if (near(m[3], 0) && near(m[7], 0) && near(Math.abs(m[11]), 1) && near(m[15], 0) && near(m[4], 0) && near(m[1], 0)) {
        const reversedZ = (m[10] * m[11]) < 0 ? false : true; // GL std: A*(-1) for z: A<0 with r3z=-1 -> A*r3z>0 ... heuristic below
        return n2 < 1e-9 ? 'P(infinite/reversed)' : 'P';
      }
      return 'clip(VP/MVP)';
    }
    return 'projective-other';
  }
  G.classify = classify;
  const isClip = (k) => k === 'P' || k === 'P(infinite/reversed)' || k === 'clip(VP/MVP)';

  // ---- shaders ----
  const KW = ['logdepth', 'log2', 'gl_FragDepth', 'reverse', 'viewMatrix', 'projectionMatrix', 'modelViewMatrix', 'ModelView', 'Projection', 'MVP', 'mvp', 'gl_InstanceID', 'uniform ', 'layout(std140)', 'texelFetch', 'gl_ViewID_OVR'];
  function noteShader(src) {
    G.shaders.count++;
    for (const k of KW) if (src.includes(k)) G.shaders.kw[k] = (G.shaders.kw[k] || 0) + 1;
    for (const m of src.matchAll(/uniform\s+(?:highp\s+|mediump\s+|lowp\s+)?mat4\s+(\w+)(\s*\[\s*\w+\s*\])?/g)) G.shaders.mat4Decl[m[1] + (m[2] ? '[]' : '')] = (G.shaders.mat4Decl[m[1] + (m[2] ? '[]' : '')] || 0) + 1;
    for (const m of src.matchAll(/uniform\s+(\w+)\s*\{([^}]*)\}/g)) G.shaders.blocks[m[1]] = m[2].replace(/\s+/g, ' ').trim().slice(0, 300);
  }

  // ---- per-context state we shadow ----
  const st = new WeakMap(); // gl -> { prog, fbo, viewport, scissor, scissorOn, fboSize: Map }
  const S = (gl) => {
    let s = st.get(gl);
    if (!s) { s = { prog: null, fbo: null, viewport: [0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight], scissor: [0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight], scissorOn: false,
      fboTex: new WeakMap(), texSize: new WeakMap(), rbSize: new WeakMap(), curTex: null, curRb: null }; st.set(gl, s); }
    return s;
  };
  const locName = new WeakMap(); // WebGLUniformLocation -> name
  const progClip = new WeakMap(); // program -> Map(loc -> Float32Array(16) last value)  (clip matrices only)
  const progNames = new WeakMap();
  const progAff = new WeakMap(); // program -> Map(loc -> rigid/similarity mat4) (for the depth of a draw when P is separate)
  const shType = new WeakMap(), shSrc = new WeakMap(), progVS = new WeakMap();
  const inVS = (prog, name) => { const vs = progVS.get(prog); const src = vs && shSrc.get(vs); if (!src) return true; const base = name.replace(/\[.*$/, ''); return new RegExp('\\b' + base + '\\b').test(src); };
  let progIds = 0;

  function fboSize(gl, s, fbo) {
    if (!fbo) return [gl.drawingBufferWidth, gl.drawingBufferHeight];
    return s.fboTex.get(fbo) || null;
  }

  function wrapProto(P) {
    if (!P) return;
    const rawVp = P.viewport, rawSc = P.scissor, rawM4 = P.uniformMatrix4fv, rawEn = P.enable, rawDis = P.disable; // originals, before any wrap
    const wrap = (name, fn) => { const o = P[name]; if (!o) return; P[name] = function () { return fn.call(this, o, arguments); }; };
    wrap('shaderSource', function (o, a) { try { shSrc.set(a[0], String(a[1])); noteShader(String(a[1])); } catch (e) { err(e); } return o.apply(this, a); });
    wrap('createShader', function (o, a) { const sh = o.apply(this, a); try { shType.set(sh, a[0]); } catch (e) { err(e); } return sh; });
    wrap('attachShader', function (o, a) { try { if (shType.get(a[1]) === this.VERTEX_SHADER) progVS.set(a[0], a[1]); } catch (e) { err(e); } return o.apply(this, a); });
    wrap('createProgram', function (o, a) { const p = o.apply(this, a); try { progNames.set(p, ++progIds); } catch (e) { err(e); } return p; });
    wrap('getUniformLocation', function (o, a) { const l = o.apply(this, a); try { if (l) locName.set(l, String(a[1])); } catch (e) { err(e); } return l; });
    wrap('useProgram', function (o, a) { const s = S(this); s.prog = a[0]; cur.useProgram++; if (a[0]) cur.programs.add(progNames.get(a[0])); return o.apply(this, a); });
    wrap('bindFramebuffer', function (o, a) { const s = S(this); if (a[0] === this.FRAMEBUFFER || a[0] === 0x8CA9 /*DRAW*/) s.fbo = a[1]; cur.bindFbo++; return o.apply(this, a); });
    wrap('viewport', function (o, a) { const s = S(this); s.viewport = [a[0], a[1], a[2], a[3]]; cur.viewports.add(a[2] + 'x' + a[3]); return o.apply(this, a); });
    wrap('scissor', function (o, a) { S(this).scissor = [a[0], a[1], a[2], a[3]]; return o.apply(this, a); });
    wrap('enable', function (o, a) { if (a[0] === this.SCISSOR_TEST) S(this).scissorOn = true; return o.apply(this, a); });
    wrap('disable', function (o, a) { if (a[0] === this.SCISSOR_TEST) S(this).scissorOn = false; return o.apply(this, a); });
    wrap('bindTexture', function (o, a) { S(this).curTex = a[1]; return o.apply(this, a); });
    wrap('texImage2D', function (o, a) { try { const s = S(this); if (s.curTex && a.length >= 8) s.texSize.set(s.curTex, [a[3], a[4]]); else if (s.curTex && a[5] && a[5].width) s.texSize.set(s.curTex, [a[5].width, a[5].height]); } catch (e) { err(e); } return o.apply(this, a); });
    wrap('texStorage2D', function (o, a) { try { const s = S(this); if (s.curTex) s.texSize.set(s.curTex, [a[3], a[4]]); } catch (e) { err(e); } return o.apply(this, a); });
    wrap('bindRenderbuffer', function (o, a) { S(this).curRb = a[1]; return o.apply(this, a); });
    wrap('renderbufferStorage', function (o, a) { try { const s = S(this); if (s.curRb) s.rbSize.set(s.curRb, [a[2], a[3]]); } catch (e) { err(e); } return o.apply(this, a); });
    wrap('renderbufferStorageMultisample', function (o, a) { try { const s = S(this); if (s.curRb) s.rbSize.set(s.curRb, [a[3], a[4]]); } catch (e) { err(e); } return o.apply(this, a); });
    wrap('framebufferTexture2D', function (o, a) { try { const s = S(this); if (s.fbo && a[1] === this.COLOR_ATTACHMENT0 || (s.fbo && a[1] === this.DEPTH_ATTACHMENT && !s.fboTex.get(s.fbo))) { const sz = s.texSize.get(a[3]); if (sz) s.fboTex.set(s.fbo, sz); } } catch (e) { err(e); } return o.apply(this, a); });
    wrap('framebufferRenderbuffer', function (o, a) { try { const s = S(this); if (s.fbo && !s.fboTex.get(s.fbo)) { const sz = s.rbSize.get(a[3]); if (sz) s.fboTex.set(s.fbo, sz); } } catch (e) { err(e); } return o.apply(this, a); });
    wrap('clear', function (o, a) {
      cur.clears++;
      const s = S(this);
      if (cfg.mode === 'stereo' && s.scissorOn && isScreen(this, s)) { // a scissored clear: clear both halves
        const sc = s.scissor, W = fboSize(this, s, s.fbo)[0];
        try {
          this.__raw_scissor(sc[0] / 2, sc[1], sc[2] / 2, sc[3]); o.apply(this, a);
          this.__raw_scissor(W / 2 + sc[0] / 2, sc[1], sc[2] / 2, sc[3]); o.apply(this, a);
        } finally { this.__raw_scissor(sc[0], sc[1], sc[2], sc[3]); }
        return;
      }
      return o.apply(this, a);
    });
    wrap('readPixels', function (o, a) { cur.readPixels++; return o.apply(this, a); });
    wrap('bufferSubData', function (o, a) { if (a[0] === 0x8A11 /*UNIFORM_BUFFER*/) { cur.ubo++; cur.uboBytes += (a[2] && a[2].byteLength) || 0; } return o.apply(this, a); });
    wrap('bufferData', function (o, a) { if (a[0] === 0x8A11) { cur.ubo++; cur.uboBytes += (a[1] && a[1].byteLength) || 0; } return o.apply(this, a); });
    wrap('uniform4fv', function (o, a) { const d = a[1]; if (d && d.length >= 16 && d.length % 16 === 0) cur.v4arr++; return o.apply(this, a); });
    wrap('uniformMatrix4fv', function (o, a) {
      try {
        cur.m4++;
        const loc = a[0], d = a[2]; const off = a[3] || 0;
        if (loc && d && d.length - off >= 16) {
          const m = new Float32Array(16); for (let i = 0; i < 16; i++) m[i] = d[off + i];
          if (a[1]) { /* transpose=true is illegal in WebGL1; WebGL2 allows */ const t = new Float32Array(16); for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) t[c * 4 + r] = m[r * 4 + c]; m.set(t); }
          const name = locName.get(loc) || '?', k = classify(m);
          const multi = (d.length - off) > 16;
          const rec = G.mat4[name] || (G.mat4[name] = { n: 0, kinds: {}, sample: null, samples: [], multi: false });
          rec.n++; rec.kinds[k] = (rec.kinds[k] || 0) + 1; rec.multi = rec.multi || multi;
          if (!rec.sample || (isClip(k) && rec.samples.length < 3)) { rec.sample = Array.from(m, (x) => +x.toPrecision(5)); if (isClip(k)) rec.samples.push(rec.sample); }
          const s = S(this);
          if (s.prog && !multi) {
            let pm = progClip.get(s.prog); if (!pm) { pm = new Map(); progClip.set(s.prog, pm); }
            if (isClip(k) && (cfg.allStages || inVS(s.prog, name)) && (!cfg.only || new RegExp(cfg.only).test(name))) { pm.set(loc, m); m.inVS = inVS(s.prog, name); } else pm.delete(loc);
            if ((k === 'rigid' || k === 'similarity') && inVS(s.prog, name)) { let pa = progAff.get(s.prog); if (!pa) { pa = new Map(); progAff.set(s.prog, pa); } pa.set(loc, m); }
          }
        }
      } catch (e) { err(e); }
      return o.apply(this, a);
    });
    // raw helpers (bypass our own wrappers)
    P.__raw_enable = function (c) { return rawEn.call(this, c); };
    P.__raw_disable = function (c) { return rawDis.call(this, c); };
    P.__raw_viewport = function (x, y, w, h) { return rawVp.call(this, x, y, w, h); };
    P.__raw_scissor = function (x, y, w, h) { return rawSc.call(this, x, y, w, h); };
    P.__raw_m4 = function (l, m) { return rawM4.call(this, l, false, m); };
    for (const dn of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements']) {
      wrap(dn, function (o, a) { return onDraw(this, o, a, dn); });
    }
  }

  function isScreen(gl, s) {
    if (!s.fbo) return true;
    const sz = s.fboTex.get(s.fbo);
    return !!sz && sz[0] === gl.drawingBufferWidth && sz[1] === gl.drawingBufferHeight;
  }

  // ---- the per-eye matrix ----
  function eyeMatrix(m, e, C, out) {
    // m column-major; row r = m[r], m[4+r], m[8+r], m[12+r]
    const n3 = Math.hypot(m[3], m[7], m[11]);
    const p00 = Math.hypot(m[0], m[4], m[8]) / (n3 || 1); // horizontal focal (symmetric frustum; skew adds a little)
    const d = p00 * e; // NDC*w shift for a view-space x offset e
    out.set(m);
    if (!cfg.noTrans) out[12] += d; // + d * e_w  (object w = 1)
    const k = cfg.noSkew ? 0 : d / C;
    out[0] -= k * m[3]; out[4] -= k * m[7]; out[8] -= k * m[11]; out[12] -= k * m[15];
    return out;
  }
  const tmpL = new Float32Array(16), tmpR = new Float32Array(16);
  let convC = 0; // view-space convergence distance (auto: median clip w of drawn origins, eased)
  const wSamples = [];

  function noteProg(kind, prog, entries) {
    const bag = G.stereoStats[kind + 'Progs'] || (G.stereoStats[kind + 'Progs'] = {});
    const id = progNames.get(prog); if (bag[id]) { bag[id].n++; return; }
    const vs = progVS.get(prog), src = (vs && shSrc.get(vs)) || '';
    const decl = [...src.matchAll(/uniform\s+(?:highp\s+|mediump\s+|lowp\s+)?mat4\s+(\w+)/g)].map((m) => m[1]);
    bag[id] = { n: 1, vsMat4: decl, corrected: entries ? [...entries.keys()].map((l) => locName.get(l)) : [], gl_Position: (src.match(/gl_Position\s*=[^;]*/) || [''])[0].slice(0, 120) };
  }
  function onDraw(gl, o, a, dn) {
    const now = performance.now();
    if (!cur || (IN_WORKER && now - lastDrawT > 6 && cur.pushed)) newFrame(now); // workers may not use rAF: a 6 ms gap = a new frame
    lastDrawT = now;
    if (!cur.pushed) { cur.pushed = true; G.idleFrames--; G.frames.push(cur); if (G.frames.length > 600) G.frames.shift(); }
    cur.draws++;
    const s = S(gl);
    if (dn.includes('Instanced')) cur.instanced++;
    if (!s.fbo) cur.drawsDefault++; else { const key = String((s.fboTex.get(s.fbo) || ['?', '?']).join('x')); cur.drawsFbo[key] = (cur.drawsFbo[key] || 0) + 1; }
    const pm = s.prog && progClip.get(s.prog);
    let clipEntries = pm && pm.size ? pm : null;
    if (clipEntries) { let any = false; for (const m of clipEntries.values()) if (m.inVS) { any = true; break; } if (!any) clipEntries = null; }
    if (clipEntries) cur.clipDraws++; else cur.noClipDraws++;
    if (cfg.mode !== 'stereo' || !clipEntries || !isScreen(gl, s)) {
      if (cfg.mode === 'stereo') { G.stereoStats.single++; if (isScreen(gl, s)) noteProg('singleScreen', s.prog, null); }
      return o.apply(gl, a);
    }
    noteProg('doubled', s.prog, clipEntries);
    // convergence: clip-space w of this draw's origin (MVP) or a fixed number
    if (cfg.conv === 'auto') {
      for (const m of clipEntries.values()) {
        if (wSamples.length >= 4096) break;
        if (m[15] > 1e-6) { wSamples.push(m[15]); break; } // MVP: clip w of the draw's origin
        const pa = progAff.get(s.prog); let best = 0; // P separate: view depth of the origin from a model-view
        if (pa) for (const a of pa.values()) if (-a[14] > best) best = -a[14];
        if (best > 0) wSamples.push(best);
        break;
      }
    }
    const C = cfg.conv === 'auto' ? (convC || 10) : +cfg.conv;
    const e = cfg.sep * C; // eye offset proportional to the convergence distance (a fixed angular parallax)
    const vp = s.viewport, sc = s.scissor;
    try {
      const viaVp = cfg.shiftVia !== 'matrix';
      let p00 = 0; for (const m of clipEntries.values()) if (m.inVS !== false) { p00 = Math.hypot(m[0], m[4], m[8]) / (Math.hypot(m[3], m[7], m[11]) || 1); break; }
      const saveSkew = cfg.noSkew; if (viaVp) cfg.noSkew = true;
      for (let eye = 0; eye < 2; eye++) {
        const sign = eye === 0 ? 1 : -1; // moving the VERTICES by +e = moving the camera by -e: the left eye (left half) moves vertices right
        for (const [loc, m] of clipEntries) gl.__raw_m4(loc, eyeMatrix(m, sign * e, C, eye ? tmpR : tmpL));
        const W = s.fbo ? s.fboTex.get(s.fbo)[0] : gl.drawingBufferWidth;
        // the convergence term (-k * row3 = a constant NDC shift of -k) applied as a viewport offset,
        // so the projection's [2][0] slot (engines keep their TAA jitter there) is never touched
        const k = saveSkew ? 0 : p00 * sign * e / C;
        const dx = viaVp ? -k * (vp[2] / 2) / 2 : 0;
        gl.__raw_viewport(eye * W / 2 + vp[0] / 2 + dx, vp[1], vp[2] / 2, vp[3]);
        // keep each eye in its half (and inside the page's own scissor box when it has one)
        let x0 = eye * W / 2, x1 = x0 + W / 2, y0 = 0, y1 = s.fbo ? s.fboTex.get(s.fbo)[1] : gl.drawingBufferHeight;
        if (s.scissorOn) { x0 = Math.max(x0, eye * W / 2 + sc[0] / 2); x1 = Math.min(x1, eye * W / 2 + (sc[0] + sc[2]) / 2); y0 = sc[1]; y1 = sc[1] + sc[3]; }
        if (viaVp || s.scissorOn) { if (!s.scissorOn) gl.__raw_enable(gl.SCISSOR_TEST); gl.__raw_scissor(x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0)); }
        o.apply(gl, a);
      }
      cfg.noSkew = saveSkew;
    } finally {
      for (const [loc, m] of clipEntries) gl.__raw_m4(loc, m);
      gl.__raw_viewport(vp[0], vp[1], vp[2], vp[3]);
      if (s.scissorOn) gl.__raw_scissor(sc[0], sc[1], sc[2], sc[3]);
      else if (cfg.shiftVia !== 'matrix') { gl.__raw_disable(gl.SCISSOR_TEST); gl.__raw_scissor(sc[0], sc[1], sc[2], sc[3]); }
    }
    G.stereoStats.doubled++; if (s.fbo) G.stereoStats.fboDoubled++;
  }
  // once per frame: update the auto convergence from this frame's samples (median)
  if (cfg.mode === 'stereo' && cfg.conv === 'auto') {
    const tick = () => {
      if (wSamples.length) {
        wSamples.sort((x, y) => x - y); const med = wSamples[wSamples.length >> 1];
        convC = convC ? convC + 0.25 * (med - convC) : med; wSamples.length = 0;
        if (G.stereoStats.convSamples.length < 50) G.stereoStats.convSamples.push(+convC.toPrecision(4));
      }
      RAF(tick);
    };
    RAF(tick);
  }

  wrapProto(W.WebGLRenderingContext && WebGLRenderingContext.prototype);
  wrapProto(W.WebGL2RenderingContext && WebGL2RenderingContext.prototype);

  // extensions: count instanced / multi-draw use (the stereo path does NOT double these: noted)
  try {
    const wrapGE = (P) => { const ge = P.getExtension; P.getExtension = function (n) { const x = ge.call(this, n); try { if (x && /multi_draw/i.test(n) && !x.__glp) { x.__glp = 1; for (const k of Object.keys(Object.getPrototypeOf(x))) if (/^multiDraw/.test(k) && typeof x[k] === 'function') { const f = x[k]; x[k] = function () { cur.multiDraw++; return f.apply(this, arguments); }; } } if (x && n === 'ANGLE_instanced_arrays' && !x.__glp) { x.__glp = 1; for (const k of ['drawArraysInstancedANGLE', 'drawElementsInstancedANGLE']) { const f = x[k]; const gl = this; x[k] = function () { cur.instanced++; return onDraw(gl, { apply: (_, args) => f.apply(x, args) }, arguments, k + 'Instanced'); }; } } (G.ext || (G.ext = {}))[n] = !!x; } catch (e) { err(e); } return x; }; };
    if (W.WebGLRenderingContext) wrapGE(WebGLRenderingContext.prototype); if (W.WebGL2RenderingContext) wrapGE(WebGL2RenderingContext.prototype);
  } catch (e) { err(e); }

  // summary for the probe
  G.summary = (lastN = 60) => {
    const fs = G.frames.filter((f) => f.draws > 0).slice(-lastN);
    const avg = (k) => fs.length ? +(fs.reduce((a, f) => a + f[k], 0) / fs.length).toFixed(1) : 0;
    const fbo = {}; for (const f of fs) for (const [k, v] of Object.entries(f.drawsFbo)) fbo[k] = (fbo[k] || 0) + v;
    for (const k of Object.keys(fbo)) fbo[k] = +(fbo[k] / fs.length).toFixed(1);
    const vps = new Set(); const progs = new Set(); for (const f of fs) { f.viewports.forEach((v) => vps.add(v)); f.programs.forEach((p) => progs.add(p)); }
    const ts = fs.map((f) => f.ts); const dt = ts.length > 1 ? (ts[ts.length - 1] - ts[0]) / (ts.length - 1) : 0;
    return {
      href: String(location.href).slice(0, 140), inWorker: IN_WORKER, contexts: G.contexts, workers: G.workers, offscreen: G.offscreen, offscreenMore: G.offscreenMore, transfers: G.transfers, transferred: G.transferred, workerReports: G.workerReports, unseen: G.checkUnseen(),
      canvases: IN_WORKER ? [] : [...document.querySelectorAll('canvas')].map((c, i) => { const r = c.getBoundingClientRect(); let z = ''; let el = c; for (let k = 0; k < 6 && el; k++, el = el.parentElement) { const cs = getComputedStyle(el); if (cs.zIndex !== 'auto') { z += k + ':' + cs.zIndex + ' '; } } return { i, w: c.width, h: c.height, rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], z, vis: getComputedStyle(c).visibility, op: getComputedStyle(c).opacity, pe: getComputedStyle(c).pointerEvents }; }),
      framesWithDraws: fs.length, idleFrames: G.idleFrames, totalDrawFrames: G.frames.length, frameMsAvg: +dt.toFixed(1), perFrame: { draws: avg('draws'), drawsDefault: avg('drawsDefault'), clipDraws: avg('clipDraws'), noClipDraws: avg('noClipDraws'), clears: avg('clears'), bindFbo: avg('bindFbo'),
        useProgram: avg('useProgram'), uniformMatrix4fv: avg('m4'), uboUploads: avg('ubo'), uboBytes: avg('uboBytes'), uniform4fvMat: avg('v4arr'), readPixels: avg('readPixels'), multiDraw: avg('multiDraw'), instanced: avg('instanced'), cpuMs: avg('cpuMs') },
      drawsPerFboSize: fbo, viewports: [...vps], distinctPrograms: progs.size, shaders: G.shaders, ext: G.ext,
      mat4: Object.fromEntries(Object.entries(G.mat4).sort((a, b) => b[1].n - a[1].n).slice(0, 25)), stereo: G.stereoStats, errors: G.errors,
    };
  };
})();

// Recon helper: records the draw sequence of ONE frame on every WebGL context of the page
// (program, target framebuffer + its size, clip-matrix uniforms, bound textures and where they come
// from, viewport, blend/depth state). Arm with window.__trace.arm(); read window.__trace.out.
(() => {
  if (self.__trace) return;
  const T = (self.__trace = { armed: false, out: null, ctxs: 0 });
  const progId = new WeakMap(), vsSrc = new WeakMap(), shType = new WeakMap(), shSrc = new WeakMap(), locName = new WeakMap();
  const fboInfo = new WeakMap(), texInfo = new WeakMap();
  const st = new WeakMap();
  let pid = 0, tid = 0, fid = 0;
  const S = (gl) => { let s = st.get(gl); if (!s) st.set(gl, (s = { id: ++T.ctxs, prog: null, fbo: null, unit: 0, units: {}, vp: null, m4: new WeakMap() })); return s; };
  const wrap = (P, n, f) => { const o = P[n]; if (!o) return; P[n] = function () { return f.call(this, o, arguments); }; };
  let frame = null;
  const RAF = self.requestAnimationFrame && self.requestAnimationFrame.bind(self);
  T.arm = () => { T.armed = true; frame = null; T.out = null; };
  const flush = () => { if (frame && frame.draws.length) { T.out = frame; T.armed = false; } frame = null; };
  if (RAF) { const loop = () => { if (T.armed) { if (frame) flush(); if (T.armed) frame = { t: performance.now(), draws: [] }; } RAF(loop); }; RAF(loop); }
  const isClip = (m) => !(Math.abs(m[3]) < 1e-6 && Math.abs(m[7]) < 1e-6 && Math.abs(m[11]) < 1e-6 && Math.abs(m[15] - 1) < 1e-6);
  for (const P of [self.WebGLRenderingContext && WebGLRenderingContext.prototype, self.WebGL2RenderingContext && WebGL2RenderingContext.prototype]) {
    if (!P) continue;
    wrap(P, 'createProgram', function (o, a) { const p = o.apply(this, a); progId.set(p, ++pid); return p; });
    wrap(P, 'createShader', function (o, a) { const s = o.apply(this, a); shType.set(s, a[0]); return s; });
    wrap(P, 'shaderSource', function (o, a) { shSrc.set(a[0], String(a[1])); return o.apply(this, a); });
    wrap(P, 'attachShader', function (o, a) { if (shType.get(a[1]) === 0x8B31) vsSrc.set(a[0], shSrc.get(a[1]) || ''); return o.apply(this, a); });
    wrap(P, 'getUniformLocation', function (o, a) { const l = o.apply(this, a); if (l) locName.set(l, a[1]); return l; });
    wrap(P, 'useProgram', function (o, a) { S(this).prog = a[0]; return o.apply(this, a); });
    wrap(P, 'createFramebuffer', function (o, a) { const f = o.apply(this, a); fboInfo.set(f, { id: ++fid, color: null }); return f; });
    wrap(P, 'createTexture', function (o, a) { const t = o.apply(this, a); texInfo.set(t, { id: ++tid, w: 0, h: 0, src: '' }); return t; });
    wrap(P, 'bindFramebuffer', function (o, a) { if (a[0] !== 0x8CA8) S(this).fbo = a[1]; return o.apply(this, a); });
    wrap(P, 'activeTexture', function (o, a) { S(this).unit = a[0] - 0x84C0; return o.apply(this, a); });
    wrap(P, 'bindTexture', function (o, a) { S(this).units[S(this).unit] = a[1]; return o.apply(this, a); });
    wrap(P, 'texImage2D', function (o, a) { const t = S(this).units[S(this).unit], i = t && texInfo.get(t); if (i) { if (a.length >= 8) { i.w = a[3]; i.h = a[4]; i.src = 'data'; } else { const s = a[5]; i.w = s && s.width; i.h = s && s.height; i.src = s && s.constructor && s.constructor.name; } i.up = (i.up || 0) + 1; } return o.apply(this, a); });
    wrap(P, 'texSubImage2D', function (o, a) { const t = S(this).units[S(this).unit], i = t && texInfo.get(t); if (i) { const s = a.length >= 9 ? null : a[6]; i.sub = (s && s.constructor && s.constructor.name) || 'data'; i.up = (i.up || 0) + 1; } return o.apply(this, a); });
    wrap(P, 'texStorage2D', function (o, a) { const t = S(this).units[S(this).unit], i = t && texInfo.get(t); if (i) { i.w = a[3]; i.h = a[4]; i.src = 'storage'; } return o.apply(this, a); });
    wrap(P, 'framebufferTexture2D', function (o, a) { const s = S(this), f = s.fbo && fboInfo.get(s.fbo), ti = a[3] && texInfo.get(a[3]); if (f && ti) { if (a[1] === 0x8CE0) { f.color = ti; ti.fbo = f.id; } } return o.apply(this, a); });
    wrap(P, 'viewport', function (o, a) { S(this).vp = [a[0], a[1], a[2], a[3]].join(','); return o.apply(this, a); });
    wrap(P, 'uniformMatrix4fv', function (o, a) { const s = S(this); if (s.prog && a[2] && a[2].length >= 16 && a[0]) { let m = s.m4.get(s.prog); if (!m) s.m4.set(s.prog, (m = {})); m[locName.get(a[0])] = isClip(a[2]) ? 'clip w0=' + (+a[2][15]).toPrecision(4) : 'aff'; } return o.apply(this, a); });
    for (const dn of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements']) {
      wrap(P, dn, function (o, a) {
        if (frame && frame.draws.length < 400) {
          const s = S(this), f = s.fbo && fboInfo.get(s.fbo);
          const tex = Object.entries(s.units).filter(([, t]) => t).map(([u, t]) => { const i = texInfo.get(t) || {}; return `u${u}:t${i.id}${i.fbo ? '(fbo' + i.fbo + ')' : ''}${i.w}x${i.h}${i.src ? ':' + i.src : ''}${i.sub ? '/' + i.sub : ''}`; }).join(' ');
          frame.draws.push({ ctx: s.id, dn, n: a[1], prog: progId.get(s.prog), gl: ((vsSrc.get(s.prog) || '').match(/gl_Position\s*=[^;]*/) || [''])[0].slice(0, 60), fbo: f ? f.id + ':' + (f.color ? f.color.w + 'x' + f.color.h : '?') : 'default', vp: s.vp, m4: JSON.stringify(s.m4.get(s.prog) || {}), tex: tex.slice(0, 220), blend: this.isEnabled(this.BLEND), depth: this.isEnabled(this.DEPTH_TEST) });
        }
        return o.apply(this, a);
      });
    }
  }
})();

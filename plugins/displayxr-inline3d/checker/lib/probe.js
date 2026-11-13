// inline3d-check — in-page probe, injected at document start in EVERY run (fake and plain).
// Records what the harness cannot see from outside: WebGL contexts per canvas, shader/program
// compile failures, and helpers the harness calls (CSS audit, occlusion audit). It changes no
// page behaviour except the MAX_TEXTURE_SIZE simulation when the harness asks for one.
(() => {
  if (window.__dxrProbe) return;
  const CFG = window.__DXR_CHECK_CFG || {};
  const P = (window.__dxrProbe = { contexts: new WeakMap(), shaderErrors: [], glCanvases: [] });

  // ---- contexts per canvas (to read drawingBufferWidth later without guessing the type) -------
  const origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    const ctx = origGetContext.call(this, type, attrs);
    if (ctx && !P.contexts.has(this)) {
      P.contexts.set(this, { type, ctx, attrs: attrs ? { ...attrs } : null });
      if (/webgl/.test(type)) P.glCanvases.push(this);
    }
    return ctx;
  };

  // ---- shader / program failures: engines always query the status, so this costs nothing -----
  const LIMIT = CFG.maxTextureSize || 0;
  for (const C of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    if (!C) continue;
    const proto = C.prototype;
    const gsp = proto.getShaderParameter;
    proto.getShaderParameter = function (sh, pname) {
      const v = gsp.call(this, sh, pname);
      if (pname === this.COMPILE_STATUS && v === false && !this.isContextLost()) {
        let log = '';
        try { log = this.getShaderInfoLog(sh) || ''; } catch { /* lost */ }
        P.shaderErrors.push(('shader compile failed: ' + log).slice(0, 400));
      }
      return v;
    };
    const gpp = proto.getProgramParameter;
    proto.getProgramParameter = function (pr, pname) {
      const v = gpp.call(this, pr, pname);
      if (pname === this.LINK_STATUS && v === false && !this.isContextLost()) {
        let log = '';
        try { log = this.getProgramInfoLog(pr) || ''; } catch { /* lost */ }
        P.shaderErrors.push(('program link failed: ' + log).slice(0, 400));
      }
      return v;
    };
    if (LIMIT) {
      // The tablet's limits, so the SDK's own clamp logic (and the page's) sees what it would see
      // there. The real clamp comes from Chrome's --webgl_or_caps_max_texture_size_limit_4096.
      const gp = proto.getParameter;
      proto.getParameter = function (pname) {
        const v = gp.call(this, pname);
        if (pname === this.MAX_TEXTURE_SIZE || pname === this.MAX_RENDERBUFFER_SIZE) return Math.min(v, LIMIT);
        if (pname === this.MAX_VIEWPORT_DIMS && v && v.length === 2) return new Int32Array([Math.min(v[0], LIMIT), Math.min(v[1], LIMIT)]);
        return v;
      };
    }
  }

  // ---- helpers the harness calls -------------------------------------------------------------
  function selectorOf(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.id) return `#${CSS.escape(el.id)}`;
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && e !== document.documentElement; e = e.parentElement) {
      if (e.id) { parts.unshift(`#${CSS.escape(e.id)}`); break; }
      const tag = e.tagName.toLowerCase();
      const sib = e.parentElement ? [...e.parentElement.children].filter((c) => c.tagName === e.tagName) : [];
      parts.unshift(sib.length > 1 ? `${tag}:nth-of-type(${sib.indexOf(e) + 1})` : tag);
    }
    return parts.join(' > ');
  }
  P.selectorOf = selectorOf;

  function rectOf(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }
  P.rectOf = rectOf;

  function isIdentityishTransform(t) {
    if (!t || t === 'none') return true;
    // A pure translation (incl. the SDK's own translateZ(0)) is fine: rule 7 allows a static translate.
    try {
      const m = new DOMMatrixReadOnly(t);
      const eps = 1e-4;
      const lin = [m.m11 - 1, m.m12, m.m13, m.m14, m.m21, m.m22 - 1, m.m23, m.m24, m.m31, m.m32, m.m33 - 1, m.m34, m.m44 - 1];
      return lin.every((x) => Math.abs(x) < eps);
    } catch {
      return false;
    }
  }

  // Rule 7 (no render-surface effects on a woven canvas or any ancestor) + own-box decoration.
  P.cssAudit = function (canvas) {
    const problems = [];
    const decorations = [];
    const animations = [];
    for (let el = canvas; el && el.nodeType === 1; el = el.parentElement) {
      const cs = getComputedStyle(el);
      const who = el === canvas ? 'the canvas' : `ancestor ${selectorOf(el)}`;
      const push = (prop, val) => problems.push({ element: selectorOf(el), self: el === canvas, prop, value: val, text: `${prop}: ${val} on ${who}` });
      if (cs.filter && cs.filter !== 'none') push('filter', cs.filter);
      if (parseFloat(cs.opacity) < 0.999) push('opacity', cs.opacity);
      const bf = cs.backdropFilter || cs.webkitBackdropFilter;
      if (bf && bf !== 'none') push('backdrop-filter', bf);
      const mask = cs.maskImage || cs.webkitMaskImage;
      if (mask && mask !== 'none') push('mask', mask);
      if (cs.clipPath && cs.clipPath !== 'none') push('clip-path', cs.clipPath);
      if (cs.mixBlendMode && cs.mixBlendMode !== 'normal') push('mix-blend-mode', cs.mixBlendMode);
      if (!isIdentityishTransform(cs.transform)) push('transform', cs.transform);
      if (cs.perspective && cs.perspective !== 'none' && el !== canvas) push('perspective', cs.perspective);
      if (el === canvas) {
        if (parseFloat(cs.borderTopLeftRadius) > 0 || parseFloat(cs.borderBottomRightRadius) > 0) decorations.push(`border-radius: ${cs.borderRadius}`);
        if (cs.boxShadow && cs.boxShadow !== 'none') decorations.push(`box-shadow: ${cs.boxShadow}`);
        const bw = ['Top', 'Right', 'Bottom', 'Left'].map((s) => parseFloat(cs[`border${s}Width`]) || 0);
        if (bw.some((w) => w > 0)) decorations.push(`border: ${bw.join('/')} px`);
      }
      try {
        for (const a of el.getAnimations()) {
          const kf = a.effect && a.effect.getKeyframes ? a.effect.getKeyframes() : [];
          const props = new Set();
          for (const k of kf) for (const p of Object.keys(k)) if (!['offset', 'easing', 'composite', 'computedOffset'].includes(p)) props.add(p);
          if (a.transitionProperty) props.add(a.transitionProperty);
          const moving = [...props].filter((p) => /transform|translate|scale|rotate|opacity|filter|width|height|left|top|right|bottom|inset|clip/i.test(p));
          if (moving.length && a.playState === 'running') animations.push({ element: selectorOf(el), props: moving });
        }
      } catch { /* no getAnimations */ }
    }
    return { problems, decorations, animations };
  };

  // What paints over the canvas (rule 9 / rule 5): hit-test a grid with pointer-events forced on
  // (a cover with pointer-events:none still paints), walk each hit list from the top down to the
  // canvas, and classify what sits above it.
  function opaqueBox(el) {
    const tag = el.tagName;
    if (tag === 'IMG' || tag === 'VIDEO' || tag === 'CANVAS' || tag === 'svg' || tag === 'IFRAME' || tag === 'PICTURE') return true;
    const cs = getComputedStyle(el);
    if (cs.backgroundImage && cs.backgroundImage !== 'none') return true;
    const m = /rgba?\(([^)]+)\)/.exec(cs.backgroundColor || '');
    if (!m) return false;
    const parts = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    const a = parts.length >= 4 ? parts[3] : 1;
    return a >= 0.9;
  }
  P.occlusionAudit = function (canvas, cols = 9, rows = 6) {
    const style = document.createElement('style');
    style.textContent = '*{pointer-events:auto !important}';
    document.documentElement.appendChild(style);
    const r = canvas.getBoundingClientRect();
    const vw = innerWidth, vh = innerHeight;
    let total = 0, opaque = 0, frost = 0, offscreen = 0;
    const coverers = new Map();
    const effects = new Map(); // overlapping chrome the draw-order split cannot lift as a plain quad
    try {
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const x = r.left + ((i + 0.5) / cols) * r.width;
          const y = r.top + ((j + 0.5) / rows) * r.height;
          if (x < 0 || y < 0 || x >= vw || y >= vh) { offscreen++; continue; }
          total++;
          const list = document.elementsFromPoint(x, y);
          let covered = false, frosted = false;
          for (const el of list) {
            if (el === canvas) break;
            if (el.contains(canvas)) continue; // an ancestor paints below its descendants
            const cs = getComputedStyle(el);
            const bf = cs.backdropFilter || cs.webkitBackdropFilter;
            if (bf && bf !== 'none') frosted = true;
            const fx = [];
            if (cs.filter && cs.filter !== 'none') fx.push(`filter: ${cs.filter}`);
            if (cs.mixBlendMode && cs.mixBlendMode !== 'normal') fx.push(`mix-blend-mode: ${cs.mixBlendMode}`);
            if (cs.transformStyle === 'preserve-3d') fx.push('transform-style: preserve-3d');
            if (fx.length) effects.set(selectorOf(el), fx.join(', '));
            if (opaqueBox(el)) {
              covered = true;
              const s = selectorOf(el);
              coverers.set(s, (coverers.get(s) || 0) + 1);
              break;
            }
          }
          if (!list.includes(canvas) && !covered) {
            // The canvas is not hit at all here (visibility:hidden, or under a non-opaque box that
            // still swallowed the hit list): treat as covered by whatever is on top.
            const top = list[0];
            if (top && !top.contains(canvas)) {
              covered = true;
              const s = selectorOf(top);
              coverers.set(s, (coverers.get(s) || 0) + 1);
            }
          }
          if (covered) opaque++;
          if (frosted) frost++;
        }
      }
    } finally {
      style.remove();
    }
    const cs = getComputedStyle(canvas);
    return {
      total, opaque, frost, offscreen,
      coveredFraction: total ? opaque / total : 0,
      frostFraction: total ? frost / total : 0,
      coverers: [...coverers.entries()].sort((a, b) => b[1] - a[1]).map(([selector, hits]) => ({ selector, hits })),
      effects: [...effects.entries()].map(([selector, props]) => ({ selector, props })),
      visible: r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden',
      rect: { x: r.left, y: r.top, width: r.width, height: r.height },
    };
  };

  // Media elements big enough to show a picture (for the "raw side-by-side shown flat" scan).
  P.mediaElements = function (exclude = []) {
    const out = [];
    for (const el of document.querySelectorAll('img, video, canvas')) {
      if (exclude.includes(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 120 || r.height < 60) continue;
      if (r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) continue;
      out.push({ selector: selectorOf(el), tag: el.tagName.toLowerCase(), rect: { x: r.left, y: r.top, width: r.width, height: r.height } });
    }
    return out;
  };

  P.bufferInfo = function (canvas) {
    const rec = P.contexts.get(canvas);
    const info = { width: canvas.width, height: canvas.height, contextType: rec ? rec.type : null, drawingBufferWidth: null, drawingBufferHeight: null, maxTextureSize: null, preserveDrawingBuffer: null };
    if (rec && /webgl/.test(rec.type)) {
      const gl = rec.ctx;
      info.drawingBufferWidth = gl.drawingBufferWidth;
      info.drawingBufferHeight = gl.drawingBufferHeight;
      try { info.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE); } catch { /* lost */ }
      try { const a = gl.getContextAttributes(); info.preserveDrawingBuffer = a ? a.preserveDrawingBuffer : null; } catch { /* lost */ }
    }
    return info;
  };
})();

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
// before close() nor the next few is a side-by-side pair (unless the cover hides the canvas).
// Everything the harness asserts on is on window.__fakeXR.
//
// window.__fakeXROpts (per case):
//   viewsAfterMs: N   frames carry NO views until N ms after the layer was created (Infinity: never)
//                     — nobody tracked yet / a runtime with nothing to locate eyes for yet.
//   noDisplayApi: true  the layer has no getDisplayInfo / getRenderingModes (an older build), so the
//                     shim cannot tell "no display" from "no eyes yet" and relies on its eye timeout.
(() => {
  const SKEW = 0.1;
  const OPTS = window.__fakeXROpts || {};
  const CANVAS_W = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width');
  const CANVAS_H = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'height');
  const H = (window.__fakeXR = { skew: SKEW, sessions: [], sessionObjs: [], layers: [], rigPushes: 0, lastRig: null, frames: 0, renderStates: [], closes: [], committed: null, history: [], watch: null });
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
      const c = H.watch;
      if (!c) return;
      let s = null;
      try { s = snap(c); } catch (e) { return; }
      H.committed = s;
      H.history.push(s); if (H.history.length > 12) H.history.shift();
      for (const cl of H.closes) if (cl.after.length < 8) cl.after.push(s);
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

  class FakeLayer {
    constructor(session, canvas, opts) {
      this.session = session; this.canvas = canvas; this.closed = false;
      this.rig = opts && opts.viewRig ? JSON.parse(JSON.stringify(opts.viewRig)) : null;
      session._layer = this;
      H.watch = canvas;
      H.layers.push({ canvas: canvas.id || canvas.tagName, opts: JSON.parse(JSON.stringify(opts || {})), at: performance.now(), coverAtCreate: coverUp(), closedAt: null });
      this._rec = H.layers[H.layers.length - 1];
      if (this.rig) H.lastRig = this.rig;
      if (OPTS.noDisplayApi) { this.getDisplayInfo = undefined; this.getRenderingModes = undefined; }
    }
    setViewRig(rig) { this.rig = JSON.parse(JSON.stringify(rig)); H.lastRig = this.rig; H.rigPushes++; }
    getDisplayInfo() { return Promise.resolve({ fake: true, displayPixelWidth: 3840, displayPixelHeight: 2160 }); }
    getRenderingModes() { return Promise.resolve([{ name: 'fake-stereo', viewCount: 2 }]); }
    close() {
      if (this.closed) return;
      this.closed = true;
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
      return window.requestAnimationFrame((t) => { if (!this.ended) cb(t, this._frame()); });
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
      const aspect = w / 2 / (h || 1);
      const vfov = L && L.rig && L.rig.verticalFov ? L.rig.verticalFov : (50 * Math.PI) / 180;
      const { depthNear: n, depthFar: f } = this.renderState;
      if (OPTS.viewsAfterMs && (!L || performance.now() - L._rec.at < OPTS.viewsAfterMs)) { H.noViewFrames = (H.noViewFrames || 0) + 1; return { session: this, getViewerPose: () => ({ views: [] }) }; }
      const views = [+SKEW, -SKEW].map((s, i) => ({
        eye: i ? 'right' : 'left',
        projectionMatrix: proj(vfov, aspect, n, f, s),
        transform: { matrix: IDENTITY.slice() },
      }));
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

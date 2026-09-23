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
// Everything the harness asserts on is on window.__fakeXR.
(() => {
  const SKEW = 0.1;
  const CANVAS_W = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width');
  const CANVAS_H = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'height');
  const H = (window.__fakeXR = { skew: SKEW, sessions: [], layers: [], rigPushes: 0, lastRig: null, frames: 0, renderStates: [] });

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
      H.layers.push({ canvas: canvas.id || canvas.tagName, opts: JSON.parse(JSON.stringify(opts || {})) });
      if (this.rig) H.lastRig = this.rig;
    }
    setViewRig(rig) { this.rig = JSON.parse(JSON.stringify(rig)); H.lastRig = this.rig; H.rigPushes++; }
    getDisplayInfo() { return Promise.resolve({ fake: true, displayPixelWidth: 3840, displayPixelHeight: 2160 }); }
    getRenderingModes() { return Promise.resolve([{ name: 'fake-stereo', viewCount: 2 }]); }
    close() { this.closed = true; }
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
      return Promise.resolve(s);
    },
  });
  Object.defineProperty(navigator, 'xr', { value: xr, configurable: true });
})();

// DisplayXR auto-3D — PlayCanvas adapter. PROTOTYPE, not a product.
//
// Loaded after core.js (manifest.json: core.js → three-adapter.js → playcanvas-adapter.js), in the
// page's MAIN world at document_start. Turns an existing PlayCanvas (engine 2.x, WebGL2) page into
// a woven inline-3D window with no change to the page and WITHOUT the engine's XrManager: the
// page's own camera renders both eyes through the engine's RenderView path — the same recipe
// @displayxr/inline3d's PlayCanvas splat backend uses (js/inline3d-splat-playcanvas.js):
// `camera.camera.xrViews = [RenderView, RenderView]`, each view = the runtime's projection +
// eye pose, viewport = its half of the side-by-side (SBS) backing store, and the camera's
// fov/aspect/near/far from `setXrProperties` so LOD and culling see the frustum the views have.
//
// Finding the app (first hit wins, all armed at document_start):
//   1. `window.pc` — a UMD / editor build: `pc.app`, `pc.AppBase.getApplication()`. The global is
//      watched with an accessor, so it is seen the moment the engine script assigns it.
//   2. `window.app` when it is an AppBase (supersplat-viewer with exposeGlobals, many demos).
//   3. ESM bundles with NO global: the AppBase constructor's first statement is
//      `AppBase._applications[canvas.id] = this` — a plain-object store keyed by the canvas id. The
//      canvas `id` read is observed (Element.prototype.id getter, canvases only) and a one-shot
//      setter for exactly that key is put on Object.prototype for the rest of that task; the
//      assignment lands on it and hands us `this`, the app. The trap is removed in the same
//      microtask checkpoint and the property is re-created as an ordinary own property, so the
//      engine's store is unchanged. Nothing else in the engine is reachable from a bare canvas: the
//      tick is a closure, the device is created after the constructor and holds no back-pointer,
//      input handlers are bound functions (see README "What the PlayCanvas adapter cannot see").
//
// What it stands down on (flat, with the reason on the HUD): a WebGPU device, several cameras
// rendering to the canvas (a UI camera, picture-in-picture), post effects / CameraFrame (frame
// passes) on the camera, an orthographic camera, an app presenting WebXR through app.xr, and —
// via the core — SDK / WebXR pages.
(() => {
  'use strict';
  const core = window[Symbol.for('dxr.auto3d.core')];
  if (!core || core.meta.playcanvasAdapter) return;
  core.meta.playcanvasAdapter = true;
  core.registerEngine('PlayCanvas');
  const { info, warnOnce, desc, realW, realH } = core;
  const cfg = () => core.cfg;
  const DEG = Math.PI / 180;

  const apps = new WeakMap(); // app -> state; null before the device exists, false when not convertible
  const via = new WeakMap();  // app -> how it was found
  let pcNS = null;            // the engine namespace, when the page has one (UMD / editor builds)
  core.meta.playcanvas = { detected: [] };

  // ------------------------------------------------------------ detection
  const isApp = (a) =>
    !!a && typeof a === 'object' && typeof a.tick === 'function' && typeof a.on === 'function' &&
    typeof a.fire === 'function' && 'graphicsDevice' in a && !!a.systems;

  function consider(app, how) {
    if (!isApp(app) || apps.has(app)) return;
    apps.set(app, null);
    via.set(app, how);
    core.meta.playcanvas.detected.push(how);
    info('PlayCanvas app found via', how);
    // Our handlers go on at once — the constructor trap fires before init(), before the device.
    app.on('postrender', () => onPostRender(app));
    app.on('prerender', () => onPreRender(app));
    app.on('destroy', () => { const st = apps.get(app); if (st && (st.active || st.pending || st.armed)) core.stand(st, 'the page destroyed the app'); });
  }

  function lookGlobals() {
    const pc = pcNS || window.pc;
    if (pc && typeof pc === 'object') {
      if (!pcNS && (pc.AppBase || pc.Application)) pcNS = pc;
      if (isApp(pc.app)) consider(pc.app, 'window.pc.app');
      try { const a = pc.AppBase && pc.AppBase.getApplication && pc.AppBase.getApplication(); if (a) consider(a, 'pc.AppBase.getApplication()'); } catch (e) { /* ignore */ }
    }
    try { if (isApp(window.app)) consider(window.app, 'window.app'); } catch (e) { /* ignore */ }
  }

  // 1. window.pc — an accessor, so a UMD build's `pc = …` / `global.pc = …` is seen immediately.
  try {
    if (!('pc' in window)) {
      let pcVal;
      Object.defineProperty(window, 'pc', {
        configurable: true, enumerable: true,
        get: () => pcVal,
        set: (v) => { pcVal = v; setTimeout(lookGlobals, 0); },
      });
    }
  } catch (e) { /* ignore */ }
  // 2. polling for window.app / pc.app (set after the page's own boot code runs).
  let polls = 0;
  const poll = () => { lookGlobals(); if (++polls < 40) setTimeout(poll, 500); };
  setTimeout(poll, 0);
  document.addEventListener('DOMContentLoaded', lookGlobals);
  window.addEventListener('load', lookGlobals);

  // 3. ESM bundles: the constructor's `_applications[canvas.id] = this`.
  const ID = Object.getOwnPropertyDescriptor(Element.prototype, 'id');
  const traps = new Set();
  function removeTrap(key) {
    if (!traps.has(key)) return;
    traps.delete(key);
    try { delete Object.prototype[key]; } catch (e) { /* ignore */ }
  }
  function trapKey(key) {
    if (typeof key !== 'string' || traps.has(key) || key === '__proto__' || key in Object.prototype) return;
    traps.add(key);
    try {
      Object.defineProperty(Object.prototype, key, {
        configurable: true, enumerable: false,
        get() { return undefined; },
        set(v) {
          removeTrap(key);
          Object.defineProperty(this, key, { value: v, writable: true, enumerable: true, configurable: true });
          if (isApp(v)) consider(v, 'AppBase constructor (canvas-id trap)');
        },
      });
    } catch (e) { traps.delete(key); return; }
    queueMicrotask(() => removeTrap(key));
  }
  if (ID && ID.get) {
    try {
      Object.defineProperty(Element.prototype, 'id', {
        configurable: true, enumerable: ID.enumerable, set: ID.set,
        get() {
          const v = ID.get.call(this);
          if (this instanceof HTMLCanvasElement && cfg().enabled && !core.foreign) trapKey(v);
          return v;
        },
      });
    } catch (e) { warnOnce('pc-idtrap', 'could not watch canvas ids — ESM PlayCanvas apps without a global will not be found', e); }
  }

  // ------------------------------------------------------------ per-app state
  function stateFor(app) {
    let st = apps.get(app);
    if (st !== null && st !== undefined) return st || null; // false = seen and not convertible
    const dev = app.graphicsDevice;
    if (!dev || !app.root) return null; // still in the constructor / init
    const canvas = dev.canvas;
    if (!(canvas instanceof HTMLCanvasElement)) { warnOnce('pc-offscreen', 'PlayCanvas on an OffscreenCanvas — not supported, left 2D'); apps.set(app, false); return null; }
    st = core.newState('PlayCanvas', canvas, ad);
    Object.assign(st, {
      app, dev, depth: 0, cam: null, views: null, rvKind: null, frustumKey: '',
      L: { w: realW(canvas), h: realH(canvas), pr: 1 }, // what the PAGE believes: its mono store, in pixels
      frame: { drew: false }, footprint: { patched: 0, seen: 0 },
    });
    apps.set(app, st);
    wrapDevice(st);
    info(`PlayCanvas app on ${desc(canvas)} (${dev.isWebGPU ? 'WebGPU' : 'WebGL2'}, found via ${via.get(app)})`);
    return st;
  }

  // The engine sizes the canvas through device.setResolution (resizeCanvas / updateCanvasSize with
  // RESOLUTION_AUTO call it, every frame when the store differs from the element). While converted
  // it records what the page asked for and applies the SBS size instead. canvas.width itself is NOT
  // virtualised here: the engine reads it internally (device.width, the back-buffer resize check,
  // resizeCanvas's own compare), so it must report the real store. With the default eyeScale 0.5 the
  // SBS store IS the mono size until the 3072 cap, so a page reading canvas.width sees no change.
  function wrapDevice(st) {
    const dev = st.dev;
    const orig = dev.setResolution;
    st.setRes = (w, h) => { st.depth++; try { orig.call(dev, w, h); } finally { st.depth--; } };
    dev.setResolution = function (w, h) {
      if (!st.active || st.depth > 0) { if (!st.active) { st.L.w = w; st.L.h = h; } return orig.call(dev, w, h); }
      st.L.w = w; st.L.h = h;
      if (applyRealSize(st)) st.app.renderNextFrame = true;
    };
    // The non-square-pixel footprint fix for gaussian splats (inline3d-splat-playcanvas.js
    // patchGsplatFootprint): an SBS eye is half-width over a full-height frustum, and the engine's
    // gsplatCornerVS derives ONE focal length from the viewport width. Applied at the GL boundary
    // because ShaderChunks is not reachable from an ESM app; square pixels are unchanged by it.
    const gl = dev.gl;
    if (gl && typeof gl.shaderSource === 'function' && !dev.isWebGPU) {
      const ss = gl.shaderSource;
      gl.shaderSource = function (sh, src) {
        if (typeof src === 'string' && src.indexOf('J2') >= 0 && /vec2\s+J2\s*=/.test(src)) {
          st.footprint.seen++;
          const p = patchGsplatFootprint(src);
          if (p.ok) { st.footprint.patched++; src = p.src; }
        }
        return ss.call(this, sh, src);
      };
    }
  }
  function applyRealSize(st) {
    const R = core.realSizeFor(st.L);
    st.R = R;
    if (realW(st.canvas) === R.W && realH(st.canvas) === R.H) return false;
    st.stats.resizes++;
    st.setRes(R.W, R.H);
    return true;
  }

  // ------------------------------------------------------------ the camera
  // The ONE enabled camera that renders to the canvas, or why there is not exactly one.
  function pickCamera(app) {
    const list = (app.systems.camera && app.systems.camera.cameras) || [];
    const cams = list.filter((c) => c && c.enabled && c.entity && c.entity.enabled && !c.renderTarget);
    if (!cams.length) return { why: 'no enabled camera renders to the canvas' };
    if (cams.length > 1) return { why: `${cams.length} cameras render to the canvas (UI / multi-view) — not split in this prototype`, flat: true };
    const c = cams[0];
    if (c.projection === 1) return { why: 'the camera is orthographic', flat: true };
    const pe = c.postEffects;
    if (c.postEffectsEnabled !== false && pe && Array.isArray(pe.effects) && pe.effects.length) return { why: 'post effects on the camera — needs per-eye targets (next)', flat: true };
    const fp = c.framePasses || (c.camera && c.camera.framePasses);
    if (fp && fp.length) return { why: 'CameraFrame / frame passes on the camera — needs per-eye targets (next)', flat: true };
    return { cam: c };
  }
  // The page camera's OWN numbers (the public getters answer the XR properties while xrViews is set).
  function pageCam(st) {
    const c = st.cam.camera;
    const fov = c._fov !== undefined ? c._fov : c.fov;
    const hfov = c._horizontalFov !== undefined ? c._horizontalFov : c.horizontalFov;
    const near = c._nearClip !== undefined ? c._nearClip : c.nearClip;
    const far = c._farClip !== undefined ? c._farClip : c.farClip;
    const aspect = st.L.w / (st.L.h || 1);
    const vfov = hfov ? 2 * Math.atan(Math.tan((fov * DEG) / 2) / aspect) : fov * DEG;
    return { vfov, near, far, aspect };
  }

  // ------------------------------------------------------------ the adapter hooks the core calls
  const ad = {
    label: (st) => `PlayCanvas ${pcNS && pcNS.version ? pcNS.version : '2.x'}, ${via.get(st.app)}`,
    unqualified(st) {
      const app = st.app;
      if (st.dev.isWebGPU) return flatWhy(st, 'WebGPU device — the prototype drives WebGL2 apps only');
      if (app.xr && app.xr.active) return 'the app is presenting WebXR';
      const pick = pickCamera(app);
      if (!pick.cam) return pick.flat ? flatWhy(st, pick.why) : pick.why;
      st.flatReason = null;
      st.qualifyCam = pick.cam;
      const where = core.canvasPlacement(st.canvas);
      if (where) return where;
      if (!(st.L.w > 0 && st.L.h > 0)) return 'canvas has no size yet';
      return core.cssEffect(st.canvas);
    },
    hasCamera: (st) => !!st.cam,
    depthRange(st) { const p = pageCam(st); return { near: p.near, far: p.far }; },
    rigFov: (st) => pageCam(st).vfov,
    sampler(st) {
      if (!st.cam) return null;
      const p = pageCam(st);
      return {
        cameraPose: st.cam.entity.getWorldTransform().data,
        verticalFov: p.vfov, aspect: p.aspect, near: p.near, far: p.far,
        forEachBounds: (cb) => forEachBounds(st, cb),
      };
    },
    fakeViewParams(st) { const p = pageCam(st); return { near: p.near, far: p.far, t: p.near * Math.tan(p.vfov / 2), aspect: p.aspect }; },
    beforeActive() {},
    afterActive(st) {
      st.cam = st.qualifyCam;
      applyRealSize(st);
      bindViews(st);
    },
    firstDraw(st) { st.app.renderNextFrame = true; },
    redraw(st) {
      // Redraw every frame (woven-canvas rules): a render-on-demand app (autoRender false) is asked
      // for a frame every session frame; one that drew nothing since the last one counts as a replay.
      if (!st.frame.drew) st.stats.replays++;
      st.frame.drew = false;
      st.app.renderNextFrame = true;
    },
    restore(st, wasLive) {
      if (st.cam && st.cam.camera) { try { st.cam.camera.xrViews = null; } catch (e) { /* ignore */ } }
      st.cam = null; st.views = null; st.frustumKey = '';
      if (wasLive) {
        try { if (realW(st.canvas) !== st.L.w || realH(st.canvas) !== st.L.h) st.setRes(st.L.w, st.L.h); } catch (e) { /* ignore */ }
        st.app.renderNextFrame = true;
      }
    },
    flipIdle(st) { st.app.renderNextFrame = true; }, // flips on the postrender of that frame
    describe: (st) => ({
      page: { w: st.L.w, h: st.L.h, pr: 1 },
      extra: {
        detection: via.get(st.app), renderView: st.rvKind, camera: st.cam ? st.cam.entity.name : null,
        footprint: { ...st.footprint }, device: st.dev.isWebGPU ? 'webgpu' : 'webgl2', autoRender: st.app.autoRender,
      },
    }),
  };
  function flatWhy(st, why) {
    if (st.flatReason !== why) { st.flatReason = why; info('PlayCanvas canvas stays 2D:', why); core.hud(); }
    return why;
  }

  // ------------------------------------------------------------ frame hooks
  function onPostRender(app) {
    const st = stateFor(app);
    if (!st) return;
    st.frame.drew = true;
    if (st.active) return;
    if (st.armed) {
      const pick = pickCamera(app);
      if (!pick.cam) { core.stand(st, pick.why); if (pick.flat) flatWhy(st, pick.why); return; }
      st.qualifyCam = pick.cam;
      core.flip(st); // this task just drew the mono frame: it is the cover
      return;
    }
    core.considerActivation(st);
  }
  function onPreRender(app) {
    const st = stateFor(app); // created here at the latest: before the first frame compiles any shader
    if (!st || !st.active) return;
    const pick = pickCamera(app);
    if (pick.cam !== st.cam) {
      const why = pick.cam ? 'the page switched cameras' : pick.why;
      core.stand(st, why);
      if (pick.flat) flatWhy(st, pick.why);
      st.nextTry = core.now() + 1000;
      return;
    }
    updateViews(st);
  }

  // ------------------------------------------------------------ the per-eye path
  // RenderView from the engine namespace when there is one, else an exact copy of the engine's
  // class (src/scene/render-view.js, MIT) built on the engine's OWN Mat4 / Vec4, reached from
  // live instances — an ESM app gives us no namespace.
  function makeViews(st) {
    if (pcNS && typeof pcNS.RenderView === 'function') { st.rvKind = 'engine'; return [new pcNS.RenderView(), new pcNS.RenderView()]; }
    const M4 = st.app.root.getWorldTransform().constructor;
    const V4 = st.cam.rect.constructor;
    const nm = st.app.root._normalMatrix;
    const M3 = nm && typeof nm.setFromMat4 === 'function' ? nm.constructor : null;
    const mat3 = () => (M3 ? new M3() : {
      data: new Float32Array(9),
      setFromMat4(m) { const s = m.data, d = this.data; d[0] = s[0]; d[1] = s[1]; d[2] = s[2]; d[3] = s[4]; d[4] = s[5]; d[5] = s[6]; d[6] = s[8]; d[7] = s[9]; d[8] = s[10]; return this; },
    });
    class RenderView {
      constructor() {
        this._positionData = new Float32Array(3); this._viewport = new V4(); this._projMat = new M4();
        this._projViewOffMat = new M4(); this._viewMat = new M4(); this._viewOffMat = new M4();
        this._viewMat3 = mat3(); this._viewInvMat = new M4(); this._viewInvOffMat = new M4();
      }
      get viewport() { return this._viewport; }
      get projMat() { return this._projMat; }
      get projViewOffMat() { return this._projViewOffMat; }
      get viewOffMat() { return this._viewOffMat; }
      get viewInvOffMat() { return this._viewInvOffMat; }
      get viewMat3() { return this._viewMat3; }
      get positionData() { return this._positionData; }
      setView(projMat, viewInvMat, viewMat) {
        this._projMat.set(projMat); this._viewInvMat.set(viewInvMat);
        if (viewMat) this._viewMat.set(viewMat); else this._viewMat.copy(this._viewInvMat).invert();
      }
      setViewport(x, y, w, h) { this._viewport.set(x, y, w, h); }
      updateTransforms(parent) {
        if (parent) { this._viewInvOffMat.mul2(parent, this._viewInvMat); this._viewOffMat.copy(this._viewInvOffMat).invert(); }
        else { this._viewInvOffMat.copy(this._viewInvMat); this._viewOffMat.copy(this._viewMat); }
        this._viewMat3.setFromMat4(this._viewOffMat);
        this._projViewOffMat.mul2(this._projMat, this._viewOffMat);
        this._positionData[0] = this._viewInvOffMat.data[12]; this._positionData[1] = this._viewInvOffMat.data[13]; this._positionData[2] = this._viewInvOffMat.data[14];
      }
    }
    st.rvKind = 'clone';
    return [new RenderView(), new RenderView()];
  }
  function bindViews(st) {
    st.views = makeViews(st);
    st.frustumKey = '';
    st.flatProj = new Float64Array(16);
    st.eyeInv = [new Float64Array(16), new Float64Array(16)];
    updateViews(st); // before the first draw: never a frame with an unset view
    st.cam.camera.xrViews = st.views.slice();
  }
  // Each render: the eyes from THIS frame's camera (prerender runs after the page's update, before
  // the engine syncs the hierarchy). A RenderView's pose is composed with the camera node's PARENT
  // (Camera.updateViewTransforms), so the attach pattern eye = camera world × view.transform is
  // RenderView pose = camera LOCAL × view.transform.
  function updateViews(st) {
    const R = st.R, local = st.cam.entity.getLocalTransform().data;
    let P0;
    if (st.haveViews) {
      for (let i = 0; i < 2; i++) {
        mul4(local, st.V[i].pose, st.eyeInv[i]);
        st.views[i].setView(st.V[i].proj, st.eyeInv[i]);
        st.views[i].setViewport(i * R.eyeW, 0, R.eyeW, R.eyeH);
      }
      P0 = st.V[0].proj;
      st.stats.stereo++;
    } else {
      // No eyes yet: the page's own frustum, flat into both halves — never a blank tile.
      const p = pageCam(st);
      perspective(p.vfov, p.aspect, p.near, p.far, st.flatProj);
      for (let i = 0; i < 2; i++) {
        st.views[i].setView(st.flatProj, local);
        st.views[i].setViewport(i * R.eyeW, 0, R.eyeW, R.eyeH);
      }
      P0 = st.flatProj;
      st.stats.flat++;
      if (st.stats.twoView > 0) st.stats.flatAfterEyes++;
    }
    // LOD and culling read camera.fov/aspect/near/far, which under xrViews come from the XR
    // properties — the frustum the views actually have, as XrManager does it.
    const f = frustumFromProjection(P0);
    const key = `${f.fov.toFixed(4)}|${f.aspectRatio.toFixed(4)}|${f.nearClip}|${f.farClip}`;
    if (key !== st.frustumKey) { st.frustumKey = key; st.cam.camera.setXrProperties({ ...f, horizontalFov: false }); }
  }

  // ------------------------------------------------------------ convergence: the scene's bounds
  function layersMeet(a, b) {
    if (!a || !b) return true;
    for (let i = 0; i < a.length; i++) if (b.indexOf(a[i]) >= 0) return true;
    return false;
  }
  function forEachBounds(st, cb) {
    const root = st.app.root, camLayers = st.cam.layers;
    let more = true;
    const meshes = (comp) => {
      if (!more || !comp || !comp.enabled || !comp.entity || !comp.entity.enabled || !layersMeet(comp.layers, camLayers)) return;
      const mis = comp.meshInstances || [];
      for (const mi of mis) {
        if (!more) return;
        if (!mi || mi.visible === false) continue;
        const bb = mi.aabb;
        if (!bb) continue;
        const r = Math.hypot(bb.halfExtents.x, bb.halfExtents.y, bb.halfExtents.z);
        if (!(r >= 0) || !isFinite(r)) continue;
        more = cb(bb.center.x, bb.center.y, bb.center.z, r) !== false;
      }
    };
    for (const c of root.findComponents('render')) meshes(c);
    for (const c of root.findComponents('model')) meshes(c);
    for (const g of root.findComponents('gsplat')) {
      if (!more) break;
      if (!g.enabled || !g.entity.enabled || !layersMeet(g.layers, camLayers)) continue;
      const bb = g.customAabb;
      if (!bb) continue;
      const m = g.entity.getWorldTransform().data, c = bb.center;
      const wx = m[0] * c.x + m[4] * c.y + m[8] * c.z + m[12];
      const wy = m[1] * c.x + m[5] * c.y + m[9] * c.z + m[13];
      const wz = m[2] * c.x + m[6] * c.y + m[10] * c.z + m[14];
      const s = Math.sqrt(Math.max(m[0] * m[0] + m[1] * m[1] + m[2] * m[2], m[4] * m[4] + m[5] * m[5] + m[6] * m[6], m[8] * m[8] + m[9] * m[9] + m[10] * m[10]));
      const r = Math.hypot(bb.halfExtents.x, bb.halfExtents.y, bb.halfExtents.z) * s;
      if (!(r >= 0) || !isFinite(r)) continue;
      more = cb(wx, wy, wz, r) !== false;
    }
  }

  // ------------------------------------------------------------ math (the SDK adapter's, verbatim where it has one)
  function mul4(a, b, o) {
    for (let c = 0; c < 4; c++) {
      const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
      o[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
      o[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
      o[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
      o[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
    }
    return o;
  }
  function perspective(vfov, aspect, n, f, o) {
    const t = 1 / Math.tan(vfov / 2);
    o.fill(0);
    o[0] = t / aspect; o[5] = t; o[10] = -(f + n) / (f - n); o[11] = -1; o[14] = (-2 * f * n) / (f - n);
    return o;
  }
  // inline3d-splat-playcanvas.js frustumFromProjection (an infinite far is clamped to the capture far).
  function frustumFromProjection(P) {
    return {
      fov: (2 * Math.atan(1 / P[5])) / DEG,
      aspectRatio: P[5] / P[0],
      nearClip: P[14] / (P[10] - 1),
      farClip: Math.abs(P[10] + 1) < 1e-9 ? 1e4 : P[14] / (P[10] + 1),
    };
  }
  // inline3d-splat-playcanvas.js patchGsplatFootprint, verbatim.
  function patchGsplatFootprint(src) {
    if (typeof src !== 'string') return { src, ok: false };
    if (src.includes('dxrFocalY')) return { src, ok: true };
    const r1 = /vec2\s+J2\s*=\s*-J1\s*\/\s*vp\.z\s*\*\s*vp\.xy\s*;/;
    const r2 = /0\.0\s*,\s*J1\s*,\s*J2\.y\s*,/;
    if (!r1.test(src) || !r2.test(src)) return { src, ok: false };
    return {
      src: src
        .replace(r1, 'float J1y = (viewport_size.y * matrix_projection[1][1]) / vp.z; /* dxrFocalY */ ' +
          'vec2 J2 = vec2(-J1 / vp.z * vp.x, -J1y / vp.z * vp.y);')
        .replace(r2, '0.0, J1y, J2.y,'),
      ok: true,
    };
  }

  info(`PlayCanvas adapter armed (core v${core.VERSION})`);
})();

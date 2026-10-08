// DisplayXR auto-3D — PlayCanvas adapter. PROTOTYPE, not a product.
//
// A part of the core bundle (build.mjs): `function dxrPlayCanvas(core)`, called by dxrCore with its
// internal API; returns { consider }. Turns an existing PlayCanvas (engine 2.x, WebGL2 or WebGPU) page into
// a woven inline-3D window with no change to the page and WITHOUT the engine's XrManager: the
// page's own camera renders both eyes through the engine's RenderView path — the same recipe
// @displayxr/inline3d's PlayCanvas splat backend uses (js/inline3d-splat-playcanvas.js):
// `camera.camera.xrViews = [RenderView, RenderView]`, each view = the runtime's projection +
// eye pose, viewport = its half of the side-by-side (SBS) backing store, and the camera's
// fov/aspect/near/far from `setXrProperties` so LOD and culling see the frustum the views have.
//
// Finding the app is the SENTINEL's (sentinel.js): `window.pc.app`, `pc.AppBase.getApplication()`,
// `window.app`, and — for ESM bundles with no global — the AppBase constructor's
// `AppBase._applications[canvas.id] = this`, caught through a per-canvas `id` trap. It loads the
// core when it finds an app and hands it over with consider(app, how, ns). Nothing else in the
// engine is reachable from a bare canvas: the tick is a closure, the device is created after the
// constructor and holds no back-pointer, input handlers are bound functions (see README "What the
// PlayCanvas adapter cannot see").
//
// What it stands down on (flat, with the reason on the HUD): several cameras rendering to the
// canvas (a UI camera, picture-in-picture), legacy post effects (camera.postEffects) or frame passes
// that are not ONE CameraFrame, an orthographic camera, an app presenting WebXR through app.xr, and
// — via the core — SDK / WebXR pages.
//
// CameraFrame (v0.6.2, P-W1c; the engine's post chain: scene -> SSAO / TAA / bloom / DOF -> compose):
// the page's FramePassCameraFrame (A) renders eye 0 and a second instance (B, built from A's own
// class, CameraFrame and options; CameraFrame.update() applied to it every frame) renders eye 1,
// each into ITS OWN half-width targets (sceneOptions.resizeSource = the eye size), so TAA history,
// SSAO, bloom and DOF are per eye and the memory is two half-width chains. camera.framePasses =
// [eye 0, eye 1] while converted; between the passes, marker passes (FramePass instances of the
// engine's own base class) switch device.xrCurrentViewIndex (the forward renderer then draws that ONE
// view of xrViews), the views' viewports (eye-target-local for the scene passes, the eye's half of the
// SBS store for the after pass), and the camera's TAA reprojection matrices. Each compose draws into
// its half (RenderPassShaderQuad.viewport / scissor); eye 1's does not clear. See playcanvas-adapter
// "CameraFrame" below and the README.
//
// WebGPU (v0.6.0): the same recipe. The engine's forward loop draws every RenderView of
// camera.xrViews with its own viewport and bind group on both backends; on WebGPU it wraps the passes
// in FramePassMultiView, which falls through to one plain render when device.xrSubImages is empty
// (only the engine's own XRGPUBinding path fills it, and we never touch app.xr). What differs sits
// behind the core's surface (surface.js): the eye projection goes through surface.toClip (the
// engine uses xrViews[i].projMat AS IS, and the runtime's is GL clip z -1..1), the out-cover is a
// copy of the canvas's current texture, the size limit is the device's maxTextureDimension2D. The
// gsplat footprint fix is re-done in WGSL at the device's createShaderModule. The store is resized
// through the same device.setResolution (WebGPU's writes canvas.width / height; the engine's
// frameStart re-creates its back buffer when getCurrentTexture() comes back another size, so
// GPUCanvasContext.configure is never re-called; maxPixelRatio only shapes the page's MONO store, the
// SBS store is sized by the core from the element's device pixels).
function dxrPlayCanvas(core) {
  core.registerEngine('PlayCanvas');
  const { info, warnOnce, desc, realW, realH } = core;
  const DEG = Math.PI / 180;

  const apps = new WeakMap(); // app -> state; null before the device exists, false when not convertible
  const via = new WeakMap();  // app -> how it was found
  let pcNS = null;            // the engine namespace, when the page has one (UMD / editor builds)
  core.meta.playcanvas = { detected: [] };

  // ------------------------------------------------------------ what the sentinel hands over
  const isApp = (a) =>
    !!a && typeof a === 'object' && typeof a.tick === 'function' && typeof a.on === 'function' &&
    typeof a.fire === 'function' && 'graphicsDevice' in a && !!a.systems;

  // ------------------------------------------------------------ convergence target: lookAt
  // GraphNode.prototype.lookAt, wrapped once, records the world point per entity (the core uses it
  // only while the camera still looks at it). Reached from app.root: an app found by the
  // constructor trap has no root yet, so the root assignment a few statements later is caught with
  // a one-shot accessor on the instance — early enough for a page's setup-time camera.lookAt().
  const lookAts = new WeakMap(); // entity -> { x, y, z }
  const hookedProtos = new WeakSet();
  function hookLookAt(node) {
    let p = node && Object.getPrototypeOf(node);
    while (p && !Object.prototype.hasOwnProperty.call(p, 'lookAt')) p = Object.getPrototypeOf(p);
    if (!p || hookedProtos.has(p) || typeof p.lookAt !== 'function') return;
    hookedProtos.add(p);
    const orig = p.lookAt;
    try {
      p.lookAt = function (x, y, z) {
        const v = x && typeof x === 'object' ? x : null;
        const t = v ? { x: v.x, y: v.y, z: v.z } : { x, y, z };
        if (isFinite(t.x) && isFinite(t.y) && isFinite(t.z)) lookAts.set(this, t);
        return orig.apply(this, arguments);
      };
    } catch (e) { warnOnce('pc-lookat', 'could not watch entity.lookAt — convergence falls back to the estimator', e); }
  }
  function hookRoot(app) {
    if (app.root) { hookLookAt(app.root); return; }
    try {
      Object.defineProperty(app, 'root', {
        configurable: true, enumerable: true,
        get() { return undefined; },
        set(v) {
          Object.defineProperty(app, 'root', { value: v, writable: true, enumerable: true, configurable: true });
          if (v) hookLookAt(v);
        },
      });
    } catch (e) { /* the engine's own field: fine, lookAt calls before the first frame are missed */ }
  }
  // Orbit scripts on the camera entity: orbit-camera.js (`pivotPoint`) and the engine's ESM
  // CameraControls (`focusPoint`). Only those two names, read only on the camera's own scripts.
  const TARGET_FIELDS = [['pivotPoint', 'orbit-camera pivotPoint'], ['focusPoint', 'CameraControls focusPoint']];

  // Called by the sentinel with each app it finds, and the engine namespace when the page has one.
  function consider(app, how, ns) {
    if (core.retired) return; // stood down for good: no app is taken on after that
    if (!pcNS && ns && typeof ns === 'object' && (ns.AppBase || ns.Application)) pcNS = ns;
    if (!isApp(app) || apps.has(app)) return;
    apps.set(app, null);
    hookRoot(app);
    via.set(app, how);
    core.meta.playcanvas.detected.push(how);
    info('PlayCanvas app found via', how);
    // Our handlers go on at once — the constructor trap fires before init(), before the device.
    app.on('postrender', () => onPostRender(app));
    app.on('prerender', () => onPreRender(app));
    app.on('destroy', () => { const st = apps.get(app); if (st && (st.active || st.pending || st.armed)) core.stand(st, 'the page destroyed the app'); });
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
  // resizeCanvas's own compare), so it must report the real store. Since P0.2 the eye is sized from the
  // element's device pixels (core realSizeFor), so the SBS store is up to 2 × the mono store (3072
  // cap): page code that reads canvas.width directly sees the SBS width while converted. The engine's
  // own getters (device.width / clientRect) are what PlayCanvas apps use, and they see the store.
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
    // WebGPU: the same fix in WGSL, at the device's createShaderModule (patchGsplatFootprintWgsl).
    if (core.T.pcFootprint === false) return; // TEST ONLY (A/B)
    if (dev.isWebGPU) { wrapWgsl(st); return; }
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
  // The engine compiles every WGSL module through `device.wgpu.createShaderModule({ code })` (its
  // WebgpuShader.createShaderModule): the per-instance method is wrapped once. A device restored after a
  // loss is a new GPUDevice, not wrapped: its splats keep the engine's single focal (half-height in
  // the eyes) until the page reloads.
  function wrapWgsl(st) {
    const w = st.dev.wgpu;
    if (!w || typeof w.createShaderModule !== 'function') return;
    const csm = w.createShaderModule;
    w.createShaderModule = function (desc) {
      const code = desc && desc.code;
      if (typeof code === 'string' && code.indexOf('J2') >= 0 && /let\s+J2\s*=/.test(code)) {
        st.footprint.seen++;
        const p = patchGsplatFootprintWgsl(code);
        if (p.ok) { st.footprint.patched++; desc = { ...desc, code: p.src }; }
      }
      return csm.call(this, desc);
    };
  }
  function applyRealSize(st) {
    const R = core.realSizeFor(st);
    st.R = R;
    if (realW(st.canvas) === R.W && realH(st.canvas) === R.H) return false;
    st.stats.resizes++;
    st.setRes(R.W, R.H);
    return true;
  }

  // ------------------------------------------------------------ the camera
  // The ONE enabled camera that renders to the canvas, or why there is not exactly one. cf: the
  // camera's FramePassCameraFrame when it renders through a CameraFrame (the page's own, also while
  // our per-eye pair stands in for it), else null.
  function pickCamera(app, st) {
    const list = (app.systems.camera && app.systems.camera.cameras) || [];
    const cams = list.filter((c) => c && c.enabled && c.entity && c.entity.enabled && !c.renderTarget);
    if (!cams.length) return { why: 'no enabled camera renders to the canvas' };
    if (cams.length > 1) return { why: `${cams.length} cameras render to the canvas (UI / multi-view) — not split in this prototype`, flat: true };
    const c = cams[0];
    if (c.projection === 1) return { why: 'the camera is orthographic', flat: true };
    const pe = c.postEffects;
    if (c.postEffectsEnabled !== false && pe && Array.isArray(pe.effects) && pe.effects.length) return { why: 'post effects on the camera — needs per-eye targets (next)', flat: true };
    const fp = c.framePasses || (c.camera && c.camera.framePasses);
    let cf = null;
    if (fp && fp.length) {
      if (st && st.cf && fp === st.cf.list) cf = st.cf.A;
      else if (fp.length === 1 && isCameraFramePass(fp[0])) cf = core.T.pcCameraFrame === false ? null : fp[0]; // false: TEST ONLY, unsplit
      else return { why: 'frame passes on the camera that are not one CameraFrame — not split', flat: true };
    }
    return { cam: c, cf };
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
      if (app.xr && app.xr.active) return 'the app is presenting WebXR';
      const pick = pickCamera(app, st);
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
    beforeActive(st) {
      // The canvas still holds the page's mono store here: a page that sizes it by writing
      // canvas.width / height itself (supersplat-viewer: resizeCanvas on 'framerender', never
      // device.setResolution) never told setResolution, so its size is taken from the canvas.
      st.L.w = realW(st.canvas); st.L.h = realH(st.canvas);
    },
    afterActive(st) {
      st.cam = st.qualifyCam;
      trapCanvasSize(st);
      applyRealSize(st);
      bindViews(st);
      syncCameraFrame(st, pickCamera(st.app, st).cf || null);
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
      uninstallCameraFrame(st);
      restoreShadows(st);
      if (st.cam && st.cam.camera) { try { st.cam.camera.xrViews = null; } catch (e) { /* ignore */ } }
      st.cam = null; st.views = null; st.frustumKey = '';
      if (wasLive) {
        try { if (realW(st.canvas) !== st.L.w || realH(st.canvas) !== st.L.h) st.setRes(st.L.w, st.L.h); } catch (e) { /* ignore */ }
        st.app.renderNextFrame = true; // the mono frame: drawn on the engine's next tick, reported from postrender
      }
      untrapCanvasSize(st);
      return false;
    },
    wake(st) { st.app.renderNextFrame = true; }, // re-enabled: one frame, whose postrender considers activation
    // redraw() only ASKS for a frame; the engine draws it on its own tick. So the out-cover is taken
    // from postrender (onPostRender -> core.takeOutCover), right after that draw, not by the core
    // after redraw() — the drawing buffer is not preserved past the task that drew it.
    coverAfterDraw: true,
    // WebGL2: the context. WebGPU: the device + the canvas context, read live (a device restored after
    // a loss replaces both); flush = the engine's own submit, so a read in postrender (before the
    // engine's frameEnd) sees this frame; alphaMode from the engine's canvas configuration.
    surface(st) {
      const d = st.dev;
      if (!d) return null;
      if (d.isWebGPU) {
        if (!d.wgpu || !d.gpuContext) return null;
        return core.surfaces.gpu({
          get device() { return d.wgpu; }, get context() { return d.gpuContext; },
          flush: () => { if (typeof d.submit === 'function') d.submit(); },
          get alphaMode() { return d.canvasConfig ? d.canvasConfig.alphaMode : 'opaque'; },
        });
      }
      return d.gl ? core.surfaces.gl(d.gl) : null;
    },
    target(st) {
      const e = st.cam && st.cam.entity;
      if (!e) return null;
      const list = e.script && (e.script.scripts || e.script._scripts);
      if (Array.isArray(list)) {
        for (const sc of list) {
          if (!sc || sc.enabled === false) continue;
          for (const [f, via] of TARGET_FIELDS) {
            if (!(f in sc)) continue;
            let p = null;
            try { p = sc[f]; } catch (err) { p = null; }
            if (p && isFinite(p.x) && isFinite(p.y) && isFinite(p.z)) return { x: p.x, y: p.y, z: p.z, via };
          }
        }
      }
      const l = lookAts.get(e);
      return l ? { x: l.x, y: l.y, z: l.z, via: 'entity.lookAt' } : null;
    },
    flipIdle(st) { st.app.renderNextFrame = true; }, // flips on the postrender of that frame
    describe: (st) => ({
      page: { w: st.L.w, h: st.L.h, pr: 1 },
      extra: {
        detection: via.get(st.app), renderView: st.rvKind, camera: st.cam ? st.cam.entity.name : null,
        footprint: { ...st.footprint }, device: st.dev.isWebGPU ? 'webgpu' : 'webgl2', autoRender: st.app.autoRender,
        surface: st.surf ? st.surf.kind : null, outCoverVia: st.outCoverVia || null,
        eyeProj0: st.views && st.views[0] ? Array.from(st.views[0].projMat.data) : null, // what the engine draws eye 0 with
        cameraFrame: describeCameraFrame(st), pageSizeWrites: st.pageSizeWrites || 0,
      },
    }),
  };
  function flatWhy(st, why) {
    if (st.flatReason !== why) { st.flatReason = why; info('PlayCanvas canvas stays 2D:', why); core.notify(); }
    return why;
  }

  // ------------------------------------------------------------ frame hooks
  function onPostRender(app) {
    const st = stateFor(app);
    if (!st) return;
    st.frame.drew = true;
    if (st.active) { core.drew(st); if (st.outCoverDue) core.takeOutCover(st); return; } // the flat pair was just drawn
    if (st.releasing) { core.monoDrawn(st); return; } // the mono frame after a staged stand-down
    if (st.armed) {
      const pick = pickCamera(app, st);
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
    const pick = pickCamera(app, st);
    if (pick.cam !== st.cam) {
      const why = pick.cam ? 'the page switched cameras' : pick.why;
      core.stand(st, why, { staged: true }); // this frame now renders mono; the layer goes after it
      if (pick.flat) flatWhy(st, pick.why);
      st.nextTry = core.now() + 1000;
      return;
    }
    syncCameraFrame(st, pick.cf || null); // the page may switch its CameraFrame on or off, or rebuild it
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
    st.clipProj = [new Float64Array(16), new Float64Array(16)]; // WebGPU: the eye projections in clip z 0..1
    updateViews(st); // before the first draw: never a frame with an unset view
    st.cam.camera.xrViews = st.views.slice();
  }
  // Each render: the eyes from THIS frame's camera (prerender runs after the page's update, before
  // the engine syncs the hierarchy). A RenderView's pose is composed with the camera node's PARENT
  // (Camera.updateViewTransforms), so the attach pattern eye = camera world × view.transform is
  // RenderView pose = camera LOCAL × view.transform.
  // In the display rig the pose also carries the rig's pivot offset (core.pivotOffset), taken in the
  // camera's own axes from its WORLD transform: world × offset × view = parent × local × offset × view.
  function updateViews(st) {
    const R = st.R, local = st.cam.entity.getLocalTransform().data;
    // The engine draws xrViews with projMat AS IS; on WebGPU its clip z is 0..1, the runtime's is GL's
    // -1..1 (surface.toClip). frustumFromProjection below keeps reading the GL matrix.
    const sf = core.surfaceOf(st);
    const clip = sf && sf.kind === 'webgpu' && core.T.gpuDepthRange !== false ? sf : null;
    let P0;
    if (st.haveViews) {
      const world = st.cam.entity.getWorldTransform().data;
      for (let i = 0; i < 2; i++) {
        const pose = core.eyePose(st, i, world);
        mul4(local, pose, st.eyeInv[i]);
        if (i === 0) st.eyeAt = [0, 1, 2].map((k) => world[k] * pose[12] + world[4 + k] * pose[13] + world[8 + k] * pose[14] + world[12 + k]); // diagnostics (dev state(): eyeAt)
        st.views[i].setView(clip ? clip.toClip(st.V[i].proj, st.clipProj[i]) : st.V[i].proj, st.eyeInv[i]);
        st.views[i].setViewport(i * R.eyeW, 0, R.eyeW, R.eyeH);
      }
      P0 = st.V[0].proj;
      st.stats.stereo++;
    } else {
      // No eyes yet: the page's own frustum, flat into both halves — never a blank tile.
      const p = pageCam(st);
      perspective(p.vfov, p.aspect, p.near, p.far, st.flatProj);
      const fp = clip ? clip.toClip(st.flatProj, st.clipProj[0]) : st.flatProj;
      for (let i = 0; i < 2; i++) {
        st.views[i].setView(fp, local);
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
    if (st.cf) cameraFrameJitter(st);
    offsetShadows(st);
  }

  // ------------------------------------------------------------ CameraFrame (v0.6.2, P-W1c)
  // CameraFrame (extras/render-passes/camera-frame.js) sets camera.framePasses = [FramePassCameraFrame];
  // the frame graph then adds those passes instead of the camera's forward passes (forward-renderer.js
  // buildFrameGraph: renderAction.useCameraPasses). Its scene passes are RenderPassForwards, so under
  // xrViews they already loop over the views (renderForwardInternal), but every pass after them is a
  // full-screen quad over ONE scene texture sized to the canvas (sceneOptions.resizeSource = the back
  // buffer): TAA would reproject through one camera matrix, bloom / DOF would bleed across the seam,
  // vignette / fringing / sharpening would be centred on the pair. So each eye gets the whole chain:
  //   eye 0 = the page's pass A, eye 1 = B, a second FramePassCameraFrame built from A's own class with
  //   A's CameraFrame and options (no engine namespace needed). Each renders into its OWN targets of
  //   the eye's size (sceneOptions.resizeSource = st.eyeSrc; every other target of the chain resizes
  //   from the scene texture), so memory is two half-width chains, about one mono chain.
  //   camera.framePasses = [proxy 0, proxy 1]: disabled FramePasses (never rendered) whose
  //   beforePasses are [marker, A] and [marker, B, end marker]; the frame graph calls frameUpdate on
  //   each, then adds its before passes (frame-graph.js addRenderPass). The markers run at RENDER
  //   time, in pass order: device.xrCurrentViewIndex = eye (renderForwardInternal then draws only that
  //   RenderView, with its own bind group: the WebGPU multiview mechanism, frame-pass-multi-view.js),
  //   the views' viewports = the eye target's rect, and the camera's TAA reprojection matrices for this
  //   eye. A marker hung on each compose pass's afterPasses moves the viewports to the eye's half of the
  //   SBS store for the after pass (the layers after the post chain, e.g. UI). The compose pass draws
  //   its quad into the eye's half (RenderPassShaderQuad.viewport / scissor); eye 1's compose clears
  //   nothing (it would wipe eye 0: a WebGPU load-op clear ignores the scissor), and the frame graph's
  //   compile then makes eye 0's last pass on the back buffer store.
  //   B follows the page's settings: CameraFrame.update() is applied to B every frame (renderPassCamera
  //   swapped for the call), so bloom / grading / vignette / TAA / SSAO / DOF are the page's own; a
  //   layer change dirties both. The camera-use flags make the pair ONE camera use (EVENT_PRERENDER and
  //   the camera's before passes once, from eye 0; EVENT_POSTRENDER from eye 1).
  //   TAA: the engine applies no jitter and stores no reprojection matrices under xrViews
  //   (renderer.js setCameraUniforms), so both are done here: the engine's Halton jitter added to both
  //   eye projections (one sequence, eye-target pixels), and per eye the previous / inverse view-
  //   projection the resolve reads (render-pass-taa.js before()); each eye has its own history (B owns
  //   its RenderPassTAA).
  // A page that rebuilds or disables its CameraFrame is followed (syncCameraFrame on prerender);
  // CameraFrame.disable() destroys "its" framePasses, i.e. our proxies: proxy 0 destroys A as the page
  // asked, and B with it. Stand-down puts camera.framePasses = [A] back and A's targets back to the
  // canvas size.
  const isCameraFramePass = (p) => !!p && typeof p === 'object' && !!p.cameraFrame && !!p.composePass && !!p.sceneOptions &&
    typeof p.setupRenderPasses === 'function' && typeof p.update === 'function' && Array.isArray(p.beforePasses) && !!frameBase(p);
  // The engine's FramePass class: FramePassCameraFrame extends it directly.
  const frameBases = new WeakMap();
  function frameBase(p) {
    const K = p && p.constructor;
    if (typeof K !== 'function') return null;
    if (frameBases.has(K)) return frameBases.get(K);
    let B = Object.getPrototypeOf(K);
    try { if (!(typeof B === 'function' && B.prototype && typeof B.prototype.render === 'function' && Array.isArray(new B(p.device).beforePasses))) B = null; } catch (e) { B = null; }
    frameBases.set(K, B);
    return B;
  }
  const HALTON = [[0.5, 0.333333], [0.25, 0.666667], [0.75, 0.111111], [0.125, 0.444444], [0.625, 0.777778], [0.375, 0.222222], [0.875, 0.555556], [0.0625, 0.888889],
    [0.5625, 0.037037], [0.3125, 0.37037], [0.8125, 0.703704], [0.1875, 0.148148], [0.6875, 0.481481], [0.4375, 0.814815], [0.9375, 0.259259], [0.03125, 0.592593]]; // renderer.js _haltonSequence

  function syncCameraFrame(st, want) {
    const C = st.cf;
    if (C && C.A === want && st.cam.camera.framePasses === C.list) return;
    if (!C && !want) return;
    if (C) uninstallCameraFrame(st);
    if (want) {
      try { installCameraFrame(st, want); } catch (e) {
        warnOnce('pc-cf', 'could not split the CameraFrame per eye — standing down', e);
        uninstallCameraFrame(st);
        core.stand(st, 'CameraFrame could not be split per eye', { staged: true });
      }
    }
  }
  function installCameraFrame(st, A) {
    const cam = st.cam, sc = cam.camera, dev = st.dev, FP = frameBase(A);
    if (!st.eyeSrc) st.eyeSrc = { get width() { return st.R ? st.R.eyeW : realW(st.canvas) >> 1; }, get height() { return st.R ? st.R.eyeH : realH(st.canvas); } };
    const C = (st.cf = {
      A, B: null, list: null, n: 0, frames: 0, jit: [0, 0, 0, 0], prev: [null, null],
      vp: [{ x: 0, y: 0, z: 1, w: 1 }, { x: 0, y: 0, z: 1, w: 1 }],
      saved: { idx: dev.xrCurrentViewIndex, prev: sc._viewProjPrevious && sc._viewProjPrevious.clone(), inv: sc._viewProjInverse && sc._viewProjInverse.clone(), jit: Array.isArray(sc._jitters) ? sc._jitters.slice() : null },
    });
    const mark = (name, fn) => { const m = new FP(dev); m.name = name; m.execute = fn; return m; };
    C.mS = [0, 1].map((i) => mark(`DxrEye${i}Scene`, () => eyeScene(st, i)));
    C.mA = [0, 1].map((i) => mark(`DxrEye${i}After`, () => eyeAfter(st)));
    C.mEnd = mark('DxrEyeEnd', () => eyeEnd(st));
    hookPass(st, A, 0);
    C.B = new A.constructor(st.app, A.cameraFrame, cam, A.options);
    hookPass(st, C.B, 1);
    syncB(st);
    const proxy = (i) => {
      const p = new FP(dev);
      p.name = `DxrEye${i}`;
      p.enabled = false; // never rendered: the frame graph only runs its frameUpdate and adds its before passes
      p.beforePasses = i ? [C.mS[1], C.B, C.mEnd] : [C.mS[0], A];
      p.frameUpdate = () => { if (st.cf !== C) return; if (i === 0) { if (A.layersDirty) C.B.layersDirty = true; } else syncB(st); };
      p.destroy = () => { if (st.cf === C && i === 0) uninstallCameraFrame(st, true); }; // CameraFrame.disable(): the page destroys its pass
      return p;
    };
    C.list = [proxy(0), proxy(1)];
    cam.framePasses = C.list;
    info('CameraFrame split per eye:', JSON.stringify(describeCameraFrame(st)));
  }
  // Adopt a FramePassCameraFrame's passes for eye i; re-run after each of its rebuilds (update() ->
  // reset() -> setupRenderPasses() on an options or layer change).
  function hookPass(st, P, i) {
    const own = Object.prototype.hasOwnProperty.call(P, 'setupRenderPasses');
    const orig = P.setupRenderPasses;
    P.setupRenderPasses = function (o) { const r = orig.call(this, o); if (st.cf && (st.cf.A === this || st.cf.B === this)) adoptPasses(st, this, i); return r; };
    P.__dxrSetup = own ? orig : null;
    adoptPasses(st, P, i);
  }
  function adoptPasses(st, P, i) {
    const C = st.cf;
    if (P.sceneOptions) P.sceneOptions.resizeSource = st.eyeSrc; // scenePass / prePass hold this object
    const cp = P.composePass;
    if (cp) {
      cp.viewport = C.vp[i]; cp.scissor = C.vp[i];
      cp.afterPasses = [C.mA[i]];
      if (i === 1) { cp.setClearColor(undefined); cp.setClearDepth(undefined); cp.setClearStencil(undefined); }
    }
    for (const pass of P.beforePasses) {
      const steps = pass && pass.layerRenderSteps;
      if (steps) for (const s of steps) { if (i === 1) s.firstCameraUse = false; else s.lastCameraUse = false; }
    }
  }
  function unhookPass(st, P, cam) {
    if (P.__dxrSetup === undefined) return;
    if (P.__dxrSetup) P.setupRenderPasses = P.__dxrSetup; else delete P.setupRenderPasses;
    delete P.__dxrSetup;
    if (P.sceneOptions) P.sceneOptions.resizeSource = cam.renderTarget;
    const cp = P.composePass;
    if (cp) { cp.viewport = undefined; cp.scissor = undefined; cp.afterPasses = []; }
    if (typeof P.updateCameraUseFlags === 'function') P.updateCameraUseFlags();
  }
  // CameraFrame.update() for B: the page's current settings, B's passes.
  function syncB(st) {
    const C = st.cf, cf = C.A.cameraFrame;
    if (!cf || cf.renderPassCamera !== C.A || typeof cf.update !== 'function') return;
    cf.renderPassCamera = C.B;
    try { cf.update(); } finally { cf.renderPassCamera = C.A; }
  }
  function uninstallCameraFrame(st, pageDestroys) {
    const C = st.cf;
    if (!C) return;
    st.cf = null;
    const cam = st.cam || st.qualifyCam, sc = cam && cam.camera, dev = st.dev;
    try { if (cam && sc.framePasses === C.list) cam.framePasses = pageDestroys ? [] : [C.A]; } catch (e) { /* ignore */ }
    try { unhookPass(st, C.A, cam); } catch (e) { /* ignore */ }
    if (C.B) { try { unhookPass(st, C.B, cam); C.B.destroy(); } catch (e) { warnOnce('pc-cf-b', 'eye 1 CameraFrame passes did not destroy cleanly', e); } }
    if (pageDestroys) { try { C.A.destroy(); } catch (e) { /* the page's own pass */ } }
    else if (C.A.sceneDepthTexture && cam) {
      // B's reset() cleared the camera's scene-depth flags, which A (still the page's) needs.
      const sp = cam.shaderParams;
      sp.sceneDepthMapLinear = true; sp.sceneDepthMapPacked = false; sp.sceneDepthMapReciprocal = true;
    }
    try { dev.xrCurrentViewIndex = C.saved.idx; } catch (e) { /* ignore */ }
    if (sc) {
      try {
        if (C.saved.prev) sc._viewProjPrevious.copy(C.saved.prev);
        if (C.saved.inv) sc._viewProjInverse.copy(C.saved.inv);
        if (C.saved.jit) for (let k = 0; k < 4; k++) sc._jitters[k] = C.saved.jit[k];
      } catch (e) { /* ignore */ }
    }
    if (st.views && st.R) for (let k = 0; k < 2; k++) st.views[k].setViewport(k * st.R.eyeW, 0, st.R.eyeW, st.R.eyeH);
  }
  // Markers (render time).
  function eyeScene(st, i) {
    const C = st.cf;
    if (!C || !st.views) return;
    const P = i ? C.B : C.A, sc = st.cam.camera, R = st.R;
    st.dev.xrCurrentViewIndex = i;
    const rt = P.rt, w = rt ? rt.width : R.eyeW, h = rt ? rt.height : R.eyeH;
    for (const v of st.views) v.setViewport(0, 0, w, h);
    // The compose quad goes to this eye's half of the store.
    const vp = C.vp[i]; vp.x = i * R.eyeW; vp.y = 0; vp.z = R.eyeW; vp.w = R.eyeH;
    if (P.taaPass && sc._viewProjPrevious) {
      sc.updateViewTransforms();
      const cur = st.views[i].projViewOffMat;
      const prev = C.prev[i] || (C.prev[i] = cur.clone());
      sc._viewProjPrevious.copy(prev);
      sc._viewProjInverse.invert(cur);
      prev.copy(cur);
      for (let k = 0; k < 4; k++) sc._jitters[k] = C.jit[k];
    }
  }
  function eyeAfter(st) {
    const R = st.R;
    if (st.views && R) for (let k = 0; k < 2; k++) st.views[k].setViewport(k * R.eyeW, 0, R.eyeW, R.eyeH);
  }
  function eyeEnd(st) {
    const C = st.cf;
    if (!C) return;
    st.dev.xrCurrentViewIndex = C.saved.idx;
    C.frames++;
  }
  // TAA jitter on both eye projections (prerender, after updateViews set them): the engine's own
  // sequence and amplitude (renderer.js setCameraUniforms), in eye-target pixels.
  function cameraFrameJitter(st) {
    const C = st.cf, A = C.A, j = C.jit, sc = st.cam.camera;
    j[2] = j[0]; j[3] = j[1];
    if (!A.taaPass || !(sc.jitter > 0) || core.T.pcTaaJitter === false) { j[0] = j[1] = 0; return; }
    const o = HALTON[C.n++ % HALTON.length];
    const w = (A.rt && A.rt.width) || st.R.eyeW, h = (A.rt && A.rt.height) || st.R.eyeH;
    j[0] = (sc.jitter * (o[0] * 2 - 1)) / w; j[1] = (sc.jitter * (o[1] * 2 - 1)) / h;
    for (const v of st.views) { v.projMat.data[8] += j[0]; v.projMat.data[9] += j[1]; }
  }
  function describeCameraFrame(st) {
    const C = st.cf;
    if (!C) return null;
    const one = (P) => P && {
      target: P.rt ? [P.rt.width, P.rt.height] : null, taa: !!P.taaPass, bloom: !!P.bloomPass, ssao: !!P.ssaoPass, dof: !!P.dofPass,
      prepass: !!P.prePass, sceneDepth: !!P.sceneDepthTexture,
      compose: P.composePass ? { vp: P.composePass.viewport ? { ...P.composePass.viewport } : null, clears: !!(P.composePass.colorArrayOps && P.composePass.colorArrayOps[0] && P.composePass.colorArrayOps[0].clear) } : null,
    };
    return { eyes: [one(C.A), one(C.B)], frames: C.frames, jitter: C.jit.slice(0, 2) };
  }

  // ------------------------------------------------------------ pages that size the canvas themselves
  // supersplat-viewer (1.37) sizes the canvas by writing canvas.width / height on the app's
  // 'framerender' (its resizeCanvas, with app._allowResize = false), never through
  // device.setResolution, and does so whenever canvas.width differs from ITS size: every frame of a
  // converted SBS store. While converted, a write the adapter does not make itself (st.depth) is
  // recorded as the page's size (st.L) and the store stays side by side (resized only when the
  // element's size gives another SBS size). Reads stay REAL (the engine reads canvas.width). The
  // instance accessors come off at stand-down, after the mono store is put back.
  function trapCanvasSize(st) {
    if (st.trapped || core.T.pcCanvasTrap === false) return;
    const c = st.canvas;
    const def = (prop, D, isW) => Object.defineProperty(c, prop, {
      configurable: true, enumerable: true,
      get() { return D.get.call(this); },
      set(v) {
        if (!st.active || st.depth > 0) { D.set.call(this, v); return; }
        const n = Math.max(0, Math.floor(+v || 0));
        if (isW) st.L.w = n; else st.L.h = n;
        st.pageSizeWrites = (st.pageSizeWrites || 0) + 1;
        warnOnce('pc-rawsize', 'the page writes canvas.width / height itself (not device.setResolution): kept the side-by-side store, recorded as the page\'s size');
        if (applyRealSize(st)) st.app.renderNextFrame = true;
      },
    });
    def('width', core.CANVAS_W, true);
    def('height', core.CANVAS_H, false);
    st.trapped = true;
  }
  function untrapCanvasSize(st) {
    if (!st.trapped) return;
    st.trapped = false;
    try { delete st.canvas.width; delete st.canvas.height; } catch (e) { /* ignore */ }
  }

  // ------------------------------------------------------------ shadow distance
  // The engine fades a light's shadow out where the view depth passes light.shadowDistance, and
  // measures that depth from the EYE. A display rig puts the eyes well behind the page camera (the
  // viewer's distance; ~9 m on the gaussian-splatting sample), so a ground the page framed inside
  // its shadowDistance is past it for both eyes: the shadow shows in 2D, not in 3D (panel,
  // 2026-09-27). Every shadow-casting light gets the page's own distance + the mean eye pull-back Δ
  // while converted; the page's value is kept per light and put back by restore(). Written only on a
  // change of more than 1 cm (the frustumKey pattern). Lights are re-listed every 30 frames, so a
  // light the page adds while converted is picked up. A value the page writes meanwhile becomes the
  // new original. core.T.pcShadowOffset === false turns it off (harness A/B only).
  const shadowOrig = new WeakMap(); // light component -> { orig, wrote }
  function offsetShadows(st) {
    if (core.T.pcShadowOffset === false) return;
    const d = st.haveViews ? Math.max(0, (st.V[0].pose[14] + st.V[1].pose[14]) / 2) + (st.piv ? Math.hypot(st.piv.t[0], st.piv.t[1], st.piv.t[2]) : 0) : 0;
    if (!st.shadowLights || ++st.shadowScan >= 30) {
      st.shadowScan = 0;
      try { st.shadowLights = st.app.root.findComponents('light'); } catch (e) { st.shadowLights = []; }
      if (!st.shadowTouched) st.shadowTouched = new Set();
    }
    for (const lc of st.shadowLights) {
      if (!lc || !lc.castShadows) continue;
      let rec = shadowOrig.get(lc);
      const cur = lc.shadowDistance;
      if (!rec) {
        if (!(d > 0.01)) continue; // nothing to offset: leave the light untouched
        shadowOrig.set(lc, (rec = { orig: cur, wrote: NaN }));
        st.shadowTouched.add(lc);
      } else if (cur !== rec.wrote) rec.orig = cur; // the page set its own value since our last write
      const want = rec.orig + d;
      if (Math.abs(want - cur) > 0.01) { lc.shadowDistance = want; rec.wrote = lc.shadowDistance; }
    }
  }
  function restoreShadows(st) {
    if (!st.shadowTouched) return;
    for (const lc of st.shadowTouched) {
      const rec = shadowOrig.get(lc);
      if (!rec) continue;
      // Unless the page wrote its own value after ours (then that one stands).
      try { if (lc.shadowDistance === rec.wrote || rec.wrote !== rec.wrote) lc.shadowDistance = rec.orig; } catch (e) { /* ignore */ }
      shadowOrig.delete(lc);
    }
    st.shadowTouched = null; st.shadowLights = null;
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

  // The same fix in WGSL (WebGPU), for the engine's two splat footprint sites (playcanvas 2.22.3):
  //   the compute projector (GSPLAT_RENDERER_RASTER_GPU_SORT, WebGPU's default; computeSplatCov):
  //     let J1 = focal / vz;  let J2 = -J1 / vz * v.xy;  ...  let tt1 = J1 * w1 + J2.y * w2;
  //     focal = viewportWidth × projMat[0] is a scalar uniform; the y focal is viewportHeight × P[1][1],
  //     and P[1][1] = (viewProj × (w1, 0)).y: w1 is the camera's world Y axis (row 1 of the view
  //     rotation), so viewProj × (w1, 0) is P's column 1 (the depth-range row does not enter);
  //   the raster chunk (GSPLAT_RENDERER_RASTER_CPU_SORT): let focal = <ub>.viewport_size.x * ...; let J1 = focal / vp.z;
  //     let J2 = -J1 / vp.z * vp.xy;  mat3x3f(..., vec3f(0.0, J1, J2.y), ...) — the GLSL shape, with
  //     <ub>.viewport_size / <ub>.matrix_projection (<ub> = the view uniform block, ub_view in 2.22.3).
  // |P[1][1]|: a flipY target negates it, and the engine's single focal never flips; square pixels
  // (viewportWidth × P[0] = viewportHeight × |P[1][1]|) are unchanged by either rewrite. Each site is
  // patched only when ALL its anchors are found; otherwise it is left as is (counted in footprint.seen).
  function patchGsplatFootprintWgsl(src) {
    if (typeof src !== 'string') return { src, ok: false };
    if (src.includes('dxrFocalY')) return { src, ok: true };
    let out = src, ok = false;
    const c1 = /let\s+J2\s*=\s*-J1\s*\/\s*vz\s*\*\s*v\.xy\s*;/, c2 = /let\s+tt1\s*=\s*J1\s*\*\s*w1\s*\+\s*J2\.y\s*\*\s*w2\s*;/;
    if (c1.test(out) && c2.test(out) && /\bviewProj\b/.test(out) && /\bviewportHeight\b/.test(out) && /\blet\s+w1\b/.test(out)) {
      out = out
        .replace(c1, 'let J1y = (viewportHeight * abs((viewProj * vec4f(w1, 0.0)).y)) / vz; /* dxrFocalY */ let J2 = vec2f(-J1 / vz * v.x, -J1y / vz * v.y);')
        .replace(c2, 'let tt1 = J1y * w1 + J2.y * w2;');
      ok = true;
    }
    // The uniform block's name in the FINAL code is the engine's (`uniform.` in the chunk becomes
    // `ub_view.`): taken from the focal line itself, and matrix_projection must live in the same block.
    const r1 = /let\s+J2\s*=\s*-J1\s*\/\s*vp\.z\s*\*\s*vp\.xy\s*;/, r2 = /vec3f\(\s*0\.0\s*,\s*J1\s*,\s*J2\.y\s*\)/;
    const f = /let\s+focal\s*=\s*([A-Za-z_]\w*)\.viewport_size\.x\s*\*\s*center\.projMat00/.exec(out);
    const ub = f && f[1];
    if (ub && r1.test(out) && r2.test(out) && out.includes(`${ub}.matrix_projection`)) {
      out = out
        .replace(r1, `let J1y = (${ub}.viewport_size.y * abs(${ub}.matrix_projection[1][1])) / vp.z; /* dxrFocalY */ let J2 = vec2f(-J1 / vp.z * vp.x, -J1y / vp.z * vp.y);`)
        .replace(r2, 'vec3f(0.0, J1y, J2.y)');
      ok = true;
    }
    return { src: out, ok };
  }

  info(`PlayCanvas adapter armed (core v${core.VERSION})`);
  return { consider };
}

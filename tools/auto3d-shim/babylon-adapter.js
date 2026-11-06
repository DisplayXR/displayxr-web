// DisplayXR auto-3D — Babylon.js adapter. PROTOTYPE, not a product.
//
// A part of the core bundle (build.mjs): `function dxrBabylon(core)`, called by dxrCore with its
// internal API; returns { consider }. Turns an existing Babylon.js page (engine 7+ / 9.x, WebGL1 /
// WebGL2 / WebGPU) into a woven inline-3D window with no change to the page and WITHOUT the engine's WebXR:
// the page's own camera renders both eyes through the engine's CAMERA RIG path, the one its WebXR
// camera uses (Cameras/XR/webXRCamera: cameraRigMode = RIG_MODE_CUSTOM, two rig cameras with their own
// viewport, a frozen projection and their own view). Scene._processSubCameras then renders the scene
// once per rig camera into its viewport: each eye's shadow maps, render targets, layers (a fullscreen
// GUI, flat per eye), utility layers (gizmos: UtilityLayerRenderer swaps the rig cameras' scene) and
// post-processes (cascaded to the rig cameras by the engine itself).
//
// Finding the engine is the SENTINEL's (sentinel.js): the ThinEngine constructor assigns
// `this._gl = canvas.getContext('webgl2', …)` in the task that created the context, caught by a
// one-shot `_gl` setter on Object.prototype (no global needed: ESM bundles), and `BABYLON.EngineStore
// .Instances` for UMD pages (the CDN build). It loads the core when it finds one and hands it over with
// consider(engine, how, ns), from INSIDE the constructor: the engine has its observables but no canvas
// and no scene yet. Scenes are hooked as they are created (engine.onNewSceneAddedObservable).
//
// Sizing: the side-by-side (SBS) store is the element's device size, each eye half of it (the core's
// rule), but reached UNIFORMLY through the engine's own hardware scaling level instead of a store the
// engine does not know about: Babylon picks in store pixels (CreatePickingRayToRef: pointer CSS px /
// hardware scaling level, against getRenderWidth()), so the store must stay what engine.resize() makes
// of the level. Capped by the zero-copy width (maxSbsWidth, 3072) the same way (the eye's aspect is kept;
// the core caps each axis on its own). A fullscreen GUI laid out in pixels keeps the page's density (it
// would shrink), and a page that sizes its store itself (not engine.resize()) is left as it is.
//
// Handedness: the runtime's poses and projections are GL's (right-handed, the eye looks down -Z, clip
// z -1..1). Babylon is left-handed unless scene.useRightHandedSystem: H = diag(1, 1, -1) converts an
// eye's local frame (eye world = camera world × H × pose × H) and its projection (P × H, then the
// engine's depth conventions: reverse depth negates the z row, a half-z-range engine maps it to 0..1).
//
// What it stands down on (flat, with the reason on the HUD): an orthographic camera, several active
// cameras (activeCameras.length > 1: split screen, a UI camera), a camera that renders into a texture
// or carries its own rig (a stereoscopic / VR camera), two scenes rendering to one canvas,
// scene.customRenderFunction, the prepass renderer / a depth renderer (SSAO2 / SSR on the prepass, DOF:
// drawn once with the page camera), temporal post-processes (TAA, motion blur, SSR: one history for
// both eyes), WebGPU snapshot rendering (GPU bundles recorded once, with the page camera), and — via the
// core — WebXR pages. A camera that draws into PART of the canvas (a configurator under its UI) converts:
// each eye draws into the same sub-rectangle of its half (rigFovOf, eyeProjection). The geometry buffer
// converts, EXPERIMENTALLY: drawn again for the second eye (sceneFxWhy, onBeforeCamera). Each eye renders
// into its own target and is copied into its half (eye targets), so screen-space lookups keyed to the
// render target (gl_FragCoord / getRenderWidth()) see the eye's frame, as a mono frame would.
//
// WebGPU: the same rig. What differs sits behind the core's surface (surface.js) and two engine facts:
// the engine's clip z is 0..1 (isNDCHalfZRange: the eye projection's z row is mapped, eyeProjection),
// and it SUBMITS only at endFrame / flushFramebuffer: the out-cover read flushes first (the surface's
// flush), and a replay of a page that stopped drawing is bracketed by beginFrame / endFrame.
function dxrBabylon(core) {
  core.registerEngine('Babylon.js');
  const { info, warnOnce, desc, realW, realH } = core;
  const RIG_MODE_CUSTOM = 22; // Camera.RIG_MODE_CUSTOM: the scene renders the rig cameras, no rig maths of its own
  const RECENT_MS = 250;      // a scene "renders to the canvas" when it rendered this recently

  const engines = new WeakMap(); // engine -> state; null before it has a canvas; false when not convertible
  const via = new WeakMap();     // engine -> how it was found
  const sceneAt = new WeakMap(); // scene -> its last render (performance.now())
  const hookedScenes = new WeakSet();
  let bjsNS = null;              // window.BABYLON, when the page has it (UMD)
  core.meta.babylon = { detected: [] };

  const isEngine = (e) =>
    !!e && typeof e === 'object' && typeof e.runRenderLoop === 'function' && Array.isArray(e.scenes) &&
    typeof e.getRenderWidth === 'function' && !!e.onNewSceneAddedObservable;

  // ------------------------------------------------------------ what the sentinel hands over
  function consider(engine, how, ns) {
    if (core.retired) return;
    if (!bjsNS && ns && typeof ns === 'object' && ns.Engine) bjsNS = ns;
    if (!isEngine(engine) || engines.has(engine)) return;
    engines.set(engine, null);
    via.set(engine, how);
    core.meta.babylon.detected.push(how);
    info('Babylon.js engine found via', how);
    try {
      for (const s of engine.scenes) hookScene(engine, s);
      engine.onNewSceneAddedObservable.add((s) => hookScene(engine, s));
      if (engine.onDisposeObservable) engine.onDisposeObservable.add(() => { const st = engines.get(engine); if (st && (st.active || st.pending || st.armed)) core.stand(st, 'the page disposed the engine'); });
    } catch (e) { warnOnce('bjs-hook', 'could not watch the Babylon.js engine — left 2D', e); }
  }
  function hookScene(engine, scene) {
    if (!scene || hookedScenes.has(scene) || !scene.onBeforeRenderObservable || !scene.onAfterRenderObservable) return;
    hookedScenes.add(scene);
    scene.onBeforeRenderObservable.add(() => onBeforeRender(engine, scene));
    scene.onAfterRenderObservable.add(() => onAfterRender(engine, scene));
    if (scene.onActiveCameraChanged) scene.onActiveCameraChanged.add(() => onCameraChanged(engine, scene));
    if (scene.onBeforeCameraRenderObservable) scene.onBeforeCameraRenderObservable.add((cam) => onBeforeCamera(engine, scene, cam));
    if (scene.onAfterCameraRenderObservable) scene.onAfterCameraRenderObservable.add((cam) => { if (cam && cam.__dxrVp && cam.viewport !== cam.__dxrVp) cam.viewport = cam.__dxrVp; });
    const pm = scene.postProcessManager;
    if (pm && typeof pm._finalizeFrame === 'function' && !Object.prototype.hasOwnProperty.call(pm, '_finalizeFrame')) {
      const fin = pm._finalizeFrame;
      // The chain's last pass draws to the screen at the engine's cached viewport: the eye's own half
      // (the eye camera reports the page camera's viewport during its chain, onBeforeCamera).
      pm._finalizeFrame = function (doNotPresent, targetTexture) {
        const cam = scene.activeCamera;
        if (!targetTexture && cam && cam.__dxrVp && cam.viewport !== cam.__dxrVp) { try { engine.setViewport(cam.__dxrVp); } catch (e) { /* ignore */ } }
        return fin.apply(this, arguments);
      };
    }
    if (scene.onDisposeObservable) {
      scene.onDisposeObservable.add(() => {
        const st = engines.get(engine);
        if (st && st.scene === scene && (st.active || st.pending || st.armed)) core.stand(st, 'the page disposed the scene');
        if (st && st.lastScene === scene) st.lastScene = null;
      });
    }
    hookCameras(scene);
  }

  // ------------------------------------------------------------ convergence target: setTarget
  // TargetCamera.prototype.setTarget (FreeCamera, UniversalCamera, … — the playground template's
  // `camera.setTarget(Vector3.Zero())`), wrapped once, records the world point per camera (the core
  // uses it only while the camera still looks at it). Reached from the first camera a scene adds,
  // through the scene's addCamera (per instance), so a setup-time setTarget is seen. An
  // ArcRotateCamera's orbit target and a lockedTarget are read directly (target() below).
  const setTargets = new WeakMap(); // camera -> { x, y, z }
  const hookedProtos = new WeakSet();
  function hookSetTarget(cam) {
    let p = cam && Object.getPrototypeOf(cam);
    while (p && !Object.prototype.hasOwnProperty.call(p, 'setTarget')) p = Object.getPrototypeOf(p);
    if (!p || hookedProtos.has(p) || typeof p.setTarget !== 'function') return;
    hookedProtos.add(p);
    const orig = p.setTarget;
    try {
      p.setTarget = function (t) {
        if (t && isFinite(t.x) && isFinite(t.y) && isFinite(t.z)) setTargets.set(this, { x: t.x, y: t.y, z: t.z });
        return orig.apply(this, arguments);
      };
    } catch (e) { warnOnce('bjs-settarget', 'could not watch camera.setTarget — convergence falls back to the estimator', e); }
  }
  function hookCameras(scene) {
    for (const c of scene.cameras || []) hookSetTarget(c);
    if (typeof scene.addCamera !== 'function' || Object.prototype.hasOwnProperty.call(scene, 'addCamera')) return;
    const add = scene.addCamera;
    try {
      scene.addCamera = function (c) { hookSetTarget(c); return add.apply(this, arguments); };
    } catch (e) { /* setup-time setTarget calls are missed: the estimator stands in */ }
  }

  // ------------------------------------------------------------ per-engine state
  function stateFor(engine) {
    let st = engines.get(engine);
    if (st) return st;
    if (st === false || st === undefined) return null;
    const canvas = typeof engine.getRenderingCanvas === 'function' ? engine.getRenderingCanvas() : null;
    if (!canvas) return null; // still in the constructor
    if (!(canvas instanceof HTMLCanvasElement)) { warnOnce('bjs-offscreen', 'Babylon.js on an OffscreenCanvas — not supported, left 2D'); engines.set(engine, false); return null; }
    st = core.newState('Babylon.js', canvas, ad);
    Object.assign(st, {
      eng: engine, scene: null, lastScene: null, cam: null, rigOn: null, eyes: null, qualify: null,
      L: { w: realW(canvas), h: realH(canvas), pr: 1 }, // what the PAGE believes: its own store, in pixels
      frame: { drew: false, idle: 0, n: 0 }, replaying: false, vp: null, gbufEyes: 0, scale: 0, hw0: 1, follows: false, pxGui: false,
      tmp: { mrh: new Float64Array(16), e: new Float64Array(16), p: new Float64Array(16) },
    });
    engines.set(engine, st);
    info(`Babylon.js engine on ${desc(canvas)} (${engine.isWebGPU ? 'WebGPU' : 'WebGL' + (engine.webGLVersion || '')}, found via ${via.get(engine)})`);
    return st;
  }

  // ------------------------------------------------------------ the scene and the camera
  // The ONE scene that renders to the canvas (rendered within RECENT_MS), or why there is not exactly one.
  function sceneOf(st) {
    const t = core.now() - RECENT_MS;
    const live = st.eng.scenes.filter((s) => s && !s.isDisposed && hookedScenes.has(s) && (sceneAt.get(s) || 0) > t);
    if (!live.length) return { why: 'no scene has rendered yet' };
    if (live.length > 1) return { why: `${live.length} scenes render to the canvas — not split in this prototype`, flat: true };
    return { scene: live[0] };
  }
  // The one camera that renders the scene to the canvas, or why there is not exactly one.
  function pickCamera(st, scene) {
    const ac = scene.activeCameras;
    if (ac && ac.length > 1) return { why: `${ac.length} active cameras render the scene (split screen / UI camera) — not split in this prototype`, flat: true };
    const cam = (ac && ac.length === 1 ? ac[0] : null) || scene.activeCamera;
    if (!cam) return { why: 'the scene has no active camera' };
    if (cam.mode === 1) return { why: 'the camera is orthographic', flat: true };
    if (cam.cameraRigMode !== 0 && cam !== st.rigOn) return { why: 'the camera has its own rig (a stereoscopic / VR camera)', flat: true };
    if (cam.outputRenderTarget) return { why: 'the camera renders into a texture', flat: true };
    const vp = vpOf(cam);
    if (!(vp.w > 0 && vp.h > 0) || vp.x < -1e-6 || vp.y < -1e-6 || vp.x + vp.w > 1 + 1e-6 || vp.y + vp.h > 1 + 1e-6) return { why: `the camera viewport lies outside the canvas (${vp.x}, ${vp.y}, ${vp.w} x ${vp.h})`, flat: true };
    if (scene.customRenderFunction) return { why: 'scene.customRenderFunction — the page renders the scene itself', flat: true };
    const fx = sceneFxWhy(scene) || postFxWhy(cam);
    if (fx) return { why: fx, flat: true };
    if (!cameraBase(cam)) return { why: 'no Babylon Camera class reachable from the page camera', flat: true };
    return { cam };
  }
  // Renderers that draw the scene ONCE per frame with the page camera (a depth map, the prepass): what
  // samples them in an eye would be the wrong view. The geometry buffer is the exception (v0.7.0,
  // EXPERIMENTAL, T.bjsGBuffer): it is gathered once per frame (Scene._gatherRenderTargetsStage) and drawn
  // in the first eye's pass only, so the adapter draws it again for the second eye (onBeforeCamera
  // below). What samples it in the eye's own pass then sees that eye's view: GIRSMManager (its GI pass
  // runs in onBeforeDrawPhase, per camera), the IBL shadows pipeline and SSAO2 / SSR on the geometry
  // buffer (post-processes, cascaded to the eye cameras). A TEMPORAL history (IBL shadows' accumulation,
  // the G-buffer's velocity) stays one for both eyes.
  function sceneFxWhy(scene) {
    if (scene.prePassRenderer && scene.prePassRenderer.enabled) return 'the prepass renderer is on (SSAO2 / SSR / motion blur / subsurface) — not split per eye';
    if (scene._geometryBufferRenderer && core.T.bjsGBuffer === false) return 'a geometry buffer renderer is on (SSAO / SSR / GI / IBL shadows) — not split per eye (bjsGBuffer off)';
    const dr = scene._depthRenderer;
    if (dr && typeof dr === 'object' && Object.keys(dr).length) return 'a depth renderer is on (depth of field / SSAO / a depth effect) — not split per eye';
    return null;
  }
  // Post-processes run once per rig camera (the engine cascades the page camera's chain to them): fine
  // for spatial ones (bloom, FXAA, tone mapping / grading, sharpen, grain, chromatic aberration). A
  // temporal one keeps ONE history that both eyes would write.
  // Class names (MotionBlurPostProcess, ScreenSpaceReflectionPostProcess) and the names the engine's
  // pipelines give the generic PostProcess they attach (TAARenderingPipeline: "TAA" / "TAAPass").
  const TEMPORAL_CLASS = /^(MotionBlur|ScreenSpaceReflection|SSR|TAA)/, TEMPORAL_NAME = /^(TAA|SSR|MotionBlur)/i;
  function postFxWhy(cam) {
    const pps = (cam._postProcesses || []).filter(Boolean);
    if (!pps.length) return null;
    if (core.T.bjsPostFx === false) return `${pps.length} post-process(es) on the camera — left unsplit (bjsPostFx off)`; // TEST ONLY (A/B)
    for (const pp of pps) {
      let n = '';
      try { n = typeof pp.getClassName === 'function' ? pp.getClassName() : ''; } catch (e) { n = ''; }
      if (TEMPORAL_CLASS.test(n) || TEMPORAL_NAME.test(pp.name || '')) return `a temporal post-process on the camera (${n || pp.name}) — one history for both eyes, not split`;
    }
    return null;
  }
  // The engine's base Camera class, from the page camera's own prototype chain (an ESM page gives us
  // no namespace). Its getClassName is the public, unminified API string.
  const bases = new WeakMap();
  function cameraBase(cam) {
    const K = cam && cam.constructor;
    if (K && bases.has(K)) return bases.get(K);
    let found = null;
    for (let p = Object.getPrototypeOf(cam); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
      if (!Object.prototype.hasOwnProperty.call(p, 'getClassName')) continue;
      let n = null;
      try { n = p.getClassName.call(cam); } catch (e) { n = null; }
      if (n === 'Camera' && typeof p.constructor === 'function') { found = p.constructor; break; }
    }
    if (K) bases.set(K, found);
    return found;
  }
  // The camera's viewport, normalised (Babylon: origin bottom-left).
  function vpOf(cam) {
    const v = cam && cam.viewport;
    return v ? { x: +v.x || 0, y: +v.y || 0, w: v.width === undefined ? 1 : +v.width, h: v.height === undefined ? 1 : +v.height } : { x: 0, y: 0, w: 1, h: 1 };
  }
  // The page camera's vertical FOV (radians) over ITS viewport, and that viewport's aspect.
  function subAspect(st) { const v = vpOf(st.cam); return (st.L.w * v.w) / ((st.L.h * v.h) || 1); }
  function vfovOf(st) {
    const c = st.cam;
    return c.fovMode === 1 ? 2 * Math.atan(Math.tan(c.fov / 2) / subAspect(st)) : c.fov; // FOVMODE_HORIZONTAL_FIXED
  }
  // The FOV the rig declares: the WHOLE canvas's, for a camera that draws into part of it (a
  // configurator with its UI over the rest of the canvas: Nike By You, viewport (0, 0.39, 1, 0.61)). The
  // runtime's eye projections then cover the canvas, and eyeProjection scales them to the viewport
  // (rows x 1/w, 1/h): the page's own framing on its viewport, the camera's axis through its centre,
  // and the same physical disparity as on the whole canvas.
  function rigFovOf(st) {
    const h = vpOf(st.cam).h || 1;
    return h === 1 ? vfovOf(st) : 2 * Math.atan(Math.tan(vfovOf(st) / 2) / h);
  }
  function rangeOf(st) {
    const c = st.cam;
    const near = c.minZ > 0 ? c.minZ : 0.1;
    const far = c.maxZ > 0 && !c.ignoreCameraMaxZ ? c.maxZ : 1e4; // 0 = an infinite far plane
    return { near, far: Math.max(far, near * 2) };
  }

  // ------------------------------------------------------------ the adapter hooks the core calls
  const ad = {
    label: (st) => `Babylon.js ${engineVersion(st)}, ${via.get(st.eng)}`,
    unqualified(st) {
      const eng = st.eng;
      if (eng.isWebGPU && core.T.bjsWebGPU === false) return flatWhy(st, 'WebGPU engine — left 2D (bjsWebGPU off)'); // TEST ONLY (A/B)
      if (eng.isWebGPU && eng.snapshotRendering) return flatWhy(st, 'WebGPU snapshot rendering (GPU bundles recorded with the page camera) — not split per eye');
      const sc = sceneOf(st);
      if (!sc.scene) return sc.flat ? flatWhy(st, sc.why) : sc.why;
      const pick = pickCamera(st, sc.scene);
      if (!pick.cam) return pick.flat ? flatWhy(st, pick.why) : pick.why;
      st.flatReason = null;
      st.qualify = { scene: sc.scene, cam: pick.cam };
      const where = core.canvasPlacement(st.canvas);
      if (where) return where;
      if (!(realW(st.canvas) > 0 && realH(st.canvas) > 0)) return 'canvas has no size yet';
      return core.cssEffect(st.canvas);
    },
    hasCamera: (st) => !!st.cam,
    depthRange: (st) => rangeOf(st),
    rigFov: (st) => rigFovOf(st),
    sampler(st) {
      if (!st.cam) return null;
      const r = rangeOf(st);
      return {
        cameraPose: cameraRH(st, new Float64Array(16)),
        verticalFov: vfovOf(st), aspect: subAspect(st), near: r.near, far: r.far,
        forEachBounds: (cb) => forEachBounds(st, cb),
      };
    },
    fakeViewParams(st) { const r = rangeOf(st), v = rigFovOf(st); return { near: r.near, far: r.far, t: r.near * Math.tan(v / 2), aspect: st.L.w / (st.L.h || 1) }; },
    beforeActive(st) {
      st.L.w = realW(st.canvas); st.L.h = realH(st.canvas); st.L.pr = 1;
      st.hw0 = hwLevel(st);
      st.follows = followsResize(st);
    },
    afterActive(st) {
      st.scene = st.qualify.scene; st.cam = st.qualify.cam; st.lastScene = st.scene;
      applySize(st);
      installRig(st, st.cam);
    },
    // afterActive may have resized the store (device pixels, the cap: applySize), which clears it; the
    // page's own next frame redraws it and the go-live cover hides it meanwhile. A page that stopped
    // drawing is asked for one frame.
    firstDraw(st) { replaySoon(st); },
    redraw(st) {
      // Redraw every frame (woven-canvas rules): a page that has drawn nothing for two session frames
      // (its render loop stopped: render on demand) gets the scene re-rendered, camera and animations
      // as they are.
      if (st.frame.drew) st.frame.idle = 0;
      else if (++st.frame.idle >= 2) { st.stats.replays++; replay(st); }
      st.frame.drew = false;
    },
    restore(st, wasLive) {
      uninstallRig(st);
      unScale(st);
      st.cam = null; st.scene = null;
      if (wasLive) replaySoon(st); // the mono frame: the page's next render (or ours, if it draws no more), reported from onAfterRender
      return false;
    },
    wake(st) { if (!st.active) replaySoon(st); }, // re-enabled: one frame, whose onAfterRender considers activation
    flipIdle(st) { replay(st); },                  // armed, page idle: one mono frame, flipped on its onAfterRender
    // The scene renders on the engine's own frame: the out-cover is taken from onAfterRender, right
    // after the draw (the drawing buffer is not preserved past that task).
    coverAfterDraw: true,
    // WebGL: the context. WebGPU: the device and the canvas context, read live (a device restored after a
    // loss replaces both); flush = the engine's own submit (it ends the current pass and starts new
    // encoders, so the rest of the frame goes on), so a read in onAfterRender sees this frame; the
    // canvas is configured with COPY_SRC by the engine.
    surface(st) {
      const eng = st.eng;
      if (!eng) return null;
      if (eng.isWebGPU) {
        if (!eng._device || !eng._context) return null;
        return core.surfaces.gpu({
          get device() { return eng._device; }, get context() { return eng._context; },
          flush: () => { if (typeof eng.flushFramebuffer === 'function') eng.flushFramebuffer(); },
          get alphaMode() { return eng.premultipliedAlpha === false ? 'opaque' : 'premultiplied'; },
        });
      }
      return eng._gl ? core.surfaces.gl(eng._gl) : null;
    },
    target(st) {
      const c = st.cam;
      if (!c) return null;
      const ok = (p) => p && isFinite(p.x) && isFinite(p.y) && isFinite(p.z);
      if (typeof c.alpha === 'number' && typeof c.beta === 'number' && typeof c.radius === 'number') {
        let t = null;
        try { t = c.target; } catch (e) { t = null; }
        if (ok(t)) return { x: t.x, y: t.y, z: t.z, via: 'ArcRotateCamera target' };
      }
      const lt = c.lockedTarget;
      if (lt) {
        let p = null;
        try { p = typeof lt.getAbsolutePosition === 'function' ? lt.getAbsolutePosition() : lt; } catch (e) { p = null; }
        if (ok(p)) return { x: p.x, y: p.y, z: p.z, via: 'camera.lockedTarget' };
      }
      const s = setTargets.get(c);
      return s ? { x: s.x, y: s.y, z: s.z, via: 'camera.setTarget' } : null;
    },
    describe: (st) => ({
      page: { w: st.L.w, h: st.L.h, pr: 1 },
      extra: {
        detection: via.get(st.eng), version: engineVersion(st), device: st.eng.isWebGPU ? 'webgpu' : 'webgl' + (st.eng.webGLVersion || ''),
        camera: st.cam ? `${st.cam.name} (${className(st.cam)})` : null, rigOn: st.rigOn ? st.rigOn.name : null,
        handedness: st.scene ? (st.scene.useRightHandedSystem ? 'right' : 'left') : null, reverseDepth: !!st.eng.useReverseDepthBuffer,
        viewport: st.vp ? [st.vp.x, st.vp.y, st.vp.w, st.vp.h] : null, gbufferPerEye: st.gbufEyes || 0, eyeTargets: !!st.eyeTargetsOn,
        hwScale: hwLevel(st), scale: st.scale || 1, followsResize: st.follows, pixelGui: st.pxGui, postProcesses: st.cam ? (st.cam._postProcesses || []).filter(Boolean).length : 0,
        surface: st.surf ? st.surf.kind : null, outCoverVia: st.outCoverVia || null, autoRender: st.frame.idle < 2,
        eyeProj0: st.eyes ? Array.from(st.eyes[0].__dxrP.m) : null, // what the engine draws eye 0 with
      },
    }),
  };
  function flatWhy(st, why) {
    if (st.flatReason !== why) { st.flatReason = why; info('Babylon.js canvas stays 2D:', why); core.notify(); }
    return why;
  }
  const className = (o) => { try { return typeof o.getClassName === 'function' ? o.getClassName() : (o.constructor && o.constructor.name) || '?'; } catch (e) { return '?'; } };
  function engineVersion(st) {
    let v = null;
    try { v = (bjsNS && bjsNS.Engine && bjsNS.Engine.Version) || (st.eng.constructor && st.eng.constructor.Version); } catch (e) { v = null; }
    return v || '?';
  }
  const hwLevel = (st) => { try { return st.eng.getHardwareScalingLevel(); } catch (e) { return 1; } };

  // ------------------------------------------------------------ frame hooks
  function onBeforeRender(engine, scene) {
    const st = stateFor(engine);
    if (!st) return;
    sceneAt.set(scene, core.now());
    if (!st.active) return;
    if (scene !== st.scene) {
      // Another scene draws into this canvas, mono, over the pair: back to 2D (re-qualified later:
      // two scenes every frame stay 2D with that reason; a switch to the other scene converts it).
      core.stand(st, 'another scene renders to the canvas', { staged: true });
      st.nextTry = core.now() + 1000;
      return;
    }
    const pick = pickCamera(st, scene);
    if (!pick.cam) {
      core.stand(st, pick.why, { staged: true }); // this frame now renders mono; the layer goes after it
      if (pick.flat) flatWhy(st, pick.why);
      st.nextTry = core.now() + 1000;
      return;
    }
    if (pick.cam !== st.rigOn) moveRig(st, pick.cam);
    applySize(st);
    syncRig(st);
    if (st.haveViews) st.stats.stereo++;
    else { st.stats.flat++; if (st.stats.twoView > 0) st.stats.flatAfterEyes++; }
  }
  function onAfterRender(engine, scene) {
    const st = stateFor(engine);
    if (!st) return;
    if (!st.replaying) { st.frame.drew = true; st.frame.n++; }
    if (st.active) {
      if (scene !== st.scene) return;
      core.drew(st);
      if (st.outCoverDue) core.takeOutCover(st);
      return;
    }
    if (st.releasing) { core.monoDrawn(st); return; } // the mono frame after a staged stand-down
    st.lastScene = scene;
    if (st.armed) {
      const sc = sceneOf(st);
      const pick = sc.scene === scene ? pickCamera(st, scene) : { why: sc.why || 'the page switched scenes', flat: sc.flat };
      if (!pick.cam) { core.stand(st, pick.why); if (pick.flat) flatWhy(st, pick.why); return; }
      st.qualify = { scene, cam: pick.cam };
      core.flip(st); // this task just drew the mono frame: it is the cover
      return;
    }
    core.considerActivation(st);
  }
  // The second eye's pass: the geometry buffer the scene gathered for this frame was drawn in the first
  // eye's pass (and the scene's render-target list reset after it); queue it again so this pass draws
  // it with this eye's view, before anything in the pass samples it (the render targets are drawn right
  // after this observable). T.bjsGBuffer 'shared' (TEST ONLY, A/B): converted, but not drawn again.
  //
  // Both eyes, with a post-process chain: the eye renders the scene into the chain's FULL texture (as
  // the page camera does), so for the rest of its pass the eye camera reports the PAGE camera's
  // viewport. Passes that map their textures through scene.activeCamera.viewport (SSAO2's combine:
  // uv = viewport.xy + vUV · viewport.zw) or reset the viewport from it mid-pass (GIRSMManager, on the
  // chain's texture) then see what they see in 2D; the chain's last pass still draws into the eye's
  // half (the _finalizeFrame wrapper above), and onAfterCameraRender puts the eye's own viewport back.
  function onBeforeCamera(engine, scene, cam) {
    const st = engines.get(engine);
    if (!st || !st.active || st.scene !== scene || !st.eyes || (cam !== st.eyes[0] && cam !== st.eyes[1])) return;
    if (st.rigOn && scene.postProcessesEnabled !== false && (cam._postProcesses || []).some(Boolean)) cam.viewport = st.rigOn.viewport;
    if (cam !== st.eyes[1]) return;
    const gbr = scene._geometryBufferRenderer;
    if (!gbr || core.T.bjsGBuffer === false || core.T.bjsGBuffer === 'shared' || !scene._renderTargets || typeof gbr.getGBuffer !== 'function') return;
    try {
      scene._renderTargets.pushNoDuplicate(gbr.getGBuffer());
      iblHistory(engine, scene, cam);
      if (!st.gbufEyes++) info('geometry buffer drawn again for the right eye (EXPERIMENTAL): GI / IBL shadows / SSAO / SSR see each eye\'s own view');
    } catch (e) { warnOnce('bjs-gbuf', 'could not draw the geometry buffer for the right eye', e); }
  }
  // IBL shadows' temporal accumulation (IblShadowsAccumulationPass): its output is drawn after EVERY
  // G-buffer draw (so per eye), but its history (oldAccumulationRT = the last output, oldLocalPositionRT
  // = the last G-buffer positions) is copied once per frame, at frame start, and the G-buffer's velocity
  // always refers to the view drawn before (the other eye). The left eye's history and velocity both
  // refer to the right eye of the frame before: consistent. The right eye's velocity refers to the left
  // eye, but its history was still the right eye's (panel, 2026-11-06: the shadows under playground
  // #8R5SSE#587 differed between the eyes, a glitch). Copied again before the right eye's pass, each
  // eye reprojects the other eye's accumulated shadows through the velocity, as a TAA follows a moving
  // camera. The G-buffer still holds the left eye's draw here (the right eye's is queued, not drawn).
  function iblHistory(engine, scene, cam) {
    const mgr = scene.postProcessRenderPipelineManager;
    const map = mgr && mgr._renderPipelines;
    if (!map || core.T.bjsIblHistory === false) return; // TEST ONLY (A/B)
    let did = false;
    for (const k of Object.keys(map)) {
      const p = map[k];
      let n = '';
      try { n = p && typeof p.getClassName === 'function' ? p.getClassName() : ''; } catch (e) { n = ''; }
      const acc = n === 'IBLShadowsRenderPipeline' ? p._accumulationPass : null;
      if (!acc || acc.enabled === false) continue;
      for (const t of [acc._oldAccumulationCopy, acc._oldPositionCopy]) {
        if (t && typeof t.render === 'function' && (typeof t.isReady !== 'function' || t.isReady())) { t.render(); did = true; }
      }
    }
    if (did) {
      try { engine.setViewport(cam.__dxrVp || cam.viewport); } catch (e) { /* the pass sets its own next */ }
      const st = engines.get(engine);
      if (st && !st.iblLogged) { st.iblLogged = true; info('IBL shadows: the accumulation history is copied again before the right eye (each eye reprojects the other eye\'s shadows)'); }
    }
  }
  // scene.activeCamera = another camera, while converted: the rig moves with it at once (the setter
  // may run mid-frame, after our onBeforeRender), or the canvas goes back to 2D when it does not qualify.
  function onCameraChanged(engine, scene) {
    const st = engines.get(engine);
    if (!st || !st.active || st.scene !== scene) return;
    const pick = pickCamera(st, scene);
    if (pick.cam) { if (pick.cam !== st.rigOn) moveRig(st, pick.cam); return; }
    core.stand(st, pick.why, { staged: true });
    if (pick.flat) flatWhy(st, pick.why);
    st.nextTry = core.now() + 1000;
  }

  // ------------------------------------------------------------ replays (a page that stopped drawing)
  // scene.render(updateCameras false, ignoreAnimations true): the page's last state, re-rendered. It is
  // the page's own observers' frame too (onBeforeRender runs), so it is used only when the page has
  // stopped drawing. Never from inside a render: replaySoon defers to the next animation frame and
  // skips when the page drew meanwhile.
  function replay(st) {
    const scene = st.scene || st.lastScene;
    if (!scene || scene.isDisposed || st.replaying) return;
    const eng = st.eng, frame = !!eng.isWebGPU; // WebGPU submits at endFrame: a bare scene.render() would never reach the canvas
    st.replaying = true;
    try {
      if (frame) eng.beginFrame();
      try { scene.render(false, true); } finally { if (frame) eng.endFrame(); }
    } catch (e) { warnOnce('bjs-replay', 'replaying the scene threw; idle frames will not be redrawn', e); } finally { st.replaying = false; }
  }
  function replaySoon(st) {
    const n = st.frame.n;
    requestAnimationFrame(() => { if (st.frame.n === n) replay(st); });
  }

  // ------------------------------------------------------------ sizing (see the header)
  // The store's density (store px per CSS px) the eyes get: the element's DEVICE pixels (the core's
  // rule: the SBS store is the element's full device size, each eye half of it; panel 2026-11-06: the
  // playground at its own CSS-pixel store gave 318-px eyes, jagged and flat), never below the page's
  // own, capped by the zero-copy width and the context's limits. Applied UNIFORMLY through the engine's
  // hardware scaling level, so the engine's own resize() makes the store and picking divides by the
  // same level. Only for a page whose store follows the engine's resize rule (store = CSS size /
  // hardware scaling level); a page that sizes its store itself is left as it is. A fullscreen GUI laid
  // out in pixels keeps the page's density: it would shrink by the same factor.
  function applySize(st) {
    const c = st.canvas, cw = c.clientWidth, ch = c.clientHeight;
    const kPage = st.hw0 > 0 ? 1 / st.hw0 : 1;
    let k = kPage;
    if (st.follows && cw > 0 && ch > 0) {
      const sf = core.surfaceOf(st);
      if (st.lim === undefined && sf) st.lim = sf.limit();
      const lim = core.T.glLimit > 0 ? core.T.glLimit : st.lim || Infinity;
      const dpr = Math.min(window.devicePixelRatio || 1, core.T.maxEyeDpr);
      st.pxGui = pixelGui(st.scene);
      if (!st.pxGui) k = Math.max(kPage, dpr);
      k = Math.min(k, Math.min(core.T.maxSbsWidth, lim) / cw, lim / ch);
    }
    const want = k / kPage;
    if (Math.abs(want - (st.scale || 1)) > 1e-3) setScale(st, want);
    const w = realW(c), h = realH(c);
    st.L.w = Math.round(w / (st.scale || 1)); st.L.h = Math.round(h / (st.scale || 1));
    const eyeW = Math.max(1, w >> 1);
    st.R = { eyeW, eyeH: h, W: 2 * eyeW, H: h };
  }
  // Does the page's store follow the engine's resize rule (what engine.resize() makes: the CSS size /
  // the hardware scaling level, floored)? Read before anything changes it.
  function followsResize(st) {
    const c = st.canvas, hw = st.hw0 > 0 ? st.hw0 : 1;
    const cw = c.clientWidth, ch = c.clientHeight;
    return cw > 0 && ch > 0 && Math.abs(realW(c) - cw / hw) <= 1 && Math.abs(realH(c) - ch / hw) <= 1;
  }
  // A fullscreen Babylon GUI (AdvancedDynamicTexture on a scene layer) laid out in store pixels: not
  // following the hardware scaling level, no ideal size.
  function pixelGui(scene) {
    const layers = (scene && scene.layers) || [];
    for (const l of layers) {
      const t = l && l.texture;
      if (!t || typeof t.getClassName !== 'function') continue;
      let n = '';
      try { n = t.getClassName(); } catch (e) { n = ''; }
      if (n === 'AdvancedDynamicTexture' && !t.adjustToEngineHardwareScalingLevel && !t.idealWidth && !t.idealHeight) return true;
    }
    return false;
  }
  // The store at s x the page's density, through the engine's hardware scaling level. While scaled, the
  // page's own setHardwareScalingLevel() is recorded (an own method on the engine for that time) and
  // re-scaled.
  function setScale(st, s) {
    const eng = st.eng;
    if (Math.abs(s - 1) <= 1e-3) { unScale(st); return; }
    if (!st.scale) {
      const orig = eng.setHardwareScalingLevel;
      st.hwOwn = Object.prototype.hasOwnProperty.call(eng, 'setHardwareScalingLevel') ? orig : null;
      eng.setHardwareScalingLevel = function (level) {
        if (!st.scale) return orig.apply(this, arguments);
        st.hw0 = level;
        this._hardwareScalingLevel = level / st.scale;
        this.resize();
      };
    }
    st.scale = s;
    eng._hardwareScalingLevel = st.hw0 / s;
    try { eng.resize(); } catch (e) { warnOnce('bjs-scale', 'could not resize the store for the eyes', e); }
    st.stats.resizes++;
    info(`store ${realW(st.canvas)}x${realH(st.canvas)}: x${s.toFixed(3)} the page's (hardware scaling ${eng._hardwareScalingLevel.toFixed(3)}, the page's ${st.hw0}) — ` +
      (s < 1 ? `the side-by-side width limit is ${core.T.maxSbsWidth}` : "the element's device pixels"));
  }
  function unScale(st) {
    if (!st.scale) return;
    const eng = st.eng;
    st.scale = 0;
    if (st.hwOwn) eng.setHardwareScalingLevel = st.hwOwn; else { try { delete eng.setHardwareScalingLevel; } catch (e) { /* ignore */ } }
    st.hwOwn = null;
    eng._hardwareScalingLevel = st.hw0;
    try { eng.resize(); } catch (e) { /* the page's next resize puts it back */ }
  }

  // ------------------------------------------------------------ the rig (two eye cameras)
  // Instances of the engine's base Camera (reached from the page camera's prototype chain), added to
  // the scene as WebXR's rig cameras are. Each has a FROZEN projection (its own Matrix, rewritten in
  // place) and a view computed on every getViewMatrix() from the page camera's CURRENT world matrix, so
  // a camera the page moves in onBeforeRender (after camera.update()) is followed in the same frame.
  // Every rewrite that changes a value bumps the matrix's updateFlag (markAsUpdated): the scene's
  // transform cache and every effect's uniform cache are keyed on it.
  function makeEyes(st, cam) {
    const Cam = cameraBase(cam), scene = cam.getScene();
    const Mx = cam.getViewMatrix().constructor;
    const Vp = cam.viewport.constructor;
    const ident = () => (typeof Mx.Identity === 'function' ? Mx.Identity() : new Mx());
    return [0, 1].map((i) => {
      const e = new Cam(`dxr-auto3d-eye-${i}`, typeof cam.position.clone === 'function' ? cam.position.clone() : cam.position, scene, false);
      Object.defineProperty(e, '__dxrEye', { value: i });
      e.isRigCamera = true;
      e._isLeftCamera = i === 0; e._isRightCamera = i === 1;
      e.viewport = e.__dxrVp = new Vp(i * 0.5, 0, 0.5, 1); // __dxrVp: the eye's own (viewport may stand in for the page's, onBeforeCamera)
      e.__dxrV = ident(); e.__dxrP = ident();
      e.freezeProjectionMatrix(e.__dxrP);
      e._isSynchronizedViewMatrix = () => false; // recomputed on every read (cheap; values compared before marking)
      e._getViewMatrix = () => eyeView(st, i, e);
      return e;
    });
  }
  // ------------------------------------------------------------ eye targets
  // Each eye renders like a MONO frame: into its own target the size of its viewport, then a pass copies
  // it into its half (Babylon's own rig post-process slot, _rigPostProcess, cascaded after the page's
  // chain). Drawn straight into half the canvas, an eye broke every screen-space lookup keyed to the
  // render target (uv = gl_FragCoord.xy / getRenderWidth()): the IBL shadows material plugin read the
  // left / right HALF of the eye's own shadow image (panel, 2026-11-06: playground #8R5SSE#587's ground
  // shadow differed between the eyes), and so would GIRSM's plugin without a chain, depth peeling, a
  // transmission pass. In its own target the eye's gl_FragCoord and getRenderWidth() are the eye's.
  // MSAA as the canvas has it. Built from the page's own PostProcess class and our copy shaders
  // (eyePassShader); attached once ready. No PostProcess class reachable (a tree-shaken ESM bundle with no
  // post-process at all) or WebGPU: the eyes keep drawing straight into their halves. T.bjsEyeTarget false: A/B.
  function postProcessClass(st, scene) {
    if (bjsNS && typeof bjsNS.PostProcess === 'function') return bjsNS.PostProcess;
    const seen = [...(scene.postProcesses || [])];
    for (const c of scene.cameras || []) for (const pp of c._postProcesses || []) if (pp) seen.push(pp);
    for (const pp of seen) {
      for (let q = Object.getPrototypeOf(pp); q && q !== Object.prototype; q = Object.getPrototypeOf(q)) {
        if (!Object.prototype.hasOwnProperty.call(q, 'getClassName')) continue;
        let n = null;
        try { n = q.getClassName.call(pp); } catch (e) { n = null; }
        if (n === 'PostProcess' && typeof q.constructor === 'function') return q.constructor;
      }
    }
    return null;
  }
  // Our own copy shaders (GLSL; the engine's shader processor adapts them to WebGL2), registered in the
  // engine's shader store under dxrEyePass*: the engine's 'pass' / 'postprocess' shaders are registered
  // lazily (only once something has used them), so they cannot be relied on. The store is reached from
  // any compiled effect (Effect.ShadersStore). WebGPU: not here (WGSL); its eyes draw straight into their halves.
  const EYE_PASS_VS = 'attribute vec2 position; uniform vec2 scale; varying vec2 vUV; const vec2 madd = vec2(0.5, 0.5);\n' +
    'void main(void) { vUV = (position * madd + madd) * scale; gl_Position = vec4(position, 0.0, 1.0); }';
  const EYE_PASS_FS = 'varying vec2 vUV; uniform sampler2D textureSampler;\nvoid main(void) { gl_FragColor = texture2D(textureSampler, vUV); }';
  function eyePassShader(scene) {
    if (scene.getEngine().isWebGPU) return false;
    const effects = [];
    for (const m of scene.materials || []) { try { effects.push(m && typeof m.getEffect === 'function' ? m.getEffect() : null); } catch (x) { /* ignore */ } }
    const pps = [...(scene.postProcesses || [])];
    for (const c of scene.cameras || []) for (const pp of c._postProcesses || []) if (pp) pps.push(pp);
    for (const pp of pps) { try { effects.push(pp && typeof pp.getEffect === 'function' ? pp.getEffect() : null); } catch (x) { /* ignore */ } }
    // Standard / PBR materials keep their effects on the submeshes (material.getEffect() is empty).
    for (const m of (scene.meshes || []).slice(0, 64)) { try { const sm = m && m.subMeshes && m.subMeshes[0]; effects.push(sm ? sm.effect : null); } catch (x) { /* ignore */ } }
    for (const e of effects) {
      const store = e && e.constructor && e.constructor.ShadersStore;
      if (!store || typeof store !== 'object') continue;
      if (!store.dxrEyePassVertexShader) store.dxrEyePassVertexShader = EYE_PASS_VS;
      if (!store.dxrEyePassPixelShader) store.dxrEyePassPixelShader = EYE_PASS_FS;
      return true;
    }
    return false;
  }
  function makeEyeTargets(st, scene) {
    if (st.eyeTargets !== undefined || core.T.bjsEyeTarget === false) return;
    st.eyeTargets = null;
    const PP = postProcessClass(st, scene);
    if (!PP || !eyePassShader(scene)) { info(`eye targets: ${PP ? 'no shader store' : 'no PostProcess class'} reachable — the eyes draw straight into their halves (screen-space lookups keyed to the canvas may misplace)`); return; }
    const eng = scene.getEngine();
    let samples = 1;
    try { const aa = eng.getCreationOptions && eng.getCreationOptions().antialias; samples = aa && eng.webGLVersion > 1 ? Math.min(4, (eng.getCaps().maxMSAASamples) || 1) : 1; } catch (e) { samples = 1; }
    try {
      st.eyeTargets = [0, 1].map((i) => {
        const pp = new PP(`dxr-auto3d-eye-${i}-target`, 'dxrEyePass', null, null, { width: 2, height: 2 }, null, 1 /* NEAREST: a 1:1 copy */, eng, false, null, 0, 'dxrEyePass');
        pp.samples = samples;
        return pp;
      });
    } catch (e) { st.eyeTargets = null; warnOnce('bjs-eyert', 'could not make the eye targets — the eyes draw straight into their halves', e); }
  }
  // Attached once their pass shader is ready (until then, and if it never is, the eyes draw straight
  // into their halves); sized every frame to the eye's viewport in pixels.
  function syncEyeTargets(st) {
    const T = st.eyeTargets, cam = st.rigOn;
    if (!T || !st.eyes || !cam) return;
    const W = realW(st.canvas), H = realH(st.canvas);
    for (let i = 0; i < 2; i++) {
      const pp = T[i], e = st.eyes[i], v = e.__dxrVp;
      pp._options = { width: Math.max(1, Math.round(W * v.width)), height: Math.max(1, Math.round(H * v.height)) };
      if (e._rigPostProcess !== pp && typeof pp.isReady === 'function' && pp.isReady()) {
        e._rigPostProcess = pp;
        st.eyeTargetsOn = true;
      }
    }
    if (st.eyeTargetsOn && (st.eyes[0]._postProcesses || []).indexOf(T[0]) < 0) {
      cam._cascadePostProcessesToRigCams();
      for (const e of st.eyes) e.isIntermediate = false; // defensive: the cascade marks a lone rig post-process of the engine's 'pass' effect intermediate (a VR rig's); ours is dxrEyePass, so it should not
      if (!st.eyeTargetsLogged) { st.eyeTargetsLogged = true; info('eye targets on: each eye renders into its own target and is copied into its half'); }
    }
  }
  function disposeEyeTargets(st) {
    const T = st.eyeTargets;
    st.eyeTargets = undefined; st.eyeTargetsOn = false;
    if (st.eyes) for (const e of st.eyes) { e._rigPostProcess = null; e._postProcesses = []; }
    if (T) for (const pp of T) { try { pp.dispose(); } catch (e) { /* ignore */ } }
  }

  function installRig(st, cam) {
    try {
      // A page camera the page disposed took our eyes with it (Camera.dispose disposes its rig cameras).
      if (st.eyes && st.eyes.some((e) => typeof e.isDisposed === 'function' && e.isDisposed())) st.eyes = null;
      if (!st.eyes) st.eyes = makeEyes(st, cam);
      for (const e of st.eyes) e.rigParent = cam;
      st.rigMode0 = cam.cameraRigMode;
      cam.cameraRigMode = RIG_MODE_CUSTOM;
      cam._rigCameras.push(st.eyes[0], st.eyes[1]);
      st.rigOn = cam;
      makeEyeTargets(st, cam.getScene());
      syncRig(st);
      if (typeof cam._cascadePostProcessesToRigCams === 'function') cam._cascadePostProcessesToRigCams();
    } catch (e) {
      warnOnce('bjs-rig', 'could not put the eye cameras on the page camera — standing down', e);
      uninstallRig(st);
      core.stand(st, 'the eye cameras could not be installed', { staged: true });
    }
  }
  function detachRig(st) {
    const cam = st.rigOn;
    st.rigOn = null;
    if (!cam || !st.eyes) return;
    const list = cam._rigCameras || [];
    for (const e of st.eyes) { const k = list.indexOf(e); if (k >= 0) list.splice(k, 1); e._postProcesses = []; e._rigPostProcess = null; }
    st.eyeTargetsOn = false; // re-attached on the next camera (syncEyeTargets)
    if (!list.length && cam.cameraRigMode === RIG_MODE_CUSTOM) cam.cameraRigMode = st.rigMode0 || 0;
  }
  function moveRig(st, cam) {
    detachRig(st);
    st.cam = cam;
    installRig(st, cam);
    info(`the page switched cameras: the eyes follow ${cam.name} (${className(cam)})`);
  }
  function uninstallRig(st) {
    detachRig(st);
    disposeEyeTargets(st);
    if (st.eyes) {
      for (const e of st.eyes) { e._postProcesses = []; try { e.dispose(); } catch (err) { /* ignore */ } }
      st.eyes = null;
    }
  }
  // What the eye cameras copy from the page camera every frame (the engine's own _updateRigCameras
  // copies minZ / maxZ / fov / upVector; the layer mask decides what they draw).
  function syncRig(st) {
    const cam = st.rigOn;
    if (!cam || !st.eyes) return;
    const v = (st.vp = vpOf(cam));
    for (let i = 0; i < 2; i++) {
      const e = st.eyes[i], ev = e.__dxrVp;
      if (e.viewport !== ev) e.viewport = ev;
      e.layerMask = cam.layerMask; e.minZ = cam.minZ; e.maxZ = cam.maxZ;
      ev.x = i * 0.5 + v.x * 0.5; ev.y = v.y; ev.width = v.w * 0.5; ev.height = v.h;
    }
    syncEyeTargets(st);
  }

  // The page camera's world matrix with the RUNTIME's camera convention (the eye looks down -Z):
  // world × H for a left-handed scene (H = diag(1, 1, -1)), as is for a right-handed one. The core's
  // eyePose (the display rig's pivot) and estimator read it.
  function cameraRH(st, out) {
    const w = st.cam.getWorldMatrix().m;
    for (let k = 0; k < 16; k++) out[k] = w[k];
    if (!st.scene.useRightHandedSystem) { out[8] = -out[8]; out[9] = -out[9]; out[10] = -out[10]; out[11] = -out[11]; }
    return out;
  }
  function eyeView(st, i, e) {
    const V = e.__dxrV, P = e.__dxrP;
    const cam = st.rigOn;
    if (!cam || !st.scene) return V;
    if (st.haveViews) {
      const T = st.tmp, lh = !st.scene.useRightHandedSystem;
      const mrh = cameraRH(st, T.mrh);
      const pose = core.eyePose(st, i, mrh);
      mul4(mrh, pose, T.e);
      if (lh) { T.e[8] = -T.e[8]; T.e[9] = -T.e[9]; T.e[10] = -T.e[10]; T.e[11] = -T.e[11]; } // × H: the eye's own frame, left-handed
      writeMat(V, core.invert4(T.e));
      if (i === 0) st.eyeAt = [T.e[12], T.e[13], T.e[14]]; // diagnostics (dev state(): eyeAt)
      eyeProjection(st, st.V[i].proj, lh, T.p);
      writeMat(P, T.p);
    } else {
      // No eyes yet: the page's own view and projection, flat into both halves — never a blank tile.
      writeMat(V, cam.getViewMatrix().m);
      writeMat(P, cam.getProjectionMatrix().m);
    }
    return V;
  }
  // The runtime's projection (GL: right-handed, clip z -1..1) in the engine's conventions.
  function eyeProjection(st, src, lh, out) {
    for (let k = 0; k < 16; k++) out[k] = src[k];
    const v = st.vp;
    if (v && (v.w !== 1 || v.h !== 1)) for (let c = 0; c < 4; c++) { out[c * 4] /= v.w; out[c * 4 + 1] /= v.h; } // the whole canvas's -> the camera's viewport (rigFovOf)
    if (lh) { out[8] = -out[8]; out[9] = -out[9]; out[10] = -out[10]; out[11] = -out[11]; } // P × H
    const eng = st.eng;
    if (eng.useReverseDepthBuffer) { out[2] = -out[2]; out[6] = -out[6]; out[10] = -out[10]; out[14] = -out[14]; } // near -> 1, far -> -1 (near / far swapped)
    if (eng.isNDCHalfZRange) for (let c = 0; c < 4; c++) out[c * 4 + 2] = 0.5 * (out[c * 4 + 2] + out[c * 4 + 3]);
    return out;
  }
  // Rewrites a Babylon Matrix in place; bumps its updateFlag only when a value changed.
  function writeMat(M, src) {
    const m = M.m;
    let diff = false;
    for (let k = 0; k < 16; k++) {
      const v = m instanceof Float32Array ? Math.fround(src[k]) : src[k];
      if (m[k] !== v) { diff = true; break; }
    }
    if (!diff) return;
    for (let k = 0; k < 16; k++) m[k] = src[k];
    M.markAsUpdated();
  }

  // ------------------------------------------------------------ convergence: the scene's bounds
  function forEachBounds(st, cb) {
    const scene = st.scene, mask = st.cam.layerMask;
    const list = scene.meshes || [];
    for (let k = 0; k < list.length && k < 4000; k++) {
      const m = list[k];
      try {
        if (!m || !m.isVisible || m.visibility === 0 || m.infiniteDistance || !(m.layerMask & mask) || (typeof m.isEnabled === 'function' && !m.isEnabled())) continue;
        if (typeof m.getTotalVertices === 'function' && m.getTotalVertices() === 0 && !(m.getBoundingInfo && m.getBoundingInfo().boundingSphere.radiusWorld > 0)) continue;
        const bs = m.getBoundingInfo && m.getBoundingInfo().boundingSphere;
        if (!bs) continue;
        const c = bs.centerWorld, r = bs.radiusWorld;
        if (!(r >= 0) || !isFinite(r) || !isFinite(c.x)) continue;
        if (cb(c.x, c.y, c.z, r) === false) return;
      } catch (e) { /* a mesh mid-dispose */ }
    }
  }

  // ------------------------------------------------------------ math
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

  info(`Babylon.js adapter armed (core v${core.VERSION})`);
  return { consider };
}

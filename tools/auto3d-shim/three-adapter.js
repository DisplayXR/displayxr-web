// DisplayXR auto-3D — three.js adapter. PROTOTYPE, not a product.
//
// The three.js half of the original auto-3D prototype (content.js v0.1.0, PR #47), unchanged in
// behaviour; the session / layer / rig / cover machinery lives in core.js. A part of the core bundle
// (build.mjs): `function dxrThree(core)`, called by dxrCore with its internal API. Returns the
// devtools listeners { observe, register }; the sentinel owns the hook and forwards to them.
//
// How it finds three.js on a bundled / minified page: three (r105+) announces every WebGLRenderer
// and Scene it constructs to a global `__THREE_DEVTOOLS__` EventTarget ('observe'), if one exists.
// The sentinel defines it before any page script runs, so every renderer reaches it. render(),
// setSize() & co. are instance properties, so they are wrapped per instance.
//
// What a converted renderer does:
//   - its canvas backing store becomes the side-by-side (SBS) pair the weave expects, while the page
//     keeps seeing its mono size (getSize / getPixelRatio / getViewport / canvas.width … are
//     virtualised, so the common `canvas.width !== clientWidth * dpr` resize check stays quiet);
//   - each render(scene, perspectiveCamera) to the screen becomes one render per eye, into its
//     half, from the eye poses + off-axis projections the session reports (attach pattern:
//     eye world = page camera × view.transform, the rig pose is identity); a camera the page frames
//     with setViewOffset (a lens shift, a crop zoom) keeps that framing in each eye (applyView), and a
//     post chain that flips its picture left-right gets eyes mirrored to match (probeMirror);
//   - anything else aimed at the screen (an ortho HUD pass, a post-processing chain's final quad) is
//     drawn identically into both halves: flat, but never a broken tile;
//   - a frame the page did not draw (render-on-demand pages) is replayed from the page's last
//     screen draws, so the tile is redrawn every frame (woven-canvas rules) and head motion still
//     looks around.
// It stands down when a renderer presents through renderer.xr (and, via the core, for SDK / WebXR
// pages).
//
// Two renderer DRIVERS share all of the above (v0.6.1, P-W1b): WebGLRenderer, and three's common
// `Renderer` behind WebGPURenderer (st.common), on either of its backends — WebGPU, or the WebGL2
// fallback (`forceWebGL`, or no adapter at init). The common renderer differs where it matters, and
// only there does its driver differ (see "WebGPURenderer" below): it is tracked from its constructor
// but converts only once init() has resolved (the backend is final then); its eye cameras carry the
// renderer's coordinateSystem and get the runtime's projection in that system's clip space
// (surface.toClip on WebGPU, reversed-Z when reversedDepthBuffer); its clears ignore the scissor, so
// the eye pair is drawn the way its output path allows (eyeBegin); three's own reads of its size /
// viewport getters see the REAL store (its screen nodes and output pass sample by them); and a
// PostProcessing chain is reported 'flat' with a reason, not split. Verified revisions: GPU_REVS.
function dxrThree(core) {
  core.registerEngine('three.js');
  const { info, warnOnce, desc, realW, realH } = core;
  // A duck-typed Vector2 for three's getSize(target), which only calls target.set().
  const vec2 = () => ({ x: 0, y: 0, set(x, y) { this.x = x; this.y = y; return this; } });

  const states = new WeakMap(); // renderer -> state
  let revision = null;
  Object.defineProperty(core.meta, 'revision', { enumerable: true, get: () => revision });

  // ------------------------------------------------------------ the three.js devtools listeners
  // The sentinel owns `__THREE_DEVTOOLS__` and forwards every 'observe' / 'register' event here,
  // starting with the one that made it load the core.
  // Both are no-ops once the core has stood down for good (core.retired: the page owns XR, opted
  // out, the guard blocked): nothing new is detected or wrapped in this document.
  const onObserve = (e) => {
    if (core.retired) return;
    const o = e && e.detail;
    if (!o) return;
    if (o.isScene) { hookLookAt(o); return; }
    if (o.isWebGPURenderer) { trackCommon(o); return; }
    if (o.isWebGLRenderer || (o.domElement && typeof o.render === 'function' && typeof o.getContext === 'function')) track(o);
  };
  // WebGPURenderer (three r178+ announces it on __THREE_DEVTOOLS__ from its constructor; earlier
  // revisions never do, so they are never seen). Driven on the revisions this driver was read and
  // tested against (the private fields it reads, _initialized / _getFrameBufferTarget, and the output
  // pass it relies on move between releases); any other revision, or an object without the common
  // Renderer API, is left untouched and reported 'flat' with the reason.
  const GPU_REVS = [178, 186];
  const COMMON_API = ['render', 'setSize', 'setPixelRatio', 'getPixelRatio', 'getSize', 'getDrawingBufferSize', 'setViewport', 'setScissor', 'setScissorTest', 'getRenderTarget', 'setRenderTarget', 'getContext'];
  const seenCommon = new WeakSet();
  function trackCommon(r) {
    if (seenCommon.has(r)) return;
    seenCommon.add(r);
    if (!(r.domElement instanceof HTMLCanvasElement)) { warnOnce('webgpu', 'WebGPURenderer seen (no canvas element) — not converted, left 2D'); return; }
    const rev = parseInt(revision, 10);
    let why = null;
    if (!(rev >= GPU_REVS[0] && rev <= GPU_REVS[1])) why = `WebGPURenderer r${revision || '?'} — the driver is verified on r${GPU_REVS[0]}–r${GPU_REVS[1]} only`;
    else if (!r.backend || !('autoClearColor' in r) || COMMON_API.some((k) => typeof r[k] !== 'function')) why = 'WebGPURenderer without the common Renderer API (backend, autoClearColor, setViewport …)';
    if (why) { core.noteFlat('three.js', r.domElement, why); return; }
    track(r, true);
  }
  const onRegister = (e) => { if (core.retired) return; if (e && e.detail && e.detail.revision) revision = e.detail.revision; };

  // ------------------------------------------------------------ convergence target: camera.lookAt
  // OrbitControls / MapControls / TrackballControls all end their update() in
  // `this.object.lookAt(this.target)`, and a page that aims its camera once calls lookAt too. The
  // controls' handlers are bound functions, so the controls instance itself is not reachable from
  // the canvas; the lookAt call is. Object3D.prototype.lookAt is wrapped the first time a Scene is
  // announced (a Scene is built before the camera and its controls on every page seen), recording
  // the world point per CAMERA. Nothing else is touched, and the call goes through unchanged. The
  // core only uses the point while the camera still looks at it.
  const lookAts = new WeakMap(); // camera -> { x, y, z } (world), the last lookAt
  const hookedProtos = new WeakSet();
  function hookLookAt(obj) {
    let p = Object.getPrototypeOf(obj);
    while (p && !Object.prototype.hasOwnProperty.call(p, 'lookAt')) p = Object.getPrototypeOf(p);
    if (!p || hookedProtos.has(p) || typeof p.lookAt !== 'function') return;
    hookedProtos.add(p);
    const orig = p.lookAt;
    try {
      p.lookAt = function (x, y, z) {
        if (this && this.isCamera) {
          const v = x && typeof x === 'object' ? x : null;
          const t = v ? { x: v.x, y: v.y, z: v.z } : { x, y, z };
          if (isFinite(t.x) && isFinite(t.y) && isFinite(t.z)) lookAts.set(this, t);
        }
        return orig.apply(this, arguments);
      };
    } catch (e) { warnOnce('lookat', 'could not watch camera.lookAt — convergence falls back to the estimator', e); }
  }
  // Globals some pages keep their controls in. Conservative: only an object whose .object IS the
  // page camera and whose .target is a Vector3.
  const CONTROL_GLOBALS = ['controls', 'orbitControls', 'cameraControls'];

  // ------------------------------------------------------------ the adapter hooks the core calls
  const ad = {
    label: (st) => `three r${revision || '?'}` + (st && st.common ? ` (WebGPURenderer, ${backendOf(st) || 'not initialised'})` : ''),
    unqualified(st) {
      if (st.viewJitter) return st.flatReason;
      if (st.common) {
        if (!ready(st)) return 'WebGPURenderer not initialised yet';
        if (st.gpuPostfx) return st.flatReason;
      }
      const camera = st.qualifyCam;
      if (!camera || !camera.isPerspectiveCamera || camera.isArrayCamera) return 'the screen camera is not a PerspectiveCamera';
      const where = core.canvasPlacement(st.canvas);
      if (where) return where;
      if (!(st.L.w > 0 && st.L.h > 0)) return 'renderer has no size yet';
      return core.cssEffect(st.canvas);
    },
    hasCamera: (st) => !!st.mainCam,
    depthRange: (st) => ({ near: st.mainCam.near, far: st.mainCam.far }),
    rigFov: (st) => { const cam = st.mainCam; return 2 * Math.atan(Math.tan(((cam.fov || 50) * Math.PI) / 360) / (cam.zoom || 1)); },
    sampler(st) {
      const scene = st.lastScene, cam = st.mainCam;
      if (!scene || !cam || !cam.matrixWorldInverse) return null;
      return {
        cameraPose: cam.matrixWorld.elements,
        viewMatrix: cam.matrixWorldInverse.elements,
        tanHalfFov: Math.tan(((cam.fov || 50) * Math.PI) / 360) / (cam.zoom || 1),
        aspect: cam.aspect || 1,
        near: cam.near, far: cam.far,
        forEachBounds: (cb) => forEachBounds(scene, cam, cb),
      };
    },
    fakeViewParams(st) {
      const cam = st.mainCam;
      return {
        near: cam.near, far: cam.far,
        t: (cam.near * Math.tan(((cam.fov || 50) * Math.PI) / 360)) / (cam.zoom || 1),
        aspect: st.L.w / (st.L.h || 1),
      };
    },
    beforeActive: (st) => core.virtualizeCanvas(st, () => { if (applyRealSize(st)) repaintNow(st); }),
    afterActive(st) {
      applyRealSize(st);
      const camera = st.mainCam;
      if (camera.parent === null) camera.updateMatrixWorld();
    },
    firstDraw(st) {
      if (st.idleOps) {
        // Flipped from idle (flipIdle): repaint the page's whole last frame (HUD passes included),
        // not just the scene, and keep it as the frame the session replays.
        const ops = st.idleOps.map((op) => (op[0] === 'clear' ? op : ['render', op[1], op[2], isMainPerspective(st, op[2])]));
        st.idleOps = null;
        replay(st, ops);
        st.lastOps = ops;
        return;
      }
      if (st.postfx && st.monoOps && st.monoOps.length) {
        // A post-processing page: its screen draws are the chain's final passes, whose render targets
        // still hold the last composed frame. Repaint those, flat, instead of the bare scene.
        const ops = st.monoOps.map((op) => (op[0] === 'clear' ? op : ['render', op[1], op[2], false]));
        replay(st, ops);
        st.lastOps = ops;
        return;
      }
      renderFlat(st, st.lastScene, st.mainCam); // repaint NOW: the resize just cleared the store
      st.lastOps = [['render', st.lastScene, st.mainCam, true]];
    },
    redraw(st) {
      // A page that drew nothing since the last session frame gets its last screen draws replayed.
      if (st.frame.drew) st.lastOps = st.frame.ops.length <= 32 ? st.frame.ops : null;
      else if (st.lastOps) replay(st, st.lastOps);
      st.frame = { drew: false, ops: [] };
    },
    // The out-cover's pixels: the left eye of the pair just drawn, read back from the GL context —
    // drawImage() of the layer-bound canvas is empty. Taken by takeCover() below, not by the core.
    coverAfterDraw: true,
    // WebGLRenderer: its WebGL context (readPixels, the GL limits). WebGPURenderer: chosen from its
    // backend once init() has resolved (null before: the core asks again). WebGPU: the backend's device
    // and the canvas context (read live: r186's canvas targets swap it), no flush (three submits each
    // render pass in finishRender, so a read right after render() sees the frame), and the alphaMode
    // three configured (alpha, default true -> 'premultiplied'). WebGL2 fallback: its context, as above.
    surface(st) {
      const r = st.r;
      if (st.common) {
        if (!ready(st) || !r.backend) return null;
        if (r.backend.isWebGPUBackend) {
          return core.surfaces.gpu({
            get device() { return r.backend.device; }, get context() { return r.getContext(); },
            flush() {},
            get alphaMode() { const a = typeof r.alpha === 'boolean' ? r.alpha : r.backend.parameters && r.backend.parameters.alpha; return a === false ? 'opaque' : 'premultiplied'; },
          });
        }
        const gl = r.backend.gl || r.getContext();
        return gl ? core.surfaces.gl(gl) : null;
      }
      const gl = r && typeof r.getContext === 'function' ? r.getContext() : null;
      return gl ? core.surfaces.gl(gl) : null;
    },
    restore(st, wasLive) {
      const last = st.lastOps;
      st.lastOps = null; st.frame = { drew: false, ops: [] }; st.idleOps = null;
      disposeChain(st);
      core.unvirtualizeCanvas(st);
      if (wasLive) {
        try {
          st.call('setPixelRatio', st.L.pr);
          st.call('setSize', st.L.w, st.L.h, false);
          st.call('setViewport', ...st.L.vp);
          st.call('setScissor', ...st.L.sc);
          st.call('setScissorTest', st.L.scTest);
          // The resize cleared the store: redraw the page's last frame, mono, in this same task, so
          // the store holds a mono picture before the core releases the layer. It is also the frame
          // a later re-enable replays (wake).
          const mono = last && last.length ? last.map((op) => (op[0] === 'clear' ? op : ['render', op[1], op[2]]))
            : st.lastMono ? [['render', st.lastMono.scene, st.lastMono.camera]] : null;
          if (mono) { monoReplay(st, mono); st.monoOps = mono; }
        } catch (e) { /* the page's next frame repaints */ }
      }
      return true; // drawn now (or cleared by the resize): never the side-by-side pair
    },
    flipIdle(st) {
      if (st.armed && st.lastMono) {
        const { scene, camera } = st.lastMono;
        const ops = st.monoOps && st.monoOps.length ? st.monoOps : [['render', scene, camera]];
        monoReplay(st, ops); // the page's whole last frame: the cover is taken from it
        st.idleOps = ops;
        flip(st, scene, camera);
      }
    },
    // Re-enabled on a page that draws on demand: replay its last mono frame through the wrapped
    // renderer, which is the page's own draw as far as activation is concerned.
    wake(st) {
      const ops = st.monoOps;
      if (!ops || !ops.length || st.active) return;
      const r = st.r;
      const prevRT = st.call('getRenderTarget');
      if (prevRT !== null) st.call('setRenderTarget', null);
      try {
        for (const op of ops) { if (op[0] === 'clear') r.clear(op[1], op[2], op[3]); else r.render(op[1], op[2]); }
      } finally { if (prevRT !== null) st.call('setRenderTarget', prevRT); }
    },
    target(st) {
      const cam = st.mainCam;
      if (!cam) return null;
      for (const k of CONTROL_GLOBALS) {
        try {
          const c = window[k];
          if (c && c.object === cam && c.target && c.target.isVector3) return { x: c.target.x, y: c.target.y, z: c.target.z, via: `window.${k}.target` };
        } catch (e) { /* ignore */ }
      }
      const l = lookAts.get(cam);
      return l ? { x: l.x, y: l.y, z: l.z, via: 'camera.lookAt' } : null;
    },
    describe: (st) => ({
      page: { w: st.L.w, h: st.L.h, pr: st.L.pr, canvasWidthSeenByPage: st.canvas.width },
      extra: st.common ? {
        renderer: 'WebGPURenderer', backend: backendOf(st), surface: st.surf ? st.surf.kind : null, clearPath: st.clearPath || null,
        coordinateSystem: ready(st) ? st.r.coordinateSystem : null, outCoverVia: st.outCoverVia || null,
        eyeProj0: st.eyes ? Array.from(st.eyes[0].projectionMatrix.elements) : null, // what three draws eye 0 with
        eyeCoord0: st.eyes ? st.eyes[0].coordinateSystem : null,
      } : st.postfx ? {
        chainMirror: st.mirrorX === undefined ? null : st.mirrorX, mirrorCorr: st.mirrorCorr, // [as drawn, mirrored] (probeMirror)
        mirrorWhy: st.mirrorWhy, mirrorAsks: st.mirrorAsks,
      } : undefined,
    }),
  };

  // ------------------------------------------------------------ per-renderer wrapping
  const ready = (st) => !st.common || (typeof st.r.hasInitialized === 'function' ? st.r.hasInitialized() === true : st.r._initialized === true);
  const backendOf = (st) => { const b = st.common && ready(st) ? st.r.backend : null; return !b ? null : b.isWebGPUBackend ? 'webgpu' : b.isWebGLBackend ? 'webgl2' : 'unknown'; };
  function track(r, common = false) {
    if (states.has(r)) return;
    const canvas = r.domElement;
    if (!(canvas instanceof HTMLCanvasElement)) { warnOnce('offscreen', 'renderer on an OffscreenCanvas — not supported, left 2D'); return; }
    const st = core.newState('three.js', canvas, ad);
    Object.assign(st, {
      r, depth: 0, orig: {}, common,
      // WebGPURenderer: a screen draw with a non-perspective camera whose render (nested) drew a
      // perspective camera into a render target — a PostProcessing chain (pass(scene, camera)).
      nestPersp: null, gpuPostfx: false, clearPath: null,
      L: { w: 0, h: 0, pr: 1, vp: [0, 0, 0, 0], sc: [0, 0, 0, 0], scTest: false }, // what the PAGE believes
      eyes: null, eyesFor: null, m4: null,
      mainCam: null, lastScene: null, lastMono: null, qualifyCam: null,
      frame: { drew: false, ops: [] }, lastOps: null,
      monoOps: null, monoCur: null, monoOpen: false, idleOps: null, // the page's last MONO frame (draws before / between conversions)
      // Post-processing (see "post-processing chains" below): set once the page is seen drawing its
      // scene into a render target and then a full-screen pass to the screen.
      postfx: false, seedTask: null, twins: new Map(), texTwin: new Map(), chainStereo: false,
      // The scene pass's view offset (see "the page camera's view window" below): viewOk once frames end
      // with it still set and viewTrend calls it framing; viewJitter once a frame cleared it, or it
      // dithered from frame to frame (TAA / SSAA).
      viewOk: false, viewJitter: false, seedMiss: null, missLogged: null,
      viewHist: [], viewSteps: 0, viewWait: null, // the view at the end of each frame (viewTrend)
      // Whether the chain flips its picture left-right (probeMirror): undefined until a frame decides.
      mirrorX: undefined, mirrorCorr: null, mirrorNext: 0, mirrorGiveUp: null, mirrorWhy: null, mirrorAsks: 0,
    });
    states.set(r, st);
    wrap(st);
    try {
      const s = st.call('getSize', vec2());
      st.L.w = s.x; st.L.h = s.y;
      st.L.pr = st.call('getPixelRatio');
      st.L.vp = [0, 0, st.L.w, st.L.h];
      st.L.sc = [0, 0, st.L.w, st.L.h];
      st.L.scTest = !!st.call('getScissorTest');
    } catch (e) { /* an old three without these: the page's own setSize fills L in */ }
    info(`three.js r${revision || '?'} ${common ? 'WebGPURenderer' : 'renderer'} found on`, desc(canvas));
  }

  function wrap(st) {
    const r = st.r;
    // Call an original with the depth guard up: three's own nested calls (setPixelRatio -> setSize,
    // setSize -> setViewport, render -> clear / setRenderTarget, a Reflector's onBeforeRender) then
    // pass straight through the wrappers instead of being re-mapped a second time.
    st.call = (name, ...a) => {
      const f = st.orig[name] || r[name];
      st.depth++;
      try { return f.apply(r, a); } finally { st.depth--; }
    };
    const W = (name, impl) => {
      const f = r[name];
      if (typeof f !== 'function') return;
      st.orig[name] = f;
      r[name] = function (...a) { return impl(...a); };
    };
    const top = () => st.depth === 0;
    const v4 = (x, y, w, h) => (x && x.isVector4 ? [x.x, x.y, x.z, x.w] : [x, y, w, h]);

    W('setSize', (w, h, updateStyle = true) => {
      if (!top()) return st.call('setSize', w, h, updateStyle);
      st.L.w = w; st.L.h = h; st.L.vp = [0, 0, w, h]; // three resets the viewport on setSize
      if (!st.active) return st.call('setSize', w, h, updateStyle);
      if (updateStyle !== false) { st.canvas.style.width = w + 'px'; st.canvas.style.height = h + 'px'; }
      if (applyRealSize(st)) repaintNow(st);
    });
    W('setPixelRatio', (v) => {
      if (!top() || v === undefined) return st.call('setPixelRatio', v);
      st.L.pr = v;
      if (!st.active) return st.call('setPixelRatio', v);
      if (applyRealSize(st)) repaintNow(st);
    });
    W('setDrawingBufferSize', (w, h, pr) => {
      if (!top()) return st.call('setDrawingBufferSize', w, h, pr);
      st.L.w = w; st.L.h = h; st.L.pr = pr; st.L.vp = [0, 0, w, h];
      if (!st.active) return st.call('setDrawingBufferSize', w, h, pr);
      if (applyRealSize(st)) repaintNow(st);
    });
    // Getters answer with the PAGE's numbers while converted, even when called from inside a render
    // (an effect sizing itself in onBeforeRender must see the mono canvas it was written for).
    // WebGPURenderer: three ITSELF reads these (screen-space nodes: screenUV / screenSize / viewport, the
    // output pass sampling the frame-buffer target, the backend sizing its colour buffer). Those reads
    // happen inside our own calls (st.depth > 0) and must see the real store; the page's see its own.
    const real = () => st.common && !top();
    W('getSize', (t) => {
      const inner = real();
      const out = st.call('getSize', t);
      if (st.active && out && !inner) { if (typeof out.set === 'function') out.set(st.L.w, st.L.h); else { out.width = st.L.w; out.height = st.L.h; } }
      return out;
    });
    W('getPixelRatio', () => (st.active && !real() ? st.L.pr : st.call('getPixelRatio')));
    // One exception: Spark's own per-pixel terms (see "Spark's pixel size" below) get the EYE.
    W('getDrawingBufferSize', (t) => {
      const inner = real();
      const out = st.call('getDrawingBufferSize', t);
      if (st.active && out && typeof out.set === 'function' && !inner) {
        if (sparkIn > 0 && st.inEye && st.R) out.set(st.R.eyeW, st.R.eyeH);
        else out.set(Math.floor(st.L.w * st.L.pr), Math.floor(st.L.h * st.L.pr));
      }
      return out;
    });
    W('setViewport', (x, y, w, h) => {
      if (!top()) return st.call('setViewport', x, y, w, h);
      st.L.vp = v4(x, y, w, h);
      if (!st.active) return st.call('setViewport', x, y, w, h);
    });
    W('getViewport', (t) => {
      const inner = real();
      const out = st.call('getViewport', t);
      if (st.active && out && typeof out.set === 'function' && !inner) out.set(...st.L.vp);
      return out;
    });
    W('setScissor', (x, y, w, h) => {
      if (!top()) return st.call('setScissor', x, y, w, h);
      st.L.sc = v4(x, y, w, h);
      if (!st.active) return st.call('setScissor', x, y, w, h);
    });
    W('getScissor', (t) => {
      const inner = real();
      const out = st.call('getScissor', t);
      if (st.active && out && typeof out.set === 'function' && !inner) out.set(...st.L.sc);
      return out;
    });
    W('setScissorTest', (b) => {
      if (!top()) return st.call('setScissorTest', b);
      st.L.scTest = !!b;
      if (!st.active) return st.call('setScissorTest', b);
    });
    W('getScissorTest', () => (st.active && !real() ? st.L.scTest : st.call('getScissorTest')));
    W('clear', (color, depth, stencil) => {
      const rt = st.call('getRenderTarget');
      if (top() && st.active && st.postfx && rt && st.twins.has(rt)) return clearChain(st, rt, color, depth, stencil);
      if (!top() || rt !== null) return st.call('clear', color, depth, stencil);
      if (!st.active) { recordMono(st, ['clear', color, depth, stencil]); return st.call('clear', color, depth, stencil); }
      st.frame.drew = true;
      st.frame.ops.push(['clear', color, depth, stencil]);
      forEyes(st, () => st.call('clear', color, depth, stencil));
    });
    W('render', (scene, camera) => {
      if (st.common && !top()) { noteNested(st, camera); return st.call('render', scene, camera); }
      if (!top() || !scene || !camera) return st.call('render', scene, camera);
      // WebGPURenderer before init(): three forwards to renderAsync (r178-r181) or throws (r182+). Not
      // ours to count: the backend (WebGPU, or the WebGL2 fallback) is not decided yet.
      if (st.common && !ready(st)) return st.call('render', scene, camera);
      if (st.common) st.nestPersp = null;
      st.stats.calls++;
      const target = st.call('getRenderTarget');
      const toScreen = target === null;
      const xrLive = !!(r.xr && r.xr.enabled && r.xr.isPresenting);
      if (!st.active) {
        const before = st.r.info && st.r.info.autoReset === false ? drawnSoFar(st) : 0;
        const out = st.call('render', scene, camera);
        if (!toScreen && !xrLive) {
          const why = seedWhy(st, target, camera);
          if (why === null) markSeed(st, scene, camera, target, drawnSoFar(st) - before);
          else if (why) noteSeedMiss(st, why);
        }
        if (toScreen && !xrLive) {
          recordMono(st, ['render', scene, camera]);
          const persp = camera.isPerspectiveCamera && !camera.isArrayCamera;
          if (persp) {
            if (st.seedTask) st.seedTask.direct = true; // the scene also went straight to the screen: not a composer
            st.lastMono = { scene, camera }; st.sawPersp = true;
            hookLookAt(camera); // fallback for a page that built no Scene before its camera (rare)
            // Flip / qualify only on the scene draw itself — never on an ortho background, HUD or
            // post quad drawn in the same frame (the throttle would otherwise keep landing on it).
            if (st.armed) flip(st, scene, camera);
            else { st.qualifyCam = camera; core.considerActivation(st); }
          } else if (st.common && ((st.nestPersp && !st.sawPersp) || (st.seedTask && !st.seedTask.direct))) {
            gpuPostfx(st); // WebGPURenderer + a post-processing chain: flat with the reason, not split
          } else if (st.seedTask && !st.seedTask.direct) {
            // A post-processing frame: the scene went into a render target earlier in this task, and
            // this full-screen pass put the result on the screen. Qualify / flip on it, with the
            // scene's own camera, after the pass is drawn (the cover is taken from it).
            const sd = st.seedTask, main = sd.main; // the seed that drew the most: the scene (markSeed)
            st.postfx = true; st.sawPersp = true;
            st.lastMono = { scene: main.scene, camera: main.camera };
            hookLookAt(main.camera);
            st.qualifyCam = main.camera;
            // Does the chain flip the picture left-right? Read off this frame (probeMirror); until it
            // knows (a blank frame), the page is not qualified.
            if (st.mirrorX === undefined) probeMirror(st, sd, scene, camera);
            // A scene pass with a view offset qualifies once a frame has ENDED with it still set: TAA /
            // SSAA set it for their draws only and clear it before the task ends (markSeed).
            if (sd.view && !st.viewOk) sd.toScreen = true;
            else if (st.mirrorX === undefined) { /* qualified on a later frame, or by probeMirror's give-up */ }
            else if (st.armed) flip(st, main.scene, main.camera);
            else core.considerActivation(st);
          } else if (!st.sawPersp && (!st.lastWhy || (st.seedMiss && st.seedMiss !== st.missLogged))) {
            st.lastWhy = 'the screen camera is not a PerspectiveCamera';
            st.missLogged = st.seedMiss;
            info('not converting', desc(st.canvas), 'yet:', st.lastWhy, st.seedMiss
              ? `(the scene went into a render target first, but not as a post chain's input: ${st.seedMiss})`
              : '(a post-processing chain, or an ortho-only scene)');
          }
        }
        return out;
      }
      if (xrLive) { core.stand(st, 'the renderer is presenting WebXR'); return st.call('render', scene, camera); }
      if (!toScreen) {
        if (st.postfx) {
          // The scene pass seeds the per-eye chain; any pass writing a chain target or sampling one
          // is part of it. Everything else (picking, PMREM, cube cameras) stays a single mono draw.
          if (isSeed(st, target, camera)) {
            st.mainCam = camera; st.chainStereo = st.haveViews;
            const before = st.r.info && st.r.info.autoReset === false ? drawnSoFar(st) : 0;
            const out = renderIntoChain(st, scene, camera, target, true);
            // A view offset that turns out to be jitter stands down (viewJitter). The estimator and
            // Spark's hook read the frame's main seed, not an overlay seeded after it.
            markSeed(st, scene, camera, target, drawnSoFar(st) - before);
            st.lastScene = st.seedTask.main.scene;
            return out;
          }
          if (st.twins.has(target) || taintedSwaps(st, scene)) return renderIntoChain(st, scene, camera, target, false);
        }
        return st.call('render', scene, camera); // shadow / picking / other targets: untouched, mono
      }
      st.frame.drew = true;
      if (st.postfx && !isMainPerspective(st, camera) && taintedSwaps(st, scene)) {
        // The chain's final pass to the screen: once per eye, the right eye sampling the twins.
        st.frame.ops.push(['render', scene, camera, false, true]);
        const out = renderPostScreen(st, scene, camera);
        takeCover(st);
        return out;
      }
      const stereo = isMainPerspective(st, camera);
      st.frame.ops.push(['render', scene, camera, stereo]);
      const out = stereo ? renderStereo(st, scene, camera) : renderFlat(st, scene, camera);
      if (stereo) takeCover(st); // after the scene draw, never after a background/HUD pass alone
      // WebGPURenderer: a flat screen pass that drew the page camera into a target (PostProcessing
      // switched on while converted): stand down, flat with the reason.
      if (st.common && !stereo && st.nestPersp && st.nestPersp.camera === st.mainCam) { gpuPostfx(st); core.stand(st, WHY_GPU_POSTFX); }
      return out;
    });
    // WebGPURenderer: renderAsync() (deprecated in r181, still common on r178-r180 pages) renders through
    // _renderScene, bypassing render(): once initialised, route it through the wrapped render().
    if (st.common) {
      W('renderAsync', (scene, camera) => {
        if (top() && ready(st)) { try { r.render(scene, camera); return Promise.resolve(); } catch (e) { return Promise.reject(e); } }
        return st.call('renderAsync', scene, camera);
      });
    }
    W('dispose', (...a) => {
      if (st.active || st.pending || st.armed) core.stand(st, 'the page disposed the renderer');
      return st.call('dispose', ...a);
    });
  }
  function flip(st, scene, camera) {
    st.mainCam = camera; st.lastScene = scene;
    core.flip(st);
  }
  // WebGPURenderer post-processing. three's PostProcessing draws a full-screen QuadMesh with an
  // orthographic camera; its PassNode renders the scene with the page camera into a render target
  // from INSIDE that draw (a node's updateBefore), i.e. nested. The twin-chain logic of the WebGL
  // driver (EffectComposer) does not transfer to TSL node chains: not split, flat with the reason.
  const WHY_GPU_POSTFX = 'WebGPU PostProcessing — not split yet (three.js PostProcessing / pass() chains stay 2D)';
  function noteNested(st, camera) {
    if (camera && camera.isPerspectiveCamera && !camera.isArrayCamera && st.call('getRenderTarget') !== null) st.nestPersp = { camera };
  }
  function gpuPostfx(st) {
    if (st.gpuPostfx) return;
    st.gpuPostfx = true; st.flatReason = WHY_GPU_POSTFX;
    info('three.js canvas', desc(st.canvas), 'stays 2D:', WHY_GPU_POSTFX);
    if (st.pending || st.armed) core.stand(st, WHY_GPU_POSTFX);
    core.notify();
  }
  // The page's screen draws while NOT converted, one list per task (a page draws its frame in one
  // callback). The last complete list is the mono frame wake / flipIdle replay.
  function recordMono(st, op) {
    if (!st.monoOpen) {
      st.monoOpen = true;
      const cur = (st.monoCur = []);
      queueMicrotask(() => { st.monoOpen = false; if (cur.length && cur.length <= 32) st.monoOps = cur; });
    }
    st.monoCur.push(op);
  }
  // Draw ops as the page drew them: mono, through the originals, to the screen.
  function monoReplay(st, ops) {
    const prevRT = st.call('getRenderTarget');
    if (prevRT !== null) st.call('setRenderTarget', null);
    try {
      for (const op of ops) { if (op[0] === 'clear') st.call('clear', op[1], op[2], op[3]); else st.call('render', op[1], op[2]); }
    } finally { if (prevRT !== null) st.call('setRenderTarget', prevRT); }
  }

  // ------------------------------------------------------------ sizing
  // Returns true when the backing store actually changed (and was therefore cleared).
  function applyRealSize(st) {
    const R = core.realSizeFor(st);
    st.R = R;
    const pr1 = st.call('getPixelRatio') === 1;
    // A no-op setSize still writes canvas.width, which reallocates and CLEARS the buffer (porting pitfall 18).
    if (pr1 && realW(st.canvas) === R.W && realH(st.canvas) === R.H) return false;
    st.stats.resizes++;
    if (!pr1) st.call('setPixelRatio', 1);
    st.call('setSize', R.W, R.H, false);
    return true;
  }

  // ------------------------------------------------------------ drawing
  function isMainPerspective(st, camera) {
    if (!camera.isPerspectiveCamera || camera.isArrayCamera) return false;
    // A view offset (setViewOffset) is the page's framing, carried into the eyes (applyView). Tiles drawn
    // into several viewports fail the full-viewport test below.
    const [x, y, w, h] = st.L.vp;
    return x === 0 && y === 0 && Math.abs(w - st.L.w) < 1 && Math.abs(h - st.L.h) < 1;
  }
  // The page's logical viewport / scissor, mapped into eye half i of the SBS store.
  function setEyeViewport(st, i) {
    const R = st.R, L = st.L;
    const sx = R.eyeW / (L.w || 1), sy = R.eyeH / (L.h || 1), ox = i * R.eyeW;
    const [vx, vy, vw, vh] = L.vp;
    st.call('setViewport', ox + vx * sx, vy * sy, vw * sx, vh * sy);
    const [cx, cy, cw, ch] = L.scTest ? L.sc : [0, 0, L.w, L.h];
    const x0 = Math.max(0, cx * sx), y0 = Math.max(0, cy * sy);
    const x1 = Math.min(R.eyeW, (cx + cw) * sx), y1 = Math.min(R.eyeH, (cy + ch) * sy);
    st.call('setScissor', ox + x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0));
    st.call('setScissorTest', true); // confines three's autoClear to this eye's half
  }
  function forEyes(st, fn) {
    try { for (let i = 0; i < 2; i++) { setEyeViewport(st, i); fn(i); } }
    finally { st.call('setScissorTest', false); }
  }
  function perspectiveClass(cam) {
    for (let p = Object.getPrototypeOf(cam); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
      if (Object.prototype.hasOwnProperty.call(p, 'setFocalLength')) return p.constructor; // PerspectiveCamera.prototype
    }
    return cam.constructor;
  }
  function eyeCameras(st, camera) {
    if (st.eyes && st.eyesFor === camera.constructor) return st.eyes;
    const P = perspectiveClass(camera);
    const mk = () => {
      const e = new P();
      e.name = 'dxr-auto3d-eye';
      e.matrixAutoUpdate = false;                                        // the matrices are the runtime's
      if ('matrixWorldAutoUpdate' in e) e.matrixWorldAutoUpdate = false; // and render() must not recompose them
      return e;
    };
    st.eyes = [mk(), mk()];
    st.eyesFor = camera.constructor;
    st.m4 = camera.matrixWorld.clone(); // a Matrix4 of the page's own three, as scratch
    return st.eyes;
  }
  const invertFrom = (m, src) => { if (typeof m.invert === 'function') m.copy(src).invert(); else m.getInverse(src); return m; };
  const reversedDepth = (st) => {
    const d = st.r.state && st.r.state.buffers && st.r.state.buffers.depth;
    return !!(d && typeof d.getReversed === 'function' && d.getReversed());
  };
  // A GL projection (z_ndc -1..1) to three's reversed-Z form (near 1, far 0): z row := (w row − z row) / 2.
  // Touches only the depth row, so the runtime's off-axis x / y terms survive exactly. Checked against
  // three r180 Matrix4.makePerspective(…, reversedDepth): c = n/(f−n), d = f·n/(f−n).
  function toReversedZ(e) {
    for (const c of [0, 4, 8, 12]) e[c + 2] = (e[c + 3] - e[c + 2]) / 2;
  }
  // Eye i's projection, from the runtime's (GL clip z -1..1), in the clip space the renderer draws with.
  // WebGLRenderer: as is, or reversed-Z (above). WebGPURenderer: the common Renderer re-derives
  // (updateProjectionMatrix: a SYMMETRIC frustum, the runtime's off-axis one lost) any camera whose
  // coordinateSystem differs from the renderer's, or that is not marked reversed on a
  // reversedDepthBuffer renderer (r182+), so both are set here, before render(); and the matrix is put in
  // that system's clip space: reversed-Z (the same row for both systems, Matrix4.makePerspective), else
  // WebGPU's z 0..1 (surface.toClip) on the WebGPU backend, else GL's as is (the WebGL2 fallback).
  // Frustum culling reads the matrix with the same coordinateSystem, so it culls what is drawn.
  // mirror: the post chain flips the picture left-right (probeMirror): S·P·S, before the view window.
  // view: the page camera's view window (setViewOffset), applied next (applyView).
  function eyeProjection(st, e, i, rev, view, mirror) {
    const m = e.projectionMatrix.elements;
    e.projectionMatrix.fromArray(st.V[i].proj);
    if (mirror) conjX(m);
    if (view) applyView(m, view);
    if (st.common) {
      e.coordinateSystem = st.r.coordinateSystem;
      if (st.r.reversedDepthBuffer === true) { toReversedZ(m); e._reversedDepth = true; }
      else {
        const sf = core.surfaceOf(st);
        if (sf && sf.kind === 'webgpu' && core.T.gpuDepthRange !== false) sf.toClip(m, m);
      }
    } else if (rev) {
      // Marked BEFORE render: on a reversed-depth renderer three otherwise calls
      // updateProjectionMatrix() on any camera not marked, which would replace the runtime's
      // off-axis frustum with a symmetric one (porting guide: never do that to an eye camera).
      toReversedZ(m);
      e._reversedDepth = true;
    }
    if (e.projectionMatrixInverse) invertFrom(e.projectionMatrixInverse, e.projectionMatrix);
  }

  // WebGPURenderer: how the pair is drawn into the one store. The common Renderer clears the WHOLE
  // attachment (WebGPU: loadOp 'clear', which ignores the scissor), so the WebGL driver's "the scissor
  // confines autoClear to this eye's half" does not hold. Two paths (st.clearPath, in state()):
  //   'fb'      the default (tone mapping, or an output colour space other than the working one, i.e.
  //             sRGB output): three draws each render() into an intermediate frame-buffer target, cleared
  //             whole, then an output pass (autoClear off) samples it at screenUV into the renderer's
  //             viewport + scissor on the canvas, which is loaded, never cleared. Per eye: clear the
  //             intermediate, draw this half, output this half. Nothing to change.
  //   'direct'  NoToneMapping + output = working colour space: the scene draws straight to the canvas,
  //             and eye 1's clear would wipe eye 0. Eye 0 clears the whole store (scissor off: one clear
  //             colour in both halves, the draw itself still confined by its viewport); eye 1 draws with
  //             autoClearColor off (depth / stencil still clear: harmless, eye 0 is done with them). A
  //             colour scene.background forces a clear, but only of what autoClearColor allows.
  function clearPathFor(st) {
    if (!st.common) return null;
    const r = st.r;
    let fb = true;
    try {
      if (typeof r.needsFrameBufferTarget === 'boolean') fb = r.needsFrameBufferTarget; // r182+: side-effect free
      else if (typeof r._getFrameBufferTarget === 'function') fb = st.call('_getFrameBufferTarget') !== null; // r178-r181 (sized by the real store: st.call)
    } catch (e) { fb = true; }
    return (st.clearPath = fb ? 'fb' : 'direct');
  }
  function eyeBegin(st, i, cp) {
    if (cp !== 'direct' || core.T.gpuClearFix === false) return;
    if (i === 0) { if (!st.L.scTest) st.call('setScissorTest', false); }
    else { st.acc = st.r.autoClearColor; st.r.autoClearColor = false; }
  }
  function eyeEnd(st) { if (st.acc !== undefined) { st.r.autoClearColor = st.acc; st.acc = undefined; } }

  // Both eyes of a pair are ONE renderer frame, as they are when three renders WebXR (one render()
  // call, one info.render.frame for both views). three itself keys its once-per-frame work on that
  // counter (geometry / attribute uploads, video textures, UBOs), and so do engines riding on three:
  // Spark (World Labs' splat renderer) re-generates and re-sorts its splats in onBeforeRender only
  // when the counter moved. Counted per eye, Spark regenerated and sorted twice per frame and the
  // shared sort order ping-ponged between the two eyes' viewpoints. So the second eye's render
  // reuses the first one's frame number; afterwards the counter is left at the highest value either
  // eye reached (nested renders — an engine's own render-target passes — advance it too), so the
  // next frame never reuses a number.
  const frameInfo = (st) => (st.r.info && st.r.info.render && typeof st.r.info.render.frame === 'number' ? st.r.info.render : null);
  function eyeFrame(fi, i, f) {
    if (!fi) return f;
    if (i === 0) return { f0: fi.frame, hi: fi.frame };
    f.hi = Math.max(f.hi, fi.frame);
    fi.frame = f.f0;
    return f;
  }
  const endFrame = (fi, f) => { if (fi && f && fi.frame < f.hi) fi.frame = f.hi; };

  // Spark's pixel size. A SparkRenderer's onBeforeRender sizes its splats in PIXELS from
  // renderer.getDrawingBufferSize() when it draws to the screen (the renderSize uniform: the
  // projection-to-pixel focal, the 0.3 px anti-alias blur, the min / max pixel radius, and the LoD's
  // pixel-scale limit). The getter answers the page's mono store while converted, which since P0.2
  // is smaller than the eye (the eye is sized from the element's device pixels; hello-world keeps a
  // pixel-ratio-1 store): Spark's pixel terms were off by that ratio. So, during an eye draw only, a
  // call made from inside a SparkRenderer's onBeforeRender sees the eye viewport (eyeW x eyeH) —
  // exactly what three's WebXR path hands Spark (its XR target's per-view size). Every other caller
  // keeps the mono answer. SparkRenderers are found among the scene's direct children (Spark's
  // examples add it there, and Spark's auto-created one is added there too), re-scanned every 60
  // eye draws or when the scene changes; one nested deeper keeps the mono size (flat terms, as before).
  let sparkIn = 0;
  const sparkHooked = new WeakSet();
  function hookSpark(st, scene) {
    const n = st.stats.stereo + st.stats.flat;
    if (scene === st.sparkScene && n - st.sparkScan < 60) return;
    st.sparkScene = scene; st.sparkScan = n;
    const ch = scene && scene.children;
    if (!ch) return;
    for (const o of ch) {
      if (!o || sparkHooked.has(o) || !isSparkRenderer(o) || typeof o.onBeforeRender !== 'function') continue;
      sparkHooked.add(o);
      const f = o.onBeforeRender;
      o.onBeforeRender = function () { sparkIn++; try { return f.apply(this, arguments); } finally { sparkIn--; } };
    }
  }
  function renderStereo(st, scene, camera) {
    st.mainCam = camera; st.lastScene = scene;
    hookSpark(st, scene);
    if (!st.haveViews) { // no eyes yet: flat into both halves, never a blank tile
      if (st.stats.twoView > 0) st.stats.flatAfterEyes++;
      return renderFlat(st, scene, camera);
    }
    // This frame's camera pose, parents included, before the eyes are composed from it. The scene
    // itself is updated by three inside each eye's render(), as it would be for the page's own.
    if (typeof camera.updateWorldMatrix === 'function') camera.updateWorldMatrix(true, false);
    else if (camera.parent === null) camera.updateMatrixWorld();
    const eyes = eyeCameras(st, camera);
    const rev = reversedDepth(st);
    const cp = clearPathFor(st);
    const sm = st.r.shadowMap, smAuto = sm ? sm.autoUpdate : undefined;
    const fi = frameInfo(st);
    let fr = null;
    st.inEye = true;
    try {
      for (let i = 0; i < 2; i++) {
        fr = eyeFrame(fi, i, fr);
        const e = eyes[i];
        st.m4.fromArray(core.eyePose(st, i, camera.matrixWorld.elements)); // + the display rig's pivot (core.pivotOffset)
        e.matrixWorld.multiplyMatrices(camera.matrixWorld, st.m4); // attach pattern: identity rig pose
        if (i === 0) st.eyeAt = e.matrixWorld.elements.slice(12, 15); // diagnostics (dev state(): eyeAt)
        e.matrix.copy(e.matrixWorld);
        invertFrom(e.matrixWorldInverse, e.matrixWorld);
        eyeProjection(st, e, i, rev, viewOf(camera));             // the runtime's off-axis frustum + the page's view window
        e.near = camera.near; e.far = camera.far; e.fov = camera.fov; e.aspect = camera.aspect; e.zoom = camera.zoom;
        if (e.layers && camera.layers) e.layers.mask = camera.layers.mask;
        setEyeViewport(st, i);
        eyeBegin(st, i, cp);
        if (i === 1 && sm) sm.autoUpdate = false; // shadow maps are view-independent: render them once
        st.call('render', scene, e);
      }
    } finally {
      st.inEye = false;
      eyeEnd(st);
      endFrame(fi, fr);
      if (sm) sm.autoUpdate = smAuto;
      st.call('setScissorTest', false);
    }
    st.stats.stereo++;
    core.drew(st);
  }
  function renderFlat(st, scene, camera) {
    hookSpark(st, scene);
    const cp = clearPathFor(st);
    const sm = st.r.shadowMap, smAuto = sm ? sm.autoUpdate : undefined;
    const fi = frameInfo(st);
    let fr = null;
    st.inEye = true;
    try {
      for (let i = 0; i < 2; i++) {
        fr = eyeFrame(fi, i, fr);
        setEyeViewport(st, i);
        eyeBegin(st, i, cp);
        if (i === 1 && sm) sm.autoUpdate = false;
        st.call('render', scene, camera);
      }
    } finally {
      st.inEye = false;
      eyeEnd(st);
      endFrame(fi, fr);
      if (sm) sm.autoUpdate = smAuto;
      st.call('setScissorTest', false);
    }
    st.stats.flat++;
    core.drew(st);
  }
  // Redraw the page's last screen draws (render-on-demand pages, or a resize that just cleared the
  // store). Stereo draws re-run with THIS frame's eyes, so an idle page still looks around.
  function replay(st, ops) {
    const prevRT = st.call('getRenderTarget');
    if (prevRT !== null) st.call('setRenderTarget', null);
    let drew = false;
    try {
      for (const op of ops) {
        if (op[0] === 'clear') forEyes(st, () => st.call('clear', op[1], op[2], op[3]));
        else if (op[4]) renderPostScreen(st, op[1], op[2]);
        else if (op[3]) renderStereo(st, op[1], op[2]);
        else renderFlat(st, op[1], op[2]);
      }
      st.stats.replays++;
      drew = true;
    } catch (e) {
      warnOnce('replay', 'replaying the last frame threw; idle frames will not be redrawn', e);
      st.lastOps = null;
    } finally {
      if (prevRT !== null) st.call('setRenderTarget', prevRT);
    }
    if (drew) takeCover(st); // the whole replayed frame, HUD passes included
  }
  // The out-cover is read right after a screen draw, in the SAME task: the drawing buffer is not
  // preserved, and the XR session frame is a different task from the page's own rAF draw.
  function takeCover(st) {
    if (st.outCoverDue) core.takeOutCover(st); // clears outCoverDue: at most once per frame
  }
  function repaintNow(st) {
    const ops = st.frame.ops.length ? st.frame.ops : st.lastOps;
    if (ops && ops.length) replay(st, ops);
  }

  // ------------------------------------------------------------ post-processing chains
  // A composer (three's EffectComposer, pmndrs postprocessing, or a page's own) draws the scene into
  // a render target with the page camera, runs full-screen passes between targets, and puts the
  // last one on the screen. Each eye needs its own copy of that whole chain. So:
  //   - SEED: a draw with the page camera into a target shaped like the canvas starts the chain.
  //     It runs twice: the left eye into the page's target, the right eye into a TWIN of it.
  //   - A draw that writes a chain target, or samples a chain texture, is part of the chain. It
  //     runs twice too; for the right eye its target is the twin, and every chain texture its
  //     materials sample is swapped to its twin for that one draw (and put back right after).
  //   - The pass that samples the chain onto the screen runs once per eye, into its half.
  // Each draw is duplicated the moment it happens, so a material whose uniforms the page rewrites
  // between passes (a two-pass blur on one material) is right for both eyes. Replaying a recorded
  // frame would not be. A target the chain never touches (picking, PMREM, a cube camera) keeps its
  // single mono draw.
  const TEX_PROPS = ['map', 'alphaMap', 'emissiveMap', 'envMap', 'lightMap', 'aoMap'];
  // Why a draw into render target rt is NOT a chain's seed: null when it is one, '' when it is not
  // even a candidate (no perspective camera, a cube / 3D / array target), else the reason, which the
  // 2D log line names (a page whose chain is missed says why).
  function seedWhy(st, rt, camera) {
    if (!rt || rt.isWebGLCubeRenderTarget || rt.isWebGL3DRenderTarget || rt.isWebGLArrayRenderTarget) return '';
    if (!camera || !camera.isPerspectiveCamera || camera.isArrayCamera) return '';
    if (st.active && st.mainCam && camera !== st.mainCam) return 'not the page camera';
    const L = st.L;
    if (!(L.w > 0 && L.h > 0 && rt.width > 0 && rt.height > 0)) return 'the renderer or the target has no size yet';
    const a = L.w / L.h, near = (x) => Math.abs(x - a) / a < 0.1;
    const tgt = `target ${Math.round(rt.width)}x${Math.round(rt.height)}`;
    // Shaped like the canvas: excludes a PMREM / cube-face draw (square camera, atlas-shaped
    // target) and a picking draw (tiny target).
    if (!near(rt.width / rt.height)) return `${tgt} is not shaped like the ${L.w}x${L.h} canvas`;
    if (!near(camera.aspect || a)) return `camera aspect ${(+camera.aspect).toFixed(3)} is not the canvas's ${a.toFixed(3)}`;
    if (!(rt.width >= 0.5 * L.w * L.pr && rt.height >= 0.5 * L.h * L.pr)) return `${tgt} is under half the canvas's ${Math.round(L.w * L.pr)}x${Math.round(L.h * L.pr)} px`;
    return null;
  }
  const isSeed = (st, rt, camera) => seedWhy(st, rt, camera) === null;
  // drawn: what the seed's own draw drew (triangles + points + lines; drawnSoFar). A frame may seed more
  // than one target with the page camera (visual-learning.app/sandworm, on the panel: the scene, then
  // two overlay scenes of points / lines into targets of their own). `main` is the one that drew the
  // most: the scene, which probeMirror compares the chain's output with.
  function markSeed(st, scene, camera, rt, drawn = 0) {
    const prev = st.seedTask, view = viewSnap(camera);
    // Two seeds of one camera with different views in one frame: SSAA's per-sample jitter.
    const mixed = !!prev && (prev.mixed || (prev.camera === camera && !sameView(prev.view, view)));
    const main = !prev || drawn > prev.main.drawn ? { scene, camera, rt, drawn } : prev.main;
    st.seedTask = { scene, camera, rt, view, mixed, n: prev ? prev.n + 1 : 1, main };
    if (prev) return;
    queueMicrotask(() => { // a page draws its frame in one task
      const sd = st.seedTask;
      st.seedTask = null;
      if (!sd || !sd.view) return;
      // A view offset still set when the task ends is the page's framing; one set for the scene pass
      // alone (set, draw, cleared), or several in one frame, is TAA / SSAA jitter. So is one left set
      // that dithers frame to frame (viewTrend).
      if (sd.mixed || !sameView(sd.view, viewSnap(sd.camera))) { viewJitter(st); return; }
      const trend = viewTrend(st, sd.view, sd.rt);
      if (trend === 'jitter') { viewJitter(st); return; }
      if (st.viewOk) return;
      if (trend === 'framing') { viewReady(st, sd); return; }
      // Not known yet (a view that moved by less than a pixel, fewer than VIEW_FRAMES frames ago). A
      // page that stops drawing here is not jittering: framing, 1 s after its last frame.
      clearTimeout(st.viewWait);
      st.viewWait = setTimeout(() => { if (!st.viewOk && !st.viewJitter) viewReady(st, sd); }, 1000);
    });
  }
  function viewReady(st, sd) {
    st.viewOk = true;
    clearTimeout(st.viewWait);
    // The frame that put the chain on the screen waited for this (render()): qualify it now.
    if (sd.toScreen && st.mirrorX !== undefined && !st.active && !st.pending && !st.armed) { st.qualifyCam = sd.main.camera; core.considerActivation(st); }
  }
  // Primitives the renderer has counted. render() zeroes the count first (info.autoReset, the default),
  // so after one render() the count is that render's own; a page that turned autoReset off accumulates,
  // and the caller takes the difference around the render.
  const drawnSoFar = (st) => { const ri = st.r.info && st.r.info.render; return ri ? (ri.triangles || 0) + (ri.points || 0) + (ri.lines || 0) : 0; };
  // The last near-miss seed of this task, for the 2D log line.
  function noteSeedMiss(st, why) {
    if (st.seedMiss === null) queueMicrotask(() => { st.seedMiss = null; });
    st.seedMiss = why;
  }

  // ------------------------------------------------------------ the page camera's view window
  // A page may frame its picture with camera.setViewOffset: a lens shift (visual-learning.app keeps
  // the subject centred between its HUD panels), a crop zoom, a tile of a larger image. three draws
  // that view as a SUB-WINDOW of the camera's image plane, which in NDC is a 2D scale + offset:
  // x' = a·x + b, y' = c·y + d (a = fullWidth / width, b = a·(1 − 2·offsetX / fullWidth) − 1; c, d
  // likewise, with offsetY measured down from the top). In clip space (x' = a·x + b·w) it applies to
  // any projection, so each eye's off-axis frustum gets the page's framing exactly (equal to three
  // r180's updateProjectionMatrix to 4e-16, symmetric and off-axis). Both eyes get the same window:
  // the convergence plane keeps zero disparity, and a crop zoom magnifies the disparity with the
  // picture, as zooming into a stereo photo does. Touches the x / y rows only, so it commutes with the
  // reversed-Z and WebGPU depth conversions (z row).
  //
  // TAA / SSAA also use setViewOffset: a sub-pixel jitter set for the scene draw and cleared after
  // it. Those stay 2D (viewJitter): TAA stops drawing the scene once its accumulation completes, so
  // the eyes would freeze on the held frame while the head moves.
  const viewOf = (cam) => (cam && cam.view && cam.view.enabled ? cam.view : null);
  const viewSnap = (cam) => { const v = viewOf(cam); return v ? [v.fullWidth, v.fullHeight, v.offsetX, v.offsetY, v.width, v.height] : null; };
  const sameView = (p, q) => (p === null || q === null ? p === q : p.every((x, i) => x === q[i]));
  function applyView(m, v) {
    const a = v.fullWidth / v.width, c = v.fullHeight / v.height;
    if (!(isFinite(a) && isFinite(c))) return;
    const b = a * (1 - (2 * v.offsetX) / v.fullWidth) - 1;
    const d = 1 - c * (1 - (2 * v.offsetY) / v.fullHeight);
    for (let k = 0; k < 16; k += 4) {
      const w = m[k + 3];
      m[k] = a * m[k] + b * w;
      m[k + 1] = c * m[k + 1] + d * w;
    }
  }
  // ------------------------------------------------------------ a chain that mirrors its picture
  // visual-learning.app/sandworm's chain flips its picture left-right in a ShaderPass
  // (texture2D(tDiffuse, vec2(1.0 - vUv.x, vUv.y))). Mirroring each eye's image inverts its disparity,
  // so the pair came out pseudoscopic (#221, on the panel). Mirroring the screen is drawing through the
  // camera C·S (S = diag(−1, 1, 1)); so each eye is drawn as S·E·S with the projection S·P·S (the eye's
  // x offset and the frustum's x skew negated), and the page's own mirror turns that into eye E of C·S,
  // head motion included. Swapping the halves would fix a still pair but invert the look-around.
  //
  // Found on the picture, however the page mirrors (a pass's UVs, a flipped quad): in a mono chain
  // frame, the chain's screen pass and the scene by the page camera are each drawn again into a small
  // RGBA8 target of our own (two extra, small draws, until decided), and the same rows of the two are
  // compared. Each row is high-passed first (minus its ±6-bin moving average): a chain's vignette,
  // grading and the scene's own light gradients are left-right symmetric and, compared raw, made the
  // sandworm page match its scene as drawn almost as well as mirrored (r 0.6 vs 0.8); high-passed,
  // what is left is where things are (r ~0 vs 0.4-0.9 over its whole tour, never the other way).
  // Decided when one reading wins with r > 0.4 by 0.25; a blank or ambiguous frame decides nothing
  // and is asked again on a later frame (at most 4 times a second). Still undecided 3 s after the first
  // ask: not mirrored, which is how every chain was drawn before (and a page that drew one frame and
  // stopped still converts).
  const MIRROR_ROWS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9], MIRROR_BINS = 64, MIRROR_PW = 192, MIRROR_HP = 6;
  // S·M·S for S = diag(−1, 1, 1, 1), in place on a column-major 4x4: row 0 and column 0 negated, (0, 0) kept.
  const conjX = (m) => { for (const k of [1, 2, 3, 4, 8, 12]) m[k] = -m[k]; return m; };
  // st.mirrorWhy says how the last ask ended (state(): mirrorWhy, mirrorAsks). pass / passCam: the
  // chain's screen pass that was just drawn.
  function probeMirror(st, sd, pass, passCam) {
    if (core.T.chainMirror === false) { st.mirrorX = false; st.mirrorWhy = 'probe off (chainMirror: false)'; return; }
    const t = performance.now();
    if (t < st.mirrorNext) return;
    st.mirrorNext = t + 250;
    st.mirrorAsks++;
    const r = st.r, gl = typeof r.getContext === 'function' ? r.getContext() : null;
    const main = sd.main; // the frame's main seed: the scene, not an overlay seeded after it (markSeed)
    const RT = main.rt && main.rt.isWebGLRenderTarget ? main.rt.constructor : null;
    if (!gl || !RT || typeof r.readRenderTargetPixels !== 'function') {
      st.mirrorX = false; st.mirrorWhy = `cannot probe: ${!gl ? 'no WebGL context' : !RT ? 'the seed is not a WebGLRenderTarget' : 'no readRenderTargetPixels'}`;
      return;
    }
    if (!st.mirrorGiveUp) {
      st.mirrorGiveUp = setTimeout(() => {
        if (st.mirrorX !== undefined) return;
        st.mirrorX = false; st.mirrorWhy = `undecided after 3 s (${st.mirrorAsks} asks; last: ${st.mirrorWhy}): taken as not mirrored`;
        if (!st.active && !st.pending && !st.armed && st.qualifyCam) core.considerActivation(st);
      }, 3000);
    }
    try {
      const ph = Math.max(8, Math.round((MIRROR_PW * st.L.h) / (st.L.w || 1)));
      const out = drawRows(st, RT, MIRROR_PW, ph, pass, passCam);   // the chain's output: its screen pass, drawn again
      const scn = drawRows(st, RT, MIRROR_PW, ph, main.scene, main.camera); // the scene, as the page camera sees it
      const o = highPass(out), s = highPass(scn), f = [];
      for (let k = 0; k < MIRROR_ROWS.length; k++) for (let b = MIRROR_BINS - 1; b >= 0; b--) f.push(s[k * MIRROR_BINS + b]);
      const so = spread(o), ss = spread(s);
      if (so < 0.5 || ss < 0.5) { // ask again later
        st.mirrorWhy = `blank frame (structure: screen ${so.toFixed(2)}, scene ${ss.toFixed(2)}; screen pass ${out.stats}; scene ${scn.stats}, ` +
          `${sd.n} seed(s) this frame, the main one (${main.drawn} primitives) a ${main.scene.type} of ${main.scene.children ? main.scene.children.length : 0} children, camera layers ${main.camera.layers ? main.camera.layers.mask : '?'})`;
        return;
      }
      const asDrawn = corr(s, o), mirrored = corr(f, o);
      st.mirrorCorr = [+asDrawn.toFixed(3), +mirrored.toFixed(3)];
      if (Math.max(asDrawn, mirrored) <= 0.4 || Math.abs(mirrored - asDrawn) < 0.25) { st.mirrorWhy = 'ambiguous'; return; } // ask again later
      st.mirrorX = mirrored > asDrawn;
      st.mirrorWhy = 'decided';
      if (st.mirrorX) info(`the post chain on ${desc(st.canvas)} mirrors its picture left-right (r ${mirrored.toFixed(2)} mirrored vs ${asDrawn.toFixed(2)} as drawn): each eye is drawn mirrored to match`);
    } catch (e) {
      warnOnce('mirror', 'could not compare the post chain with its scene: taken as not mirrored', e);
      st.mirrorX = false; st.mirrorWhy = `error: ${e && e.message}`;
    }
  }
  // Each row minus its moving average (±MIRROR_HP bins, cut short at the ends): what is left is where things are.
  function highPass(v) {
    const out = [];
    for (let k = 0; k < v.length; k += MIRROR_BINS) {
      for (let b = 0; b < MIRROR_BINS; b++) {
        const lo = Math.max(0, b - MIRROR_HP), hi = Math.min(MIRROR_BINS - 1, b + MIRROR_HP);
        let s = 0;
        for (let j = lo; j <= hi; j++) s += v[k + j];
        out.push(v[k + b] - s / (hi - lo + 1));
      }
    }
    return out;
  }
  // MIRROR_ROWS of one draw (the scene by the page camera, or the chain's screen pass), made again into
  // a pw x ph RGBA8 target of our own, as MIRROR_BINS mean luminances each. Both sides are read the
  // same way, and neither from the canvas: the first version read the drawing buffer, and on the panel
  // (#221) it never reached a correlation (mirrorCorr null, not mirrored by the 3 s fallback) where the
  // same page decided on its first ask headless. Nor from the page's own targets (half-float or
  // multisampled ones may not be readable). This target always is.
  function drawRows(st, RT, pw, ph, scene, camera) {
    const r = st.r, rt = new RT(pw, ph), px = new Uint8Array(pw * ph * 4), out = [];
    const prev = st.call('getRenderTarget');
    const sm = r.shadowMap, smAuto = sm ? sm.autoUpdate : undefined;
    try {
      if (sm) sm.autoUpdate = false; // the page's own draw this frame rendered them
      st.call('setRenderTarget', rt);
      st.call('clear', true, true, true);
      st.call('render', scene, camera);
      const ri = r.info && r.info.render; // reset by render() itself (info.autoReset): this draw alone
      r.readRenderTargetPixels(rt, 0, 0, pw, ph, px);
      // For mirrorWhy: what the draw drew (calls / triangles) and the luminance it left.
      let lo = 255, hi = 0, sum = 0;
      for (let i = 0; i < px.length; i += 4) { const l = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]; lo = Math.min(lo, l); hi = Math.max(hi, l); sum += l; }
      out.stats = `${ri ? ri.calls : '?'} calls, ${ri ? ri.triangles : '?'} triangles, luminance ${lo.toFixed(0)}..${hi.toFixed(0)} (mean ${(sum / (px.length / 4)).toFixed(0)})`;
    } finally {
      if (sm) sm.autoUpdate = smAuto;
      st.call('setRenderTarget', prev);
      rt.dispose();
    }
    for (const f of MIRROR_ROWS) binRow(px, Math.min(ph - 1, Math.floor(f * ph)) * pw * 4, pw, out);
    return out;
  }
  function binRow(px, at, w, out) {
    for (let b = 0; b < MIRROR_BINS; b++) {
      const x0 = Math.floor((b * w) / MIRROR_BINS), x1 = Math.max(x0 + 1, Math.floor(((b + 1) * w) / MIRROR_BINS));
      let s = 0;
      for (let x = x0; x < x1; x++) { const i = at + x * 4; s += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]; }
      out.push(s / (x1 - x0));
    }
  }
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const spread = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) * (x - m)))); };
  function corr(a, b) {
    const ma = mean(a), mb = mean(b);
    let ab = 0, aa = 0, bb = 0;
    for (let i = 0; i < a.length; i++) { const x = a[i] - ma, y = b[i] - mb; ab += x * y; aa += x * x; bb += y * y; }
    return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
  }

  // A jitter left set (#226, from the #222 review). three's TAARenderPass / SSAARenderPass clear their
  // offset after the draw (caught above, in markSeed), but a page's own TAA may leave it set and only
  // move it: the view then reaches the end of every frame, and passed for framing. One entry per frame,
  // the view as it stands at the end of the frame, in the scene target's pixels (the units a TAA
  // jitters in: ±0.5 px of a half-size target is ±1 canvas px) whatever units the page passes to
  // setViewOffset:
  //   framing    unchanged since the last frame; or moved by 1 px or more (a deliberate shift, a cut);
  //              or a new window size (a zoom); or VIEW_FRAMES frames of sub-pixel steps that do not
  //              keep turning back (a slow pan)
  //   jitter     a run of sub-pixel steps (its last VIEW_FRAMES frames at most) that stays within 1.5 px
  //              and turns back at least twice on one axis. Halton / random jitter turns back almost
  //              every frame, so a TAA is caught on its 4th sample: one that settles after a few
  //              samples and stops drawing the scene is caught too. A pan, a tween, a settling spring
  //              does not turn back twice in a few frames.
  //   unknown    neither, so far
  const VIEW_FRAMES = 8;
  function viewTrend(st, v, rt) {
    const bw = (rt && rt.width) || st.L.w * st.L.pr || 1, bh = (rt && rt.height) || st.L.h * st.L.pr || 1;
    const e = { x: (v[2] / (v[0] || 1)) * bw, y: (v[3] / (v[1] || 1)) * bh, w: v[4] / (v[0] || 1), h: v[5] / (v[1] || 1) };
    const hist = st.viewHist, prev = hist[hist.length - 1];
    hist.push(e);
    if (hist.length > VIEW_FRAMES) hist.shift();
    if (!prev) return 'unknown';
    const dx = e.x - prev.x, dy = e.y - prev.y;
    if (e.w !== prev.w || e.h !== prev.h || (dx === 0 && dy === 0) || Math.abs(dx) >= 1 || Math.abs(dy) >= 1) { st.viewSteps = 0; return 'framing'; }
    st.viewSteps++;
    const run = hist.slice(-Math.min(st.viewSteps + 1, VIEW_FRAMES)); // this run of sub-pixel steps
    const turns = (k) => {
      let n = 0;
      for (let i = 2; i < run.length; i++) {
        const a = run[i - 1][k] - run[i - 2][k], b = run[i][k] - run[i - 1][k];
        if (a * b < 0) n++;
      }
      return n;
    };
    const span = (k) => Math.max(...run.map((p) => p[k])) - Math.min(...run.map((p) => p[k]));
    if (Math.max(turns('x'), turns('y')) >= 2 && span('x') <= 1.5 && span('y') <= 1.5) return 'jitter';
    return st.viewSteps >= VIEW_FRAMES - 1 ? 'framing' : 'unknown';
  }
  const WHY_JITTER = 'the scene pass jitters camera.setViewOffset (TAA / SSAA) — not split';
  function viewJitter(st) {
    if (st.viewJitter) return;
    st.viewJitter = true; st.flatReason = WHY_JITTER;
    info('three.js canvas', desc(st.canvas), 'stays 2D:', WHY_JITTER);
    if (st.active) core.stand(st, WHY_JITTER, { staged: true });
    else if (st.pending || st.armed) core.stand(st, WHY_JITTER);
    core.notify();
  }
  // The materials of a small object (a full-screen quad, or a scene holding one): a pass. A big
  // scene is not scanned, so a scene draw never pays for this.
  function passMaterials(obj) {
    const mats = [];
    let meshes = 0, seen = 0;
    const stack = [obj];
    while (stack.length) {
      const o = stack.pop();
      if (++seen > 64) return null;
      if (o.isMesh || o.isPoints || o.isLine || o.isSprite) {
        if (++meshes > 8) return null;
        const m = o.material;
        if (Array.isArray(m)) { for (const x of m) if (x) mats.push(x); } else if (m) mats.push(m);
      }
      const ch = o.children;
      if (ch) for (let i = 0; i < ch.length; i++) stack.push(ch[i]);
    }
    if (obj.overrideMaterial) mats.push(obj.overrideMaterial);
    return mats;
  }
  // [holder, key, chain texture, its twin] for every chain texture the object's materials sample,
  // or null when there is none.
  function taintedSwaps(st, obj) {
    if (!st.texTwin.size) return null;
    const mats = passMaterials(obj);
    if (!mats) return null;
    let out = null;
    const hit = (holder, key, tex) => {
      const tw = tex && tex.isTexture ? st.texTwin.get(tex) : null;
      if (tw) (out || (out = [])).push([holder, key, tex, tw]);
    };
    for (const m of mats) {
      const u = m.uniforms;
      if (u) {
        for (const k in u) {
          const e = u[k], v = e && e.value;
          if (!v) continue;
          if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) hit(v, i, v[i]); } else hit(e, 'value', v);
        }
      }
      for (const k of TEX_PROPS) hit(m, k, m[k]);
    }
    return out;
  }
  const swapIn = (sw) => { if (sw) for (const s of sw) s[0][s[1]] = s[3]; };
  const swapOut = (sw) => { if (sw) for (let i = sw.length - 1; i >= 0; i--) { const s = sw[i]; s[0][s[1]] = s[2]; } };
  // The right eye's copy of a chain target, created on first use and kept the target's size.
  function twinOf(st, rt) {
    let tw = st.twins.get(rt);
    if (!tw) {
      tw = rt.clone();
      st.twins.set(rt, tw);
      const a = rt.textures || [rt.texture], b = tw.textures || [tw.texture];
      for (let i = 0; i < a.length; i++) if (a[i] && b[i]) st.texTwin.set(a[i], b[i]);
      if (rt.texture && tw.texture) st.texTwin.set(rt.texture, tw.texture);
    }
    if (rt.depthTexture && !tw.depthTexture) tw.depthTexture = rt.depthTexture.clone();
    if (rt.depthTexture && tw.depthTexture) st.texTwin.set(rt.depthTexture, tw.depthTexture);
    if (tw.width !== rt.width || tw.height !== rt.height) tw.setSize(rt.width, rt.height, rt.depth);
    if (tw.viewport && rt.viewport) tw.viewport.copy(rt.viewport);
    if (tw.scissor && rt.scissor) tw.scissor.copy(rt.scissor);
    tw.scissorTest = rt.scissorTest;
    return tw;
  }
  // An eye camera aimed from the page camera, as renderStereo does it. A chain that mirrors its
  // picture (st.mirrorX) gets the eye S·E·S; the display rig's pivot offset (in the page camera's own
  // axes, which are not mirrored) is kept as it was.
  const mirroredPose = new Float32Array(16);
  const mirrorOf = (st) => (core.T.chainMirror === 'force' ? true : !!st.mirrorX);
  function aimEye(st, camera, eyes, i, rev) {
    const e = eyes[i], mirror = mirrorOf(st);
    let pose = core.eyePose(st, i, camera.matrixWorld.elements);
    if (mirror) {
      mirroredPose.set(pose);
      conjX(mirroredPose);
      const t = st.piv && st.piv.t;
      if (t) mirroredPose[12] += 2 * t[0];
      pose = mirroredPose;
    }
    st.m4.fromArray(pose);
    e.matrixWorld.multiplyMatrices(camera.matrixWorld, st.m4);
    e.matrix.copy(e.matrixWorld);
    invertFrom(e.matrixWorldInverse, e.matrixWorld);
    eyeProjection(st, e, i, rev, viewOf(camera), mirror);
    e.near = camera.near; e.far = camera.far; e.fov = camera.fov; e.aspect = camera.aspect; e.zoom = camera.zoom;
    if (e.layers && camera.layers) e.layers.mask = camera.layers.mask;
    return e;
  }
  // One chain draw, twice: the left eye into the page's target, the right eye into its twin.
  function renderIntoChain(st, scene, camera, rt, seed) {
    const stereo = seed && st.haveViews;
    let eyes = null, rev = false;
    if (stereo) {
      if (typeof camera.updateWorldMatrix === 'function') camera.updateWorldMatrix(true, false);
      else if (camera.parent === null) camera.updateMatrixWorld();
      eyes = eyeCameras(st, camera); rev = reversedDepth(st);
    }
    const tw = twinOf(st, rt);
    const face = st.call('getActiveCubeFace'), level = st.call('getActiveMipmapLevel');
    const sw = seed ? null : taintedSwaps(st, scene); // read before the left draw: the same textures
    const sm = st.r.shadowMap, smAuto = sm ? sm.autoUpdate : undefined;
    const fi = frameInfo(st); // the eye pair is one renderer frame here too (see eyeFrame)
    let fr = null;
    try {
      fr = eyeFrame(fi, 0, fr);
      st.call('render', scene, stereo ? aimEye(st, camera, eyes, 0, rev) : camera);
      swapIn(sw);
      st.call('setRenderTarget', tw, face, level);
      if (sm) sm.autoUpdate = false; // shadow maps are view-independent: rendered by the left draw
      fr = eyeFrame(fi, 1, fr);
      st.call('render', scene, stereo ? aimEye(st, camera, eyes, 1, rev) : camera);
    } finally {
      endFrame(fi, fr);
      swapOut(sw);
      if (sm) sm.autoUpdate = smAuto;
      st.call('setRenderTarget', rt, face, level);
    }
  }
  function clearChain(st, rt, color, depth, stencil) {
    const tw = twinOf(st, rt);
    const face = st.call('getActiveCubeFace'), level = st.call('getActiveMipmapLevel');
    st.call('clear', color, depth, stencil);
    try { st.call('setRenderTarget', tw, face, level); st.call('clear', color, depth, stencil); }
    finally { st.call('setRenderTarget', rt, face, level); }
  }
  // The chain's last pass onto the screen: the left eye's half from the page's targets, the right
  // eye's half from the twins.
  function renderPostScreen(st, scene, camera) {
    const sw = taintedSwaps(st, scene);
    const sm = st.r.shadowMap, smAuto = sm ? sm.autoUpdate : undefined;
    const fi = frameInfo(st);
    let fr = null;
    try {
      fr = eyeFrame(fi, 0, fr);
      setEyeViewport(st, 0);
      st.call('render', scene, camera);
      setEyeViewport(st, 1);
      swapIn(sw);
      if (sm) sm.autoUpdate = false;
      fr = eyeFrame(fi, 1, fr);
      st.call('render', scene, camera);
    } finally {
      endFrame(fi, fr);
      swapOut(sw);
      if (sm) sm.autoUpdate = smAuto;
      st.call('setScissorTest', false);
    }
    if (st.chainStereo) st.stats.stereo++; else st.stats.flat++;
    core.drew(st);
  }
  function disposeChain(st) {
    for (const tw of st.twins.values()) { try { tw.dispose(); } catch (e) { /* ignore */ } }
    st.twins.clear(); st.texTwin.clear(); st.chainStereo = false;
  }

  // ------------------------------------------------------------ convergence: the scene's bounds
  // Bounding spheres of what the camera's layers can see (meshes, points, lines, sprites, Spark
  // splats), in world space, for core.estimateSubjectDistance.
  function forEachBounds(scene, cam, cb) {
    let more = true;
    scene.traverseVisible((o) => {
      if (!more) return;
      const splat = isSplatMesh(o);
      if (!splat && !(o.isMesh || o.isPoints || o.isLine || o.isSprite)) return;
      if (cam.layers && o.layers && typeof cam.layers.test === 'function' && !cam.layers.test(o.layers)) return;
      if (splat) { more = splatBounds(o, cam, cb); return; }
      if (isSparkRenderer(o)) return; // Spark's draw quad, not scene content
      let bs = o.boundingSphere || null;
      const g = o.geometry;
      if (!bs && g) {
        if (!g.boundingSphere && typeof g.computeBoundingSphere === 'function') { try { g.computeBoundingSphere(); } catch (e) { /* ignore */ } }
        bs = g.boundingSphere;
      }
      if (!bs || !(bs.radius >= 0) || !isFinite(bs.radius)) return;
      const m = o.matrixWorld.elements, c = bs.center;
      more = cb(xfX(m, c.x, c.y, c.z), xfY(m, c.x, c.y, c.z), xfZ(m, c.x, c.y, c.z), bs.radius * maxScale(m)) !== false;
    });
  }
  const xfX = (m, x, y, z) => m[0] * x + m[4] * y + m[8] * z + m[12];
  const xfY = (m, x, y, z) => m[1] * x + m[5] * y + m[9] * z + m[13];
  const xfZ = (m, x, y, z) => m[2] * x + m[6] * y + m[10] * z + m[14];
  const maxScale = (m) => Math.sqrt(Math.max(m[0] * m[0] + m[1] * m[1] + m[2] * m[2], m[4] * m[4] + m[5] * m[5] + m[6] * m[6], m[8] * m[8] + m[9] * m[9] + m[10] * m[10]));

  // Spark splats (@sparkjsdev/spark 2.x). A SplatMesh is a THREE.Object3D, not a Mesh: no geometry,
  // no bounds, so the walk above never saw it (Spark pages without a lookAt fell back to the
  // default distance). Its splats live in an object-local store (`.splats`: PackedSplats /
  // ExtSplats / PagedSplats) behind getNumSplats() and getSplat(i) (packed, ext: decodes one) or
  // forEachSplat(cb) (every store, a paged LoD world included: decodes them all). Spark's own
  // SplatMesh.getBoundingBox() walks every splat on every call, so the shim takes a sample of
  // <= SPLAT_SAMPLES centres (+ each splat's largest scale) once per splat count and caches it per
  // mesh; matrixWorld is applied per call, so a moved or scaled mesh needs no resample. A paged world
  // that is still streaming changes its count every few frames: it is resampled at most every
  // SPLAT_RESAMPLE_MS, and never more often than 20 x the last sample's cost (<= 5 % of the time).
  //
  // Seen from outside, a splat mesh is ONE sphere (centroid of the centres, 98th-percentile radius:
  // a capture's stray floaters do not inflate it), as PlayCanvas's gsplat AABB is: the camera
  // converges on the middle of the subject. A sphere that holds the camera (a World Labs / Marble
  // room) is no subject, and the core would drop it, so from inside the mesh is fed as its sampled
  // splats in front of the camera (<= SPLAT_POINTS, each a sphere of its own scale), flagged `among`:
  // the core then takes their apparent-size-weighted median depth, the depth of what fills most of
  // the view (never the centroid shortcut, whose r^2 weighting lets a few large, far, dim splats of
  // the room's walls outvote the thing in front of the camera).
  const SPLAT_SAMPLES = 50000, SPLAT_POINTS = 1500, SPLAT_RESAMPLE_MS = 1000;
  const splatCache = new WeakMap(); // SplatMesh -> { src, n, at, cost, pts: Float32Array [x y z r]*, k, cx, cy, cz, r }
  const isSplatMesh = (o) => !!o && !o.isMesh && typeof o.forEachSplat === 'function' && typeof o.getBoundingBox === 'function' && 'numSplats' in o;
  const isSparkRenderer = (o) => typeof o.updateInternal === 'function' && 'orderingTexture' in o;
  function splatCount(o, src) {
    try {
      const n = src && typeof src.getNumSplats === 'function' ? src.getNumSplats() : src && src.numSplats !== undefined ? src.numSplats : o.numSplats;
      return n > 0 && isFinite(n) ? n : 0;
    } catch (e) { return 0; }
  }
  function splatSample(o) {
    const src = o.splats || o.packedSplats || o.extSplats || null, n = splatCount(o, src);
    const c = splatCache.get(o);
    if (!n) return null; // not loaded yet
    if (c && c.src === src && c.n === n) return c.k ? c : null;
    const now = performance.now();
    if (c && c.src === src && now - c.at < Math.max(SPLAT_RESAMPLE_MS, 20 * c.cost)) return c.k ? c : null;
    const step = Math.max(1, Math.ceil(n / SPLAT_SAMPLES));
    const pts = new Float32Array(Math.ceil(n / step) * 4);
    let k = 0;
    const take = (ctr, sc) => {
      if (k >= pts.length || !ctr || !isFinite(ctr.x) || !isFinite(ctr.y) || !isFinite(ctr.z)) return;
      const r = sc ? Math.max(sc.x, sc.y, sc.z) : 0;
      pts[k] = ctr.x; pts[k + 1] = ctr.y; pts[k + 2] = ctr.z; pts[k + 3] = r > 0 && isFinite(r) ? r : 1e-4;
      k += 4;
    };
    const walk = () => o.forEachSplat((i, ctr, sc) => { if (i % step === 0) take(ctr, sc); });
    try {
      if (src && typeof src.getSplat === 'function') for (let i = 0; i < n; i += step) { const s = src.getSplat(i); take(s.center, s.scales); }
      else walk();
    } catch (e) {
      k = 0;
      try { walk(); } catch (e2) { warnOnce('spark-bounds', 'could not read Spark splat centres: convergence falls back', e2); k = 0; }
    }
    const e = { src, n, at: now, cost: performance.now() - now, pts, k: k / 4, cx: 0, cy: 0, cz: 0, r: 0 };
    splatCache.set(o, e);
    if (!e.k) return null;
    for (let i = 0; i < k; i += 4) { e.cx += pts[i]; e.cy += pts[i + 1]; e.cz += pts[i + 2]; }
    e.cx /= e.k; e.cy /= e.k; e.cz /= e.k;
    const d = new Float32Array(e.k);
    for (let i = 0, j = 0; i < k; i += 4, j++) d[j] = Math.hypot(pts[i] - e.cx, pts[i + 1] - e.cy, pts[i + 2] - e.cz) + pts[i + 3];
    d.sort();
    e.r = d[Math.min(e.k - 1, Math.floor(e.k * 0.98))];
    return e;
  }
  function splatBounds(o, cam, cb) {
    const S = splatSample(o);
    if (!S) return true;
    const m = o.matrixWorld.elements, sc = maxScale(m), cw = cam.matrixWorld.elements;
    const wx = xfX(m, S.cx, S.cy, S.cz), wy = xfY(m, S.cx, S.cy, S.cz), wz = xfZ(m, S.cx, S.cy, S.cz), wr = S.r * sc;
    if (Math.hypot(wx - cw[12], wy - cw[13], wz - cw[14]) > wr) return cb(wx, wy, wz, wr) !== false;
    // Inside: the sampled splats ahead of the camera and roughly in view, thinned to SPLAT_POINTS.
    const vm = cam.matrixWorldInverse.elements, p = S.pts;
    const tanV = Math.tan(((cam.fov || 50) * Math.PI) / 360) / (cam.zoom || 1), tanH = tanV * (cam.aspect || 1), near = cam.near || 0;
    const ahead = [];
    for (let i = 0; i < S.k * 4; i += 4) {
      const x = xfX(m, p[i], p[i + 1], p[i + 2]), y = xfY(m, p[i], p[i + 1], p[i + 2]), z = xfZ(m, p[i], p[i + 1], p[i + 2]);
      const vz = -(vm[2] * x + vm[6] * y + vm[10] * z + vm[14]);
      if (!(vz > near)) continue;
      const vx = vm[0] * x + vm[4] * y + vm[8] * z + vm[12], vy = vm[1] * x + vm[5] * y + vm[9] * z + vm[13];
      if (Math.abs(vx) > vz * tanH * 1.2 || Math.abs(vy) > vz * tanV * 1.2) continue;
      ahead.push(i);
    }
    const step = Math.max(1, ahead.length / SPLAT_POINTS);
    for (let j = 0; j < ahead.length; j += step) {
      const i = ahead[Math.floor(j)];
      if (cb(xfX(m, p[i], p[i + 1], p[i + 2]), xfY(m, p[i], p[i + 1], p[i + 2]), xfZ(m, p[i], p[i + 1], p[i + 2]), p[i + 3] * sc, true) === false) return false;
    }
    return true;
  }

  info(`three.js adapter armed (core v${core.VERSION})`);
  return { observe: onObserve, register: onRegister };
}

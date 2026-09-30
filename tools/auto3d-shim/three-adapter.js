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
//     eye world = page camera × view.transform, the rig pose is identity);
//   - anything else aimed at the screen (an ortho HUD pass, a post-processing chain's final quad) is
//     drawn identically into both halves: flat, but never a broken tile;
//   - a frame the page did not draw (render-on-demand pages) is replayed from the page's last
//     screen draws, so the tile is redrawn every frame (woven-canvas rules) and head motion still
//     looks around.
// It stands down when a renderer presents through renderer.xr (and, via the core, for SDK / WebXR
// pages). WebGPURenderer is left 2D.
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
    if (o.isWebGPURenderer) { warnOnce('webgpu', 'WebGPURenderer seen — not converted by this prototype, left 2D'); return; }
    if (o.isWebGLRenderer || (o.domElement && typeof o.render === 'function' && typeof o.getContext === 'function')) track(o);
  };
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
    label: () => `three r${revision || '?'}`,
    unqualified(st) {
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
    readEye: (st, target) => core.readGlEye(ad.gl(st), st, target),
    gl: (st) => (st.r && typeof st.r.getContext === 'function' ? st.r.getContext() : null),
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
    describe: (st) => ({ page: { w: st.L.w, h: st.L.h, pr: st.L.pr, canvasWidthSeenByPage: st.canvas.width } }),
  };

  // ------------------------------------------------------------ per-renderer wrapping
  function track(r) {
    if (states.has(r)) return;
    const canvas = r.domElement;
    if (!(canvas instanceof HTMLCanvasElement)) { warnOnce('offscreen', 'renderer on an OffscreenCanvas — not supported, left 2D'); return; }
    const st = core.newState('three.js', canvas, ad);
    Object.assign(st, {
      r, depth: 0, orig: {},
      L: { w: 0, h: 0, pr: 1, vp: [0, 0, 0, 0], sc: [0, 0, 0, 0], scTest: false }, // what the PAGE believes
      eyes: null, eyesFor: null, m4: null,
      mainCam: null, lastScene: null, lastMono: null, qualifyCam: null,
      frame: { drew: false, ops: [] }, lastOps: null,
      monoOps: null, monoCur: null, monoOpen: false, idleOps: null, // the page's last MONO frame (draws before / between conversions)
      // Post-processing (see "post-processing chains" below): set once the page is seen drawing its
      // scene into a render target and then a full-screen pass to the screen.
      postfx: false, seedTask: null, twins: new Map(), texTwin: new Map(), chainStereo: false,
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
    info(`three.js r${revision || '?'} renderer found on`, desc(canvas));
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
    W('getSize', (t) => {
      const out = st.call('getSize', t);
      if (st.active && out) { if (typeof out.set === 'function') out.set(st.L.w, st.L.h); else { out.width = st.L.w; out.height = st.L.h; } }
      return out;
    });
    W('getPixelRatio', () => (st.active ? st.L.pr : st.call('getPixelRatio')));
    // One exception: Spark's own per-pixel terms (see "Spark's pixel size" below) get the EYE.
    W('getDrawingBufferSize', (t) => {
      const out = st.call('getDrawingBufferSize', t);
      if (st.active && out && typeof out.set === 'function') {
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
      const out = st.call('getViewport', t);
      if (st.active && out && typeof out.set === 'function') out.set(...st.L.vp);
      return out;
    });
    W('setScissor', (x, y, w, h) => {
      if (!top()) return st.call('setScissor', x, y, w, h);
      st.L.sc = v4(x, y, w, h);
      if (!st.active) return st.call('setScissor', x, y, w, h);
    });
    W('getScissor', (t) => {
      const out = st.call('getScissor', t);
      if (st.active && out && typeof out.set === 'function') out.set(...st.L.sc);
      return out;
    });
    W('setScissorTest', (b) => {
      if (!top()) return st.call('setScissorTest', b);
      st.L.scTest = !!b;
      if (!st.active) return st.call('setScissorTest', b);
    });
    W('getScissorTest', () => (st.active ? st.L.scTest : st.call('getScissorTest')));
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
      if (!top() || !scene || !camera) return st.call('render', scene, camera);
      st.stats.calls++;
      const target = st.call('getRenderTarget');
      const toScreen = target === null;
      const xrLive = !!(r.xr && r.xr.enabled && r.xr.isPresenting);
      if (!st.active) {
        const out = st.call('render', scene, camera);
        if (!toScreen && !xrLive && isSeed(st, target, camera)) markSeed(st, scene, camera);
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
          } else if (st.seedTask && !st.seedTask.direct) {
            // A post-processing frame: the scene went into a render target earlier in this task, and
            // this full-screen pass put the result on the screen. Qualify / flip on it, with the
            // scene's own camera, after the pass is drawn (the cover is taken from it).
            const sd = st.seedTask;
            st.postfx = true; st.sawPersp = true;
            st.lastMono = { scene: sd.scene, camera: sd.camera };
            hookLookAt(sd.camera);
            if (st.armed) flip(st, sd.scene, sd.camera);
            else { st.qualifyCam = sd.camera; core.considerActivation(st); }
          } else if (!st.sawPersp && !st.lastWhy) {
            st.lastWhy = 'the screen camera is not a PerspectiveCamera';
            info('not converting', desc(st.canvas), 'yet:', st.lastWhy, '(a post-processing chain, or an ortho-only scene)');
          }
        }
        return out;
      }
      if (xrLive) { core.stand(st, 'the renderer is presenting WebXR'); return st.call('render', scene, camera); }
      if (!toScreen) {
        if (st.postfx) {
          // The scene pass seeds the per-eye chain; any pass writing a chain target or sampling one
          // is part of it. Everything else (picking, PMREM, cube cameras) stays a single mono draw.
          if (isSeed(st, target, camera)) { st.mainCam = camera; st.lastScene = scene; st.chainStereo = st.haveViews; return renderIntoChain(st, scene, camera, target, true); }
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
      return out;
    });
    W('dispose', (...a) => {
      if (st.active || st.pending || st.armed) core.stand(st, 'the page disposed the renderer');
      return st.call('dispose', ...a);
    });
  }
  function flip(st, scene, camera) {
    st.mainCam = camera; st.lastScene = scene;
    core.flip(st);
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
    if (camera.view && camera.view.enabled) return false; // setViewOffset (tiles, TAA jitter): not ours to split
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
        e.projectionMatrix.fromArray(st.V[i].proj);               // the runtime's off-axis frustum, untouched
        if (rev) {
          // Marked BEFORE render: on a reversed-depth renderer three otherwise calls
          // updateProjectionMatrix() on any camera not marked, which would replace the runtime's
          // off-axis frustum with a symmetric one (porting guide: never do that to an eye camera).
          toReversedZ(e.projectionMatrix.elements);
          e._reversedDepth = true;
        }
        if (e.projectionMatrixInverse) invertFrom(e.projectionMatrixInverse, e.projectionMatrix);
        e.near = camera.near; e.far = camera.far; e.fov = camera.fov; e.aspect = camera.aspect; e.zoom = camera.zoom;
        if (e.layers && camera.layers) e.layers.mask = camera.layers.mask;
        setEyeViewport(st, i);
        if (i === 1 && sm) sm.autoUpdate = false; // shadow maps are view-independent: render them once
        st.call('render', scene, e);
      }
    } finally {
      st.inEye = false;
      endFrame(fi, fr);
      if (sm) sm.autoUpdate = smAuto;
      st.call('setScissorTest', false);
    }
    st.stats.stereo++;
    core.drew(st);
  }
  function renderFlat(st, scene, camera) {
    hookSpark(st, scene);
    const sm = st.r.shadowMap, smAuto = sm ? sm.autoUpdate : undefined;
    const fi = frameInfo(st);
    let fr = null;
    st.inEye = true;
    try {
      for (let i = 0; i < 2; i++) {
        fr = eyeFrame(fi, i, fr);
        setEyeViewport(st, i);
        if (i === 1 && sm) sm.autoUpdate = false;
        st.call('render', scene, camera);
      }
    } finally {
      st.inEye = false;
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
  function isSeed(st, rt, camera) {
    if (!rt || rt.isWebGLCubeRenderTarget || rt.isWebGL3DRenderTarget || rt.isWebGLArrayRenderTarget) return false;
    if (!camera || !camera.isPerspectiveCamera || camera.isArrayCamera || (camera.view && camera.view.enabled)) return false;
    if (st.active && st.mainCam && camera !== st.mainCam) return false;
    const L = st.L;
    if (!(L.w > 0 && L.h > 0 && rt.width > 0 && rt.height > 0)) return false;
    const a = L.w / L.h, near = (x) => Math.abs(x - a) / a < 0.1;
    // Shaped like the canvas: excludes a PMREM / cube-face draw (square camera, atlas-shaped
    // target) and a picking draw (tiny target).
    return near(rt.width / rt.height) && near(camera.aspect || a) && rt.width >= 0.5 * L.w * L.pr && rt.height >= 0.5 * L.h * L.pr;
  }
  function markSeed(st, scene, camera) {
    if (!st.seedTask) queueMicrotask(() => { st.seedTask = null; }); // a page draws its frame in one task
    st.seedTask = { scene, camera };
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
  // An eye camera aimed from the page camera, as renderStereo does it.
  function aimEye(st, camera, eyes, i, rev) {
    const e = eyes[i];
    st.m4.fromArray(core.eyePose(st, i, camera.matrixWorld.elements));
    e.matrixWorld.multiplyMatrices(camera.matrixWorld, st.m4);
    e.matrix.copy(e.matrixWorld);
    invertFrom(e.matrixWorldInverse, e.matrixWorld);
    e.projectionMatrix.fromArray(st.V[i].proj);
    if (rev) { toReversedZ(e.projectionMatrix.elements); e._reversedDepth = true; }
    if (e.projectionMatrixInverse) invertFrom(e.projectionMatrixInverse, e.projectionMatrix);
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

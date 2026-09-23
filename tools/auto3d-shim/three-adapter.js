// DisplayXR auto-3D — three.js adapter. PROTOTYPE, not a product.
//
// The three.js half of the original auto-3D prototype (content.js v0.1.0, PR #47), unchanged in
// behaviour; the session / layer / rig / cover / HUD machinery now lives in core.js, which must be
// loaded first (manifest.json lists core.js → three-adapter.js → playcanvas-adapter.js).
//
// How it finds three.js on a bundled / minified page: three (r105+) announces every WebGLRenderer
// and Scene it constructs to a global `__THREE_DEVTOOLS__` EventTarget ('observe'), if one exists.
// This script defines it before any page script runs, so every renderer reaches it. render(),
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
(() => {
  'use strict';
  const core = window[Symbol.for('dxr.auto3d.core')];
  if (!core || core.meta.threeAdapter) return; // core inert (not the DisplayXR Browser) or already loaded
  core.meta.threeAdapter = true;
  core.registerEngine('three.js');
  const { info, warnOnce, desc, realW, realH } = core;
  const cfg = () => core.cfg;
  // A duck-typed Vector2 for three's getSize(target), which only calls target.set().
  const vec2 = () => ({ x: 0, y: 0, set(x, y) { this.x = x; this.y = y; return this; } });

  const states = new WeakMap(); // renderer -> state
  let revision = null;
  Object.defineProperty(core.meta, 'revision', { enumerable: true, get: () => revision });

  // ------------------------------------------------------------ the three.js devtools hook
  let devtools = window.__THREE_DEVTOOLS__ || null;
  const onObserve = (e) => {
    const o = e && e.detail;
    if (!o || o.isScene) return;
    if (o.isWebGPURenderer) { warnOnce('webgpu', 'WebGPURenderer seen — not converted by this prototype, left 2D'); return; }
    if (o.isWebGLRenderer || (o.domElement && typeof o.render === 'function' && typeof o.getContext === 'function')) track(o);
  };
  const onRegister = (e) => { if (e && e.detail && e.detail.revision) revision = e.detail.revision; };
  const hooked = new WeakSet();
  const attachHook = (t) => {
    if (!t || typeof t.addEventListener !== 'function' || hooked.has(t)) return;
    hooked.add(t);
    t.addEventListener('observe', onObserve);
    t.addEventListener('register', onRegister);
  };
  if (!devtools) devtools = new EventTarget();
  attachHook(devtools);
  try {
    // An accessor, so the real three.js devtools extension can still install its own object and we
    // keep listening on whatever is there.
    Object.defineProperty(window, '__THREE_DEVTOOLS__', {
      configurable: true, enumerable: false,
      get: () => devtools,
      set: (v) => { devtools = v; attachHook(v); },
    });
  } catch (e) { window.__THREE_DEVTOOLS__ = devtools; }

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
      renderFlat(st, st.lastScene, st.mainCam); // repaint NOW: the resize just cleared the store
      st.lastOps = [['render', st.lastScene, st.mainCam, true]];
    },
    redraw(st) {
      // A page that drew nothing since the last session frame gets its last screen draws replayed.
      if (st.frame.drew) st.lastOps = st.frame.ops.length <= 32 ? st.frame.ops : null;
      else if (st.lastOps) replay(st, st.lastOps);
      st.frame = { drew: false, ops: [] };
    },
    restore(st, wasLive) {
      st.lastOps = null; st.frame = { drew: false, ops: [] };
      core.unvirtualizeCanvas(st);
      if (wasLive) {
        try {
          st.call('setPixelRatio', st.L.pr);
          st.call('setSize', st.L.w, st.L.h, false);
          st.call('setViewport', ...st.L.vp);
          st.call('setScissor', ...st.L.sc);
          st.call('setScissorTest', st.L.scTest);
          if (st.lastMono) st.call('render', st.lastMono.scene, st.lastMono.camera); // the resize cleared it
        } catch (e) { /* the page's next frame repaints */ }
      }
    },
    flipIdle(st) {
      if (st.armed && st.lastMono) {
        const { scene, camera } = st.lastMono;
        st.call('render', scene, camera);
        flip(st, scene, camera);
      }
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
    W('getDrawingBufferSize', (t) => {
      const out = st.call('getDrawingBufferSize', t);
      if (st.active && out && typeof out.set === 'function') out.set(Math.floor(st.L.w * st.L.pr), Math.floor(st.L.h * st.L.pr));
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
      if (!top() || !st.active || st.call('getRenderTarget') !== null) return st.call('clear', color, depth, stencil);
      st.frame.drew = true;
      st.frame.ops.push(['clear', color, depth, stencil]);
      forEyes(st, () => st.call('clear', color, depth, stencil));
    });
    W('render', (scene, camera) => {
      if (!top() || !scene || !camera) return st.call('render', scene, camera);
      st.stats.calls++;
      const toScreen = st.call('getRenderTarget') === null;
      const xrLive = !!(r.xr && r.xr.enabled && r.xr.isPresenting);
      if (!st.active) {
        const out = st.call('render', scene, camera);
        if (toScreen && !xrLive) {
          const persp = camera.isPerspectiveCamera && !camera.isArrayCamera;
          if (persp) {
            st.lastMono = { scene, camera }; st.sawPersp = true;
            // Flip / qualify only on the scene draw itself — never on an ortho background, HUD or
            // post quad drawn in the same frame (the throttle would otherwise keep landing on it).
            if (st.armed) flip(st, scene, camera);
            else { st.qualifyCam = camera; core.considerActivation(st); }
          } else if (!st.sawPersp && !st.lastWhy) {
            st.lastWhy = 'the screen camera is not a PerspectiveCamera';
            info('not converting', desc(st.canvas), 'yet:', st.lastWhy, '(a post-processing chain, or an ortho-only scene)');
          }
        }
        return out;
      }
      if (xrLive) { core.stand(st, 'the renderer is presenting WebXR'); return st.call('render', scene, camera); }
      if (!toScreen) return st.call('render', scene, camera); // shadow / post-processing / picking targets: untouched, mono
      st.frame.drew = true;
      const stereo = isMainPerspective(st, camera);
      st.frame.ops.push(['render', scene, camera, stereo]);
      return stereo ? renderStereo(st, scene, camera) : renderFlat(st, scene, camera);
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

  // ------------------------------------------------------------ sizing
  // Returns true when the backing store actually changed (and was therefore cleared).
  function applyRealSize(st) {
    const R = core.realSizeFor(st.L);
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

  function renderStereo(st, scene, camera) {
    st.mainCam = camera; st.lastScene = scene;
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
    try {
      for (let i = 0; i < 2; i++) {
        const e = eyes[i];
        st.m4.fromArray(st.V[i].pose);
        e.matrixWorld.multiplyMatrices(camera.matrixWorld, st.m4); // attach pattern: identity rig pose
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
      if (sm) sm.autoUpdate = smAuto;
      st.call('setScissorTest', false);
    }
    st.stats.stereo++;
  }
  function renderFlat(st, scene, camera) {
    const sm = st.r.shadowMap, smAuto = sm ? sm.autoUpdate : undefined;
    try {
      for (let i = 0; i < 2; i++) {
        setEyeViewport(st, i);
        if (i === 1 && sm) sm.autoUpdate = false;
        st.call('render', scene, camera);
      }
    } finally {
      if (sm) sm.autoUpdate = smAuto;
      st.call('setScissorTest', false);
    }
    st.stats.flat++;
  }
  // Redraw the page's last screen draws (render-on-demand pages, or a resize that just cleared the
  // store). Stereo draws re-run with THIS frame's eyes, so an idle page still looks around.
  function replay(st, ops) {
    const prevRT = st.call('getRenderTarget');
    if (prevRT !== null) st.call('setRenderTarget', null);
    try {
      for (const op of ops) {
        if (op[0] === 'clear') forEyes(st, () => st.call('clear', op[1], op[2], op[3]));
        else if (op[3]) renderStereo(st, op[1], op[2]);
        else renderFlat(st, op[1], op[2]);
      }
      st.stats.replays++;
    } catch (e) {
      warnOnce('replay', 'replaying the last frame threw; idle frames will not be redrawn', e);
      st.lastOps = null;
    } finally {
      if (prevRT !== null) st.call('setRenderTarget', prevRT);
    }
  }
  function repaintNow(st) {
    const ops = st.frame.ops.length ? st.frame.ops : st.lastOps;
    if (ops && ops.length) replay(st, ops);
  }

  // ------------------------------------------------------------ convergence: the scene's bounds
  // Bounding spheres of what the camera's layers can see (meshes, points, lines, sprites), in world
  // space, for core.estimateSubjectDistance.
  function forEachBounds(scene, cam, cb) {
    let more = true;
    scene.traverseVisible((o) => {
      if (!more || !(o.isMesh || o.isPoints || o.isLine || o.isSprite)) return;
      if (cam.layers && o.layers && typeof cam.layers.test === 'function' && !cam.layers.test(o.layers)) return;
      let bs = o.boundingSphere || null;
      const g = o.geometry;
      if (!bs && g) {
        if (!g.boundingSphere && typeof g.computeBoundingSphere === 'function') { try { g.computeBoundingSphere(); } catch (e) { /* ignore */ } }
        bs = g.boundingSphere;
      }
      if (!bs || !(bs.radius >= 0) || !isFinite(bs.radius)) return;
      const m = o.matrixWorld.elements, c = bs.center;
      const wx = m[0] * c.x + m[4] * c.y + m[8] * c.z + m[12];
      const wy = m[1] * c.x + m[5] * c.y + m[9] * c.z + m[13];
      const wz = m[2] * c.x + m[6] * c.y + m[10] * c.z + m[14];
      const s = Math.sqrt(Math.max(m[0] * m[0] + m[1] * m[1] + m[2] * m[2], m[4] * m[4] + m[5] * m[5] + m[6] * m[6], m[8] * m[8] + m[9] * m[9] + m[10] * m[10]));
      more = cb(wx, wy, wz, bs.radius * s) !== false;
    });
  }

  info(`three.js adapter armed (core v${core.VERSION})`);
})();

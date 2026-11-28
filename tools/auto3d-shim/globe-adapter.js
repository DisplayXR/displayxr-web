// DisplayXR auto-3D — the GLOBE part (v0.8.3): a WebGL renderer that draws a TILED WORLD (a globe, a
// 3D map), recognised by what it draws, never by its site. PROTOTYPE, not a product.
//
// `function dxrGlobe(core, glTap)`, a part of the core bundle (build.mjs). It sits on the generic WebGL
// tap (gl-tap.js) and owns only what is specific to a globe / map renderer:
//
//   RECOGNITION (behaviour only). The sentinel hands over every bare WebGL context (one with no engine
//   the other adapters know) 3 s after it was created (sentinel.js, the globe route); consider() taps
//   it and watches its frames. A frame QUALIFIES when it draws, on screen, at least MIN_TILES draws
//   that each carry their own clip matrix (one camera, many model origins: the relative-to-centre tile
//   scheme every globe and 3D-map renderer uses to keep float precision at planet scale), and the
//   tiles' model origins, seen from the camera, lie on ONE SURFACE (a least-squares plane in clip space
//   (u, v, w) with a small residual: the ground) that has RELIEF in view (the far tiles at least
//   RELIEF × as deep as the near ones: a tilted view, a globe; a straight-down flat map does not).
//   QUALIFY_FRAMES qualifying frames recognise the canvas for the rest of the page. Nothing else
//   qualifies: an engine page uploads one view-projection for all its draws (no per-draw clip
//   matrices), an orthographic 2D map has no clip matrix at all, a flat top-down map has no relief.
//   A canvas another adapter tracks is never taken.
//
//   THE RIG: a globe is a WORLD. The adapter tells the core so (ad.world()), which latches the open
//   scene at once: camera rig, fixed focus, real scale (metersToVirtual 1, converged openSceneConvM
//   ahead), decided once for the page and kept, whatever the page's own controls do. The runtime
//   returns off-axis eyes for that rig; the adapter reads each eye's horizontal frustum shear
//   k = -P[8] (the NDC shift of content at infinity) and hands the tap { k, C } with
//
//   THE FOCUS (the comfort rule): C, in the page's own units, is the depth of the SURFACE AT THE CENTRE
//   OF THE VIEW — read on the view axis from a plane through the drawn vertices the tap samples around
//   the centre (gl-tap.js: real surface points, from the page's own vertex data; a tile's model origin is
//   often a bounding-box corner well off the surface: about 12 % too far on Google Maps), else their median
//   depth at the centre, else the plane through the tile origins — but never more than NEAR_FACTOR × the nearest surface
//   in view (the 10th percentile of those depths), times the user's Focus. A pure function of the page
//   camera and what it draws: it follows the page's zoom from globe to
//   street level with no estimator, no easing and nothing to hunt. With it, content at view depth z sits
//   at k · (1 − C / z) of NDC disparity: 0 on the ground at the centre, k at infinity (k is the open
//   scene's comfort: a quarter of the viewer's IPD at the default depth), and at most −k (crossed) for
//   the nearest ground, at any zoom.
//
//   LABELS AND PINS: a globe draws its labels, icons and pins in screen space (no clip matrix). The tap
//   draws those into both halves unchanged: at the glass, in both eyes.
//
//   REPLAY: a map draws only when something changes (render on demand), so where the core needs a
//   frame the page did not draw (the flip, the first stereo frame, every step of the depth fade, an eye
//   pair that moved, the out-cover and the mono frame of a turn-off) the tap REPLAYS the page's last
//   screen frame (gl-tap.js), side by side with the current eyes, or mono. Recording starts only once
//   the canvas is recognised. A page that is not drawing and needs nothing keeps its last frame, which
//   is a full stereo pair while live.
function dxrGlobe(core, glTap) {
  const T = core.T;
  const MIN_TILES = 12, MIN_POINTS = 8, MAX_RELRES = 0.12, RELIEF = 1.15, QUALIFY_FRAMES = 6, NEAR_FACTOR = 2, CENTRE_R = 0.2, MIN_VERTS = 24;
  const seen = new WeakSet();
  const states = [];
  let warnedTaken = false;

  // ---------------------------------------------------------------- the ground fit
  // tiles: [u, v, w] = the clip position of each tile's model origin. In-view points only (|x|, |y| <=
  // 1.2 in NDC). Least-squares plane w = a·u + b·v + c (a plane in view space is a plane in (u, v, w)),
  // refitted once without the points beyond 3 × the median residual. c is the plane's depth on the axis.
  function fitGround(tiles) {
    const P = [];
    for (const t of tiles) { const w = t[2]; if (!(w > 0)) continue; const x = t[0] / w, y = t[1] / w; if (Math.abs(x) <= 1.2 && Math.abs(y) <= 1.2) P.push(t); }
    if (P.length < MIN_POINTS) return null;
    const solve = (pts) => {
      let suu = 0, suv = 0, su = 0, svv = 0, sv = 0, n = 0, suw = 0, svw = 0, sw = 0;
      for (const [u, v, w] of pts) { suu += u * u; suv += u * v; su += u; svv += v * v; sv += v; n++; suw += u * w; svw += v * w; sw += w; }
      // [suu suv su; suv svv sv; su sv n] [a b c]' = [suw svw sw]'
      const A = [[suu, suv, su, suw], [suv, svv, sv, svw], [su, sv, n, sw]];
      for (let i = 0; i < 3; i++) {
        let p = i; for (let r = i + 1; r < 3; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
        if (Math.abs(A[p][i]) < 1e-12) return null;
        [A[i], A[p]] = [A[p], A[i]];
        for (let r = 0; r < 3; r++) if (r !== i) { const f = A[r][i] / A[i][i]; for (let c = i; c < 4; c++) A[r][c] -= f * A[i][c]; }
      }
      return [A[0][3] / A[0][0], A[1][3] / A[1][1], A[2][3] / A[2][2]];
    };
    let q = solve(P);
    if (!q) return null;
    const res = (pts, q) => pts.map(([u, v, w]) => Math.abs(w - (q[0] * u + q[1] * v + q[2])));
    let r = res(P, q);
    const med = (a) => { const b = a.slice().sort((x, y) => x - y); return b[b.length >> 1]; };
    const m0 = med(r);
    const keep = P.filter((p, i) => r[i] <= 3 * m0 + 1e-9 * Math.abs(q[2]));
    if (keep.length >= MIN_POINTS && keep.length < P.length) { const q2 = solve(keep); if (q2) { q = q2; r = res(keep, q); } }
    const ws = P.map((p) => p[2]).sort((x, y) => x - y);
    const pct = (f) => ws[Math.min(ws.length - 1, Math.max(0, Math.floor(f * (ws.length - 1))))];
    const c = q[2];
    return { n: P.length, c, a: q[0], b: q[1], relres: c > 0 ? med(r) / c : Infinity, near: pct(0.1), far: pct(0.9), relief: pct(0.9) / pct(0.1) };
  }

  // The surface from the sampled vertices (see THE FOCUS): { c, near, n, via } or null.
  function surfaceOf(F) {
    const V = [];
    for (const p of F.verts) { const w = p[2]; if (!(w > 0)) continue; const x = p[0] / w, y = p[1] / w; if (Math.abs(x) <= 1.05 && Math.abs(y) <= 1.05) V.push([x, y, w]); }
    if (V.length < MIN_VERTS) return null;
    const ws = V.map((p) => p[2]).sort((a, b) => a - b);
    const near = ws[Math.floor(0.1 * (ws.length - 1))];
    // the plane through the vertices around the centre (|x|, |y| <= 0.5), read on the view axis; else the
    // median depth of the vertices at the centre; else the plane through all of them
    const local = F.verts.filter((p) => p[2] > 0 && Math.abs(p[0] / p[2]) <= 0.5 && Math.abs(p[1] / p[2]) <= 0.5);
    const fl = local.length >= MIN_VERTS ? fitGround(local) : null;
    if (fl && fl.c > 0 && fl.relres <= 0.25) return { c: fl.c, near, n: V.length, via: 'plane through the vertices at the centre' };
    const mid = V.filter((p) => Math.abs(p[0]) <= CENTRE_R && Math.abs(p[1]) <= CENTRE_R).map((p) => p[2]).sort((a, b) => a - b);
    if (mid.length >= 6) return { c: mid[mid.length >> 1], near, n: V.length, via: 'vertices at the centre' };
    const f = fitGround(F.verts);
    return f && f.c > 0 ? { c: f.c, near, n: V.length, via: 'plane through the vertices' } : null;
  }

  // ---------------------------------------------------------------- per context
  function consider(canvas, gl) {
    if (!canvas || !gl || seen.has(gl) || core.retired) return;
    seen.add(gl);
    if (takenByOther(canvas)) return;
    const G = { canvas, gl, tap: null, q: 0, recent: [], st: null, fit: null, C: 0, lastDrawAt: 0, fps: [], gone: false, seenFrames: 0 };
    G.tap = glTap(gl, { frame: (F) => onFrame(G, F) });
    states.push(G);
  }
  function takenByOther(canvas) {
    for (const w of core.tracked) { const st = w.deref(); if (st && st.canvas === canvas && !st.isGlobe) return true; }
    return false;
  }
  function give(G, why) {
    if (G.gone) return;
    G.gone = true;
    try { G.tap.uninstall(); } catch (e) { /* ignore */ }
    if (!warnedTaken) { warnedTaken = true; core.info('globe: leaving', core.desc(G.canvas), 'alone:', why); }
  }

  function onFrame(G, F) {
    if (G.gone) return;
    const t = core.now();
    if (!F.replay) { G.lastDrawAt = t; G.pageFrames = (G.pageFrames || 0) + 1; G.fps.push(t); if (G.fps.length > 60) G.fps.shift(); }
    const fit = !F.replay && F.clip >= MIN_TILES ? fitGround(F.tiles) : null;
    if (fit) G.fit = fit;
    if (grabs.length && (G.st || !grabs.recognisedOnly)) serveGrabs(G);
    const st = G.st;
    if (!st) {
      if (F.replay) return;
      if (++G.seenFrames % 30 === 1 && takenByOther(G.canvas)) { give(G, 'another adapter converts it'); return; }
      const ok = !!fit && fit.relres <= MAX_RELRES && fit.relief >= RELIEF && fit.c > 0;
      G.recent.push(ok); if (G.recent.length > 20) G.recent.shift();
      if (ok) G.q++;
      if (G.q >= QUALIFY_FRAMES && G.recent.filter(Boolean).length >= QUALIFY_FRAMES) recognise(G, F, fit);
      return;
    }
    // ---- a recognised canvas
    st.stats.calls++;
    if (!F.replay) {
      const sf = surfaceOf(F);
      if (sf) { G.surf = sf; G.C = focusOf(sf); }
      else if (fit) { G.surf = { c: fit.c, near: fit.near, n: fit.n, via: 'tile origins' }; G.C = focusOf(fit); }
    }
    if (G.tap.stereo) {
      if (F.stereo) G.tap.drawnK = G.tap.stereo.k.slice();
      G.tap.stereo.C = G.C * (core.site.convScale || 1);
      if (st.active) {
        if (G.drawnW !== G.gl.drawingBufferWidth || G.drawnH !== G.gl.drawingBufferHeight) setR(st, G);
        if (st.haveViews) st.stats.stereo++; else { st.stats.flat++; if (st.stats.twoView > 0) st.stats.flatAfterEyes++; }
        core.drew(st);
        if (st.outCoverDue) core.takeOutCover(st);
      }
    } else if (st.wantMono) {
      st.wantMono = false;
      core.monoDrawn(st);
    }
    if (st.armed) { core.flip(st); return; }
    if (!st.active && !st.pending && !st.releasing) core.considerActivation(st);
  }
  // C: the ground at the centre of the view, never beyond NEAR_FACTOR x the nearest ground in view.
  const focusOf = (fit) => Math.max(1e-6, Math.min(fit.c, NEAR_FACTOR * fit.near));

  function recognise(G, F, fit) {
    const st = core.newState('WebGL globe', G.canvas, ad);
    st.isGlobe = true; st.G = G; G.st = st;
    const sf = surfaceOf(F);
    G.surf = sf || { c: fit.c, near: fit.near, n: fit.n, via: 'tile origins' };
    G.C = focusOf(G.surf);
    st.L = { w: G.gl.drawingBufferWidth, h: G.gl.drawingBufferHeight, pr: 1 };
    core.registerEngine('WebGL globe');
    G.tap.record = true;
    core.info(`globe: ${core.desc(G.canvas)} draws a tiled world (${F.clip} tiles on one camera, ground fit ${(fit.relres * 100).toFixed(1)} % residual, relief ${fit.relief.toFixed(2)}) — a world: camera rig, focus on the ground at the centre of the view`);
    core.notify();
    core.considerActivation(st);
  }
  function setR(st, G) {
    const W = G.gl.drawingBufferWidth, H = G.gl.drawingBufferHeight;
    G.drawnW = W; G.drawnH = H;
    st.R = { W, H, eyeW: Math.floor(W / 2), eyeH: H };
  }
  // A frame now, by replaying the page's last one (see the header). Not when the page drew in this
  // animation frame already (its frame is the current one) unless forced; false when there is nothing
  // to replay yet.
  function redrawNow(G, force) {
    if (!force && core.now() - G.lastDrawAt < 12) return false;
    return G.tap.replay();
  }
  // The eyes' horizontal shear, from the session's views (camera rig: the runtime's off-axis frusta).
  function eyeK(st) {
    if (!st.haveViews) return [0, 0];
    return [-st.V[0].proj[8], -st.V[1].proj[8]];
  }
  const fovOf = (G) => {
    const p = G.tap.F && G.tap.F.p11 && G.tap.F.p11.length ? G.tap.F.p11.slice().sort((a, b) => a - b)[G.tap.F.p11.length >> 1] : 0;
    if (p > 0.2 && p < 20) G.p11 = p;
    return 2 * Math.atan(1 / (G.p11 || 3.17)); // 35° until a tile told us
  };

  // ---------------------------------------------------------------- the adapter contract (core.js)
  const ad = {
    label: (st) => 'WebGL globe (tiled world)',
    unqualified(st) {
      const G = st.G;
      if (G.gone) return 'the WebGL tap was removed';
      if (takenByOther(st.canvas)) return 'another adapter converts this canvas';
      const why = core.canvasPlacement(st.canvas) || core.cssEffect(st.canvas);
      if (why) return why;
      if (core.now() - G.lastDrawAt > 2000) return 'the globe is not drawing';
      return null;
    },
    hasCamera: (st) => !st.G.gone,
    depthRange: () => ({ near: 0.05, far: 10000 }), // rig units (the open scene's real scale): the runtime's frusta only
    rigFov: (st) => fovOf(st.G),
    sampler(st) {
      const G = st.G, c = G.canvas;
      const aspect = (c.clientWidth || G.gl.drawingBufferWidth) / Math.max(1, c.clientHeight || G.gl.drawingBufferHeight);
      return { cameraPose: IDENT, verticalFov: fovOf(G), aspect, near: 0.05, far: 10000, forEachBounds() {} };
    },
    world: (st) => 'a tiled globe / map (one camera over many ground tiles)',
    target: () => null,
    fakeViewParams(st) {
      const G = st.G, f = fovOf(G);
      return { near: 0.05, far: 10000, t: Math.tan(f / 2), aspect: G.gl.drawingBufferWidth / 2 / Math.max(1, G.gl.drawingBufferHeight) * 2 };
    },
    beforeActive() {},
    afterActive(st) {
      const G = st.G;
      setR(st, G);
      G.tap.stereo = { k: eyeK(st), C: G.C * (core.site.convScale || 1) };
    },
    firstDraw(st) { redrawNow(st.G, true); },
    redraw(st) {
      const G = st.G;
      if (!G.tap.stereo) return;
      const k = eyeK(st), o = G.tap.drawnK || [0, 0];
      G.tap.stereo.k = k;
      // A changed eye pair (the depth fade, the user's depth, a head move) or a due out-cover needs a frame
      // the page may not draw: replay its last one with the current eyes.
      if (Math.abs(k[0] - o[0]) + Math.abs(k[1] - o[1]) > 2e-4 || st.outCoverDue || !G.tap.drawnK) { if (redrawNow(G, false)) G.tap.drawnK = k.slice(); }
      if (!G.offAt && core.canvasPlacement(st.canvas)) G.offAt = core.now();
      else if (G.offAt && !core.canvasPlacement(st.canvas)) G.offAt = 0;
      if (G.offAt && core.now() - G.offAt > 1000) { G.offAt = 0; core.stand(st, 'the globe canvas left the screen (the page switched view)'); }
    },
    restore(st) {
      const G = st.G;
      G.tap.stereo = null;
      G.tap.drawnK = null;
      G.tap.clearTaint();
      st.wantMono = true;
      // the mono frame now, under the still-bound layer (core.stand: mono first, release after)
      return redrawNow(G, true) && !st.wantMono;
    },
    flipIdle(st) { redrawNow(st.G, true); },
    wake(st) { redrawNow(st.G, true); },
    describe(st) {
      const G = st.G, f = G.fit;
      const ts = G.fps; const fps = ts.length > 5 ? (ts.length - 1) / ((ts[ts.length - 1] - ts[0]) / 1000) : 0;
      return {
        page: { surface: G.surf ? { depth: +G.surf.c.toPrecision(4), near: +G.surf.near.toPrecision(4), points: G.surf.n, via: G.surf.via } : null, tiles: G.tap.F ? G.tap.F.clip : 0, flat: G.tap.F ? G.tap.F.flat : 0, through: G.tap.F ? G.tap.F.through : 0, ground: f ? +f.c.toPrecision(4) : null, near: f ? +f.near.toPrecision(4) : null, relief: f ? +f.relief.toFixed(2) : null, residual: f ? +f.relres.toFixed(3) : null, focus: +G.C.toPrecision(4), fps: +fps.toFixed(1) },
        real: st.R ? { w: st.R.W, h: st.R.H } : null,
        stereo: G.tap.stereo ? { k: G.tap.stereo.k.map((x) => +x.toFixed(4)), C: +G.tap.stereo.C.toPrecision(4) } : null,
      };
    },
    surface: (st) => core.surfaces.gl(st.G.gl),
    coverAfterDraw: true,
  };
  const IDENT = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

  // DEV ONLY (cfg.dev): window.__dxrGlobe.grab() resolves with the next page frame's pixels, read in its
  // drawing task (the drawing buffer is not preserved): { w, h, png } — the side-by-side store while live.
  const grabs = [];
  function serveGrabs(G) {
    const gl = G.gl, w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    try { gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px); } catch (e) { /* lost */ }
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d'), im = g.createImageData(w, h);
    for (let y = 0; y < h; y++) im.data.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    g.putImageData(im, 0, 0);
    const out = { w, h, png: c.toDataURL('image/png'), live: !!(G.st && G.st.active), stereo: G.tap.stereo ? { k: G.tap.stereo.k.slice(), C: G.tap.stereo.C } : null, fit: G.fit, surf: G.surf };
    for (const r of grabs.splice(0)) r(out);
  }
  if (core.cfg.dev) {
    try { Object.defineProperty(window, '__dxrGlobe', { configurable: true, value: { set: (o) => { for (const G of states) { if ('sampleVerts' in o) G.tap.sampleVerts = !!o.sampleVerts; if ('record' in o && G.st) G.tap.record = !!o.record; } }, grab: () => new Promise((r) => { grabs.push(r); grabs.recognisedOnly = true; for (const G of states) if (G.st) redrawNow(G, true); }), states: () => states.map((G) => ({ canvas: core.desc(G.canvas), recognised: !!G.st, qualifying: G.q, gone: G.gone, fit: G.fit, surf: G.surf, C: G.C, stereo: G.tap.stereo, frames: G.tap.frames, pageCount: G.pageFrames || 0, lastF: G.tap.F && { d: G.tap.F.draws, s: G.tap.F.screen, c: G.tap.F.clip, f: G.tap.F.flat, o: G.tap.F.offscreen, t: G.tap.F.tiles.length, v: G.tap.F.verts.length, wq: G.tap.F.wq.slice(0, 8) }, pageFrames: G.fps.length, lastDrawAgo: Math.round(core.now() - G.lastDrawAt) })) } }); } catch (e) { /* ignore */ }
  }

  return { consider, states: () => states.map((G) => ({ canvas: core.desc(G.canvas), recognised: !!G.st, qualifying: G.q, gone: G.gone, fit: G.fit })) };
}

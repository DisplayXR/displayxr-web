// Slice C: the frame-rate guard, the GL size clamp, reduced motion, and the PlayCanvas
// shadow-distance offset. Dev bundle (env.NEW); asserts through window.__dxrAuto3D, the dev
// report log (window.__dxrAuto3DReports) and window.__fakeXR.

// Live, settled: enough 2-view frames and the go-live fade finished.
const settled = (extra = 'true') => `(() => { const s = window.__dxrAuto3D && window.__dxrAuto3D.state(); const r = s && s.renderers.find((x) => x.active);
  return !!(r && r.stats.twoView > 90 && r.rampK === 1 && !r.ramping && (${extra})); })()`;
// The out-cover lives only briefly: record the first one inserted (as the kill cases do).
const watchOutCover = () => {
  window.__outCover = null;
  const mo = new MutationObserver((recs) => {
    for (const r of recs) for (const n of r.addedNodes) {
      if (!window.__outCover && n.nodeType === 1 && n.matches('img[data-dxr-auto3d-cover]')) {
        window.__outCover = { srcLen: n.src.length, naturalWidth: n.naturalWidth, naturalHeight: n.naturalHeight, src: n.src };
        mo.disconnect();
      }
    }
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
};
// The out-cover vs the mono canvas after the stand-down (the kill cases' check, run.mjs).
const compareOutCover = async () => {
  const oc = window.__outCover;
  if (!oc) return null;
  const w = 128, h = 72;
  const img = new Image(); img.src = oc.src; await img.decode();
  const px = (src) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(src, 0, 0, w, h); return g.getImageData(0, 0, w, h).data; };
  const a = px(img), b = px(document.querySelector('canvas:not([data-dxr-auto3d-cover])'));
  const lum = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  let e = 0, ef = 0, m = 0, m2 = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, j = ((h - 1 - y) * w + x) * 4, l = lum(a, i);
    e += Math.abs(l - lum(b, i)); ef += Math.abs(l - lum(b, j)); m += l; m2 += l * l;
  }
  const n = w * h; m /= n;
  return { srcLen: oc.srcLen, mae: e / n, maeFlipped: ef / n, std: Math.sqrt(Math.max(0, m2 / n - m * m)) };
};
const outCoverReal = (k) => k && (k.srcLen > 200000 || (k.std > 4 && k.mae < 12 && 3 * k.mae < k.maeFlipped));
const hotkey = async (page, code) => {
  await page.keyboard.down('Control'); await page.keyboard.down('Alt'); await page.keyboard.press(code);
  await page.keyboard.up('Alt'); await page.keyboard.up('Control');
};
// A page that burns N ms in its OWN rAF (every frame, 2D and 3D alike) and keeps its canvas
// unqualified (opacity .99) for the first holdMs after the canvas appears (not after document start:
// on a slow box the engine may take longer than that to load), so the shim sees a 2D rate before
// going live.
const burnPrelude = (ms, holdMs) => `(() => {
  const f = () => { const t0 = performance.now(); while (performance.now() - t0 < ${ms}) {} requestAnimationFrame(f); };
  requestAnimationFrame(f);
  const sh = new CSSStyleSheet(); sh.replaceSync('canvas { opacity: .99 }');
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sh];
  const lift = () => { document.adoptedStyleSheets = document.adoptedStyleSheets.filter((x) => x !== sh); };
  const wait = () => { if (document.querySelector('canvas')) setTimeout(lift, ${holdMs}); else setTimeout(wait, 50); };
  wait();
})();`;
// A page that burns N ms in its OWN rAF only while it is "loading": from the first layer until
// holdMs + loadMs after it (the cover drop is ~holdMs after the layer), then runs clean. Only the
// FIRST layer: a retry's layer finds a loaded page. (Spark hello-world / streaming-lod on the panel.)
const loadingPrelude = (ms, loadMs) => `(() => {
  const f = () => {
    const L = window.__fakeXR && window.__fakeXR.layers[0];
    if (L && performance.now() - L.at < 1200 + ${loadMs}) { const t0 = performance.now(); while (performance.now() - t0 < ${ms}) {} }
    requestAnimationFrame(f);
  };
  requestAnimationFrame(f);
})();`;
// A page still STREAMING: its own rAF alternates 80 ms / 40 ms burns every 700 ms (unsteady in 2D,
// ~17 fps in 3D) from the first layer until holdMs + loadMs after it, then runs clean.
const streamingPrelude = (loadMs) => `(() => {
  const f = () => {
    const L = window.__fakeXR && window.__fakeXR.layers[0], t = performance.now();
    if (L && t - L.at < 1200 + ${loadMs}) { const ms = Math.floor(t / 700) % 2 ? 80 : 40; const t0 = performance.now(); while (performance.now() - t0 < ms) {} }
    requestAnimationFrame(f);
  };
  requestAnimationFrame(f);
})();`;
const fpsOver = async (page, ms) => {
  const a = await page.evaluate(() => ({ f: window.__fakeXR.frames, t: performance.now() }));
  await new Promise((r) => setTimeout(r, ms));
  const b = await page.evaluate(() => ({ f: window.__fakeXR.frames, t: performance.now() }));
  return (1000 * (b.f - a.f)) / (b.t - a.t);
};
const readOut = () => ({
  reports: (window.__dxrAuto3DReports || []).map(({ status, reason }) => ({ status, reason })),
  state: window.__dxrAuto3D.state(), sessions: window.__fakeXR.sessions.length, layers: window.__fakeXR.layers.length,
  closes: window.__fakeXR.closes, stored: localStorage.getItem('dxrAuto3D'),
});

// Mean luma of 7x7 patches of the canvas's current store at the page's shadow / lit probe points.
const shadowRead = (mode) => new Promise((res) => requestAnimationFrame(() => setTimeout(() => {
  const S = window.__shadow, cv = document.querySelector('canvas:not([data-dxr-auto3d-cover])');
  const W = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width').get.call(cv);
  const H = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'height').get.call(cv);
  const c2 = document.createElement('canvas'); c2.width = W; c2.height = H;
  const g = c2.getContext('2d', { willReadFrequently: true }); g.drawImage(cv, 0, 0);
  const d = g.getImageData(0, 0, W, H).data;
  const patch = ([x, y]) => {
    let s = 0, n = 0;
    for (let j = -3; j <= 3; j++) for (let i = -3; i <= 3; i++) {
      const px = Math.round(x) + i, py = Math.round(y) + j;
      if (px < 0 || py < 0 || px >= W || py >= H) continue;
      const k = (py * W + px) * 4; s += 0.299 * d[k] + 0.587 * d[k + 1] + 0.114 * d[k + 2]; n++;
    }
    return n ? s / n : NaN;
  };
  const sd = S.sun.light.shadowDistance;
  if (mode === 'mono') { res({ W, H, sd, mono: { shadow: patch(S.screen(S.shadowPt)), lit: patch(S.screen(S.litPt)) } }); return; }
  // Stereo: project through the FAKE runtime's views (fake-xr.js): eye = page camera + (0, 0, eyeZ),
  // projection 50 deg vertical, aspect eyeW/eyeH, off-axis skew +0.1 (left) / -0.1 (right) in P[8].
  const eyeW = W / 2, eyeH = H, aspect = eyeW / eyeH, t = 1 / Math.tan((50 * Math.PI) / 360), eyeZ = window.__fakeXROpts.eyeZ || 0;
  const at = (p, i) => {
    const [x, y, z0] = S.view(p), z = z0 - eyeZ, skew = i ? -0.1 : 0.1;
    const nx = ((t / aspect) * x + skew * z) / -z, ny = (t * y) / -z;
    return [i * eyeW + ((nx + 1) / 2) * eyeW, ((1 - ny) / 2) * eyeH];
  };
  res({ W, H, sd, eyes: [0, 1].map((i) => ({ shadow: patch(at(S.shadowPt, i)), lit: patch(at(S.litPt, i)), at: at(S.shadowPt, i).map(Math.round) })) });
}, 0)));

export default function cases({ P, NEW }) {
  const shadowCase = (id, name, offsetOn) => ({
    id, name, url: P + 'pc-shadow.html', shim: NEW,
    cfg: { rig: 'display', ...(offsetOn ? {} : { pcShadowOffset: false }) }, fake: { eyeZ: 12 },
    async run(page, h) {
      await page.waitForFunction(settled('window.__frozen'), { timeout: 30000, polling: 100 });
      await h.sleep(300);
      const live = await page.evaluate(shadowRead, 'stereo');
      if (!offsetOn) return { live };
      await hotkey(page, 'Digit3');
      await page.waitForFunction(() => { const r = window.__dxrAuto3D.state().renderers[0]; return r && !r.active && !r.releasing && window.__fakeXR.layers[0].closedAt !== null; }, { timeout: 5000, polling: 50 });
      await h.sleep(500);
      const mono = await page.evaluate(shadowRead, 'mono');
      return { live, mono };
    },
    check(r, t) {
      const L = r.live, M = r.mono;
      t('live in 3D (display rig, eyes 12 m behind the page camera)', r.ok && L && L.W > 0, r.error || '');
      if (!L) return;
      const fmt = (e) => `shadow ${e.shadow.toFixed(1)} vs lit ${e.lit.toFixed(1)} at ${e.at}`;
      if (offsetOn) {
        t("shadowDistance = the page's 11 + the eye pull-back 12 while live", Math.abs(L.sd - 23) < 0.02, `shadowDistance ${L.sd}`);
        for (const i of [0, 1]) t(`${i ? 'right' : 'left'} eye: the box's shadow is on the ground (in-shadow patch >= 20 levels darker than lit ground)`, L.eyes[i].lit - L.eyes[i].shadow >= 20, fmt(L.eyes[i]));
        t("after restore: shadowDistance back to the page's 11", M && M.sd === 11, `shadowDistance ${M && M.sd}`);
        t('after restore: the mono frame shows the shadow', M && M.mono.lit - M.mono.shadow >= 20, M ? `shadow ${M.mono.shadow.toFixed(1)} vs lit ${M.mono.lit.toFixed(1)} (store ${M.W}x${M.H})` : 'n/a');
      } else {
        // The control: WITHOUT the offset the eyes are past the fade line and the shadow is gone —
        // proves the case above discriminates.
        t('control (offset off): shadowDistance untouched', L.sd === 11, `shadowDistance ${L.sd}`);
        for (const i of [0, 1]) t(`control (offset off), ${i ? 'right' : 'left'} eye: NO shadow (patches within 5 levels)`, Math.abs(L.eyes[i].lit - L.eyes[i].shadow) < 5, fmt(L.eyes[i]));
      }
    },
  });

  const clampCase = (id, name, url, extra) => ({
    id, name, url: P + url, shim: NEW, cfg: { glLimit: 512, ...(extra || {}) }, expect: 'convert', fovDeg: 40, ready: 'window.__frozen',
    alsoCheck(r, t, h, R) {
      const [ew, eh] = R.eye; // unclamped: eye 640x720 (the 1280x720 CSS canvas at DPR 1, half width)
      t('glLimit 512: each axis capped on its own (SBS width 512 -> eye 256; height 720 -> 512)', ew === 256 && eh === 512 && R.real[0] === 512 && R.real[1] === 512,
        `store ${R.real.join('x')}, eye ${ew}x${eh}`);
    },
  });

  return [
    {
      id: 'g-trip', name: 'frame-rate guard: conversion costs 60 ms a frame -> back to 2D, ONE retry after guardRetryMs, trips again -> blocked, report guard',
      url: P + 'pc-orbit.html', shim: NEW, cfg: { guardFps: 24 }, fake: { frameCostMs: 60 }, commits: true, // 3D ~14 fps: below 24 and below 0.6 x the ~55 fps 2D rate
      async run(page, h) {
        await page.evaluate(watchOutCover);
        await page.waitForFunction(() => (window.__dxrAuto3DReports || []).some((r) => r.status === 'guard'), { timeout: 50000, polling: 100 });
        await page.waitForFunction(() => { const r = window.__dxrAuto3D.state().renderers[0]; return r && !r.active && !r.releasing; }, { timeout: 5000, polling: 50 });
        await h.sleep(300);
        const cmp = await page.evaluate(compareOutCover);
        const at = await page.evaluate(() => ({ sessions: window.__fakeXR.sessions.length }));
        await h.sleep(5000);
        const out = await page.evaluate(readOut);
        return { at, out, cmp };
      },
      check(r, t, h) {
        const O = r.out;
        t('guard tripped (report { status: guard })', r.ok && O && O.reports.some((x) => x.status === 'guard' && /frame-rate guard/.test(x.reason || '')), r.error || JSON.stringify(O && O.reports));
        if (!O) return;
        t('the last report is guard (the chip hides on it)', O.reports[O.reports.length - 1].status === 'guard', O.reports.map((x) => x.status).join(' -> '));
        const S = O.state.renderers[0];
        t('back to 2D, both layers closed', S && !S.active && !S.releasing && O.closes.length === 2, `active ${S && S.active}, closes ${O.closes.length}`);
        t('exactly ONE retry: two sessions and two layers, still two 5 s after the block while the page keeps drawing', O.sessions === 2 && O.layers === 2 && r.at.sessions === 2, `sessions ${r.at.sessions} -> ${O.sessions}, layers ${O.layers}`);
        const lines = r.log.filter((l) => /back to 2D: frame-rate guard/.test(l));
        t('two console lines: the first trip announces the retry, the second the block', lines.length === 2 && /retrying once in 6\.0 s/.test(lines[0]) && /after one retry — 2D for the rest of this page/.test(lines[1]), lines.join(' | ') || '0 lines');
        const st = O.reports.map((x) => x.status), iLive = st.indexOf('live'), iGuard = st.indexOf('guard');
        t('reports: live -> converting (retry wait) -> live (the retry) -> guard', iLive >= 0 && st.slice(iLive, iGuard).includes('converting') && st.slice(iLive + 1, iGuard).includes('live'), st.join(' -> '));
        t('the retry is judged against the 2D rate drawn during the wait (the block names it)', /\(2D ran at \d+(\.\d)?\)/.test(O.reports[iGuard] ? O.reports[iGuard].reason : ''), O.reports[iGuard] ? O.reports[iGuard].reason : '');
        t('nothing saved', O.stored === null, `stored ${O.stored}`);
        for (const i of [0, 1]) {
          const rp = O.closes[i] ? h.rawPairAtClose(O.closes[i]) : null;
          t(`close #${i + 1}: no raw side-by-side frame once the layer is closed (commit model)`, rp && rp.frames >= 3 && rp.discriminates && rp.bad.length === 0,
            rp ? `${rp.frames} committed frames from close(); at close ${rp.atClose.toFixed(2)}, pair ${rp.pairBase.toFixed(2)}, mono ${rp.monoBase.toFixed(2)}; raw pairs [${rp.bad.map((b) => b.i).join(', ')}]` : 'layer never closed');
        }
        const k = r.cmp;
        t('the turn-off took the out-cover, and it holds a real picture', outCoverReal(k), k ? `data URL ${k.srcLen} chars; vs mono MAE ${k.mae.toFixed(2)} (flipped ${k.maeFlipped.toFixed(2)}), std ${k.std.toFixed(1)}` : 'no out-cover');
      },
    },
    {
      id: 'g-30fps', name: 'frame-rate guard: a page that is slow in 2D (its own rAF burns 60 ms a frame) stays in 3D',
      url: P + 'pc-orbit.html', shim: [burnPrelude(60, 2500), ...NEW], cfg: { guardFps: 24 }, // 60 ms: ~16 fps in 2D and 3D: below 24, but never below 0.6 x baseline
      async run(page, h) {
        await page.waitForFunction(settled(), { timeout: 30000, polling: 100 });
        const fps = await fpsOver(page, 7500); // warm-up (4 s from the cover drop) + a full window (2 s) + margin
        const out = await page.evaluate(readOut);
        return { fps, out };
      },
      check(r, t) {
        const O = r.out, S = O && O.state.renderers.find((x) => x.active);
        t('went live', r.ok && !!S, r.error || '');
        if (!O) return;
        t('3D really runs below guardFps 24 (the absolute test alone would trip)', r.fps < 24, `${r.fps.toFixed(1)} session fps`);
        t('no guard trip: still live, one session, no guard report', S && O.sessions === 1 && !O.reports.some((x) => x.status === 'guard'), `sessions ${O.sessions}; reports ${O.reports.map((x) => x.status).join(' -> ')}`);
      },
    },
    {
      // The page's own loop burns 60 ms (a ~16 fps page in 2D and in 3D alike) and it goes live on its
      // first qualifying draw, so the first trip has no baseline. P0.2: any first trip retries once
      // after guardRetryMs; the retry's baseline is the ~16 fps drawn during the wait, so it stays.
      id: 'g-retry', name: 'frame-rate guard, no baseline: a page that is slow in 2D anyway (60 ms burn) -> trip, ONE retry with the 2D rate of the wait as baseline -> stays live',
      url: P + 'pc-orbit.html', shim: [burnPrelude(60, 0), ...NEW], cfg: { guardFps: 24 },
      async run(page, h) {
        await page.waitForFunction(() => window.__fakeXR.sessions.length >= 2, { timeout: 40000, polling: 100 });
        await page.waitForFunction(settled(), { timeout: 20000, polling: 100 });
        const fps = await fpsOver(page, 7500); // warm-up (4 s) + a full window (2 s) + margin: a second trip would land here
        await h.sleep(500);
        return { fps, out: await page.evaluate(readOut) };
      },
      check(r, t) {
        const O = r.out, S = O && O.state.renderers.find((x) => x.active);
        t('first trip had no 2D baseline and announced ONE retry; the retry ran', r.ok && r.log.some((l) => /back to 2D: frame-rate guard: .*no 2D baseline.*retrying once in/.test(l)) && r.log.some((l) => /frame-rate guard: retrying once \(/.test(l)),
          r.error || r.log.filter((l) => /frame-rate guard/.test(l)).join(' | '));
        if (!O) return;
        t('3D still runs below guardFps 24 (the no-baseline rule alone would trip again)', r.fps < 24, `${r.fps.toFixed(1)} session fps`);
        t('LIVE after the retry: two sessions, the second still open, no guard report', !!S && O.sessions === 2 && O.layers === 2 && O.closes.length === 1 && !O.reports.some((x) => x.status === 'guard'),
          `active ${!!S}, sessions ${O.sessions}, layers ${O.layers}, closes ${O.closes.length}; reports ${O.reports.map((x) => x.status).join(' -> ')}`);
        const st = O.reports.map((x) => x.status);
        t('reports: live -> converting (retry wait) -> ... -> live', st[st.length - 1] === 'live' && st.filter((x) => x === 'live').length === 2 && st.slice(st.indexOf('live')).includes('converting'), st.join(' -> '));
      },
    },
    {
      // P0.2 fix 1a: the warm-up. Heavy for the first 5 s after the cover drop (a Spark page loading its
      // splats), clean at 60 fps after. No guard window starts in the first 4 s, and whatever the guard
      // decides after that, the page must end LIVE (a trip would retry once, into a loaded page).
      id: 'g-loading', name: 'frame-rate guard: a page that burns 60 ms a frame for 5 s after go-live (loading), then runs clean -> ends LIVE',
      url: P + 'pc-orbit.html', shim: [loadingPrelude(60, 5000), ...NEW], cfg: { guardFps: 24 }, // the load runs ~16 fps; headless 'clean' is 40-60
      async run(page, h) {
        await page.waitForFunction(() => window.__fakeXR.layers.length >= 1, { timeout: 20000, polling: 100 });
        const slow = await fpsOver(page, 3000); // inside the loading phase: really below guardFps 24
        await page.waitForFunction(() => performance.now() - window.__fakeXR.layers[0].at > 17000, { timeout: 30000, polling: 200 });
        await page.waitForFunction(settled(), { timeout: 20000, polling: 100 });
        return { slow, out: await page.evaluate(readOut) };
      },
      check(r, t) {
        const O = r.out, S = O && O.state.renderers.find((x) => x.active);
        t('the loading phase really ran below guardFps (24) in 3D', r.ok && r.slow < 24, r.error || `${r.slow && r.slow.toFixed(1)} session fps`);
        if (!O) return;
        t('ends LIVE, no guard report', !!S && !O.reports.some((x) => x.status === 'guard') && O.reports[O.reports.length - 1].status === 'live',
          `active ${!!S}, sessions ${O.sessions}; reports ${O.reports.map((x) => x.status).join(' -> ')}`);
      },
    },
    {
      // P0.2 fix 1b: a loading phase longer than the warm-up. The first window trips (no baseline); the
      // page is fast in 2D by then, which #100 read as "the conversion's fault" and blocked. Now: ONE
      // retry after guardRetryMs whatever the 2D rate, into the loaded page -> live.
      id: 'g-loading-long', name: 'frame-rate guard: 60 ms a frame for 8 s after go-live -> first trip, 2D fast meanwhile, ONE retry anyway -> LIVE',
      url: P + 'pc-orbit.html', shim: [loadingPrelude(60, 8000), ...NEW], cfg: { guardFps: 24 },
      async run(page, h) {
        await page.waitForFunction(() => window.__fakeXR.sessions.length >= 2, { timeout: 40000, polling: 100 });
        await page.waitForFunction(settled(), { timeout: 20000, polling: 100 });
        await h.sleep(7500); // a second trip would land here (headless 'clean' is 30-60 fps: judged against the wait's 2D rate)
        return { out: await page.evaluate(readOut) };
      },
      check(r, t) {
        const O = r.out, S = O && O.state.renderers.find((x) => x.active);
        t('first trip during the load, announced a retry', r.ok && r.log.some((l) => /back to 2D: frame-rate guard: .*retrying once in 6\.0 s/.test(l)), r.error || r.log.filter((l) => /frame-rate guard/.test(l)).join(' | '));
        if (!O) return;
        t('LIVE after the retry: two sessions, one close, no guard report', !!S && O.sessions === 2 && O.closes.length === 1 && !O.reports.some((x) => x.status === 'guard'),
          `active ${!!S}, sessions ${O.sessions}, closes ${O.closes.length}; reports ${O.reports.map((x) => x.status).join(' -> ')}`);
        const st = O.reports.map((x) => x.status);
        t('reports end live', st[st.length - 1] === 'live', st.join(' -> '));
      },
    },
    {
      // Panel, Marble / streaming-lod: a fixed 6 s retry landed while the world was still streaming and
      // tripped again (20.0 vs a 2D rate of 25.4). The retry now waits for a steady 2D rate (2 s).
      id: 'g-steady', name: 'frame-rate guard: the page is still streaming (unsteady 2D) when guardRetryMs is up -> the retry waits for a steady 2D rate -> LIVE',
      url: P + 'pc-orbit.html', shim: [streamingPrelude(15000), ...NEW], cfg: { guardFps: 24 },
      async run(page, h) {
        await page.waitForFunction(() => window.__fakeXR.sessions.length >= 2, { timeout: 45000, polling: 100 });
        const at = await page.evaluate(() => ({ trip: window.__fakeXR.layers[0].closedAt - window.__fakeXR.layers[0].at, retry: window.__fakeXR.sessions[1].at - window.__fakeXR.layers[0].at }));
        await page.waitForFunction(settled(), { timeout: 20000, polling: 100 });
        await h.sleep(7500); // a second trip would land here
        return { at, out: await page.evaluate(readOut) };
      },
      check(r, t) {
        const O = r.out, S = O && O.state.renderers.find((x) => x.active);
        t('first trip during the stream', r.ok && r.log.some((l) => /back to 2D: frame-rate guard: .*retrying once/.test(l)), r.error || r.log.filter((l) => /frame-rate guard/.test(l)).join(' | '));
        if (!O) return;
        t('the retry waited past guardRetryMs for the stream to end (unsteady until 16.2 s after the layer)', r.at.retry > 16200 && r.at.retry - r.at.trip > 6000,
          `trip at ${Math.round(r.at.trip)} ms, retry at ${Math.round(r.at.retry)} ms after the first layer`);
        t('the retry names the steady 2D rate', r.log.some((l) => /frame-rate guard: retrying once \(2D steady at \d+(\.\d)? fps\)/.test(l)), r.log.filter((l) => /retrying once/.test(l)).join(' | '));
        t('LIVE after the retry: two sessions, no guard report', !!S && O.sessions === 2 && !O.reports.some((x) => x.status === 'guard'),
          `active ${!!S}, sessions ${O.sessions}; reports ${O.reports.map((x) => x.status).join(' -> ')}`);
      },
    },
    clampCase('g-clamp-three', 'GL size clamp (glLimit 512): three.js keyframes', 'three-keyframes.html', { convTarget: false }),
    clampCase('g-clamp-pc', 'GL size clamp (glLimit 512): PlayCanvas meshes', 'pc-mesh.html'),
    {
      id: 'g-reduced', name: 'prefers-reduced-motion: rampMs 1, and the turn-off still takes the out-cover',
      url: P + 'three-keyframes.html', shim: NEW, expect: 'convert', fovDeg: 40, ready: 'window.__frozen', killAfter: true, commits: true,
      before: (page) => page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]),
      probe: () => ({ rampMs: window.__dxrAuto3D.cfg.rampMs, reduce: matchMedia('(prefers-reduced-motion: reduce)').matches }),
      alsoCheck(r, t) {
        t('reduced motion: rampMs = 1 (never 0)', r.probe && r.probe.reduce && r.probe.rampMs === 1, JSON.stringify(r.probe));
        t('the turn-off inserted an out-cover', !!(r.after && r.after.outCover), r.after && r.after.outCover ? `${r.after.outCover.naturalWidth}x${r.after.outCover.naturalHeight}` : 'none');
      },
    },
    shadowCase('g-shadow', 'PlayCanvas shadow-distance offset: display-rig eyes far behind the camera still see the shadow; restored after', true),
    shadowCase('g-shadow-ctl', 'PlayCanvas shadow-distance offset OFF (control): the same eyes lose the shadow', false),
  ];
}

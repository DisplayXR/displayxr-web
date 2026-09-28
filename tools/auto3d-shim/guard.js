// DisplayXR auto-3D — frame-rate guard. PROTOTYPE, not a product.
//
// `function dxrGuard(core)`, a part of the core bundle (build.mjs). A page that cannot afford the
// conversion (two eye draws, the replay, the weave) goes back to 2D for the rest of the document
// instead of stuttering in 3D. Hooks the core calls:
//   draw(st, t)   every page draw while NOT converted (the top of considerActivation): the 2D baseline
//   onFlip(st)    the layer was just created: freeze the baseline, reset the window
//   tick(st, t)   once per session frame, after the cover tick: sample, maybe trip
//   tripped       null, or why the guard stood this document down for good (statusOf -> 'guard')
//   retrying      null, or why the guard is waiting to retry after a first trip (statusOf ->
//                 'converting', the chip amber; considerActivation waits)
//
// Baseline: the page's own 2D rate, from the last 60 draws before the flip. Only intervals of at most
// 250 ms count, and at least 20 of them are needed: a render-on-demand page (draws on input), or one
// that went live on its first qualifying draw (most pages), has no baseline. Sampling: session-frame
// intervals, from 1 s after the fade-in finished (rampK 1, no ramp, no cover) AND no earlier than
// T.guardWarmupMs (4 s) after the cover drop (P0.2: a page that is still loading its assets —
// Spark's hello-world and streaming-lod on the panel, 25-39 fps for the first seconds, then a steady
// 60 / 44 — must not be judged by its loading phase). Intervals over 250 ms and hidden-page time are
// excluded, and a visibilitychange starts over. Trip: the mean rate over the last T.guardMs is below
// T.guardFps AND, when there is a baseline, below 0.8 × baseline (a page that runs at 30 fps in 2D is
// not the conversion's fault).
//
// On the FIRST trip in a document, whatever the baseline (P0.2): core.turnOff (fade to flat ->
// out-cover -> staged stand), then wait T.guardRetryMs (6 s; report 'converting', chip amber) and
// retry ONCE, whatever the page's 2D rate meanwhile (#100's "retry only if 2D is slow too" blocked
// the Spark pages, whose 2D rate was 58 fps: their slow phase was the load, not the conversion). The
// page's 2D draws during the wait are the retry's baseline, so the second trip is judged against them
// when there are enough. A second trip blocks for the document: report 'guard', nothing saved.
function dxrGuard(core) {
  const T = core.T;
  const RING = 60, MAX_DT = 250, MIN_BASE = 20, ARM_MS = 1000;
  const g = new WeakMap(); // st -> { ring[], base, readyAt, last, dts[], sum }
  const of = (st) => { let s = g.get(st); if (!s) g.set(st, (s = { ring: [], base: 0, readyAt: 0, last: 0, dts: [], sum: 0 })); return s; };
  const resetWindow = (s) => { s.readyAt = 0; s.last = 0; s.dts.length = 0; s.sum = 0; };
  const api = { tripped: null, retrying: null };
  let retried = false; // the one retry this document gets
  let retryTimer = 0;

  // A hidden page runs no frames (or throttled ones): whatever was measured around it is not the
  // conversion's cost. Start over, 2D ring included.
  document.addEventListener('visibilitychange', () => {
    for (const w of core.tracked) { const st = w.deref(); const s = st && g.get(st); if (s) { resetWindow(s); s.ring.length = 0; } }
  });

  // The page's 2D rate over a ring of draw times: { n intervals, fps }.
  const rateOf = (ring) => {
    let n = 0, sum = 0;
    for (let i = 1; i < ring.length; i++) { const dt = ring[i] - ring[i - 1]; if (dt > 0 && dt <= MAX_DT) { n++; sum += dt; } }
    return { n, fps: n ? (1000 * n) / sum : 0 };
  };

  api.draw = (st, t) => {
    if (st.active || st.releasing) return; // the staged stand's mono frame is not a page draw
    const r = of(st).ring;
    r.push(t);
    if (r.length > RING) r.shift();
  };

  api.onFlip = (st) => {
    const s = of(st);
    const r = rateOf(s.ring);
    s.base = r.n >= MIN_BASE ? r.fps : 0;
    s.ring.length = 0;
    resetWindow(s);
  };

  api.tick = (st, t) => {
    if (api.tripped || api.retrying) return;
    const s = of(st);
    const settled = st.active && !st.cover && !st.ramp && !st.releasing && !st.offTok && core.rampK(st) === 1;
    if (!settled || document.hidden) { resetWindow(s); return; }
    if (!s.readyAt) s.readyAt = t;
    const prev = s.last;
    s.last = t;
    // The warm-up: no window starts within guardWarmupMs of the cover drop (the page may be loading).
    const warm = (st.coverDropAt || st.layerAt || 0) + T.guardWarmupMs;
    if (t - s.readyAt < ARM_MS || t < warm || !prev) return;
    const dt = t - prev;
    if (!(dt > 0) || dt > MAX_DT) return; // a hitch (GC, tab switch, debugger) is not a rate
    s.dts.push(dt); s.sum += dt;
    if (s.sum < T.guardMs) return;
    const fps = (1000 * s.dts.length) / s.sum;
    if (fps < T.guardFps && (!s.base || fps < 0.8 * s.base)) { trip(st, fps, s.base); return; }
    while (s.dts.length && s.sum - s.dts[0] >= T.guardMs) s.sum -= s.dts.shift();
  };

  const in3D = (fps, base) => `frame-rate guard: ${fps.toFixed(1)} fps in 3D over ${(T.guardMs / 1000).toFixed(1)} s` +
    (base ? ` (2D ran at ${base.toFixed(1)})` : ' (no 2D baseline)');
  const hold = (v) => { for (const w of core.tracked) { const o = w.deref(); if (o) { o.nextTry = v; if (!v) o.tries = 0; } } };
  function trip(st, fps, base) {
    if (!retried) {
      // The first trip: stand down, then retry once after guardRetryMs whatever the 2D rate.
      retried = true;
      const why = `${in3D(fps, base)} — retrying once in ${(T.guardRetryMs / 1000).toFixed(1)} s (the page may still have been loading)`;
      api.retrying = why;
      hold(Infinity);
      retryTimer = setTimeout(retry, T.guardRetryMs);
      core.turnOff(st, why); // logs the one "back to 2D: …" line
      core.notify();
      return;
    }
    block(`${in3D(fps, base)}, after one retry — 2D for the rest of this page`);
    core.turnOff(st, api.tripped); // logs the one "back to 2D: …" line
    core.notify();
  }
  function retry() {
    retryTimer = 0;
    if (!api.retrying || api.tripped) return;
    api.retrying = null;
    core.info('frame-rate guard: retrying once');
    hold(0);
    // A render-on-demand page draws nothing by itself: ask each adapter for one frame.
    for (const w of core.tracked) { const o = w.deref(); if (o) core.wake(o); }
    core.notify();
  }
  function block(why) {
    api.tripped = why;
    api.retrying = null;
    clearTimeout(retryTimer); retryTimer = 0;
    hold(Infinity);
    core.standDownForGood();
  }

  return api;
}

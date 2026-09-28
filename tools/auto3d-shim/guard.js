// DisplayXR auto-3D — frame-rate guard. PROTOTYPE, not a product.
//
// `function dxrGuard(core)`, a part of the core bundle (build.mjs). A page that cannot afford the
// conversion (two eye draws, the replay, the weave) goes back to 2D for the rest of the document
// instead of stuttering in 3D. Hooks the core calls:
//   draw(st, t)   every page draw while NOT converted (the top of considerActivation): the 2D baseline,
//                 and the re-measure after a trip with no baseline
//   onFlip(st)    the layer was just created: freeze the baseline, reset the window
//   tick(st, t)   once per session frame, after the cover tick: sample, maybe trip
//   tripped       null, or why the guard stood this document down for good (statusOf -> 'guard')
//   measuring     null, or why the guard is re-measuring the page's 2D rate (statusOf -> 'converting';
//                 considerActivation waits)
//
// Baseline: the page's own 2D rate, from the last 60 draws before the flip. Only intervals of at most
// 250 ms count, and at least 20 of them are needed: a render-on-demand page (draws on input), or one
// that went live on its first qualifying draw (most pages), has no baseline. Sampling: session-frame
// intervals, from 1 s after the fade-in finished (rampK 1, no ramp, no cover); intervals over 250 ms
// and hidden-page time are excluded, and a visibilitychange starts over. Trip: the mean rate over the
// last T.guardMs is below T.guardFps AND, when there is a baseline, below 0.8 × baseline (a page that
// runs at 30 fps in 2D is not the conversion's fault).
//
// On a trip WITH a baseline, or on the second trip in a document: core.turnOff (fade to flat ->
// out-cover -> staged stand), no retry in this document, report 'guard', nothing saved.
//
// On a first trip with NO baseline the guard cannot tell a slow conversion from a slow page, so it
// finds out (P0.1): the same turn-off, then it measures the page's OWN 2D rate for REMEASURE_MS (the
// considerActivation timestamps keep coming while the page draws in 2D; report 'converting'). If the
// page runs below T.guardFps in 2D too, the trip was void: ONE retry, whose flip has that 2D run as
// its baseline. If it runs faster in 2D (the conversion's fault), or draws too little to measure (a
// render-on-demand page: the per-frame replay is our cost), the guard blocks for good ('guard').
function dxrGuard(core) {
  const T = core.T;
  const RING = 60, MAX_DT = 250, MIN_BASE = 20, ARM_MS = 1000;
  const REMEASURE_MS = 2000, MIN_REMEASURE = 5; // intervals the re-measure needs to be a rate at all
  const g = new WeakMap(); // st -> { ring[], base, readyAt, last, dts[], sum }
  const of = (st) => { let s = g.get(st); if (!s) g.set(st, (s = { ring: [], base: 0, readyAt: 0, last: 0, dts: [], sum: 0 })); return s; };
  const resetWindow = (s) => { s.readyAt = 0; s.last = 0; s.dts.length = 0; s.sum = 0; };
  const api = { tripped: null, measuring: null };
  let retried = false; // the one retry this document gets
  let M = null;        // the re-measure: { st, t0, timer }

  // A hidden page runs no frames (or throttled ones): whatever was measured around it is not the
  // conversion's cost. Start over, 2D ring included (a re-measure too).
  document.addEventListener('visibilitychange', () => {
    for (const w of core.tracked) { const st = w.deref(); const s = st && g.get(st); if (s) { resetWindow(s); s.ring.length = 0; } }
    if (M) M.t0 = 0;
  });

  // The page's 2D rate over a ring of draw times: { n intervals, fps }.
  const rateOf = (ring) => {
    let n = 0, sum = 0;
    for (let i = 1; i < ring.length; i++) { const dt = ring[i] - ring[i - 1]; if (dt > 0 && dt <= MAX_DT) { n++; sum += dt; } }
    return { n, fps: n ? (1000 * n) / sum : 0 };
  };

  api.draw = (st, t) => {
    if (st.active) return;
    const s = of(st), r = s.ring;
    const mine = !!M && M.st === st;
    if (mine) {
      if (st.releasing || document.hidden) return; // the staged stand is still drawing its mono frame
      if (!M.t0) { M.t0 = t; r.length = 0; }
    }
    r.push(t);
    if (r.length > RING) r.shift();
    if (mine && t - M.t0 >= REMEASURE_MS) decide();
  };

  api.onFlip = (st) => {
    const s = of(st);
    const r = rateOf(s.ring);
    s.base = r.n >= MIN_BASE ? r.fps : 0;
    s.ring.length = 0;
    resetWindow(s);
  };

  api.tick = (st, t) => {
    if (api.tripped || M) return;
    const s = of(st);
    const settled = st.active && !st.cover && !st.ramp && !st.releasing && !st.offTok && core.rampK(st) === 1;
    if (!settled || document.hidden) { resetWindow(s); return; }
    if (!s.readyAt) s.readyAt = t;
    const prev = s.last;
    s.last = t;
    if (t - s.readyAt < ARM_MS || !prev) return;
    const dt = t - prev;
    if (!(dt > 0) || dt > MAX_DT) return; // a hitch (GC, tab switch, debugger) is not a rate
    s.dts.push(dt); s.sum += dt;
    if (s.sum < T.guardMs) return;
    const fps = (1000 * s.dts.length) / s.sum;
    if (fps < T.guardFps && (!s.base || fps < 0.8 * s.base)) { trip(st, fps, s.base); return; }
    while (s.dts.length && s.sum - s.dts[0] >= T.guardMs) s.sum -= s.dts.shift();
  };

  const in3D = (fps) => `frame-rate guard: ${fps.toFixed(1)} fps in 3D over ${(T.guardMs / 1000).toFixed(1)} s`;
  function trip(st, fps, base) {
    if (!base && !retried) {
      // No baseline: stand down, then measure what the page does in 2D on its own.
      const why = `${in3D(fps)} (no 2D baseline) — measuring the page's own 2D rate`;
      api.measuring = why;
      M = { st, t0: 0, timer: 0 };
      of(st).ring.length = 0;
      for (const w of core.tracked) { const o = w.deref(); if (o) o.nextTry = Infinity; }
      // A page that stops drawing in 2D never reaches draw(): decide on a timer too (it then blocks).
      M.timer = setTimeout(decide, T.rampMs + T.releaseMaxMs + REMEASURE_MS + 1500);
      core.turnOff(st, why); // logs the one "back to 2D: …" line
      core.notify();
      return;
    }
    block(in3D(fps) + (base ? ` (2D ran at ${base.toFixed(1)})` : ' (no 2D baseline)') + (retried ? ', after one retry' : '') + ' — 2D for the rest of this page');
    core.turnOff(st, api.tripped); // logs the one "back to 2D: …" line
    core.notify();
  }
  function block(why) {
    api.tripped = why;
    api.measuring = null;
    for (const w of core.tracked) { const o = w.deref(); if (o) o.nextTry = Infinity; }
    core.standDownForGood();
  }
  // The end of a re-measure (REMEASURE_MS of 2D draws, or the timer).
  function decide() {
    if (!M) return;
    const { st, timer } = M;
    M = null;
    clearTimeout(timer);
    const r = rateOf(of(st).ring);
    if (r.n >= MIN_REMEASURE && r.fps < T.guardFps) {
      // The page is that slow on its own: not the conversion's fault. One retry; its flip takes the
      // 2D run just measured as the baseline, so a second trip is judged against it.
      retried = true;
      api.measuring = null;
      core.info(`frame-rate guard: the page runs at ${r.fps.toFixed(1)} fps in 2D too — not the conversion's cost; retrying once with that baseline`);
      for (const w of core.tracked) { const o = w.deref(); if (o) { o.nextTry = 0; o.tries = 0; } }
      core.notify();
      return;
    }
    block(r.n >= MIN_REMEASURE
      ? `frame-rate guard: 3D ran below ${T.guardFps} fps where the page runs at ${r.fps.toFixed(1)} fps in 2D — 2D for the rest of this page`
      : `frame-rate guard: 3D ran below ${T.guardFps} fps and the page draws too little in 2D to compare (${r.n} intervals in ${(REMEASURE_MS / 1000).toFixed(1)} s) — 2D for the rest of this page`);
    core.info(api.tripped);
    core.notify();
  }

  return api;
}

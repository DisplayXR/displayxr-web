// Coexistence with the browser's "Convert to 3D" (lift), v0.5.6. Two DOM contracts (core.js,
// "coexistence with Convert to 3D"):
//   OUT  data-dxr-auto3d="live" on the converted canvas, from the claim (before the store becomes
//        side-by-side) until the store is mono again and the layer is released, on every exit path;
//   IN   a canvas carrying a lift marker (core.js LIFT_MARKERS: dxr-lift), itself or
//        on an ancestor, is never converted; lifted while live -> back to 2D the normal way.
// Dev bundle (env.NEW) behind env.MARKS, the page-side recorder (run.mjs): every marker / width
// mutation a page's own MutationObserver sees, and whether the marker was on at each report.

const W8 = { timeout: 30000, polling: 100 };
const settled = `(() => { const s = window.__dxrAuto3D && window.__dxrAuto3D.state(); const r = s && s.renderers.find((x) => x.active);
  return !!(r && r.stats.twoView > 90 && r.rampK === 1 && !r.ramping); })()`;
const released = `(() => { const s = window.__dxrAuto3D.state(); const r = s.renderers.find((x) => x.canvas.startsWith('canvas'));
  const L = window.__fakeXR.layers; return !!(r && !r.active && !r.releasing && !r.pending && L.length && L[L.length - 1].closedAt !== null); })()`;
const hotkey = async (page, code) => {
  await page.keyboard.down('Control'); await page.keyboard.down('Alt'); await page.keyboard.press(code);
  await page.keyboard.up('Alt'); await page.keyboard.up('Control');
};
const markerOn = () => { const c = document.querySelector('canvas:not([data-dxr-auto3d-cover])'); return c ? c.getAttribute('data-dxr-auto3d') : 'no canvas'; };
const readAll = () => ({
  mk: window.__mk, reports: (window.__dxrAuto3DReports || []).map(({ status, reason, marker }) => ({ status, reason, marker })),
  sessions: window.__fakeXR.sessions.map((s) => ({ mode: s.mode, at: s.at })), layers: window.__fakeXR.layers.length, closes: window.__fakeXR.closes,
  state: window.__dxrAuto3D ? window.__dxrAuto3D.state() : null, marker: (() => { const c = document.querySelector('canvas:not([data-dxr-auto3d-cover])'); return c ? c.getAttribute('data-dxr-auto3d') : 'no canvas'; })(),
});
// The test's stand-in for Convert to 3D: tag the canvas (or its parent) as soon as it is inserted,
// before any draw can reach the shim. `who` 'self' | 'parent'.
const liftTag = (who, name) => `(() => {
  const tag = (c) => { const e = ${who === 'parent' ? 'c.parentElement' : 'c'}; if (e) e.setAttribute(${JSON.stringify(name)}, 'auto'); };
  new MutationObserver((recs) => { for (const r of recs) for (const n of r.addedNodes) if (n.tagName === 'CANVAS' && !n.hasAttribute('data-dxr-auto3d-cover')) tag(n); })
    .observe(document, { childList: true, subtree: true });
})();`;

// The marker's set / remove records (old value null = set, 'live' = removed), in order.
function markerSeq(mk) { return (mk ? mk.recs : []).filter((r) => r.a === 'data-dxr-auto3d').map((r) => (r.old === null ? 'set' : 'rm')); }
// Every width write to / from the side-by-side store width `sbs` lies inside a marker window.
function sbsInsideMarker(mk, sbs) {
  const recs = mk ? mk.recs : [];
  const widths = recs.map((r, i) => ({ r, i })).filter((x) => x.r.a === 'width');
  let on = false; const inside = new Map();
  recs.forEach((r, i) => { if (r.a === 'data-dxr-auto3d') on = r.old === null; else inside.set(i, on); });
  let touched = 0; const bad = [];
  widths.forEach((x, k) => {
    const newV = k + 1 < widths.length ? widths[k + 1].r.old : null; // the last one's new value: unknown (not needed)
    if (String(x.r.old) === String(sbs) || String(newV) === String(sbs)) { touched++; if (!inside.get(x.i)) bad.push(`#${x.i} ${x.r.old}->${newV}`); }
  });
  return { touched, bad };
}

export default function cases({ P, NEW, MARKS, productShim }) {
  const DEV = [MARKS, ...NEW];
  const liveCase = (id, engine, url, exitThird) => ({
    id, name: `marker (${engine}): data-dxr-auto3d="live" while converted; gone after user off, and after ${exitThird}; one set + one remove per conversion`,
    url: P + url, shim: DEV,
    async run(page, h) {
      await page.waitForFunction(settled, W8);
      const A = await page.evaluate(markerOn);
      const sbs = await page.evaluate(() => window.__dxrAuto3D.state().renderers.find((x) => x.active).real[0]);
      await hotkey(page, 'Digit3'); // user off: fade, out-cover, staged stand, release
      await page.waitForFunction(released, { timeout: 8000, polling: 50 });
      const B = await page.evaluate(markerOn);
      await hotkey(page, 'Digit3'); // on again: wake, 3D again
      await page.waitForFunction(settled, W8);
      const C = await page.evaluate(markerOn);
      let D;
      if (exitThird === 'pagehide') {
        // The core's pagehide listener releases at once (immediate stand): read in the SAME task.
        // A synthetic pagehide does not unload, so the page converts again on its next draw: the
        // sequence is read up to the event (the recorder flushed synchronously right after it).
        D = await page.evaluate(() => { window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })); window.__mk.flush(); const c = document.querySelector('canvas:not([data-dxr-auto3d-cover])'); return { m: c.getAttribute('data-dxr-auto3d'), active: window.__dxrAuto3D.state().renderers.some((x) => x.active), n: window.__mk.recs.length }; });
      } else {
        // The page asks for inline-3d itself: stand-down for good, immediate release.
        await page.evaluate(() => { navigator.xr.requestSession('inline-3d').catch(() => {}); });
        await page.waitForFunction(() => { const s = window.__dxrAuto3D.state(); return !!s.foreign && !s.renderers.some((x) => x.active || x.releasing); }, { timeout: 5000, polling: 50 });
        D = { m: await page.evaluate(markerOn), active: false };
      }
      await h.sleep(300);
      return { A, B, C, D, sbs, out: await page.evaluate(readAll) };
    },
    check(r, t) {
      t('live: the canvas carries data-dxr-auto3d="live"', r.ok && r.A === 'live', r.error || `marker ${r.A}`);
      if (!r.out) return;
      t('user off (Ctrl+Alt+3), layer released: marker gone', r.B === null, `marker ${r.B}`);
      t('on again, live: marker back', r.C === 'live', `marker ${r.C}`);
      t(`${exitThird}: marker gone${exitThird === 'pagehide' ? ' in the same task as the event' : ''}, nothing active`, r.D && r.D.m === null && !r.D.active, JSON.stringify(r.D));
      const seq = markerSeq(r.D && r.D.n ? { recs: r.out.mk.recs.slice(0, r.D.n) } : r.out.mk);
      t('the page saw exactly set, remove, set, remove (no repeated writes, no loop)', seq.join(',') === 'set,rm,set,rm', seq.join(',') || 'none');
      const conv = r.out.reports.filter((x) => x.status === 'converting' || x.status === 'live');
      t('every converting / live report was made with the marker on', conv.length >= 2 && conv.every((x) => x.marker), r.out.reports.map((x) => `${x.status}${x.marker ? '*' : ''}`).join(' -> '));
      if (exitThird !== 'pagehide') {
        const sd = r.out.reports.filter((x) => x.status === 'standdown');
        t('the stand-down report is made with the marker already gone', sd.length >= 1 && sd.every((x) => !x.marker), JSON.stringify(sd));
      }
    },
  });

  const liftedCase = (id, engine, url, who, name) => ({
    id, name: `lift (${engine}): a canvas whose ${who === 'self' ? 'element' : 'parent'} carries [${name}] before load is never converted; page untouched; report standdown/lifted`,
    url: P + url, shim: [liftTag(who, name), ...DEV],
    async run(page, h) {
      await page.waitForFunction(() => window.__dxrAuto3D && window.__dxrAuto3D.state().renderers.length > 0, W8);
      await h.sleep(4000); // un-lifted, these pages are live in ~1-2 s
      return { out: await page.evaluate(readAll) };
    },
    check(r, t) {
      const O = r.out;
      t('engine found', r.ok && O && O.state && O.state.renderers.length >= 1, r.error || '');
      if (!O || !O.state) return;
      t(`the canvas is marked lifted in state() ([${name}])`, O.state.renderers.some((x) => x.lifted === name), JSON.stringify(O.state.renderers.map((x) => x.lifted)));
      t('never converted: no session, no layer, no cover, nothing active', O.sessions.length === 0 && O.layers === 0 && O.mk.covers === 0 && !O.state.renderers.some((x) => x.active || x.pending),
        `sessions ${O.sessions.length}, layers ${O.layers}, covers ${O.mk.covers}`);
      t('no marker ever written, no store write while lifted', markerSeq(O.mk).length === 0 && O.marker === null, `marker records ${markerSeq(O.mk).join(',')}, marker ${O.marker}`);
      const lines = r.log.filter((l) => /element is lifted \(Convert to 3D/.test(l));
      t('ONE console line: "not converting …: element is lifted (Convert to 3D …)"', lines.length === 1 && /not converting/.test(lines[0]), lines.join(' | ') || 'none');
      const st = O.reports.map((x) => x.status);
      t('reports: never converting / live; the last is standdown (reason lifted)', !st.includes('converting') && !st.includes('live') && O.reports.length && O.reports[O.reports.length - 1].status === 'standdown' && O.reports[O.reports.length - 1].reason === 'lifted',
        O.reports.map((x) => `${x.status}${x.reason ? '(' + x.reason + ')' : ''}`).join(' -> '));
    },
  });

  const liftLiveCase = (id, engine, url, who, name) => ({
    id, name: `lift (${engine}): [${name}] added on the ${who === 'self' ? 'canvas' : 'parent'} while live -> back to 2D the normal way (fade, out-cover, staged release), marker removed, no retry`,
    url: P + url, shim: DEV, commits: true,
    async run(page, h) {
      await page.waitForFunction(settled, W8);
      const A = await page.evaluate(markerOn);
      const t0 = await page.evaluate(({ who, name }) => { const c = document.querySelector('canvas:not([data-dxr-auto3d-cover])'); (who === 'self' ? c : c.parentElement).setAttribute(name, 'auto'); return performance.now(); }, { who, name });
      await page.waitForFunction(released, { timeout: 6000, polling: 50 });
      const ms = await page.evaluate((t) => performance.now() - t, t0);
      await h.sleep(3000); // and it stays 2D
      return { A, ms, out: await page.evaluate(readAll) };
    },
    check(r, t, h) {
      t('live first, with the marker', r.ok && r.A === 'live', r.error || `marker ${r.A}`);
      const O = r.out;
      if (!O) return;
      t(`back to 2D within 3 s of the lift attribute (${Math.round(r.ms)} ms)`, r.ms < 3000, `${Math.round(r.ms)} ms`);
      t('marker gone; set once, removed once', O.marker === null && markerSeq(O.mk).join(',') === 'set,rm', `marker ${O.marker}, records ${markerSeq(O.mk).join(',')}`);
      const rmAt = O.mk.recs.filter((x) => x.a === 'data-dxr-auto3d' && x.old !== null).map((x) => x.t)[0];
      t('the marker went after the layer was closed', O.closes.length === 1 && rmAt >= O.closes[0].at, `close ${O.closes[0] && O.closes[0].at.toFixed(0)}, marker removed ${rmAt && rmAt.toFixed(0)}`);
      t('no retry: one session, still one 3 s later', O.sessions.length === 1 && O.layers === 1, `sessions ${O.sessions.length}, layers ${O.layers}`);
      t('the normal 3D->2D path: the staged release line, then the out-cover', r.log.some((l) => /back to 2D: the element was lifted \(Convert to 3D\)/.test(l)) && r.log.some((l) => /layer released \d+ ms after the stand \(mono frame drawn first\)/.test(l)) && O.mk.covers >= 2,
        `covers ${O.mk.covers}; ` + r.log.filter((l) => /back to 2D|layer released/.test(l)).join(' | '));
      const rp = O.closes[0] ? h.rawPairAtClose(O.closes[0]) : null;
      t('no raw side-by-side frame once the layer is closed (commit model)', rp && rp.frames >= 3 && rp.discriminates && rp.bad.length === 0,
        rp ? `${rp.frames} frames; pair ${rp.pairBase.toFixed(2)}, mono ${rp.monoBase.toFixed(2)}; raw [${rp.bad.map((b) => b.i).join(', ')}]` : 'no close');
      const last = O.reports[O.reports.length - 1];
      t('the last report is standdown (reason lifted), made with the marker gone', last && last.status === 'standdown' && last.reason === 'lifted' && !last.marker, JSON.stringify(last));
      t('state(): lifted, not active', O.state.renderers.some((x) => x.lifted === name && !x.active), JSON.stringify(O.state.renderers.map((x) => ({ lifted: x.lifted, active: x.active }))));
    },
  });

  return [
    {
      id: 'm-order', name: 'marker (three.js, a 640-wide mono store -> 1280 SBS): set BEFORE the first SBS store write and removed AFTER the last one; on through converting',
      url: P + 'three-keyframes.html?pr=0.5', shim: DEV,
      async run(page, h) {
        await page.waitForFunction(settled, W8);
        const sbs = await page.evaluate(() => window.__dxrAuto3D.state().renderers.find((x) => x.active).real[0]);
        await hotkey(page, 'Digit3');
        await page.waitForFunction(released, { timeout: 8000, polling: 50 });
        await h.sleep(300);
        return { sbs, out: await page.evaluate(readAll) };
      },
      check(r, t) {
        const O = r.out;
        t('converted to a 1280-wide SBS store from a 640-wide mono one', r.ok && r.sbs === 1280, r.error || `sbs ${r.sbs}`);
        if (!O) return;
        const s = sbsInsideMarker(O.mk, r.sbs);
        t('every store write to / from the SBS width happened with the marker on (set before the resize, removed after the mono one)', s.touched >= 2 && s.bad.length === 0, `${s.touched} SBS writes; outside: ${s.bad.join(', ') || 'none'}`);
        t('set, remove: once each', markerSeq(O.mk).join(',') === 'set,rm', markerSeq(O.mk).join(','));
        const conv = O.reports.filter((x) => x.status === 'converting');
        t('the marker was already on at the first converting report (before the store became SBS)', conv.length >= 1 && conv.every((x) => x.marker), O.reports.map((x) => `${x.status}${x.marker ? '*' : ''}`).join(' -> '));
        t('marker gone at the end', O.marker === null, `marker ${O.marker}`);
      },
    },
    liveCase('m-three', 'three.js', 'three-keyframes.html', 'the page requests inline-3d'),
    liveCase('m-pc', 'PlayCanvas', 'pc-mesh.html', 'pagehide'),
    liftedCase('m-lifted-three', 'three.js', 'three-keyframes.html', 'self', 'dxr-lift'),
    liftedCase('m-lifted-pc', 'PlayCanvas', 'pc-mesh.html', 'parent', 'dxr-lift'),
    {
      id: 'm-lifted-offer', name: 'lift (three.js, product host, offer): a lifted canvas is never offered (no offer pill to click), report standdown/lifted',
      url: P + 'three-keyframes.html', shim: [liftTag('self', 'dxr-lift'), ...productShim({ decision: 'offer', dev: true })],
      async run(page, h) {
        await page.waitForFunction(() => window.__dxrAuto3D && window.__dxrAuto3D.state().renderers.length > 0, W8);
        await h.sleep(3000);
        return { out: await page.evaluate(() => ({ reports: window.__dxrFakeHost.reports.map(({ status, reason }) => ({ status, reason })), chip: window.__dxrAuto3D.chip().state, sessions: window.__fakeXR.sessions.length })) };
      },
      check(r, t) {
        const O = r.out;
        t('no session', r.ok && O && O.sessions === 0, r.error || JSON.stringify(O));
        if (!O) return;
        const last = O.reports[O.reports.length - 1];
        t('the last report is standdown (reason lifted)', last && last.status === 'standdown' && last.reason === 'lifted', O.reports.map((x) => x.status + (x.reason ? `(${x.reason})` : '')).join(' -> '));
        t('the chip is not offering 3D on it', O.chip !== 'offer', `chip ${O.chip}`);
      },
    },
    liftLiveCase('m-lift-live-three', 'three.js', 'three-keyframes.html', 'self', 'dxr-lift'),
    liftLiveCase('m-lift-live-pc', 'PlayCanvas', 'pc-mesh.html', 'parent', 'dxr-lift'),
  ];
}

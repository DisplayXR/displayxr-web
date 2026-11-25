// Product-mode cases: the page gets what the browser injects (fake-host.js evaluating the built
// sentinel + core), no dev surface. They assert through window.__dxrFakeHost (loadCore calls,
// cap.save / cap.report records) and window.__fakeXR, never through window.__dxrAuto3D.
const read = () => {
  const H = window.__dxrFakeHost || null;
  const syms = Object.getOwnPropertySymbols(window).map((s) => Symbol.keyFor(s)).filter(Boolean);
  return {
    host: H && { loadCore: H.loadCore, saves: H.saves, reports: H.reports.map(({ status, engine, reason }) => ({ status, engine, reason })) },
    devSurface: typeof window.__dxrAuto3D, devReports: typeof window.__dxrAuto3DReports,
    hud: !!document.querySelector('[data-dxr-auto3d-hud]'),
    marker: window[Symbol.for('dxr.auto3d')], markerEnumerable: Object.prototype.propertyIsEnumerable.call(window, Symbol.for('dxr.auto3d')),
    syms, fake: { sessions: window.__fakeXR.sessions.length, layers: window.__fakeXR.layers.length },
  };
};
const liveAnd = (extra) => `(() => { const H = window.__dxrFakeHost; return !!(window.__frozen && ${extra} && window.__fakeXR.frames > 90); })()`;

export default function cases({ P, NEW, productShim }) {
  return [
    {
      id: 'p-smoke', name: 'product mode (fake host): three.js keyframes goes live; no dev surface; the page\'s test config is ignored',
      url: P + 'three-keyframes.html', shim: productShim({ decision: 'allow' }), cfg: { enabled: false, noLayer: true, holdMs: 1 },
      async run(page, h) {
        await page.waitForFunction(liveAnd("H && H.reports.some((r) => r.status === 'live')"), { timeout: 30000, polling: 100 });
        await h.sleep(300);
        return { P: await page.evaluate(read) };
      },
      check(r, t) {
        const X = r.P, H = X && X.host;
        t('went live', r.ok && H && H.reports.some((x) => x.status === 'live' && x.engine === 'three.js'), r.error || JSON.stringify(H && H.reports));
        t('cap.loadCore() called exactly once', H && H.loadCore === 1, `loadCore ${H && H.loadCore}`);
        const seq = H ? H.reports.map((x) => `${x.status}|${x.engine || ''}|${x.reason || ''}`) : [];
        t('reports are transitions only, converting before live', seq.length && seq.every((k, i) => i === 0 || k !== seq[i - 1]) && seq.findIndex((k) => k.startsWith('converting')) < seq.findIndex((k) => k.startsWith('live')), seq.join(' -> '));
        t('nothing saved', H && H.saves.length === 0, JSON.stringify(H && H.saves));
        t('no dev surface (no window.__dxrAuto3D, no HUD, no report log)', X && X.devSurface === 'undefined' && !X.hud && X.devReports === 'undefined', `__dxrAuto3D ${X && X.devSurface}, hud ${X && X.hud}, reports ${X && X.devReports}`);
        t('window.__dxrAuto3DTestCfg ignored outside dev (enabled:false / noLayer did not apply)', X && X.fake.layers === 1 && X.fake.sessions === 1, `sessions ${X && X.fake.sessions}, layers ${X && X.fake.layers}`);
        t('the only symbol on window is the value-only marker', X && X.marker === true && !X.markerEnumerable && X.syms.length === 1 && X.syms[0] === 'dxr.auto3d', `marker ${X && X.marker}, symbols ${X && JSON.stringify(X.syms)}`);
      },
    },
    {
      // A USER block outside dev: the sentinel stays detect-only and never loads the core; once it
      // detects the engine it reports { status: 'off', engine } once (the browser's re-enable offer).
      id: 'p-block', name: 'product mode, the user blocked the site: the core is never loaded, no session',
      url: P + 'three-keyframes.html', shim: productShim({ decision: 'block' }),
      async run(page, h) {
        await page.waitForFunction('window.__frozen', { timeout: 30000, polling: 100 });
        await h.sleep(1500);
        return { P: await page.evaluate(read) };
      },
      check(r, t) {
        const X = r.P, H = X && X.host;
        t('cap.loadCore() never called', r.ok && H && H.loadCore === 0, r.error || `loadCore ${H && H.loadCore}`);
        t('no session, no layer', X && X.fake.sessions === 0 && X.fake.layers === 0, JSON.stringify(X && X.fake));
        t('exactly one report: { status: off, engine: three.js }', H && H.reports.length === 1 && H.reports[0].status === 'off' && H.reports[0].engine === 'three.js', JSON.stringify(H && H.reports));
      },
    },
    {
      id: 'p-double', name: 'double injection: product injector first, then the dev extension — the first injector wins',
      url: P + 'three-keyframes.html', shim: [...productShim({ decision: 'allow' }), ...NEW],
      async run(page, h) {
        await page.waitForFunction(liveAnd("H && H.reports.some((r) => r.status === 'live')"), { timeout: 30000, polling: 100 });
        await h.sleep(300);
        return { P: await page.evaluate(read) };
      },
      check(r, t) {
        const X = r.P, H = X && X.host;
        t('product went live, core loaded once', r.ok && H && H.loadCore === 1, r.error || `loadCore ${H && H.loadCore}`);
        t('the dev bundle stayed inert (no __dxrAuto3D, no HUD)', X && X.devSurface === 'undefined' && !X.hud, `__dxrAuto3D ${X && X.devSurface}`);
        t('one session, one layer', X && X.fake.sessions === 1 && X.fake.layers === 1, JSON.stringify(X && X.fake));
      },
    },
    {
      id: 'p-double-dev', name: 'double injection: the dev extension first, then the product injector — the dev bundle wins',
      url: P + 'three-keyframes.html', shim: [...NEW, ...productShim({ decision: 'allow' })],
      async run(page, h) {
        await page.waitForFunction(liveAnd("window.__dxrAuto3D && window.__dxrAuto3D.state().renderers.some((x) => x.active)"), { timeout: 30000, polling: 100 });
        await h.sleep(300);
        return { P: await page.evaluate(read) };
      },
      check(r, t) {
        const X = r.P, H = X && X.host;
        t('dev bundle live', r.ok && X && X.devSurface === 'object', r.error || `__dxrAuto3D ${X && X.devSurface}`);
        t('the product injector never loaded its core', H && H.loadCore === 0 && H.reports.length === 0, `loadCore ${H && H.loadCore}, reports ${H && H.reports.length}`);
        t('one session, one layer', X && X.fake.sessions === 1 && X.fake.layers === 1, JSON.stringify(X && X.fake));
      },
    },
  ];
}

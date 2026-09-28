// TEST ONLY — a fake browser host for PRODUCT-mode cases. Injected in the page's main world at
// document start, after fake-xr.js, in place of the dev bundle. It does what the browser's injector
// does: evaluates dist/auto3d-sentinel.js (an expression) with an indirect eval, and calls the result
// with a frozen cfg and a capability object whose loadCore() evaluates dist/auto3d-core.js on demand.
//
// Inputs (set by run.mjs's productShim() just before this script):
//   window.__dxrFakeHostSrc  { sentinel, core }  the two built texts (deleted once read)
//   window.__dxrFakeHostCfg  host data for this frame: { decision, depths, rig, convScale, dev,
//                            engines, test } — defaults: allow, 0.3 / 1.0, camera, 1, false, both, null
// Output, for the case's assertions: window.__dxrFakeHost
//   loadCore   how many times the sentinel called cap.loadCore()
//   coreEvalMs time spent evaluating the core text (0 while not loaded)
//   saves[]    every cap.save(partial), deep-copied
//   reports[]  every cap.report(r), with t = performance.now()
// (A real host keeps all of this out of the page; the recorder is on window only for the harness.)
(() => {
  const src = window.__dxrFakeHostSrc;
  const o = window.__dxrFakeHostCfg || {};
  try { delete window.__dxrFakeHostSrc; delete window.__dxrFakeHostCfg; } catch (e) { /* ignore */ }
  if (!src) return;
  const H = (window.__dxrFakeHost = { loadCore: 0, coreEvalMs: 0, saves: [], reports: [] });
  const cfg = Object.freeze({
    decision: o.decision || 'allow',
    depths: Object.freeze({ camera: 0.3, display: 1.0, ...(o.depths || {}) }),
    rig: o.rig || 'camera',
    convScale: typeof o.convScale === 'number' ? o.convScale : 1,
    dev: !!o.dev,
    engines: Object.freeze({ three: true, playcanvas: true, ...(o.engines || {}) }),
    test: o.test || null,
  });
  let core = null;
  const cap = {
    loadCore() {
      H.loadCore++;
      if (!core) { const t0 = performance.now(); core = (0, eval)(src.core); H.coreEvalMs = performance.now() - t0; }
      return core;
    },
    save(p) { H.saves.push(JSON.parse(JSON.stringify(p))); },
    report(r) { H.reports.push({ ...r, t: performance.now() }); },
  };
  const sentinel = (0, eval)(src.sentinel);
  sentinel(cfg, cap);
})();

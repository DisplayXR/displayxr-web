// DisplayXR auto-3D — the DEV host. PROTOTYPE, not a product.
//
// `function dxrDevHost(loadCore)`: stands in for the browser when the scripts run from the dev
// extension (dist/auto3d-dev.js). The browser hands the sentinel a frozen `cfg` and a `cap` backed
// by its content settings; this emulates both on top of the page's own `localStorage` (per frame
// origin), the v0.4 behaviour. Returns { cfg, cap } for dxrSentinel.
//
//   cfg.decision  stored decision, else the v0.3/v0.4 `enabled` flag ('allow' / 'block')
//   cfg.dev       true unless localStorage.dxrAuto3DDev === '0' (then: no HUD, hotkeys, __dxrAuto3D)
//   cfg.test      window.__dxrAuto3DTestCfg (the harness); the core honours it only when dev.
//                 Its site keys (enabled / decision / depths / rig / convScale / hud) are applied
//                 here, as the old loadCfg merged them; the rest is tuning, applied by the core.
//   cfg.hud       dev-only: the HUD's own on/off (Ctrl+Alt+D), saved with the site.
//   cap.save      merges into the stored site object (the old saveCfg, plus `decision`)
//   cap.report    pushes to window.__dxrAuto3DReports, only when dev
function dxrDevHost(loadCore) {
  const LS_KEY = 'dxrAuto3D';
  const V = 1;
  const DEFAULT_DEPTH = { camera: 0.5, display: 1.0 };
  let dev = true;
  try { dev = localStorage.getItem('dxrAuto3DDev') !== '0'; } catch (e) { /* opaque origin */ }
  const rawTest = window.__dxrAuto3DTestCfg; // harness override, never persisted by itself
  const test = dev && rawTest && typeof rawTest === 'object' ? rawTest : null;

  const cur = loadCfg();
  function loadCfg() {
    let stored = {};
    try { stored = JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (e) { /* opaque origin */ }
    const ok = stored.v === V;
    const base = { v: V, enabled: true, convScale: 1, rig: 'camera', hud: true, ...(ok ? stored : {}) };
    // Per-rig depth (v0.4). A v0.3 site stored ONE depth, applied to both rigs; it was tuned on the
    // camera rig (the only rig then worth tuning), so it carries over to the camera rig only.
    const sd = ok ? stored.depths : null;
    base.depths = { ...DEFAULT_DEPTH, ...(sd && typeof sd === 'object' ? sd : {}) };
    if (!sd && ok && typeof stored.depth === 'number') base.depths.camera = stored.depth;
    delete base.depth;
    for (const k of Object.keys(DEFAULT_DEPTH)) if (!(base.depths[k] > 0)) base.depths[k] = DEFAULT_DEPTH[k];
    const known = (d) => d === 'allow' || d === 'offer' || d === 'block';
    base.decision = known(base.decision) ? base.decision : base.enabled ? 'allow' : 'block';
    if (test) {
      if ('enabled' in test) base.decision = test.enabled ? 'allow' : 'block';
      if (known(test.decision)) base.decision = test.decision;
      if (test.depths && typeof test.depths === 'object') base.depths = { ...base.depths, ...test.depths };
      for (const k of ['rig', 'convScale', 'hud']) if (k in test) base[k] = test[k];
    }
    base.enabled = base.decision === 'allow';
    return base;
  }

  const cfg = Object.freeze({
    decision: cur.decision,
    depths: Object.freeze({ ...cur.depths }),
    rig: cur.rig,
    convScale: cur.convScale,
    dev,
    engines: Object.freeze({ three: true, playcanvas: true }),
    test,
    hud: cur.hud !== false,
  });
  const cap = {
    loadCore,
    save(p) {
      if (!p || typeof p !== 'object') return;
      if (p.decision === 'allow' || p.decision === 'block' || p.decision === 'offer') { cur.decision = p.decision; cur.enabled = p.decision === 'allow'; }
      if (p.depths && typeof p.depths === 'object') cur.depths = { ...cur.depths, ...p.depths };
      if (p.rig === 'camera' || p.rig === 'display') cur.rig = p.rig;
      if (typeof p.convScale === 'number') cur.convScale = p.convScale;
      if (typeof p.hud === 'boolean') cur.hud = p.hud;
      try {
        const keep = { v: V, enabled: cur.enabled, depths: { ...cur.depths }, convScale: cur.convScale, rig: cur.rig, hud: cur.hud, decision: cur.decision };
        localStorage.setItem(LS_KEY, JSON.stringify(keep));
      } catch (e) { /* opaque origin */ }
    },
    report(r) {
      if (!dev) return;
      try { (window.__dxrAuto3DReports = window.__dxrAuto3DReports || []).push({ ...r, t: performance.now() }); } catch (e) { /* ignore */ }
    },
  };
  return { cfg, cap };
}

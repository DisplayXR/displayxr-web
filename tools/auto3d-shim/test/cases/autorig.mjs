// v0.7.13: the automatic rig. While the user has not chosen a style for the site (the host passes no
// rig: cfg.rig 'auto' here), the core picks the rig once per activation, when the rig's scale is
// decided: 'display' (Object on the glass) for an object on a turntable (the page's own target, the
// scene not open, no walk hint), 'camera' (Scene camera) for everything else. An open scene that
// latches later moves an automatic display rig back to the camera rig. A user's choice wins.
//
// Every other case runs with rig 'camera' from run.mjs's default config (the rig they were written
// for); these pass rig 'auto' (or a choice) themselves.

// Polls state() until fn(S, R) holds or ms run out; returns the rig, the source and the style lines.
const pollRig = (ms, until) => new Function(`return (async () => {
  const t0 = performance.now(); let S = null, R = null;
  while (performance.now() - t0 < ${ms}) {
    S = window.__dxrAuto3D.state(); R = S.renderers.find((x) => x.active) || null;
    if (R && (${until})) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const rig = window.__fakeXR.lastRig;
  return { rigMode: S && S.rigMode, rigType: rig && rig.type, src: R && R.convergenceSource, via: R && R.convergenceVia, latched: R && R.openLatched, waited: Math.round(performance.now() - t0) };
})();`);

function rigCase(id, name, url, want, why, extra) {
  const until = (extra && extra.until) || `R.rigScale && S.rigMode === ${JSON.stringify(want)}`;
  return {
    id, name, url, expect: 'convert', fovDeg: 40, ready: 'window.__ready || window.__frozen', cfg: { rig: 'auto', ...((extra && extra.cfg) || {}) },
    ...(extra || {}),
    probe: pollRig((extra && extra.ms) || 8000, until),
    check(r, t) {
      t('converted within 60 s', r.ok, `${r.ms} ms`);
      const p = r.probe;
      if (!p) { t('probe read', false, 'no probe'); return; }
      const lines = r.log.filter((l) => /style: /.test(l));
      t(`automatic rig: ${want}, pushed to the layer`, p.rigMode === want && p.rigType === want, JSON.stringify(p));
      const last = lines[lines.length - 1] || '';
      if (why) t(`the console names the reason (${why})`, /automatic: /.test(last) && new RegExp(why).test(last), lines.join(' | ') || 'no style line');
      if (extra && extra.lines) t(`${extra.lines} style line(s)`, lines.length === extra.lines, lines.join(' | ') || 'none');
    },
  };
}

export default function cases({ P, NEW }) {
  const fix = (c) => ({ ...c, shim: NEW, url: P + c.url });
  return [
    // The turntable: an orbit target the camera looks at, a model outside the camera -> display rig.
    rigCase('rig-auto-orbit', 'three.js OrbitControls target (a product on a turntable): automatic display rig', 'three-orbit.html', 'display', 'object on a turntable', { lines: 1 }),
    rigCase('rig-auto-pc-orbit', 'PlayCanvas CameraControls focusPoint: automatic display rig', 'pc-orbit.html', 'display', 'object on a turntable'),
    // No page target (the estimator's object viewer): stays on the author's camera.
    rigCase('rig-auto-estimator', 'model on a floor, no target (the estimator): automatic camera rig', 'three-walk.html?scene=model&cam=still', 'camera', 'no page target'),
    // Open scenes: camera rig, with their fixed focus.
    rigCase('rig-auto-room', 'mesh room, camera inside (surrounded): automatic camera rig', 'three-walk.html?scene=room&cam=still', 'camera', 'open scene|surrounded',
      { until: 'R.openLatched && S.rigMode === "camera"', ms: 12000 }),
    // A walk hint at decision time (FirstPersonControls' lookAt 100 ahead is a target, but the controls say walk).
    rigCase('rig-auto-fpc', 'FirstPersonControls (a lookAt target every frame): the walk hint keeps the camera rig', 'three-walk.html?scene=field&cam=fpc', 'camera', 'walk|open scene', { lines: 1 }),
    // The user's choice wins and nothing is decided automatically.
    rigCase('rig-choice-camera', 'OrbitControls target, but the site chose the camera rig: no automatic rig', 'three-orbit.html', 'camera', null, { cfg: { rig: 'camera' }, lines: 0 }),
    rigCase('rig-choice-display', 'model on a floor (estimator), the site chose the display rig: no automatic rig', 'three-walk.html?scene=model&cam=still', 'display', null, { cfg: { rig: 'display' }, lines: 0 }),
  ].map(fix);
}

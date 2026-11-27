// The automatic rig (v0.7.13) under the STRICT OBJECT TEST and the CORE GLASS (v0.8.0).
//
// While the user has not chosen a style for the site (cfg.rig 'auto' here), the core picks the rig
// once per activation, when the rig's scale is decided:
//   'display' (Object on the glass) ONLY for a simple object that is the point of the page: a fixed
//     target, one compact subject that fits the frame with the camera well outside it, nothing else in
//     the scene but a floor / dome, and no page element over the canvas that follows the 3D scene;
//   'camera' (Scene camera) for everything else. An object-LIKE page that fails only "alone" or
//     "no overlay" keeps the camera rig but takes its focus from the same core glass.
// The core glass: the glass sits where a third of the subject's core surface (area-weighted points,
// the stage left out) is in front, read from the live camera, so it follows a turn and a zoom.
//
// Every other case runs with rig 'camera' from run.mjs's default config; these pass rig 'auto' (or a
// choice) themselves.

const pollRig = (ms, until) => new Function(`return (async () => {
  const t0 = performance.now(); let S = null, R = null;
  while (performance.now() - t0 < ${ms}) {
    S = window.__dxrAuto3D.state(); R = S.renderers.find((x) => x.active) || null;
    if (R && (${until})) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const rig = window.__fakeXR.lastRig;
  return { rigMode: S && S.rigMode, rigType: rig && rig.type, src: R && R.convergenceSource, via: R && R.convergenceVia, latched: R && R.openLatched,
    glass: R && R.glass, verdict: R && R.verdict, overlay: R && R.overlayTracked, conv: R && R.convergence, vdh: rig && rig.virtualDisplayHeight,
    pz: rig && rig.position && rig.position.z, diopters: rig && rig.convergenceDiopters, scale: R && R.rigScale, waited: Math.round(performance.now() - t0) };
})();`);

function rigCase(id, name, url, want, why, extra) {
  const x = extra || {};
  const until = x.until || `R.rigScale && R.verdict && S.rigMode === ${JSON.stringify(want)}`;
  return {
    id, name, url, expect: 'convert', fovDeg: x.fovDeg || 40, ready: 'window.__ready || window.__frozen', ...x, cfg: { rig: 'auto', coreGlass: true, ...(x.cfg || {}) },
    probe: pollRig(x.ms || 10000, until),
    check(r, t) {
      t('converted within 60 s', r.ok, `${r.ms} ms`);
      const p = r.probe;
      if (!p) { t('probe read', false, 'no probe'); return; }
      const lines = r.log.filter((l) => /style: /.test(l));
      t(`rig: ${want}, pushed to the layer`, p.rigMode === want && p.rigType === want, JSON.stringify({ rigMode: p.rigMode, rigType: p.rigType, src: p.src, verdict: p.verdict, scale: p.scale, waited: p.waited }));
      const all = r.log.filter((l) => /style: |object test: /.test(l)).join(' | ');
      if (why) t(`the console names the reason (${why})`, new RegExp(why).test(all), all || 'no line');
      if (x.verdict) t(`object test: object ${x.verdict.object}, object-like ${x.verdict.like}`, p.verdict && p.verdict.object === x.verdict.object && p.verdict.like === x.verdict.like, JSON.stringify(p.verdict));
      if (x.glass === 'display') t('core glass: read from the surface, the portal at it', p.glass && p.glass.d > 0 && Math.abs(-p.pz - p.glass.d) < 1e-3 * p.glass.d, JSON.stringify({ glass: p.glass, conv: p.conv, pz: p.pz, vdh: p.vdh }));
      if (x.glass === 'camera') t('core glass on the camera rig: the convergence is the glass', p.glass && p.glass.d > 0 && Math.abs(1 / p.diopters - p.glass.d) < 1e-3 * p.glass.d, JSON.stringify({ glass: p.glass, conv: p.conv, diopters: p.diopters }));
      if (x.glass === 'none') t('no core glass', !p.glass, JSON.stringify(p.glass));
      if (x.stage) t(`the stage is left out (${x.stage})`, p.glass && new RegExp(x.stage).test(p.glass.note || ''), p.glass ? p.glass.note : 'no glass');
      if (x.front) t('a third of the surface in front: the glass is nearer than the target, by less than the subject', p.glass && p.glass.d < p.conv && p.conv - p.glass.d < 1.0, JSON.stringify({ glass: p.glass && p.glass.d, conv: p.conv }));
      if (x.overlay !== undefined) t(`overlays that follow the scene: ${x.overlay}`, p.overlay === x.overlay, String(p.overlay));
      if (x.lines !== undefined) t(`${x.lines} style line(s)`, lines.length === x.lines, lines.join(' | ') || 'none');
    },
  };
}

export default function cases({ P, NEW }) {
  const fix = (c) => ({ ...c, shim: NEW, url: P + c.url });
  const TT = 'three-turntable.html';
  return [
    // THE positive case: a product on a turntable, a floor and a dome around it.
    rigCase('rig-object', 'product viewer (OrbitControls, autoRotate, floor + dome): a simple object -> display rig, core glass', TT, 'display', 'a simple object',
      { fovDeg: 30, verdict: { object: true, like: true }, glass: 'display', stage: '2 left out as stage \\(0 of them other', front: true, lines: 1 }),
    rigCase('rig-object-still', 'the same, no autoRotate (nothing moves): still a simple object', TT + '?still=1', 'display', 'a simple object', { fovDeg: 30, verdict: { object: true, like: true }, glass: 'display' }),
    rigCase('rig-object-late', 'the same, the subject added 1.5 s after load: decided after it arrives', TT + '?late=1500', 'display', 'a simple object', { fovDeg: 30, verdict: { object: true, like: true }, glass: 'display', ms: 14000 }),
    // Not certain: the camera rig, with the core focus.
    rigCase('rig-hotspot', 'product viewer with a DOM hotspot that follows a 3D point: camera rig, core focus', TT + '?hotspot=1', 'camera', 'follow the 3D scene',
      { fovDeg: 30, glass: 'camera', overlay: true, until: 'R.rigScale && R.overlayTracked && S.rigMode === "camera" && R.glass', ms: 14000 }),
    rigCase('rig-extra', 'product viewer with another prop off the frame: object-like, camera rig, core focus', TT + '?extra=1', 'camera', 'other part',
      { fovDeg: 30, verdict: { object: false, like: true }, glass: 'camera' }),
    // Not an object.
    rigCase('rig-follow', 'the orbit target drifts through the world (a follow camera): not an object', TT + '?follow=1', 'camera', 'target moves', { fovDeg: 30, verdict: { object: false, like: false }, glass: 'none' }),
    rigCase('rig-auto-orbit', 'three.js OrbitControls whose target is off the subject (camera close to the scene): not an object', 'three-orbit.html', 'camera', 'object test: not an object', { glass: 'none' }),
    rigCase('rig-auto-pc-orbit', 'PlayCanvas CameraControls focusPoint off the subject: not an object', 'pc-orbit.html', 'camera', 'object test: not an object', { glass: 'none' }),
    rigCase('rig-auto-estimator', 'model on a floor, NO page target (the estimator), seen from outside: a simple object -> display rig', 'three-walk.html?scene=model&cam=still', 'display', 'an object seen from outside',
      { verdict: { object: true, like: true }, glass: 'display', stage: '1 left out as stage' }),
    rigCase('rig-auto-room', 'mesh room, camera inside (surrounded): camera rig', 'three-walk.html?scene=room&cam=still', 'camera', 'open scene|surrounded', { until: 'R.openLatched && S.rigMode === "camera"', ms: 12000 }),
    rigCase('rig-auto-fpc', 'FirstPersonControls (a lookAt target every frame): camera rig', 'three-walk.html?scene=field&cam=fpc', 'camera', 'walk|open scene', { until: 'R.openLatched && S.rigMode === "camera"' }),
    // The user's choice wins; a chosen display rig still gets the core glass.
    rigCase('rig-choice-camera', 'product viewer, but the site chose the camera rig: no automatic rig', TT, 'camera', null, { fovDeg: 30, cfg: { rig: 'camera' }, lines: 0, until: 'R.rigScale && R.verdict' }),
    rigCase('rig-choice-display', 'model on a floor (estimator), the site chose the display rig: no automatic rig, core glass', 'three-walk.html?scene=model&cam=still', 'display', null,
      { cfg: { rig: 'display' }, lines: 0, glass: 'display', stage: '1 left out as stage', until: 'R.rigScale && R.glass' }),
    // A/B: the 0.7.13 rule.
    rigCase('rig-loose', 'A/B strictObject false: any page target is an object (0.7.13)', 'three-orbit.html', 'display', 'object on a turntable', { cfg: { strictObject: false }, until: 'R.rigScale && S.rigMode === "display"' }),
  ].map(fix);
}

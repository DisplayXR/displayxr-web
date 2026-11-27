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
    store: R && R.real, box: [document.querySelector('canvas').clientWidth * devicePixelRatio, document.querySelector('canvas').clientHeight * devicePixelRatio],
    glass: R && R.glass, verdict: R && R.verdict, overlay: R && R.overlayTracked, conv: R && R.convergence, vdh: rig && rig.virtualDisplayHeight,
    pz: rig && rig.position && rig.position.z, diopters: rig && rig.convergenceDiopters, scale: R && R.rigScale, waited: Math.round(performance.now() - t0) };
})();`);

function rigCase(id, name, url, want, why, extra) {
  const x = extra || {};
  const until = x.until || `R.rigScale && R.verdict && S.rigMode === ${JSON.stringify(want)}`;
  return {
    id, name, url, expect: 'convert', fovDeg: x.fovDeg || 40, ready: 'window.__ready || window.__frozen', ...x, cfg: { rig: 'auto', coreGlass: true, eyeScale: 1, ...(x.cfg || {}) },
    probe: pollRig(x.ms || 10000, until),
    check(r, t) {
      t('converted within 60 s', r.ok, `${r.ms} ms`);
      const p = r.probe;
      if (!p) { t('probe read', false, 'no probe'); return; }
      const lines = r.log.filter((l) => /style: /.test(l));
      t(`rig: ${want}, pushed to the layer`, p.rigMode === want && p.rigType === want, JSON.stringify({ rigMode: p.rigMode, rigType: p.rigType, src: p.src, verdict: p.verdict, scale: p.scale, waited: p.waited }));
      const all = r.log.filter((l) => /style: |object test: /.test(l)).join(' | ');
      if (why) t(`the console names the reason (${why})`, new RegExp(why).test(all), all || 'no line');
      if (x.store) { const st = p.store || [], k = st[0] && p.box[1] ? (st[0] * p.box[1]) / (st[1] * p.box[0]) : 0; t('the store is 2:1 against the canvas box (the shape the browser joins, browser-pvt#257)', Math.abs(k - 2) < 0.06, `store ${st[0]}x${st[1]} for a ${Math.round(p.box[0])}x${Math.round(p.box[1])} box: ${k.toFixed(3)}`); }
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
      { fovDeg: 30, verdict: { object: true, like: true }, glass: 'display', stage: '2 left out as stage \\(0 of them other', front: true, lines: 1, store: true }),
    rigCase('rig-object-still', 'the same, no autoRotate (nothing moves): still a simple object', TT + '?still=1', 'display', 'a simple object', { fovDeg: 30, verdict: { object: true, like: true }, glass: 'display' }),
    rigCase('rig-object-late', 'the same, the subject added 1.5 s after load: decided after it arrives', TT + '?late=1500', 'display', 'a simple object', { fovDeg: 30, verdict: { object: true, like: true }, glass: 'display', ms: 14000 }),
    // Not certain: the camera rig, with the core focus.
    rigCase('rig-hotspot', 'product viewer with a DOM hotspot that follows a 3D point: camera rig, core focus', TT + '?hotspot=1', 'camera', 'follow the 3D scene',
      { fovDeg: 30, glass: 'camera', overlay: true, until: 'R.rigScale && R.overlayTracked && S.rigMode === "camera" && R.glass', ms: 14000 }),
    rigCase('rig-extra', 'product viewer with another prop off the frame: object-like, camera rig, core focus', TT + '?extra=1', 'camera', 'other part',
      { fovDeg: 30, verdict: { object: false, like: true }, glass: 'camera' }),
    // Not an object.
    rigCase('rig-follow', 'the orbit target drifts through the world (a follow camera): not an object', TT + '?follow=1', 'camera', 'target moves', { fovDeg: 30, verdict: { object: false, like: false }, glass: 'none', ms: 16000 }),
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
    // THE MORPH: a product viewer whose camera pans off the subject at 3.5 s and comes back at 6 s. The
    // rig goes display -> camera -> display with no flat phase: the rig pushed is never at zero depth,
    // and its field of view moves between the display's own and the page's.
    {
      id: 'rig-morph', name: 'product viewer, the camera pans off the subject and comes back: display -> camera -> display by a morph, never flat',
      url: 'three-turntable.html?still=1&panAt=3500&backAt=6000', expect: 'convert', fovDeg: 30, ready: 'window.__ready', cfg: { rig: 'auto', coreGlass: true, eyeScale: 1 },
      probe: new Function(`return (async () => {
        const out = [], t0 = performance.now();
        while (performance.now() - t0 < 9500) {
          const S = window.__dxrAuto3D.state(), R = S.renderers.find((x) => x.active);
          if (R && R.rigNow) out.push({ t: Math.round(performance.now() - t0), mode: S.rigMode, morph: R.morphing, ...R.rigNow, k: R.rampK });
          await new Promise((r) => setTimeout(r, 40));
        }
        return out;
      })();`),
      check(r, t) {
        t('converted within 60 s', r.ok, `${r.ms} ms`);
        const s = r.probe || [];
        const modes = s.map((x) => x.mode).filter((m, i, a) => i === 0 || m !== a[i - 1]);
        t('rig sequence display -> camera -> display', modes.join('>') === 'display>camera>display', modes.join('>'));
        const morphs = s.filter((x) => x.morph);
        t('both changes were morphs (a camera-form rig in flight)', morphs.length >= 6 && morphs.every((x) => x.type === 'camera'), `${morphs.length} morph samples`);
        const depth = (x) => (x.type === 'display' ? x.ipd : x.ipd * (x.m2v || 1));
        const flat = s.filter((x) => !(depth(x) > 0) || (x.k !== undefined && x.k !== null && x.k < 1));
        t('never flat: the eye scale stays above zero and the depth fade is not used', flat.length === 0, flat.length ? JSON.stringify(flat[0]) : 'ok');
        const fovs = morphs.map((x) => (x.vfov * 180) / Math.PI);
        t('in flight the field of view is between the display own and the page 30 deg', fovs.every((f) => f > 5 && f < 30.5), `${Math.min(...fovs).toFixed(1)}..${Math.max(...fovs).toFixed(1)} deg`);
        // Continuity of the camera-form eye scale across the first morph (no step larger than a third of its range).
        const e = morphs.map((x) => x.ipd * x.m2v), steps = e.slice(1).map((v, i) => Math.abs(v - e[i])), range = Math.max(...e) - Math.min(...e);
        t('the eye scale moves in small steps', range > 0 && Math.max(...steps) < 0.5 * range, `range ${range.toPrecision(3)}, largest step ${Math.max(...steps).toPrecision(3)}`);
        const lines = r.log.filter((l) => /object test:|style:/.test(l)).map((l) => l.replace(/^.*dxr-auto3d\] /, '')).join(' | ');
        t('the console tells the story', /no longer an object/.test(lines) && /deciding again/.test(lines), lines);
      },
    },
    // ZOOM: the page dollies its camera to half the distance at 3.5 s. The glass follows the subject (it is
    // read from the live camera), so the portal comes to half the distance and half the height: the
    // subject stays on the glass and is twice as large. (It froze once: a change detector that overflowed.)
    {
      id: 'rig-zoom', name: 'product viewer, the page zooms in (camera to half the distance): the glass follows, the portal halves',
      url: 'three-turntable.html?still=1&zoomAt=3500', expect: 'convert', fovDeg: 30, ready: 'window.__ready', cfg: { rig: 'auto', coreGlass: true, eyeScale: 1 },
      probe: new Function(`return (async () => {
        const read = () => { const S = window.__dxrAuto3D.state(), R = S.renderers.find((x) => x.active); return R && R.glass && R.rigNow ? { mode: S.rigMode, target: R.convergence, glass: R.glass.d, z: R.rigNow.z, vdh: R.rigNow.vdh, zoomed: !!window.__zoomed, verdict: R.verdict } : null; };
        let a = null, b = null; const t0 = performance.now();
        while (performance.now() - t0 < 9000) {
          const r = read();
          if (r && !r.zoomed) a = r;
          if (r && r.zoomed && a) { await new Promise((q) => setTimeout(q, 1200)); b = read(); break; }
          await new Promise((q) => setTimeout(q, 100));
        }
        return { a, b };
      })();`),
      check(r, t) {
        t('converted within 60 s', r.ok, `${r.ms} ms`);
        const { a, b } = r.probe || {};
        if (!a || !b) { t('read before and after the zoom', false, JSON.stringify(r.probe)); return; }
        t('still the display rig, still an object', b.mode === 'display' && b.verdict && b.verdict.object, JSON.stringify({ mode: b.mode, verdict: b.verdict }));
        t('the target distance halved', Math.abs(b.target / a.target - 0.5) < 0.03, `${a.target.toFixed(2)} -> ${b.target.toFixed(2)}`);
        const front = (x) => x.target - x.glass;
        t('the glass followed: it sits the same distance in front of the target as before', Math.abs(front(b) - front(a)) < 0.05 * Math.abs(a.target - a.glass) + 0.02 && Math.abs(-b.z - b.glass) < 1e-3 * b.glass, `in front of the target by ${front(a).toFixed(3)} -> ${front(b).toFixed(3)}; glass ${a.glass.toFixed(2)} -> ${b.glass.toFixed(2)}`);
        t('the virtual display height shrank with it', b.vdh < 0.6 * a.vdh, `${a.vdh.toFixed(3)} -> ${b.vdh.toFixed(3)}`);
      },
    },
    // A/B: the 0.7.13 rule.
    rigCase('rig-loose', 'A/B strictObject false: any page target is an object (0.7.13)', 'three-orbit.html', 'display', 'object on a turntable', { cfg: { strictObject: false }, until: 'R.rigScale && S.rigMode === "display"' }),
  ].map(fix);
}

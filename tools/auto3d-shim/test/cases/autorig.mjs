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
    glass: R && R.glass, verdict: R && R.verdict, overlay: R && R.overlayTracked, conv: R && R.convergence, vdh: rig && rig.virtualDisplayHeight * (R && R.rigNow && R.rigNow.k || 1),
    pz: rig && rig.position && rig.position.z * (R && R.rigNow && R.rigNow.k || 1), diopters: rig && rig.convergenceDiopters, scale: R && R.rigScale, waited: Math.round(performance.now() - t0) };
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
      id: 'rig-morph', name: 'product viewer, the camera pans off the subject and comes back: ONE rig per page, the display rig throughout, nothing decided again',
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
        t('the display rig throughout (one decision per page)', modes.join('>') === 'display', modes.join('>'));
        t('no morph, no fade: the rig is never in flight', s.every((x) => !x.morph && x.type === 'display' && (x.k === undefined || x.k === null || x.k >= 1 || x.t < 3000)), `${s.filter((x) => x.morph).length} morph samples`);
        // The page's pan is a cut (the camera jumps aside and back): the glass is a function of where the
        // camera stands, so the portal takes exactly two heights, one per camera position, with no ease of ours.
        const live = s.filter((x) => x.t > 3000), vd = live.map((x) => x.vdh), lo = Math.min(...vd), hi = Math.max(...vd);
        const mid = vd.filter((v) => v > lo + 0.1 * (hi - lo) && v < hi - 0.1 * (hi - lo));
        t('the portal follows the page camera at once (no ease of ours)', vd.length > 20 && hi > lo && mid.length <= 2, `${lo.toFixed(3)} / ${hi.toFixed(3)}, ${mid.length} sample(s) in between`);
        const lines = r.log.filter((l) => /object test:|style:/.test(l)).map((l) => l.replace(/^.*dxr-auto3d\] /, '')).join(' | ');
        t('nothing is decided again', !/no longer an object|deciding again|Scene camera/.test(lines), lines);
      },
    },
    // THE 3D CURSOR (v0.8.1): where the browser draws its cursor at depth, the depth of the subject under the
    // pointer is reported to the layer (raw, device px between the eyes, < 0 in front of the glass); off the
    // subject the report carries no depth. Nothing is drawn by the script.
    {
      id: 'rig-cursor', name: 'product viewer: the pointer over the subject reports a depth in front of the glass; off it, none',
      // The camera-rig variant (a hotspot page: object-like, core focus), because the fake models the runtime's
      // camera rig exactly (fake.nominal + eyeX: two real eyes converged on the glass), not its display rig.
      url: 'three-turntable.html?still=1&hotspot=1', expect: 'convert', fovDeg: 30, ready: 'window.__ready', cfg: { rig: 'auto', coreGlass: true, eyeScale: 1 }, fake: { nominal: [0, 0.1, 0.6], eyeX: 0.0315 },
      probe: new Function(`return (async () => {
        const live = () => { const S = window.__dxrAuto3D.state(), R = S.renderers.find((x) => x.active); return R && R.glass && R.verdict && R.rampK >= 1 ? R : null; };
        const t0 = performance.now();
        while (!live() && performance.now() - t0 < 9000) await new Promise((q) => setTimeout(q, 100));
        if (!live()) return { error: 'never live with a core glass' };
        await new Promise((q) => setTimeout(q, 1500));
        const b = document.querySelector('canvas').getBoundingClientRect();
        const at = async (u, v) => {
          window.dispatchEvent(new PointerEvent('pointermove', { clientX: b.left + u * b.width, clientY: b.top + v * b.height, bubbles: true }));
          await new Promise((q) => setTimeout(q, 400));
          const R = live();
          return R && R.cursor ? { support: R.cursor.support, last: R.cursor.last } : null;
        };
        const centre = await at(0.5, 0.5), corner = await at(0.04, 0.06);
        return { centre, corner, width: b.width * devicePixelRatio };
      })();`),
      check(r, t) {
        t('converted within 60 s', r.ok, `${r.ms} ms`);
        const P = r.probe || {};
        if (P.error || !P.centre) { t('the cursor state could be read', false, JSON.stringify(P)); return; }
        t('the layer answers that the runtime draws the cursor', P.centre.support === 'runtime', P.centre.support);
        const d = P.centre.last && P.centre.last.disparityPx;
        t('over the subject: a depth in front of the glass (crossed, a few px to a few % of the width)', d < -0.5 && d > -0.08 * P.width, `${d} px of ${P.width}`);
        t('over the subject: reported at the pointer', P.centre.last && Math.abs(P.centre.last.u - 0.5) < 0.01 && Math.abs(P.centre.last.v - 0.5) < 0.01, JSON.stringify(P.centre.last));
        t('off the subject: the report carries no depth', P.corner && P.corner.last && P.corner.last.disparityPx === undefined, JSON.stringify(P.corner));
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
        t('the glass followed: it sits the same distance in front of the target as before', Math.abs(front(b) - front(a)) < 0.05 && Math.abs(-b.z - b.glass) < 1e-3 * b.glass, `in front of the target by ${front(a).toFixed(3)} -> ${front(b).toFixed(3)}; glass ${a.glass.toFixed(2)} -> ${b.glass.toFixed(2)}`);
        t('the virtual display height shrank with it', b.vdh < 0.6 * a.vdh, `${a.vdh.toFixed(3)} -> ${b.vdh.toFixed(3)}`);
      },
    },
    // FLAT IS THE PAGE (v0.8.3, T.flatMorph). 3D -> 2D on the display rig: the depth fade is also the
    // dolly zoom to the page's own camera, so the last rig before the lens switches is the page camera
    // itself (its field of view, both eyes on it), and the glass plane kept its size on the way.
    ...[['rig-flat', true], ['rig-flat-off', false]].map(([id, on]) => ({
      id, name: on ? 'product viewer, 3D turned off: the display rig morphs to the page camera while the depth fades (flat = the page\'s 2D picture)' : 'A/B flatMorph false: flat is the display rig with its factors at 0 (0.8.2)',
      url: 'three-turntable.html?still=1', expect: 'convert', fovDeg: 30, ready: 'window.__ready', cfg: { rig: 'auto', coreGlass: true, eyeScale: 1, flatMorph: on }, fake: { nominal: [0, 0.1, 0.6], eyeX: 0.0315 },
      probe: new Function(`return (async () => {
        const R = () => { const S = window.__dxrAuto3D.state(); return S.renderers.find((x) => x.active) || S.renderers[0] || null; };
        const t0 = performance.now(); let live = null;
        while (performance.now() - t0 < 12000) { const r = R(); if (r && r.active && r.rampK === 1 && !r.ramping && r.glass && r.glass.d > 0 && window.__fakeXR.lastRig && window.__fakeXR.lastRig.type === 'display') { live = { rig: window.__fakeXR.lastRig, glass: r.glass.d, k: r.rigNow.k }; break; } await new Promise((q) => setTimeout(q, 100)); }
        if (!live) return { live: null };
        const seen = []; let pushes = window.__fakeXR.rigPushes;
        window.__dxrAuto3D.set('enabled', false);
        const t1 = performance.now();
        while (performance.now() - t1 < 4000) {
          await new Promise((q) => requestAnimationFrame(q));
          if (window.__fakeXR.rigPushes !== pushes) { pushes = window.__fakeXR.rigPushes; seen.push(JSON.parse(JSON.stringify(window.__fakeXR.lastRig))); }
          const r = R(); if (!r || !r.active) break;
        }
        return { live, seen, ms: Math.round(performance.now() - t1) };
      })();`),
      check(r, t) {
        t('converted within 60 s', r.ok, `${r.ms} ms`);
        const p = r.probe || {};
        if (!p.live || !p.seen || !p.seen.length) { t('live on the display rig, then rigs pushed during the turn-off', false, JSON.stringify({ live: p.live, n: p.seen && p.seen.length })); return; }
        const fov = (30 * Math.PI) / 180, d = p.live.glass, last = p.seen[p.seen.length - 1];
        if (!on) {
          t('the last rig is the display rig, flat', last.type === 'display' && last.ipdFactor === 0 && last.parallaxFactor === 0, JSON.stringify(last));
          return;
        }
        t('the last rig before the lens switches is the page camera: at its position, its field of view, both eyes on it',
          last.type === 'camera' && Math.abs(last.position.z) < 1e-6 * d && Math.abs(last.verticalFov - fov) < 1e-6 && last.ipdFactor === 0 && last.parallaxFactor === 0, JSON.stringify(last));
        const cam = p.seen.filter((g) => g.type === 'camera');
        const size = cam.map((g) => (d + g.position.z) * Math.tan(g.verticalFov / 2)), want = d * Math.tan(fov / 2);
        const worst = Math.max(...size.map((x) => Math.abs(x / want - 1)));
        t('the glass plane kept its size at every step (a dolly zoom)', cam.length >= 5 && worst < 5e-3, `${cam.length} steps, worst ${(worst * 100).toFixed(3)} %`);
        const e = cam.map((g) => g.ipdFactor * g.metersToVirtual), f = cam.map((g) => g.verticalFov);
        const mono = (a, sgn) => a.every((x, i) => i === 0 || sgn * (x - a[i - 1]) >= -1e-9);
        t('the depth only falls and the field of view only moves toward the page\'s', mono(e, -1) && (mono(f, 1) || mono(f, -1)) && e[0] > 0, `eye scale ${e[0].toExponential(2)} -> ${e[e.length - 1].toExponential(2)}, fov ${(f[0] * 57.2958).toFixed(2)} -> ${(f[f.length - 1] * 57.2958).toFixed(2)} deg`);
      },
    })),
    // A/B: the 0.7.13 rule.
    rigCase('rig-loose', 'A/B strictObject false: any page target is an object (0.7.13)', 'three-orbit.html', 'display', 'object on a turntable', { cfg: { strictObject: false }, until: 'R.rigScale && S.rigMode === "display"' }),
  ].map(fix);
}

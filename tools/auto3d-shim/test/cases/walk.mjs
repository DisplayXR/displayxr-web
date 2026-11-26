// v0.7.12: open scenes that are not splats (the camera walks, or geometry surrounds it), and the eyes
// anchored on the page camera (the display's nominal viewer = the page camera; only the head's
// deviation is scaled, and clamped short of the nearest surface). Page: pages/three-walk.html (no
// lookAt, no controls target: the estimator and the open signals decide).
//
// The eye-anchor cases use the fake's RUNTIME MODEL (fake.nominal, fake-xr.js): getDisplayInfo()
// reports a nominal viewer and the 8K panel's size, and the eyes come back as the runtime's camera rig
// computes them (relative to the canvas centre, centre pulled to the axis by parallaxFactor, × m2v,
// frusta sheared by eye × convergenceDiopters). `eyeMid` is the two eyes' midpoint in the page
// camera's own axes, after the shim's anchor.

const NOMINAL = [0, 0.1, 0.65];

// Polls state() until fn(R) holds or ms run out; returns the last read.
const pollSrc = (ms, until) => `(async () => {
  const t0 = performance.now(); let R = null;
  while (performance.now() - t0 < ${ms}) {
    R = window.__dxrAuto3D.state().renderers.find((x) => x.active) || null;
    if (R && (${until})) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  return R && { src: R.convergenceSource, via: R.convergenceVia, d: R.convergence, latched: R.openLatched, why: R.openWhy, m2v: window.__fakeXR.lastRig && window.__fakeXR.lastRig.metersToVirtual, scale: R.rigScale, waited: Math.round(performance.now() - t0) };
})()`;

function openCase(id, name, query, expectOpen, why, extra) {
  return {
    id, name, url: 'P' + query, expect: 'convert', fovDeg: 40, ready: 'window.__ready', ...(extra || {}),
    probe: new Function(`return ${pollSrc(expectOpen ? 12000 : 8000, expectOpen ? 'R.openLatched' : 'false')};`),
    check(r, t) {
      t('converted within 60 s', r.ok, `${r.ms} ms`);
      const p = r.probe;
      if (!p) { t('probe read', false, 'no probe'); return; }
      const lines = r.log.filter((l) => /open scene:/.test(l));
      if (expectOpen) {
        t(`open scene latched by ${why}: fixed 2 at real scale (m2v 1)`, p.src === 'fixed' && p.latched === true && p.d === 2 && p.m2v === 1 && new RegExp(why).test(p.why || ''), JSON.stringify(p));
        t('one log line names the signal', lines.length === 1 && new RegExp(why).test(lines[0]), lines.join(' | ') || 'no open-scene line');
      } else {
        t('stays an object viewer: estimator, not latched, no open-scene line', p.src === 'estimator' && !p.latched && lines.length === 0 && p.m2v !== 1,
          `${JSON.stringify(p)}; ${lines.join(' | ')}`);
      }
    },
  };
}

// Eye-anchor probe: reads the anchored eye midpoint (camera axes) and the anchor's record, with the fake
// head at `head` (display space, metres) for 1 s first.
const anchorProbe = (head) => new Function(`return (async () => {
  window.__fakeXROpts.headM = ${JSON.stringify(head)};
  await new Promise((r) => setTimeout(r, 1000));
  const R = window.__dxrAuto3D.state().renderers.find((x) => x.active);
  return R && { src: R.convergenceSource, d: R.convergence, latched: R.openLatched, eyeMid: R.eyeMid, eyeShear: R.eyeShear, anchor: R.anchor, nearSurf: R.nearSurf,
    m2v: window.__fakeXR.lastRig.metersToVirtual, pf: window.__fakeXR.lastRig.parallaxFactor, runtime: window.__fakeXR.runtime };
})();`);

function anchorCase(id, name, query, head, check, extra) {
  return { id, name, url: 'P' + query, expect: 'convert', fovDeg: 40, ready: 'window.__ready', fake: { nominal: NOMINAL, eyeX: 0.032 }, ...(extra || {}), probe: anchorProbe(head),
    check(r, t) {
      t('converted within 60 s', r.ok, `${r.ms} ms`);
      const p = r.probe;
      if (!p || !p.eyeMid) { t('probe read', false, JSON.stringify(p)); return; }
      check(p, t, r);
    } };
}
const len = (v) => Math.hypot(v[0], v[1], v[2]);

export default function cases({ P, NEW }) {
  const fix = (c) => ({ ...c, shim: NEW, url: c.url.replace(/^P/, P) });
  return [
    // (b) surrounded: a mesh room, the camera standing still inside it.
    openCase('walk-room-still', 'mesh room (four wall meshes), camera still inside: surrounded -> open, latched', 'three-walk.html?scene=room&cam=still', true, 'surrounded'),
    // (a) + (b): a first-person stroll round the room (either signal may latch first; one line).
    openCase('walk-room-fps', 'mesh room, a first-person stroll: open, latched', 'three-walk.html?scene=room&cam=walk', true, 'surrounded|walk'),
    // (a) alone: open ground, objects only far ahead (never surrounded), the camera walks and looks about.
    openCase('walk-field', 'open ground, nothing around, the camera walks forward and looks left / right: the walk signal latches', 'three-walk.html?scene=field&cam=walk', true, 'walk: the camera moved'),
    // (a) controls: a PointerLockControls-shaped window.controls on the page camera.
    openCase('walk-plc', 'model page with PointerLockControls on the camera: the walk signal latches', 'three-walk.html?scene=model&cam=plc', true, 'walk: PointerLockControls'),
    // (a) FirstPersonControls: its per-frame lookAt 100 ahead stops counting as a target once the walk latched.
    openCase('walk-fpc', 'FirstPersonControls on the camera (lookAt 100 ahead every frame): walk latches, the lookAt no longer wins', 'three-walk.html?scene=field&cam=fpc', true, 'walk: FirstPersonControls'),
    // Must NOT latch: case a's scene (a model on a 40-unit floor), still / orbiting / dollying.
    openCase('walk-model-still', 'model on a 40-unit floor (case a\'s scene), camera still: stays the estimator', 'three-walk.html?scene=model&cam=still', false),
    openCase('walk-model-orbit', 'model on the floor, the camera orbits it (scripted turntable, no lookAt): stays the estimator', 'three-walk.html?scene=model&cam=orbit', false),
    openCase('walk-model-dolly', 'model on the floor, the camera dollies toward it and back: stays the estimator', 'three-walk.html?scene=model&cam=dolly', false),
    // The A/B: both signals off, the room stays the estimator (the cases above are the signals, not the old rule).
    openCase('walk-room-off', 'mesh room, camera still, the walk + surround signals off (A/B): stays the estimator', 'three-walk.html?scene=room&cam=still', false, null, { cfg: { openWalk: false, openSurround: false } }),

    // Eye anchor, estimator rig: at the nominal head the eye midpoint IS the page camera.
    anchorCase('anchor-est-rest', 'eye anchor, object viewer (estimator): head at the nominal viewer -> eyes centred on the page camera', 'three-walk.html?scene=model&cam=still', NOMINAL, (p, t) => {
      t('estimator scale (m2v = d ≈ 8)', p.src === 'estimator' && p.m2v > 6 && p.m2v < 10, JSON.stringify({ src: p.src, m2v: p.m2v }));
      t('eye midpoint on the page camera (|mid| < 1e-4 units)', len(p.eyeMid) < 1e-4, `mid ${p.eyeMid.map((x) => x.toFixed(5))}, rest offset removed ${p.anchor && p.anchor.r.map((x) => x.toFixed(3))}`);
      const sh = p.eyeShear;
      t('at rest each frustum is the page camera frustum, sheared only by the eye own ±IPD/2 (P[8] opposite, P[9] 0)', sh && Math.abs(sh[0][0] + sh[1][0]) < 1e-5 && Math.abs(sh[0][1]) < 1e-5 && Math.abs(sh[1][1]) < 1e-5 && sh[0][0] > 0,
        JSON.stringify(sh));
      t('the runtime alone would have parked it m2v × (nominal − canvas centre) off (> 0.5 units)', p.anchor && len(p.anchor.r) > 0.5, JSON.stringify(p.anchor));
    }),
    // The A/B: anchor off, the same head leaves the eyes m2v × 0.1 above the page camera.
    anchorCase('anchor-est-off', 'eye anchor off (A/B): the runtime\'s eyes sit m2v × the nominal height above the page camera', 'three-walk.html?scene=model&cam=still', NOMINAL, (p, t) => {
      const C = p.runtime.C, want = [p.m2v * (0 - C[0]), p.m2v * (0.1 - C[1]), 0];
      t('eye midpoint = m2v × (nominal − canvas centre) off the page camera (the runtime rest)', len([p.eyeMid[0] - want[0], p.eyeMid[1] - want[1], p.eyeMid[2]]) < 1e-3 * p.m2v && len(want) > 0.5 && p.anchor === null,
        `mid ${p.eyeMid.map((x) => x.toFixed(3))}, want ${want.map((x) => x.toFixed(3))} (canvas centre ${C.map((x) => x.toFixed(3))} m)`);
    }, { cfg: { eyeAnchor: false } }),
    // Fixed / open rig (m2v 1): the anchor applies too (rest = page camera), unclamped.
    anchorCase('anchor-fixed-rest', 'eye anchor, open scene (fixed rig, m2v 1): head at nominal -> eyes centred on the page camera', 'three-walk.html?scene=room&cam=still', NOMINAL, (p, t) => {
      t('fixed rig at real scale', p.src === 'fixed' && p.m2v === 1, JSON.stringify({ src: p.src, m2v: p.m2v }));
      t('eye midpoint on the page camera (|mid| < 1e-4)', len(p.eyeMid) < 1e-4, `mid ${p.eyeMid.map((x) => x.toFixed(5))}`);
    }),
    anchorCase('anchor-fixed-lean', 'eye anchor, open scene: a 0.2 m lean is real 0.2 m of eye motion (no clamp at real scale)', 'three-walk.html?scene=room&cam=still', [0.1, 0.1, 0.65 - 0.17], (p, t) => {
      t('eye midpoint = the head deviation × 1 (0.1 right, 0.17 toward the scene)', Math.abs(p.eyeMid[0] - 0.1) < 2e-3 && Math.abs(p.eyeMid[1]) < 2e-3 && Math.abs(p.eyeMid[2] + 0.17) < 2e-3 && !p.anchor.clamped, `mid ${p.eyeMid.map((x) => x.toFixed(4))}`);
    }),
    // A small lean passes through (normal parallax unchanged): 0.03 m toward the panel × m2v.
    anchorCase('anchor-est-lean', 'eye anchor, estimator: a small lean is m2v × the deviation, unclamped', 'three-walk.html?scene=model&cam=still', [0.02, 0.1, 0.62], (p, t) => {
      const want = [0.02 * p.m2v, 0, -0.03 * p.m2v];
      t('eye midpoint = m2v × (head − nominal)', Math.abs(p.eyeMid[0] - want[0]) < 0.01 && Math.abs(p.eyeMid[1]) < 0.01 && Math.abs(p.eyeMid[2] - want[2]) < 0.01 && !p.anchor.clamped,
        `mid ${p.eyeMid.map((x) => x.toFixed(3))}, want ${want.map((x) => x.toFixed(3))}`);
    }),
    // A big lean toward the subject (0.6 m × m2v ≈ 4.8 units, the model ~7.2 ahead) is clamped short of it.
    anchorCase('anchor-est-clamp', 'eye anchor, estimator: a 0.6 m lean toward the model is clamped to 0.5 × the nearest surface', 'three-walk.html?scene=model&cam=still', [0, 0.1, 0.05], (p, t) => {
      const ns = p.nearSurf;
      t('nearest surface in view read from the estimator (≈ 8 − the knot\'s radius)', ns > 6 && ns < 7.9, `nearSurf ${ns}`);
      t('clamped: |deviation| = 0.5 × nearest surface, pointing at the scene, never reaching it', p.anchor.clamped && Math.abs(len(p.eyeMid) - 0.5 * ns) < 0.01 && p.eyeMid[2] < 0 && -p.eyeMid[2] < ns,
        `mid ${p.eyeMid.map((x) => x.toFixed(3))}, |mid| ${len(p.eyeMid).toFixed(3)}, unclamped ${p.anchor.dev.toFixed(3)}`);
    }),
  ].map(fix);
}

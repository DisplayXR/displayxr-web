// Spark (World Labs' Gaussian-splat renderer for three.js, @sparkjsdev/spark 2.x) under the three.js
// adapter. Spark draws inside the page's own renderer.render(scene, camera): a SparkRenderer is a
// THREE.Mesh in the scene whose onBeforeRender, once per renderer frame (info.render.frame),
// regenerates its splat accumulator for the camera it is given and starts an async GPU-readback +
// worker sort; every draw reads the camera's projectionMatrix as is (the eyes' off-axis frusta pass
// through). The adapter's two eye renders count as ONE renderer frame (three-adapter.js, eyeFrame),
// as a three WebXR frame does: without that, Spark regenerated and re-sorted twice per frame and its
// single sort order ping-ponged between the two eyes' viewpoints (measured: 2 updates, 1 regenerate
// and 1 sort per frame on a static scene, alternating left / right).
//
// Page: pages/three-spark.html (procedural splats, lookAt the lattice centre: convergence 5,
// 'target'). The page's instrumentation is window.__spark (see the page's header).
//
// Convergence without a target (?at=, ?room=): a SplatMesh is a THREE.Object3D with no geometry
// bounds; the three adapter samples its splat centres (three-adapter.js, splatBounds). From outside:
// one sphere, converge on its centre (as PlayCanvas's gsplat AABB). From inside (a room-scale world,
// an OPEN scene: every bound in view is a piece of a volume that holds the camera): a FIXED focus 2
// units ahead at real scale (T.openSceneMode 'fixed', the legacy-WebXR rule, David 2026-09-28); with
// T.openSceneMode 'percentile', the 0.5.3 room rule, a high percentile (T.convRoomPercentile, 0.7) of
// the apparent-size-weighted depths of the splats in view.

// Over one second of live frames: Spark updates per stereo frame, regenerations, sorts, and the
// viewpoint of the latest sort vs the camera Spark was last updated with.
const sparkProbe = async () => {
  const S = window.__spark;
  const st = () => window.__dxrAuto3D.state().renderers.find((x) => x.active);
  const a = { u: S.updates.length, g: S.gens, s: S.sorts.length, stereo: st().stats.stereo, replays: st().stats.replays, pageFrames: window.__pageFrames };
  await new Promise((r) => setTimeout(r, 1000));
  const b = { u: S.updates.length, g: S.gens, s: S.sorts.length, stereo: st().stats.stereo, replays: st().stats.replays, pageFrames: window.__pageFrames };
  const lastU = S.updates[S.updates.length - 1] || null, lastS = S.sorts[S.sorts.length - 1] || null;
  const R = st();
  return { a, b, lastU, lastS, eyeX: (window.__fakeXROpts && window.__fakeXROpts.eyeX) || 0, rs: S.renderSize || null, eye: R.eye };
};

function sparkChecks(r, t) {
  const p = r.probe;
  if (!p) { t('Spark probe read', false, 'no probe'); return; }
  const dStereo = p.b.stereo - p.a.stereo, dU = p.b.u - p.a.u, dG = p.b.g - p.a.g, dS = p.b.s - p.a.s;
  t('Spark draws inside the page\'s render(): stereo frames counted while its splats are live', dStereo > 20, `${dStereo} stereo frames in 1 s`);
  t('ONE Spark update per stereo frame (the two eyes are one renderer frame), not one per eye', dU > 0 && dU <= dStereo * 1.05 + 1,
    `${dU} SparkRenderer.updateInternal calls over ${dStereo} stereo frames`);
  t('static scene: no splat regeneration and no re-sort once settled (no left/right ping-pong)', dG === 0 && dS === 0,
    `${dG} regenerations, ${dS} sorts in 1 s (total ${p.b.g} / ${p.b.s})`);
  const near = (u, v) => u && v && Math.abs(u.x - v.x) < 1e-4 && Math.abs(u.y - v.y) < 1e-4 && Math.abs(u.z - v.z) < 1e-4;
  const eyeOk = p.lastU && Math.abs(Math.abs(p.lastU.x) - p.eyeX) < 1e-4 && p.lastU.x <= 0;
  t('the order on screen was sorted for THIS view: last sort viewpoint = the camera of the last update (the left eye, as three WebXR shares one sort)',
    near(p.lastS, p.lastU) && eyeOk, `last sort at ${JSON.stringify(p.lastS)}, last update camera ${JSON.stringify(p.lastU)}, eyeX ${p.eyeX}`);
  // Spark sizes its splats in pixels from renderer.getDrawingBufferSize() (its renderSize uniform).
  // While converted that getter answers the page's mono store, smaller than the eye since P0.2;
  // inside a SparkRenderer's onBeforeRender during an eye draw it answers the EYE (three-adapter.js,
  // "Spark's pixel size"). Read by the page after its last render() (a stereo frame).
  const replayOnly = p.a.pageFrames === p.b.pageFrames; // spark-idle: the page stopped drawing; its last read may predate the conversion
  if (!replayOnly) t("Spark's drawing-buffer size during a stereo frame = the eye (eyeW x eyeH), not the page's mono store",
    p.rs && p.eye && p.rs.x === p.eye[0] && p.rs.y === p.eye[1], `renderSize ${p.rs && p.rs.x}x${p.rs && p.rs.y}, eye ${p.eye && p.eye.join('x')}`);
}

export default function cases({ P, NEW }) {
  return [
    // The generic 'convert' assertions (SBS 2× eye, halves differ, 0.1 skew shift, rig, convergence
    // on the lookAt target, stable frame) plus Spark's own.
    { id: 'spark', name: 'Spark splats (three.js, procedural SplatMesh, setAnimationLoop)', url: P + 'three-spark.html', shim: NEW, expect: 'convert', fovDeg: 40, ready: 'window.__splatReady',
      probe: sparkProbe, alsoCheck: (r, t) => sparkChecks(r, t) },
    // Two distinct eye viewpoints (±0.02 along x): the case that ping-ponged. The shift is the 0.1
    // skew (64 px) minus the eyes' parallax at the lattice (focal·2·eyeX / z ≈ 989·0.04/5 ≈ 8 px).
    { id: 'spark-eyes', name: 'Spark splats, eyes 0.04 apart: one sort per frame, stable', url: P + 'three-spark.html', shim: NEW, fake: { eyeX: 0.02 }, expect: 'convert', fovDeg: 40, ready: 'window.__splatReady',
      probe: sparkProbe,
      check(r, t, h) {
        t('converted within 60 s', r.ok, `${r.ms} ms`);
        const R = r.state && r.state.renderers.find((x) => x.active);
        if (!R || !r.pixels) return;
        const ew = R.eye[0], sh = h.bestShift(r.pixels.px, r.pixels.w, r.pixels.h, ew);
        const focal = R.eye[1] / 2 / Math.tan((40 * Math.PI) / 360), want = 0.1 * ew - (focal * 0.04) / 5;
        t(`right half = left half shifted ≈ ${want.toFixed(1)} px (skew minus parallax)`, sh.zeroErr > 1 && Math.abs(sh.s - want) <= 2, `best shift ${sh.s} px (residual ${sh.e.toFixed(2)})`);
        t('frame stable across two reads (no sort flicker between frames)', h.diffCount(r.pixels.px, r.pixels.px2) === 0, `${h.diffCount(r.pixels.px, r.pixels.px2)} bytes differ`);
        sparkChecks(r, t);
      } },
    // No lookAt, the lattice 7 units ahead: the estimator finds the SplatMesh's centre (before the
    // splat bounds it saw nothing and fell back to 5.00).
    // The camera rig in ESTIMATOR mode (an object viewer: the camera outside every bound). v0.7.11: the
    // scale (m2v = depth × d / 0.5, d where the scale was decided) is set ONCE and frozen; the
    // convergence keeps following the estimate. The viewer's head sits 0.61 m off (fake headM, scaled by
    // m2v as the runtime does): the eyes sit head × m2v from the page camera (0.61 × 7 ≈ 4.3 units here),
    // and stay there when a 3-unit box appears 3 ahead and pulls the estimate in.
    { id: 'spark-est-head', name: 'Spark splats, object viewer (estimator): m2v set once (7) and frozen while the estimate moves; eyes stay at head × m2v from the page camera',
      url: P + 'three-spark.html?at=7', shim: NEW, expect: 'convert', fovDeg: 40, ready: 'window.__splatReady',
      fake: { eyeX: 0.032, headM: [0, 0.1, 0.6] },
      probe: async () => {
        const read = () => { const R = window.__dxrAuto3D.state().renderers.find((x) => x.active), c = window.__camWorld(), e = R.eyeAt;
          return { src: R.convergenceSource, d: R.convergence, m2v: window.__fakeXR.lastRig.metersToVirtual, scale: R.rigScale, eyeFromCam: e ? Math.hypot(e[0] - c[12], e[1] - c[13], e[2] - c[14]) : null }; };
        const before = read();
        window.__addSubject(3); // a 3-unit box 3 ahead: the estimate moves in from 7
        let maxEye = 0; const m2vs = new Set();
        for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 100)); const x = read(); m2vs.add(x.m2v); if (x.eyeFromCam > maxEye) maxEye = x.eyeFromCam; }
        return { before, after: read(), maxEye, m2vs: [...m2vs] };
      },
      check(r, t) {
        t('converted within 60 s', r.ok, `${r.ms} ms`);
        const p = r.probe, head = Math.hypot(0.032, 0.1, 0.6);
        if (!p) { t('probe read', false, 'no probe'); return; }
        const b = p.before, a = p.after;
        t('scale set once by the estimator at the lattice (7 ± 5 %), m2v = d, logged once', b.src === 'estimator' && b.scale && Math.abs(b.scale.d - 7) / 7 < 0.05 && Math.abs(b.m2v - b.scale.d) < 1e-3 * b.scale.d &&
          r.log.filter((l) => /scale set: m2v/.test(l)).length === 1, `before ${JSON.stringify(b)}; ${r.log.filter((l) => /scale set/.test(l)).join(' | ')}`);
        t('eye 0 at head × m2v from the page camera (±5 %)', Math.abs(b.eyeFromCam - head * b.m2v) < 0.05 * head * b.m2v, `eye ${b.eyeFromCam.toFixed(2)}, head × m2v ${(head * b.m2v).toFixed(2)}`);
        t('the box pulls the estimate in (convergence moves > 5 %), m2v does NOT move (one value over 4 s)', Math.abs(a.d - b.d) / b.d > 0.05 && p.m2vs.length === 1 && p.m2vs[0] === b.m2v,
          `d ${b.d.toFixed(2)} -> ${a.d.toFixed(2)}; m2v seen ${p.m2vs.join(', ')}`);
        t('the eyes never moved farther than head × the frozen m2v from the page camera', p.maxEye <= head * b.m2v * 1.01, `max ${p.maxEye.toFixed(3)} vs ${(head * b.m2v).toFixed(3)}`);
      } },
    { id: 'spark-est', name: 'Spark splats, no lookAt: estimator converges on the SplatMesh centre (7)', url: P + 'three-spark.html?at=7', shim: NEW, expect: 'convert', fovDeg: 40, ready: 'window.__splatReady' },
    // No lookAt, the camera inside the splat mesh (lattice at 8 + a 15-unit shell around the camera):
    // the mesh's sphere holds the camera and nothing bounded is in view: an OPEN scene. Fixed focus:
    // convergence 2 (units read as metres), source 'fixed', rig at real scale (the generic rig check:
    // metersToVirtual 1, ipd = parallax = 1 at the default depth 0.5).
    { id: 'spark-room', name: 'Spark splats, camera inside the mesh (open scene): fixed focus 2 m at real scale', url: P + 'three-spark.html?room=1', shim: NEW, expect: 'convert', fovDeg: 40, ready: 'window.__splatReady',
      alsoCheck(r, t, h, R) {
        t(`open scene: convergence exactly T.openSceneConvM (2), via 'open scene'`, R && R.convergence === 2 && R.convergenceVia === 'open scene', `convergence ${R && R.convergence} via ${R && R.convergenceVia}`);
      } },
    // The same room with T.openSceneMode 'percentile' (the dev tuning key, via __dxrAuto3DTestCfg):
    // the 0.5.3 room rule, the 70th percentile of the in-view splats' apparent-size-weighted depths,
    // toward the back of the lattice (8.6), so the A/B stays live.
    { id: 'spark-room-percentile', name: 'Spark splats, camera inside the mesh, openSceneMode percentile: 70th percentile (8.6)', url: P + 'three-spark.html?room=1&mode=percentile', shim: NEW, cfg: { openSceneMode: 'percentile' }, expect: 'convert', fovDeg: 40, ready: 'window.__splatReady',
      alsoCheck(r, t, h, R) {
        const d = R && R.convergence;
        t('inside the mesh: finite, in front of the room shell (not the 15-unit shell, not the near plane, not the 5.00 default)', isFinite(d) && d > 1 && d < 12 && Math.abs(d - 5) > 0.5, `convergence ${d}`);
      } },
    // ... and with T.convRoomPercentile 0.5 on top: the weighted MEDIAN (8.06).
    { id: 'spark-room-percentile-p50', name: 'Spark splats, camera inside the mesh, percentile mode, convRoomPercentile 0.5: the weighted median (8)', url: P + 'three-spark.html?room=1&mode=percentile&p=0.5', shim: NEW, cfg: { openSceneMode: 'percentile', convRoomPercentile: 0.5 }, expect: 'convert', fovDeg: 40, ready: 'window.__splatReady' },
    // v0.7.11 (#319): a bounded prop in view no longer ends an open scene, and open LATCHES. arrival.space
    // has ~400 meshes (props, signs, portals) inside its splat world: the source flipped between the
    // estimator and the fixed rig as the viewer walked, and the depth kept changing on the panel.
    // A bounded subject appears inside the open scene 1 s after the fixed focus (a model loading into a
    // world): the source STAYS 'fixed' at real scale (0.7.x: it went to 'estimator', converging on the box).
    { id: 'spark-room-subject', name: 'Spark splats, open scene, a bounded subject appears after 1 s: stays fixed (open latches, props do not veto)', url: P + 'three-spark.html?room=1', shim: NEW, expect: 'convert', fovDeg: 40, ready: 'window.__splatReady',
      probe: async () => {
        const read = () => { const R = window.__dxrAuto3D.state().renderers.find((x) => x.active); return { src: R.convergenceSource, via: R.convergenceVia, d: R.convergence, latched: R.openLatched, rig: JSON.parse(JSON.stringify(window.__fakeXR.lastRig)), hud: (document.querySelector('[data-dxr-auto3d-hud]') || {}).textContent || '' }; };
        const before = read();
        await new Promise((r) => setTimeout(r, 1000));
        window.__addSubject();
        await new Promise((r) => setTimeout(r, 5000)); // the estimator ran every 30 frames: ~10 times
        return { before, after: read() };
      },
      check(r, t) {
        t('converted within 60 s', r.ok, `${r.ms} ms`);
        const p = r.probe;
        if (!p) { t('probe read', false, 'no probe'); return; }
        const fixedOk = (x) => x.src === 'fixed' && x.via === 'open scene' && x.d === 2 && x.rig.metersToVirtual === 1 && x.rig.ipdFactor === 1 && x.rig.parallaxFactor === 1 && x.hud.includes('(fixed: open scene)');
        const fmt = (x) => `src ${x.src} via ${x.via} d ${x.d} latched ${x.latched} m2v ${x.rig.metersToVirtual} ipd ${x.rig.ipdFactor} hud "${x.hud}"`;
        t(`before: source 'fixed', convergence 2, real scale (m2v 1, ipd = parallax = 1), latched`, fixedOk(p.before) && p.before.latched === true, fmt(p.before));
        t(`5 s after the box (3 units ahead, in view): still 'fixed: open scene', convergence 2, real scale`, fixedOk(p.after), fmt(p.after));
        t('no "convergence settled" line (the source never moved)', !r.log.some((l) => /convergence settled: /.test(l)), r.log.filter((l) => /convergence settled: /.test(l)).join(' | ') || 'none');
      } },
    // Open with a bounded prop in view from the start (the box at 3 among the room's splats): open, not
    // the estimator on the box (0.7.x: 'estimator', 3).
    { id: 'spark-room-props', name: 'Spark splats, camera inside the mesh with a bounded prop in view from the start: open scene, fixed focus 2', url: P + 'three-spark.html?room=1&subject=1', shim: NEW, expect: 'convert', fovDeg: 40, ready: 'window.__splatReady',
      alsoCheck(r, t, h, R) {
        t(`open with a prop in view: convergence exactly 2, via 'open scene'`, R && R.convergence === 2 && R.convergenceVia === 'open scene' && R.convergenceSource === 'fixed',
          `convergence ${R && R.convergence} source ${R && R.convergenceSource} via ${R && R.convergenceVia}`);
      } },
    // The latch: open, then the camera leaves the room (40 units back, outside every bound: from there the
    // estimator alone sees an object viewer and would converge on the lattice ~48 ahead). Stays fixed.
    // The viewer's head sits 0.1 m up and 0.6 m back (fake headM, scaled by the rig's m2v as the runtime
    // does): at m2v 1 the eyes stay within ~0.6 of the page camera. On the panel (#319) the estimator's
    // m2v put arrival.space's eyes 5.6 units above the camera ('head on top of a tree').
    { id: 'spark-room-latch', name: 'Spark splats, open scene, then the camera leaves the volume: the open latch keeps the fixed focus; eyes stay by the page camera', url: P + 'three-spark.html?room=1', shim: NEW, expect: 'convert', fovDeg: 40, ready: 'window.__splatReady',
      fake: { eyeX: 0.032, headM: [0, 0.1, 0.6] },
      probe: async () => {
        const read = () => {
          const R = window.__dxrAuto3D.state().renderers.find((x) => x.active), c = window.__camWorld(), e = R.eyeAt;
          return { src: R.convergenceSource, via: R.convergenceVia, d: R.convergence, latched: R.openLatched, m2v: window.__fakeXR.lastRig.metersToVirtual,
            eyeFromCam: e ? +Math.hypot(e[0] - c[12], e[1] - c[13], e[2] - c[14]).toFixed(3) : null };
        };
        const before = read();
        window.__leaveRoom();
        await new Promise((r) => setTimeout(r, 4000));
        return { before, after: read() };
      },
      check(r, t) {
        t('converted within 60 s', r.ok, `${r.ms} ms`);
        const p = r.probe;
        if (!p) { t('probe read', false, 'no probe'); return; }
        const ok = (x) => x.src === 'fixed' && x.via === 'open scene' && x.d === 2 && x.latched === true && x.m2v === 1 && x.eyeFromCam !== null && x.eyeFromCam < 0.7;
        t('inside the room: fixed 2, latched, eye 0 within 0.7 of the page camera (head 0.61 m × m2v 1)', ok(p.before), JSON.stringify(p.before));
        t('4 s after the camera left the volume (outside every bound): still fixed 2 at real scale, eyes still by the camera', ok(p.after), JSON.stringify(p.after));
      } },
    // Render on demand: the page stops drawing 30 frames after the splats are sorted; the shim's
    // replay keeps both eyes drawn (Spark's onBeforeRender runs in every replayed eye render).
    { id: 'spark-idle', name: 'Spark splats, page stops drawing (replay)', url: P + 'three-spark.html?freeze=30', shim: NEW, expect: 'convert', fovDeg: 40, ready: 'window.__frozen',
      probe: sparkProbe,
      alsoCheck(r, t, h, R) {
        const p = r.probe;
        t('page drew nothing during the probe; the shim replayed every frame', p && p.a.pageFrames === p.b.pageFrames && p.b.replays - p.a.replays > 20 && R.stats.replays > 0,
          p ? `page frames ${p.a.pageFrames} -> ${p.b.pageFrames}, replays +${p.b.replays - p.a.replays}` : 'no probe');
        sparkChecks(r, t);
      } },
  ];
}

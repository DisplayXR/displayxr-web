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

// Over one second of live frames: Spark updates per stereo frame, regenerations, sorts, and the
// viewpoint of the latest sort vs the camera Spark was last updated with.
const sparkProbe = async () => {
  const S = window.__spark;
  const st = () => window.__dxrAuto3D.state().renderers.find((x) => x.active);
  const a = { u: S.updates.length, g: S.gens, s: S.sorts.length, stereo: st().stats.stereo, replays: st().stats.replays, pageFrames: window.__pageFrames };
  await new Promise((r) => setTimeout(r, 1000));
  const b = { u: S.updates.length, g: S.gens, s: S.sorts.length, stereo: st().stats.stereo, replays: st().stats.replays, pageFrames: window.__pageFrames };
  const lastU = S.updates[S.updates.length - 1] || null, lastS = S.sorts[S.sorts.length - 1] || null;
  return { a, b, lastU, lastS, eyeX: (window.__fakeXROpts && window.__fakeXROpts.eyeX) || 0 };
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

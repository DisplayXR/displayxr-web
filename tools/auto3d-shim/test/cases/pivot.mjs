// The display rig's pivot (core.js, pivotOffset; David at the panel, 2026-09-29: "pivot point for
// object view is different from virtual display location — they should always coincide (when
// transitioning from scene view it is center screen at convergence plane)").
//
// Each case converts a page in the camera rig, reads the convergence point the camera rig declared
// (page camera + forward × 1/convergenceDiopters) and its framing there (2·d·tan(verticalFov/2)),
// toggles to the display rig (ctl.setRig, as the chip / Ctrl+Alt+P do) and asserts, from the rig
// the core pushed and the page camera's own world matrix (window.__camWorld, a test hook on the page):
//   - the virtual display's centre (page camera × (pivot offset + rig.position)) IS that point (1 %),
//   - its height (virtualDisplayHeight) IS that framing (1 %).
// Then the page moves its camera the way its controls do, and the centre must stay the pivot:
//   - 'orbit' (three OrbitControls, about its target = the convergence point): the centre stays on
//     the target (the page's orbit pivot and the display coincide);
//   - 'yaw' (a first-person turn: the camera rotates about ITSELF — Spark's SparkControls, pointer
//     look): the display does not swing sideways (< 1 % of d across the view axis); the eyes the
//     adapter composed (state().eyeAt, eye 0: the fake's eye poses are identity, so it is the render
//     camera) orbit it at d; and, A/B, with T.displayPivot false (0.5.4's rigid attach) the display
//     swings by ~d·sin(yaw), so the assertion discriminates.
// Finally back to the camera rig: no pivot offset, the rig on the page camera as before.
const READY = (extra) => `(() => { const s = window.__dxrAuto3D && window.__dxrAuto3D.state(); const r = s && s.renderers.find((x) => x.active);
  return !!(r && r.stats.twoView > 90 && r.rampK === 1 && !r.ramping && (${extra || 'true'})); })()`;

function sample() {
  const s = window.__dxrAuto3D.state(), R = s.renderers.find((x) => x.active);
  const M = window.__camWorld(), rig = R && R.rig;
  const L = Math.hypot(M[8], M[9], M[10]) || 1;
  const f = [-M[8] / L, -M[9] / L, -M[10] / L], p = [M[12], M[13], M[14]];
  const t = R && R.pivot ? R.pivot.t : [0, 0, 0];
  const q = rig && rig.position ? [t[0] + rig.position.x, t[1] + rig.position.y, t[2] + rig.position.z] : null;
  const centre = q && [0, 1, 2].map((k) => M[k] * q[0] + M[4 + k] * q[1] + M[8 + k] * q[2] + M[12 + k]);
  return {
    rigMode: s.rigMode, rig, conv: R && R.convergence, src: R && R.convergenceSource, p, f, centre, pivot: R ? R.pivot : null, eyeAt: R && R.eyeAt,
    target: typeof window.__target === 'function' ? window.__target() : null,
  };
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const fmt = (a) => (a ? `(${a.map((x) => x.toFixed(3)).join(', ')})` : 'null');
// Displacement of b from a across the view axis f (the along-axis part is the convergence moving).
const lateral = (a, b, f) => { const w = sub(b, a), k = dot(w, f); return len([w[0] - k * f[0], w[1] - k * f[1], w[2] - k * f[2]]); };

async function drive(page, h, c) {
  await page.waitForFunction(READY(c.ready), { timeout: 60000, polling: 200 });
  await h.sleep(400);
  const out = { cam: await page.evaluate(sample) };
  await page.evaluate(() => window.__dxrAuto3D.set('rig', 'display'));
  await h.sleep(600);
  out.disp = await page.evaluate(sample);
  if (c.motion) {
    // Five steps of c.step (5°), a few frames apart: a drag, not a cut (> 30° in one frame re-anchors).
    for (let i = 0; i < 5; i++) {
      await page.evaluate(c.motion === 'orbit' ? (a) => window.__orbit(a) : (a) => window.__yaw(a), c.step);
      await h.sleep(120);
    }
    await h.sleep(500);
    out.moved = await page.evaluate(sample);
    if (c.motion === 'yaw') {
      await page.evaluate(() => window.__dxrAuto3D.set('displayPivot', false));
      await h.sleep(400);
      out.rigid = await page.evaluate(sample);
      await page.evaluate(() => window.__dxrAuto3D.set('displayPivot', true));
    }
  }
  await page.evaluate(() => window.__dxrAuto3D.set('rig', 'camera'));
  await h.sleep(400);
  out.back = await page.evaluate(sample);
  return { S: out };
}

function checks(r, t, c) {
  const S = r.S;
  t('converted, then toggled camera -> display', r.ok && S && S.cam.rigMode === 'camera' && S.cam.rig && S.cam.rig.type === 'camera' && S.disp.rigMode === 'display' && S.disp.rig && S.disp.rig.type === 'display',
    r.error || (S && `cam ${S.cam.rig && S.cam.rig.type}, then ${S.disp.rig && S.disp.rig.type}`));
  if (!S || !S.disp.rig || !S.cam.rig) return;
  const C = S.cam, D = S.disp;
  const dCam = 1 / C.rig.convergenceDiopters;
  const convPt = [0, 1, 2].map((k) => C.p[k] + C.f[k] * dCam);
  const err = len(sub(D.centre, convPt));
  t(`display centre = the camera rig's convergence point (screen centre on the convergence plane, ${dCam.toFixed(3)} ahead), within 1 %`,
    err < 0.01 * dCam, `centre ${fmt(D.centre)} vs convergence point ${fmt(convPt)}: off by ${((100 * err) / dCam).toFixed(3)} % of d (source ${C.src})`);
  const frame = 2 * dCam * Math.tan(C.rig.verticalFov / 2), vdh = D.rig.virtualDisplayHeight;
  t('framing at that plane unchanged: virtualDisplayHeight = 2·d·tan(camera-rig verticalFov / 2), within 1 %', Math.abs(vdh - frame) < 0.01 * frame,
    `vdh ${vdh && vdh.toFixed(4)} vs ${frame.toFixed(4)} (fov ${((C.rig.verticalFov * 180) / Math.PI).toFixed(2)}°)`);
  t('the pivot anchor is that centre', D.pivot && len(sub(D.pivot.c, D.centre)) < 1e-3 * dCam, `anchor ${fmt(D.pivot && D.pivot.c)}`);
  if (c.motion === 'orbit') {
    const M = S.moved, d = M.rig && -M.rig.position.z, e = len(sub(M.centre, M.target));
    t("page orbits its controls' target (25° yaw): the display centre stays on the target (orbit pivot = display), within 1 %",
      M.rig && M.rig.type === 'display' && e < 0.01 * d && len(sub(M.p, D.p)) > 0.3 * d,
      `centre ${fmt(M.centre)} vs target ${fmt(M.target)}: ${((100 * e) / d).toFixed(3)} % of d; camera moved ${len(sub(M.p, D.p)).toFixed(3)}; source ${M.src}`);
  }
  if (c.motion === 'yaw') {
    const M = S.moved, d = M.rig && -M.rig.position.z, lat = lateral(D.centre, M.centre, M.f);
    t('first-person turn (the camera rotates about itself, 25°): the display does NOT swing — its centre moves < 1 % of d across the view axis',
      M.rig && M.rig.type === 'display' && lat < 0.01 * d && dot(M.f, D.f) < Math.cos((20 * Math.PI) / 180),
      `lateral ${lat.toFixed(4)} (${((100 * lat) / d).toFixed(3)} % of d ${d && d.toFixed(3)}), camera turned ${((Math.acos(Math.min(1, dot(M.f, D.f))) * 180) / Math.PI).toFixed(1)}°`);
    const v = [0, 1, 2].map((k) => M.centre[k] - M.f[k] * d), ev = M.eyeAt && len(sub(M.eyeAt, v));
    t('... the eyes the adapter composed orbit it: eye 0 (identity fake pose) at centre - forward·d, not at the page camera',
      M.eyeAt && ev < 1e-3 * d && len(sub(M.eyeAt, M.p)) > 0.2 * d, `eye ${fmt(M.eyeAt)} vs ${fmt(v)} (${ev && ev.toExponential(2)}); page camera ${fmt(M.p)}`);
    const G = S.rigid, glat = G && G.centre ? lateral(D.centre, G.centre, G.f) : NaN;
    t('A/B: with T.displayPivot false (0.5.4, the portal rigidly on the page camera) the same turn swings the display by > 30 % of d',
      glat > 0.3 * d && G.pivot === null, `lateral ${glat.toFixed(3)} (${((100 * glat) / d).toFixed(1)} % of d)`);
  }
  const B = S.back;
  t('back to the camera rig: no pivot offset, rig on the page camera (untouched)',
    B.rig && B.rig.type === 'camera' && B.pivot === null && B.rig.position.x === 0 && B.rig.position.y === 0 && B.rig.position.z === 0 && (!B.eyeAt || len(sub(B.eyeAt, B.p)) < 1e-4),
    `type ${B.rig && B.rig.type}, pivot ${JSON.stringify(B.pivot)}, eye ${fmt(B.eyeAt)} vs camera ${fmt(B.p)}`);
}

export default function cases({ P, NEW }) {
  const mk = (id, name, url, extra) => {
    const c = { id, name, url: P + url, shim: NEW, ...extra };
    c.run = (page, h) => drive(page, h, c);
    c.check = (r, t) => checks(r, t, c);
    return c;
  };
  return [
    mk('pivot-three-orbit', 'display rig pivot: three OrbitControls page, toggle + orbit about the target', 'three-orbit.html', { motion: 'orbit', step: (5 * Math.PI) / 180 }),
    mk('pivot-spark-room', 'display rig pivot: Spark open world (fixed 2 m), toggle + first-person turn', 'three-spark.html?room=1', { motion: 'yaw', step: (5 * Math.PI) / 180, ready: 'window.__splatReady' }),
    mk('pivot-pc-orbit', 'display rig pivot: PlayCanvas CameraControls page, toggle', 'pc-orbit.html', {}),
    mk('pivot-pc-mesh', 'display rig pivot: PlayCanvas page, toggle + first-person turn', 'pc-mesh.html', { motion: 'yaw', step: 5 }),
  ];
}

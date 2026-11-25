// cursor: 'depth' (PlayCanvas) over layers on the DISPLAY rig (handle.setLayerRig, issue #185): which
// layers each pick pass draws, the nearest-point merge, and the display-rig hit → the world point the
// PHOTO views show at the same pixels. Pure parts of js/inline3d-cursor-depth-playcanvas.js; the
// engine half is test/e2e/cursor-depth.e2e.mjs (playcanvas/splat/layerrig).
//
// The oracle is the runtime's own display rig (displayxr-common dxr_display3d_compute_view, factors
// 1) — what the layer rig's round views are proven equal to in test/layer-rig.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';

import { cursorPickPlan, nearestPickPoint, displayRigPickSolver } from '../js/inline3d-cursor-depth-playcanvas.js';
import { cameraRigFrame, layerRigGain, roundViews, mul4, invertRigid } from '../js/inline3d-splat-layer-rig.js';
import { CURSOR_DEPTH_PICK_GLSL, CURSOR_DEPTH_PICK_WGSL } from '../js/inline3d-cursor-depth.js';

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b} (eps ${eps})`);

// ── nearestPickPoint ──────────────────────────────────────────────────────────────────────────

test('nearestPickPoint: the smallest distance along the forward wins, across arrays and {x,y,z}', () => {
  const f = [0, 0, -1]; // looking down −z: larger z = nearer the viewer
  assert.deepEqual(nearestPickPoint([{ x: 0, y: 0, z: -5 }, [1, 2, -2], null, { x: 3, y: 0, z: -9 }], f), [1, 2, -2]);
  // The same points seen from the other side: the far one is now the nearest.
  assert.deepEqual(nearestPickPoint([{ x: 0, y: 0, z: -5 }, [1, 2, -2], { x: 3, y: 0, z: -9 }], [0, 0, 1]), [3, 0, -9]);
  // An oblique forward: distance is the projection, not z alone.
  assert.deepEqual(nearestPickPoint([[10, 0, -1], [0, 0, -3]], [-Math.SQRT1_2, 0, -Math.SQRT1_2]), [10, 0, -1]);
});

test('nearestPickPoint: nothing hit → null; non-finite points are skipped, never chosen', () => {
  assert.equal(nearestPickPoint([], [0, 0, -1]), null);
  assert.equal(nearestPickPoint([null, null], [0, 0, -1]), null);
  assert.equal(nearestPickPoint(null, [0, 0, -1]), null);
  assert.deepEqual(nearestPickPoint([[NaN, 0, 0], { x: 0, y: Infinity, z: 9 }, [0, 0, -4]], [0, 0, -1]), [0, 0, -4]);
});

test('nearestPickPoint: an eye-pass hit and a display-pass hit merge by nearest, whichever pass found it', () => {
  const f = [0, 0, -1];
  const eye = [{ x: 0, y: 0, z: -3 }, null];
  const display = [null, [0.1, 0, -1.5]];
  assert.deepEqual(nearestPickPoint([...eye, ...display], f), [0.1, 0, -1.5]);
  assert.deepEqual(nearestPickPoint([...display, ...eye], f), [0.1, 0, -1.5], 'order-independent');
  assert.deepEqual(nearestPickPoint([...eye, null, [0, 0, -4]], f), [0, 0, -3]);
});

// ── cursorPickPlan ────────────────────────────────────────────────────────────────────────────

const SKIP = [4, 5, 6]; // UI, immediate, skybox stand-ins

test('cursorPickPlan: no layer rig → the eye layers minus the skipped ones, no display pass (zero cost)', () => {
  assert.deepEqual(cursorPickPlan([0, 4, 1, 6, 7], null, SKIP), { eye: [0, 1, 7], display: [] });
  assert.deepEqual(cursorPickPlan([0, 1], { active: true, moved: { display: [], post: [] }, lastRound: [{}, {}] }, SKIP), { eye: [0, 1], display: [] });
  assert.deepEqual(cursorPickPlan([0, 1], { active: false, moved: { display: [9], post: [] }, lastRound: [{}, {}] }, SKIP), { eye: [0, 1], display: [] }, 'inactive rig');
  assert.deepEqual(cursorPickPlan(undefined, null, SKIP), { eye: [], display: [] });
});

test('cursorPickPlan: a ROUNDED display run takes its own pass; the post run joins the eye', () => {
  const lr = { active: true, moved: { display: [9, 10], post: [11] }, lastRound: [{}, {}] };
  assert.deepEqual(cursorPickPlan([0, 1], lr, SKIP), { eye: [0, 1, 11], display: [9, 10] });
});

test('cursorPickPlan: an UNROUNDED display run (display rig declared, gain 1) draws through the photo views → the eye pass', () => {
  for (const lastRound of [null, [{}]]) {
    const lr = { active: true, moved: { display: [9], post: [11] }, lastRound };
    assert.deepEqual(cursorPickPlan([0], lr, SKIP), { eye: [0, 9, 11], display: [] });
  }
});

test('cursorPickPlan: skipped layers never enter either pass; no layer is picked twice', () => {
  const lr = { active: true, moved: { display: [4, 9, 9], post: [5, 0] }, lastRound: [{}, {}] };
  assert.deepEqual(cursorPickPlan([0, 1], lr, SKIP), { eye: [0, 1], display: [9] });
});

// ── displayRigPickSolver ──────────────────────────────────────────────────────────────────────

function rot(q, v) {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}
function pose(p, q) {
  const [x, y, z, w] = q;
  const m = new Float64Array(16);
  m[0] = 1 - 2 * (y * y + z * z); m[1] = 2 * (x * y + w * z); m[2] = 2 * (x * z - w * y);
  m[4] = 2 * (x * y - w * z); m[5] = 1 - 2 * (x * x + z * z); m[6] = 2 * (y * z + w * x);
  m[8] = 2 * (x * z + w * y); m[9] = 2 * (y * z - w * x); m[10] = 1 - 2 * (x * x + y * y);
  m[12] = p[0]; m[13] = p[1]; m[14] = p[2]; m[15] = 1;
  return m;
}
function projT(l, r, d, u, n = 0.01, f = 100) {
  const P = new Float64Array(16);
  P[0] = 2 / (l + r); P[8] = (r - l) / (l + r); P[5] = 2 / (u + d); P[9] = (u - d) / (u + d);
  P[10] = -(f + n) / (f - n); P[11] = -1; P[14] = (-2 * f * n) / (f - n);
  return P;
}
const q0 = [Math.sin(0.15), Math.sin(-0.1) * 0.3, 0, 0];
q0[3] = Math.sqrt(1 - q0[0] ** 2 - q0[1] ** 2);
const PHOTO = { type: 'camera', position: { x: 0.4, y: -0.3, z: 1.2 }, orientation: { x: q0[0], y: q0[1], z: q0[2], w: q0[3] }, convergenceDiopters: 1 / 2.4, verticalFov: (50 * Math.PI) / 180, metersToVirtual: 1 };
const SCREEN = { w: 0.3, h: 0.3 / (16 / 9) };
const NOM = 0.65;
function cameraView(e) {
  const rig = PHOTO, ro = Math.tan(rig.verticalFov / 2) * (SCREEN.w / SCREEN.h), uo = Math.tan(rig.verticalFov / 2);
  const el = [e[0], e[1], e[2] - NOM];
  const w = rot(q0, el);
  const s = el.map((x) => x * rig.convergenceDiopters), den = 1 + s[2];
  return { pose: pose([rig.position.x + w[0], rig.position.y + w[1], rig.position.z + w[2]], q0), proj: projT((ro + s[0]) / den, (ro - s[0]) / den, (uo + s[1]) / den, (uo - s[1]) / den) };
}
/** The runtime's display rig the photo rounds to (ipd = parallax = 1): the oracle for the stage's pixels. */
function displayView(e) {
  const D = 1 / PHOTO.convergenceDiopters, t = Math.tan(PHOTO.verticalFov / 2), f = rot(q0, [0, 0, -1]);
  const vdh = 2 * D * t, pf = SCREEN.h / (2 * NOM) / t, m2v = vdh / SCREEN.h, es = pf * m2v;
  const ez = e.map((x) => x * es), W = SCREEN.w * m2v, H = SCREEN.h * m2v;
  const w = rot(q0, ez), p = [PHOTO.position.x + D * f[0], PHOTO.position.y + D * f[1], PHOTO.position.z + D * f[2]];
  return { pose: pose([p[0] + w[0], p[1] + w[1], p[2] + w[2]], q0), proj: projT((W / 2 + ez[0]) / ez[2], (W / 2 - ez[0]) / ez[2], (H / 2 + ez[1]) / ez[2], (H / 2 - ez[1]) / ez[2]) };
}
const ap = (m, X) => [0, 1, 2].map((r) => m[r] * X[0] + m[4 + r] * X[1] + m[8 + r] * X[2] + m[12 + r]);
function ndc(P, V, X) {
  const c = mul4(P, V);
  const w = c[3] * X[0] + c[7] * X[1] + c[11] * X[2] + c[15];
  return [(c[0] * X[0] + c[4] * X[1] + c[8] * X[2] + c[12]) / w, (c[1] * X[0] + c[5] * X[1] + c[9] * X[2] + c[13]) / w];
}
/** A rig node with scale, rotation and translation (PlayCanvas composes RenderViews with it). */
const RIG = (() => {
  const m = pose([1.5, -0.25, 3], [0, Math.sin(0.2), 0, Math.cos(0.2)]);
  for (let i = 0; i < 12; i++) if (i % 4 !== 3) m[i] *= 2;
  return m;
})();
const invert = (m) => {
  // RIG = T · R · 2 (uniform): inverse = (1/2) Rᵀ · T⁻¹
  const o = invertRigid(m.map((x, i) => (i < 12 && i % 4 !== 3 ? x / 2 : x)));
  for (let i = 0; i < 12; i++) if (i % 4 !== 3) o[i] /= 2;
  for (let i = 12; i < 15; i++) o[i] /= 2;
  return o;
};

/** Stage points around the window, in front and behind it (rig space). */
function stagePoints() {
  const fr = cameraRigFrame(PHOTO);
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const r = rot(q0, [Math.sin(i * 1.7) * 0.5, Math.cos(i * 2.3) * 0.3, (i % 5) * 0.25 - 0.4]);
    pts.push(fr.N0.map((v, a) => v + fr.D * fr.fwd[a] + r[a]));
  }
  return pts;
}

test('displayRigPickSolver: a stage hit lands where the PHOTO views show it — same pixels in both eyes (vs the runtime display-rig oracle)', () => {
  const fr = cameraRigFrame(PHOTO);
  const k = layerRigGain(fr, { viewerDistance: NOM });
  assert.ok(Math.abs(k - 1) > 0.5, 'a real rounding');
  // Level heads (exact), a head closer to the glass and off-centre, three views, and a head
  // leaning out of level (eye 0 still exact, the last eye within ~1e-3 NDC: no point matches a vertical disparity).
  for (const [eyes, epsL] of [
    [[[-0.032, 0, NOM], [0.032, 0, NOM]], 1e-6],
    [[[0.05, 0.03, 0.55], [0.114, 0.03, 0.55]], 1e-6],
    [[[-0.04, 0, NOM], [0, 0, NOM], [0.04, 0, NOM]], 1e-6],
    [[[0.05, 0.03, 0.55], [0.114, 0.035, 0.56]], 2e-3],
  ]) {
    const entries = eyes.map(cameraView);
    const round = roundViews(entries, fr, k);
    const solve = displayRigPickSolver(entries[0].proj, round, entries.map((e) => e.pose), RIG);
    const L = eyes.length - 1;
    for (const X of stagePoints()) {
      // The pick sample: round eye 0's pixel and view distance for X.
      const [x, y] = ndc(entries[0].proj, round[0].view, X);
      const dist = -ap(round[0].view, X)[2];
      const Yw = solve((x + 1) / 2, (1 - y) / 2, dist);
      assert.ok(Yw, 'a point');
      const Y = ap(invert(RIG), Yw);
      for (const i of [0, L]) {
        const want = ndc(displayView(eyes[i]).proj, invertRigid(displayView(eyes[i]).pose), X); // where the panel shows the stage
        const got = ndc(entries[i].proj, invertRigid(entries[i].pose), Y); // where the cursor's photo views put Y
        near(got[0], want[0], i ? epsL : 1e-9, `eye ${i} x`);
        near(got[1], want[1], i ? epsL : 1e-9, `eye ${i} y`);
      }
    }
  }
});

test('displayRigPickSolver: no rounding (round view = photo view) → the plain off-axis ray rebuild, through the rig node', () => {
  const entries = [[-0.032, 0, NOM], [0.032, 0, NOM]].map(cameraView);
  const same = entries.map((e) => ({ view: invertRigid(e.pose), viewInv: e.pose }));
  const solve = displayRigPickSolver(entries[0].proj, same, entries.map((e) => e.pose), RIG);
  for (const X of stagePoints()) {
    const [x, y] = ndc(entries[0].proj, same[0].view, X);
    const Yw = solve((x + 1) / 2, (1 - y) / 2, -ap(same[0].view, X)[2]);
    const want = ap(RIG, X);
    for (let a = 0; a < 3; a++) near(Yw[a], want[a], 1e-6, 'X itself, in world');
  }
});

test('displayRigPickSolver: degenerate input → null (one view, a non-positive distance)', () => {
  const entries = [[-0.032, 0, NOM], [0.032, 0, NOM]].map(cameraView);
  const same = entries.map((e) => ({ view: invertRigid(e.pose), viewInv: e.pose }));
  assert.equal(displayRigPickSolver(entries[0].proj, same.slice(0, 1), [entries[0].pose], RIG), null);
  const solve = displayRigPickSolver(entries[0].proj, same, entries.map((e) => e.pose), RIG);
  assert.equal(solve(0.5, 0.5, 0), null);
  assert.equal(solve(0.5, 0.5, -1), null);
});

// ── the ShaderMaterial opt-in snippets ───────────────────────────────────────────────────────

test('CURSOR_DEPTH_PICK_GLSL / _WGSL: the engine pickPS, the id to target 0, the depth to target 1 under DEPTH_PICK_PASS', () => {
  for (const [s, c0, c1] of [[CURSOR_DEPTH_PICK_GLSL, 'pcFragColor0', 'pcFragColor1'], [CURSOR_DEPTH_PICK_WGSL, 'output.color', 'output.color1']]) {
    assert.ok(Object.isFrozen(s));
    assert.match(s.declarations, /#ifdef PICK_PASS\s+#include "pickPS"\s+#endif/);
    assert.match(s.output, new RegExp(`^${c0.replace('.', '\\.')} = getPickOutput\\(\\);`));
    // What the pick pass looks for to keep a ShaderMaterial in (js/inline3d-cursor-depth-playcanvas.js).
    assert.match(s.output, /#ifdef DEPTH_PICK_PASS\s+\S+ = getPickDepth\(\);\s+#endif/);
    assert.ok(s.output.includes(`${c1} = getPickDepth();`));
  }
});

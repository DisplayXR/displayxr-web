// The rig map (js/inline3d-splat-rig-map.js): a view set located for one camera rig, remapped to
// another, must put every point exactly where the other rig's OWN views put it. The oracle below
// is the runtime's camera rig (displayxr-common dxr_camera3d_compute_views: eye factors about the
// nominal viewer, then the portal), written independently of the module under test.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cameraPortal,
  remapViews,
  mapEyes,
  viewsResidual,
  RigTracker,
  RIG_MATCH_TOL,
  rigSnapshot,
  sameRig,
  invertAffine,
  nodePose,
} from '../js/inline3d-splat-rig-map.js';

const N = 0.6; // nominal viewer distance (the oracle's; the map never needs it)
const ASPECT = 16 / 9;

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
function projT(l, r, d, u, n = 0.1, f = 100) {
  const P = new Float64Array(16);
  P[0] = 2 / (l + r); P[8] = (r - l) / (l + r); P[5] = 2 / (u + d); P[9] = (u - d) / (u + d);
  P[10] = -(f + n) / (f - n); P[11] = -1; P[14] = (-2 * f * n) / (f - n);
  return P;
}
/** The runtime: camera-rig views for physical eyes `eyes` (display space, metres). */
function locate(rig, eyes) {
  const m = rig.metersToVirtual ?? 1, invd = rig.convergenceDiopters, t = Math.tan(rig.verticalFov / 2);
  const ipd = rig.ipdFactor ?? 1, par = rig.parallaxFactor ?? 1;
  const c = [0, 1, 2].map((k) => eyes.reduce((s, e) => s + e[k], 0) / eyes.length);
  const q = [rig.orientation.x, rig.orientation.y, rig.orientation.z, rig.orientation.w];
  return eyes.map((e, i) => {
    const pr = [par * c[0] + (e[0] - c[0]) * ipd, par * c[1] + (e[1] - c[1]) * ipd, N + par * (c[2] - N) + (e[2] - c[2]) * ipd];
    const el = [m * pr[0], m * pr[1], m * (pr[2] - N)];
    const w = rot(q, el);
    const s = [el[0] * invd, el[1] * invd, el[2] * invd], den = 1 + s[2];
    const ro = t * ASPECT;
    return {
      pose: pose([rig.position.x + w[0], rig.position.y + w[1], rig.position.z + w[2]], q),
      proj: projT((ro + s[0]) / den, (ro - s[0]) / den, (t + s[1]) / den, (t - s[1]) / den),
      x: i * 640, y: 0, width: 640, height: 720,
    };
  });
}
function mulv(M, X) {
  return [0, 1, 2, 3].map((r) => M[r] * X[0] + M[4 + r] * X[1] + M[8 + r] * X[2] + M[12 + r] * (X[3] ?? 1));
}
/** NDC (x, y, z) of world point X through (proj, view). */
function ndc(proj, view, X) {
  const c = mulv(proj, mulv(view, X));
  return [c[0] / c[3], c[1] / c[3], c[2] / c[3]];
}
function normQ(q) {
  const n = Math.hypot(...q);
  return { x: q[0] / n, y: q[1] / n, z: q[2] / n, w: q[3] / n };
}
// a deterministic PRNG
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const between = (a, b) => a + (b - a) * rnd();

function randomRig() {
  return {
    type: 'camera',
    position: { x: between(-1, 1), y: between(-1, 1), z: between(-1, 1) },
    orientation: normQ([between(-0.3, 0.3), between(-0.3, 0.3), between(-0.3, 0.3), 1]),
    convergenceDiopters: 1 / between(0.3, 4),
    verticalFov: between(0.5, 1.2),
    metersToVirtual: between(0.5, 3),
    ipdFactor: between(0.3, 1.5),
    parallaxFactor: between(0.3, 1.5),
  };
}
function randomEyes() {
  const cx = between(-0.08, 0.08), cy = between(-0.05, 0.05), cz = between(0.45, 0.8), h = between(0.028, 0.035);
  const tilt = between(-0.004, 0.004);
  return [[cx - h, cy - tilt, cz + tilt], [cx + h, cy + tilt, cz - tilt]];
}
/** A world point in front of rig R, at a multiple k of its convergence distance. */
function pointIn(rig, k) {
  const q = [rig.orientation.x, rig.orientation.y, rig.orientation.z, rig.orientation.w];
  const D = 1 / rig.convergenceDiopters, t = Math.tan(rig.verticalFov / 2);
  const local = [between(-0.8, 0.8) * t * ASPECT * k * D, between(-0.8, 0.8) * t * k * D, -k * D];
  const w = rot(q, local);
  return [rig.position.x + w[0], rig.position.y + w[1], rig.position.z + w[2]];
}
function inv(m) {
  const o = invertAffine(m);
  assert.ok(o, 'singular');
  return o;
}

test('remapped views put every point exactly where the target rig\'s own views do (x, y AND depth planes)', () => {
  for (let trial = 0; trial < 60; trial++) {
    const F = randomRig();
    const T = randomRig();
    const eyes = randomEyes();
    const vf = locate(F, eyes);
    const vt = locate(T, eyes);
    const r = remapViews(vf, cameraPortal(F), cameraPortal(T));
    assert.ok(r, 'a map exists');
    for (let i = 0; i < eyes.length; i++) {
      // the eye the views are drawn from IS the target rig's eye
      for (let k = 0; k < 3; k++) assert.ok(Math.abs(r[i].eye[k] - vt[i].pose[12 + k]) < 1e-9, `eye ${i}.${k}`);
      assert.ok(Math.abs(r[i].viewInv[12] - vt[i].pose[12]) < 1e-9);
      for (const k of [0.3, 0.7, 1, 1.6, 3, 8]) {
        const X = pointIn(T, k);
        const a = ndc(r[i].proj, r[i].view, X);
        const b = ndc(vt[i].proj, inv(vt[i].pose), X);
        assert.ok(Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9, `trial ${trial} view ${i} k ${k}: ${a} vs ${b}`);
      }
      // the target's near/far planes land at NDC z = −1 / +1 (the runtime's near/far survive)
      const q = [T.orientation.x, T.orientation.y, T.orientation.z, T.orientation.w];
      const fwd = rot(q, [0, 0, -1]);
      const E = vt[i].pose;
      for (const [d, z] of [[0.1, -1], [100, 1]]) {
        const X = [E[12] + d * fwd[0], E[13] + d * fwd[1], E[14] + d * fwd[2]];
        assert.ok(Math.abs(ndc(r[i].proj, r[i].view, X)[2] - z) < 1e-6, `depth plane ${d}`);
      }
    }
  }
});

test('the case at hand: two photos\' camera rigs differing in convergence and vertical FOV, nominal eyes', () => {
  const at = { x: 0, y: 0, z: 0 }, id = { x: 0, y: 0, z: 0, w: 1 };
  const A = { type: 'camera', position: at, orientation: id, convergenceDiopters: 1 / 1.6829, verticalFov: 0.8985, metersToVirtual: 1, ipdFactor: 1, parallaxFactor: 1 };
  const B = { type: 'camera', position: at, orientation: id, convergenceDiopters: 1 / 0.4069, verticalFov: 0.9435, metersToVirtual: 1, ipdFactor: 1, parallaxFactor: 1 };
  const eyes = [[-0.032, 0, N], [0.032, 0, N]];
  const vb = locate(B, eyes);
  const va = locate(A, eyes);
  const r = remapViews(vb, cameraPortal(B), cameraPortal(A));
  // a point 3·D behind A's plane keeps its disparity (the pre-1.24 chain scaled it by ≈4)
  const X = [0.2, -0.1, -3 * 1.6829];
  const px = (P, V) => (ndc(P, V, X)[0] * 0.5 + 0.5) * 640;
  const disp = px(r[0].proj, r[0].view) - px(r[1].proj, r[1].view);
  const want = px(va[0].proj, inv(va[0].pose)) - px(va[1].proj, inv(va[1].pose));
  assert.ok(Math.abs(disp - want) < 1e-6, `${disp} vs ${want}`);
  assert.ok(Math.abs(want) > 1, 'the point has real disparity');
});

test('mapEyes: the target rig\'s eyes from the source views, factors and metersToVirtual included', () => {
  for (let trial = 0; trial < 30; trial++) {
    const F = randomRig();
    const T = randomRig();
    const eyes = randomEyes();
    const got = mapEyes(locate(F, eyes), cameraPortal(F), cameraPortal(T));
    const want = locate(T, eyes);
    for (let i = 0; i < 2; i++) for (let k = 0; k < 3; k++) assert.ok(Math.abs(got[i][k] - want[i].pose[12 + k]) < 1e-9);
  }
});

test('locate: the views say which declared rig they were located for; none within tolerance → null', () => {
  const rt = new RigTracker();
  const A = randomRig();
  const B = randomRig();
  rt.note({ type: 'display', virtualDisplayHeight: 0.24 });
  const a = rt.note(A);
  const b = rt.note(B);
  const eyes = randomEyes();
  // float32, as the browser hands them over
  const f32 = (vs) => vs.map((v) => ({ ...v, pose: Float32Array.from(v.pose), proj: Float32Array.from(v.proj) }));
  assert.equal(rt.locate(f32(locate(A, eyes))), a);
  assert.equal(rt.locate(f32(locate(B, eyes))), b);
  assert.ok(rt.lastResidual < RIG_MATCH_TOL / 10);
  assert.equal(rt.latest, b);
  // a rig the runtime CLAMPED (convergence 0.5 % off what we declared): unknown, not "nearest"
  assert.equal(rt.locate(locate({ ...B, convergenceDiopters: B.convergenceDiopters * 1.005 }, eyes)), null);
  // vertical FOV alone differs: still told apart
  assert.equal(rt.locate(locate({ ...B, verticalFov: B.verticalFov * 1.002 }, eyes)), null);
  // the eye factors do not show in the views (any eyes fit a window): a rig that differs from a
  // declared one ONLY in them matches it — and between two such declared rigs, `prefer` (the rig
  // declared when the views were pulled) decides, else the newest
  const B2 = rt.note({ ...B, ipdFactor: B.ipdFactor * 1.1 });
  const vB = f32(locate(B, eyes));
  assert.equal(rt.locate(vB), B2, 'same window: the newest');
  assert.equal(rt.locate(vB, b), b, 'same window: the preferred');
  assert.equal(rt.locate(f32(locate(A, eyes)), B2), a, 'a preference never beats a different window');
  // the window moved only vertically (the rig raised 1 mm), or only rolled (0.2°) about its axis
  const nominal = [[-0.032, 0, N], [0.032, 0, N]];
  const rt2 = new RigTracker();
  rt2.note(B);
  assert.equal(rt2.locate(locate({ ...B, position: { ...B.position, y: B.position.y + 1e-3 } }, nominal)), null);
  const qB = [B.orientation.x, B.orientation.y, B.orientation.z, B.orientation.w];
  const s = Math.sin(0.0017), c = Math.cos(0.0017); // roll: qB · (0, 0, s, c)
  const roll = normQ([qB[3] * 0 + qB[0] * c + qB[1] * s - qB[2] * 0, qB[3] * 0 + qB[1] * c + qB[2] * 0 - qB[0] * s, qB[3] * s + qB[2] * c + qB[0] * 0 - qB[1] * 0, qB[3] * c - qB[2] * s]);
  assert.equal(rt2.locate(locate({ ...B, orientation: roll }, [[0, -0.001, N], [0, 0.001, N]])), null, 'roll');
  // rotation differs
  assert.equal(rt.locate(locate({ ...B, orientation: normQ([B.orientation.x + 0.01, B.orientation.y, B.orientation.z, B.orientation.w]) }, eyes)), null);
});

test('RigTracker: declarations by value, deduplicated, bounded; the in-place rewrite of a descriptor is not aliased', () => {
  const rt = new RigTracker({ history: 3 });
  const obj = randomRig();
  const e1 = rt.note(obj);
  assert.equal(rt.note({ ...obj }), e1, 'same values: same entry');
  obj.convergenceDiopters *= 2; // the SDK rewrites its camera-rig object in place
  const e2 = rt.note(obj);
  assert.notEqual(e2, e1);
  assert.notEqual(e1.rig.convergenceDiopters, e2.rig.convergenceDiopters, 'the old snapshot kept its value');
  rt.note(randomRig());
  rt.note(randomRig());
  assert.equal(rt.rigs.length, 3);
  assert.ok(!rt.rigs.includes(e1));
});

test('identity and non-camera rigs: nothing to remap', () => {
  const A = randomRig();
  const P = cameraPortal(A);
  assert.equal(remapViews(locate(A, randomEyes()), P, P), null);
  assert.equal(cameraPortal({ type: 'display', virtualDisplayHeight: 0.24 }), null);
  assert.equal(cameraPortal({ ...A, convergenceDiopters: 0 }), null, 'convergence at infinity: no window');
  assert.equal(cameraPortal({ ...A, ipdFactor: 0 }), null, 'a zero factor cannot be inverted');
  assert.ok(sameRig(rigSnapshot(A), rigSnapshot({ ...A })));
  assert.ok(!sameRig(rigSnapshot(A), rigSnapshot({ ...A, verticalFov: A.verticalFov + 1e-6 })));
  assert.equal(viewsResidual(locate(A, randomEyes()), null), Infinity);
});

test('an eye at or behind a window: no map (the caller keeps its path)', () => {
  const A = randomRig();
  const B = { ...randomRig(), convergenceDiopters: 1 / 0.05, metersToVirtual: 3 };
  // eyes leaning 0.1 m toward the glass: B's eye (m·Δz = −0.3) lands behind its window (D = 0.05)
  const eyes = [[-0.03, 0, N - 0.1], [0.03, 0, N - 0.1]];
  assert.equal(remapViews(locate(A, eyes), cameraPortal(A), cameraPortal(B)), null);
});

test('nodePose is rigid, on the eye, with the rig\'s axes', () => {
  const A = randomRig();
  const P = cameraPortal(A);
  const m = nodePose(P, [1, 2, 3]);
  assert.deepEqual([m[12], m[13], m[14]], [1, 2, 3]);
  const c0 = [m[0], m[1], m[2]], c1 = [m[4], m[5], m[6]];
  assert.ok(Math.abs(Math.hypot(...c0) - 1) < 1e-12 && Math.abs(c0[0] * c1[0] + c0[1] * c1[1] + c0[2] * c1[2]) < 1e-12);
});

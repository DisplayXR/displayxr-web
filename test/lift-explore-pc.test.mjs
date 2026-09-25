// Tests for the PlayCanvas explore renderer's pure half (js/lift/orbit.js, js/lift/explore-gl.js): the camera-side orbit
// is the same picture as the Spark renderer's content-side orbit, the depth modifier's λ, the
// comfort scale, the footprint patch agreeing with the SDK adapter's, and the tracked-eyes head
// tracker. No engine (js/lift/explore.js itself imports playcanvas).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  orbitRig,
  rigApply,
  rotationOfQuat,
  perspectiveOffAxis,
  liftLambda,
  comfortScale,
  PIVOT_TARGET_M,
  createHeadTracker,
  rigFromMeta,
  frustumFor,
} from '../js/lift/orbit.js';
import { patchGsplatFootprint, LIFT_MODIFY_VS } from '../js/lift/explore-gl.js';
import { patchGsplatFootprint as sdkPatch } from '../js/inline3d-splat-playcanvas.js';

const DEG = Math.PI / 180;
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

/** Spark's content transform: T(F)·Ry(yaw)·Rx(pitch)·T(−F), applied to a point. */
function sparkContent(yaw, pitch, D, p) {
  const [cy, sy, cp, sp] = [Math.cos(yaw * DEG), Math.sin(yaw * DEG), Math.cos(pitch * DEG), Math.sin(pitch * DEG)];
  let x = p.x, y = p.y, z = p.z + D; // T(−F), F = (0,0,−D)
  // Rx(pitch)
  [y, z] = [cp * y - sp * z, sp * y + cp * z];
  // Ry(yaw)
  [x, z] = [cy * x + sy * z, -sy * x + cy * z];
  return { x, y, z: z - D };
}

test('orbitRig: the eyes carrying the inverse orbit see exactly what Spark saw with the content turned', () => {
  const D = 2.3;
  for (const [yaw, pitch] of [[0, 0], [15, 0], [-10, 7], [4, -15]]) {
    const rig = orbitRig(yaw, pitch, D);
    for (const eye of [{ x: 0, y: 0, z: 0 }, { x: 0.0315, y: 0.1, z: -0.05 }]) {
      for (const p of [{ x: 0.3, y: -0.2, z: -1.4 }, { x: -1, y: 0.5, z: -4 }]) {
        // Spark: eye-space = (content(p) − eye)
        const c = sparkContent(yaw, pitch, D, p);
        const a = { x: c.x - eye.x, y: c.y - eye.y, z: c.z - eye.z };
        // PlayCanvas: the eye's world pose = rig·T(eye); eye-space = inverse(pose)·p
        const eyeW = rigApply(rig, eye);
        const R = rotationOfQuat(rig.rotation);
        const d = { x: p.x - eyeW.x, y: p.y - eyeW.y, z: p.z - eyeW.z };
        const b = { x: R[0] * d.x + R[1] * d.y + R[2] * d.z, y: R[4] * d.x + R[5] * d.y + R[6] * d.z, z: R[8] * d.x + R[9] * d.y + R[10] * d.z };
        for (const k of ['x', 'y', 'z']) assert.ok(near(a[k], b[k], 1e-12), `${yaw},${pitch} ${k}: ${a[k]} vs ${b[k]}`);
      }
    }
  }
});

test('orbitRig: the pivot point F never moves', () => {
  const D = 1.7;
  const rig = orbitRig(12, -9, D);
  const f = rigApply(rig, { x: 0, y: 0, z: -D });
  assert.ok(near(f.x, 0, 1e-12) && near(f.y, 0, 1e-12) && near(f.z, -D, 1e-12));
});

test('perspectiveOffAxis matches the frustum edges (three makePerspective layout)', () => {
  const rig = rigFromMeta({ focalPx: 800, pivotZ: 2, w: 1000, h: 600 });
  const f = frustumFor(rig, { x: 0.03, y: 0.1, z: 0 });
  const P = perspectiveOffAxis(f.l, f.r, f.t, f.b, 0.02, 5000);
  // a point on the window's right edge at the pivot projects to NDC x = +1
  const x = rig.halfW, y = 0, z = -rig.dPivot;
  const ex = x - 0.03, ey = y - 0.1;
  const clipX = P[0] * ex + P[8] * z, clipW = -z;
  assert.ok(near(clipX / clipW, 1, 1e-5)); // Float32 matrix
  const clipY = P[5] * ey + P[9] * z;
  assert.ok(Math.abs(clipY / clipW) < 1);
  assert.equal(P[11], -1);
});

test('liftLambda: identity at s = 1, pivot plane fixed, flat at s = 0 seen from the origin', () => {
  const o = { x: 0, y: 0, z: 0 };
  const D = 2;
  for (const c of [{ x: 0.1, y: 0.2, z: -1 }, { x: -1, y: 0, z: -5 }]) {
    assert.ok(near(liftLambda(c, o, D, 1), 1, 1e-12));
    const l0 = liftLambda(c, o, D, 0);
    assert.ok(near(-c.z * l0, D, 1e-12)); // every splat lands on the pivot plane
  }
  assert.ok(near(liftLambda({ x: 0, y: 0, z: -D }, o, D, 0.3), 1, 1e-12));
  // behind the centre of projection: untouched
  assert.equal(liftLambda({ x: 0, y: 0, z: 0.5 }, o, D, 0.3), 1);
  // the shader declares the uniforms the JS drives
  for (const u of ['uLiftS', 'uLiftO', 'uLiftD', 'uLiftFade']) assert.ok(LIFT_MODIFY_VS.includes(u));
});

test('comfortScale: metric scenes off target are brought to it; everything else untouched', () => {
  assert.equal(PIVOT_TARGET_M, 2);
  assert.equal(comfortScale({ pivotZ: 10 }, { space: 'metric' }), 0.2);
  assert.equal(comfortScale({ pivotZ: 1 }, { space: 'metric' }), 2);
  assert.equal(comfortScale({ pivotZ: 2.4 }, { space: 'metric' }), 1); // within 25 %
  assert.equal(comfortScale({ pivotZ: 2.6 }, { space: 'metric' }), 2 / 2.6);
  assert.equal(comfortScale({ pivotZ: 10 }, { space: 'disparity' }), 1);
  assert.equal(comfortScale({ pivotZ: 10 }, { space: 'metric', mode: 'off' }), 1);
  assert.equal(comfortScale({ pivotZ: 2.2 }, { space: 'disparity', mode: 'always' }), 2 / 2.2);
  assert.equal(comfortScale({ pivotZ: -8 }, { space: 'metric', target: 4 }), 0.5); // OpenGL-signed pivot
  assert.equal(comfortScale({ pivotZ: 10, space: 'metric' }), 0.2); // meta.space
  // the neutral view is unchanged: the rig's window scales with the pivot, so its angular size holds
  const m = { focalPx: 700, pivotZ: 10, w: 900, h: 600 };
  const k = comfortScale(m, { space: 'metric' });
  const a = rigFromMeta(m), b = rigFromMeta({ ...m, pivotZ: m.pivotZ * k });
  assert.ok(near(a.halfW / a.dPivot, b.halfW / b.dPivot, 1e-12));
});

test('patchGsplatFootprint is the SDK adapter\'s, byte for byte', () => {
  const src =
    'vec3 vp = camera_params.w == 1.0 ? vec3(0.0, 0.0, 1.0) : v;\n\tfloat J1 = focal / vp.z;\n\tvec2 J2 = -J1 / vp.z * vp.xy;\n\tmat3 J = mat3(\n\t\tJ1, 0.0, J2.x,\n\t\t0.0, J1, J2.y,\n\t\t0.0, 0.0, 0.0\n\t);';
  assert.deepEqual(patchGsplatFootprint(src), sdkPatch(src));
  assert.ok(patchGsplatFootprint(src).ok);
  assert.deepEqual(patchGsplatFootprint('nope'), sdkPatch('nope'));
});

test('head tracker eyes:"tracked" keeps the runtime separation (metres as given)', () => {
  const nominal = createHeadTracker({});
  const tracked = createHeadTracker({ metresPerUnit: 1 });
  const views = [{ x: -0.029, y: 0.1, z: 0.6 }, { x: 0.029, y: 0.1, z: 0.6 }];
  let n, t;
  for (let i = 0; i < 12; i++) {
    n = nominal.update(views);
    t = tracked.update(views);
  }
  assert.ok(near(n.eyes[1].x - n.eyes[0].x, 0.063, 1e-12));
  assert.ok(near(t.eyes[1].x - t.eyes[0].x, 0.058, 1e-12));
  assert.equal(tracked.metresPerUnit, 1);
});

// groundPlaneRig (web#274): a suggested ground-plane camera rig for a tilted top-down view, and
// what it does on a given panel. Guideline only — it returns numbers. Pinned against independent
// arithmetic: ray/ground intersection for the edge depths, cameraRigDisparityPct for the on-glass
// disparity, and plugging minHeight back in.

import test from 'node:test';
import assert from 'node:assert/strict';

import { groundPlaneRig, cameraRigDisparityPct, comfortZone } from '../js/inline3d-depth-budget.js';

const near = (a, b, eps, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} != ${b}`);
const RAD = Math.PI / 180;

// On-glass disparity (m) of a point at view-axis depth z, from the SDK's existing camera-rig formula.
function pctToM(z, d, fov, H, ipd = 1, m2v = 1) {
  const aspect = 1.5;
  return (cameraRigDisparityPct({ z, convergence: d, verticalFov: fov, aspect, ipdFactor: ipd, metersToVirtual: m2v }) / 100) * aspect * H;
}

// Where the ray at angle a above the axis meets the ground, as a view-axis depth (independent of the helper).
function groundDepth(h, tilt, a) {
  const fromVertical = tilt + a;
  const slant = h / Math.cos(fromVertical);
  return slant * Math.cos(a);
}

const BASE = { height: 10, tiltDeg: 35, fovDeg: 45, tileHeightM: 0.2, viewerM: 0.45, objectHeight: 2 };

test('convergence is the ground at the view centre, d = h / cos(tilt)', () => {
  const r = groundPlaneRig(BASE);
  near(r.convergence, 10 / Math.cos(35 * RAD), 1e-12);
  near(r.convergenceDiopters, 1 / r.convergence, 1e-15);
  near(r.verticalFov, 45 * RAD, 1e-15);
  assert.equal(groundPlaneRig({ ...BASE, fovDeg: undefined, verticalFov: 45 * RAD }).convergence, r.convergence);
});

test('edge inverse-depth ratios match a ray/ground intersection', () => {
  const r = groundPlaneRig(BASE);
  const d = r.convergence;
  const half = 22.5 * RAD;
  near(r.report.nearEdgeInvDepthRatio, d / groundDepth(10, 35 * RAD, -half), 1e-9, 'bottom edge');
  near(r.report.farEdgeInvDepthRatio, d / groundDepth(10, 35 * RAD, half), 1e-9, 'top edge');
  assert.equal(r.report.horizonInView, false);
});

test('disparities agree with cameraRigDisparityPct and carry the canvas-size factor', () => {
  const r = groundPlaneRig(BASE);
  const d = r.convergence;
  const fov = 45 * RAD;
  const half = 22.5 * RAD;
  const zn = groundDepth(10, 35 * RAD, -half);
  const zf = groundDepth(10, 35 * RAD, half);
  near(r.report.groundNearMm, 1000 * pctToM(zn, d, fov, 0.2), 1e-9);
  near(r.report.groundFarMm, 1000 * pctToM(zf, d, fov, 0.2), 1e-9);
  assert.ok(r.report.groundNearMm < 0 && r.report.groundFarMm > 0, 'near edge in front, far edge behind');
  const zObj = zn - 2 * Math.cos(35 * RAD);
  near(r.report.objectNearMm, 1000 * pctToM(zObj, d, fov, 0.2), 1e-9);
  // Half the canvas height, half the disparity: the factor a canvas-blind formula misses.
  const small = groundPlaneRig({ ...BASE, tileHeightM: 0.1 });
  near(small.report.groundNearMm, r.report.groundNearMm / 2, 1e-9);
  // ipdFactor and metersToVirtual scale it linearly.
  near(groundPlaneRig({ ...BASE, ipdFactor: 2 }).report.groundNearMm, 2 * r.report.groundNearMm, 1e-9);
});

test('perceived pop-out / recession from the disparity at the viewer distance', () => {
  const r = groundPlaneRig(BASE);
  const e = 0.063;
  const p = -r.report.objectNearMm / 1000;
  near(r.report.popOutMmNearEdge, (1000 * 0.45 * p) / (e + p), 1e-9);
  const q = r.report.groundFarMm / 1000;
  near(r.report.recessionMmFarEdge, (1000 * 0.45 * q) / (e - q), 1e-9);
});

test('minHeight: at that height the near-edge object sits exactly on the budget', () => {
  for (const extra of [{}, { maxPopOutMm: 20 }, { objectHeight: 0 }, { zone: 'percival' }]) {
    const opts = { ...BASE, ...extra };
    const r = groundPlaneRig(opts);
    assert.ok(r.minHeight > 0);
    const at = groundPlaneRig({ ...opts, height: r.minHeight });
    near(-at.report.objectNearMm, at.report.budgetMm, 1e-6, JSON.stringify(extra));
    // Higher is inside the budget, lower is outside.
    assert.ok(-groundPlaneRig({ ...opts, height: r.minHeight * 1.1 }).report.objectNearMm < at.report.budgetMm);
    assert.ok(-groundPlaneRig({ ...opts, height: r.minHeight * 0.9 }).report.objectNearMm > at.report.budgetMm);
  }
  const z = groundPlaneRig(BASE);
  near(z.report.budgetMm, comfortZone({ viewerM: 0.45 }).frontMm, 1e-9, 'default budget = the zone front side');
  const m = groundPlaneRig({ ...BASE, maxPopOutMm: 20 });
  near(groundPlaneRig({ ...BASE, maxPopOutMm: 20, height: m.minHeight }).report.popOutMmNearEdge, 20, 1e-6, 'perceived budget');
  assert.equal(m.report.budgetSource, 'maxPopOutMm');
});

test('ipdFactorForBudget puts the near-edge object on the budget at this height', () => {
  const r = groundPlaneRig(BASE);
  const at = groundPlaneRig({ ...BASE, ipdFactor: r.ipdFactorForBudget });
  near(-at.report.objectNearMm, at.report.budgetMm, 1e-9);
});

test('top-down (tilt 0): the flat ground is all on the glass', () => {
  const r = groundPlaneRig({ ...BASE, tiltDeg: 0, objectHeight: 0 });
  near(r.report.groundNearMm, 0, 1e-12);
  near(r.report.groundFarMm, 0, 1e-12);
  assert.equal(r.ipdFactorForBudget, null, 'nothing pops out');
});

test('horizon in view: far edge recedes without bound', () => {
  const r = groundPlaneRig({ ...BASE, tiltDeg: 75 });
  assert.equal(r.report.horizonInView, true);
  assert.ok(r.report.farEdgeInvDepthRatio <= 0);
  assert.ok(r.report.groundFarMm > 0);
});

test('no canvas height: geometry only, physical fields unknown — never guessed', () => {
  const r = groundPlaneRig({ ...BASE, tileHeightM: undefined });
  assert.ok(r.convergence > 0);
  assert.ok(Number.isNaN(r.report.groundNearMm));
  assert.equal(r.minHeight, null);
  assert.ok(Number.isNaN(r.report.comfortFactor));
  assert.equal(r.basis.tileHeightM, null);
});

test('invalid input is null', () => {
  assert.equal(groundPlaneRig({ ...BASE, height: 0 }), null);
  assert.equal(groundPlaneRig({ ...BASE, tiltDeg: 90 }), null);
  assert.equal(groundPlaneRig({ ...BASE, fovDeg: undefined }), null);
  assert.equal(groundPlaneRig(), null);
});

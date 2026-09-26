// ONE depth budget for live and explore (docs/lift.md § Depth budget): at strength 1 the explore
// scene's fg–bg parallax between the NOMINAL eye pair equals depthBudget × the photo width — the
// native module's live SBS budget — and strength scales it linearly.
//
// The parallax is MEASURED through the explore renderer's own geometry, independently of the
// closed-form budgetSpread(): the rig (rigFromMeta, comfort-scaled pivot as explore builds it),
// the shader's depth remap (LIFT_MODIFY_VS: t' = D + S·(t − D) along the ray from the camera) and
// the off-axis frustum per eye (frustumFor) → NDC x → fraction of the window width.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  rigFromMeta,
  frustumFor,
  comfortScale,
  depthGainForBudget,
  depthRangeFromCenters,
  budgetSpread,
  DEPTH_BUDGET_DEFAULT,
  IPD_M,
  NEAR,
} from '../js/lift/orbit.js';
import { normaliseDisparity, budgetInvRange, LIFT_DEFAULTS } from '../js/lift/gen/lift-gen.js';
import { parseNativeCaps } from '../js/lift/native.js';

/** Measured fg–bg parallax (fraction of the window width) of points at distances near/far (the
 *  lift's own metres), for gain S, as explore renders them. */
function measure({ meta, space, near, far, S }) {
  const k = comfortScale(meta, { space });
  const rig = rigFromMeta({ ...meta, pivotZ: meta.pivotZ * k }, 'opencv');
  const D = rig.dPivot;
  const xOnScreen = (z, eyeX) => {
    const t = k * z; // camera distance in the scaled scene
    const tp = D + (t - D) * S; // LIFT_MODIFY_VS liftLambda with the origin at the camera
    const X = 0; // an on-axis point; λ keeps it on its ray (X stays 0)
    const fr = frustumFor(rig, { x: eyeX, y: 0, z: 0 }, rig);
    const xn = ((X - eyeX) * NEAR) / tp;
    return (2 * xn - (fr.r + fr.l)) / (fr.r - fr.l); // NDC x
  };
  const disp = (z) => (xOnScreen(z, IPD_M / 2) - xOnScreen(z, -IPD_M / 2)) / 2; // fraction of width
  return { spread: Math.abs(disp(near) - disp(far)), k, D, rig };
}

const within = (a, b, tol = 0.02) => Math.abs(a - b) <= tol * Math.abs(b);

/** A synthetic relative-disparity map: a near disc (the subject) on a sloped far wall. */
function syntheticDepth(w = 160, h = 90) {
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const r = Math.hypot((x - w / 2) / w, (y - h / 2) / h);
      data[y * w + x] = r < 0.18 ? 0.9 - r : 0.15 + 0.2 * (y / h); // bigger = nearer
    }
  return { data, w, h, space: 'disparity' };
}

/** What generateLift does with a relative scene under a budget (sizes, range, pivot seed, meta). */
function relativeLift(budget, W = 1024, f = 1.2 * 1024) {
  const depth = syntheticDepth();
  const P = { ...LIFT_DEFAULTS, depthBudget: budget };
  let { invFar, invNear, pivotLo } = normaliseDisparity(depth, 'disparity', P);
  const before = { invFar, invNear, invP: invFar + pivotLo * (invNear - invFar) };
  ({ invFar, invNear } = budgetInvRange({ invFar, invNear, pivotLo, budget, W, f }));
  const pivotZ = 1 / (invFar + pivotLo * (invNear - invFar));
  const meta = { focalPx: f, w: W, h: Math.round(W * 9 / 16), pivotZ, depthRange: { near: 1 / invNear, far: 1 / invFar } };
  return { meta, before, pivotLo, invFar, invNear };
}

const geoOf = ({ meta, space }) => {
  const k = comfortScale(meta, { space });
  const rig = rigFromMeta({ ...meta, pivotZ: meta.pivotZ * k }, 'opencv');
  return { near: meta.depthRange.near, far: meta.depthRange.far, d: rig.dPivot, k, fPx: rig.fPx, w: rig.w, ipd: IPD_M };
};

test('depth budget: the default is the one panel-calibrated constant, shared by the generator', () => {
  assert.equal(DEPTH_BUDGET_DEFAULT, 0.018);
  assert.equal(LIFT_DEFAULTS.depthBudget, DEPTH_BUDGET_DEFAULT);
});

test('depth budget: relative scene — generator range + nominal rig → measured spread = depthBudget × width (±2 %) at strength 1', () => {
  const budget = DEPTH_BUDGET_DEFAULT;
  const L = relativeLift(budget);
  // the generator keeps the pivot seed's depth and normalised position
  assert.ok(within(L.invFar + L.pivotLo * (L.invNear - L.invFar), L.before.invP, 1e-9));
  const g = geoOf({ meta: L.meta, space: 'disparity' });
  const S = depthGainForBudget(budget, g).gain;
  assert.ok(within(S, 1, 0.02), `a budget-generated relative scene needs no extra gain at strength 1 (S = ${S})`);
  const m = measure({ meta: L.meta, space: 'disparity', near: L.meta.depthRange.near, far: L.meta.depthRange.far, S });
  assert.ok(within(m.spread, budget), `measured ${m.spread} vs budget ${budget}`);
  // 36 px on a 2000-px frame — the panel number the default was derived from
  assert.ok(within(m.spread * 2000, 36));
});

test('depth budget: strength 0.5 halves the parallax (±2 %), no regeneration', () => {
  for (const budget of [0.018, 0.03]) {
    const L = relativeLift(budget);
    const g = geoOf({ meta: L.meta, space: 'disparity' });
    const s1 = measure({ meta: L.meta, space: 'disparity', ...L.meta.depthRange, S: depthGainForBudget(budget * 1, g).gain }).spread;
    const s05 = measure({ meta: L.meta, space: 'disparity', ...L.meta.depthRange, S: depthGainForBudget(budget * 0.5, g).gain }).spread;
    assert.ok(within(s05, s1 / 2), `${budget}: ${s05} vs ${s1 / 2}`);
    assert.ok(within(s1, budget));
  }
});

test('depth budget: metric scene with a comfort scale k ≠ 1 still matches (k cancels; dead-band untouched)', () => {
  const budget = DEPTH_BUDGET_DEFAULT;
  // a far CG frame: pivot 6 m → comfort k = 2/6
  const meta = { focalPx: 900, w: 1024, h: 576, pivotZ: 6, space: 'metric', depthRange: { near: 3.5, far: 40 } };
  const k = comfortScale(meta, { space: 'metric' });
  assert.ok(Math.abs(k - 1 / 3) < 1e-9, `comfort applies (k = ${k})`);
  const g = geoOf({ meta, space: 'metric' });
  for (const s of [1, 0.5]) {
    const S = depthGainForBudget(budget * s, g).gain;
    const m = measure({ meta, space: 'metric', near: 3.5, far: 40, S });
    assert.ok(within(m.spread, budget * s), `strength ${s}: ${m.spread} vs ${budget * s}`);
  }
  // inside the dead-band nothing is rescaled, and the budget still holds
  const near2 = { ...meta, pivotZ: 2.5, depthRange: { near: 1.2, far: 9 } };
  assert.equal(comfortScale(near2, { space: 'metric' }), 1);
  const S2 = depthGainForBudget(budget, geoOf({ meta: near2, space: 'metric' })).gain;
  assert.ok(within(measure({ meta: near2, space: 'metric', near: 1.2, far: 9, S: S2 }).spread, budget));
});

test('depth budget: SOG-input scene (no meta.depthRange) takes near/far from the splat centres and matches', () => {
  const budget = DEPTH_BUDGET_DEFAULT;
  // OpenCV centres (+z forward): a subject at ~1.6 m, background 4–12 m, a few stray outliers
  const n = 5000;
  const c = new Float32Array(n * 3);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < n; i++) {
    const z = i < 1500 ? 1.4 + 0.4 * rnd() : i < 4990 ? 4 + 8 * rnd() : 500; // 10 outliers at 500 m
    c[i * 3] = (rnd() - 0.5) * z;
    c[i * 3 + 1] = (rnd() - 0.5) * z;
    c[i * 3 + 2] = z;
  }
  const range = depthRangeFromCenters(c, 1);
  assert.ok(range.near > 1.3 && range.near < 1.5, `near ${range.near}`);
  assert.ok(range.far > 11 && range.far < 12.1, `far ${range.far} (outliers ignored)`);
  const meta = { focalPx: 1100, w: 1536, h: 864, pivotZ: 1.8, space: 'metric', depthRange: range };
  const g = geoOf({ meta, space: 'metric' });
  const S = depthGainForBudget(budget, g).gain;
  const m = measure({ meta, space: 'metric', near: range.near, far: range.far, S });
  assert.ok(within(m.spread, budget), `${m.spread} vs ${budget}`);
});

test('depth budget: the closed form agrees with the measured projection; an unreachable budget is capped, not NaN', () => {
  const L = relativeLift(0.018);
  const g = geoOf({ meta: L.meta, space: 'disparity' });
  for (const S of [0.3, 1, 1.7]) {
    const m = measure({ meta: L.meta, space: 'disparity', ...L.meta.depthRange, S });
    assert.ok(within(budgetSpread(S, g), m.spread, 1e-6));
  }
  const flat = { near: 1.99, far: 2.01, d: 2, k: 1, fPx: 1000, w: 1000 };
  const r = depthGainForBudget(0.5, flat);
  assert.equal(r.capped, true);
  assert.ok(Number.isFinite(r.gain) && r.gain > 0 && Number.isFinite(r.spread));
});

test('depth budget: the module can report its own (caps.depthBudget), validated', () => {
  assert.equal(parseNativeCaps({ native: true, depthBudget: 0.022 }).depthBudget, 0.022);
  assert.equal(parseNativeCaps({ native: true, depthBudget: 3 }).depthBudget, undefined);
  assert.equal(parseNativeCaps({ native: true }).depthBudget, undefined);
});

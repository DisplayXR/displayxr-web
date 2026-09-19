// Tests for the splat rig WATERFALL — which rig, what lens, what is it looking at.
//
// Every step is exercised, and so is the ORDER, because the order is the design: a value from a
// lower step arriving when a higher one was available is not a wrong number, it is a wrong
// SOURCE, and it is invisible in the picture. That is why the resolved rig carries
// `intrinsicsSource` / `focusSource` / `typeSource` at all, and why the assertions below check
// them as hard as they check the values.
//
// The estimator is tested against a synthetic cloud with a KNOWN frustum, because the whole
// claim is that a capture's gaussians only exist where its camera could see them — so a cloud
// filling a frustum of half-tangents (h, v) must give those back.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveRig,
  estimateIntrinsics,
  fallbackIntrinsics,
  intrinsicsFromTangents,
  medianDisparityDistance,
  focalEq35,
  toRestSpace,
  aheadOfRest,
  planeDistance,
  unrotate,
  rotate,
} from '../js/inline3d-splat-rig.js';

const near = (a, b, eps, what = '') => assert.ok(Math.abs(a - b) < eps, `${what} ${a} !~= ${b}`);

/** Deterministic LCG — a fixed cloud, so a failure is a regression and not a bad seed. */
function rng(seed = 1) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

/**
 * A cloud filling a frustum: uniform in tangent space out to (hTan, vTan), depths log-uniform
 * over [zNear, zFar] so the disparities are spread the way a real capture's are.
 */
function frustumCloud({ hTan = 0.857, vTan = 0.482, zNear = 1, zFar = 10, n = 20000, seed = 7 } = {}) {
  const r = rng(seed);
  const tx = new Float64Array(n);
  const ty = new Float64Array(n);
  const invz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const z = zNear * Math.pow(zFar / zNear, r());
    tx[i] = (r() * 2 - 1) * hTan;
    ty[i] = (r() * 2 - 1) * vTan;
    invz[i] = 1 / z;
  }
  return { tx, ty, invz, n };
}

const IDENTITY_REST = { position: [0, 0, 0], rotation: [0, 0, 0, 1] };

// ── the frame arithmetic ────────────────────────────────────────────────────────────────

test('rotate and unrotate are inverses, and unrotate takes world INTO the camera frame', () => {
  // 90° about Y (xyzw).
  const q = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
  const v = [1, 2, 3];
  const there = rotate(q, v);
  const back = unrotate(q, there);
  for (let i = 0; i < 3; i++) near(back[i], v[i], 1e-12, `axis ${i}`);
  // A camera yawed 90° about +y sees the world's +x on its own -z... or +z, depending on the
  // sign convention — what matters is that the two are consistent, which the round trip pins.
  const p = toRestSpace({ position: [0, 0, 0], rotation: q }, [1, 0, 0]);
  near(Math.hypot(p[0], p[1], p[2]), 1, 1e-12, 'length preserved');
});

test('aheadOfRest and planeDistance are inverses along the view axis', () => {
  const rest = { position: [1, 2, 3], rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2] };
  const p = aheadOfRest(rest, 4.5);
  near(planeDistance(rest, p), 4.5, 1e-12);
});

test('planeDistance is the PLANE, not the radius — an off-axis point projects', () => {
  // 45° off the axis at radius √2 ⇒ one unit down the axis.
  near(planeDistance(IDENTITY_REST, [1, 0, 1]), 1, 1e-12);
});

// ── the estimator ───────────────────────────────────────────────────────────────────────

test('the estimator reads a known frustum back off the cloud', () => {
  const cloud = frustumCloud({ hTan: 0.857, vTan: 0.482 });
  const est = estimateIntrinsics(cloud.tx, cloud.ty, cloud.n);
  assert.ok(est);
  const h = (est.tangents.txHi - est.tangents.txLo) / 2;
  const v = (est.tangents.tyHi - est.tangents.tyLo) / 2;
  // P1/P99 trims 1 % off each end of a uniform fill, so the estimate is slightly INSIDE the
  // true frustum by construction. That is the trade the percentiles buy: a handful of
  // hallucinated gaussians past the frame edge cannot set the field of view for the asset.
  near(h, 0.857, 0.857 * 0.03, 'h_tan');
  near(v, 0.482, 0.482 * 0.03, 'v_tan');
  // Square pixels by construction — nothing in a cloud distinguishes a non-square pixel. Not
  // bit-identical, because `width` is rounded to whole pixels; within that rounding.
  near(est.intrinsics.fx / est.intrinsics.fy, 1, 1 / est.intrinsics.width, 'square pixels');
  // ~22 mm-equivalent, which is what a 0.857/0.482 frustum is.
  near(est.focalEqMm, 22, 2);
});

test('an ASYMMETRIC cloud comes back as a principal-point offset, not a wider lens', () => {
  const cloud = frustumCloud({ n: 20000 });
  // Shift every tangent right by 0.1: the same lens, pointed elsewhere.
  for (let i = 0; i < cloud.n; i++) cloud.tx[i] += 0.1;
  const est = estimateIntrinsics(cloud.tx, cloud.ty, cloud.n);
  const { fx, cx, width } = est.intrinsics;
  // cx moves off centre by 0.1·fx; the WIDTH of the frustum is unchanged.
  near((cx - width / 2) / fx, -0.1, 0.01, 'principal offset');
});

test('a cloud that is not a camera is REFUSED, both ways', () => {
  // A scan the viewer is inside: most of a hemisphere.
  assert.equal(estimateIntrinsics(...Object.values(pick(frustumCloud({ hTan: 4, vTan: 3 })))), null);
  // One distant object subtending almost nothing: a telescope.
  assert.equal(estimateIntrinsics(...Object.values(pick(frustumCloud({ hTan: 0.02, vTan: 0.012 })))), null);
  function pick(c) {
    return { tx: c.tx, ty: c.ty, n: c.n };
  }
});

test('too few splats is refused rather than extrapolated', () => {
  assert.equal(estimateIntrinsics(new Float64Array(10), new Float64Array(10), 10), null);
  assert.equal(estimateIntrinsics(new Float64Array(0), new Float64Array(0), 0), null);
});

test('the 28 mm fallback keeps the ORIENTATION it is given', () => {
  const land = fallbackIntrinsics(16 / 9);
  const port = fallbackIntrinsics(9 / 16);
  assert.ok(land.width > land.height);
  assert.ok(port.width < port.height);
  // Both are 28 mm-equivalent on the diagonal, which is the point of the diagonal convention.
  for (const i of [land, port]) {
    near(focalEq35(i.width / 2 / i.fx, i.height / 2 / i.fy), 28, 0.01);
  }
});

test('intrinsicsFromTangents refuses a degenerate frustum instead of dividing by zero', () => {
  assert.equal(intrinsicsFromTangents(0.5, 0.5, -0.3, 0.3), null);
  assert.equal(intrinsicsFromTangents(-0.5, 0.5, 0.3, -0.3), null);
});

// ── focus ───────────────────────────────────────────────────────────────────────────────

test('the focus distance is the median of 1/z, INVERTED — not the median of z', () => {
  // Two depths, 1 m and 100 m, in equal numbers: the median disparity is the midpoint of
  // 1 and 0.01, i.e. 1/0.505 ≈ 1.98 m — decisively near. The median of z would say 50.5 m, and
  // that is the shape of the 40 m bug this rule exists to prevent.
  const n = 1000;
  const invz = new Float64Array(n);
  for (let i = 0; i < n; i++) invz[i] = i < n / 2 ? 1 / 1 : 1 / 100;
  near(medianDisparityDistance(invz, n), 1 / 0.505, 0.01);
});

test('a cloud with no forward splats yields no focus rather than an infinity', () => {
  assert.equal(medianDisparityDistance(new Float64Array(0), 0), null);
});

// ── the waterfall, in order ─────────────────────────────────────────────────────────────

const BLOCK = {
  convention: 'opencv',
  rig: 'camera',
  rest: IDENTITY_REST,
  intrinsics: { fx: 1194.665984, fy: 1194.665984, cx: 1024, cy: 576, width: 2048, height: 1152 },
  stereo: { baseline_m: 0.063 },
  focus: { point: [0, 0, 1.683], subject_m: 2.14, near_m: 0.73, far_m: 66.2, source: 'convergence' },
  dxr: { ipdFactor: 1, parallaxFactor: 1 },
};

test('a full v2 block answers everything, and the cloud is not consulted', () => {
  const r = resolveRig({ camera: BLOCK, opts: {}, cloud: null });
  assert.equal(r.type, 'camera');
  assert.equal(r.typeSource, 'block');
  assert.equal(r.intrinsicsSource, 'block');
  assert.equal(r.focusSource, 'block');
  assert.deepEqual(r.focus, [0, 0, 1.683]);
  near(r.convergence, 1.683, 1e-12);
  assert.deepEqual(r.focusDistances, { subject_m: 2.14, near_m: 0.73, far_m: 66.2 });
});

test('the caller outranks the block, at every step', () => {
  const r = resolveRig({
    camera: BLOCK,
    opts: {
      rig: 'display',
      focus: [1, 2, 3],
      intrinsics: { fx: 100, fy: 100, cx: 50, cy: 50, width: 100, height: 100 },
      ipdFactor: 0.5,
      parallaxFactor: 0,
    },
    cloud: null,
  });
  assert.equal(r.type, 'display');
  assert.equal(r.typeSource, 'caller');
  assert.equal(r.focusSource, 'caller');
  assert.deepEqual(r.focus, [1, 2, 3]);
  assert.equal(r.ipdFactor, 0.5);
  assert.equal(r.parallaxFactor, 0);
  // Caller intrinsics are BELOW the block's: the file knows its own lens, and a page overriding
  // it is almost always a page that did not know the file had one.
  assert.equal(r.intrinsicsSource, 'block');
});

test("`rig: 'auto'` is not a rig — it means ask the asset", () => {
  const withBlock = resolveRig({ camera: { ...BLOCK, rig: null }, opts: { rig: 'auto' }, cloud: null });
  assert.equal(withBlock.type, 'camera');
  assert.equal(withBlock.typeSource, 'block-present');
  const without = resolveRig({ camera: null, opts: { rig: 'auto' }, cloud: null });
  assert.equal(without.type, 'display');
  assert.equal(without.typeSource, 'default');
});

test("`rig: 'display'` beside a rest pose means a display rig opened at that viewpoint", () => {
  const r = resolveRig({ camera: { ...BLOCK, rig: 'display' }, opts: {}, cloud: null });
  assert.equal(r.type, 'display');
  assert.equal(r.typeSource, 'block');
  // ...and it still gets the block's lens and focus. The rig says who moves, not what is known.
  assert.equal(r.intrinsicsSource, 'block');
  assert.equal(r.focusSource, 'block');
});

test('a block with NO intrinsics estimates them, and says so', () => {
  const cloud = frustumCloud({ hTan: 0.857, vTan: 0.482 });
  const r = resolveRig({ camera: { ...BLOCK, intrinsics: null }, opts: {}, cloud });
  assert.equal(r.intrinsicsSource, 'estimated');
  near(r.intrinsics.width / 2 / r.intrinsics.fx, 0.857, 0.857 * 0.03, 'estimated h_tan');
  // The block's focus is still the block's: one missing field does not demote the rest.
  assert.equal(r.focusSource, 'block');
  assert.equal(r.typeSource, 'block');
});

test('no block at all: the cloud supplies the lens AND the focus', () => {
  const cloud = frustumCloud({ hTan: 0.6, vTan: 0.45, zNear: 2, zFar: 20 });
  const r = resolveRig({ camera: null, opts: {}, cloud });
  assert.equal(r.type, 'display');
  assert.equal(r.intrinsicsSource, 'estimated');
  assert.equal(r.focusSource, 'median-disparity');
  // Straight ahead of an identity rest pose, at the median-disparity distance.
  assert.equal(r.focus[0], 0);
  assert.equal(r.focus[1], 0);
  near(r.focus[2], r.convergence, 1e-12);
});

test('an untrustworthy cloud falls through to 28 mm, keeping its orientation', () => {
  const cloud = frustumCloud({ hTan: 4, vTan: 3 }); // a scan the viewer is inside
  const r = resolveRig({ camera: null, opts: {}, cloud, canvasAspect: 1 });
  assert.equal(r.intrinsicsSource, 'fallback-28mm');
  near(r.focalEqMm, 28, 0.01);
  // The extent still knew it was landscape (4:3 in tangents), so the frame is landscape — the
  // canvas's 1:1 is not what decides it.
  assert.ok(r.intrinsics.width > r.intrinsics.height);
});

test('with nothing at all, the focus is 2 m ahead and every source says so', () => {
  const r = resolveRig({ camera: null, opts: {}, cloud: null, canvasAspect: 16 / 9 });
  assert.equal(r.focusSource, 'default');
  near(r.convergence, 2, 1e-12);
  assert.equal(r.intrinsicsSource, 'fallback-28mm');
  assert.equal(r.typeSource, 'default');
  assert.equal(r.ipdFactor, 1);
  assert.equal(r.parallaxFactor, 1);
});

test('`convergence` is the straight-ahead shorthand for `focus`, and ranks just under it', () => {
  const rest = { position: [0, 0, 0], rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2] };
  const r = resolveRig({ camera: { ...BLOCK, rest, focus: null }, opts: { convergence: 3 }, cloud: null });
  assert.equal(r.focusSource, 'caller-convergence');
  near(planeDistance(rest, r.focus), 3, 1e-9);
  // ...and a real `focus` outranks it.
  const both = resolveRig({ camera: BLOCK, opts: { convergence: 3, focus: [0, 0, 9] }, cloud: null });
  assert.equal(both.focusSource, 'caller');
  near(both.convergence, 9, 1e-12);
});

test('a rest pose that is NOT the origin still resolves a focus in model space', () => {
  const rest = { position: [10, 0, 0], rotation: [0, 0, 0, 1] };
  const cloud = frustumCloud({ zNear: 3, zFar: 3.0001 }); // everything at 3 m
  const r = resolveRig({ camera: { ...BLOCK, rest, focus: null, intrinsics: null }, opts: {}, cloud });
  assert.equal(r.focusSource, 'median-disparity');
  near(r.focus[0], 10, 1e-9, 'x rides the rest position');
  near(r.focus[2], 3, 0.01, 'z is the median depth AHEAD of it');
});

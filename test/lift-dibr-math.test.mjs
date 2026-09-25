// Pure-JS tests for the live-DIBR normalisation / convergence / view-mapping math.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  percentileRange, centreMedian, dilateMax, toDisparity, DepthNormalizer, viewEye,
  kooimaProjection, qScale, KAPPA,
} from '../js/lift/live-dibr.js';
import { depthMap } from './lift-dibr-scene.mjs';

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} ${a} vs ${b}`);

test('percentileRange: uniform ramp gives the 2nd/98th percentiles', () => {
  const n = 10001;
  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) d[i] = i / (n - 1);
  const r = percentileRange(d, 0.02, 0.98);
  near(r.lo, 0.02, 1e-3, 'lo');
  near(r.hi, 0.98, 1e-3, 'hi');
});

test('percentileRange: outliers are clipped, NaN ignored', () => {
  const d = new Float32Array(1000).fill(0.5);
  for (let i = 0; i < 500; i++) d[i] = 0.2 + (0.6 * i) / 499;
  d[0] = -50; d[1] = 900; d[2] = NaN;
  const r = percentileRange(d);
  assert.ok(r.lo > 0.1 && r.hi < 1, JSON.stringify(r));
});

test('percentileRange: flat map', () => {
  const r = percentileRange(new Float32Array(10).fill(3));
  assert.equal(r.lo, 3);
  assert.equal(r.hi, 3);
});

test('centreMedian ignores the border 25% on each side', () => {
  const w = 40, h = 20;
  const d = new Float32Array(w * h).fill(1); // border = near
  for (let y = 5; y < 15; y++) for (let x = 10; x < 30; x++) d[y * w + x] = 0.25;
  near(centreMedian(d, w, h, 0, 1, 0.5), 0.25, 1e-6);
});

test('centreMedian normalises by lo/hi and clamps', () => {
  const d = new Float32Array(16).fill(5);
  near(centreMedian(d, 4, 4, 0, 10), 0.5, 1e-6);
  near(centreMedian(d, 4, 4, 6, 10), 0, 1e-6);
});

test('dilateMax grows the foreground by r px (square)', () => {
  const w = 9, h = 9;
  const d = new Float32Array(w * h);
  d[4 * w + 4] = 1;
  const o = dilateMax(d, w, h, 2);
  let count = 0;
  for (const v of o) count += v;
  assert.equal(count, 25);
  assert.equal(o[2 * w + 2], 1);
  assert.equal(o[1 * w + 4], 0);
  assert.deepEqual(Array.from(dilateMax(d, w, h, 0)), Array.from(d));
});

test('toDisparity: metric -> 1/z, passthrough otherwise', () => {
  const m = toDisparity(new Float32Array([2, 0.5, 0]), 'metric');
  assert.deepEqual(Array.from(m), [0.5, 2, 0]);
  const p = new Float32Array([1]);
  assert.equal(toDisparity(p, 'disparity'), p);
});

test('DepthNormalizer: EMA decay 0.9 toward a new range, reset snaps', () => {
  const nz = new DepthNormalizer({ ema: 0.9 });
  const a = new Float32Array(10000);
  for (let i = 0; i < a.length; i++) a[i] = i / (a.length - 1); // 0..1
  const b = a.map((v) => 2 + v); // 2..3 (scene cut)
  nz.update(a, 100, 100);
  near(nz.lo, 0.02, 2e-3);
  nz.update(b, 100, 100);
  near(nz.lo, 0.9 * 0.02 + 0.1 * 2.02, 2e-3, 'one EMA step');
  for (let i = 0; i < 60; i++) nz.update(b, 100, 100);
  near(nz.lo, 2.02, 0.01, 'converged');
  nz.update(a, 100, 100, { reset: true });
  near(nz.lo, 0.02, 2e-3, 'reset snaps');
  nz.update(b, 100, 100, { stabilize: false });
  near(nz.hi, 2.98, 2e-3, 'no stabilize = this frame');
});

test('auto-convergence on the synthetic scene = centre median', () => {
  const d = depthMap(0, 364, 210);
  const nz = new DepthNormalizer();
  const s = nz.update(d, 364, 210);
  assert.ok(s.conv > 0 && s.conv < 1, String(s.conv));
  near(s.conv, centreMedian(d, 364, 210, s.lo, s.hi), 1e-6);
});

test('viewEye inverts kooimaProjection (eye in window heights)', () => {
  for (const eye of [{ x: 0, y: 0, z: 2.5 }, { x: 0.13, y: -0.07, z: 1.8 }, { x: -0.4, y: 0.2, z: 4 }]) {
    for (const A of [1, 16 / 9, 0.75]) {
      const e = viewEye(kooimaProjection(eye, A));
      near(e.x, eye.x, 1e-5); near(e.y, eye.y, 1e-5); near(e.z, eye.z, 1e-5); near(e.aspect, A, 1e-5);
    }
  }
});

test('qScale: nominal pair sees budget*gain of the width across n in [0,1]', () => {
  const A = 16 / 9, D0 = 2.5, budget = 0.025;
  const qs = qScale(budget, 1, A, D0);
  // Eyes at +-b/2, b = KAPPA*D0; screen-space shift = e.x*q (window heights); disparity = b*qs.
  const disparityFracOfWidth = (KAPPA * D0 * qs) / A;
  near(disparityFracOfWidth, budget, 1e-9);
  near(qScale(budget, 2, A, D0), 2 * qs, 1e-12, 'gain is linear');
});

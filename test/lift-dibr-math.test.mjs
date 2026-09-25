// Pure-JS tests for the live-DIBR normalisation / convergence / view-mapping math.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  percentileRange, centreMedian, dilateMax, toDisparity, DepthNormalizer, viewEye,
  kooimaProjection, qScale, KAPPA, sourceCamera, srcUvRef,
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

// ---------------------------------------------------------------------------------------------
// Off-axis viewer — the DisplayXR Browser 1.0.2 panel run (Leia SR 3840x2160, 0.3442x0.1936 m;
// tile 800x450 CSS @ dpr 2.5 -> canvas 4000x1125 SBS, each view 2000x1125). The two projection
// matrices below are VERBATIM from that session (DUMPVIEW 0 / 1). The runtime's nominal viewer sits
// ~0.1 m above the panel centre, so the tile is seen ~4.7 deg from above: P9 ~ -0.9.
// ---------------------------------------------------------------------------------------------
const PANEL = [
  [6.166205883026123, 0, 0, 0, 0, 10.96214485168457, 0, 0, 0.45363613963127136, -0.8832857012748718, -1.0001999139785767, -1, 0, 0, -0.2000199854373932, 0],
  [6.157009124755859, 0, 0, 0, 0, 10.945794105529785, 0, 0, -0.2347441464662552, -0.9125044345855713, -1.0001999139785767, -1, 0, 0, -0.2000199854373932, 0],
];
const PANEL_VIEW_H = 1125; // px per window height in that run
const panelEyes = () => PANEL.map((m) => viewEye(m));

test('panel matrices ARE plain Kooima frusta and viewEye reads them (hypothesis (a) rejected)', () => {
  // Rebuild each dumped matrix from the eye viewEye recovers, with the runtime's own construction
  // (displayxr-common dxr_display3d: l/r/b/t = near*(+-half - e)/e.z). Same numbers back.
  for (const m of PANEL) {
    const e = viewEye(m);
    const k = kooimaProjection(e, e.aspect);
    for (const i of [0, 5, 8, 9]) near(k[i], m[i], 1e-5, `P${i}`);
    near(e.aspect, 16 / 9, 1e-5, 'aspect');
    assert.ok(e.y > 0.4 && e.y < 0.5, `eye ABOVE the tile centre (+y up): ${e.y}`);
    near(e.z, 5.477, 0.01, 'eye distance, tile heights');
  }
  const [L, R] = panelEyes();
  assert.ok(L.x < R.x, 'view 0 is the left eye');
  near(R.x - L.x, 0.6118, 1e-3, 'eye separation, tile heights (~62 mm at 0.1008 m/tile-height)');
});

test('sourceCamera = eye centroid; lookAround blends x,y toward the anchor, never z', () => {
  const eyes = [{ x: -0.4, y: 0.44, z: 5.48 }, { x: 0.2, y: 0.46, z: 5.47 }];
  const c = sourceCamera(eyes);
  near(c.x, -0.1, 1e-12); near(c.y, 0.45, 1e-12); near(c.z, 5.475, 1e-12);
  assert.deepEqual(sourceCamera(eyes, { x: 9, y: 9 }, 0), c, 'lookAround 0 ignores the anchor');
  const h = sourceCamera(eyes, { x: 0.1, y: 0.25 }, 0.5);
  near(h.x, 0, 1e-12); near(h.y, 0.35, 1e-12); near(h.z, 5.475, 1e-12);
  const f = sourceCamera(eyes, { x: 0.1, y: 0.25 }, 1);
  near(f.x, 0.1, 1e-12); near(f.y, 0.25, 1e-12);
});

test('panel eyes, flat source ON the glass (q = 0): both eyes are the identity', () => {
  const eyes = panelEyes();
  const cam = sourceCamera(eyes);
  for (const e of eyes) {
    for (let v = 0; v <= 1.0001; v += 0.125) {
      for (let u = 0; u <= 1.0001; u += 0.125) {
        const [us, vs] = srcUvRef([u, v], 0, e, cam, e.aspect);
        near(us, u, 1e-12, 'u'); near(vs, v, 1e-12, 'v');
      }
    }
  }
});

test('an eye AT the source camera is the identity for every depth', () => {
  const cam = { x: -0.1, y: 0.45, z: 5.5 };
  for (const q of [-0.08, -0.02, 0.03, 0.08]) {
    for (const uv of [[0.1, 0.9], [0.5, 0.5], [0.95, 0.05]]) {
      const [u, v] = srcUvRef(uv, q, cam, cam, 16 / 9);
      near(u, uv[0], 1e-12); near(v, uv[1], 1e-12);
    }
  }
});

test('panel eyes, real depth: near and far move OPPOSITE ways horizontally, not vertically', () => {
  const eyes = panelEyes();
  const cam = sourceCamera(eyes);
  const A = eyes[0].aspect;
  const qs = qScale(0.025, 1, A, cam.z);
  const conv = 0.6;
  const qNear = qs * (1 - conv), qFar = qs * (0 - conv);
  for (const e of eyes) {
    const side = Math.sign(e.x - cam.x);
    // content displacement in px = -(source offset); source offset at uv (0.5, 0.5):
    const move = (q) => {
      const [u, v] = srcUvRef([0.5, 0.5], q, e, cam, A);
      return { dx: -(u - 0.5) * A * PANEL_VIEW_H, dy: -(v - 0.5) * PANEL_VIEW_H };
    };
    const n = move(qNear), f = move(qFar), c = move(0);
    assert.equal(Math.sign(n.dx), -side, 'near: crossed');
    assert.equal(Math.sign(f.dx), side, 'far: uncrossed');
    assert.ok(Math.abs(n.dx) > 3 && Math.abs(f.dx) > 3, `visible parallax ${n.dx} ${f.dx}`);
    near(c.dx, 0, 1e-9); near(c.dy, 0, 1e-9);
    // vertical: only the eyes' own height difference about their centroid (~0.007 tile heights
    // here — head roll), i.e. < 0.5 px; the pre-fix mapping below moved it by ~20 px.
    assert.ok(Math.abs(n.dy) < 0.5 && Math.abs(f.dy) < 0.5, `vertical ${n.dy} ${f.dy}`);
  }
});

test('REGRESSION: pre-fix source camera on the tile axis shears the frame by E.y*q (the 1.0.2 bug)', () => {
  const eyes = panelEyes();
  const A = eyes[0].aspect;
  const D0 = sourceCamera(eyes).z;
  const onAxis = { x: 0, y: 0, z: D0 };
  const qFar = qScale(0.025, 1, A, D0) * -0.6;
  for (const e of eyes) {
    const [, v] = srcUvRef([0.5, 0.5], qFar, e, onAxis, A);
    const dy = (v - 0.5) * PANEL_VIEW_H; // source offset, v up
    near(Math.abs(dy), Math.abs(e.y * qFar) * PANEL_VIEW_H, 0.5, 'shear = E.y*q');
    assert.ok(Math.abs(dy) > 15, `pre-fix vertical shift ${dy.toFixed(1)} px of 1125`);
  }
});

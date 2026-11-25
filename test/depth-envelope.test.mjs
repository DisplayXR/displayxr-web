// The frame envelope (handle.setDepthEnvelope) and displayMetrics(): the pure pieces.
//
// `envelopeCenter` below is a line-for-line JS transcription of EFFECTS.envelope's GLSL `center`
// (js/inline3d-splat-effects.js). The physics is checked INDEPENDENTLY of that formula: a capped
// gaussian's panel depth is recomputed from the camera-rig disparity model and must equal the cap.

import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDepthEnvelope, DEPTH_ENVELOPE_DEFAULTS } from '../js/inline3d-splat-playcanvas.js';
import { ENVELOPE_MAX_RECTS, composeModifier, EFFECTS } from '../js/inline3d-splat-effects.js';
import { displayMetricsFrom, DISPLAY_METRICS_DEFAULTS } from '../js/inline3d.js';

const near = (a, b, eps, what) => assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} vs ${b}`);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const smoothstep = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** EFFECTS.envelope's center(), in JS. Returns { c, lambda }. */
function envelopeCenter(st, c) {
  const v = [c[0] - st.origin[0], c[1] - st.origin[1], c[2] - st.origin[2]];
  const d = dot(v, st.axis);
  if (d <= 1e-4) return { c, lambda: 1 };
  const f = [dot(v, st.right) / (d * st.tanX), dot(v, st.up) / (d * st.tanY)];
  const S = st.stage;
  const inside = Math.min(Math.min(f[0] - S[0], S[1] - f[0]) * st.halfW, Math.min(f[1] - S[2], S[3] - f[1]) * st.halfH);
  let e = smoothstep(0, st.band, inside);
  for (const r of st.rects) {
    const C = r.f;
    if (r.weight <= 0 || C[0] >= C[1] || C[2] >= C[3]) continue;
    const ox = Math.max(Math.max(C[0] - f[0], f[0] - C[1]) * st.halfW, 0);
    const oy = Math.max(Math.max(C[2] - f[1], f[1] - C[3]) * st.halfH, 0);
    e = Math.min(e, 1 + (smoothstep(0, st.band, Math.hypot(ox, oy)) - 1) * r.weight);
  }
  const F = st.edge + Math.max(st.maxFront - st.edge, 0) * e;
  const invEnv = st.invD + F / (st.kfp * Math.max(st.viewer - F, 1e-3));
  if (1 / d <= invEnv) return { c, lambda: 1 };
  const lambda = 1 / (invEnv * d);
  return { c: [st.origin[0] + v[0] * lambda, st.origin[1] + v[1] * lambda, st.origin[2] + v[2] * lambda], lambda };
}

// A camera rig at the origin looking down −z: 50° vertical fov, convergence 3 m, ipd 1, m2v 1, on a
// 0.32 × 0.18 m canvas, viewer at 0.6 m. Eyes 63 mm apart (they cancel — any value gives the same).
const vfov = (50 * Math.PI) / 180;
const tanY = Math.tan(vfov / 2);
const H = 0.18;
const W = 0.32;
const fp = H / (2 * tanY);
const D = 3;
const n = 0.6;
const e = 0.063;
const base = (o = {}) => ({
  origin: [0, 0, 0],
  axis: [0, 0, -1],
  right: [1, 0, 0],
  up: [0, 1, 0],
  tanX: tanY * (W / H),
  tanY,
  halfW: W / 2,
  halfH: H / 2,
  invD: 1 / D,
  kfp: 1 * fp,
  viewer: n,
  maxFront: 0.02,
  stage: [-1, 1, -1, 1],
  band: 0.016,
  edge: 0.001,
  rects: [],
  ...o,
});

/** Panel depth, metres OUT of the glass (+), of a point at depth d — from disparity, not the cap formula. */
function panelOut(st, d) {
  const k = st.kfp / fp; // ipd · m2v · scale
  const p = k * e * fp * (st.invD - 1 / d); // on-screen disparity, + = uncrossed (behind)
  return (-p * n) / (e - p);
}

test('a gaussian that would come out past maxFront lands EXACTLY maxFront out at the frame centre', () => {
  const st = base();
  const d = 0.5; // far out of the glass
  assert.ok(panelOut(st, d) > 0.02, 'it starts beyond the cap');
  const { c, lambda } = envelopeCenter(st, [0, 0, -d]);
  near(panelOut(st, -c[2]), 0.02, 1e-12, 'out distance after');
  assert.ok(lambda > 1, 'pushed back along its ray');
});

test('mono-invariant: the point stays on its own ray (the 2D picture is unchanged)', () => {
  const st = base();
  const p = [0.05, -0.03, -0.6];
  const { c, lambda } = envelopeCenter(st, p);
  assert.ok(lambda > 1);
  near(c[0] / c[2], p[0] / p[2], 1e-12, 'x/z');
  near(c[1] / c[2], p[1] / p[2], 1e-12, 'y/z');
});

test('behind the glass, and out within the cap, nothing moves', () => {
  const st = base();
  for (const d of [3, 10, 2.5]) assert.equal(envelopeCenter(st, [0, 0, -d]).lambda, 1, `d=${d}`);
  // 10 mm out at the centre: under the 20 mm cap
  const d10 = 1 / (st.invD + 0.01 / (fp * (n - 0.01)));
  near(panelOut(st, d10), 0.01, 1e-12, 'the test point');
  assert.equal(envelopeCenter(st, [0, 0, -d10]).lambda, 1);
});

test('at the stage edge the cap is edgeM; inside a full-weight flat rect too; weight 0 is no rect', () => {
  const st = base();
  const atEdge = (fx, s) => {
    // a point whose screen spot is canvas-normalised x = fx, far out
    const d = 0.5;
    const { c } = envelopeCenter(s, [fx * s.tanX * d, 0, -d]);
    return panelOut(s, -c[2]);
  };
  near(atEdge(1, st), 0.001, 1e-12, 'the canvas edge');
  near(atEdge(0, st), 0.02, 1e-12, 'the centre');
  const stage = base({ stage: [-0.5, 0.5, -1, 1] });
  near(atEdge(0.5, stage), 0.001, 1e-12, 'a narrower stage');
  near(atEdge(0.8, stage), 0.001, 1e-12, 'outside the stage: flat');
  const rect = base({ rects: [{ f: [-0.2, 0.2, -0.2, 0.2], weight: 1 }] });
  near(atEdge(0, rect), 0.001, 1e-12, 'under a flat rect');
  const off = base({ rects: [{ f: [-0.2, 0.2, -0.2, 0.2], weight: 0 }] });
  near(atEdge(0, off), 0.02, 1e-12, 'weight 0');
  const half = base({ rects: [{ f: [-0.2, 0.2, -0.2, 0.2], weight: 0.5 }] });
  near(atEdge(0, half), 0.001 + 0.019 * 0.5, 1e-12, 'weight 0.5: half way');
});

test('ipdFactor halves the disparity: the cap is still met exactly (setStereo is accounted for)', () => {
  const st = base({ kfp: 0.5 * fp });
  const { c } = envelopeCenter(st, [0, 0, -0.4]);
  near(panelOut(st, -c[2]), 0.02, 1e-12, 'out distance after');
});

test('the GLSL takes ENVELOPE_MAX_RECTS rects and composes after custom', () => {
  const { code, order } = composeModifier([
    { name: 'envelope', def: EFFECTS.envelope, opts: {} },
    { name: 'custom:x', def: { stage: 'custom' }, opts: { glsl: 'void modifySplatCenter(inout vec3 c) {}' } },
  ]);
  assert.deepEqual(order, ['custom:x', 'envelope']);
  for (let i = 0; i < ENVELOPE_MAX_RECTS; i++) assert.match(code, new RegExp(`uniform vec4 dxrFx_envelope_F${i};`));
  assert.doesNotMatch(code, new RegExp(`dxrFx_envelope_F${ENVELOPE_MAX_RECTS}\\b`));
});

test('validateDepthEnvelope: defaults, merge, canvas fractions → y-up normalised, heaviest rects kept, errors', () => {
  const v = validateDepthEnvelope({}, null);
  assert.equal(v.maxFrontM, DEPTH_ENVELOPE_DEFAULTS.maxFrontM);
  assert.deepEqual(v.stage.f, [-1, 1, -1, 1]);
  const s = validateDepthEnvelope({ stage: { x: 0.1, y: 0.2, w: 0.5, h: 0.5 } }, v);
  assert.deepEqual(s.stage.f.map((x) => +x.toFixed(12)), [-0.8, 0.2, -0.4, 0.6]);
  assert.equal(validateDepthEnvelope({ bandM: 0.01 }, s).stage, s.stage, 'a key not given is kept');
  const many = Array.from({ length: 12 }, (_, i) => ({ x: 0, y: 0, w: 0.01 * (i + 1), h: 0.1, weight: i < 6 ? 1 : 0.5 }));
  const r = validateDepthEnvelope({ rects: many }, null).rects;
  assert.equal(r.length, ENVELOPE_MAX_RECTS);
  assert.ok(r.slice(0, 6).every((x) => x.weight === 1), 'full weight first');
  assert.equal(r[0].w, 0.06, 'then the largest');
  assert.equal(validateDepthEnvelope({ rects: [{ x: 0, y: 0, w: 0.5, h: 0.5, weight: 0 }] }, null).rects.length, 0, 'weight 0 dropped');
  assert.equal(validateDepthEnvelope({ edgeM: 0.05, maxFrontM: 0.02 }, null).edgeM, 0.02, 'edge clamped to the cap');
  assert.equal(validateDepthEnvelope(null, v), null);
  assert.throws(() => validateDepthEnvelope({ maxFrontM: -1 }, null), RangeError);
  assert.throws(() => validateDepthEnvelope({ bandM: 0 }, null), RangeError);
  assert.throws(() => validateDepthEnvelope({ rects: {} }, null), TypeError);
  assert.throws(() => validateDepthEnvelope({ canvasSizeM: [1] }, null), TypeError);
  assert.throws(() => validateDepthEnvelope({ band: 1 }, null), /unknown option/);
});

test('displayMetricsFrom: canvas metres from the panel pitch × devicePixelRatio; defaults flagged', () => {
  const info = { displayWidthMeters: 0.3456, displayHeightMeters: 0.1944, displayPixelWidth: 3840, displayPixelHeight: 2160, nominalViewerPosition: { z: 0.6 } };
  const m = displayMetricsFrom(info, { width: 960, height: 540 }, 2);
  near(m.metersPerCssPx, 0.00018, 1e-15, 'pitch × dpr');
  near(m.canvasSizeM[0], 0.1728, 1e-12, 'w');
  near(m.canvasSizeM[1], 0.0972, 1e-12, 'h');
  assert.equal(m.nominalViewerM, 0.6);
  assert.deepEqual(m.source, { size: 'display', viewer: 'display', eyeSeparation: 'default' });
  assert.equal(m.eyeSeparationM, DISPLAY_METRICS_DEFAULTS.eyeSeparationM);
  const none = displayMetricsFrom(null, { width: 100, height: 100 }, 1);
  assert.deepEqual(none.source, { size: 'default', viewer: 'default', eyeSeparation: 'default' });
  assert.equal(none.nominalViewerM, 0.65);
  const noViewer = displayMetricsFrom({ ...info, nominalViewerPosition: undefined }, null, 1);
  assert.equal(noViewer.source.viewer, 'default');
  assert.deepEqual(noViewer.canvasSizeM, [0, 0], 'no rect: zero, not NaN');
});

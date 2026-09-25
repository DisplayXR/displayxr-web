// Tests for the lift generator's CPU-side pieces (js/lift/gen/): the PLY writer (a round trip
// through a parser, and the per-field encodings a 3DGS loader depends on) and the morphology
// passes' semantics on synthetic depth, via the CPU references the GPU passes are checked
// against in test/lift-gen-gpu.html.

import test from 'node:test';
import assert from 'node:assert/strict';

import { emitLiftSplats, parsePly, PLY_PROPS, SH_C0, NO_LAYER } from '../js/lift/gen/ply-writer.js';
import { erodeRef, edgesRef, hiddenRef } from '../js/lift/gen/cpu-ref.js';
import { normaliseDisparity, revealAngles, LIFT_DEFAULTS } from '../js/lift/gen/lift-gen.js';

// ── PLY ───────────────────────────────────────────────────────────────────────────────────

function tinyScene({ W = 4, H = 3, bx = 1, by = 1, withLayer1 = true } = {}) {
  const PW = W + 2 * bx, PH = H + 2 * by;
  const out0 = new Float32Array(W * H * 4);
  for (let i = 0; i < W * H; i++) { out0[4 * i] = 0.5; out0[4 * i + 1] = 1; }
  out0[4 * 5 + 1] = 0.5;  // one soft matte pixel
  out0[4 * 6 + 1] = 0.0;  // one skipped pixel
  const rgbPad = new Uint8Array(PW * PH * 4);
  for (let i = 0; i < PW * PH; i++) { rgbPad[4 * i] = 255; rgbPad[4 * i + 1] = 128; rgbPad[4 * i + 2] = 0; rgbPad[4 * i + 3] = 255; }
  const out1 = new Float32Array(PW * PH * 4).fill(0);
  for (let i = 0; i < PW * PH; i++) out1[4 * i + 3] = -1000;
  if (withLayer1) {
    out1[4 * 0 + 3] = 0.0;               // a border texel (top-left corner)
    out1.set([0.25, 0.5, 0.75, 0.0], 4 * (2 * PW + 3)); // an interior hidden texel, far
  }
  return { W, H, PW, PH, bx, by, f: 10, invFar: 1 / 3, invNear: 1 / 0.7, out0, rgbPad, out1 };
}

test('PLY: header is standard 3DGS, body round-trips, sizes add up', () => {
  const job = tinyScene();
  const r = emitLiftSplats(job);
  assert.deepEqual(r.layerCounts, [11, 2]);
  assert.equal(r.splatCount, 13);
  const p = parsePly(r.ply);
  assert.equal(p.count, 13);
  assert.deepEqual(p.props, PLY_PROPS);
  assert.equal(p.headerBytes % 4, 0, 'body is 4-byte aligned');
  assert.equal(r.ply.byteLength, p.headerBytes + 13 * 17 * 4);
  const head = new TextDecoder().decode(new Uint8Array(r.ply, 0, p.headerBytes));
  assert.match(head, /^ply\nformat binary_little_endian 1\.0\n/);
  assert.match(head, /element vertex 13\n/);
});

test('PLY: positions unproject through the centre principal point (OpenCV, y down, z forward)', () => {
  const job = tinyScene();
  const { data } = parsePly(emitLiftSplats(job).ply);
  const z = 1 / (job.invFar + 0.5 * (job.invNear - job.invFar));
  // first splat = pixel (0,0): x = (0.5 − W/2)·z/f, y = (0.5 − H/2)·z/f
  assert.ok(Math.abs(data[0] - ((0.5 - 2) * z) / 10) < 1e-6);
  assert.ok(Math.abs(data[1] - ((0.5 - 1.5) * z) / 10) < 1e-6);
  assert.ok(Math.abs(data[2] - z) < 1e-6);
  assert.ok(data[1] < 0, 'top row is −y (y points DOWN)');
});

test('PLY: colour is SH0 (c−0.5)/C0, opacity is a logit, scales are log σ, rotation identity wxyz', () => {
  const job = tinyScene();
  const { data } = parsePly(emitLiftSplats(job).ply);
  const v = (i, k) => data[i * 17 + PLY_PROPS.indexOf(k)];
  assert.ok(Math.abs(v(0, 'f_dc_0') - 0.5 / SH_C0) < 1e-5);
  assert.ok(Math.abs(v(0, 'f_dc_1') - (128 / 255 - 0.5) / SH_C0) < 1e-5);
  assert.ok(Math.abs(v(0, 'f_dc_2') + 0.5 / SH_C0) < 1e-5);
  const sig = (x) => 1 / (1 + Math.exp(-x));
  assert.ok(sig(v(0, 'opacity')) > 0.99);
  assert.ok(Math.abs(sig(v(5, 'opacity')) - 0.5) < 1e-6, 'the matte pixel keeps α = 0.5');
  const z = data[2];
  assert.ok(Math.abs(Math.exp(v(0, 'scale_0')) - (0.65 * z) / 10) < 1e-6);
  assert.equal(v(0, 'scale_0'), v(0, 'scale_1'));
  assert.ok(Math.exp(v(0, 'scale_2')) < Math.exp(v(0, 'scale_0')), 'thin in z on a flat surface');
  // a flat (fronto-parallel) surface: identity rotation, w first
  assert.ok(Math.abs(v(0, 'rot_0') - 1) < 1e-6);
  for (const k of ['rot_1', 'rot_2', 'rot_3']) assert.ok(Math.abs(v(0, k)) < 1e-6);
  assert.deepEqual([v(0, 'nx'), v(0, 'ny'), v(0, 'nz')], [0, 0, 0]);
});

test('PLY: layer 1 is emitted only where it exists, in the padded frame, farther than layer 0', () => {
  const job = tinyScene();
  const { data } = parsePly(emitLiftSplats(job).ply);
  const zFar = 1 / job.invFar;
  const a = 11 * 17, b = 12 * 17;
  // border texel (0,0) of the padded raster = frame pixel (−1,−1): outside the frustum
  assert.ok(Math.abs(data[a] - ((-1 + 0.5 - 2) * zFar) / 10) < 1e-5);
  assert.ok(Math.abs(data[a + 2] - zFar) < 1e-5);
  // interior texel (3,2) = frame pixel (2,1)
  assert.ok(Math.abs(data[b] - ((2 + 0.5 - 2) * zFar) / 10) < 1e-5);
  assert.ok(Math.abs(data[b + 6] - (0.25 - 0.5) / SH_C0) < 1e-5);
  const none = emitLiftSplats(tinyScene({ withLayer1: false }));
  assert.deepEqual(none.layerCounts, [11, 0]);
  assert.ok(NO_LAYER > -1000);
});

/** local axis k (0,1,2) of splat i, rotated into the world by its wxyz quaternion */
function axis(data, i, k) {
  const [w, x, y, z] = [13, 14, 15, 16].map((j) => data[i * 17 + j]);
  const R = [
    [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
  ];
  return [R[0][k], R[1][k], R[2][k]];
}

function rampAndStep(extra = {}) {
  const W = 8, H = 1;
  const job = { ...tinyScene({ W, H, withLayer1: false }), ...extra };
  // gentle ramp in columns 0..3, then a big step at 4
  for (let u = 0; u < W; u++) job.out0[4 * u] = u < 4 ? 0.3 + 0.04 * u : 0.95;
  job.out0[4 * 5 + 1] = 1; job.out0[4 * 6 + 1] = 1;
  return parsePly(emitLiftSplats(job).ply).data;
}

test('PLY: surfels lie on the local tangent plane — a slant tilts them, a step does not', () => {
  const data = rampAndStep();
  const x1 = axis(data, 1, 0), n1 = axis(data, 1, 2);
  assert.ok(Math.abs(x1[2]) > 0.2, `ramp pixel's in-plane axis leaves the xy plane (${x1[2]})`);
  assert.ok(Math.abs(n1[2]) < 0.99, 'and its normal is no longer the view axis');
  // the step pixel's one-sided derivative takes the flat side: no tilt
  assert.ok(Math.abs(axis(data, 4, 0)[2]) < 1e-6);
  // the surfel is longer along the slope than across it, and thin along its normal
  const sx = Math.exp(data[1 * 17 + 10]), sy = Math.exp(data[1 * 17 + 11]), sn = Math.exp(data[1 * 17 + 12]);
  assert.ok(sx > sy && sn < 0.2 * sy);
});

test('PLY: the depth step of a grazing slant is capped at maxAniso footprints', () => {
  const W = 6, H = 1;
  const job = tinyScene({ W, H, withLayer1: false });
  for (let u = 0; u < W; u++) { job.out0[4 * u] = 0.1 + 0.15 * u; job.out0[4 * u + 1] = 1; }
  const data = parsePly(emitLiftSplats({ ...job, maxAniso: 3 }).ply).data;
  const a = axis(data, 2, 0);
  // in-plane axis direction ≈ (pix, 0, dz) with |dz| ≤ 3·pix  →  |a.z/a.x| ≤ 3 (+ the ray term)
  assert.ok(Math.abs(a[2] / a[0]) <= 3.3, `slope ${a[2] / a[0]}`);
});

test('PLY: orient:false gives fronto-parallel disks thickened by the slope', () => {
  const data = rampAndStep({ orient: false });
  const sz = (i) => Math.exp(data[i * 17 + 12]), sx = (i) => Math.exp(data[i * 17 + 10]);
  assert.ok(Math.abs(data[1 * 17 + 13] - 1) < 1e-9, 'identity rotation');
  assert.ok(sz(1) / sx(1) > 0.3, 'ramp pixel is thick');
  assert.ok(sz(4) / sx(4) < 0.2, 'the step pixel is not (one-sided min slope)');
});

test('parsePly rejects non-float and truncated files', () => {
  const r = emitLiftSplats(tinyScene());
  assert.throws(() => parsePly(r.ply.slice(0, r.ply.byteLength - 4)), /size/);
  const bad = new TextEncoder().encode('ply\nformat binary_little_endian 1.0\nelement vertex 1\nproperty uchar red\nend_header\n\0');
  assert.throws(() => parsePly(bad.buffer), /only float/);
});

// ── morphology on synthetic depth ─────────────────────────────────────────────────────────

/** A near square (d̂ = 0.9) on a far background (0.1), W×H. */
function squareScene(W = 40, H = 30, x0 = 12, x1 = 27, y0 = 10, y1 = 19) {
  const d = new Float32Array(W * H).fill(0.1);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) d[y * W + x] = 0.9;
  return { d, W, H, x0, x1, y0, y1 };
}

test('erosion: min-filter of radius R grows the far background into the square by exactly R', () => {
  const { d, W, H, x0, x1, y0, y1 } = squareScene();
  const e = erodeRef(d, W, H, 3);
  const cy = 15;
  // row through the middle: columns x0..x0+2 now far, x0+3 still near; symmetric on the right
  assert.equal(e[cy * W + x0 + 2], Math.fround(0.1));
  assert.equal(e[cy * W + x0 + 3], Math.fround(0.9));
  assert.equal(e[cy * W + x1 - 3], Math.fround(0.9));
  assert.equal(e[cy * W + x1 - 2], Math.fround(0.1));
  assert.equal(e[(y0 + 3) * W + 20], Math.fround(0.9));
  assert.equal(e[(y0 + 2) * W + 20], Math.fround(0.1));
  assert.equal(e[(y1 - 3) * W + 20], Math.fround(0.9));
  // idempotent on a flat field, and R = 0 is identity
  assert.deepEqual(erodeRef(d, W, H, 0), d);
});

test('edges: only FAR-side pixels are marked, with the direction the foreground lies in', () => {
  const { d, W, H, x0, x1, y0, y1 } = squareScene();
  const E = edgesRef(d, W, H, { tau: 0.04 });
  const at = (x, y, c) => E[4 * (y * W + x) + c];
  const cy = 15;
  // left of the square: fg on the RIGHT of the bg pixel (ΔR), 1 and 2 px away
  assert.ok(Math.abs(at(x0 - 1, cy, 1) - 0.8) < 1e-6);
  assert.ok(Math.abs(at(x0 - 2, cy, 1) - 0.8) < 1e-6);
  assert.equal(at(x0 - 3, cy, 1), 0);
  // right of it: fg on the LEFT (ΔL)
  assert.ok(at(x1 + 1, cy, 0) > 0);
  // above / below
  assert.ok(at(20, y0 - 1, 3) > 0, 'fg below');
  assert.ok(at(20, y1 + 1, 2) > 0, 'fg above');
  // the square itself (near side) is never an edge
  for (let x = x0; x <= x1; x++) assert.deepEqual([...E.subarray(4 * (cy * W + x), 4 * (cy * W + x) + 4)], [0, 0, 0, 0]);
});

test('hidden mask: a band INSIDE the foreground rim, Δ·band px wide, split by background side', () => {
  const { d, W, H, x0, x1 } = squareScene();
  const tau = 0.04;
  const E = edgesRef(d, W, H, { tau });
  // band = 5 px per unit step → a 0.8 step opens 4 px; K caps at 10
  const M = hiddenRef(d, E, W, H, { K: 10, band: 5.05, tau });
  const at = (x, y, c) => M[4 * (y * W + x) + c];
  const cy = 15;
  // right rim of the square (bg on the RIGHT of the hole) → maskRight, 4 px wide
  for (let x = x1; x > x1 - 4; x--) { assert.equal(at(x, cy, 0), 1, `x=${x}`); assert.equal(at(x, cy, 1), 0); }
  assert.equal(at(x1 - 4, cy, 0) + at(x1 - 4, cy, 1), 0, 'band stops at Δ·band');
  assert.equal(at(x1, cy, 2), 1, 'distance to the edge pixel');
  assert.ok(Math.abs(at(x1, cy, 3) - 0.1) < 1e-6, 'carries the background disparity');
  // left rim → maskLeft
  for (let x = x0; x < x0 + 4; x++) { assert.equal(at(x, cy, 1), 1); assert.equal(at(x, cy, 0), 0); }
  // background itself is never in the band
  assert.equal(at(x1 + 1, cy, 0) + at(x1 + 1, cy, 1), 0);
  assert.equal(at(x0 - 1, cy, 0) + at(x0 - 1, cy, 1), 0);
  // the square's centre is out of reach of every edge
  assert.equal(at(20, cy, 0) + at(20, cy, 1), 0);
});

test('hidden mask: the band is clamped at K and the outpaint border is always hidden-layer', () => {
  const { d, W, H, x1 } = squareScene();
  const tau = 0.04;
  const pad = [2, 2], inner = [W - 4, H - 4];
  const E = edgesRef(d, W, H, { pad, inner, tau });
  const M = hiddenRef(d, E, W, H, { pad, inner, K: 3, band: 100, tau });
  const at = (x, y, c) => M[4 * (y * W + x) + c];
  assert.equal(at(x1 - 2, 15, 0), 1);
  assert.equal(at(x1 - 3, 15, 0), 0, 'K = 3 caps an 80 px band');
  assert.deepEqual([at(0, 0, 0), at(0, 0, 1), at(0, 0, 2)], [1, 0, -1], 'left border → maskRight');
  assert.deepEqual([at(W - 1, 5, 0), at(W - 1, 5, 1), at(W - 1, 5, 2)], [0, 1, -1], 'right border → maskLeft');
});

test('hidden mask: a soft rim does not shorten the band — reach uses the pixel\'s own step too', () => {
  // 1-row scene: background 0.1 | a 3-px soft rim at 0.3 | a subject interior at 0.9, 200 px wide
  const W = 260, H = 5, tau = 0.04, d = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) d[y * W + x] = x < 20 ? 0.1 : x < 23 ? 0.3 : 0.9;
  const E = edgesRef(d, W, H, { tau });
  const M = hiddenRef(d, E, W, H, { K: 200, band: 100, tau });
  const inM = (x) => M[4 * (2 * W + x) + 1] === 1; // maskLeft: background on the left
  // the rim's own step (0.2) reaches 20 px; the interior (0.9 − 0.1 = 0.8) reaches 80 px
  assert.ok(inM(21) && inM(60) && inM(95), 'interior within its own reveal is hidden-layer');
  assert.ok(!inM(110), 'and stops at (d − d_bg)·band');
});

test('hidden mask: past 32 px the gather strides 2 px and still reaches K', () => {
  const W = 300, H = 5, tau = 0.04, d = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) d[y * W + x] = x < 10 ? 0 : 1;
  const E = edgesRef(d, W, H, { tau });
  const M = hiddenRef(d, E, W, H, { K: 250, band: 1000, tau });
  const inM = (x) => M[4 * (2 * W + x) + 1] === 1;
  // the far-side edge band is 2 px (x = 8, 9): every pixel out to K finds one of them
  for (let x = 10; x < 10 + 240; x++) assert.ok(inM(x), `x=${x}`);
});

test('normaliseDisparity: 2–98 % percentiles to [0,1]; relative maps to [zNear, zFar]; metric keeps 1/z', () => {
  const w = 100, h = 100;
  const data = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) data[i] = i / (w * h);
  const r = normaliseDisparity({ data, w, h }, 'disparity');
  assert.equal(r.dlo[0], 0);
  assert.equal(r.dlo[w * h - 1], 1);
  assert.ok(Math.abs(1 / r.invNear - LIFT_DEFAULTS.zNear) < 1e-9);
  assert.ok(Math.abs(1 / r.invFar - LIFT_DEFAULTS.zFar) < 1e-9);
  const m = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) m[i] = 1 + (i % 10);
  const rm = normaliseDisparity({ data: m, w, h }, 'metric');
  assert.ok(Math.abs(1 / rm.invFar - 10) < 1e-6 && Math.abs(1 / rm.invNear - 1) < 1e-6);
});

// ── outpaint border sizing ────────────────────────────────────────────────────────────────

test('outpaintBorders: the inward move of the edge content under the orbit turn, per side, clamped', async () => {
  const { outpaintBorders } = await import('../js/lift/gen/lift-gen.js');
  const w = 40, h = 30, W = 1000, H = 750, f = 1000, th = (15 * Math.PI) / 180, tanT = Math.tan(th);
  const invFar = 1 / 3, invNear = 1 / 0.7;
  const dlo = new Float32Array(w * h).fill(0); // everything at zFar = 3 m ...
  for (let y = 0; y < h; y++) dlo[y * w + w - 1] = 1; // ... except the RIGHT edge column at zNear
  const zp = 1.5;
  // reference: turn the edge point (x = ue·z/f, depth z) by ±θ about (0, 0, zp), project, take the
  // larger INWARD image move
  const turnNeed = (z, ue) => Math.max(...[-1, 1].map((sg) => {
    const x = (ue * z) / f, r = z - zp;
    const u = (f * (x * Math.cos(th) - sg * r * Math.sin(th))) / (zp + sg * x * Math.sin(th) + r * Math.cos(th));
    return ue < 0 ? u - ue : ue - u;
  }));
  const P = { ...LIFT_DEFAULTS, borderMaxFrac: 0.5, borderAreaMax: Infinity };
  const b = outpaintBorders({ dlo, w, h, invFar, invNear, zp, f, W, H, tanT, P });
  const needFar = turnNeed(3, -W / 2), needNear = turnNeed(0.7, W / 2);
  assert.ok(Math.abs(b.needed.left - needFar) <= 1, `left ${b.needed.left} vs ${needFar}`);
  assert.ok(Math.abs(b.needed.right - needNear) <= 1, `right ${b.needed.right} vs ${needNear}`);
  // the turn foreshortens the frame edge too: more than the small-angle f·tanθ·|1 − zp/z|
  assert.ok(needFar > f * tanT * Math.abs(1 - zp / 3) + 20, 'edge foreshortening counted');
  assert.equal(b.left, Math.ceil(1.1 * needFar) + 2, 'left = ceil(1.1·need) + 2');
  assert.ok(b.right > b.left, 'the side with near content needs more');
  // the cap bites
  const capped = outpaintBorders({ dlo, w, h, invFar, invNear, zp, f, W, H, tanT, P: { ...P, borderMaxFrac: 0.1 } });
  assert.equal(capped.right, 100);
  // the padded-area budget shrinks every side in proportion, never below the base border
  const tight = outpaintBorders({ dlo, w, h, invFar, invNear, zp, f, W, H, tanT, P: { ...P, borderAreaMax: 1.0 } });
  assert.ok((W + tight.left + tight.right) * (H + tight.top + tight.bottom) <= W * W, 'within budget');
  assert.ok(tight.left < b.left && tight.right < b.right && tight.right > tight.left, 'shrunk in proportion');
  assert.ok(tight.left >= Math.round(LIFT_DEFAULTS.borderFrac * W));
  // a flat scene AT the pivot still shows past its edge when turned (the plane foreshortens), but
  // never below the full-res base border
  const zf = 1 / (invFar + 0.5 * (invNear - invFar));
  const flat = outpaintBorders({ dlo: new Float32Array(w * h).fill(0.5), w, h, invFar, invNear, zp: zf, f, W, H, tanT, P });
  const flatNeed = (half) => { const x = (half * zf) / f; return half - (f * x * Math.cos(th)) / (zf + x * Math.sin(th)); };
  assert.equal(flat.left, Math.max(Math.round(LIFT_DEFAULTS.borderFrac * W), Math.ceil(1.1 * flatNeed(W / 2)) + 2));
  assert.equal(flat.top, Math.max(Math.round(LIFT_DEFAULTS.borderFrac * H), Math.ceil(1.1 * flatNeed(H / 2)) + 2));
  const tiny = outpaintBorders({ dlo: new Float32Array(w * h).fill(0.5), w, h, invFar, invNear, zp: zf, f, W, H, tanT: Math.tan(0.02), P });
  assert.equal(tiny.top, Math.round(LIFT_DEFAULTS.borderFrac * H), 'base border floor');
});

test('revealAngles: the hidden layer is sized for the drag orbit PLUS the tracked head/eye excursion', () => {
  const P = { ...LIFT_DEFAULTS, maxOrbitDeg: 15 };
  const deg = (r) => (r * 180) / Math.PI;
  // a portrait at 0.93 m: each eye is (5 cm + 31.5 mm) off the rest head, seen from the pivot
  const r = revealAngles(0.93, P);
  assert.ok(Math.abs(r.h - (15 + deg(Math.atan(0.0815 / 0.93)))) < 1e-9, `h ${r.h}`);
  assert.ok(Math.abs(r.v - deg(Math.atan(0.1 / 0.93))) < 1e-9, `v ${r.v}`);
  assert.ok(r.h > 19.5 && r.h < 20.5 && r.v > 6 && r.v < 6.3);
  // U/D weight = tan h / tan v, clamped to [1, 4]
  assert.ok(Math.abs(r.hWeight - Math.tan((r.h * Math.PI) / 180) / Math.tan((r.v * Math.PI) / 180)) < 1e-9);
  assert.ok(r.hWeight > 3 && r.hWeight < 3.6, `hWeight ${r.hWeight}`);
  // a near pivot is floored at the nominal viewing distance; a far metric pivot is explore's 2 m
  assert.equal(revealAngles(0.3, P).D, 0.6);
  assert.equal(revealAngles(28, P).D, 2);
  assert.equal(revealAngles(28, P).hWeight, 4);
  // explicit overrides win; no head excursion ⇒ no margin
  assert.equal(revealAngles(0.93, { ...P, revealMarginDeg: 0 }).h, 15);
  assert.ok(revealAngles(0.93, { ...P, viewerOffset: { x: 0, y: 0 }, viewerIpd: 0 }).h === 15);
  // a taller viewer excursion lowers the horizontal preference
  assert.ok(revealAngles(0.93, { ...P, viewerOffset: { y: 0.2 } }).hWeight < r.hWeight);
});

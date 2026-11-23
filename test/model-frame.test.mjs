// addModel's robust framing (web#327): the area-weighted surface sample, the three numbers it
// gives (pivot, screen plane, fit extent), the full-box guard, `framing: 'box'`, and the two
// viewers' fitTo third argument. Dependency-free: synthetic triangle soups and the fake engines.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  sampleSurface,
  robustFrame,
  resolveFraming,
  fitOptionsOf,
  meshesOfPlayCanvasEntity,
  ROBUST_SAMPLES,
  SCREEN_PLANE_PERCENTILE,
  FULL_BOX_CAP,
  FRAMINGS,
} from '../js/inline3d-model-frame.js';
import { boundsOfEntity, frameOfEntity } from '../js/inline3d-model-playcanvas.js';
import { validateModelCall } from '../js/inline3d-model-entry.js';
import { fitScale } from '../js/inline3d-splat-playcanvas.js';
import { framedSubjectBounds } from '../js/inline3d-splat-shared.js';
import { installDom, makeCanvas, makeTHREE } from './stubs.mjs';

installDom();
const { SceneViewer } = await import('../js/inline3d-viewer.js');
const { PlayCanvasSplatViewer } = await import('../js/inline3d-splat-playcanvas.js');

const near = (a, b, eps, what = '') => assert.ok(Math.abs(a - b) <= eps, `${what} ${a} !~= ${b} (±${eps})`);

/** An axis-aligned rectangle as two triangles. `axis` is the normal: 'x' | 'y' | 'z'. */
function rect(axis, at, [a0, a1], [b0, b1]) {
  const P = [];
  const put = (a, b) => {
    if (axis === 'z') P.push(a, b, at);
    else if (axis === 'y') P.push(a, at, b);
    else P.push(at, a, b);
  };
  put(a0, b0); put(a1, b0); put(a1, b1);
  put(a0, b0); put(a1, b1); put(a0, b1);
  return { positions: new Float32Array(P), indices: null };
}

/** A grid of `n`×`n` tiny triangles in a square of side `size` centred at (cx, cy, cz), facing +z. */
function denseCluster(n, size, [cx, cy, cz]) {
  const P = [];
  const d = size / n;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x = cx - size / 2 + i * d;
      const y = cy - size / 2 + j * d;
      P.push(x, y, cz, x + d, y, cz, x, y + d, cz);
    }
  }
  return { positions: new Float32Array(P), indices: null };
}

function boxOf(meshes) {
  const mn = [Infinity, Infinity, Infinity];
  const mx = [-Infinity, -Infinity, -Infinity];
  for (const m of meshes) {
    for (let i = 0; i < m.positions.length; i += 3) {
      for (let c = 0; c < 3; c++) {
        mn[c] = Math.min(mn[c], m.positions[i + c]);
        mx[c] = Math.max(mx[c], m.positions[i + c]);
      }
    }
  }
  return { center: mn.map((v, i) => (v + mx[i]) / 2), extent: mn.map((v, i) => mx[i] - v) };
}

// ── the sample ───────────────────────────────────────────────────────────────────────────────

test('the sample is deterministic (fixed seed) and the default size', () => {
  const m = [rect('y', 0, [-1, 1], [-1, 1])];
  const a = sampleSurface(m);
  const b = sampleSurface(m);
  assert.equal(a.x.length, ROBUST_SAMPLES);
  assert.deepEqual(Array.from(a.z.slice(0, 64)), Array.from(b.z.slice(0, 64)));
  assert.equal(sampleSurface([]), null);
  assert.equal(sampleSurface([{ positions: new Float32Array(9), indices: null }]), null, 'zero area: nothing to sample');
});

test('AREA weighting: a dense cluster of tiny triangles does not drag the pivot or the screen plane', () => {
  // A 2×2 floor-facing-the-viewer panel at z = 0 (area 4) and, far forward, 40 000 tiny triangles
  // (an "eye" or a text decal) totalling ~0.005 area — 99.9% of the vertices, 0.1% of the surface.
  const panel = rect('z', 0, [-1, 1], [-1, 1]);
  const decal = denseCluster(200, 0.1, [0.5, 0.5, 0.8]);
  // A thin wall through the middle so z has some spread for the percentiles (area 0.4, z ±0.1).
  const wall = rect('x', 0, [-1, 1], [-0.1, 0.1]);
  const meshes = [panel, decal, wall];
  const f = robustFrame(meshes, boxOf(meshes));
  near(f.center[0], 0, 0.05, 'pivot x stays at the panel median');
  near(f.center[2], 0, 0.02, 'pivot z stays on the panel');
  assert.ok(f.screenPlaneZ < 0.1, `screen plane not pulled to the decal (${f.screenPlaneZ})`);
  // By vertex count the decal would be everything: its z would be the median.
  const vz = [];
  for (const m of meshes) for (let i = 2; i < m.positions.length; i += 3) vz.push(m.positions[i]);
  vz.sort((a, b) => a - b);
  near(vz[vz.length >> 1], 0.8, 1e-6, 'a vertex median WOULD sit on the decal');
});

test('screen plane = the 75th-percentile depth: ~25% of the surface in front of the glass', () => {
  // A wall in the y-z plane, z uniform on [-1, 1]: p50 = 0, p75 = 0.5, p01/p99 = ∓0.98.
  const m = [rect('x', 0, [0, 1], [-1, 1])];
  const f = robustFrame(m, boxOf(m));
  assert.equal(SCREEN_PLANE_PERCENTILE, 0.75);
  near(f.screenPlaneZ, 0.5, 0.02, 'p75 z');
  near(f.center[2], 0, 0.02, 'pivot z = median');
  near(f.depthRange[0], -0.98, 0.02, 'depthRange p01');
  near(f.depthRange[1], 0.98, 0.02, 'depthRange p99');
  near(f.center[1], 0.5, 1e-9, 'pivot y = box centre y (unchanged)');
  // Share of samples in front of the screen plane.
  const S = sampleSurface(m);
  let front = 0;
  for (const z of S.z) if (z > f.screenPlaneZ) front++;
  near(front / S.z.length, 0.25, 0.01, 'share in front');
});

test('full-box guard: a thin tail is trimmed from the fit, but the FULL box never exceeds 90% of the tile', () => {
  // A 1×1×1 body (its six faces) and a long thin tail behind it to z = -3 (tiny area).
  const body = [
    rect('z', 0.5, [-0.5, 0.5], [-0.5, 0.5]), rect('z', -0.5, [-0.5, 0.5], [-0.5, 0.5]),
    rect('x', 0.5, [-0.5, 0.5], [-0.5, 0.5]), rect('x', -0.5, [-0.5, 0.5], [-0.5, 0.5]),
    rect('y', 0.5, [-0.5, 0.5], [-0.5, 0.5]), rect('y', -0.5, [-0.5, 0.5], [-0.5, 0.5]),
  ];
  const tail = rect('y', 0, [-0.01, 0.01], [-3, -0.5]);
  const meshes = [...body, tail];
  const box = boxOf(meshes);
  const margin = 0.8;
  const f = robustFrame(meshes, box, { margin });
  near(f.center[2], 0, 0.02, 'pivot on the body, not the box centre (-1.25)');
  assert.ok(Math.abs(box.center[2] - -1.25) < 1e-6);
  // The guard binds on z: the full box about the pivot is 2 × 3 = 6 deep, so the fit extent is
  // at least 6 × margin / 0.9 — much more than the trimmed ~1.
  const symFullZ = 2 * Math.max(box.center[2] + box.extent[2] / 2 - f.center[2], f.center[2] - (box.center[2] - box.extent[2] / 2));
  near(f.extent[2], (symFullZ * margin) / FULL_BOX_CAP, 1e-9, 'z extent = the guard');
  // And on the screen: the full box about the pivot, at the fitted scale, is at most
  // FULL_BOX_CAP of the tile on the axes the margin binds ('contain': both). ('height' keeps its
  // own rule for the width: it may run to the tile's edge, never past it.)
  const vH = 0.24;
  const horizFull = Math.hypot(2 * Math.max(0.5 - f.center[0], f.center[0] + 0.5), symFullZ);
  const sc = fitScale({ extent: f.extent, fit: 'contain', margin, vH, aspect: 1, fitSweep: true, depthLimit: 100 });
  assert.ok(horizFull * sc <= FULL_BOX_CAP * vH + 1e-9, `contain: swept full box ${horizFull * sc} > ${FULL_BOX_CAP * vH}`);
  assert.ok(1 * sc <= FULL_BOX_CAP * vH + 1e-9, 'contain: full height');
  const sh = fitScale({ extent: f.extent, fit: 'height', margin, vH, aspect: 1, fitSweep: true, depthLimit: 100 });
  assert.ok(1 * sh <= FULL_BOX_CAP * vH + 1e-9, 'height: full height');
  // A compact subject with no outlier (a cube's faces reach its box): the trimmed extent IS the
  // box, and the guard (the full box at 0.9) does not bind.
  const cube = robustFrame(body, boxOf(body), { margin });
  near(cube.extent[1], 1, 0.01, 'cube height extent');
  assert.ok(cube.extent[1] >= (1 * margin) / FULL_BOX_CAP);
});

test('robustFrame refuses a surface that does not lie in the box (unreadable / quantized geometry)', () => {
  const m = [rect('z', 0, [-1, 1], [-1, 1])];
  assert.equal(robustFrame(m, { center: [10, 10, 10], extent: [1, 1, 1] }), null);
  assert.equal(robustFrame([], boxOf(m)), null);
  assert.equal(robustFrame(m, null), null);
});

// ── the option ──────────────────────────────────────────────────────────────────────────────

test("framing: 'robust' (default) | 'box'; anything else throws at the call", () => {
  assert.deepEqual(FRAMINGS, ['robust', 'box']);
  assert.equal(resolveFraming(undefined), 'robust');
  assert.equal(resolveFraming('box'), 'box');
  assert.throws(() => resolveFraming('tight'), /framing must be 'robust' or 'box' \(got "tight"\)/);
  const route = { engine: 'playcanvas', explicit: false };
  assert.throws(() => validateModelCall(makeCanvas(), 'a.glb', { framing: 3 }, route), /framing must be/);
  validateModelCall(makeCanvas(), 'a.glb', { framing: 'box' }, route);
  assert.equal(fitOptionsOf({ center: [0, 0, 0], extent: [1, 1, 1] }), undefined, 'a box frame makes the 2-arg call');
  assert.deepEqual(fitOptionsOf({ center: [0, 0, 0], extent: [1, 1, 1], screenPlaneZ: 0.2 }), { screenPlaneZ: 0.2 });
});

// ── PlayCanvas: reading the entity ──────────────────────────────────────────────────────────

/** A fake render entity whose one mesh instance carries readable triangles and an AABB. */
function fakeEntity(mesh, { translate = [0, 0, 0] } = {}) {
  const P = mesh.positions;
  const nv = P.length / 3;
  const b = boxOf([mesh]);
  const world = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, translate[0], translate[1], translate[2], 1]);
  const mi = {
    aabb: {
      center: { x: b.center[0] + translate[0], y: b.center[1] + translate[1], z: b.center[2] + translate[2] },
      halfExtents: { x: b.extent[0] / 2, y: b.extent[1] / 2, z: b.extent[2] / 2 },
    },
    node: { getWorldTransform: () => ({ data: world }) },
    mesh: {
      vertexBuffer: { numVertices: nv },
      primitive: [{ type: 4, base: 0, count: nv, indexed: false }],
      getPositions(out) {
        out.set(P);
        return nv;
      },
    },
  };
  return { findComponents: (t) => (t === 'render' ? [{ meshInstances: [mi] }] : []) };
}

test("PlayCanvas: frameOfEntity reads the triangles through the node's world transform; 'box' = boundsOfEntity exactly", () => {
  const wall = rect('x', 0, [0, 1], [-1, 1]);
  const e = fakeEntity(wall, { translate: [0, 0, 2] });
  const meshes = meshesOfPlayCanvasEntity(e);
  assert.equal(meshes.length, 1);
  near(meshes[0].positions[2], -1 + 2, 1e-6, 'translated');
  const robust = frameOfEntity({}, e);
  near(robust.screenPlaneZ, 2.5, 0.02, 'p75 in content space');
  near(robust.center[2], 2, 0.02);
  const box = frameOfEntity({}, e, { framing: 'box' });
  assert.deepEqual(box, boundsOfEntity({}, e), "framing:'box' is the old frame, number for number");
  assert.equal(box.screenPlaneZ, undefined);
  // No readable triangles (the AABB-only engine fake): robust falls back to the box.
  const aabbOnly = { findComponents: () => [{ meshInstances: [{ aabb: { center: { x: 0, y: 1, z: 0 }, halfExtents: { x: 0.5, y: 1, z: 0.25 } } }] }] };
  assert.deepEqual(frameOfEntity({}, aabbOnly), { center: [0, 1, 0], extent: [1, 2, 0.5] });
});

// ── the viewers' fitTo(center, extent, opts) ────────────────────────────────────────────────

function viewers(opts = {}) {
  const { THREE } = makeTHREE();
  const o = { virtualDisplayHeight: 0.24, fit: 'contain', margin: 0.8, orbit: false, idleSpin: 0, ...opts };
  return [new SceneViewer(THREE, makeCanvas(400, 400), o), new PlayCanvasSplatViewer(makeCanvas(400, 400), o)];
}

test('fitTo without opts (or opts without screenPlaneZ) is the old fit, bit for bit, on both viewers', () => {
  for (const v of viewers()) {
    const [w] = v instanceof SceneViewer ? viewers() : viewers().slice(1);
    v.fitTo([0.2, 0.1, -0.3], [1.2, 0.6, 2.0]);
    w.fitTo([0.2, 0.1, -0.3], [1.2, 0.6, 2.0], {});
    assert.equal(JSON.stringify(w.getSubjectBounds()), JSON.stringify(v.getSubjectBounds()));
    assert.equal(v.getSubjectBounds().center.z, 0, 'centre on the glass');
  }
});

test('fitTo screenPlaneZ: that depth lands on the glass, the pivot stays the centre, zoom keeps it there; both viewers agree', () => {
  const [sv, pv] = viewers();
  const c = [0.1, 0.5, 0.1];
  const e = [0.7, 1.0, 1.0];
  for (const v of [sv, pv]) v.fitTo(c, e, { screenPlaneZ: 0.22, depthRange: [-0.4, 0.45] });
  for (const zoom of [1, 2.5]) {
    for (const v of [sv, pv]) v.setPose({ zoom });
    const b = sv.getSubjectBounds();
    assert.equal(JSON.stringify(pv.getSubjectBounds()), JSON.stringify(b), `zoom ${zoom}: both viewers`);
    // Pivot (content z 0.1) sits s·(0.1 − 0.22) behind the glass, so content z 0.22 is at z = 0.
    near(b.center.z, b.scale * (0.1 - 0.22), 1e-12, `zoom ${zoom}: pivot slide`);
    near(sv._pivot.position.z, b.center.z, 1e-12, 'three: the pivot group carries it');
  }
  const f = sv.getFocus();
  assert.deepEqual([f.x, f.y, f.z], c, 'still turns about the centre');
  // depth:'auto' measures the robust depth range relative to the glass, at zoom 1.
  for (const v of [sv, pv]) {
    const fb = framedSubjectBounds(v);
    near(fb.front, v._fitScale * (0.45 - 0.22), 1e-12, 'front');
    near(fb.back, v._fitScale * (-0.4 - 0.22), 1e-12, 'back');
  }
  // A depthOffset still rides on top; resetPose clears it, not the framing.
  sv.setPose({ zoom: 1, depthOffset: 0.01 });
  near(sv.getSubjectBounds().center.z, 0.01 + sv._fitScale * (0.1 - 0.22), 1e-12);
  sv.resetPose();
  near(sv.getSubjectBounds().center.z, sv._fitScale * (0.1 - 0.22), 1e-12);
  // A later 2-arg fit (e.g. a page refitting) drops the slide.
  sv.fitTo(c, e);
  assert.equal(sv.getSubjectBounds().center.z, 0);
  assert.equal(sv._framedDepth, null);
  sv.dispose();
  pv.dispose();
});

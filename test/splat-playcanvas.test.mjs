// Tests for the PlayCanvas splat backend's PURE parts — everything that decides a number or a
// string before the engine is touched: the perf mapping, the two shader-chunk rewrites, the
// projection/frustum extraction, the pivot and its inverse (which is how the eyes, not the
// splat, move), the fit, the capture camera, the source-format routing, the engine switch, the
// handle's pre-load queue, and the three-free camera-rig builder.
//
// No `playcanvas` here, and none needed: ./inline3d-splat-playcanvas.js imports the engine
// DYNAMICALLY, which is the same property that keeps it off a Spark-only page. The GPU half is
// measured in the browser (docs/playcanvas-adapter.md §Gates).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  playcanvasPerfSettings,
  patchPlayCanvasQuadExtent,
  PLAYCANVAS_QUAD_SIGMA,
  SPLAT_PERF_PRESETS,
} from '../js/inline3d-splat-perf.js';
import {
  patchGsplatFootprint,
  perspectiveFov,
  perspectiveOffAxis,
  frustumFromProjection,
  pivotMatrix,
  pivotInverseTRS,
  poseMatrix,
  quatFromMatrix,
  mat4Mul,
  mat4Invert,
  transformPoint,
  fitScale,
  captureProjection,
  capturePose,
  engineFormatFor,
  nearestCentreToRay,
  pickViewPath,
  attachPlayCanvasSplat,
  describeResource,
  readCloud,
} from '../js/inline3d-splat-playcanvas.js';
import { coverageExponent } from '../js/inline3d-splat-shared.js';
import {
  resolveSplatEngine,
  sampleCloudRestSpace,
  sampleCloudCentres,
  centresVisitor,
  RIG_SAMPLE_CAP,
} from '../js/inline3d-splat-rig.js';
import { cameraRigFromCamera, cameraRigFromPose } from '../js/inline3d-three.js';
import { SceneViewer } from '../js/inline3d-viewer.js';
import { installDom, makeCanvas, makeTHREE } from './stubs.mjs';

const near = (a, b, eps, what = '') => assert.ok(Math.abs(a - b) < eps, `${what} ${a} !~= ${b}`);
const nearArr = (a, b, eps, what = '') => {
  assert.equal(a.length, b.length, `${what} length`);
  for (let i = 0; i < a.length; i++) near(a[i], b[i], eps, `${what}[${i}]`);
};
const I16 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

// The two engine chunks, quoted from playcanvas@2.22.3's npm build — TABS and all, because the
// build re-indents and the anchors must survive that.
const CORNER_2_22_3 = [
  '#else',
  '\t\tvec3 vp = camera_params.w == 1.0 ? vec3(0.0, 0.0, 1.0) : v;',
  '\t\tfloat J1 = focal / vp.z;',
  '\t\tvec2 J2 = -J1 / vp.z * vp.xy;',
  '\t\tmat3 J = mat3(',
  '\t\t\tJ1, 0.0, J2.x,',
  '\t\t\t0.0, J1, J2.y,',
  '\t\t\t0.0, 0.0, 0.0',
  '\t\t);',
  '\t#endif',
].join('\n');
const COMMON_2_22_3 = [
  'void clipCorner(inout SplatCorner corner, float alpha) {',
  '\tfloat alphaClipValue = alphaClipForward;',
  '\tfloat clip = min(1.0, sqrt(max(0.0, log(alpha / alphaClipValue))) * 0.5);',
  '\tcorner.offset *= clip;',
  '\tcorner.uv *= clip;',
  '}',
].join('\n');

// ── 1. engine switch ────────────────────────────────────────────────────────────────────────

test('engine: unset and "spark" are Spark; "playcanvas" is the new backend; anything else throws', () => {
  assert.equal(resolveSplatEngine(undefined), 'spark');
  assert.equal(resolveSplatEngine({}), 'spark');
  assert.equal(resolveSplatEngine({ engine: 'spark' }), 'spark');
  assert.equal(resolveSplatEngine({ engine: 'playcanvas' }), 'playcanvas');
  assert.throws(() => resolveSplatEngine({ engine: 'PlayCanvas' }), /unknown engine "PlayCanvas"/);
  assert.throws(() => resolveSplatEngine({ engine: 'babylon' }), /expected 'spark' or 'playcanvas'/);
});

// ── 2. perf mapping ─────────────────────────────────────────────────────────────────────────

test('perf unset: engine defaults except minPixelSize 0 (Spark keeps sub-2px splats)', () => {
  for (const p of [undefined, null]) {
    const r = playcanvasPerfSettings(p);
    assert.deepEqual(r.settings, { minPixelSize: 0 });
    assert.equal(r.quadExtent, null);
    assert.equal(r.applied.preset, 'default');
  }
});

test('perf:false is the kill switch — nothing is touched, not even minPixelSize', () => {
  const r = playcanvasPerfSettings(false);
  assert.deepEqual(r.settings, {});
  assert.equal(r.quadExtent, null);
  assert.equal(r.applied, null);
});

test("'exact' maps minAlpha onto alphaClipForward and reports the engine's native alpha radius", () => {
  const r = playcanvasPerfSettings('exact');
  assert.equal(r.settings.alphaClipForward, SPLAT_PERF_PRESETS.exact.minAlpha);
  assert.equal(r.settings.minPixelSize, 0);
  assert.equal(r.quadExtent, null, 'exact never shrinks the quad');
  assert.equal(r.applied.alphaRadius, 'native');
});

test("'balanced' (and true) cap the quad at √6σ of the engine's √8σ", () => {
  for (const p of ['balanced', true]) {
    const r = playcanvasPerfSettings(p);
    near(r.quadExtent, Math.sqrt(6) / Math.sqrt(8), 1e-12, 'k');
    near(r.applied.maxStdDev, Math.sqrt(6), 1e-12, 'reported σ');
    assert.equal(r.settings.minPixelSize, 0);
    assert.equal(r.applied.preset, 'balanced');
  }
});

test("'aggressive' → 2σ quad and a 2 px diameter cull (Spark's 1 px RADIUS)", () => {
  const r = playcanvasPerfSettings('aggressive');
  near(r.quadExtent, 2 / PLAYCANVAS_QUAD_SIGMA, 1e-12);
  assert.equal(r.settings.minPixelSize, 2);
});

test('an options object: engine-native keys pass through and win; Spark-only keys are named, not applied', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const r = playcanvasPerfSettings({ splatBudget: 600000, minPixelSize: 1.5, maxStdDev: 3, lod: true, falloff: 0.5 });
  assert.equal(r.settings.splatBudget, 600000);
  assert.equal(r.settings.minPixelSize, 1.5);
  assert.equal(r.quadExtent, null, 'maxStdDev ≥ √8 is not a shrink and is not applied');
  assert.deepEqual(r.ignored.sort(), ['falloff', 'lod']);
  assert.equal(warn.mock.callCount(), 1, 'one warning names both');
});

test('an unknown preset warns and falls back to the default mapping', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const r = playcanvasPerfSettings('turbo');
  assert.deepEqual(r.settings, { minPixelSize: 0 });
  assert.equal(warn.mock.callCount(), 1);
});

// ── 3. shader-chunk rewrites ────────────────────────────────────────────────────────────────

test('footprint patch: separate y focal from viewport_size.y · P[1][1], on the tabbed 2.22.3 chunk', () => {
  const r = patchGsplatFootprint(CORNER_2_22_3);
  assert.equal(r.ok, true);
  assert.match(r.src, /float J1y = \(viewport_size\.y \* matrix_projection\[1\]\[1\]\) \/ vp\.z;/);
  assert.match(r.src, /vec2 J2 = vec2\(-J1 \/ vp\.z \* vp\.x, -J1y \/ vp\.z \* vp\.y\);/);
  assert.match(r.src, /0\.0, J1y, J2\.y,/);
  assert.ok(!/0\.0, J1, J2\.y,/.test(r.src), 'the old y row is gone');
  assert.equal(patchGsplatFootprint(r.src).src, r.src, 'idempotent');
});

test('footprint patch declines (ok:false, source untouched) when the anchor moved', () => {
  const moved = CORNER_2_22_3.replace('vec2 J2 = -J1 / vp.z * vp.xy;', 'vec2 J2 = someOtherForm(vp);');
  const r = patchGsplatFootprint(moved);
  assert.equal(r.ok, false);
  assert.equal(r.src, moved);
});

test('quad-extent patch caps clipCorner at k, scaling offset AND uv together', () => {
  const r = patchPlayCanvasQuadExtent(COMMON_2_22_3, Math.sqrt(6) / Math.sqrt(8));
  assert.equal(r.ok, true);
  assert.match(r.src, /float clip = min\(0\.8660254 \/\* dxrQuadExtent \*\/, sqrt\(/);
  assert.match(r.src, /corner\.uv \*= clip;/, 'uv still rides the same factor — truncation, not squash');
  assert.equal(patchPlayCanvasQuadExtent(r.src, 0.5).src, r.src, 'idempotent');
  assert.equal(patchPlayCanvasQuadExtent(COMMON_2_22_3, 1).ok, false, 'k = 1 is not a shrink');
  assert.equal(patchPlayCanvasQuadExtent('no anchor here', 0.5).ok, false);
});

// ── 4. projections ──────────────────────────────────────────────────────────────────────────

test('frustumFromProjection recovers fov / aspect / near / far (the numbers LOD reads)', () => {
  const P = perspectiveFov(35, 16 / 9, 0.001, 1000);
  const f = frustumFromProjection(P);
  near(f.fov, 35, 1e-9, 'fov');
  near(f.aspectRatio, 16 / 9, 1e-12, 'aspect');
  near(f.nearClip, 0.001, 1e-9, 'near');
  near(f.farClip, 1000, 1e-3, 'far');
});

test('an off-axis skew does not change the recovered vertical fov (it lives in [2][0])', () => {
  const a = perspectiveOffAxis(-0.1, 0.1, 0.05, -0.05, 0.1, 100);
  const b = perspectiveOffAxis(-0.08, 0.12, 0.05, -0.05, 0.1, 100);
  assert.notEqual(b[8], 0, 'skewed');
  near(frustumFromProjection(a).fov, frustumFromProjection(b).fov, 1e-12);
});

test('perspectiveFov matches three.js PerspectiveCamera for the SceneViewer mono camera', () => {
  // three: top = near·tan(fov/2), makePerspective(left, left+width, top, top-height, near, far)
  const fov = 35, aspect = 1.5, n = 0.001, f = 1000;
  const P = perspectiveFov(fov, aspect, n, f);
  const t = 1 / Math.tan((fov * Math.PI) / 360);
  near(P[5], t, 1e-12, 'y focal');
  near(P[0], t / aspect, 1e-12, 'x focal');
  assert.equal(P[8], 0);
  assert.equal(P[9], 0);
  assert.equal(P[11], -1);
});

test('captureProjection: centred principal point is symmetric; an off-centre cx skews the right way', () => {
  const K = { fx: 1000, fy: 1000, cx: 1024, cy: 576, width: 2048, height: 1152 };
  const P = captureProjection(K, 2048 / 1152);
  near(P[8], 0, 1e-12, 'no horizontal skew');
  near(P[9], 0, 1e-12, 'no vertical skew');
  near(frustumFromProjection(P).fov, (2 * Math.atan(576 / 1000) * 180) / Math.PI, 1e-9, 'vertical fov is the lens');
  // Principal point LEFT of centre → the frustum's centre is RIGHT of the axis → +[2][0].
  const Q = captureProjection({ ...K, cx: 900 }, 2048 / 1152);
  assert.ok(Q[8] > 0, `skew ${Q[8]}`);
  // Canvas aspect widens the horizontal only.
  const W = captureProjection(K, 2);
  near(W[5], P[5], 1e-12, 'vertical kept');
  assert.ok(W[0] < P[0], 'horizontal widened');
});

test('capturePose: the identity rest pose under flipY is the identity camera (two half-turns cancel)', () => {
  const c = capturePose({ position: [0, 0, 0], rotation: [0, 0, 0, 1] }, true);
  nearArr(Array.from(c.matrix), I16, 1e-12, 'pose');
  // Without the content flip only the camera-convention half-turn remains: looking down +z.
  const d = capturePose({ position: [0, 0, 0], rotation: [0, 0, 0, 1] }, false);
  near(d.matrix[10], -1, 1e-12, 'z axis flipped');
  near(d.matrix[5], -1, 1e-12, 'y axis flipped');
});

// ── 5. the pivot, and why the eyes can carry it instead of the splat ────────────────────────

const POSES = [
  { yaw: 0, pitch: 0, scale: 1, focus: [0, 0, 0], orbitCentre: [0, 0, 0], depthOffset: 0 },
  { yaw: 37, pitch: -22, scale: 0.013, focus: [2.4, 18.2, -35.4], orbitCentre: [0, 0, 0], depthOffset: 0.02 },
  { yaw: -120, pitch: 50, scale: 3.5, focus: [0.1, -0.2, 1.7], orbitCentre: [0.1, -0.2, 1.7], depthOffset: -0.05 },
];

test('pivotInverseTRS is exactly the inverse of pivotMatrix', () => {
  for (const s of POSES) {
    const M = pivotMatrix(s);
    const t = pivotInverseTRS(s);
    const Minv = poseMatrix(t.position, t.rotation);
    for (let i = 0; i < 12; i++) if (i % 4 !== 3) Minv[i] *= t.scale;
    nearArr(Array.from(mat4Mul(M, Minv)), I16, 1e-9, 'M·M⁻¹');
  }
});

test('camera rig at rest: recentre:false with a focus is the identity (the capture does not move)', () => {
  const f = [0.3, -0.1, 1.68];
  const M = pivotMatrix({ yaw: 0, pitch: 0, scale: 1, focus: f, orbitCentre: f });
  nearArr(Array.from(M), I16, 1e-12, 'M');
  // …and while orbiting, the focus is the fixed point.
  const R = pivotMatrix({ yaw: 30, pitch: 10, scale: 1, focus: f, orbitCentre: f });
  nearArr(transformPoint(R, ...f), f, 1e-12, 'focus');
});

test('RenderView plumbing: eyes under inverse(pivot) see exactly what a pivoted splat shows fixed eyes', () => {
  // RenderView.updateTransforms: viewInvOff = parentWorld · viewInv, viewOff = inverse(that).
  // Moving-eyes: parent = M⁻¹, content point p. Moving-content (SceneViewer): no parent, M·p.
  const P = perspectiveOffAxis(-0.06, 0.04, 0.03, -0.03, 0.05, 50);
  const eye = poseMatrix([0.031, 0.01, 0.5], [0, 0.05, 0, Math.sqrt(1 - 0.0025)]);
  for (const s of POSES) {
    const M = pivotMatrix(s);
    const Minv = mat4Invert(M);
    const viewOff = mat4Invert(mat4Mul(Minv, eye));
    const viewFixed = mat4Invert(eye);
    for (const p of [[0, 0, 0], [1, 2, -3], [-0.4, 0.2, 0.9], s.focus]) {
      const a = transformPoint(mat4Mul(P, viewOff), ...p);
      const q = transformPoint(M, ...p);
      const b = transformPoint(mat4Mul(P, viewFixed), ...q);
      nearArr(a, b, 1e-9, `clip of ${p}`);
    }
  }
});

test('quatFromMatrix round-trips poseMatrix', () => {
  for (const q0 of [[0, 0, 0, 1], [1, 0, 0, 0], [0.2, -0.4, 0.1, Math.sqrt(1 - 0.21)], [0, 0.7071067811865476, 0, 0.7071067811865476]]) {
    const q = quatFromMatrix(poseMatrix([1, 2, 3], q0));
    const sign = Math.sign(q[3] || q[0]) === Math.sign(q0[3] || q0[0]) ? 1 : -1;
    nearArr(q.map((v) => v * sign), q0, 1e-9, 'q');
  }
});

test('fitScale is SceneViewer.fitTo’s scale, for every fit mode', () => {
  installDom();
  const { THREE } = makeTHREE();
  for (const fit of ['contain', 'height', 'cover', 'none']) {
    for (const [w, h] of [[400, 400], [640, 360], [300, 500]]) {
      for (const e of [[1, 1, 1], [127.6, 39.0, 69.4], [0.2, 0.5, 1.5]]) {
        const canvas = makeCanvas(w, h);
        const v = new SceneViewer(THREE, canvas, { fit, orbit: false, virtualDisplayHeight: 0.18 });
        v.fitTo([0, 0, 0], e);
        const s = fitScale({ extent: e, fit, margin: 0.8, vH: 0.18, aspect: w / h });
        assert.equal(s, v._fitScale, `${fit} ${w}x${h} ${e}`);
        v.dispose();
      }
    }
  }
});

// ── 6. sources, picking, view path ──────────────────────────────────────────────────────────

test('engineFormatFor routes by magic (bytes) or extension (URL), and refuses what the engine cannot read', () => {
  const sog = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0]);
  const ply = new TextEncoder().encode('ply\nformat');
  assert.deepEqual(engineFormatFor(null, sog), { ext: 'sog', streamed: false });
  assert.deepEqual(engineFormatFor(null, ply), { ext: 'ply', streamed: false });
  assert.equal(engineFormatFor(null, new Uint8Array([0x1f, 0x8b, 0, 0])), null, '.spz is Spark-only');
  assert.deepEqual(engineFormatFor('https://x/a/b.sog?v=2'), { ext: 'sog', streamed: false });
  assert.deepEqual(engineFormatFor('https://x/scene/lod-meta.json'), { ext: 'json', streamed: true });
  assert.equal(engineFormatFor('https://x/a.splat'), null);
});

test('nearestCentreToRay prefers the nearest centre INSIDE the cone over a closer-angled far one', () => {
  const xyz = new Float32Array([
    0.001, 0, -5, // nearly on the ray, far
    0.01, 0, -1, // inside a 0.02 cone, near → wins
    3, 0, -1, // way off
  ]);
  assert.deepEqual(Array.from(nearestCentreToRay(xyz, [0, 0, 0], [0, 0, -1])), [0.01, 0, -1].map((v) => Math.fround(v)));
  assert.equal(nearestCentreToRay(new Float32Array([0, 0, 5]), [0, 0, 0], [0, 0, -1]), null, 'behind the eye');
});

test('pickViewPath: RenderView when the engine has it, N cameras when it does not', () => {
  class Camera {}
  Object.defineProperty(Camera.prototype, 'xrViews', { get() { return null; }, set() {} });
  assert.equal(pickViewPath({ RenderView: class {}, Camera }), 'renderview');
  assert.equal(pickViewPath({ Camera }), 'cameras');
  assert.equal(pickViewPath({ RenderView: class {}, Camera: class {} }), 'cameras');
  assert.equal(pickViewPath({ RenderView: class {}, Camera }, 'cameras'), 'cameras', 'forced');
});

// ── 7. the cloud walkers both backends share ────────────────────────────────────────────────

test('sampleCloudCentres drops haze and keeps the rest, in order', () => {
  const xyz = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const got = sampleCloudCentres(3, centresVisitor(xyz, new Float32Array([0.9, 0.01, 0.5])));
  assert.deepEqual(Array.from(got), [1, 2, 3, 7, 8, 9]);
  assert.deepEqual(Array.from(sampleCloudCentres(3, centresVisitor(xyz))), Array.from(xyz), 'no opacity = no filter');
});

test('sampleCloudRestSpace strides above RIG_SAMPLE_CAP and keeps only what is in front of the lens', () => {
  const n = RIG_SAMPLE_CAP * 2 + 10;
  const xyz = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    xyz[i * 3] = 0.1;
    xyz[i * 3 + 1] = -0.2;
    xyz[i * 3 + 2] = i % 2 ? 2 : -1; // odd = in front, even = behind
  }
  const s = sampleCloudRestSpace(n, centresVisitor(xyz), null);
  // stride 3 → indices 0,3,6,…; only the odd ones are in front.
  assert.ok(s.n > 0 && s.n < RIG_SAMPLE_CAP, `n=${s.n}`);
  near(s.tx[0], 0.05, 1e-6, 'x/z');
  near(s.ty[0], -0.1, 1e-6, 'y/z');
  near(s.invz[0], 0.5, 1e-6, '1/z');
});

// ── 8. camera rig without three ─────────────────────────────────────────────────────────────

test('cameraRigFromPose builds the byte-identical descriptor cameraRigFromCamera does', () => {
  const THREE = {
    Vector3: class { set(x, y, z) { Object.assign(this, { x, y, z }); return this; } },
    Quaternion: class { set(x, y, z, w) { Object.assign(this, { x, y, z, w }); return this; } },
    MathUtils: { DEG2RAD: Math.PI / 180, degToRad: (d) => d * (Math.PI / 180) }, // three's own definition
  };
  const pose = { p: [0.25, -1.5, 3], q: [0.1, 0.2, -0.3, Math.sqrt(1 - 0.14)] };
  for (const fov of [21.997559456757255, 35, 60, 90.5]) {
    const cam = {
      fov,
      updateMatrixWorld() {},
      matrixWorld: { decompose: (p, q, s) => (p.set(...pose.p), q.set(...pose.q), s.set(1, 1, 1)) },
    };
    for (const o of [{}, { convergence: 1.683 }, { convergence: 2, ipdFactor: 0.5, parallaxFactor: 0.7, metersToVirtual: 2 }, { attach: true, convergence: 0.8 }]) {
      const a = cameraRigFromCamera(THREE, cam, o);
      const b = cameraRigFromPose(
        { position: { x: pose.p[0], y: pose.p[1], z: pose.p[2] }, orientation: { x: pose.q[0], y: pose.q[1], z: pose.q[2], w: pose.q[3] }, fov },
        o,
      );
      assert.equal(JSON.stringify(b), JSON.stringify(a), `fov ${fov} ${JSON.stringify(o)}`);
    }
  }
});

// ── 9. the handle before the engine arrives ─────────────────────────────────────────────────

test('attachPlayCanvasSplat replays calls made before it loaded — exclude() reaches the layer', async () => {
  installDom();
  globalThis.Blob ??= class {};
  const canvas = makeCanvas(320, 180);
  const excluded = [];
  const wall = {
    supported: true,
    addScene: () => ({ exclude: (el) => excluded.push(el), unexclude() {}, remove() {}, setViewRig() {} }),
  };
  // An engine whose device never arrives: everything synchronous runs, nothing GPU-side does.
  const pc = { createGraphicsDevice: () => new Promise(() => {}) };
  const out = {};
  const el = { id: 'buy' };
  attachPlayCanvasSplat(out, wall, canvas, 'x.sog', { playcanvas: pc }, [['exclude', [el]], ['setPose', [{ yaw: 20 }]]]);
  assert.deepEqual(excluded, [el]);
  assert.equal(out.viewer.getPose().yaw, 20);
  assert.equal(out.backend, 'playcanvas');
  assert.equal(canvas.width, 640, 'SBS buffer: double width in 3D');
  assert.equal(out.pick(10, 10), null, 'nothing to pick before load');
  out.remove();
});

test('a remove() queued before load disposes instead of booting the engine', async () => {
  installDom();
  const canvas = makeCanvas(320, 180);
  let booted = 0;
  const pc = {
    createGraphicsDevice: () => {
      booted++;
      return new Promise(() => {});
    },
  };
  const out = {};
  const r = await attachPlayCanvasSplat(out, null, canvas, 'x.sog', { playcanvas: pc }, [['remove', []]]);
  assert.equal(r, out, 'the load promise still resolves to the handle');
  assert.equal('ready' in out, false, 'attach never writes out.ready — ./splat owns it');
  assert.equal(booted, 0);
  assert.equal(out.viewer._disposed, true);
});

// ── 10. engine bootstrap, against a recording fake of the engine ────────────────────────────

/** Just enough of `playcanvas` for attachEngine, recording what the adapter does to it. */
function makeFakePc() {
  const rec = { entities: [], resolution: 0, fillMode: 0, chunks: new Map(), deviceOpts: null, started: 0, removed: [], queue: [], meshInstances: [] };
  let current = null; // the engine's global "current app" — the trap the adapter must avoid
  class Entity {
    constructor(name, app = current) {
      this.name = name;
      this.app = app;
      this.children = [];
      this.enabled = true;
      rec.entities.push(this);
    }
    destroy() {
      this.destroyed = true;
    }
    addChild(c) {
      this.children.push(c);
    }
    addComponent(type, data) {
      if (type === 'camera') this.camera = { layers: [0, 1, 2, 4, 3], ...data, camera: { setXrProperties() {} } };
      if (type === 'gsplat') {
        const params = new Map();
        this.gsplat = {
          ...data,
          workBufferUpdate: 0,
          modifier: null,
          setParameter: (n, v) => params.set(n, v),
          getParameter: (n) => params.get(n),
          deleteParameter: (n) => params.delete(n),
          setWorkBufferModifier(m) {
            this.modifier = m;
          },
        };
      }
    }
    setLocalPosition() {}
    setLocalRotation() {}
    setLocalScale() {}
    setLocalEulerAngles(x, y, z) {
      this.euler = [x, y, z];
    }
  }
  class AppBase {
    constructor(canvas) {
      this.canvas = canvas;
      this.root = new Entity('root', this);
      const tileChunks = (rec.tileChunks = new Map());
      const tileParams = (rec.tileParams = new Map());
      const material = {
        getShaderChunks: () => ({ set: (k, v) => tileChunks.set(k, v), delete: (k) => tileChunks.delete(k), get: (k) => tileChunks.get(k) }),
        setParameter: (n, v) => tileParams.set(n, v),
        update() {},
      };
      this.scene = { gsplat: { minPixelSize: 2, alphaClipForward: 1 / 255, material } };
      this.resolutionMode = 'fixed';
      this.scene.layers = { getLayerById: (id) => ({ id, addMeshInstances: (mis) => rec.meshInstances.push(...mis) }) };
      this.graphicsDevice = {};
      this.assets = {
        add() {},
        remove: (a) => rec.removed.push(a),
        load: (a) => {
          a.resource = rec.queue.length ? rec.queue.shift() : rec.resource;
          queueMicrotask(() => a._ready?.(a));
        },
      };
      current = this;
    }
    init(o) {
      this.opts = o;
      current = this;
    }
    setCanvasResolution() {
      rec.resolution++;
    }
    setCanvasFillMode() {
      rec.fillMode++;
    }
    requestAnimationFrame() {
      rec.engineRaf = (rec.engineRaf || 0) + 1;
    }
    start() {
      rec.started++;
    }
    tick() {}
    destroy() {}
  }
  class Camera {}
  Object.defineProperty(Camera.prototype, 'xrViews', { get() { return null; }, set() {} });
  const pc = {
    DEVICETYPE_WEBGL2: 'webgl2',
    RESOLUTION_FIXED: 'fixed',
    SHADERLANGUAGE_GLSL: 'glsl',
    TONEMAP_NONE: 6,
    createGraphicsDevice: async (canvas, o) => ((rec.deviceOpts = o), { canvas }),
    AppOptions: class {},
    AppBase,
    Entity,
    Camera,
    RenderView: class {},
    Asset: class {
      constructor(name, type, file) {
        Object.assign(this, { name, type, file });
        rec.assetFile = file;
      }
      ready(cb) {
        this._ready = cb;
      }
      once() {}
      unload() {
        this.unloaded = true;
      }
    },
    WORKBUFFER_UPDATE_ONCE: 1,
    WORKBUFFER_UPDATE_ALWAYS: 2,
    GraphNode: class { constructor(name) { this.name = name; } },
    Mesh: class {
      setPositions(p) { this.positions = p; }
      setUvs(i, u) { this.uvs = u; }
      setIndices(i) { this.indices = i; }
      update() {}
    },
    ShaderMaterial: class {
      constructor(desc) {
        this.desc = desc;
        this.params = new Map();
      }
      setParameter(n, v) { this.params.set(n, v); }
      update() {}
    },
    BlendState: class { constructor(...a) { this.args = a; } },
    MeshInstance: class { constructor(mesh, material, node) { Object.assign(this, { mesh, material, node, visible: true }); } },
    SEMANTIC_POSITION: 'POSITION',
    SEMANTIC_TEXCOORD0: 'TEXCOORD0',
    BLENDEQUATION_ADD: 'ADD',
    BLENDMODE_ZERO: 'ZERO',
    BLENDMODE_SRC_ALPHA: 'SRC_ALPHA',
    CULLFACE_NONE: 'NONE',
    LAYERID_UI: 4,
    LAYERID_SKYBOX: 2,
    Color: class { constructor(...a) { this.v = a; } },
    CameraComponentSystem: 'cam',
    GSplatComponentSystem: 'gsplat',
    TextureHandler: 'tex',
    GSplatHandler: 'gsh',
    RenderComponentSystem: 'render',
    LightComponentSystem: 'light',
    AnimComponentSystem: 'anim',
    ContainerHandler: 'container',
    ShaderChunks: {
      get: () => ({
        get: (k) => (k === 'gsplatCornerVS' ? CORNER_2_22_3 : k === 'gsplatCommonVS' ? COMMON_2_22_3 : ''),
        set: (k, v) => rec.chunks.set(k, v),
      }),
    },
  };
  return { pc, rec, makeOtherApp: () => new AppBase({}) };
}

test('attachEngine: our own device, AppBase with no xr/input, engine rAF off, canvas never resized', async () => {
  installDom();
  const { pc, rec } = makeFakePc();
  const v = new (await import('../js/inline3d-splat-playcanvas.js')).PlayCanvasSplatViewer(makeCanvas(320, 180), { orbit: false });
  const app = await v.attachEngine(pc, { perf: playcanvasPerfSettings('balanced') });
  assert.deepEqual(rec.deviceOpts.deviceTypes, ['webgl2']);
  assert.equal(rec.deviceOpts.xrCompatible, false);
  assert.equal(rec.deviceOpts.alpha, true);
  assert.equal(rec.deviceOpts.premultipliedAlpha, true);
  assert.equal(rec.deviceOpts.preserveDrawingBuffer, false);
  assert.deepEqual(app.opts.componentSystems, ['cam', 'gsplat', 'render', 'light', 'anim'], 'splat + glTF-with-animation; no xr, no input');
  assert.deepEqual(app.opts.resourceHandlers, ['tex', 'gsh', 'container']);
  assert.equal(app.opts.xr, undefined);
  assert.equal(app.opts.mouse, undefined);
  assert.equal(rec.resolution, 0, 'setCanvasResolution would write a NaN buffer width without sizes');
  assert.equal(rec.fillMode, 0, 'setCanvasFillMode would write inline style.width');
  app.requestAnimationFrame();
  assert.equal(rec.engineRaf, undefined, 'the engine’s own rAF is a no-op; the SDK frame drives tick()');
  assert.match(rec.chunks.get('gsplatCornerVS'), /dxrFocalY/, 'footprint fix applied');
  assert.match(rec.chunks.get('gsplatCommonVS'), /dxrQuadExtent/, 'balanced quad extent applied');
  assert.equal(app.scene.gsplat.minPixelSize, 0);
  assert.equal(v.eye.camera.toneMapping, 6, 'tonemap NONE: splat colours go out as stored');
  assert.equal(rec.started, 1);
  v.dispose();
});

test('every engine Entity belongs to ITS tile’s app, never the engine’s global current app', async () => {
  installDom();
  const { pc, rec, makeOtherApp } = makeFakePc();
  const { PlayCanvasSplatViewer } = await import('../js/inline3d-splat-playcanvas.js');
  const v = new PlayCanvasSplatViewer(makeCanvas(320, 180), { orbit: false });
  const app = await v.attachEngine(pc, { perf: playcanvasPerfSettings(undefined) });
  makeOtherApp(); // a second tile boots and becomes the engine's "current" app
  v.addSplatAsset({});
  const ours = rec.entities.filter((e) => e.name.startsWith('inline3d-'));
  assert.ok(ours.length >= 3, ours.map((e) => e.name).join());
  for (const e of ours) assert.equal(e.app, app, `${e.name} is on the wrong app`);
  assert.deepEqual(v.splat.euler, [180, 0, 0], 'the OpenCV → GL flip');
  v.dispose();
});

test('perf:false leaves the engine’s gsplat params and shader chunks untouched', async () => {
  installDom();
  const { pc, rec } = makeFakePc();
  const { PlayCanvasSplatViewer } = await import('../js/inline3d-splat-playcanvas.js');
  const v = new PlayCanvasSplatViewer(makeCanvas(320, 180), { orbit: false });
  const app = await v.attachEngine(pc, { perf: playcanvasPerfSettings(false) });
  assert.equal(app.scene.gsplat.minPixelSize, 2);
  assert.equal(rec.chunks.has('gsplatCommonVS'), false);
  assert.equal(rec.chunks.has('gsplatCornerVS'), true, 'the footprint FIX is not a perf knob');
  v.dispose();
});

test('frustumFromProjection: an infinite-far projection gives a large FINITE far, never -Infinity/NaN', () => {
  // three/WebXR infinite form: P[10] = -1, P[14] = -2·near.
  const P = perspectiveFov(40, 1.5, 0.05, 100);
  P[10] = -1;
  P[14] = -2 * 0.05;
  const f = frustumFromProjection(P);
  assert.ok(Number.isFinite(f.farClip) && f.farClip >= 1000, `far ${f.farClip}`);
  near(f.nearClip, 0.05, 1e-12, 'near still recovered');
  near(f.fov, 40, 1e-9, 'fov still recovered');
});


// ── 11. review fixes ────────────────────────────────────────────────────────────────────────

test('onFocusChange assigned on the stub BEFORE the adapter loads is the one that fires', () => {
  installDom();
  const seen = [];
  const out = { onFocusChange: (p) => seen.push(p) }; // what ./splat's stub holds
  const pc = { createGraphicsDevice: () => new Promise(() => {}) };
  attachPlayCanvasSplat(out, null, makeCanvas(320, 180), 'x.sog', { playcanvas: pc }, []);
  out.viewer.setFocus([0.5, 0.25, -1], { snap: true });
  assert.equal(seen.length, 1, 'the pre-load callback survived attach');
  assert.deepEqual(seen[0], [0.5, -0.25, 1], 'reported in the splat’s own (unflipped) space');
  const later = [];
  out.onFocusChange = (p) => later.push(p);
  out.viewer.setFocus([0, 0, 0], { snap: true });
  assert.equal(later.length, 1, 'reassigning after load still works');
  assert.equal(seen.length, 1);
  out.remove();
});

test('./splat stub carries an onFocusChange slot; the adapter never writes out.ready (source check)', async () => {
  const fs = await import('node:fs');
  const splat = fs.readFileSync(new URL('../js/inline3d-splat.js', import.meta.url), 'utf8');
  const stub = splat.slice(splat.indexOf('function addSplatDeferred'));
  assert.match(stub, /onFocusChange: null,/);
  assert.equal((stub.match(/out\.ready =/g) || []).length, 1, 'one owner of ready');
  const pcSrc = fs.readFileSync(new URL('../js/inline3d-splat-playcanvas.js', import.meta.url), 'utf8');
  assert.equal(/out\.ready\s*=/.test(pcSrc), false);
});

/** A GSplatOctreeResource as the engine hands it back: data.tree already nulled, aabb set. */
function fakeOctree({ camera } = {}) {
  return {
    octree: { nodes: [] },
    numSplats: 294912,
    aabb: { center: { x: 1, y: 2, z: 3 }, halfExtents: { x: 10, y: 5, z: 20 } },
    data: { version: 1, count: 516096, lodLevels: 3, tree: null, ...(camera ? { camera } : {}) },
  };
}

test('describeResource: a Streamed SOG frames from the octree bound and counts its finest level', () => {
  const d = describeResource(fakeOctree());
  assert.equal(d.kind, 'streamed');
  assert.equal(d.numSplats, 294912);
  assert.deepEqual(d.bounds, { center: [1, 2, 3], extent: [20, 10, 40] });
  assert.equal(describeResource({ gsplatData: { numSplats: 7, meta: { a: 1 } } }).kind, 'flat');
  assert.equal(describeResource(null).kind, null);
});

test('a Streamed SOG through the adapter: framed (not model scale); pick is nearest RESIDENT chunk centre', async (t) => {
  installDom();
  const warn = t.mock.method(console, 'warn', () => {});
  const { pc, rec } = makeFakePc();
  rec.resource = fakeOctree();
  const out = {};
  const canvas = makeCanvas(320, 180);
  await attachPlayCanvasSplat(out, null, canvas, 'https://x/scene/lod-meta.json', { playcanvas: pc, focusInput: false }, []);
  assert.equal(out.mesh.numSplats, 294912);
  assert.equal(out.rig.type, 'display');
  assert.deepEqual(out.frame, { center: [1, -2, -3], extent: [20, 10, 40] }, 'the flip applies to the bound');
  assert.notEqual(out.viewer._fitScale, 1, 'fitTo ran — not UNFRAMED at model scale');
  assert.ok(!warn.mock.calls.some((c) => /UNFRAMED/.test(String(c.arguments[0]))));
  assert.equal(out.pick(160, 90), null, 'nothing resident yet');
  // Two chunks become resident; the pick walks them.
  rec.resource.octree.fileResources = new Map([
    [0, { centers: new Float32Array([5, 5, 5]) }],
    [1, { centers: new Float32Array([1, 2, 3 + 0.001]) }],
  ]);
  assert.ok(out.pick(160, 90), 'picked a resident centre');
  out.remove();
});

test('a Streamed SOG with a top-level lod-meta camera block goes on the camera rig', async () => {
  installDom();
  const { pc, rec } = makeFakePc();
  rec.resource = fakeOctree({
    camera: {
      convention: 'opencv',
      rest: { position: [0, 0, 0], rotation: [0, 0, 0, 1] },
      intrinsics: { fx: 1000, fy: 1000, cx: 640, cy: 360, width: 1280, height: 720 },
      focus: { point: [0, 0, 2] },
    },
  });
  const out = {};
  await attachPlayCanvasSplat(out, null, makeCanvas(320, 180), 'https://x/lod-meta.json', { playcanvas: pc, focusInput: false }, []);
  assert.equal(out.rig.type, 'camera');
  assert.equal(out.rig.intrinsicsSource, 'block', 'not the 28 mm fallback');
  assert.equal(out.camera.intrinsics.fx, 1000);
  out.remove();
});

test('readCloud strides at copy time: ≤ FRAME_SAMPLE_CAP splats kept, 16 B each, opacity aligned', async () => {
  const N = 1179648;
  const centers = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) centers[i * 3] = i;
  const w = 1024, h = Math.ceil(N / w);
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < N; i++) px[i * 4 + 3] = i % 256;
  const res = {
    centers,
    gsplatData: { numSplats: N, isSog: true, meta: { version: 2 }, sh0: { width: w, height: h, read: async () => px } },
  };
  const c = await readCloud(res);
  assert.equal(c.sourceTotal, N);
  assert.equal(c.stride, 6);
  assert.equal(c.total, 196608);
  assert.equal(c.xyz.length, 196608 * 3);
  assert.equal(c.xyz.byteLength + c.opacity.byteLength, 196608 * 16, '≈3.1 MB, was 18.9 MB for the full copy');
  assert.equal(c.xyz[3], 6, 'second kept splat is source index 6');
  near(c.opacity[1], (6 % 256) / 255, 1e-7, 'opacity follows the same stride');
  assert.equal(await readCloud(fakeOctree()), null, 'a Streamed SOG has no flat cloud');
});

test('sampleCloudCentres honours a cap (the pick set uses RIG_SAMPLE_CAP)', () => {
  const n = 100000;
  const xyz = new Float32Array(n * 3);
  const s = sampleCloudCentres(n, centresVisitor(xyz), { cap: RIG_SAMPLE_CAP });
  assert.equal(s.length / 3, Math.ceil(n / Math.ceil(n / RIG_SAMPLE_CAP)));
});

// ── 12. shared viewer constants, and the two viewers side by side ───────────────────────────

test('the viewer constants both backends read are pinned (values from SceneViewer 1.7)', async () => {
  const S = await import('../js/inline3d-splat-shared.js');
  assert.equal(S.IDLE_DELAY_MS, 2500);
  assert.equal(S.FOCUS_EASE, 0.18);
  assert.equal(S.DEFAULT_DEPTH_LIMIT, 4.0);
  assert.equal(S.DAMP_BASE, 0.001);
  assert.equal(S.MAX_DT_S, 0.1);
  assert.deepEqual(S.PITCH_LIMIT, [-60, 60]);
  assert.equal(S.DRAG_DEG_PER_TILE, 180);
  assert.deepEqual([S.WHEEL_LINE_PX, S.WHEEL_PAGE_PX, S.WHEEL_MAX_PX, S.ZOOM_PER_PX], [33, 400, 120, 0.001]);
  assert.deepEqual([S.ZOOM_MIN, S.ZOOM_MAX], [0.2, 6]);
  assert.deepEqual([S.MONO_FOV, S.MONO_NEAR, S.MONO_FAR, S.CAPTURE_FAR], [35, 0.001, 1000, 5000]);
});

test('SceneViewer and the PlayCanvas adapter keep NO private copy of a tuning constant (source check)', async () => {
  const fs = await import('node:fs');
  for (const f of ['inline3d-viewer.js', 'inline3d-splat-playcanvas.js']) {
    const src = fs.readFileSync(new URL(`../js/${f}`, import.meta.url), 'utf8');
    for (const name of ['IDLE_DELAY_MS', 'FOCUS_EASE', 'WHEEL_LINE_PX', 'ZOOM_PER_PX', 'ZOOM_MIN', 'ZOOM_MAX']) {
      assert.equal(new RegExp(`^const ${name}\\b`, 'm').test(src), false, `${f} redefines ${name}`);
    }
    assert.match(src, /from '\.\/inline3d-splat-shared\.js'/);
  }
});

test('behavioural trace: SceneViewer and PlayCanvasSplatViewer move identically (fit, focus ease, wheel, idle spin, setPose/resetPose)', async (t) => {
  installDom();
  let T = 1000;
  t.mock.method(performance, 'now', () => T);
  const { THREE } = makeTHREE();
  const { PlayCanvasSplatViewer } = await import('../js/inline3d-splat-playcanvas.js');
  const opts = { virtualDisplayHeight: 0.18, fit: 'contain', margin: 0.75, fitSweep: true, depthLimit: 3, idleSpin: 8 };
  const sv = new SceneViewer(THREE, makeCanvas(640, 360), { ...opts, orbit: true });
  const pv = new PlayCanvasSplatViewer(makeCanvas(640, 360), { ...opts, orbit: true });
  const snap = (v) => JSON.stringify({ pose: v.getPose(), target: v.getPose({ target: true }), focus: v.getFocus(), fit: v._fitScale, bounds: v.getSubjectBounds() });
  const both = (fn) => { fn(sv); fn(pv); };
  const step = (ms, what) => { T += ms; sv._tick(); pv._tick(); assert.equal(snap(pv), snap(sv), what); };
  both((v) => v.fitTo([0.2, 0.1, -0.3], [1.2, 0.6, 2.0]));
  step(16, 'after fitTo');
  both((v) => v.setFocus([0.5, 0.25, -1]));
  for (let i = 0; i < 30; i++) step(16, `focus ease frame ${i}`);
  both((v) => v._onWheel({ deltaY: 100, deltaMode: 0, preventDefault() {} }));
  both((v) => v._onWheel({ deltaY: -3, deltaMode: 1, preventDefault() {} }));
  for (let i = 0; i < 20; i++) step(16, `wheel ease frame ${i}`);
  both((v) => v.setPose({ yaw: 30, pitch: 80, zoom: 9, depthOffset: 0.02 })); // pitch + zoom clamp
  step(16, 'setPose snap + clamps');
  step(3000, 'idle delay passes');
  for (let i = 0; i < 20; i++) step(16, `idle spin frame ${i}`);
  both((v) => v.resetPose());
  step(16, 'resetPose');
  sv.dispose();
  pv.dispose();
});

// ── 13. setSource: swap the asset, crossfading ──────────────────────────────────────────────

/** A flat (non-streamed) resource with a small grid of centres, offset so two differ. */
function fakeFlat(n, off) {
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    c[i * 3] = off + (i % 10) * 0.1;
    c[i * 3 + 1] = off + (Math.floor(i / 10) % 10) * 0.1;
    c[i * 3 + 2] = off + 2 + Math.floor(i / 100) * 0.1;
  }
  return { centers: c, gsplatData: { numSplats: n, meta: {} } };
}
const settle = async (cond) => {
  for (let i = 0; i < 50 && !cond(); i++) await new Promise((r) => setTimeout(r, 0));
  assert.ok(cond(), 'condition never became true');
};

test('setSource crossfade FALLBACK (no frame copy): coverage-linear exponents 0→1 / 1→0, old released after; rig re-runs; pose kept', async (t) => {
  installDom();
  const K = 'dxrFx_xfade_k';
  let T = 1000;
  t.mock.method(performance, 'now', () => T);
  const { pc, rec } = makeFakePc();
  rec.queue = [fakeFlat(600, 0), fakeFlat(600, 5)];
  const out = {};
  const seen = [];
  out.onFocusChange = (p) => seen.push(p);
  await attachPlayCanvasSplat(out, null, makeCanvas(320, 180), 'a.sog', { playcanvas: pc, focusInput: false, idleSpin: 0 }, []);
  const e1 = out.mesh.entity;
  const a1 = out.mesh.asset;
  const frame1 = JSON.stringify(out.frame);
  out.setPose({ yaw: 20 });
  seen.length = 0;
  const done = out.setSource('b.sog', { fadeMs: 100 });
  await settle(() => out.mesh.entity !== e1);
  const e2 = out.mesh.entity;
  await settle(() => e1.gsplat.getParameter(K) === 1);
  assert.equal(e2.gsplat.getParameter(K), 0, 'the new asset starts invisible');
  assert.match(e2.gsplat.modifier.glsl, /1\.0 - pow\(max\(1\.0 - col\.a, 0\.0200\), dxrFx_xfade_k\)/, 'alpha remapped, not scaled');
  assert.match(e2.gsplat.modifier.glsl, /if \(dxrFx_xfade_k >= 1\.0\) return;/, 'k = 1 leaves alpha untouched');
  assert.equal(e2.gsplat.workBufferUpdate, 2, 'work buffer re-rendered every frame while fading');
  // The clock starts on the second tick (the first frame builds the new work buffer): a slow
  // first frame must not eat the fade.
  T += 800; // a slow build frame
  out.viewer._tick();
  assert.equal(e2.gsplat.getParameter(K), 0, 'still 0 after the build frame');
  out.viewer._tick(); // clock starts here
  assert.equal(e2.gsplat.getParameter(K), 0);
  T += 50;
  out.viewer._tick();
  near(e2.gsplat.getParameter(K), coverageExponent(0.5), 1e-9, 'half way in');
  near(e1.gsplat.getParameter(K), coverageExponent(0.5), 1e-9, 'half way out');
  T += 60;
  out.viewer._tick();
  await done;
  assert.equal(e2.gsplat.modifier, null, 'fade modifier removed from the survivor');
  assert.equal(e2.gsplat.workBufferUpdate, 1, 'one clean re-render without it');
  assert.equal(e1.enabled, false, 'old one hidden at once');
  for (let i = 0; i < 4; i++) {
    T += 16;
    out.viewer._tick();
  }
  assert.equal(e1.destroyed, true, 'old entity destroyed a few frames later');
  assert.ok(rec.removed.includes(a1) && a1.unloaded, 'old asset released');
  assert.notEqual(JSON.stringify(out.frame), frame1, 'the waterfall re-ran for the new file');
  assert.ok(seen.length > 0, 'onFocusChange fired for the new focus');
  assert.equal(out.viewer.getPose().yaw, 20, 'pose kept');
  out.remove();
});

test('setSource: fadeMs 0 swaps at once; resetPose:true resets; a Spark-only format rejects', async (t) => {
  installDom();
  const { pc, rec } = makeFakePc();
  rec.queue = [fakeFlat(300, 0), fakeFlat(300, 3)];
  const out = {};
  await attachPlayCanvasSplat(out, null, makeCanvas(320, 180), 'a.sog', { playcanvas: pc, focusInput: false }, []);
  const e1 = out.mesh.entity;
  out.setPose({ yaw: 33 });
  await out.setSource('b.sog', { resetPose: true });
  assert.notEqual(out.mesh.entity, e1);
  assert.equal(e1.enabled, false);
  assert.equal(out.mesh.entity.gsplat.modifier, null, 'no fade machinery for a cut');
  assert.equal(out.viewer.getPose().yaw, 0);
  await assert.rejects(out.setSource('c.spz'), /reads \.sog, \.ply/);
  out.remove();
});

test('setSource crossfade = FRAME_SNAPSHOT: capture on the next drawn frame, old released at once, lerp 1→0, new asset untouched', async (t) => {
  installDom();
  let T = 1000;
  t.mock.method(performance, 'now', () => T);
  const { pc, rec } = makeFakePc();
  pc.Texture = class { constructor(d, o) { this.o = o; } destroy() { this.destroyed = true; } };
  pc.RenderTarget = class { constructor(o) { this.o = o; } destroy() {} };
  Object.assign(pc, { PIXELFORMAT_RGBA8: 7, FILTER_NEAREST: 0, ADDRESS_CLAMP_TO_EDGE: 1, BLENDMODE_ONE: 'ONE', BLENDMODE_ONE_MINUS_SRC_ALPHA: 'OMSA' });
  rec.queue = [fakeFlat(600, 0), fakeFlat(600, 5)];
  const out = {};
  await attachPlayCanvasSplat(out, null, makeCanvas(320, 180), 'a.sog', { playcanvas: pc, focusInput: false, idleSpin: 0 }, []);
  const copies = [];
  out.viewer.app.graphicsDevice.copyRenderTarget = (src, dst, color, depth) => (copies.push({ src, dst, color, depth }), true);
  const e1 = out.mesh.entity;
  const done = out.setSource('b.sog', { fadeMs: 100 });
  await settle(() => out.viewer._captureWaiters.length === 1);
  assert.equal(out.mesh.entity, e1, 'nothing of the new asset before the capture');
  out.viewer._afterTick(); // a frame was drawn
  await settle(() => out.mesh.entity !== e1);
  const e2 = out.mesh.entity;
  assert.equal(copies.length, 1);
  assert.deepEqual([copies[0].src, copies[0].color, copies[0].depth], [null, true, false], 'back buffer → texture, colour only');
  assert.equal(copies[0].dst.o.colorBuffer.o.width, out.viewer.canvas.width, 'capture = the whole buffer');
  const parts = rec.meshInstances.filter((mi) => /Snapshot/.test(mi.material.desc.uniqueName));
  assert.equal(parts.length, 2, 'scale + add quads');
  assert.deepEqual(parts[0].material.blendState.args, [true, 'ADD', 'ZERO', 'SRC_ALPHA', 'ADD', 'ZERO', 'SRC_ALPHA'], 'dst *= 1 − α, colour and alpha');
  assert.deepEqual(parts[1].material.blendState.args, [true, 'ADD', 'ONE', 'ONE', 'ADD', 'ONE', 'ONE'], 'dst += α·A');
  assert.ok(parts.every((mi) => mi.drawOrder < 0), 'under the feather');
  assert.ok(parts.every((mi) => mi.visible), 'overlay up in the same task as the swap');
  assert.equal(parts[1].material.params.get('dxrSnapAlpha'), 1);
  assert.equal(e1.enabled, false, 'the snapshot shows the old asset: released at once');
  assert.equal(e2.gsplat.modifier, null, 'the new asset is drawn untouched (no work-buffer modifier)');
  out.viewer._tick(); // build frame
  T += 800;
  out.viewer._tick(); // clock starts
  assert.equal(parts[1].material.params.get('dxrSnapAlpha'), 1);
  T += 25;
  out.viewer._tick();
  near(parts[1].material.params.get('dxrSnapAlpha'), 0.75, 1e-9, 'linear');
  T += 100;
  out.viewer._tick();
  await done;
  assert.ok(parts.every((mi) => !mi.visible), 'overlay hidden at the end');
  assert.equal(e2.gsplat.modifier, null);
  out.remove();
});

test('FRAME_SNAPSHOT: a buffer resize mid-fade ends the fade (the capture no longer fits)', async (t) => {
  installDom();
  let T = 1000;
  t.mock.method(performance, 'now', () => T);
  const { pc, rec } = makeFakePc();
  pc.Texture = class { destroy() {} };
  pc.RenderTarget = class { destroy() {} };
  rec.queue = [fakeFlat(300, 0), fakeFlat(300, 5)];
  const out = {};
  await attachPlayCanvasSplat(out, null, makeCanvas(320, 180), 'a.sog', { playcanvas: pc, focusInput: false, idleSpin: 0 }, []);
  out.viewer.app.graphicsDevice.copyRenderTarget = () => true;
  const e1 = out.mesh.entity;
  const done = out.setSource('b.sog', { fadeMs: 1000 });
  await settle(() => out.viewer._captureWaiters.length === 1);
  out.viewer._afterTick();
  await settle(() => out.mesh.entity !== e1);
  out.viewer._tick();
  out.viewer._tick();
  out.viewer.canvas.width = 999; // a resize / 2D↔3D switch
  T += 10;
  out.viewer._tick();
  await done;
  assert.ok(rec.meshInstances.filter((mi) => /Snapshot/.test(mi.material.desc.uniqueName)).every((mi) => !mi.visible));
  out.remove();
});

test('coverageExponent: exact ends, monotonic, inverts coverage 1 − e^{−kL}', () => {
  assert.equal(coverageExponent(0), 0);
  assert.equal(coverageExponent(-1), 0);
  assert.equal(coverageExponent(1), 1);
  assert.equal(coverageExponent(2), 1);
  let prev = 0;
  for (let c = 0.05; c < 1; c += 0.05) {
    const k = coverageExponent(c, 5);
    assert.ok(k > prev && k < 1);
    near((1 - Math.exp(-k * 5)) / (1 - Math.exp(-5)), c, 1e-12, 'coverage recovered');
    prev = k;
  }
});

test('reveal: installed at its START state before the first frame, played once woven, then removed', async (t) => {
  installDom();
  let T = 1000;
  t.mock.method(performance, 'now', () => T);
  const { pc, rec } = makeFakePc();
  rec.queue = [fakeFlat(600, 0)];
  const out = {};
  let woven;
  out.firstWoven = new Promise((r) => (woven = r));
  await attachPlayCanvasSplat(out, null, makeCanvas(320, 180), 'a.sog', { playcanvas: pc, focusInput: false, idleSpin: 0, reveal: { type: 'sweep', durationMs: 100, easing: 'linear' } }, []);
  assert.match(rec.tileChunks.get('gsplatModifyVS'), /dxrFx_sweep_color/, 'tile chunk up before any frame');
  assert.equal(rec.tileParams.get('dxrFx_sweep_amount'), 0, 'at its start state: nothing shows');
  for (let i = 0; i < 5; i++) ((T += 500), out.viewer._tick());
  assert.equal(rec.tileParams.get('dxrFx_sweep_amount'), 0, 'held until firstWoven');
  assert.deepEqual(out.effects().map((e) => [e.name, e.waiting]), [['sweep', true]]);
  woven({ woven: true });
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 3; i++) {
    out.viewer._tick(); // the two build frames, then the clock starts
    await new Promise((r) => setTimeout(r, 0));
  }
  out.viewer._tick();
  T += 50;
  out.viewer._tick();
  near(rec.tileParams.get('dxrFx_sweep_amount'), 0.5, 1e-9);
  T += 60;
  out.viewer._tick();
  assert.equal(rec.tileChunks.has('gsplatModifyVS'), false, 'removed at the end: the engine chunk again');
  assert.deepEqual(out.effects(), []);
  out.remove();
});

test('handle.playEffect / setEffect / stopEffect / effects on the adapter; bad calls throw at the call', async (t) => {
  installDom();
  let T = 1000;
  t.mock.method(performance, 'now', () => T);
  const { pc, rec } = makeFakePc();
  rec.queue = [fakeFlat(300, 0)];
  const out = {};
  // a setEffect the page made on ./splat's stub before this module loaded (replayed, queued to load)
  await attachPlayCanvasSplat(out, null, makeCanvas(320, 180), 'a.sog', { playcanvas: pc, focusInput: false, idleSpin: 0 }, [['setEffect', ['grade', { saturation: 0 }]]]);
  assert.match(rec.tileChunks.get('gsplatModifyVS'), /dxrFx_grade_color/, 'the queued setEffect ran after load');
  assert.throws(() => out.playEffect('grade', {}), /persistent effect/);
  assert.throws(() => out.playEffect('nope'), /unknown effect/);
  assert.throws(() => out.setEffect('custom', { glsl: 'void modifySplatColor(vec3 c, inout vec4 col) { col.r = gl_FragCoord.x; }' }), /screen-space/);
  const p = out.playEffect('pulse', { durationMs: 100 });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(out.effects().map((e) => e.name).sort(), ['grade', 'pulse']);
  out.stopEffect('pulse');
  assert.deepEqual(await p, { finished: false });
  out.stopEffect();
  assert.equal(rec.tileChunks.has('gsplatModifyVS'), false);
  out.remove();
});

test('setSource fallback + reveal: the incoming asset carries ONE modifier (fade + reveal), the outgoing its own fade', async (t) => {
  installDom();
  let T = 1000;
  t.mock.method(performance, 'now', () => T);
  const { pc, rec } = makeFakePc();
  rec.queue = [fakeFlat(600, 0), fakeFlat(600, 5)];
  const out = {};
  await attachPlayCanvasSplat(out, null, makeCanvas(320, 180), 'a.sog', { playcanvas: pc, focusInput: false, idleSpin: 0 }, []);
  const e1 = out.mesh.entity;
  const done = out.setSource('b.sog', { fadeMs: 100, reveal: 'sweep' });
  await settle(() => out.mesh.entity !== e1);
  const e2 = out.mesh.entity;
  const code = e2.gsplat.modifier.glsl;
  assert.match(code, /dxrFx_xfade_color\(center, color\)/);
  assert.match(code, /dxrFx_sweep_color\(center, color\)/);
  assert.equal(code.split('void modifySplatColor(').length - 1, 1, 'one composed modifier');
  assert.doesNotMatch(e1.gsplat.modifier.glsl, /sweep/, 'only the incoming asset reveals');
  for (let i = 0; i < 4; i++) ((T += 60), out.viewer._tick());
  await done;
  assert.equal(e1.enabled, false);
  out.remove();
});

test('wavefront with no frame to wipe from (hidden tab / no copy): falls back to the 1.12.1 crossfade', async (t) => {
  installDom();
  let T = 1000;
  t.mock.method(performance, 'now', () => T);
  const { pc, rec } = makeFakePc(); // no RenderTarget: captureFrame() → false
  rec.queue = [fakeFlat(300, 0), fakeFlat(300, 5)];
  const out = {};
  await attachPlayCanvasSplat(out, null, makeCanvas(320, 180), 'a.sog', { playcanvas: pc, focusInput: false, idleSpin: 0 }, []);
  const e1 = out.mesh.entity;
  const done = out.setSource('b.sog', { transition: 'wavefront', durationMs: 100 });
  await settle(() => out.mesh.entity !== e1);
  const e2 = out.mesh.entity;
  assert.match(e2.gsplat.modifier.glsl, /dxrFx_xfade_color/, 'the one-pass crossfade');
  assert.doesNotMatch(e2.gsplat.modifier.glsl, /wavefront/);
  for (let i = 0; i < 4; i++) ((T += 60), out.viewer._tick());
  await done;
  assert.equal(e2.gsplat.modifier, null, 'end state: the untouched asset');
  assert.equal(e1.enabled, false);
  out.remove();
});

test('setSource options: transitions validated before anything loads', async () => {
  const { resolveSwap } = await import('../js/inline3d-splat-playcanvas.js');
  assert.equal(resolveSwap({}).transition, 'cut');
  assert.equal(resolveSwap({ fadeMs: 300 }).transition, 'crossfade');
  assert.equal(resolveSwap({ fadeMs: 300 }).durationMs, 300);
  assert.equal(resolveSwap({ transition: 'flip' }).durationMs, 2200);
  assert.equal(resolveSwap({ transition: 'wavefront' }).band, 0.18);
  assert.throws(() => resolveSwap({ transition: 'spin' }), /transition 'spin'/);
  assert.throws(() => resolveSwap({ transition: 'flip', reveal: 'sweep' }), /its own reveal/);
  assert.throws(() => resolveSwap({ reveal: 'bogus' }), /reveal type 'bogus'/);
  assert.equal(resolveSwap({ transition: 'wavefront' }).durationMs, 2000, 'the approved default');
  assert.equal(resolveSwap({ transition: 'wavefront' }).easing, 'easeInOutSine');
  assert.equal(resolveSwap({ transition: 'wavefront' }).ridge, 0.03);
  assert.equal(resolveSwap({ transition: 'wavefront' }).ridgeMaxDisparity, 0.004);
  assert.throws(() => resolveSwap({ transition: 'wavefront', ridge: 2 }), /ridge/);
  assert.throws(() => resolveSwap({ transition: 'wavefront', ridgeMaxDisparity: 0.5 }), /ridgeMaxDisparity/);
  assert.throws(() => resolveSwap({ easing: 'wobble' }), /unknown easing/);
});

test('Spark refuses every effect entry point by name (source check: ./splat imports three)', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../js/inline3d-splat.js', import.meta.url), 'utf8');
  const spark = src.slice(src.indexOf("if (resolveSplatEngine(opts) === 'playcanvas')"));
  assert.match(spark, /if \(opts\.reveal !== undefined && opts\.reveal !== false\) throw effectsNotOnSpark\('reveal'\);/);
  for (const m of ['playEffect', 'setEffect', 'stopEffect']) assert.match(spark, new RegExp(`${m}\\(\\) \\{\\n\\s+throw effectsNotOnSpark\\('${m}\\(\\)'\\);`));
  const { effectsNotOnSpark } = await import('../js/inline3d-splat-effects.js');
  assert.match(effectsNotOnSpark('reveal').message, /PlayCanvas-only in this version/);
  assert.match(src, /resolveRevealOption\(opts\.reveal\);/, 'PlayCanvas branch validates reveal at the call');
});

// ── 14. feather ─────────────────────────────────────────────────────────────────────────────

test('feather: an edge-ramp quad in the UI layer, blend ZERO/SRC_ALPHA, ramp sized per eye viewport, 3D only', async () => {
  installDom();
  const { pc, rec } = makeFakePc();
  const { PlayCanvasSplatViewer } = await import('../js/inline3d-splat-playcanvas.js');
  const v = new PlayCanvasSplatViewer(makeCanvas(320, 180), { orbit: false, feather: 24 });
  await v.attachEngine(pc, { perf: playcanvasPerfSettings(undefined) });
  assert.equal(rec.meshInstances.length, 1, 'one quad');
  const mi = rec.meshInstances[0];
  assert.deepEqual(mi.material.blendState.args, [true, 'ADD', 'ZERO', 'SRC_ALPHA', 'ADD', 'ZERO', 'SRC_ALPHA'], 'dst *= ramp, colour and alpha');
  assert.equal(mi.material.depthTest, false);
  assert.ok(mi.node, 'a mesh instance needs a node (the engine reads its world scale)');
  // A side-by-side eye: 320 px wide in a 640×180 buffer.
  v._mode = '3d';
  v._updateFeather(320, 180);
  near(mi.material.params.get('dxrFeatherFx'), 24 / 320, 1e-12);
  near(mi.material.params.get('dxrFeatherFy'), 24 / 180, 1e-12);
  assert.equal(mi.visible, true);
  v._updateFeather(30, 20);
  assert.equal(mi.material.params.get('dxrFeatherFx'), 0.5, 'clamped at half the eye');
  // Flat fallback: no feather, exactly as SceneViewer (EdgeFeather runs in onFrame only).
  v._mode = 'mono';
  v._updateFeather(320, 180);
  assert.equal(mi.visible, false);
  v.dispose();
});

test('feather 0 (the default) adds nothing to the scene', async () => {
  installDom();
  const { pc, rec } = makeFakePc();
  const { PlayCanvasSplatViewer } = await import('../js/inline3d-splat-playcanvas.js');
  const v = new PlayCanvasSplatViewer(makeCanvas(320, 180), { orbit: false });
  await v.attachEngine(pc, { perf: playcanvasPerfSettings(undefined) });
  assert.equal(rec.meshInstances.length, 0);
  v.dispose();
});

// ── 15. orbit: tilt-and-relax ───────────────────────────────────────────────────────────────

test('orbit constants are pinned: ±15°, τ 0.2 s dragging, τ 0.6 s relaxing', async () => {
  const S = await import('../js/inline3d-splat-shared.js');
  assert.deepEqual([S.ORBIT_MAX_DEG, S.ORBIT_TAU_DRAG_S, S.ORBIT_TAU_REST_S], [15, 0.2, 0.6]);
});

test('orbit: press centre → +25 % width → 0.4 s ≈ 6.5° → release → 1.5 s ≈ 0.5°', async (t) => {
  installDom();
  let T = 1000;
  t.mock.method(performance, 'now', () => T);
  const { PlayCanvasSplatViewer } = await import('../js/inline3d-splat-playcanvas.js');
  const v = new PlayCanvasSplatViewer(makeCanvas(400, 300), { orbit: true, idleSpin: 0 });
  const frames = (s) => {
    for (let i = 0; i < Math.round(s / 0.016); i++) {
      T += 16;
      v._tick();
    }
  };
  v._tick();
  v._onDown({ clientX: 200, clientY: 150, pointerId: 1 });
  v._onMove({ clientX: 300, clientY: 150 }); // +25 % of the width
  assert.equal(v.getPose({ target: true }).yaw, 7.5, 'target = 0.25 · 2 · 15');
  frames(0.4);
  const expDrag = 7.5 * (1 - Math.exp(-0.4 / 0.2)); // 6.49
  near(v.getPose().yaw, expDrag, 0.05, 'eased toward the target with τ 0.2 s');
  v._onUp({ pointerId: 1 });
  assert.equal(v.getPose({ target: true }).yaw, 0, 'release targets rest');
  frames(1.5);
  near(v.getPose().yaw, v.getPose().yaw > 0 ? expDrag * Math.exp(-1.5 / 0.6) : 0, 0.05, 'relaxed with τ 0.6 s (≈0.53°)');
  assert.ok(v.getPose().yaw > 0.4 && v.getPose().yaw < 0.7, `yaw ${v.getPose().yaw}`);
  v.dispose();
});

test('orbit: the cap, pitch, pitchLimit, re-press mid-relax, setPose snaps, idle spin waits for rest', async (t) => {
  installDom();
  let T = 1000;
  t.mock.method(performance, 'now', () => T);
  const { PlayCanvasSplatViewer } = await import('../js/inline3d-splat-playcanvas.js');
  const v = new PlayCanvasSplatViewer(makeCanvas(400, 300), { orbit: true, idleSpin: 10, pitchLimit: [-5, 5], orbitMaxDeg: 20 });
  v._tick();
  v._onDown({ clientX: 200, clientY: 150, pointerId: 1 });
  v._onMove({ clientX: 400, clientY: 300 }); // a full half-width right, half-height down
  assert.equal(v.getPose({ target: true }).yaw, 20, 'capped at orbitMaxDeg');
  assert.equal(v.getPose({ target: true }).pitch, 5, 'pitchLimit still clamps');
  v._onMove({ clientX: 100, clientY: 150 });
  assert.equal(v.getPose({ target: true }).yaw, -10, 'absolute from the press, not cumulative (−¼ width)');
  v._onUp({ pointerId: 1 });
  T += 100;
  v._tick();
  // Re-press mid-relax: rest stays the ORIGINAL rest, not the mid-tilt pose.
  v._onDown({ clientX: 200, clientY: 150, pointerId: 1 });
  v._onUp({ pointerId: 1 });
  assert.equal(v.getPose({ target: true }).yaw, 0);
  // Idle turntable held off until the relax completes.
  T += 3000;
  v._tick();
  assert.equal(v.getPose({ target: true }).yaw, 0, 'no idle spin while relaxing');
  for (let i = 0; i < 400 && v._orbitMode; i++) {
    T += 16;
    v._tick();
  }
  assert.equal(v._orbitMode, null, 'rest reached');
  T += 16;
  v._tick();
  assert.ok(v.getPose({ target: true }).yaw > 0, 'idle spin resumes after rest');
  // setPose stays a snap, and ends any relax.
  v._onDown({ clientX: 200, clientY: 150, pointerId: 1 });
  v._onMove({ clientX: 260, clientY: 150 });
  v._onUp({ pointerId: 1 });
  v.setPose({ yaw: 42 });
  assert.equal(v.getPose().yaw, 42);
  assert.equal(v._orbitMode, null);
  v.dispose();
});

// ── 16. focus: the nearest disparity clump ──────────────────────────────────────────────────

const LENS = { fx: 1000, fy: 1000, cx: 640, cy: 360, width: 1280, height: 720 };

/** A central-crop cloud: a thin NEAR plane (2 % mass), a trunk at 2.3 m (10 %), a far wall (88 %). */
function clumpCloud() {
  const tx = [], ty = [], invz = [], w = [];
  const add = (count, z) => {
    for (let i = 0; i < count; i++) {
      tx.push(((i % 20) / 20 - 0.5) * 0.4); // stays inside the central half of a 1280-wide frame
      ty.push(((Math.floor(i / 20) % 20) / 20 - 0.5) * 0.3);
      invz.push(1 / (z * (1 + ((i % 7) - 3) * 0.004)));
      w.push(0.9);
    }
  };
  add(200, 0.8); // 2 %: a sliver of foreground — must be skipped
  add(1000, 2.3); // 10 %: the trunk — the answer
  add(8800, 30); // the far wall
  return { tx, ty, invz, w, n: tx.length };
}

test('nearestClumpDistance: skips a 2 % near sliver, lands on the 10 % trunk at 2.3 m', async () => {
  const { nearestClumpDistance } = await import('../js/inline3d-splat-rig.js');
  const r = nearestClumpDistance(clumpCloud(), LENS);
  near(r.distance, 2.3, 0.1, 'trunk');
  near(r.massFrac, 0.1, 0.02, 'its share of the crop');
  assert.equal(nearestClumpDistance(clumpCloud(), null), null, 'no lens → no rung');
});

test('the focus waterfall order: block(considered) › nearest-clump › block(cloud-median) › median-disparity', async () => {
  const { resolveRig } = await import('../js/inline3d-splat-rig.js');
  const cloud = clumpCloud();
  const cam = (focus, intrinsics = LENS) => ({
    rest: { position: [0, 0, 0], rotation: [0, 0, 0, 1] },
    intrinsics,
    focus,
  });
  // A considered block focus wins over the clump.
  let r = resolveRig({ camera: cam({ point: [0, 0, 5], source: 'convergence' }), cloud });
  assert.equal(r.focusSource, 'block');
  assert.equal(r.blockFocusSource, 'convergence');
  // An absent source counts as considered too.
  assert.equal(resolveRig({ camera: cam({ point: [0, 0, 5] }), cloud }).focusSource, 'block');
  // A converter's whole-cloud median ranks BELOW the clump.
  r = resolveRig({ camera: cam({ point: [0, 0, 46.9], source: 'cloud-median' }), cloud });
  assert.equal(r.focusSource, 'nearest-clump');
  near(r.convergence, 2.3, 0.1, 'the trunk, not 46.9 m');
  assert.equal(r.blockFocusSource, 'cloud-median');
  // Intrinsics-only block (no focus): the clump.
  assert.equal(resolveRig({ camera: cam(null), cloud }).focusSource, 'nearest-clump');
  // No lens: the clump rung is skipped; a median block still beats the recomputed median.
  r = resolveRig({ camera: cam({ point: [0, 0, 46.9], source: 'cloud-median' }, null), cloud });
  assert.equal(r.focusSource, 'block-cloud-median');
  assert.equal(resolveRig({ camera: null, cloud }).focusSource, 'median-disparity');
  // The caller still outranks everything.
  assert.equal(resolveRig({ camera: cam(null), cloud, opts: { convergence: 1.5 } }).focusSource, 'caller-convergence');
});

test('rigNeedsCloud: a lens + a considered focus answers everything; a median focus does not', async () => {
  const { rigNeedsCloud } = await import('../js/inline3d-splat-rig.js');
  assert.equal(rigNeedsCloud({ intrinsics: LENS, focus: { point: [0, 0, 2], source: 'manual' } }), false);
  assert.equal(rigNeedsCloud({ intrinsics: LENS, focus: { point: [0, 0, 2], source: 'cloud-median' } }), true);
  assert.equal(rigNeedsCloud({ intrinsics: LENS, focus: null }), true);
  assert.equal(rigNeedsCloud(null), true);
});

test('the adapter reports nearest-clump on handle.rig and through onFocusChange', async () => {
  installDom();
  const { pc, rec } = makeFakePc();
  // A flat resource whose centres ARE the clump cloud (identity rest: model = rest space).
  const cl = clumpCloud();
  const centers = new Float32Array(cl.n * 3);
  for (let i = 0; i < cl.n; i++) {
    const z = 1 / cl.invz[i];
    centers[i * 3] = cl.tx[i] * z;
    centers[i * 3 + 1] = cl.ty[i] * z;
    centers[i * 3 + 2] = z;
  }
  rec.queue = [{ centers, gsplatData: { numSplats: cl.n, meta: { camera: { convention: 'opencv', intrinsics: LENS } } } }];
  const out = {};
  const got = [];
  out.onFocusChange = (p, info) => got.push(info);
  await attachPlayCanvasSplat(out, null, makeCanvas(320, 180), 'https://x/scene.sog', { playcanvas: pc, focusInput: false }, []);
  assert.equal(out.rig.type, 'camera');
  assert.equal(out.rig.focusSource, 'nearest-clump');
  near(out.rig.convergence, 2.3, 0.1);
  assert.ok(got.some((i) => i && i.focusSource === 'nearest-clump'));
  out.remove();
});

// ── 17. captureFit ──────────────────────────────────────────────────────────────────────────

test("captureWindow 'height' is the 1.7 capture window, arithmetic for arithmetic", async () => {
  const { captureWindow } = await import('../js/inline3d-splat-shared.js');
  const K = { fx: 1194.67, fy: 1194.67, cx: 1000, cy: 600, width: 2048, height: 1152 };
  for (const aspect of [16 / 9, 1, 0.6, 2.4]) {
    const near = 0.001;
    // The formula applyCaptureCamera always had, inlined.
    const top = (near * K.cy) / K.fy;
    const bottom = -(near * (K.height - K.cy)) / K.fy;
    const mid = (near * (K.width / 2 - K.cx)) / K.fx;
    const half = ((top - bottom) * aspect) / 2;
    assert.deepEqual(captureWindow(K, aspect, near), { left: mid - half, right: mid + half, top, bottom }, `aspect ${aspect}`);
  }
});

test("captureWindow 'cover': a 4:3 capture in a 16:9 tile keeps the width and crops top/bottom; narrower tiles = 'height'", async () => {
  const { captureWindow, captureVerticalFovDeg } = await import('../js/inline3d-splat-shared.js');
  const K = { fx: 1000, fy: 1000, cx: 800, cy: 600, width: 1600, height: 1200 }; // 4:3, centred
  const near = 1;
  const c = captureWindow(K, 16 / 9, near, 'cover');
  near_(c.left, -0.8);
  near_(c.right, 0.8);
  near_((c.right - c.left) / (c.top - c.bottom), 16 / 9, 'fills the tile');
  assert.ok(c.top - c.bottom < 1.2 - 1e-9, 'vertical cropped below the capture’s 1.2');
  near_((c.top + c.bottom) / 2, 0, 'crop centred on the frame');
  assert.deepEqual(captureWindow(K, 1, near, 'cover'), captureWindow(K, 1, near, 'height'), 'a narrower tile: identical');
  // The rig FOV follows the crop (so 3D crops like the flat view); 'height' is the lens's own.
  near_(captureVerticalFovDeg(K, 16 / 9, near, 'height'), (2 * Math.atan(600 / 1000) * 180) / Math.PI);
  assert.ok(captureVerticalFovDeg(K, 16 / 9, near, 'cover') < captureVerticalFovDeg(K, 16 / 9, near, 'height'));
  function near_(a, b, what = '') {
    assert.ok(Math.abs(a - b) < 1e-9, `${what} ${a} !~= ${b}`);
  }
});

test("the PlayCanvas viewer's mono camera honours captureFit, and re-declares the rig FOV on a resize", async () => {
  installDom();
  const { PlayCanvasSplatViewer, frustumFromProjection } = await import('../js/inline3d-splat-playcanvas.js');
  const K = { fx: 1000, fy: 1000, cx: 800, cy: 600, width: 1600, height: 1200 };
  const rig = { rest: { position: [0, 0, 0], rotation: [0, 0, 0, 1] }, intrinsics: K };
  const canvas = makeCanvas(640, 360);
  const h = new PlayCanvasSplatViewer(canvas, { orbit: false });
  const c = new PlayCanvasSplatViewer(makeCanvas(640, 360), { orbit: false, captureFit: 'cover' });
  let pushed = 0;
  c.onCaptureFov = () => pushed++;
  h.useCaptureCamera(rig);
  c.useCaptureCamera(rig);
  assert.ok(frustumFromProjection(c.mono.proj).fov < frustumFromProjection(h.mono.proj).fov, 'cover crops the vertical');
  near(frustumFromProjection(c.mono.proj).fov, c.mono.fov, 1e-9, 'the fov the rig sends matches the crop');
  assert.equal(pushed, 1);
  h.dispose();
  c.dispose();
});

test('addSplat validates captureFit at call time (source check — ./splat imports three)', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../js/inline3d-splat.js', import.meta.url), 'utf8');
  assert.match(src, /CAPTURE_FITS\.includes\(opts\.captureFit\)/);
});

// ── 18. handle.engine — the escape hatch ────────────────────────────────────────────────────

test('handle.engine is a frozen { app, root, camera }; the splat hangs under root; remove() destroys the app', async () => {
  installDom();
  const { pc, rec } = makeFakePc();
  rec.queue = [fakeFlat(300, 0)];
  const out = {};
  await attachPlayCanvasSplat(out, null, makeCanvas(320, 180), 'a.sog', { playcanvas: pc, focusInput: false }, []);
  assert.equal(out.backend, 'playcanvas');
  const { app, root, camera } = out.engine;
  assert.ok(Object.isFrozen(out.engine));
  assert.ok(root.children.includes(out.mesh.entity), 'the content root holds the splat');
  assert.equal(root.app, app);
  assert.equal(camera, out.viewer.eye, 'the eye-rig camera entity');
  let destroyed = 0;
  app.destroy = () => destroyed++;
  out.remove();
  assert.equal(destroyed, 1, 'page-added entities under root die with the app');
});

// ── 19. parity: exact pick, formats refused at call time, renderScale ───────────────────────

test('pick is EXACT over the engine’s full centre set, skipping haze by the kept opacity byte', async () => {
  installDom();
  const { pc, rec } = makeFakePc();
  // 50k centres far off-axis, plus two on the view axis: a HAZE one nearer, a solid one behind it.
  const n = 50002;
  const centers = new Float32Array(n * 3);
  for (let i = 0; i < n - 2; i++) {
    centers[i * 3] = 50 + (i % 100);
    centers[i * 3 + 1] = 50;
    centers[i * 3 + 2] = 10;
  }
  centers.set([0, 0, 1.5], (n - 2) * 3); // haze
  centers.set([0.001, 0, 2.5], (n - 1) * 3); // solid — the answer
  const alpha = new Uint8Array(n * 4).fill(255);
  alpha[(n - 2) * 4 + 3] = 3; // ~1 % opacity
  const w = 256;
  const h = Math.ceil(n / w);
  const px = new Uint8Array(w * h * 4);
  px.set(alpha.subarray(0, n * 4));
  rec.queue = [{ centers, gsplatData: { numSplats: n, isSog: true, meta: { version: 2 }, sh0: { width: w, height: h, read: async () => px } } }];
  const out = {};
  await attachPlayCanvasSplat(out, null, makeCanvas(320, 180), 'a.sog', { playcanvas: pc, focusInput: false, rig: 'display', fit: 'none' }, []);
  // Aim through the centre of the canvas along the model +z axis: use a camera at the origin.
  out.viewer.mono.pose = poseMatrix([0, 0, 0], [0, 0, 0, 1]); // content −z = model +z (the flip)
  out.viewer.setFocus([0, 0, 0], { snap: true, recentre: false });
  const p = out.pick(160, 90);
  assert.ok(p, 'hit something');
  near(p[2], 2.5, 1e-6, 'the solid splat, not the nearer haze — and not a strided sample (it is index n-1)');
  out.remove();
});

test('fileType: Spark names route to the engine parsers; Spark-only types are refused', async () => {
  const { engineFormatFor, playcanvasCannotRead } = await import('../js/inline3d-splat-shared.js');
  assert.deepEqual(engineFormatFor(null, new Uint8Array([1, 2, 3, 4]), undefined, 'pcsogszip'), { ext: 'sog', streamed: false });
  assert.equal(engineFormatFor(null, new Uint8Array(4), undefined, 'spz'), null);
  assert.equal(playcanvasCannotRead('https://x/a.sog'), null);
  assert.equal(playcanvasCannotRead('https://x/lod-meta.json'), null);
  assert.equal(playcanvasCannotRead('https://x/no-extension'), null, 'unknowable now → decided at load');
  assert.equal(playcanvasCannotRead(new Blob([])), null, 'a Blob is read at load');
  assert.match(playcanvasCannotRead('https://x/a.spz'), /engine:'spark'/);
  assert.match(playcanvasCannotRead(new Uint8Array([0x1f, 0x8b, 0, 0])), /engine:'spark'/);
  assert.match(playcanvasCannotRead('x.sog', { fileType: 'ksplat' }), /ksplat/);
});

test('renderScale sizes the buffer: min(dpr,2)·renderScale per eye, double-width in 3D, 1:1 flat', async () => {
  installDom();
  globalThis.window.devicePixelRatio = 3; // clamped to 2
  const { PlayCanvasSplatViewer } = await import('../js/inline3d-splat-playcanvas.js');
  const canvas = makeCanvas(500, 300);
  const v = new PlayCanvasSplatViewer(canvas, { orbit: false, renderScale: 0.6 });
  assert.deepEqual([canvas.width, canvas.height], [2 * Math.round(500 * 2 * 0.6), Math.round(300 * 2 * 0.6)]);
  v.startMono();
  assert.deepEqual([canvas.width, canvas.height], [600, 360]);
  v.dispose();
  globalThis.window.devicePixelRatio = 1;
});


// ── 1.9.1: handle.engine.root usable for glTF — systems, handlers, idempotency, depth range ────

test('the registration list is pinned: splat + exactly what a glTF with animation needs', async () => {
  const { PLAYCANVAS_SYSTEMS, PLAYCANVAS_HANDLERS } = await import('../js/inline3d-splat-playcanvas.js');
  assert.deepEqual(PLAYCANVAS_SYSTEMS, [
    'CameraComponentSystem',
    'GSplatComponentSystem',
    'RenderComponentSystem',
    'LightComponentSystem',
    'AnimComponentSystem',
  ]);
  assert.deepEqual(PLAYCANVAS_HANDLERS, ['TextureHandler', 'GSplatHandler', 'ContainerHandler']);
  assert.ok(Object.isFrozen(PLAYCANVAS_SYSTEMS) && Object.isFrozen(PLAYCANVAS_HANDLERS));
});

test('a page that registers Render/Light/Anim again (the pre-1.9.1 pattern) does not throw', async () => {
  installDom();
  const { pc } = makeFakePc();
  // The engine's registry: add() THROWS on a duplicate id.
  const origInit = pc.AppBase.prototype.init;
  pc.AppBase.prototype.init = function (o) {
    origInit.call(this, o);
    const reg = { list: [] };
    reg.add = (sys) => {
      if (reg[sys.id]) throw new Error(`ComponentSystem name '${sys.id}' already registered or not allowed`);
      reg[sys.id] = sys;
      reg.list.push(sys);
    };
    for (const id of ['camera', 'gsplat', 'render', 'light', 'anim']) reg.add({ id });
    this.systems = reg;
  };
  const { PlayCanvasSplatViewer } = await import('../js/inline3d-splat-playcanvas.js');
  const v = new PlayCanvasSplatViewer(makeCanvas(320, 180), { orbit: false });
  const app = await v.attachEngine(pc, { perf: playcanvasPerfSettings(undefined) });
  const existing = app.systems.render;
  let destroyed = 0;
  const dup = { id: 'render', destroy: () => destroyed++ };
  assert.equal(app.systems.add(dup), existing, 'returns the registered system');
  assert.equal(destroyed, 1, 'the duplicate is released');
  assert.equal(app.systems.list.length, 5, 'nothing added twice');
  app.systems.add({ id: 'sound' });
  assert.ok(app.systems.sound, 'new ids still register');
  v.dispose();
});

test('clampProjectionDepth raises near / lowers far, keeps the frustum shape, is idempotent', async () => {
  const { clampProjectionDepth } = await import('../js/inline3d-splat-playcanvas.js');
  const P = perspectiveOffAxis(-0.06, 0.04, 0.03, -0.03, 0.001, 5000);
  const before = Float64Array.from(P);
  clampProjectionDepth(P, 0.05, 50);
  const f = frustumFromProjection(P);
  near(f.nearClip, 0.05, 1e-9);
  near(f.farClip, 50, 1e-6);
  for (const i of [0, 5, 8, 9, 11]) assert.equal(P[i], before[i], `element ${i} (fov, skew) untouched`);
  const again = Float64Array.from(P);
  clampProjectionDepth(P, 0.05, 50);
  assert.deepEqual(Array.from(P), Array.from(again), 'idempotent');
  const Q = perspectiveOffAxis(-0.06, 0.04, 0.03, -0.03, 0.2, 10);
  const q0 = Float64Array.from(Q);
  clampProjectionDepth(Q, 0.05, 50); // near already above the floor, far already below the cap
  assert.deepEqual(Array.from(Q), Array.from(q0), 'a floor/cap never widens the range');
  clampProjectionDepth(Q, null, null);
  assert.deepEqual(Array.from(Q), Array.from(q0));
});

test('nearClip / farClip reach the viewer as a floor and a cap (unset = untouched)', async () => {
  installDom();
  const { PlayCanvasSplatViewer } = await import('../js/inline3d-splat-playcanvas.js');
  const a = new PlayCanvasSplatViewer(makeCanvas(320, 180), { orbit: false, nearClip: 0.05, farClip: 50 });
  assert.deepEqual([a.nearClip, a.farClip], [0.05, 50]);
  const b = new PlayCanvasSplatViewer(makeCanvas(320, 180), { orbit: false, nearClip: -1 });
  assert.deepEqual([b.nearClip, b.farClip], [null, null]);
  a.dispose();
  b.dispose();
});

test('package.json is readable through the exports map ("./package.json")', async () => {
  const fs = await import('node:fs');
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.exports['./package.json'], './package.json');
});


// ── 1.10.1: no sky by default; the swap's cloud work off the long-task path ────────────────

test('sky: the eye camera renders no SKYBOX layer by default; sky:true keeps the engine’s sky', async () => {
  installDom();
  const { PlayCanvasSplatViewer } = await import('../js/inline3d-splat-playcanvas.js');
  for (const [opts, hasSky] of [[{}, false], [{ sky: false }, false], [{ sky: true }, true]]) {
    const { pc } = makeFakePc();
    const v = new PlayCanvasSplatViewer(makeCanvas(320, 180), { orbit: false, ...opts });
    await v.attachEngine(pc, { perf: playcanvasPerfSettings(undefined) });
    assert.equal(v.eye.camera.layers.includes(2), hasSky, JSON.stringify(opts));
    assert.ok(v.eye.camera.layers.includes(0), 'the World layer (the splat) stays');
    assert.ok(v.eye.camera.layers.includes(4), 'the UI layer (feather) stays');
    v.dispose();
  }
});

test('selectKth is the sorted k-th element (NaN last, duplicates, extremes) — boundsFromPositions unchanged', async () => {
  const { selectKth, boundsFromPositions } = await import('../js/inline3d-viewer.js');
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let t = 0; t < 200; t++) {
    const n = 1 + Math.floor(rnd() * 2000);
    const a = new Float64Array(n);
    for (let i = 0; i < n; i++) a[i] = rnd() < 0.1 ? Math.round(rnd() * 4) : rnd() < 0.02 ? NaN : rnd() * 100 - 50;
    const sorted = Float64Array.from(a).sort();
    for (const k of [0, n >> 1, n - 1, Math.floor(0.05 * (n - 1)), Math.floor(0.95 * (n - 1))]) {
      const got = selectKth(Float64Array.from(a), n, k);
      assert.ok(Object.is(got, sorted[k]) || (got === 0 && sorted[k] === 0), `n ${n} k ${k}: ${got} vs ${sorted[k]}`);
    }
  }
  // The percentile box on a known cloud (the pre-1.10.1 sort-based answer, precomputed).
  const xyz = new Float32Array(3000 * 3);
  for (let i = 0; i < 3000; i++) {
    xyz[i * 3] = (i % 30) * 0.1;
    xyz[i * 3 + 1] = Math.floor(i / 30) % 10;
    xyz[i * 3 + 2] = i === 5 ? 1e4 : Math.floor(i / 300);
  }
  const b = boundsFromPositions(xyz);
  near(b.center[0], 1.45, 1e-6);
  near(b.extent[0], 2.9, 1e-6);
  near(b.center[2], 4.5, 1e-6, 'the floater at 1e4 is rejected');
  near(b.extent[2], 9, 1e-6);
});

test('the cloud passes yield between steps (source check: each in its own task; `y` = yieldToMain, or yieldIdle for prepareSource)', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../js/inline3d-splat-playcanvas.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('async function loadOne('), src.indexOf('function applyLoaded('));
  const order = ['cloud:bounds', 'cloud:rest-sample', 'cloud:pick-set'];
  let at = 0;
  for (const name of order) {
    const i = body.indexOf(`perfSpan('${name}'`, at);
    assert.ok(i > at, name);
    assert.ok(/await (yieldToMain|y)\(\)/.test(body.slice(at, i)), `a yield before ${name}`);
    at = i;
  }
});

// ── 13b. setSource: LIVE outgoing + prepareSource (./inline3d-splat-live.js) ─────────────────

/** The fake engine plus what the live path touches: layers, targets, RenderViews, the director. */
async function liveRig(t, { outgoing = 'live', transition = 'crossfade', durationMs = 100 } = {}) {
  installDom();
  const clock = { T: 1000 };
  t.mock.method(performance, 'now', () => clock.T);
  const { pc, rec } = makeFakePc();
  pc.Texture = class { constructor(d, o) { this.o = o; } destroy() { this.destroyed = true; } };
  pc.RenderTarget = class { constructor(o) { this.o = o; } destroy() { this.destroyed = true; } };
  pc.Layer = class { constructor(o) { this.name = o.name; this.id = 1000; } };
  pc.RenderView = class {
    setView(p, v) { this.proj = Float64Array.from(p); this.pose = Float64Array.from(v); }
    setViewport(...a) { this.vp = a; }
  };
  Object.assign(pc, { PIXELFORMAT_RGBA8: 7, FILTER_NEAREST: 0, ADDRESS_CLAMP_TO_EDGE: 1, BLENDMODE_ONE: 'ONE', BLENDMODE_ONE_MINUS_SRC_ALPHA: 'OMSA' });
  pc.Entity.prototype.removeChild = function (c) { this.children = this.children.filter((x) => x !== c); };
  pc.Entity.prototype.getLocalPosition = () => ({ x: 0, y: 0, z: 0 });
  pc.Entity.prototype.getLocalRotation = () => ({ x: 0, y: 0, z: 0, w: 1 });
  rec.queue = [fakeFlat(600, 0), fakeFlat(600, 5), fakeFlat(600, 9)];
  const out = {};
  await attachPlayCanvasSplat(out, null, makeCanvas(320, 180), 'a.sog', { playcanvas: pc, focusInput: false, idleSpin: 0 }, []);
  const v = out.viewer;
  v.app.graphicsDevice.copyRenderTarget = () => true;
  const pushed = [];
  v.app.scene.layers.push = (l) => pushed.push(l);
  const camerasMap = new Map();
  v.app.renderer = { gsplatDirector: { camerasMap } };
  const frame = (dt = 0) => {
    clock.T += dt;
    v._tick();
    v._drawMono();
  };
  const opts = { transition, durationMs, ...(outgoing ? { outgoing } : {}) };
  return { pc, rec, out, v, clock, frame, pushed, camerasMap, opts };
}

/** Make the director report a sorted manager for the live camera (what `ready` reads). */
function sortLive(v, camerasMap) {
  const live = v._live;
  const world = { lastWorldStateVersion: 3, getState: (n) => (n === 3 ? { sortedBefore: true } : null) };
  camerasMap.set(live.cam.camera.camera, { layersMap: new Map([[live.layer, { gsplatManager: { world } }]]) });
}

test('LIVE outgoing: the old asset moves to its own layer + camera + target, keeps rendering, the overlay switches to it once sorted', async (t) => {
  const { rec, out, v, frame, pushed, camerasMap, opts, clock } = await liveRig(t);
  const e1 = out.mesh.entity;
  const a1 = out.mesh.asset;
  const done = out.setSource('b.sog', opts);
  await settle(() => v._captureWaiters.length === 1);
  v._afterTick(); // the frozen bridge is captured
  await settle(() => out.mesh.entity !== e1);
  const e2 = out.mesh.entity;
  const live = v._live;
  assert.ok(live?.active, 'live window open');
  assert.equal(pushed.length, 1, 'one layer, added to the composition');
  assert.equal(pushed[0].name, 'inline3d-outgoing');
  assert.equal(e1.enabled, true, 'the outgoing asset stays resident and drawn');
  assert.deepEqual(e1.gsplat.layers, [pushed[0].id], 'ONLY on the live layer (one manager per camera × layer)');
  assert.equal(e2.gsplat.layers, undefined, 'the incoming asset keeps the default World layer (the eye camera)');
  assert.equal(live.cam.enabled, true);
  assert.deepEqual(live.cam.camera.layers, [pushed[0].id], 'the live camera sees only its layer');
  assert.equal(live.cam.camera.priority, -1, 'renders before the eye (whose overlay samples it)');
  assert.equal(live.cam.camera.renderTarget, live.rt);
  assert.equal(live.tex.o.width, v.canvas.width, 'target = the whole buffer, every eye where it sits');
  assert.equal(live.tex.o.height, v.canvas.height);
  const parts = rec.meshInstances.filter((mi) => /Snapshot/.test(mi.material.desc.uniqueName));
  const src = () => parts[1].material.params.get('dxrSnap');
  assert.equal(src(), v._snap.tex, 'the frozen capture bridges until the live camera has sorted');
  frame();
  assert.equal(src(), v._snap.tex, 'still frozen: no sorted manager yet');
  // The live camera's views are the eye's: same projection and pose, same viewport.
  assert.equal(live.views.length, 1);
  assert.deepEqual([...live.views[0].proj], [...v.mono.proj]);
  assert.deepEqual([...live.views[0].pose], [...v.mono.pose]);
  sortLive(v, camerasMap);
  frame(); // the hook sees `ready`
  assert.equal(src(), live.tex, 'overlay now samples the LIVE target');
  frame(); // clock starts (second tick)
  clock.T += 50;
  frame();
  near(parts[1].material.params.get('dxrSnapAlpha'), 0.5, 1e-9, 'the same lerp, now of two live images');
  assert.equal(e1.enabled, true);
  clock.T += 60;
  frame();
  await done;
  assert.equal(live.active, false, 'window closed');
  assert.equal(live.cam.enabled, false, 'camera off: the director drops its manager');
  assert.equal(live.rt, null, 'target freed');
  assert.equal(src(), v._snap.tex, 'overlay back on the frozen source for the next swap');
  assert.ok(parts.every((mi) => !mi.visible), 'overlay hidden: exactly the untouched incoming asset');
  assert.equal(e1.enabled, false, 'the outgoing asset released at the end');
  for (let i = 0; i < 4; i++) frame(16);
  assert.ok(e1.destroyed && rec.removed.includes(a1) && a1.unloaded, 'and destroyed + unloaded a few frames later');
  out.remove();
});

test("outgoing:'frozen' keeps the 1.12.1 path (old asset released at once, no live camera); a bad value throws before loading", async (t) => {
  const { out, v, opts } = await liveRig(t, { outgoing: 'frozen' });
  const e1 = out.mesh.entity;
  await assert.rejects(out.setSource('x.sog', { transition: 'crossfade', outgoing: 'moving' }), /outgoing 'moving' — expected 'live' or 'frozen'/);
  const done = out.setSource('b.sog', opts);
  await settle(() => v._captureWaiters.length === 1);
  v._afterTick();
  await settle(() => out.mesh.entity !== e1);
  assert.equal(e1.enabled, false, 'frozen: the snapshot shows it — released at once');
  assert.ok(!v._live?.active, 'no live window');
  out.setSource('c.sog', { transition: 'cut' }); // supersedes; the crossfade finishes
  await done;
  out.remove();
});

test('LIVE outgoing with the wavefront: live during the wipe, stopped + released when it ends; a resize mid-window ends it', async (t) => {
  const { out, v, frame, camerasMap, opts } = await liveRig(t, { transition: 'wavefront', durationMs: 100 });
  const e1 = out.mesh.entity;
  let done = out.setSource('b.sog', opts);
  await settle(() => v._captureWaiters.length === 1);
  v._afterTick();
  await settle(() => out.mesh.entity !== e1);
  assert.ok(v._live.active && e1.enabled);
  sortLive(v, camerasMap);
  for (let i = 0; i < 40; i++) {
    frame(10);
    await new Promise((r) => setTimeout(r, 0)); // the effect's gate resolves between frames
  }
  await done;
  assert.equal(v._live.active, false);
  assert.equal(e1.enabled, false);
  // A resize mid-window: the target no longer fits the buffer — the transition ends at once.
  const e2 = out.mesh.entity;
  done = out.setSource('c.sog', { ...opts, durationMs: 10000 });
  await settle(() => v._captureWaiters.length === 1);
  v._afterTick();
  await settle(() => out.mesh.entity !== e2);
  frame(10);
  v.canvas.width = 999;
  frame(10);
  frame(10);
  await done;
  assert.equal(v._live.active, false, 'stopped');
  assert.equal(e2.enabled, false, 'released');
  out.remove();
});

test('a newer setSource supersedes a live window: it closes (camera off, old asset released) before the next swap starts', async (t) => {
  const { out, v, frame, opts } = await liveRig(t, { durationMs: 10000 });
  const e1 = out.mesh.entity;
  const first = out.setSource('b.sog', opts);
  await settle(() => v._captureWaiters.length === 1);
  v._afterTick();
  await settle(() => out.mesh.entity !== e1);
  frame(10);
  assert.ok(v._live.active);
  const second = out.setSource('c.sog', { transition: 'cut' });
  await first;
  assert.equal(v._live.active, false);
  assert.equal(e1.enabled, false);
  await second;
  out.remove();
});

test('outgoingChain: N = R_o·K_o·D_o·(K_n·D_n)⁻¹ — the old lens frame seen through the new one; two identical frames cancel to R_o', async () => {
  const { outgoingChain } = await import('../js/inline3d-splat-live.js');
  const q = (deg) => [0, Math.sin((deg * Math.PI) / 360), 0, Math.cos((deg * Math.PI) / 360)];
  const compose = (ch) => {
    const trs = (x) => { const m = poseMatrix(x.position, x.rotation); for (let i = 0; i < 12; i++) if (i % 4 !== 3) m[i] *= x.scale; return m; };
    const S = poseMatrix([0, 0, 0], [0, 0, 0, 1]);
    S[0] = ch.scale[0]; S[5] = ch.scale[1]; S[10] = ch.scale[2];
    return mat4Mul(mat4Mul(trs(ch.n1), S), trs(ch.n3));
  };
  const D = (c, tt) => { const m = poseMatrix([0, 0, 0], [0, 0, 0, 1]); m[0] = c * tt; m[5] = c * tt; m[10] = c; return m; };
  const R = poseMatrix([0.1, -0.2, 0.3], q(12));
  for (let i = 0; i < 12; i++) if (i % 4 !== 3) R[i] *= 1.7; // the rig scale (fit)
  const oldF = { rig: R, pose: poseMatrix([0, 0, 0.4], q(-5)), c: 0.9, t: 0.35 };
  const newF = { rig: poseMatrix([0, 0, 0], [0, 0, 0, 1]), pose: poseMatrix([0.05, 0, 0.2], q(8)), c: 2.4, t: 0.52 };
  const N = compose(outgoingChain(oldF, newF));
  // N · K_n · D_n must equal R_o · K_o · D_o: the new window maps onto the old one.
  const lhs = mat4Mul(N, mat4Mul(newF.pose, D(newF.c, newF.t)));
  const rhs = mat4Mul(oldF.rig, mat4Mul(oldF.pose, D(oldF.c, oldF.t)));
  for (let i = 0; i < 16; i++) assert.ok(Math.abs(lhs[i] - rhs[i]) < 1e-9, `N·K_n·D_n [${i}] ${lhs[i]} vs ${rhs[i]}`);
  const same = compose(outgoingChain(oldF, { ...oldF, rig: newF.rig }));
  for (let i = 0; i < 16; i++) assert.ok(Math.abs(same[i] - R[i]) < 1e-9, 'same lens → the old rig node alone');
});

test('prepareSource: loads in the background, setSource(prepared) swaps with no load; single use; dispose() unloads; remove() drops what is left', async (t) => {
  const { rec, out, v, opts } = await liveRig(t, { outgoing: 'frozen' });
  const loads = [];
  const load0 = v.app.assets.load;
  v.app.assets.load = (a) => (loads.push(a.name), load0(a));
  const prepared = await out.prepareSource('b.sog');
  assert.deepEqual(loads, ['b.sog'], 'fetched + decoded + uploaded now');
  assert.equal(prepared.state, 'ready');
  assert.equal(prepared.numSplats, 600);
  const e1 = out.mesh.entity;
  const done = out.setSource(prepared, opts);
  await settle(() => v._captureWaiters.length === 1);
  assert.deepEqual(loads, ['b.sog'], 'no second load on the transition path');
  v._afterTick();
  await settle(() => out.mesh.entity !== e1);
  assert.equal(out.mesh.asset.name, 'b.sog');
  assert.equal(prepared.state, 'used');
  await assert.rejects(out.setSource(prepared), /prepared source that was already used/);
  const p2 = await out.prepareSource('c.sog');
  p2.dispose();
  assert.equal(p2.state, 'disposed');
  const a2 = rec.removed.at(-1);
  assert.ok(a2.name === 'c.sog' && a2.unloaded, 'dispose() removes + unloads the asset');
  await assert.rejects(out.setSource(p2), /already disposed/);
  const p3 = await out.prepareSource('c.sog');
  await assert.rejects(out.setSource({ ...p3 }), /from another handle/); // a copy: not ours
  out.setSource('d.sog').catch(() => {});
  await done;
  out.remove();
  assert.equal(p3.state, 'disposed', 'remove() disposes a prepared asset nobody used');
});

test('boundsFromPositionsAsync: bit-identical to boundsFromPositions, yielding between the per-axis selections and the window pass', async () => {
  const { boundsFromPositions: sync, boundsFromPositionsAsync } = await import('../js/inline3d-viewer.js');
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const xyz = new Float32Array(30000 * 3).map((_, i) => (i % 3 === 2 ? 2 + rnd() : rnd() - 0.5) * (i === 99 ? 1e4 : 1));
  let yields = 0;
  const a = await boundsFromPositionsAsync(xyz, undefined, async () => { yields++; });
  assert.deepEqual(a, sync(xyz));
  assert.equal(yields, 3, 'one per axis (the last before the window pass)');
  assert.deepEqual(await boundsFromPositionsAsync(xyz.subarray(0, 30), undefined, async () => {}), sync(xyz.subarray(0, 30)), 'untrimmed small set');
});


test('an entity effect that ends puts the work buffer back on AUTO (ONCE alone left the engine placement on ALWAYS: re-render + re-sort every frame)', async (t) => {
  const { out, v, frame, opts } = await liveRig(t, { transition: 'wavefront', durationMs: 60, outgoing: 'frozen' });
  const e1 = out.mesh.entity;
  const done = out.setSource('b.sog', opts);
  await settle(() => v._captureWaiters.length === 1);
  v._afterTick();
  await settle(() => out.mesh.entity !== e1);
  const g = out.mesh.entity.gsplat;
  const seen = [];
  let val = g.workBufferUpdate;
  const first = val;
  Object.defineProperty(g, 'workBufferUpdate', { get: () => val, set: (x) => { seen.push(x); val = x; }, configurable: true });
  for (let i = 0; i < 30; i++) {
    frame(10);
    await new Promise((r) => setTimeout(r, 0));
  }
  await done;
  assert.ok(first === 2 || seen.includes(2), 'ALWAYS while the ridge plays');
  assert.deepEqual(seen.slice(-2), [0, 1], 'AUTO, then ONE clean re-render');
  out.remove();
});


// ── 13c. setSource: particle transitions (swarm, burst, shimmer-cross, dust) ─────────────────

test('particle transitions: validated before anything loads; linear shared clock, 2–3 s; no reveal; spans overlap', async () => {
  const { PARTICLE_TRANSITIONS, particleSpan } = await import('../js/inline3d-splat-effects.js');
  const { resolveSwap } = await import('../js/inline3d-splat-playcanvas.js');
  for (const name of ['swarm', 'burst', 'shimmer-cross', 'dust']) {
    const p = resolveSwap({ transition: name });
    assert.ok(PARTICLE_TRANSITIONS[name], name);
    assert.ok(p.durationMs >= 2000 && p.durationMs <= 3000, `${name}: ~2–3 s`);
    assert.equal(p.easing, 'linear', `${name}: each particle eases; the shared clock is linear`);
    assert.ok(p.particles, name);
    assert.throws(() => resolveSwap({ transition: name, reveal: 'sweep' }), /its own reveal/);
  }
  assert.equal(resolveSwap({ transition: 'swarm' }).particles.out.effect, 'assemble');
  assert.equal(resolveSwap({ transition: 'burst' }).particles.in.effect, 'converge');
  assert.equal(resolveSwap({ transition: 'shimmer-cross' }).particles.out.effect, 'shimmer');
  assert.equal(resolveSwap({ transition: 'dust' }).particles.in.effect, 'dissolve-in');
  assert.throws(() => resolveSwap({ transition: 'morph' }), /setSource transition 'morph'/, 'morph was prototyped and dropped');
  // shared particle options reach both sides; per-side overrides; bad values throw at the call
  const p = resolveSwap({ transition: 'swarm', order: 'noise', maxDisparity: 0, incomingFx: { spread: 0.2 } });
  assert.equal(p.particles.out.opts.order, 'noise');
  assert.equal(p.particles.in.opts.maxDisparity, 0);
  assert.equal(p.particles.in.opts.spread, 0.2);
  assert.throws(() => resolveSwap({ transition: 'swarm', stagger: 2 }), /stagger/);
  assert.throws(() => resolveSwap({ transition: 'dust', overlap: 1.5 }), /overlap/);
  assert.throws(() => resolveSwap({ transition: 'swarm', outgoingFx: 3 }), /outgoingFx/);
  // the spans: out over [0, (1+v)/2], in over [(1−v)/2, 1]
  near(particleSpan(0, 0.4, 'out'), 0, 1e-12);
  near(particleSpan(0.7, 0.4, 'out'), 1, 1e-12);
  near(particleSpan(0.3, 0.4, 'in'), 0, 1e-12);
  near(particleSpan(0.65, 0.4, 'in'), 0.5, 1e-12);
  near(particleSpan(1, 0.4, 'in'), 1, 1e-12);
});

test('swarm (LIVE): the outgoing asset plays assemble in reverse on the live camera, the incoming forwards; one clock; A OVER B; the end is a cut', async (t) => {
  const { rec, out, v, frame, camerasMap, clock } = await liveRig(t);
  const e1 = out.mesh.entity;
  const done = out.setSource('b.sog', { transition: 'swarm', durationMs: 1000 });
  await settle(() => v._captureWaiters.length === 1);
  v._afterTick();
  await settle(() => out.mesh.entity !== e1);
  const e2 = out.mesh.entity;
  const live = v._live;
  assert.ok(live?.active, 'the outgoing photo is live (it moves)');
  assert.match(e1.gsplat.modifier.glsl, /dxrFx_assemble_center\(center\)/, 'outgoing: its own entity modifier');
  assert.match(e2.gsplat.modifier.glsl, /dxrFx_assemble_center\(center\)/, 'incoming: its own');
  assert.equal(e1.gsplat.workBufferUpdate, 2, 'both re-render their work buffers while they move');
  assert.equal(e2.gsplat.workBufferUpdate, 2);
  assert.equal(e1.gsplat.getParameter('dxrFx_assemble_amount'), 1, 'the outgoing one starts untouched');
  assert.equal(e2.gsplat.getParameter('dxrFx_assemble_amount'), 0, 'the incoming one starts hidden');
  assert.deepEqual(out.effects(), [], 'driven by setSource: not a page effect');
  const parts = rec.meshInstances.filter((mi) => /Snapshot/.test(mi.material.desc.uniqueName));
  const over = () => parts[0].material.params.get('dxrSnapOver');
  frame();
  assert.equal(over(), 0, 'bridge (frozen capture, not yet sorted): the old frame alone');
  sortLive(v, camerasMap);
  frame(); // ready → live source
  frame(); // clock starts
  assert.equal(parts[1].material.params.get('dxrSnap'), live.tex);
  assert.equal(over(), 1, 'the live outgoing image OVER the incoming one');
  assert.equal(v._transitionState.raw, 0);
  clock.T += 500;
  frame();
  near(v._transitionState.raw, 0.5, 1e-9);
  const ov = particleSpanOf('out', 0.5), iv = particleSpanOf('in', 0.5);
  near(e1.gsplat.getParameter('dxrFx_assemble_amount'), 1 - ov, 1e-9, 'outgoing amount = 1 − its span');
  near(e2.gsplat.getParameter('dxrFx_assemble_amount'), iv, 1e-9, 'incoming amount = its span');
  near(e2.gsplat.getParameter('dxrFx_assemble_time'), 0.5, 1e-9, 'time from the shared clock');
  clock.T += 600;
  frame();
  await done;
  assert.equal(e2.gsplat.modifier, null, 'incoming modifier deleted: the engine default, exactly');
  assert.equal(e2.gsplat.workBufferUpdate, 1, 'back off ALWAYS');
  assert.equal(live.active, false, 'live camera off');
  assert.ok(parts.every((mi) => !mi.visible), 'overlay hidden');
  assert.equal(e1.enabled, false, 'outgoing released');
  assert.equal(v._transitionState, null);
  out.remove();
});

function particleSpanOf(side, t) {
  const v = 0.45; // swarm's overlap
  const a = side === 'out' ? 0 : (1 - v) / 2;
  const b = side === 'out' ? (1 + v) / 2 : 1;
  return Math.min(1, Math.max(0, (t - a) / (b - a)));
}

test("particle transitions with outgoing:'frozen': the snapshot fades out over the outgoing span while the new photo plays in", async (t) => {
  const { rec, out, v, frame, clock } = await liveRig(t, { outgoing: 'frozen' });
  const e1 = out.mesh.entity;
  const done = out.setSource('b.sog', { transition: 'dust', durationMs: 1000, outgoing: 'frozen' });
  await settle(() => v._captureWaiters.length === 1);
  v._afterTick();
  await settle(() => out.mesh.entity !== e1);
  const e2 = out.mesh.entity;
  assert.ok(!v._live?.active, 'no live camera');
  assert.equal(e1.enabled, false, 'the frozen frame shows the old photo: released at once');
  assert.match(e2.gsplat.modifier.glsl, /dxrFx_dissolve_in_center/);
  const parts = rec.meshInstances.filter((mi) => /Snapshot/.test(mi.material.desc.uniqueName));
  frame();
  frame();
  clock.T += 350; // dust: out span [0, 0.7]
  frame();
  near(parts[1].material.params.get('dxrSnapAlpha'), 0.5, 1e-9, 'frozen A fades over its span');
  clock.T += 700;
  frame();
  await done;
  assert.equal(e2.gsplat.modifier, null);
  out.remove();
});

test('particle transition with no frame to capture (hidden tab / no copy): the one-pass crossfade, no particles', async (t) => {
  installDom();
  let T = 1000;
  t.mock.method(performance, 'now', () => T);
  const { pc, rec } = makeFakePc(); // no RenderTarget: captureFrame() → false
  rec.queue = [fakeFlat(300, 0), fakeFlat(300, 5)];
  const out = {};
  await attachPlayCanvasSplat(out, null, makeCanvas(320, 180), 'a.sog', { playcanvas: pc, focusInput: false, idleSpin: 0 }, []);
  const e1 = out.mesh.entity;
  const done = out.setSource('b.sog', { transition: 'swarm', durationMs: 100 });
  await settle(() => out.mesh.entity !== e1);
  const e2 = out.mesh.entity;
  assert.match(e2.gsplat.modifier.glsl, /dxrFx_xfade_color/, 'the one-pass crossfade');
  assert.doesNotMatch(e2.gsplat.modifier.glsl, /assemble/);
  for (let i = 0; i < 4; i++) ((T += 60), out.viewer._tick());
  await done;
  assert.equal(e2.gsplat.modifier, null, 'end state: the untouched asset');
  assert.equal(e1.enabled, false);
  out.remove();
});

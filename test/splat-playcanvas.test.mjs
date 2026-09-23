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
  assert.equal(out.engine, 'playcanvas');
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
  const rec = { entities: [], resolution: 0, fillMode: 0, chunks: new Map(), deviceOpts: null, started: 0 };
  let current = null; // the engine's global "current app" — the trap the adapter must avoid
  class Entity {
    constructor(name, app = current) {
      this.name = name;
      this.app = app;
      this.children = [];
      rec.entities.push(this);
    }
    addChild(c) {
      this.children.push(c);
    }
    addComponent(type, data) {
      if (type === 'camera') this.camera = { ...data, camera: { setXrProperties() {} } };
      if (type === 'gsplat') this.gsplat = data;
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
      this.scene = { gsplat: { minPixelSize: 2, alphaClipForward: 1 / 255 } };
      this.resolutionMode = 'fixed';
      this.assets = {
        add() {},
        load: (a) => {
          a.resource = rec.resource;
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
    },
    Color: class { constructor(...a) { this.v = a; } },
    CameraComponentSystem: 'cam',
    GSplatComponentSystem: 'gsplat',
    TextureHandler: 'tex',
    GSplatHandler: 'gsh',
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
  assert.deepEqual(app.opts.componentSystems, ['cam', 'gsplat'], 'no xr, no input systems');
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

test('a Streamed SOG through the adapter: framed (not model scale), camera block read, pick warns once', async (t) => {
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
  assert.equal(out.pick(10, 10), null);
  assert.equal(out.pick(20, 20), null);
  const pickWarns = warn.mock.calls.filter((c) => /pick is unsupported on a Streamed SOG/.test(String(c.arguments[0])));
  assert.equal(pickWarns.length, 1, 'one warning, not one per call');
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

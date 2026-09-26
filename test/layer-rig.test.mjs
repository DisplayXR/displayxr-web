// handle.setLayerRig (js/inline3d-splat-layer-rig.js): the exact camera-rig → display-rig mapping,
// the camera-run split, and the engine glue on a fake engine. Design:
// docs/proposals/layer-display-rig.md.
//
// The ORACLES below re-implement the runtime's two rigs (displayxr-common dxr_view_math.c:
// dxr_camera3d_compute_view and dxr_display3d_compute_view) — in the TEST only, as the reference the
// SDK's mapping is checked against. The SDK itself builds no frustum.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cameraRigFrame,
  layerRigGain,
  windowShear,
  roundViews,
  layerRuns,
  mul4,
  invertRigid,
  validateLayerRig,
  validateLayerRigOptions,
  layerRigPlane,
  LayerRigCameras,
  DEFAULT_VIEWER_DISTANCE_M,
} from '../js/inline3d-splat-layer-rig.js';
import { snapshotRig, attachPlayCanvasSplat } from '../js/inline3d-splat-playcanvas.js';
import { installDom, makeCanvas } from './stubs.mjs';
import { makeSbsMaterial, validateSbsOptions, eyeSplit, EYE_SPLIT_UNIFORM, SBS_EYE_GLSL } from '../js/inline3d-splat-video.js';

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b} (eps ${eps})`);

// ── oracles: the runtime's rigs ─────────────────────────────────────────────────────────────

function rot(q, v) {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}
function pose(p, q) {
  const [x, y, z, w] = q;
  const m = new Float64Array(16);
  m[0] = 1 - 2 * (y * y + z * z); m[1] = 2 * (x * y + w * z); m[2] = 2 * (x * z - w * y);
  m[4] = 2 * (x * y - w * z); m[5] = 1 - 2 * (x * x + z * z); m[6] = 2 * (y * z + w * x);
  m[8] = 2 * (x * z + w * y); m[9] = 2 * (y * z - w * x); m[10] = 1 - 2 * (x * x + y * y);
  m[12] = p[0]; m[13] = p[1]; m[14] = p[2]; m[15] = 1;
  return m;
}
function projFromTangents(l, r, d, u, n = 0.01, f = 100) {
  const P = new Float64Array(16);
  P[0] = 2 / (l + r); P[8] = (r - l) / (l + r);
  P[5] = 2 / (u + d); P[9] = (u - d) / (u + d);
  P[10] = -(f + n) / (f - n); P[11] = -1; P[14] = (-2 * f * n) / (f - n);
  return P;
}
/** dxr_camera3d_compute_view (factors applied by the caller; eyes in metres, display space). */
function cameraView(e, nomZ, aspect, rig) {
  const m = rig.metersToVirtual;
  const invd = rig.convergenceDiopters;
  const ro = Math.tan(rig.verticalFov / 2) * aspect;
  const uo = Math.tan(rig.verticalFov / 2);
  const el = [m * e[0], m * e[1], m * (e[2] - nomZ)];
  const q = [rig.orientation.x, rig.orientation.y, rig.orientation.z, rig.orientation.w];
  const w = rot(q, el);
  const eyeWorld = [rig.position.x + w[0], rig.position.y + w[1], rig.position.z + w[2]];
  const s = [el[0] * invd, el[1] * invd, el[2] * invd];
  const den = 1 + s[2];
  return {
    pose: pose(eyeWorld, q),
    proj: projFromTangents((ro + s[0]) / den, (ro - s[0]) / den, (uo + s[1]) / den, (uo - s[1]) / den),
  };
}
/** dxr_display3d_compute_view: the display rig equivalent of the camera rig, with factors 1. */
function displayView(e, screen, rigD) {
  const m2v = rigD.virtualDisplayHeight / screen.h;
  const es = rigD.perspectiveFactor * m2v;
  const ez = [e[0] * es, e[1] * es, e[2] * es];
  const W = screen.w * m2v;
  const H = screen.h * m2v;
  const q = rigD.q;
  const w = rot(q, ez);
  const eyeWorld = [rigD.p[0] + w[0], rigD.p[1] + w[1], rigD.p[2] + w[2]];
  return {
    pose: pose(eyeWorld, q),
    proj: projFromTangents((W / 2 + ez[0]) / ez[2], (W / 2 - ez[0]) / ez[2], (H / 2 + ez[1]) / ez[2], (H / 2 - ez[1]) / ez[2]),
  };
}
function ndc(P, V, X) {
  const c = mul4(P, V);
  const x = c[0] * X[0] + c[4] * X[1] + c[8] * X[2] + c[12];
  const y = c[1] * X[0] + c[5] * X[1] + c[9] * X[2] + c[13];
  const w = c[3] * X[0] + c[7] * X[1] + c[11] * X[2] + c[15];
  return [x / w, y / w];
}

// A photo rig as the SDK declares it (cameraRigFromPose shape), tilted so nothing is axis-aligned.
const qTilt = (() => {
  const a = 0.3, b = -0.2;
  const q1 = [Math.sin(a / 2), 0, 0, Math.cos(a / 2)];
  const q2 = [0, Math.sin(b / 2), 0, Math.cos(b / 2)];
  const [x1, y1, z1, w1] = q2, [x2, y2, z2, w2] = q1;
  return [w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2, w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2, w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2, w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2];
})();
const PHOTO = {
  type: 'camera',
  position: { x: 0.4, y: -0.3, z: 1.2 },
  orientation: { x: qTilt[0], y: qTilt[1], z: qTilt[2], w: qTilt[3] },
  ipdFactor: 1,
  parallaxFactor: 1,
  convergenceDiopters: 1 / 2.4,
  verticalFov: (50 * Math.PI) / 180,
  metersToVirtual: 1,
};
const SCREEN = { w: 0.3, h: 0.3 / (16 / 9) }; // the canvas on the panel, metres
const NOM = 0.65; // nominal viewer distance, metres

/** The display rig the runtime's own conversion says the photo IS, with ipd = parallax = 1. */
function roundDisplayRig(rig, screen, n) {
  const D = 1 / rig.convergenceDiopters;
  const tanC = Math.tan(rig.verticalFov / 2);
  const q = [rig.orientation.x, rig.orientation.y, rig.orientation.z, rig.orientation.w];
  const f = rot(q, [0, 0, -1]);
  return {
    virtualDisplayHeight: 2 * D * tanC,
    perspectiveFactor: screen.h / (2 * n) / tanC,
    p: [rig.position.x + D * f[0], rig.position.y + D * f[1], rig.position.z + D * f[2]],
    q,
  };
}

// ── the math ────────────────────────────────────────────────────────────────────────────────

test('windowShear: fixes the convergence plane pointwise, sends the round eye to the runtime eye; gain 1 = identity', () => {
  const fr = cameraRigFrame(PHOTO);
  const E = [0.43, -0.28, 1.25];
  const { M, Minv, Eround } = windowShear(E, fr, 3.2);
  const ap = (m, X) => [0, 1, 2].map((r) => m[r] * X[0] + m[4 + r] * X[1] + m[8 + r] * X[2] + m[12 + r]);
  const q = [PHOTO.orientation.x, PHOTO.orientation.y, PHOTO.orientation.z, PHOTO.orientation.w];
  const Wc = fr.N0.map((v, i) => v + fr.D * fr.fwd[i]);
  for (const [a, b] of [[0, 0], [0.7, -0.2], [-1.3, 0.9]]) {
    const r = rot(q, [a, b, 0]);
    const X = [Wc[0] + r[0], Wc[1] + r[1], Wc[2] + r[2]];
    const Y = ap(M, X);
    for (let i = 0; i < 3; i++) near(Y[i], X[i], 1e-12, 'plane point fixed');
  }
  const back = ap(M, Eround);
  for (let i = 0; i < 3; i++) near(back[i], E[i], 1e-12, 'M(E′) = E');
  const I = mul4(M, Minv);
  for (let i = 0; i < 16; i++) near(I[i], i % 5 === 0 ? 1 : 0, 1e-12, 'M · M⁻¹ = I');
  const id = windowShear(E, fr, 1).M;
  for (let i = 0; i < 16; i++) near(id[i], i % 5 === 0 ? 1 : 0, 1e-15, 'gain 1: identity');
});

test('EXACT: photo camera-rig view · M_i draws every point where the display rig (ipd = parallax = 1) draws it — both eyes, off-centre, leaning', () => {
  const aspect = SCREEN.w / SCREEN.h;
  const fr = cameraRigFrame(PHOTO);
  const k = layerRigGain(fr, { viewerDistance: NOM });
  near(k, 2.4 / NOM, 1e-12, 'k = D / (m·n)');
  const R = roundDisplayRig(PHOTO, SCREEN, NOM);
  const heads = [
    [[-0.032, 0, NOM], [0.032, 0, NOM]],
    [[0.05, 0.03, 0.55], [0.114, 0.035, 0.56]], // off-centre, closer, slightly rolled
    [[-0.12, -0.04, 0.8], [-0.056, -0.041, 0.79]],
  ];
  const pts = [];
  const q = [PHOTO.orientation.x, PHOTO.orientation.y, PHOTO.orientation.z, PHOTO.orientation.w];
  for (let i = 0; i < 12; i++) {
    const loc = [Math.sin(i * 1.7) * 0.6, Math.cos(i * 2.3) * 0.4, (i % 5) * 0.12 - 0.2]; // window frame: ±, in front and behind
    const r = rot(q, loc);
    pts.push([fr.N0[0] + fr.D * fr.fwd[0] + r[0], fr.N0[1] + fr.D * fr.fwd[1] + r[1], fr.N0[2] + fr.D * fr.fwd[2] + r[2]]);
  }
  let worst = 0;
  for (const eyes of heads) {
    const entries = eyes.map((e) => cameraView(e, NOM, aspect, PHOTO));
    const round = roundViews(entries, fr, k);
    assert.ok(round, 'two views on a camera rig are rounded');
    eyes.forEach((e, i) => {
      const ref = displayView(e, SCREEN, R);
      // round eye == the display rig's eye
      for (let a = 0; a < 3; a++) near(round[i].eye[a], ref.pose[12 + a], 1e-9, 'round eye = display-rig eye');
      for (const X of pts) {
        const got = ndc(entries[i].proj, round[i].view, X);
        const want = ndc(ref.proj, invertRigid(ref.pose), X);
        worst = Math.max(worst, Math.abs(got[0] - want[0]), Math.abs(got[1] - want[1]));
      }
    });
  }
  assert.ok(worst < 1e-9, `max NDC error ${worst}`);
});

test('EXACT with a plane offset: the plane at D′ lands on the glass — the display rig through the window at D′, factors 1', () => {
  const aspect = SCREEN.w / SCREEN.h;
  const fr = cameraRigFrame(PHOTO);
  for (const opt of [{ planeDistance: 3.3 }, { planeOffset: 0.05 }, { planeOffset: -0.08 }]) {
    const Dp = layerRigPlane(fr, { viewerDistance: NOM, ...opt });
    if (opt.planeOffset) near(Dp, 2.4 * (1 + opt.planeOffset / NOM), 1e-12, 'D′ = D(1 + offset/n)');
    const k = layerRigGain(fr, { viewerDistance: NOM });
    // oracle: the photo portal family's window at D′ (same vfov), display rig with factors 1
    const R = roundDisplayRig({ ...PHOTO, convergenceDiopters: 1 / Dp }, SCREEN, NOM);
    const q = [PHOTO.orientation.x, PHOTO.orientation.y, PHOTO.orientation.z, PHOTO.orientation.w];
    let worst = 0;
    for (const eyes of [[[-0.032, 0, NOM], [0.032, 0, NOM]], [[0.05, 0.03, 0.55], [0.114, 0.035, 0.56]]]) {
      const entries = eyes.map((e) => cameraView(e, NOM, aspect, PHOTO));
      const round = roundViews(entries, fr, k, [], Dp);
      eyes.forEach((e, i) => {
        const ref = displayView(e, SCREEN, R);
        for (let a = 0; a < 3; a++) near(round[i].eye[a], ref.pose[12 + a], 1e-9, 'virtual eye = the D′ display rig eye');
        for (let j = 0; j < 10; j++) {
          const loc = [Math.sin(j * 1.3) * 0.5, Math.cos(j * 2.1) * 0.3, (j % 4) * 0.2 - 0.3];
          const r = rot(q, loc);
          const X = [0, 1, 2].map((c) => fr.N0[c] + Dp * fr.fwd[c] + r[c]);
          const got = ndc(entries[i].proj, round[i].view, X);
          const want = ndc(ref.proj, invertRigid(ref.pose), X);
          worst = Math.max(worst, Math.abs(got[0] - want[0]), Math.abs(got[1] - want[1]));
        }
      });
      // a point ON the D′ plane: zero disparity
      const X0 = [0, 1, 2].map((c) => fr.N0[c] + Dp * fr.fwd[c] + rot(q, [0.2, -0.1, 0])[c]);
      const pL = ndc(entries[0].proj, round[0].view, X0);
      const pR = ndc(entries[1].proj, round[1].view, X0);
      if (eyes[0][1] === 0) near(pL[0], pR[0], 1e-9, 'on the glass: no disparity');
    }
    assert.ok(worst < 1e-9, `${JSON.stringify(opt)}: max NDC error ${worst}`);
  }
});

test('viewInv and view are inverses, and the view the engine will compose is P⁻¹·M', () => {
  const fr = cameraRigFrame(PHOTO);
  const entries = [[-0.03, 0, 0.6], [0.03, 0, 0.6]].map((e) => cameraView(e, 0.6, 1.5, PHOTO));
  const r = roundViews(entries, fr, 4);
  for (const o of r) {
    const I = mul4(o.viewInv, o.view);
    for (let i = 0; i < 16; i++) near(I[i], i % 5 === 0 ? 1 : 0, 1e-12, 'viewInv · view = I');
  }
});

test('roundViews is null (the photo views are used as they are) in mono, off a camera rig, at gain 1, at infinite convergence', () => {
  const e2 = [[-0.03, 0, 0.6], [0.03, 0, 0.6]].map((e) => cameraView(e, 0.6, 1.5, PHOTO));
  const fr = cameraRigFrame(PHOTO);
  assert.equal(roundViews(e2.slice(0, 1), fr, 3), null, 'one view');
  assert.equal(roundViews(e2, null, 3), null, 'no rig');
  assert.equal(roundViews(e2, fr, 1), null, 'gain 1');
  assert.equal(cameraRigFrame({ type: 'display', virtualDisplayHeight: 0.3 }), null, 'a display rig is already round');
  assert.equal(cameraRigFrame({ ...PHOTO, convergenceDiopters: 0 }), null, 'no finite window');
  assert.equal(cameraRigFrame(null), null);
});

test('the 2D↔3D ramp: photo eyes collapsing onto the nominal viewpoint collapse the round eyes with them', () => {
  const fr = cameraRigFrame(PHOTO);
  for (const f of [1, 0.5, 0.1, 0]) {
    const eyes = [[-0.032 * f, 0, 0.6], [0.032 * f, 0, 0.6]];
    const entries = eyes.map((e) => cameraView(e, 0.6, 1.5, PHOTO));
    const r = roundViews(entries, fr, 4);
    const dPhoto = Math.hypot(...[0, 1, 2].map((a) => entries[1].pose[12 + a] - entries[0].pose[12 + a]));
    const dRound = Math.hypot(...[0, 1, 2].map((a) => r[1].eye[a] - r[0].eye[a]));
    near(dRound, 4 * dPhoto, 1e-12, `baseline follows the ramp at f=${f}`);
  }
});

test('gain: D/(m·n) from the declared descriptor; viewerDistance defaults to 0.6 m; an explicit gain wins', () => {
  const fr = cameraRigFrame({ ...PHOTO, metersToVirtual: 2 });
  near(layerRigGain(fr), 2.4 / (2 * DEFAULT_VIEWER_DISTANCE_M), 1e-12, 'default n');
  near(layerRigGain(fr, { viewerDistance: 0.5 }), 2.4, 1e-12, 'caller n');
  assert.equal(layerRigGain(fr, { viewerDistance: 0.5, gain: 1.7 }), 1.7, 'explicit gain');
});

test('a round eye never reaches the window plane (a large gain, leaning in)', () => {
  const fr = cameraRigFrame(PHOTO);
  const E = pose([0, 0, 0], [0, 0, 0, 1]);
  const lean = cameraView([0, 0, 0.1], 0.6, 1.5, PHOTO).pose; // 10 cm from the glass
  const { Eround } = windowShear([lean[12], lean[13], lean[14]], fr, 50);
  const Wc = fr.N0.map((v, i) => v + fr.D * fr.fwd[i]);
  const h = -(fr.fwd[0] * (Eround[0] - Wc[0]) + fr.fwd[1] * (Eround[1] - Wc[1]) + fr.fwd[2] * (Eround[2] - Wc[2]));
  assert.ok(h > 0, `h(E′) = ${h}`);
  assert.ok(E); // (pose helper sanity)
});

test('validateLayerRig / validateLayerRigOptions: names, ids and pc.Layer; options merge, null clears; bad ones throw', () => {
  assert.deepEqual(validateLayerRig('Stage', 'display'), { rig: 'display', opts: {} });
  assert.equal(validateLayerRig(7, 'camera').rig, 'camera');
  assert.deepEqual(validateLayerRig({ id: 3 }, 'display', { viewerDistance: 0.7, planeOffset: -0.02 }).opts, { viewerDistance: 0.7, planeOffset: -0.02 });
  assert.deepEqual(validateLayerRigOptions({ gain: null, planeDistance: 3 }), { gain: null, planeDistance: 3 });
  assert.throws(() => validateLayerRig('', 'display'), TypeError);
  assert.throws(() => validateLayerRig('Stage', 'round'), /expected 'display' or 'camera'/);
  assert.throws(() => validateLayerRig('Stage', 'display', { gain: 0 }), /bad gain/);
  assert.throws(() => validateLayerRig('Stage', 'display', { viewerDistance: -1 }), /bad viewerDistance/);
  assert.throws(() => validateLayerRig('Stage', 'display', { planeOffset: NaN }), /bad planeOffset/);
  assert.throws(() => validateLayerRigOptions({ stageOffset: 1 }), /unknown option/);
});

test('snapshotRig copies the frame fields (the SDK rewrites its descriptor in place)', () => {
  const live = { ...PHOTO, position: { ...PHOTO.position } };
  const s = snapshotRig(live);
  live.position.x = 99;
  live.convergenceDiopters = 7;
  assert.equal(s.position.x, PHOTO.position.x);
  assert.equal(s.convergenceDiopters, PHOTO.convergenceDiopters);
  assert.equal(snapshotRig(null), null);
});

// ── the run split ───────────────────────────────────────────────────────────────────────────

// PlayCanvas's default composition, with a page layer (10) pushed after World-transparent:
// World(o) Depth(o) Skybox(o) World(t) Stage(o) Stage(t) Immediate(o) Immediate(t) UI(t)
const COMP = [0, 1, 2, 0, 10, 10, 3, 3, 4];
const EYE = [0, 1, 2, 3, 4, 10];

test('layerRuns: before / display / after, in composition order', () => {
  const r = layerRuns(COMP, new Set([10]), EYE);
  assert.deepEqual(r.pre, [0, 1, 2]);
  assert.deepEqual(r.display, [10]);
  assert.deepEqual(r.post, [3, 4], 'Immediate and UI (feather, transition overlay) still draw after the stage');
  assert.deepEqual(r.interleaved, []);
});

test('layerRuns: nothing to split without a display layer the eye draws; interleaved layers stay first and are reported', () => {
  assert.deepEqual(layerRuns(COMP, new Set([99]), EYE).pre, EYE);
  const comp = [0, 10, 5, 11, 0, 4];
  const r = layerRuns(comp, new Set([10, 11]), [0, 4, 5, 10, 11]);
  assert.deepEqual(r.display, [10, 11]);
  assert.deepEqual(r.pre, [0, 5]);
  assert.deepEqual(r.interleaved, [5]);
  assert.deepEqual(r.post, [4]);
});

// ── the engine glue, on a fake engine ───────────────────────────────────────────────────────

function fakeViewer({ eyeLayers = EYE.slice(), comp = COMP, path = 'renderview', names = { Stage: 10, World: 0, UI: 4 }, layerCams = {} } = {}) {
  const made = [];
  class RV {
    setView(p, vi, v) { this.proj = p; this.viewInv = Float64Array.from(vi); this.view = v ? Float64Array.from(v) : null; }
    setViewport(...a) { this.vp = a; }
  }
  const layerObj = (id) => ({ id, cameras: layerCams[id] || [] });
  const mkCam = (name) => {
    const cam = {
      name,
      enabled: true,
      camera: { layers: [], camera: { xrViews: null, setXrProperties(p) { this.xr = p; } } },
      setLocalPosition(...p) { this.pos = p; },
      setLocalRotation(...q) { this.rot = q; },
    };
    return cam;
  };
  const v = {
    pc: { RenderView: RV, Vec4: class { constructor(...a) { this.v = a; } } },
    canvas: { width: 1920, height: 540 },
    _frustumKey: 'k1',
    _viewPath: path === 'cameras' ? 'cameras' : 'renderview',
    app: {
      scene: {
        layers: {
          layerList: comp.map((id) => ({ id })),
          getLayerByName: (n) => (n in names ? layerObj(names[n]) : null),
          getLayerById: (id) => (comp.includes(id) ? layerObj(id) : null),
        },
      },
    },
    eye: path === 'cameras' ? null : { camera: { layers: eyeLayers } },
    _views: path === 'cameras' ? [0, 1].map((i) => Object.assign(mkCam(`inline3d-eye-${i}`), { camera: { layers: eyeLayers.slice() } })) : [],
    _makeCamera(name) {
      const cam = mkCam(name);
      made.push(cam);
      return cam;
    },
  };
  return { v, made };
}
const rect = (e) => [e.x, e.y, e.width, e.height];
function stereo(rig = PHOTO) {
  return [[-0.032, 0, 0.6], [0.032, 0, 0.6]].map((e, i) => ({ ...cameraView(e, 0.6, 16 / 9, rig), x: i * 960, y: 0, width: 960, height: 540 }));
}
const quiet = (t) => t.mock.method(console, 'warn', () => {});

test('LayerRigCameras (renderviews): stage → display camera (priority 1), UI/Immediate → post camera (priority 2); rounded views; engaged', (t) => {
  const warns = [];
  t.mock.method(console, 'warn', (m) => warns.push(m));
  const { v, made } = fakeViewer();
  const lr = new LayerRigCameras(v);
  lr.set('Stage', 'display', { viewerDistance: 0.6 });
  const entries = stereo();
  lr.frame(entries, rect, { fov: 50 }, PHOTO, { located: true });
  assert.deepEqual(v.eye.camera.layers, [0, 1, 2], 'the eye keeps what draws before the stage');
  const [disp, post] = made;
  assert.equal(disp.camera.priority, 1);
  assert.deepEqual(disp.camera.layers, [10]);
  assert.equal(post.camera.priority, 2);
  assert.deepEqual(post.camera.layers, [3, 4]);
  for (const c of made) {
    assert.equal(c.camera.clearColorBuffer, false, 'never clears the photo');
    assert.equal(c.camera.frustumCulling, false);
  }
  const rvs = disp.camera.camera.xrViews;
  assert.equal(rvs.length, 2);
  assert.deepEqual(rvs[1].vp, [960, 0, 960, 540]);
  assert.equal(rvs[0].proj, entries[0].proj, 'the runtime projection, verbatim');
  const want = roundViews(entries, cameraRigFrame(PHOTO), 2.4 / 0.6);
  assert.deepEqual([...rvs[0].viewInv], [...want[0].viewInv]);
  assert.equal(disp.camera.clearDepthBuffer, true);
  assert.deepEqual([...post.camera.camera.xrViews[0].viewInv], [...entries[0].pose], 'post: the photo views');
  const st = lr.state();
  assert.equal(st.path, 'renderviews');
  assert.equal(st.engaged, true);
  assert.equal(st.reason, null);
  near(st.gain, 4, 1e-12, 'gain');
  near(st.planeM, 2.4, 1e-12, 'the photo convergence plane lands on the glass');
  assert.equal(st.located, true);
  assert.equal(warns.length, 1, 'one WARN on the first 3D frame');
  assert.match(warns[0], /path=renderviews engaged=true layers=\[Stage\] viewerDistance=0\.60m gain=4\.000 planeM=2\.400/);
  lr.frame(entries, rect, { fov: 50 }, PHOTO, { located: true });
  assert.equal(warns.length, 1, 'no repeat while nothing changes');
});

test('LayerRigCameras (ncamera): N display cameras at the views’ rects, the shear in the projection — the same pixels as the RenderView path', (t) => {
  quiet(t);
  const { v, made } = fakeViewer({ path: 'cameras' });
  const lr = new LayerRigCameras(v);
  lr.set('Stage', 'display', {});
  const entries = stereo();
  lr.frame(entries, rect, null, PHOTO, { located: true });
  for (const e of v._views) assert.deepEqual(e.camera.layers, [0, 1, 2], 'every eye camera drops the stage');
  const disp = made.filter((c) => c.camera.priority === 1);
  const post = made.filter((c) => c.camera.priority === 2);
  assert.equal(disp.length, 2, 'one display camera per view');
  assert.equal(post.length, 2, 'one post camera per view');
  assert.deepEqual(disp[1].camera.rect.v, [0.5, 0, 0.5, 1]);
  const st = lr.state();
  assert.equal(st.path, 'ncamera');
  assert.equal(st.engaged, true);
  // What the engine draws with: proj' · (rig-space node)⁻¹ must equal proj · view_round.
  const want = roundViews(entries, cameraRigFrame(PHOTO), 4);
  for (let i = 0; i < 2; i++) {
    const node = pose(disp[i].pos, [disp[i].rot[0], disp[i].rot[1], disp[i].rot[2], disp[i].rot[3]]);
    const got = mul4(disp[i]._dxrProj, invertRigid(node));
    const exp = mul4(entries[i].proj, want[i].view);
    for (let j = 0; j < 16; j++) near(got[j], exp[j], 1e-9, `view ${i} element ${j}`);
  }
  // post cameras: the photo's own projection and pose
  assert.deepEqual([...post[0]._dxrProj], [...entries[0].proj]);
});

test('LayerRigCameras: mono and a display rig draw the stage through the photo views, depth kept — and say why', (t) => {
  quiet(t);
  const { v, made } = fakeViewer();
  const lr = new LayerRigCameras(v);
  lr.set(10, 'display', {});
  const mono = stereo().slice(0, 1);
  lr.frame(mono, rect, { fov: 50 }, PHOTO);
  const disp = made[0];
  assert.deepEqual([...disp.camera.camera.xrViews[0].viewInv], [...mono[0].pose]);
  assert.equal(disp.camera.clearDepthBuffer, false);
  assert.equal(lr.state().path, 'mono');
  assert.equal(lr.state().engaged, false);
  assert.match(lr.state().reason, /mono/);
  const e2 = stereo();
  lr.frame(e2, rect, { fov: 50 }, { type: 'display', virtualDisplayHeight: 0.24 });
  assert.deepEqual([...disp.camera.camera.xrViews[1].viewInv], [...e2[1].pose]);
  assert.equal(lr.state().engaged, false);
  assert.match(lr.state().reason, /display rig/);
});

test('LayerRigCameras: NEVER silent — a missing layer and a layer another camera draws are named in reason', (t) => {
  quiet(t);
  const other = { entity: { name: 'AppStageCamera' } };
  const { v } = fakeViewer({ names: { Stage: 10, Other: 11 }, comp: [...COMP, 11], layerCams: { 11: [other] } });
  const lr = new LayerRigCameras(v);
  lr.set('Nope', 'display', {});
  lr.set('Other', 'display', {});
  lr.frame(stereo(), rect, { fov: 50 }, PHOTO);
  const st = lr.state();
  assert.equal(st.engaged, false);
  assert.match(st.reason, /"Nope" is not in the tile's layer composition/);
  assert.match(st.reason, /"Other" is drawn by AppStageCamera, not by the tile's eye camera/);
  lr.set('Stage', 'display', {});
  lr.frame(stereo(), rect, { fov: 50 }, PHOTO);
  assert.equal(lr.state().engaged, true, 'the resolvable layer engages');
  assert.match(lr.state().reason, /^engaged; .*Nope/, 'the others still reported');
});

test('LayerRigCameras: a display layer NO camera draws is adopted (in composition order) — the N-camera path has no handle.engine.camera', (t) => {
  quiet(t);
  const { v, made } = fakeViewer({ eyeLayers: [0, 1, 2, 3, 4] }); // Stage (10) in the composition, on no camera
  const lr = new LayerRigCameras(v);
  lr.set('Stage', 'display', {});
  lr.frame(stereo(), rect, { fov: 50 }, PHOTO);
  assert.equal(lr.state().engaged, true);
  assert.deepEqual(made[0].camera.layers, [10]);
  assert.deepEqual(v.eye.camera.layers, [0, 1, 2]);
});

test('LayerRigCameras: back to the camera rig (and the kill switch) restores the eye camera exactly', (t) => {
  quiet(t);
  const { v, made } = fakeViewer();
  const lr = new LayerRigCameras(v);
  lr.set('Stage', 'display', {});
  lr.frame(stereo(), rect, { fov: 50 }, PHOTO);
  lr.set('Stage', 'camera', {});
  lr.frame(stereo(), rect, { fov: 50 }, PHOTO);
  assert.deepEqual([...v.eye.camera.layers].sort((a, b) => a - b), [...EYE].sort((a, b) => a - b));
  assert.ok(made.every((c) => c.enabled === false), 'run cameras off');
  const k = fakeViewer();
  const lr2 = new LayerRigCameras(k.v);
  lr2.disabled = true;
  lr2.set('Stage', 'display', {});
  lr2.frame(stereo(), rect, { fov: 50 }, PHOTO);
  assert.deepEqual(k.v.eye.camera.layers, EYE, 'kill switch: never moved');
  assert.equal(k.made.length, 0, 'no camera made');
  assert.match(lr2.state().reason, /kill switch/);
});

test('LayerRigCameras: a layer named before it exists is picked up when the page adds it', (t) => {
  quiet(t);
  const { v } = fakeViewer({ comp: [0, 1, 2, 0, 3, 3, 4], eyeLayers: [0, 1, 2, 3, 4] });
  const lr = new LayerRigCameras(v);
  lr.set('Stage', 'display', {});
  assert.equal(lr.sync(), false, 'not there yet');
  v.app.scene.layers.layerList = COMP.map((id) => ({ id }));
  v.eye.camera.layers = EYE.slice();
  assert.equal(lr.sync(), true);
  assert.deepEqual(v.eye.camera.layers, [0, 1, 2]);
});

test('options merge across calls; setOptions changes the plane live', (t) => {
  quiet(t);
  const { v } = fakeViewer();
  const lr = new LayerRigCameras(v);
  lr.set('Stage', 'display', { viewerDistance: 0.5 });
  lr.setOptions({ planeOffset: 0.03 });
  lr.frame(stereo(), rect, { fov: 50 }, PHOTO);
  near(lr.state().planeM, 2.4 * (1 + 0.03 / 0.5), 1e-12, 'planeM = D(1 + offset/n)');
  assert.equal(lr.state().viewerDistance, 0.5, 'kept across the second call');
  lr.setOptions({ planeDistance: 3.1 });
  lr.frame(stereo(), rect, { fov: 50 }, PHOTO);
  assert.equal(lr.state().planeM, 3.1, 'planeDistance wins');
  lr.setOptions({ planeDistance: null, planeOffset: null });
  lr.frame(stereo(), rect, { fov: 50 }, PHOTO);
  near(lr.state().planeM, 2.4, 1e-12, 'cleared');
});

// ── makeSbsMaterial ─────────────────────────────────────────────────────────────────────────

test('makeSbsMaterial: left / right regions, the scene-wide split uniform, mono = the left half', () => {
  class SM {
    constructor(d) { this.desc = d; this.p = new Map(); }
    setParameter(k, v) { this.p.set(k, v); }
    update() {}
  }
  const pc = { ShaderMaterial: SM, SEMANTIC_POSITION: 'P', SEMANTIC_TEXCOORD0: 'T', CULLFACE_NONE: 0, CULLFACE_BACK: 1 };
  const tex = { width: 640, height: 180 };
  const m = makeSbsMaterial(pc, tex);
  assert.deepEqual(m.p.get('dxrSbsL'), [0, 0, 0.5, 1]);
  assert.deepEqual(m.p.get('dxrSbsR'), [0.5, 0, 0.5, 1]);
  assert.equal(m.p.get('dxrSbsTex'), tex);
  assert.ok(m.desc.fragmentGLSL.includes(`uniform float ${EYE_SPLIT_UNIFORM};`), 'declares the scene-wide split');
  assert.ok(!m.p.has(EYE_SPLIT_UNIFORM), 'never sets it per material (the scene value must win)');
  assert.ok(SBS_EYE_GLSL.includes('gl_FragCoord.x >= dxr_eye_split'));
  assert.deepEqual(makeSbsMaterial(pc, tex, { format: 'tb' }).p.get('dxrSbsR'), [0, 0.5, 1, 0.5]);
  assert.equal(eyeSplit([{}], rect), 1e9, 'mono: every fragment is the left eye');
  assert.equal(eyeSplit(stereo(), rect), 960, 'stereo: the right eye starts at its viewport');
  assert.throws(() => validateSbsOptions(tex, { format: 'lr' }), /format/);
  assert.throws(() => validateSbsOptions(tex, { opacity: 2 }), /opacity/);
  assert.throws(() => validateSbsOptions(tex, { bogus: 1 }), /unknown option/);
  assert.throws(() => validateSbsOptions(null), TypeError);
});

// ── the handle ──────────────────────────────────────────────────────────────────────────────

test('handle: setLayerRig / setLayerRigOptions are callable before the engine boots, validate at the call, and chain', () => {
  installDom();
  const pc = { createGraphicsDevice: () => new Promise(() => {}) }; // never boots
  const out = {};
  attachPlayCanvasSplat(out, null, makeCanvas(320, 180), 'x.sog', { playcanvas: pc }, []);
  assert.equal(out.setLayerRig('Stage', 'display', { viewerDistance: 0.7 }), out);
  assert.equal(out.setLayerRigOptions({ planeOffset: 0.02 }), out);
  const st = out.layerRigState();
  assert.deepEqual(st.display, ['Stage']);
  assert.equal(st.engaged, false);
  assert.equal(st.viewerDistance, 0.7);
  assert.equal(st.planeOffset, 0.02);
  assert.equal(st.reason, 'no frame drawn yet');
  out.setLayerRig('Stage', 'camera');
  assert.deepEqual(out.layerRigState().display, []);
  assert.throws(() => out.setLayerRig('Stage', 'round'), /expected 'display' or 'camera'/);
  assert.throws(() => out.setLayerRigOptions({ bogus: 1 }), /unknown option/);
  assert.throws(() => out.makeSbsMaterial({}), /needs the engine/);
  out.remove();
});

test('handle: addSplat displayRigLayers sugar, and the nolayerrig kill switch', (t) => {
  installDom();
  t.mock.method(console, 'info', () => {});
  const pc = { createGraphicsDevice: () => new Promise(() => {}) };
  const a = {};
  attachPlayCanvasSplat(a, null, makeCanvas(320, 180), 'x.sog', { playcanvas: pc, displayRigLayers: { layers: ['Stage', 7], gain: 2, planeOffset: 0.01 } }, []);
  assert.deepEqual(a.layerRigState().display, ['Stage', 7]);
  assert.equal(a.viewer.layerRigs.opts.gain, 2);
  assert.equal(a.viewer.layerRigs.opts.planeOffset, 0.01);
  a.remove();
  const b = {};
  attachPlayCanvasSplat(b, null, makeCanvas(320, 180), 'x.sog', { playcanvas: pc, displayRigLayers: ['Stage'], diag: 'nolayerrig,nooverlay' }, []);
  assert.equal(b.layerRigState().disabled, true, 'recorded, never applied');
  assert.match(b.layerRigState().reason, /kill switch/);
  b.remove();
  assert.throws(() => attachPlayCanvasSplat({}, null, makeCanvas(320, 180), 'x.sog', { playcanvas: pc, displayRigLayers: 'Stage' }, []), /displayRigLayers/);
});

test('handle: setRenderScale changes the buffer scale live, schedules one resize, validates, and chains', () => {
  installDom();
  const pc = { createGraphicsDevice: () => new Promise(() => {}) };
  const out = {};
  attachPlayCanvasSplat(out, null, makeCanvas(320, 180), 'x.sog', { playcanvas: pc, renderScale: 0.6 }, []);
  assert.equal(out.renderScale, 0.6);
  let resizes = 0;
  const orig = out.viewer._scheduleResize.bind(out.viewer);
  out.viewer._scheduleResize = () => { resizes++; orig(); };
  assert.equal(out.setRenderScale(1), out);
  assert.equal(out.renderScale, 1, 'the accessor is live, not a copy');
  assert.equal(out.viewer.renderScale, 1);
  assert.equal(resizes, 1);
  out.setRenderScale(1);
  assert.equal(resizes, 1, 'no resize when nothing changed');
  for (const bad of [0, -1, 5, NaN, '1', null]) assert.throws(() => out.setRenderScale(bad), RangeError);
  assert.equal(out.renderScale, 1);
  out.remove();
});

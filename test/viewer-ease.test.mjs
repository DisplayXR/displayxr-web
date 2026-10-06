// The tracking ease (./js/inline3d-viewer-ease.js): when the views jump between the runtime's
// nominal viewer and the tracked eyes, the eye cameras glide instead of snapping.
//
// What is pinned: the snap is gone (the first frame after the jump draws what was drawn before,
// the weight falls monotonically to 0 by `durationMs`), the eased views are EXACT window-relative
// frusta for the eased eye (so a rig locate still matches), the triggers (state edge, state edge a
// frame BEFORE the jump, the jump test where no state is reported), the non-triggers (ordinary
// head motion, a vendor-animated ramp, a view-count change), the off switch, and that SceneViewer
// draws the eased matrices.

import test from 'node:test';
import assert from 'node:assert/strict';

import { ViewerEase, resolveViewerEaseOption, frameTrackingState, VIEWER_EASE_DEFAULT_MS } from '../js/inline3d-viewer-ease.js';
import { installDom, makeCanvas, makeTHREE, makeLayer } from './stubs.mjs';

// ── a window-relative Kooima view, as the runtime builds it (display rig, metres) ──────────

const W = 0.3; // window width, m
const H = 0.2;
const NEAR = 0.05;
const FAR = 100;

/** Column-major off-axis projection for an eye at E relative to the window centre (window in z=0). */
function kooimaProj(E) {
  const [ex, ey, ez] = E;
  const l = ((-W / 2 - ex) * NEAR) / ez;
  const r = ((W / 2 - ex) * NEAR) / ez;
  const b = ((-H / 2 - ey) * NEAR) / ez;
  const t = ((H / 2 - ey) * NEAR) / ez;
  const P = new Float32Array(16);
  P[0] = (2 * NEAR) / (r - l);
  P[5] = (2 * NEAR) / (t - b);
  P[8] = (r + l) / (r - l);
  P[9] = (t + b) / (t - b);
  P[10] = -(FAR + NEAR) / (FAR - NEAR);
  P[11] = -1;
  P[14] = (-2 * FAR * NEAR) / (FAR - NEAR);
  return P;
}

/** A pose at E with rotation q about +y by `yaw` radians (rig orientation), column-major. */
function pose(E, yaw = 0) {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const M = new Float32Array(16);
  M[0] = c; M[2] = -s;
  M[5] = 1;
  M[8] = s; M[10] = c;
  M[12] = E[0]; M[13] = E[1]; M[14] = E[2];
  M[15] = 1;
  return M;
}

const IPD = 0.064;
const NOMINAL = [0, 0, 0.6];
const TRACKED = [0.09, 0.04, 0.48]; // a viewer 9 cm right, 4 cm up, 12 cm closer than nominal

/** Two entries (left, right) for a head centre C, as the renderers hold them. */
function entries(C, { ipd = IPD, yaw = 0 } = {}) {
  return [-1, 1].map((sgn) => {
    const E = [C[0] + (sgn * ipd) / 2, C[1], C[2]];
    // The rig rotation moves the pose; the projection is display-space and does not rotate.
    const R = pose([0, 0, 0], yaw);
    const Ew = [R[0] * E[0] + R[8] * E[2], E[1], R[2] * E[0] + R[10] * E[2]];
    return { proj: kooimaProj(E), pose: pose(Ew, yaw), _eye: E };
  });
}

const headOf = (es) => [(es[0].pose[12] + es[1].pose[12]) / 2, (es[0].pose[13] + es[1].pose[13]) / 2, (es[0].pose[14] + es[1].pose[14]) / 2];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const lerp = (a, b, w) => a.map((v, i) => v + (b[i] - v) * w);

/** Drive an ease with a clock; returns { ease, step(C, state, dt) -> { es, w } }. */
function rig(opts = {}) {
  let t = 1000;
  const ease = new ViewerEase({ clock: () => t, ...opts });
  return {
    ease,
    step(C, state, dt = 1000 / 60, eopts) {
      t += dt;
      const es = entries(C, eopts);
      const w = ease.apply(es, state);
      return { es, w };
    },
    get t() {
      return t;
    },
  };
}

// ── the snap, and its removal ────────────────────────────────────────────────────────────

test('acquisition: the first tracked frame draws what was drawn before, then glides onto the viewer', () => {
  const r = rig();
  for (let i = 0; i < 10; i++) r.step(NOMINAL, 'searching');
  const first = r.step(TRACKED, 'tracking');
  assert.equal(first.w, 1, 'weight 1 on the jump frame');
  assert.ok(dist(headOf(first.es), NOMINAL) < 1e-6, 'drawn head is still the nominal one');
  let prevW = 1;
  let frames = 0;
  while (r.ease.active) {
    const { w, es } = r.step(TRACKED, 'tracking');
    assert.ok(w <= prevW + 1e-12, 'weight never rises');
    // Never overshoots, never leaves the segment nominal -> tracked.
    const h = headOf(es);
    const along = dist(h, NOMINAL) / dist(TRACKED, NOMINAL);
    assert.ok(along >= -1e-6 && along <= 1 + 1e-6, `left the path: ${along}`);
    prevW = w;
    frames++;
    assert.ok(frames < 100);
  }
  // 300 ms at 60 fps: ~18 frames.
  assert.ok(frames >= 15 && frames <= 20, `ease lasted ${frames} frames`);
  const after = r.step(TRACKED, 'tracking');
  assert.equal(after.w, 0);
  assert.ok(dist(headOf(after.es), TRACKED) < 1e-6, 'lands exactly on the tracked viewer');
});

test('the biggest per-frame move during the ease is a small fraction of the snap', () => {
  const r = rig();
  for (let i = 0; i < 5; i++) r.step(NOMINAL, 'searching');
  let prev = NOMINAL;
  let maxStep = 0;
  for (let i = 0; i < 40; i++) {
    const { es } = r.step(TRACKED, 'tracking');
    const h = headOf(es);
    maxStep = Math.max(maxStep, dist(h, prev));
    prev = h;
  }
  const snap = dist(TRACKED, NOMINAL);
  assert.ok(maxStep < snap * 0.1, `largest step ${(maxStep * 1000).toFixed(1)} mm vs snap ${(snap * 1000).toFixed(1)} mm`);
});

test('the eased view is the EXACT frustum of the eased eye (pose and projection agree)', () => {
  const r = rig();
  for (let i = 0; i < 5; i++) r.step(NOMINAL, 'searching');
  for (let i = 0; i < 8; i++) {
    const { es, w } = r.step(TRACKED, 'tracking');
    for (let k = 0; k < 2; k++) {
      const E = [es[k].pose[12], es[k].pose[13], es[k].pose[14]];
      const want = kooimaProj(E);
      for (const idx of [0, 5, 8, 9, 10, 14]) {
        assert.ok(Math.abs(es[k].proj[idx] - want[idx]) < 2e-5, `eye ${k} P[${idx}] ${es[k].proj[idx]} vs ${want[idx]} (w=${w.toFixed(3)})`);
      }
    }
  }
});

test('the viewer keeps moving during the ease and the ease follows (no lag once it ends)', () => {
  const r = rig();
  for (let i = 0; i < 5; i++) r.step(NOMINAL, 'searching');
  let C = TRACKED.slice();
  let last;
  for (let i = 0; i < 40; i++) {
    C = [C[0] + 0.001, C[1], C[2]]; // 6 cm/s sideways
    last = r.step(C, 'tracking');
  }
  assert.equal(last.w, 0);
  assert.ok(dist(headOf(last.es), C) < 1e-6);
});

test('loss: tracked -> nominal glides back the same way', () => {
  const r = rig();
  for (let i = 0; i < 5; i++) r.step(TRACKED, 'tracking');
  const first = r.step(NOMINAL, 'searching');
  assert.equal(first.w, 1);
  assert.ok(dist(headOf(first.es), TRACKED) < 1e-6);
  for (let i = 0; i < 30; i++) r.step(NOMINAL, 'searching');
  assert.equal(r.ease.active, false);
});

// ── triggers ──────────────────────────────────────────────────────────────────────────────

test('state edge a frame BEFORE the jump (the browser updates the state first): still no snap', () => {
  const r = rig();
  for (let i = 0; i < 5; i++) r.step(NOMINAL, 'searching');
  r.step(NOMINAL, 'tracking'); // edge, views not moved yet
  const jump = r.step(TRACKED, 'tracking');
  assert.equal(jump.w, 1, 'the armed jump restarts the ease from what was drawn');
  assert.equal(r.ease.last.reason, 'armed-jump');
  assert.ok(dist(headOf(jump.es), NOMINAL) < 1e-6);
});

test('no state reported (older browser): a jump of more than half an eye separation triggers', () => {
  const r = rig();
  for (let i = 0; i < 5; i++) r.step(NOMINAL, null);
  const j = r.step(TRACKED, null);
  assert.equal(j.w, 1);
  assert.equal(r.ease.last.reason, 'jump');
});

test('ordinary head motion never triggers (even fast: 0.6 m/s at 60 fps)', () => {
  for (const state of ['tracking', null, 'unknown']) {
    const r = rig();
    let C = NOMINAL.slice();
    for (let i = 0; i < 120; i++) {
      C = [C[0] + 0.01 * Math.sin(i / 7), C[1] + 0.004, C[2]];
      const { w } = r.step(C, state);
      assert.equal(w, 0, `triggered at frame ${i} (${state})`);
    }
  }
});

test('a vendor-animated acquisition (eyes ramped over 1 s) is left alone', () => {
  const r = rig();
  // The vendor's untracked pose: both eyes collapsed onto one point.
  const target = [0, 0.1, 0.6];
  for (let i = 0; i < 5; i++) r.step(target, 'searching', undefined, { ipd: 0 });
  let maxDev = 0;
  for (let i = 1; i <= 60; i++) {
    const w = i / 60;
    const C = lerp(target, TRACKED, w);
    const ipd = IPD * w;
    const state = ipd > 0.001 ? 'tracking' : 'searching';
    const { es } = r.step(C, state, undefined, { ipd });
    maxDev = Math.max(maxDev, dist(headOf(es), C));
  }
  assert.equal(maxDev < 1e-6, true, `deviation from the vendor ramp ${(maxDev * 1000).toFixed(3)} mm`);
});

test('a view-count change (2D <-> 3D mode switch) resets instead of easing', () => {
  const r = rig();
  for (let i = 0; i < 5; i++) r.step(NOMINAL, 'searching');
  // one view (mono)
  r.ease.apply([{ proj: kooimaProj(NOMINAL), pose: pose(NOMINAL) }], 'searching');
  const back = r.step(TRACKED, 'tracking');
  assert.equal(back.w, 0, 'nothing to ease from across a view-count change');
});

test('the offset rides the rig: a rig rotating during the ease carries it along', () => {
  const r = rig();
  for (let i = 0; i < 5; i++) r.step(NOMINAL, 'searching');
  const r2 = rig();
  for (let i = 0; i < 5; i++) r2.step(NOMINAL, 'searching');
  for (let i = 0; i < 10; i++) {
    const yaw = 0.02 * i;
    const a = r.step(TRACKED, 'tracking', undefined, { yaw: 0 });
    const b = r2.step(TRACKED, 'tracking', undefined, { yaw });
    // b's eased eye, rotated back by yaw, must equal a's eased eye.
    for (let k = 0; k < 2; k++) {
      const c = Math.cos(-yaw);
      const s = Math.sin(-yaw);
      const P = b.es[k].pose;
      const back = [c * P[12] + s * P[14], P[13], -s * P[12] + c * P[14]];
      const want = [a.es[k].pose[12], a.es[k].pose[13], a.es[k].pose[14]];
      assert.ok(dist(back, want) < 1e-6, `frame ${i} eye ${k}`);
    }
  }
});

// ── options ───────────────────────────────────────────────────────────────────────────────

test('viewerEase:false (and durationMs:0) pass every frame through untouched', () => {
  for (const opt of [false, { enabled: false }, { durationMs: 0 }]) {
    const r = rig(opt === false ? { enabled: false } : opt);
    for (let i = 0; i < 5; i++) r.step(NOMINAL, 'searching');
    const j = r.step(TRACKED, 'tracking');
    assert.equal(j.w, 0);
    assert.ok(dist(headOf(j.es), TRACKED) < 1e-6);
  }
});

test('resolveViewerEaseOption: defaults, overrides, spellings', () => {
  assert.deepEqual(resolveViewerEaseOption(), { enabled: true, durationMs: VIEWER_EASE_DEFAULT_MS, easing: 'smoothstep' });
  assert.deepEqual(resolveViewerEaseOption(false), { enabled: false, durationMs: 300, easing: 'smoothstep' });
  assert.deepEqual(resolveViewerEaseOption({ durationMs: 400, easing: 'ease-out-cubic' }), { enabled: true, durationMs: 400, easing: 'easeoutcubic' });
  assert.equal(resolveViewerEaseOption({ easing: 'bogus' }).easing, 'smoothstep');
});

test('frameTrackingState reads frame.session.trackingState, null when absent', () => {
  assert.equal(frameTrackingState({ session: { trackingState: 'tracking' } }), 'tracking');
  assert.equal(frameTrackingState({ session: {} }), null);
  assert.equal(frameTrackingState(undefined), null);
});

// ── SceneViewer draws the eased matrices ──────────────────────────────────────────────────

test('SceneViewer: the camera on the jump frame is the previous one; the frame state drives it', async () => {
  installDom();
  const { SceneViewer } = await import('../js/inline3d-viewer.js');
  const { EyeCamera } = await import('../js/inline3d-three.js');
  const { THREE, log } = makeTHREE();
  // The stub logs the camera by reference (one camera serves both eyes): snapshot at draw time.
  const realRender = THREE.WebGLRenderer.prototype.render;
  THREE.WebGLRenderer.prototype.render = function (scene, camera) {
    realRender.call(this, scene, { projectionMatrix: { elements: Array.from(camera.projectionMatrix.elements) } });
  };
  const canvas = makeCanvas(300, 200);
  const viewer = new SceneViewer(THREE, canvas, { orbit: false });
  viewer.useEyeCamera(EyeCamera);
  const layer = makeLayer(canvas);
  const asViews = (es) => es.map((e, i) => ({ eye: i ? 'right' : 'left', projectionMatrix: e.proj, transform: { matrix: e.pose } }));
  const frame = (state) => ({ session: { trackingState: state } });
  for (let i = 0; i < 3; i++) viewer.onFrame(asViews(entries(NOMINAL)), layer, frame('searching'));
  log.render.length = 0;
  viewer.onFrame(asViews(entries(TRACKED)), layer, frame('tracking'));
  const drawn = log.render.map((r) => Array.from(r.camera.projectionMatrix.elements));
  const nominal = entries(NOMINAL).map((e) => Array.from(e.proj));
  for (let k = 0; k < 2; k++) for (let j = 0; j < 16; j++) assert.ok(Math.abs(drawn[k][j] - nominal[k][j]) < 1e-5);
  assert.equal(viewer.viewerEase.last.reason, 'armed-jump');

  // Opted out per viewer: the snap is back.
  const v2 = new SceneViewer(THREE, makeCanvas(300, 200), { orbit: false, viewerEase: false });
  v2.useEyeCamera(EyeCamera);
  const layer2 = makeLayer(v2.canvas);
  for (let i = 0; i < 3; i++) v2.onFrame(asViews(entries(NOMINAL)), layer2, frame('searching'));
  log.render.length = 0;
  v2.onFrame(asViews(entries(TRACKED)), layer2, frame('tracking'));
  const tracked = entries(TRACKED).map((e) => Array.from(e.proj));
  const d2 = log.render.map((r) => Array.from(r.camera.projectionMatrix.elements));
  for (let k = 0; k < 2; k++) for (let j = 0; j < 16; j++) assert.ok(Math.abs(d2[k][j] - tracked[k][j]) < 1e-5);
});

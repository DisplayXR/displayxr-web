// Tests for the depth measurements (js/inline3d-depth-budget.js) and the opt-in helpers next to
// them: `clearColor`, `./model`'s setStereo, and the one-time rig warnings.
//
// The product rule these pin as much as the arithmetic: the SDK never clamps, refuses or
// silently overrides what a page asked for. So every opt-in is tested twice — ON, it does what it
// says; ABSENT, the result is bit-identical to a viewer that never heard of it.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installDom, makeCanvas, makeTHREE } from './stubs.mjs';

installDom();
const {
  disparityPct,
  cameraRigDisparityPct,
  depthBudgetFromBounds,
  viewRigWarnings,
  warnViewRigOnce,
  withheldReasonHint,
} = await import('../js/inline3d-depth-budget.js');
const { SceneViewer } = await import('../js/inline3d-viewer.js');
const { PlayCanvasSplatViewer } = await import('../js/inline3d-splat-playcanvas.js');
const { parseClearColor, validateSetStereo, attachModelStereo } = await import('../js/inline3d-splat-shared.js');
const { displayRig, cameraRigFromPose } = await import('../js/inline3d-three.js');

const near = (a, b, eps = 1e-9, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} !~= ${b}`);

function withWarnings(fn) {
  const warns = [];
  const real = console.warn;
  console.warn = (...a) => warns.push(a.map(String).join(' '));
  try {
    fn();
  } finally {
    console.warn = real;
  }
  return warns;
}

// ── 1. the pure helpers ──────────────────────────────────────────────────────────────────────

test('disparityPct: 0.1 h in front ≈ 0.6 %, 0.27 h behind ≈ 1.5 % on a 16:9 tile at 0.6 m', () => {
  const aspect = 16 / 9;
  // Small-depth limit (no physical height): 100 · e · depthH / (aspect · V).
  near(disparityPct({ depthH: 0.1, aspect }), (-100 * 0.063 * 0.1) / (aspect * 0.6), 1e-12);
  near(Math.abs(disparityPct({ depthH: 0.1, aspect })), 0.6, 0.02, 'comfortable front');
  near(Math.abs(disparityPct({ depthH: 0.18, aspect })), 1.1, 0.05, 'strong front');
  near(disparityPct({ depthH: -0.27, aspect }), 1.5, 0.1, 'comfortable behind');
  // Signs: in front is crossed (negative), behind uncrossed (positive), the glass is 0.
  assert.ok(disparityPct({ depthH: 0.1, aspect }) < 0);
  assert.ok(disparityPct({ depthH: -0.1, aspect }) > 0);
  assert.equal(disparityPct({ depthH: 0, aspect }), 0);
});

test('disparityPct: the exact form with a physical height, ipdFactor, the viewer, bad input', () => {
  const aspect = 1.5;
  const h = 0.2;
  // e·z/(V − z) over the tile width aspect·h, z = depthH·h.
  const z = 0.1 * h;
  near(disparityPct({ depthH: 0.1, aspect, heightM: h }), (-100 * ((0.063 * z) / (0.6 - z))) / (aspect * h), 1e-12);
  const zb = 0.3 * h;
  near(disparityPct({ depthH: -0.3, aspect, heightM: h }), (100 * ((0.063 * zb) / (0.6 + zb))) / (aspect * h), 1e-12);
  // In front grows faster than linear, behind slower.
  assert.ok(Math.abs(disparityPct({ depthH: 0.3, aspect, heightM: h })) > Math.abs(disparityPct({ depthH: 0.3, aspect })));
  assert.ok(disparityPct({ depthH: -0.3, aspect, heightM: h }) < disparityPct({ depthH: -0.3, aspect }));
  // Disparity is linear in the rig's eye separation; a nearer viewer sees more of it.
  near(disparityPct({ depthH: 0.1, aspect, ipdFactor: 0.5 }), 0.5 * disparityPct({ depthH: 0.1, aspect }), 1e-12);
  assert.ok(Math.abs(disparityPct({ depthH: 0.1, aspect, viewerM: 0.4 })) > Math.abs(disparityPct({ depthH: 0.1, aspect })));
  // At or past the viewer: unbounded, not a wrapped sign.
  assert.equal(disparityPct({ depthH: 5, aspect, heightM: 0.2, viewerM: 0.6 }), -Infinity);
  assert.ok(Number.isNaN(disparityPct({ depthH: 0.1, aspect: 0 })));
  assert.ok(Number.isNaN(disparityPct({ depthH: NaN, aspect: 1 })));
});

test('cameraRigDisparityPct: 100·b·(1/D − 1/z)/(2·tan(fov/2)·aspect), + behind, − in front, 0 on the plane', () => {
  const o = { convergence: 2, ipdFactor: 1, metersToVirtual: 1, verticalFov: 0.8, aspect: 1.6 };
  const k = (100 * 0.063) / (2 * Math.tan(0.4) * 1.6);
  near(cameraRigDisparityPct({ ...o, z: 4 }), k * (1 / 2 - 1 / 4), 1e-12);
  assert.ok(cameraRigDisparityPct({ ...o, z: 4 }) > 0, 'behind the convergence = behind the glass');
  assert.ok(cameraRigDisparityPct({ ...o, z: 1 }) < 0, 'nearer = in front');
  near(cameraRigDisparityPct({ ...o, z: 2 }), 0, 1e-15);
  // The baseline: ipdFactor × metersToVirtual × 63 mm.
  near(cameraRigDisparityPct({ ...o, z: 4, ipdFactor: 2, metersToVirtual: 0.5 }), cameraRigDisparityPct({ ...o, z: 4 }), 1e-12);
  // Diopters as the descriptor carries them win over a distance.
  near(cameraRigDisparityPct({ ...o, z: 4, convergence: 9, convergenceDiopters: 0.5 }), cameraRigDisparityPct({ ...o, z: 4 }), 1e-12);
  // Convergence 0 = infinity: everything is in front.
  assert.ok(cameraRigDisparityPct({ ...o, convergence: 0, z: 1000 }) < 0);
  near(cameraRigDisparityPct({ ...o, convergence: 0, z: 1 }), -k, 1e-12);
  assert.ok(Number.isNaN(cameraRigDisparityPct({ ...o, z: 1, verticalFov: undefined })));
});

test('depthBudgetFromBounds', () => {
  // A box from getSubjectBounds: vH 0.2, front at +0.02 (0.1 h), back at −0.054 (0.27 h).
  const r = depthBudgetFromBounds({ front: 0.02, back: -0.054, virtualDisplayHeight: 0.2, aspect: 16 / 9 });
  near(r.frontH, 0.1, 1e-12);
  near(r.backH, 0.27, 1e-12);
  near(r.frontPct, Math.abs(disparityPct({ depthH: 0.1, aspect: 16 / 9 })), 1e-12);
  near(r.backPct, disparityPct({ depthH: -0.27, aspect: 16 / 9 }), 1e-12);
  assert.ok(r.frontPct >= 0 && r.backPct >= 0, 'magnitudes');
  assert.deepEqual(r.basis, { rig: 'display', aspect: 16 / 9, viewerM: 0.6, heightM: null, ipdFactor: 1, eyeSeparationM: 0.063 });
  // Entirely behind the glass: nothing in front.
  const b = depthBudgetFromBounds({ front: -0.01, back: -0.03, virtualDisplayHeight: 0.2, aspect: 1 });
  assert.equal(b.frontH, 0);
  assert.equal(b.frontPct, 0);
  near(b.backH, 0.15, 1e-12);
});

// ── 3. clearColor ────────────────────────────────────────────────────────────────────────────

test('parseClearColor: arrays, hex, rgb()/rgba(), transparent; absent = null; unreadable warns and is null', () => {
  assert.equal(parseClearColor(undefined), null);
  assert.equal(parseClearColor(null), null);
  assert.deepEqual(parseClearColor([0.1, 0.2, 0.3]), [0.1, 0.2, 0.3, 1]);
  assert.deepEqual(parseClearColor([0.1, 0.2, 0.3, 0.5]), [0.1, 0.2, 0.3, 0.5]);
  assert.deepEqual(parseClearColor([2, -1, 0.5, 1]), [1, 0, 0.5, 1]);
  assert.deepEqual(parseClearColor('#fff'), [1, 1, 1, 1]);
  assert.deepEqual(parseClearColor('#00000080'), [0, 0, 0, 128 / 255]);
  assert.deepEqual(parseClearColor('#336699'), [0x33 / 255, 0x66 / 255, 0x99 / 255, 1]);
  assert.deepEqual(parseClearColor('rgb(255, 0, 51)'), [1, 0, 51 / 255, 1]);
  assert.deepEqual(parseClearColor('rgba(0,0,0,0.25)'), [0, 0, 0, 0.25]);
  assert.deepEqual(parseClearColor('rgb(0 0 0 / 50%)'), [0, 0, 0, 0.5]);
  assert.deepEqual(parseClearColor('transparent'), [0, 0, 0, 0]);
  let r;
  const warns = withWarnings(() => (r = parseClearColor('rebeccapurple-ish')));
  assert.equal(r, null);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /clearColor/);
});

/** A THREE stub whose renderer records every setClearColor. */
function recordingTHREE() {
  const { THREE, log } = makeTHREE();
  log.clearColor = [];
  class R extends THREE.WebGLRenderer {
    setClearColor(c, a) {
      log.clearColor.push([c, a]);
    }
  }
  return { THREE: { ...THREE, WebGLRenderer: R }, log };
}

test('SceneViewer clearColor: absent = the one transparent clear as before; given = the opaque clear after it', () => {
  const a = recordingTHREE();
  new SceneViewer(a.THREE, makeCanvas(), { orbit: false });
  assert.deepEqual(a.log.clearColor, [[0x000000, 0]]);
  const b = recordingTHREE();
  const v = new SceneViewer(b.THREE, makeCanvas(), { orbit: false, clearColor: '#102030' });
  assert.deepEqual(b.log.clearColor, [[0x000000, 0], [0x102030, 1]]);
  assert.deepEqual(v.clearColor, [0x10 / 255, 0x20 / 255, 0x30 / 255, 1]);
  const c = recordingTHREE();
  new SceneViewer(c.THREE, makeCanvas(), { orbit: false, clearColor: [1, 1, 1, 1] });
  assert.deepEqual(c.log.clearColor.at(-1), [0xffffff, 1]);
});

test('PlayCanvasSplatViewer clearColor reaches the eye camera; absent = (0,0,0,0)', () => {
  class Color {
    constructor(r, g, b, a) {
      Object.assign(this, { r, g, b, a });
    }
  }
  const made = [];
  const pc = {
    Color,
    LAYERID_SKYBOX: 2,
    Entity: class {
      constructor(name) {
        this.name = name;
      }
      addComponent(type, data) {
        this.camera = { layers: [0, 1, 2], ...data, camera: {} };
        made.push(data);
      }
    },
  };
  for (const [opt, want] of [
    [undefined, { r: 0, g: 0, b: 0, a: 0 }],
    [[0, 0.5, 1, 1], { r: 0, g: 0.5, b: 1, a: 1 }],
  ]) {
    const v = new PlayCanvasSplatViewer(makeCanvas(), { orbit: false, clearColor: opt });
    v.pc = pc;
    v.app = {};
    v.rigNode = { addChild() {} };
    v._makeCamera('x', null);
    assert.deepEqual({ ...made.at(-1).clearColor }, want);
    v.pc = null;
    v.app = null;
    v.rigNode = null;
    v.dispose();
  }
});

// ── 5. ./model setStereo ─────────────────────────────────────────────────────────────────────

test('attachModelStereo: nothing declared until called; relative display-rig factors; null restores the plain rig', () => {
  const rigs = [];
  const tile = { setViewRig: (r) => rigs.push(JSON.parse(JSON.stringify(r))) };
  const out = {};
  attachModelStereo(out, { getTile: () => tile, vH: 0.3, makeDisplayRig: displayRig });
  assert.deepEqual(out.rig, { type: 'display', ipdFactor: 1, parallaxFactor: 1, stereoDefault: { ipdFactor: 1, parallaxFactor: 1 } });
  assert.equal(rigs.length, 0, 'a page that never calls it declares nothing new');
  assert.equal(out.setStereo({ ipdFactor: 0.5 }), out);
  assert.equal(out.rig.ipdFactor, 0.5);
  assert.deepEqual(rigs.at(-1), displayRig({ virtualDisplayHeight: 0.3, ipdFactor: 0.5, parallaxFactor: 1 }));
  out.setStereo({ parallaxScale: 0.25 }); // sticky: ipd stays
  assert.deepEqual([out.rig.ipdFactor, out.rig.parallaxFactor], [0.5, 0.25]);
  out.setStereo({ ipdFactor: null });
  assert.deepEqual([out.rig.ipdFactor, out.rig.parallaxFactor], [1, 0.25]);
  out.setStereo(null);
  assert.deepEqual(rigs.at(-1), displayRig({ virtualDisplayHeight: 0.3 }), 'the exact equivalent of the shorthand');
  assert.throws(() => out.setStereo({ ipdFactor: -1 }), /@displayxr\/inline3d\/model: setStereo — ipdFactor/);
  assert.throws(() => out.setStereo({ depth: 1 }), /unknown option/);
  // controls:'page' declares its own rig; this only records the values.
  const p = {};
  const prigs = [];
  attachModelStereo(p, { getTile: () => ({ setViewRig: (r) => prigs.push(r) }), vH: 0.24, makeDisplayRig: displayRig, page: true });
  p.setStereo({ ipdFactor: 0.3 });
  assert.equal(p.rig.type, 'camera');
  assert.equal(p.rig.ipdFactor, 0.3);
  assert.equal(prigs.length, 0);
});

test('validateSetStereo is the splat one, tagged per subpath', () => {
  assert.deepEqual(validateSetStereo({ ipdFactor: 0.4 }, null), { ipdFactor: 0.4 });
  assert.throws(() => validateSetStereo({ ipdFactor: 1, ipdScale: 1 }, null), /@displayxr\/inline3d\/splat: setStereo — ipdFactor and ipdScale are exclusive/);
  assert.throws(() => validateSetStereo('x', null, '@displayxr/inline3d/model'), /@displayxr\/inline3d\/model: setStereo takes/);
});

// ── 6. warnings (read only) ──────────────────────────────────────────────────────────────────

test('viewRigWarnings: convergence 0 / unset, verticalFov in degrees, display factors above 1; clean rigs say nothing', () => {
  const keys = (r) => viewRigWarnings(r).map((w) => w[0]);
  assert.deepEqual(keys({ type: 'camera', convergenceDiopters: 0, verticalFov: 0.8 }), ['convergence']);
  assert.deepEqual(keys({ type: 'camera', verticalFov: 0.8 }), ['convergence']);
  assert.deepEqual(keys({ type: 'camera', convergenceDiopters: 0.5, verticalFov: 45 }), ['fov']);
  assert.deepEqual(keys({ type: 'camera', convergenceDiopters: 0.5, verticalFov: 0.8 }), []);
  assert.deepEqual(keys({ type: 'display', ipdFactor: 1.5 }), ['factor']);
  assert.deepEqual(keys({ type: 'display', parallaxFactor: 2 }), ['factor']);
  assert.deepEqual(keys({ type: 'display', ipdFactor: 1, parallaxFactor: 0.5 }), []);
  assert.deepEqual(keys({ virtualDisplayHeight: 0.3 }), [], 'an untyped rig is a display rig');
  assert.match(viewRigWarnings({ type: 'camera', verticalFov: 0.8 })[0][1], /^\[inline3d\] .*convergence at infinity puts the whole scene in front of the glass; set convergence to the subject's distance/);
});

test('warnViewRigOnce: each kind once per set, the rig object untouched', () => {
  const seen = new Set();
  const rig = Object.freeze({ type: 'camera', convergenceDiopters: 0, verticalFov: 60 });
  const warns = withWarnings(() => {
    for (let i = 0; i < 10; i++) warnViewRigOnce(seen, rig);
  });
  assert.equal(warns.length, 2, 'convergence + fov, once each');
  assert.equal(withWarnings(() => warnViewRigOnce(new Set(), { type: 'display', ipdFactor: 1 })).length, 0);
});

test('a rig builder left at convergence 0 warns once per page, and setViewRig does not repeat it for that descriptor', () => {
  // The builder's "once per page" latch is module state; node --test runs each file in its own
  // process and nothing above builds a camera rig, so this is the page's first.
  const seen = new Set();
  let rig;
  const warns = withWarnings(() => {
    rig = cameraRigFromPose({ position: { x: 0, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 }, fov: 40 });
    cameraRigFromPose({ position: { x: 0, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 }, fov: 40 }, { out: rig });
    warnViewRigOnce(seen, rig);
  });
  assert.equal(rig.convergenceDiopters, 0, 'built as asked');
  assert.equal(warns.length, 1, warns.join('\n'));
  assert.ok(seen.has('convergence'), 'the handle still records it as said');
  // A converged rig: silent.
  assert.equal(withWarnings(() => cameraRigFromPose({ position: { x: 0, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 }, fov: 40 }, { convergence: 2 })).length, 0);
});

test('withheldReasonHint names the CSS causes for the render-surface reasons', () => {
  assert.match(withheldReasonHint('cross-pass:mono'), /filter, opacity < 1.*backdrop-filter.*rule 7/);
  assert.match(withheldReasonHint('cross-pass:mono(cover,2:1)'), /rule 7/);
  assert.match(withheldReasonHint('no-quad'), /filter, opacity < 1/);
  assert.match(withheldReasonHint('no-identity'), /rules 3-5/);
  assert.match(withheldReasonHint('something-new'), /woven-canvas-rules/);
});

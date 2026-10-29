// Comfort depth: the pure zone helpers (js/inline3d-depth-budget.js) and the opt-in `depth` option's
// shared plumbing (js/inline3d-splat-shared.js: resolveDepthOption, attachComfortDepth,
// framedSubjectBounds, attachModelStereo's base factor). The engines' end-to-end cases live next to
// their own fakes: test/model-playcanvas.test.mjs and test/splat-playcanvas.test.mjs.
//
// The product rule: the display-rig factor only ever LOWERS depth, and without the option nothing
// is measured or declared. The camera-rig factor is a measurement with no cap.

import test from 'node:test';
import assert from 'node:assert/strict';

const { comfortZone, comfortDepthFactor, cameraRigComfortFactor, cameraRigDisparityPct } = await import('../js/inline3d-depth-budget.js');
const { resolveDepthOption, attachComfortDepth, attachModelStereo, framedSubjectBounds } = await import('../js/inline3d-splat-shared.js');
const { displayRig } = await import('../js/inline3d-three.js');
const root = await import('../js/inline3d.js');
const three = await import('../js/inline3d-three.js');

const near = (a, b, eps = 1e-9, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} !~= ${b}`);
const tick = () => new Promise((r) => setTimeout(r, 0));

// ── 1. comfortZone ───────────────────────────────────────────────────────────────────────────

test('comfortZone at 0.6 m: Percival ±1/3 D, Shibata ≈ 0.571 D front / 0.633 D behind; mm = e·V·ΔD', () => {
  const p = comfortZone({ viewerM: 0.6, zone: 'percival' });
  near(p.frontD, 1 / 3);
  near(p.behindD, 1 / 3);
  near(p.frontMm, 0.063 * 0.6 * (1 / 3) * 1000);
  const s = comfortZone({ viewerM: 0.6 });
  assert.equal(s.zone, 'shibata', 'the default');
  near(s.frontD, 1 / 0.6 / 1.035 + 0.626 - 1 / 0.6);
  near(s.frontD, 0.5697, 1e-3);
  near(s.behindD, 0.6325, 1e-3);
  near(s.behindMm, 0.063 * 0.6 * s.behindD * 1000);
  const n = comfortZone({ viewerM: 0.5, zone: 0.2 });
  assert.deepEqual([n.frontD, n.behindD], [0.2, 0.2]);
});

test('comfortZone: Shibata behind is unbounded once the far limit is past infinity; bad input → NaN fields', () => {
  const far = comfortZone({ viewerM: 5 }); // Dv = 0.2: 0.2/1.129 − 0.442 < 0
  assert.equal(far.behindD, Infinity);
  assert.equal(far.behindMm, Infinity);
  assert.ok(far.frontD > 0);
  for (const o of [{ viewerM: 0 }, { viewerM: -1 }, { viewerM: NaN }, { zone: 'nope' }, { zone: 0 }, { zone: -0.3 }]) {
    const z = comfortZone(o);
    assert.ok(Number.isNaN(z.frontD) && Number.isNaN(z.behindD) && Number.isNaN(z.frontMm), JSON.stringify(o));
  }
});

// ── 2. comfortDepthFactor (display rig, ≤ 1) ─────────────────────────────────────────────────

test('comfortDepthFactor: a 15.6" laptop fits (1); an 11" tablet at 0.4 m needs ≈ 0.95; Percival on the laptop < 1', () => {
  const subject = { frontH: 0.5, backH: 1.0 };
  assert.equal(comfortDepthFactor({ ...subject, tileHeightM: 0.194, viewerM: 0.6, zone: 'shibata' }), 1);
  const tablet = comfortDepthFactor({ ...subject, tileHeightM: 0.148, viewerM: 0.4 });
  near(tablet, 0.954, 5e-3);
  // exact: front at z = V − frontH·H, |1/z − 1/V| against the zone's front
  const zf = 0.4 - 0.5 * 0.148;
  near(tablet, comfortZone({ viewerM: 0.4 }).frontD / (1 / zf - 1 / 0.4));
  const perc = comfortDepthFactor({ ...subject, tileHeightM: 0.194, viewerM: 0.6, zone: 'percival' });
  assert.ok(perc < 1 && perc > 0.7, String(perc));
  near(perc, (1 / 3) / (1 / 0.6 - 1 / (0.6 + 0.194)), 1e-12, 'the back side binds');
});

test('comfortDepthFactor never exceeds 1, and is 1 on missing / invalid input', () => {
  for (let i = 0; i < 200; i++) {
    const k = comfortDepthFactor({ frontH: Math.random() * 2, backH: Math.random() * 4, tileHeightM: 0.05 + Math.random() * 0.4, viewerM: 0.2 + Math.random(), zone: ['shibata', 'percival', 0.1][i % 3] });
    assert.ok(k > 0 && k <= 1, String(k));
  }
  assert.equal(comfortDepthFactor({ frontH: 0, backH: 0, tileHeightM: 0.2 }), 1, 'flat subject');
  assert.equal(comfortDepthFactor(), 1);
  assert.equal(comfortDepthFactor({ frontH: 0.5, backH: 1 }), 1, 'no height');
  assert.equal(comfortDepthFactor({ frontH: NaN, backH: 1, tileHeightM: 0.2 }), 1);
  assert.equal(comfortDepthFactor({ frontH: 0.5, backH: 1, tileHeightM: 0.2, viewerM: 0 }), 1);
  assert.equal(comfortDepthFactor({ frontH: 0.5, backH: 1, tileHeightM: 0.2, zone: 'x' }), 1);
  assert.equal(comfortDepthFactor({ frontH: 10, backH: 0, tileHeightM: 0.2, viewerM: 0.6 }), 1, 'front at/past the viewer: no finite answer');
});

// ── 3. cameraRigComfortFactor (camera rig, no cap) ───────────────────────────────────────────

const ROOM = { zNear: 1.5, zFar: 6, convergence: 2.5, verticalFov: (60 * Math.PI) / 180, aspect: 16 / 9, tileHeightM: 0.194, viewerM: 0.6 };

test('cameraRigComfortFactor: a metre-scale room — the binding side, from cameraRigDisparityPct converted to diopters', () => {
  const m = cameraRigComfortFactor(ROOM);
  const dD = (z) => ((cameraRigDisparityPct({ z, ...ROOM }) / 100) * ROOM.aspect * ROOM.tileHeightM) / (0.063 * ROOM.viewerM);
  const zone = comfortZone({ viewerM: 0.6 });
  near(m, Math.min(zone.frontD / -dD(ROOM.zNear), zone.behindD / dD(ROOM.zFar)), 1e-12);
  near(m, 7.63, 0.01, 'a real-sized room is nearly flat at ipdFactor 1 on a laptop');
  assert.ok(m > 1, 'no cap: the camera rig may want MORE eye separation');
  near(cameraRigComfortFactor({ ...ROOM, ipdFactor: 2 }), m / 2, 1e-12, 'relative to the ipdFactor given');
});

test('cameraRigComfortFactor scales with the scene units: ×0.01 world → 0.01 × m, ×100 world → 100 × m', () => {
  const m = cameraRigComfortFactor(ROOM);
  const scaled = (s) => cameraRigComfortFactor({ ...ROOM, zNear: ROOM.zNear * s, zFar: ROOM.zFar * s, convergence: ROOM.convergence * s });
  // b = 63 mm × metersToVirtual is fixed in scene units, so a smaller world sees MORE disparity.
  near(scaled(0.01), m * 0.01, 1e-9);
  near(scaled(100), m * 100, 1e-6);
  near(cameraRigComfortFactor({ ...ROOM, zNear: 150, zFar: 600, convergence: 250, metersToVirtual: 100 }), m, 1e-9, 'metersToVirtual undoes it');
});

test('cameraRigComfortFactor: zFar = Infinity, convergence 0 (= infinity), on-plane, bad input', () => {
  const inf = cameraRigComfortFactor({ ...ROOM, zFar: Infinity });
  assert.ok(inf > 0 && inf < cameraRigComfortFactor(ROOM), 'an infinite far side binds harder, still finite');
  // convergence 0: everything in front, so only the near point counts
  const c0 = cameraRigComfortFactor({ ...ROOM, convergence: 0 });
  const zone = comfortZone({ viewerM: 0.6 });
  const front = (0.063 * (1 / ROOM.zNear) * ROOM.tileHeightM) / (2 * Math.tan(ROOM.verticalFov / 2) * 0.063 * 0.6);
  near(c0, zone.frontD / front, 1e-12);
  assert.equal(cameraRigComfortFactor({ ...ROOM, convergence: undefined }), c0, 'unset = 0');
  assert.equal(cameraRigComfortFactor({ ...ROOM, convergence: 0, zFar: Infinity }), c0, 'at infinite convergence the far point is on the plane');
  near(cameraRigComfortFactor({ ...ROOM, convergence: undefined, convergenceDiopters: 0.4 }), cameraRigComfortFactor(ROOM), 1e-12);
  assert.equal(cameraRigComfortFactor({ ...ROOM, zNear: 2.5, zFar: 2.5 }), Infinity, 'all on the plane');
  for (const bad of [{ zNear: 0 }, { zFar: 1 }, { verticalFov: 0 }, { aspect: -1 }, { tileHeightM: 0 }, { zone: 'x' }, { ipdFactor: 0 }, { viewerM: 0 }]) {
    assert.ok(Number.isNaN(cameraRigComfortFactor({ ...ROOM, ...bad })), JSON.stringify(bad));
  }
});

test('the helpers are exported from the root and ./three', () => {
  for (const mod of [root, three]) {
    for (const k of ['comfortZone', 'comfortDepthFactor', 'cameraRigComfortFactor']) assert.equal(typeof mod[k], 'function', k);
  }
});

// ── 4. the option ────────────────────────────────────────────────────────────────────────────

test("resolveDepthOption: absent → null; 'auto' → Shibata; { zone }; anything else throws, tagged", () => {
  assert.equal(resolveDepthOption(undefined), null);
  assert.equal(resolveDepthOption(null), null);
  assert.deepEqual(resolveDepthOption('auto'), { zone: 'shibata' });
  assert.deepEqual(resolveDepthOption({}), { zone: 'shibata' });
  assert.deepEqual(resolveDepthOption({ zone: 'percival' }), { zone: 'percival' });
  assert.deepEqual(resolveDepthOption({ zone: 0.25 }), { zone: 0.25 });
  assert.throws(() => resolveDepthOption('on', '@displayxr/inline3d/model'), /@displayxr\/inline3d\/model: depth must be 'auto'/);
  assert.throws(() => resolveDepthOption(true), /depth must be/);
  assert.throws(() => resolveDepthOption({ zone: 'comfy' }), /depth.zone must be/);
  assert.throws(() => resolveDepthOption({ zone: 0 }), /depth.zone must be/);
  assert.throws(() => resolveDepthOption({ zone: 'shibata', max: 1 }), /unknown option\(s\) max/);
});

test('framedSubjectBounds: zoom and orbit are left out (the framed box at zoom 1)', () => {
  const v = { _fitScale: 0.1, _subjectHalf: [1, 2, 3], _depthOffset: 0.05, _zoom: 3, _yaw: 40 };
  const b = framedSubjectBounds(v);
  near(b.front, 0.35);
  near(b.back, -0.25);
  assert.equal(framedSubjectBounds({ _fitScale: 0, _subjectHalf: [1, 1, 1] }), null);
});

/** A core tile handle with displayMetrics / on / firstWoven, recording what it was told. */
function fakeTile({ heightM = 0.148, viewerM = 0.4, viewerSource = 'display' } = {}) {
  const t = {
    rigs: [],
    metricsCalls: 0,
    listeners: {},
    firstWoven: Promise.resolve({ woven: true }),
    setViewRig: (r) => t.rigs.push(JSON.parse(JSON.stringify(r))),
    displayMetrics: async () => {
      t.metricsCalls++;
      return { canvasSizeM: [heightM * 1.5, t.heightM], nominalViewerM: viewerM, source: { size: 'display', viewer: viewerSource, eyeSeparation: 'default' } };
    },
    on: (type, cb) => {
      (t.listeners[type] ||= []).push(cb);
      return () => (t.listeners[type] = t.listeners[type].filter((f) => f !== cb));
    },
    heightM,
  };
  return t;
}

// Tablet case from §2, as a box: front 0.5, back 1.0 tile heights at vH 0.3.
const VH = 0.3;
const tabletViewer = { _fitScale: 1, _subjectHalf: [0.1, 0.1, 0.225], _depthOffset: -0.075 }; // front 0.15, back −0.3
const K_TABLET = comfortDepthFactor({ frontH: 0.5, backH: 1, tileHeightM: 0.148, viewerM: 0.4 });

function modelRig(tile, option) {
  const out = {};
  const stereo = attachModelStereo(out, { getTile: () => tile, vH: VH, makeDisplayRig: displayRig });
  const depth = attachComfortDepth(out, { option, getTile: () => tile, getBounds: () => framedSubjectBounds(tabletViewer), getVH: () => VH, apply: (k) => stereo.setBase(k) });
  return { out, depth };
}

test('depth absent: inert — depthFactor 1, nothing measured, nothing declared, setStereo exactly as before', async () => {
  const tile = fakeTile();
  const { out, depth } = modelRig(tile, null);
  await depth.refresh();
  await tick();
  assert.equal(out.depthFactor, 1);
  assert.equal(tile.metricsCalls, 0, 'no async work');
  assert.equal(tile.rigs.length, 0, 'no rig that was not declared before');
  assert.deepEqual(Object.keys(tile.listeners), [], 'no listener');
  out.setStereo({ ipdFactor: 0.5 });
  assert.deepEqual(tile.rigs.at(-1), displayRig({ virtualDisplayHeight: VH, ipdFactor: 0.5, parallaxFactor: 1 }));
});

test('depth on: the declared display rig carries k on BOTH scalars, × setStereo; unchanged k is not re-sent', async () => {
  const tile = fakeTile();
  const { out, depth } = modelRig(tile, { zone: 'shibata' });
  assert.equal(out.depthFactor, 1, 'before the first measurement');
  await depth.refresh();
  near(out.depthFactor, K_TABLET, 1e-12);
  assert.equal(tile.rigs.length, 1);
  near(tile.rigs[0].ipdFactor, K_TABLET, 1e-12);
  near(tile.rigs[0].parallaxFactor, K_TABLET, 1e-12);
  assert.equal(tile.rigs[0].virtualDisplayHeight, VH);
  out.setStereo({ ipdFactor: 0.5 });
  near(tile.rigs.at(-1).ipdFactor, 0.5 * K_TABLET, 1e-12, 'a depth slider still works on top');
  near(tile.rigs.at(-1).parallaxFactor, K_TABLET, 1e-12);
  near(out.rig.ipdFactor, 0.5 * K_TABLET, 1e-12, 'handle.rig reads what is in force');
  const n = tile.rigs.length;
  await depth.refresh();
  await tick(); // the firstWoven re-measure too
  assert.equal(tile.rigs.length, n, 'same k: nothing re-declared');
  // a bigger canvas on the same panel: more vergence per tile height → lower k, re-declared
  tile.heightM = 0.2;
  tile.listeners.renderingmodechange[0]();
  await tick();
  assert.ok(out.depthFactor < K_TABLET);
  assert.equal(tile.rigs.length, n + 1);
  // a laptop-sized fit: back to 1, the plain rig (the shorthand's equivalent)
  tile.heightM = 0.01;
  await depth.refresh();
  assert.equal(out.depthFactor, 1);
  assert.deepEqual(tile.rigs.at(-1), displayRig({ virtualDisplayHeight: VH, ipdFactor: 0.5, parallaxFactor: 1 }));
  depth.dispose();
  assert.equal(tile.listeners.renderingmodechange.length, 0, 'dispose unsubscribes');
});

test('depth uses the NOMINAL viewer distance, 0.6 m when the display reports none', async () => {
  const tile = fakeTile({ viewerM: 0.65, viewerSource: 'default' });
  const { out, depth } = modelRig(tile, { zone: 'shibata' });
  await depth.refresh();
  near(out.depthFactor, comfortDepthFactor({ frontH: 0.5, backH: 1, tileHeightM: 0.148, viewerM: 0.6 }), 1e-12);
});

test('ignore(): one warning, factor held at 1, nothing measured', async () => {
  const tile = fakeTile();
  const { out, depth } = modelRig(tile, { zone: 'shibata' });
  const warns = [];
  const real = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    depth.ignore('a camera rig');
    depth.ignore('a camera rig');
  } finally {
    console.warn = real;
  }
  assert.equal(warns.length, 1);
  assert.match(warns[0], /depth: 'auto' applies to the display rig only; ignored on a camera rig/);
  await depth.refresh();
  assert.equal(tile.metricsCalls, 0);
  assert.equal(out.depthFactor, 1);
  await depth.resume();
  near(out.depthFactor, K_TABLET, 1e-12, 'resume() measures again');
});

test('addSplat (./splat/playcanvas): an invalid depth throws at the call', async () => {
  const { addSplat } = await import('../js/inline3d-splat-pc-entry.js');
  const canvas = { getBoundingClientRect: () => ({ width: 1, height: 1 }) };
  assert.throws(() => addSplat(null, canvas, 'a.sog', { depth: 'yes' }), /@displayxr\/inline3d\/splat: depth must be 'auto'/);
  assert.throws(() => addSplat(null, canvas, 'a.sog', { depth: { zone: 'x' } }), /depth.zone must be/);
});

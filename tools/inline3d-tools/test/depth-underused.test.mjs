// The `depth-underused` check's verdict (no browser): too little depth is a failure too.
// Camera rig: the measured share of the comfort zone it uses; display rig: its ipdFactor.
//   node --test tools/inline3d-tools/test/depth-underused.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rigDepthUse, shibataZoneMm, DEPTH_ZONE_USE_FLOOR } from '../lib/check/analyze.mjs';

const cam = (o) => ({ type: 'camera', verticalFov: 0.8, ...o });
const zone = shibataZoneMm(0.65); // ≈ 23.5 mm in front, 25.3 mm behind
// n blocks evenly from lo to hi (mm on the glass, < 0 in front).
const spread = (lo, hi, n = 40) => Array.from({ length: n }, (_, i) => lo + ((hi - lo) * i) / (n - 1));

test('floor: 30% of the zone, on the binding side (= cameraRigComfortFactor above ~3.3)', () => {
  assert.equal(DEPTH_ZONE_USE_FLOOR, 0.3);
  const r = rigDepthUse(cam({ convergenceDiopters: 0.5 }), spread(-2, 0.32 * zone.behindMm), zone);
  assert.equal(r.status, 'pass', r.summary); // the far side uses 32%
  assert.equal(rigDepthUse(cam({ convergenceDiopters: 0.5 }), spread(-0.25 * zone.frontMm, 0.25 * zone.behindMm), zone).status, 'warn');
});

test('a game camera converged 13.4 units out, ipdFactor 2.5, m2v 1, measuring under 20% of the zone: WARN with rules 1-3', () => {
  const r = rigDepthUse(cam({ ipdFactor: 2.5, metersToVirtual: 1, convergenceDiopters: 1 / 13.4 }), spread(-0.2 * zone.frontMm, 0.2 * zone.behindMm), zone);
  assert.equal(r.status, 'warn', r.summary);
  assert.match(r.summary, /uses 1\d% of the comfort zone/);
  assert.equal(r.details.normalisedMetersToVirtual, 6.7); // rule 2: convergence / 2
  assert.ok(Math.abs(r.details.ipdFactorOnThatScale - 2.5 / 6.7) < 0.001, String(r.details.ipdFactorOnThatScale));
  assert.ok(r.details.fillMultiplier > 4.5 && r.details.fillMultiplier < 6, String(r.details.fillMultiplier));
  assert.match(r.hint, /convergence \/ 2 = 6\.7/);
  assert.match(r.hint, /cameraRigComfortFactor/);
});

test('camera rig: judged by the measured disparity, not the comfort product', () => {
  // far convergence (low comfort product) but real depth: pass
  assert.equal(rigDepthUse(cam({ ipdFactor: 1, convergenceDiopters: 0.05 }), spread(-12, 14), zone).status, 'pass');
  // high comfort product but flat: warn
  assert.equal(rigDepthUse(cam({ ipdFactor: 1, convergenceDiopters: 4 }), spread(-0.4, 0.4), zone).status, 'warn');
});

test('camera rig: too few blocks skips; converged at infinity warns; ipdFactor 0 is 2D on purpose', () => {
  assert.equal(rigDepthUse(cam({ convergenceDiopters: 1 }), [0.1, 0.2], zone).status, 'skip');
  assert.equal(rigDepthUse(cam({ convergenceDiopters: 1 }), null, zone).status, 'skip');
  const inf = rigDepthUse(cam({ convergenceDiopters: 0 }), spread(-3, 3), zone);
  assert.equal(inf.status, 'warn');
  assert.match(inf.hint, /centre of interest/);
  assert.equal(rigDepthUse(cam({ ipdFactor: 0, convergenceDiopters: 1 }), spread(0, 0), zone).status, 'pass');
});

test('display rig: judged by ipdFactor, not by the measured span (a shallow subject in a small tile is correct)', () => {
  assert.equal(rigDepthUse(null, spread(-0.2, 0.2), zone).status, 'pass');
  assert.equal(rigDepthUse({ type: 'display' }, spread(-0.2, 0.2), zone).status, 'pass');
  assert.equal(rigDepthUse({ type: 'display', ipdFactor: 0.5 }, null, zone).status, 'pass');
  const r = rigDepthUse({ type: 'display', ipdFactor: 0.3 }, spread(-3, 3), zone);
  assert.equal(r.status, 'warn');
  assert.match(r.hint, /natural depth/);
  assert.equal(rigDepthUse({ type: 'display', ipdFactor: 0 }, null, zone).status, 'pass');
});

test('no layer: skip', () => {
  assert.equal(rigDepthUse(undefined, null, zone).status, 'skip');
});

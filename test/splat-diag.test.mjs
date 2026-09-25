// The transition diagnostics' recorder, without an engine (./inline3d-splat-diag.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDiag, poseDelta, summarizeRig, DiagRecorder, verdict, DIAG_SWITCHES } from '../js/inline3d-splat-diag.js';

const views = (hx, extra = 0) =>
  [-1, 1].map((sg) => ({
    projectionMatrix: Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, extra, 0, -1, -1, 0, 0, -0.2, 0]),
    transform: { matrix: Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, hx + sg * 0.03, 0.1, 0.5, 1]) },
  }));

test('resolveDiag: the option wins over the URL; tokens are switches; off values and unknown tokens', () => {
  assert.deepEqual(resolveDiag(undefined, '').on, false, 'nothing asked');
  assert.equal(resolveDiag(undefined, '?dxrdiag=1').on, true);
  assert.equal(resolveDiag(undefined, '?dxrdiag').on, true, 'bare ?dxrdiag = on');
  assert.deepEqual([...resolveDiag(undefined, '?a=b&dxrdiag=norig,frozen').switches], ['norig', 'frozen']);
  assert.deepEqual([...resolveDiag(undefined, '?dxrdiag=nowarm&dxrdiag=frozen').switches], ['nowarm', 'frozen'], 'repeated params join');
  assert.equal(resolveDiag(false, '?dxrdiag=1').on, false, 'false beats the URL');
  assert.deepEqual([...resolveDiag(true, '?dxrdiag=norig').switches], [], 'the option wins: the URL switches are not merged');
  assert.deepEqual([...resolveDiag('frozen', '').switches], ['frozen']);
  assert.deepEqual([...resolveDiag(['norig', 'nowarm'], '').switches], ['norig', 'nowarm']);
  assert.equal(resolveDiag(undefined, '?dxrdiag=0').on, false);
  const u = resolveDiag('norig,bogus', '');
  assert.equal(u.on, true);
  assert.deepEqual(u.unknown, ['bogus'], 'unknown tokens are reported, never thrown');
  assert.deepEqual([...DIAG_SWITCHES], ['norig', 'frozen', 'nowarm', 'nooverlay']);
});

test('poseDelta: bit-identical views are HELD; any real move is not; delta in world units and in eye separations', () => {
  const a = poseDelta(views(0), null);
  assert.equal(a.m.held, false, 'no previous frame: never held');
  assert.ok(Math.abs(a.m.ipd - 0.06) < 1e-6);
  const b = poseDelta(views(0), a.state);
  assert.equal(b.m.held, true);
  assert.equal(b.m.delta, 0);
  const c = poseDelta(views(0.0005), b.state);
  assert.equal(c.m.held, false);
  assert.ok(Math.abs(c.m.delta - 0.0005) < 1e-6);
  assert.ok(Math.abs(c.m.rel - 0.0005 / 0.06) < 1e-5);
  // same poses, a new PROJECTION (a lens change located the same head): not a hold
  const d = poseDelta(views(0.0005, 0.1), c.state);
  assert.equal(d.m.held, false);
  assert.equal(d.m.delta, 0);
  // a view-count change is never a hold
  assert.equal(poseDelta(views(0.0005).slice(0, 1), d.state).m.held, false);
});

test('summarizeRig: numbers rounded, nested fields flattened, typed arrays dropped', () => {
  const s = summarizeRig({ type: 'camera', verticalFov: 0.691111161, position: { x: 1, y: 2, z: 3 }, m: new Float32Array(16), convergenceDiopters: 0.1379375 });
  assert.deepEqual(s, { type: 'camera', verticalFov: 0.6911, 'position.x': 1, 'position.y': 2, 'position.z': 3, convergenceDiopters: 0.1379 });
  assert.deepEqual(summarizeRig(null), { type: 'none' });
});

test('DiagRecorder: a transition — phases, rig pushes (deduped), held run, gap, frozen image; summary 1 s after settle', () => {
  let T = 0;
  const lines = [];
  let img = { overlay: 'none', w: 0 };
  const r = new DiagRecorder({ now: () => T, log: (m) => lines.push(m) });
  r.imageState = () => img;
  const tick = (dt, v) => {
    T += dt;
    return r.frame(v, T);
  };
  r.rig({ type: 'camera', verticalFov: 0.7 });
  r.rig({ type: 'camera', verticalFov: 0.7 }); // same: not an event
  assert.equal(r.events.filter((e) => e.type === 'rig').length, 1);
  assert.equal(r.rigRepeats, 1);
  tick(16, views(0));
  tick(16, views(0.001));
  r.setPhase('swap', { transition: 'crossfade' });
  r.rig({ type: 'camera', verticalFov: 0.5 });
  r.setPhase('window');
  img = { overlay: 'frozen', w: 1 };
  const f1 = tick(16, views(0.002));
  assert.equal(f1.afterRig, true, 'a rig push just before: a pose jump here is the rig');
  assert.equal(f1.img, 'frozen');
  tick(16, views(0.002)); // held
  tick(16, views(0.002)); // held
  tick(16, views(0.002)); // held
  img = { overlay: 'live', w: 0.9 };
  tick(90, views(0.004)); // a 90 ms gap
  tick(16, views(0.005));
  r.setPhase('settle');
  tick(16, views(0.006));
  assert.equal(r.transitions.length, 0, 'not closed before a second has passed');
  tick(1000, views(0.007));
  assert.equal(r.transitions.length, 1);
  const s = r.transitions[0];
  assert.deepEqual(s.phases.map((p) => p.phase), ['swap', 'window', 'settle']);
  assert.equal(s.heldRunMax, 3);
  assert.equal(s.heldRunMaxMs, 48);
  assert.equal(s.frozenImageFrames, 4);
  assert.ok(s.maxFrameGapMs >= 90, 'the gap');
  assert.equal(s.rigs.length, 1);
  assert.equal(s.rigs[0].rig.verticalFov, 0.5);
  assert.match(s.verdict, /TRACKING-HELD 3 frames \(48 ms\)/);
  assert.match(s.verdict, /IMAGE-FROZEN 4 frames/);
  assert.equal(r.phase, 'idle', 'back to idle once summarised');
  assert.ok(lines.some((l) => l.startsWith('transition #1 ')), 'one console line per transition');
  assert.ok(lines.some((l) => l.startsWith('rig ')), 'rig pushes logged');
  const j = JSON.parse(r.dump());
  assert.equal(j.transitions.length, 1);
  assert.ok(j.frames.length >= 10);
});

test('DiagRecorder: a newer swap closes the open transition as superseded; dropped rigs are marked', () => {
  let T = 0;
  const r = new DiagRecorder({ now: () => T, log: () => {} });
  r.setPhase('swap');
  r.frame(views(0), (T += 16));
  r.rig({ type: 'display', virtualDisplayHeight: 0.3 }, { dropped: true });
  r.setPhase('swap');
  assert.equal(r.transitions.length, 1);
  assert.equal(r.transitions[0].how, 'superseded');
  assert.equal(r.transitions[0].rigs[0].dropped, true);
  assert.equal(r.events.filter((e) => e.type === 'rig-dropped').length, 1);
});

test('verdict: thresholds', () => {
  const base = { heldRunMax: 0, heldRunMaxMs: 0, maxFrameGapMs: 20, longestTaskMs: 0, frozenImageFrames: 0, frozenImageMs: 0 };
  assert.match(verdict(base), /^CLEAN/);
  assert.match(verdict({ ...base, heldRunMax: 1 }), /^CLEAN/, 'one repeated frame is noise');
  assert.match(verdict({ ...base, heldRunMax: 2, heldRunMaxMs: 33 }), /^TRACKING-HELD 2 frames/);
  assert.match(verdict({ ...base, maxFrameGapMs: 51, longestTaskMs: 45 }), /^MAIN-THREAD gap 51 ms \(longest task 45 ms\)/);
  assert.match(verdict({ ...base, frozenImageFrames: 2, frozenImageMs: 33 }), /^IMAGE-FROZEN 2 frames/);
});

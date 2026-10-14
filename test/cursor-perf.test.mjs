// The depth cursor's responsiveness: the amortised pick (the sprite follows the newest pointer,
// the pick only refreshes depth), the pointer sampling (pointerrawupdate, coalesced samples, one
// layout read a frame), and the `cursor: { debug }` stats. The BVH pick itself needs a real
// three.js: test/e2e/cursor-perf.e2e.mjs checks it ray-for-ray against three's raycast.

import test from 'node:test';
import assert from 'node:assert/strict';

import { CursorAmortisedPick, CursorDebugStats, cursorDebugMode, CURSOR_MODEL_RAYS_PER_FRAME } from '../js/inline3d-cursor-perf.js';
import { CursorPointer, supportsRawUpdate, resolveCursorOption, CURSOR_DEFAULT_TUNING as T } from '../js/inline3d-cursor-depth.js';
import { DepthCursor } from '../js/inline3d-three.js';

const W = 0.3, H = 0.2;
function kooima(eye) {
  const d = eye[2];
  const l = (-W / 2 - eye[0]) / d, r = (W / 2 - eye[0]) / d;
  const u = (H / 2 - eye[1]) / d, dn = (-H / 2 - eye[1]) / d;
  const n = 0.01, f = 100;
  return {
    projectionMatrix: [2 / (r - l), 0, 0, 0, 0, 2 / (u - dn), 0, 0, (r + l) / (r - l), (u + dn) / (u - dn), -(f + n) / (f - n), -1, 0, 0, (-2 * f * n) / (f - n), 0],
    transformMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, eye[0], eye[1], eye[2], 1],
  };
}
const VIEWS = [kooima([-0.032, 0, 0.6]), kooima([0.032, 0, 0.6])];
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const FWD = [0, 0, -1];

function stubTHREE() {
  class Mat { constructor(o) { Object.assign(this, o); } dispose() {} }
  class Geom { setAttribute(k, v) { this[k] = v; } dispose() {} }
  return {
    BufferGeometry: Geom,
    Float32BufferAttribute: class { constructor(a, n) { this.array = a; this.itemSize = n; } },
    MeshBasicMaterial: Mat,
    ShaderMaterial: Mat, // the softened arrow (ADR-046 Amendment 2 §B.7)
    ShaderChunk: { colorspace_fragment: '' },
    Vector3: class { constructor(...a) { this.v = a; } set(...a) { this.v = a; return this; } },
    Vector4: class { constructor(...a) { this.v = a; } set(...a) { this.v = a; return this; } },
    DoubleSide: 2,
    Mesh: class {
      constructor(geometry, material) {
        this.geometry = geometry;
        this.material = material;
        this.matrix = { elements: null, fromArray(a) { this.elements = a; } };
      }
    },
  };
}

function stubCanvas({ raw = false } = {}) {
  const handlers = {};
  const c = {
    style: { cursor: 'crosshair' },
    handlers,
    rectReads: 0,
    getBoundingClientRect() {
      c.rectReads++;
      return { left: 0, top: 0, width: 300, height: 200 };
    },
    addEventListener(k, f) { handlers[k] = f; },
    removeEventListener(k) { delete handlers[k]; },
  };
  if (raw) c.onpointerrawupdate = null;
  return c;
}

// A plane at z = 0.1 (in front of the glass) over the canvas's LEFT half only.
const leftPlane = (o, d) => {
  if (d[2] >= 0) return null;
  const t = (0.1 - o[2]) / d[2];
  const p = [o[0] + d[0] * t, o[1] + d[1] * t, 0.1];
  return p[0] < 0 ? p : null;
};
const FRONT = 1 - 0.6 / 0.5 - T.margin; // the target over that plane

// ── CursorAmortisedPick ────────────────────────────────────────────────────────────────────

test('amortised pick: slot order covers every footprint point per sweep, alternating eyes, every (point, eye) once', () => {
  for (const [P, E] of [[10, 2], [9, 2], [10, 1], [4, 3]]) {
    const seen = new Set();
    for (let k = 0; k < P * E; k++) {
      const [p, e] = CursorAmortisedPick.slot(k, P, E);
      assert.ok(p >= 0 && p < P && e >= 0 && e < E);
      seen.add(`${p}/${e}`);
    }
    assert.equal(seen.size, P * E, `${P}x${E}: every slot once`);
    // The first P slots are every point once (a full spatial sweep before any point repeats).
    const first = new Set(Array.from({ length: P }, (_, k) => CursorAmortisedPick.slot(k, P, E)[0]));
    assert.equal(first.size, P);
  }
  // Two eyes, 10 points: eyes alternate within a sweep, and the next sweep takes the other eye.
  assert.deepEqual(CursorAmortisedPick.slot(0, 10, 2), [0, 0]);
  assert.deepEqual(CursorAmortisedPick.slot(1, 10, 2), [1, 1]);
  assert.deepEqual(CursorAmortisedPick.slot(10, 10, 2), [0, 1]);
  assert.deepEqual(CursorAmortisedPick.slot(11, 10, 2), [1, 0]);
});

test('amortised pick: N rays a frame, nearest live hit, a full sweep in ceil(P / N) frames', () => {
  const fp = Array.from({ length: 10 }, (_, i) => [0.5 + i * 1e-4, 0.5]);
  const casts = [];
  // Point 7 is the nearest content (smaller z·forward = nearer), cast only from eye 0.
  const cast = (e, u) => {
    const i = Math.round((u - 0.5) / 1e-4);
    casts.push([i, e]);
    return [0, 0, i === 7 && e === 0 ? 0.3 : 0.1];
  };
  const pick = new CursorAmortisedPick(3);
  const r1 = pick.step(fp, 2, cast, FWD, 1.5, 0.05);
  assert.equal(casts.length, 3);
  assert.equal(pick.lastRays, 3);
  assert.equal(r1[2], 0.1, 'point 7 not reached yet');
  pick.step(fp, 2, cast, FWD, 1.5, 0.05);
  pick.step(fp, 2, cast, FWD, 1.5, 0.05);
  // Slots 0..8 so far: point 7 was cast from eye 1 (slot 7 → eye 7 % 2 = 1) — not the near one yet.
  assert.equal(casts.length, 9);
  let r;
  for (let i = 0; i < 4; i++) r = pick.step(fp, 2, cast, FWD, 1.5, 0.05);
  assert.equal(r[2], 0.3, 'within two sweeps (both eyes) the nearest hit wins');
  assert.equal(casts.length, 20 + 1, 'wrapped around: 7 frames × 3 rays, the ring of 20 slots');
  // More rays than slots: each slot once a frame, never more.
  const all = new CursorAmortisedPick(50);
  casts.length = 0;
  all.step(fp, 2, cast, FWD, 1.5, 0.05);
  assert.equal(casts.length, 20);
  assert.equal(all.lastRays, 20);
});

test('amortised pick: a slot cast from where the pointer no longer is (beyond reach) is ignored', () => {
  const fpAt = (u) => Array.from({ length: 10 }, () => [u, 0.5]);
  let content = true;
  const cast = () => (content ? [0, 0, 0.2] : null);
  const pick = new CursorAmortisedPick(1);
  for (let i = 0; i < 20; i++) pick.step(fpAt(0.3), 2, cast, FWD, 1.5, 0.05);
  // Moved by 0.02 canvas widths × 1.5 = 0.03 heights (< reach 0.05): the old hits still count.
  content = false;
  assert.deepEqual(pick.step(fpAt(0.32), 2, cast, FWD, 1.5, 0.05), [0, 0, 0.2]);
  // Moved 0.1 widths = 0.15 heights (> reach): only this frame's (missing) ray counts.
  assert.equal(pick.step(fpAt(0.42), 2, cast, FWD, 1.5, 0.05), null);
  // Exactly at reach is kept (<=), just beyond is not.
  const primed = () => {
    const pk = new CursorAmortisedPick(1);
    const two = [[0.5, 0.5], [0.5, 0.5]];
    pk.step(two, 1, () => [0, 0, 0.2], FWD, 1, 1);
    pk.step(two, 1, () => [0, 0, 0.2], FWD, 1, 1);
    return pk;
  };
  const moved = [[0.5, 0.6], [0.5, 0.6]];
  const dist = Math.abs(0.5 - 0.6);
  assert.deepEqual(primed().step(moved, 1, () => null, FWD, 1, dist), [0, 0, 0.2], 'exactly at reach: kept');
  assert.equal(primed().step(moved, 1, () => null, FWD, 1, dist * 0.999), null);
});

test('amortised pick: staleness is judged by the HOTSPOT a slot was cast from, not by its footprint point', () => {
  // A still pointer whose far footprint point (0.4 heights below the tip, beyond reach) is over content.
  const fp = [[0.5, 0.5], [0.5, 0.9]];
  const cast = (e, u, v) => (v > 0.8 ? [0, 0, 0.25] : null);
  const pick = new CursorAmortisedPick(1);
  pick.step(fp, 1, cast, FWD, 1, 0.05);
  assert.deepEqual(pick.step(fp, 1, cast, FWD, 1, 0.05), [0, 0, 0.25]);
});

test('amortised pick: a footprint of a different size restarts the sweep', () => {
  const pick = new CursorAmortisedPick(2);
  const hits = [];
  pick.step([[0.5, 0.5], [0.5, 0.5], [0.5, 0.5]], 1, (e, u, v) => (hits.push(1), [0, 0, 0.2]), FWD, 1, 1);
  const r = pick.step([[0.5, 0.5]], 1, () => null, FWD, 1, 1);
  assert.equal(r, null, 'old slots are gone with the old footprint');
});

// ── DepthCursor: the sprite follows the newest pointer; the pick only refreshes depth ───────

test('DepthCursor amortised: placed at the NEWEST pointer every frame, 3 rays a frame; leaving content drops its stale hits', () => {
  const canvas = stubCanvas();
  let rays = 0;
  const cur = new DepthCursor(stubTHREE(), { canvas, hitTest: (o, d) => (rays++, leftPlane(o, d)), raysPerFrame: 3 });
  assert.equal(CURSOR_MODEL_RAYS_PER_FRAME, 3);
  let t = 1000;
  cur.setPointer(0.25, 0.5);
  let p;
  for (let i = 0; i < 8; i++) p = cur.update(VIEWS, (t += 16));
  assert.equal(rays, 24, '3 rays a frame, never the whole footprint');
  assert.ok(p.active);
  near(p.targetDisparity, FRONT, 1e-9);
  // A small move over the content: the sprite is solved at the new pointer this very frame.
  cur.setPointer(0.27, 0.5);
  const q = cur.update(VIEWS, (t += 16));
  near(q.geometry.canvasPoint[0], (0.27 - 0.5) * W, 1e-9);
  assert.ok(q.targetDisparity < 0, 'still over the content');
  // A jump off it: the first frame there is judged on its fresh rays only — the left-half hits
  // cast from 0.27 are stale — so the target is the glass at once (the filter then sinks slowly).
  cur.setPointer(0.8, 0.5);
  const r = cur.update(VIEWS, (t += 16));
  assert.equal(r.targetDisparity, 0);
  near(r.geometry.canvasPoint[0], (0.8 - 0.5) * W, 1e-9);
  cur.dispose();
});

test('DepthCursor amortised: both eyes are cast — content only one eye sees is found', () => {
  // Content only along rays from the RIGHT eye (origin x > 0).
  const rightOnly = (o, d) => (o[0] > 0 ? leftPlane([o[0] - 0.064, o[1], o[2]], d) || [0, 0, 0.1] : null);
  const cur = new DepthCursor(stubTHREE(), { canvas: stubCanvas(), hitTest: rightOnly, raysPerFrame: 3 });
  cur.setPointer(0.25, 0.5);
  let p;
  for (let i = 0; i < 8; i++) p = cur.update(VIEWS, 1000 + i * 16);
  assert.ok(p.targetDisparity < 0, 'the right eye\'s hits count');
  cur.dispose();
});

test('DepthCursor raysPerFrame 0 (default) still casts the whole footprint, both eyes, every frame', () => {
  let rays = 0;
  const cur = new DepthCursor(stubTHREE(), { canvas: stubCanvas(), hitTest: (o, d) => (rays++, leftPlane(o, d)) });
  cur.setPointer(0.25, 0.5);
  cur.update(VIEWS, 1000);
  assert.equal(rays, 20, '2 eyes × 10 footprint points');
  cur.dispose();
});

// ── debug: zero cost off, stats on, 'both' keeps the OS cursor ─────────────────────────────

test('cursorDebugMode + resolveCursorOption: debug is true | false | both, validated at the call', () => {
  assert.equal(cursorDebugMode(undefined), false);
  assert.equal(cursorDebugMode(false), false);
  assert.equal(cursorDebugMode(true), 'stats');
  assert.equal(cursorDebugMode('both'), 'both');
  assert.deepEqual(resolveCursorOption({ debug: true }), { debug: true });
  assert.deepEqual(resolveCursorOption({ debug: 'both' }), { debug: 'both' });
  assert.deepEqual(resolveCursorOption({ debug: false }), { debug: false });
  assert.throws(() => resolveCursorOption({ debug: 'yes' }), /cursor\.debug/);
  assert.throws(() => resolveCursorOption({ debug: 1 }), /cursor\.debug/);
});

test('DepthCursor debug off: nothing measured, the hit test is the page\'s own (no wrapper)', () => {
  const hitTest = (o, d) => leftPlane(o, d);
  const cur = new DepthCursor(stubTHREE(), { canvas: stubCanvas(), hitTest });
  assert.equal(cur.debugStats, null);
  assert.equal(cur.hitTest, hitTest);
  cur.dispose();
});

test('DepthCursor debug: per-frame cost, rays and frame interval, logged once a period; both = CSS cursor never hidden', () => {
  const lines = [];
  const canvas = stubCanvas();
  const info = () => ({ mode: 'bvh', built: 4, refits: 0, failed: 0, buildMs: 1.5, plainCasts: 2 });
  const hitTest = Object.assign((o, d) => leftPlane(o, d), { info });
  const cur = new DepthCursor(stubTHREE(), { canvas, hitTest, raysPerFrame: 3, debug: 'both' });
  cur.debugStats.log = (l) => lines.push(l);
  assert.notEqual(cur.hitTest, hitTest, 'wrapped to count rays');
  cur.setPointer(0.25, 0.5);
  let p;
  for (let t = 0; t <= 1100; t += 100) p = cur.update(VIEWS, t);
  assert.ok(p.active, 'the sprite shows…');
  assert.equal(canvas.style.cursor, 'crosshair', "…and the OS cursor stays visible beside it ('both')");
  // update() is timed with performance.now(); frames came in quick succession, so at most one log.
  assert.ok(lines.length <= 1);
  const s = cur.debugStats;
  // Drive the period by hand: debug stats are keyed on the real clock.
  s.frame(0.5, 3, 5000, 2, 3);
  s.frame(1.5, 3, 5016, null, 0);
  const out = s.frame(1.0, 3, 6100, 4, 1);
  assert.ok(out, 'a summary once the period has passed');
  assert.equal(s.last, out);
  assert.equal(out.pick.mode, 'bvh');
  assert.equal(out.pointerSource, 'pointermove');
  assert.match(lines[lines.length - 1], /cursor debug: .*update .*rays 3\.0\/frame.*pick bvh \(4 built/);
  cur.dispose();
});

test('CursorDebugStats: rolling stats, printed at most once per period, history bounded', () => {
  const lines = [];
  const s = new CursorDebugStats({ periodMs: 1000, log: (l) => lines.push(l) });
  assert.equal(s.frame(1, 2, 0, 5, 1), null);
  assert.equal(s.frame(3, 4, 10, null, 0), null);
  assert.equal(s.frame(2, 0, 30, 7, 2), null);
  assert.equal(lines.length, 0, 'never per frame');
  const out = s.frame(10, 6, 1000, 1, 1);
  assert.equal(lines.length, 1);
  assert.equal(out.frames, 4);
  near(out.updateMs.mean, 4);
  assert.equal(out.updateMs.max, 10);
  assert.equal(out.updateMs.p95, 10);
  near(out.rays.mean, 3);
  assert.equal(out.rays.max, 6);
  assert.deepEqual([out.frameMs.n, out.frameMs.max], [3, 970]);
  near(out.frameMs.mean, 1000 / 3);
  assert.equal(out.pointerAgeMs.n, 3, 'frames without a new sample carry no age');
  near(out.pointerAgeMs.mean, 13 / 3);
  near(out.samplesPerFrame, 1);
  near(out.seconds, 1);
  // The next window starts empty.
  assert.equal(s.frame(1, 1, 1500, null, 0), null);
  const out2 = s.frame(1, 1, 2000, null, 0);
  assert.equal(out2.frames, 2);
  assert.equal(out2.pointerAgeMs.n, 0);
  assert.doesNotMatch(lines[1], /pointer age/);
  for (let i = 0; i < 200; i++) s.frame(0, 0, 3000 + i * 1000);
  assert.equal(s.history.length, 120);
});

// ── CursorPointer: raw updates, coalesced samples, one layout read a frame ─────────────────

test('CursorPointer: pointerrawupdate where supported (and secure), pointermove always; dispose removes both', () => {
  const plain = stubCanvas();
  const a = new CursorPointer(plain);
  assert.equal(a.source, 'pointermove');
  assert.equal(plain.handlers.pointerrawupdate, undefined);
  a.dispose();

  const raw = stubCanvas({ raw: true });
  assert.equal(supportsRawUpdate(raw), true);
  const b = new CursorPointer(raw);
  assert.equal(b.source, 'pointerrawupdate');
  assert.equal(typeof raw.handlers.pointerrawupdate, 'function');
  assert.equal(typeof raw.handlers.pointermove, 'function', 'pointermove stays (fallback, synthetic events)');
  b.dispose();
  assert.equal(raw.handlers.pointerrawupdate, undefined);
  assert.equal(raw.handlers.pointermove, undefined);

  const prev = globalThis.isSecureContext;
  globalThis.isSecureContext = false;
  try {
    assert.equal(supportsRawUpdate(stubCanvas({ raw: true })), false, 'not in an insecure context');
    assert.equal(new CursorPointer(stubCanvas({ raw: true })).source, 'pointermove');
  } finally {
    if (prev === undefined) delete globalThis.isSecureContext;
    else globalThis.isSecureContext = prev;
  }
  assert.equal(supportsRawUpdate(null), false);
});

test('CursorPointer: the newest coalesced sample wins; an older one never overwrites a newer one', () => {
  const canvas = stubCanvas({ raw: true });
  const p = new CursorPointer(canvas);
  const ev = (x, t, co) => ({ clientX: x, clientY: 100, timeStamp: t, getCoalescedEvents: co ? () => co : undefined });
  // A pointermove carrying three coalesced samples: the LAST is the position.
  canvas.handlers.pointermove(ev(30, 10, [ev(30, 8), ev(60, 9), ev(90, 10)]));
  assert.deepEqual(p.uv, [0.3, 0.5]);
  assert.equal(p.sampleTime, 10);
  // A raw update ahead of the next rAF-aligned move…
  canvas.handlers.pointerrawupdate(ev(150, 20));
  assert.deepEqual(p.uv, [0.5, 0.5]);
  // …and a stale move dispatched after it (older timestamp) is ignored.
  canvas.handlers.pointermove(ev(120, 15));
  assert.deepEqual(p.uv, [0.5, 0.5]);
  assert.equal(p.samples, 2);
  // Same timestamp is not older: accepted.
  canvas.handlers.pointermove(ev(165, 20));
  assert.deepEqual(p.uv, [0.55, 0.5]);
  // Synthetic events: empty coalesced list, no timestamp — still tracked.
  canvas.handlers.pointermove({ clientX: 240, clientY: 50, getCoalescedEvents: () => [] });
  assert.deepEqual(p.uv, [0.8, 0.25]);
  // Off the canvas → null; leave → null; set() overrides.
  canvas.handlers.pointerrawupdate(ev(400, 1e12));
  assert.equal(p.uv, null);
  p.set(0.1, 0.2);
  assert.deepEqual(p.uv, [0.1, 0.2]);
  canvas.handlers.pointerleave();
  assert.equal(p.uv, null);
  p.dispose();
});

test('CursorPointer: no layout read per event — the position resolves once, on the next read', () => {
  const canvas = stubCanvas({ raw: true });
  const p = new CursorPointer(canvas);
  for (let i = 0; i < 8; i++) canvas.handlers.pointerrawupdate({ clientX: 10 + i, clientY: 10, timeStamp: 1 + i });
  assert.equal(canvas.rectReads, 0, 'eight raw samples, no getBoundingClientRect');
  assert.deepEqual(p.uv, [17 / 300, 10 / 200]);
  assert.equal(canvas.rectReads, 1);
  p.uv;
  p.uv;
  assert.equal(canvas.rectReads, 1, 'cached until the next sample');
  p.dispose();
});

test('CursorPointer keepCss: hideCss never hides', () => {
  const canvas = stubCanvas();
  // The hide is a data attribute (the page's inline cursor is never written).
  const attrs = new Map();
  Object.assign(canvas, { setAttribute: (k, v) => attrs.set(k, v), removeAttribute: (k) => attrs.delete(k), hasAttribute: (k) => attrs.has(k) });
  const hidden = () => attrs.has('data-inline3d-cursor-hidden');
  const p = new CursorPointer(canvas, { keepCss: true });
  p.hideCss(true);
  assert.equal(hidden(), false);
  const q = new CursorPointer(canvas);
  q.hideCss(true);
  assert.equal(hidden(), true);
  assert.equal(canvas.style.cursor, 'crosshair');
  q.hideCss(false);
  assert.equal(hidden(), false);
});

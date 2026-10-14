// Runtime ADR-046 Amendment 4: where the browser AND the runtime draw the web cursor, the page
// supplies only the depth under the pointer — `layer.setCursorDepth({ disparityPx, u, v })` per
// frame while the pointer is over the element, `layer.setCursorDepth()` to withdraw — and draws
// nothing itself. What is pinned, against a FAKE layer (no browser here has the real API):
//   - the link: method-presence detection, the support probe (pending → runtime / none, a bounded
//     rate-limited re-ask after "none"), the depth's shape (no disparityPx = nothing 3D there),
//     one withdrawal per withdrawal, a new layer withdrawing from the old;
//   - the UNIT: RAW content disparity (no margin, no clamp, no filter) in DEVICE px between the
//     two outermost views, < 0 crossed — checked against an independent projection;
//   - every backend (./three DepthCursor, the PlayCanvas cursor, the stereo-pair cursor): support
//     "runtime" → the sprite is never drawn and the CSS cursor never hidden; "none", "pending" or
//     no API → exactly today's SDK-drawn sprite.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CURSOR_DEFAULT_TUNING as T,
  CURSOR_RUNTIME_PROBES,
  CURSOR_RUNTIME_RETRY_MS,
  CursorDepthPlacer,
  CursorRuntimeLink,
  cursorDisparityPx,
  cursorRuntimeCapable,
} from '../js/inline3d-cursor-depth.js';
import { DepthCursor } from '../js/inline3d-three.js';
import { PlayCanvasDepthCursor } from '../js/inline3d-cursor-depth-playcanvas.js';
import { installCallDom, doc } from './call-dom.mjs';

installCallDom();
globalThis.addEventListener ??= () => {};
globalThis.removeEventListener ??= () => {};
const { PairCursor } = await import('../js/camera/pair-cursor.js');

const near = (a, b, eps = 1e-6, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} != ${b}`);
const flush = () => new Promise((r) => setTimeout(r, 0));

// ── fixtures ────────────────────────────────────────────────────────────────────────────────

const W = 0.3; // canvas width, m
const H = 0.2; // canvas height, m — 200 CSS px on the page, dpr 1 → 1 mm per device px

/** Off-axis view from a display-space eye onto the W×H canvas at z = 0. */
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
const EYES = [[-0.032, 0, 0.6], [0.032, 0, 0.6]];
const VIEWS = EYES.map(kooima);

/** Independent oracle: where a point lands on the glass (z = 0) from an eye, then device px apart (R − L). */
function oracleDisparityPx(point, eyes = EYES, pxPerM = 200 / H) {
  const onGlass = (e) => e[0] + (point[0] - e[0]) * (e[2] / (e[2] - point[2]));
  return (onGlass(eyes[eyes.length - 1]) - onGlass(eyes[0])) * pxPerM;
}

/** A fake XRDisplayLayer with the Amendment 4 methods; `support` may be a value or a promise. */
function fakeLayer(support = 'runtime') {
  const calls = [];
  return {
    calls,
    probes: 0,
    setCursorDepth(...args) {
      calls.push(args);
    },
    getCursorDepthSupport() {
      this.probes++;
      return typeof support === 'function' ? support() : Promise.resolve(support);
    },
  };
}

function stubTHREE() {
  class Mat { constructor(o) { Object.assign(this, o); } dispose() {} }
  class Geom { setAttribute(k, v) { this[k] = v; } dispose() {} }
  const V = class { constructor(...a) { this.v = a; } set(...a) { this.v = a; return this; } };
  return {
    BufferGeometry: Geom,
    Float32BufferAttribute: class { constructor(a, n) { this.array = a; this.itemSize = n; } },
    MeshBasicMaterial: Mat,
    ShaderMaterial: Mat,
    ShaderChunk: { colorspace_fragment: '' },
    Vector3: V,
    Vector4: V,
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

function stubCanvas() {
  const handlers = {};
  const lists = {};
  const attrs = new Map();
  return {
    nodeType: 1,
    style: { cursor: 'grab' },
    handlers,
    setAttribute: (k, v) => attrs.set(k, String(v)),
    removeAttribute: (k) => attrs.delete(k),
    hasAttribute: (k) => attrs.has(k),
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    addEventListener(k, f) {
      (lists[k] ||= []).push(f);
      handlers[k] = (e) => (lists[k] || []).slice().forEach((g) => g(e));
    },
    removeEventListener(k, f) {
      lists[k] = (lists[k] || []).filter((g) => g !== f);
      if (!lists[k].length) delete handlers[k];
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 200 }),
  };
}
const cssHidden = (el) => el.hasAttribute('data-inline3d-cursor-hidden');

// Content: a plane at z = 0.1 (in front of the glass) over the canvas's left half.
const PLANE_Z = 0.1;
const hitTest = (o, d) => {
  if (d[2] >= 0) return null;
  const t = (PLANE_Z - o[2]) / d[2];
  const p = [o[0] + d[0] * t, o[1] + d[1] * t, PLANE_Z];
  return p[0] < 0 ? p : null;
};

// ── the unit ────────────────────────────────────────────────────────────────────────────────

test('unit: content disparity → device px between the outermost views = the projection oracle (crossed < 0)', () => {
  const placer = new CursorDepthPlacer();
  const point = [-0.05, 0, PLANE_Z];
  const p = placer.update(VIEWS, { u: 1 / 3, v: 0.5, nearestPoint: point, canvasPx: 200 }, 1);
  near(p.contentDisparity, 1 - 0.6 / 0.5, 1e-9, 'd = 1 − 1/t');
  near(p.contentDisparityPx, oracleDisparityPx(point), 1e-6, 'px = d × pxPerBaseline');
  near(p.contentDisparityPx, -12.8, 1e-6, '0.064 m × −0.2 at 1 mm per px');
  // RAW: no margin, no clamp — the runtime applies the policy.
  assert.notEqual(p.contentDisparity, p.targetDisparity);
  // A point BEHIND the glass is sent too (uncrossed, > 0): the runtime's clamp, not ours.
  const q = placer.update(VIEWS, { u: 1 / 3, v: 0.5, nearestPoint: [-0.05, 0, -0.3], canvasPx: 200 }, 2);
  near(q.contentDisparityPx, oracleDisparityPx([-0.05, 0, -0.3]), 1e-6);
  assert.ok(q.contentDisparityPx > 0);
  // Nothing under it, or no canvas size: null.
  assert.equal(placer.update(VIEWS, { u: 0.5, v: 0.5, nearestPoint: null, canvasPx: 200 }, 3).contentDisparityPx, null);
  assert.equal(placer.update(VIEWS, { u: 0.5, v: 0.5, nearestPoint: point }, 4).contentDisparityPx, null);
  assert.equal(cursorDisparityPx(-0.2, 64), -12.8);
  assert.equal(cursorDisparityPx(null, 64), null);
  assert.equal(cursorDisparityPx(-0.2, 0), null);
  assert.equal(cursorDisparityPx(NaN, 64), null);
});

// ── the link ────────────────────────────────────────────────────────────────────────────────

test('link: method presence is the capability; no API → never "runtime", nothing called', async () => {
  assert.equal(cursorRuntimeCapable(null), false);
  assert.equal(cursorRuntimeCapable({ setCursorDepth() {} }), false, 'both methods');
  assert.equal(cursorRuntimeCapable(fakeLayer()), true);
  const link = new CursorRuntimeLink();
  assert.equal(link.bind({ getViewport() {} }), false);
  assert.equal(link.support, 'none');
  assert.equal(link.report(0.5, 0.5, -3), false);
});

test('link: pending → "runtime"; the depth shape; one withdrawal; a new layer withdraws from the old', async () => {
  const a = fakeLayer('runtime');
  const link = new CursorRuntimeLink();
  assert.equal(link.bind(a), false, 'pending: not yet');
  assert.equal(link.support, 'pending');
  assert.equal(link.report(0.5, 0.5, -3), false, 'nothing sent while pending');
  assert.equal(a.calls.length, 0);
  await flush();
  assert.equal(link.bind(a), true);
  assert.equal(a.probes, 1, 'asked once');
  link.report(0.25, 0.75, -12.5);
  link.report(1.5, -0.2, null); // clamped to the element; no disparityPx = nothing 3D there
  assert.deepEqual(a.calls, [[{ u: 0.25, v: 0.75, disparityPx: -12.5 }], [{ u: 1, v: 0 }]]);
  link.withdraw();
  link.withdraw();
  assert.deepEqual(a.calls.at(-1), [], 'withdraw = setCursorDepth() with no argument');
  assert.equal(a.calls.length, 3, 'once per withdrawal, never per frame');
  // A second link on the same layer shares its answer (one probe per layer).
  const link2 = new CursorRuntimeLink();
  assert.equal(link2.bind(a), true);
  assert.equal(a.probes, 1);
  // A rebuilt layer: the old one is withdrawn from, the new one asked.
  link.report(0.5, 0.5, -1);
  const b = fakeLayer('runtime');
  link.bind(b);
  assert.deepEqual(a.calls.at(-1), []);
  assert.equal(b.probes, 1);
  link.dispose();
  assert.equal(b.calls.length, 0, 'nothing was sent to b, so nothing to withdraw');
});

test('link: "none" is re-asked at most every CURSOR_RUNTIME_RETRY_MS, CURSOR_RUNTIME_PROBES times; a rejection is "none"', async () => {
  let now = 1000;
  const realPerf = globalThis.performance;
  Object.defineProperty(globalThis, 'performance', { value: { now: () => now }, configurable: true, writable: true });
  try {
    let answer = 'none';
    const a = fakeLayer(() => Promise.resolve(answer));
    const link = new CursorRuntimeLink();
    link.bind(a);
    await flush();
    assert.equal(link.support, 'none');
    for (let i = 0; i < 10; i++) {
      now += 16;
      link.bind(a);
    }
    assert.equal(a.probes, 1, 'not re-asked inside the retry window');
    for (let i = 0; i < 40; i++) {
      now += CURSOR_RUNTIME_RETRY_MS;
      link.bind(a);
      await flush();
    }
    assert.equal(a.probes, CURSOR_RUNTIME_PROBES, 'bounded');
    // The browser answers "none" until its weave session is live: a later "runtime" is taken.
    answer = 'runtime';
    const c = fakeLayer(() => Promise.resolve(answer === 'runtime' && c.probes > 1 ? 'runtime' : 'none'));
    const l2 = new CursorRuntimeLink();
    l2.bind(c);
    await flush();
    assert.equal(l2.support, 'none');
    now += CURSOR_RUNTIME_RETRY_MS;
    l2.bind(c);
    await flush();
    assert.equal(l2.bind(c), true, 'the second answer turned it on');
    // Throws / rejects → "none", never an exception out of a frame.
    const bad = { setCursorDepth() { throw new Error('closed'); }, getCursorDepthSupport() { throw new Error('nope'); } };
    const l3 = new CursorRuntimeLink();
    assert.doesNotThrow(() => l3.bind(bad));
    await flush();
    assert.equal(l3.support, 'none');
  } finally {
    Object.defineProperty(globalThis, 'performance', { value: realPerf, configurable: true, writable: true });
  }
});

// ── ./three DepthCursor ─────────────────────────────────────────────────────────────────────

/** Drive a DepthCursor through: over content, off content, 2D, pointer leaves. */
async function driveDepthCursor(layer) {
  const canvas = stubCanvas();
  const cur = new DepthCursor(stubTHREE(), { canvas, hitTest });
  const frames = [];
  const step = (views, t) => {
    const p = cur.update(views, layer === undefined ? t : { nowMs: t, layer });
    frames.push({ p, visible: cur.object.visible, hidden: cssHidden(canvas) });
    return p;
  };
  step(VIEWS, 1000); // no pointer yet — starts the probe
  await flush();
  canvas.handlers.pointermove({ clientX: 50, clientY: 100 }); // u = 1/6, over the plane
  const over = step(VIEWS, 1016);
  step(VIEWS, 1032);
  cur.setPointer(0.75, 0.5); // off the content
  const off = step(VIEWS, 1048);
  step([VIEWS[0]], 1064); // 2D
  cur.setPointer(1 / 6, 0.5);
  step(VIEWS, 1080);
  canvas.handlers.pointerleave();
  step(VIEWS, 1096);
  step(VIEWS, 1112);
  return { cur, canvas, frames, over, off };
}

test('DepthCursor, support "runtime": never draws the sprite, never hides the CSS cursor, sends the RAW depth in device px', async () => {
  const layer = fakeLayer('runtime');
  const { cur, canvas, frames, over } = await driveDepthCursor(layer);
  assert.ok(frames.every((f) => !f.visible), 'the sprite is never visible');
  assert.ok(frames.every((f) => !f.hidden), 'the CSS cursor is never hidden');
  assert.equal(over.active, false);
  assert.equal(over.runtime, true);
  const sent = layer.calls;
  // over ×2, off, (2D → withdraw), over, (leave → withdraw); the second leave frame sends nothing.
  assert.equal(sent.length, 6, JSON.stringify(sent));
  const [o1, o2, off, w1, o3, w2] = sent;
  for (const [d] of [o1, o2, o3]) {
    near(d.u, 1 / 6, 1e-9);
    near(d.v, 0.5, 1e-9);
    // The footprint's nearest point on the plane: a plane parallel to the glass has ONE depth, so
    // the oracle at any point of it is the expected value, and it is the RAW one (no margin).
    near(d.disparityPx, oracleDisparityPx([-0.1, 0, PLANE_Z]), 1e-6);
    near(d.disparityPx, -12.8, 1e-6);
  }
  assert.deepEqual(off, [{ u: 0.75, v: 0.5 }], 'over the element, nothing 3D under it: no disparityPx');
  assert.deepEqual(w1, [], '2D withdraws');
  assert.deepEqual(w2, [], 'pointer off the element withdraws');
  cur.dispose();
  assert.equal(layer.calls.length, 6, 'already withdrawn: dispose sends nothing more');
  assert.equal(canvas.style.cursor, 'grab', "the page's cursor is never written");
});

test('DepthCursor, support "none" / no API / still pending: identical to today (SDK sprite + CSS hide)', async () => {
  const base = await driveDepthCursor(undefined); // today's call shape: update(views, nowMs)
  for (const layer of [fakeLayer('none'), { getViewport() {} }, fakeLayer(() => new Promise(() => {}))]) {
    const run = await driveDepthCursor(layer);
    assert.deepEqual(
      run.frames.map((f) => [f.p.active, f.visible, f.hidden, f.p.targetDisparity]),
      base.frames.map((f) => [f.p.active, f.visible, f.hidden, f.p.targetDisparity]),
    );
    assert.equal(run.over.active, true, 'the sprite is drawn over the content');
    assert.ok(run.frames.some((f) => f.hidden), 'and the CSS cursor hidden meanwhile');
    assert.equal((layer.calls || []).length, 0, 'nothing sent');
  }
});

test('DepthCursor: a layer that turns "runtime" mid-hover hands over at once — the sprite goes, the CSS cursor comes back', async () => {
  let resolve;
  const layer = fakeLayer(() => new Promise((r) => (resolve = r)));
  const canvas = stubCanvas();
  const cur = new DepthCursor(stubTHREE(), { canvas, hitTest });
  cur.setPointer(1 / 6, 0.5);
  cur.update(VIEWS, { nowMs: 1000, layer });
  cur.update(VIEWS, { nowMs: 1016, layer });
  assert.equal(cur.object.visible, true, 'pending: the fallback draws');
  assert.equal(cssHidden(canvas), true);
  resolve('runtime');
  await flush();
  cur.update(VIEWS, { nowMs: 1032, layer });
  assert.equal(cur.object.visible, false);
  assert.equal(cssHidden(canvas), false);
  assert.equal(layer.calls.length, 1);
});

// ── PlayCanvas cursor (./model, ./splat on the PlayCanvas engine) ──────────────────────────

function pcCursor() {
  const canvas = stubCanvas();
  const IDENT = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const viewer = { app: {}, rigNode: { getWorldTransform: () => ({ data: IDENT }) } };
  const cur = new PlayCanvasDepthCursor({}, viewer, { canvas });
  // The engine halves are stubbed: the pick (a GPU readback) and the sprite's mesh/material.
  const sprite = { mi: { visible: false }, node: { setLocalPosition() {}, setLocalRotation() {}, setLocalScale() {} } };
  let built = 0;
  cur._pick = () => {};
  cur._makeSprite = () => {
    built++;
    cur._sprite = sprite;
    return sprite;
  };
  cur._useSoft = () => {};
  cur._useSprite = () => {};
  cur.shapes.pick = () => ({ kind: 'shape', name: 'arrow' });
  const entries = VIEWS.map((v) => ({ proj: v.projectionMatrix, pose: v.transformMatrix, width: 150, height: 200 }));
  return { cur, canvas, sprite, entries, built: () => built };
}

test('PlayCanvas cursor, support "runtime": no sprite is ever built, the RAW depth goes to the layer', async () => {
  const layer = fakeLayer('runtime');
  const { cur, canvas, entries, built } = pcCursor();
  cur.frame(entries, layer);
  await flush();
  cur.pointer.set(1 / 6, 0.5);
  cur.hit = [-0.1, 0, PLANE_Z];
  cur.frame(entries, layer);
  cur.frame(entries, layer);
  assert.equal(built(), 0, 'no sprite');
  assert.equal(cssHidden(canvas), false);
  assert.equal(cur.placement.runtime, true);
  near(layer.calls[0][0].disparityPx, oracleDisparityPx([-0.1, 0, PLANE_Z]), 1e-6);
  cur.hit = null;
  cur.frame(entries, layer);
  assert.deepEqual(layer.calls.at(-1), [{ u: 1 / 6, v: 0.5 }]);
  cur.inactive(); // mono
  assert.deepEqual(layer.calls.at(-1), []);
  const n = layer.calls.length;
  cur.inactive();
  assert.equal(layer.calls.length, n, 'one withdrawal');
});

test('PlayCanvas cursor, support "none" / no layer: today\'s sprite and CSS hide', async () => {
  for (const layer of [fakeLayer('none'), null]) {
    const { cur, canvas, sprite, entries, built } = pcCursor();
    cur.frame(entries, layer);
    await flush();
    cur.pointer.set(1 / 6, 0.5);
    cur.hit = [-0.1, 0, PLANE_Z];
    cur.frame(entries, layer);
    cur.frame(entries, layer);
    assert.equal(built(), 1);
    assert.equal(sprite.mi.visible, true);
    assert.equal(cssHidden(canvas), true);
    assert.equal(cur.placement.active, true);
    assert.equal(layer?.calls.length ?? 0, 0);
  }
});

// ── the stereo-pair cursor (./call, ./camera) ──────────────────────────────────────────────

/** A uniform SBS luma pair whose content sits `d` output px crossed (the pair-cursor test's builder, uniform case). */
function uniformPair(E, Hh, d, seed = 7) {
  const Wd = 2 * E;
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const tex = new Uint8Array((E + 64) * Hh);
  for (let y = 0; y < Hh; y += 2) for (let x = 0; x < E + 64; x += 2) {
    const v = 20 + Math.floor(rnd() * 210);
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) if (y + dy < Hh && x + dx < E + 64) tex[(y + dy) * (E + 64) + x + dx] = v;
  }
  const img = new Uint8Array(Wd * Hh);
  for (let y = 0; y < Hh; y++) for (let x = 0; x < E; x++) {
    img[y * Wd + x] = tex[y * (E + 64) + x + 32];
    img[y * Wd + E + x] = tex[y * (E + 64) + x + d + 32];
  }
  return { img, w: Wd, h: Hh, scale: 1 };
}

function recordingCtx() {
  const ops = [];
  return { ops, save() {}, restore() {}, rect() {}, clip() {}, closePath() {}, stroke() {}, beginPath() {}, moveTo() {}, lineTo() {}, fill() { ops.push('fill'); }, drawImage() { ops.push('image'); }, putImageData() {} };
}

test('pair cursor, support "runtime" on the tile handle: nothing drawn into the pair, the matched depth in device px', async () => {
  const E = 240, Hh = 135;
  const full = { sx: 0, sy: 0, sw: E, sh: Hh };
  const canvas = doc.createElement('canvas');
  canvas.style = { cursor: 'pointer' };
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 384, height: 216 });
  const handle = fakeLayer('runtime'); // a tile handle forwards the same two methods
  const cur = new PairCursor(canvas, { pointerScope: 'canvas', shape: 'arrow', soften: 'off' });
  const geo = { rL: full, rR: full, outW: E, outH: Hh, handle };
  const g = recordingCtx();
  const pair = uniformPair(E, Hh, 12);
  cur.draw(g, pair, geo, 1);
  await flush();
  cur.pointer.set(0.5, 0.5);
  for (const t of [1.1, 1.2, 1.3]) cur.draw(g, pair, geo, t);
  assert.equal(g.ops.length, 0, 'nothing drawn into the woven pair');
  assert.equal(canvas.hasAttribute('data-inline3d-cursor-hidden'), false);
  const [d] = handle.calls.at(-1);
  near(d.u, 0.5, 1e-9);
  // 12 output px crossed, one output px = 384 CSS px / 240 = 1.6 device px at dpr 1 → −19.2.
  near(d.disparityPx, -12 * (384 / E), 0.6, 'raw, crossed < 0');
  assert.equal(cur.last.runtime, true);
  cur.pointer.set(null);
  cur.draw(g, pair, geo, 1.4);
  assert.deepEqual(handle.calls.at(-1), [], 'pointer gone → withdrawn');
  // "none": the arrow is drawn into both halves, the CSS cursor hidden — today's behaviour.
  const none = fakeLayer('none');
  const cur2 = new PairCursor(canvas, { pointerScope: 'canvas', shape: 'arrow', soften: 'off' });
  const geo2 = { ...geo, handle: none };
  cur2.draw(g, pair, geo2, 1);
  await flush();
  cur2.pointer.set(0.5, 0.5);
  let last;
  for (const t of [1.1, 1.2, 1.3]) last = cur2.draw(g, pair, geo2, t);
  assert.equal(last.drawn, true);
  assert.ok(g.ops.length > 0, 'the arrow is drawn');
  assert.equal(canvas.hasAttribute('data-inline3d-cursor-hidden'), true);
  assert.equal(none.calls.length, 0);
  cur2.dispose();
  cur.dispose();
});

test('policy stays in the runtime: the SDK never sends a margin-shifted or clamped value', () => {
  // The margin and the clamp are the runtime's; a page that pre-applied them would double them.
  const placer = new CursorDepthPlacer();
  const far = [-0.05, 0, 0.5]; // far out of the glass: past the −0.6 clamp
  const p = placer.update(VIEWS, { u: 1 / 3, v: 0.5, nearestPoint: far, canvasPx: 200 }, 1);
  assert.ok(p.contentDisparity < T.minDisparity, 'beyond the comfort clamp');
  near(p.contentDisparityPx, oracleDisparityPx(far), 1e-6, 'sent unclamped');
});

// ── touch (1.45.1): a finger or a pen in contact is no hover → uv null → the runtime depth is withdrawn ──

test('touch on the runtime path: a finger (move or bare tap) or a pen in contact withdraws the depth; a mouse brings it back', async () => {
  const layer = fakeLayer('runtime');
  const canvas = stubCanvas();
  const cur = new DepthCursor(stubTHREE(), { canvas, hitTest });
  cur.update(VIEWS, { nowMs: 1000, layer });
  await flush();
  const mouse = (x) => canvas.handlers.pointermove({ clientX: x, clientY: 100, pointerType: 'mouse' });
  const sent = () => layer.calls.at(-1);
  mouse(50);
  cur.update(VIEWS, { nowMs: 1016, layer });
  near(sent()[0].disparityPx, -12.8, 1e-6, 'mouse over the content: depth sent');
  let t = 1032;
  for (const ev of [
    ['pointermove', { clientX: 60, clientY: 100, pointerType: 'touch', buttons: 1 }],
    ['pointerdown', { clientX: 50, clientY: 100, pointerType: 'touch', buttons: 1 }], // a tap that never moves
    ['pointermove', { clientX: 50, clientY: 100, pointerType: 'pen', buttons: 1 }],
  ]) {
    const n = layer.calls.length;
    canvas.handlers[ev[0]](ev[1]);
    cur.update(VIEWS, { nowMs: (t += 16), layer });
    assert.deepEqual(sent(), [], `${ev[1].pointerType} ${ev[0]}: setCursorDepth() — withdrawn`);
    assert.equal(layer.calls.length, n + 1, 'exactly one withdrawal');
    cur.update(VIEWS, { nowMs: (t += 16), layer });
    assert.equal(layer.calls.length, n + 1, 'and nothing more while the finger is down');
    assert.equal(cur.object.visible, false);
    assert.equal(cssHidden(canvas), false);
    mouse(50);
    cur.update(VIEWS, { nowMs: (t += 16), layer });
    near(sent()[0].disparityPx, -12.8, 1e-6, 'a mouse again: the depth is back');
  }
  // A HOVERING pen (no buttons) counts as a pointer, like the mouse.
  canvas.handlers.pointermove({ clientX: 50, clientY: 100, pointerType: 'pen', buttons: 0 });
  cur.update(VIEWS, { nowMs: (t += 16), layer });
  near(sent()[0].disparityPx, -12.8, 1e-6);
  cur.dispose();
});

test('touch on the runtime path: PlayCanvas and pair cursors withdraw too (they share CursorPointer)', async () => {
  // PlayCanvas
  const layer = fakeLayer('runtime');
  const { cur, canvas, entries } = pcCursor();
  cur.frame(entries, layer);
  await flush();
  canvas.handlers.pointermove({ clientX: 50, clientY: 100, pointerType: 'mouse' });
  cur.hit = [-0.1, 0, PLANE_Z];
  cur.frame(entries, layer);
  assert.ok(layer.calls.at(-1)[0].disparityPx < 0);
  canvas.handlers.pointerdown({ clientX: 50, clientY: 100, pointerType: 'touch', buttons: 1 });
  cur.frame(entries, layer);
  assert.deepEqual(layer.calls.at(-1), []);
  // Pair
  const E = 240, Hh = 135;
  const full = { sx: 0, sy: 0, sw: E, sh: Hh };
  const pc2 = doc.createElement('canvas');
  pc2.style = {};
  pc2.getBoundingClientRect = () => ({ left: 0, top: 0, width: 384, height: 216 });
  const handlers = {};
  const lists = {};
  pc2.addEventListener = (k, f) => {
    (lists[k] ||= []).push(f);
    handlers[k] = (e) => lists[k].forEach((g) => g(e));
  };
  pc2.removeEventListener = () => {};
  const handle = fakeLayer('runtime');
  const pair = new PairCursor(pc2, { pointerScope: 'canvas', shape: 'arrow', soften: 'off' });
  const geo = { rL: full, rR: full, outW: E, outH: Hh, handle };
  const g = recordingCtx();
  const luma = uniformPair(E, Hh, 12);
  pair.draw(g, luma, geo, 1);
  await flush();
  handlers.pointermove({ clientX: 192, clientY: 108, pointerType: 'mouse' });
  pair.draw(g, luma, geo, 1.1);
  assert.ok(handle.calls.at(-1)[0].disparityPx < 0);
  handlers.pointermove({ clientX: 192, clientY: 108, pointerType: 'touch', buttons: 1 });
  pair.draw(g, luma, geo, 1.2);
  assert.deepEqual(handle.calls.at(-1), []);
  assert.equal(g.ops.length, 0);
});

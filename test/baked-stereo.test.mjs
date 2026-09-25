// Baked stereo follows the RUNTIME'S tracking state (see Inline3D#_trackBakedStereo).
//
// `XRSession.trackingState` ('tracking' | 'searching' | 'unknown', DisplayXR Browser patch 0195)
// is the only input, and only with `untrackedFallback: 'mono'` (the MANUAL eye-tracking mode's
// page-side duty): 'searching' eases image/video tiles to flat, 'tracking' eases them back,
// 'unknown' and a browser without the attribute leave them alone. The default 'none' — right for
// MANAGED displays like Leia, where the vendor already goes 2D — changes nothing. What is pinned here is the
// paint's control flow: the full SBS pair, the left eye in BOTH halves, and the blend between.
//
// Recording stubs, no jsdom, same approach as teardown-mono.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';

function makeCanvas(w = 300, h = 150) {
  const canvas = {
    style: {},
    width: 0,
    height: 0,
    clientWidth: w,
    clientHeight: h,
    parentElement: null,
    contains: () => false,
    getBoundingClientRect: () => ({ x: 0, y: 0, width: w, height: h, right: w, bottom: h, left: 0, top: 0 }),
    getContext() {
      return this.ctx;
    },
  };
  canvas.ctx = {
    canvas,
    draws: [],
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    save() {},
    restore() {
      this.globalAlpha = 1;
    },
    clearRect() {
      this.draws = [];
    },
    drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh) {
      this.draws.push({ sx, sw, dx, dw, alpha: this.globalAlpha });
    },
  };
  return canvas;
}

let frameCb = null;
function installEnv({ withTracking = true } = {}) {
  class FakeDisplayLayer {
    constructor(session, canvas) {
      this.canvas = canvas;
    }
    getViewport() {
      return { x: 0, y: 0, width: 150, height: 150 };
    }
    close() {}
  }
  const session = {
    trackingState: withTracking ? 'unknown' : undefined, // a 0195 browser starts at 'unknown'
    addEventListener() {},
    removeEventListener() {},
    requestReferenceSpace: async () => ({}),
    requestAnimationFrame(cb) {
      frameCb = cb;
      return 1;
    },
    end() {},
  };
  Object.defineProperty(globalThis, 'navigator', {
    value: { xr: { requestSession: async () => session } },
    configurable: true,
    writable: true,
  });
  globalThis.window = { XRDisplayLayer: FakeDisplayLayer, devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} };
  globalThis.XRDisplayLayer = FakeDisplayLayer;
  globalThis.document = undefined;
  globalThis.IntersectionObserver = undefined;
  return session;
}

/** One session frame whose two eyes are `sep` apart (metres, along x), at frame time `t` ms. */
function runFrame(sep, views = 2, t = 0) {
  const cb = frameCb;
  frameCb = null;
  assert.ok(cb, 'the manager should have a session frame armed');
  const eye = (x) => ({ transform: { position: { x, y: 0, z: 0.6 } } });
  const list = views === 2 ? [eye(-sep / 2), eye(sep / 2)] : [eye(0)];
  cb(t, { getViewerPose: () => ({ views: list }) });
}

let session = installEnv();
const { createInline3D } = await import('../js/inline3d.js');
const flush = () => new Promise((r) => setTimeout(r, 0));

async function videoWall({ fallback = 'mono', withTracking = true } = {}) {
  session = installEnv({ withTracking });
  const wall = await createInline3D({ lazy: false, autoChrome: false, untrackedFallback: fallback });
  const canvas = makeCanvas();
  wall.addVideo(canvas, { readyState: 4, videoWidth: 800, videoHeight: 200 });
  await flush();
  return { wall, canvas, session };
}

/** Classify the last paint: 'sbs' (one stretched draw of the whole pair) or a flattened one. */
function paint(canvas) {
  const d = canvas.ctx.draws;
  if (d.length === 1 && d[0].sw === 800) return { kind: 'sbs' };
  // L into the left half, L into the right half, then (optionally) R over it at some alpha.
  assert.equal(d[0].sx, 0, 'left half must be the left eye');
  assert.equal(d[1].sx, 0, 'right half must START from the left eye');
  assert.equal(d[1].dx, canvas.width / 2);
  const r = d[2];
  if (!r) return { kind: 'flat' };
  assert.equal(r.sx, 400, 'the blended draw must be the right eye');
  return { kind: 'blend', alpha: r.alpha };
}

const EASE_MS = 300; // the mode switch's default duration

/** Run frames 16 ms apart for `ms` of frame time, starting at `t0`; returns the end time. */
function runFor(ms, t0, sep = 0.063) {
  let t = t0;
  for (; t < t0 + ms; t += 16) runFrame(sep, 2, t);
  runFrame(sep, 2, t);
  return t;
}

test("'searching' eases image/video tiles to flat; 'tracking' eases them back", async () => {
  const { canvas, session: s } = await videoWall();
  s.trackingState = 'tracking';
  let t = runFor(50, 0);
  assert.equal(paint(canvas).kind, 'sbs');
  s.trackingState = 'searching';
  t = runFor(Math.round(EASE_MS / 2), t + 16);
  assert.equal(paint(canvas).kind, 'blend', 'mid-ease: the right eye is part-way to the left');
  t = runFor(EASE_MS * 2, t + 16);
  assert.equal(paint(canvas).kind, 'flat', 'eased all the way: the left eye in both halves');
  s.trackingState = 'tracking';
  t = runFor(EASE_MS * 2, t + 16);
  assert.equal(paint(canvas).kind, 'sbs', 'and back to the full pair');
});

test("'unknown' leaves it alone — never read as flat — in either direction", async () => {
  const { canvas, session: s } = await videoWall();
  s.trackingState = 'unknown';
  let t = runFor(EASE_MS * 2, 0);
  assert.equal(paint(canvas).kind, 'sbs', 'a first frame / no display yet is not flat');
  s.trackingState = 'searching';
  t = runFor(EASE_MS * 2, t + 16);
  s.trackingState = 'unknown';
  t = runFor(EASE_MS * 2, t + 16);
  assert.equal(paint(canvas).kind, 'flat', "'unknown' after 'searching' holds flat rather than guessing");
});

test('a browser without trackingState changes nothing', async () => {
  const { canvas } = await videoWall({ withTracking: false });
  runFor(EASE_MS * 2, 0, 0); // eyes coincide — the old guess would have gone flat
  assert.equal(paint(canvas).kind, 'sbs');
});

test('the eye views are not an input any more: separation alone never flattens', async () => {
  const { canvas, session: s } = await videoWall();
  s.trackingState = 'tracking';
  let t = runFor(EASE_MS, 0, 0.063);
  t = runFor(EASE_MS * 3, t + 16, 0); // views coincide while the runtime still says tracked
  assert.equal(paint(canvas).kind, 'sbs');
});

test('a single-view frame changes nothing (a per-frame fallback under load)', async () => {
  const { canvas, session: s } = await videoWall();
  s.trackingState = 'tracking';
  runFrame(0.063, 1, 0);
  runFrame(0.063, 1, 400);
  assert.equal(paint(canvas).kind, 'sbs');
});

test("the default untrackedFallback:'none' never flattens — MANAGED displays go 2D themselves", async () => {
  const { canvas, session: s, wall } = await videoWall({ fallback: 'none' });
  s.trackingState = 'searching';
  runFor(EASE_MS * 3, 0);
  assert.equal(wall.trackingState, 'searching', 'the state is still reported');
  assert.equal(paint(canvas).kind, 'sbs', 'but the pixels are untouched');
});

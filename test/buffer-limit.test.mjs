// The device-limit clamp on woven backing stores (./js/inline3d-buffer-limit.js).
//
// Measured on an Android 3D tablet (Adreno 740, DisplayXR Browser 154): a full-screen SBS canvas
// at renderScale 1 asked for 5120×1348. MAX_TEXTURE_SIZE there is 4096 (a Chromium driver
// workaround), the browser silently clamped the drawing buffer to 4096 wide, getViewport() kept
// splitting canvas.width (2560 per eye), and the eye boundary landed at 62.5% of the buffer while
// the weave split it at 50%: a large double image, nothing logged.
//
// The fake GL below reports MAX_TEXTURE_SIZE 4096 and, like the browser, clamps its drawing
// buffer to what it can hold.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installDom, makeCanvas, makeTHREE, makeViews, makeLayer } from './stubs.mjs';
import {
  glBufferLimits,
  clampEyeBuffer,
  clampWarning,
  bufferScale,
} from '../js/inline3d-buffer-limit.js';

installDom();
const { SceneViewer } = await import('../js/inline3d-viewer.js');
const { EyeCamera } = await import('../js/inline3d-three.js');
const { PlayCanvasSplatViewer } = await import('../js/inline3d-splat-playcanvas.js');

const MAX_TEXTURE_SIZE = 0x0d33;
const MAX_RENDERBUFFER_SIZE = 0x84e8;
const MAX_VIEWPORT_DIMS = 0x0d3a;

/**
 * A GL context stub. `report` is what getParameter answers; `clampTo` is what the drawing buffer
 * is really clamped to (the browser's behaviour). They differ only in the "unpredicted" test.
 */
function makeGl(canvas, { tex = 4096, rb = 16384, vp = [16384, 16384], clampTo = tex } = {}) {
  const gl = {
    MAX_TEXTURE_SIZE,
    MAX_RENDERBUFFER_SIZE,
    MAX_VIEWPORT_DIMS,
    queries: 0,
    getParameter(p) {
      this.queries++;
      if (p === MAX_TEXTURE_SIZE) return tex;
      if (p === MAX_RENDERBUFFER_SIZE) return rb;
      if (p === MAX_VIEWPORT_DIMS) return Int32Array.from(vp);
      return 0;
    },
    get drawingBufferWidth() {
      return Math.min(canvas.width, clampTo);
    },
    get drawingBufferHeight() {
      return Math.min(canvas.height, clampTo);
    },
  };
  return gl;
}

function captureWarnings(fn) {
  const real = console.warn;
  const calls = [];
  console.warn = (...a) => calls.push(a.join(' '));
  try {
    fn();
  } finally {
    console.warn = real;
  }
  return calls;
}

// ── the helper ──────────────────────────────────────────────────────────────────────────────

test('clampEyeBuffer: a 2560-wide eye on a 4096 device clamps to 2048 per eye, height scaled by the same factor', () => {
  const lim = glBufferLimits(makeGl({ width: 0, height: 0 }));
  const c = clampEyeBuffer(2560, 1348, lim);
  assert.equal(c.clamped, true);
  assert.equal(c.eyeW, 2048);
  assert.equal(c.eyeH, 1078); // floor(1348 × 0.8)
  assert.equal(c.bufW, 4096);
  assert.equal(c.bufH, 1078);
  assert.equal(c.scale, 0.8);
  assert.equal(c.limitName, 'MAX_TEXTURE_SIZE');
  // Eye aspect preserved (to the rounding of one row).
  assert.ok(Math.abs(c.eyeW / c.eyeH - 2560 / 1348) < 2 / 1078);
});

test('clampEyeBuffer: a store that fits is untouched; mono (cols 1) fits where SBS does not', () => {
  const lim = glBufferLimits(makeGl({ width: 0, height: 0 }));
  assert.deepEqual(
    [clampEyeBuffer(2000, 1000, lim).eyeW, clampEyeBuffer(2000, 1000, lim).clamped],
    [2000, false],
  );
  const mono = clampEyeBuffer(2560, 1348, lim, { cols: 1 });
  assert.equal(mono.clamped, false);
  assert.equal(mono.bufW, 2560);
});

test('glBufferLimits: the smallest of the three limits wins, per axis, and is queried once per context', () => {
  const gl = makeGl({ width: 0, height: 0 }, { tex: 16384, rb: 8192, vp: [16384, 4096] });
  const a = glBufferLimits(gl);
  assert.deepEqual([a.maxW, a.nameW, a.maxH, a.nameH], [8192, 'MAX_RENDERBUFFER_SIZE', 4096, 'MAX_VIEWPORT_DIMS']);
  const q = gl.queries;
  glBufferLimits(gl);
  assert.equal(gl.queries, q, 'cached per context');
  // Height-bound: a tall eye shrinks on the height limit, width by the same factor.
  const c = clampEyeBuffer(1000, 8192, a);
  assert.equal(c.eyeH, 4096);
  assert.equal(c.eyeW, 500);
  assert.equal(c.limitName, 'MAX_VIEWPORT_DIMS');
});

test('the warning names the store, the limit, the result and the renderScale request vs effective', () => {
  const c = clampEyeBuffer(2560, 1348, glBufferLimits(makeGl({ width: 0, height: 0 })));
  assert.equal(
    clampWarning('[inline3d/splat]', c, 1),
    '[inline3d/splat] SBS buffer 5120×1348 exceeds MAX_TEXTURE_SIZE 4096 on this device; rendering at 4096×1078 (renderScale 1 → 0.8).',
  );
});

// ── SceneViewer (./viewer, ./splat on Spark, ./model on three) ────────────────────────────────

function sceneViewer({ box = [2560, 1348], gl: glOpts } = {}) {
  const { THREE, log } = makeTHREE();
  const canvas = makeCanvas(...box);
  const viewer = new SceneViewer(THREE, canvas, { orbit: false, logTag: '[inline3d/splat]' });
  viewer.useEyeCamera(EyeCamera);
  const gl = makeGl(canvas, glOpts);
  viewer.renderer.getContext = () => gl;
  return { viewer, canvas, log, gl };
}

test('SceneViewer: a full-screen SBS request past MAX_TEXTURE_SIZE is clamped BEFORE sizing; renderScale reports 0.8', () => {
  const { viewer, canvas } = sceneViewer();
  const warns = captureWarnings(() => viewer._resize());
  assert.equal(canvas.width, 4096);
  assert.equal(canvas.height, 1078);
  assert.equal(viewer.renderScale, 1, 'the request is kept as given');
  assert.equal(viewer.effectiveRenderScale, 0.8);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /SBS buffer 5120×1348 exceeds MAX_TEXTURE_SIZE 4096.*4096×1078 \(renderScale 1 → 0\.8\)/);
});

test('SceneViewer: the clamp warns ONCE per viewer, however often the box changes', () => {
  const { viewer, canvas } = sceneViewer();
  const warns = captureWarnings(() => {
    viewer._resize();
    canvas.setBox(2600, 1400);
    viewer._resize();
    canvas.setBox(2560, 1348);
    viewer._resize();
  });
  assert.equal(warns.length, 1);
});

test('SceneViewer: the eye split lands at exactly 50% of the real buffer after the clamp', () => {
  const { viewer, canvas, log } = sceneViewer();
  captureWarnings(() => viewer._resize());
  const vps = [];
  const real = viewer.renderer.setViewport.bind(viewer.renderer);
  viewer.renderer.setViewport = (x, y, w, h) => {
    vps.push({ x, y, w, h });
    real(x, y, w, h);
  };
  viewer.onFrame(makeViews(2), makeLayer(canvas));
  assert.deepEqual(vps, [
    { x: 0, y: 0, w: 2048, h: 1078 },
    { x: 2048, y: 0, w: 2048, h: 1078 },
  ]);
  assert.equal(vps[1].x / 4096, 0.5);
  assert.equal(log.render.length, 2);
});

test('SceneViewer: a drawing buffer the browser clamped anyway is laid out from the drawing buffer, never canvas.width/2', () => {
  // The GL claims 16384 (so no clamp is predicted) but the drawing buffer really stops at 4096.
  const { viewer, canvas } = sceneViewer({ gl: { tex: 16384, clampTo: 4096 } });
  let warns = captureWarnings(() => viewer._resize());
  assert.equal(canvas.width, 5120, 'no clamp was predicted');
  assert.equal(warns.length, 1, 'the unpredicted clamp is named once');
  assert.match(warns[0], /clamped this canvas's drawing buffer to 4096×1348 .*5120×1348/);
  const vps = [];
  viewer.renderer.setViewport = (x, y, w, h) => vps.push({ x, w });
  warns = captureWarnings(() => {
    viewer.onFrame(makeViews(2), makeLayer(canvas));
    viewer.onFrame(makeViews(2), makeLayer(canvas));
  });
  assert.equal(warns.length, 0, 'still once per viewer');
  // getViewport() said 0..2560 | 2560..5120; the real buffer is 4096 wide.
  assert.deepEqual(vps.slice(0, 2), [
    { x: 0, w: 2048 },
    { x: 2048, w: 2048 },
  ]);
  // The replay path maps the same way.
  vps.length = 0;
  viewer._replayLastGood();
  assert.deepEqual(vps, [
    { x: 0, w: 2048 },
    { x: 2048, w: 2048 },
  ]);
});

test('SceneViewer: mono (the 2D tier) clamps with ONE eye across and draws the whole real buffer', () => {
  const { viewer, canvas } = sceneViewer({ box: [5000, 2000] });
  const vps = [];
  viewer.renderer.setViewport = (x, y, w, h) => vps.push({ w, h });
  captureWarnings(() => viewer.startMono());
  assert.equal(canvas.width, 4096, 'a 5000-wide mono store is clamped too');
  assert.equal(canvas.height, Math.floor(2000 * (4096 / 5000)));
  viewer.stopMono();
});

// ── PlayCanvasSplatViewer (./splat engine:'playcanvas', ./model engine:'playcanvas') ──────────

function pcViewer({ box = [2560, 1348], gl: glOpts } = {}) {
  const canvas = makeCanvas(...box);
  const viewer = new PlayCanvasSplatViewer(canvas, { orbit: false });
  const gl = makeGl(canvas, glOpts);
  viewer.app = { graphicsDevice: { gl } }; // just the context — the resize never ticks the engine
  return { viewer, canvas, gl };
}

test('PlayCanvasSplatViewer: clamps to MAX_TEXTURE_SIZE before sizing, reports 0.8, warns once as [inline3d/splat]', () => {
  const { viewer, canvas } = pcViewer();
  viewer._replayLastGood = () => false;
  const warns = captureWarnings(() => {
    viewer._resize();
    canvas.setBox(2600, 1400);
    viewer._resize();
  });
  assert.equal(viewer.renderScale, 1);
  assert.ok(Math.abs(viewer.effectiveRenderScale - 4096 / 5200) < 1e-9);
  assert.equal(canvas.width, 4096);
  assert.equal(warns.length, 1);
  assert.match(
    warns[0],
    /^\[inline3d\/splat\] SBS buffer 5120×1348 exceeds MAX_TEXTURE_SIZE 4096 on this device; rendering at 4096×1078 \(renderScale 1 → 0\.8\)\.$/,
  );
});

test('PlayCanvasSplatViewer: an unpredicted drawing-buffer clamp maps the entries onto the drawing buffer', () => {
  const { viewer, canvas } = pcViewer({ gl: { tex: 16384, clampTo: 4096 } });
  viewer._replayLastGood = () => false;
  captureWarnings(() => viewer._resize());
  assert.equal(canvas.width, 5120);
  // A frame cached in getViewport()'s space (canvas.width) draws into the 4096-wide buffer.
  const { sx, sy, b } = viewer._entryScale({ bufW: 5120, bufH: 1348 });
  assert.equal(b.w, 4096);
  assert.equal(sx, 0.8);
  assert.equal(sy, 1);
  assert.equal(2560 * sx, 2048, 'the right eye starts at exactly 50%');
});

test('bufferScale: identity when the drawing buffer matches canvas.width/height (2D canvas: no GL)', () => {
  const c = { width: 4096, height: 1078 };
  assert.deepEqual(bufferScale(c, null), { sx: 1, sy: 1, w: 4096, h: 1078, mismatch: false });
  assert.equal(bufferScale(c, makeGl(c)).mismatch, false);
});

test('splat handle (engine:playcanvas): renderScale reports the value in force, renderScaleRequested the request', async () => {
  const { attachPlayCanvasSplat } = await import('../js/inline3d-splat-playcanvas.js');
  const out = {};
  const canvas = makeCanvas(2560, 1348);
  // No engine: enough to build the handle and its viewer, which is all this test reads.
  const noEngine = { createGraphicsDevice: async () => Promise.reject(new Error('no engine in this test')) };
  const realErr = console.error;
  console.error = () => {};
  const warns = [];
  const realWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    await attachPlayCanvasSplat(out, null, canvas, 'a.sog', { playcanvas: noEngine }, []).catch(() => {});
    const viewer = out.viewer;
    viewer._disposed = false;
    viewer._mode = '3d'; // the failed load took it to mono; the woven store is what is under test
    viewer._replayLastGood = () => false;
    viewer.app = { graphicsDevice: { gl: makeGl(canvas) } };
    viewer._resize();
    assert.equal(out.renderScale, 0.8, 'effective, not the request');
    assert.equal(out.renderScaleRequested, 1);
    out.setRenderScale(0.5); // 1280-px eyes: 2560 wide, fits
    viewer._resize();
    assert.equal(out.renderScaleRequested, 0.5);
    assert.equal(out.renderScale, 0.5);
    assert.equal(canvas.width, 2560);
    assert.equal(warns.filter((w) => w.includes('exceeds MAX_TEXTURE_SIZE')).length, 1);
  } finally {
    console.error = realErr;
    console.warn = realWarn;
  }
});

// Tests for the source-resolution cap on image/video backing buffers.
//
// Measured on an NP02J tablet (DisplayXR Browser 1.0.6): the player sample's 90vw tile at dpr 2
// got a 4608x1296 SBS buffer for a 640x360-per-eye clip — 13x the source's pixels, redrawn every
// frame — and fell to 25 fps with half its video frames dropped. The cap sizes the buffer to the
// source's own per-eye resolution (keeping the box aspect), never larger than box x dpr.
//
// Environment below is copied from teardown-mono.test.mjs (recording stubs, no jsdom).
import test from 'node:test';
import assert from 'node:assert/strict';

// ── environment ─────────────────────────────────────────────────────────────────────────

/** A recording 2D context: enough for _paint / _recommitLastFrame, and nothing else. */
function makeCtx(canvas) {
  return {
    canvas,
    draws: [],
    clears: [],
    globalCompositeOperation: 'source-over',
    save() {},
    restore() {
      this.globalCompositeOperation = 'source-over';
    },
    clearRect(x, y, w, h) {
      this.clears.push({ x, y, w, h });
    },
    drawImage(src, ...rest) {
      // Both shapes the SDK uses: drawImage(src, dx, dy) for the self re-commit, and the
      // 9-argument source-rect form for every real paint.
      const nine = rest.length === 8;
      this.draws.push({
        src,
        sw: nine ? rest[2] : undefined,
        dw: nine ? rest[6] : undefined,
        op: this.globalCompositeOperation,
      });
    },
  };
}

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
  canvas.ctx = makeCtx(canvas);
  return canvas;
}

/** A still SBS photo, already decoded (addImage takes a non-string source as-is). */
const makeImg = () => ({ naturalWidth: 800, naturalHeight: 200 });
/** A video element stub. `readyState` 4 = has a current frame; 1 = metadata only (buffering). */
const makeVideo = (readyState = 4) => ({ readyState, videoWidth: 800, videoHeight: 200 });

/** Install the globals createInline3D touches, and hand back the levers to drive them. */
function installEnv({ throwOnConstruct = false } = {}) {
  const created = [];
  class FakeDisplayLayer {
    constructor(session, canvas) {
      if (throwOnConstruct) throw new TypeError('canvas is not an HTMLCanvasElement');
      this.canvas = canvas;
      this.closed = false;
      created.push(this);
    }
    getViewport() {
      return { x: 0, y: 0, width: 150, height: 150 };
    }
    close() {
      this.closed = true;
    }
  }
  const listeners = new Map();
  let frameCb = null;
  const session = {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
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
  globalThis.window = {
    XRDisplayLayer: FakeDisplayLayer,
    devicePixelRatio: 1,
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.XRDisplayLayer = FakeDisplayLayer;
  globalThis.document = undefined;
  globalThis.IntersectionObserver = undefined;
  const images = [];
  globalThis.Image = class {
    constructor() {
      this.naturalWidth = 800;
      this.naturalHeight = 200;
      images.push(this);
    }
  };
  return {
    session,
    created,
    images,
    fire(type) {
      for (const fn of listeners.get(type) ?? []) fn({ type });
    },
    /** Run the session frame the manager is waiting on, with a two-view pose. */
    runFrame() {
      const cb = frameCb;
      frameCb = null;
      assert.ok(cb, 'the manager should have a session frame armed');
      cb(0, { getViewerPose: () => ({ views: [{ eye: 'left' }, { eye: 'right' }] }) });
    },
  };
}

/** Let the SDK's unawaited async work (the image load, the first mode read) settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

/** Run `fn` with console.warn captured; returns the calls. */
async function captureWarnings(fn) {
  const real = console.warn;
  const calls = [];
  console.warn = (...args) => calls.push(args);
  try {
    await fn(calls);
  } finally {
    console.warn = real;
  }
  return calls;
}

installEnv();
const { createInline3D } = await import('../js/inline3d.js');

const newWall = () => createInline3D({ lazy: false, autoChrome: false });

/** The last thing painted into this canvas: a mono paint takes HALF the source (one eye). */
function lastDraw(canvas) {
  return canvas.ctx.draws[canvas.ctx.draws.length - 1];
}


const vid = (w, h, readyState = 4) => ({ readyState, videoWidth: w, videoHeight: h });

test('a big box over a small SBS video is capped at the source per-eye size, box aspect kept', async () => {
  const env = installEnv();
  globalThis.window.devicePixelRatio = 2;
  const wall = await newWall();
  const c = makeCanvas(1152, 648); // the player sample's 90vw tile on a 1280-wide tablet
  wall.addVideo(c, vid(1280, 360)); // 640x360 per eye
  await flush();
  env.runFrame();
  const win = wall._windows.get(c);
  assert.equal(win.sbs, true);
  assert.equal(c.width, 1280, 'two 640-px eyes, not 2 x 2304');
  assert.equal(c.height, 360);
  assert.ok(Math.abs(win.bufScale - 640 / 2304) < 1e-9);
  globalThis.window.devicePixelRatio = 1;
});

test('a box smaller than the source is NOT enlarged — the cap only shrinks', async () => {
  const env = installEnv();
  const wall = await newWall();
  const c = makeCanvas(300, 150);
  wall.addVideo(c, vid(3840, 1080)); // 1920x1080 per eye, far above the box
  await flush();
  env.runFrame();
  assert.equal(c.width, 600);
  assert.equal(c.height, 150);
  assert.equal(wall._windows.get(c).bufScale, 1);
});

test('a box aspect unlike the source keeps the BOX aspect and every source pixel on the filling axis', async () => {
  const env = installEnv();
  const wall = await newWall();
  const c = makeCanvas(2000, 500); // 4:1 box
  wall.addVideo(c, vid(1280, 360)); // 16:9 eye
  await flush();
  env.runFrame();
  // s = max(640/2000, 360/500) = 0.72 -> eye 1440x360: height holds all 360 source rows.
  assert.equal(c.width, 2 * 1440);
  assert.equal(c.height, 360);
});

test('an explicit {width,height} is the page call and is never capped', async () => {
  const env = installEnv();
  const wall = await newWall();
  const c = makeCanvas(1152, 648);
  wall.addVideo(c, vid(1280, 360), { width: 2000, height: 1000 });
  await flush();
  env.runFrame();
  assert.equal(c.width, 4000);
  assert.equal(c.height, 1000);
});

test('the buffer re-derives when the source changes size (a new title), and decoration scales with it', async () => {
  const env = installEnv();
  const wall = await newWall();
  const v = vid(1280, 360);
  const c = makeCanvas(1600, 900);
  wall.addVideo(c, v, { cornerRadius: 40 });
  await flush();
  env.runFrame();
  assert.equal(c.width, 1280); // 640-px eyes
  const win = wall._windows.get(c);
  assert.equal(win.bufScale, 0.4);
  v.videoWidth = 2560; // a sharper title swapped in
  v.videoHeight = 720;
  env.runFrame();
  assert.equal(c.width, 2560, 'eye follows the new 1280-px source');
  assert.equal(c.height, 720);
  assert.equal(win.bufScale, 0.8);
});

// ── the device-limit clamp (./js/inline3d-buffer-limit.js) ─────────────────────────────────
//
// An Android 3D tablet (Adreno 740) reports MAX_TEXTURE_SIZE 4096 where desktops report 16384.
// The core probes a throwaway WebGL context for it once per document.

const { _resetProbedLimits } = await import('../js/inline3d-buffer-limit.js');

/**
 * A document whose probe canvas hands out a GL context reporting `tex` for every limit. Install it
 * AFTER installEnv() (which clears `document`); the wrapper clears it again afterwards.
 */
function installProbe(tex) {
  const gl = {
    MAX_TEXTURE_SIZE: 0x0d33,
    MAX_RENDERBUFFER_SIZE: 0x84e8,
    MAX_VIEWPORT_DIMS: 0x0d3a,
    getParameter: (p) => (p === 0x0d3a ? Int32Array.from([tex, tex]) : tex),
    getExtension: () => ({ loseContext() {} }),
  };
  globalThis.document = { createElement: () => ({ getContext: () => gl }) };
  _resetProbedLimits();
}
const withDeviceLimit = (fn) => async () => {
  try {
    await fn();
  } finally {
    globalThis.document = undefined;
    _resetProbedLimits();
  }
};

test(
  'a full-screen SBS video past MAX_TEXTURE_SIZE is clamped to the device, both axes by one factor, warned once',
  withDeviceLimit(async () => {
    const env = installEnv();
    installProbe(4096);
    const wall = await newWall();
    const c = makeCanvas(2560, 1348);
    const warns = await captureWarnings(async () => {
      wall.addVideo(c, vid(10240, 2696)); // 5120x2696 per eye: the source cap does not bite
      await flush();
      env.runFrame();
      env.runFrame();
    });
    const win = wall._windows.get(c);
    assert.equal(c.width, 4096, '2 x 2048, not 2 x 2560');
    assert.equal(c.height, 1078);
    assert.equal(win.eyeW, 2048);
    assert.ok(Math.abs(win.bufScale - 0.8) < 1e-9, 'decoration scales with the clamp');
    const hits = warns.filter((w) => String(w[0]).includes('exceeds MAX_TEXTURE_SIZE 4096'));
    assert.equal(hits.length, 1);
    assert.match(String(hits[0][0]), /^\[inline3d\] SBS buffer 5120×1348 exceeds MAX_TEXTURE_SIZE 4096 on this device; rendering at 4096×1078/);
  }),
);

test(
  'an explicit {width,height} past the device limit is clamped too (the source cap exempts it, the device cannot)',
  withDeviceLimit(async () => {
    const env = installEnv();
    installProbe(4096);
    const wall = await newWall();
    const c = makeCanvas(1152, 648);
    await captureWarnings(async () => {
      wall.addVideo(c, vid(1280, 360), { width: 3000, height: 1000 });
      await flush();
      env.runFrame();
    });
    assert.equal(c.width, 4096);
    assert.equal(c.height, Math.floor(1000 * (4096 / 6000)));
  }),
);

test('an addScene canvas the browser clamped below canvas.width is named once (the page sizes it; the core can only see it)', async () => {
  const env = installEnv();
  const wall = await newWall();
  const c = makeCanvas(2560, 1348);
  c.width = 5120;
  c.height = 1348;
  const gl = { drawingBufferWidth: 4096, drawingBufferHeight: 1348 };
  c.getContext = (type) => (type === 'webgl2' ? gl : null);
  const warns = await captureWarnings(async () => {
    wall.addScene(c, () => {});
    await flush();
    env.runFrame();
    env.runFrame();
    env.runFrame();
  });
  const hits = warns.filter((w) => String(w[0]).includes("clamped this canvas's drawing buffer"));
  assert.equal(hits.length, 1);
  assert.match(String(hits[0][0]), /^\[inline3d\] .* to 4096×1348 \(canvas\.width\/height say 5120×1348\); getViewport\(\) splits canvas\.width/);
});

test('an addScene canvas whose drawing buffer matches canvas.width says nothing', async () => {
  const env = installEnv();
  const wall = await newWall();
  const c = makeCanvas(1000, 500);
  c.width = 2000;
  c.height = 500;
  c.getContext = (type) => (type === 'webgl2' ? { drawingBufferWidth: 2000, drawingBufferHeight: 500 } : null);
  const warns = await captureWarnings(async () => {
    wall.addScene(c, () => {});
    await flush();
    env.runFrame();
  });
  assert.equal(warns.filter((w) => String(w[0]).includes('drawing buffer')).length, 0);
});

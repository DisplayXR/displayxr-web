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

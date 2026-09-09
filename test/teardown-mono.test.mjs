// Tests for the "no raw side-by-side in a canvas nothing is weaving" rule (web#28,
// browser-pvt#99).
//
// The field symptom is a tile showing a flat squeezed left|right pair instead of woven 3D, and
// what makes it a BUG rather than a glitch is that it is STICKY: the SDK decides its mono
// fallback once, at boot, so nothing on the page ever repaints such a canvas. Every path below
// ends with a canvas that no layer weaves, so what is worth pinning is not pixels but the ONE
// invariant that covers all of them — a window with no live layer holds a MONO frame in a 1:1
// buffer, whatever order the events arrived in.
//
// Recording stubs, no jsdom: the behaviour under test is control flow (which branch of _paint
// ran, whether the buffer was re-sized, whether the loop carried on past a throw), and a real
// canvas would hide exactly the calls that answer that.

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
function assertMono(canvas, why) {
  const d = lastDraw(canvas);
  assert.ok(d, `${why}: nothing was painted at all`);
  assert.equal(d.sw, 400, `${why}: the last paint took the WHOLE 800px source, i.e. an SBS pair`);
  assert.equal(d.dw, canvas.width, `${why}: the eye was not stretched across the whole buffer`);
}

// ── 1. session end ──────────────────────────────────────────────────────────────────────

test('session end repaints every image and video window MONO — the sticky-SBS bug (#28)', async () => {
  const env = installEnv();
  const wall = await newWall();
  const photo = makeCanvas();
  const movie = makeCanvas();
  wall.addImage(photo, makeImg());
  wall.addVideo(movie, makeVideo());
  await flush();

  // Live: both canvases hold a side-by-side pair in a 2:1 buffer.
  const winPhoto = wall._windows.get(photo);
  const winMovie = wall._windows.get(movie);
  assert.equal(winPhoto.sbs, true);
  assert.equal(photo.width, 600, 'a live window is 2 eyes wide');
  assert.equal(movie.width, 600);

  env.fire('end');

  for (const [canvas, win, name] of [
    [photo, winPhoto, 'image'],
    [movie, winMovie, 'video'],
  ]) {
    assert.equal(win.sbs, false, `${name}: the buffer is still flagged side-by-side after teardown`);
    assert.equal(canvas.width, 300, `${name}: the backing store is still 2 eyes wide after teardown`);
    assert.equal(canvas.height, 150);
    assertMono(canvas, `${name} after session end`);
  }
  // The layers really were closed — the repaint is on top of teardown, not instead of it.
  assert.deepEqual(env.created.map((l) => l.closed), [true, true]);
});

test('close() goes through the same path as the session ending on its own', async () => {
  installEnv();
  const wall = await newWall();
  const photo = makeCanvas();
  wall.addImage(photo, makeImg());
  await flush();
  const win = wall._windows.get(photo);
  wall.close();
  assert.equal(win.sbs, false);
  assert.equal(photo.width, 300);
  assertMono(photo, 'after close()');
});

// ── 2. a late image ─────────────────────────────────────────────────────────────────────

test('an image whose load lands AFTER teardown paints mono, not a fresh SBS pair (#28)', async () => {
  const env = installEnv();
  const wall = await newWall();
  const photo = makeCanvas();
  wall.addImage(photo, 'slow-photo-sbs.png'); // a URL: still downloading
  await flush();
  const win = wall._windows.get(photo);
  assert.equal(win.sbs, true, 'the tile activated while the image was still in flight');
  assert.equal(win.img, null);

  env.fire('end');
  // …and only now does the network deliver. This is the path whose odds rise with latency.
  env.images[0].onload();
  await flush();

  assert.equal(win.img, env.images[0], 'the load still lands — nothing is cancelled');
  assert.equal(win.sbs, false);
  assert.equal(photo.width, 300);
  assertMono(photo, 'a late image after teardown');
});

test('_paint refuses the SBS branch whenever no live layer weaves the canvas (#28)', async () => {
  installEnv();
  const wall = await newWall();
  const photo = makeCanvas();
  wall.addImage(photo, makeImg());
  await flush();
  const win = wall._windows.get(photo);
  wall.close();

  // Defence in depth, pinned on its own: whatever put an SBS buffer back (a path this test
  // cannot know about — that is the point), the next paint must still come out flat rather
  // than trust `win.sbs`.
  win.sbs = true;
  photo.width = 600;
  win.repaint();
  assert.equal(win.sbs, false, '_paint left the window flagged side-by-side with no layer');
  assert.equal(photo.width, 300, '_paint painted one eye into a 2:1 buffer');
  assertMono(photo, 'a repaint with no live layer');
});

// ── 3. a layer that cannot be created ───────────────────────────────────────────────────

test('a throwing XRDisplayLayer constructor warns ONCE and leaves the canvas mono (#28)', async () => {
  installEnv({ throwOnConstruct: true });
  const photo = makeCanvas();
  let wall;
  const warnings = await captureWarnings(async () => {
    wall = await newWall();
    wall.addImage(photo, makeImg());
    await flush();
  });
  const win = wall._windows.get(photo);
  assert.equal(win.layer, null, 'the failed construction must not leave a half-live layer');
  assert.equal(win.sbs, false, 'the canvas was left holding a side-by-side buffer');
  assert.equal(photo.width, 300);
  assertMono(photo, 'after a failed layer construction');
  const mine = warnings.filter((w) => String(w[0]).includes('new XRDisplayLayer() failed'));
  assert.equal(mine.length, 1, 'the failure must be diagnosable — and said exactly once');
  assert.ok(mine[0][1] instanceof TypeError, 'the error itself has to reach the console');

  // A re-activation (a tile scrolling back) retries the constructor but must not re-warn.
  const again = await captureWarnings(async () => wall._activate(win));
  assert.equal(again.filter((w) => String(w[0]).includes('new XRDisplayLayer() failed')).length, 0);
  wall.close();
});

test('a scene whose layer cannot be created is told, so it can go mono itself (#28)', async () => {
  installEnv({ throwOnConstruct: true });
  let lost = 0;
  let wall;
  await captureWarnings(async () => {
    wall = await newWall();
    wall.addScene(makeCanvas(), () => {}, { onLayerLost: () => lost++ });
    await flush();
  });
  assert.equal(lost, 1, 'the SDK does not own scene pixels — saying so is all it can do');
  wall.close();
  assert.equal(lost, 1, 'one notification per loss, not one per teardown step');
});

test('session end tells scene windows their layer is gone; a scroll-away does NOT', async () => {
  const env = installEnv();
  const wall = await newWall();
  const canvas = makeCanvas();
  let lost = 0;
  const win = wall._windows.get(canvas) ?? null;
  assert.equal(win, null);
  wall.addScene(canvas, () => {}, { onLayerLost: () => lost++ });
  await flush();

  // A lazy tile scrolling off screen is NOT a loss: the layer is coming back and onFrame
  // restores the SBS store by itself, so collapsing here would make scrolling a mode change.
  wall._deactivate(wall._windows.get(canvas));
  assert.equal(lost, 0);

  wall._activate(wall._windows.get(canvas));
  env.fire('end');
  assert.equal(lost, 1, 'the session ending IS a permanent loss and has to be reported');
});

// ── 4. one throwing scene must not take the other windows down ──────────────────────────

test('a throwing onFrame does not stop the windows after it from repainting (#28)', async () => {
  const env = installEnv();
  const wall = await newWall();
  const broken = makeCanvas();
  const photo = makeCanvas();
  let sceneCalls = 0;
  wall.addScene(broken, () => {
    sceneCalls++;
    throw new Error('a texture 404ed');
  });
  wall.addImage(photo, makeImg());
  await flush();

  const before = photo.ctx.draws.length;
  const warnings = await captureWarnings(async () => {
    env.runFrame();
    env.runFrame(); // a second frame: the loop keeps running, the warning does not repeat
  });
  assert.equal(sceneCalls, 2, 'the throwing scene is still driven — it is not disabled');
  assert.ok(
    photo.ctx.draws.length >= before + 2,
    'the image window after the throwing scene never repainted — an un-redrawn canvas can be ' +
      'dropped from the aggregated frame, which is the smear browser-pvt#99 reports'
  );
  assert.equal(warnings.filter((w) => String(w[0]).includes('onFrame threw')).length, 1);
  wall.close();
});

// ── 5. a buffering video ────────────────────────────────────────────────────────────────

test('a buffering video re-commits its last frame instead of going idle (#28)', async () => {
  const env = installEnv();
  const wall = await newWall();
  const movie = makeCanvas();
  wall.addVideo(movie, makeVideo(1)); // metadata only: no current frame to draw
  await flush();
  env.runFrame(); // the per-frame repaint is where a stalled video is reached

  const selfDraws = movie.ctx.draws.filter((d) => d.src === movie);
  assert.ok(selfDraws.length >= 1, 'a stalled video left its canvas un-redrawn');
  assert.equal(
    selfDraws[0].op,
    'copy',
    "the re-commit must be an identity blit — source-over would eat into a feathered tile's alpha"
  );
  assert.equal(movie.ctx.clears.length, 0, 'a stalled frame must never clear the tile to blank');
  wall.close();
});

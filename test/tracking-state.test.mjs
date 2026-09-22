// Tests for the tracking-state surface — `wall.trackingState`, `on('trackingstatechange')`, and
// the optional `untrackedFallback:'mono'` paint decision.
//
// Two things are worth pinning here and they pull in opposite directions.
//
// 1. On a browser that HAS the surface, the state must reach the page and (with the fallback on)
//    reach the pixels: a window the SDK owns the buffer of paints its LEFT eye into a 1:1 store
//    while nobody is tracked, and goes back to the side-by-side pair when tracking resumes. The
//    layer is never touched, which is why these tests assert on the BUFFER and the DRAW rather
//    than on any layer call.
// 2. On a browser that has NEITHER the attribute NOR the event — every shipped build until
//    browser-pvt "0194 trackingstatechange" — the answer is 'unknown' forever, with no handler
//    calls and NO warning. A page must be able to subscribe unconditionally.
//
// Recording stubs, no jsdom, same as teardown-mono.test.mjs: the behaviour under test is which
// branch of _paint ran and whether the backing store was re-sized.

import test from 'node:test';
import assert from 'node:assert/strict';

// ── environment ─────────────────────────────────────────────────────────────────────────

/** A recording 2D context: enough for _paint, and nothing else. */
function makeCtx(canvas) {
  return {
    canvas,
    draws: [],
    globalCompositeOperation: 'source-over',
    save() {},
    restore() {
      this.globalCompositeOperation = 'source-over';
    },
    clearRect() {},
    drawImage(src, ...rest) {
      const nine = rest.length === 8;
      this.draws.push({ src, sw: nine ? rest[2] : undefined, dw: nine ? rest[6] : undefined });
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

/**
 * Install the globals createInline3D touches.
 *
 * `trackingState: null` builds the OLD browser — a session with no such attribute at all, which
 * is the degradation case. Anything else is the initial state the session reports.
 */
function installEnv({ trackingState = 'tracking' } = {}) {
  class FakeDisplayLayer {
    constructor(session, canvas) {
      this.canvas = canvas;
      this.closed = false;
    }
    getViewport() {
      return { x: 0, y: 0, width: 150, height: 150 };
    }
    close() {
      this.closed = true;
    }
  }
  const listeners = new Map();
  const session = {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    requestReferenceSpace: async () => ({}),
    requestAnimationFrame() {
      return 1;
    },
  };
  if (trackingState !== null) session.trackingState = trackingState;
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
  globalThis.ResizeObserver = undefined;
  globalThis.Image = class {};
  return {
    session,
    /** How many listeners the manager actually attached for a given session event. */
    listenerCount: (type) => (listeners.get(type) ?? new Set()).size,
    /** Move the session's own attribute and fire the payload-free event the browser fires. */
    setTracking(state) {
      session.trackingState = state;
      for (const fn of listeners.get('trackingstatechange') ?? []) fn({ type: 'trackingstatechange' });
    },
    /** Fire a session event with no state move (an old browser's, or a redundant one). */
    fire(type) {
      for (const fn of listeners.get(type) ?? []) fn({ type });
    },
  };
}

/** Let the SDK's unawaited async work settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

/** Run `fn` with console.warn AND console.error captured; returns every call. */
async function captureLogs(fn) {
  const realWarn = console.warn;
  const realError = console.error;
  const calls = [];
  console.warn = (...args) => calls.push(args);
  console.error = (...args) => calls.push(args);
  try {
    await fn();
  } finally {
    console.warn = realWarn;
    console.error = realError;
  }
  return calls;
}

installEnv();
const { createInline3D } = await import('../js/inline3d.js');

const newWall = (opts = {}) => createInline3D({ lazy: false, autoChrome: false, ...opts });

const lastDraw = (canvas) => canvas.ctx.draws[canvas.ctx.draws.length - 1];

/** A mono paint takes HALF the 800px source (one eye) and stretches it over the whole buffer. */
function assertMono(canvas, why) {
  const d = lastDraw(canvas);
  assert.ok(d, `${why}: nothing was painted at all`);
  assert.equal(d.sw, 400, `${why}: the last paint took the WHOLE source, i.e. an SBS pair`);
  assert.equal(canvas.width, 300, `${why}: the backing store is not 1:1`);
}

/** An SBS paint maps the whole source onto a 2-eyes-wide buffer. */
function assertSbs(canvas, why) {
  const d = lastDraw(canvas);
  assert.ok(d, `${why}: nothing was painted at all`);
  assert.equal(d.sw, 800, `${why}: the last paint took ONE eye, i.e. a flat frame`);
  assert.equal(canvas.width, 600, `${why}: the backing store is not 2 eyes wide`);
}

// ── 1. the state itself ─────────────────────────────────────────────────────────────────

test('the initial state is READ off the session, before any event arrives', async () => {
  installEnv({ trackingState: 'searching' });
  const wall = await newWall();
  assert.equal(wall.trackingState, 'searching');
  wall.close();
});

test('a trackingstatechange drives wall.trackingState and the handler, state FIRST', async () => {
  const env = installEnv({ trackingState: 'tracking' });
  const wall = await newWall();
  const seen = [];
  const off = wall.on('trackingstatechange', (state, ev) => seen.push([state, ev]));

  env.setTracking('searching');
  assert.equal(wall.trackingState, 'searching');
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], 'searching', 'the callback is handed the STATE as its first argument');
  assert.deepEqual(seen[0][1], { type: 'trackingstatechange', state: 'searching' });

  env.setTracking('tracking');
  assert.equal(wall.trackingState, 'tracking');
  assert.deepEqual(seen.map((s) => s[0]), ['searching', 'tracking']);

  // The unsubscribe works, and off() is the same bookkeeping as the display events.
  off();
  env.setTracking('searching');
  assert.equal(seen.length, 2, 'the unsubscribed handler still fired');
  assert.equal(wall.trackingState, 'searching', 'the state is tracked whether or not anyone listens');
  wall.close();
});

test('the event is READ, never parsed — a repeat of the same state is not a change', async () => {
  const env = installEnv({ trackingState: 'tracking' });
  const wall = await newWall();
  const seen = [];
  wall.on('trackingstatechange', (state) => seen.push(state));

  env.fire('trackingstatechange'); // the browser fires; the attribute has not moved
  assert.deepEqual(seen, [], 'a no-op event reached the page');

  env.session.trackingState = 'wobbling'; // a value this SDK does not know
  env.fire('trackingstatechange');
  assert.deepEqual(seen, ['unknown'], 'an unrecognised state must degrade to unknown, not pass through');
  wall.close();
});

test('off() and on() share the display events’ bookkeeping, and on() still refuses a typo', async () => {
  installEnv();
  const wall = await newWall();
  assert.throws(() => wall.on('trackingchange', () => {}), TypeError);
  assert.throws(() => wall.on('trackingstatechange', 'not a function'), TypeError);
  // A tile handle re-emits it too — the subscription is the manager's either way.
  const handle = wall.addImage(makeCanvas(), makeImg());
  assert.equal(typeof handle.on('trackingstatechange', () => {}), 'function');
  wall.close();
});

test('a throwing page handler is contained, exactly as it is for a mode event', async () => {
  const env = installEnv();
  const wall = await newWall();
  const after = [];
  wall.on('trackingstatechange', () => {
    throw new Error('page bug');
  });
  wall.on('trackingstatechange', (s) => after.push(s));
  const logs = await captureLogs(async () => env.setTracking('searching'));
  assert.deepEqual(after, ['searching'], 'the handler after the throwing one never ran');
  assert.equal(logs.length, 1, 'the throw was not reported exactly once');
  wall.close();
});

test('the session ending releases the page to unknown, once', async () => {
  const env = installEnv({ trackingState: 'tracking' });
  const wall = await newWall();
  const seen = [];
  wall.on('trackingstatechange', (s) => seen.push(s));
  wall.close();
  assert.equal(wall.trackingState, 'unknown');
  assert.deepEqual(seen, ['unknown']);
});

// ── 2. the mono fallback ────────────────────────────────────────────────────────────────

test("untrackedFallback:'mono' takes an image window flat while searching, and back again", async () => {
  const env = installEnv({ trackingState: 'tracking' });
  const wall = await newWall({ untrackedFallback: 'mono' });
  const photo = makeCanvas();
  wall.addImage(photo, makeImg());
  await flush();
  const win = wall._windows.get(photo);
  assertSbs(photo, 'tracked');
  assert.equal(win.sbs, true);

  env.setTracking('searching');
  assert.equal(win.sbs, false, 'the window is still flagged side-by-side with nobody tracked');
  assertMono(photo, 'searching');
  assert.ok(win.layer && !win.layer.closed, 'the weave layer must NOT be closed by the fallback');

  env.setTracking('tracking');
  assert.equal(win.sbs, true);
  assertSbs(photo, 'tracking resumed');
  assert.ok(win.layer && !win.layer.closed, 'the layer was recreated rather than kept');
  wall.close();
});

test("a window added WHILE searching is born flat — no allocate-then-reallocate", async () => {
  installEnv({ trackingState: 'searching' });
  const wall = await newWall({ untrackedFallback: 'mono' });
  const photo = makeCanvas();
  wall.addImage(photo, makeImg());
  await flush();
  assert.equal(wall._windows.get(photo).sbs, false);
  assertMono(photo, 'added while searching');
  wall.close();
});

test("the default untrackedFallback:'none' changes NOTHING about the pixels", async () => {
  const env = installEnv({ trackingState: 'tracking' });
  const wall = await newWall(); // no option at all — every page that predates this
  const photo = makeCanvas();
  wall.addImage(photo, makeImg());
  await flush();
  const win = wall._windows.get(photo);

  env.setTracking('searching');
  assert.equal(wall.trackingState, 'searching', 'the state is still reported');
  assert.equal(win.sbs, true, 'the default fallback must not touch the buffer');
  assertSbs(photo, 'searching with the default fallback');
  wall.close();
});

test('a SCENE window is never touched — the page owns those pixels', async () => {
  const env = installEnv({ trackingState: 'tracking' });
  const wall = await newWall({ untrackedFallback: 'mono' });
  const stage = makeCanvas();
  wall.addScene(stage, () => {});
  await flush();
  const win = wall._windows.get(stage);
  const before = { w: stage.width, h: stage.height };

  env.setTracking('searching');
  assert.equal(win.ownsBuffer, false);
  assert.deepEqual({ w: stage.width, h: stage.height }, before, "the SDK resized a scene canvas");
  assert.equal(stage.ctx.draws.length, 0, 'the SDK painted into a scene canvas');
  assert.ok(win.layer && !win.layer.closed);
  wall.close();
});

// ── 3. the old browser ──────────────────────────────────────────────────────────────────

test('a session with NO trackingState attribute reports unknown forever, silently', async () => {
  const env = installEnv({ trackingState: null });
  const seen = [];
  const logs = await captureLogs(async () => {
    const wall = await newWall({ untrackedFallback: 'mono' });
    const photo = makeCanvas();
    wall.addImage(photo, makeImg());
    await flush();
    wall.on('trackingstatechange', (s) => seen.push(s));

    assert.equal(wall.trackingState, 'unknown');
    assert.equal(env.listenerCount('trackingstatechange'), 0, 'nothing to read: do not subscribe');

    // Whatever happens, it stays unknown and the window keeps weaving its pair.
    env.fire('trackingstatechange');
    assert.equal(wall.trackingState, 'unknown');
    assertSbs(photo, 'an old browser must keep its side-by-side pair');

    wall.close(); // already 'unknown': the release is silent too
  });
  assert.deepEqual(seen, [], 'a browser with no tracking surface called the handler');
  assert.deepEqual(logs, [], 'degrading to unknown must not spam the console');
});

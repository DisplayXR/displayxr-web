// Tests for `rectCover` — the SDK-owned cover over a woven canvas across a move or resize, released
// on rewoven() (core primitive; default 'off' in the core, 'auto' on ./splat and ./model).
//
// The state machine is what is pinned: change → cover up (on the frame the change is seen) →
// rewoven settles → cover down; a second change while it is up restarts the wait; remove() takes
// the element out of the DOM; nothing happens before the first join, or with the option off. Plus
// the box key: a pure MOVE now restarts a pending rewoven(), a document scroll does not.
//
// Recording DOM stubs and an injected clock, as first-woven.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

let clock = 0;
Object.defineProperty(globalThis, 'performance', {
  value: { now: () => clock },
  configurable: true,
  writable: true,
});

function makeParent() {
  const parent = {
    children: [],
    insertBefore(el, ref) {
      const i = this.children.indexOf(el);
      if (i >= 0) this.children.splice(i, 1);
      if (el.parentElement && el.parentElement !== this) el.parentElement.removeChild(el);
      const at = ref ? this.children.indexOf(ref) : -1;
      if (at >= 0) this.children.splice(at, 0, el);
      else this.children.push(el);
      el.parentElement = this;
    },
    removeChild(el) {
      const i = this.children.indexOf(el);
      if (i >= 0) this.children.splice(i, 1);
      el.parentElement = null;
    },
    querySelectorAll: () => [],
  };
  return parent;
}
const sibling = (el, d) => {
  const p = el.parentElement;
  if (!p) return null;
  return p.children[p.children.indexOf(el) + d] || null;
};

function makeCanvas(w = 400, h = 200, parent = makeParent()) {
  const ctx = { save() {}, restore() {}, clearRect() {}, drawImage() {} };
  const c = {
    tagName: 'CANVAS',
    style: {},
    width: 800,
    height: 200,
    clientWidth: w,
    clientHeight: h,
    left: 0,
    top: 0,
    parentElement: null,
    contains: () => false,
    get offsetParent() {
      return this.parentElement;
    },
    get offsetLeft() {
      return this.left;
    },
    get offsetTop() {
      return this.top;
    },
    get offsetWidth() {
      return this.clientWidth;
    },
    get offsetHeight() {
      return this.clientHeight;
    },
    get nextSibling() {
      return sibling(this, 1);
    },
    getBoundingClientRect() {
      const sy = globalThis.window?.scrollY || 0;
      return { x: this.left, y: this.top - sy, left: this.left, top: this.top - sy, width: this.clientWidth, height: this.clientHeight, right: this.left + this.clientWidth, bottom: this.top - sy + this.clientHeight };
    },
    getContext: () => ctx,
  };
  parent.insertBefore(c, null);
  return c;
}

function installEnv() {
  const made = [];
  globalThis.document = {
    createElement(tag) {
      const draws = [];
      const el = {
        tagName: tag.toUpperCase(),
        style: {},
        dataset: {},
        attrs: {},
        width: 300,
        height: 150,
        parentElement: null,
        draws,
        setAttribute(k, v) {
          this.attrs[k] = v;
        },
        get previousSibling() {
          return sibling(this, -1);
        },
        getContext: () => ({ drawImage: (...a) => draws.push(a) }),
      };
      made.push(el);
      return el;
    },
  };
  class FakeDisplayLayer {
    constructor(session, canvas) {
      this.canvas = canvas;
    }
    getViewport() {
      return { x: 0, y: 0, width: 400, height: 200 };
    }
    close() {}
  }
  const listeners = new Map();
  let frameCb = null;
  const session = {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
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
  globalThis.window = { XRDisplayLayer: FakeDisplayLayer, devicePixelRatio: 1, scrollX: 0, scrollY: 0, addEventListener() {}, removeEventListener() {} };
  globalThis.XRDisplayLayer = FakeDisplayLayer;
  globalThis.IntersectionObserver = undefined;
  globalThis.MutationObserver = undefined;
  return {
    made,
    covers: () => made.filter((e) => e.dataset && 'inline3dCover' in e.dataset),
    fire(type) {
      for (const fn of listeners.get(type) ?? []) fn({ type });
    },
    runFrame(n = 2) {
      const cb = frameCb;
      frameCb = null;
      assert.ok(cb, 'the manager should have a session frame armed');
      const views = [{ eye: 'left' }, { eye: 'right' }].slice(0, n);
      cb(clock, { getViewerPose: () => (n ? { views } : null) });
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
async function peek(p) {
  const PENDING = Symbol('pending');
  const v = await Promise.race([p, flush().then(() => PENDING)]);
  return v === PENDING ? 'pending' : v;
}

installEnv();
const { createInline3D } = await import('../js/inline3d.js');
const newWall = () => createInline3D({ lazy: false, autoChrome: false });

/** A scene window, woven (hold 100 ms), with a recording onFrame. */
async function wovenScene(env, opts = {}) {
  const wall = await newWall();
  const canvas = makeCanvas();
  const h = wall.addScene(canvas, () => {}, { firstWovenHoldMs: 100, ...opts });
  env.runFrame(2);
  clock += 100;
  env.runFrame(2);
  assert.equal((await peek(h.firstWoven)).woven, true);
  return { wall, canvas, h };
}

test('off by default in the core: a moved canvas gets no cover', async () => {
  clock = 0;
  const env = installEnv();
  const { wall, canvas } = await wovenScene(env);
  canvas.left = 500;
  env.runFrame(2);
  assert.equal(env.covers().length, 0);
  wall.close();
});

test('change → cover up on that frame → rewoven settles → cover down', async () => {
  clock = 0;
  const env = installEnv();
  const { wall, canvas, h } = await wovenScene(env, { rectCover: 'auto' });
  env.runFrame(2); // baseline look, nothing moved
  assert.equal(env.covers().length, 0, 'made lazily, on the first change');

  clock = 1000;
  canvas.left = 640; // the screen switch moves the canvas
  canvas.top = 40;
  env.runFrame(2);
  const [cover] = env.covers();
  assert.ok(cover, 'raised on the frame the change was seen');
  assert.equal(cover.style.display, 'block');
  assert.equal(cover.parentElement, canvas.parentElement);
  assert.equal(cover.previousSibling, canvas, 'the canvas’s next sibling');
  assert.equal(cover.style.pointerEvents, 'none');
  assert.equal(cover.style.background, '#000');
  assert.deepEqual([cover.style.left, cover.style.top, cover.style.width, cover.style.height], ['640px', '40px', '400px', '200px']);
  assert.equal(cover.draws.length, 1, 'one snapshot, at the change');

  const p = h.rewoven(); // the page can await the same wait
  clock = 1099;
  env.runFrame(2);
  assert.equal(cover.style.display, 'block');
  clock = 1100;
  env.runFrame(2);
  assert.equal((await peek(p)).woven, true);
  assert.equal(cover.style.display, 'none', 'cut, never faded, when rewoven settles');
  assert.equal(cover.draws.length, 1, 'never re-snapshotted per frame');
  wall.close();
});

test('the snapshot is the LEFT eye, cover-fit from the old on-screen aspect into the new box', async () => {
  clock = 0;
  const env = installEnv();
  const { wall, canvas } = await wovenScene(env, { rectCover: { snapshot: true, color: 'rgb(1, 2, 3)' } });
  env.runFrame(2);
  canvas.clientWidth = 200; // 2:1 → 1:1
  canvas.clientHeight = 200;
  env.runFrame(2);
  const [cover] = env.covers();
  assert.equal(cover.style.background, 'rgb(1, 2, 3)');
  assert.equal(cover.width, 200);
  assert.equal(cover.height, 200);
  const [src, sx, sy, sw, sh, dx, dy, dw, dh] = cover.draws[0];
  assert.equal(src, canvas);
  // Left eye = 400x200 of the 800x200 buffer, shown at 2:1; a 1:1 box keeps the middle half.
  assert.deepEqual([sx, sy, sw, sh, dx, dy, dw, dh], [100, 0, 200, 200, 0, 0, 200, 200]);
  wall.close();
});

test('snapshot:false is a solid color only', async () => {
  clock = 0;
  const env = installEnv();
  const { wall, canvas } = await wovenScene(env, { rectCover: { snapshot: false } });
  env.runFrame(2);
  canvas.left = 10;
  env.runFrame(2);
  const [cover] = env.covers();
  assert.equal(cover.style.display, 'block');
  assert.equal(cover.draws.length, 0);
  wall.close();
});

test('a second change while the cover is up restarts the wait and moves the cover', async () => {
  clock = 0;
  const env = installEnv();
  const { wall, canvas } = await wovenScene(env, { rectCover: 'auto' });
  env.runFrame(2);
  clock = 1000;
  canvas.left = 300;
  env.runFrame(2);
  const [cover] = env.covers();
  clock = 1060;
  canvas.clientWidth = 600; // the layout settles over two frames
  env.runFrame(2);
  assert.equal(cover.style.width, '600px', 'follows the canvas');
  clock = 1100;
  env.runFrame(2);
  assert.equal(cover.style.display, 'block', 'restarted at 1060, not settled at 1100');
  clock = 1160;
  env.runFrame(2);
  await flush();
  assert.equal(cover.style.display, 'none');
  assert.equal(cover.draws.length, 1, 'one snapshot per cover cycle');
  // A later change is a new cycle: up again, a fresh snapshot.
  clock = 2000;
  canvas.left = 0;
  env.runFrame(2);
  assert.equal(cover.style.display, 'block');
  assert.equal(cover.draws.length, 2);
  wall.close();
});

test('a re-parented canvas takes its cover with it', async () => {
  clock = 0;
  const env = installEnv();
  const { wall, canvas } = await wovenScene(env, { rectCover: 'auto' });
  env.runFrame(2);
  const other = makeParent();
  other.insertBefore(canvas, null); // the kiosk moves the ONE canvas into the next screen's box
  canvas.left = 50;
  env.runFrame(2);
  const [cover] = env.covers();
  assert.equal(cover.parentElement, other);
  assert.equal(cover.previousSibling, canvas);
  wall.close();
});

test('remove() tears the cover down and out of the DOM', async () => {
  clock = 0;
  const env = installEnv();
  const { wall, canvas, h } = await wovenScene(env, { rectCover: 'auto' });
  env.runFrame(2);
  canvas.left = 5;
  env.runFrame(2);
  const [cover] = env.covers();
  const parent = cover.parentElement;
  h.remove();
  await flush();
  assert.equal(cover.parentElement, null);
  assert.equal(parent.children.includes(cover), false);
  wall.close();
});

test('session end tears the cover down too', async () => {
  clock = 0;
  const env = installEnv();
  const { canvas } = await wovenScene(env, { rectCover: 'auto' });
  env.runFrame(2);
  canvas.left = 5;
  env.runFrame(2);
  const [cover] = env.covers();
  env.fire('end');
  await flush();
  assert.equal(cover.parentElement, null);
});

test('nothing is raised before the first join: the page’s own poster covers that', async () => {
  clock = 0;
  const env = installEnv();
  const wall = await newWall();
  const canvas = makeCanvas();
  wall.addScene(canvas, () => {}, { rectCover: 'auto' });
  env.runFrame(2);
  canvas.left = 99;
  env.runFrame(2);
  assert.equal(env.covers().length, 0);
  wall.close();
});

test('a bad rectCover throws at the call', async () => {
  clock = 0;
  installEnv();
  const wall = await newWall();
  assert.throws(() => wall.addScene(makeCanvas(), () => {}, { rectCover: 'on' }), /rectCover: expected 'auto', 'off'/);
  assert.throws(() => wall.addScene(makeCanvas(), () => {}, { rectCover: { color: 3 } }), /rectCover\.color/);
  wall.close();
});

test('rewoven: a pure move now restarts a pending hold; a document scroll does not', async () => {
  clock = 0;
  const env = installEnv();
  const { wall, canvas, h } = await wovenScene(env);
  clock = 1000;
  const p = h.rewoven();
  globalThis.window.scrollY = 300; // scrolling: the page position is unchanged
  env.runFrame(2);
  clock = 1100;
  env.runFrame(2);
  assert.equal((await peek(p)).reason, 'hold-elapsed', 'a scroll is not a move');

  clock = 2000;
  const q = h.rewoven();
  canvas.left = 200; // a move at the same size
  clock = 2050;
  env.runFrame(2);
  clock = 2100;
  env.runFrame(2);
  assert.equal(await peek(q), 'pending', 'restarted at the move (2050)');
  clock = 2150;
  env.runFrame(2);
  assert.equal((await peek(q)).woven, true);
  wall.close();
});

test('./splat and ./model default rectCover to auto at every addScene call site', () => {
  for (const f of ['inline3d-splat.js', 'inline3d-splat-playcanvas.js', 'inline3d-model.js', 'inline3d-model-playcanvas.js']) {
    const src = fs.readFileSync(new URL(`../js/${f}`, import.meta.url), 'utf8');
    const calls = src.split('wall.addScene(').length - 1;
    assert.equal(calls, 1, `${f}: one addScene call`);
    assert.match(src, /rectCover: opts\.rectCover === undefined \? 'auto' : opts\.rectCover,/, f);
  }
});

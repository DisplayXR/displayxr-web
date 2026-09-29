// sharedInline3D(): the document's ONE manager, handed to any module that needs a wall it did not
// create (RFC 0003 §1, woven-canvas rule 1). What is pinned is the identity contract — the same
// manager comes back while it is live, a fresh one after it closed, one creation for concurrent
// callers, and the page's own createInline3D() result is what a later sharedInline3D() returns.
// Stubs, not jsdom: the question is WHICH object comes back, never what it draws.

import test from 'node:test';
import assert from 'node:assert/strict';

let sessions = 0;
let gate = null; // when set, requestSession waits on it (to observe two callers racing)
function installEnv() {
  class FakeDisplayLayer {
    getViewport() {
      return null;
    }
    close() {}
  }
  const makeSession = () => {
    const listeners = new Map();
    return {
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
      end() {
        for (const fn of listeners.get('end') ?? []) fn({ type: 'end' });
      },
    };
  };
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      xr: {
        requestSession: async () => {
          sessions++;
          if (gate) await gate;
          return makeSession();
        },
      },
    },
    configurable: true,
    writable: true,
  });
  globalThis.window = { XRDisplayLayer: FakeDisplayLayer, devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} };
  globalThis.XRDisplayLayer = FakeDisplayLayer;
  globalThis.document = undefined;
  globalThis.IntersectionObserver = undefined;
}
installEnv();
const { createInline3D, sharedInline3D } = await import('../js/inline3d.js');

test('sharedInline3D: creates once, then returns the same live manager; a new one after close()', async () => {
  sessions = 0;
  const a = await sharedInline3D();
  assert.equal(a.supported, true);
  assert.equal(sessions, 1);
  const b = await sharedInline3D({ lazy: false }); // opts ignored: the manager already exists
  assert.equal(b, a, 'the live manager is the shared one');
  assert.equal(sessions, 1, 'no second session');
  a.close();
  const c = await sharedInline3D();
  assert.notEqual(c, a, 'a closed manager is never handed out again');
  assert.equal(sessions, 2);
  c.close();
});

test('sharedInline3D: the page\'s own createInline3D() IS the shared manager (rule 1, both orders)', async () => {
  const mine = await createInline3D();
  assert.equal(await sharedInline3D(), mine, 'a page that made its wall first hands it to <dxr-call>');
  mine.close();
  const shared = await sharedInline3D();
  // The other order: a page that creates a second manager after the shared one exists gets the
  // core's existing second-session warning (unchanged); sharedInline3D then follows the newest.
  const warned = [];
  const orig = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  let later;
  try {
    later = await createInline3D();
  } finally {
    console.warn = orig;
  }
  assert.ok(warned.some((w) => w.includes('second inline-3D session')), 'the existing rule-1 warning still fires');
  assert.equal(await sharedInline3D(), later);
  shared.close();
  later.close();
});

test('sharedInline3D: concurrent callers share ONE creation (no double session on page load)', async () => {
  sessions = 0;
  let release;
  gate = new Promise((r) => (release = r));
  const p1 = sharedInline3D();
  const p2 = sharedInline3D();
  release();
  gate = null;
  const [a, b] = await Promise.all([p1, p2]);
  assert.equal(a, b);
  assert.equal(sessions, 1);
  a.close();
});

test('sharedInline3D: unsupported resolves { supported: false } and is not cached', async () => {
  const nav = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
  try {
    const u1 = await sharedInline3D();
    const u2 = await sharedInline3D();
    assert.equal(u1.supported, false);
    assert.equal(u1.trackingState, 'unknown');
    assert.notEqual(u1, u2, 'each probe is fresh: the weave service can bind after load');
  } finally {
    Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true });
  }
  const back = await sharedInline3D();
  assert.equal(back.supported, true, 'and it recovers once the feature is there');
  back.close();
});

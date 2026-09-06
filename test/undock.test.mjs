// The undock helper's API path against the browser contract (browser-pvt#25 / patch 0130):
// `layer.undock()` resolves on a successful LAUNCH; the viewer's exit is the XRSession's
// `undockend` event; refusals are prompt DOMException rejections.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { undock, setUndockLayerResolver } from '../js/inline3d-undock.js';

class FakeSession extends EventTarget {}
const el = { getBoundingClientRect: () => ({ left: 10, top: 20, width: 300, height: 150 }) };
const opts = { src: 'https://example.com/a.glb', type: 'model' };

function domError(name) {
  const e = new Error(name);
  e.name = name;
  return e;
}

test('API path: resolves on launch, ended waits for the session undockend event', async () => {
  const session = new FakeSession();
  let launched = 0;
  const layer = { undock: async () => { launched += 1; } };
  setUndockLayerResolver(() => ({ layer, session }));
  try {
    const handle = await undock(el, opts);
    assert.equal(launched, 1);
    assert.equal(handle.detached, false);
    assert.equal(handle.viewer, 'model');
    let ended = false;
    handle.ended.then(() => { ended = true; });
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(ended, false, 'ended must not resolve on launch');
    // While the viewer is open a second undock is refused as busy.
    await assert.rejects(undock(el, opts), (e) => e.name === 'busy');
    session.dispatchEvent(new Event('undockend'));
    await handle.ended;
    assert.equal(ended, true);
    // ...and after the exit the next undock is allowed again.
    const again = await undock(el, opts);
    assert.equal(launched, 2);
    session.dispatchEvent(new Event('undockend'));
    await again.ended;
  } finally {
    setUndockLayerResolver(null);
  }
});

test('API path: an undockend that fires before the launch promise settles is not lost', async () => {
  const session = new FakeSession();
  let resolveLaunch;
  const layer = { undock: () => new Promise((r) => { resolveLaunch = r; }) };
  setUndockLayerResolver(() => ({ layer, session }));
  try {
    const p = undock(el, opts);
    session.dispatchEvent(new Event('undockend')); // viewer died instantly
    resolveLaunch();
    const handle = await p;
    await handle.ended; // resolves because the listener was armed before the launch
  } finally {
    setUndockLayerResolver(null);
  }
});

test('API path: the browser DOMException names map onto the four contract names', async () => {
  const session = new FakeSession();
  const cases = [
    ['NotAllowedError', 'no-activation'],
    ['NotSupportedError', 'not-installed'],
    ['SecurityError', 'src-not-allowed'],
    ['InvalidStateError', 'busy'],
    ['OperationError', 'not-installed'],
  ];
  try {
    for (const [dom, expected] of cases) {
      setUndockLayerResolver(() => ({ layer: { undock: async () => { throw domError(dom); } }, session }));
      await assert.rejects(undock(el, opts), (e) => e.name === expected, `${dom} -> ${expected}`);
    }
    // A refusal leaves nothing in flight: the next call is not 'busy'.
    setUndockLayerResolver(() => ({ layer: { undock: async () => {} }, session }));
    const h = await undock(el, opts);
    session.dispatchEvent(new Event('undockend'));
    await h.ended;
  } finally {
    setUndockLayerResolver(null);
  }
});

test('API path: a bare layer from an old resolver still launches; ended is just unobservable', async () => {
  setUndockLayerResolver(() => ({ undock: async () => {} }));
  try {
    const h = await undock(el, opts);
    assert.equal(h.detached, false);
    setUndockLayerResolver(null);
  } finally {
    setUndockLayerResolver(null);
  }
});

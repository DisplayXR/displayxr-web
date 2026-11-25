// mountCall() — the one-line path (RFC 0003 §1, C1) — and the `warning` event it introduces.
//
// Pinned here: (1) mountCall with no wall uses the document's SHARED manager, so a page that
// already has a session (or two calls on one page) never gets a second one; (2) an explicit
// `wall` wins; (3) `lift-not-bundled` fires ONCE, only when a mono peer actually routes on a 3D
// display with the lift MODULE missing — never on a 2D wall, never for a display that merely
// cannot lift; (4) `key` reaches the hosted signalling connect URL.
//
// Drives the real Call with the recording DOM of test/call-dom.mjs. Own file: it installs
// DOM/WebRTC/XR globals.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installCallDom, doc, channels, FakeTrack, FakeStream, silentUntilLayerWall } from './call-dom.mjs';

installCallDom();

// A DisplayXR-Browser-shaped navigator.xr, so sharedInline3D() creates a real manager.
function installXr() {
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
    value: { xr: { requestSession: async () => makeSession() } },
    configurable: true,
    writable: true,
  });
  globalThis.window = { XRDisplayLayer: FakeDisplayLayer, devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} };
  globalThis.XRDisplayLayer = FakeDisplayLayer;
  globalThis.IntersectionObserver = undefined;
}
installXr();

const { mountCall, addCall, dxrSignaling } = await import('../js/inline3d-call.js');
const { makeHello } = await import('../js/call/wire.js');
const { sharedInline3D, createInline3D } = await import('../js/inline3d.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const noSignal = { async join(room, hooks) { return { id: hooks.id, peers: [], send() {}, leave() {} }; } };
const monoCam = () => new FakeStream([new FakeTrack('video')]);
const base = () => ({ signaling: noSignal, room: 'R'.repeat(22), ui: false, audio: false, selfView: false, camera: monoCam(), format: 'mono' });

test('mountCall: no wall → the document\'s shared manager; two mounts share it; a page\'s own wall is found', async () => {
  const host = doc.body.appendChild(doc.createElement('div'));
  const a = await mountCall(host, base());
  try {
    const shared = await sharedInline3D();
    assert.equal(a.diagnostics().wall, shared, 'the wall is the shared one');
    assert.equal(a.diagnostics().wall.supported, true);
    const host2 = doc.body.appendChild(doc.createElement('div'));
    const b = await mountCall(host2, base());
    assert.equal(b.diagnostics().wall, a.diagnostics().wall, 'a second call on the page joins the SAME session (rule 1)');
    b.leave();
  } finally {
    a.leave();
  }
  // Modules that borrow the wall never close it: leave() left the page's session alone.
  const still = await sharedInline3D();
  assert.equal(still, a.diagnostics().wall, 'leave() did not close the shared manager');
  still.close();
  // A page that made its own wall first, then mounts: that wall.
  const mine = await createInline3D();
  const host3 = doc.body.appendChild(doc.createElement('div'));
  const c = await mountCall(host3, base());
  assert.equal(c.diagnostics().wall, mine);
  c.leave();
  mine.close();
});

test('mountCall: an explicit `wall` wins over the shared one, and a 2D wall is fine', async () => {
  const w = { supported: false, trackingState: 'unknown' };
  const host = doc.body.appendChild(doc.createElement('div'));
  const call = await mountCall(host, { ...base(), wall: w });
  assert.equal(call.diagnostics().wall, w);
  call.leave();
  await assert.rejects(mountCall(null, {}), /needs a container element/);
});

/** A remote mono peer arrives: hello over the data channel, then its video plays. */
function arriveMono() {
  const hello = makeHello({ format: 'mono', width: 640, height: 480 });
  for (const dc of channels) dc.onmessage && dc.onmessage({ data: JSON.stringify(hello) });
  const v = doc.created.filter((e) => e.tagName === 'VIDEO' && (e.listeners.playing || []).length).at(-1);
  Object.assign(v, { readyState: 4, videoWidth: 640, videoHeight: 480 });
  v.fire('playing');
}
// The fake peer's id sorts above any real one, so this side offers and the data channel exists at once.
const onePeer = { async join(room, hooks) { return { id: hooks.id, peers: ['~~~~~~~~~~~'], send() {}, leave() {} }; } };

test("warning 'lift-not-bundled': once, when a mono peer routes flat on a 3D display because the lift MODULE is missing", { timeout: 10000 }, async () => {
  const w = silentUntilLayerWall();
  const warnings = [];
  const consoleWarns = [];
  const orig = console.warn;
  console.warn = (...a) => consoleWarns.push(a.join(' '));
  const host = doc.body.appendChild(doc.createElement('div'));
  let call;
  try {
    call = await addCall(w.wall, host, {
      ...base(),
      signaling: onePeer,
      mono3D: 'auto',
      _liftImporter: async () => {
        throw new Error('Cannot find module ./lift/index.js');
      },
    });
    call.on('warning', (e) => warnings.push(e));
    await call.join();
    arriveMono();
    for (let i = 0; i < 200 && !warnings.length; i++) await sleep(5);
    assert.equal(call.mono3D.reason, 'import-failed');
    assert.equal(call.peers[0].display, '2D');
    assert.equal(call.diagnostics().peers[0].route, 'flat');
    arriveMono(); // a second routing pass of the same peer: still one warning
    await sleep(20);
  } finally {
    console.warn = orig;
    call?.leave();
  }
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, 'lift-not-bundled');
  assert.match(warnings[0].message, /call\/full/);
  assert.match(warnings[0].message, /mono3D: lift/);
  assert.equal(consoleWarns.filter((m) => m.includes('lift-not-bundled')).length, 1, 'one console.warn, listener or not');
});

test("warning 'lift-not-bundled': a copy of the SDK whose lift module has no lift export counts as missing too", { timeout: 10000 }, async () => {
  const w = silentUntilLayerWall();
  const warnings = [];
  const orig = console.warn;
  console.warn = () => {};
  const host = doc.body.appendChild(doc.createElement('div'));
  let call;
  try {
    call = await addCall(w.wall, host, { ...base(), signaling: onePeer, mono3D: 'auto', _liftImporter: async () => ({ LIFT_PLACEHOLDER: true }) });
    call.on('warning', (e) => warnings.push(e));
    await call.join();
    arriveMono();
    for (let i = 0; i < 200 && !warnings.length; i++) await sleep(5);
  } finally {
    console.warn = orig;
    call?.leave();
  }
  assert.equal(warnings.map((e) => e.code).join(), 'lift-not-bundled');
  assert.equal(call.mono3D.reason, 'no-lift-export');
});

test("no 'lift-not-bundled' on a 2D wall, for a display that cannot lift, or with mono3D off", { timeout: 10000 }, async () => {
  const orig = console.warn;
  const origInfo = console.info;
  console.warn = () => {};
  console.info = () => {};
  const runs = [
    { name: '2D wall', wall: { supported: false }, opts: { _liftImporter: async () => { throw new Error('missing'); } } },
    { name: 'no provider', wall: silentUntilLayerWall().wall, opts: { _liftImporter: async () => ({ lift() {}, liftCapabilities: async () => ({ native: false, webFallback: { webgpu: false } }) }) } },
    { name: 'mono3D off', wall: silentUntilLayerWall().wall, opts: { mono3D: 'off', _liftImporter: async () => { throw new Error('missing'); } } },
  ];
  try {
    for (const r of runs) {
      const warnings = [];
      const host = doc.body.appendChild(doc.createElement('div'));
      const call = await addCall(r.wall, host, { ...base(), signaling: onePeer, mono3D: 'auto', ...r.opts });
      call.on('warning', (e) => warnings.push(e));
      await call.join();
      arriveMono();
      await sleep(150);
      call.leave();
      assert.equal(warnings.length, 0, `${r.name}: no warning`);
    }
  } finally {
    console.warn = orig;
    console.info = origInfo;
  }
});

test('key: a publishable key rides on the hosted connect URL; none by default', async () => {
  const seen = [];
  class WS {
    constructor(url) {
      seen.push(url);
      setTimeout(() => this.onerror && this.onerror(new Error('refused')), 1);
    }
    close() {}
  }
  await assert.rejects(dxrSignaling('wss://s.example', { key: 'pk_test 1', WebSocket: WS }).join('R'.repeat(22), { id: 'p1', maxPeers: 4 }));
  await assert.rejects(dxrSignaling('wss://s.example', { WebSocket: WS }).join('R'.repeat(22), { id: 'p1', maxPeers: 4 }));
  assert.match(seen[0], /^wss:\/\/s\.example\/v1\/connect\?k=[0-9a-f]{64}&key=pk_test%201$/);
  assert.match(seen[1], /^wss:\/\/s\.example\/v1\/connect\?k=[0-9a-f]{64}$/);
});

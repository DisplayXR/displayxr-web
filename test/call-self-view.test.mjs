// The call's self view follows its tile's firstWoven (web#131). Seen once in the DisplayXR
// Browser: the self view showed the whole packed L|R pair squeezed into each eye — the look of a
// canvas nothing is weaving — under a "You · 3D" badge, because the badge read the route and the
// route never learned the layer had failed. What is pinned here, through the real Call with the
// recording DOM: a 'layer-failed' first-woven result takes the self view to the flat left eye
// with an honest 2D badge; a recovered wall re-registers it; a normal woven path stays 3D; and
// `diagnostics().self` reports what is actually on the panel.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installCallDom, doc, FakeTrack, FakeStream } from './call-dom.mjs';

installCallDom();
const { addCall } = await import('../js/inline3d-call.js');

const findPart = (n, name) => (n.attrs && n.attrs.part === name ? n : (n.children || []).map((c) => findPart(c, name)).find(Boolean));
const noSignal = { async join(room, hooks) { return { id: hooks.id, peers: [], send() {}, leave() {} }; } };
const sbsStream = () => new FakeStream([Object.assign(new FakeTrack('video'), { getSettings: () => ({ width: 1280, height: 480 }) })]);
const flush = async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};

/** A 3D wall (no session: nothing to gate on) whose addImage handles the test settles by hand. */
function fwWall() {
  const added = [];
  const wall = {
    supported: true,
    addImage(canvas, src) {
      let settle;
      const firstWoven = new Promise((r) => (settle = r));
      const h = { canvas, src, removed: 0, firstWoven, settle: (woven, reason) => settle({ woven, confirmed: false, reason, ms: 5 }), remove() { this.removed++; } };
      added.push(h);
      return h;
    },
  };
  return { wall, added };
}

async function selfCall(wall) {
  const host = doc.body.appendChild(doc.createElement('div'));
  const call = await addCall(wall, host, { signaling: noSignal, room: 'R'.repeat(22), ui: true, autoJoin: false, audio: false, selfView: true, camera: sbsStream(), format: 'sbs' });
  await call.join();
  await flush();
  const badge = () => findPart(findPart(host, 'self'), 'badge').children[0].textContent;
  return { call, badge };
}

test('self view: a layer-failed tile goes flat with a 2D badge; diagnostics().self says why; the retry re-weaves it', async (t) => {
  const { wall, added } = fwWall();
  const { call, badge } = await selfCall(wall);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    assert.equal(added.length, 1, 'the self view registered on the 3D wall');
    assert.equal(badge(), 'You · 3D');
    assert.deepEqual(call.diagnostics().self, { route: 'woven-sbs', woven: true, reason: null, firstWoven: 'pending', layerRetries: 0 });

    added[0].settle(false, 'layer-failed');
    await flush();
    assert.equal(badge(), 'You · 2D', 'the badge follows what is woven, not the wall');
    const d = call.diagnostics().self;
    assert.equal(d.route, 'flat-left', 'one eye, flat — never the packed pair');
    assert.equal(d.woven, false);
    assert.equal(d.reason, 'layer-failed');
    assert.equal(added[0].removed, 1);

    // The call's own update() (an unforced reroute) must not put it back on the wall.
    call.setDepth(0.1);
    assert.equal(call.diagnostics().self.route, 'flat-left');

    // The view retries the layer (backoff) while the wall stays up; the badge follows it back.
    t.mock.timers.tick(1500);
    assert.equal(added.length, 2, 're-registered on the wall');
    assert.equal(badge(), 'You · 3D');
    assert.equal(call.diagnostics().self.reason, null);
    added[1].settle(true, 'hold-elapsed');
    await flush();
    assert.equal(badge(), 'You · 3D');
    assert.equal(call.diagnostics().self.firstWoven.woven, true);
  } finally {
    call.leave();
  }
});

test('self view: the session ending takes it 2D (badge + diagnostics)', async () => {
  const { wall, added } = fwWall();
  const ends = [];
  wall.session = { addEventListener: (type, fn) => type === 'end' && ends.push(fn), removeEventListener() {} };
  wall.close = () => {};
  const { call, badge } = await selfCall(wall);
  try {
    added[0].settle(true, 'hold-elapsed');
    await flush();
    assert.equal(badge(), 'You · 3D');
    // The core settles nothing new for a woven window on teardown (firstWoven is one-shot); the
    // call's session-end hook is what takes the view flat.
    for (const fn of ends) fn();
    assert.equal(badge(), 'You · 2D');
    assert.equal(call.diagnostics().self.route, 'flat-left');
    assert.equal(added[0].removed, 1);
  } finally {
    call.leave();
  }
});

test('self view: a normal woven path stays 3D', async () => {
  const { wall, added } = fwWall();
  const { call, badge } = await selfCall(wall);
  try {
    added[0].settle(true, 'hold-elapsed');
    await flush();
    assert.equal(badge(), 'You · 3D');
    const d = call.diagnostics().self;
    assert.equal(d.route, 'woven-sbs');
    assert.equal(d.woven, true);
    assert.equal(d.reason, null);
    assert.deepEqual(d.firstWoven, { woven: true, confirmed: false, reason: 'hold-elapsed', ms: 5 });
    assert.equal(added.length, 1);
  } finally {
    call.leave();
  }
});

test('self view: on a 2D wall diagnostics().self is flat with no failure reason; no self view → null', async () => {
  const { call, badge } = await selfCall({ supported: false });
  try {
    assert.equal(badge(), 'You · 2D');
    assert.deepEqual(call.diagnostics().self, { route: 'flat-left', woven: false, reason: null, firstWoven: null, layerRetries: 0 });
  } finally {
    call.leave();
  }
  const host = doc.body.appendChild(doc.createElement('div'));
  const none = await addCall({ supported: false }, host, { signaling: noSignal, room: 'R'.repeat(22), ui: false, autoJoin: false, audio: false, selfView: false, camera: sbsStream(), format: 'sbs' });
  assert.equal(none.diagnostics().self, null);
  none.leave();
});

// Regression: mono→3D must not wait for the weave session to go live (#172 deadlock).
//
// The browser's inline session does not tick (session rAF never fires) until a layer exists. In a
// call where every peer is mono and the self view is flat, lift's addScene window is the ONLY
// layer — so gating the first lift on "weave live" means nothing is ever lifted. The call must
// lift at once, and re-create (release + lift again) once when the session goes live.
//
// Drives the real Call through addCall() with a recording fake DOM, a fake RTCPeerConnection,
// a fake signalling adapter, an injected fake lift, and a mock wall whose session rAF stays
// silent until a scene/layer is registered. Own file: it installs DOM/WebRTC globals.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installCallDom, doc, channels, FakeTrack, FakeStream, silentUntilLayerWall } from './call-dom.mjs';

installCallDom();
const { addCall } = await import('../js/inline3d-call.js');
const { makeHello, createLiveGate } = await import('../js/call/wire.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('#172 deadlock regression: an all-mono call lifts at once, then re-creates the lift once when the session goes live', { timeout: 10000 }, async () => {
  const w = silentUntilLayerWall();
  const lifts = [];
  // Like the real lift(): its canvas becomes an addScene window on the wall it is given.
  const fakeLift = async (el, opts) => {
    const framesAtLift = w.frames; // session frames seen when lift() was called
    const scene = opts.wall.addScene(el, () => {});
    const h = { el, opts, framesAtLift, removed: false, state: 'live', native: false, priorities: [], setPriority(p) { this.priorities.push(p); return true; }, setConvergence() {}, remove() { this.removed = true; scene.remove(); } };
    lifts.push(h);
    return h;
  };
  // The fake peer's id sorts ABOVE any real peer id ('~' > every base64url char), so this side is
  // always the offerer and builds the connection (and its data channel) at once. With a random
  // lower id this side would wait for an offer that never comes, and the hello would be lost.
  const signaling = { async join(room, hooks) { return { id: hooks.id, peers: ['~~~~~~~~~~~'], send() {}, leave() {} }; } };
  const host = doc.body.appendChild(doc.createElement('div'));
  const call = await addCall(w.wall, host, {
    signaling, room: 'R'.repeat(22), ui: false, audio: false, selfView: false,
    camera: new FakeStream([new FakeTrack('video')]), format: 'mono', mono3D: fakeLift,
  });
  try {
    assert.equal(call.state, 'in-call');
    await sleep(10);
    assert.equal(w.frames, 0, 'no layer yet → the session has not ticked');
    // The remote peer: a mono hello, and its video starts playing.
    const hello = makeHello({ format: 'mono', width: 640, height: 480 });
    assert.ok(channels.length >= 1, 'the offerer built the data channel');
    for (const dc of channels) dc.onmessage && dc.onmessage({ data: JSON.stringify(hello) });
    const v = doc.created.filter((e) => e.tagName === 'VIDEO' && (e.listeners.playing || []).length).at(-1);
    assert.ok(v, 'the tile video exists');
    Object.assign(v, { readyState: 4, videoWidth: 640, videoHeight: 480 });
    v.fire('playing');
    // Poll (not a fixed sleep: the resolve → acquire chain is async and a loaded test runner is
    // slow). What proves the fix is the frame count AT the first lift, not how fast it came.
    for (let i = 0; i < 200 && !lifts.length; i++) await sleep(5);
    assert.equal(lifts.length >= 1, true, 'lifted (the old weave-live gate never lifted here: no layer → no session frames)');
    assert.equal(lifts[0].framesAtLift, 0, 'the first lift came BEFORE the session ever ticked');
    assert.equal(lifts[0].opts.mode, 'live');
    assert.equal(lifts[0].opts.wall, w.wall);
    // lift's scene is the only layer → the session starts ticking → 10 one-view frames → live.
    for (let i = 0; i < 600 && lifts.length < 2; i++) await sleep(5); // generous: a loaded runner
    assert.ok(w.frames >= 10, `the session ticked (${w.frames} frames)`);
    assert.equal(lifts.length, 2, 'the pre-live lift was re-created exactly once');
    assert.equal(lifts[0].removed, true, 'the pre-live lift was released');
    assert.equal(lifts[1].removed, false);
    await sleep(50);
    assert.equal(lifts.length, 2, 'no further re-creates once live');
    const p = call.peers[0];
    assert.equal(p.display, '2D→3D');
    const d = call.diagnostics().peers[0];
    assert.equal(d.route, 'lifted');
    assert.equal(d.lift.live, true);
  } finally {
    // Always leave: a failing assertion must fail the test, not leave timers that hang the run.
    call.leave();
  }
  assert.equal(lifts.at(-1).removed, true, 'leave() releases the lift');
});

test('live gate counts ONE-view frames (the browser inline viewer pose)', () => {
  const g = createLiveGate();
  for (let i = 0; i < 9; i++) assert.equal(g.feed(1), false);
  assert.equal(g.feed(1), true);
});

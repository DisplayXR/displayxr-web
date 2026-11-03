// Sender-side auto-convergence through the real Call (recording DOM + fake WebRTC, test/call-dom.mjs):
// a side-by-side sender measures its OWN raw camera frames and broadcasts `conv {d, c}` on the data
// channel (≤ 5 Hz, a heartbeat ≤ 400 ms apart, the last value right after hello + state to a peer
// that opens late); a receiver applies a FRESH `conv` as the measured disparity (frac × eye width)
// instead of measuring the decoded frames, and falls back to measuring them itself when the sender
// is older (no `hello.conv`), silent for 1.2 s, or when a depth cursor needs the copy.
import test from 'node:test';
import assert from 'node:assert/strict';

import { installCallDom, doc, channels, FakeTrack, FakeStream } from './call-dom.mjs';
import { texture, sbs, rect } from './sbs-fixtures.mjs';

installCallDom();
// The paint loop is driven by hand: `paint()` runs one frame of every tile.
let rafCb = null;
globalThis.requestAnimationFrame = (cb) => {
  rafCb = cb;
  return 1;
};
globalThis.addEventListener ??= () => {};
globalThis.removeEventListener ??= () => {};
const { addCall } = await import('../js/inline3d-call.js');
const { makeHello, makeConv } = await import('../js/call/wire.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};
const paint = async () => {
  const cb = rafCb;
  cb(performance.now());
  await flush();
};
const ROOM = 'R'.repeat(22);
// The peer's id sorts above any real one, so this side is the offerer and builds the data channel.
const PEER = '~~~~~~~~~~~';
const signaling = { async join(room, hooks) { return { id: hooks.id, peers: [PEER], send() {}, leave() {} }; } };
const sbsStream = () => new FakeStream([Object.assign(new FakeTrack('video'), { getSettings: () => ({ width: 1280, height: 480 }) })]);
const monoStream = () => new FakeStream([new FakeTrack('video')]);

const E = 240;
const H = 135;
const pairs = new Map();
const pairFor = (d) => {
  if (!pairs.has(d)) pairs.set(d, sbs(E, H, [{ d: 0, tex: texture(1) }, { d, tex: texture(2), inside: rect(90, 35, 150, 95) }]));
  return pairs.get(d);
};
/** A grab serving a synthetic pair whose subject is `state.d` copy px in front (scale 1, 480-wide video). */
function syntheticGrab(state) {
  state.grabs = 0;
  return async (video) => {
    state.grabs++;
    if (state.moving) state.d = Math.min(60, state.d + 1); // a subject leaning in, 1 px per sample
    Object.assign(video, { videoWidth: 2 * E, videoHeight: H, readyState: 4 });
    const { img, W } = pairFor(state.d);
    return { img, w: W, h: H, scale: 1, via: 'canvas', readMs: 0 };
  };
}

/** The data channel to the peer, with every message this side sends recorded as `{ at, msg }`. */
function tapChannel() {
  const dc = channels.at(-1);
  const sent = [];
  dc.send = (data) => sent.push({ at: performance.now(), msg: JSON.parse(data) });
  return { dc, sent, convs: () => sent.filter((s) => s.msg.type === 'conv') };
}

async function senderCall(extra = {}) {
  const state = { d: 40 };
  const host = doc.body.appendChild(doc.createElement('div'));
  const call = await addCall({ supported: false }, host, {
    signaling, room: ROOM, ui: false, audio: false, selfView: false, camera: sbsStream(), format: 'sbs', _convGrab: syntheticGrab(state), ...extra,
  });
  return { call, state, ...tapChannel() };
}

const gaps = (list) => list.slice(1).map((s, i) => s.at - list[i].at);

test('sender: a stereo camera broadcasts conv at ≤ 5 Hz, a heartbeat when it holds still, and the last value right after hello + state on open', { timeout: 15000 }, async () => {
  const { call, state, dc, sent, convs } = await senderCall();
  try {
    assert.equal(call.state, 'in-call');
    // A moving subject: the value changes on every sample, so the 5 Hz gate is what paces it.
    state.moving = true;
    await sleep(1300);
    state.moving = false;
    const moving = convs();
    assert.ok(moving.length >= 2, `sent while moving: ${moving.length}`);
    assert.ok(moving.length <= 8, `≤ 5 Hz: ${moving.length} in 1.3 s`);
    // The 5 Hz gate is timer-paced with 20 ms of slack (wire.rateGate): never under 180 ms apart.
    for (const g of gaps(moving)) assert.ok(g >= 175, `gap ${g.toFixed(0)} ms`);
    for (const { msg } of moving) {
      assert.ok(msg.d > 35 / E && msg.d < 61 / E, `d=${msg.d} is a fraction of the eye width`);
      assert.ok(msg.c >= 0.8 && msg.c <= 1);
    }
    // Holding still: only the heartbeat.
    state.d = 44;
    await sleep(500);
    const t0 = performance.now();
    await sleep(1400);
    const still = convs().filter((s) => s.at >= t0);
    assert.ok(still.length >= 2 && still.length <= 4, `heartbeats in 1.4 s: ${still.length}`);
    for (const g of gaps(still)) assert.ok(g >= 395 && g <= 900, `heartbeat gap ${g.toFixed(0)} ms`);
    for (const { msg } of still) assert.ok(Math.abs(msg.d - 44 / E) < 0.01);

    // A peer whose channel opens (late joiner / reconnect): hello (conv: true), state, the last conv.
    const n = sent.length;
    dc.onopen();
    const open = sent.slice(n).map((s) => s.msg);
    assert.equal(open[0].type, 'hello');
    assert.equal(open[0].conv, true);
    assert.equal(open[0].format, 'sbs');
    assert.equal(open[1].type, 'state');
    assert.equal(open[2].type, 'conv');
    assert.deepEqual(open[2], convs().at(-2).msg, 'the last conv sent');
  } finally {
    call.leave();
  }
});

test('sender: nothing while the camera is off, from a mono camera, or with sendConvergence: false', { timeout: 15000 }, async () => {
  {
    const { call, state, convs } = await senderCall();
    try {
      await sleep(500);
      assert.ok(convs().length >= 1, 'sending while the camera is on');
      call.setCameraOff(true);
      await sleep(250); // a sample in flight may still land
      const n = convs().length;
      const grabs = state.grabs;
      await sleep(700);
      assert.equal(convs().length, n, 'no conv while the camera is off');
      assert.equal(state.grabs, grabs, 'and no measuring');
      call.setCameraOff(false);
      await sleep(500);
      assert.ok(convs().length > n, 'back on: sending again');
    } finally {
      call.leave();
    }
  }
  {
    const state = { d: 40 };
    const host = doc.body.appendChild(doc.createElement('div'));
    const call = await addCall({ supported: false }, host, { signaling, room: ROOM, ui: false, audio: false, selfView: false, camera: monoStream(), format: 'mono', _convGrab: syntheticGrab(state) });
    const { dc, sent, convs } = tapChannel();
    try {
      dc.onopen();
      await sleep(700);
      assert.equal(convs().length, 0, 'a mono sender sends no conv');
      assert.equal(state.grabs, 0, 'and measures nothing');
      const hello = sent.find((s) => s.msg.type === 'hello').msg;
      assert.equal(hello.format, 'mono');
      assert.ok(!('conv' in hello), 'nor advertises it');
    } finally {
      call.leave();
    }
  }
  {
    const { call, state, dc, sent, convs } = await senderCall({ sendConvergence: false });
    try {
      dc.onopen();
      await sleep(700);
      assert.equal(convs().length, 0, 'sendConvergence: false sends nothing');
      assert.equal(state.grabs, 0);
      assert.ok(!('conv' in sent.find((s) => s.msg.type === 'hello').msg));
    } finally {
      call.leave();
    }
  }
});

test('sender: leave() stops measuring', { timeout: 10000 }, async () => {
  const { call, state } = await senderCall();
  await sleep(450);
  call.leave();
  await sleep(50);
  const grabs = state.grabs;
  await sleep(500);
  assert.equal(state.grabs, grabs);
});

// ── receiver ─────────────────────────────────────────────────────────────────────────────────

/** A 3D wall whose addImage accepts every tile. */
const wovenWall = () => ({ supported: true, addImage: (canvas, src) => ({ canvas, src, firstWoven: new Promise(() => {}), remove() {} }) });

/**
 * A receiving call with one stereo peer. The peer's hello (+ an optional first `conv`) arrives
 * BEFORE its video plays, so the first paint already knows what the sender sends.
 */
async function receiverCall({ conv = true, firstConv = null, opts = {} } = {}) {
  const host = doc.body.appendChild(doc.createElement('div'));
  const call = await addCall(wovenWall(), host, { signaling, room: ROOM, ui: false, audio: false, selfView: false, camera: monoStream(), format: 'mono', sendConvergence: false, ...opts });
  const { dc } = tapChannel();
  const recv = (msg) => dc.onmessage({ data: JSON.stringify(msg) });
  recv(makeHello({ format: 'sbs', width: 1280, height: 480, conv }));
  if (firstConv !== null) recv(makeConv(firstConv, 0.9));
  const v = doc.created.filter((e) => e.tagName === 'VIDEO' && (e.listeners.playing || []).length).at(-1);
  Object.assign(v, { readyState: 4, videoWidth: 1280, videoHeight: 480 });
  v.fire('playing');
  await flush();
  const peer = () => call.diagnostics().peers[0];
  assert.equal(peer().route, 'woven-sbs');
  return { call, recv, peer, video: v };
}

test('receiver: a fresh sender conv sets the disparity to frac × eye width and skips local measuring', { timeout: 10000 }, async () => {
  const { call, recv, peer, video } = await receiverCall({ firstConv: 0.1 });
  try {
    for (let i = 0; i < 4; i++) {
      await paint();
      await sleep(70);
    }
    let a = peer().autoConverge;
    assert.equal(a.source, 'sender');
    assert.equal(a.senderFrac, 0.1);
    assert.equal(a.disparityPx, 0.1 * 640, 'frac × (videoWidth / 2)');
    assert.equal(a.samples, 0, 'no local copy of the decoded frame');
    assert.ok(peer().convergencePx > 0, 'the shift is applied (low-passed toward d / 2)');
    // A WebRTC resolution change: the same fraction of the new eye width.
    Object.assign(video, { videoWidth: 640, videoHeight: 240 });
    recv(makeConv(0.1, 0.9));
    await paint();
    assert.equal(peer().autoConverge.disparityPx, 0.1 * 320);
    // d: null (nothing measured) holds the previous value.
    await sleep(110); // past the receiver's 10 Hz gate
    recv(makeConv(null));
    await paint();
    a = peer().autoConverge;
    assert.equal(a.source, 'sender');
    assert.equal(a.senderFrac, 0.1);
    // Junk is dropped before it reaches the tile.
    await sleep(110);
    recv({ type: 'conv', d: 3 });
    recv({ type: 'conv', d: 'x' });
    await paint();
    assert.equal(peer().autoConverge.senderFrac, 0.1);
  } finally {
    call.leave();
  }
});

test('receiver: a conv older than 1.2 s → local measuring resumes, holding the sender value until it locks', { timeout: 10000 }, async () => {
  const { call, peer } = await receiverCall({ firstConv: 0.1 });
  try {
    await paint();
    assert.equal(peer().autoConverge.samples, 0);
    await sleep(1250);
    await paint();
    await sleep(220);
    await paint();
    const a = peer().autoConverge;
    assert.ok(a.samples >= 1, `measuring locally again (${a.samples})`);
    assert.equal(a.source, 'local');
    assert.equal(a.disparityPx, 64, 'an unreadable local frame does not drop the last value');
  } finally {
    call.leave();
  }
});

test('receiver: an older sender (no hello.conv) is measured locally, exactly as in 1.47', { timeout: 10000 }, async () => {
  const { call, recv, peer } = await receiverCall({ conv: false });
  try {
    recv(makeConv(0.1, 0.9)); // not announced: ignored
    await paint();
    const a = peer().autoConverge;
    assert.ok(a.samples >= 1, 'measured the decoded frame');
    assert.equal(a.disparityPx, null, 'the unannounced conv was not applied');
    assert.notEqual(a.source, 'sender');
    assert.equal(peer().hello.conv, false);
  } finally {
    call.leave();
  }
});

test('receiver: autoConverge: false ignores conv (and measures nothing)', { timeout: 10000 }, async () => {
  const { call, peer } = await receiverCall({ firstConv: 0.1, opts: { autoConverge: false } });
  try {
    await paint();
    await sleep(220);
    await paint();
    const a = peer().autoConverge;
    assert.equal(a.disparityPx, null);
    assert.equal(a.source, null);
    assert.equal(a.samples, 0);
    assert.equal(peer().convergencePx, 0, 'the pair as sent');
  } finally {
    call.leave();
  }
});

test('receiver: a hovering depth cursor still copies the frame locally; the sender value still wins', { timeout: 10000 }, async () => {
  const { call, peer } = await receiverCall({ firstConv: 0.1, opts: { cursor: { pointerScope: 'canvas' } } });
  try {
    for (let i = 0; i < 20; i++) await flush(); // the cursor module loads lazily
    const canvas = peer().element.children[0].children[0];
    assert.equal(canvas.tagName, 'CANVAS');
    canvas.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100 });
    for (const f of canvas.listeners.pointermove || []) f({ clientX: 100, clientY: 50, pointerType: 'mouse', timeStamp: 1 });
    assert.ok((canvas.listeners.pointermove || []).length, 'the depth cursor listens on the tile');
    await paint();
    await sleep(80);
    await paint();
    const a = peer().autoConverge;
    assert.ok(a.samples >= 1, `the cursor's copy (${a.samples})`);
    assert.equal(a.source, 'sender');
    assert.equal(a.disparityPx, 64);
  } finally {
    call.leave();
  }
});

// The headless-mode hooks a chat app that owns its layouts needs (docs/call.md § Headless mode),
// through the real Call with the recording DOM (test/call-dom.mjs) and a fake ResizeObserver:
// names, app messages, the signal / weave / speaking events, tileCover → rectCover, tileAspect
// 'fill', the self tile accessor, setSelfView, setAudioOutput, quality.path and the hidden-tile
// paint skip.
import test from 'node:test';
import assert from 'node:assert/strict';

import { installCallDom, doc, channels, El, FakeTrack, FakeStream } from './call-dom.mjs';

installCallDom();
let rafCb = null;
globalThis.requestAnimationFrame = (cb) => {
  rafCb = cb;
  return 1;
};
globalThis.addEventListener ??= () => {};
globalThis.removeEventListener ??= () => {};
// A ResizeObserver the test fires by hand, per observed element.
const observers = [];
globalThis.ResizeObserver = class {
  constructor(cb) {
    this.cb = cb;
    this.targets = [];
    observers.push(this);
  }
  observe(t) {
    this.targets.push(t);
  }
  disconnect() {
    this.targets = [];
  }
};
function setBox(el, w, h) {
  el.clientWidth = w;
  el.clientHeight = h;
  for (const o of observers) if (o.targets.includes(el)) o.cb([{ target: el }]);
}
El.prototype.setSinkId = async function (id) {
  if (this.refuseSink) throw new Error('NotFoundError');
  this.sinkId = id;
};

const { addCall } = await import('../js/inline3d-call.js');
const { makeHello, sanitizeName, makeAppMessage, normalizeApp, windowGate, selectedPath, APP_MAX_BYTES, NAME_MAX_CHARS } = await import('../js/call/wire.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};
const ROOM = 'R'.repeat(22);
const PEER = '~~~~~~~~~~~'; // sorts above any real id: this side offers and builds the data channel
const PEER2 = '~~~~~~~~~~z';
const sbsStream = () => new FakeStream([Object.assign(new FakeTrack('video'), { getSettings: () => ({ width: 1280, height: 480 }) })]);
const monoStream = () => new FakeStream([new FakeTrack('video')]);
const findPart = (n, name) => (n.attrs && n.attrs.part === name ? n : (n.children || []).map((c) => findPart(c, name)).find(Boolean));

/** Signalling with one peer already in the room; the hooks are kept so a test can drive them. */
function signalingWith(peers = [PEER]) {
  const s = { hooks: null };
  s.adapter = {
    async join(room, hooks) {
      s.hooks = hooks;
      return { id: hooks.id, peers: [...peers], send() {}, leave() {} };
    },
  };
  return s;
}

/** A 3D wall whose tiles the test settles by hand; records every addImage's options. */
function fwWall() {
  const added = [];
  const wall = {
    supported: true,
    addImage(canvas, src, opts) {
      let settle;
      const firstWoven = new Promise((r) => (settle = r));
      const h = {
        canvas,
        src,
        opts,
        removed: 0,
        firstWoven,
        settle: (woven, reason) => settle({ woven, confirmed: false, reason, ms: 7 }),
        rewovenCalls: 0,
        rw: null,
        rewoven() {
          this.rewovenCalls++;
          if (!this.rw) {
            let r;
            const p = new Promise((x) => (r = x));
            this.rw = { p, settle: (res) => ((this.rw = null), r(res)) };
          }
          return this.rw.p;
        },
        remove() {
          this.removed++;
        },
      };
      added.push(h);
      return h;
    },
  };
  return { wall, added };
}

/** A tapped data channel to the peer: every message this side sends, parsed. */
function tap() {
  const dc = channels.at(-1);
  const sent = [];
  dc.send = (data) => sent.push(JSON.parse(data));
  const recv = (msg) => dc.onmessage({ data: JSON.stringify(msg) });
  return { dc, sent, recv };
}

/** The remote participant's video (the last one this side created), playing at w×h. */
function playRemote(w = 1280, h = 480) {
  const v = doc.created.filter((e) => e.tagName === 'VIDEO' && (e.listeners.playing || []).length).at(-1);
  Object.assign(v, { readyState: 4, videoWidth: w, videoHeight: h });
  v.fire('playing');
  return v;
}

async function headless(wall, extra = {}, sig = signalingWith()) {
  const host = doc.body.appendChild(doc.createElement('div'));
  const events = {};
  const call = await addCall(wall, host, { signaling: sig.adapter, room: ROOM, ui: false, audio: false, selfView: false, camera: monoStream(), format: 'mono', sendConvergence: false, ...extra });
  for (const t of ['name', 'message', 'signal', 'weave', 'speaking', 'quality']) call.on(t, (e) => (events[t] ||= []).push(e));
  return { call, host, events, sig, ...tap() };
}

// ── pure parts ─────────────────────────────────────────────────────────────────────────────────

test('sanitizeName: control and bidi characters out, whitespace collapsed, ≤ 64 code points, junk → null', () => {
  assert.equal(sanitizeName('  Ada\u0000 \u0007Lovelace\n'), 'Ada Lovelace');
  assert.equal(sanitizeName('evil‮gnp.exe'), 'evil gnp.exe');
  assert.equal(sanitizeName('​​'), null);
  assert.equal(sanitizeName(42), null);
  assert.equal(sanitizeName({ toString: () => 'x' }), null);
  assert.equal(Array.from(sanitizeName('😀'.repeat(100))).length, NAME_MAX_CHARS, 'counted in code points, never a split surrogate');
  const h = makeHello({ format: 'mono', name: ' Bo\tb ' });
  assert.equal(h.name, 'Bo b');
  assert.ok(!('name' in makeHello({ format: 'mono' })), 'no name, no field');
});

test('app messages: wrap / size cap / unserialisable; only type app is one; the window gate', () => {
  assert.deepEqual(JSON.parse(makeAppMessage({ a: 1 }).json), { type: 'app', d: { a: 1 } });
  assert.equal(makeAppMessage('x'.repeat(APP_MAX_BYTES)), null, 'over 16 KiB serialised');
  assert.ok(makeAppMessage('x'.repeat(APP_MAX_BYTES - 30)));
  assert.equal(makeAppMessage('é'.repeat(APP_MAX_BYTES / 2)), null, 'measured in UTF-8 bytes');
  const cyc = {};
  cyc.self = cyc;
  assert.equal(makeAppMessage(cyc), null);
  assert.equal(makeAppMessage(undefined), null);
  assert.equal(makeAppMessage(10n), null);
  assert.deepEqual(normalizeApp({ type: 'app', d: null }), { data: null });
  assert.equal(normalizeApp({ type: 'hello' }), null);
  assert.equal(normalizeApp({ type: 'app' }), null);
  const g = windowGate(3, 1000);
  assert.deepEqual([g(0), g(10), g(20), g(30), g(999), g(1000), g(1011)], [true, true, true, false, false, true, true]);
});

test('selectedPath: Chrome (transport → pair), Firefox (selected), relay on either end, none yet', () => {
  const rep = (...s) => new Map(s.map((x) => [x.id, x]));
  const chrome = rep(
    { id: 't', type: 'transport', selectedCandidatePairId: 'cp' },
    { id: 'cp', type: 'candidate-pair', localCandidateId: 'l', remoteCandidateId: 'r', currentRoundTripTime: 0.0425 },
    { id: 'l', type: 'local-candidate', candidateType: 'srflx' },
    { id: 'r', type: 'remote-candidate', candidateType: 'host' }
  );
  assert.deepEqual(selectedPath(chrome), { path: 'srflx', rttMs: 43 });
  const firefox = rep(
    { id: 'cp', type: 'candidate-pair', selected: true, localCandidateId: 'l', remoteCandidateId: 'r' },
    { id: 'l', type: 'local-candidate', candidateType: 'host' },
    { id: 'r', type: 'remote-candidate', candidateType: 'relay' }
  );
  assert.deepEqual(selectedPath(firefox), { path: 'relay', rttMs: null });
  assert.deepEqual(selectedPath(rep({ id: 'cp', type: 'candidate-pair', state: 'in-progress' })), { path: null, rttMs: null });
});

// ── through the Call ─────────────────────────────────────────────────────────────────────────

test('names: hello carries the name, peers[].name + the name event, setName re-broadcasts, junk is sanitised', async () => {
  const { call, events, dc, sent, recv } = await headless({ supported: false }, { name: '  Alice\u0000 ' });
  try {
    assert.equal(call.name, 'Alice');
    dc.onopen();
    assert.equal(sent.find((m) => m.type === 'hello').name, 'Alice');
    assert.equal(call.setName('Bob‮'), 'Bob');
    assert.equal(sent.at(-1).type, 'hello');
    assert.equal(sent.at(-1).name, 'Bob', 'setName re-sends hello to everyone');
    assert.equal(call.setName(''), null);
    assert.ok(!('name' in sent.at(-1)), 'a cleared name is not sent');

    recv(makeHello({ format: 'mono', width: 640, height: 480 }));
    assert.equal(call.peers[0].name, null, 'an older peer: no name');
    assert.equal(events.name, undefined, 'no name, no event');
    recv({ ...makeHello({ format: 'mono' }), name: `\u0001Zed\u0002${'z'.repeat(200)}` });
    assert.equal(call.peers[0].name, `Zed ${'z'.repeat(NAME_MAX_CHARS - 4)}`);
    recv({ ...makeHello({ format: 'mono' }), name: `\u0001Zed\u0002${'z'.repeat(200)}` });
    assert.equal(events.name.length, 1, 'the same name again: no event');
    recv({ ...makeHello({ format: 'mono' }), name: 42 });
    assert.deepEqual(events.name.at(-1), { id: PEER, name: null });
  } finally {
    call.leave();
  }
});

test('app messages: send / broadcast, 16 KiB cap, 20/s per peer, only type app surfaces', async () => {
  const { call, events, dc, sent, recv } = await headless({ supported: false });
  try {
    dc.onopen();
    const base = sent.length;
    assert.equal(call.send(PEER, { chat: 'hi' }), true);
    assert.deepEqual(sent.at(-1), { type: 'app', d: { chat: 'hi' } });
    assert.equal(call.send('nobody', 1), false, 'not a participant');
    assert.equal(call.send(PEER, 'x'.repeat(APP_MAX_BYTES)), false, 'over 16 KiB: nothing sent');
    assert.equal(call.send(PEER, () => 1), false, 'not serialisable');
    assert.equal(call.broadcast({ n: 0 }), true);
    let ok = 2;
    while (call.send(PEER, ok)) ok++;
    assert.equal(ok, 20, 'the 21st in a second is refused');
    assert.equal(call.broadcast('late'), false, 'and broadcast says so');
    assert.equal(sent.slice(base).filter((m) => m.type === 'app').length, 20);

    // Receiving: app messages surface; the SDK's own types never do; junk is ignored.
    recv({ type: 'app', d: { emoji: '👍' } });
    recv(makeHello({ format: 'mono' }));
    recv({ type: 'state', muted: true });
    recv({ type: 'conv', d: 0.01 });
    recv({ type: 'hint', subjectZmm: 600 });
    recv({ type: 'mystery', d: 1 });
    recv({ type: 'app' });
    assert.deepEqual(events.message, [{ from: PEER, data: { emoji: '👍' } }]);
    for (let i = 0; i < 60; i++) recv({ type: 'app', d: i });
    assert.equal(events.message.length, 40, 'a receiver drops anything over 40/s from one peer');
  } finally {
    call.leave();
  }
  assert.equal(call.send(PEER, 1), false, 'after leave');
});

test('signal: connected on join, reconnecting / connected / closed (+ code) from the adapter, null after leave', async () => {
  const { call, events, sig } = await headless({ supported: false });
  try {
    assert.equal(call.signal, 'connected');
    sig.hooks.onDisconnect();
    assert.equal(call.signal, 'reconnecting');
    sig.hooks.onReconnect([]);
    assert.equal(call.signal, 'connected');
    sig.hooks.onDisconnect(Object.assign(new Error('the room expired'), { code: 'expired' }));
    assert.equal(call.signal, 'closed');
    // `connected` fired before this listener was attached (join resolved inside addCall).
    assert.deepEqual(events.signal, [{ state: 'reconnecting' }, { state: 'connected' }, { state: 'closed', code: 'expired' }]);
  } finally {
    call.leave();
  }
  assert.equal(call.signal, null);
});

test("tile('self') + data-dxr-peer=self; layout: 'none' lets the footer and self slot step aside", async () => {
  const host = doc.body.appendChild(doc.createElement('div'));
  const call = await addCall({ supported: false }, host, { signaling: signalingWith([]).adapter, room: ROOM, ui: 'tiles', layout: 'none', audio: false, camera: sbsStream(), format: 'sbs' });
  try {
    const self = call.tile('self');
    assert.ok(self);
    assert.equal(self.getAttribute('data-dxr-peer'), 'self');
    assert.ok(host.classList.contains('dxr-call-host--none'));
    const css = doc.head.children.find((c) => c.tagName === 'STYLE' && /dxr-call-host/.test(c.textContent)).textContent;
    assert.match(css, /\.dxr-call-host--none \.dxr-call-foot,\.dxr-call-host--none \.dxr-call-self\{display:contents;\}/);
  } finally {
    call.leave();
  }
  const grid = await addCall({ supported: false }, doc.body.appendChild(doc.createElement('div')), { signaling: signalingWith([]).adapter, room: ROOM, ui: false, audio: false, selfView: false, camera: monoStream() });
  assert.equal(grid.tile('self'), null, 'no self view, no self tile');
  grid.leave();
});

test('setSelfView: off removes the layer (then hides the box); on registers it again; the weave event says self', async () => {
  const { wall, added } = fwWall();
  const { call, events } = await headless(wall, { selfView: true, camera: sbsStream(), format: 'sbs' }, signalingWith([]));
  try {
    await flush();
    assert.equal(added.length, 1, 'the self view is on the wall');
    added[0].settle(true, 'hold-elapsed');
    await flush();
    assert.deepEqual(events.weave, [{ id: 'self', state: 'woven', reason: 'hold-elapsed', ms: 7, kind: 'camera' }]);
    assert.equal(call.setSelfView(false), false);
    assert.equal(added[0].removed, 1, 'the layer is removed, not hidden under display:none');
    assert.ok(call.tile('self').classList.contains('dxr-call-hidden'));
    call.setDepth(0.2); // an unrelated refresh must not resurrect it
    assert.equal(added.length, 1);
    assert.equal(call.setSelfView(), true, 'no argument toggles');
    assert.equal(added.length, 2);
    assert.ok(!call.tile('self').classList.contains('dxr-call-hidden'));
    added[1].settle(false, 'layer-failed');
    await flush();
    assert.deepEqual(events.weave.at(-1), { id: 'self', state: 'flat', reason: 'layer-failed', ms: 0, kind: 'camera' });
  } finally {
    call.leave();
  }
  // selfView: false at mount, then on: the self tile is created on demand.
  const late = await headless({ supported: false }, { selfView: false }, signalingWith([]));
  assert.equal(late.call.tile('self'), null);
  assert.equal(late.call.setSelfView(true), true);
  assert.ok(late.call.tile('self'));
  late.call.leave();
});

test("weave events for a peer (firstWoven → woven; failure → flat; a resize → rewoven) and tileCover → rectCover", async () => {
  const { wall, added } = fwWall();
  const { call, events, recv } = await headless(wall, { layout: 'none' });
  try {
    recv(makeHello({ format: 'sbs', width: 1280, height: 480 }));
    playRemote();
    assert.equal(added.length, 1);
    assert.deepEqual(added[0].opts, { rectCover: 'auto' }, "layout: 'none' → tileCover 'auto' → the core's rectCover");
    const stage = call.tile(PEER).children[0];
    setBox(stage, 640, 360); // the first look: a baseline, no rewoven
    added[0].settle(true, 'woven');
    await flush();
    assert.deepEqual(events.weave, [{ id: PEER, state: 'woven', reason: 'woven', ms: 7, kind: 'camera' }]);
    setBox(stage, 800, 450);
    assert.equal(added[0].rewovenCalls, 1);
    setBox(stage, 820, 460); // still settling: the same pending promise, one event
    added[0].rw.settle({ woven: true, confirmed: true, reason: 'woven', ms: 300 });
    await flush();
    assert.deepEqual(events.weave.at(-1), { id: PEER, state: 'woven', reason: 'woven', ms: 300, kind: 'camera' });
    assert.equal(events.weave.length, 2);
  } finally {
    call.leave();
  }
  // A layer the wall refuses: flat + reason. The grid layout keeps the core default (no option).
  {
    const { wall: w2, added: a2 } = fwWall();
    const { call: c2, events: e2, recv: r2 } = await headless(w2);
    try {
      r2(makeHello({ format: 'sbs', width: 1280, height: 480 }));
      playRemote();
      assert.equal(a2[0].opts, undefined, "layout 'grid': tileCover 'off' — addImage exactly as before");
      a2[0].settle(false, 'layer-failed');
      await flush();
      assert.deepEqual(e2.weave[0], { id: PEER, state: 'flat', reason: 'layer-failed', ms: 7, kind: 'camera' });
    } finally {
      c2.leave();
    }
  }
  // tileCover: 'auto' on a grid layout; 'off' on 'none'.
  for (const [extra, want] of [[{ tileCover: 'auto' }, { rectCover: 'auto' }], [{ layout: 'none', tileCover: 'off' }, undefined]]) {
    const { wall: w3, added: a3 } = fwWall();
    const { call: c3, recv: r3 } = await headless(w3, extra);
    r3(makeHello({ format: 'sbs', width: 1280, height: 480 }));
    playRemote();
    assert.deepEqual(a3[0].opts, want);
    c3.leave();
  }
});

test("tileAspect 'fill': no aspect-ratio on the stage; the crop follows the stage box; a hidden tile does not paint", async () => {
  const { wall, added } = fwWall();
  const { call, recv } = await headless(wall, { theme: { tileAspect: 'fill' } });
  try {
    recv(makeHello({ format: 'sbs', width: 1280, height: 480 }));
    playRemote();
    const stage = call.tile(PEER).children[0];
    assert.equal(stage.style.aspectRatio, undefined, 'the page sizes the stage');
    const conv = added[0].src;
    let paints = 0;
    const ctx = conv.getContext();
    conv.getContext = () => (paints++, ctx);
    setBox(stage, 300, 400);
    rafCb(performance.now());
    assert.ok(Math.abs(conv.width / 2 / conv.height - 0.75) < 0.02, `per eye ${conv.width / 2}x${conv.height} = the stage's 3:4`);
    setBox(stage, 1000, 100);
    rafCb(performance.now());
    assert.ok(Math.abs(conv.width / 2 / conv.height - 4) < 0.05, 'clamped at 4');
    const n = paints;
    setBox(stage, 0, 0); // display:none
    rafCb(performance.now());
    rafCb(performance.now());
    assert.equal(paints, n, 'a 0×0 stage is not painted');
    setBox(stage, 400, 300);
    rafCb(performance.now());
    assert.equal(paints, n + 1, 'shown again: painted');
  } finally {
    call.leave();
  }
  // The numeric default is untouched.
  const { wall: w2, added: a2 } = fwWall();
  const d = await headless(w2);
  d.recv(makeHello({ format: 'sbs', width: 1280, height: 480 }));
  playRemote();
  assert.equal(d.call.tile(PEER).children[0].style.aspectRatio, String(16 / 9));
  setBox(d.call.tile(PEER).children[0], 300, 400);
  rafCb(performance.now());
  assert.ok(Math.abs(a2[0].src.width / 2 / a2[0].src.height - 16 / 9) < 0.02, 'a fixed aspect ignores the box');
  d.call.leave();
});

test('setAudioOutput applies to existing tiles and to tiles that join later; a refusal resolves false', async () => {
  const sig = signalingWith();
  const { call } = await headless({ supported: false }, {}, sig);
  try {
    const audios = () => doc.created.filter((e) => e.tagName === 'AUDIO');
    const first = audios().at(-1);
    assert.equal(await call.setAudioOutput('speakers-2'), true);
    assert.equal(first.sinkId, 'speakers-2');
    sig.hooks.onPeerJoined(PEER2);
    await flush();
    const second = audios().at(-1);
    assert.notEqual(second, first);
    await flush();
    assert.equal(second.sinkId, 'speakers-2', 'a later tile plays to the same output');
    second.refuseSink = true;
    assert.equal(await call.setAudioOutput('gone'), false);
    assert.equal(first.sinkId, 'gone');
  } finally {
    call.leave();
  }
});

test('setMic replaces the audio track on the senders; localStream is what is sent', async () => {
  const opened = [];
  globalThis.navigator ??= {};
  const prev = globalThis.navigator.mediaDevices;
  globalThis.navigator.mediaDevices = {
    async getUserMedia({ audio }) {
      opened.push(audio.deviceId ? audio.deviceId.exact : 'default');
      if (audio.deviceId && audio.deviceId.exact === 'broken') throw Object.assign(new Error('x'), { name: 'NotReadableError' });
      return new FakeStream([new FakeTrack('audio')]);
    },
  };
  const { call } = await headless({ supported: false });
  try {
    const before = call.localStream;
    assert.ok(before);
    const pc = call.diagnostics().transport.peerConnection(PEER);
    const replaced = [];
    for (const t of pc.getTransceivers()) {
      const r = t.sender.replaceTrack;
      t.sender.replaceTrack = async (tr) => (replaced.push(tr), r(tr));
      t.receiver.track = { kind: 'audio' };
    }
    assert.equal(await call.setMic('usb-mic'), true);
    assert.deepEqual(opened, ['usb-mic']);
    const a = call.localStream.getAudioTracks()[0];
    assert.ok(a && replaced.includes(a), 'the new track is on the senders');
    assert.notEqual(call.localStream, before);
    call.mute(true);
    assert.equal(await call.setMic('broken'), false, 'cannot open: kept');
    assert.equal(call.localStream.getAudioTracks()[0], a);
    assert.equal(await call.setMic(null), true);
    assert.equal(call.localStream.getAudioTracks()[0].enabled, false, 'a muted call stays muted');
    assert.equal(a.readyState, 'ended', 'the old track is stopped');
  } finally {
    call.leave();
    globalThis.navigator.mediaDevices = prev;
  }
});

test('speaking events (a peer, and self) and quality.path / rttMs from the selected candidate pair', { timeout: 15000 }, async () => {
  const { call, events, recv } = await headless({ supported: false });
  try {
    recv(makeHello({ format: 'mono', width: 640, height: 480 }));
    const pc = call.diagnostics().transport.peerConnection(PEER);
    let level = 0.5;
    pc.getStats = async () =>
      new Map(
        [
          { id: 'a', type: 'inbound-rtp', kind: 'audio', audioLevel: level },
          { id: 'm', type: 'media-source', kind: 'audio', audioLevel: level },
          { id: 'v', type: 'inbound-rtp', kind: 'video', frameWidth: 640, frameHeight: 480, framesPerSecond: 30, bytesReceived: 1000, timestamp: performance.now() },
          { id: 't', type: 'transport', selectedCandidatePairId: 'cp' },
          { id: 'cp', type: 'candidate-pair', localCandidateId: 'l', remoteCandidateId: 'r', currentRoundTripTime: 0.031 },
          { id: 'l', type: 'local-candidate', candidateType: 'host' },
          { id: 'r', type: 'remote-candidate', candidateType: 'relay' },
        ].map((s) => [s.id, s])
      );
    await sleep(650);
    assert.deepEqual(
      (events.speaking || []).map((e) => e.id).sort(),
      [PEER, 'self'].sort(),
      'both start speaking'
    );
    assert.ok(events.speaking.every((e) => e.on === true));
    for (let i = 0; i < 50 && !(events.quality || []).some((q) => q.id === PEER); i++) await sleep(50);
    const q = events.quality.find((x) => x.id === PEER);
    assert.equal(q.path, 'relay');
    assert.equal(q.rttMs, 31);
    level = 0; // the remote level decays (×0.6 per 500 ms tick), so this takes a few seconds
    for (let i = 0; i < 120 && events.speaking.length < 4; i++) await sleep(50);
    assert.deepEqual(events.speaking.slice(2).map((e) => e.on), [false, false]);
  } finally {
    call.leave();
  }
});

// The content tile (3D app share, docs/call.md § Sharing a 3D app): a SECOND video track per pair
// that carries a running app's side-by-side views. What is pinned here:
//  - transport: the content transceiver exists only when BOTH hellos say `content`; an older peer
//    never gets a second video m-line (so never a second camera sender); it is the second video
//    transceiver in getTransceivers() order on both ends; ontrack routes it to onContentStream and
//    never touches the camera stream; the answerer never puts its camera on it; tuneSenders gives it
//    the SBS budget and `maintain-resolution`, and the camera ×0.6 while content is on;
//  - call: shareContent → a `content` message with the KNOWN convergence; a receiver shows a content
//    tile that applies `frac` directly (display-referred) and never samples the frames; stopContent
//    empties the sender, removes the tile and says `on: false`; a late joiner gets the message on open.
// Recording DOM + a fake WebRTC whose transceivers know their kind (test/call-dom.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';

import { installCallDom, doc, FakeTrack, FakeStream } from './call-dom.mjs';

installCallDom();
let rafCb = null;
globalThis.requestAnimationFrame = (cb) => {
  rafCb = cb;
  return 1;
};
globalThis.addEventListener ??= () => {};
globalThis.removeEventListener ??= () => {};

// ── a fake RTCPeerConnection whose transceivers carry their kind, and an SDP of m-lines ───────

let rid = 0;
function transceiver(kind, track = null) {
  return {
    direction: 'sendrecv',
    receiver: { track: { kind, id: `remote-${kind}-${++rid}` } },
    sender: {
      track,
      replaced: [],
      params: { encodings: [{}] },
      async replaceTrack(t) {
        this.track = t;
        this.replaced.push(t);
      },
      setStreams() {},
      getParameters() {
        return { ...this.params, encodings: this.params.encodings.map((e) => ({ ...e })) };
      },
      async setParameters(p) {
        this.params = p;
      },
    },
    setCodecPreferences() {},
  };
}
const sdpOf = (kinds) => ['v=0', ...kinds.map((k) => `m=${k} 9 UDP/TLS/RTP/SAVPF 96`)].join('\r\n') + '\r\n';
const kindsOf = (sdp) => [...sdp.matchAll(/^m=(audio|video)/gm)].map((m) => m[1]);

class KindPC {
  static all = [];
  constructor() {
    this.connectionState = 'new';
    this.signalingState = 'stable';
    this.transceivers = [];
    this.remoteDescription = null;
    this.localDescription = null;
    KindPC.all.push(this);
  }
  createDataChannel() {
    const dc = { readyState: 'open', sent: [], send(d) { this.sent.push(JSON.parse(d)); }, close() {} };
    this.dc = dc;
    return dc;
  }
  addTransceiver(trackOrKind) {
    const t = typeof trackOrKind === 'string' ? transceiver(trackOrKind) : transceiver(trackOrKind.kind, trackOrKind);
    this.transceivers.push(t);
    return t;
  }
  getTransceivers() {
    return this.transceivers;
  }
  getSenders() {
    return this.transceivers.map((t) => t.sender);
  }
  videos() {
    return this.transceivers.filter((t) => t.receiver.track.kind === 'video');
  }
  async createOffer() {
    return { type: 'offer', sdp: sdpOf(this.transceivers.map((t) => t.receiver.track.kind)) };
  }
  async createAnswer() {
    return { type: 'answer', sdp: this.remoteDescription.sdp };
  }
  async setLocalDescription(d) {
    this.localDescription = d;
    this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable';
  }
  async setRemoteDescription(d) {
    this.remoteDescription = d;
    // An offer's m-lines create the answerer's transceivers, in order (as WebRTC does).
    if (d.type === 'offer') kindsOf(d.sdp).forEach((k, i) => this.transceivers[i] || this.transceivers.push(transceiver(k)));
    this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable';
  }
  async addIceCandidate() {}
  close() {
    this.connectionState = 'closed';
  }
}
globalThis.RTCPeerConnection = KindPC;

const { addCall } = await import('../js/inline3d-call.js');
const { MeshTransport, CAMERA_SHARE_FACTOR } = await import('../js/call/transport.js');
const { makeHello, makeContent, maxBitrateKbps } = await import('../js/call/wire.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
const paint = async (n = 1) => {
  for (let i = 0; i < n; i++) {
    rafCb(performance.now());
    await flush();
  }
};
const ROOM = 'R'.repeat(22);
const PEER = '~~~~~~~~~~~'; // sorts above any real id: this side OFFERS

function recSignaling(peers = [PEER]) {
  const sig = { sent: [], hooks: null };
  sig.join = async (room, hooks) => {
    sig.hooks = hooks;
    return { id: hooks.id, peers, send: (to, data) => sig.sent.push({ to, data }), leave() {} };
  };
  sig.offers = () => sig.sent.filter((m) => m.data.kind === 'offer');
  return sig;
}

const monoCam = () => new FakeStream([Object.assign(new FakeTrack('video'), { id: 'cam-track' })]);
/** A shared app's track as the shipping browser gives it: the label, no source hint. */
function appStream(name = 'Cube', settings = {}) {
  const l = {};
  const t = Object.assign(new FakeTrack('video'), {
    id: 'app-track',
    label: `DisplayXR: ${name} (3D)`,
    getSettings: () => ({ width: 2560, height: 720, deviceId: 'dxr-app:1', displayxrStereo: { layout: 'side-by-side', rectified: true }, ...settings }),
    addEventListener: (type, f) => ((l[type] ||= []).push(f)),
    removeEventListener: (type, f) => (l[type] = (l[type] || []).filter((x) => x !== f)),
    fire: (type) => (l[type] || []).forEach((f) => f({ type })),
  });
  return new FakeStream([t]);
}

/** A 3D wall whose addImage records every registration and settles its firstWoven at once. */
function wovenWall() {
  const added = [];
  return {
    added,
    supported: true,
    addImage(canvas, src) {
      const h = { canvas, src, removed: 0, firstWoven: Promise.resolve({ woven: true, ms: 5 }), remove() { h.removed++; } };
      added.push(h);
      return h;
    },
  };
}

async function offererCall({ wall = { supported: false }, opts = {} } = {}) {
  KindPC.all = [];
  const sig = recSignaling();
  const host = doc.body.appendChild(doc.createElement('div'));
  const call = await addCall(wall, host, { signaling: sig, room: ROOM, ui: false, audio: false, selfView: false, camera: monoCam(), format: 'mono', sendConvergence: false, ...opts });
  const pc = KindPC.all.at(-1);
  const dc = pc.dc;
  const recv = (msg) => dc.onmessage({ data: JSON.stringify(msg) });
  const events = {};
  for (const t of ['content', 'warning', 'weave', 'display']) call.on(t, (e) => (events[t] ||= []).push(e));
  await flush();
  // The first offer is out (have-local-offer); answer it like the far end would.
  const answer = async () => {
    await sig.hooks.onSignal(PEER, { kind: 'answer', gen: 1, sdp: pc.localDescription.sdp });
    await flush();
  };
  return { call, sig, pc, dc, recv, events, answer };
}

// ── transport ────────────────────────────────────────────────────────────────────────────────

test('no content transceiver unless BOTH hellos say content; then a same-generation re-offer adds it', async () => {
  const { call, sig, pc, recv, answer, dc } = await offererCall();
  try {
    assert.equal(pc.videos().length, 1, 'one camera video m-line to start with');
    dc.onopen();
    assert.equal(dc.sent.find((m) => m.type === 'hello').content, true, 'this SDK advertises the capability');
    recv(makeHello({ format: 'mono' })); // an older peer: no `content`
    await flush();
    assert.equal(pc.videos().length, 1, 'an old peer never gets a second video m-line');
    recv(makeHello({ format: 'mono', content: true }));
    await flush();
    assert.equal(pc.videos().length, 2, 'both said content: the content transceiver');
    assert.equal(sig.offers().length, 1, 'the first offer is still out: the re-offer waits for its answer');
    await answer();
    const offers = sig.offers();
    assert.equal(offers.length, 2, 'renegotiated');
    assert.equal(offers[1].data.gen, offers[0].data.gen, 'same generation: the answerer takes it on the same connection');
    assert.deepEqual(kindsOf(offers[1].data.sdp), ['audio', 'video', 'video']);
    recv(makeHello({ format: 'mono', content: true })); // a repeated hello (setName, setCamera)
    await flush();
    assert.equal(pc.videos().length, 2, 'idempotent');
  } finally {
    call.leave();
  }
});

test('an old answerer never gets a second camera sender, even while this side shares', async () => {
  const { call, pc, recv, answer, events, dc } = await offererCall();
  try {
    await answer();
    dc.onopen();
    recv(makeHello({ format: 'mono' }));
    await flush();
    const cam = pc.videos()[0].sender;
    const camTrack = cam.track;
    await call.shareContent(appStream());
    assert.equal(pc.videos().length, 1, 'no transceiver was added for the share');
    assert.equal(cam.track, camTrack, 'the camera sender still sends the camera');
    assert.ok(!cam.replaced.some((t) => t && t.id === 'app-track'), 'the app never went onto the camera sender');
    assert.deepEqual(events.warning.map((w) => w.code), ['content-unsupported']);
    assert.equal(events.warning.length, 1, 'once per peer per share');
  } finally {
    call.leave();
  }
});

test('ontrack: the second video transceiver is content (onContentStream); the camera stream is untouched', async () => {
  const PCs = [];
  class P extends KindPC {
    constructor() {
      super();
      PCs.push(this);
    }
  }
  const sig = recSignaling();
  const t = new MeshTransport({ signaling: sig, id: 'aa000000', maxPeers: 4, RTCPeerConnection: P });
  const got = { stream: [], content: [] };
  await t.start({ room: ROOM, localStream: monoCam(), onStream: (id, s) => got.stream.push(s), onContentStream: (id, s) => got.content.push(s) });
  t.addContentTransceiver('zz');
  t.addContentTransceiver(PEER);
  const pc = PCs[0];
  const [camT, contentT] = pc.videos();
  const audioT = pc.transceivers[0];
  pc.ontrack({ track: audioT.receiver.track, transceiver: audioT });
  pc.ontrack({ track: camT.receiver.track, transceiver: camT });
  pc.ontrack({ track: contentT.receiver.track, transceiver: contentT });
  assert.equal(got.content.length, 1);
  assert.deepEqual(got.content[0].getTracks(), [contentT.receiver.track], 'its own stream');
  const camStream = got.stream.at(-1);
  assert.deepEqual(camStream.getTracks().map((x) => x.kind).sort(), ['audio', 'video']);
  assert.ok(camStream.getTracks().includes(camT.receiver.track), 'the camera track was NOT evicted by the content track');
  assert.ok(!camStream.getTracks().includes(contentT.receiver.track));
  // Without e.transceiver (older engines), the receiver's track identifies it.
  pc.ontrack({ track: contentT.receiver.track });
  assert.equal(got.content.length, 2);
  t.stop();
});

test('answerer: the camera goes on the first video transceiver only; the content one gets the content track (or nothing)', async () => {
  const PCs = [];
  class P extends KindPC {
    constructor() {
      super();
      PCs.push(this);
    }
  }
  const cam = monoCam();
  const sig = recSignaling([]);
  const t = new MeshTransport({ signaling: sig, id: 'zz000000', maxPeers: 4, RTCPeerConnection: P });
  await t.start({ room: ROOM, localStream: cam });
  // An offer from a NEW offerer (audio, video, video): nothing shared yet.
  await sig.hooks.onSignal('aa111111', { kind: 'offer', gen: 1, sdp: sdpOf(['audio', 'video', 'video']) });
  await flush();
  let [v0, v1] = PCs[0].videos();
  assert.equal(v0.sender.track, cam.getVideoTracks()[0]);
  assert.equal(v1.sender.track, null, 'the content sender never gets the camera');
  assert.equal(v1.direction, 'sendrecv', 'but can send later');
  // Sharing: replaceTrack on the content slot only.
  const app = appStream();
  await t.replaceTrack('video', app.getVideoTracks()[0], app, { slot: 'content' });
  assert.equal(v1.sender.track, app.getVideoTracks()[0]);
  assert.equal(v0.sender.track, cam.getVideoTracks()[0], 'the camera sender is untouched');
  // setCamera (slot camera) never touches the content sender.
  const cam2 = monoCam();
  await t.replaceTrack('video', cam2.getVideoTracks()[0], cam2);
  assert.equal(v0.sender.track, cam2.getVideoTracks()[0]);
  assert.equal(v1.sender.track, app.getVideoTracks()[0]);
  // A rebuilt connection (new generation) picks the current content track up at once.
  await sig.hooks.onSignal('aa111111', { kind: 'offer', gen: 2, sdp: sdpOf(['audio', 'video', 'video']) });
  await flush();
  [v0, v1] = PCs[1].videos();
  assert.equal(v1.sender.track, app.getVideoTracks()[0]);
  assert.equal(v0.sender.track, cam2.getVideoTracks()[0]);
  // An OLD offerer (one video m-line): the camera, and nothing else.
  const t2 = new MeshTransport({ signaling: recSignaling([]), id: 'zz000001', maxPeers: 4, RTCPeerConnection: P });
  await t2.start({ room: ROOM, localStream: cam });
  await t2.replaceTrack('video', app.getVideoTracks()[0], app, { slot: 'content' });
  await t2.signaling.hooks.onSignal('aa222222', { kind: 'offer', gen: 1, sdp: sdpOf(['audio', 'video']) });
  await flush();
  const old = PCs.at(-1);
  assert.equal(old.videos().length, 1);
  assert.equal(old.videos()[0].sender.track, cam.getVideoTracks()[0]);
  t.stop();
  t2.stop();
});

test('tuneSenders: content gets the SBS budget + maintain-resolution; the camera ×0.6 while content is on', async () => {
  const { call, pc, recv, answer, dc } = await offererCall();
  try {
    await answer();
    dc.onopen();
    recv(makeHello({ format: 'mono', content: true }));
    await flush();
    await answer(); // the re-offer's answer
    const [camT, contentT] = pc.videos();
    await call.shareContent(appStream());
    assert.equal(contentT.sender.params.encodings[0].maxBitrate, maxBitrateKbps('sbs', 1) * 1000);
    assert.equal(contentT.sender.params.degradationPreference, 'maintain-resolution');
    assert.equal(camT.sender.params.encodings[0].maxBitrate, Math.round(maxBitrateKbps('mono', 1) * CAMERA_SHARE_FACTOR) * 1000);
    assert.equal(CAMERA_SHARE_FACTOR, 0.6);
    await call.stopContent();
    assert.equal(camT.sender.params.encodings[0].maxBitrate, maxBitrateKbps('mono', 1) * 1000, 'the camera gets its budget back');
  } finally {
    call.leave();
  }
});

// ── call: the sharer ─────────────────────────────────────────────────────────────────────────

test('shareContent → the content sender + a content message with the known convergence; stopContent undoes it', async () => {
  const { call, pc, recv, answer, events, dc } = await offererCall({ opts: { selfContentView: true } });
  try {
    await answer();
    dc.onopen();
    recv(makeHello({ format: 'mono', content: true }));
    await flush();
    await answer();
    const contentT = pc.videos()[1];
    const s = appStream('Model Viewer');
    const info = await call.shareContent(s);
    assert.equal(contentT.sender.track, s.getVideoTracks()[0]);
    assert.equal(s.getVideoTracks()[0].contentHint, 'detail');
    const msg = dc.sent.filter((m) => m.type === 'content').at(-1);
    assert.deepEqual(msg, { type: 'content', on: true, format: 'sbs', width: 2560, height: 720, convergence: { known: true, frac: 0 }, appName: 'Model Viewer' }, 'no zeroDisparityShiftFrac in the hint: 0');
    assert.deepEqual({ ...info, convergence: { ...info.convergence } }, { on: true, format: 'sbs', width: 2560, height: 720, appName: 'Model Viewer', convergence: { known: true, frac: 0 } });
    assert.equal(call.content.appName, 'Model Viewer');
    assert.deepEqual(events.content, [{ id: 'self', on: true, appName: 'Model Viewer' }]);
    const preview = call.tile('self', 'content');
    assert.ok(preview, 'selfContentView: a preview tile');
    assert.equal(preview.attrs['data-dxr-kind'], 'content');
    assert.equal(call.tile('self'), null, 'selfView: false — the camera self view is a different tile');
    // Stop.
    assert.equal(await call.stopContent(), true);
    assert.equal(contentT.sender.track, null, 'replaceTrack(null) on the content sender');
    assert.equal(contentT.sender.replaced.at(-1), null);
    assert.deepEqual(dc.sent.filter((m) => m.type === 'content').at(-1), { type: 'content', on: false });
    assert.equal(call.tile('self', 'content'), null, 'the preview tile is gone');
    assert.equal(preview.parentNode, null);
    assert.equal(call.content, null);
    assert.deepEqual(events.content.at(-1), { id: 'self', on: false, appName: 'Model Viewer', reason: 'stopped' });
    assert.equal(s.getVideoTracks()[0].readyState, 'live', 'the track is the page’s: left running');
    assert.equal(await call.stopContent(), false, 'nothing to stop');
    // The hint's own frac, and stopTrack.
    const s2 = appStream('Cube', { displayxrStereo: { layout: 'side-by-side', source: 'app', appName: 'Cube', zeroDisparityShiftFrac: 0.03 } });
    await call.shareContent(s2);
    assert.deepEqual(dc.sent.filter((m) => m.type === 'content').at(-1).convergence, { known: true, frac: 0.03 });
    await call.stopContent({ stopTrack: true });
    assert.equal(s2.getVideoTracks()[0].readyState, 'ended');
  } finally {
    call.leave();
  }
});

test('a late joiner gets the content message on open; the track ending stops the share', async () => {
  const { call, recv, answer, events, dc } = await offererCall();
  try {
    await answer();
    recv(makeHello({ format: 'mono', content: true }));
    await flush();
    const s = appStream();
    await call.shareContent(s);
    const n = dc.sent.length;
    dc.onopen(); // the peer's channel opens (late joiner / rebuilt connection)
    const open = dc.sent.slice(n);
    assert.deepEqual(open.map((m) => m.type), ['hello', 'state', 'content']);
    assert.equal(open[0].content, true);
    assert.equal(open[2].on, true);
    assert.equal(open[2].appName, 'Cube');
    // The app exits: the track ends → the share stops by itself.
    s.getVideoTracks()[0].fire('ended');
    await flush();
    assert.equal(call.content, null);
    assert.deepEqual(events.content.at(-1), { id: 'self', on: false, appName: 'Cube', reason: 'ended' });
    assert.deepEqual(dc.sent.filter((m) => m.type === 'content').at(-1), { type: 'content', on: false });
  } finally {
    call.leave();
  }
});

// ── call: the receiver ───────────────────────────────────────────────────────────────────────

async function receiverWithContent(convergence = { known: true, frac: 0.04 }) {
  const wall = wovenWall();
  const r = await offererCall({ wall });
  await r.answer();
  r.dc.onopen();
  r.recv(makeHello({ format: 'mono', content: true }));
  await flush();
  await r.answer();
  r.recv(makeContent({ format: 'sbs', width: 2560, height: 720, convergence, appName: 'Cube' }));
  await flush();
  // The far end's content track arrives on the content transceiver.
  const contentT = r.pc.videos()[1];
  r.pc.ontrack({ track: contentT.receiver.track, transceiver: contentT });
  const v = doc.created.filter((e) => e.tagName === 'VIDEO' && e.srcObject && e.srcObject.getTracks?.().includes(contentT.receiver.track)).at(-1);
  assert.ok(v, 'the content tile plays the content stream');
  Object.assign(v, { readyState: 4, videoWidth: 2560, videoHeight: 720 });
  v.fire('playing');
  await flush();
  const diag = () => r.call.diagnostics().content.find((c) => c.id === PEER);
  return { ...r, wall, video: v, diag };
}

test('receiver: a content tile, woven, display-referred — frac × eye width is the disparity, nothing is sampled', async () => {
  const { call, wall, events, diag, video } = await receiverWithContent();
  try {
    const el = call.tile(PEER, 'content');
    assert.ok(el);
    assert.equal(el.attrs['data-dxr-peer'], PEER);
    assert.equal(el.attrs['data-dxr-kind'], 'content');
    assert.notEqual(el, call.tile(PEER), 'the camera tile is a different tile');
    assert.equal(diag().route, 'woven-sbs');
    assert.equal(wall.added.length, 1, 'only the content tile is woven (the peer camera is mono and not playing)');
    assert.deepEqual(events.content, [{ id: PEER, on: true, appName: 'Cube' }]);
    assert.deepEqual({ ...call.peers[0].content }, { on: true, format: 'sbs', appName: 'Cube' });
    assert.ok(events.weave.some((e) => e.id === PEER && e.kind === 'content' && e.state === 'woven'), 'the weave event carries the kind');
    assert.ok(events.display.some((e) => e.id === PEER && e.kind === 'content' && e.display === '3D'));
    await paint(80);
    const target = (0.04 * 1280) / 2; // half the display-plane disparity off each eye
    assert.ok(Math.abs(diag().convergencePx - target) < 0.05, `shift ${diag().convergencePx} → ${target}`);
    assert.equal(diag().samples, 0, 'never measured');
    // The depth control still adds.
    call.setDepth(0.5);
    await paint(80);
    assert.ok(Math.abs(diag().convergencePx - (target + 0.5 * 0.05 * 1280)) < 0.1, `with depth: ${diag().convergencePx}`);
    assert.equal(diag().samples, 0);
    // A WebRTC resolution change: the same FRACTION of the new eye width.
    call.setDepth(0);
    Object.assign(video, { videoWidth: 1280, videoHeight: 360 });
    await paint(80);
    assert.ok(Math.abs(diag().convergencePx - (0.04 * 640) / 2) < 0.05);
  } finally {
    call.leave();
  }
});

test('receiver: an unknown convergence is shown as sent; on:false removes the tile; a peer leaving removes it too', async () => {
  const { call, recv, events, diag } = await receiverWithContent({ known: false, frac: null });
  try {
    await paint(30);
    assert.equal(diag().convergencePx, 0);
    assert.equal(diag().samples, 0);
    const el = call.tile(PEER, 'content');
    recv({ type: 'content', on: false });
    await flush();
    assert.equal(call.tile(PEER, 'content'), null);
    assert.equal(el.parentNode, null, 'removed from the DOM');
    assert.deepEqual(events.content.at(-1), { id: PEER, on: false, appName: 'Cube' });
    assert.equal(call.peers[0].content.on, false);
    // Junk does not create a tile.
    recv({ type: 'content', on: 'yes' });
    recv({ type: 'content' });
    await flush();
    assert.equal(call.tile(PEER, 'content'), null);
    assert.equal(events.content.length, 2, 'no event for a repeated off');
  } finally {
    call.leave();
  }
});

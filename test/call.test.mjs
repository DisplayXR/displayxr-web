// Tests for @displayxr/inline3d/call's pure parts, its mesh transport against a mocked WebRTC, and
// the dxr-signal/1 protocol against the real Node dev server. The media path itself (camera, VP9,
// the woven tile) needs a browser: it is covered by the headless-Chrome end-to-end run described
// in the PR, and the woven route by a DisplayXR panel.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  normalizeCallOptions,
  routeFor,
  badgeFor,
  normalizeHello,
  makeHello,
  newRoomId,
  isValidRoomId,
  parseInviteLink,
  buildInviteLink,
  convergenceShiftPx,
  lowPass,
  clampShift,
  eyeCropRect,
  mirrorSwapOps,
  mirrorSwapPixels,
  maxBitrateKbps,
  preferVideoCodecs,
  sortCodecCapabilities,
  MeshTransport,
  clampMaxPeers,
  qrEncode,
  dxrSignaling,
  roomKey,
  resolveLift,
  createLiftPool,
  createFrameWatch,
  liftConvergenceFor,
  liftPriorityFor,
  setLiftPriority,
  defaultLiftSpecifier,
  LIFT_PRIORITY,
} from '../js/inline3d-call.js';
import {
  focalPx,
  createConvergence,
  eyeOutputSize,
  normalizeHint,
  normalizeState,
  rateGate,
  backoffMs,
  base64url,
  looksSbs,
  CONVERGENCE_MAX_FRACTION,
  createLiveGate,
} from '../js/call/wire.js';
import { videoCodecOrder } from '../js/call/sdp.js';
import { isOfferer } from '../js/call/transport.js';
import { stereoLabelHint, openCamera, noCameraCode, isBusyError } from '../js/call/capture.js';
import { peerjsCloud } from '../js/call/signaling.js';
import { startDevServer } from '../signaling/dev-server.mjs';
import { Room, mintTurnCredentials } from '../signaling/room.mjs';

// ── SDP codec preference ─────────────────────────────────────────────────────────────────────

const SDP = [
  'v=0',
  'o=- 1 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  'a=rtpmap:111 opus/48000/2',
  'm=video 9 UDP/TLS/RTP/SAVPF 96 97 102 103 98 99 45 46 116',
  'a=rtpmap:96 VP8/90000',
  'a=rtpmap:97 rtx/90000',
  'a=fmtp:97 apt=96',
  'a=rtpmap:102 H264/90000',
  'a=rtpmap:103 rtx/90000',
  'a=fmtp:103 apt=102',
  'a=rtpmap:98 VP9/90000',
  'a=rtpmap:99 rtx/90000',
  'a=fmtp:99 apt=98',
  'a=rtpmap:45 AV1/90000',
  'a=rtpmap:46 rtx/90000',
  'a=fmtp:46 apt=45',
  'a=rtpmap:116 red/90000',
  '',
].join('\r\n');

test('SDP: VP9 > VP8 > AV1 first, each followed by its RTX; H.264 kept but last', () => {
  const out = preferVideoCodecs(SDP);
  const mline = out.split('\r\n').find((l) => l.startsWith('m=video'));
  assert.equal(mline, 'm=video 9 UDP/TLS/RTP/SAVPF 98 99 96 97 45 46 102 103 116');
  assert.deepEqual(videoCodecOrder(out).slice(0, 3), ['VP9', 'RTX', 'VP8']);
  // The audio section and every attribute line are untouched.
  assert.equal(out.replace(mline, ''), SDP.replace(SDP.split('\r\n')[6], ''));
});

test('SDP: no video section, or none of our codecs, is returned unchanged', () => {
  const audioOnly = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\n';
  assert.equal(preferVideoCodecs(audioOnly), audioOnly);
  const h264Only = 'm=video 9 UDP/TLS/RTP/SAVPF 102\r\na=rtpmap:102 H264/90000\r\n';
  assert.equal(preferVideoCodecs(h264Only), h264Only);
  assert.equal(preferVideoCodecs(''), '');
});

test('setCodecPreferences order: VP9, VP8, AV1, then the rest in browser order', () => {
  const caps = ['video/H264', 'video/rtx', 'video/VP8', 'video/AV1', 'video/VP9', 'video/red', 'video/VP9'].map((mimeType, i) => ({ mimeType, i }));
  const sorted = sortCodecCapabilities(caps).map((c) => `${c.mimeType}#${c.i}`);
  assert.deepEqual(sorted, ['video/VP9#4', 'video/VP9#6', 'video/VP8#2', 'video/AV1#3', 'video/H264#0', 'video/rtx#1', 'video/red#5']);
});

// ── hello and the routing table ──────────────────────────────────────────────────────────────

test('routing table (RFC §3): sbs woven / flat-left; mono lifted on a woven wall, flat otherwise', () => {
  assert.deepEqual(routeFor({ format: 'sbs', woven: true }), { route: 'woven-sbs' });
  assert.deepEqual(routeFor({ format: 'sbs', woven: false }), { route: 'flat-left' });
  assert.deepEqual(routeFor({ format: 'mono', woven: false }), { route: 'flat' });
  assert.deepEqual(routeFor({ format: 'mono', woven: true }), { route: 'flat', mono3d: 'unavailable' });
  assert.deepEqual(routeFor({ format: 'mono', woven: true, mono3D: 'off' }), { route: 'flat', mono3d: 'off' });
  // P2: lift() resolved → lifted, on a woven wall only.
  assert.deepEqual(routeFor({ format: 'mono', woven: true, lift: true }), { route: 'lifted', mono3d: 'lifted' });
  assert.deepEqual(routeFor({ format: 'mono', woven: false, lift: true }), { route: 'flat' });
  assert.deepEqual(routeFor({ format: 'mono', woven: true, lift: true, mono3D: 'off' }), { route: 'flat', mono3d: 'off' });
  assert.deepEqual(routeFor({ format: 'mono', woven: true, lift: true, overBudget: true }), { route: 'flat', mono3d: 'budget' });
  assert.deepEqual(routeFor({ format: 'mono', woven: true, lift: true, failed: true }), { route: 'flat', mono3d: 'failed' });
  // an injected lift function counts as "on"
  assert.deepEqual(routeFor({ format: 'mono', woven: true, lift: true, mono3D: () => null }), { route: 'lifted', mono3d: 'lifted' });
  // SBS never goes through lift, whatever lift says.
  assert.deepEqual(routeFor({ format: 'sbs', woven: true, lift: true }), { route: 'woven-sbs' });
  // A peer that never said hello — or said something else — is mono.
  for (const format of [null, undefined, 'tb', 'SBS', 42]) assert.equal(routeFor({ format, woven: true }).route, 'flat');
});

test('badges: 3D (woven SBS) / 2D→3D (lifted) / 2D (flat)', () => {
  assert.equal(badgeFor('woven-sbs'), '3D');
  assert.equal(badgeFor('lifted'), '2D→3D');
  for (const r of ['flat', 'flat-left', null]) assert.equal(badgeFor(r), '2D');
});

test('normalizeHello: defaults, clamps, and rectified defaults to false', () => {
  assert.equal(normalizeHello(null), null);
  assert.equal(normalizeHello({ type: 'hint' }), null);
  const h = normalizeHello({ type: 'hello', format: 'sbs', width: 1280, height: 480 });
  assert.equal(h.format, 'sbs');
  assert.equal(h.rectified, false, 'a raw stereo camera is the common case');
  assert.equal(h.baselineMm, null);
  const junk = normalizeHello({ type: 'hello', format: 'lightfield', width: -3, baselineMm: 'x', hfovDeg: 400, rectified: 'yes', sdk: 'x'.repeat(500) });
  assert.equal(junk.format, 'mono');
  assert.equal(junk.width, null);
  assert.equal(junk.baselineMm, null);
  assert.equal(junk.hfovDeg, null);
  assert.equal(junk.rectified, false);
  assert.equal(junk.sdk.length, 64);
});

test('makeHello round-trips through normalizeHello', () => {
  const sent = makeHello({ format: 'sbs', width: 1280, height: 480, baselineMm: 60, hfovDeg: 72, rectified: false });
  const got = normalizeHello(JSON.parse(JSON.stringify(sent)));
  assert.equal(got.format, 'sbs');
  assert.equal(got.width, 1280);
  assert.equal(got.baselineMm, 60);
  assert.equal(got.hfovDeg, 72);
  assert.equal(got.v, 1);
  assert.equal(makeHello({ format: 'weird' }).format, 'mono');
  assert.ok(!('baselineMm' in makeHello({ format: 'mono' })));
});

test('hint and state validation; hint rate gate is 5 Hz', () => {
  assert.deepEqual(normalizeHint({ type: 'hint', subjectZmm: 650 }), { type: 'hint', subjectZmm: 650 });
  assert.equal(normalizeHint({ type: 'hint', subjectZmm: 10 }), null);
  assert.equal(normalizeHint({ type: 'hint', subjectZmm: Infinity }), null);
  assert.deepEqual(normalizeState({ type: 'state', muted: 1, cameraOff: true }), { type: 'state', muted: false, cameraOff: true, speaking: false });
  const gate = rateGate(5);
  const passed = [0, 50, 150, 199, 200, 390, 400, 1000].filter((t) => gate(t));
  assert.deepEqual(passed, [0, 200, 400, 1000]);
});

test('capture: aspect > 2.5 is a side-by-side pair (1280x480 is, 1280x720 is not); stereo label hint', () => {
  assert.equal(looksSbs(1280, 480), true); // a raw vendor stereo camera: 640x480 per eye
  assert.equal(looksSbs(2560, 720), true);
  assert.equal(looksSbs(1280, 720), false);
  assert.equal(looksSbs(0, 0), false);
  assert.equal(stereoLabelHint('USB Stereo Camera'), true);
  assert.equal(stereoLabelHint('FaceTime HD Camera'), false);
});

// ── convergence ──────────────────────────────────────────────────────────────────────────────

test('convergence shift = f_px · baseline / (2 · subjectZ)', () => {
  const f = focalPx(1280, 70);
  assert.ok(Math.abs(f - 640 / Math.tan((35 * Math.PI) / 180)) < 1e-9);
  const s = convergenceShiftPx({ eyeWidthPx: 1280, hfovDeg: 70, baselineMm: 63, subjectZmm: 600 });
  assert.ok(Math.abs(s - (f * 63) / 1200) < 1e-9);
  assert.ok(Math.abs(s - 47.98) < 0.05, `~48 px, got ${s}`);
  // Closer subject → more shift; unknowns → 0 (show the pair as sent).
  assert.ok(convergenceShiftPx({ eyeWidthPx: 1280, hfovDeg: 70, baselineMm: 63, subjectZmm: 400 }) > s);
  assert.equal(convergenceShiftPx({ eyeWidthPx: 1280, hfovDeg: 70, subjectZmm: 600 }), 0);
  assert.equal(convergenceShiftPx({ eyeWidthPx: 1280, baselineMm: 63, subjectZmm: 600 }), 0);
  assert.equal(convergenceShiftPx({ eyeWidthPx: 1280, hfovDeg: 70, baselineMm: 63 }), 0);
});

test('low-pass α=0.2 converges monotonically and settles exactly', () => {
  let v = 0;
  const seen = [];
  for (let i = 0; i < 80; i++) seen.push((v = lowPass(v, 40)));
  assert.ok(Math.abs(seen[0] - 8) < 1e-9, 'first step is α·target');
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] >= seen[i - 1]);
  assert.equal(seen.at(-1), 40);
});

test('the shift is clamped to ±12% of the eye width', () => {
  assert.equal(clampShift(1000, 1000), 1000 * CONVERGENCE_MAX_FRACTION);
  assert.equal(clampShift(-1000, 1000), -1000 * CONVERGENCE_MAX_FRACTION);
  assert.equal(clampShift(10, 1000), 10);
  assert.equal(clampShift(NaN, 1000), 0);
});

test('createConvergence: 0 until hello+hint, then eases toward the target; depth adds to it', () => {
  const c = createConvergence();
  assert.equal(c.step(1280), 0, 'no hello, no hint: the pair as sent');
  c.hello = normalizeHello({ type: 'hello', format: 'sbs', baselineMm: 63, hfovDeg: 70 });
  assert.equal(c.step(1280), 0, 'hello without hint: still 0');
  c.subjectZmm = 600;
  const target = c.target(1280);
  const first = c.step(1280);
  assert.ok(first > 0 && first < target);
  for (let i = 0; i < 100; i++) c.step(1280);
  assert.equal(c.current, target);
  c.depth = 1;
  assert.ok(Math.abs(c.target(1280) - (target + 0.05 * 1280)) < 1e-9);
  c.depth = -1;
  c.subjectZmm = null;
  assert.equal(c.target(1280), -0.05 * 1280);
});

test('eyeCropRect: symmetric opposite offsets, tile aspect kept, never outside the eye', () => {
  const W = 1280;
  const H = 720;
  const A = 16 / 9;
  const L = eyeCropRect(W, H, A, 40, 0);
  const R = eyeCropRect(W, H, A, 40, 1);
  assert.ok(Math.abs(L.sw / L.sh - A) < 1e-9);
  assert.equal(L.sw, R.sw);
  // The left crop sits 2·shift to the right of the right crop: crossed disparity drops by 2·shift.
  assert.ok(Math.abs(L.sx - R.sx - 80) < 1e-9);
  for (const r of [L, R]) {
    assert.ok(r.sx >= 0 && r.sx + r.sw <= W + 1e-9);
    assert.ok(r.sy >= 0 && r.sy + r.sh <= H + 1e-9);
  }
  const zero = eyeCropRect(W, H, A, 0, 0);
  assert.deepEqual(zero, { sx: 0, sy: 0, sw: 1280, sh: 720 });
});

test('eyeOutputSize never upscales (a 640x480 raw stereo eye stays <= 640 wide)', () => {
  assert.deepEqual(eyeOutputSize(640, 480, 16 / 9), { w: 640, h: 360 });
  assert.deepEqual(eyeOutputSize(1280, 720, 16 / 9), { w: 1280, h: 720 });
  const tall = eyeOutputSize(640, 480, 4 / 3);
  assert.deepEqual(tall, { w: 640, h: 480 });
});

// ── self view: the mirroring trap ────────────────────────────────────────────────────────────

test('mirror-and-swap keeps crossed disparity crossed (naive per-half mirror inverts it)', () => {
  // A 16x1 SBS frame (8 px per eye). A near object is at x=5 in the left eye and x=3 in the right
  // (crossed disparity +2: left image further right).
  const W = 16;
  const H = 1;
  const px = new Uint8Array(W);
  px[5] = 255; // left eye
  px[8 + 3] = 255; // right eye
  const out = mirrorSwapPixels(px, W, H);
  const leftX = out.slice(0, 8).indexOf(255);
  const rightX = out.slice(8).indexOf(255);
  assert.equal(leftX - rightX, 2, 'disparity preserved after mirroring');
  // The naive per-half mirror: each half flipped in place.
  const naive = new Uint8Array(W);
  for (let x = 0; x < 8; x++) {
    naive[x] = px[7 - x];
    naive[8 + x] = px[8 + 7 - x];
  }
  assert.equal(naive.slice(0, 8).indexOf(255) - naive.slice(8).indexOf(255), -2, 'naive mirror inverts depth');
  // It is a real mirror: mirrorSwap of mirrorSwap is the identity.
  assert.deepEqual(mirrorSwapPixels(out, W, H), px);
});

test('mirrorSwapOps: left output half comes from the RIGHT source eye, mirrored', () => {
  const ops = mirrorSwapOps(2560, 720);
  assert.deepEqual(ops.map((o) => [o.src, o.sx, o.dx]), [['R', 1280, 0], ['L', 0, 1280]]);
  assert.ok(ops.every((o) => o.mirror));
});

// ── rooms and invite links ───────────────────────────────────────────────────────────────────

test('room ids: 128 random bits, 22 url-safe chars, from crypto.getRandomValues', () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const r = newRoomId();
    assert.match(r, /^[A-Za-z0-9_-]{22}$/);
    seen.add(r);
  }
  assert.equal(seen.size, 2000);
  // Deterministic source → deterministic encoding (known vector).
  const r = newRoomId((a) => a.fill(0xff));
  assert.equal(r, '_____________________w');
  assert.equal(base64url(new Uint8Array([0xfb, 0xff])), '-_8');
  // Every generated char carries entropy: the per-position symbol spread is wide.
  const firstChars = new Set([...seen].map((x) => x[0]));
  assert.ok(firstChars.size > 50);
});

test('room id validity: >= 16 base64url chars (96 bits)', () => {
  assert.equal(isValidRoomId('A'.repeat(16)), true);
  assert.equal(isValidRoomId('A'.repeat(15)), false);
  assert.equal(isValidRoomId('A'.repeat(65)), false);
  assert.equal(isValidRoomId('AAAAAAAAAAAAAAA/'), false);
  assert.equal(isValidRoomId(undefined), false);
});

test('invite links: room in the FRAGMENT only; query kept; old fragment dropped', () => {
  const room = 'abcDEF123_-xyzXYZ0987q';
  const link = buildInviteLink('https://x.example/call/?signal=wss%3A%2F%2Fs#old', room);
  assert.equal(link, `https://x.example/call/?signal=wss%3A%2F%2Fs#room=${room}`);
  assert.equal(parseInviteLink(link), room);
  assert.equal(parseInviteLink(`#room=${room}`), room);
  assert.equal(parseInviteLink(`room=${room}`), room);
  assert.equal(parseInviteLink(`https://x/#a=1&room=${room}&b=2`), room);
  assert.equal(parseInviteLink({ hash: `#room=${room}` }), room);
  // Never read from the query string: that would put the room in server logs.
  assert.equal(parseInviteLink(`https://x/?room=${room}`), null);
  assert.equal(parseInviteLink('https://x/#room=short'), null);
  assert.equal(parseInviteLink(''), null);
  assert.throws(() => buildInviteLink('https://x/', 'bad'));
});

// ── options + the maxPeers cap ───────────────────────────────────────────────────────────────

test('normalizeCallOptions: defaults, a link as room, clamped maxPeers', () => {
  const o = normalizeCallOptions({});
  assert.equal(o.room, 'auto');
  assert.equal(o.maxPeers, 4);
  assert.equal(o.layout, 'grid');
  assert.equal(o.ui, true);
  assert.equal(o.autoJoin, false);
  assert.equal(o.mono3D, 'auto');
  assert.equal(o.maxLifted, 4);
  assert.equal(normalizeCallOptions({ mono3D: 'off' }).mono3D, 'off');
  assert.equal(normalizeCallOptions({ mono3D: false }).mono3D, 'off');
  const fn = async () => ({});
  assert.equal(normalizeCallOptions({ mono3D: fn }).mono3D, fn);
  assert.equal(normalizeCallOptions({ mono3D: 'yes' }).mono3D, 'auto');
  assert.equal(normalizeCallOptions({ maxLifted: 2 }).maxLifted, 2);
  assert.equal(normalizeCallOptions({ maxLifted: 9 }).maxLifted, 4);
  assert.equal(normalizeCallOptions({ maxLifted: -1 }).maxLifted, 0);
  assert.equal(o.camera, 'auto');
  assert.equal(o.tileAspect, 16 / 9);
  assert.equal(normalizeCallOptions({ ui: false }).autoJoin, true);
  assert.equal(normalizeCallOptions({ maxPeers: 12 }).maxPeers, 4);
  assert.equal(normalizeCallOptions({ maxPeers: 1 }).maxPeers, 2);
  const room = 'Q'.repeat(22);
  assert.equal(normalizeCallOptions({ room: `https://x/#room=${room}` }).room, room);
  assert.throws(() => normalizeCallOptions({ room: 'nope' }), /not a valid room id/);
  assert.equal(normalizeCallOptions({ accent: 'violet' }).accent, '#9b7bff');
});

test('clampMaxPeers: full mesh is 2..4', () => {
  assert.equal(clampMaxPeers(undefined), 4);
  assert.equal(clampMaxPeers(3), 3);
  assert.equal(clampMaxPeers(8), 4);
  assert.equal(clampMaxPeers(0), 2);
  assert.equal(clampMaxPeers(2.5), 4);
});

test('bitrate per peer falls as the mesh grows; SBS gets more than mono', () => {
  assert.deepEqual([1, 2, 3].map((n) => maxBitrateKbps('sbs', n)), [6000, 4000, 3000]);
  assert.deepEqual([1, 2, 3].map((n) => maxBitrateKbps('mono', n)), [2500, 1800, 1400]);
  assert.equal(maxBitrateKbps('sbs', 0), 6000);
});

test('backoff: exponential, capped, jittered ±20%', () => {
  assert.equal(backoffMs(0, { rand: () => 0.5 }), 1000);
  assert.equal(backoffMs(3, { rand: () => 0.5 }), 8000);
  assert.equal(backoffMs(20, { rand: () => 0.5 }), 30000);
  assert.equal(backoffMs(0, { rand: () => 0 }), 800);
  assert.equal(backoffMs(0, { rand: () => 1 }), 1200);
});

// ── the mesh transport against a mocked WebRTC ───────────────────────────────────────────────

class FakePC {
  static all = [];
  constructor(cfg) {
    this.cfg = cfg;
    this.connectionState = 'new';
    this.signalingState = 'stable';
    this.transceivers = [];
    this.remoteDescription = null;
    this.localDescription = null;
    FakePC.all.push(this);
  }
  createDataChannel() {
    return { readyState: 'connecting', close() {}, send() {} };
  }
  addTransceiver(trackOrKind) {
    const kind = typeof trackOrKind === 'string' ? trackOrKind : trackOrKind.kind;
    const t = { receiver: { track: { kind } }, sender: { track: null, replaceTrack: async () => {} }, direction: 'sendrecv', setCodecPreferences() {} };
    this.transceivers.push(t);
    return t;
  }
  getTransceivers() {
    return this.transceivers;
  }
  getSenders() {
    return [];
  }
  async createOffer() {
    return { type: 'offer', sdp: SDP };
  }
  async createAnswer() {
    return { type: 'answer', sdp: SDP };
  }
  async setLocalDescription(d) {
    this.localDescription = d;
    this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable';
  }
  async setRemoteDescription(d) {
    this.remoteDescription = d;
    this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable';
  }
  async addIceCandidate() {}
  close() {
    this.connectionState = 'closed';
  }
}

function fakeSignaling({ existing = [] } = {}) {
  const s = {
    sent: [],
    hooks: null,
    left: false,
    async join(room, hooks) {
      s.hooks = hooks;
      return { id: hooks.id, peers: existing, send: (to, data) => s.sent.push({ to, data }), leave: () => (s.left = true) };
    },
  };
  return s;
}

test('transport: roles are deterministic — the lexically smaller id offers', () => {
  assert.equal(isOfferer('aaa', 'bbb'), true);
  assert.equal(isOfferer('bbb', 'aaa'), false);
});

test('transport: joining a room that already holds maxPeers is refused (room-full)', async () => {
  // 4 already in a 4-person room: a 5th is refused. (3 + this peer = 4 would be allowed.)
  const sig = fakeSignaling({ existing: ['p1', 'p2', 'p3', 'p4'] });
  const t = new MeshTransport({ signaling: sig, id: 'me000000', maxPeers: 4, RTCPeerConnection: FakePC });
  await assert.rejects(t.start({ room: 'r'.repeat(22), localStream: null }), (e) => e.code === 'room-full');
  assert.equal(sig.left, true, 'it leaves the signalling room');
  assert.equal(t.size, 0, 'and builds no connections');
  // One below the cap is fine.
  const ok = new MeshTransport({ signaling: fakeSignaling({ existing: ['p1', 'p2', 'p3'] }), id: 'me000000', maxPeers: 4, RTCPeerConnection: FakePC });
  await ok.start({ room: 'r'.repeat(22), localStream: null });
  assert.equal(ok.size, 3);
  ok.stop();
});

test('transport: a peer beyond maxPeers is refused; the others get connections', async () => {
  FakePC.all = [];
  const sig = fakeSignaling({ existing: ['zz1', 'zz2'] });
  const refused = [];
  const joined = [];
  const t = new MeshTransport({ signaling: sig, id: 'aa000000', maxPeers: 3, RTCPeerConnection: FakePC });
  await t.start({ room: 'r'.repeat(22), localStream: null, onPeer: (id) => joined.push(id), onRefused: (id) => refused.push(id) });
  assert.deepEqual(joined, ['zz1', 'zz2']);
  sig.hooks.onPeerJoined('zz3');
  assert.deepEqual(refused, ['zz3']);
  assert.equal(t.size, 2);
  // We are the smaller id, so we offered to both, with generation 1.
  await new Promise((r) => setTimeout(r, 10));
  const offers = sig.sent.filter((m) => m.data.kind === 'offer');
  assert.deepEqual(offers.map((m) => [m.to, m.data.gen]).sort(), [['zz1', 1], ['zz2', 1]]);
  assert.equal(FakePC.all.length, 2);
  t.stop();
  assert.ok(sig.sent.some((m) => m.data.kind === 'bye'));
});

test('transport: stale-generation candidates and answers are dropped; an answerer builds on offer', async () => {
  FakePC.all = [];
  const sig = fakeSignaling();
  const t = new MeshTransport({ signaling: sig, id: 'zz000000', maxPeers: 4, RTCPeerConnection: FakePC });
  await t.start({ room: 'r'.repeat(22), localStream: null });
  // 'aa…' < 'zz…': they offer, we answer.
  await sig.hooks.onSignal('aa111111', { kind: 'offer', gen: 2, sdp: SDP });
  assert.equal(FakePC.all.length, 1);
  const answer = sig.sent.find((m) => m.data.kind === 'answer');
  assert.equal(answer.data.gen, 2);
  const pc = FakePC.all[0];
  let added = 0;
  pc.addIceCandidate = async () => added++;
  await sig.hooks.onSignal('aa111111', { kind: 'candidate', gen: 1, candidate: {} });
  await sig.hooks.onSignal('aa111111', { kind: 'candidate', gen: 2, candidate: {} });
  assert.equal(added, 1, 'the gen-1 candidate belonged to a dead connection');
  // A newer generation replaces the connection.
  await sig.hooks.onSignal('aa111111', { kind: 'offer', gen: 3, sdp: SDP });
  assert.equal(FakePC.all.length, 2);
  assert.equal(pc.connectionState, 'closed');
  t.stop();
});

// ── dxr-signal/1 against the real dev server ─────────────────────────────────────────────────

async function withServer(opts, fn) {
  const srv = await startDevServer({ port: 0, ...opts });
  try {
    await fn(srv);
  } finally {
    await srv.close();
  }
}

function hooksRecorder(id) {
  const ev = [];
  let wake = null;
  const push = (e) => {
    ev.push(e);
    if (wake) wake();
  };
  return {
    ev,
    hooks: {
      id,
      maxPeers: 4,
      onPeerJoined: (p) => push(['joined', p]),
      onPeerLeft: (p) => push(['left', p]),
      onSignal: (from, data) => push(['signal', from, data]),
    },
    async until(pred, ms = 3000) {
      const t0 = Date.now();
      while (!ev.some(pred)) {
        if (Date.now() - t0 > ms) throw new Error('timeout waiting; got ' + JSON.stringify(ev));
        await new Promise((r) => {
          wake = r;
          setTimeout(r, 50);
        });
      }
      return ev.find(pred);
    },
  };
}

test('dxr-signal/1: join, presence, relay, leave — round trip against the dev server', async () => {
  await withServer({}, async (srv) => {
    const room = newRoomId();
    const a = hooksRecorder('peerAAAA1');
    const b = hooksRecorder('peerBBBB2');
    const sa = await dxrSignaling(srv.url).join(room, a.hooks);
    assert.equal(sa.id, 'peerAAAA1');
    assert.deepEqual(sa.peers, []);
    const sb = await dxrSignaling(srv.url).join(room, b.hooks);
    assert.deepEqual(sb.peers, ['peerAAAA1']);
    await a.until((e) => e[0] === 'joined' && e[1] === 'peerBBBB2');
    sb.send('peerAAAA1', { kind: 'offer', gen: 1, sdp: 'x' });
    const got = await a.until((e) => e[0] === 'signal');
    assert.deepEqual(got, ['signal', 'peerBBBB2', { kind: 'offer', gen: 1, sdp: 'x' }]);
    // The server keyed the room by its hash — the room itself was never in a URL.
    assert.equal(srv.rooms.size, 1);
    assert.equal([...srv.rooms.keys()][0], await roomKey(room));
    sb.leave();
    await a.until((e) => e[0] === 'left' && e[1] === 'peerBBBB2');
    sa.leave();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(srv.rooms.size, 0, 'an empty room is forgotten');
  });
});

test('dxr-signal/1: a full room refuses the next join with room-full', async () => {
  await withServer({ cap: 2 }, async (srv) => {
    const room = newRoomId();
    const s1 = await dxrSignaling(srv.url).join(room, hooksRecorder('peer11111').hooks);
    const s2 = await dxrSignaling(srv.url).join(room, hooksRecorder('peer22222').hooks);
    await assert.rejects(dxrSignaling(srv.url).join(room, hooksRecorder('peer33333').hooks), (e) => e.code === 'room-full');
    s1.leave();
    s2.leave();
  });
});

test('dxr-signal/1: bad room ids and duplicate peer ids are rejected', async () => {
  await withServer({}, async (srv) => {
    await assert.rejects(dxrSignaling(srv.url).join('short', hooksRecorder('peer11111').hooks), (e) => e.code === 'bad-room');
    const room = newRoomId();
    const s1 = await dxrSignaling(srv.url).join(room, hooksRecorder('peer11111').hooks);
    await assert.rejects(dxrSignaling(srv.url).join(room, hooksRecorder('peer11111').hooks), (e) => e.code === 'id-taken');
    s1.leave();
  });
});

test('dxrSignaling() without a URL explains itself', () => {
  assert.equal(typeof dxrSignaling().join, 'function', 'no URL → the hosted default');
  assert.throws(() => dxrSignaling(''), (e) => e.code === 'no-signaling-url');
});

test('Room: a join whose room does not match the connection key is refused', async () => {
  const room = newRoomId();
  const r = new Room({ key: await roomKey(newRoomId()) });
  const out = [];
  const conn = { send: (m) => out.push(m), close: () => out.push('closed') };
  await r.onMessage(conn, JSON.stringify({ t: 'join', v: 1, room, id: 'peer11111' }));
  assert.equal(out[0].code, 'bad-room');
  assert.equal(out[1], 'closed');
  assert.equal(r.size, 0);
});

test('Room: TURN credentials are minted per join and only when configured', async () => {
  assert.equal(await mintTurnCredentials({}), null);
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, json: async () => ({ iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }, { urls: ['turn:turn.cloudflare.com:3478'], username: 'u', credential: 'c' }] }) };
  };
  const ice = await mintTurnCredentials({ TURN_KEY_ID: 'kid', TURN_KEY_API_TOKEN: 'tok', TURN_TTL: '600' }, fakeFetch);
  assert.equal(ice.length, 2);
  assert.match(calls[0].url, /\/v1\/turn\/keys\/kid\/credentials\/generate-ice-servers$/);
  assert.equal(JSON.parse(calls[0].init.body).ttl, 600);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok');
  // Older API shape: a single object.
  const one = await mintTurnCredentials({ TURN_KEY_ID: 'k', TURN_KEY_API_TOKEN: 't' }, async () => ({ ok: true, json: async () => ({ iceServers: { urls: 'turn:x', username: 'u', credential: 'c' } }) }));
  assert.equal(one.length, 1);
  // Handed to the joiner in `welcome`.
  const r = new Room({ iceServers: async () => ice });
  const out = [];
  await r.onMessage({ send: (m) => out.push(m), close() {} }, JSON.stringify({ t: 'join', room: newRoomId(), id: 'peer11111' }));
  assert.equal(out[0].t, 'welcome');
  assert.deepEqual(out[0].iceServers, ice);
});

// ── QR ───────────────────────────────────────────────────────────────────────────────────────

const qrHash = (q) => createHash('sha256').update(q.modules.map((r) => r.map((v) => (v ? 1 : 0)).join('')).join('\n')).digest('hex').slice(0, 16);

test('QR: golden matrices (verified against an independent decoder when written)', () => {
  const link = qrEncode('https://displayxr.github.io/displayxr-web/samples/call/#room=AAAAAAAAAAAAAAAAAAAAAA');
  assert.equal(link.version, 5);
  assert.equal(link.size, 37);
  assert.equal(qrHash(link), '6669f7954f805863');
  const hello = qrEncode('HELLO');
  assert.equal(hello.version, 1);
  assert.equal(qrHash(hello), 'c346c75add569873');
});

test('QR: finder patterns in three corners; version grows with length; too long throws', () => {
  const q = qrEncode('x'.repeat(100));
  const finder = (x0, y0) => {
    for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
      const d = Math.max(Math.abs(x - 3), Math.abs(y - 3));
      if (q.modules[y0 + y][x0 + x] !== (d !== 2)) return false;
    }
    return true;
  };
  assert.ok(finder(0, 0) && finder(q.size - 7, 0) && finder(0, q.size - 7));
  assert.ok(qrEncode('x'.repeat(200)).version > q.version);
  assert.throws(() => qrEncode('x'.repeat(400)), /too long/);
});

// ── panel-round fixes: liveness gate (#172), unreachable, camera-busy, PeerJS zombie slots ──────


test('live gate: live after 10 CONSECUTIVE frames with a located pose (#172)', () => {
  // The browser's inline session reports ONE view on the viewer pose (per-eye views are per
  // layer) — a >=2 requirement never went live on a real panel.
  const g = createLiveGate();
  for (let i = 0; i < 9; i++) assert.equal(g.feed(1), false);
  assert.equal(g.feed(0), false, 'a frame with no located view resets the run');
  for (let i = 0; i < 9; i++) assert.equal(g.feed(1), false);
  assert.equal(g.feed(1), true);
  assert.equal(g.live, true);
  assert.equal(g.feed(0), true, 'once live, stays live');
  const stereo = createLiveGate();
  for (let i = 0; i < 9; i++) assert.equal(stereo.feed(2), false);
  assert.equal(stereo.feed(2), true, 'two views count too');
  const noPose = createLiveGate();
  for (let i = 0; i < 29; i++) assert.equal(noPose.feed(null), false);
  assert.equal(noPose.feed(null), true, 'no reference space: live after 30 frames');
});

test('transport: a peer with no connection for unreachableMs becomes UNREACHABLE (sticky), then recovers', async () => {
  FakePC.all = [];
  const sig = fakeSignaling({ existing: ['zz1'] });
  const states = [];
  const t = new MeshTransport({ signaling: sig, id: 'aa000000', maxPeers: 4, RTCPeerConnection: FakePC, unreachableMs: 40 });
  await t.start({ room: 'r'.repeat(22), localStream: null, onPeerState: (id, s) => states.push(s) });
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(states, ['connecting', 'unreachable']);
  // Retries keep running underneath; a rebuild does not flip the state back to "connecting".
  const rec = t.peers.get('zz1');
  t._setState(rec, 'reconnecting');
  assert.equal(rec.state, 'unreachable');
  // A connection comes up → connected, flag cleared.
  const pc = FakePC.all.at(-1);
  pc.connectionState = 'connected';
  pc.onconnectionstatechange();
  assert.equal(states.at(-1), 'connected');
  assert.equal(rec.unreachable, false);
  t.stop();
});

function fakeMedia(behaviour) {
  // behaviour(deviceId|undefined) -> {w,h} | Error
  return {
    async getUserMedia({ video }) {
      const id = video && video.deviceId ? video.deviceId.exact : undefined;
      const r = behaviour(id);
      if (r instanceof Error) throw r;
      const track = { kind: 'video', label: id || 'default', readyState: 'live', getSettings: () => ({ width: r.w, height: r.h, deviceId: id || 'cam0' }), stop() {} };
      return { getVideoTracks: () => [track], getTracks: () => [track] };
    },
    async enumerateDevices() {
      return [{ kind: 'videoinput', deviceId: 'cam0', label: 'Built-in' }, { kind: 'videoinput', deviceId: 'cam1', label: 'Tracker stereo' }];
    },
  };
}
const busyErr = () => Object.assign(new Error('Device in use'), { name: 'NotReadableError' });

test('capture: every camera held by another app → camera-busy (never a 0x0 track)', async () => {
  await assert.rejects(openCamera('auto', { mediaDevices: fakeMedia(() => busyErr()) }), (e) => e.code === 'camera-busy' && e.skipped.length > 0 && e.skipped.every((x) => x.busy));
  // A device that opens but delivers 0x0 is not a camera.
  await assert.rejects(openCamera('auto', { mediaDevices: fakeMedia(() => ({ w: 0, h: 0 })) }), (e) => e.code === 'camera-busy' || e.code === 'no-camera');
  // Some other failure is not "busy".
  const denied = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
  await assert.rejects(openCamera('auto', { mediaDevices: fakeMedia(() => denied) }), (e) => e.code === 'no-camera');
  assert.equal(isBusyError(busyErr()), true);
  assert.equal(noCameraCode([{ busy: true }, { busy: true }]), 'camera-busy');
  assert.equal(noCameraCode([{ busy: true }, { busy: false }]), 'no-camera');
  assert.equal(noCameraCode([]), 'no-camera');
});

test('capture: the default camera busy but another is a stereo pair → that pair, as sbs', async () => {
  const md = fakeMedia((id) => (id === 'cam1' ? { w: 1280, h: 480 } : busyErr()));
  const cam = await openCamera('auto', { mediaDevices: md });
  assert.equal(cam.format, 'sbs');
  assert.equal(cam.width, 1280);
  assert.equal(cam.calibration.rectified, false);
  assert.ok(cam.skipped.some((s) => s.busy));
});

/** An in-memory PeerJS broker: ids, data connections, zombie ids that never answer. */
function fakeBroker() {
  const peers = new Map(); // id -> FakePeer | 'zombie'
  class Emitter {
    constructor() {
      this.h = {};
    }
    on(t, f) {
      (this.h[t] ||= []).push(f);
    }
    off(t, f) {
      this.h[t] = (this.h[t] || []).filter((x) => x !== f);
    }
    emit(t, ...a) {
      for (const f of [...(this.h[t] || [])]) f(...a);
    }
  }
  class Conn extends Emitter {
    constructor(owner, peer) {
      super();
      this.owner = owner;
      this.peer = peer;
      this.open = false;
      this.other = null;
    }
    send(m) {
      if (this.open && this.other) setTimeout(() => this.other.emit('data', JSON.parse(JSON.stringify(m))), 1);
    }
    close() {
      if (!this.open) return;
      this.open = false;
      this.emit('close');
      if (this.other && this.other.open) this.other.close();
    }
  }
  class FakePeer extends Emitter {
    constructor(id, options = {}) {
      super();
      this.id = id;
      this.options = options;
      this.destroyed = false;
      setTimeout(() => {
        if (peers.has(id)) return this.emit('error', { type: 'unavailable-id' });
        peers.set(id, this);
        this.emit('open', id);
      }, 1);
    }
    connect(id) {
      const c = new Conn(this, id);
      setTimeout(() => {
        const target = peers.get(id);
        if (!target) return this.emit('error', { type: 'peer-unavailable', message: `Could not connect to peer ${id}` });
        if (target === 'zombie') return; // ICE never completes / holder gone: silence
        const back = new Conn(target, this.id);
        c.other = back;
        back.other = c;
        c.open = back.open = true;
        target.emit('connection', back);
        back.emit('open');
        c.emit('open');
      }, 1);
      return c;
    }
    destroy() {
      this.destroyed = true;
      if (peers.get(this.id) === this) peers.delete(this.id);
    }
  }
  return { Peer: FakePeer, peers };
}

test('peerjsCloud: a zombie slot does not count, is reported unreachable, and pagehide frees our slot', async () => {
  const room = newRoomId();
  const tag = (await roomKey(room)).slice(0, 24);
  const broker = fakeBroker();
  broker.peers.set(`dxrcall-${tag}-0`, 'zombie'); // a reloaded page's leftover
  const listeners = {};
  const prevAdd = globalThis.addEventListener;
  const prevRemove = globalThis.removeEventListener;
  globalThis.addEventListener = (t, f) => ((listeners[t] ||= []).push(f));
  globalThis.removeEventListener = () => {};
  try {
    const fast = { Peer: broker.Peer, settleMs: 60, helloMs: 60, unreachableMs: 120, retryMs: 1000, heartbeatMs: 1000 };
    const live = hooksRecorder('peerLIVE01');
    const s1 = await peerjsCloud(fast).join(room, { ...live.hooks, maxPeers: 2 });
    assert.equal(s1.slot, 1, 'slot 0 is taken by the zombie');
    const me = hooksRecorder('peerME0002');
    const ghosts = [];
    const s2 = await peerjsCloud(fast).join(room, { ...me.hooks, maxPeers: 2, onPeerUnreachable: (g) => ghosts.push(g) });
    // Room size 2 with a zombie + one live peer: still joinable (twice as many slots as people),
    // and only the peer that said hi is counted.
    assert.equal(s2.slot, 2);
    assert.deepEqual(s2.peers, ['peerLIVE01']);
    await new Promise((r) => setTimeout(r, 1300));
    assert.deepEqual(ghosts, ['slot-0'], 'the silent slot is reported unreachable');
    // pagehide destroys our Peer → the broker frees the slot immediately.
    assert.ok(broker.peers.has(`dxrcall-${tag}-2`));
    for (const f of listeners.pagehide || []) f();
    assert.equal(broker.peers.has(`dxrcall-${tag}-2`), false);
    s1.leave();
    s2.leave();
    await new Promise((r) => setTimeout(r, 250));
  } finally {
    globalThis.addEventListener = prevAdd;
    globalThis.removeEventListener = prevRemove;
  }
});

test('peerjsCloud: hands the media transport the same TURN relays PeerJS uses (STUN filtered out)', async () => {
  const room = newRoomId();
  const broker = fakeBroker();
  const config = { iceServers: [
    { urls: 'stun:stun.example.org:19302' },
    { urls: ['turn:eu-0.relay.example:3478', 'turn:us-0.relay.example:3478'], username: 'u', credential: 'c' },
  ] };
  const fast = { Peer: broker.Peer, peerOptions: { config }, settleMs: 20, helloMs: 20, unreachableMs: 1000, retryMs: 1000, heartbeatMs: 1000 };
  const s = await peerjsCloud(fast).join(room, { ...hooksRecorder('peerTURN01').hooks, maxPeers: 2 });
  assert.deepEqual(s.iceServers, [config.iceServers[1]]);
  s.leave();
  // No relay configured → no iceServers (the transport keeps its STUN default).
  const s2 = await peerjsCloud({ ...fast, peerOptions: { config: { iceServers: [config.iceServers[0]] } } })
    .join(newRoomId(), { ...hooksRecorder('peerTURN02').hooks, maxPeers: 2 });
  assert.equal(s2.iceServers, undefined);
  s2.leave();
  await new Promise((r) => setTimeout(r, 250));
});

// ── mono→3D through lift() (P2a, call/lift.js) ───────────────────────────────────────────────

/** A fake lift(): records every call and hands back a handle recording what it was told. */
function fakeLift({ native = false, reject = false, state = 'live', delayMs = 0 } = {}) {
  const calls = [];
  const fn = async (element, opts) => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (reject) throw new Error('lift boom');
    const h = {
      element,
      opts,
      native,
      state,
      removed: false,
      priorities: [],
      convergences: [],
      setPriority(p) {
        this.priorities.push(p);
        return true;
      },
      setConvergence(c) {
        this.convergences.push(c);
      },
      remove() {
        this.removed = true;
      },
    };
    calls.push(h);
    return h;
  };
  fn.calls = calls;
  return fn;
}
const flush = () => new Promise((r) => setTimeout(r, 0));

test('resolveLift: off / injected / module / every failure resolves flat, never throws', async () => {
  const logs = [];
  const log = (t, o) => logs.push([t, o]);
  assert.equal((await resolveLift('off', { log })).lift, null);
  assert.equal((await resolveLift(false)).reason, 'off');
  const inj = fakeLift();
  const r1 = await resolveLift(inj);
  assert.equal(r1.lift, inj);
  assert.equal(r1.source, 'injected');
  // 'auto': the import fails (lift not installed / not in this build) → flat, one log line.
  const r2 = await resolveLift('auto', { importer: () => Promise.reject(new Error('Cannot find module')), log });
  assert.equal(r2.lift, null);
  assert.equal(r2.reason, 'import-failed');
  assert.deepEqual(logs.at(-1)[0], 'lift-unavailable');
  // a module without lift()
  assert.equal((await resolveLift('auto', { importer: async () => ({}) })).reason, 'no-lift-export');
  // module present, capabilities: no native, no WebGPU → flat
  const noGpu = { lift: inj, liftCapabilities: async () => ({ native: false, webFallback: { webgpu: false, video: false, still: false } }) };
  assert.equal((await resolveLift('auto', { importer: async () => noGpu })).reason, 'no-provider');
  // native provider → ready, caps kept for the lobby
  const nat = { lift: inj, liftCapabilities: async () => ({ native: true, provider: 'vendor-x', maxStreams: 4, webFallback: { webgpu: false } }) };
  const r3 = await resolveLift('auto', { importer: async () => nat });
  assert.equal(r3.lift, inj);
  assert.equal(r3.caps.provider, 'vendor-x');
  // WebGPU web fallback only → ready
  const web = { lift: inj, liftCapabilities: async () => ({ native: false, webFallback: { webgpu: true } }) };
  assert.equal((await resolveLift('auto', { importer: async () => web })).lift, inj);
  // capabilities throw → treated as unknown, not fatal
  const caps404 = { lift: inj, liftCapabilities: async () => { throw new Error('x'); } };
  assert.equal((await resolveLift('auto', { importer: async () => caps404 })).lift, inj);
  // no liftCapabilities: navigator.gpu decides
  assert.equal((await resolveLift('auto', { importer: async () => ({ lift: inj }), nav: {} })).reason, 'no-webgpu');
  assert.equal((await resolveLift('auto', { importer: async () => ({ lift: inj }), nav: { gpu: {} } })).lift, inj);
});

test('defaultLiftSpecifier resolves the ./lift subpath next to js/call/', () => {
  assert.equal(defaultLiftSpecifier('https://cdn.example/pkg/js/call/lift.js'), 'https://cdn.example/pkg/js/lift/index.js');
});

test('depth → convergence: 0 is auto, ±1 spans lift convergence 0..1, same direction as SBS (+ = back)', () => {
  assert.equal(liftConvergenceFor(0), 'auto');
  assert.equal(liftConvergenceFor(0.01), 'auto');
  assert.equal(liftConvergenceFor(null), 'auto');
  assert.equal(liftConvergenceFor(NaN), 'auto');
  assert.equal(liftConvergenceFor(1), 1);
  assert.equal(liftConvergenceFor(-1), 0);
  assert.equal(liftConvergenceFor(0.5), 0.75);
  assert.equal(liftConvergenceFor(-0.5), 0.25);
  assert.equal(liftConvergenceFor(7), 1);
  // monotonic: a larger depth never brings the picture forward
  let prev = -Infinity;
  for (let d = 0.05; d <= 1; d += 0.05) {
    const c = liftConvergenceFor(d);
    assert.ok(c >= prev);
    prev = c;
  }
});

test('liftPriorityFor + setLiftPriority (the native-provider hook): forwards, or no-ops safely', () => {
  assert.equal(liftPriorityFor({ id: 'a', speakerId: 'a' }), 'high');
  assert.equal(liftPriorityFor({ id: 'a', speakerId: 'b' }), 'normal');
  assert.equal(liftPriorityFor({ id: 'a', speakerId: null }), 'normal');
  assert.equal(liftPriorityFor({ id: 'a', speakerId: 'a', visible: false }), 'paused');
  assert.deepEqual(LIFT_PRIORITY, { speaker: 'high', other: 'normal', hidden: 'paused' });
  const seen = [];
  assert.equal(setLiftPriority({ setPriority: (p) => (seen.push(p), true) }, 'high'), true);
  assert.deepEqual(seen, ['high']);
  assert.equal(setLiftPriority({}, 'high'), false); // no setPriority (older lift / injected): no-op
  assert.equal(setLiftPriority(null, 'high'), false);
  assert.equal(setLiftPriority({ setPriority: () => { throw new Error('x'); } }, 'low'), false);
  assert.equal(setLiftPriority({ setPriority: () => true }, 'urgent'), false);
});

test('lift pool: lift(video, {mode:"live", wall, ...}) once per peer; slots capped; release removes', async () => {
  const lift = fakeLift();
  const pool = createLiftPool({ lift, max: 2 });
  const wall = { supported: true };
  const v1 = { tag: 'v1' };
  const [h1, again] = await Promise.all([pool.acquire('p1', v1, { wall }), pool.acquire('p1', v1, { wall })]);
  assert.equal(lift.calls.length, 1, 'one lift per peer');
  assert.equal(h1, again);
  assert.equal(h1.element, v1);
  assert.equal(h1.opts.mode, 'live');
  assert.equal(h1.opts.wall, wall);
  assert.equal(h1.opts.ui, 'none');
  assert.equal(h1.opts.convergence, 'auto');
  assert.equal(h1.opts.priority, 'normal');
  await pool.acquire('p2', {}, { wall });
  assert.equal(pool.size, 2);
  assert.equal(pool.canAcquire('p3'), false);
  assert.equal(pool.canAcquire('p1'), true);
  assert.equal(await pool.acquire('p3', {}, { wall }), null, 'over budget → no lift');
  assert.equal(lift.calls.length, 2);
  pool.release('p1');
  assert.equal(h1.removed, true);
  assert.equal(pool.canAcquire('p3'), true);
  pool.releaseAll();
  assert.equal(pool.size, 0);
});

test('lift pool: page liftOptions pass through, but the call owns mode/wall/ui/convergence/priority', async () => {
  const lift = fakeLift();
  const wall = { supported: true };
  const pool = createLiftPool({ lift, options: { models: 'https://cdn.example/m', quality: 'low', mode: 'explore', wall: 'nope', ui: 'builtin', priority: 'low' } });
  const h = await pool.acquire('p', {}, { wall });
  assert.equal(h.opts.models, 'https://cdn.example/m');
  assert.equal(h.opts.quality, 'low');
  assert.equal(h.opts.mode, 'live');
  assert.equal(h.opts.wall, wall);
  assert.equal(h.opts.ui, 'none');
  assert.equal(h.opts.priority, 'normal');
  assert.equal((await createLiftPool({ lift }).acquire('q', {}, {})).opts.quality, 'auto');
});

test('lift pool: a release while lift() is pending removes the late handle; a rejection frees the slot', async () => {
  const slow = fakeLift({ delayMs: 20 });
  const pool = createLiftPool({ lift: slow, max: 4 });
  const p = pool.acquire('p1', {}, {});
  pool.release('p1');
  assert.equal(await p, null);
  assert.equal(slow.calls[0].removed, true);
  assert.equal(pool.size, 0);
  const bad = fakeLift({ reject: true });
  const pool2 = createLiftPool({ lift: bad, max: 1 });
  let err = null;
  assert.equal(await pool2.acquire('p1', {}, { onError: (e) => (err = e) }), null);
  assert.match(String(err), /lift boom/);
  assert.equal(pool2.size, 0);
  assert.equal(pool2.canAcquire('p2'), true);
});

test('lift pool: priority follows the active speaker; hidden tiles pause; transitions only on change', async () => {
  const lift = fakeLift();
  const pool = createLiftPool({ lift, max: 4 });
  const a = await pool.acquire('a', {}, {});
  const b = await pool.acquire('b', {}, {});
  const c = await pool.acquire('c', {}, { visible: false });
  assert.equal(c.opts.priority, 'paused', 'an offscreen tile starts paused');
  const last = (h) => h.priorities.at(-1);
  pool.setSpeaker('a');
  assert.equal(last(a), 'high');
  assert.equal(last(b), 'normal');
  assert.equal(pool.priority('a'), 'high');
  pool.setSpeaker('b');
  assert.equal(last(a), 'normal');
  assert.equal(last(b), 'high');
  const nA = a.priorities.length;
  pool.setSpeaker('b'); // no change → no call
  assert.equal(a.priorities.length, nA);
  pool.setVisible('b', false);
  assert.equal(last(b), 'paused', 'the speaker scrolled off → paused');
  pool.setVisible('b', true);
  assert.equal(last(b), 'high');
  pool.setVisible('c', true);
  assert.equal(last(c), 'normal');
  pool.setSpeaker(null);
  assert.equal(last(b), 'normal');
  // a lift landing AFTER the speaker changed gets the current priority
  const slow = fakeLift({ delayMs: 10 });
  const pool2 = createLiftPool({ lift: slow, max: 4 });
  const pend = pool2.acquire('x', {}, {});
  pool2.setSpeaker('x');
  const hx = await pend;
  assert.equal(hx.opts.priority, 'normal');
  assert.equal(last(hx), 'high');
});

test('lift pool: the call depth control drives every lifted convergence', async () => {
  const lift = fakeLift();
  const pool = createLiftPool({ lift, max: 4 });
  pool.setDepth(0.5);
  const a = await pool.acquire('a', {}, {});
  assert.equal(a.opts.convergence, 0.75, 'a new lift starts at the current depth');
  const b = await pool.acquire('b', {}, {});
  assert.equal(pool.setDepth(-1), 0);
  assert.equal(a.convergences.at(-1), 0);
  assert.equal(b.convergences.at(-1), 0);
  pool.setDepth(0);
  assert.equal(a.convergences.at(-1), 'auto');
  assert.equal(pool.anyWeb, true);
  const nat = createLiftPool({ lift: fakeLift({ native: true }) });
  await nat.acquire('n', {}, {});
  assert.equal(nat.anyWeb, false, 'the native provider runs off the page frame budget');
});

test('frame watch: warns once after 3 s under ~20 fps, recovers above ~28 fps, ignores tab switches', () => {
  const w = createFrameWatch();
  let ev = null;
  for (let i = 0; i < 300 && !ev; i++) ev = w.feed(16.7);
  assert.equal(ev, null);
  const events = [];
  for (let i = 0; i < 100; i++) {
    const e = w.feed(80);
    if (e) events.push(e);
  }
  assert.deepEqual(events, ['degraded'], 'once, not per frame');
  assert.equal(w.degraded, true);
  assert.equal(w.feed(5000), null, 'a 5 s gap is a tab switch, not a frame');
  const back = [];
  for (let i = 0; i < 200; i++) {
    const e = w.feed(16.7);
    if (e) back.push(e);
  }
  assert.deepEqual(back, ['recovered']);
  // a short hitch (< 3 s) is not a degradation
  const w2 = createFrameWatch();
  for (let i = 0; i < 60; i++) w2.feed(16.7);
  const hitch = [];
  for (let i = 0; i < 20; i++) {
    const e = w2.feed(100);
    if (e) hitch.push(e);
  }
  assert.deepEqual(hitch, []);
});

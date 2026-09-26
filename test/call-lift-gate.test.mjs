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

// ── a tiny recording DOM ─────────────────────────────────────────────────────────────────────
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.style = { setProperty() {} };
    this.dataset = {};
    this.attrs = {};
    this.listeners = {};
    this.textContent = '';
    this.innerHTML = '';
    this._cls = new Set();
    const cls = this._cls;
    this.classList = {
      add: (...c) => c.forEach((x) => cls.add(x)),
      remove: (...c) => c.forEach((x) => cls.delete(x)),
      toggle: (c, on) => ((on === undefined ? !cls.has(c) : on) ? cls.add(c) : cls.delete(c)),
      contains: (c) => cls.has(c),
    };
    this.readyState = 0;
    this.videoWidth = 0;
    this.videoHeight = 0;
    this.width = 0;
    this.height = 0;
    this.clientWidth = 0;
    this.clientHeight = 0;
    this.paused = true;
  }
  set className(v) {
    this._cls.clear();
    String(v).split(/\s+/).filter(Boolean).forEach((c) => this._cls.add(c));
  }
  get className() {
    return [...this._cls].join(' ');
  }
  get parentElement() {
    return this.parentNode;
  }
  get isConnected() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return n === doc.documentElement;
  }
  get childElementCount() {
    return this.children.length;
  }
  get firstChild() {
    return this.children[0] || null;
  }
  appendChild(c) {
    if (c.parentNode) c.remove();
    c.parentNode = this;
    this.children.push(c);
    return c;
  }
  append(...cs) {
    for (const c of cs) if (c) this.appendChild(c);
  }
  insertBefore(c, ref) {
    if (c.parentNode) c.remove();
    const i = ref ? this.children.indexOf(ref) : -1;
    c.parentNode = this;
    if (i < 0) this.children.push(c);
    else this.children.splice(i, 0, c);
    return c;
  }
  replaceChildren(...cs) {
    for (const c of [...this.children]) c.remove();
    this.append(...cs);
  }
  remove() {
    if (!this.parentNode) return;
    const p = this.parentNode;
    p.children.splice(p.children.indexOf(this), 1);
    this.parentNode = null;
  }
  closest(sel) {
    const c = sel.replace(/^\./, '');
    for (let n = this; n; n = n.parentNode) if (n._cls && n._cls.has(c)) return n;
    return null;
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  getAttribute(k) {
    return this.attrs[k] ?? null;
  }
  removeAttribute(k) {
    delete this.attrs[k];
  }
  addEventListener(t, f) {
    (this.listeners[t] ||= []).push(f);
  }
  removeEventListener(t, f) {
    this.listeners[t] = (this.listeners[t] || []).filter((x) => x !== f);
  }
  fire(t) {
    for (const f of this.listeners[t] || []) f({ type: t });
  }
  insertAdjacentHTML() {}
  getBoundingClientRect() {
    return { x: 0, y: 0, left: 0, top: 0, width: 0, height: 0 };
  }
  getContext() {
    return new Proxy({}, { get: () => () => ({ data: new Uint8ClampedArray(4) }) });
  }
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
}
const doc = {
  created: [],
  createElement(t) {
    const e = new El(t);
    doc.created.push(e);
    return e;
  },
  createTextNode: (t) => Object.assign(new El('#text'), { textContent: t }),
  getElementById: () => null,
};
doc.documentElement = new El('html');
doc.head = doc.documentElement.appendChild(new El('head'));
doc.body = doc.documentElement.appendChild(new El('body'));

class FakeTrack {
  constructor(kind) {
    this.kind = kind;
    this.enabled = true;
    this.label = 'fake';
    this.readyState = 'live';
  }
  getSettings() {
    return { width: 640, height: 480 };
  }
  stop() {
    this.readyState = 'ended';
  }
}
class FakeStream {
  constructor(tracks = []) {
    this.tracks = [...tracks];
  }
  getTracks() {
    return [...this.tracks];
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === 'video');
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
  addTrack(t) {
    this.tracks.push(t);
  }
  removeTrack(t) {
    this.tracks = this.tracks.filter((x) => x !== t);
  }
}
const channels = [];
class FakePC {
  constructor() {
    this.connectionState = 'new';
    this.signalingState = 'stable';
    this.transceivers = [];
  }
  createDataChannel() {
    const dc = { readyState: 'open', send() {}, close() {} };
    channels.push(dc);
    return dc;
  }
  addTransceiver(k) {
    const t = { receiver: { track: {} }, sender: { track: null, replaceTrack: async () => {}, getParameters: () => ({ encodings: [{}] }), setParameters: async () => {} }, setCodecPreferences() {} };
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
    return { type: 'offer', sdp: 'v=0\r\n' };
  }
  async createAnswer() {
    return { type: 'answer', sdp: 'v=0\r\n' };
  }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  async addIceCandidate() {}
  close() {}
}

globalThis.document = doc;
globalThis.MediaStream = FakeStream;
globalThis.RTCPeerConnection = FakePC;
globalThis.requestAnimationFrame = () => 0; // the page paint loop is not needed here
globalThis.cancelAnimationFrame = () => {};

const { addCall, makeHello, createLiveGate } = await import('../js/inline3d-call.js');

/**
 * A wall whose inline session is SILENT until a layer/scene exists (the real panel's behaviour),
 * then ticks with a ONE-view viewer pose (the browser's inline pose; per-eye views are per layer).
 */
function silentUntilLayerWall() {
  const w = { layers: 0, frames: 0, ticking: false, pending: [] };
  const tick = () => {
    const cbs = w.pending.splice(0);
    w.frames++;
    for (const cb of cbs) cb(0, { getViewerPose: () => ({ views: [{}] }) });
    if (w.pending.length) setTimeout(tick, 1);
    else w.ticking = false;
  };
  const kick = () => {
    if (w.layers > 0 && !w.ticking && w.pending.length) {
      w.ticking = true;
      setTimeout(tick, 1);
    }
  };
  w.session = {
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame(cb) {
      w.pending.push(cb);
      kick();
      return 1;
    },
  };
  w.wall = {
    supported: true,
    refSpace: {},
    session: w.session,
    close() {},
    addImage() {
      w.layers++;
      kick();
      return { remove: () => w.layers--, firstWoven: Promise.resolve({ woven: true, ms: 1 }) };
    },
    addScene() {
      w.layers++;
      kick();
      return { remove: () => w.layers-- };
    },
  };
  return w;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('#172 deadlock regression: an all-mono call lifts at once, then re-creates the lift once when the session goes live', { timeout: 10000 }, async () => {
  const w = silentUntilLayerWall();
  const lifts = [];
  // Like the real lift(): its canvas becomes an addScene window on the wall it is given.
  const fakeLift = async (el, opts) => {
    const scene = opts.wall.addScene(el, () => {});
    const h = { el, opts, removed: false, state: 'live', native: false, priorities: [], setPriority(p) { this.priorities.push(p); return true; }, setConvergence() {}, remove() { this.removed = true; scene.remove(); } };
    lifts.push(h);
    return h;
  };
  const signaling = { async join(room, hooks) { return { id: hooks.id, peers: ['p1peer000'], send() {}, leave() {} }; } };
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
    for (const dc of channels) dc.onmessage && dc.onmessage({ data: JSON.stringify(hello) });
    const v = doc.created.filter((e) => e.tagName === 'VIDEO' && (e.listeners.playing || []).length).at(-1);
    assert.ok(v, 'the tile video exists');
    Object.assign(v, { readyState: 4, videoWidth: 640, videoHeight: 480 });
    v.fire('playing');
    await sleep(5);
    assert.equal(lifts.length >= 1, true, 'lifted AT ONCE, before the session ever ticked (the old gate never lifted here)');
    assert.equal(lifts[0].opts.mode, 'live');
    assert.equal(lifts[0].opts.wall, w.wall);
    // lift's scene is the only layer → the session starts ticking → 10 one-view frames → live.
    for (let i = 0; i < 100 && lifts.length < 2; i++) await sleep(5);
    assert.ok(w.frames >= 10, `the session ticked (${w.frames} frames)`);
    assert.equal(lifts.length, 2, 'the pre-live lift was re-created exactly once');
    assert.equal(lifts[0].removed, true, 'the pre-live lift was released');
    assert.equal(lifts[1].removed, false);
    await sleep(50);
    assert.equal(lifts.length, 2, 'no further re-creates once live');
    const p = call.peers[0];
    assert.equal(p.route, 'lifted');
    assert.equal(p.lift.live, true);
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

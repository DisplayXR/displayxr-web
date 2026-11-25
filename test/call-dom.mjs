// test/call-dom.mjs — a tiny recording DOM + fake WebRTC for driving the real Call under
// `node --test`. Shared by the call tests that need addCall()/mountCall() to run end to end
// (call-lift-gate, call-mount, call-element). Not jsdom: what these tests assert is control flow —
// which route a tile took, whether a lift was created, what an event carried — and a recording
// double is the useful one. Extracted verbatim from call-lift-gate.test.mjs.

// ── a tiny recording DOM ─────────────────────────────────────────────────────────────────────
export class El {
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
  /** Enough of EventTarget for a custom element's CustomEvents: listeners on THIS node only. */
  dispatchEvent(ev) {
    for (const f of this.listeners[ev.type] || []) f(ev);
    return true;
  }
  hasAttribute(k) {
    return k in this.attrs;
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
export const doc = {
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

export class FakeTrack {
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
export class FakeStream {
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
export const channels = [];
export class FakePC {
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

/**
 * Install the globals the call module touches. Call it BEFORE importing js/inline3d-call.js
 * (the module reads `document` at construction time, not import time, but the pattern keeps
 * every test file honest about what it depends on).
 */
export function installCallDom() {
  globalThis.document = doc;
  globalThis.MediaStream = FakeStream;
  globalThis.RTCPeerConnection = FakePC;
  globalThis.requestAnimationFrame = () => 0; // the page paint loop is not needed here
  globalThis.cancelAnimationFrame = () => {};
  return { doc, channels, FakeTrack, FakeStream, FakePC };
}

/**
 * A wall whose inline session is SILENT until a layer/scene exists (the real panel's behaviour),
 * then ticks with a ONE-view viewer pose (the browser's inline pose; per-eye views are per layer).
 */
export function silentUntilLayerWall() {
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

// <dxr-call> (js/call/element.js) — the C1 gate's element tests (RFC 0003 §7): attribute → option
// mapping, events re-dispatched as DOM CustomEvents, disconnect = leave. Plus: registration by
// importing the entry, `el.options` winning over attributes, a mount that lands after the element
// left, a failing mount, and — through the real mountCall with the recording DOM — an end-to-end
// element call.
//
// No jsdom. `HTMLElement` is the recording El of test/call-dom.mjs (it has the attribute and
// listener surface the element uses), `customElements` and `CustomEvent` are two-line fakes, and
// the element's mount seam takes a fake handle for the unit tests. Own file: installs globals.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installCallDom, doc, El, FakeTrack, FakeStream } from './call-dom.mjs';

installCallDom();
globalThis.HTMLElement = El;
const registry = new Map();
globalThis.customElements = { define: (n, c) => registry.set(n, c), get: (n) => registry.get(n) };
globalThis.CustomEvent = class {
  constructor(type, init = {}) {
    this.type = type;
    this.detail = init.detail;
    this.bubbles = !!init.bubbles;
    this.composed = !!init.composed;
  }
};

const mod = await import('../js/inline3d-call.js');
const { DxrCallElement, attrsToOpts, defineCallElement, CALL_EVENT_PREFIX, mountCall, DXR_SIGNAL_DEFAULT } = mod;

/** A fake CallHandle: records leave(), lets a test emit events. */
function fakeHandle() {
  const listeners = new Map();
  const h = {
    leaves: 0,
    state: 'lobby',
    on(t, cb) {
      if (!listeners.has(t)) listeners.set(t, new Set());
      listeners.get(t).add(cb);
      return () => listeners.get(t)?.delete(cb);
    },
    off(t, cb) {
      listeners.get(t)?.delete(cb);
    },
    emit(t, p) {
      for (const cb of listeners.get(t) || []) cb(p);
    },
    leave() {
      h.leaves++;
      h.state = 'left';
      h.emit('left', { room: 'r' });
    },
    listening: (t) => (listeners.get(t) || new Set()).size,
  };
  return h;
}

/** A fake mount seam recording (el, opts); resolves with a fresh fake handle (or as told). */
function fakeMount({ delayMs = 0, reject = null } = {}) {
  const calls = [];
  const fn = async (el, opts) => {
    calls.push({ el, opts });
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (reject) throw reject;
    return fakeHandle();
  };
  fn.calls = calls;
  return fn;
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const withMount = async (m, fn) => {
  const prev = DxrCallElement.mount;
  DxrCallElement.mount = m;
  try {
    return await fn();
  } finally {
    DxrCallElement.mount = prev;
  }
};
/** A `<dxr-call>` with attributes, "in the document" (connected → connectedCallback, as the browser would). */
function makeEl(attrs = {}) {
  const el = new DxrCallElement();
  el.tagName = 'DXR-CALL';
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}
const connect = (el) => {
  doc.body.appendChild(el);
  el.connectedCallback();
};
const disconnect = (el) => {
  el.remove();
  el.disconnectedCallback();
};

test('importing @displayxr/inline3d/call registers <dxr-call>; defineCallElement is idempotent; no globals', () => {
  assert.equal(registry.get('dxr-call'), DxrCallElement, 'the entry defined the element');
  assert.equal(defineCallElement(), false, 'already defined → false, no second define');
  assert.equal(defineCallElement('dxr-call', null), false, 'no registry → false, no throw');
  assert.equal(globalThis.DisplayXR, undefined, 'Decision 11: no global');
  assert.equal(CALL_EVENT_PREFIX, 'dxr-call:');
});

test('attrsToOpts: the attribute → option table (unset attributes contribute nothing)', () => {
  assert.deepEqual(attrsToOpts(() => null), {}, 'nothing set → nothing: the call defaults apply');
  const room = 'Q'.repeat(22);
  const o = attrsToOpts(
    makeEl({
      room,
      signaling: 'wss://sig.example',
      key: 'pk_abc',
      camera: 'stereo',
      layout: 'speaker',
      accent: 'violet',
      'max-peers': '3',
      'no-ui': '',
      'auto-join': '',
      mono3d: 'off',
      'no-audio': '',
      'no-self-view': '',
      'no-auto-converge': '',
      'tile-aspect': '4/3',
      'invite-base': 'https://x.example/call',
      'browser-url': 'https://dl.example',
      debug: '',
    })
  );
  assert.equal(o.room, room);
  assert.equal(o.signaling.name, 'dxr');
  assert.equal(o.signaling.url, 'wss://sig.example');
  assert.equal(o.key, 'pk_abc');
  assert.equal(o.camera, 'stereo');
  assert.equal(o.layout, 'speaker');
  assert.equal(o.accent, 'violet');
  assert.equal(o.maxPeers, 3);
  assert.equal(o.ui, false);
  assert.equal(o.autoJoin, true);
  assert.equal(o.mono3D, 'off');
  assert.equal(o.audio, false);
  assert.equal(o.selfView, false);
  assert.equal(o.autoConverge, false);
  assert.equal(o.tileAspect, 4 / 3);
  assert.equal(o.inviteBase, 'https://x.example/call');
  assert.equal(o.browserUrl, 'https://dl.example');
  assert.equal(o.debug, true);
  // Booleans: present = true, unless the value spells false. mono3d only knows "off".
  assert.equal(attrsToOpts(makeEl({ 'no-ui': 'false' })).ui, undefined);
  assert.equal(attrsToOpts(makeEl({ 'auto-join': 'true' })).autoJoin, true);
  assert.equal(attrsToOpts(makeEl({ mono3d: 'auto' })).mono3D, undefined);
  assert.equal(attrsToOpts(makeEl({ 'tile-aspect': '1.5' })).tileAspect, 1.5);
  assert.equal(attrsToOpts(makeEl({ 'tile-aspect': 'wide' })).tileAspect, undefined);
  assert.equal(attrsToOpts(makeEl({ 'max-peers': '' })).maxPeers, undefined);
  // No `signaling` attribute → no adapter here: the call's own default (the hosted server) applies.
  assert.equal(attrsToOpts(makeEl({ key: 'pk_1' })).signaling, undefined);
  assert.equal(DXR_SIGNAL_DEFAULT, 'wss://dxr-signal.displayxr.workers.dev');
  // A key with an explicit signaling URL reaches that adapter (its connect URL carries it).
  assert.equal(attrsToOpts(makeEl({ signaling: 'wss://s', key: 'pk_1' })).key, 'pk_1');
});

test('connect mounts with attrs + el.options (options win); el.call and dxr-call:ready once it lands', async () => {
  const m = fakeMount();
  await withMount(m, async () => {
    const el = makeEl({ room: 'R'.repeat(22), accent: 'amber', 'max-peers': '2' });
    const stream = new FakeStream([new FakeTrack('video')]);
    el.options = { camera: stream, format: 'sbs', accent: 'lime' };
    const readyEvents = [];
    el.addEventListener('dxr-call:ready', (e) => readyEvents.push(e));
    assert.equal(el.call, null);
    connect(el);
    assert.equal(m.calls.length, 1);
    assert.equal(m.calls[0].el, el, 'the element IS the container (light DOM)');
    assert.equal(m.calls[0].opts.room, 'R'.repeat(22));
    assert.equal(m.calls[0].opts.maxPeers, 2);
    assert.equal(m.calls[0].opts.camera, stream, 'a non-string option came from el.options');
    assert.equal(m.calls[0].opts.format, 'sbs');
    assert.equal(m.calls[0].opts.accent, 'lime', 'el.options wins over the attribute');
    const h = await el.ready;
    assert.equal(el.call, h);
    assert.equal(readyEvents.length, 1);
    assert.equal(readyEvents[0].detail.call, h);
    assert.equal(readyEvents[0].bubbles, true);
    assert.equal(readyEvents[0].composed, true);
    el.connectedCallback(); // a spurious second connect (a DOM move that re-adds it) does not remount
    assert.equal(m.calls.length, 1);
    disconnect(el);
  });
});

test('every call event is re-dispatched as a bubbling CustomEvent dxr-call:<type> with the payload in detail', async () => {
  await withMount(fakeMount(), async () => {
    const el = makeEl();
    const seen = [];
    for (const t of ['joined', 'left', 'peer', 'peerleft', 'state', 'format', 'speaker', 'quality', 'error', 'warning', 'session']) {
      el.addEventListener(`dxr-call:${t}`, (e) => seen.push([e.type, e.detail, e.bubbles]));
    }
    const warned = [];
    const orig = console.warn;
    console.warn = (...a) => warned.push(a.join(' '));
    try {
      connect(el);
      const h = await el.ready;
      h.emit('joined', { room: 'r', id: 'me' });
      h.emit('peer', { id: 'p1' });
      h.emit('warning', { code: 'lift-not-bundled', message: 'x' });
      h.emit('error', { code: 'camera-busy', message: 'held', error: null });
      h.emit('quality', { id: 'p1', in: null, out: null });
      assert.deepEqual(
        seen.map(([t, d]) => [t, d.id ?? d.code ?? d.room]),
        [
          ['dxr-call:joined', 'me'],
          ['dxr-call:peer', 'p1'],
          ['dxr-call:warning', 'lift-not-bundled'],
          ['dxr-call:error', 'camera-busy'],
          ['dxr-call:quality', 'p1'],
        ]
      );
      assert.ok(seen.every(([, , bubbles]) => bubbles));
      assert.equal(warned.filter((w) => w.includes('camera-busy')).length, 1, 'errors are also said in the console (a page may have no JS at all)');
      disconnect(el);
    } finally {
      console.warn = orig;
    }
  });
});

test('disconnect = leave: once, el.call → null, dxr-call:left still reaches the element, listeners unhooked', async () => {
  await withMount(fakeMount(), async () => {
    const el = makeEl();
    const lefts = [];
    el.addEventListener('dxr-call:left', (e) => lefts.push(e.detail));
    connect(el);
    const h = await el.ready;
    disconnect(el);
    assert.equal(h.leaves, 1);
    assert.equal(el.call, null);
    assert.equal(lefts.length, 1, "the call's 'left' was re-dispatched before the unhook");
    assert.equal(h.listening('peer'), 0, 'unhooked');
    disconnect(el);
    assert.equal(h.leaves, 1, 'a second disconnect is a no-op');
    // Re-appending starts a FRESH call (a new mount), never the old handle.
    connect(el);
    const h2 = await el.ready;
    assert.notEqual(h2, h);
    assert.equal(el.call, h2);
    disconnect(el);
    assert.equal(h2.leaves, 1);
  });
});

test('a mount that lands after the element left is left at once; a failing mount → dxr-call:error + ready rejects', async () => {
  const slow = fakeMount({ delayMs: 20 });
  await withMount(slow, async () => {
    const el = makeEl();
    connect(el);
    disconnect(el); // gone while the camera/lobby is coming up
    const h = await el.ready;
    assert.equal(h, null, 'ready resolves null: the element left first');
    assert.equal(el.call, null);
    await flush();
    const landed = await slow.calls[0];
    void landed;
  });
  // The handle the slow mount produced was left: reach it through a second, observable seam.
  const handles = [];
  const slowSeen = async () => {
    await new Promise((r) => setTimeout(r, 10));
    const h = fakeHandle();
    handles.push(h);
    return h;
  };
  await withMount(slowSeen, async () => {
    const el = makeEl();
    connect(el);
    disconnect(el);
    await el.ready;
    assert.equal(handles.length, 1);
    assert.equal(handles[0].leaves, 1, 'the late handle was left, not leaked');
  });
  const boom = new Error('no camera and no mic');
  const warned = [];
  const orig = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  try {
    await withMount(fakeMount({ reject: boom }), async () => {
      const el = makeEl();
      const errors = [];
      el.addEventListener('dxr-call:error', (e) => errors.push(e.detail));
      connect(el);
      await assert.rejects(el.ready, boom);
      assert.equal(errors.length, 1);
      assert.equal(errors[0].code, 'mount-failed');
      assert.equal(errors[0].error, boom);
      assert.equal(el.call, null);
      assert.ok(warned.some((w) => w.includes('mount failed')));
      disconnect(el); // nothing to leave; no throw
    });
  } finally {
    console.warn = orig;
  }
});

test('end to end with the REAL mountCall: <dxr-call auto-join no-ui> joins, events flow, disconnect leaves', async () => {
  // No navigator.xr here: a 2D wall, as in any non-DisplayXR browser (the woven path is the
  // #172 gate test's; the element adds nothing to routing).
  const joined = [];
  const peers = [];
  const el = makeEl({ 'auto-join': '', 'no-ui': '', 'no-audio': '', 'no-self-view': '', room: 'E'.repeat(22) });
  el.addEventListener('dxr-call:peer', (e) => peers.push(e.detail));
  el.options = {
    // One participant already in the room: reported DURING the join, i.e. during the mount.
    signaling: { async join(room, hooks) { return { id: hooks.id, peers: ['~~~~~~~~~~~'], send() {}, leave() {} }; } },
    camera: new FakeStream([new FakeTrack('video')]),
    format: 'mono',
  };
  el.addEventListener('dxr-call:joined', (e) => joined.push(e.detail));
  const lefts = [];
  el.addEventListener('dxr-call:left', (e) => lefts.push(e.detail));
  assert.equal(DxrCallElement.mount, null, 'the plain ./call entry leaves the seam at its default');
  connect(el);
  const h = await el.ready;
  try {
    assert.equal(h.state, 'in-call', 'auto-join: mounted straight into the call');
    assert.equal(h.room, 'E'.repeat(22));
    assert.equal(h.wall.supported, false, 'the shared wall of a 2D document');
    assert.equal(joined.length, 1, "auto-join joined DURING the mount; the element re-issues 'joined' once it can");
    assert.equal(joined[0].id, h.id);
    assert.equal(joined[0].room, h.room);
    assert.deepEqual(peers, [{ id: '~~~~~~~~~~~' }], "a participant already in the room is replayed as 'peer' after ready");
    assert.equal(h.peers.length, 1);
    assert.ok(el.classList.contains('dxr-call-host'), 'the element is the call host');
  } finally {
    disconnect(el); // a failing assertion must not leave the call's timers holding the process
  }
  assert.equal(h.state, 'left');
  assert.equal(lefts.length, 1);
  assert.equal(el.call, null);
});

test('./call/full points the element at its own mountCall (so <dxr-call> lifts), and re-exports the surface', async () => {
  const full = await import('../js/inline3d-call-full.js');
  assert.equal(DxrCallElement.mount, full.mountCall);
  assert.notEqual(full.mountCall, mountCall);
  assert.equal(full.addCall !== mod.addCall, true);
  assert.equal(full.dxrSignaling, mod.dxrSignaling);
  assert.equal(full.DxrCallElement, DxrCallElement);
  assert.equal(typeof full.liftBundled, 'boolean');
  // With the placeholder (no lift on main) it is the plain entry; with the real module, the
  // default mono3D is that lift. Either way an explicit mono3D is untouched.
  const m = fakeMount();
  await withMount(m, async () => {
    const el = makeEl();
    el.options = { mono3D: 'off' };
    connect(el);
    await el.ready;
    assert.equal(m.calls[0].opts.mono3D, 'off');
    disconnect(el);
  });
  DxrCallElement.mount = null; // leave the seam as ./call had it for any later test
});

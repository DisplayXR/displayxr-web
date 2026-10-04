// Tests for the sample's peerjsCloud() adapter (samples/call/peerjs-cloud.js) — the demo
// SignalingAdapter over the public PeerJS broker. It left the package in 1.29 (RFC 0003, Decision
// 12) but the sample still offers it (`?signal=peerjs`), so its slot/zombie logic stays pinned
// here against an in-memory fake broker. Moved verbatim from test/call.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';

import { newRoomId } from '../js/call/wire.js';
import { roomKey } from '../js/call/signaling.js';
import { peerjsCloud } from '../samples/call/peerjs-cloud.js';

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

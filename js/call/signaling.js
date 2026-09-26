// call/signaling.js — the SignalingAdapter seam, and the two adapters the SDK ships.
//
// A SignalingAdapter is ANY object with `join(room, hooks) → Promise<SignalingSession>`:
//
//   join(room, {
//     id,            // this peer's id (the transport picks it; stable across reconnects)
//     maxPeers,      // the room size this peer asks for
//     onPeerJoined(id), onPeerLeft(id), onSignal(fromId, data),
//     onDisconnect(err?), onReconnect(peerIds),
//   }) → Promise<{ id, peers: string[], iceServers?: RTCIceServer[], send(to, data), leave() }>
//
// It rejects with an Error whose `code` is 'room-full' when the room is at capacity. That is the
// whole contract: presence, a relay for opaque offer/answer/ICE blobs, and leaving. Bring your
// own (your accounts, your push service) by implementing it — see call.d.ts.
//
//   dxrSignaling(url)  the `dxr-signal/1` JSON-over-WebSocket protocol (signaling/README.md), served
//                      by the reference Cloudflare Worker or `node signaling/dev-server.mjs`.
//   peerjsCloud()      DEMO ONLY: the free public PeerJS broker. No uptime guarantee, not ours, and
//                      every peer id it sees is derived from a hash of the room.

import { backoffMs } from './wire.js';

export const SIGNAL_PROTOCOL = 'dxr-signal/1';

function codedError(code, message) {
  const e = new Error(`@displayxr/inline3d/call: ${message}`);
  /** @type {any} */ (e).code = code;
  return e;
}

/** SHA-256 hex of the room id: the only room-derived value that goes into a URL. */
export async function roomKey(room) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(room)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The `dxr-signal/1` client. `url` is the server's base (`wss://signal.example.com` or
 * `ws://localhost:8787`); the adapter connects to `<url>/v1/connect?k=<sha256(room)>`.
 *
 * A dropped socket is reconnected with backoff and the SAME peer id, so media that is flowing
 * peer-to-peer is not torn down by a signalling blip.
 *
 * @param {string} url
 * @param {{ WebSocket?: any, pingMs?: number }} [opts]
 */
export function dxrSignaling(url, opts = {}) {
  if (!url || typeof url !== 'string') {
    throw codedError(
      'no-signaling-url',
      'dxrSignaling(url) needs your signalling server URL (there is no hosted default yet) — ' +
        'run `node signaling/dev-server.mjs` for local work, or deploy signaling/worker.mjs.'
    );
  }
  const base = url.replace(/\/+$/, '');
  const WS = opts.WebSocket || globalThis.WebSocket;
  const pingMs = opts.pingMs || 20000;

  return {
    name: 'dxr',
    url: base,
    async join(room, hooks) {
      const key = await roomKey(room);
      const endpoint = `${base}/v1/connect?k=${key}`;
      let ws = null;
      let left = false;
      let attempt = 0;
      let pingTimer = null;
      let known = new Set();
      let queue = [];

      const open = (isReconnect) =>
        new Promise((resolve, reject) => {
          let settled = false;
          let joined = false;
          const sock = new WS(endpoint);
          ws = sock;
          const fail = (err) => {
            if (!settled) {
              settled = true;
              try {
                sock.close(); // a failed join never leaves a socket behind
              } catch {
                /* already closing */
              }
              reject(err);
            }
          };
          sock.onopen = () => {
            sock.send(JSON.stringify({ t: 'join', v: 1, room, id: hooks.id, max: hooks.maxPeers }));
          };
          sock.onmessage = (ev) => {
            let msg;
            try {
              msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
            } catch {
              return;
            }
            switch (msg.t) {
              case 'welcome': {
                attempt = 0;
                const peers = Array.isArray(msg.peers) ? msg.peers.filter((p) => typeof p === 'string') : [];
                clearInterval(pingTimer);
                pingTimer = setInterval(() => sendRaw({ t: 'ping' }), pingMs);
                const flush = queue;
                queue = [];
                for (const m of flush) sendRaw(m);
                if (isReconnect) {
                  const now = new Set(peers);
                  for (const p of known) if (!now.has(p)) hooks.onPeerLeft?.(p);
                  known = now;
                  hooks.onReconnect?.(peers);
                } else known = new Set(peers);
                settled = true;
                joined = true;
                resolve({ id: msg.id, peers, iceServers: Array.isArray(msg.iceServers) ? msg.iceServers : undefined, max: msg.max });
                break;
              }
              case 'full':
                left = true;
                fail(codedError('room-full', `this call is full (${msg.max} participants)`));
                break;
              case 'error':
                if (!settled && ['bad-room', 'bad-id', 'bad-version'].includes(msg.code)) {
                  left = true;
                  fail(codedError(msg.code, msg.message || msg.code));
                } else if (!settled && msg.code === 'id-taken') {
                  // A reconnect raced the server noticing the old socket close: retry shortly.
                  fail(codedError('id-taken', 'peer id still held; retrying'));
                }
                break;
              case 'peer-joined':
                if (typeof msg.id === 'string' && !known.has(msg.id)) {
                  known.add(msg.id);
                  hooks.onPeerJoined?.(msg.id);
                }
                break;
              case 'peer-left':
                if (typeof msg.id === 'string') {
                  known.delete(msg.id);
                  hooks.onPeerLeft?.(msg.id);
                }
                break;
              case 'signal':
                if (typeof msg.from === 'string') hooks.onSignal?.(msg.from, msg.data);
                break;
            }
          };
          sock.onerror = () => fail(codedError('signaling-unreachable', `cannot reach ${base}`));
          sock.onclose = () => {
            clearInterval(pingTimer);
            fail(codedError('signaling-closed', 'signalling closed before joining'));
            if (joined && !left && ws === sock) reconnect();
          };
        });

      const sendRaw = (m) => {
        if (ws && ws.readyState === 1) ws.send(JSON.stringify(m));
        else if (!left) queue.push(m);
      };

      const reconnect = () => {
        hooks.onDisconnect?.();
        const tryAgain = () => {
          if (left) return;
          open(true).catch((err) => {
            if (left || (err && err.code === 'room-full')) {
              hooks.onDisconnect?.(err);
              return;
            }
            setTimeout(tryAgain, backoffMs(attempt++, { baseMs: 500, maxMs: 15000 }));
          });
        };
        setTimeout(tryAgain, backoffMs(attempt++, { baseMs: 300, maxMs: 15000 }));
      };

      const first = await open(false);
      return {
        ...first,
        send: (to, data) => sendRaw({ t: 'signal', to, data }),
        leave: () => {
          if (left) return;
          left = true;
          clearInterval(pingTimer);
          try {
            if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'leave' }));
            ws && ws.close(1000, 'leave');
          } catch {
            /* ignore */
          }
        },
      };
    },
  };
}

/**
 * DEMO ONLY — zero-setup signalling over the free public PeerJS broker (0.peerjs.com). It has no
 * uptime guarantee and is not operated by DisplayXR; use `dxrSignaling(url)` for anything real.
 *
 * PeerJS has no rooms, so this adapter makes one out of SLOTS: each peer registers the broker id
 * `dxrcall-<hash(room)>-<k>` for the first free k (a taken id is how "slot in use" is discovered),
 * opens a PeerJS data connection to every other slot, and relays our signalling over those.
 *
 * A taken slot is NOT the same as a live participant, and that is what the rest of this adapter
 * deals with:
 *  - A page that went away without its broker socket closing leaves a ZOMBIE slot. So there are
 *    twice as many slots as participants (a zombie never blocks a join), a slot counts as a
 *    participant only once it has said `hi`, and the room size is enforced on those. The page's own
 *    Peer is destroyed on `pagehide` / `beforeunload`, so a reload frees its slot at once.
 *  - A slot that exists but never says `hi` within `unreachableMs` is reported through
 *    `onPeerUnreachable('slot-<k>')`: the usual cause is a network where even the data
 *    connection's ICE never completes (it needs a relay). Silent slots are re-dialled every
 *    `retryMs` in the background; a `hi` (or the broker saying the slot is free) clears it again
 *    via `onPeerReachable`.
 *
 * @param {{ Peer?: any, peerOptions?: object, url?: string, helloMs?: number, unreachableMs?: number,
 *           retryMs?: number, heartbeatMs?: number, settleMs?: number }} [opts]
 *        `Peer`: the PeerJS constructor (default: `globalThis.Peer`, else the ESM build from jsDelivr).
 */
export function peerjsCloud(opts = {}) {
  const T = {
    hello: opts.helloMs || 5000,
    unreachable: opts.unreachableMs || 10000,
    retry: opts.retryMs || 10000,
    heartbeat: opts.heartbeatMs || 3000,
    settle: opts.settleMs || 1500,
  };
  const loadPeer = async () => {
    if (opts.Peer) return opts.Peer;
    if (globalThis.Peer) return globalThis.Peer;
    const mod = await import(/* @vite-ignore */ opts.url || 'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/+esm');
    return mod.Peer || mod.default;
  };
  return {
    name: 'peerjs',
    async join(room, hooks) {
      const Peer = await loadPeer();
      const tag = (await roomKey(room)).slice(0, 24);
      const max = hooks.maxPeers || 4;
      const nSlots = max * 2; // zombies must never make a room look full
      const slotId = (k) => `dxrcall-${tag}-${k}`;

      let peer = null;
      let mySlot = -1;
      for (let k = 0; k < nSlots && !peer; k++) {
        peer = await new Promise((resolve) => {
          const p = new Peer(slotId(k), opts.peerOptions || {});
          const onErr = (e) => {
            if (e && e.type === 'unavailable-id') {
              p.destroy();
              resolve(null);
            }
          };
          p.on('error', onErr);
          p.on('open', () => {
            p.off?.('error', onErr);
            mySlot = k;
            resolve(p);
          });
        });
      }
      if (!peer) throw codedError('room-full', `every slot of this call is taken (${nSlots})`);

      const byId = new Map(); // logical peer id -> { conn, seen }
      const bySlot = new Map(); // broker id -> logical peer id
      const silent = new Map(); // broker id -> { since, reported, conn }
      let left = false;

      const markReachable = (brokerId) => {
        const s = silent.get(brokerId);
        if (!s) return;
        silent.delete(brokerId);
        if (s.reported) hooks.onPeerReachable?.(`slot-${brokerId.split('-').pop()}`);
      };
      const wire = (conn) => {
        conn.on('open', () => conn.send({ t: 'hi', id: hooks.id }));
        conn.on('data', (msg) => {
          if (!msg || typeof msg !== 'object') return;
          const known = bySlot.get(conn.peer);
          if (msg.t === 'hi' && typeof msg.id === 'string') {
            markReachable(conn.peer);
            if (!known) {
              bySlot.set(conn.peer, msg.id);
              const prev = byId.get(msg.id);
              byId.set(msg.id, { conn, seen: Date.now() });
              if (!prev) hooks.onPeerJoined?.(msg.id);
              if (conn.open) conn.send({ t: 'hi', id: hooks.id });
            }
            return;
          }
          if (!known) return;
          const rec = byId.get(known);
          if (rec) rec.seen = Date.now();
          if (msg.t === 'signal') hooks.onSignal?.(known, msg.data);
          else if (msg.t === 'bye') drop(conn.peer);
        });
        conn.on('close', () => drop(conn.peer));
        conn.on('error', () => {});
      };
      const drop = (brokerId) => {
        const id = bySlot.get(brokerId);
        if (!id) return;
        bySlot.delete(brokerId);
        byId.delete(id);
        hooks.onPeerLeft?.(id);
      };
      const dial = (k) => {
        const b = slotId(k);
        if (!silent.has(b)) silent.set(b, { since: Date.now(), reported: false, conn: null });
        const c = peer.connect(b, { reliable: true });
        silent.get(b).conn = c;
        wire(c);
      };

      peer.on('connection', wire);
      peer.on('error', (e) => {
        // 'peer-unavailable' names the broker id: that slot is FREE, so it is not a participant.
        const m = e && e.type === 'peer-unavailable' && String(e.message || '').match(/(dxrcall-[0-9a-f]+-\d+)/);
        if (m) markReachable(m[1]);
      });
      for (let k = 0; k < nSlots; k++) if (k !== mySlot) dial(k);

      const hb = setInterval(() => {
        const now = Date.now();
        for (const [id, rec] of byId) {
          if (now - rec.seen > 4 * T.heartbeat) {
            for (const [b, pid] of bySlot) if (pid === id) drop(b);
          } else if (rec.conn.open) rec.conn.send({ t: 'hb' });
        }
        for (const [b, st] of silent) {
          // Silent past the hello window → not counted; past the unreachable window → reported.
          if (!st.reported && now - st.since > T.unreachable) {
            st.reported = true;
            hooks.onPeerUnreachable?.(`slot-${b.split('-').pop()}`);
          }
          if (now - (st.lastDial || st.since) > T.retry) {
            st.lastDial = now;
            try {
              if (st.conn && !st.conn.open) st.conn.close(); // one pending attempt per slot
            } catch {
              /* ignore */
            }
            st.conn = peer.connect(b, { reliable: true }); // background retry of a silent slot
            wire(st.conn);
          }
        }
      }, Math.min(T.heartbeat, 1000));

      // Free this page's slot the moment it goes away — otherwise a reload leaves a zombie.
      const unload = () => {
        try {
          for (const rec of byId.values()) if (rec.conn.open) rec.conn.send({ t: 'bye' });
          peer.destroy();
        } catch {
          /* ignore */
        }
      };
      globalThis.addEventListener?.('pagehide', unload);
      globalThis.addEventListener?.('beforeunload', unload);

      // Give the slot mesh a moment to say hello, so `peers` is useful. Only slots that said `hi`
      // count (the transport enforces the room size on this list); late ones arrive through
      // onPeerJoined like any other join.
      await new Promise((r) => setTimeout(r, Math.min(T.settle, T.hello)));
      // Hand the media connections the same relays PeerJS itself uses (its public TURN, or a
      // page's `peerOptions.config`), so a demo call crosses the NATs a bare-PeerJS app crosses.
      // Demo-grade: shared, no uptime guarantee — production TURN comes from dxrSignaling().
      const relays = (peer.options?.config?.iceServers || []).filter((s) =>
        [].concat(s.urls || s.url || []).some((u) => /^turns?:/.test(u)));
      return {
        id: hooks.id,
        peers: [...byId.keys()],
        iceServers: relays.length ? relays : undefined,
        slot: mySlot,
        send: (to, data) => {
          const rec = byId.get(to);
          if (rec && rec.conn.open) rec.conn.send({ t: 'signal', data });
        },
        leave: () => {
          if (left) return;
          left = true;
          clearInterval(hb);
          globalThis.removeEventListener?.('pagehide', unload);
          globalThis.removeEventListener?.('beforeunload', unload);
          for (const rec of byId.values()) if (rec.conn.open) rec.conn.send({ t: 'bye' });
          setTimeout(() => peer.destroy(), 200);
        },
      };
    },
  };
}

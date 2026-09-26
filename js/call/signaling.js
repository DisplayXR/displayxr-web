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
 * PeerJS has no rooms, so this adapter makes one out of SLOTS: peer `k` of a room registers the
 * broker id `dxrcall-<hash(room)>-<k>` (the first free k < maxPeers — a taken id is how "slot in
 * use" is discovered, and no free slot is 'room-full'), opens a PeerJS data connection to every
 * other slot, and relays our signalling over those. A heartbeat detects a peer that vanished.
 *
 * @param {{ Peer?: any, peerOptions?: object, url?: string }} [opts]  `Peer`: the PeerJS
 *        constructor (default: `globalThis.Peer`, else the ESM build from jsDelivr).
 */
export function peerjsCloud(opts = {}) {
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
      const slot = (k) => `dxrcall-${tag}-${k}`;

      let peer = null;
      let mySlot = -1;
      for (let k = 0; k < max && !peer; k++) {
        peer = await new Promise((resolve) => {
          const p = new Peer(slot(k), opts.peerOptions || {});
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
      if (!peer) throw codedError('room-full', `this call is full (${max} participants)`);

      const byId = new Map(); // logical peer id -> { conn, seen }
      const bySlot = new Map(); // broker id -> logical peer id
      let left = false;

      const wire = (conn) => {
        conn.on('open', () => conn.send({ t: 'hi', id: hooks.id }));
        conn.on('data', (msg) => {
          if (!msg || typeof msg !== 'object') return;
          const known = bySlot.get(conn.peer);
          if (msg.t === 'hi' && typeof msg.id === 'string') {
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

      peer.on('connection', wire);
      peer.on('error', () => {}); // peer-unavailable for empty slots is expected
      for (let k = 0; k < max; k++) if (k !== mySlot) wire(peer.connect(slot(k), { reliable: true }));

      const hb = setInterval(() => {
        const now = Date.now();
        for (const [id, rec] of byId) {
          if (now - rec.seen > 12000) {
            for (const [b, pid] of bySlot) if (pid === id) drop(b);
          } else if (rec.conn.open) rec.conn.send({ t: 'hb' });
        }
      }, 3000);

      // Give the slot mesh a moment to say hello, so `peers` is useful; late arrivals come
      // through onPeerJoined like any other join.
      await new Promise((r) => setTimeout(r, 1500));
      return {
        id: hooks.id,
        peers: [...byId.keys()],
        send: (to, data) => {
          const rec = byId.get(to);
          if (rec && rec.conn.open) rec.conn.send({ t: 'signal', data });
        },
        leave: () => {
          if (left) return;
          left = true;
          clearInterval(hb);
          for (const rec of byId.values()) if (rec.conn.open) rec.conn.send({ t: 'bye' });
          setTimeout(() => peer.destroy(), 200);
        },
      };
    },
  };
}

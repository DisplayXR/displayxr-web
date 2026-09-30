// call/signaling.js — the SignalingAdapter seam, and the adapter the SDK ships.
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
//   (peerjsCloud, the demo adapter over the public PeerJS broker, left the package in 1.29 —
//    RFC 0003 Decision 12 — and lives in samples/call/peerjs-cloud.js as a worked example.)

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
 * @param {{ WebSocket?: any, pingMs?: number, key?: string }} [opts]  `key`: a publishable key for
 *        the hosted service (RFC 0003 §5a), sent as a query parameter on connect. Public by design
 *        (it sits in page source); a server that does not know keys ignores it.
 */
/**
 * The hosted DisplayXR `dxr-signal/1` server (a Cloudflare Worker running `signaling/worker.mjs`,
 * config in `signaling/deploy/displayxr.toml`). It also mints short-lived TURN credentials per
 * join. `dxrSignaling()` with no URL uses it; pass your own URL to self-host.
 */
export const DXR_SIGNAL_DEFAULT = 'wss://dxr-signal.displayxr.workers.dev';

export function dxrSignaling(url = DXR_SIGNAL_DEFAULT, opts = {}) {
  if (!url || typeof url !== 'string') {
    throw codedError(
      'no-signaling-url',
      'dxrSignaling(url): url must be a ws:// or wss:// string (omit it for the hosted DisplayXR server)'
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
      const endpoint = `${base}/v1/connect?k=${key}${typeof opts.key === 'string' && opts.key ? `&key=${encodeURIComponent(opts.key)}` : ''}`;
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

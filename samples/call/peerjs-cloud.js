// samples/call/peerjs-cloud.js — DEMO ONLY: a SignalingAdapter over the free public PeerJS broker.
//
// Removed from the package in 1.29 (RFC 0003, Decision 12): DisplayXR does not run the broker, it
// has no uptime guarantee, and the hosted `dxrSignaling()` server has replaced it as the default.
// It lives on here as the sample's `?signal=peerjs` switch and as a worked example of the
// `SignalingAdapter` seam (call.d.ts): any object with `join(room, hooks)` is a transport.
//
// Imports its two helpers from the SDK's own files (a sample, not a package consumer).

import { roomKey } from '../../js/call/signaling.js';

function codedError(code, message) {
  const e = new Error(`@displayxr/inline3d/call: ${message}`);
  /** @type {any} */ (e).code = code;
  return e;
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


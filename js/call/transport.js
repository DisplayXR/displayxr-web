// call/transport.js — the `Transport` seam and its P1 implementation, a WebRTC full mesh.
//
// A Transport moves media and small reliable messages between this page and up to N−1 others. The
// call module only ever talks to this interface, so an SFU adapter (RFC §2, P3) can replace the
// mesh without the module changing:
//
//   transport.start({ room, localStream, onPeer, onPeerLeft, onStream, onMessage, onPeerState })
//   transport.send(peerId, msg) / broadcast(msg)
//   transport.replaceVideoTrack(track) / setSendFormat(format)
//   transport.peerConnection(peerId)   // for getStats (null on an SFU)
//   transport.stop()
//
// ── the mesh, pair by pair ───────────────────────────────────────────────────────────────────
//
// ROLES ARE DETERMINISTIC: of each pair, the peer with the lexically smaller id is the OFFERER. It
// builds the RTCPeerConnection, adds sendrecv audio + video transceivers and a negotiated data
// channel (id 0, so both ends create it without an in-band handshake), and sends the offer. The
// answerer builds its connection when the offer arrives and attaches its tracks to the offered
// transceivers. Nobody ever offers at the same time as the other side, so there is no glare to
// resolve, and every renegotiation (ICE restart, rebuild) is the offerer's job — an answerer that
// sees trouble just asks for one.
//
// GENERATIONS: every signal carries the connection generation it belongs to. A rebuild bumps it,
// and a late ICE candidate or answer from a dead connection is dropped instead of poisoning the
// new one.
//
// RECOVERY LADDER on a pair that stops working: 'disconnected' for 4 s, or 'failed' → ICE restart
// on the SAME connection (cheap: keeps the transceivers, renegotiates candidates) → if that has
// not connected within 10 s, tear down and rebuild with exponential backoff (1 s, 2 s, 4 s … 30 s,
// jittered). A peer that ALSO left the signalling room is dropped for good instead.

import { preferVideoCodecs, sortCodecCapabilities } from './sdp.js';
import { backoffMs, maxBitrateKbps, DEFAULT_MAX_PEERS, MESH_HARD_CAP } from './wire.js';

export const DEFAULT_ICE_SERVERS = Object.freeze([{ urls: 'stun:stun.l.google.com:19302' }]);
const DISCONNECTED_GRACE_MS = 4000;
const ICE_RESTART_TIMEOUT_MS = 10000;
const CONNECT_TIMEOUT_MS = 20000;
const ANSWERER_WAIT_MS = 8000;

/**
 * Clamp the requested room size to what a full mesh can carry.
 * @param {number} [n]
 */
export function clampMaxPeers(n) {
  const v = Number.isInteger(n) ? n : DEFAULT_MAX_PEERS;
  return Math.max(2, Math.min(MESH_HARD_CAP, v));
}

/** Of a pair, who offers: the lexically smaller id. Pure. */
export function isOfferer(myId, theirId) {
  return myId < theirId;
}

export class MeshTransport {
  /**
   * @param {object} o
   * @param {any} o.signaling  a SignalingAdapter
   * @param {string} o.id  this peer's id
   * @param {number} [o.maxPeers]  room size INCLUDING this peer; clamped to 2..4
   * @param {RTCIceServer[]} [o.iceServers]  overrides what the signalling server hands out
   * @param {any} [o.RTCPeerConnection]  injectable for tests
   * @param {(tag: string, obj: object) => void} [o.log]
   */
  constructor({ signaling, id, maxPeers, iceServers, RTCPeerConnection: PC, log } = {}) {
    this.signaling = signaling;
    this.id = id;
    this.maxPeers = clampMaxPeers(maxPeers);
    this.pageIce = iceServers || null;
    this.iceServers = iceServers || DEFAULT_ICE_SERVERS;
    this.PC = PC || globalThis.RTCPeerConnection;
    this.log = log || (() => {});
    /** @type {Map<string, any>} */
    this.peers = new Map();
    this.session = null;
    this.ready = false;
    this._pending = [];
    this.stopped = false;
    this.sendFormat = 'mono';
    this.localStream = null;
  }

  /** Remote peers currently in the mesh (not counting this one). */
  get size() {
    return this.peers.size;
  }

  async start({ room, localStream, sendFormat, onPeer, onPeerLeft, onStream, onMessage, onPeerState, onRefused, onSignalingState }) {
    this.localStream = localStream;
    this.sendFormat = sendFormat || 'mono';
    this.cb = { onPeer, onPeerLeft, onStream, onMessage, onPeerState, onRefused, onSignalingState };
    // Hooks can fire before join() resolves (the PeerJS adapter discovers peers while joining);
    // queue them so every one runs against a fully-initialised transport.
    const later = (fn) => (...a) => (this.ready ? fn(...a) : this._pending.push(() => fn(...a)));
    this.session = await this.signaling.join(room, {
      id: this.id,
      maxPeers: this.maxPeers,
      onPeerJoined: later((pid) => this._onPeerJoined(pid)),
      onPeerLeft: later((pid) => this._onPeerLeftSignaling(pid)),
      onSignal: later((from, data) => this._onSignal(from, data)),
      onDisconnect: (err) => onSignalingState?.(err ? 'closed' : 'reconnecting', err),
      onReconnect: later((ids) => {
        onSignalingState?.('connected');
        for (const pid of ids) this._onPeerJoined(pid);
      }),
    });
    if (!this.pageIce && this.session.iceServers && this.session.iceServers.length) {
      // Short-lived TURN from the server, plus public STUN.
      this.iceServers = [...DEFAULT_ICE_SERVERS, ...this.session.iceServers];
    }
    // The client enforces the cap too: a server that allows more than this page asked for does
    // not get to grow the mesh. The newest arrivals are the ones refused.
    const existing = this.session.peers || [];
    if (existing.length >= this.maxPeers) {
      this.session.leave();
      const e = new Error(`@displayxr/inline3d/call: this call is full (${this.maxPeers} participants)`);
      /** @type {any} */ (e).code = 'room-full';
      throw e;
    }
    this.ready = true;
    for (const pid of existing) this._onPeerJoined(pid);
    const q = this._pending;
    this._pending = [];
    for (const fn of q) fn();
    return this.session;
  }

  // ── presence ────────────────────────────────────────────────────────────────────────────

  _onPeerJoined(pid) {
    if (this.stopped || pid === this.id) return;
    const rec = this.peers.get(pid);
    if (rec) {
      rec.absent = false; // back in the signalling room (a reconnect); media may never have stopped
      if (rec.state !== 'connected' && isOfferer(this.id, pid)) this._rebuild(rec, 'rejoined');
      return;
    }
    if (this.peers.size >= this.maxPeers - 1) {
      this.log('refused', { peer: pid, reason: 'maxPeers', maxPeers: this.maxPeers });
      this.cb.onRefused?.(pid);
      return;
    }
    const r = this._newRecord(pid);
    this.cb.onPeer?.(pid);
    if (r.offerer) this._build(r, 1);
    else r.waitTimer = setTimeout(() => this._askRestart(r), ANSWERER_WAIT_MS);
  }

  _onPeerLeftSignaling(pid) {
    const rec = this.peers.get(pid);
    if (!rec) return;
    rec.absent = true;
    // Media still flowing peer-to-peer outlives a signalling blip; a dead pair does not.
    if (rec.state !== 'connected') this._drop(rec, 'left');
  }

  _newRecord(pid) {
    const rec = {
      id: pid,
      offerer: isOfferer(this.id, pid),
      pc: null,
      builtAt: 0,
      offerAt: 0,
      dc: null,
      gen: 0,
      state: 'new',
      stream: null,
      attempts: 0,
      iceRestarted: false,
      absent: false,
      pendingCandidates: [],
      timers: new Set(),
      waitTimer: null,
    };
    this.peers.set(pid, rec);
    return rec;
  }

  // ── connection lifecycle ────────────────────────────────────────────────────────────────

  _build(rec, gen) {
    this._closePc(rec);
    rec.gen = gen;
    rec.builtAt = Date.now();
    rec.iceRestarted = false;
    rec.pendingCandidates = [];
    rec.stream = null; // a new connection's tracks arrive in a new stream (a fresh srcObject)
    const pc = new this.PC({ iceServers: this.iceServers });
    rec.pc = pc;
    const dc = pc.createDataChannel('dxr-call', { negotiated: true, id: 0, ordered: true });
    this._wireDc(rec, dc);
    if (rec.offerer) {
      const tracks = this.localStream ? this.localStream.getTracks() : [];
      const audio = tracks.find((t) => t.kind === 'audio');
      const video = tracks.find((t) => t.kind === 'video');
      const streams = this.localStream ? [this.localStream] : [];
      pc.addTransceiver(audio || 'audio', { direction: 'sendrecv', streams });
      const vt = pc.addTransceiver(video || 'video', { direction: 'sendrecv', streams });
      this._preferCodecs(vt);
    }
    pc.onicecandidate = (e) => {
      if (e.candidate) this._signal(rec, { kind: 'candidate', candidate: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate });
    };
    pc.ontrack = (e) => {
      if (!rec.stream) rec.stream = new MediaStream();
      if (!rec.stream.getTracks().includes(e.track)) {
        for (const t of rec.stream.getTracks()) if (t.kind === e.track.kind) rec.stream.removeTrack(t);
        rec.stream.addTrack(e.track);
      }
      this.cb.onStream?.(rec.id, rec.stream);
    };
    pc.onconnectionstatechange = () => this._onConnState(rec, pc);
    this._arm(rec, CONNECT_TIMEOUT_MS, () => {
      if (rec.pc === pc && pc.connectionState !== 'connected') this._fail(rec, 'connect-timeout');
    });
    if (rec.offerer) this._offer(rec).catch((err) => this.log('offer-error', { peer: rec.id, err: String(err) }));
    this._setState(rec, rec.attempts > 0 ? 'reconnecting' : 'connecting');
    return pc;
  }

  async _offer(rec, { iceRestart = false } = {}) {
    const pc = rec.pc;
    const offer = await pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
    if (!this._canPreferCodecs) offer.sdp = preferVideoCodecs(offer.sdp);
    await pc.setLocalDescription(offer);
    this._signal(rec, { kind: 'offer', sdp: pc.localDescription.sdp });
  }

  async _onSignal(from, data) {
    if (this.stopped || !data || typeof data !== 'object') return;
    let rec = this.peers.get(from);
    if (!rec) {
      // An offer from someone we have not seen join (the join event can trail the offer).
      if (data.kind !== 'offer') return;
      this._onPeerJoined(from);
      rec = this.peers.get(from);
      if (!rec) return; // refused by the cap
    }
    const gen = data.gen | 0;
    try {
      switch (data.kind) {
        case 'offer': {
          if (rec.offerer) return; // never happens with deterministic roles; ignore rather than glare
          clearTimeout(rec.waitTimer);
          if (gen < rec.gen) return;
          rec.offerAt = Date.now();
          if (gen > rec.gen || !rec.pc) this._build(rec, gen);
          const pc = rec.pc;
          await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
          this._attachAnswererTracks(rec);
          const answer = await pc.createAnswer();
          if (!this._canPreferCodecs) answer.sdp = preferVideoCodecs(answer.sdp);
          await pc.setLocalDescription(answer);
          this._signal(rec, { kind: 'answer', sdp: pc.localDescription.sdp });
          this._flushCandidates(rec);
          break;
        }
        case 'answer':
          if (!rec.offerer || gen !== rec.gen || !rec.pc || rec.pc.signalingState !== 'have-local-offer') return;
          await rec.pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
          this._flushCandidates(rec);
          break;
        case 'candidate':
          if (gen !== rec.gen || !rec.pc) return;
          if (rec.pc.remoteDescription) await rec.pc.addIceCandidate(data.candidate).catch(() => {});
          else rec.pendingCandidates.push(data.candidate);
          break;
        case 'restart':
          // The answerer lost (or never got) its connection, and only it can know: this side's
          // own view can read 'connected' for ~10 s after the far end vanished (until ICE consent
          // fails). So the ask is authoritative — rebuild now; an ICE restart cannot help a peer
          // whose connection is gone. The one exception is a fresh build already in flight.
          if (!rec.offerer) return;
          if (rec.pc && rec.state !== 'connected' && Date.now() - rec.builtAt < 5000) return;
          this._rebuild(rec, 'peer-asked');
          break;
        case 'bye':
          this._drop(rec, 'left');
          break;
      }
    } catch (err) {
      this.log('signal-error', { peer: from, kind: data.kind, err: String(err) });
    }
  }

  _flushCandidates(rec) {
    const list = rec.pendingCandidates;
    rec.pendingCandidates = [];
    for (const c of list) rec.pc.addIceCandidate(c).catch(() => {});
  }

  /** Answerer side: put our tracks on the transceivers the offer created, and make them sendrecv. */
  _attachAnswererTracks(rec) {
    const pc = rec.pc;
    const tracks = this.localStream ? this.localStream.getTracks() : [];
    for (const tr of pc.getTransceivers()) {
      const kind = tr.receiver && tr.receiver.track ? tr.receiver.track.kind : null;
      if (!kind || tr.sender.track) continue;
      const t = tracks.find((x) => x.kind === kind);
      if (t) {
        tr.sender.replaceTrack(t).catch(() => {});
        if (this.localStream && tr.sender.setStreams) tr.sender.setStreams(this.localStream);
      }
      tr.direction = 'sendrecv';
      if (kind === 'video') this._preferCodecs(tr);
    }
  }

  _preferCodecs(transceiver) {
    const caps = globalThis.RTCRtpReceiver && RTCRtpReceiver.getCapabilities && RTCRtpReceiver.getCapabilities('video');
    this._canPreferCodecs = !!(transceiver && transceiver.setCodecPreferences && caps);
    if (!this._canPreferCodecs) return;
    try {
      transceiver.setCodecPreferences(sortCodecCapabilities(caps.codecs));
    } catch {
      this._canPreferCodecs = false; // fall back to munging the SDP
    }
  }

  _onConnState(rec, pc) {
    if (rec.pc !== pc) return;
    const s = pc.connectionState;
    this.log('pc-state', { peer: rec.id, state: s, gen: rec.gen });
    if (s === 'connected') {
      this._clearTimers(rec);
      rec.attempts = 0;
      rec.iceRestarted = false;
      this._setState(rec, 'connected');
      this.tuneSenders();
    } else if (s === 'disconnected') {
      this._setState(rec, 'reconnecting');
      this._arm(rec, DISCONNECTED_GRACE_MS, () => {
        if (rec.pc === pc && pc.connectionState !== 'connected') this._fail(rec, 'disconnected');
      });
    } else if (s === 'failed') {
      this._fail(rec, 'failed');
    } else if (s === 'closed' && !this.stopped && this.peers.get(rec.id) === rec) {
      this._fail(rec, 'closed');
    }
  }

  /** The recovery ladder: ICE restart first, then a rebuild with backoff (offerer only). */
  _fail(rec, why) {
    if (this.stopped || this.peers.get(rec.id) !== rec) return;
    if (rec.absent) return this._drop(rec, 'left');
    this._setState(rec, 'reconnecting');
    if (!rec.offerer) return this._askRestart(rec);
    const pc = rec.pc;
    if (pc && !rec.iceRestarted && pc.connectionState !== 'closed' && pc.signalingState !== 'closed') {
      rec.iceRestarted = true;
      this.log('ice-restart', { peer: rec.id, why, gen: rec.gen });
      this._offer(rec, { iceRestart: true }).catch(() => this._rebuild(rec, 'ice-restart-failed'));
      this._arm(rec, ICE_RESTART_TIMEOUT_MS, () => {
        if (rec.pc === pc && pc.connectionState !== 'connected') this._rebuild(rec, 'ice-restart-timeout');
      });
      return;
    }
    this._rebuild(rec, why);
  }

  _rebuild(rec, why) {
    if (this.stopped || this.peers.get(rec.id) !== rec) return;
    this._clearTimers(rec);
    this._closePc(rec);
    this._setState(rec, 'reconnecting');
    const delay = backoffMs(rec.attempts++);
    this.log('redial', { peer: rec.id, why, attempt: rec.attempts, inMs: delay });
    this._arm(rec, delay, () => this._build(rec, rec.gen + 1));
  }

  _askRestart(rec) {
    if (this.stopped || this.peers.get(rec.id) !== rec || rec.offerer) return;
    const askedAt = Date.now();
    this._signal(rec, { kind: 'restart' });
    // Ask again, backing off, only while no offer has answered the last ask — a connection the
    // offerer is already rebuilding must be given its chance (its own timeout covers it).
    this._arm(rec, Math.max(3000, backoffMs(rec.attempts++)), () => {
      if (rec.state !== 'connected' && !(rec.offerAt >= askedAt)) this._askRestart(rec);
    });
  }

  _drop(rec, reason) {
    if (this.peers.get(rec.id) !== rec) return;
    this._clearTimers(rec);
    clearTimeout(rec.waitTimer);
    this._closePc(rec);
    this.peers.delete(rec.id);
    this._setState(rec, 'left');
    this.cb.onPeerLeft?.(rec.id, reason);
    this.tuneSenders();
  }

  _closePc(rec) {
    if (rec.dc) {
      try {
        rec.dc.close();
      } catch {
        /* ignore */
      }
      rec.dc = null;
    }
    if (rec.pc) {
      const pc = rec.pc;
      rec.pc = null; // before close(): its 'closed' state change must not re-enter _fail
      try {
        pc.close();
      } catch {
        /* ignore */
      }
    }
  }

  _arm(rec, ms, fn) {
    const t = setTimeout(() => {
      rec.timers.delete(t);
      fn();
    }, ms);
    rec.timers.add(t);
  }

  _clearTimers(rec) {
    for (const t of rec.timers) clearTimeout(t);
    rec.timers.clear();
  }

  _setState(rec, state) {
    if (rec.state === state) return;
    rec.state = state;
    this.cb.onPeerState?.(rec.id, state);
  }

  _signal(rec, data) {
    this.session?.send(rec.id, { ...data, gen: rec.gen });
  }

  // ── data channel ────────────────────────────────────────────────────────────────────────

  _wireDc(rec, dc) {
    rec.dc = dc;
    dc.onopen = () => this.cb.onMessage?.(rec.id, { type: '__open' });
    dc.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg && msg.type === 'bye') return this._drop(rec, 'left');
      this.cb.onMessage?.(rec.id, msg);
    };
  }

  send(pid, msg) {
    const rec = this.peers.get(pid);
    if (rec && rec.dc && rec.dc.readyState === 'open') {
      rec.dc.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  broadcast(msg) {
    for (const pid of this.peers.keys()) this.send(pid, msg);
  }

  peerConnection(pid) {
    const rec = this.peers.get(pid);
    return rec ? rec.pc : null;
  }

  peerState(pid) {
    const rec = this.peers.get(pid);
    return rec ? rec.state : null;
  }

  // ── sending ─────────────────────────────────────────────────────────────────────────────

  /** Swap the outgoing video (setCamera). No renegotiation: replaceTrack on every sender. */
  async replaceTrack(kind, track, stream) {
    if (stream) this.localStream = stream;
    for (const rec of this.peers.values()) {
      if (!rec.pc) continue;
      for (const tr of rec.pc.getTransceivers()) {
        const k = tr.receiver && tr.receiver.track ? tr.receiver.track.kind : null;
        if (k === kind) await tr.sender.replaceTrack(track).catch(() => {});
      }
    }
    await this.tuneSenders();
  }

  setSendFormat(format) {
    this.sendFormat = format;
    return this.tuneSenders();
  }

  /**
   * Hold resolution, drop frame rate under pressure (a halved SBS width halves each eye), and
   * share the uplink across the mesh: `maxBitrate` falls as peers join.
   */
  async tuneSenders() {
    const n = this.peers.size;
    const kbps = maxBitrateKbps(this.sendFormat, n);
    for (const rec of this.peers.values()) {
      if (!rec.pc) continue;
      for (const s of rec.pc.getSenders()) {
        if (!s.track || s.track.kind !== 'video') continue;
        try {
          const p = s.getParameters();
          p.degradationPreference = 'maintain-resolution';
          if (!p.encodings || !p.encodings.length) p.encodings = [{}];
          p.encodings[0].maxBitrate = kbps * 1000;
          await s.setParameters(p);
        } catch (err) {
          this.log('setParameters-error', { peer: rec.id, err: String(err) });
        }
      }
    }
    return kbps;
  }

  // ── teardown ────────────────────────────────────────────────────────────────────────────

  stop() {
    if (this.stopped) return;
    this.broadcast({ type: 'bye' });
    this.stopped = true;
    for (const rec of this.peers.values()) {
      this._clearTimers(rec);
      clearTimeout(rec.waitTimer);
      this._signal(rec, { kind: 'bye' });
      this._closePc(rec);
    }
    this.peers.clear();
    try {
      this.session?.leave();
    } catch {
      /* ignore */
    }
  }

  /** Test/diagnostic hook: kill one pair's connection as a network failure would. */
  _debugKill(pid) {
    const rec = this.peers.get(pid);
    if (!rec || !rec.pc) return false;
    // close() fires no connectionstatechange, so walk the ladder by hand, exactly as 'failed' would.
    this._closePc(rec);
    this._fail(rec, 'debug-kill');
    return true;
  }
}

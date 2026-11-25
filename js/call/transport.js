// call/transport.js — the `Transport` seam and its P1 implementation, a WebRTC full mesh.
//
// A Transport moves media and small reliable messages between this page and up to N−1 others. The
// call module only ever talks to this interface, so an SFU adapter (RFC §2, P3) can replace the
// mesh without the module changing:
//
//   transport.start({ room, localStream, onPeer, onPeerLeft, onStream, onMessage, onPeerState })
//   transport.send(peerId, msg) / broadcast(msg)
//   transport.replaceTrack(kind, track, stream, { slot }) / setSendFormat(format)
//   transport.addContentTransceiver(peerId)   // the content track (3D app share), see below
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
// THE CONTENT TRACK (3D app share, docs/call.md § Sharing a 3D app): a SECOND video transceiver
// per pair, sendrecv, so either side can share into it. It exists only when BOTH hellos said
// `content: true` — the call module calls addContentTransceiver(pid) when the peer's hello says
// so (its own always does) — so an older peer is never offered a second video m-line and never
// gets a second camera sender. The offerer adds it (null track until someone shares) and
// renegotiates with a same-generation re-offer (the answerer's 'offer' case takes it on the same
// connection); a rebuild re-adds it in the first offer. It is identified as the SECOND video
// transceiver in getTransceivers() order on both ends: that order is m-line order (the offerer
// created them in that order; the answerer's are created from the offer's m-lines, and it never
// adds its own), and m-lines are never reordered or reused here — so both ends agree with no mid
// or msid bookkeeping. Sharing is then a replaceTrack on that sender only (no renegotiation), and
// its frames reach the far end's onContentStream, never the camera stream.
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
 * A peer known to exist (signalling presence) with no working connection for this long is
 * UNREACHABLE: almost always a network that needs a relay (TURN) — ICE sits in 'checking' or
 * fails on every attempt. The state is sticky until a connection comes up; the recovery ladder
 * keeps retrying underneath it the whole time.
 */
export const UNREACHABLE_MS = 10000;
/** The camera's share of its bitrate while this side shares content (tuneSenders). */
export const CAMERA_SHARE_FACTOR = 0.6;

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
  constructor({ signaling, id, maxPeers, iceServers, RTCPeerConnection: PC, log, unreachableMs } = {}) {
    this.unreachableMs = unreachableMs > 0 ? unreachableMs : UNREACHABLE_MS;
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
    // The content track this side shares (null = not sharing) and the stream it rides in.
    this.contentTrack = null;
    this.contentStream = null;
  }

  /** Remote peers currently in the mesh (not counting this one). */
  get size() {
    return this.peers.size;
  }

  async start({ room, localStream, sendFormat, contentTrack, contentStream, onPeer, onPeerLeft, onStream, onContentStream, onMessage, onPeerState, onRefused, onSignalingState, onGhost }) {
    this.localStream = localStream;
    this.sendFormat = sendFormat || 'mono';
    if (contentTrack !== undefined) this.contentTrack = contentTrack || null;
    if (contentStream !== undefined) this.contentStream = contentStream || null;
    this.cb = { onPeer, onPeerLeft, onStream, onContentStream, onMessage, onPeerState, onRefused, onSignalingState, onGhost };
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
      // A participant the signalling layer knows EXISTS but cannot even exchange signalling with
      // (the PeerJS adapter: a taken slot whose data connection never opens). No connection can be
      // attempted, so it is reported as a ghost the UI can show as unreachable.
      onPeerUnreachable: later((gid) => onGhost?.(gid, true)),
      onPeerReachable: later((gid) => onGhost?.(gid, false)),
      onReconnect: later((ids) => {
        onSignalingState?.('connected');
        for (const pid of ids) this._onPeerJoined(pid);
      }),
    });
    if (!this.pageIce && this.session.iceServers && this.session.iceServers.length) {
      // Relays from the signalling adapter (short-lived TURN from dxr-signal, or PeerJS's own), plus public STUN.
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
      // Content (3D app share): both hellos said `content` (contentCap), and the far end's
      // content track once it arrived, in its own stream.
      contentCap: false,
      contentStream: null,
      renegotiate: false,
      attempts: 0,
      iceRestarted: false,
      absent: false,
      pendingCandidates: [],
      timers: new Set(),
      waitTimer: null,
      unreachable: false,
      unreachTimer: null,
    };
    this.peers.set(pid, rec);
    this._armUnreachable(rec);
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
    rec.renegotiate = false;
    if (rec.contentStream) {
      rec.contentStream = null;
      this.cb.onContentStream?.(rec.id, null);
    }
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
      // A rebuild of a pair that already agreed on content offers its transceiver at once.
      if (rec.contentCap) this._addContent(rec, pc);
    }
    pc.onicecandidate = (e) => {
      if (e.candidate) this._signal(rec, { kind: 'candidate', candidate: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate });
    };
    pc.ontrack = (e) => {
      if (rec.pc !== pc) return;
      if (this._isContent(pc, e.transceiver, e.track)) {
        // The far end's content track: its own stream, never the camera's (no eviction).
        rec.contentStream = new MediaStream([e.track]);
        this.cb.onContentStream?.(rec.id, rec.contentStream);
        return;
      }
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
          if (rec.state === 'connected') this.tuneSenders(); // a re-offer may have added the content sender
          break;
        }
        case 'answer':
          if (!rec.offerer || gen !== rec.gen || !rec.pc || rec.pc.signalingState !== 'have-local-offer') return;
          await rec.pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
          this._flushCandidates(rec);
          if (rec.renegotiate) {
            // A content transceiver was added while this offer was out: offer again.
            rec.renegotiate = false;
            this._offer(rec).catch((err) => this.log('offer-error', { peer: rec.id, err: String(err) }));
          } else if (rec.state === 'connected') this.tuneSenders();
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

  /**
   * Answerer side: put our tracks on the transceivers the offer created, and make them sendrecv.
   * The content transceiver (the second video one) never gets the camera: it gets this side's
   * content track when it is sharing, else stays empty (but sendrecv, so it can share later).
   */
  _attachAnswererTracks(rec) {
    const pc = rec.pc;
    const tracks = this.localStream ? this.localStream.getTracks() : [];
    const content = this._contentTransceiver(pc);
    if (content) {
      if (this.contentTrack && content.sender.track !== this.contentTrack) {
        content.sender.replaceTrack(this.contentTrack).catch(() => {});
        if (this.contentStream && content.sender.setStreams) content.sender.setStreams(this.contentStream);
      }
      content.direction = 'sendrecv';
      this._preferCodecs(content);
    }
    for (const tr of pc.getTransceivers()) {
      if (tr === content) continue;
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

  // ── the content transceiver ─────────────────────────────────────────────────────────────

  /** The video transceivers of a connection, in getTransceivers() (= m-line) order. */
  _videoTransceivers(pc) {
    if (!pc || typeof pc.getTransceivers !== 'function') return [];
    return pc.getTransceivers().filter((tr) => tr && tr.receiver && tr.receiver.track && tr.receiver.track.kind === 'video');
  }

  /** The content transceiver: the SECOND video transceiver (see the header), or null. */
  _contentTransceiver(pc) {
    return this._videoTransceivers(pc)[1] || null;
  }

  /** Is this incoming track (ontrack) the far end's content track? */
  _isContent(pc, transceiver, track) {
    const ct = this._contentTransceiver(pc);
    if (!ct) return false;
    if (transceiver) return transceiver === ct;
    return !!(track && ct.receiver && ct.receiver.track === track);
  }

  _addContent(rec, pc) {
    if (this._contentTransceiver(pc)) return this._contentTransceiver(pc);
    const streams = this.contentStream ? [this.contentStream] : [];
    const tr = pc.addTransceiver(this.contentTrack || 'video', { direction: 'sendrecv', streams });
    this._preferCodecs(tr);
    return tr;
  }

  /**
   * Both hellos of this pair said `content`: give it the content transceiver. Offerer only (the
   * answerer gets it in the offer); idempotent. Renegotiates with a same-generation re-offer, or
   * after the offer in flight is answered. False when this side cannot (answerer, unknown peer).
   */
  addContentTransceiver(pid) {
    const rec = this.peers.get(pid);
    if (!rec || this.stopped) return false;
    rec.contentCap = true;
    if (!rec.offerer) return false;
    const pc = rec.pc;
    if (!pc) return true; // the next build adds it
    if (this._contentTransceiver(pc)) return true;
    this._addContent(rec, pc);
    this.log('content-transceiver', { peer: rec.id, gen: rec.gen });
    if (pc.signalingState === 'stable') this._offer(rec).catch((err) => this.log('offer-error', { peer: rec.id, err: String(err) }));
    else rec.renegotiate = true;
    return true;
  }

  /** Does this pair carry a content transceiver right now? */
  hasContent(pid) {
    const rec = this.peers.get(pid);
    return !!(rec && rec.pc && this._contentTransceiver(rec.pc));
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
    clearTimeout(rec.unreachTimer);
    clearTimeout(rec.waitTimer);
    this._closePc(rec);
    this.peers.delete(rec.id);
    if (rec.contentStream) {
      rec.contentStream = null;
      this.cb.onContentStream?.(rec.id, null);
    }
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

  /** Start the unreachable clock (idempotent); a connection clears it (see _setState). */
  _armUnreachable(rec) {
    if (rec.unreachTimer || rec.unreachable) return;
    rec.unreachTimer = setTimeout(() => {
      rec.unreachTimer = null;
      if (this.stopped || this.peers.get(rec.id) !== rec || rec.state === 'connected') return;
      rec.unreachable = true;
      this.log('unreachable', { peer: rec.id, afterMs: this.unreachableMs, pc: rec.pc ? rec.pc.iceConnectionState : null });
      this._setState(rec, 'unreachable');
    }, this.unreachableMs);
  }

  _setState(rec, state) {
    if (state === 'connected') {
      clearTimeout(rec.unreachTimer);
      rec.unreachTimer = null;
      rec.unreachable = false;
    } else if (state === 'connecting' || state === 'reconnecting') {
      // Sticky: retries continue underneath, but the page keeps being told the truth.
      if (rec.unreachable) state = 'unreachable';
      else this._armUnreachable(rec);
    }
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

  /** An already-serialised message (the app channel: sized before it is sent). */
  sendRaw(pid, json) {
    const rec = this.peers.get(pid);
    if (rec && rec.dc && rec.dc.readyState === 'open') {
      rec.dc.send(json);
      return true;
    }
    return false;
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

  /**
   * Swap an outgoing track. No renegotiation: replaceTrack on the senders of that slot.
   * `slot: 'camera'` (default — setCamera / setMic): every sender of that kind EXCEPT the content
   * one. `slot: 'content'` (shareContent / stopContent, video only): the content sender of every
   * pair that has one; `track: null` stops sharing. A pair that gets its content transceiver later
   * picks the current content track up then.
   */
  async replaceTrack(kind, track, stream, { slot = 'camera' } = {}) {
    if (slot === 'content') {
      this.contentTrack = track || null;
      this.contentStream = track ? stream || null : null;
    } else if (stream) this.localStream = stream;
    for (const rec of this.peers.values()) {
      if (!rec.pc) continue;
      const content = this._contentTransceiver(rec.pc);
      if (slot === 'content') {
        if (!content) continue;
        await content.sender.replaceTrack(track || null).catch(() => {});
        if (track && stream && content.sender.setStreams) content.sender.setStreams(stream);
        continue;
      }
      for (const tr of rec.pc.getTransceivers()) {
        if (tr === content) continue;
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
    const sharing = !!this.contentTrack;
    // While content is on, the camera yields: the shared app is what people look at.
    const kbps = Math.round(maxBitrateKbps(this.sendFormat, n) * (sharing ? CAMERA_SHARE_FACTOR : 1));
    const contentKbps = maxBitrateKbps('sbs', n);
    for (const rec of this.peers.values()) {
      if (!rec.pc) continue;
      const ct = this._contentTransceiver(rec.pc);
      for (const s of rec.pc.getSenders()) {
        if (!s.track || s.track.kind !== 'video') continue;
        const isContent = !!(ct && ct.sender === s);
        try {
          const p = s.getParameters();
          p.degradationPreference = 'maintain-resolution';
          if (!p.encodings || !p.encodings.length) p.encodings = [{}];
          p.encodings[0].maxBitrate = (isContent ? contentKbps : kbps) * 1000;
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
      clearTimeout(rec.unreachTimer);
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

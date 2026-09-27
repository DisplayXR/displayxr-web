// inline3d-call.js — a 3D video call in any page, in one call.
//
// PREVIEW tier. Not covered by the SDK's 1.x semver promise — see docs/sdk-stability.md.
// Implements P1 of docs/rfcs/0002-video-call.md.
//
//   import { createInline3D } from '@displayxr/inline3d';
//   import { addCall, dxrSignaling } from '@displayxr/inline3d/call';
//
//   const wall = await createInline3D();
//   const call = await addCall(wall, document.getElementById('call'), {
//     signaling: dxrSignaling(),            // hosted DisplayXR server; or dxrSignaling('wss://your.server')
//   });
//   call.on('peer', ({ id }) => console.log('joined', id));
//
// WHAT IT OWNS. Unlike the other modules this one takes a CONTAINER, not a canvas: a call has a
// variable number of participants, so it creates one persistent canvas per remote participant
// (plus the self view) inside `container`, lays them out, and draws its own chrome around them.
//
// ── RENDERING, AND WHY THE SBS PATH GOES THROUGH addImage ──────────────────────────────────────
//
// Each remote participant is ONE detached `<video srcObject>` (never in the DOM: an in-DOM video
// is a second candidate the browser's join fallback could weave instead of the canvas — P0) and
// ONE woven canvas. The route is RFC §3's table (call/wire.js routeFor):
//
//   sbs  on a woven wall   → woven, with a CONVERGENCE SHIFT
//   sbs  on a 2D wall      → the left eye, flat
//   mono on a woven wall   → LIFTED: one lift() stream per peer (`mono3D`, P2 — see below)
//   mono on a 2D wall      → flat
//
// The convergence shift is a per-eye horizontal CROP OFFSET, `f_px·baseline/(2·subjectZ)`, from
// the sender's `hello` + `hint`, low-passed. `wall.addVideo()` draws the whole video frame and
// `Inline3D._paint` refuses anything that is not a ready <video> on that path (its readyState
// gate), so the shifted pair is painted into an intermediate SBS canvas this module owns, and that
// canvas is handed to `wall.addImage(tileCanvas, convCanvas)` — which the core documents as "a
// canvas you own, repainted every frame". The SDK therefore still owns the tile's backing buffer
// (sizing, dpr, lazy lifecycle, mono fallback, tracking-loss easing); this module only decides
// what the pair IS. No core change. The intermediate canvas is cropped to the tile's aspect, so
// the woven buffer's per-eye aspect always equals the stage box — never `object-fit` a woven
// canvas (P0: it letterboxes the SBS quad).
//
// A tile registers with the wall ONCE per (peer, format): routing waits for both the stream to
// play and the `hello` (or its 2 s timeout), so hello and 'playing' arriving in either order never
// remove + re-add a layer (P0).
//
// TRACKING LOSS is the core's: with `createInline3D({ untrackedFallback: 'mono' })` every image
// window — these tiles included — eases to its left eye while nobody is tracked, exactly as the
// player's SBS path does. Nothing here asks for it.
//
// MONO→3D (P2, RFC §5): a mono peer on a woven wall is handed to `lift()`
// (`@displayxr/inline3d/lift`, loaded lazily — never a hard dependency; call/lift.js) with
// `{ mode: 'live', wall }`, so lift's canvas is one more window on the call's own wall and follows
// the same #172 rule as the SBS tiles: lift AT ONCE (in an all-mono call lift's window is the only
// layer, and the inline session does not tick until a layer exists — waiting for live frames
// would deadlock), then release + lift again ONCE when the weave session goes live.
// DEVIATION from the detached-<video> rule, for lifted tiles only: lift() floats its canvas over
// the ELEMENT's rect and (native provider) the browser converts that element in place, so a lifted
// tile's <video> is mounted inside its stage. lift hides it (`visibility:hidden`, the #168 guard)
// while its own canvas covers it on the web path; the browser weaves it itself on the native one.
// Leaving the lifted route detaches it again. Priority follows the active speaker (high) and
// visibility (paused), the depth slider drives lift's convergence, and at most `maxLifted`
// streams run at once.
//
// SESSION LOSS: a call must outlive a service restart. A layer that fails to build is retried
// with backoff (flat in between); a session that ENDS without the page closing the wall is
// replaced with a fresh `createInline3D()` and every tile re-registers on it — no reload. To tell
// the two apart the module wraps `wall.close` for the call's lifetime (a page close runs the
// SDK's teardown synchronously, so no listener can distinguish them afterwards); `leave()`
// restores it.

import { createInline3D } from './inline3d.js';
import {
  WIRE_VERSION,
  CALL_SDK,
  DEFAULT_MAX_PEERS,
  HINT_MAX_HZ,
  newRoomId,
  newPeerId,
  isValidRoomId,
  parseInviteLink,
  buildInviteLink,
  normalizeHello,
  makeHello,
  normalizeHint,
  normalizeState,
  rateGate,
  routeFor,
  badgeFor,
  createConvergence,
  eyeCropRect,
  eyeOutputSize,
  mirrorSwapOps,
  backoffMs,
  createLiveGate,
} from './call/wire.js';
import { MeshTransport, clampMaxPeers } from './call/transport.js';
import { openCamera, openMic } from './call/capture.js';
import { drawQr } from './call/qr.js';
import { injectCallStyle, ICONS, el, show, resolveCallAccent, CALL_ACCENTS } from './call/ui.js';
import { normalizeMono3D, resolveLift, createLiftPool, createFrameWatch } from './call/lift.js';

import { dxrSignaling } from './call/signaling.js';
export { dxrSignaling, peerjsCloud, SIGNAL_PROTOCOL, roomKey, DXR_SIGNAL_DEFAULT } from './call/signaling.js';
export {
  WIRE_VERSION,
  CALL_SDK,
  newRoomId,
  isValidRoomId,
  parseInviteLink,
  buildInviteLink,
  normalizeHello,
  makeHello,
  routeFor,
  badgeFor,
  CALL_ACCENTS,
};
export { createLiveGate } from './call/wire.js';
export { convergenceShiftPx, lowPass, clampShift, eyeCropRect, mirrorSwapOps, mirrorSwapPixels, maxBitrateKbps } from './call/wire.js';
export { preferVideoCodecs, sortCodecCapabilities, VIDEO_CODEC_ORDER } from './call/sdp.js';
export { MeshTransport, clampMaxPeers } from './call/transport.js';
export { qrEncode } from './call/qr.js';
export {
  normalizeMono3D,
  resolveLift,
  createLiftPool,
  createFrameWatch,
  liftConvergenceFor,
  liftPriorityFor,
  setLiftPriority,
  defaultLiftSpecifier,
  LIFT_PRIORITY,
} from './call/lift.js';

const TAG = '[inline3d/call]';
const HELLO_WAIT_MS = 2000;
const LEFT_TILE_MS = 2500;
const STATS_TICK_MS = 500;
const SPEAKING_LEVEL = 0.02;
const LAYER_RETRIES = 4;
const LIFT_RETRIES = 2;
const DEFAULT_BROWSER_URL = 'https://github.com/DisplayXR/displayxr-browser';
export const PLATE_TEXT = Object.freeze({
  unreachable: "Can't reach this participant — the network needs a relay (TURN)",
  cameraBusy: 'Camera busy — in use by another app (e.g. eye tracking)',
});

/**
 * Apply defaults and validate. Pure (no DOM, no network) — see test/call.test.mjs.
 * @param {object} [opts]
 */
export function normalizeCallOptions(opts = {}) {
  const ui = opts.ui === undefined ? true : !!opts.ui;
  const aspect = typeof opts.tileAspect === 'number' && opts.tileAspect > 0.3 && opts.tileAspect < 4 ? opts.tileAspect : 16 / 9;
  let room = opts.room === undefined || opts.room === null ? 'auto' : opts.room;
  if (room !== 'auto' && !isValidRoomId(room)) {
    const fromLink = parseInviteLink(room);
    if (!fromLink) throw new Error(`@displayxr/inline3d/call: room "${room}" is not a valid room id (16-64 base64url chars) or invite link`);
    room = fromLink;
  }
  return {
    room,
    // Default: the hosted DisplayXR signalling server (which also mints TURN credentials).
    signaling: opts.signaling || dxrSignaling(),
    iceServers: Array.isArray(opts.iceServers) ? opts.iceServers : undefined,
    camera: opts.camera === undefined ? 'auto' : opts.camera,
    format: opts.format === 'sbs' ? 'sbs' : opts.format === 'mono' ? 'mono' : undefined,
    calibration: opts.calibration && typeof opts.calibration === 'object' ? { ...opts.calibration } : {},
    rectify: typeof opts.rectify === 'function' ? opts.rectify : null,
    audio: opts.audio === undefined ? true : !!opts.audio,
    mono3D: normalizeMono3D(opts.mono3D),
    maxPeers: clampMaxPeers(opts.maxPeers === undefined ? DEFAULT_MAX_PEERS : opts.maxPeers),
    // Extra lift() options for lifted tiles (models, ort, quality, providers). The call's own
    // keys (mode, wall, ui, convergence, priority) always win.
    liftOptions: opts.liftOptions && typeof opts.liftOptions === 'object' ? { ...opts.liftOptions } : null,
    // Concurrent lifted tiles. Default = maxPeers (4): every mono peer can be lifted.
    maxLifted: Number.isFinite(+opts.maxLifted) && opts.maxLifted !== null ? Math.max(0, Math.min(DEFAULT_MAX_PEERS, Math.floor(+opts.maxLifted))) : DEFAULT_MAX_PEERS,
    layout: opts.layout === 'speaker' ? 'speaker' : 'grid',
    ui,
    autoJoin: opts.autoJoin === undefined ? !ui : !!opts.autoJoin,
    selfView: opts.selfView === undefined ? true : !!opts.selfView,
    tileAspect: aspect,
    accent: typeof opts.accent === 'string' && opts.accent ? resolveCallAccent(opts.accent) : null,
    inviteBase: typeof opts.inviteBase === 'string' ? opts.inviteBase : null,
    updateUrl: opts.updateUrl === undefined ? ui : !!opts.updateUrl,
    browserUrl: typeof opts.browserUrl === 'string' ? opts.browserUrl : DEFAULT_BROWSER_URL,
    recoverSession: opts.recoverSession === undefined ? true : !!opts.recoverSession,
    scrollIntoView: opts.scrollIntoView === undefined ? true : !!opts.scrollIntoView,
    wallOptions: opts.wallOptions && typeof opts.wallOptions === 'object' ? opts.wallOptions : {},
    log: typeof opts.log === 'function' ? opts.log : opts.debug ? (tag, obj) => console.log(`${TAG} ${tag} ${JSON.stringify(obj)}`) : null,
  };
}

/**
 * Put a 3D video call in `container`. Resolves once the camera is open and (with `ui:true`) the
 * lobby is showing; with `ui:false` (or `autoJoin:true`) once the call is joined.
 *
 * @param {any} wall  a `createInline3D()` result (may be `{supported:false}`) or null
 * @param {HTMLElement} container
 * @param {object} opts  see call.d.ts
 */
export async function addCall(wall, container, opts = {}) {
  if (!container || typeof container.appendChild !== 'function') throw new TypeError('@displayxr/inline3d/call: addCall(wall, container, opts) needs a container element');
  const o = normalizeCallOptions(opts);
  if (!o.signaling || typeof o.signaling.join !== 'function') {
    throw new TypeError('@displayxr/inline3d/call: opts.signaling must be a SignalingAdapter — dxrSignaling([url]), peerjsCloud() (demo only), or your own');
  }
  const call = new Call(wall, container, o);
  await call._init();
  return call.handle;
}

class Call {
  constructor(wall, container, o) {
    this.o = o;
    this.container = container;
    this.wall = wall || null;
    this.wallLive = !!(wall && wall.supported);
    this.weaveLive = false; // see createLiveGate / #172: no woven registration before this
    this.camStatus = 'pending'; // 'ok' | 'busy' | 'none' | 'pending'
    this.id = newPeerId();
    this.room = o.room === 'auto' ? parseInviteLink(globalThis.location) : o.room;
    this.state = 'idle'; // idle | lobby | joining | in-call | full | left
    this.tiles = new Map();
    this.listeners = new Map();
    this.local = null; // { stream, video, audio, format, width, height, calibration, owned, label }
    this.muted = false;
    this.camOff = false;
    this.depth = 0;
    this.speakerId = null;
    this.transport = null;
    this._raf = 0;
    this._statsTimer = 0;
    this._hintGate = rateGate(HINT_MAX_HZ);
    // mono→3D (call/lift.js): the option, whether it is on right now (setMono3D), the resolved
    // lift (null until resolved), the pool of lifted streams, and the web-provider frame watch.
    this.mono3D = o.mono3D;
    this.mono3DOn = o.mono3D !== 'off';
    this.liftApi = null;
    this.liftPool = null;
    this._liftP = null;
    this.liftProven = false;
    this._frameWatch = createFrameWatch();
    this.handle = this._makeHandle();
    if (this.wallLive) this._hookWall(this.wall);
  }

  get woven() {
    // NOT gated on weaveLive: the inline session does not tick until a layer exists, so waiting
    // for live frames before the first registration deadlocks (seen on a real panel). Tiles
    // register at once; _watchLive re-registers them once when the session goes live (#172).
    return !!(this.wall && this.wall.supported && this.wallLive);
  }

  log(tag, obj = {}) {
    if (this.o.log) this.o.log(tag, obj);
  }

  emit(type, payload) {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const cb of [...set]) {
      try {
        cb(payload);
      } catch (err) {
        console.error(`${TAG} '${type}' listener threw`, err);
      }
    }
  }

  error(code, message, err) {
    this.log('error', { code, message });
    if (!this.listeners.get('error')?.size) console.warn(`${TAG} ${code}: ${message}`);
    this.emit('error', { code, message, error: err || null });
  }

  // ── setup ────────────────────────────────────────────────────────────────────────────────

  async _init() {
    this._buildDom();
    // The lobby's pre-call hint wants to know what a mono peer will look like; nothing to lift on
    // a 2D wall (mono peers are flat there by the table).
    if (this.wallLive) this._ensureLift();
    await this._openMedia(this.o.camera);
    this._startLoop();
    if (this.o.autoJoin) await this.join();
    else this._setState('lobby');
  }

  async _openMedia(want, format, { keepOnFail = false } = {}) {
    const log = (t, x) => this.log(t, x);
    let cam = null;
    let camError = null;
    try {
      cam = await openCamera(want, { format: format || this.o.format, calibration: this.o.calibration, log });
    } catch (err) {
      camError = err;
      // No camera is never fatal: the call goes on audio-only, the self view and every receiver
      // say why, and the user can retry (the tracker may let go) or pick another camera.
      const busy = err.code === 'camera-busy';
      this.error(busy ? 'camera-busy' : err.code || 'no-camera', busy ? `${PLATE_TEXT.cameraBusy}. Joining audio-only.` : `no camera: ${err.message}. Joining audio-only.`, err);
      if (keepOnFail && this.local && this.local.videoTrack) return this.local; // keep the working one
      this.camStatus = busy ? 'busy' : 'none';
    }
    if (cam) this.camStatus = 'ok';
    if (cam && cam.format === 'sbs' && this.o.rectify) {
      // P2 seam: a calibrated rectification step (plug-in or runtime supplied). Its output is a
      // rectified SBS stream; the hello then says so.
      try {
        const out = await this.o.rectify(cam.stream, { width: cam.width, height: cam.height, deviceId: cam.deviceId, label: cam.label });
        if (out && typeof out.getVideoTracks === 'function') {
          cam.stream = out;
          cam.calibration = { ...cam.calibration, rectified: true };
        }
      } catch (err) {
        this.error('rectify-failed', `rectify() threw — sending the raw pair: ${err.message}`, err);
      }
    }
    let audioTrack = this.local ? this.local.audioTrack : null;
    if (this.o.audio && !audioTrack) audioTrack = await openMic({ log });
    if (audioTrack) audioTrack.enabled = !this.muted;
    const videoTrack = cam ? cam.stream.getVideoTracks()[0] || null : null;
    if (videoTrack) {
      // Resolution over frame rate: halving an SBS frame's width halves each eye (RFC §2).
      try {
        videoTrack.contentHint = 'detail';
      } catch {
        /* older engines */
      }
      videoTrack.enabled = !this.camOff;
    }
    const stream = new MediaStream([videoTrack, audioTrack].filter(Boolean));
    const video = this.local?.video || Object.assign(document.createElement('video'), { muted: true, playsInline: true, autoplay: true });
    video.srcObject = cam ? cam.stream : null;
    video.play().catch(() => {});
    const prev = this.local;
    this.local = {
      stream,
      camStream: cam ? cam.stream : null,
      video,
      videoTrack,
      audioTrack,
      format: cam ? cam.format : 'mono',
      width: cam ? cam.width : 0,
      height: cam ? cam.height : 0,
      calibration: cam ? cam.calibration : {},
      owned: cam ? cam.owned : false,
      label: cam ? cam.label : '',
      // Kept on the error path too: which cameras were held, and why, is the one clue a
      // 'camera-busy' / 'no-camera' report carries.
      skipped: cam ? cam.skipped : camError?.skipped || [],
    };
    this.log('camera', { format: this.local.format, width: this.local.width, height: this.local.height, label: this.local.label, skipped: this.local.skipped.length });
    if (prev && prev.owned && prev.camStream && prev.camStream !== this.local.camStream) prev.camStream.getVideoTracks().forEach((t) => t.stop());
    this._refreshSelf();
    this._refreshLobby();
    return this.local;
  }

  hello() {
    const l = this.local || {};
    return makeHello({
      format: l.format,
      width: l.width,
      height: l.height,
      baselineMm: l.calibration?.baselineMm,
      hfovDeg: l.calibration?.hfovDeg,
      rectified: !!l.calibration?.rectified,
    });
  }

  stateMsg() {
    // An audio-only participant (busy / no camera) reads as camera-off: receivers show a plate,
    // never a black or 0x0 tile.
    return { type: 'state', muted: this.muted, cameraOff: this.camOff || !this.local?.videoTrack, speaking: !!this._selfSpeaking };
  }

  // ── joining ──────────────────────────────────────────────────────────────────────────────

  async join() {
    if (this.state === 'joining' || this.state === 'in-call') return this.handle;
    if (this.state === 'left' && !this.local?.videoTrack) await this._openMedia(this.o.camera);
    if (!this.room) {
      this.room = newRoomId();
      this.log('room-created', {});
    }
    if (this.o.updateUrl && globalThis.history && globalThis.location) {
      try {
        history.replaceState(history.state, '', buildInviteLink(location.href, this.room));
      } catch {
        /* sandboxed iframe */
      }
    }
    this._setState('joining');
    const t = new MeshTransport({
      signaling: this.o.signaling,
      id: this.id,
      maxPeers: this.o.maxPeers,
      iceServers: this.o.iceServers,
      log: (tag, obj) => this.log(tag, obj),
    });
    this.transport = t;
    try {
      await t.start({
        room: this.room,
        localStream: this.local.stream,
        sendFormat: this.local.format,
        onPeer: (id) => this._onPeer(id),
        onPeerLeft: (id, reason) => this._onPeerLeft(id, reason),
        onStream: (id, stream) => this.tiles.get(id)?.setStream(stream),
        onMessage: (id, msg) => this._onMessage(id, msg),
        onPeerState: (id, st) => {
          this.tiles.get(id)?.setConn(st);
          this.emit('state', { id, state: st });
        },
        onRefused: (id) => this.log('refused-peer', { id }),
        onGhost: (gid, on) => this._onGhost(gid, on),
        onSignalingState: (st, err) => {
          this.log('signaling', { state: st });
          if (st === 'closed' && err) this.error(err.code || 'signaling-closed', err.message, err);
        },
      });
    } catch (err) {
      this.transport = null;
      if (err && err.code === 'room-full') {
        this._setState('full');
        this.error('room-full', err.message, err);
      } else {
        this._setState('lobby');
        this.error(err.code || 'join-failed', `could not join: ${err.message}`, err);
      }
      throw err;
    }
    this._setState('in-call');
    // The grid is sized so the whole call block fits ONE viewport, but only if it starts at the
    // top: a tile below the fold is withheld from the weave (browser#167), so its layer goes
    // live late. Bring the block into view once, on join.
    if (this.o.ui && this.o.scrollIntoView) {
      try {
        this.container.scrollIntoView?.({ block: 'start', behavior: 'instant' });
        this._fitGrid();
      } catch {
        /* ignore */
      }
    }
    this._startStats();
    this._pagehide = () => this.leave();
    globalThis.addEventListener?.('pagehide', this._pagehide);
    this.log('joined', { id: this.id, peers: this.tiles.size });
    this.emit('joined', { room: this.room, id: this.id });
    return this.handle;
  }

  _onPeer(id) {
    if (this.tiles.has(id)) return;
    const tile = new Tile(this, id);
    this.tiles.set(id, tile);
    this._layout();
    this.emit('peer', { id });
  }

  /**
   * A participant the signalling layer knows exists but cannot reach at all (no id to connect to
   * yet — see peerjsCloud). Shown as a tile in the 'unreachable' state so the page never claims
   * you are alone; removed when the adapter reaches it (or finds the slot free).
   */
  _onGhost(gid, on) {
    const t = this.tiles.get(gid);
    if (on && !t) {
      const tile = new Tile(this, gid);
      tile.ghost = true;
      this.tiles.set(gid, tile);
      tile.setConn('unreachable');
      this._layout();
    } else if (!on && t && t.ghost) {
      t.destroy();
      this.tiles.delete(gid);
      this._layout();
    }
  }

  _onPeerLeft(id, reason) {
    const tile = this.tiles.get(id);
    if (!tile) return;
    tile.setConn('left');
    this.emit('peerleft', { id, reason });
    tile.leaveTimer = setTimeout(() => {
      tile.destroy();
      if (this.tiles.get(id) === tile) this.tiles.delete(id);
      if (this.speakerId === id) this._setSpeaker(null);
      this._layout();
    }, LEFT_TILE_MS);
  }

  _onMessage(id, msg) {
    const tile = this.tiles.get(id);
    if (!tile || !msg) return;
    if (msg.type === '__open') {
      this.transport.send(id, this.hello());
      this.transport.send(id, this.stateMsg());
      tile.onChannelOpen();
      return;
    }
    const h = normalizeHello(msg);
    if (h) return tile.setHello(h);
    const hint = normalizeHint(msg);
    if (hint) return tile.setHint(hint);
    const st = normalizeState(msg);
    if (st) return tile.setRemoteState(st);
  }

  // ── handle ops ─────────────────────────────────────────────────────────────────────────

  inviteLink() {
    if (!this.room) return null;
    const base = this.o.inviteBase || (globalThis.location ? location.href : '');
    return buildInviteLink(base, this.room);
  }

  mute(on) {
    this.muted = on === undefined ? !this.muted : !!on;
    if (this.local?.audioTrack) this.local.audioTrack.enabled = !this.muted;
    this.transport?.broadcast(this.stateMsg());
    this._refreshBar();
    this.log('mute', { muted: this.muted });
    return this.muted;
  }

  cameraOff(on) {
    this.camOff = on === undefined ? !this.camOff : !!on;
    if (this.local?.videoTrack) this.local.videoTrack.enabled = !this.camOff;
    this.transport?.broadcast(this.stateMsg());
    this._refreshBar();
    this._refreshSelf();
    return this.camOff;
  }

  setDepth(v) {
    const n = v === null || v === undefined || !Number.isFinite(+v) ? 0 : Math.max(-1, Math.min(1, +v));
    this.depth = n;
    for (const t of this.tiles.values()) t.conv.depth = n;
    this.liftPool?.setDepth(n); // the same control is lift's convergence on lifted tiles
    if (this.ui?.depth && +this.ui.depth.value !== n) this.ui.depth.value = String(n);
    return n;
  }

  async setCamera(idOrStream, { format } = {}) {
    const before = this.local?.format;
    const l = await this._openMedia(idOrStream, format, { keepOnFail: true });
    if (this.transport) {
      await this.transport.replaceTrack('video', l.videoTrack, l.stream);
      await this.transport.setSendFormat(l.format);
      this.transport.broadcast(this.hello());
      this.transport.broadcast(this.stateMsg());
    }
    if (before !== l.format) this.log('send-format', { format: l.format });
    return { format: l.format, width: l.width, height: l.height, label: l.label };
  }

  /** Try the configured camera again (e.g. after the eye tracker released it). */
  retryCamera() {
    return this.setCamera(this.o.camera, { format: this.o.format });
  }

  sendHint(subjectZmm) {
    if (!this._hintGate(performance.now())) return false;
    const h = normalizeHint({ type: 'hint', subjectZmm });
    if (!h) return false;
    this.transport?.broadcast(h);
    return true;
  }

  leave() {
    if (this.state === 'left') return;
    globalThis.removeEventListener?.('pagehide', this._pagehide);
    this.transport?.stop();
    this.transport = null;
    for (const t of this.tiles.values()) t.destroy();
    this.tiles.clear();
    this.liftPool?.releaseAll();
    clearInterval(this._statsTimer);
    this._setSpeaker(null);
    if (this.local) {
      this.local.stream.getTracks().forEach((t) => t.stop());
      if (this.local.owned && this.local.camStream) this.local.camStream.getTracks().forEach((t) => t.stop());
      this.local.videoTrack = null;
      this.local.audioTrack = null;
    }
    if (this.self) {
      this.self.unregister();
      this.self.route = null; // a rejoin re-registers it
    }
    this._unhookWall();
    this._setState('left');
    this._layout();
    this.emit('left', { room: this.room });
  }

  // ── the wall: session loss and recovery ───────────────────────────────────────────────

  _hookWall(w) {
    if (!w || !w.session || typeof w.session.addEventListener !== 'function') return;
    const orig = w.close;
    this._wallHook = { w, orig, pageClosed: false };
    const hook = this._wallHook;
    w.close = (...a) => {
      hook.pageClosed = true;
      return orig.apply(w, a);
    };
    hook.onEnd = () => this._sessionEnded(hook);
    w.session.addEventListener('end', hook.onEnd);
    this._watchLive(w);
  }

  /**
   * displayxr-browser-pvt#172: a woven layer registered BEFORE the weave session is live can be
   * fed the whole SBS frame per eye (L|R|L|R, flat) until it is re-created. Tiles register
   * immediately (the session only starts ticking once a layer exists — gating the first
   * registration on live frames deadlocks), and when the first run of live stereo frames lands,
   * every woven tile registered before it is re-created ONCE. Uses the session's own frames, read
   * through the frozen `wall.session` / `wall.refSpace` fields — no core change.
   */
  _watchLive(w) {
    this.weaveLive = false;
    const session = w.session;
    if (!session || typeof session.requestAnimationFrame !== 'function') {
      this.weaveLive = true; // nothing to wait on
      return;
    }
    const gate = createLiveGate();
    const t0 = performance.now();
    const onFrame = (_t, f) => {
      if (w !== this.wall || !this.wallLive || this.state === 'left') return;
      let n = null;
      if (w.refSpace) {
        try {
          const pose = f.getViewerPose(w.refSpace);
          n = pose && pose.views ? pose.views.length : 0;
        } catch {
          n = 0;
        }
      }
      if (!gate.feed(n)) {
        try {
          session.requestAnimationFrame(onFrame);
        } catch {
          /* session ending: _sessionEnded handles it */
        }
        return;
      }
      this.weaveLive = true;
      this.log('weave-live', { ms: Math.round(performance.now() - t0) });
      // Re-create only what was woven before the session was live (#172); flat tiles are untouched.
      // A lifted tile is a woven window too (lift's addScene canvas): release + lift again.
      for (const t of this.tiles.values()) if (t.route === 'woven-sbs' || t.route === 'lifted') t.reroute(true);
      if (this.self && this.self.route === 'woven-sbs') this.self.reroute(true);
      this._layout();
    };
    try {
      session.requestAnimationFrame(onFrame);
    } catch {
      this.weaveLive = true;
    }
  }

  _unhookWall() {
    const h = this._wallHook;
    if (!h) return;
    this._wallHook = null;
    if (h.w.close !== h.orig) h.w.close = h.orig;
    try {
      h.w.session.removeEventListener('end', h.onEnd);
    } catch {
      /* ignore */
    }
  }

  _sessionEnded(hook) {
    if (this._wallHook !== hook) return;
    this.wallLive = false;
    this.weaveLive = false;
    this.log('session-ended', { byPage: hook.pageClosed });
    for (const t of this.tiles.values()) t.onWallLost();
    this.self?.onWallLost();
    if (hook.pageClosed || !this.o.recoverSession || this.state === 'left') {
      this._unhookWall();
      return;
    }
    this.error('session-ended', 'the inline-3D session ended; tiles are flat while it is re-opened');
    this._unhookWall();
    this._recoverWall(0);
  }

  _recoverWall(attempt) {
    if (this.state === 'left' || attempt > 10) return;
    setTimeout(async () => {
      if (this.state === 'left') return;
      let w = null;
      try {
        w = await createInline3D(this.o.wallOptions);
      } catch {
        w = null;
      }
      if (!w || !w.supported) return this._recoverWall(attempt + 1);
      this.wall = w;
      this.wallLive = true;
      this._hookWall(w);
      this.log('session-recovered', { attempt });
      for (const t of this.tiles.values()) t.reroute(true);
      this.self?.reroute(true);
      this.emit('session', { wall: w });
    }, backoffMs(attempt, { baseMs: 1000, maxMs: 15000 }));
  }

  // ── paint loop + stats ─────────────────────────────────────────────────────────────────

  _startLoop() {
    let last = 0;
    const tick = (now) => {
      this._raf = requestAnimationFrame(tick);
      this.self?.paint();
      for (const t of this.tiles.values()) t.paint();
      if (last && this.liftPool && this.liftPool.anyWeb) this._watchFrames(now - last);
      last = now;
    };
    this._raf = requestAnimationFrame(tick);
  }

  /**
   * Budget: lifted tiles on the WEB provider run in this page's frame budget. When frames degrade
   * (~< 20 fps for 3 s) say so once — a log line and a `quality` event with `lift` — so the page
   * can drop to fewer lifts or call `setMono3D(false)`. The native provider runs in the service.
   */
  _watchFrames(dt) {
    const ev = this._frameWatch.feed(dt);
    if (!ev) return;
    const detail = { degraded: ev === 'degraded', frameMs: Math.round(this._frameWatch.frameMs * 10) / 10, tiles: this.liftPool.size };
    this.log('lift-frame-time', detail);
    if (ev === 'degraded') console.warn(`${TAG} lifted tiles are slowing the page (~${Math.round(1000 / detail.frameMs)} fps with ${detail.tiles} lifted) — setMono3D(false) shows mono peers flat`);
    this.emit('quality', { id: null, in: null, out: null, lift: detail });
  }

  // ── mono→3D ────────────────────────────────────────────────────────────────────────────

  /** Resolve `mono3D` to a lift function once (lazily); reroute the mono tiles when it lands. */
  _ensureLift() {
    if (!this.mono3DOn) return Promise.resolve(null);
    if (!this._liftP) {
      const log = (t, x) => this.log(t, x);
      const lo = this.o.liftOptions;
      // liftCapabilities probes the same model source the lifts will use.
      const capsOpts = { webFallback: true, ...(lo && lo.models ? { models: lo.models } : {}) };
      this._liftP = resolveLift(this.mono3D, { log, capsOpts }).then((r) => {
        this.liftApi = r;
        if (r.lift) {
          this.liftPool = createLiftPool({ lift: r.lift, max: this.o.maxLifted, log, options: this.o.liftOptions });
          this.liftPool.setDepth(this.depth);
          this.liftPool.setSpeaker(this.speakerId);
          if (!r.caps && r.capabilities) {
            Promise.resolve()
              .then(() => r.capabilities(capsOpts))
              .then((c) => {
                r.caps = c || null;
                this._refreshLobby();
              })
              .catch(() => {});
          }
        } else if (r.reason !== 'off') {
          console.info(`${TAG} mono→3D unavailable (${r.reason}) — mono participants are shown flat`);
        }
        this._rerouteMono();
        this._refreshLobby();
        return r;
      });
    }
    return this._liftP;
  }

  /** Re-run the routing table for every mono tile (lift resolved, a slot freed, setMono3D). */
  _rerouteMono() {
    for (const t of this.tiles.values()) if (t.format && t.format !== 'sbs') t.reroute(false);
  }

  setMono3D(on) {
    const want = on === undefined ? !this.mono3DOn : !!on;
    if (want === this.mono3DOn) return want;
    this.mono3DOn = want;
    if (want && this.mono3D === 'off') this.mono3D = 'auto';
    this._frameWatch.reset();
    this.log('mono3d', { on: want });
    this._rerouteMono(); // off: every lift is released, the tiles go flat
    if (want && this.wallLive) this._ensureLift();
    this._refreshLobby();
    return want;
  }

  /** What the lobby says a mono participant will look like here. */
  _liftHint() {
    if (!this.wallLive) return '';
    if (!this.mono3DOn) return 'Mono cameras: 2D (2D→3D is off).';
    const r = this.liftApi;
    if (!r) return 'Mono cameras: checking 2D→3D…';
    if (!r.lift) return 'Mono cameras: 2D (no 2D→3D provider here).';
    const c = r.caps;
    if (c && c.native) return `Mono cameras: 2D→3D (native${c.provider ? `, ${c.provider}` : ''}).`;
    if (c && c.webFallback && c.webFallback.webgpu) return 'Mono cameras: 2D→3D (in this page, WebGPU).';
    return this.liftProven ? 'Mono cameras: 2D→3D.' : 'Mono cameras: 2D→3D (confirmed on the first mono participant).';
  }

  _mono3DInfo() {
    const r = this.liftApi;
    const c = r && r.caps;
    return Object.freeze({
      on: this.mono3DOn,
      state: !this.mono3DOn ? 'off' : !r ? (this._liftP ? 'loading' : 'idle') : r.lift ? 'ready' : 'unavailable',
      reason: r ? r.reason : null,
      native: c ? !!c.native : null,
      provider: (c && c.provider) || null,
      lifted: this.liftPool ? this.liftPool.size : 0,
      max: this.o.maxLifted,
      proven: this.liftProven,
    });
  }

  _startStats() {
    clearInterval(this._statsTimer);
    let n = 0;
    this._statsTimer = setInterval(() => this._stats(++n % 4 === 0), STATS_TICK_MS);
  }

  async _stats(withQuality) {
    if (!this.transport) return;
    let best = null;
    let localLevel = 0;
    for (const [id, tile] of this.tiles) {
      const pc = this.transport.peerConnection(id);
      if (!pc) continue;
      let report;
      try {
        report = await pc.getStats();
      } catch {
        continue;
      }
      const codecs = {};
      report.forEach((s) => {
        if (s.type === 'codec') codecs[s.id] = s.mimeType;
      });
      const q = { in: null, out: null };
      report.forEach((s) => {
        if (s.type === 'inbound-rtp' && s.kind === 'audio' && typeof s.audioLevel === 'number') tile.level = Math.max(s.audioLevel, (tile.level || 0) * 0.6);
        if (s.type === 'media-source' && s.kind === 'audio' && typeof s.audioLevel === 'number') localLevel = Math.max(localLevel, s.audioLevel);
        if (!withQuality) return;
        if (s.type === 'inbound-rtp' && s.kind === 'video') {
          const prev = tile._prevIn;
          q.in = {
            width: s.frameWidth || 0,
            height: s.frameHeight || 0,
            fps: s.framesPerSecond || 0,
            codec: codecs[s.codecId] || null,
            kbps: prev ? Math.round(((s.bytesReceived - prev.bytes) * 8) / (s.timestamp - prev.t)) : null,
            dropped: s.framesDropped || 0,
            decoder: s.decoderImplementation || null,
          };
          tile._prevIn = { bytes: s.bytesReceived, t: s.timestamp };
        } else if (s.type === 'outbound-rtp' && s.kind === 'video') {
          const prev = tile._prevOut;
          q.out = {
            width: s.frameWidth || 0,
            height: s.frameHeight || 0,
            fps: s.framesPerSecond || 0,
            codec: codecs[s.codecId] || null,
            kbps: prev ? Math.round(((s.bytesSent - prev.bytes) * 8) / (s.timestamp - prev.t)) : null,
            limitation: s.qualityLimitationReason || null,
            encoder: s.encoderImplementation || null,
          };
          tile._prevOut = { bytes: s.bytesSent, t: s.timestamp };
        }
      });
      if (withQuality && (q.in || q.out)) {
        tile.quality = q;
        this.emit('quality', { id, ...q });
      }
      const lvl = tile.remote.muted ? 0 : tile.level || 0;
      tile.setSpeaking(lvl > SPEAKING_LEVEL || tile.remote.speaking);
      if (lvl > SPEAKING_LEVEL && (!best || lvl > best.lvl)) best = { id, lvl };
    }
    // Active speaker with hysteresis: a challenger must lead two ticks running.
    const cand = best ? best.id : null;
    if (cand && cand !== this.speakerId) {
      this._challengeTicks = this._challenger === cand ? (this._challengeTicks || 0) + 1 : 1;
      this._challenger = cand;
      if (this._challengeTicks >= 2) this._setSpeaker(cand);
    } else {
      this._challenger = null;
      this._challengeTicks = 0;
    }
    const speaking = !this.muted && localLevel > SPEAKING_LEVEL;
    if (speaking !== !!this._selfSpeaking) {
      this._selfSpeaking = speaking;
      this.transport?.broadcast(this.stateMsg());
      this.self?.setSpeaking(speaking);
    }
  }

  _setSpeaker(id) {
    if (id === this.speakerId) return;
    this.speakerId = id;
    this._challengeTicks = 0;
    this.liftPool?.setSpeaker(id); // the active speaker's lifted stream is converted every round
    this.emit('speaker', { id });
    if (this.o.layout === 'speaker') this._layout();
  }

  // ── chrome ─────────────────────────────────────────────────────────────────────────────

  /**
   * Size the grid so the whole call block (banner, tiles, self view, bar) fits the viewport from
   * where the block actually sits: `--dxr-call-fit` = viewport height − the block's visible top −
   * everything in the block that is not the grid. The CSS falls back to `100vh − reserve` when
   * this has not run. A tile below the fold is withheld from the weave (browser#167).
   */
  _fitGrid() {
    const ui = this.ui;
    if (!ui || !this.o.ui || typeof globalThis.innerHeight !== 'number') return;
    const host = this.container.getBoundingClientRect?.();
    const grid = ui.grid.getBoundingClientRect?.();
    if (!host || !grid || !grid.height) return;
    const fit = Math.max(160, Math.floor(globalThis.innerHeight - Math.max(0, host.top) - (host.height - grid.height) - 8));
    const prev = parseFloat(this.container.style.getPropertyValue('--dxr-call-fit')) || 0;
    if (Math.abs(fit - prev) > 2) this.container.style.setProperty('--dxr-call-fit', `${fit}px`);
    if (!this._fitHooked) {
      this._fitHooked = true;
      globalThis.addEventListener?.('resize', () => this._fitGrid());
    }
  }

  _setState(s) {
    this.state = s;
    this.log('state', { state: s });
    this._layout();
  }

  _buildDom() {
    const c = this.container;
    injectCallStyle(c.ownerDocument || document);
    c.classList.add('dxr-call-host');
    if (this.o.accent) c.style.setProperty('--dxr-accent', this.o.accent);
    const ui = (this.ui = {});
    ui.banner = el('div', { class: 'dxr-call-banner dxr-call-hidden' }, [
      el('span', { text: 'You are seeing this call in 2D.' }),
      el('a', { href: this.o.browserUrl, target: '_blank', rel: 'noopener', text: 'View in 3D with DisplayXR Browser' }),
    ]);
    ui.grid = el('div', { class: 'dxr-call-grid', 'data-layout': this.o.layout, 'data-n': '0' });
    ui.panel = el('div', { class: 'dxr-call-panel dxr-call-hidden' });
    ui.selfSlot = el('div', { class: 'dxr-call-self' });
    ui.bar = el('div', { class: 'dxr-call-bar' });
    ui.foot = el('div', { class: 'dxr-call-foot' }, [ui.selfSlot, ui.bar]);
    ui.invite = el('div', { class: 'dxr-call-panel dxr-call-hidden' });
    if (!this.o.ui) {
      show(ui.bar, false);
    }
    c.append(ui.banner, ui.panel, ui.grid, ui.invite, ui.foot);
    if (this.o.selfView) this.self = new SelfTile(this, ui.selfSlot);
    else show(ui.selfSlot, false);
    if (this.o.ui) this._buildBar();
  }

  _buildBar() {
    const ui = this.ui;
    const ib = (label, icon, onclick, extra = '') => el('button', { class: `dxr-call-ib ${extra}`, type: 'button', 'aria-label': label, title: label, html: icon, onclick });
    ui.mic = ib('Mute microphone', ICONS.mic, () => this.mute());
    ui.cam = ib('Turn camera off', ICONS.cam, () => (this.local?.videoTrack ? this.cameraOff() : this.retryCamera().catch(() => {})));
    ui.depth = el('input', { type: 'range', min: '-1', max: '1', step: '0.05', value: '0', 'aria-label': 'Depth' });
    ui.depth.addEventListener('input', () => this.setDepth(+ui.depth.value));
    ui.depth.addEventListener('dblclick', () => this.setDepth(0));
    ui.inviteBtn = ib('Invite', ICONS.link, () => {
      this._showInvite = !this._showInvite;
      this._layout();
    });
    ui.leave = ib('Leave call', ICONS.leave, () => this.leave(), 'dxr-call-ib--leave');
    ui.bar.append(ui.mic, ui.cam, el('label', { class: 'dxr-call-depth' }, ['Depth', ui.depth]), ui.inviteBtn, ui.leave);
  }

  _refreshBar() {
    const ui = this.ui;
    if (!ui || !ui.mic) return;
    ui.mic.innerHTML = this.muted ? ICONS.micOff : ICONS.mic;
    ui.mic.setAttribute('aria-pressed', String(this.muted));
    ui.mic.title = this.muted ? 'Unmute microphone' : 'Mute microphone';
    const noCam = !this.local?.videoTrack;
    ui.cam.innerHTML = this.camOff || noCam ? ICONS.camOff : ICONS.cam;
    ui.cam.setAttribute('aria-pressed', String(this.camOff || noCam));
    ui.cam.title = noCam ? (this.camStatus === 'busy' ? `${PLATE_TEXT.cameraBusy} — click to retry` : 'No camera — click to retry') : this.camOff ? 'Turn camera on' : 'Turn camera off';
  }

  _refreshSelf() {
    this.self?.update();
  }

  _refreshLobby() {
    if (this.state === 'lobby' || this.state === 'idle') this._layout();
  }

  _renderInvite(target, title, note) {
    target.replaceChildren();
    const link = this.inviteLink();
    if (!link) return;
    const input = el('input', { type: 'text', readOnly: true, value: link, 'aria-label': 'Invite link' });
    input.addEventListener('focus', () => input.select());
    const copy = el('button', { class: 'dxr-call-btn dxr-call-btn--primary', type: 'button', text: 'Copy link' });
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(link);
        copy.textContent = 'Copied';
      } catch {
        input.select();
        copy.textContent = 'Press Ctrl/Cmd+C';
      }
      setTimeout(() => (copy.textContent = 'Copy link'), 1800);
    });
    const qr = el('canvas', { 'aria-label': 'QR code of the invite link', role: 'img' });
    try {
      drawQr(qr, link, { px: 4 });
    } catch {
      qr.style.display = 'none'; // a link too long for a version-10 code: the copy button stays
    }
    target.append(
      el('h3', { text: title }),
      el('p', { text: note }),
      el('div', { class: 'dxr-call-invite' }, [el('div', { class: 'dxr-call-row', style: 'flex:1 1 280px' }, [input, copy]), qr])
    );
  }

  _layout() {
    const ui = this.ui;
    if (!ui) return;
    const c = this.container;
    const lobby = this.o.ui && (this.state === 'lobby' || this.state === 'idle' || this.state === 'full' || this.state === 'left');
    c.classList.toggle('dxr-call-host--lobby', lobby);
    show(ui.banner, this.o.ui && !this.woven);
    const n = this.tiles.size;
    ui.grid.dataset.n = String(Math.min(n, 4));
    show(ui.grid, n > 0 && this.state !== 'left');
    // Speaker layout: the active speaker (or the first tile) spans the row.
    const main = this.o.layout === 'speaker' ? this.speakerId || [...this.tiles.keys()][0] : null;
    for (const [id, t] of this.tiles) t.el.classList.toggle('dxr-call-tile--main', id === main);
    if (!this.o.ui) return;
    this._refreshBar();
    queueMicrotask(() => this._fitGrid());
    const p = ui.panel;
    if (lobby) {
      show(p, true);
      p.replaceChildren();
      const l = this.local;
      const joining = !!this.room;
      const title =
        this.state === 'full' ? 'This call is full' : this.state === 'left' ? 'You left the call' : joining ? 'Join the 3D call' : 'Start a 3D call';
      const kind = this.camStatus === 'busy' ? 'busy (joining audio-only)' : !l || !l.videoTrack ? 'none (joining audio-only)' : l.format === 'sbs' ? `sending 3D (side-by-side, ${l.width}×${l.height})` : `sending 2D (${l.width}×${l.height})`;
      const text =
        this.state === 'full'
          ? `It already has ${this.o.maxPeers} participants.`
          : `Check your framing below. Camera: ${l?.label || 'default'} — ${kind}.${this._liftHint() ? ` ${this._liftHint()}` : ''}`;
      const go = el('button', {
        class: 'dxr-call-btn dxr-call-btn--primary',
        type: 'button',
        text: this.state === 'left' ? 'Rejoin' : joining ? 'Join call' : 'Start 3D call',
      });
      go.addEventListener('click', () => this.join().catch(() => {}));
      const sel = el('select', { class: 'dxr-call-select', 'aria-label': 'Camera' });
      this._fillCameras(sel);
      sel.addEventListener('change', () => this.setCamera(sel.value).catch((e) => this.error('camera-failed', e.message, e)));
      const retry = !l || !l.videoTrack ? el('button', { class: 'dxr-call-btn', type: 'button', text: 'Retry camera' }) : null;
      retry?.addEventListener('click', () => this.retryCamera().catch(() => {}));
      p.append(el('h3', { text: title }), el('p', { text }), el('div', { class: 'dxr-call-row' }, [this.state === 'full' ? null : go, retry, sel]));
    } else if (this.state === 'in-call' && n === 0) {
      show(p, true);
      this._renderInvite(p, 'Waiting for others', 'Share this link (or scan the code). Anyone who opens it joins — keep it private.');
    } else if (this.state === 'joining') {
      show(p, true);
      p.replaceChildren(el('p', { text: 'Joining…' }));
    } else show(p, false);
    const inviteOpen = this.state === 'in-call' && n > 0 && this._showInvite;
    if (inviteOpen && !ui.invite.childElementCount) this._renderInvite(ui.invite, 'Invite', 'Anyone with this link can join.');
    show(ui.invite, inviteOpen);
    if (!inviteOpen) ui.invite.replaceChildren();
    ui.inviteBtn?.setAttribute('aria-pressed', String(!!inviteOpen));
  }

  async _fillCameras(sel) {
    let cams = [];
    try {
      cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    } catch {
      /* ignore */
    }
    const cur = this.local?.videoTrack?.getSettings?.().deviceId;
    sel.replaceChildren(...cams.map((d, i) => el('option', { value: d.deviceId, text: d.label || `Camera ${i + 1}` })));
    if (cur) sel.value = cur;
    show(sel, cams.length > 1);
  }

  _makeHandle() {
    const call = this;
    return {
      get room() {
        return call.room;
      },
      get id() {
        return call.id;
      },
      get state() {
        return call.state;
      },
      get wall() {
        return call.wall;
      },
      get format() {
        return call.local ? call.local.format : null;
      },
      get muted() {
        return call.muted;
      },
      get depth() {
        return call.depth;
      },
      get speaker() {
        return call.speakerId;
      },
      /** 'ok' | 'busy' (held by another app, e.g. eye tracking) | 'none' | 'pending'. */
      get camera() {
        return call.camStatus;
      },
      /** mono→3D: on/off, whether a lift provider resolved, native or web, and how many are lifted. */
      get mono3D() {
        return call._mono3DInfo();
      },
      /** Read-only snapshot of the remote participants. */
      get peers() {
        return Object.freeze([...call.tiles.values()].map((t) => t.info()));
      },
      join: () => call.join(),
      inviteLink: () => call.inviteLink(),
      mute: (on) => call.mute(on),
      cameraOff: (on) => call.cameraOff(on),
      setCamera: (idOrStream, o) => call.setCamera(idOrStream, o),
      setDepth: (v) => call.setDepth(v),
      retryCamera: () => call.retryCamera(),
      sendHint: (z) => call.sendHint(z),
      setMono3D: (on) => call.setMono3D(on),
      leave: () => call.leave(),
      on(type, cb) {
        if (typeof cb !== 'function') throw new TypeError(`${TAG} on() takes a function`);
        if (!call.listeners.has(type)) call.listeners.set(type, new Set());
        call.listeners.get(type).add(cb);
        return () => call.listeners.get(type)?.delete(cb);
      },
      off(type, cb) {
        call.listeners.get(type)?.delete(cb);
      },
      /** Diagnostics: the transport (mesh) and a way to simulate a dropped connection. */
      _debug: {
        get transport() {
          return call.transport;
        },
        kill: (id) => call.transport?._debugKill(id),
      },
    };
  }
}

// ── paint helpers ──────────────────────────────────────────────────────────────────────────

/** Size a FLAT (never woven) canvas to its box × dpr. Returns false if it has no box yet. */
function sizeFlat(canvas) {
  const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
  const w = Math.round((canvas.clientWidth || 0) * dpr);
  const h = Math.round((canvas.clientHeight || 0) * dpr);
  if (!w || !h) return false;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return true;
}

/**
 * Paint one eye (sbs) or the whole frame (mono) of `video` FLAT into `canvas`, cropped to cover.
 * `mirror` flips it (the self view). `eyeHalf` 0/1 picks the eye of an SBS frame; null = mono.
 */
function paintFlat(canvas, video, { eyeHalf = null, mirror = false } = {}) {
  if (!sizeFlat(canvas)) return;
  const g = canvas.getContext('2d');
  const W = video.videoWidth;
  const H = video.videoHeight;
  if (!W || !H || (video.readyState || 0) < 2) return;
  const eyeW = eyeHalf === null ? W : W / 2;
  const r = eyeCropRect(eyeW, H, canvas.width / canvas.height, 0, 0);
  g.save();
  if (mirror) {
    g.translate(canvas.width, 0);
    g.scale(-1, 1);
  }
  g.drawImage(video, (eyeHalf || 0) * eyeW + r.sx, r.sy, r.sw, r.sh, 0, 0, canvas.width, canvas.height);
  g.restore();
}

// ── a remote participant ──────────────────────────────────────────────────────────────────

class Tile {
  constructor(call, id) {
    this.call = call;
    this.id = id;
    this.hello = null;
    this.format = null; // null until hello or its timeout
    this.route = null;
    this.routedKey = null;
    this.handle = null;
    this.conn = 'connecting';
    this.remote = { muted: false, cameraOff: false, speaking: false };
    this.level = 0;
    this.speaking = false;
    this.quality = null;
    this.conv = createConvergence();
    this.conv.depth = call.depth;
    this.hintGate = rateGate(HINT_MAX_HZ);
    this.layerFails = 0;
    this.forceFlat = false;
    // lifted route (mono→3D): the lift handle once it lands, whether it is showing (live), and a
    // per-tile failure latch with bounded retries.
    this.lifted = false;
    this.liftHandle = null;
    this.liftLive = false;
    this.liftFailed = false;
    this.liftFails = 0;
    this.visible = true;
    this.video = Object.assign(document.createElement('video'), { muted: true, playsInline: true, autoplay: true });
    this.audio = Object.assign(document.createElement('audio'), { autoplay: true });
    this.video.addEventListener('playing', () => this._maybeRoute());
    this.video.addEventListener('loadeddata', () => this._maybeRoute());
    this.video.addEventListener('resize', () => this._maybeRoute());
    this.canvas = el('canvas');
    this.cover = el('div', { class: 'dxr-call-cover dxr-call-hidden' });
    this.badge = el('div', { class: 'dxr-call-badge' });
    this.plate = el('div', { class: 'dxr-call-state', text: 'Connecting…' });
    this.stage = el('div', { class: 'dxr-call-stage' }, [this.canvas, this.cover, this.badge, this.plate]);
    this.stage.style.aspectRatio = String(call.o.tileAspect);
    this.el = el('div', { class: 'dxr-call-tile', 'data-peer': id }, [this.stage, el('div', { class: 'dxr-call-talk' })]);
    if (!call.o.ui) {
      show(this.badge, false);
    }
    call.ui.grid.appendChild(this.el);
    this._renderBadge();
  }

  info() {
    return Object.freeze({
      id: this.id,
      format: this.format || 'mono',
      route: this.route,
      state: this.conn,
      muted: this.remote.muted,
      cameraOff: this.remote.cameraOff,
      speaking: this.speaking,
      rectified: !!(this.hello && this.hello.rectified),
      hello: this.hello,
      quality: this.quality,
      convergencePx: this.conv.current,
      lift: this.lifted
        ? Object.freeze({
            live: this.liftLive,
            native: !!(this.liftHandle && this.liftHandle.native),
            priority: this.call.liftPool ? this.call.liftPool.priority(this.id) : null,
            state: this.liftHandle ? this.liftHandle.state || null : 'pending',
          })
        : null,
    });
  }

  setStream(stream) {
    if (this.video.srcObject !== stream) {
      this.video.srcObject = stream;
      this.audio.srcObject = stream;
    }
    this.video.play().catch(() => {});
    this.audio.play().catch(() => {});
  }

  onChannelOpen() {
    clearTimeout(this.helloTimer);
    // A peer that never says hello (a foreign client) is mono — RFC §2.
    this.helloTimer = setTimeout(() => {
      if (!this.format) {
        this.format = 'mono';
        this._maybeRoute();
      }
    }, HELLO_WAIT_MS);
  }

  setHello(h) {
    clearTimeout(this.helloTimer);
    this.hello = h;
    this.conv.hello = h;
    const changed = this.format !== h.format;
    this.format = h.format;
    this.call.log('hello', { peer: this.id, format: h.format, width: h.width, height: h.height, rectified: h.rectified });
    if (changed) this._maybeRoute();
    else this._renderBadge();
  }

  setHint(h) {
    if (!this.hintGate(performance.now())) return;
    this.conv.subjectZmm = h.subjectZmm;
  }

  setRemoteState(st) {
    this.remote = st;
    this._renderBadge();
    this._renderPlate();
    this._updateVisible();
  }

  setSpeaking(on) {
    if (on === this.speaking) return;
    this.speaking = on;
    this.el.classList.toggle('dxr-call-tile--speaking', on);
  }

  setConn(st) {
    if (st === 'unreachable' && this.conn !== 'unreachable') {
      this.call.error('unreachable', `${PLATE_TEXT.unreachable}. Still retrying in the background.`, Object.assign(new Error('unreachable'), { peer: this.id }));
    }
    this.conn = st;
    if (st === 'connected' && this.leaveTimer) {
      clearTimeout(this.leaveTimer);
      this.leaveTimer = null;
    }
    this._renderPlate();
  }

  _renderPlate() {
    const t =
      this.conn === 'left'
        ? 'Left the call'
        : this.conn === 'unreachable'
          ? PLATE_TEXT.unreachable
          : this.conn === 'reconnecting'
          ? 'Reconnecting…'
          : this.conn !== 'connected'
            ? 'Connecting…'
            : this.remote.cameraOff
              ? 'Camera off'
              : null;
    this.plate.textContent = t || '';
    show(this.plate, !!t);
  }

  _renderBadge() {
    const b = badgeFor(this.route);
    // A lifted tile whose lift is still loading reads "2D→3D…" (it is painted flat meanwhile).
    const text = !this.route ? '…' : this.route === 'lifted' && !this.liftLive ? `${b}…` : b;
    this.badge.replaceChildren(el('b', { text }));
    this.badge.dataset.route = this.route || '';
    if (this.remote.muted) this.badge.insertAdjacentHTML('beforeend', ICONS.mutedSmall);
  }

  /** Route once the stream plays AND the format is known (hello or its timeout). */
  _maybeRoute() {
    if (!this.format || (this.video.readyState || 0) < 2 || !this.video.videoWidth) return;
    this.reroute(false);
  }

  reroute(force) {
    const call = this.call;
    const pool = call.liftPool;
    const r =
      this.forceFlat && this.format === 'sbs'
        ? { route: 'flat-left' }
        : routeFor({
            format: this.format,
            woven: call.woven,
            mono3D: call.mono3DOn ? 'auto' : 'off',
            lift: !!pool,
            overBudget: pool ? !pool.canAcquire(this.id) : false,
            failed: this.liftFailed,
          });
    // First mono peer on a woven wall and lift not asked for yet (e.g. setMono3D(true) later).
    if (this.format !== 'sbs' && call.woven && call.mono3DOn && !call._liftP) call._ensureLift();
    const key = `${r.route}|${this.format}`;
    if (!force && key === this.routedKey) return;
    this.routedKey = key;
    this._unregister();
    this.route = r.route;
    if (r.route === 'woven-sbs') this._registerWoven();
    else if (r.route === 'lifted') this._registerLifted();
    call.log('route', { peer: this.id, route: r.route, format: this.format, mono3d: r.mono3d || null });
    call.emit('format', { id: this.id, format: this.format, route: r.route, mono3d: r.mono3d || null, hello: this.hello });
    this._renderBadge();
  }

  _registerWoven() {
    const call = this.call;
    if (!this.convCanvas) this.convCanvas = document.createElement('canvas');
    this._paintConv(); // the first frame exists before the layer does
    show(this.cover, true);
    const handle = call.wall.addImage(this.canvas, this.convCanvas);
    this.handle = handle;
    handle.firstWoven?.then((res) => {
      if (this.handle !== handle) return;
      show(this.cover, false); // a cut, never a fade
      call.log('first-woven', { peer: this.id, woven: res.woven, reason: res.reason, ms: Math.round(res.ms) });
      if (!res.woven && res.reason === 'layer-failed') this._layerFailed();
    });
  }

  /**
   * The lifted route: lift(video, { mode: 'live', wall }) through the call's pool. The video is
   * mounted in the stage (lift() overlays the element's rect; see the header), the flat canvas
   * keeps painting until lift reports `live`, then hides so lift's canvas (web) or the browser's
   * in-place conversion of the video (native) is what shows.
   */
  _registerLifted() {
    const call = this.call;
    const pool = call.liftPool;
    this.lifted = true;
    this.liftLive = false;
    this.video.classList.add('dxr-call-liftsrc');
    this.canvas.classList.add('dxr-call-liftflat');
    if (this.video.parentNode !== this.stage) this.stage.insertBefore(this.video, this.stage.firstChild);
    this._observeVisible();
    pool.acquire(this.id, this.video, { wall: call.wall, visible: this.visible, onError: (err) => this._liftError(err) }).then((h) => {
      if (!h || !this.lifted || pool.handle(this.id) !== h) return;
      this.liftHandle = h;
      const onState = (st) => {
        if (st === 'live') this._liftShowing(true);
        else if (st === 'error' || st === 'disposed') this._liftShowing(false);
      };
      this._liftOff = [
        h.on?.('statechange', (d) => onState(d && d.state)),
        h.on?.('error', (d) => {
          if (d && d.fatal) this._liftError(d.error);
        }),
      ];
      // Until lift is live its canvas has nothing to draw: keep it hidden and the flat tile up.
      if (h.state === 'live') this._liftShowing(true);
      else if (h.canvas && h.canvas.style) h.canvas.style.visibility = 'hidden';
      call.log('lifted', { peer: this.id, native: !!h.native, woven: !!h.woven, state: h.state || null, provider: (h.stats && h.stats.provider) || null });
    });
  }

  _liftShowing(on) {
    if (on === this.liftLive) return;
    this.liftLive = on;
    const h = this.liftHandle;
    if (on) {
      if (h && h.canvas && h.canvas.style && !h.native) h.canvas.style.visibility = '';
      this.canvas.style.visibility = 'hidden';
      this.liftFails = 0;
      if (!this.call.liftProven) {
        this.call.liftProven = true;
        this.call._refreshLobby();
      }
    } else this.canvas.style.visibility = '';
    this.call.log('lift-live', { peer: this.id, live: on });
    this._renderBadge();
  }

  /** lift() failed (or its handle hit a fatal error): flat now, retried with backoff a couple of times. */
  _liftError(err) {
    if (!this.lifted) return;
    this.call.log('lift-error', { peer: this.id, message: String((err && err.message) || err).slice(0, 200) });
    this.liftFailed = true;
    this.reroute(true);
    if (this.liftFails++ >= LIFT_RETRIES) return;
    clearTimeout(this.liftTimer);
    this.liftTimer = setTimeout(() => {
      this.liftFailed = false;
      this.reroute(false);
    }, backoffMs(this.liftFails - 1, { baseMs: 3000, maxMs: 30000 }));
  }

  /** Offscreen (or camera-off) lifted tiles are PAUSED — the provider keeps their last frame. */
  _observeVisible() {
    if (this._io || typeof IntersectionObserver !== 'function') return;
    this._io = new IntersectionObserver((entries) => {
      const e = entries[entries.length - 1];
      this._onscreen = !!(e && e.isIntersecting);
      this._updateVisible();
    });
    this._io.observe(this.stage);
  }

  _updateVisible() {
    const v = this._onscreen !== false && !this.remote.cameraOff;
    if (v === this.visible) return;
    this.visible = v;
    this.call.liftPool?.setVisible(this.id, v);
  }

  _layerFailed() {
    this.forceFlat = true;
    this.reroute(true);
    if (this.layerFails++ >= LAYER_RETRIES) return;
    const delay = backoffMs(this.layerFails - 1, { baseMs: 1500, maxMs: 20000 });
    this.call.log('layer-retry', { peer: this.id, attempt: this.layerFails, inMs: delay });
    clearTimeout(this.layerTimer);
    this.layerTimer = setTimeout(() => {
      this.forceFlat = false;
      if (this.call.woven) this.reroute(true);
    }, delay);
  }

  onWallLost() {
    // The layer died with the session; the core already painted this canvas flat. Stop treating
    // it as woven until a new wall arrives (Call._recoverWall → reroute(true)).
    this.handle = null;
    this.reroute(true);
  }

  _unregister() {
    show(this.cover, false);
    if (this.lifted) {
      this.lifted = false;
      for (const off of this._liftOff || []) if (typeof off === 'function') off();
      this._liftOff = null;
      this.call.liftPool?.release(this.id);
      // A lift slot just freed: a mono tile held flat by the budget may take it (after this
      // tile's own reroute / removal has settled).
      queueMicrotask(() => this.call.state !== 'left' && this.call._rerouteMono());
      this.liftHandle = null;
      this.liftLive = false;
      this.canvas.style.visibility = '';
      this.canvas.classList.remove('dxr-call-liftflat');
      if (this._io) {
        this._io.disconnect();
        this._io = null;
      }
      // Back to a DETACHED video. Removing a playing media element from the document pauses it
      // (a queued microtask), so play it again after that.
      if (this.video.parentNode) {
        this.video.remove();
        this.video.classList.remove('dxr-call-liftsrc');
        setTimeout(() => this.video.srcObject && this.video.play().catch(() => {}), 0);
      }
    }
    if (this.handle) {
      try {
        this.handle.remove();
      } catch {
        /* the session may be gone */
      }
      this.handle = null;
    }
  }

  paint() {
    if (!this.route) return;
    if (this.route === 'woven-sbs') this._paintConv();
    else if (this.route === 'lifted') {
      if (!this.liftLive) paintFlat(this.canvas, this.video); // flat until lift is showing
    } else paintFlat(this.canvas, this.video, { eyeHalf: this.route === 'flat-left' ? 0 : null });
  }

  /** The convergence-shifted pair, into the canvas the wall repaints the tile from. */
  _paintConv() {
    const v = this.video;
    const W = v.videoWidth;
    const H = v.videoHeight;
    if (!W || !H || (v.readyState || 0) < 2 || !this.convCanvas) return;
    const eyeW = W / 2;
    const A = this.call.o.tileAspect;
    const { w: outW, h: outH } = eyeOutputSize(eyeW, H, A);
    const c = this.convCanvas;
    if (c.width !== 2 * outW || c.height !== outH) {
      c.width = 2 * outW;
      c.height = outH;
    }
    const shift = this.conv.step(eyeW);
    const g = c.getContext('2d');
    for (const eye of [0, 1]) {
      const r = eyeCropRect(eyeW, H, A, shift, eye);
      g.drawImage(v, eye * eyeW + r.sx, r.sy, r.sw, r.sh, eye * outW, 0, outW, outH);
    }
  }

  destroy() {
    clearTimeout(this.helloTimer);
    clearTimeout(this.layerTimer);
    clearTimeout(this.leaveTimer);
    clearTimeout(this.liftTimer);
    this._unregister();
    this.video.srcObject = null;
    this.audio.srcObject = null;
    this.el.remove();
  }
}

// ── the self view ─────────────────────────────────────────────────────────────────────────

class SelfTile {
  constructor(call, slot) {
    this.call = call;
    this.canvas = el('canvas');
    this.badge = el('div', { class: 'dxr-call-badge' });
    this.plate = el('div', { class: 'dxr-call-state dxr-call-hidden' });
    this.stage = el('div', { class: 'dxr-call-stage' }, [this.canvas, this.badge, this.plate]);
    this.stage.style.aspectRatio = String(call.o.tileAspect);
    this.el = el('div', { class: 'dxr-call-tile dxr-call-tile--self' }, [this.stage, el('div', { class: 'dxr-call-talk' })]);
    slot.appendChild(this.el);
    this.route = null;
    this.handle = null;
    this.mirror = null;
  }

  update() {
    const l = this.call.local;
    const noCam = !l || !l.videoTrack;
    this.plate.textContent = noCam ? (this.call.camStatus === 'busy' ? PLATE_TEXT.cameraBusy : this.call.camStatus === 'pending' ? '' : 'No camera') : this.call.camOff ? 'Camera off' : '';
    show(this.plate, noCam || this.call.camOff);
    this.reroute(false);
  }

  reroute(force) {
    const l = this.call.local;
    // Local SBS on a woven wall → woven mirror-and-swap preview; anything else is flat.
    const route = l && l.format === 'sbs' && this.call.woven && l.videoTrack ? 'woven-sbs' : l && l.format === 'sbs' ? 'flat-left' : 'flat';
    if (!force && route === this.route) return this._badge();
    this.unregister();
    this.route = route;
    if (route === 'woven-sbs') {
      if (!this.mirror) this.mirror = document.createElement('canvas');
      this._paintMirror();
      this.handle = this.call.wall.addImage(this.canvas, this.mirror);
    }
    this._badge();
  }

  _badge() {
    this.badge.replaceChildren(el('b', { text: `You · ${this.route === 'woven-sbs' ? '3D' : '2D'}` }));
  }

  onWallLost() {
    this.handle = null;
    this.reroute(true);
  }

  unregister() {
    if (this.handle) {
      try {
        this.handle.remove();
      } catch {
        /* ignore */
      }
      this.handle = null;
    }
  }

  setSpeaking(on) {
    this.el.classList.toggle('dxr-call-tile--speaking', on);
  }

  paint() {
    const l = this.call.local;
    if (!l || !l.video || this.call.state === 'left') return;
    if (this.route === 'woven-sbs') this._paintMirror();
    else paintFlat(this.canvas, l.video, { eyeHalf: this.route === 'flat-left' ? 0 : null, mirror: true });
  }

  /**
   * The MIRRORED stereo preview: each half mirrored AND the halves swapped (wire.js
   * mirrorSwapOps). Mirroring each half in place would invert every disparity. The stream that is
   * SENT is never touched — only this canvas.
   */
  _paintMirror() {
    const v = this.call.local.video;
    const W = v.videoWidth;
    const H = v.videoHeight;
    if (!W || !H || (v.readyState || 0) < 2) return;
    const A = this.call.o.tileAspect;
    const eyeW = W / 2;
    const { w: outW, h: outH } = eyeOutputSize(eyeW, H, A);
    const c = this.mirror;
    if (c.width !== 2 * outW || c.height !== outH) {
      c.width = 2 * outW;
      c.height = outH;
    }
    const g = c.getContext('2d');
    const r = eyeCropRect(eyeW, H, A, 0, 0);
    for (const op of mirrorSwapOps(W, H)) {
      const dx = op.dx === 0 ? 0 : outW;
      g.save();
      g.translate(dx + outW, 0);
      g.scale(-1, 1);
      g.drawImage(v, op.sx + r.sx, r.sy, r.sw, r.sh, 0, 0, outW, outH);
      g.restore();
    }
  }
}

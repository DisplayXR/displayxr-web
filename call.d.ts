// Type definitions for @displayxr/inline3d/call.
// PREVIEW tier — not covered by the 1.x semver promise. See docs/sdk-stability.md.
//
// P1 of docs/rfcs/0002-video-call.md: full-mesh WebRTC (<= 4 participants), pluggable signalling,
// side-by-side stereo from a stereo camera, convergence from `hello` + `hint`, SDK chrome or
// headless. P2a: mono peers lifted to 3D through `@displayxr/inline3d/lift` (`mono3D`).
// RFC 0003 C1: `mountCall(el, opts?)` (the one-line path, the wall from `sharedInline3D()`), the
// `warning` event (`lift-not-bundled`), `key`; `<dxr-call>` is `./call/element`, and
// `./call/full` is this entry with lift statically imported.
// RFC 0003 C2 (§2): THIS is the public surface — what a page needs to run, observe and dress a
// call. The test helpers that used to be exported here are internal (importable by file path
// from `js/call/*.js`); 1.30 keeps them as `@deprecated` wrappers (the block at the end), 1.31
// removes them. Options are grouped (`theme`, `invite`, `landing`, `liftOptions.max`), the camera
// is `@displayxr/inline3d/camera` (`camera: cam`), and `diagnostics()` holds the debug data.
//
// The public surface of this file is pinned by test/api-snapshot: a change here fails `npm test`
// until the snapshot is updated in the same change (`node tools/api-surface.mjs --update`).

import type { Inline3D, Inline3DUnsupported } from './index.js';
import type { StereoCamera, PairCursorOptions } from './camera.js';

/** What a participant sends: a side-by-side pair (left eye left) or one flat picture. */
export type CallFormat = 'sbs' | 'mono';

/**
 * A remote participant's connection state as the tile shows it. `'unreachable'`: known to exist
 * but no connection for ~10 s — usually a network that needs a relay (TURN). Sticky until it
 * connects; retries continue in the background.
 */
export type PeerState = 'new' | 'connecting' | 'connected' | 'reconnecting' | 'unreachable' | 'left';

/** How THIS side shows a participant: a woven stereo pair, a mono peer lifted to 3D, or flat. */
export type CallDisplay = '3D' | '2D→3D' | '2D';

/**
 * The signalling seam. Any object with `join()` works — bring your own accounts / push service.
 * `join` rejects with an Error whose `code` is `'room-full'` when the room is at capacity.
 */
export interface SignalingAdapter {
  readonly name?: string;
  join(room: string, hooks: SignalingHooks): Promise<SignalingSession>;
}
export interface SignalingHooks {
  /** This peer's id — stable across signalling reconnects. */
  id: string;
  maxPeers: number;
  onPeerJoined?(id: string): void;
  onPeerLeft?(id: string): void;
  /** An opaque offer / answer / ICE blob relayed from `from`. */
  onSignal?(from: string, data: unknown): void;
  onDisconnect?(err?: Error): void;
  /** A participant known to exist that signalling itself cannot reach (shown as an unreachable tile). */
  onPeerUnreachable?(ghostId: string): void;
  onPeerReachable?(ghostId: string): void;
  onReconnect?(peerIds: string[]): void;
}
export interface SignalingSession {
  id: string;
  /** Peers already in the room when this one joined. */
  peers: string[];
  /** Short-lived TURN credentials minted by the server, if it has any. */
  iceServers?: RTCIceServer[];
  /** Hosted service (RFC 0003 §5): the tier this session was admitted as. */
  tier?: 'anon' | 'key';
  /** Hosted service: the publishable key id this session is attributed to. */
  key?: string;
  /** Hosted service: why `iceServers` is (or is not) there — see {@link SignalingTurnStatus}. */
  turn?: SignalingTurnStatus;
  send(to: string, data: unknown): void;
  leave(): void;
}

/**
 * The hosted DisplayXR signalling server (`dxrSignaling()` with no URL): `wss://signal.displayxr.org`
 * since the release after 1.32.0 (it was `wss://dxr-signal.displayxr.workers.dev`). The same server
 * answers on both hosts, and `dxrSignaling()` given either one fails over to the other; a
 * self-hosted URL is tried as given.
 */
export const DXR_SIGNAL_DEFAULT: string;
/**
 * The server's TURN decision for one session (`welcome.turn`, `dxr-signal/1`). `status` is the
 * service-wide state of the monthly relay budget (`ok` / `degraded` / `off`); `reason` says why
 * THIS session got no credentials: `unconfigured` (the server has no TURN — self-hosted), `budget`
 * (anonymous session shed near the budget → `warning` `turn-shed`), `rate` (too many mints from
 * this address → `turn-shed`), `cap` (the monthly cap → `error` `turn-cap`), `mint-failed`.
 */
export interface SignalingTurnStatus {
  status: 'ok' | 'degraded' | 'off';
  reason?: 'unconfigured' | 'budget' | 'cap' | 'rate' | 'mint-failed';
  /** Credential lifetime, seconds, when minted. */
  ttl?: number;
}

/**
 * The `dxr-signal/1` JSON-over-WebSocket client (protocol: signaling/README.md). `url` is your
 * server's base, e.g. `wss://signal.example.com` or `ws://localhost:8787` — the reference servers
 * are `signaling/worker.mjs` (Cloudflare) and `node signaling/dev-server.mjs`. No URL = the hosted
 * server. `key`: a publishable key for the hosted service (public by design; sent on connect).
 * The hosted server answers on more than one host (RFC 0003 §5g) and the adapter fails over
 * between them on connect and reconnect by itself; `aliases` adds fallbacks for a self-hosted URL.
 */
export function dxrSignaling(
  url?: string,
  opts?: {
    WebSocket?: any;
    pingMs?: number;
    /** A publishable key for the hosted service (public by design; sent on connect). */
    key?: string;
    /** Extra base URLs to fail over to when `url` is unreachable (the hosted default has its own). */
    aliases?: string[];
  }
): SignalingAdapter;

/** The eight named accents `theme.accent` takes (the same names `/player` uses). */
export type CallAccent = 'azure' | 'violet' | 'magenta' | 'sunset' | 'amber' | 'lime' | 'mint' | 'ice';

/**
 * Every string the chrome shows, by key (docs/call.md lists them with their defaults). A partial
 * map overrides any subset — which is also how the chrome is localised. `{var}` placeholders are
 * filled by the module.
 */
export type CallStrings = Partial<Record<
  | 'lobbyStartTitle' | 'lobbyJoinTitle' | 'lobbyFullTitle' | 'lobbyLeftTitle' | 'lobbyFullText' | 'lobbyText'
  | 'cameraDefault' | 'kindBusy' | 'kindNone' | 'kindSbs' | 'kindMono'
  | 'liftOff' | 'liftChecking' | 'liftMissing' | 'liftNoProvider' | 'liftNative' | 'liftWeb' | 'liftProven' | 'liftUnproven'
  | 'start' | 'join' | 'rejoin' | 'retryCamera' | 'cameraSelect' | 'joining'
  | 'waitingTitle' | 'waitingText' | 'inviteTitle' | 'inviteText' | 'inviteLink' | 'copyLink' | 'copied' | 'pressCopy' | 'qrLabel'
  | 'banner2D' | 'bannerLink'
  | 'mute' | 'unmute' | 'cameraOn' | 'cameraOff' | 'cameraRetry' | 'cameraBusyRetry' | 'depth' | 'invite' | 'leave'
  | 'connecting' | 'reconnecting' | 'leftCall' | 'cameraOffPlate' | 'noCamera' | 'unreachable' | 'cameraBusy'
  | 'you' | 'badge3D' | 'badge2D3D' | 'badge2D' | 'badgePending',
  string
>>;

/**
 * Theming (RFC 0003 §2). The colour / radius / font entries are written as CSS custom properties
 * on the host (`--dxr-accent`, `--dxr-ink`, `--dxr-shell`, `--dxr-danger`, `--dxr-radius`,
 * `--dxr-font`), which a stylesheet can set instead; the chrome also exposes `part` names
 * (`bar`, `invite`, `badge`, `plate`, `lobby`, `banner`, `self`, `tile`, `grid`) — reached as
 * `dxr-call [part="bar"]`, since the chrome is light DOM. Every one of these styles chrome only:
 * a woven tile and its ancestors stay visually bare (woven-canvas rule 7), and no theme can reach
 * them.
 */
export interface CallTheme {
  /** A named accent or any CSS colour → `--dxr-accent`. Default `'azure'`. */
  accent?: CallAccent | (string & {});
  /** Text on chrome → `--dxr-ink`. */
  ink?: string;
  /** Chrome background → `--dxr-shell` (near-solid on purpose: no blur over the weave). */
  shell?: string;
  /** Leave / muted → `--dxr-danger`. */
  danger?: string;
  /** Chrome corner radius (px, or any CSS length) → `--dxr-radius`. Never applied to a tile. */
  radius?: number | string;
  /** Chrome font family → `--dxr-font`. */
  font?: string;
  /** Tile aspect (w/h) = the woven buffer's per-eye aspect. Default 16/9. */
  tileAspect?: number;
  /** Overrides for the chrome's text (also localisation). */
  strings?: CallStrings;
}

export interface CallOptions {
  /**
   * The inline-3D manager to put the tiles on. `mountCall` defaults it to the document's shared
   * one (`sharedInline3D()`); `addCall` takes it as its first argument instead.
   */
  wall?: Inline3D | Inline3DUnsupported | null;
  /**
   * `'auto'` (default): the room in this page's `#room=` fragment, else a new one on join. Or a
   * room id / invite link. Room ids are >= 96 random bits (generated ones: 128), base64url.
   */
  room?: 'auto' | (string & {});
  /** Default `dxrSignaling()` (the hosted DisplayXR server). Or `dxrSignaling(url)` to self-host, or your own adapter. */
  signaling?: SignalingAdapter;
  /**
   * A publishable key for the hosted signalling service (`pk_…`, RFC 0003 §5a). Public by design
   * — it sits in page source — and only used when `signaling` is left at the default.
   */
  key?: string;
  /** Overrides the server's STUN/TURN list. Default: public STUN + the server's TURN, if any. */
  iceServers?: RTCIceServer[];
  /**
   * `'auto'` (default): the call opens the best camera through `@displayxr/inline3d/camera`
   * (`openCamera({ prefer: 'auto' })`): a stereo device when one is present, else the default
   * webcam; a camera held by another process (an eye tracker) is skipped, never fatal. `'stereo'`
   * prefers the pair (falls back to mono), `'mono'` never probes, a string is a `deviceId`, a
   * `MediaStream` is used as given with `format` declaring what it is, and a `StereoCamera` you
   * opened yourself is used as is (and left open when the call ends).
   */
  camera?: 'auto' | 'stereo' | 'mono' | (string & {}) | MediaStream | StereoCamera;
  /** The format of a page-supplied `MediaStream`. Default `'mono'` — 3D-ness is never guessed. */
  format?: CallFormat;
  /** Microphone (echo cancellation + noise suppression). Default true. */
  audio?: boolean;
  /**
   * Lift mono peers to 3D on a 3D display (RFC §5). `'auto'` (default): import
   * `@displayxr/inline3d/lift` lazily from this copy of the SDK, and use it when it reports a
   * native provider or a WebGPU web fallback — otherwise mono peers stay flat (one log line, no
   * error). `'off'` / `false`: flat. A function: your own `lift` (a bundled app imports
   * `lift` from `@displayxr/inline3d/lift` and passes it here, or uses `./call/full`). Switch at
   * runtime with `setMono3D()`.
   */
  mono3D?: 'auto' | 'off' | false | LiftFunction;
  /**
   * Extra `lift()` options for lifted tiles — e.g. `models` (where the depth model is served from),
   * `ort`, `quality`, `providers` — plus `max`: concurrent lifted tiles (default 4 = the mesh
   * maximum; further mono peers stay flat). The call's own keys (`mode`, `wall`, `ui`,
   * `convergence`, `priority`) always win.
   */
  liftOptions?: Record<string, unknown> & { max?: number };
  /**
   * Auto-convergence (default true): measure the disparity of the point between each SBS peer's
   * eyes on the received frames and shift the two eyes by half of it each, so the remote person sits
   * at the display plane. No calibration needed. The depth slider stays an offset on top.
   */
  autoConverge?: boolean;
  /**
   * `'depth'`: over a 3D (stereo) tile — a peer's or your self view — a crosshair just in front of
   * the person under the pointer replaces the CSS cursor, instead of the flat cursor drawn on the
   * glass behind them (runtime ADR-046; the depth is measured off each tile's two halves). Lifted
   * (2D→3D) and flat tiles keep the normal cursor. Off by default (zero cost).
   * `<dxr-call cursor="depth">`.
   */
  cursor?: 'depth' | PairCursorOptions;
  /** Participants INCLUDING you. Default 4, clamped to 2..4 (full mesh). */
  maxPeers?: number;
  /**
   * `'grid'` (default), `'speaker'` (the active speaker spans the row), or `'none'`: the module
   * creates the tiles but does not position them — each carries `data-dxr-peer="<id>"` and
   * `tile(id)` returns it, for the page's own CSS grid on the host.
   */
  layout?: 'grid' | 'speaker' | 'none';
  /**
   * SDK chrome. `true` (default): lobby, invite (link + QR), bottom bar, badges, plates, banner.
   * `'tiles'`: badges and state plates only — your bar, the module's correct per-tile chrome.
   * `false`: nothing. Tiles are module-owned in every mode (they are woven canvases).
   */
  ui?: boolean | 'tiles';
  /** Join without the lobby. Default: true unless `ui` is `true`. */
  autoJoin?: boolean;
  /** The small self view (mirrored; a stereo self view is mirrored AND eye-swapped — an `addCameraView`). Default true. */
  selfView?: boolean;
  /** Colours, radius, font, tile aspect and strings — see {@link CallTheme}. */
  theme?: CallTheme;
  /** Invite links: `base` (default this page's URL, query kept, fragment replaced); `updateUrl` writes `#room=` into the page URL on join (default: `ui === true`). */
  invite?: { base?: string; updateUrl?: boolean };
  /** The "see it in 3D" offer for recipients on ordinary browsers: `browserUrl` (where it links), `allow2D` (false = 3D-only kiosk pages). */
  landing?: { browserUrl?: string; allow2D?: boolean };
  /** Verbose console logging. `diagnostics()` has the rest. */
  debug?: boolean;
}

/**
 * The `lift()` of `@displayxr/inline3d/lift`, as the call uses it: `lift(video, { mode: 'live',
 * wall, ui: 'none', convergence, priority, quality })` → a handle it can `remove()`. Only the
 * members below are used; everything else is optional.
 */
export type LiftFunction = ((element: HTMLVideoElement, opts: Record<string, unknown> & {
  mode: 'live';
  wall: unknown;
  ui: 'none';
  convergence: 'auto' | number;
  priority: 'high' | 'normal' | 'low' | 'paused';
}) => Promise<{
  remove(): void;
  setPriority?(p: 'high' | 'normal' | 'low' | 'paused'): boolean;
  setConvergence?(x: 'auto' | number): void;
  on?(type: string, cb: (d: any) => void): () => void;
  readonly native?: boolean;
  readonly state?: string;
  readonly canvas?: HTMLCanvasElement;
}>) & { liftCapabilities?: (o?: { webFallback?: boolean }) => Promise<any> };

/** The documented shape of the `quality` event's `in` / `out` (values informative, shape stable). */
export interface CallQuality {
  in: { width: number; height: number; fps: number; codec: string | null; kbps: number | null; dropped: number; decoder: string | null } | null;
  out: { width: number; height: number; fps: number; codec: string | null; kbps: number | null; limitation: string | null; encoder: string | null } | null;
}

/** A remote participant, as a page needs it. Debug data (hello, route, convergence, lift) is in `diagnostics()`. */
export interface CallPeer {
  readonly id: string;
  readonly format: CallFormat;
  readonly display: CallDisplay;
  readonly state: PeerState;
  readonly muted: boolean;
  readonly cameraOff: boolean;
  readonly speaking: boolean;
}

/**
 * `error` codes — fatal for a feature, never for the widget. `'camera-busy'` (held by another
 * app: audio-only until `retryCamera()`), `'no-camera'`, `'permission-denied'`, `'unreachable'`
 * (`error.peer` = the tile), `'room-full'`, `'session-ended'`, `'signaling-closed'`,
 * `'signaling-unreachable'`, `'join-failed'`, `'camera-failed'`, `'rectify-failed'`,
 * `'mount-failed'` (the element). From the hosted signalling service (RFC 0003 §5, C3):
 * `'rate-limited'` / `'quota'` (a limit of the anonymous or keyed tier — the join is refused;
 * `error.retryMs` says when a retry may work), `'bad-key'` / `'origin-not-allowed'` (the
 * publishable key is unknown, revoked, or not allowed from this page's origin), `'blocked'`,
 * `'expired'` (the room's lifetime is up), and `'turn-cap'` (the service's monthly relay budget
 * is spent: the call still joins and direct connections work, but nobody gets TURN — not fatal).
 */
export type CallErrorCode =
  | 'camera-busy'
  | 'no-camera'
  | 'permission-denied'
  | 'unreachable'
  | 'room-full'
  | 'session-ended'
  | 'signaling-closed'
  | 'join-failed'
  | 'camera-failed'
  | 'rectify-failed'
  | 'mount-failed'
  | 'signaling-unreachable'
  // Hosted signalling service (RFC 0003 §5, C3).
  | 'rate-limited'
  | 'quota'
  | 'bad-key'
  | 'origin-not-allowed'
  | 'blocked'
  | 'expired'
  | 'turn-cap'
  | (string & {});

/** `warning` codes — degraded, not broken. */
export type CallWarningCode = 'lift-not-bundled' | 'turn-shed' | (string & {});

export interface CallEvents {
  joined: { room: string; id: string };
  /** `reason`: `'left'` (you called `leave()` / the element was removed) or `'pagehide'`. */
  left: { room: string | null; reason: string };
  peer: { id: string };
  peerleft: { id: string; reason: string };
  state: { id: string; state: PeerState };
  /** How this side shows a participant changed (a hello arrived, lift went live, the wall came back). */
  display: { id: string; display: CallDisplay };
  speaker: { id: string | null };
  /**
   * Per peer (`id`) every 2 s; or, with `id: null` and `lift`, when lifted tiles on the web
   * provider degrade the page's frame rate (~< 20 fps for 3 s) and when it recovers.
   */
  quality: ({ id: string } & CallQuality) | ({ id: null; in: null; out: null; lift: { degraded: boolean; frameMs: number; tiles: number } });
  error: { code: CallErrorCode; message: string; error: Error | null };
  /**
   * `'lift-not-bundled'`: a 2D participant is on a 3D display, `mono3D` is `'auto'`, and the lift
   * module could not be imported from this build — they stay flat. Fix: `mono3D: lift` or
   * `./call/full`. Emitted once per call with one `console.warn`. A display that honestly cannot
   * lift is NOT this: that is `handle.mono3D.reason` (`'no-provider'` / `'no-webgpu'`).
   * `'turn-shed'`: only THIS session got no TURN from the hosted service (an anonymous session
   * while the monthly relay budget is nearly spent, or too many credential requests from this
   * address this hour); the call runs STUN-only. A publishable key keeps TURN.
   */
  warning: { code: CallWarningCode; message: string };
}

export interface CallHandle {
  readonly room: string | null;
  readonly id: string;
  readonly state: 'lobby' | 'joining' | 'in-call' | 'full' | 'left';
  /** `'busy'` = held by another app (e.g. eye tracking): the call runs audio-only until `retryCamera()`. */
  readonly camera: 'ok' | 'busy' | 'none' | 'pending';
  /** What YOU send; null before a camera opened. */
  readonly localFormat: CallFormat | null;
  readonly muted: boolean;
  readonly cameraOff: boolean;
  readonly depth: number;
  readonly speaker: string | null;
  /** Read-only snapshot of the remote participants. */
  readonly peers: ReadonlyArray<CallPeer>;
  /** mono→3D status. `reason` when unavailable: `'import-failed'`, `'no-lift-export'`, `'no-provider'`, `'no-webgpu'`. */
  readonly mono3D: { readonly on: boolean; readonly state: 'off' | 'idle' | 'loading' | 'ready' | 'unavailable'; readonly reason: string | null; readonly provider: string | null; readonly lifted: number; readonly max: number };
  join(): Promise<void>;
  leave(): void;
  /** `…#room=<id>` — the room rides in the fragment, which never reaches a server. Null before a room exists. */
  inviteLink(): string | null;
  /** Mute (true), unmute (false) or toggle (no argument). Returns the new state. */
  mute(on?: boolean): boolean;
  /** Camera off (true), on (false) or toggle. Returns the new state (`cameraOff` reads it). */
  setCameraOff(on?: boolean): boolean;
  /** Switch cameras: a `deviceId`, a `MediaStream` (+ `format`), or a `StereoCamera`. Keeps the current one on failure. */
  setCamera(src: string | MediaStream | StereoCamera, opts?: { format?: CallFormat }): Promise<{ format: CallFormat; width: number; height: number; label: string }>;
  /** Try the configured camera again (e.g. after the eye tracker released it). */
  retryCamera(): Promise<{ format: CallFormat; width: number; height: number; label: string }>;
  /**
   * The ONE depth control, [-1, 1] (+ = push back). Stereo tiles: ± 5% of the eye width added to
   * the automatic convergence. Lifted tiles: lift's convergence (0 → `'auto'`, else 0.5 + 0.5·v).
   */
  setDepth(v: number | null): number;
  /** Turn mono→3D on/off at runtime (no argument toggles). Off releases every lift; tiles go flat. */
  setMono3D(on?: boolean): boolean;
  /** A participant's tile element (for `layout: 'none'`), or null. Style it in place; never move it. */
  tile(peerId: string): HTMLElement | null;
  on<K extends keyof CallEvents>(type: K, cb: (e: CallEvents[K]) => void): () => void;
  off<K extends keyof CallEvents>(type: K, cb: (e: CallEvents[K]) => void): void;
  /** Explicitly UNSTABLE: the wall, the transport, per-peer hello / route / convergence / lift / quality, the lift pool. For devtools. */
  diagnostics(): Record<string, unknown>;
}

export function addCall(wall: Inline3D | Inline3DUnsupported | null, container: HTMLElement, opts?: CallOptions): Promise<CallHandle>;

/**
 * The one-line path (RFC 0003 §1): `addCall` with every argument optional. The wall is
 * `opts.wall` if given, else the document's shared manager (`sharedInline3D()` — the page's
 * existing session, never a second one). Hosted signalling, `camera: 'auto'` and the SDK chrome
 * by default; resolves once the lobby shows (or, with `autoJoin` / `ui: false`, once joined).
 * `<dxr-call>` is this as markup.
 */
export function mountCall(el: HTMLElement, opts?: CallOptions): Promise<CallHandle>;

/** The room in an invite link (or a `location`), or null — for an SPA router to read the room without mounting a call. */
export function parseInviteLink(link: string | { hash?: string; href?: string } | null | undefined): string | null;

// ── <dxr-call> — the one-line path as markup ───────────────────────────────────────────────
//
// Importing this entry (or `./call/full`, or the CDN bundle `dist/call.js`) registers the element.
// It mounts on connect (`mountCall(this, { ...attrsToOpts(this), ...this.options })`), leaves on
// disconnect (a DOM move IS a teardown — woven-canvas rule 2), re-dispatches every call event as
// a bubbling, composed `CustomEvent` named `dxr-call:<event>` with the payload in `detail`, and
// exposes the handle as `el.call`. Attributes (read once, at connect): `room`, `signaling` (a
// URL), `key`, `camera`, `layout`, `accent`, `max-peers`, `no-ui`, `ui="tiles"`, `auto-join`,
// `mono3d="off"`, `no-audio`, `no-self-view`, `no-auto-converge`, `tile-aspect`, `invite-base`,
// `browser-url`, `debug`. Everything else is `el.options`, set before connect; options win.

export class DxrCallElement extends HTMLElement {
  /** The mount seam: null = `mountCall` of `./call`; `./call/full` sets its own. */
  static mount: ((el: HTMLElement, opts?: CallOptions) => Promise<CallHandle>) | null;
  /** Non-string options (a `MediaStream`, an adapter, `lift`, a `wall`, a `theme`) — set BEFORE connecting. */
  options: CallOptions | null;
  /** The handle once mounted; null before, and again after disconnect. */
  readonly call: CallHandle | null;
  /** Resolves with the handle when the mount lands (null if the element left the DOM first); rejects if it failed. */
  readonly ready: Promise<CallHandle | null> | null;
  connectedCallback(): void;
  disconnectedCallback(): void;
}

/** The attribute → option mapping the element applies at connect. Pure; unset attributes contribute nothing. */
export function attrsToOpts(source: { getAttribute(name: string): string | null } | ((name: string) => string | null)): Partial<CallOptions>;

/**
 * Register the element (default name `dxr-call`) once. True when this call registered it; false
 * when the name was taken or there is no `customElements` registry. The entries call it for you.
 */
export function defineCallElement(name?: string, registry?: CustomElementRegistry): boolean;

/** `'dxr-call:'` — every DOM event the element dispatches starts with it. */
export const CALL_EVENT_PREFIX: 'dxr-call:';

/** The DOM events: one per {@link CallEvents} key, plus `dxr-call:ready` once the handle exists. */
export type DxrCallEventMap = { [K in keyof CallEvents as `dxr-call:${K}`]: CustomEvent<CallEvents[K]> } & {
  'dxr-call:ready': CustomEvent<{ call: CallHandle }>;
};

declare global {
  interface HTMLElementTagNameMap {
    'dxr-call': DxrCallElement;
  }
  interface HTMLElementEventMap extends DxrCallEventMap {}
}

// ── DEPRECATED (1.30 only) — the 1.29 exports that left the public surface in C2 ─────────
//
// Each is INTERNAL (RFC 0003 §2): still importable by file path from `js/call/*.js` /
// `js/camera/*.js`, kept on this entry for one release as a wrapper that `console.warn`s once,
// removed in 1.31. Do not write new code against them.

/** @deprecated internal — js/call/options.js; removed from this entry in 1.31 */
export function normalizeCallOptions(opts?: Partial<CallOptions>): Record<string, unknown>;
/** @deprecated internal — js/call/wire.js; removed in 1.31 */
export function newRoomId(getRandomValues?: (a: Uint8Array) => Uint8Array): string;
/** @deprecated internal — js/call/wire.js; removed in 1.31 */
export function isValidRoomId(room: unknown): boolean;
/** @deprecated internal — js/call/wire.js; removed in 1.31 (`handle.inviteLink()` is the API) */
export function buildInviteLink(base: string, room: string): string;
/** @deprecated internal — js/call/wire.js; removed in 1.31 (the wire is a protocol: docs/call-wire.md) */
export function normalizeHello(msg: unknown): { type: 'hello'; v: number; format: CallFormat; width: number | null; height: number | null; baselineMm: number | null; hfovDeg: number | null; rectified: boolean; sdk: string | null } | null;
/** @deprecated internal — js/call/wire.js; removed in 1.31 */
export function makeHello(o?: { format?: CallFormat; width?: number; height?: number; baselineMm?: number; hfovDeg?: number; rectified?: boolean }): object;
/** @deprecated internal — js/call/wire.js; removed in 1.31 (`CallPeer.display` is the API) */
export function routeFor(p: { format?: string | null; woven: boolean; mono3D?: 'auto' | 'off' | false | LiftFunction; lift?: boolean; overBudget?: boolean; failed?: boolean }): { route: 'woven-sbs' | 'flat-left' | 'flat' | 'lifted'; mono3d?: string };
/** @deprecated internal — js/call/wire.js; removed in 1.31 */
export function badgeFor(route: 'woven-sbs' | 'flat-left' | 'flat' | 'lifted' | null): CallDisplay;
/** @deprecated internal — js/call/wire.js; removed in 1.31 */
export function createLiveGate(o?: { need?: number; needNoPose?: number }): { feed(viewCount: number | null): boolean; readonly live: boolean };
/** @deprecated internal — js/camera/converge.js; removed in 1.31 */
export function convergenceShiftPx(p: { eyeWidthPx: number; hfovDeg?: number | null; baselineMm?: number | null; subjectZmm?: number | null }): number;
/** @deprecated internal — js/camera/converge.js; removed in 1.31 */
export function lowPass(prev: number, target: number, alpha?: number): number;
/** @deprecated internal — js/camera/converge.js; removed in 1.31 */
export function clampShift(px: number, eyeWidthPx: number, maxFraction?: number): number;
/** @deprecated internal — js/camera/geometry.js; removed in 1.31 */
export function eyeCropRect(eyeW: number, eyeH: number, aspect: number, shift: number, eye: 0 | 1): { sx: number; sy: number; sw: number; sh: number };
/** @deprecated internal — js/camera/geometry.js; removed in 1.31 (`addCameraView` of `/camera` mirrors a self view) */
export function mirrorSwapOps(W: number, H: number): Array<{ src: 'L' | 'R'; sx: number; sw: number; sy: number; sh: number; dx: number; dw: number; mirror: true }>;
/** @deprecated internal — js/camera/geometry.js; removed in 1.31 */
export function mirrorSwapPixels<T extends ArrayLike<number>>(px: T, W: number, H: number): T;
/** @deprecated internal — js/call/wire.js; removed in 1.31 */
export function maxBitrateKbps(format: CallFormat, remotePeers: number): number;
/** @deprecated internal — js/camera/disparity.js; removed in 1.31 (`autoConverge` is the behaviour) */
export function measureFocusDisparity(img: ArrayLike<number>, W: number, H: number, o?: { focus?: { x: number; y: number }; block?: number; dMin?: number; dMax?: number; dyMax?: number; minNcc?: number }): { d: number; x: number; y: number; c: number; method: 'focus' | 'mode'; blocks: number } | null;
/** @deprecated internal — js/call/sdp.js; removed in 1.31 */
export function preferVideoCodecs(sdp: string, order?: readonly string[]): string;
/** @deprecated internal — js/call/sdp.js; removed in 1.31 */
export function sortCodecCapabilities<T extends { mimeType?: string }>(codecs: T[], order?: readonly string[]): T[];
/** @deprecated internal — js/call/sdp.js; removed in 1.31 */
export const VIDEO_CODEC_ORDER: readonly string[];
/** @deprecated internal — js/call/transport.js; removed in 1.31 (an SFU adapter will get a designed Transport seam) */
export class MeshTransport {
  constructor(o: { signaling: SignalingAdapter; id: string; maxPeers?: number; iceServers?: RTCIceServer[]; RTCPeerConnection?: any; log?: (tag: string, obj: object) => void });
  readonly size: number;
}
/** @deprecated internal — js/call/transport.js; removed in 1.31 */
export function clampMaxPeers(n?: number): number;
/** @deprecated internal — js/call/qr.js; removed in 1.31 */
export function qrEncode(text: string, opts?: { ecl?: 'L' | 'M'; mask?: number }): { version: number; size: number; mask: number; modules: boolean[][] };
/** @deprecated internal — js/call/signaling.js; removed in 1.31 (documented in signaling/README.md) */
export function roomKey(room: string): Promise<string>;
/** @deprecated internal — js/call/signaling.js; removed in 1.31 */
export const SIGNAL_PROTOCOL: string;
/** @deprecated internal — js/call/wire.js; removed in 1.31 */
export const WIRE_VERSION: number;
/** @deprecated internal — js/call/wire.js; removed in 1.31 */
export const CALL_SDK: string;
/** @deprecated replaced by `theme.strings`; removed in 1.31 */
export const PLATE_TEXT: Readonly<{ unreachable: string; cameraBusy: string }>;
/** @deprecated folded into `theme.accent` (which takes the names); removed in 1.31 */
export const CALL_ACCENTS: Readonly<Record<CallAccent, string>>;
/** @deprecated internal — js/call/lift.js; removed in 1.31 */
export function normalizeMono3D(v: unknown): 'auto' | 'off' | LiftFunction;
/** @deprecated internal — js/call/lift.js; removed in 1.31 */
export function resolveLift(mono3D: 'auto' | 'off' | false | LiftFunction, o?: { importer?: () => Promise<any>; nav?: any; log?: (tag: string, o: object) => void; capsOpts?: object }): Promise<{ lift: LiftFunction | null; capabilities: ((o?: object) => Promise<any>) | null; caps: any; source: 'injected' | 'module' | 'none'; reason: string | null }>;
/** @deprecated internal — js/call/lift.js; removed in 1.31 */
export function createLiftPool(o: { lift: LiftFunction; max?: number; log?: (tag: string, o: object) => void; options?: Record<string, unknown> }): { readonly size: number; max: number; has(id: string): boolean; release(id: string): void; releaseAll(): void; [k: string]: unknown };
/** @deprecated internal — js/call/lift.js; removed in 1.31 */
export function createFrameWatch(o?: { degradedMs?: number; recoveredMs?: number; holdMs?: number; alpha?: number }): { feed(dtMs: number): 'degraded' | 'recovered' | null; reset(): void; readonly frameMs: number | null; readonly degraded: boolean };
/** @deprecated internal — js/call/lift.js; removed in 1.31 */
export function liftConvergenceFor(depth: number | null | undefined): 'auto' | number;
/** @deprecated internal — js/call/lift.js; removed in 1.31 */
export function liftPriorityFor(p: { id: string | null; speakerId: string | null; visible?: boolean }): 'high' | 'normal' | 'low' | 'paused';
/** @deprecated internal — js/call/lift.js; removed in 1.31 */
export function setLiftPriority(handle: { setPriority?(p: 'high' | 'normal' | 'low' | 'paused'): boolean } | null | undefined, level: 'high' | 'normal' | 'low' | 'paused'): boolean;
/** @deprecated internal — js/call/lift.js; removed in 1.31 */
export function defaultLiftSpecifier(base?: string): string;
/** @deprecated internal — js/call/lift.js; removed in 1.31 */
export const LIFT_PRIORITY: Readonly<{ speaker: 'high'; other: 'normal'; hidden: 'paused' }>;

// Type definitions for @displayxr/inline3d/call.
// PREVIEW tier — not covered by the 1.x semver promise. See docs/sdk-stability.md.
//
// P1 of docs/rfcs/0002-video-call.md: full-mesh WebRTC (<= 4 participants), pluggable signalling,
// side-by-side stereo from a stereo camera, convergence from `hello` + `hint`, SDK chrome or
// headless. P2a: mono peers lifted to 3D through `@displayxr/inline3d/lift` (`mono3D`).

/**
 * The `lift()` of `@displayxr/inline3d/lift`, as the call uses it: `lift(video, { mode: 'live',
 * wall, ui: 'none', convergence, priority, quality })` → a handle. Only the members below are
 * used; `setPriority` / `setConvergence` / `on` / `native` / `canvas` / `state` are optional.
 */
export interface CallLiftHandle {
  remove(): void;
  setPriority?(p: LiftStreamPriority): boolean;
  setConvergence?(x: 'auto' | number): void;
  on?(type: string, cb: (d: any) => void): () => void;
  readonly native?: boolean;
  readonly woven?: boolean;
  readonly state?: string;
  readonly canvas?: HTMLCanvasElement;
  readonly stats?: { provider?: string | null } & Record<string, unknown>;
}
export type CallLiftFunction = ((element: HTMLVideoElement, opts: Record<string, unknown> & {
  mode: 'live';
  wall: unknown;
  ui: 'none';
  convergence: 'auto' | number;
  priority: LiftStreamPriority;
}) => Promise<CallLiftHandle>) & { liftCapabilities?: (o?: { webFallback?: boolean }) => Promise<any> };

/** A lifted stream's scheduling (the native provider's per-stream priority). */
export type LiftStreamPriority = 'high' | 'normal' | 'low' | 'paused';

/** Why a mono peer is not lifted (or `'lifted'`). */
export type Mono3DReason = 'unavailable' | 'off' | 'lifted' | 'budget' | 'failed';

/** What a participant sends: a side-by-side pair (left eye left) or one flat picture. */
export type CallFormat = 'sbs' | 'mono';

/** How this page draws a remote participant (RFC §3). */
export type CallRoute = 'woven-sbs' | 'flat-left' | 'flat' | 'lifted';

/** A remote participant's connection state as the tile shows it. */
/**
 * `'unreachable'`: known to exist but no connection for ~10 s — usually a network that needs a
 * relay (TURN). Sticky until it connects; retries continue in the background.
 */
export type PeerState = 'new' | 'connecting' | 'connected' | 'reconnecting' | 'unreachable' | 'left';

/** The out-of-band 3D flag, sent on the data channel when it opens. A peer that sends none is mono. */
export interface CallHello {
  type: 'hello';
  v: number;
  format: CallFormat;
  width: number | null;
  height: number | null;
  /** Camera baseline, mm. Needed (with `hfovDeg`) for automatic convergence. */
  baselineMm: number | null;
  /** Horizontal field of view of ONE eye, degrees. */
  hfovDeg: number | null;
  /** False for a raw stereo camera (the P1 default); true only after a calibrated rectify step. */
  rectified: boolean;
  sdk: string | null;
}

export interface CallCalibration {
  baselineMm?: number;
  hfovDeg?: number;
  rectified?: boolean;
}

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
  send(to: string, data: unknown): void;
  leave(): void;
}

/**
 * The `dxr-signal/1` JSON-over-WebSocket client (protocol: signaling/README.md). `url` is your
 * server's base, e.g. `wss://signal.example.com` or `ws://localhost:8787` — the reference servers
 * are `signaling/worker.mjs` (Cloudflare) and `node signaling/dev-server.mjs`. There is no hosted
 * default yet, so the URL is required.
 */
/** The hosted DisplayXR signalling server (`dxrSignaling()` with no URL). */
export const DXR_SIGNAL_DEFAULT: string;
export function dxrSignaling(url?: string, opts?: { WebSocket?: any; pingMs?: number }): SignalingAdapter;

/**
 * DEMO ONLY — the free public PeerJS broker. No uptime guarantee and not operated by DisplayXR.
 * `Peer` defaults to `globalThis.Peer`, else the ESM build is imported from jsDelivr.
 */
export function peerjsCloud(opts?: {
  Peer?: any;
  peerOptions?: object;
  url?: string;
  /** Upper bound on the join-time wait for slots to say hello (ms, default 5000). */
  helloMs?: number;
  /** A taken slot silent this long is reported unreachable (ms, default 10000). */
  unreachableMs?: number;
  /** Background re-dial interval for silent slots (ms, default 10000). */
  retryMs?: number;
  heartbeatMs?: number;
  settleMs?: number;
}): SignalingAdapter;

export type CallAccent = 'azure' | 'violet' | 'magenta' | 'sunset' | 'amber' | 'lime' | 'mint' | 'ice';

export interface CallOptions {
  /** Default `dxrSignaling()` (the hosted DisplayXR server). Or `dxrSignaling(url)` to self-host,
   *  `peerjsCloud()` (demo only), or your own adapter. */
  signaling?: SignalingAdapter;
  /**
   * `'auto'` (default): the room in this page's `#room=` fragment, else a new one on join. Or a
   * room id / invite link. Room ids are >= 96 random bits (generated ones: 128), base64url.
   */
  room?: 'auto' | string;
  /** Overrides the server's STUN/TURN list. Default: public STUN + the server's TURN, if any. */
  iceServers?: RTCIceServer[];
  /**
   * `'auto'` (default): a device delivering > 2.5:1 frames is a stereo pair, sent as `'sbs'`;
   * otherwise the default webcam, `'mono'`. A camera held by another process (e.g. an eye
   * tracker: NotReadableError) is skipped, never fatal. `'stereo'` prefers the pair (falls back
   * to mono), `'mono'` never probes, a string is a deviceId, a MediaStream is used as given with
   * `format` declaring what it is.
   */
  camera?: 'auto' | 'stereo' | 'mono' | string | MediaStream;
  /** The format of a page-supplied `camera` stream. Default `'mono'` — 3D-ness is never guessed. */
  format?: CallFormat;
  /** Sent in `hello`; enables automatic convergence on the receivers. */
  calibration?: CallCalibration;
  /**
   * P2 seam: a calibrated rectification step for a raw stereo stream (needs the camera's
   * intrinsics/extrinsics, which come from a plug-in or the runtime). Return a rectified SBS
   * stream; the hello then says `rectified: true`. P1 ships none: the raw pair is sent.
   */
  rectify?: (stream: MediaStream, info: { width: number; height: number; deviceId: string | null; label: string }) => MediaStream | Promise<MediaStream>;
  /** Microphone (echo cancellation + noise suppression). Default true. */
  audio?: boolean;
  /**
   * Lift mono peers to 3D on a 3D display (RFC §5). `'auto'` (default): import
   * `@displayxr/inline3d/lift` lazily from this copy of the SDK, and use it when it reports a
   * native provider or a WebGPU web fallback — otherwise mono peers stay flat (one log line, no
   * error). `'off'` / `false`: flat. A function: your own `lift` (a bundled app imports
   * `lift` from `@displayxr/inline3d/lift` and passes it here). Switch at runtime with
   * `setMono3D()`.
   */
  mono3D?: 'auto' | 'off' | false | CallLiftFunction;
  /**
   * Extra `lift()` options for lifted tiles — e.g. `models` (where the depth model is served from),
   * `ort`, `quality`, `providers`. The call's own keys (`mode`, `wall`, `ui`, `convergence`,
   * `priority`) always win.
   */
  liftOptions?: Record<string, unknown>;
  /** Concurrent lifted tiles. Default 4 (= the mesh maximum); further mono peers stay flat. */
  maxLifted?: number;
  /** Participants INCLUDING you. Default 4, clamped to 2..4 (full mesh). */
  maxPeers?: number;
  /** `'grid'` (default) or `'speaker'` (the active speaker spans the row). */
  layout?: 'grid' | 'speaker';
  /** SDK chrome: lobby, invite (link + QR), bottom bar, badges, banner. Default true. */
  ui?: boolean;
  /** Join without the lobby. Default: `!ui`. */
  autoJoin?: boolean;
  /** The small self view (mirrored; a stereo self view is mirrored AND eye-swapped). Default true. */
  selfView?: boolean;
  /** Tile aspect (w/h) = the woven buffer's per-eye aspect. Default 16/9. */
  tileAspect?: number;
  /** A named accent or any CSS colour, written to `--dxr-accent`. */
  accent?: CallAccent | string;
  /** Base URL of invite links (default: this page's URL, query kept, fragment replaced). */
  inviteBase?: string;
  /** Write `#room=` into this page's URL on join (so a reload rejoins). Default: `ui`. */
  updateUrl?: boolean;
  /** Where the "View in 3D with DisplayXR Browser" banner links. */
  browserUrl?: string;
  /** Re-open the inline-3D session if it ends without the page closing it. Default true. */
  recoverSession?: boolean;
  /** Scroll the call block to the top of the viewport once, on join, so every tile (and the self
   *  view) is on screen and woven. Default true (only with `ui`). */
  scrollIntoView?: boolean;
  /** `createInline3D()` options used for that re-open. */
  wallOptions?: object;
  debug?: boolean;
  log?: (tag: string, detail: object) => void;
}

export interface CallQuality {
  in: { width: number; height: number; fps: number; codec: string | null; kbps: number | null; dropped: number; decoder: string | null } | null;
  out: { width: number; height: number; fps: number; codec: string | null; kbps: number | null; limitation: string | null; encoder: string | null } | null;
}

export interface CallPeer {
  readonly id: string;
  readonly format: CallFormat;
  readonly route: CallRoute | null;
  readonly state: PeerState;
  readonly muted: boolean;
  readonly cameraOff: boolean;
  readonly speaking: boolean;
  readonly rectified: boolean;
  readonly hello: CallHello | null;
  readonly quality: CallQuality | null;
  /** The per-eye convergence shift currently painted, source px. */
  readonly convergencePx: number;
  /** A lifted tile: whether lift is showing yet, native or web, and its current priority. */
  readonly lift: { readonly live: boolean; readonly native: boolean; readonly priority: LiftStreamPriority | null; readonly state: string | null } | null;
}

export interface CallMono3DInfo {
  readonly on: boolean;
  readonly state: 'off' | 'idle' | 'loading' | 'ready' | 'unavailable';
  /** Why it is unavailable: `'import-failed'`, `'no-lift-export'`, `'no-provider'`, `'no-webgpu'`. */
  readonly reason: string | null;
  /** From `liftCapabilities()` when the lift module has it; null when unknown. */
  readonly native: boolean | null;
  readonly provider: string | null;
  readonly lifted: number;
  readonly max: number;
  /** A lift has gone live in this call. */
  readonly proven: boolean;
}

export interface CallEvents {
  peer: { id: string };
  peerleft: { id: string; reason: string };
  format: { id: string; format: CallFormat; route: CallRoute; mono3d: Mono3DReason | null; hello: CallHello | null };
  /**
   * Per peer (`id`) every 2 s; or, with `id: null` and `lift`, when lifted tiles on the web
   * provider degrade the page's frame rate (~< 20 fps for 3 s) and when it recovers.
   */
  quality: ({ id: string } & CallQuality) | ({ id: null; in: null; out: null; lift: { degraded: boolean; frameMs: number; tiles: number } });
  speaker: { id: string | null };
  /** Codes include `'camera-busy'`, `'no-camera'`, `'unreachable'` (error.peer = the tile id), `'room-full'`, `'session-ended'`. */
  error: { code: string; message: string; error: Error | null };
  state: { id: string; state: PeerState };
  joined: { room: string; id: string };
  left: { room: string };
  session: { wall: unknown };
}

export interface CallHandle {
  readonly room: string | null;
  readonly id: string;
  readonly state: 'idle' | 'lobby' | 'joining' | 'in-call' | 'full' | 'left';
  readonly wall: unknown;
  readonly format: CallFormat | null;
  readonly muted: boolean;
  readonly depth: number;
  readonly speaker: string | null;
  /** `'busy'` = held by another app (e.g. eye tracking): the call runs audio-only until `retryCamera()`. */
  readonly camera: 'ok' | 'busy' | 'none' | 'pending';
  /** mono→3D status (see {@link CallMono3DInfo}). */
  readonly mono3D: CallMono3DInfo;
  /** Read-only snapshot of the remote participants. */
  readonly peers: ReadonlyArray<CallPeer>;
  join(): Promise<CallHandle>;
  /** `…#room=<id>` — the room rides in the fragment, which never reaches a server. Null before a room exists. */
  inviteLink(): string | null;
  /** Mute (true), unmute (false) or toggle (no argument). Returns the new state. */
  mute(on?: boolean): boolean;
  cameraOff(on?: boolean): boolean;
  setCamera(idOrStream: string | MediaStream, opts?: { format?: CallFormat }): Promise<{ format: CallFormat; width: number; height: number; label: string }>;
  /**
   * The ONE depth control, [-1, 1] (+ = push back). Stereo tiles: ± 5% of the eye width added to
   * the automatic convergence. Lifted tiles: lift's convergence (0 → `'auto'`, else 0.5 + 0.5·v).
   */
  setDepth(v: number | null): number;
  /** Try the configured camera again (e.g. after the eye tracker released it). Keeps the current one on failure. */
  retryCamera(): Promise<{ format: CallFormat; width: number; height: number; label: string }>;
  /** Send `hint {subjectZmm}` (rate-limited to 5 Hz) if the page can estimate the face distance. */
  sendHint(subjectZmm: number): boolean;
  /** Turn mono→3D on/off at runtime (no argument toggles). Off releases every lift; tiles go flat. */
  setMono3D(on?: boolean): boolean;
  leave(): void;
  on<K extends keyof CallEvents>(type: K, cb: (e: CallEvents[K]) => void): () => void;
  off<K extends keyof CallEvents>(type: K, cb: (e: CallEvents[K]) => void): void;
}

export function addCall(wall: unknown, container: HTMLElement, opts: CallOptions): Promise<CallHandle>;

// ── pure helpers (exported for tests and advanced pages) ──────────────────────────────────
export function normalizeCallOptions(opts?: Partial<CallOptions>): Record<string, unknown>;
export function newRoomId(getRandomValues?: (a: Uint8Array) => Uint8Array): string;
export function isValidRoomId(room: unknown): boolean;
export function parseInviteLink(link: string | { hash?: string; href?: string } | null | undefined): string | null;
export function buildInviteLink(base: string, room: string): string;
export function normalizeHello(msg: unknown): CallHello | null;
export function makeHello(o?: { format?: CallFormat; width?: number; height?: number; baselineMm?: number; hfovDeg?: number; rectified?: boolean }): object;
export function routeFor(p: { format?: string | null; woven: boolean; mono3D?: 'auto' | 'off' | false | CallLiftFunction; lift?: boolean; overBudget?: boolean; failed?: boolean }): { route: CallRoute; mono3d?: Mono3DReason };
export function badgeFor(route: CallRoute | null): '3D' | '2D→3D' | '2D';
export function normalizeMono3D(v: unknown): 'auto' | 'off' | CallLiftFunction;
export function resolveLift(
  mono3D: 'auto' | 'off' | false | CallLiftFunction,
  o?: { importer?: () => Promise<any>; nav?: any; log?: (tag: string, o: object) => void; capsOpts?: object },
): Promise<{ lift: CallLiftFunction | null; capabilities: ((o?: object) => Promise<any>) | null; caps: any; source: 'injected' | 'module' | 'none'; reason: string | null }>;
export function liftConvergenceFor(depth: number | null | undefined): 'auto' | number;
export function liftPriorityFor(p: { id: string | null; speakerId: string | null; visible?: boolean }): LiftStreamPriority;
/** The hook for the native provider's per-stream priority: forwards to `handle.setPriority` (no-op without one). */
export function setLiftPriority(handle: CallLiftHandle | null | undefined, level: LiftStreamPriority): boolean;
export function defaultLiftSpecifier(base?: string): string;
export const LIFT_PRIORITY: Readonly<{ speaker: 'high'; other: 'normal'; hidden: 'paused' }>;
export function createFrameWatch(o?: { degradedMs?: number; recoveredMs?: number; holdMs?: number; alpha?: number }): {
  feed(dtMs: number): 'degraded' | 'recovered' | null;
  reset(): void;
  readonly frameMs: number | null;
  readonly degraded: boolean;
};
export interface CallLiftPool {
  readonly size: number;
  max: number;
  has(id: string): boolean;
  handle(id: string): CallLiftHandle | null;
  priority(id: string): LiftStreamPriority | null;
  canAcquire(id: string): boolean;
  acquire(id: string, element: HTMLVideoElement, o?: { wall?: unknown; visible?: boolean; onError?: (e: unknown) => void }): Promise<CallLiftHandle | null>;
  release(id: string): void;
  releaseAll(): void;
  setSpeaker(id: string | null): void;
  setVisible(id: string, visible: boolean): void;
  setDepth(v: number): 'auto' | number;
  readonly anyWeb: boolean;
  list(): Array<{ id: string; priority: LiftStreamPriority | null; pending: boolean; native: boolean }>;
}
export function createLiftPool(o: { lift: CallLiftFunction; max?: number; log?: (tag: string, o: object) => void; options?: Record<string, unknown> }): CallLiftPool;
export function convergenceShiftPx(p: { eyeWidthPx: number; hfovDeg?: number | null; baselineMm?: number | null; subjectZmm?: number | null }): number;
export function lowPass(prev: number, target: number, alpha?: number): number;
export function clampShift(px: number, eyeWidthPx: number, maxFraction?: number): number;
export function eyeCropRect(eyeW: number, eyeH: number, aspect: number, shift: number, eye: 0 | 1): { sx: number; sy: number; sw: number; sh: number };
export function mirrorSwapOps(W: number, H: number): Array<{ src: 'L' | 'R'; sx: number; sw: number; sy: number; sh: number; dx: number; dw: number; mirror: true }>;
export function mirrorSwapPixels<T extends ArrayLike<number>>(px: T, W: number, H: number): T;
export function maxBitrateKbps(format: CallFormat, remotePeers: number): number;
export function preferVideoCodecs(sdp: string, order?: readonly string[]): string;
export function sortCodecCapabilities<T extends { mimeType?: string }>(codecs: T[], order?: readonly string[]): T[];
export const VIDEO_CODEC_ORDER: readonly string[];
export function clampMaxPeers(n?: number): number;
export function qrEncode(text: string, opts?: { ecl?: 'L' | 'M'; mask?: number }): { version: number; size: number; mask: number; modules: boolean[][] };
export function roomKey(room: string): Promise<string>;
export const SIGNAL_PROTOCOL: string;
export const WIRE_VERSION: number;
export const CALL_SDK: string;
export const PLATE_TEXT: Readonly<{ unreachable: string; cameraBusy: string }>;
export function createLiveGate(o?: { need?: number; needNoPose?: number }): { feed(viewCount: number | null): boolean; readonly live: boolean };
export const CALL_ACCENTS: Readonly<Record<CallAccent, string>>;
export class MeshTransport {
  constructor(o: { signaling: SignalingAdapter; id: string; maxPeers?: number; iceServers?: RTCIceServer[]; RTCPeerConnection?: any; log?: (tag: string, obj: object) => void });
  readonly size: number;
}

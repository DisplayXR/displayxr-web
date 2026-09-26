// Type definitions for @displayxr/inline3d/call.
// PREVIEW tier — not covered by the 1.x semver promise. See docs/sdk-stability.md.
//
// P1 of docs/rfcs/0002-video-call.md: full-mesh WebRTC (<= 4 participants), pluggable signalling,
// side-by-side stereo from a stereo camera, convergence from `hello` + `hint`, mono peers flat
// (the `mono3D` hook is where P2's lift() lands), SDK chrome or headless.

/** What a participant sends: a side-by-side pair (left eye left) or one flat picture. */
export type CallFormat = 'sbs' | 'mono';

/** How this page draws a remote participant (RFC §3). */
export type CallRoute = 'woven-sbs' | 'flat-left' | 'flat' | 'lifted';

/** A remote participant's connection state as the tile shows it. */
export type PeerState = 'new' | 'connecting' | 'connected' | 'reconnecting' | 'left';

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
export function dxrSignaling(url: string, opts?: { WebSocket?: any; pingMs?: number }): SignalingAdapter;

/**
 * DEMO ONLY — the free public PeerJS broker. No uptime guarantee and not operated by DisplayXR.
 * `Peer` defaults to `globalThis.Peer`, else the ESM build is imported from jsDelivr.
 */
export function peerjsCloud(opts?: { Peer?: any; peerOptions?: object; url?: string }): SignalingAdapter;

export type CallAccent = 'azure' | 'violet' | 'magenta' | 'sunset' | 'amber' | 'lime' | 'mint' | 'ice';

export interface CallOptions {
  /** Required: `dxrSignaling(url)`, `peerjsCloud()` (demo only), or your own adapter. */
  signaling: SignalingAdapter;
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
  /** Lift mono peers to 3D on a 3D display. P1: the hook exists and resolves to flat. */
  mono3D?: 'auto' | 'off';
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
}

export interface CallEvents {
  peer: { id: string };
  peerleft: { id: string; reason: string };
  format: { id: string; format: CallFormat; route: CallRoute; mono3d: 'unavailable' | 'off' | 'lifted' | null; hello: CallHello | null };
  quality: { id: string } & CallQuality;
  speaker: { id: string | null };
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
  /** Read-only snapshot of the remote participants. */
  readonly peers: ReadonlyArray<CallPeer>;
  join(): Promise<CallHandle>;
  /** `…#room=<id>` — the room rides in the fragment, which never reaches a server. Null before a room exists. */
  inviteLink(): string | null;
  /** Mute (true), unmute (false) or toggle (no argument). Returns the new state. */
  mute(on?: boolean): boolean;
  cameraOff(on?: boolean): boolean;
  setCamera(idOrStream: string | MediaStream, opts?: { format?: CallFormat }): Promise<{ format: CallFormat; width: number; height: number; label: string }>;
  /** Depth offset for every stereo tile, [-1, 1] (± 5% of the eye width), added to the automatic convergence. */
  setDepth(v: number | null): number;
  /** Send `hint {subjectZmm}` (rate-limited to 5 Hz) if the page can estimate the face distance. */
  sendHint(subjectZmm: number): boolean;
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
export function routeFor(p: { format?: string | null; woven: boolean; mono3D?: 'auto' | 'off'; lift?: boolean }): { route: CallRoute; mono3d?: 'unavailable' | 'off' | 'lifted' };
export function badgeFor(route: CallRoute | null): '3D' | '2D';
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
export const CALL_ACCENTS: Readonly<Record<CallAccent, string>>;
export class MeshTransport {
  constructor(o: { signaling: SignalingAdapter; id: string; maxPeers?: number; iceServers?: RTCIceServer[]; RTCPeerConnection?: any; log?: (tag: string, obj: object) => void });
  readonly size: number;
}

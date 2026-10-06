// Type definitions for @displayxr/inline3d/camera.
// PREVIEW tier — not covered by the 1.x semver promise. See docs/sdk-stability.md.
//
// RFC 0003 §4 (phase C2): the stereo camera as its own primitive. `openCamera` owns device
// selection and calibration, `addCameraView` is the correctly mirrored 3D self view (each half
// mirrored AND the halves swapped), `capturePhoto` / `record` produce plain side-by-side files
// with the layout in the name (`_2x1`) and the stereo record inside the file (XMP in a JPEG, a
// Tags element in a WebM — Decision 9). `/call` builds on it: `CallOptions.camera` takes a
// {@link StereoCamera}, and the call's self view is an `addCameraView`.
//
// The public surface of this file is pinned by test/api-snapshot: a change here fails `npm test`
// until the snapshot is updated in the same change (`node tools/api-surface.mjs --update`).

import type { Inline3D, Inline3DUnsupported, TileHandle } from './index.js';

/** What the camera delivers: a side-by-side pair (left eye left) or one flat picture. */
export type CameraFormat = 'sbs' | 'mono';

/**
 * Which camera to open. `'auto'` (default): a stereo device when one is present — the DisplayXR
 * Browser's "3D Camera" (recognised by its `displayxrStereo` track settings, never by its label),
 * or a device delivering wider than 2.5:1 frames — else the default webcam. `'stereo'` prefers
 * the pair and falls back to mono; `'mono'` never probes; a string is a `deviceId`; a
 * `MediaStream` is used as given, with {@link CameraOptions.format} declaring what it is.
 */
export type CameraPreference = 'auto' | 'stereo' | 'mono' | (string & {}) | MediaStream;

/** What is known about a stereo pair: from the device's own description, or from `calibration`. */
export interface StereoInfo {
  /** True only for a calibrated, rectified pair (the runtime's 3D camera says so; a raw USB pair is false). */
  readonly rectified: boolean;
  /** Camera baseline, mm, or null when unknown. */
  readonly baselineMm: number | null;
  /** Horizontal field of view of ONE eye, degrees, or null when unknown. */
  readonly horizontalFovDeg: number | null;
}

/** `baselineMm` / `horizontalFovDeg` / `rectified` the page knows about a stream the device does not describe. */
export interface CameraCalibration {
  baselineMm?: number;
  horizontalFovDeg?: number;
  rectified?: boolean;
}

export interface CameraOptions {
  /** See {@link CameraPreference}. Default `'auto'`. */
  prefer?: CameraPreference;
  /** The format of a page-supplied `MediaStream`. Default `'mono'`: 3D-ness is never guessed from a stream. */
  format?: CameraFormat;
  /** Fills {@link StereoCamera.stereo} where the device gives nothing; a page value wins over the device's. */
  calibration?: CameraCalibration;
  /**
   * A calibrated rectification step for a raw stereo stream (needs the camera's intrinsics /
   * extrinsics, from a plug-in or the runtime). Returns a rectified SBS stream; `stereo.rectified`
   * is then true. A throwing hook keeps the raw pair (`cam.rectifyError`).
   */
  rectify?: (stream: MediaStream, info: { width: number; height: number; deviceId: string | null; label: string }) => MediaStream | Promise<MediaStream>;
  /** Verbose console logging. */
  debug?: boolean;
}

/** Why {@link openCamera} rejected (`error.code`). `skipped` lists every device tried and why it was not used. */
export type CameraErrorCode = 'camera-busy' | 'permission-denied' | 'no-camera';
export interface CameraError extends Error {
  code: CameraErrorCode;
  skipped: ReadonlyArray<{ label: string; error: string; busy?: boolean; denied?: boolean }>;
}

export interface CameraEvents {
  /** The camera ended under you: revoked by the runtime, unplugged, or taken by another app. Not fired by `close()`. */
  ended: { reason: string };
}

/** A photo from {@link StereoCamera.capturePhoto}: the RAW pair (never mirrored, never shifted). */
export interface CameraPhoto {
  blob: Blob;
  /** The blob's MIME type. */
  type: string;
  /** The whole frame's size (an SBS photo is twice its eye's width). */
  width: number;
  height: number;
  layout: CameraFormat;
  /**
   * Horizontal disparity (left-eye x − right-eye x, source px) of the subject the camera converged
   * on — the face — or null when none was measured. A viewer shifts the eyes toward each other by
   * half of it each to put that subject at the display plane. Also written into a JPEG's XMP.
   */
  convergencePx: number | null;
  stereo: StereoInfo | null;
  /** `<base>_2x1.jpg` for a pair (`_2x1` = columns×rows, what `/player` reads), `<base>.jpg` for mono. */
  suggestedName: string;
  /** The XMP packet written into a JPEG (null for other types, which carry no metadata). */
  xmp: string | null;
}

export interface CapturePhotoOptions {
  /** `'image/jpeg'` (default; carries the XMP record) | `'image/png'` | `'image/webp'`. */
  type?: string;
  /** Encoder quality for lossy types. Default 0.92. */
  quality?: number;
  /** The file name's base (default `photo-<timestamp>`); the layout suffix and extension are added. */
  name?: string;
  /** Use this convergence instead of measuring the current frame. */
  convergencePx?: number;
}

export interface RecordOptions {
  /** Default: the first of `video/webm;codecs=vp9`, `…vp8`, `video/webm`, `video/mp4` this browser supports. */
  mimeType?: string;
  /** Also record a left-eye MONO copy for 2D platforms (Decision 13). Default false. */
  mono?: boolean;
  /** Audio to mix in: a `MediaStream` (its audio tracks) or one `MediaStreamTrack`. Default none. */
  audio?: MediaStream | MediaStreamTrack | null;
  videoBitsPerSecond?: number;
  /** The file name's base (default `clip-<timestamp>`). */
  name?: string;
}

/** A recording from {@link StereoCamera.record}; `stop()` resolves with the files. */
export interface CameraRecording {
  readonly state: 'inactive' | 'recording' | 'paused';
  readonly mimeType: string;
  pause(): void;
  resume(): void;
  stop(): Promise<CameraClip>;
}

export interface CameraClip {
  /** The side-by-side recording (a WebM carries the stereo record as `DXR_*` tags). */
  blob: Blob;
  type: string;
  layout: CameraFormat;
  durationMs: number;
  /** The median of the convergence measured while recording (see {@link CameraPhoto.convergencePx}). */
  convergencePx: number | null;
  stereo: StereoInfo | null;
  /** `<base>_2x1.webm` for a pair, `<base>.webm` for mono. */
  suggestedName: string;
  /** Whether the stereo record was written into the file (WebM only). */
  tagged: boolean;
  /** With `mono: true`: the left-eye copy and its name (`<base>.webm`). */
  mono?: Blob;
  monoSuggestedName?: string;
}

/** An open camera from {@link openCamera}. */
export interface StereoCamera {
  readonly format: CameraFormat;
  /** The pair's description, or null for a mono camera. */
  readonly stereo: StereoInfo | null;
  /** The MediaStream: hand it to WebRTC, a MediaRecorder, a canvas. Never mirrored. */
  readonly stream: MediaStream;
  /** The frame's size (an SBS frame is two eyes wide); {@link eyeWidth} is one eye's. */
  readonly width: number;
  readonly height: number;
  readonly eyeWidth: number;
  readonly deviceId: string | null;
  readonly label: string;
  /** True when this module opened the device (and `close()` stops it); false for a page-supplied stream. */
  readonly owned: boolean;
  /** Devices tried and not used (busy, denied, not a pair) — the clue a `'camera-busy'` report carries. */
  readonly skipped: ReadonlyArray<{ label: string; error: string; busy?: boolean; denied?: boolean }>;
  readonly state: 'live' | 'ended' | 'closed';
  /** A detached, playing `<video>` on the stream (never in the DOM); null without a document. */
  readonly video: HTMLVideoElement | null;
  /** The error a throwing `rectify` hook produced (the raw pair is used). */
  readonly rectifyError?: Error;
  capturePhoto(opts?: CapturePhotoOptions): Promise<CameraPhoto>;
  record(opts?: RecordOptions): CameraRecording;
  /** One measurement of the face's disparity in the current frame (see {@link CameraPhoto.convergencePx}), or null. */
  measureConvergence(): Promise<number | null>;
  on<K extends keyof CameraEvents>(type: K, cb: (e: CameraEvents[K]) => void): () => void;
  off<K extends keyof CameraEvents>(type: K, cb: (e: CameraEvents[K]) => void): void;
  /** Stop the camera (only tracks this module opened), remove its views. Idempotent; fires no `ended`. */
  close(): void;
}

/**
 * Open the best camera. Never rejects for a busy optional device; rejects (a {@link CameraError})
 * only when NO camera opens. `opts` may be just a {@link CameraPreference}.
 */
export function openCamera(opts?: CameraOptions | CameraPreference): Promise<StereoCamera>;

/** Is `x` a {@link StereoCamera}? Duck-typed, so two copies of the SDK interoperate. */
export function isStereoCamera(x: unknown): x is StereoCamera;

export interface CameraViewOptions {
  /** Selfie mirroring, done right for a pair (each half mirrored AND swapped). Default true. */
  mirror?: boolean;
  /** Measure the face's disparity ~5×/s and converge on it (the face at the display plane). Default false. */
  autoConverge?: boolean;
  /** [-1, 1], + = push back: an offset on top of the convergence. Default 0. */
  depth?: number;
  /** The tile's aspect (w/h) = the woven buffer's per-eye aspect. Default 16/9. */
  aspect?: number;
  /**
   * Called when the view's route changes — including when the wall says the tile will not weave
   * and the view drops to its flat left eye by itself — and when its `firstWoven` settles. Keep a
   * "3D" badge on `view.woven`, not on the wall.
   */
  onRouteChange?: (route: CameraView['route'], state: CameraViewWeaveState) => void;
}

/** What a {@link CameraView} actually shows (`view.weaveState()`), for diagnostics. */
export interface CameraViewWeaveState {
  route: 'woven-sbs' | 'flat-left' | 'flat' | null;
  woven: boolean;
  /** Why a pair on a 3D wall is flat: the tile's `firstWoven` reason (`'layer-failed'`, `'session-ended'`), else null. */
  reason: string | null;
  /** The current registration's settled `firstWoven`, `'pending'`, or null off the woven route. */
  firstWoven: { woven: boolean; confirmed: boolean; reason: string | null; ms: number } | 'pending' | null;
  /** Layer re-registrations attempted after a `'layer-failed'` (bounded; reset by a woven result). */
  layerRetries: number;
}

/** A self view from {@link addCameraView}. */
export interface CameraView {
  readonly canvas: HTMLCanvasElement;
  /** `'woven-sbs'`: 3D on the panel; `'flat-left'`: a pair shown as its left eye; `'flat'`: mono. */
  readonly route: 'woven-sbs' | 'flat-left' | 'flat' | null;
  /** On the woven route. A tile the wall will not weave drops the view flat, so this goes false with it. */
  readonly woven: boolean;
  /** Why a pair on a 3D wall is shown flat (`'layer-failed'`, `'session-ended'`), else null. */
  readonly fallbackReason: string | null;
  /** What the view actually shows, for diagnostics. */
  weaveState(): CameraViewWeaveState;
  /** The wall's tile handle while woven (its `firstWoven` settles when the tile is safe to reveal), else null. */
  readonly handle: TileHandle | null;
  readonly mirror: boolean;
  readonly autoConverge: boolean;
  readonly depth: number;
  /** The per-eye convergence shift currently painted, source px. */
  readonly convergencePx: number;
  /** The last measured disparity of the face (source px), or null. */
  readonly disparityPx: number | null;
  setDepth(v: number | null): number;
  /** No argument toggles. Returns the new state. */
  setMirror(on?: boolean): boolean;
  setAutoConverge(on?: boolean): boolean;
  /** Paint one frame now (the view paints itself every animation frame; this is for tests and tools). */
  paint(): void;
  /** Stop painting and leave the wall. The camera stays open. */
  remove(): void;
}

/**
 * Put a camera on a canvas as a self view: on a woven wall a stereo camera is a 3D tile, mirrored
 * correctly; anywhere else it is the left eye (or the mono frame), flat and mirrored. The
 * canvas's CSS box is the shape the viewer sees; it must obey the woven-canvas rules.
 */
export function addCameraView(wall: Inline3D | Inline3DUnsupported | null, canvas: HTMLCanvasElement, cam: StereoCamera, opts?: CameraViewOptions): CameraView;

/** `<base>_2x1.<ext>` for a pair, `<base>.<ext>` for mono — the name a capture suggests. Pure. */
export function suggestedName(base: string, layout: CameraFormat, type: string): string;

/** Stamped into every capture's metadata as `Software`. */
export const CAMERA_SDK: string;

/** The stereo record a capture carries (XMP `dxr:*` in a JPEG, `DXR_*` tags in a WebM). */
export interface StereoFileMeta {
  layout: CameraFormat;
  columns: number;
  rows: number;
  convergencePx: number | null;
  baselineMm: number | null;
  horizontalFovDeg: number | null;
  rectified: boolean | null;
  eyeWidth: number | null;
  eyeHeight: number | null;
  software: string | null;
}

/** Read the stereo record back from a JPEG's bytes (null when it carries none). */
export function readJpegStereoMeta(bytes: Uint8Array): StereoFileMeta | null;
/** Read the stereo record back from a WebM's bytes (null when it carries none). */
export function readWebmStereoMeta(bytes: Uint8Array): StereoFileMeta | null;
/** The raw XMP packet of a JPEG, or null. */
export function readJpegXmp(bytes: Uint8Array): string | null;
/** The stereo record in an XMP packet, or null. */
export function parseStereoXmp(xml: string): StereoFileMeta | null;

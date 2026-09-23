// Type definitions for @displayxr/inline3d/splat.
// EXPERIMENTAL — not covered by the 1.x semver promise. See docs/sdk-stability.md.

import type { SceneViewer, SubjectBounds, OrbitPose } from './viewer.js';

/**
 * The knobs behind `SplatOptions.perf`. Every one is a Spark 2.1.0 setting except `alphaRadius`,
 * which is a patch to Spark's own vertex shader (there is no option for it). Bit-exact vs lossy,
 * and the defaults each one overrides, are tabled in `js/inline3d-splat-perf.js`.
 */
export interface SplatPerfOptions {
  /** Shrink each quad to the radius where its alpha reaches `alphaFloor`. Bit-exact by default. */
  alphaRadius?: boolean;
  /**
   * The alpha each splat's tail may be cut at, PER SPLAT. Defaults to `minAlpha`, which is the
   * bit-exact cut; above it this is a lossy crop that scales with each splat's own opacity.
   */
  alphaFloor?: number;
  /** Drop splats and fragments under this alpha. Spark's default is `0.5/255`. */
  minAlpha?: number;
  /** Quad extent in σ, globally. Spark's default is `Math.sqrt(8)`. */
  maxStdDev?: number;
  /** Drop splats smaller than this, in pixels. Spark's default is 0. */
  minPixelRadius?: number;
  /** Clamp on quad size in pixels — note it SQUASHES rather than crops. Default 512. */
  maxPixelRadius?: number;
  /** 1 = Gaussian falloff, 0 = flat. Not a perf knob; 0 costs MORE. */
  falloff?: number;
  /** Build LOD data at load, so Spark can substitute merged splats against a budget. */
  lod?: boolean | 'quality';
  /** LOD budget multiplier (needs `lod`). */
  lodSplatScale?: number;
  /** Absolute LOD budget in splats (needs `lod`). */
  lodSplatCount?: number;
  /** Minimum on-screen splat size multiplier (needs `lod`); up to ~5 is often invisible. */
  lodRenderScale?: number;
  /**
   * `engine: 'playcanvas'` only — engine-native knobs, passed straight to `app.scene.gsplat`
   * (and winning over the Spark-knob mapping).
   *
   * `splatBudget` is a splat count **per tile, all views included**: every view of a tile is
   * drawn through one engine camera, so one budget covers both eyes of a 3D tile. It only acts
   * on a Streamed SOG (a flat `.sog` draws every splat). Unset on a Streamed SOG = 600k
   * (`STREAMED_SPLAT_BUDGET`); unset on anything else, or `perf: false` = the engine's 1M.
   */
  splatBudget?: number;
  /**
   * `engine: 'playcanvas'`, Streamed SOG only: how a chunk's LOD is chosen. Unset = the engine's
   * `'distance'`.
   */
  lodMode?: 'distance' | 'error';
  /** Streamed SOG only: camera travel (in the file's own units) before LOD re-evaluates. Engine default 1. */
  lodUpdateDistance?: number;
  /** Streamed SOG only: camera rotation in degrees before LOD re-evaluates. Engine default 0 (off). */
  lodUpdateAngle?: number;
  /** Streamed SOG only: how many coarser levels may stand in while a finer one streams. Engine default 0. */
  lodUnderfillLimit?: number;
  /** `engine: 'playcanvas'` only: cull splats whose quad DIAMETER is under this many px. */
  minPixelSize?: number;
  /** `engine: 'playcanvas'` only: the forward-pass alpha floor (engine default 1/255). */
  alphaClipForward?: number;
  /** `engine: 'playcanvas'` only: the engine's AA compensation, for AA-trained assets. */
  antiAlias?: boolean;
}

/**
 * The PlayCanvas backend's viewer (`engine: 'playcanvas'`): the SceneViewer pose surface without
 * three. Not field-compatible with SceneViewer — see docs/playcanvas-adapter.md.
 */
export interface PlayCanvasSplatViewer {
  idleSpin: number;
  readonly is3D: boolean;
  depthOffset: number;
  /** The engine's `AppBase`, once booted. */
  readonly app: unknown;
  fitTo(center: number[], extent: number[]): void;
  setPose(pose?: OrbitPose): void;
  getPose(opts?: { target?: boolean }): Required<OrbitPose>;
  resetPose(): void;
  getSubjectBounds(): SubjectBounds & { front: number; back: number; scale: number };
  setFocus(point: number[] | { x: number; y: number; z: number } | null, opts?: { snap?: boolean; recentre?: boolean }): PlayCanvasSplatViewer;
  getFocus(opts?: { target?: boolean }): { x: number; y: number; z: number };
}

/** Camera intrinsics for ONE eye, in pixels, OpenCV convention. */
export interface SogIntrinsics {
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  width: number;
  height: number;
}

/**
 * The `camera` block of a `.sog`'s `meta.json` (v2), plus the fields this SDK derives from it.
 * v2 is a superset of v1: everything but `convention` is optional, `intrinsics` included.
 */
export interface SogCamera {
  convention: 'opencv';
  /** Which rig the asset asks for. Null when the block does not say. */
  rig: 'camera' | 'display' | null;
  rest: { position: number[]; rotation: number[] };
  /** Null when the block carried none, or none that were usable — estimate one instead. */
  intrinsics: SogIntrinsics | null;
  stereo: { baseline_m: number } | null;
  /**
   * The point that is simultaneously the orbit centre, the pivot plane and the convergence
   * distance. In the splat's own space. The three distances are advisory.
   */
  focus: {
    point: number[];
    subject_m: number | null;
    near_m: number | null;
    far_m: number | null;
    source: string | null;
  } | null;
  /** The camera rig's ABSOLUTE scalars. Null when unstated. */
  dxr: { ipdFactor: number | null; parallaxFactor: number | null };
  /** Full vertical angle of the capture in RADIANS; null without intrinsics. */
  verticalFov: number | null;
  /** Principal point off the frame centre, fraction of the frame, y UP; null without intrinsics. */
  principalOffset: { x: number; y: number } | null;
}

/**
 * What the waterfall resolved, with the step that produced each value beside it — which is the
 * point of it. `intrinsicsSource: 'fallback-28mm'` on an asset that looks zoomed out says more
 * than any amount of staring at the picture.
 */
export interface ResolvedRig {
  type: 'camera' | 'display';
  typeSource: 'caller' | 'block' | 'block-present' | 'default';
  rest: { position: number[]; rotation: number[] };
  intrinsics: SogIntrinsics;
  intrinsicsSource: 'block' | 'caller' | 'estimated' | 'fallback-28mm';
  /** 35 mm-equivalent focal of whatever lens was resolved. */
  focalEqMm: number;
  /** The live focus, in the splat's own space. */
  focus: number[];
  /**
   * Which step answered the focus. The order: `caller` › `caller-convergence` › `block` (a
   * considered block focus) › `nearest-clump` (the nearest substantial disparity clump in the
   * central half of the frame — needs the block's or the caller's lens) › `block-cloud-median` (a
   * block focus a converter computed as a whole-cloud median) › `median-disparity` › `default`.
   */
  focusSource:
    | 'caller'
    | 'caller-convergence'
    | 'block'
    | 'nearest-clump'
    | 'block-cloud-median'
    | 'median-disparity'
    | 'default'
    | 'picked'
    | 'set';
  /** The block's own `focus.source` string (e.g. `'convergence'`, `'cloud-median'`), for diagnostics. */
  blockFocusSource: string | null;
  /** Fraction of the central crop's opacity-weighted mass the winning clump carried (`nearest-clump` only). */
  clumpMassFrac: number | null;
  /** What Space returns to. */
  focusDefault: number[];
  focusDefaultSource: string;
  /** The block's advisory distances, when it carried any. */
  focusDistances: { subject_m: number | null; near_m: number | null; far_m: number | null } | null;
  /** Focus distance along the rest camera's view axis — the zero-disparity PLANE. */
  convergence: number;
  ipdFactor: number;
  parallaxFactor: number;
}

export interface SplatOptions {
  /**
   * Which renderer. `'spark'` (the default) is three.js + Spark. `'playcanvas'` is the PlayCanvas
   * engine (optional peer `playcanvas >=2.22.3 <3`, loaded by dynamic import only when asked):
   * same handle, reads `.sog` / `.ply` / a Streamed-SOG `lod-meta.json`. Anything else throws.
   *
   * A Streamed SOG is loaded BY URL only — its `lod-meta.json`, or the directory holding it (a
   * URL ending in `/`). It is a directory of chunk files named by relative path, so bytes of a
   * `lod-meta.json` throw at call time with a message giving the URL form, and so does a streamed
   * URL with `engine: 'spark'`.
   */
  engine?: 'spark' | 'playcanvas';
  /**
   * `engine: 'playcanvas'` only: the WebGL context's `preserveDrawingBuffer` (default false) —
   * the knob for the weave's zero-copy read race on large canvases.
   */
  preserveDrawingBuffer?: boolean;
  /**
   * `engine: 'playcanvas'` only: the `playcanvas` module namespace to use instead of
   * `import('playcanvas')` — for a page that already bundles its own copy.
   */
  playcanvas?: unknown;
  /** Metres of world the tile's height spans (default 0.24). */
  virtualDisplayHeight?: number;
  /**
   * Precomputed subject bounds. Strongly preferred — bake these at conversion time, where the
   * full opacity-weighted subject detection is cheap, instead of paying for a weaker
   * approximation in the page.
   */
  frame?: SubjectBounds;
  /** Apply the 180° X flip most splat exports need (default true). */
  flipY?: boolean;
  /** Degrees/second of turntable once idle (default 8). */
  idleSpin?: number;
  /**
   * Drag + wheel. On the PlayCanvas backend the drag is TILT-AND-RELAX: measured as a fraction of
   * the canvas box from the press, it tilts up to ±`orbitMaxDeg` (a half-width swipe reaches it)
   * and relaxes back to rest on release; `idleSpin` resumes once at rest. On Spark (SceneViewer)
   * it is still the cumulative turntable (a full-width drag = 180°).
   */
  orbit?: boolean;
  /** PlayCanvas: the largest drag tilt, degrees, either axis (default 15). */
  orbitMaxDeg?: number;
  /** PlayCanvas: easing time constants, seconds — `drag` while held (0.2), `rest` after release (0.6). */
  orbitEase?: { drag?: number; rest?: number };
  fit?: 'contain' | 'height' | 'cover' | 'none';
  /** Fraction of the tile the subject may occupy (default 0.8) — width AND height. */
  margin?: number;
  /** Backstop on total depth, in display heights (default 4.0). Rarely binds. */
  depthLimit?: number;
  /**
   * Fit the horizontal against the box's DIAGONAL (width and depth) rather than width alone,
   * so a long subject still fits once the turntable turns it (default true).
   */
  fitSweep?: boolean;
  /** Per-eye buffer scale; 0.5–0.7 is usually free (default 1). */
  renderScale?: number;
  feather?: number;
  /**
   * Spark: minimum ms between splat sorts (default 16, so both eyes share one sort per frame).
   * PlayCanvas: accepted and has no effect — the engine re-sorts when the camera ROTATES, with one
   * directional sort serving every view.
   */
  sortIntervalMs?: number;
  /**
   * Cut overdraw. UNSET changes nothing — every Spark default stays where Spark put it, so an
   * existing page's pixels do not move.
   *
   * `'exact'` is the bit-exact pair — each quad shrunk to where its own alpha reaches 1/255
   * (those fragments were already being discarded), plus the 1/255 peak-opacity cull. It buys
   * little on a mostly-opaque capture, which is what a lifted photograph is. `'balanced'` (or
   * `true`, −5…−20 % measured) and `'aggressive'` (−22 %) tighten the quad extent instead, which
   * is the axis that actually pays on the web; both move pixels.
   */
  perf?: boolean | 'exact' | 'balanced' | 'aggressive' | SplatPerfOptions;
  /**
   * Which view rig. `'auto'` (the default) reads it off the ASSET — a `.sog` carrying a `camera`
   * block was lifted from a photograph and gets a camera rig that conserves the recording
   * camera; anything else is an object and gets the display rig with the auto-frame. Only
   * detectable when `src` is BYTES.
   */
  rig?: 'auto' | 'display' | 'camera';
  /**
   * Camera rig only: what gives when the canvas is not the capture's shape. `'height'` (default,
   * the 1.7 behaviour) keeps the capture's vertical extent and widens or narrows the horizontal to
   * the canvas. `'cover'` always fills the tile with photograph: a canvas WIDER than the capture
   * keeps the width and crops top/bottom (a 4:3 capture in a 16:9 tile); a narrower one is
   * `'height'`. Both backends; the 3D rig's vertical FOV follows the crop. Anything else throws.
   */
  captureFit?: 'height' | 'cover';
  /** Camera rig only: the distance in world metres that sits ON the glass. */
  convergence?: number;
  /**
   * The point to converge on and orbit about, in the splat's own space — the highest step of the
   * focus waterfall. Wins over `convergence`, which is the straight-ahead shorthand for it.
   */
  focus?: number[];
  /** Override the lens, when the asset carries none and the estimate is wrong. */
  intrinsics?: SogIntrinsics;
  /** Camera rig scalars. ABSOLUTE, never normalised against the convergence. */
  ipdFactor?: number;
  parallaxFactor?: number;
  /**
   * Bind double-click (focus what was clicked) and Space (back to the resolved focus). Default
   * true; pass false when the page owns those gestures itself.
   */
  focusInput?: boolean;
  /**
   * Disambiguates .splat from .ksplat when passing BYTES — content-sniffing cannot separate
   * those two. Unnecessary for .sog/.ply/.spz, which are identifiable by magic number.
   */
  fileName?: string;
  /**
   * Container format, when passing bytes. Usually unnecessary — the magic number is sniffed —
   * but note Spark's names are not the file extensions: a `.sog` is `pcsogszip`.
   */
  fileType?: 'ply' | 'spz' | 'splat' | 'ksplat' | 'pcsogs' | 'pcsogszip' | 'rad';
  /** Element whose visibility gates the lazy create/close lifecycle. */
  observe?: Element;
}

/** `handle.stats()` on `engine: 'playcanvas'`. */
export interface SplatStats {
  /** `'streamed'` for a `lod-meta.json`, `'flat'` for `.sog`/`.ply`, null before load. */
  kind: 'flat' | 'streamed' | null;
  /**
   * Splats the engine placed in this tile's work buffer on the LAST frame: after LOD selection
   * and the budget, before per-view frustum culling. Every view of the tile draws from this set.
   */
  resident: number;
  /** The largest `resident` seen so far. */
  peakResident: number;
  /** The tile's splat budget (all views included), or null. */
  budget: number | null;
  /** The asset's own count: every splat of a flat source, the finest level of a Streamed SOG. */
  numSplats: number;
  /** Views drawn last frame (1 in mono, the runtime's view count in 3D). */
  views: number;
  /** Streamed SOG only (null otherwise): LOD levels, chunk files, chunk files currently loaded. */
  lodLevels: number | null;
  files: number | null;
  filesLoaded: number | null;
  /**
   * `performance.now()` (ms since navigation start) of the first frame that drew a non-empty
   * set — the page's time to first splat. Null until then.
   */
  firstFrameMs: number | null;
}

/** What {@link addSplat} returns: a TileHandle plus the objects behind it. */
export interface SplatHandle {
  /**
   * SceneViewer on Spark; the PlayCanvas backend's own viewer on `engine: 'playcanvas'` (null
   * there until the backend module has loaded — one module fetch after addSplat returns).
   */
  readonly viewer: SceneViewer | PlayCanvasSplatViewer;
  /**
   * Spark's SplatMesh; on `engine: 'playcanvas'` a `{ numSplats, entity, asset, resource }`
   * record of the engine objects. Null until the asset is loaded.
   */
  readonly mesh: object;
  /** Spark's SparkRenderer (absent on `engine: 'playcanvas'`). */
  readonly spark?: object;
  /** Which backend is rendering: `'playcanvas'` or `'spark'`; null until it has loaded. */
  readonly backend: 'playcanvas' | 'spark' | null;
  /**
   * ADVANCED — not covered by the semver promise. The renderer objects behind this window, for a
   * page that wants to add its own content. Null until the backend has booted.
   *
   * PlayCanvas: `{ app, root, camera }` — the tile's `pc.AppBase`; the content root entity (the
   * splat's content space — add your own entities under it, e.g. a glTF through the engine's
   * container loader, skinned and animated included); the eye-rig camera entity. `remove()`
   * destroys the app, and everything under `root` with it.
   *
   * Spark: `{ renderer, scene, camera }` — the WebGLRenderer, the scene, and whichever camera draws
   * the current frame.
   */
  readonly engine:
    | { readonly app: unknown; readonly root: unknown; readonly camera: unknown }
    | { readonly renderer: unknown; readonly scene: unknown; readonly camera: unknown }
    | null;
  /** `engine: 'playcanvas'` only: the live focus, in the splat's own space. */
  getFocus?(opts?: { target?: boolean }): number[] | null;
  /** Bounds actually used for framing; null until `ready` resolves. */
  frame: SubjectBounds | null;
  /**
   * The `.sog`'s `camera` block — the recording camera, when the asset carries one. Null for a
   * URL source, a non-`.sog`, or an object splat (which is most of them).
   */
  camera: SogCamera | null;
  /** What the waterfall resolved, sources included. Null until `ready` resolves. */
  rig: ResolvedRig | null;
  /** The view-rig descriptor sent to the runtime, on the camera path. */
  viewRig?: object;
  /** What `perf` actually applied, or null. */
  perf: object | null;
  /** Resolves once the asset has loaded and been framed; rejects if the load failed. */
  readonly ready: Promise<SplatHandle>;

  setPose(pose?: OrbitPose): void;
  resetPose(): void;
  /**
   * Point the window at something, in the SPLAT's own space (the space the `camera` block's
   * `focus.point` is in). Null returns to whatever the waterfall resolved. Eased unless `snap`.
   */
  setFocus(
    point: number[] | { x: number; y: number; z: number } | null,
    opts?: { snap?: boolean },
  ): SplatHandle;
  /**
   * Swap the asset (URL or bytes) in place. PlayCanvas backend only — throws on Spark.
   *
   * The new file loads BEHIND the current one; then the two crossfade over `fadeMs` (0 = a cut)
   * and the old one is released. The rig waterfall re-runs for the new file (rig, lens, focus and
   * frame update; `onFocusChange` fires). The pose (yaw/pitch/zoom/depth) is kept unless
   * `resetPose`. A newer call supersedes an older one still loading. Resolves once the fade has
   * finished; rejects if the new asset cannot be loaded (the current one stays on screen).
   */
  setSource(
    src: string | Blob | ArrayBuffer | Uint8Array,
    opts?: { fadeMs?: number; resetPose?: boolean },
  ): Promise<SplatHandle>;
  /**
   * Called with the live focus (the splat's own space) whenever it moves — easing included — and
   * which waterfall step it came from. PlayCanvas backend; assign any time, even before `ready`.
   */
  onFocusChange: ((point: number[], info: { focusSource: ResolvedRig['focusSource'] | null }) => void) | null;
  /**
   * What is under a point on the canvas, in the splat's own space — the double-click's pick.
   * PlayCanvas: the nearest gaussian CENTRE to the ray over the FULL centre set (haze under 5 %
   * opacity skipped); on a Streamed SOG, over the chunks currently resident. Spark: its surface
   * raycast, falling back to the nearest centre.
   */
  pick(clientX: number, clientY: number): number[] | null;
  /**
   * `engine: 'playcanvas'` only: splat accounting for this tile. Null until the backend module
   * has loaded.
   */
  stats?(): SplatStats | null;

  /** Close this window and release its GPU resources. */
  remove(): void;
  /** Mark a 2D element painted over this window so the weave leaves it crisp. */
  exclude(el: Element): void;
  unexclude(el: Element): void;
}

/**
 * Load a splat into an inline-3D window. Safe to call with an unsupported wall — it renders a
 * flat, orbitable view instead, so pages need no branch.
 */
export function addSplat(
  wall: object | null | undefined,
  canvas: HTMLCanvasElement,
  /**
   * A URL, or the bytes themselves.
   *
   * Prefer BYTES for anything generated rather than fetched. Spark reads a splat's format from
   * the URL path, so an object URL from URL.createObjectURL() — which has no extension — fails
   * with "Unknown file type" before it fetches anything, and that reads like a corrupt asset
   * rather than a missing hint. Given bytes, Spark sniffs the magic number instead.
   */
  src: string | Blob | ArrayBuffer,
  opts?: SplatOptions,
): SplatHandle;

/** Robust model-space bounds of a loaded SplatMesh, lifted through its own matrix. */
export function measureSplatBounds(mesh: object, three?: object): SubjectBounds | null;

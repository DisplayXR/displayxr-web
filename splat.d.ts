// Type definitions for @displayxr/inline3d/splat.
// EXPERIMENTAL — not covered by the 1.x semver promise. See docs/sdk-stability.md.

import type { SceneViewer, SubjectBounds, OrbitPose } from './viewer.js';
import type { FirstWovenResult } from './index.js';

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
  /** `'setRig'` after `handle.setRig('display' | 'camera')`; the waterfall's step otherwise. */
  typeSource: 'caller' | 'block' | 'block-present' | 'default' | 'setRig';
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
    | 'set'
    | 'frame';
  /**
   * On a display rig set by `handle.setRig('display')`: what it framed, in `handle.engine.root`'s
   * space, and where that came from (the page's meshes, meshes + the shown splat, the splat alone,
   * or the caller's `frame`). Absent otherwise.
   */
  frame?: { center: number[]; extent: number[]; source: 'root' | 'root+splat' | 'splat' | 'caller' } | null;
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

/**
 * `handle.setLayerRig` / `handle.setLayerRigOptions` options — tile-wide; they MERGE across calls
 * (a key given replaces, `null` clears it back to its default). The rounding gain is
 * k = D / (metersToVirtual · viewerDistance): the photo rig's convergence distance over the
 * viewer's. docs/proposals/layer-display-rig.md.
 */
export interface SplatLayerRigOptions {
  /** Nominal viewer distance in metres (default 0.6, the browser's own nominal). */
  viewerDistance?: number | null;
  /** An explicit gain k instead (1 = exactly the photo rig; larger = rounder). */
  gain?: number | null;
  /**
   * Metres ON THE PANEL (display space), + = toward the viewer: moves the display-rig stage
   * forward by this much. The plane that lands on the glass moves back from the photo's
   * convergence plane by planeOffset·D/viewerDistance (world units). Default 0.
   */
  planeOffset?: number | null;
  /**
   * The plane that lands on the glass, as a distance from the photo's camera in world units
   * (wins over planeOffset). Default: the photo's convergence distance D.
   */
  planeDistance?: number | null;
}

/** `handle.layerRigState()`. */
export interface SplatLayerRigState {
  /** The layers on the display rig, as the page named them. */
  display: Array<string | number>;
  /** The `nolayerrig` kill switch is on (requests recorded, never applied). */
  disabled: boolean;
  /** The view path of the last drawn frame: RenderViews, the N-camera fallback, or one view. */
  path: 'renderviews' | 'ncamera' | 'mono' | null;
  /** The display-rig views were actually applied on the last drawn frame. */
  engaged: boolean;
  /** Same as `engaged` (the 1.23 name). */
  rounded: boolean;
  /** Why not engaged (or what is wrong with some layers while engaged); null when all is well. */
  reason: string | null;
  viewerDistance: number;
  /** The gain the last frame used (null off a camera rig). */
  gain: number | null;
  /** The plane that lands on the glass, as a distance from the photo's camera (world units). */
  planeM: number | null;
  /** The photo rig's convergence distance D (world units). */
  photoConvergenceM: number | null;
  planeOffset: number;
  /** The views were verified (read off the views) as located for the rig used; null if unknown. */
  located: boolean | null;
}

/** `handle.makeSbsMaterial` options. */
export interface SplatSbsMaterialOptions {
  /** How the texture holds the two eyes. Default `'sbs'` (left half = left eye). */
  format?: 'sbs' | 'tb' | 'mono';
  /** 0–1; below 1 the material alpha-blends. Default 1. */
  opacity?: number;
  /** The texture's row 0 is the image's BOTTOM (flip the sampling). Default false. */
  flipY?: boolean;
  /** Default true. */
  depthTest?: boolean;
  /** Default true. */
  depthWrite?: boolean;
  /** Back-face culling. Default false (both faces). */
  cull?: boolean;
  name?: string;
}

/** `handle.setVideo` options. */
export interface SplatVideoOptions {
  /** Stereo layout of the frame: `'sbs'` (default, left eye = left half), `'tb'` (left = top), `'mono'` (both eyes the whole frame). */
  format?: 'sbs' | 'tb' | 'mono';
  /** `'contain'` (default): the whole eye image, bars where the aspects differ. `'cover'`: the window full, the overflow cropped. */
  fit?: 'contain' | 'cover';
  /** Only `'display'`. */
  rig?: 'display';
  /** The display rig's height while the video is on (default: the tile's own `virtualDisplayHeight`). No visible effect on a flat plane at the window. */
  virtualDisplayHeight?: number;
  /** Applied to the element when given. */
  loop?: boolean;
  muted?: boolean;
  /** Default true for a URL (the SDK's own element), false for an element you pass. */
  autoplay?: boolean;
}

/** What `handle.setVideo(src)` resolves to. */
export interface SplatVideo {
  /** The element: play / pause / currentTime / duration / ended / events are the page's to drive. */
  readonly video: HTMLVideoElement;
  readonly format: 'sbs' | 'tb' | 'mono';
  readonly fit: 'contain' | 'cover';
  /** `handle.setVideo(null)`, or a no-op if another setVideo has replaced this one. */
  remove(): Promise<null>;
  /** Frames drawn with the plane up, and texture uploads (new video frames). */
  stats(): { frames: number; uploads: number };
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
   * `engine: 'playcanvas'` only. Sugar for `handle.setLayerRig(layer, 'display', opts)` on each
   * layer (a name, an id or a `pc.Layer`), applied as soon as the engine boots.
   */
  displayRigLayers?: Array<string | number | { id: number }> | ({ layers: Array<string | number | { id: number }> } & SplatLayerRigOptions);
  /**
   * `engine: 'playcanvas'` only: TRANSITION DIAGNOSTICS (#36). Off by default; `true` (or the page
   * URL's `?dxrdiag=1`) records every woven frame — its interval, whether its eye poses are
   * bit-identical to the previous frame's (a tracking HOLD), whether the transition overlay shows
   * the frozen capture — plus every `setViewRig` push with its values, long tasks, and the
   * setSource phases (`prepare`, `swap`, `window`, `settle`). It shows a small overlay (excluded
   * from the weave), logs `[dxr-diag]` console lines (one summary with a verdict per transition),
   * and exposes `window.__dxrDiag` (`copy(__dxrDiag.dump())` for the JSON).
   *
   * A string / array adds A/B kill switches (also accepted as `?dxrdiag=norig,frozen`): `'norig'`
   * keeps the rig declared before the first setSource (drops every re-declaration), `'frozen'`
   * forces `outgoing: 'frozen'`, `'nowarm'` skips the transition shader pre-warm, `'cold'` skips
   * the live outgoing pre-sort, `'nooverlay'` records without the overlay, `'oldrig'` draws the
   * views as located (no rig tracking; the live outgoing photo on the pre-1.24 chain). The option wins over the
   * URL; `false` turns it off even with `?dxrdiag` present. See docs/playcanvas-adapter.md
   * § Diagnosing transition stalls.
   */
  diag?: boolean | string | ReadonlyArray<'norig' | 'frozen' | 'nowarm' | 'cold' | 'nooverlay' | 'oldpick' | 'nolayerrig' | 'oldrig' | '1'>;
  /**
   * `engine: 'playcanvas'` only: the WebGL context's `preserveDrawingBuffer` (default false) —
   * the knob for the weave's zero-copy read race on large canvases.
   */
  preserveDrawingBuffer?: boolean;
  /**
   * `engine: 'playcanvas'` only: create the tile's WebGL context with MSAA (default false — it buys
   * nothing on alpha-blended splats). Turn it on when the page draws meshes under
   * `handle.engine.root` and wants addModel's silhouettes (addModel's context has MSAA on);
   * `setRig('display')` is then pixel-identical to an addModel tile. Fixed at context creation.
   */
  antialias?: boolean;
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
  /**
   * PlayCanvas: zoom bounds + relax, for the wheel, the two-finger pinch and `setPose`. `min` /
   * `max` clamp the zoom (defaults 0.2 / 6, the pre-1.19 range); `relax: true` eases it back to
   * rest — 1×, or the last `setPose` zoom — once the wheel has been idle 150 ms or the pinch ends,
   * with the orbit's time constant (`ease`, default 0.6 s) and a landing floor so it arrives (2×
   * is home in ≈3 s). The zoom scales the subject about the focus, which keeps its screen position
   * and its disparity. `{ min: 1, max: 2, relax: true }` is a peek that never shows the splat's edges.
   */
  zoom?: { min?: number; max?: number; relax?: boolean; ease?: number };
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
  /**
   * PlayCanvas: a FLOOR on the projection's near plane, in world units (the adapter owns the
   * projections; this only raises near, for depth precision when meshes share the scene under
   * `handle.engine.root`). Anything nearer is clipped, splats included. Unset: untouched.
   */
  nearClip?: number;
  /**
   * PlayCanvas: draw the engine's sky box (default false). Off, nothing is drawn behind the splat
   * even when a page sets `scene.envAtlas` to light its own meshes; the canvas stays transparent.
   */
  sky?: boolean;
  /** PlayCanvas: a CAP on the projection's far plane (only ever lowers it). Unset: untouched. */
  farClip?: number;
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
  /** Forwarded to the core window: see `TileOptions.firstWovenHoldMs`. */
  firstWovenHoldMs?: number;
  /**
   * Who owns the camera. `'viewer'` (the default): the SDK's orbit, idle spin, auto-fit and focus
   * gestures. `'page'` (`engine: 'playcanvas'` only; throws on Spark): the page drives the camera
   * every frame through {@link SplatHandle.setCameraPose} and the adapter keeps only the eye math —
   * the attach-pattern camera rig, the runtime's projections, the mono fallback. `fit`,
   * `virtualDisplayHeight`, `orbit`, `idleSpin`, `focusInput` (and the other framing/orbit knobs)
   * are ignored, named once in a `console.info`; `rig: 'display'` throws.
   */
  controls?: 'viewer' | 'page';
  /**
   * `controls: 'page'`: the comfort number `ipd × metersToVirtual × convergenceDiopters × 0.5` the
   * rig is built to, in (0, 1]. Default 0.3, the auto-3D shim's. `metersToVirtual = comfortDepth ·
   * d / 0.5`, so the depth budget is the same for a 10 cm subject and a 150 m castle.
   */
  comfortDepth?: number;
  /**
   * `controls: 'page'` only: called once per adapter frame — the wall's session frame in 3D, the
   * mono rAF in 2D — BEFORE anything renders. Call `handle.setCameraPose(…)` synchronously in
   * here and THIS frame renders that pose (zero lag, the attach pattern); a pose set from the
   * page's own rAF may be one frame late, since the two rAFs have no guaranteed order. A throw is
   * caught and warned once; frames keep rendering.
   */
  onBeforeFrame?: (frame: SplatFrameInfo) => void;
  /**
   * `engine: 'playcanvas'` only (throws on Spark): play a reveal on the first asset. Installed at
   * its start state before the first frame, played once `firstWoven` settles (at once in 2D) —
   * docs/splat-effects.md. A name uses that effect's defaults; an object overrides them.
   */
  reveal?: SplatRevealName | false | SplatRevealSpec;
}

/** The transition effects `reveal` accepts. */
export type SplatRevealName = 'inflate' | 'sweep' | 'dissolve' | 'fade' | SplatParticleRevealName;

/** The particle reveals: every gaussian is a particle with its own start time (docs/splat-effects.md §Particle reveals). */
export type SplatParticleRevealName = 'assemble' | 'dissolve-in' | 'converge' | 'shimmer';

/**
 * Options every particle reveal takes (plus its timing). All sizes are in PICTURE units, so the
 * look is the same on a 2 cm object and a 40 m street.
 */
export interface SplatParticleOptions {
  /**
   * What staggers the particles: `'radial'` (distance in the picture from the origin), `'depth'`
   * (near first), `'noise'` (fbm patches), `'random'`, or `'layers'` (a SHARP photo's grid order:
   * layer 0, the visible surface, then layer 1, the disocclusion fill, each outward from the
   * origin — reads `splat.index`, so it forces `scope: 'entity'`).
   */
  order?: 'radial' | 'depth' | 'noise' | 'random' | 'layers';
  /** Fraction of the duration spent launching particles, 0..0.95. */
  stagger?: number;
  /** How much of each particle's key is random, 0..1. */
  jitter?: number;
  /** A particle in flight is a dot this size (a fraction of the view width). */
  dotSize?: number;
  /** A particle grows back to its own splat over the last (1 − grow) of its flight. */
  grow?: number;
  /** In-flight alpha multiplier, 0..1. */
  flightAlpha?: number;
  /** In-flight tint, added as `color · glow`. */
  color?: [number, number, number];
  glow?: number;
  /** Size of the noise patches, per half-view-width. */
  noiseScale?: number;
  /**
   * Comfort cap: no particle is ever nearer the eyes than its home depth by more than this much
   * extra disparity, a fraction of the eye view's width (default 0.004; 0 = never nearer than
   * home; max 0.05). In 2D a nominal 64 mm-at-1.7 m separation is assumed.
   */
  maxDisparity?: number;
  /** Fade a particle over the first `vanish` of its flight (0 = off, the reveals' default; the particle transitions use ~0.3–0.45). */
  vanish?: number;
  /** Share of the gaussians drawn while in flight, 0..1 (1 = all, the reveals' default; the swarm uses 0.2). */
  density?: number;
  /** `order: 'layers'`: gaussians per layer (default 768² = 589 824, SHARP). */
  layerSize?: number;
  /** `assemble`: how far out the swarm starts (half-view-widths), its spiral (rad), its curl turbulence, how coherent its start field is (0..1), and how much of it reaches back in depth (0..1). */
  spread?: number;
  swirl?: number;
  turbulence?: number;
  coherence?: number;
  depth?: number;
  /** `dissolve-in`: the wind's lift and the random drift (half-view-widths). */
  lift?: number;
  drift?: number;
  /** `converge`: the spiral (rad) and the launch ball's radius (half-view-widths). */
  spin?: number;
  burst?: number;
  /** `shimmer`: twinkle rate (rad/s) and sparkle strength. */
  twinkle?: number;
  sparkle?: number;
}

/** Named easings; a function `(x) => y` on [0, 1] also works. */
export type SplatEasing =
  | 'linear'
  | 'easeInQuad'
  | 'easeOutQuad'
  | 'easeInOutQuad'
  | 'easeInCubic'
  | 'easeOutCubic'
  | 'easeInOutCubic'
  | 'easeInOutSine'
  | ((x: number) => number);

/**
 * Where an effect is centred: `'focus'` (the focus point), `'eyes'` (the eyes' midpoint — the
 * inflate default), a point in the splat's OWN space `[x, y, z]`, or a canvas point
 * `[clientX, clientY]` / `{ clientX, clientY }` resolved with `pick()` when the effect starts.
 * All effects are keyed on world position and time only, so both eyes agree.
 */
export type SplatEffectOrigin = 'focus' | 'eyes' | [number, number, number] | [number, number] | { clientX: number; clientY: number };

/** Options every played effect takes. */
export interface SplatEffectTiming {
  durationMs?: number;
  /** Wait this long at the start state before the clock runs. */
  holdMs?: number;
  easing?: SplatEasing;
  origin?: SplatEffectOrigin;
  /** `'in'` (default): arrive, then the effect is removed. `'out'`: leave; the end state is held until `stopEffect`. */
  direction?: 'in' | 'out';
  /** `'tile'` (default, every splat of the tile, render time) or `'entity'` (the current asset only, work buffer). */
  scope?: 'tile' | 'entity';
}

/** `reveal: { type, … }`. */
export interface SplatRevealSpec extends Omit<SplatEffectTiming, 'direction' | 'scope'> {
  type: SplatRevealName;
  [param: string]: unknown;
}

/** A custom effect's GLSL (PlayCanvas-shaped) — docs/splat-effects.md §custom. */
export interface SplatCustomEffect extends SplatEffectTiming {
  /**
   * Any of `void modifySplatCenter(inout vec3 center)`, `void modifySplatRotationScale(vec3
   * originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale)`, `void
   * modifySplatColor(vec3 center, inout vec4 color)` — world-space centres. `dxrProgress` (0..1)
   * and `dxrTime` (s) are defined; `splat.index` / `splat.uv` are the asset's own file index in
   * `scope: 'entity'`. Screen-space inputs are refused.
   */
  glsl: string;
  /** Tile scope only: `void modifySplatColor(vec2 gaussianUV, inout vec4 color)` per fragment. */
  fragmentGlsl?: string;
  /** Uniform values, set every frame; a function gets the frame time in ms. */
  uniforms?: Record<string, number | number[] | ((tMs: number) => number | number[])>;
  /** `setEffect` only: hold `dxrProgress` here (default 1). */
  progress?: number;
  /** `playEffect` only: keep the effect at its end instead of removing it. */
  hold?: boolean;
}

export type SplatEffectName = 'inflate' | 'deflate' | 'sweep' | 'dissolve' | 'fade' | SplatParticleRevealName | 'pulse' | 'grade' | 'clip' | 'custom' | `custom:${string}`;

/** `setEffect('grade', …)`. */
export interface SplatGradeParams {
  /** Stops; default 0. */
  exposure?: number;
  contrast?: number;
  saturation?: number;
  tint?: [number, number, number];
  scope?: 'tile' | 'entity';
}

/** `setEffect('clip', …)` — in the splat's own space, like setFocus. Exactly one shape. */
export interface SplatClipParams {
  box?: { min: [number, number, number]; max: [number, number, number] };
  sphere?: { center: [number, number, number]; radius: number };
  /** Keep the outside instead. */
  invert?: boolean;
  scope?: 'tile' | 'entity';
}

/** One row of `handle.effects()`. */
export interface SplatEffectState {
  name: string;
  scope: 'tile' | 'entity';
  stage: 'grade' | 'clip' | 'reveal' | 'pulse' | 'custom';
  /** Played (has a clock) vs set (held). */
  playing: boolean;
  /** Held at its start state until a gate settles (a reveal waiting for `firstWoven`). */
  waiting: boolean;
  /** 0..1, before easing. */
  progress: number;
}

/**
 * `handle.setRig('display', opts)`'s options. Every default is addModel's, so a mesh framed this
 * way renders exactly as `addModel(url, { engine: 'playcanvas' })` renders it.
 * docs/playcanvas-adapter.md §setRig.
 */
export interface SplatSetRigDisplayOptions {
  /** Default 0.24. */
  virtualDisplayHeight?: number;
  /** Default `'contain'`. */
  fit?: 'contain' | 'cover' | 'height' | 'none';
  /** Default 0.8. */
  margin?: number;
  /** Default 4. */
  depthLimit?: number;
  /** Default true. */
  fitSweep?: boolean;
  /** Idle turntable, °/s after 2.5 s without input. Default 8 (addModel's); 0 for a still product. */
  idleSpin?: number;
  /** On the declared display rig. Default 1 each. */
  ipdFactor?: number;
  parallaxFactor?: number;
  perspectiveFactor?: number;
  /**
   * The eye camera's tone mapping WHILE THE SPLAT IS HIDDEN (the splat's display-referred colours
   * keep `'none'` whenever it is shown). Default: the environment's own — `'neutral'` (Khronos PBR
   * Neutral) for `environment: 'neutral'`, `'none'` (three's) for `environment: 'room'`.
   */
  toneMapping?: 'none' | 'linear' | 'neutral' | 'aces' | 'aces2' | 'filmic' | 'hejl';
  /**
   * addModel's IBL of the same name, installed when the scene has no `envAtlas` of its own and
   * removed again when the rig switches away (a page that lights its own meshes is never touched):
   * `'neutral'` (default) the Sample-Viewer-matched studio; `'room'` three's RoomEnvironment (the
   * look `addModel(…, { engine: 'three', environment: 'room' })` gives), with tone mapping
   * `'none'` unless `toneMapping` is passed; `'none'` installs nothing. (Through 1.16 `'room'` was
   * the default and an alias of `'neutral'`.) A transmissive glTF under root (KHR_materials_
   * transmission) also gets the scene-colour grab pass while the display rig is active.
   */
  environment?: 'room' | 'neutral' | 'none';
  /**
   * Frame THIS box (in `handle.engine.root`'s space) instead of measuring. Default: the enabled
   * meshes under root (+ the splat's box when it is shown); with no meshes, the splat itself.
   */
  frame?: { center: number[] | { x: number; y: number; z: number }; extent: number[] | { x: number; y: number; z: number } };
}

/** `setSource`'s options. */
export interface SplatSourceOptions {
  /** > 0 = a crossfade of this length (the 1.10 option; same as `transition: 'crossfade'`). */
  fadeMs?: number;
  resetPose?: boolean;
  /**
   * `'cut'` (default), `'crossfade'` (images lerp, see setSource), `'flip'` (the old photo
   * flattens to its convergence plane — zero disparity — the swap happens there, the new one
   * inflates out of its own; default 2200 ms), `'wavefront'` (a soft front crosses left → right
   * with a thin depth ridge riding it; default 2000 ms, ease-in-out; falls back to the crossfade
   * in a hidden tab). For photo slideshows: `crossfade` or `wavefront`.
   *
   * The particle transitions (docs/splat-effects.md §Particle transitions): `'swarm'` (the old
   * photo disperses into a curl-noise swarm while the new one assembles out of one), `'burst'`
   * (the old one collapses into its focus, the new one bursts out of its own), `'shimmer-cross'`
   * (nothing moves: twinkling points out, twinkling points in) and `'dust'` (drifting dust out,
   * gathering dust in). 2.6–2.8 s, linear shared clock (each particle eases itself). The old
   * photo is live, in 2D too; a hidden tab gets the crossfade.
   *
   * The SEQUENCE transitions (docs/splat-effects.md §Sequence transitions): ONE photo at a time.
   * `'reassemble'` disperses the current photo (`assemble` backwards), releases it, loads the next
   * one and assembles it (3000 ms: 45 % out, a 10 % empty beat, 45 % in). The general form
   * `{ type: 'sequence', out, in }` runs any two of `assemble`, `dissolve-in`, `converge`,
   * `shimmer`, `sweep`, `fade`. No second camera, overlay or capture: the eye camera renders every
   * frame.
   */
  transition?: 'cut' | 'crossfade' | 'flip' | 'wavefront' | SplatParticleTransitionName | 'reassemble' | SplatSequenceTransition;
  /** Sequence transitions: the empty beat between out and in, a fraction of `durationMs`, 0..0.9 (default 0.1). */
  beat?: number;
  durationMs?: number;
  easing?: SplatEasing;
  /** `cut`/`crossfade` only: reveal the INCOMING asset (entity scope) while the old one fades. */
  reveal?: SplatRevealName | false | SplatRevealSpec;
  /** `wavefront`: the soft band, a fraction of the picture width (default 0.18). */
  band?: number;
  /** `wavefront`: the ridge's pull toward the eyes, world units (default 0.03 — 3 cm on a metric photo). */
  ridge?: number;
  /** `wavefront`: the ridge's disparity cap, a fraction of the eye view's width (default 0.004, max 0.05). */
  ridgeMaxDisparity?: number;
  /**
   * `crossfade` / `wavefront`: how the OUTGOING photo is shown during the window.
   * `'live'` (the default in a woven 3D session): it stays resident and keeps rendering every frame
   * through the same eye views (head motion included) into its own target, blended per eye with
   * the live incoming one — about 2× draw for the window, both assets resident. `'frozen'` (the
   * default in 2D): its last frame, frozen into a texture (1.12.1); one draw, but no head parallax
   * on the outgoing photo — on a tracked panel it reads as tracking pausing. Engine builds without
   * the single-camera RenderView path always use `'frozen'`.
   */
  outgoing?: 'live' | 'frozen';
  /** Particle transitions: particle options for BOTH photos (the shared ones of the particle reveals). */
  order?: SplatParticleOptions['order'];
  stagger?: number;
  jitter?: number;
  maxDisparity?: number;
  dotSize?: number;
  noiseScale?: number;
  layerSize?: number;
  origin?: SplatEffectOrigin;
  /** Particle transitions: how much of the clock the two photos' spans share, 0..1 (0 = one after the other). */
  overlap?: number;
  /** Particle and sequence transitions: option overrides for the OUTGOING photo's effect. */
  outgoingFx?: SplatParticleOptions & Record<string, unknown>;
  /** Particle and sequence transitions: option overrides for the INCOMING photo's effect. */
  incomingFx?: SplatParticleOptions & Record<string, unknown>;
}

/**
 * `prepareSource`'s options: the `setSource` options the prepared asset will be swapped in with.
 * For a particle transition, its shaders are compiled and linked NOW, in the dwell — otherwise the
 * first transition of each kind in a page blocks its first frame on the link (tens of ms, hundreds
 * the first time a machine sees the variant). Validated like setSource's.
 */
export type SplatPrepareOptions = SplatSourceOptions & {
  /**
   * Sequence transitions only. Default false: the prepare only FETCHES the file's bytes, so one
   * splat stays resident and the decode + upload run at the swap, in the empty beat. `true`: the
   * full prepare (decoded and uploaded now, not in the scene) — no load at the swap, two assets
   * resident during the dwell.
   */
  resident?: boolean;
};

/** setSource's particle transitions (docs/splat-effects.md §Particle transitions). */
export type SplatParticleTransitionName = 'swarm' | 'burst' | 'shimmer-cross' | 'dust';

/** The reveals a sequence transition can run (each draws nothing at its start). */
export type SplatSequenceRevealName = 'assemble' | 'dissolve-in' | 'converge' | 'shimmer' | 'sweep' | 'fade';

/**
 * setSource's general SEQUENCE transition: `out` backwards on the current photo, the swap, `in`
 * forwards on the next. `durationMs` / `beat` / `easing` here or at the top level of the options
 * (the top level wins).
 */
export interface SplatSequenceTransition {
  type: 'sequence';
  out: SplatSequenceRevealName;
  in: SplatSequenceRevealName;
  durationMs?: number;
  beat?: number;
  easing?: SplatEasing;
}

/**
 * What `prepareSource()` resolves to: an opaque, single-use handle for `setSource`. The asset is
 * fully resident (GPU textures + the engine's centre array) until used or disposed — except for a
 * sequence transition (`prepareSource(src, { transition: 'reassemble' })`), whose prepare only
 * fetches the file's bytes: nothing reaches the engine until the swap.
 */
export interface SplatPreparedSource {
  /** The asset's own count (every splat of a flat source); null for a fetch-only (sequence) prepare. */
  readonly numSplats: number | null;
  /** `'ready'` until `setSource` uses it (`'used'`) or `dispose()` drops it (`'disposed'`). */
  readonly state: 'ready' | 'used' | 'disposed';
  /** Release the prepared asset (no-op once used or disposed). */
  dispose(): void;
}

/** What `onBeforeFrame` receives. */
export interface SplatFrameInfo {
  /** `performance.now()` at the call. */
  time: number;
  /** The runtime's view list in 3D (valid only inside the call — copy what you keep); null in mono. */
  views: readonly XRView[] | null;
  /** Seconds since the previous call (0 on the first; capped at 0.1). */
  dt: number;
}

/** A page camera, as `setCameraPose` takes it and `getCameraPose` returns it. */
export interface SplatCameraPose {
  /**
   * Column-major world matrix of the page camera in the SPLAT's own space (the space of the camera
   * block's `rest`), three.js convention: looks down −Z, +Y up. Rotation + translation + at most a
   * UNIFORM scale (a page whose world scales the splat passes `inv(splatWorld) · camera.matrixWorld`;
   * the scale is how page units reach the adapter). The adapter applies its own OpenCV → engine flip.
   */
  matrixWorld: Float32Array;
  /** Full vertical field of view, degrees. */
  verticalFovDeg: number;
  /** Page units. Default 0.001. A floor on every projection's near (depth mapping only). */
  near: number;
  /** Page units. Default 5000. A cap on every projection's far. */
  far: number;
  /**
   * Zero-disparity distance along the view axis, page units; null = the adapter's own (the focus
   * waterfall's, fixed until `setFocus` / `setSource`).
   */
  convergence: number | null;
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

  /** Throws on `controls: 'page'` (the page owns the camera). */
  setPose(pose?: OrbitPose): void;
  /** Throws on `controls: 'page'`. */
  resetPose(): void;
  /**
   * `controls: 'page'` only (throws otherwise): the camera for the next frame drawn — call it every
   * frame you render, ideally inside `onBeforeFrame`. Last call wins; a page that stops calling
   * keeps its last pose. Throws synchronously on a malformed matrix or lens.
   */
  setCameraPose(
    matrixWorld: ArrayLike<number>,
    opts: { verticalFovDeg: number; near?: number; far?: number; convergence?: number },
  ): SplatHandle;
  /** The last pose the page set (a copy), or null before the first `setCameraPose`. */
  getCameraPose(): SplatCameraPose | null;
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
   * The new file loads BEHIND the current one (or pass a `prepareSource()` result: no load at all
   * on this path); then the two crossfade over `fadeMs` (0 = a cut) and the old one is released.
   * The crossfade blends the two IMAGES linearly, per eye, so the mix is exactly `t` whatever the
   * two photos' depth order. The old image is LIVE in a woven 3D session (it keeps rendering with
   * head motion; `outgoing: 'frozen'` restores the 1.12.1 frozen last frame, the 2D default). The
   * end state is exactly a plain swap. The rig waterfall re-runs for the new file (rig, lens, focus and
   * frame update; `onFocusChange` fires). The pose (yaw/pitch/zoom/depth) is kept unless
   * `resetPose`. A newer call supersedes an older one still loading. Resolves once the fade has
   * finished; rejects if the new asset cannot be loaded (the current one stays on screen).
   */
  setSource(src: string | Blob | ArrayBuffer | Uint8Array | SplatPreparedSource, opts?: SplatSourceOptions): Promise<SplatHandle>;
  /**
   * PlayCanvas backend only — throws on Spark. Fetch, decode and upload `src` now, in the
   * background (the SDK's own passes in idle periods; the engine's end-of-load unpack runs when
   * it must), without rendering it. `setSource(prepared, opts)` then starts on the next frame with
   * no load on the transition path. Single use; `dispose()` it if the page changes its mind.
   * Memory: two full assets resident until the swap (≈ +70 MB of GPU textures per 1.18M-gaussian
   * SOG). `remove()` disposes any still unused.
   */
  prepareSource(src: string | Blob | ArrayBuffer | Uint8Array, opts?: SplatPrepareOptions): Promise<SplatPreparedSource>;
  /**
   * PlayCanvas backend only — throws on Spark, and with `controls:'page'` (the page's camera IS
   * the rig). Switch the rig live, on the next frame: no remount, no reload, no new session.
   *
   * `'display'` frames the page's meshes under `handle.engine.root` (+ the splat when shown) on
   * addModel's defaults and declares a display rig; `'camera'` returns to the asset's capture rig,
   * re-resolved from the waterfall's own inputs (lens, captureFit, focus rung); `'auto'` is what
   * the load resolved. The pose resets to the new rig's rest; the declared view rig switches with
   * it; the choice is sticky across `setSource` until `'auto'`. A clean cut (no eased transition).
   * `handle.rig.typeSource` reads `'setRig'`. Resolves once applied. docs/playcanvas-adapter.md §setRig.
   */
  setRig(type: 'display', opts?: SplatSetRigDisplayOptions): Promise<SplatHandle>;
  setRig(type: 'camera' | 'auto'): Promise<SplatHandle>;
  /**
   * PlayCanvas backend only — throws on Spark, and with `controls:'page'`. Play a stereo video ON
   * this handle: no new canvas, layer or session (docs/playcanvas-adapter.md §setVideo). The splat
   * is hidden and a screen-locked plane on the display rig shows the video, sized to its per-eye
   * aspect by `fit`; each eye samples only its own half (`'sbs'`: left/right, `'tb'`: top/bottom).
   * Not woven (the mono path): the LEFT half at the full buffer resolution. The texture is
   * re-uploaded only when the video presents a new frame (requestVideoFrameCallback).
   *
   * Applies on the first frame the video has; resolves to a {@link SplatVideo}. The page drives
   * transport through `v.video`. A URL makes an SDK-owned `<video>` (autoplays unless
   * `autoplay: false`; muted automatically if the browser refuses sound without a gesture); an
   * element you pass stays yours (the SDK never plays or pauses it unless `autoplay: true`).
   * `setVideo(null)` exits and restores the splat's visibility, the pose, the lens and the declared
   * view rig exactly as they were. A second setVideo replaces the video and keeps the pre-video
   * state. Throws during an in-flight `setSource`; while a video is on, `setSource` rejects and
   * `setRig` throws (`setVideo(null)` first). `prepareSource` stays available.
   */
  setVideo(src: string | HTMLVideoElement, opts?: SplatVideoOptions): Promise<SplatVideo>;
  setVideo(src: null): Promise<null>;
  /**
   * `engine: 'playcanvas'` only (throws on Spark). Draw `layer` (a name, an id or a `pc.Layer` of
   * `handle.engine.app`) through the DISPLAY rig — round, physical-depth stage objects — while the
   * splat and the view rig declared to the runtime stay on the photo's camera rig; `'camera'` puts
   * it back. One extra camera over the named layers, into the same target, in composition order;
   * the photo's projection matrices are used verbatim and the views are right-multiplied by the
   * shear that fixes the photo's convergence plane (so a z = 0 contact point never moves).
   * Identity in mono / the 2D tier, on a display rig (`setRig('display')`, `setVideo`), and under
   * `?dxrdiag=nolayerrig`. Callable before `ready`. docs/proposals/layer-display-rig.md.
   */
  setLayerRig(layer: string | number | { id: number }, rig: 'display' | 'camera', opts?: SplatLayerRigOptions): SplatHandle;
  /**
   * `engine: 'playcanvas'` only. Change the per-eye buffer scale live (the `renderScale` option),
   * in (0, 4]; the backing store is resized on the next animation frame. Throws a RangeError
   * otherwise.
   */
  setRenderScale(scale: number): SplatHandle;
  /** `engine: 'playcanvas'` only. The current per-eye buffer scale. */
  readonly renderScale: number;
  /** `engine: 'playcanvas'` only. Change the layer rig's tile-wide options live (merge; `null` clears). */
  setLayerRigOptions(opts: SplatLayerRigOptions): SplatHandle;
  /**
   * `engine: 'playcanvas'` only. What `setLayerRig` is doing — engaged or not, on which view path,
   * and why not. The same line is WARNed on the first 3D frame and on every change.
   */
  layerRigState(): SplatLayerRigState;
  /**
   * `engine: 'playcanvas'` only, after `ready`. An unlit `pc.ShaderMaterial` that shows the left
   * half of `texture` to left-eye views and the right half to right-eye views (`format`), on any
   * mesh — mono / the 2D tier / a 1-view mode: the left half. The eye is picked from the scene-wide
   * uniform `dxr_eye_split` the SDK sets every draw (declare it in your own shader to do the same).
   * Nothing is decoded: the page uploads its one `<video>` into `texture`.
   */
  makeSbsMaterial(texture: unknown, opts?: SplatSbsMaterialOptions): unknown;
  /**
   * `engine: 'playcanvas'` only (throws on Spark). Play a transition/pulse/custom effect;
   * validated at the call, run once the first asset is on screen. Resolves `{ finished }` —
   * false when stopped or replaced. docs/splat-effects.md.
   */
  playEffect(name: SplatParticleRevealName, opts?: Omit<SplatEffectTiming, 'direction'> & SplatParticleOptions): Promise<{ finished: boolean }>;
  playEffect(
    name: Exclude<SplatEffectName, 'grade' | 'clip'>,
    opts?: SplatEffectTiming & Record<string, unknown>,
  ): Promise<{ finished: boolean }>;
  /**
   * `engine: 'playcanvas'` only. Set a persistent effect (`grade`, `clip`, `custom`), hold a
   * transition at `{ progress }`, or pass `null` to remove it (the exact baseline).
   */
  setEffect(name: 'grade', params: SplatGradeParams | null): SplatHandle;
  setEffect(name: 'clip', params: SplatClipParams | null): SplatHandle;
  setEffect(name: 'custom' | `custom:${string}`, params: SplatCustomEffect | null): SplatHandle;
  setEffect(name: SplatEffectName, params: (SplatEffectTiming & { progress?: number } & Record<string, unknown>) | null): SplatHandle;
  /** Stop one effect (all with no name): `finish: true` jumps to its end state, else removes it. */
  stopEffect(name?: SplatEffectName, opts?: { finish?: boolean }): SplatHandle;
  /** What is on right now. */
  effects(): SplatEffectState[];
  /**
   * Called with the live focus (the splat's own space) whenever it moves — easing included — and
   * which waterfall step it came from. PlayCanvas backend; assign any time, even before `ready`.
   */
  onFocusChange: ((point: number[], info: { focusSource: ResolvedRig['focusSource'] | null }) => void) | null;
  /**
   * What is under a point on the canvas, in the splat's own space — the double-click's pick.
   * PlayCanvas: the nearest gaussian CENTRE to the ray over the FULL centre set (haze under 5 %
   * opacity skipped); on a Streamed SOG, over the chunks currently resident. Spark: its surface
   * raycast, falling back to the nearest centre. PlayCanvas: a BURST of picks from one view (the
   * same frame) builds a pick index at the second one, so N picks cost about three full scans, not
   * N; the answer is the full scan's, exactly.
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
  /**
   * The core window's `TileHandle.firstWoven`: when it is safe to reveal the canvas. Resolves
   * `{ woven: false, reason: 'unsupported' }` at once where there is no inline-3D session.
   */
  readonly firstWoven: Promise<FirstWovenResult>;
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

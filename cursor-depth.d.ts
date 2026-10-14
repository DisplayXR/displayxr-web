// Type definitions for @displayxr/inline3d/cursor-depth — the depth-aware cursor's placement
// maths, dependency-free. A port of the runtime's u_cursor_depth (ADR-046, XR_DXR_cursor_depth):
// same geometry, same defaults, same numbers. For three.js, ./three's `DepthCursor` wires it up.
//
// The policy (ADR-046 Amendment 2), the same for every DisplayXR depth cursor: never behind the
// glass (`cursorTarget`), margin 0.015 eye baselines, drawn only past the draw threshold
// (`cursorShouldDraw`; otherwise the OS cursor is the cursor), the classic arrow at the OS cursor's
// size (`CURSOR_ARROW`, `cursorArrowMesh`, `cursorDefaultHeight`).

/** A view as an XRView carries it: column-major projection + transform matrices. */
export interface CursorView {
  projectionMatrix: ArrayLike<number>;
  transformMatrix: ArrayLike<number>;
}

/** Placement policy. Disparities in eye-baseline units (0 = on the glass, < 0 = in front); times in seconds. */
export interface CursorTuning {
  margin: number;
  minDisparity: number;
  /** Never above 0 in effect: `cursorTarget` never puts the cursor behind the glass, whatever this says. */
  maxDisparity: number;
  riseTau: number;
  sinkTau: number;
  stale: number;
}

/** The defaults: margin 0.015 (~1 mm at a 63–65 mm IPD), clamp [−0.6, 0], rise 30 ms, sink 250 ms, stale 0.5 s. */
export const CURSOR_DEFAULT_TUNING: Readonly<CursorTuning>;
/** Fallback sprite height, as a fraction of the canvas height (0.03), when the canvas's on-page size is unknown. */
export const CURSOR_DEFAULT_HEIGHT: number;
/** The OS arrow's height in CSS px (19): the drawn arrow's default size. */
export const CURSOR_ARROW_CSS_PX: number;
/** The default sprite height for a canvas `cssHeight` CSS px tall: 19 CSS px of it (capped at 0.5); the fallback when unknown. */
export function cursorDefaultHeight(cssHeight: number): number;
/** The draw threshold, eye-baseline units (−0.005): drawn only at or below it. */
export const CURSOR_DRAW_THRESHOLD: number;
/** …and only at ≥ this many panel pixels of on-screen disparity (0.5), where pixels are knowable. */
export const CURSOR_DRAW_MIN_PX: number;
/** Draw at this filtered disparity? `pxPerBaseline`: panel px of on-screen disparity per baseline unit, when known. */
export function cursorShouldDraw(disparity: number, pxPerBaseline?: number | null): boolean;

/** The cursor's line of sight for one frame. */
export interface CursorGeometry {
  eye: number[];
  canvasPoint: number[];
  forward: number[];
  eyeToCanvas: number;
  canvasHeight: number;
  /** The display plane's unit axes: draw the sprite in its X/Y plane, facing +Z. */
  basis: { x: number[]; y: number[]; z: number[] };
}

/** The ray from a view through canvas point (u, v) (`[0,1]²`, origin top-left, v down). */
export function cursorViewRay(view: CursorView, u: number, v: number): { origin: number[]; direction: number[] };
/** Solve the line of sight from two views (the outermost pair); null when degenerate (2D, off-canvas). */
export function solveCursorGeometry(viewA: CursorView, viewB: CursorView, u: number, v: number): CursorGeometry | null;
/** A point's disparity; null when it is not in front of the eye. */
export function cursorPointDisparity(g: CursorGeometry, point: ArrayLike<number>): number | null;
/** The policy: `d < 0 ? max(d − margin, minDisparity) : 0` — never behind the glass; 0 with nothing under the cursor. */
export function cursorTarget(tuning: CursorTuning, hasContent: boolean, contentDisparity: number): number;
/** Advance a filter (`{}` to start; the first step snaps) toward `target` at `nowSec`. */
export function cursorFilterStep(filter: object, tuning: CursorTuning, target: number, nowSec: number): number;
/** Where to draw a sprite at `disparity`, and how tall. */
export function placeCursor(g: CursorGeometry, disparity: number, heightFraction: number): { position: number[]; height: number };

/**
 * Where along the cursor's depth the sprite goes.
 * - `'hybrid'` (default): on the line of sight while the pointer MOVES (exactly over it), and
 *   fixed relative to the DISPLAY while it is still, so it parallaxes with the content as the head
 *   moves. Anchored in the display's frame, not the scene's: a rig that orbits, pans or zooms
 *   (an idle spin, a damped drag, a scripted camera) does not move a still cursor off the pointer.
 * - `'screen'`: always on the line of sight. Never parallaxes; on a head-tracked display it can
 *   read as "at the glass".
 * - `'world'`: always straight in front of the pointer's canvas point. Parallaxes; drifts ~mm off
 *   the pointer from an off-axis viewer.
 */
export type CursorAnchorMode = 'hybrid' | 'screen' | 'world';
export const CURSOR_ANCHOR_MODES: readonly CursorAnchorMode[];

/** `cursor: { … }` on ./model and ./splat (an object also means `'depth'`). */
export interface CursorOptions {
  /** Sprite height as a fraction of the canvas height (default: the OS arrow's 19 CSS px of the canvas). */
  height?: number;
  /** How far in front of out-of-screen content it floats, in eye-baseline units (default 0.015). */
  margin?: number;
  /** Default `'hybrid'`. */
  anchor?: CursorAnchorMode;
  /** `'window'`: keep the cursor over DOM layered on the canvas, and hide the CSS cursor page-wide meanwhile. Default `'canvas'`. */
  pointerScope?: 'canvas' | 'window';
  /**
   * Diagnostics, off by default and free when off. `true`: log the cursor's per-frame cost
   * (update ms, rays a frame, frame interval, pointer-sample age) as rolling stats, at most once a
   * second. `'both'`: that, and the OS cursor stays visible beside the sprite, for filming the lag
   * between them on a panel. three.js backend (./model `engine: 'three'`, ./splat on Spark).
   */
  debug?: boolean | 'both';
  /** Crosstalk softening of the lifted arrow (runtime ADR-046 Amendment 2 §B.7). Default `'both'`. */
  soften?: CursorSoftenOption;
  /** The sprite. Default `'auto'`: mirror the page's CSS cursor under the pointer (`grab` → the open hand, …). */
  shape?: CursorShapeOption;
  /** Per-frame override while the sprite draws: a shape name, or nothing for `shape`'s answer. */
  shapeFor?: (hit: CursorShapeHit) => CursorShape | 'none' | 'auto' | null | undefined;
}
export const CURSOR_OPTION_KEYS: readonly (keyof CursorOptions)[];
/** `cursor` as ./model and ./splat accept it: null = off; throws on a bad value. */
export function resolveCursorOption(opt: unknown, who?: string): CursorOptions | null;

/** A ring of 9 canvas-normalised points: (u, v) and 8 around it at 0.75 × height. */
export function cursorFootprint(u: number, v: number, height: number, aspect: number): Array<[number, number]>;
/** What the arrow covers: its tip (the hotspot) first, then a ring around its body (down-right of the tip). */
export function cursorArrowFootprint(u: number, v: number, height: number, aspect: number): Array<[number, number]>;
/** The classic arrow's outline polygon (12 × 19 px normalised): unit = its height, x right, y DOWN, the tip = the hotspot at (0, 0). */
export const CURSOR_ARROW: ReadonlyArray<readonly [number, number]>;
/** Its white fill: the outline inset by one px of 19. */
export const CURSOR_ARROW_FILL: ReadonlyArray<readonly [number, number]>;
/** CURSOR_ARROW (or `poly`) inset by `d`, in units of its height. */
export function cursorArrowInset(d: number, poly?: ReadonlyArray<readonly [number, number]>): Array<[number, number]>;
/** White, and the dark outline (RGBA, 0..1). */
export const CURSOR_FILL_COLOR: readonly number[];
export const CURSOR_OUTLINE_COLOR: readonly number[];
/** The arrow as a 3D mesh in its XY plane (y UP, tip at the origin, unit = sprite height): outline then fill, non-indexed triangles. */
export function cursorArrowMesh(
  fill?: readonly number[],
  outline?: readonly number[],
): { positions: Float32Array; colors: Float32Array; count: number };
/** @deprecated The crosshair is retired (ADR-046 Amendment 2); use `cursorArrowMesh`. Removed in 2.0. */
export function cursorCrosshairMesh(
  fill?: readonly number[],
  outline?: readonly number[],
): { positions: Float32Array; colors: Float32Array; count: number };
/** Column-major model matrix placing the unit sprite (tip at its origin) for a placement. */
export function cursorModelMatrix(placement: CursorPlacement, out?: number[]): number[];

/** One frame's placement. `position`/`basis` are in the views' space; null when not solved. */
export interface CursorPlacement {
  /** Draw the sprite this frame (the policy's draw threshold). False on the plane: the OS cursor is the cursor. */
  active: boolean;
  /** The geometry solved (two views, pointer on the canvas): position/basis/height are filled even when not drawn. */
  solved?: boolean;
  /** Panel px of on-screen disparity per baseline unit, when `canvasPx` was given. */
  pxPerBaseline?: number | null;
  position: number[] | null;
  basis: { x: number[]; y: number[]; z: number[] } | null;
  height: number;
  disparity: number;
  targetDisparity: number;
  /** Hybrid: true while the pointer is still and the sprite is held world-fixed. */
  anchored?: boolean;
}

/** The whole pipeline with its filter state: one per cursor. Inactive with fewer than two views. */
export class CursorDepthPlacer {
  constructor(tuning?: CursorTuning, opts?: { anchor?: CursorAnchorMode });
  update(
    views: ArrayLike<CursorView | XRView>,
    hint: {
      /** Canvas-normalised pointer, v down. */
      u: number;
      v: number;
      /** Nearest content point under the cursor FOOTPRINT, in the views' space; null = nothing. */
      nearestPoint: ArrayLike<number> | null;
      /** Sprite height as a fraction of the canvas height (default 0.03; see `cursorDefaultHeight`). */
      cursorHeight?: number;
      /** The canvas's height in panel pixels, for the draw threshold's pixel floor. */
      canvasPx?: number;
    },
    nowSec: number,
  ): CursorPlacement;
}

// ── The sprite: the page's CSS cursor, mirrored (ADR-046 Amendment 2 §C, page side) ─────────

/** The procedural sprites: one per standard CSS cursor keyword (aliases share one). */
export type CursorShape =
  | 'arrow' | 'pointer' | 'grab' | 'grabbing' | 'move' | 'text' | 'vertical-text' | 'crosshair'
  | 'not-allowed' | 'help' | 'wait' | 'progress' | 'copy' | 'alias' | 'context-menu' | 'cell'
  | 'ns-resize' | 'ew-resize' | 'nesw-resize' | 'nwse-resize' | 'col-resize' | 'row-resize'
  | 'zoom-in' | 'zoom-out';
/** `cursor.shape`: `'auto'` (default — the page's computed CSS cursor, url() images included), `'none'`, or a sprite. */
export type CursorShapeOption = 'auto' | 'none' | CursorShape;
/** What `shapeFor` is handed each drawn frame. */
export interface CursorShapeHit {
  /** Canvas-normalised pointer, v down. */
  u: number;
  v: number;
  /** The nearest content point under the footprint (the views' / world space), null on a pair or a miss. */
  point: number[] | null;
  /** What `'auto'` would draw: a sprite name, `'none'` or `'image'` (null unless `shape: 'auto'`). */
  css: CursorShape | 'none' | 'image' | null;
  /** The page's computed CSS `cursor` value (null unless `shape: 'auto'`). */
  cssValue: string | null;
}
/** What a cursor draws: nothing, a keyword sprite, or a loaded url() image. */
export type CursorSprite =
  | { kind: 'none' }
  | { kind: 'shape'; name: CursorShape; key: string }
  | { kind: 'image'; key: string; entry: CursorImageEntry; width: number; height: number; hotspot: [number, number] };
export interface CursorImageEntry {
  url: string;
  state: 'loading' | 'ready' | 'failed';
  image: HTMLImageElement | null;
  /** Natural size, CSS px. */
  width: number;
  height: number;
  /** A .cur file's own hotspot, once read. */
  curHotspot: [number, number] | null;
}
export const CURSOR_SHAPES: readonly CursorShape[];
export const CURSOR_SHAPE_OPTIONS: readonly CursorShapeOption[];
/** Every CSS cursor keyword the map knows. */
export const CURSOR_CSS_KEYWORDS: readonly string[];
/** The data attribute that hides the CSS cursor while the sprite draws (on the canvas; on <html> for pointerScope 'window'). */
export const CURSOR_HIDDEN_ATTR: string;
/** The one rule injected for it: `cursor: none !important` on the attribute's element and its descendants. */
export const CURSOR_HIDDEN_RULE: string;
/** Pointer moves re-read the CSS cursor at most this often, ms (100); press/release re-read at once. */
export const CURSOR_CSS_READ_MS: number;
/** Image cursors larger than this (CSS px) are scaled down to it (128). */
export const CURSOR_IMAGE_MAX_PX: number;
/** Texels per sprite unit of the keyword textures (64). */
export const CURSOR_SHAPE_TEXTURE_PX: number;
/** One keyword → its sprite, `'none'`, or the arrow for anything unknown. */
export function cssKeywordToShape(keyword: string): CursorShape | 'none';
/** A computed CSS `cursor` value's keyword fallback → its sprite (images ignored). */
export function cssCursorToShape(css: string | null | undefined): CursorShape | 'none';
/** A computed CSS `cursor` value: its url() images in order (explicit hotspot or null) and the keyword fallback. */
export function parseCssCursor(css: string | null | undefined): { images: ReadonlyArray<{ url: string; hotspot: [number, number] | null }>; keyword: string };
/** `shapeFor`'s answer if it names a sprite (or 'none'), else the fixed `shape`, else the CSS one, else the arrow. */
export function cursorPickShape(shape: CursorShapeOption | undefined, fromShapeFor: unknown, css: string | null | undefined): CursorShape | 'none';
/** A .cur file's hotspot (the entry `w` px wide, else the first), or null when not a cursor file. */
export function curFileHotspot(buf: ArrayBuffer | null, w?: number): [number, number] | null;
/** Cursor images by URL (crossOrigin 'anonymous'), loaded once. */
export class CursorImageCache {
  constructor(opts?: { ImageCtor?: unknown; fetchFn?: unknown });
  get(url: string): CursorImageEntry;
}
/** The page-wide cache the cursors share. */
export const cursorImageCache: CursorImageCache;
/** What to draw for a computed CSS cursor value: the first READY image (failed → next, loading → the fallback), else the keyword. */
export function resolveCursorSprite(css: string, images?: Pick<CursorImageCache, 'get'>): CursorSprite;
export function spriteForName(name: CursorShape | 'none' | string): CursorSprite;
/** The sprite's area in sprite units (arrow heights; y down, hotspot at the origin). */
export function cursorSpriteRect(sprite: CursorSprite): [number, number, number, number];
/** That area padded by `radius` (+ `aa`). */
export function cursorSpriteBox(sprite: CursorSprite, radius: number, aa?: number): [number, number, number, number];
/** A sprite's geometry (sprite units, y down, hotspot at the origin). */
export interface CursorShapeGeometry {
  readonly name: CursorShape;
  /** The dark outline: a union of polygons. */
  readonly parts: ReadonlyArray<ReadonlyArray<readonly [number, number]>>;
  /** Each part inset by 1/19: the white fill. */
  readonly fill: ReadonlyArray<ReadonlyArray<readonly [number, number]>>;
  /** Dark marks over the fill (the ? of help, the + of copy). */
  readonly detail: ReadonlyArray<ReadonlyArray<readonly [number, number]>>;
  readonly box: readonly [number, number, number, number];
}
export function cursorShape(name: CursorShape | string): CursorShapeGeometry;
type CursorPolys = { outline: ReadonlyArray<ReadonlyArray<readonly [number, number]>>; fill: ReadonlyArray<ReadonlyArray<readonly [number, number]>>; detail?: ReadonlyArray<ReadonlyArray<readonly [number, number]>> };
/** The outline, the fill inset by `d` sprite units (default 1/19), the detail. */
export function cursorShapePolys(name: CursorShape | string, d?: number): CursorPolys;
/** The shape's box padded by `radius` (+ `aa`). */
export function cursorShapeBox(name: CursorShape | string, radius: number, aa?: number): [number, number, number, number];
/** The softened shape at (x, y) of sprite units (straight RGB + alpha); for the arrow, exactly cursorSoftArrowSample. */
export function cursorShapeSample(name: CursorShape | string, x: number, y: number, radius: number, aa: number, fill?: readonly number[], outline?: readonly number[], polys?: CursorPolys): [number, number, number, number];
/** The softened shape rasterised for a 2D canvas, the hotspot at (cx, cy), one sprite unit = `sizePx`. */
export function cursorShapeRaster(name: CursorShape | string, cx: number, cy: number, sizePx: number, radius: number, alpha: number, fill?: readonly number[], outline?: readonly number[], polys?: CursorPolys): { x0: number; y0: number; width: number; height: number; data: Uint8ClampedArray };
/** A keyword sprite as a crisp straight-alpha RGBA texture (row 0 = the top) and the sprite-unit rect it covers. */
export function cursorShapeTexture(name: CursorShape | string): { width: number; height: number; data: Uint8ClampedArray; rect: readonly [number, number, number, number] };
/** RGBA pixels softened with the same 13-tap kernel and opacity, padded by the radius. */
export function cursorSoftenPixels(src: ArrayLike<number>, w: number, h: number, radiusPx: number, alpha: number): { pad: number; width: number; height: number; data: Uint8ClampedArray };
/** The crisp shape drawn with a 2D context (outline dark, fill white, detail dark), the hotspot at (cx, cy). */
export function drawCursorShape2D(g: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, name: CursorShape | string, cx: number, cy: number, sizePx: number, polys?: CursorPolys, fillStyle?: string, outlineStyle?: string): void;
/** GLSL defining `vec4 inline3dSoftSprite(sampler2D tex, vec2 p, vec4 rect, float radius)` — every non-arrow sprite, one program. */
export function cursorSpriteGLSL(): string;
/** Inject CURSOR_HIDDEN_RULE once; false without a document. */
export function ensureCursorHiddenRule(doc?: Document): boolean;
/** The page's computed cursor at `el` with the depth cursor's hide lifted (synchronously) off `holders`; null if unreadable. */
export function readPageCursor(el: Element, holders: ReadonlyArray<Element | null | undefined>): string | null;
/** Tracks the page's CSS cursor under the pointer: listeners mark it stale; `value()` re-reads (moves throttled, press/release at once). */
export class CursorCssReader {
  constructor(pointer: { canvas: Element; scope: 'canvas' | 'window' }, opts?: { throttleMs?: number });
  /** The last computed CSS cursor read, or null. */
  readonly css: string | null;
  /** Reads performed (diagnostics). */
  readonly reads: number;
  throttleMs: number;
  value(nowMs?: number): string;
  shape(nowMs?: number): CursorShape | 'none';
  read(nowMs?: number): string;
  dispose(): void;
}
/** Per-cursor sprite state: the option, `shapeFor`, and a reader only for `'auto'`. */
export class CursorShapeSelector {
  constructor(pointer: { canvas: Element; scope: 'canvas' | 'window' }, opts?: { shape?: CursorShapeOption; shapeFor?: ((hit: CursorShapeHit) => unknown) | null; images?: Pick<CursorImageCache, 'get'> });
  readonly option: CursorShapeOption;
  readonly reader: CursorCssReader | null;
  /** The sprite picked last. */
  readonly sprite: CursorSprite;
  /** …as a label: a sprite name, 'none' or 'image'. */
  readonly current: CursorShape | 'none' | 'image';
  pick(hit: { u: number; v: number; point: number[] | null }, nowMs?: number): CursorSprite;
  dispose(): void;
}

// ── Crosstalk softening of the lifted cursor (runtime ADR-046 Amendment 2 §B.7) ─────────────

/**
 * `'both'` (default): edge blur AND opacity easing; `'off'`: neither (the crisp arrow, exactly as
 * before 1.44); `'alpha'` / `'blur'`: one of them (A/B presets).
 */
export type CursorSoftenPreset = 'both' | 'off' | 'alpha' | 'blur';
/** The tuning knobs, each over the runtime's default (U_CURSOR_SOFTEN_DEFAULT_*). */
export interface CursorSoftenTuning {
  /** Which effects; default `'both'`. */
  mode?: CursorSoftenPreset;
  /** Panel px of blur per panel px of ghost offset (the views' on-screen split). Default 0.1; >= 0. */
  blurK?: number;
  /** Hard ceiling on the blur radius, panel px. Default 8; [0, 8]. */
  blurMaxPx?: number;
  /** Blur cap as a fraction of the drawn arrow's height. Default 0.06; [0, 0.5] (0 = off). */
  blurMaxFrac?: number;
  /** Opacity at full lift. Default 0.5; [0, 1]. */
  alphaMin?: number;
  /** |disparity| (eye baselines) at which the opacity reaches alphaMin. Default 0.03; > 0. */
  fullD?: number;
}
/** `cursor.soften`: a preset, a tuning object, `true` (= default) or `false` (= `'off'`). */
export type CursorSoftenOption = CursorSoftenPreset | CursorSoftenTuning | boolean;
/** The resolved parameter set. */
export interface CursorSoftenParams {
  blur: boolean;
  alpha: boolean;
  blurK: number;
  blurMaxPx: number;
  blurMaxFrac: number;
  alphaMin: number;
  fullD: number;
}
export const CURSOR_SOFTEN_PRESETS: readonly CursorSoftenPreset[];
export const CURSOR_SOFTEN_DEFAULTS: Readonly<CursorSoftenParams>;
export const CURSOR_SOFTEN_KEYS: readonly (keyof CursorSoftenTuning)[];
/** `cursor.soften` resolved over the defaults; throws on a bad value. */
export function resolveCursorSoften(opt: unknown, who?: string): CursorSoftenParams;
/**
 * The runtime's lenient string parse (u_cursor_soften_params_parse), e.g. for URL parameters: a
 * value that does not parse or is out of range keeps its default. `changed`: any knob was set.
 */
export function parseCursorSoften(
  mode?: string | null,
  blurK?: string | null,
  blurMaxPx?: string | null,
  blurMaxFrac?: string | null,
  alphaMin?: string | null,
  fullD?: string | null,
): { params: CursorSoftenParams; changed: boolean };
/**
 * One frame's softening (u_cursor_draw_soften_sized): blur radius (panel px) = blurK × |ghostPx|,
 * capped at blurMaxPx and blurMaxFrac × `spritePx`; opacity eases 1 → alphaMin by a smoothstep
 * over |d| up to fullD. (0, 1) on the glass.
 */
export function cursorSoften(d: number, ghostPx: number, spritePx?: number, params?: CursorSoftenParams | null): { blurPx: number; alpha: number };
/** Largest panel-px distance between the hotspot in NEIGHBOURING views (canvas-normalised origins). */
export function cursorGhostPx(origins: ArrayLike<ArrayLike<number> | null> | null, pxW: number, pxH: number): number;
/** Canvas-normalised [u, v] (v down) of a point seen from a view, or null when not in front of it. */
export function cursorProjectToCanvas(view: CursorView | XRView, point: ArrayLike<number>): [number, number] | null;
/** A placement's softening; `radius` / `aa` in arrow heights; `soft` false = draw the crisp arrow. */
export interface CursorSoftening {
  blurPx: number;
  alpha: number;
  ghostPx: number;
  spritePx: number;
  radius: number;
  aa: number;
  soft: boolean;
}
/** The softening for a placement drawn with `views` on a `panelW` × `panelH` px canvas, the arrow `heightFraction` of it tall. */
export function cursorPlacementSoften(
  placement: CursorPlacement | { active: false } | null,
  views: ArrayLike<CursorView | XRView>,
  panelW: number,
  panelH: number,
  heightFraction: number,
  params?: CursorSoftenParams,
): CursorSoftening;
/** The runtime's 13-tap blur kernel, `[dx, dy, weight]` in units of the radius. */
export const CURSOR_SOFTEN_KERNEL: ReadonlyArray<readonly [number, number, number]>;
/** The arrow's [width, height] in its own units (height 1). */
export const CURSOR_ARROW_SIZE: readonly [number, number];
/** The arrow's box padded by `radius` (+ `aa`), arrow units, y down, tip at the origin: [x0, y0, x1, y1]. */
export function cursorSoftArrowBox(radius: number, aa?: number): [number, number, number, number];
/** Signed distance to a polygon (negative inside). */
export function cursorPolygonSd(poly: ReadonlyArray<readonly [number, number]>, x: number, y: number): number;
/** The softened arrow at (x, y) of arrow units: straight RGB + alpha (before opacity). The shader's reference. */
export function cursorSoftArrowSample(
  x: number,
  y: number,
  radius: number,
  aa: number,
  fill?: readonly number[],
  outline?: readonly number[],
  polys?: ReadonlyArray<ReadonlyArray<readonly [number, number]>>,
): [number, number, number, number];
/** GLSL defining `vec4 inline3dSoftArrow(vec2 p, float radius, float aa, vec3 fill, vec3 outline)`. */
export function cursorSoftArrowGLSL(polys?: ReadonlyArray<ReadonlyArray<readonly [number, number]>>): string;
/** The softened arrow rasterised for a 2D canvas, its tip at (cx, cy), `sizePx` tall: straight-alpha RGBA bytes. */
export function cursorSoftArrowRaster(
  cx: number,
  cy: number,
  sizePx: number,
  radius: number,
  alpha: number,
  fill?: readonly number[],
  outline?: readonly number[],
  polys?: ReadonlyArray<ReadonlyArray<readonly [number, number]>>,
): { x0: number; y0: number; width: number; height: number; data: Uint8ClampedArray };

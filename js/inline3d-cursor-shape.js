// inline3d-cursor-shape.js — WHICH sprite the depth cursor draws: the page's CSS cursor, mirrored.
//
// The depth cursor replaces the OS cursor while content under it comes out of the glass (ADR-046).
// Until 1.44 it always drew the arrow, so a page whose cursor is `grab` over a model showed an
// arrow there instead. This module closes that gap on the page side (ADR-046 Amendment 2 §C, done
// in the page): it reads the page's computed CSS cursor and draws what the browser would show.
//
//  - Keywords (cssKeywordToShape): every standard CSS cursor keyword has a procedural sprite
//    (CURSOR_SHAPES; aliases share one: `n-resize` → `ns-resize`, `no-drop` → `not-allowed`, …),
//    `none` draws nothing (and the OS cursor stays hidden: the page hid it on purpose), anything
//    unknown draws the arrow. No image assets: each sprite is a union of polygons on the arrow's
//    19-px grid (unit = the arrow's height, x right, y DOWN, the hotspot at the origin — the shape's
//    natural point: a tip, the palm, the centre), drawn in the arrow's style: dark outline, white
//    fill inset by one px of the 19, and dark `detail` marks on the fill (the ? of help, the + of
//    copy and zoom-in). Parts that abut keep a dark seam between their fills (the finger lines).
//  - Images (parseCssCursor, CursorImageCache): `url(a) x y, url(b), fallback` — the first url that
//    loads as an image with crossOrigin 'anonymous' (same-origin and data: always do; a
//    cross-origin one without CORS cannot be used, so the next item is tried), at its natural CSS
//    size capped at 128 px, hotspot = the explicit x y, else a .cur file's own, else 0 0. Loaded
//    async and cached per URL; the keyword fallback is drawn until the image is ready.
//  - Drawing: the arrow keeps its analytic path (the crisp mesh / cursorSoftArrowGLSL). Every other
//    sprite is a TEXTURE — keyword shapes rasterised once each (cursorShapeTexture), images as
//    loaded — on one soft quad whose shader (cursorSpriteGLSL) applies the same 13-tap blur and
//    opacity, so one program serves every sprite and a change never compiles anything. On a 2D
//    pair the same rasters are drawn into the woven buffer (cursorShapeRaster, cursorImageRaster).
//    Never a CSS filter, never CSS opacity.
//  - Read-back (CursorCssReader): the depth cursor hides the CSS cursor while it draws, and that
//    hide must not be what it reads back. So the hide is a data attribute plus ONE injected rule
//    (CursorPointer.hideCss) — the page's inline `style.cursor` is never written — and a read
//    lifts the attribute, takes getComputedStyle(element under the pointer).cursor and puts it
//    back, synchronously in one task, so nothing paints in between. Reads happen only after
//    pointer events (move throttled, down/up at once) and only on frames that draw the sprite.
//    Loaded with the cursor, i.e. only on `cursor: 'depth'` (ADR-046 §0).

import {
  CURSOR_ARROW,
  CURSOR_ARROW_FILL,
  CURSOR_FILL_COLOR,
  CURSOR_OUTLINE_COLOR,
  CURSOR_SOFTEN_KERNEL,
  cursorArrowInset,
  cursorPolygonSd,
} from './inline3d-cursor-depth.js';

import { CURSOR_SHAPES, CURSOR_SHAPE_OPTIONS } from './inline3d-cursor-option.js';

export { CURSOR_SHAPES, CURSOR_SHAPE_OPTIONS };

/** The data attribute the hide sets (on the canvas, or on <html> for pointerScope 'window'). */
export const CURSOR_HIDDEN_ATTR = 'data-inline3d-cursor-hidden';

/** The one rule injected for it. */
export const CURSOR_HIDDEN_RULE = `[${CURSOR_HIDDEN_ATTR}],[${CURSOR_HIDDEN_ATTR}] *{cursor:none!important}`;

/** An image cursor larger than this (CSS px, either side) is scaled down to it, as browsers cap it. */
export const CURSOR_IMAGE_MAX_PX = 128;

/** The CSS px of one sprite unit (the arrow's height at the default size). */
const UNIT_PX = 19;

// ── Keywords ─────────────────────────────────────────────────────────────────────────────────

const KEYWORD_TO_SHAPE = Object.freeze({
  auto: 'arrow',
  default: 'arrow',
  none: 'none',
  pointer: 'pointer',
  grab: 'grab',
  '-webkit-grab': 'grab',
  grabbing: 'grabbing',
  '-webkit-grabbing': 'grabbing',
  move: 'move',
  'all-scroll': 'move',
  text: 'text',
  'vertical-text': 'vertical-text',
  crosshair: 'crosshair',
  'not-allowed': 'not-allowed',
  'no-drop': 'not-allowed',
  help: 'help',
  wait: 'wait',
  progress: 'progress',
  copy: 'copy',
  alias: 'alias',
  'context-menu': 'context-menu',
  cell: 'cell',
  'n-resize': 'ns-resize',
  's-resize': 'ns-resize',
  'ns-resize': 'ns-resize',
  'e-resize': 'ew-resize',
  'w-resize': 'ew-resize',
  'ew-resize': 'ew-resize',
  'ne-resize': 'nesw-resize',
  'sw-resize': 'nesw-resize',
  'nesw-resize': 'nesw-resize',
  'nw-resize': 'nwse-resize',
  'se-resize': 'nwse-resize',
  'nwse-resize': 'nwse-resize',
  'col-resize': 'col-resize',
  'row-resize': 'row-resize',
  'zoom-in': 'zoom-in',
  '-webkit-zoom-in': 'zoom-in',
  'zoom-out': 'zoom-out',
  '-webkit-zoom-out': 'zoom-out',
});

/** Every CSS keyword the map knows (diagnostics, tests). */
export const CURSOR_CSS_KEYWORDS = Object.freeze(Object.keys(KEYWORD_TO_SHAPE));

/**
 * One CSS cursor keyword → its sprite name, `'none'`, or the arrow for anything unknown.
 * @param {string} kw
 * @returns {string}
 */
export function cssKeywordToShape(kw) {
  return (typeof kw === 'string' && KEYWORD_TO_SHAPE[kw.trim().toLowerCase()]) || 'arrow';
}

/** Split at top-level commas: commas inside quotes or parentheses (a data: URL) stay. */
function splitTopLevel(s) {
  const out = [];
  let depth = 0, quote = '', cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === '\\' && i + 1 < s.length) {
        cur += c + s[++i];
        continue;
      }
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const _parsed = new Map();

/**
 * A computed CSS `cursor` value, parsed: its `url(…)` images in order (each with its explicit
 * hotspot, or null) and the keyword fallback (the last keyword; `auto` when there is none).
 * `image-set(…)` entries are skipped (not drawable here: the next item is used).
 * @param {string} css  e.g. `url("a.cur"), url(b.png) 4 4, pointer`
 * @returns {{images: Array<{url: string, hotspot: [number, number]|null}>, keyword: string}}
 */
export function parseCssCursor(css) {
  if (typeof css !== 'string') return { images: [], keyword: 'auto' };
  let r = _parsed.get(css);
  if (r) return r;
  const images = [];
  let keyword = 'auto';
  for (const item of splitTopLevel(css)) {
    const m = /^url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)\s]*))\s*\)\s*(.*)$/is.exec(item);
    if (m) {
      const url = (m[1] ?? m[2] ?? m[3] ?? '').replace(/\\(.)/g, '$1');
      const nums = (m[4] || '').trim().split(/\s+/).filter(Boolean).map(Number);
      const hotspot = nums.length === 2 && nums.every(Number.isFinite) ? [nums[0], nums[1]] : null;
      if (url) images.push({ url, hotspot });
      continue;
    }
    if (/^(-webkit-)?image-set\(/i.test(item)) continue;
    keyword = item.trim().toLowerCase();
  }
  r = Object.freeze({ images: Object.freeze(images), keyword });
  if (_parsed.size > 64) _parsed.clear();
  _parsed.set(css, r);
  return r;
}

/**
 * A computed CSS `cursor` value → the keyword sprite that stands for it, ignoring images (the
 * keyword fallback decides): `'none'`, a CURSOR_SHAPES name, or the arrow.
 * @returns {string}
 */
export function cssCursorToShape(css) {
  return cssKeywordToShape(parseCssCursor(css).keyword);
}

/**
 * The sprite NAME for one frame: `shapeFor`'s answer when it names a sprite (or `'none'`), else
 * the fixed `shape` option, else (`'auto'`) the page's (`css`, a name or null), else the arrow.
 * @returns {string}
 */
export function cursorPickShape(shape, fromShapeFor, css) {
  const ok = (s) => s === 'none' || CURSOR_SHAPES.includes(s);
  if (ok(fromShapeFor)) return fromShapeFor;
  if (ok(shape)) return shape;
  return ok(css) ? css : 'arrow';
}

// ── Images ───────────────────────────────────────────────────────────────────────────────────

/**
 * A Windows .cur file's hotspot for the entry `w` px wide (else its first entry), or null when
 * the bytes are not a cursor file. (A .png has no hotspot: the spec's default is 0 0.)
 * @param {ArrayBuffer} buf
 */
export function curFileHotspot(buf, w = 0) {
  if (!buf || buf.byteLength < 22) return null;
  const v = new DataView(buf);
  if (v.getUint16(0, true) !== 0 || v.getUint16(2, true) !== 2) return null;
  const n = v.getUint16(4, true);
  let pick = -1;
  for (let i = 0; i < n && 6 + 16 * i + 16 <= buf.byteLength; i++) {
    const ew = v.getUint8(6 + 16 * i) || 256;
    if (pick < 0 || ew === w) pick = i;
    if (ew === w) break;
  }
  if (pick < 0) return null;
  const o = 6 + 16 * pick;
  return [v.getUint16(o + 4, true), v.getUint16(o + 6, true)];
}

const looksLikeCur = (url) => /\.cur(?:[?#]|$)/i.test(url) || /^data:image\/(?:x-win-bitmap|x-icon|vnd\.microsoft\.icon)/i.test(url);

/**
 * Cursor images by URL: loaded once (crossOrigin 'anonymous'), shared by every cursor on the page.
 * An entry is `{ state: 'loading' | 'ready' | 'failed', image, width, height, curHotspot }` with
 * the natural size in CSS px. `get(url)` starts the load on first sight.
 */
export class CursorImageCache {
  constructor({ ImageCtor = globalThis.Image, fetchFn = globalThis.fetch } = {}) {
    this._Image = ImageCtor;
    this._fetch = fetchFn;
    this._m = new Map();
  }

  get(url) {
    let e = this._m.get(url);
    if (e) return e;
    e = { url, state: 'loading', image: null, width: 0, height: 0, curHotspot: null };
    this._m.set(url, e);
    if (typeof this._Image !== 'function') {
      e.state = 'failed';
      return e;
    }
    const img = new this._Image();
    img.crossOrigin = 'anonymous';
    let pending = 1;
    const done = () => {
      if (--pending > 0 || e.state === 'failed') return;
      e.state = 'ready';
    };
    img.onload = () => {
      const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
      if (!(w > 0 && h > 0)) return void (e.state = 'failed');
      e.image = img;
      e.width = w;
      e.height = h;
      done();
    };
    img.onerror = () => {
      e.state = 'failed';
    };
    if (looksLikeCur(url) && typeof this._fetch === 'function') {
      pending++;
      Promise.resolve()
        .then(() => this._fetch(url, url.startsWith('data:') ? undefined : { mode: 'cors' }))
        .then((r) => (r && r.ok !== false ? r.arrayBuffer() : null))
        .then((buf) => {
          e.curHotspot = buf ? curFileHotspot(buf, e.width) : null;
        })
        .catch(() => {})
        .finally(done);
    }
    img.src = url;
    return e;
  }
}

/** The page-wide image cache the cursors share. */
export const cursorImageCache = new CursorImageCache();

/**
 * What to draw for a computed CSS cursor value: the first READY image of its url list (skipping
 * failed ones; while one is still loading, the keyword fallback), else the keyword's sprite.
 * @returns {{kind: 'none'} | {kind: 'shape', name: string, key: string} |
 *           {kind: 'image', key: string, entry: object, width: number, height: number, hotspot: [number, number]}}
 */
export function resolveCursorSprite(css, images = cursorImageCache) {
  const p = parseCssCursor(css);
  for (const it of p.images) {
    const e = images.get(it.url);
    if (e.state === 'failed') continue;
    if (e.state !== 'ready') break; // the fallback until it is
    const k = Math.min(1, CURSOR_IMAGE_MAX_PX / Math.max(e.width, e.height));
    const hot = it.hotspot || e.curHotspot || [0, 0];
    const width = e.width * k, height = e.height * k;
    const hotspot = [Math.min(width, Math.max(0, hot[0] * k)), Math.min(height, Math.max(0, hot[1] * k))];
    return { kind: 'image', key: it.url, entry: e, width, height, hotspot };
  }
  return spriteForName(cssKeywordToShape(p.keyword));
}

/** The sprite descriptor for a NAME (a CURSOR_SHAPES entry, or 'none'). */
export function spriteForName(name) {
  if (name === 'none') return { kind: 'none' };
  const n = CURSOR_SHAPES.includes(name) ? name : 'arrow';
  return { kind: 'shape', name: n, key: `shape:${n}` };
}

/**
 * The sprite's extent in sprite units (y down, hotspot at the origin): an image's CSS box around
 * its hotspot; a shape's texture rect. [x0, y0, x1, y1].
 */
export function cursorSpriteRect(sprite) {
  if (sprite.kind === 'image') {
    const [hx, hy] = sprite.hotspot;
    return [-hx / UNIT_PX, -hy / UNIT_PX, (sprite.width - hx) / UNIT_PX, (sprite.height - hy) / UNIT_PX];
  }
  return cursorShapeTexture(sprite.name).rect;
}

/** The soft quad for a sprite: its rect padded by the blur radius plus one AA width. */
export function cursorSpriteBox(sprite, radius, aa = 0) {
  const b = cursorSpriteRect(sprite);
  const pad = (radius > 0 && Number.isFinite(radius) ? radius : 0) + (aa > 0 && Number.isFinite(aa) ? aa : 0);
  return [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad];
}

// ── The shapes ─────────────────────────────────────────────────────────────────────────────────
// Designed on the arrow's 19-px grid (x right, y down), then moved so the hotspot is the origin
// and scaled to sprite units. Parts that must read as ONE white area overlap by more than 2 px
// (each fill is inset by 1); parts meant to show a seam overlap by 1 (a 1 px dark line).

/** A box with chamfered corners [tl, tr, br, bl] (px), clockwise on screen (y down). */
function box(x0, y0, x1, y1, [tl = 0, tr = 0, br = 0, bl = 0] = []) {
  const p = [];
  const add = (x, y) => {
    const q = p[p.length - 1];
    if (!q || Math.abs(q[0] - x) > 1e-9 || Math.abs(q[1] - y) > 1e-9) p.push([x, y]);
  };
  add(x0 + tl, y0);
  add(x1 - tr, y0);
  add(x1, y0 + tr);
  add(x1, y1 - br);
  add(x1 - br, y1);
  add(x0 + bl, y1);
  add(x0, y1 - bl);
  add(x0, y0 + tl);
  if (p.length > 1 && Math.abs(p[0][0] - p[p.length - 1][0]) < 1e-9 && Math.abs(p[0][1] - p[p.length - 1][1]) < 1e-9) p.pop();
  return p;
}

const clockwise = (pts) => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [px, py] = pts[i], [qx, qy] = pts[(i + 1) % pts.length];
    a += px * qy - qx * py;
  }
  return a > 0 ? pts : pts.reverse();
};

/** A limb from (x0, y0) (its base) to (x1, y1) (its tip), `w` px wide, the tip chamfered. */
function limb(x0, y0, x1, y1, w, c = w / 3.5) {
  const dx = x1 - x0, dy = y1 - y0;
  const l = Math.hypot(dx, dy);
  const ux = dx / l, uy = dy / l; // along, base → tip
  const nx = -uy * (w / 2), ny = ux * (w / 2); // across
  const tx = x1 - ux * c, ty = y1 - uy * c; // where the chamfer starts
  const k = 1 - (2 * c) / w; // the tip's flat, as a fraction of the width
  return clockwise([
    [x0 + nx, y0 + ny],
    [tx + nx, ty + ny],
    [x1 + nx * k, y1 + ny * k],
    [x1 - nx * k, y1 - ny * k],
    [tx - nx, ty - ny],
    [x0 - nx, y0 - ny],
  ]);
}

/** A straight bar from (x0, y0) to (x1, y1), `w` px wide (square ends). */
function bar(x0, y0, x1, y1, w) {
  const dx = x1 - x0, dy = y1 - y0;
  const l = Math.hypot(dx, dy);
  const nx = (-dy / l) * (w / 2), ny = (dx / l) * (w / 2);
  return clockwise([[x0 + nx, y0 + ny], [x1 + nx, y1 + ny], [x1 - nx, y1 - ny], [x0 - nx, y0 - ny]]);
}

/** A regular n-gon (a disc at this size). */
function disc(cx, cy, r, n = 20) {
  return clockwise(Array.from({ length: n }, (_, k) => [cx + r * Math.cos((2 * Math.PI * k) / n), cy + r * Math.sin((2 * Math.PI * k) / n)]));
}

/**
 * A ring as overlapping annular segments: each spans three steps, so a neighbour overlaps it by
 * two (> the 2 px the two 1-px insets need) and the fills merge into one white band.
 */
function ring(cx, cy, r0, r1, n = 24) {
  const out = [];
  const P = (r, a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  for (let k = 0; k < n; k++) {
    const as = [0, 1, 2, 3].map((i) => (2 * Math.PI * (k + i)) / n);
    out.push(clockwise([...as.map((a) => P(r1, a)), ...as.reverse().map((a) => P(r0, a))]));
  }
  return out;
}

const tri = (a, b, c) => clockwise([a, b, c]);

/** Parts rotated by `deg` about (cx, cy). */
const rot = (parts, deg, cx, cy) => {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return parts.map((p) => clockwise(p.map(([x, y]) => [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c])));
};
/** Parts scaled by `k` about the origin, then moved by (dx, dy). */
const xf = (parts, k, dx = 0, dy = 0) => parts.map((p) => p.map(([x, y]) => [x * k + dx, y * k + dy]));

const ARROW_PX = () => [CURSOR_ARROW.map(([x, y]) => [x * 19, y * 19])];

/** The double-headed arrow (vertical, centred on (9.5, 9.5)); rotate it for the other axes. */
const doubleArrow = () => [
  box(8.0, 3.0, 11.0, 16.0),
  tri([9.5, 0], [14.2, 5.0], [4.8, 5.0]),
  tri([9.5, 19.0], [4.8, 14.0], [14.2, 14.0]),
];

/** A splitter (col-resize): a bar with an arrow out of each side. */
const splitter = () => [
  box(8.0, 1.0, 11.0, 18.0),
  box(3.4, 8.0, 7.4, 11.0),
  tri([0, 9.5], [4.4, 5.0], [4.4, 14.0]),
  box(11.6, 8.0, 15.6, 11.0),
  tri([19.0, 9.5], [14.6, 14.0], [14.6, 5.0]),
];

const hourglass = () => [
  box(3.0, 0, 16.0, 3.0),
  box(3.0, 16.0, 16.0, 19.0),
  tri([4.2, 0.5], [14.8, 0.5], [9.5, 10.0]),
  tri([9.5, 9.0], [14.8, 18.5], [4.2, 18.5]),
];

const magnifier = () => [disc(7.5, 7.5, 7.0), limb(11.6, 11.6, 18.4, 18.4, 3.8, 1.0)];

// Each design: `hot` (px), `parts` (outline), optional `detail` (dark marks on the fill).
function designs() {
  return {
    // The pointing hand: the index finger up (its tip = the hotspot), three curled fingers, thumb, palm.
    // Chamfers stay under (width − 2.2 px) / 2, so the 1-px inset keeps every edge (a valid fill).
    pointer: {
      hot: [6.8, 0],
      parts: [
        box(5.0, 0, 8.6, 14.0, [1.2, 1.2, 0, 0]),
        box(7.6, 5.4, 10.9, 14.0, [1.1, 1.1, 0, 0]),
        box(9.9, 6.4, 13.2, 14.0, [1.1, 1.1, 0, 0]),
        box(12.2, 7.6, 15.2, 14.0, [0.9, 0.9, 0, 0]),
        box(4.2, 10.8, 15.2, 19.0, [0, 0, 3.0, 2.2]),
        limb(7.4, 15.0, 1.0, 9.0, 3.6),
      ],
    },
    // The open hand: four fingers spread, thumb out; the hotspot in the palm (below the finger seams).
    grab: {
      hot: [8.6, 12.5],
      parts: [
        box(3.0, 2.6, 6.6, 12.4, [1.2, 1.2, 0, 0]),
        box(5.6, 0.6, 9.2, 12.4, [1.2, 1.2, 0, 0]),
        box(8.2, 1.4, 11.8, 12.4, [1.2, 1.2, 0, 0]),
        box(10.8, 3.6, 14.2, 12.4, [1.1, 1.1, 0, 0]),
        box(3.0, 9.4, 14.2, 18.0, [0, 0, 2.6, 2.6]),
        limb(6.2, 14.4, 0.4, 7.0, 3.6),
      ],
    },
    // The closed hand: the same palm, the fingers curled to a row of knuckles.
    grabbing: {
      hot: [8.6, 13.0],
      parts: [
        box(3.0, 5.6, 6.6, 12.4, [1.2, 1.2, 0, 0]),
        box(5.6, 5.0, 9.2, 12.4, [1.2, 1.2, 0, 0]),
        box(8.2, 5.2, 11.8, 12.4, [1.2, 1.2, 0, 0]),
        box(10.8, 6.0, 14.2, 12.4, [1.1, 1.1, 0, 0]),
        box(3.0, 9.4, 14.2, 18.0, [0, 0, 2.6, 2.6]),
        limb(6.0, 14.2, 1.2, 9.0, 3.6),
      ],
    },
    // The four-way arrow.
    move: {
      hot: [9.5, 9.5],
      parts: [
        box(3.0, 7.8, 16.0, 11.2),
        box(7.8, 3.0, 11.2, 16.0),
        tri([9.5, 0], [14.0, 4.6], [5.0, 4.6]),
        tri([9.5, 19.0], [5.0, 14.4], [14.0, 14.4]),
        tri([0, 9.5], [4.6, 5.0], [4.6, 14.0]),
        tri([19.0, 9.5], [14.4, 14.0], [14.4, 5.0]),
      ],
    },
    // The I-beam: a stem with serifs; the hotspot at its middle.
    text: { hot: [9.5, 9.5], parts: [box(8.0, 0.5, 11.0, 18.5), box(4.5, 0, 14.5, 3.0), box(4.5, 16.0, 14.5, 19.0)] },
    'vertical-text': { hot: [9.5, 9.5], parts: rot([box(8.0, 0.5, 11.0, 18.5), box(4.5, 0, 14.5, 3.0), box(4.5, 16.0, 14.5, 19.0)], 90, 9.5, 9.5) },
    crosshair: { hot: [9.5, 9.5], parts: [box(0, 8.0, 19.0, 11.0), box(8.0, 0, 11.0, 19.0)] },
    cell: { hot: [9.5, 9.5], parts: [box(1.5, 6.3, 17.5, 12.7), box(6.3, 1.5, 12.7, 17.5)] },
    // The circle with a slash.
    'not-allowed': { hot: [9.5, 9.5], parts: [...ring(9.5, 9.5, 5.4, 8.8), bar(4.6, 4.6, 14.4, 14.4, 3.4)] },
    // Arrow + a ? badge.
    help: {
      hot: [0, 0],
      parts: [...xf(ARROW_PX(), 0.8), disc(13.6, 12.4, 5.4)],
      detail: [box(11.6, 9.0, 15.4, 10.2), box(14.4, 9.0, 15.6, 12.6), box(12.9, 11.6, 15.6, 12.8), box(12.9, 11.6, 14.1, 13.8), box(12.9, 14.8, 14.1, 16.0)],
    },
    wait: { hot: [9.5, 9.5], parts: hourglass() },
    // Arrow + a small hourglass (busy, still usable).
    progress: { hot: [0, 0], parts: [...xf(ARROW_PX(), 0.8), ...xf(hourglass(), 0.5, 9.4, 9.4)] },
    // Arrow + a + badge.
    copy: {
      hot: [0, 0],
      parts: [...xf(ARROW_PX(), 0.8), box(9.6, 9.8, 18.8, 19.0, [1.2, 1.2, 1.2, 1.2])],
      detail: [box(13.6, 11.8, 14.8, 17.0), box(11.6, 13.8, 16.8, 15.0)],
    },
    // Arrow + a shortcut-arrow badge.
    alias: {
      hot: [0, 0],
      parts: [...xf(ARROW_PX(), 0.8), box(9.6, 9.8, 18.8, 19.0, [1.2, 1.2, 1.2, 1.2])],
      detail: [bar(11.8, 16.8, 15.6, 13.0, 1.3), tri([16.8, 11.8], [16.8, 15.4], [13.2, 11.8])],
    },
    // Arrow + a menu.
    'context-menu': {
      hot: [0, 0],
      parts: [...xf(ARROW_PX(), 0.8), box(9.2, 8.6, 18.8, 19.0)],
      detail: [box(11.0, 10.8, 17.0, 11.8), box(11.0, 13.3, 17.0, 14.3), box(11.0, 15.8, 17.0, 16.8)],
    },
    'ns-resize': { hot: [9.5, 9.5], parts: doubleArrow() },
    'ew-resize': { hot: [9.5, 9.5], parts: rot(doubleArrow(), 90, 9.5, 9.5) },
    'nesw-resize': { hot: [9.5, 9.5], parts: rot(doubleArrow(), 45, 9.5, 9.5) },
    'nwse-resize': { hot: [9.5, 9.5], parts: rot(doubleArrow(), -45, 9.5, 9.5) },
    'col-resize': { hot: [9.5, 9.5], parts: splitter() },
    'row-resize': { hot: [9.5, 9.5], parts: rot(splitter(), 90, 9.5, 9.5) },
    // A magnifier with + / −; the hotspot at the lens centre.
    'zoom-in': { hot: [7.5, 7.5], parts: magnifier(), detail: [box(4.4, 6.9, 10.6, 8.1), box(6.9, 4.4, 8.1, 10.6)] },
    'zoom-out': { hot: [7.5, 7.5], parts: magnifier(), detail: [box(4.4, 6.9, 10.6, 8.1)] },
  };
}

let _designs = null;
const _shapes = new Map();

/**
 * One sprite's geometry (sprite units: the arrow's height = 1, x right, y DOWN, hotspot at the
 * origin): `parts` (the dark outline, a union of polygons), `fill` (each part inset by one px of
 * the 19), `detail` (dark marks over the fill), `box` [x0, y0, x1, y1]. Built once, lazily.
 * @param {string} name  a CURSOR_SHAPES entry (anything else: the arrow)
 */
export function cursorShape(name) {
  const key = CURSOR_SHAPES.includes(name) ? name : 'arrow';
  let s = _shapes.get(key);
  if (s) return s;
  const freeze = (polys) => Object.freeze(polys.map((p) => Object.freeze(p.map((q) => Object.freeze(q)))));
  let parts, fill, detail;
  if (key === 'arrow') {
    parts = [CURSOR_ARROW];
    fill = [CURSOR_ARROW_FILL];
    detail = [];
  } else {
    const d = (_designs ||= designs())[key];
    const toUnits = (polys) => polys.map((poly) => poly.map(([x, y]) => [(x - d.hot[0]) / 19, (y - d.hot[1]) / 19]));
    parts = freeze(toUnits(d.parts));
    fill = freeze(parts.map((p) => cursorArrowInset(1 / 19, p)));
    detail = freeze(toUnits(d.detail || []));
  }
  const xs = parts.flat().map((p) => p[0]);
  const ys = parts.flat().map((p) => p[1]);
  s = Object.freeze({
    name: key,
    parts: Object.freeze(parts),
    fill: Object.freeze(fill),
    detail: Object.freeze(detail),
    box: Object.freeze([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]),
  });
  _shapes.set(key, s);
  return s;
}

/**
 * The shape's outline parts, its fill inset by `d` (sprite units) and its detail marks — the 2D
 * pair insets by one OUTPUT px, which can be more than one px of the 19.
 * @returns {{outline: number[][][], fill: number[][][], detail: number[][][]}}
 */
export function cursorShapePolys(name, d = 1 / 19) {
  const s = cursorShape(name);
  if (Math.abs(d - 1 / 19) < 1e-12) return { outline: s.parts, fill: s.fill, detail: s.detail };
  return { outline: s.parts, fill: s.parts.map((p) => cursorArrowInset(d, p)), detail: s.detail };
}

/** The shape's box padded by the blur radius plus one AA width (sprite units, hotspot at the origin). */
export function cursorShapeBox(name, radius, aa = 0) {
  const b = cursorShape(name).box;
  const pad = (radius > 0 && Number.isFinite(radius) ? radius : 0) + (aa > 0 && Number.isFinite(aa) ? aa : 0);
  return [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad];
}

const unionSd = (polys, x, y) => {
  let d = Infinity;
  for (const p of polys) d = Math.min(d, cursorPolygonSd(p, x, y));
  return d;
};
const coverage = (sd, aa) => (aa > 0 ? Math.min(1, Math.max(0, 0.5 - sd / aa)) : sd < 0 ? 1 : 0);

/**
 * The softened shape at (x, y) of sprite units — for the arrow exactly cursorSoftArrowSample: the
 * 13-tap kernel over the crisp shape (outline union, the fill union over it, the detail marks over
 * that in the outline colour, each edge anti-aliased over `aa`), accumulated premultiplied.
 * @param {{outline: number[][][], fill: number[][][], detail?: number[][][]}} [polys]
 * @returns {[number, number, number, number]}  straight RGB and alpha (before the opacity)
 */
export function cursorShapeSample(name, x, y, radius, aa, fill = CURSOR_FILL_COLOR, outline = CURSOR_OUTLINE_COLOR, polys = cursorShapePolys(name)) {
  let r = 0, g = 0, b = 0, a = 0, ws = 0;
  const taps = radius > 0 ? CURSOR_SOFTEN_KERNEL : CURSOR_SOFTEN_KERNEL.slice(0, 1);
  const det = polys.detail && polys.detail.length ? polys.detail : null;
  for (const [dx, dy, w] of taps) {
    const px = x + dx * radius, py = y + dy * radius;
    const co = coverage(unionSd(polys.outline, px, py), aa);
    let cf = co > 0 ? coverage(unionSd(polys.fill, px, py), aa) : 0;
    if (det && cf > 0) cf *= 1 - coverage(unionSd(det, px, py), aa);
    r += w * (outline[0] * co + (fill[0] - outline[0]) * cf);
    g += w * (outline[1] * co + (fill[1] - outline[1]) * cf);
    b += w * (outline[2] * co + (fill[2] - outline[2]) * cf);
    a += w * co;
    ws += w;
  }
  a /= ws;
  if (!(a > 1e-5)) return [0, 0, 0, 0];
  return [r / ws / a, g / ws / a, b / ws / a, a];
}

/**
 * The softened shape rasterised for a 2D canvas: the hotspot at canvas point (cx, cy), one sprite
 * unit = `sizePx`. Straight-alpha RGBA bytes, the opacity applied.
 * @returns {{x0: number, y0: number, width: number, height: number, data: Uint8ClampedArray}}
 */
export function cursorShapeRaster(name, cx, cy, sizePx, radius, alpha, fill = CURSOR_FILL_COLOR, outline = CURSOR_OUTLINE_COLOR, polys = cursorShapePolys(name)) {
  const size = sizePx > 0 && Number.isFinite(sizePx) ? sizePx : 1;
  const aa = 1 / size;
  const [bx0, by0, bx1, by1] = cursorShapeBox(name, radius, aa);
  const x0 = Math.floor(cx + bx0 * size), y0 = Math.floor(cy + by0 * size);
  const width = Math.max(1, Math.ceil(cx + bx1 * size) - x0), height = Math.max(1, Math.ceil(cy + by1 * size) - y0);
  const data = new Uint8ClampedArray(width * height * 4);
  const op = alpha >= 0 && alpha <= 1 ? alpha : 1;
  for (let j = 0; j < height; j++) {
    const y = (y0 + j + 0.5 - cy) / size;
    for (let i = 0; i < width; i++) {
      const c = cursorShapeSample(name, (x0 + i + 0.5 - cx) / size, y, radius, aa, fill, outline, polys);
      if (!(c[3] > 0)) continue;
      const o = (j * width + i) * 4;
      data[o] = Math.round(c[0] * 255);
      data[o + 1] = Math.round(c[1] * 255);
      data[o + 2] = Math.round(c[2] * 255);
      data[o + 3] = Math.round(c[3] * op * 255);
    }
  }
  return { x0, y0, width, height, data };
}

/** Texels per sprite unit of the keyword textures: ~3× a 19-CSS-px cursor at DPR 1. */
export const CURSOR_SHAPE_TEXTURE_PX = 64;
const _textures = new Map();

/**
 * A keyword shape as a texture (crisp, straight-alpha RGBA, row 0 = the TOP), built once:
 * `rect` = the sprite-unit area it covers [x0, y0, x1, y1] (the hotspot at the origin).
 * @returns {{width: number, height: number, data: Uint8ClampedArray, rect: [number, number, number, number]}}
 */
export function cursorShapeTexture(name) {
  const key = CURSOR_SHAPES.includes(name) ? name : 'arrow';
  let t = _textures.get(key);
  if (t) return t;
  const n = CURSOR_SHAPE_TEXTURE_PX;
  const r = cursorShapeRaster(key, 0, 0, n, 0, 1);
  t = Object.freeze({ width: r.width, height: r.height, data: r.data, rect: Object.freeze([r.x0 / n, r.y0 / n, (r.x0 + r.width) / n, (r.y0 + r.height) / n]) });
  _textures.set(key, t);
  return t;
}

/** Draw the crisp shape with a 2D context: the outline dark, the fill white, the detail dark. */
export function drawCursorShape2D(g, name, cx, cy, sizePx, polys = cursorShapePolys(name), fillStyle = '#fff', outlineStyle = '#000') {
  for (const [list, style] of [[polys.outline, outlineStyle], [polys.fill, fillStyle], [polys.detail || [], outlineStyle]]) {
    g.fillStyle = style;
    for (const poly of list) {
      g.beginPath();
      poly.forEach(([x, y], k) => (k ? g.lineTo : g.moveTo).call(g, cx + x * sizePx, cy + y * sizePx));
      g.closePath();
      g.fill();
    }
  }
}

/**
 * A straight-alpha RGBA image softened with the same 13-tap kernel (nearest-texel taps, `radiusPx`
 * output px) and opacity `alpha`; the result is padded by the radius on every side.
 * @returns {{pad: number, width: number, height: number, data: Uint8ClampedArray}}
 */
export function cursorSoftenPixels(src, w, h, radiusPx, alpha) {
  const pad = radiusPx > 0 && Number.isFinite(radiusPx) ? Math.ceil(radiusPx) + 1 : 0;
  const W = w + 2 * pad, H = h + 2 * pad;
  const out = new Uint8ClampedArray(W * H * 4);
  const op = alpha >= 0 && alpha <= 1 ? alpha : 1;
  const taps = pad ? CURSOR_SOFTEN_KERNEL : CURSOR_SOFTEN_KERNEL.slice(0, 1);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      let r = 0, g = 0, b = 0, a = 0, ws = 0;
      for (const [dx, dy, wt] of taps) {
        ws += wt;
        const x = Math.round(i - pad + dx * radiusPx), y = Math.round(j - pad + dy * radiusPx);
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const o = (y * w + x) * 4, sa = (src[o + 3] / 255) * wt;
        r += src[o] * sa;
        g += src[o + 1] * sa;
        b += src[o + 2] * sa;
        a += sa;
      }
      if (!(a > 1e-5)) continue;
      const o = (j * W + i) * 4;
      out[o] = r / a;
      out[o + 1] = g / a;
      out[o + 2] = b / a;
      out[o + 3] = (a / ws) * op * 255;
    }
  }
  return { pad, width: W, height: H, data: out };
}

const glf = (v) => {
  const s = (+v).toPrecision(9);
  return /[.eE]/.test(s) ? s : `${s}.0`;
};

/**
 * GLSL (ES 1.00 and 3.00: no loops, no arrays) for a softened TEXTURE sprite — every keyword shape
 * but the arrow, and every url() image, through one program:
 *
 *   vec4 inline3dSoftSprite(sampler2D tex, vec2 p, vec4 rect, float radius)
 *
 * `p` in sprite units (y down, hotspot at the origin); `rect` = the area the texture covers (row 0
 * = its top, rect.y); `radius` = the blur radius in sprite units: the runtime's 13-tap kernel, taps
 * outside the texture transparent, accumulated premultiplied. Straight RGB and alpha out; the
 * caller applies the opacity.
 */
export function cursorSpriteGLSL() {
  const taps = CURSOR_SOFTEN_KERNEL.slice(1)
    .map(([dx, dy, w]) => `    acc += ${glf(w)} * i3dSpriteTap(tex, uv + vec2(${glf(dx)}, ${glf(dy)}) * k);`)
    .join('\n');
  const wsum = CURSOR_SOFTEN_KERNEL.slice(1).reduce((t, k) => t + k[2], 0);
  return `
vec4 i3dSpriteTap(sampler2D tex, vec2 uv) {
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec4(0.0);
  vec4 c = texture2D(tex, uv);
  return vec4(c.rgb * c.a, c.a);
}
vec4 inline3dSoftSprite(sampler2D tex, vec2 p, vec4 rect, float radius) {
  vec2 sz = rect.zw - rect.xy;
  vec2 uv = (p - rect.xy) / sz;
  vec2 k = vec2(radius) / sz;
  vec4 acc = i3dSpriteTap(tex, uv);
  float wsum = 1.0;
  if (radius > 0.0) {
${taps}
    wsum += ${glf(wsum)};
  }
  acc /= wsum;
  return vec4(acc.a > 1e-5 ? acc.rgb / acc.a : vec3(0.0), acc.a);
}
`;
}

// ── Read-back of the page's CSS cursor ─────────────────────────────────────────────────────────

/** Pointer moves re-read the CSS cursor at most this often (ms); down/up re-read at once. */
export const CURSOR_CSS_READ_MS = 100;

/**
 * Inject the hide rule once per document (idempotent).
 * @returns {boolean}  false when there is no document to inject into
 */
export function ensureCursorHiddenRule(doc = globalThis.document) {
  if (!doc || !doc.createElement) return false;
  const id = 'inline3d-cursor-style';
  if (doc.getElementById && doc.getElementById(id)) return true;
  const st = doc.createElement('style');
  st.id = id;
  st.textContent = CURSOR_HIDDEN_RULE;
  (doc.head || doc.documentElement)?.appendChild(st);
  return true;
}

/**
 * The page's CSS cursor at `el`, as the page set it — the depth cursor's own hide lifted for the
 * read (the attribute off `holders`, getComputedStyle, the attribute back, all synchronous, so no
 * frame can paint without it).
 * @param {Element} el
 * @param {Array<Element|null|undefined>} holders  elements that may carry the hide attribute
 * @returns {string|null}  the computed `cursor`, or null when it cannot be read
 */
export function readPageCursor(el, holders) {
  const gcs = globalThis.getComputedStyle;
  if (!el || typeof gcs !== 'function') return null;
  const lifted = [];
  for (const h of holders) {
    if (h && h.hasAttribute && h.hasAttribute(CURSOR_HIDDEN_ATTR)) {
      lifted.push([h, h.getAttribute(CURSOR_HIDDEN_ATTR)]);
      h.removeAttribute(CURSOR_HIDDEN_ATTR);
    }
  }
  try {
    const v = gcs(el).cursor;
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  } finally {
    for (const [h, v] of lifted) h.setAttribute(CURSOR_HIDDEN_ATTR, v ?? '');
  }
}

/**
 * Tracks the page's CSS cursor under the pointer, cheaply: its listeners only note the element
 * under the pointer and mark the cached value stale; `value()` — called by the backend on frames
 * that DRAW the sprite — re-reads it when stale (a move: at most every CURSOR_CSS_READ_MS; a press
 * or release: at once, so `grab` → `grabbing` follows the click). The read itself runs on the
 * frame, after every page handler of the event has run (a page toggling a `grabbing` class on
 * pointerdown is seen whatever the listener order).
 */
export class CursorCssReader {
  /**
   * @param {{canvas: Element, scope: 'canvas'|'window'}} pointer  the backend's CursorPointer
   * @param {{throttleMs?: number}} [opts]
   */
  constructor(pointer, { throttleMs = CURSOR_CSS_READ_MS } = {}) {
    this.pointer = pointer;
    this.throttleMs = throttleMs;
    /** The last computed CSS cursor read (diagnostics), or null before the first. */
    this.css = null;
    /** Reads performed so far (diagnostics). */
    this.reads = 0;
    this._el = null;
    this._stale = true;
    this._urgent = true;
    this._lastRead = -Infinity;
    const note = (urgent) => (e) => {
      const path = typeof e.composedPath === 'function' ? e.composedPath() : null;
      const t = path && path.length ? path[0] : e.target;
      if (t && t.nodeType === 1) this._el = t;
      this._stale = true;
      if (urgent) this._urgent = true;
    };
    this._onMove = note(false);
    this._onPress = note(true);
    this._target = pointer.scope === 'window' ? globalThis : pointer.canvas;
    if (this._target && this._target.addEventListener) {
      this._target.addEventListener('pointermove', this._onMove);
      this._target.addEventListener('pointerdown', this._onPress);
      this._target.addEventListener('pointerup', this._onPress);
      this._target.addEventListener('pointercancel', this._onPress);
    }
  }

  /** The page's computed CSS cursor, re-read if stale and due ('auto' when unreadable). */
  value(nowMs = globalThis.performance ? globalThis.performance.now() : Date.now()) {
    if (this._stale && (this._urgent || this.css === null || nowMs - this._lastRead >= this.throttleMs)) this.read(nowMs);
    return this.css ?? 'auto';
  }

  /** The page's cursor as a keyword sprite name (images ignored): see cssCursorToShape. */
  shape(nowMs) {
    return cssCursorToShape(this.value(nowMs));
  }

  /** Read now, whatever the throttle says. */
  read(nowMs = globalThis.performance ? globalThis.performance.now() : Date.now()) {
    const doc = globalThis.document;
    const canvas = this.pointer.canvas;
    let el = this._el;
    if (el && el.isConnected === false) el = null;
    const css = readPageCursor(el || canvas, [canvas, doc && doc.documentElement]);
    this.reads++;
    this._lastRead = nowMs;
    this._stale = false;
    this._urgent = false;
    if (css !== null) this.css = css;
    return this.css ?? 'auto';
  }

  dispose() {
    if (this._target && this._target.removeEventListener) {
      this._target.removeEventListener('pointermove', this._onMove);
      this._target.removeEventListener('pointerdown', this._onPress);
      this._target.removeEventListener('pointerup', this._onPress);
      this._target.removeEventListener('pointercancel', this._onPress);
    }
  }
}

/**
 * The per-cursor sprite state every backend keeps: the option, the optional `shapeFor`, and a
 * reader only when something may read the CSS (`shape: 'auto'`, the default). `pick(hit)` is
 * called on frames where the placement is active, and returns the sprite descriptor
 * (resolveCursorSprite): `{kind: 'none'}`, a keyword shape, or a ready url() image.
 */
export class CursorShapeSelector {
  /**
   * @param {{canvas: Element, scope: string}} pointer
   * @param {{shape?: string, shapeFor?: Function, images?: CursorImageCache}} [opts]
   */
  constructor(pointer, { shape = 'auto', shapeFor = null, images = cursorImageCache } = {}) {
    if (!CURSOR_SHAPE_OPTIONS.includes(shape)) {
      throw new Error(`@displayxr/inline3d: cursor.shape "${shape}" — expected ${CURSOR_SHAPE_OPTIONS.join(', ')}.`);
    }
    this.option = shape;
    this.shapeFor = typeof shapeFor === 'function' ? shapeFor : null;
    this.images = images;
    this.reader = shape === 'auto' ? new CursorCssReader(pointer) : null;
    /** The sprite drawn last (diagnostics): its descriptor. */
    this.sprite = spriteForName(shape === 'auto' ? 'arrow' : shape);
  }

  /** The sprite drawn last, as a label: a shape name, 'none', or 'image'. */
  get current() {
    return this.sprite.kind === 'shape' ? this.sprite.name : this.sprite.kind;
  }

  /** @param {{u: number, v: number, point: number[]|null}} hit */
  pick(hit, nowMs) {
    const cssValue = this.reader ? this.reader.value(nowMs) : null;
    const auto = cssValue === null ? null : resolveCursorSprite(cssValue, this.images);
    const label = auto ? (auto.kind === 'shape' ? auto.name : auto.kind) : null;
    let mine;
    if (this.shapeFor) {
      try {
        mine = this.shapeFor({ ...hit, css: label, cssValue });
      } catch (err) {
        if (!this._warned) {
          this._warned = true;
          console.warn('[inline3d] cursor.shapeFor threw; using the page cursor.', err);
        }
      }
    }
    const ok = (s) => s === 'none' || CURSOR_SHAPES.includes(s);
    if (ok(mine)) this.sprite = spriteForName(mine);
    else if (ok(this.option)) this.sprite = spriteForName(this.option);
    else this.sprite = auto || spriteForName('arrow');
    return this.sprite;
  }

  dispose() {
    this.reader?.dispose();
  }
}

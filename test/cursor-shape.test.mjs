// The depth cursor mirrors the page's CSS cursor (ADR-046 Amendment 2 §C, page side): the CSS →
// sprite map, the procedural sprites (hotspots, style, the arrow unchanged), the read-back that
// must not see the cursor's own hide, and the option/glue on every backend.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CURSOR_ARROW,
  CURSOR_ARROW_FILL,
  CURSOR_HIDDEN_ATTR,
  CURSOR_HIDDEN_RULE,
  CURSOR_SHAPES,
  CURSOR_SHAPE_OPTIONS,
  CURSOR_CSS_READ_MS,
  CursorCssReader,
  CursorPointer,
  CursorShapeSelector,
  cssCursorToShape,
  cursorArrowMesh,
  cursorPickShape,
  cursorPolygonSd,
  cursorShape,
  cursorShapeBox,
  cursorShapeTexture,
  cursorSpriteGLSL,
  cursorSpriteRect,
  cursorSpriteBox,
  CURSOR_CSS_KEYWORDS,
  CURSOR_IMAGE_MAX_PX,
  CursorImageCache,
  cssKeywordToShape,
  curFileHotspot,
  parseCssCursor,
  resolveCursorSprite,
  spriteForName,
  cursorShapePolys,
  cursorShapeRaster,
  cursorShapeSample,
  cursorSoftArrowBox,
  cursorSoftArrowSample,
  readPageCursor,
  resolveCursorOption,
} from '../js/inline3d-cursor-depth.js';
import { resolvePairCursorOption, CURSOR_OPTION_KEYS } from '../js/inline3d-cursor-option.js';
import { DepthCursor } from '../js/inline3d-three.js';
import { PairCursor, drawPairArrow } from '../js/camera/pair-cursor.js';
import { CURSOR_OPTION_KEYS as KEYS } from '../js/inline3d-cursor-option.js';
void KEYS;

// ── A tiny DOM: elements with attributes, listeners, a parent chain, and a cascade where the
// hide rule (on the element or an ancestor) beats everything, as `!important` does.

function el(cursor = 'auto', parent = null) {
  const attrs = new Map();
  const lists = {};
  return {
    nodeType: 1,
    isConnected: true,
    parent,
    style: {},
    cursorRule: cursor, // what the page's stylesheet says
    setAttribute: (k, v) => attrs.set(k, String(v)),
    removeAttribute: (k) => attrs.delete(k),
    hasAttribute: (k) => attrs.has(k),
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    addEventListener(k, f) {
      (lists[k] ||= []).push(f);
    },
    removeEventListener(k, f) {
      lists[k] = (lists[k] || []).filter((g) => g !== f);
    },
    dispatch(k, e = {}) {
      for (const f of (lists[k] || []).slice()) f({ target: this, ...e });
    },
    listeners: (k) => (lists[k] || []).length,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 200 }),
  };
}

function installCascade(html) {
  let reads = 0;
  globalThis.getComputedStyle = (e) => {
    reads++;
    for (let p = e; p; p = p.parent) if (p.hasAttribute(CURSOR_HIDDEN_ATTR)) return { cursor: 'none' };
    return { cursor: e.style.cursor || e.cursorRule };
  };
  const styles = [];
  globalThis.document = {
    documentElement: html,
    head: { appendChild: (s) => styles.push(s) },
    getElementById: (id) => styles.find((s) => s.id === id) || null,
    createElement: () => ({}),
  };
  return { styles, reads: () => reads };
}
function uninstall() {
  delete globalThis.getComputedStyle;
  delete globalThis.document;
}

// ── The map ──────────────────────────────────────────────────────────────────────────────────

test('cssCursorToShape: EVERY standard CSS cursor keyword → its sprite; none → none; unknown → the arrow', () => {
  const table = {
    auto: 'arrow', default: 'arrow', none: 'none',
    pointer: 'pointer', grab: 'grab', '-webkit-grab': 'grab', grabbing: 'grabbing', '-webkit-grabbing': 'grabbing',
    move: 'move', 'all-scroll': 'move', text: 'text', 'vertical-text': 'vertical-text', crosshair: 'crosshair',
    'not-allowed': 'not-allowed', 'no-drop': 'not-allowed', help: 'help', wait: 'wait', progress: 'progress',
    copy: 'copy', alias: 'alias', 'context-menu': 'context-menu', cell: 'cell',
    'n-resize': 'ns-resize', 's-resize': 'ns-resize', 'ns-resize': 'ns-resize',
    'e-resize': 'ew-resize', 'w-resize': 'ew-resize', 'ew-resize': 'ew-resize',
    'ne-resize': 'nesw-resize', 'sw-resize': 'nesw-resize', 'nesw-resize': 'nesw-resize',
    'nw-resize': 'nwse-resize', 'se-resize': 'nwse-resize', 'nwse-resize': 'nwse-resize',
    'col-resize': 'col-resize', 'row-resize': 'row-resize',
    'zoom-in': 'zoom-in', '-webkit-zoom-in': 'zoom-in', 'zoom-out': 'zoom-out', '-webkit-zoom-out': 'zoom-out',
  };
  for (const [css, want] of Object.entries(table)) assert.equal(cssCursorToShape(css), want, css);
  // The map covers exactly that list, and every sprite is reachable from some keyword.
  assert.deepEqual([...CURSOR_CSS_KEYWORDS].sort(), Object.keys(table).sort());
  for (const shape of CURSOR_SHAPES) assert.ok(Object.values(table).includes(shape), `${shape} unreachable`);
  for (const [css, want] of [['  GRAB ', 'grab'], ['wobble', 'arrow'], ['', 'arrow'], ['url(a.png), grab', 'grab'], ['url("x,y.png") 3 4, text', 'text']]) {
    assert.equal(cssCursorToShape(css), want, JSON.stringify(css));
  }
  for (const v of [null, undefined, 42]) assert.equal(cssCursorToShape(v), 'arrow');
  assert.equal(cssKeywordToShape('NOT-ALLOWED'), 'not-allowed');
});

test('parseCssCursor: url list (quotes, commas inside data: URLs, hotspots), image-set skipped, the keyword fallback', () => {
  const p = parseCssCursor('url("data:image/png;base64,AA,BB") 4 5, url(\'b c.cur\'), url(plain.png) 1, -webkit-image-set(url(x.png) 1x) 2 2, pointer');
  assert.deepEqual(p.images, [
    { url: 'data:image/png;base64,AA,BB', hotspot: [4, 5] },
    { url: 'b c.cur', hotspot: null },
    { url: 'plain.png', hotspot: null }, // one number is not a hotspot
  ]);
  assert.equal(p.keyword, 'pointer');
  assert.deepEqual(parseCssCursor('grab'), { images: [], keyword: 'grab' });
  assert.deepEqual(parseCssCursor('url(a.png)').images, [{ url: 'a.png', hotspot: null }]);
  assert.equal(parseCssCursor('url(a.png)').keyword, 'auto', 'no keyword → auto');
  assert.deepEqual(parseCssCursor('url("q\\"x.png") 0 0, move').images[0], { url: 'q"x.png', hotspot: [0, 0] });
  assert.equal(parseCssCursor(null).keyword, 'auto');
  assert.equal(parseCssCursor('url(a.png) 2 3, auto'), parseCssCursor('url(a.png) 2 3, auto'), 'memoised');
});

function fakeImages(states) {
  // { url: {state, width, height, curHotspot} }
  const asked = [];
  return {
    asked,
    get(url) {
      asked.push(url);
      return { url, image: { naturalWidth: 0 }, width: 32, height: 32, curHotspot: null, state: 'loading', ...(states[url] || {}) };
    },
  };
}

test('resolveCursorSprite: the first READY image; failed → next; loading → the keyword fallback; none; hotspot + 128-px cap', () => {
  let r = resolveCursorSprite('url(a.png) 3 4, url(b.png), grab', fakeImages({ 'a.png': { state: 'ready' } }));
  assert.equal(r.kind, 'image');
  assert.equal(r.key, 'a.png');
  assert.deepEqual(r.hotspot, [3, 4], 'explicit hotspot');
  assert.deepEqual(cursorSpriteRect(r), [-3 / 19, -4 / 19, 29 / 19, 28 / 19], 'CSS px → sprite units around the hotspot');
  r = resolveCursorSprite('url(a.png) 3 4, url(b.png), grab', fakeImages({ 'a.png': { state: 'failed' }, 'b.png': { state: 'ready' } }));
  assert.equal(r.key, 'b.png', 'a failed (e.g. no CORS) url falls to the next');
  assert.deepEqual(r.hotspot, [0, 0], 'no hotspot, not a .cur → 0 0');
  const imgs = fakeImages({});
  r = resolveCursorSprite('url(a.png), url(b.png), grab', imgs);
  assert.deepEqual(r, spriteForName('grab'), 'still loading → the keyword fallback');
  assert.deepEqual(imgs.asked, ['a.png'], 'and the next url is not fetched while the first may still load');
  r = resolveCursorSprite('url(a.png), url(b.png), grab', fakeImages({ 'a.png': { state: 'failed' }, 'b.png': { state: 'failed' } }));
  assert.equal(r.name, 'grab', 'all failed → the keyword');
  r = resolveCursorSprite('url(a.cur), auto', fakeImages({ 'a.cur': { state: 'ready', curHotspot: [7, 9] } }));
  assert.deepEqual(r.hotspot, [7, 9], "a .cur file's own hotspot");
  r = resolveCursorSprite('url(big.png) 100 50, auto', fakeImages({ 'big.png': { state: 'ready', width: 256, height: 200 } }));
  assert.deepEqual([r.width, r.height], [CURSOR_IMAGE_MAX_PX, 100], 'capped at 128 CSS px, aspect kept');
  assert.deepEqual(r.hotspot, [50, 25], 'the hotspot scales with it');
  assert.deepEqual(resolveCursorSprite('none'), { kind: 'none' });
  assert.deepEqual(resolveCursorSprite('url(x.png), none', fakeImages({ 'x.png': { state: 'failed' } })), { kind: 'none' });
  assert.deepEqual(resolveCursorSprite('wobble'), spriteForName('arrow'));
  const b = cursorSpriteBox(spriteForName('grab'), 0.1, 0.01), t = cursorSpriteRect(spriteForName('grab'));
  b.forEach((v, i) => assert.ok(Math.abs(v - (t[i] + (i < 2 ? -0.11 : 0.11))) < 1e-12));
});

test('curFileHotspot: reads a .cur header (the entry matching the width, else the first); not a cursor → null', () => {
  const cur = (entries) => {
    const b = new ArrayBuffer(6 + 16 * entries.length);
    const v = new DataView(b);
    v.setUint16(0, 0, true);
    v.setUint16(2, 2, true);
    v.setUint16(4, entries.length, true);
    entries.forEach(([w, x, y], i) => {
      v.setUint8(6 + 16 * i, w);
      v.setUint16(6 + 16 * i + 4, x, true);
      v.setUint16(6 + 16 * i + 6, y, true);
    });
    return b;
  };
  assert.deepEqual(curFileHotspot(cur([[32, 5, 6]])), [5, 6]);
  assert.deepEqual(curFileHotspot(cur([[16, 1, 2], [32, 10, 12]]), 32), [10, 12]);
  assert.deepEqual(curFileHotspot(cur([[16, 1, 2], [32, 10, 12]]), 48), [1, 2]);
  const ico = cur([[32, 5, 6]]);
  new DataView(ico).setUint16(2, 1, true); // type 1 = an .ico: no hotspot
  assert.equal(curFileHotspot(ico), null);
  assert.equal(curFileHotspot(new ArrayBuffer(4)), null);
  assert.equal(curFileHotspot(null), null);
});

test('CursorImageCache: crossOrigin anonymous, cached per URL, ready on load, failed on error (no CORS), .cur hotspot fetched', async () => {
  const made = [];
  class FakeImage {
    constructor() {
      made.push(this);
    }
    set src(v) {
      this._src = v;
    }
  }
  const fetched = [];
  const curBytes = (() => {
    const b = new ArrayBuffer(22);
    const v = new DataView(b);
    v.setUint16(2, 2, true);
    v.setUint16(4, 1, true);
    v.setUint8(6, 32);
    v.setUint16(10, 3, true);
    v.setUint16(12, 4, true);
    return b;
  })();
  const c = new CursorImageCache({ ImageCtor: FakeImage, fetchFn: async (u, o) => (fetched.push([u, o]), { ok: true, arrayBuffer: async () => curBytes }) });
  const a = c.get('a.png');
  assert.equal(c.get('a.png'), a, 'one entry per URL');
  assert.equal(made.length, 1);
  assert.equal(made[0].crossOrigin, 'anonymous');
  assert.equal(made[0]._src, 'a.png');
  assert.equal(a.state, 'loading');
  Object.assign(made[0], { naturalWidth: 24, naturalHeight: 20 });
  made[0].onload();
  assert.equal(a.state, 'ready');
  assert.deepEqual([a.width, a.height], [24, 20]);
  assert.equal(fetched.length, 0, 'a .png is not fetched for a hotspot');
  const b = c.get('https://x.example/b.png');
  made[1].onerror(); // a cross-origin image without CORS fails to load with crossOrigin set
  assert.equal(b.state, 'failed');
  const k = c.get('hand.cur');
  Object.assign(made[2], { naturalWidth: 32, naturalHeight: 32 });
  made[2].onload();
  assert.equal(k.state, 'loading', 'a .cur waits for its hotspot');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(k.state, 'ready');
  assert.deepEqual(k.curHotspot, [3, 4]);
  assert.deepEqual(fetched[0], ['hand.cur', { mode: 'cors' }]);
  const zero = c.get('zero.png');
  Object.assign(made[3], { naturalWidth: 0, naturalHeight: 0 });
  made[3].onload();
  assert.equal(zero.state, 'failed', 'a 0×0 image is not a cursor');
  assert.equal(new CursorImageCache({ ImageCtor: undefined }).get('a.png').state, 'failed', 'no Image (a worker, node): failed, the keyword is drawn');
});

test('cursorPickShape: shapeFor wins when it names a sprite, then a fixed shape, then the CSS, then the arrow', () => {
  assert.equal(cursorPickShape('auto', 'move', 'grab'), 'move');
  assert.equal(cursorPickShape('auto', undefined, 'grab'), 'grab');
  assert.equal(cursorPickShape('auto', 'auto', 'grabbing'), 'grabbing', "shapeFor 'auto' defers to the CSS");
  assert.equal(cursorPickShape('auto', 'bogus', 'pointer'), 'pointer');
  assert.equal(cursorPickShape('pointer', undefined, 'grab'), 'pointer', 'a fixed shape ignores the CSS');
  assert.equal(cursorPickShape('pointer', 'grab', null), 'grab');
  assert.equal(cursorPickShape('auto', null, null), 'arrow');
  assert.equal(cursorPickShape(undefined, undefined, 'bogus'), 'arrow');
  assert.equal(cursorPickShape('auto', undefined, 'none'), 'none', "the page's none");
  assert.equal(cursorPickShape('none', undefined, 'grab'), 'none');
  assert.equal(cursorPickShape('auto', 'none', 'grab'), 'none');
  assert.deepEqual([...CURSOR_SHAPE_OPTIONS], ['auto', 'none', ...CURSOR_SHAPES]);
});

// ── The sprites ──────────────────────────────────────────────────────────────────────────────

const convex = (poly) => {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const [a, b, c] = [poly[i], poly[(i + 1) % poly.length], poly[(i + 2) % poly.length]];
    const z = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(z) < 1e-12) continue;
    if (sign && Math.sign(z) !== sign) return false;
    sign = Math.sign(z);
  }
  return true;
};
const unionSd = (polys, x, y) => Math.min(...polys.map((p) => cursorPolygonSd(p, x, y)));

test('shapes: the arrow is the arrow — same polygons, same mesh, same soft samples, same box', () => {
  const a = cursorShape('arrow');
  assert.equal(a.parts[0], CURSOR_ARROW);
  assert.equal(a.fill[0], CURSOR_ARROW_FILL);
  void cursorArrowMesh;
  assert.deepEqual(cursorShapeBox('arrow', 0.05, 0.01), cursorSoftArrowBox(0.05, 0.01));
  for (const [x, y] of [[0.02, 0.05], [0.2, 0.5], [0.3, 0.75], [0.05, 0.6], [-0.01, 0.2], [0.4, 0.95]]) {
    for (const r of [0, 0.06]) {
      const s = cursorShapeSample('arrow', x, y, r, 1 / 64);
      const t = cursorSoftArrowSample(x, y, r, 1 / 64);
      s.forEach((v, i) => assert.ok(Math.abs(v - t[i]) < 1e-12, `${x},${y} r=${r}: ${s} vs ${t}`));
    }
  }
  assert.equal(cursorShape('bogus').name, 'arrow', 'unknown names draw the arrow');
});

test('shapes: valid 1/19 fills inside the outline, the OS cursor size, the hotspot at the natural point', () => {
  const area = (p) => p.reduce((t, q, i) => t + q[0] * p[(i + 1) % p.length][1] - p[(i + 1) % p.length][0] * q[1], 0);
  for (const name of CURSOR_SHAPES) {
    const s = cursorShape(name);
    assert.equal(s.parts.length, s.fill.length);
    s.parts.forEach((p, i) => {
      // The inset keeps every edge: same winding, and every fill vertex ~1 px inside ITS part (a
      // chamfer too big for the width flips an edge and pushes a vertex out).
      assert.equal(Math.sign(area(s.fill[i])), Math.sign(area(p)), `${name}: part ${i} fill flipped`);
      for (const [x, y] of s.fill[i]) assert.ok(cursorPolygonSd(p, x, y) < -0.04, `${name}: part ${i} fill vertex ${x},${y} not inset`);
    });
    // Detail marks sit on the white fill.
    for (const d of s.detail) for (const [x, y] of d) assert.ok(unionSd(s.fill, x, y) < 0.01, `${name}: detail off the fill`);
    const [x0, y0, x1, y1] = s.box;
    const big = Math.max(x1 - x0, y1 - y0);
    assert.ok(big > (name === 'grabbing' ? 0.6 : 0.8) && big <= 1.0001, `${name}: about one arrow (${big})`);
  }
  // Tips: the arrow, the pointing hand, and every arrow-with-a-badge have their hotspot on the tip.
  for (const name of ['arrow', 'pointer', 'help', 'progress', 'copy', 'alias', 'context-menu']) {
    const s = cursorShape(name);
    assert.ok(Math.abs(s.box[1]) < 1e-9, `${name}: nothing above the hotspot`);
    assert.ok(Math.abs(unionSd(s.parts, 0, 0)) < 0.03, `${name}: the hotspot is on the tip`);
  }
  // Centred cursors: the hotspot at the centre of the box.
  for (const name of ['move', 'text', 'vertical-text', 'crosshair', 'cell', 'not-allowed', 'wait', 'ns-resize', 'ew-resize', 'nesw-resize', 'nwse-resize', 'col-resize', 'row-resize']) {
    const b = cursorShape(name).box;
    assert.ok(Math.abs(b[0] + b[2]) < 0.03 && Math.abs(b[1] + b[3]) < 0.03, `${name}: centred on its hotspot (${b})`);
  }
  // The hands: in the palm (white); the magnifiers: the lens centre (white, inside the + / −'s gap or on it).
  for (const name of ['grab', 'grabbing']) assert.deepEqual(cursorShapeSample(name, 0, 0, 0, 0), [1, 1, 1, 1], `${name}: white at the hotspot`);
  for (const name of ['zoom-in', 'zoom-out']) assert.ok(unionSd(cursorShape(name).fill, 0, 0) < -0.2, `${name}: hotspot deep in the lens`);
  assert.ok(cursorShape('grab').box[1] < cursorShape('grabbing').box[1] - 0.15, 'the open hand reaches higher than the fist');
  // Orientation: the horizontal ones are wide, the vertical ones tall.
  const wh = (n) => { const b = cursorShape(n).box; return (b[2] - b[0]) / (b[3] - b[1]); };
  for (const n of ['ew-resize', 'vertical-text']) assert.ok(wh(n) > 1.5, `${n} is horizontal`);
  for (const n of ['ns-resize', 'text']) assert.ok(wh(n) < 0.67, `${n} is vertical`);
  assert.ok(wh('col-resize') > 1 && wh('row-resize') < 1, 'the splitters point across their bar');
  // The detail marks are drawn dark: the + of zoom-in at the lens centre, not on zoom-out's vertical.
  assert.ok(cursorShapeSample('zoom-in', 0, -2 / 19, 0, 0)[0] < 0.1, 'zoom-in: the + is dark');
  assert.deepEqual(cursorShapeSample('zoom-out', 0, -2 / 19, 0, 0), [1, 1, 1, 1], 'zoom-out: no vertical stroke');
  assert.ok(cursorShapeSample('not-allowed', 0, 0, 0, 0)[0] > 0.9, 'not-allowed: the slash is white at the centre');
  assert.equal(cursorShapeSample('not-allowed', 0, -6 / 19, 0, 0)[3], 1, 'the ring is drawn');
  assert.equal(cursorShapeSample('not-allowed', -2.5 / 19, 2.5 / 19, 0, 0)[3], 0, 'and its inside (off the slash) is clear');
});

test('shapes: the hands show dark seams between fingers (abutting parts), and one white palm (overlapping parts)', () => {
  const s = cursorShape('grab');
  // Between index and middle, above the palm: dark. Mid-palm: white.
  const seamY = (2 - 10) / 19; // 2 px under the middle finger's top… well above the palm (y = 9.4 px)
  let dark = 0;
  for (let x = -3; x <= -1; x += 0.05) {
    const c = cursorShapeSample('grab', x / 19, (5 - 10) / 19, 0, 0);
    if (c[3] === 1 && c[0] < 0.1) dark++;
  }
  assert.ok(dark > 0, 'a dark seam between index and middle');
  assert.ok(seamY < 0);
  for (const [x, y] of [[0, 2], [2, 4], [-3, 4], [4, 2]]) {
    assert.deepEqual(cursorShapeSample('grab', x / 19, y / 19, 0, 0), [1, 1, 1, 1], `palm white at ${x},${y}`);
  }
  // The rim: just inside the outline it is dark (the outline), everywhere.
  const top = s.box[1];
  const c = cursorShapeSample('grab', ((7.4 - 8.6) / 19), top + 0.3 / 19, 0, 0);
  assert.equal(c[3], 1);
  assert.ok(c[0] < 0.1, 'the rim is the dark outline');
});

test('cursorShapeTexture: every keyword sprite as a crisp texture covering its box, row 0 = the top, built once', () => {
  for (const name of CURSOR_SHAPES) {
    const t = cursorShapeTexture(name);
    assert.equal(cursorShapeTexture(name), t, 'cached');
    assert.equal(t.data.length, t.width * t.height * 4);
    const [r0, r1, r2, r3] = t.rect, b = cursorShape(name).box;
    assert.ok(r0 <= b[0] && r1 <= b[1] && r2 >= b[2] && r3 >= b[3], `${name}: the texture covers the shape`);
    assert.ok(Math.abs((r2 - r0) * 64 - t.width) < 1e-9 && Math.abs((r3 - r1) * 64 - t.height) < 1e-9, `${name}: 64 texels per unit`);
    let opaque = 0;
    for (let i = 3; i < t.data.length; i += 4) opaque += t.data[i] === 255;
    assert.ok(opaque > 200, `${name}: drawn (${opaque} opaque texels)`);
    assert.deepEqual(cursorSpriteRect(spriteForName(name)), [...t.rect]);
  }
  // Row 0 is the top: the arrow's tip texel (top-left) is opaque, its bottom-left corner is clear.
  const a = cursorShapeTexture('arrow');
  const at = (x, y) => a.data[(y * a.width + x) * 4 + 3];
  assert.ok(at(1, 1) > 0, 'tip at the top-left');
  assert.equal(at(1, a.height - 2), 0);
});

test('shapes: the soft box grows around the hotspot only; the raster puts the hotspot where asked', () => {
  for (const name of CURSOR_SHAPES) {
    const b0 = cursorShapeBox(name, 0, 0), b1 = cursorShapeBox(name, 0.06, 0.02);
    assert.deepEqual(b0, [...cursorShape(name).box]);
    b1.forEach((v, i) => assert.ok(Math.abs(v - (b0[i] + (i < 2 ? -0.08 : 0.08))) < 1e-12));
    // A 64-px sprite with its hotspot at (100.5, 80.5): the pixel there is opaque for the filled shapes.
    const r = cursorShapeRaster(name, 100.5, 80.5, 64, 0, 1);
    assert.ok(r.x0 <= 100 && r.y0 <= 80 && r.x0 + r.width > 100 && r.y0 + r.height > 80);
    // A centred cursor's hotspot pixel is ON it (opaque); a tip's is at its edge.
    const o = ((80 - r.y0) * r.width + (100 - r.x0)) * 4;
    if (['grab', 'grabbing', 'move', 'text', 'vertical-text', 'crosshair', 'cell', 'not-allowed', 'ns-resize', 'ew-resize', 'nesw-resize', 'nwse-resize', 'col-resize', 'row-resize', 'zoom-in', 'zoom-out'].includes(name)) {
      assert.equal(r.data[o + 3], 255, `${name}: hotspot pixel on the sprite`);
    }
    if (['grab', 'grabbing', 'move', 'text', 'crosshair', 'cell'].includes(name)) {
      assert.deepEqual(Array.from(r.data.slice(o, o + 4)), [255, 255, 255, 255], `${name}: hotspot pixel white`);
    }
  }
  // Opacity applies to alpha only, never the colour (no CSS opacity anywhere: it is in the pixels).
  const a = cursorShapeRaster('grab', 50, 50, 38, 0, 1), h = cursorShapeRaster('grab', 50, 50, 38, 0, 0.5);
  let checked = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (a.data[i + 3] !== 255) continue;
    assert.equal(h.data[i], a.data[i]);
    assert.ok(Math.abs(h.data[i + 3] - 128) <= 1);
    checked++;
  }
  assert.ok(checked > 100);
});

test('cursorSpriteGLSL: one textured program for every non-arrow sprite; the 13-tap kernel; no loops or arrays (ES 1.00)', () => {
  const src = cursorSpriteGLSL();
  assert.match(src, /vec4 inline3dSoftSprite\(sampler2D tex, vec2 p, vec4 rect, float radius\)/);
  assert.equal(src.match(/acc \+= /g).length, 12, '12 off-centre taps + the centre');
  assert.match(src, /texture2D\(tex, uv\)/);
  assert.match(src, /uv\.x < 0\.0 \|\| uv\.y < 0\.0 \|\| uv\.x > 1\.0 \|\| uv\.y > 1\.0/, 'taps off the texture are transparent');
  assert.match(src, /c\.rgb \* c\.a/, 'premultiplied accumulation');
  assert.doesNotMatch(src, /\bfor\s*\(|\bwhile\s*\(|\[\s*\d+\s*\]/);
});

// ── The read-back ────────────────────────────────────────────────────────────────────────────

test('readPageCursor: lifts the hide for the read, puts it back, never touches the inline style', () => {
  const html = el('auto');
  const canvas = el('grab', html);
  installCascade(html);
  try {
    canvas.setAttribute(CURSOR_HIDDEN_ATTR, '');
    assert.equal(globalThis.getComputedStyle(canvas).cursor, 'none', 'hidden as the page sees it');
    assert.equal(readPageCursor(canvas, [canvas, html]), 'grab', 'but the read sees the page cursor');
    assert.equal(canvas.hasAttribute(CURSOR_HIDDEN_ATTR), true, 'and the hide is back');
    // pointerScope 'window': the attribute on <html>.
    canvas.removeAttribute(CURSOR_HIDDEN_ATTR);
    html.setAttribute(CURSOR_HIDDEN_ATTR, '');
    canvas.style.cursor = 'grabbing';
    assert.equal(readPageCursor(canvas, [canvas, html]), 'grabbing');
    assert.equal(html.hasAttribute(CURSOR_HIDDEN_ATTR), true);
    assert.equal(canvas.hasAttribute(CURSOR_HIDDEN_ATTR), false, 'no attribute added where there was none');
    assert.equal(canvas.style.cursor, 'grabbing');
    // A throwing getComputedStyle still restores the hide.
    globalThis.getComputedStyle = () => {
      throw new Error('boom');
    };
    assert.equal(readPageCursor(canvas, [canvas, html]), null);
    assert.equal(html.hasAttribute(CURSOR_HIDDEN_ATTR), true, 'restored after a throw');
    assert.equal(readPageCursor(null, [html]), null);
  } finally {
    uninstall();
  }
});

test('CursorPointer hide: data attribute + ONE injected rule, never the inline style', () => {
  const html = el('auto');
  const canvas = el('grab', html);
  const { styles } = installCascade(html);
  try {
    canvas.style.cursor = 'grab';
    const p = new CursorPointer(canvas);
    p.hideCss(true);
    p.hideCss(true);
    assert.equal(canvas.getAttribute(CURSOR_HIDDEN_ATTR), '');
    assert.equal(canvas.style.cursor, 'grab');
    assert.equal(styles.length, 1);
    assert.equal(styles[0].textContent, CURSOR_HIDDEN_RULE);
    const q = new CursorPointer(el('auto', html));
    q.hideCss(true);
    assert.equal(styles.length, 1, 'one rule per document, however many cursors');
    p.hideCss(false);
    assert.equal(canvas.hasAttribute(CURSOR_HIDDEN_ATTR), false);
    p.dispose();
    q.dispose();
  } finally {
    uninstall();
  }
});

test('CursorCssReader: reads on the FRAME, never in the listener; moves throttled, press/release at once', () => {
  const html = el('auto');
  const canvas = el('grab', html);
  const cas = installCascade(html);
  try {
    const pointer = { canvas, scope: 'canvas' };
    const r = new CursorCssReader(pointer);
    // The Shop pattern: the PAGE toggles a class on pointerdown/up, in a listener added after ours.
    canvas.addEventListener('pointerdown', () => (canvas.cursorRule = 'grabbing'));
    canvas.addEventListener('pointerup', () => (canvas.cursorRule = 'grab'));
    canvas.setAttribute(CURSOR_HIDDEN_ATTR, ''); // the sprite is drawing
    assert.equal(r.shape(0), 'grab', 'first frame reads');
    assert.equal(r.reads, 1);
    canvas.dispatch('pointermove');
    assert.equal(cas.reads(), 1, 'a listener never reads (no style recalc per event)');
    assert.equal(r.shape(10), 'grab');
    assert.equal(r.reads, 1, 'a move within the throttle does not re-read');
    assert.equal(r.shape(CURSOR_CSS_READ_MS + 1), 'grab');
    assert.equal(r.reads, 2, 'once the throttle has passed, it does');
    assert.equal(r.shape(CURSOR_CSS_READ_MS + 2), 'grab');
    assert.equal(r.reads, 2, 'nothing new since: no read');
    canvas.dispatch('pointerdown');
    assert.equal(r.shape(CURSOR_CSS_READ_MS + 3), 'grabbing', 'press: read at once, AFTER the page handler ran');
    canvas.dispatch('pointerup');
    assert.equal(r.shape(CURSOR_CSS_READ_MS + 4), 'grab', 'release: read at once');
    assert.equal(r.css, 'grab');
    assert.equal(canvas.hasAttribute(CURSOR_HIDDEN_ATTR), true, 'the hide survives every read');
    // The element under the pointer is the one read (overlay DOM under pointerScope 'window').
    const badge = el('pointer', html);
    canvas.dispatch('pointerdown', { target: badge, composedPath: () => [badge, canvas, html] });
    assert.equal(r.shape(1000), 'pointer');
    r.dispose();
    assert.equal(canvas.listeners('pointermove'), 0);
    assert.equal(canvas.listeners('pointerdown'), 1, "only the page's own listener is left");
  } finally {
    uninstall();
  }
});

test('CursorShapeSelector: no reader (no listeners) unless something may read the CSS; shapeFor overrides; none', () => {
  const canvas = el('grab');
  installCascade(el('auto'));
  try {
    const fixed = new CursorShapeSelector({ canvas, scope: 'canvas' }, { shape: 'move' });
    assert.equal(fixed.reader, null);
    assert.equal(canvas.listeners('pointermove'), 0, 'a fixed shape adds no listener');
    assert.deepEqual(fixed.pick({ u: 0.5, v: 0.5, point: null }, 0), spriteForName('move'));
    const auto = new CursorShapeSelector({ canvas, scope: 'canvas' });
    assert.equal(auto.pick({ u: 0.5, v: 0.5, point: null }, 0).name, 'grab');
    assert.equal(auto.current, 'grab');
    let seen;
    const sf = new CursorShapeSelector({ canvas, scope: 'canvas' }, { shapeFor: (h) => ((seen = h), h.point ? 'pointer' : undefined) });
    assert.equal(sf.pick({ u: 0.2, v: 0.3, point: [0, 0, 1] }, 0).name, 'pointer');
    assert.deepEqual(seen, { u: 0.2, v: 0.3, point: [0, 0, 1], css: 'grab', cssValue: 'grab' });
    assert.equal(sf.pick({ u: 0.2, v: 0.3, point: null }, 1).name, 'grab', 'nothing from shapeFor → the CSS');
    const warn = console.warn;
    console.warn = () => {};
    try {
      const bad = new CursorShapeSelector({ canvas, scope: 'canvas' }, { shapeFor: () => { throw new Error('x'); } });
      assert.equal(bad.pick({ u: 0, v: 0, point: null }, 0).name, 'grab', 'a throwing shapeFor falls back');
    } finally {
      console.warn = warn;
    }
    canvas.cursorRule = 'none';
    const none = new CursorShapeSelector({ canvas, scope: 'canvas' });
    assert.deepEqual(none.pick({ u: 0, v: 0, point: null }, 0), { kind: 'none' }, "the page's none");
    assert.equal(none.current, 'none');
    assert.throws(() => new CursorShapeSelector({ canvas, scope: 'canvas' }, { shape: 'hand' }), /cursor\.shape "hand"/);
    for (const s of [fixed, auto, sf, none]) s.dispose();
  } finally {
    uninstall();
  }
});

test('options: shape / shapeFor accepted on scenes and pairs, validated at the call', () => {
  assert.ok(CURSOR_OPTION_KEYS.includes('shape') && CURSOR_OPTION_KEYS.includes('shapeFor'));
  const f = () => 'grab';
  assert.deepEqual(resolveCursorOption({ shape: 'grab' }), { shape: 'grab' });
  assert.equal(resolveCursorOption({ shapeFor: f }).shapeFor, f);
  assert.deepEqual(resolvePairCursorOption({ shape: 'pointer' }), { shape: 'pointer' });
  for (const s of CURSOR_SHAPE_OPTIONS) assert.doesNotThrow(() => resolveCursorOption({ shape: s }));
  assert.throws(() => resolveCursorOption({ shape: 'hand' }), /cursor\.shape "hand"/);
  assert.throws(() => resolveCursorOption({ shape: 'wobble' }), /expected 'auto'/);
  assert.doesNotThrow(() => resolveCursorOption({ shape: 'none' }));
  assert.throws(() => resolveCursorOption({ shapeFor: 'grab' }), /shapeFor must be a function/);
  assert.throws(() => resolvePairCursorOption({ shapeFor: 3 }), /shapeFor must be a function/);
});

// ── The backends ─────────────────────────────────────────────────────────────────────────────

function stubTHREE() {
  class Attr {
    constructor(a) {
      this.array = a;
    }
  }
  class Geo {
    setAttribute(k, v) {
      this[k] = v;
    }
    dispose() {
      this.disposed = true;
    }
  }
  class Mat {
    constructor(o) {
      Object.assign(this, o);
    }
    dispose() {}
  }
  class V4 {
    set(...a) {
      this.v = a;
      return this;
    }
  }
  class V3 extends V4 {
    constructor(...a) {
      super();
      this.v = a;
    }
  }
  class Mesh {
    constructor(g, m) {
      this.geometry = g;
      this.material = m;
      this.matrix = { elements: new Array(16), fromArray(a) { this.elements = a; return this; } };
    }
  }
  class Tex {
    constructor(image) {
      this.image = image;
      this.colorSpace = '';
    }
    dispose() {
      this.disposed = true;
    }
  }
  class DataTex extends Tex {
    constructor(data, width, height) {
      super({ data, width, height });
    }
  }
  return { BufferGeometry: Geo, Float32BufferAttribute: Attr, MeshBasicMaterial: Mat, ShaderMaterial: Mat, Vector4: V4, Vector3: V3, Mesh, DoubleSide: 2, ShaderChunk: { colorspace_fragment: '' },
    Texture: Tex, DataTexture: DataTex, RGBAFormat: 1023, LinearFilter: 1006, ClampToEdgeWrapping: 1001, SRGBColorSpace: 'srgb' };
}
function kooima(eye, w = 0.3, h = 0.2) {
  const n = 0.01, f = 100;
  const l = ((-w / 2 - eye[0]) * n) / eye[2], r = ((w / 2 - eye[0]) * n) / eye[2];
  const b = ((-h / 2 - eye[1]) * n) / eye[2], t = ((h / 2 - eye[1]) * n) / eye[2];
  const P = new Array(16).fill(0);
  P[0] = (2 * n) / (r - l); P[5] = (2 * n) / (t - b); P[8] = (r + l) / (r - l); P[9] = (t + b) / (t - b);
  P[10] = -(f + n) / (f - n); P[11] = -1; P[14] = (-2 * f * n) / (f - n);
  const T = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, eye[0], eye[1], eye[2], 1];
  return { projectionMatrix: P, transformMatrix: T };
}

test('DepthCursor (three): the Shop case — CSS grab → grabbing on press → grab on release, drawn in the sprite; arrow off the content', () => {
  const html = el('auto');
  const canvas = el('grab', html);
  installCascade(html);
  try {
    const hitTest = (o, d) => {
      const t = (0.1 - o[2]) / d[2];
      return t > 0 ? [o[0] + d[0] * t, o[1] + d[1] * t, 0.1] : null;
    };
    canvas.addEventListener('pointerdown', () => (canvas.cursorRule = 'grabbing')); // the page's own handler
    canvas.addEventListener('pointerup', () => (canvas.cursorRule = 'grab'));
    const cur = new DepthCursor(stubTHREE(), { canvas, hitTest });
    const views = [kooima([-0.032, 0, 0.6]), kooima([0.032, 0, 0.6])];
    const seq = [];
    let t = 1000;
    const frame = () => {
      const p = cur.update(views, (t += 16));
      assert.equal(p.active, true);
      const u = cur.object.material.uniforms;
      seq.push([cur.shape, u && u.inline3dCursorTex ? u.inline3dCursorTex.value : null]);
    };
    canvas.dispatch('pointermove', { clientX: 150, clientY: 100 });
    frame();
    canvas.dispatch('pointerdown', { clientX: 150, clientY: 100 });
    frame();
    canvas.dispatch('pointermove', { clientX: 152, clientY: 100 });
    frame();
    canvas.dispatch('pointerup', { clientX: 152, clientY: 100 });
    frame();
    assert.deepEqual(seq.map((s) => s[0]), ['grab', 'grabbing', 'grabbing', 'grab']);
    const tex = seq.map((s) => s[1]);
    assert.ok(tex.every(Boolean), 'drawn by the textured quad');
    assert.equal(tex[0], tex[3], 'one texture per sprite, reused');
    assert.notEqual(tex[0], tex[1]);
    assert.deepEqual(tex[0].image.data, cursorShapeTexture('grab').data);
    assert.deepEqual(tex[1].image.data, cursorShapeTexture('grabbing').data);
    assert.equal(tex[0].flipY, false, 'row 0 = the top');
    assert.equal(tex[0].colorSpace, 'srgb', 'sRGB bytes, decoded once');
    assert.equal(canvas.hasAttribute(CURSOR_HIDDEN_ATTR), true, 'OS cursor hidden while the sprite draws');
    assert.equal(canvas.style.cursor, undefined, 'the inline style is never written');
    cur.dispose();
  } finally {
    uninstall();
  }
});

test('DepthCursor (three): crisp frames keep the arrow mesh; other sprites use the textured quad at radius 0; none hides the sprite but not the hide', () => {
  const html = el('auto');
  const canvas = el('crosshair', html);
  installCascade(html);
  try {
    const hitTest = (o, d) => {
      const t = (0.1 - o[2]) / d[2];
      return [o[0] + d[0] * t, o[1] + d[1] * t, 0.1];
    };
    const views = [kooima([-0.032, 0, 0.6]), kooima([0.032, 0, 0.6])];
    const fixed = new DepthCursor(stubTHREE(), { canvas, hitTest, shape: 'move', soften: 'off' });
    assert.equal(fixed.shapes.reader, null, 'a fixed shape builds no reader');
    fixed.setPointer(0.5, 0.5);
    fixed.update(views, 1000);
    assert.equal(fixed.shape, 'move');
    const u = fixed.object.material.uniforms;
    assert.equal(u.inline3dCursorSoft.value.v[0], 0, 'crisp: radius 0');
    assert.equal(u.inline3dCursorSoft.value.v[1], 1, 'crisp: opaque');
    assert.deepEqual(u.inline3dCursorRect.value.v, [...cursorShapeTexture('move').rect]);
    fixed.dispose();
    const arrow = new DepthCursor(stubTHREE(), { canvas, hitTest, shape: 'arrow', soften: 'off' });
    arrow.setPointer(0.5, 0.5);
    arrow.update(views, 1000);
    assert.equal(arrow.object.material.vertexColors, true, 'the arrow keeps its crisp mesh (pixel-identical to before)');
    arrow.dispose();
    // The page says none: nothing drawn, but the OS cursor stays hidden while lifted.
    canvas.cursorRule = 'none';
    const none = new DepthCursor(stubTHREE(), { canvas, hitTest });
    none.setPointer(0.5, 0.5);
    const p = none.update(views, 1000);
    assert.equal(p.active, true);
    assert.equal(none.shape, 'none');
    assert.equal(none.object.visible, false, 'no sprite');
    assert.equal(canvas.hasAttribute(CURSOR_HIDDEN_ATTR), true, 'and no OS cursor either');
    none.dispose();
  } finally {
    uninstall();
  }
});

test('PairCursor: draws the page cursor\'s shape into both halves', () => {
  const html = el('auto');
  const canvas = el('grab', html);
  installCascade(html);
  try {
    const ops = [];
    const g = {
      save() {}, restore() {}, clip() {}, rect() {},
      beginPath() { this.p = []; }, moveTo(x, y) { this.p.push([x, y]); }, lineTo(x, y) { this.p.push([x, y]); }, closePath() {},
      fill() { ops.push({ style: this.fillStyle, pts: this.p }); },
    };
    drawPairArrow(g, 400, 300, 0.25, 0.5, 12, 19, 'grab');
    const parts = cursorShape('grab').parts.length;
    assert.equal(ops.length, 2 * 2 * parts, 'outline + fill parts, in each eye');
    assert.equal(ops[0].style, '#000');
    assert.equal(ops[parts].style, '#fff');
    // Left eye's hotspot at 0.25·400 + 6: the palm's box is centred near it.
    const xs = ops.slice(0, parts).flatMap((o) => o.pts.map((p) => p[0]));
    assert.ok(Math.min(...xs) < 106 && Math.max(...xs) > 106);
    const polys = cursorShapePolys('grab', 1 / 19);
    assert.equal(polys.fill, cursorShape('grab').fill, 'the 1/19 fill is shared, not rebuilt');
    void PairCursor;
  } finally {
    uninstall();
  }
});

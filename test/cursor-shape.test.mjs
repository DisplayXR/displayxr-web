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
  cursorShapeGLSL,
  cursorShapeMesh,
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

test('cssCursorToShape: the keywords with a twin, and the arrow for everything else', () => {
  const table = {
    auto: 'arrow',
    default: 'arrow',
    pointer: 'pointer',
    grab: 'grab',
    '-webkit-grab': 'grab',
    grabbing: 'grabbing',
    '-webkit-grabbing': 'grabbing',
    move: 'move',
    'all-scroll': 'move',
    text: 'arrow',
    crosshair: 'arrow',
    'ns-resize': 'arrow',
    'nwse-resize': 'arrow',
    'col-resize': 'arrow',
    wait: 'arrow',
    'not-allowed': 'arrow',
    none: 'arrow',
    '  GRAB ': 'grab',
    'url("hand.png") 4 4, grab': 'arrow', // an image cursor has no procedural twin
    'url(a.cur), url(b.png) 2 2, pointer': 'arrow',
    'image-set("a.png" 1x) 4 4, pointer': 'arrow',
    'grab, pointer': 'grab',
    '': 'arrow',
  };
  for (const [css, want] of Object.entries(table)) assert.equal(cssCursorToShape(css), want, JSON.stringify(css));
  assert.equal(cssCursorToShape(null), 'arrow');
  assert.equal(cssCursorToShape(undefined), 'arrow');
  assert.equal(cssCursorToShape(42), 'arrow');
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
  assert.deepEqual([...CURSOR_SHAPE_OPTIONS], ['auto', ...CURSOR_SHAPES]);
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
  assert.deepEqual(cursorShapeMesh('arrow'), cursorArrowMesh());
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

test('shapes: convex parts, a 1/19 fill inside the outline, the OS cursor size, the hotspot at the natural point', () => {
  for (const name of CURSOR_SHAPES) {
    const s = cursorShape(name);
    assert.equal(s.index, CURSOR_SHAPES.indexOf(name));
    assert.equal(s.parts.length, s.fill.length);
    if (name !== 'arrow') {
      for (const p of s.parts) assert.ok(convex(p), `${name}: a part is not convex`);
      // The inset must keep every edge: a chamfer too big for the width flips one (a bow-tie fill).
      for (const f of s.fill) assert.ok(convex(f), `${name}: a fill part is not convex (edge flipped by the inset)`);
    }
    // Every fill vertex is inside the outline by ~1/19 (the dark rim).
    for (const f of s.fill) for (const [x, y] of f) assert.ok(unionSd(s.parts, x, y) < -0.04, `${name}: fill at ${x},${y} not inset`);
    const [x0, y0, x1, y1] = s.box;
    const tall = name === 'grabbing' ? 0.65 : 0.85; // the fist is shorter: its fingers are curled
    assert.ok(y1 - y0 > tall && y1 - y0 <= 1.0001, `${name}: about one arrow tall (${y1 - y0})`);
    assert.ok(x1 - x0 <= 1.0001, `${name}: no wider than tall`);
  }
  // The arrow's and the pointing hand's hotspots are their TIPS: the topmost point, on the outline.
  for (const name of ['arrow', 'pointer']) {
    const s = cursorShape(name);
    assert.equal(s.box[1], 0, `${name}: nothing above the hotspot`);
    assert.ok(Math.abs(unionSd(s.parts, 0, 0)) < 0.03, `${name}: the hotspot is on the tip`);
  }
  // The pointing hand: the hotspot over the index finger, the hand hanging below it.
  const ptr = cursorShape('pointer');
  assert.ok(ptr.box[0] < -0.3 && ptr.box[2] > 0.4, 'the hand spreads both ways under the fingertip');
  // The hands' hotspots sit in the palm (white), the four-way arrow's at its centre (white).
  for (const name of ['grab', 'grabbing', 'move']) {
    const s = cursorShape(name);
    assert.ok(unionSd(s.fill, 0, 0) < -0.02, `${name}: the hotspot is inside the white fill`);
    const c = cursorShapeSample(name, 0, 0, 0, 0);
    assert.deepEqual(c, [1, 1, 1, 1], `${name}: white at the hotspot`);
  }
  const mv = cursorShape('move').box;
  for (let i = 0; i < 2; i++) assert.ok(Math.abs(mv[i] + mv[i + 2]) < 1e-9, 'the four-way arrow is centred on its hotspot');
  assert.ok(cursorShape('grab').box[1] < cursorShape('grabbing').box[1] - 0.15, 'the open hand reaches higher than the fist');
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

test('shapes: the crisp mesh is the outline then the fill, all triangles, hotspot at the origin (y up)', () => {
  for (const name of CURSOR_SHAPES) {
    const m = cursorShapeMesh(name, [1, 1, 1, 1], [0, 0, 0, 1]);
    assert.equal(m.count % 3, 0);
    assert.equal(m.positions.length, m.count * 3);
    const firstWhite = Array.from({ length: m.count }, (_, i) => m.colors[i * 4]).indexOf(1);
    assert.ok(firstWhite > 0, `${name}: outline triangles first`);
    for (let i = firstWhite; i < m.count; i++) assert.equal(m.colors[i * 4], 1, `${name}: then only fill`);
    const ys = Array.from({ length: m.count }, (_, i) => m.positions[i * 3 + 1]);
    const b = cursorShape(name).box;
    assert.ok(Math.abs(Math.max(...ys) + b[1]) < 1e-6, `${name}: y flipped (up) about the hotspot`);
  }
});

test('shapes: the soft box grows around the hotspot only; the raster puts the hotspot where asked', () => {
  for (const name of CURSOR_SHAPES) {
    const b0 = cursorShapeBox(name, 0, 0), b1 = cursorShapeBox(name, 0.06, 0.02);
    assert.deepEqual(b0, [...cursorShape(name).box]);
    b1.forEach((v, i) => assert.ok(Math.abs(v - (b0[i] + (i < 2 ? -0.08 : 0.08))) < 1e-12));
    // A 64-px sprite with its hotspot at (100.5, 80.5): the pixel there is opaque for the filled shapes.
    const r = cursorShapeRaster(name, 100.5, 80.5, 64, 0, 1);
    assert.ok(r.x0 <= 100 && r.y0 <= 80 && r.x0 + r.width > 100 && r.y0 + r.height > 80);
    if (name !== 'arrow' && name !== 'pointer') {
      const o = ((80 - r.y0) * r.width + (100 - r.x0)) * 4;
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

test('cursorShapeGLSL: one program, every shape, a uniform selects it; no loops or arrays (ES 1.00)', () => {
  const src = cursorShapeGLSL();
  assert.match(src, /vec4 inline3dSoftCursor\(vec2 p, float radius, float aa, vec3 fill, vec3 outline, float shape\)/);
  for (let k = 0; k < CURSOR_SHAPES.length; k++) {
    assert.match(src, new RegExp(`float i3dShapeSdO${k}\\(vec2 p\\)`));
    assert.match(src, new RegExp(`float i3dShapeSdF${k}\\(vec2 p\\)`));
  }
  assert.match(src, /if \(shape < 0\.5\)/);
  assert.match(src, /else if \(shape < 3\.50*\)/);
  assert.doesNotMatch(src, /\bfor\s*\(|\bwhile\s*\(|\[\s*\d+\s*\]/);
  // Each union function has one r = min(...) per part.
  const fn = (k, kind) => src.split(`float i3dShapeSd${kind}${k}(vec2 p) {`)[1].split('\n}')[0];
  for (let k = 0; k < CURSOR_SHAPES.length; k++) {
    const parts = cursorShape(CURSOR_SHAPES[k]).parts.length;
    assert.equal(fn(k, 'O').match(/r = min/g).length, parts);
    assert.equal(fn(k, 'F').match(/r = min/g).length, parts);
  }
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

test('CursorShapeSelector: no reader (no listeners) unless something may read the CSS; shapeFor overrides', () => {
  const canvas = el('grab');
  installCascade(el('auto'));
  try {
    const fixed = new CursorShapeSelector({ canvas, scope: 'canvas' }, { shape: 'move' });
    assert.equal(fixed.reader, null);
    assert.equal(canvas.listeners('pointermove'), 0, 'a fixed shape adds no listener');
    assert.equal(fixed.pick({ u: 0.5, v: 0.5, point: null }, 0), 'move');
    const auto = new CursorShapeSelector({ canvas, scope: 'canvas' });
    assert.equal(auto.pick({ u: 0.5, v: 0.5, point: null }, 0), 'grab');
    let seen;
    const sf = new CursorShapeSelector({ canvas, scope: 'canvas' }, { shapeFor: (h) => ((seen = h), h.point ? 'pointer' : undefined) });
    assert.equal(sf.pick({ u: 0.2, v: 0.3, point: [0, 0, 1] }, 0), 'pointer');
    assert.deepEqual(seen, { u: 0.2, v: 0.3, point: [0, 0, 1], css: 'grab' });
    assert.equal(sf.pick({ u: 0.2, v: 0.3, point: null }, 1), 'grab', 'nothing from shapeFor → the CSS');
    const warn = console.warn;
    console.warn = () => {};
    try {
      const bad = new CursorShapeSelector({ canvas, scope: 'canvas' }, { shapeFor: () => { throw new Error('x'); } });
      assert.equal(bad.pick({ u: 0, v: 0, point: null }, 0), 'grab', 'a throwing shapeFor falls back');
    } finally {
      console.warn = warn;
    }
    assert.throws(() => new CursorShapeSelector({ canvas, scope: 'canvas' }, { shape: 'hand' }), /cursor\.shape "hand"/);
    for (const s of [fixed, auto, sf]) s.dispose();
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
  assert.throws(() => resolveCursorOption({ shape: 'text' }), /expected 'auto'/);
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
  return { BufferGeometry: Geo, Float32BufferAttribute: Attr, MeshBasicMaterial: Mat, ShaderMaterial: Mat, Vector4: V4, Vector3: V3, Mesh, DoubleSide: 2, ShaderChunk: { colorspace_fragment: '' } };
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
      seq.push([cur.shape, u ? u.inline3dCursorSoft.value.v[3] : null]);
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
    assert.deepEqual(seq.map((s) => s[1]), [2, 3, 3, 2], "the soft shader's shape uniform follows");
    assert.equal(canvas.hasAttribute(CURSOR_HIDDEN_ATTR), true, 'OS cursor hidden while the sprite draws');
    assert.equal(canvas.style.cursor, undefined, 'the inline style is never written');
    cur.dispose();
  } finally {
    uninstall();
  }
});

test('DepthCursor (three): a fixed shape and crisp frames swap the mesh to that shape', () => {
  const canvas = el('grab');
  const hitTest = (o, d) => {
    const t = (0.1 - o[2]) / d[2];
    return [o[0] + d[0] * t, o[1] + d[1] * t, 0.1];
  };
  const cur = new DepthCursor(stubTHREE(), { canvas, hitTest, shape: 'move', soften: 'off' });
  assert.equal(cur.shapes.reader, null, "a fixed shape builds no reader");
  cur.setPointer(0.5, 0.5);
  cur.update([kooima([-0.032, 0, 0.6]), kooima([0.032, 0, 0.6])], 1000);
  assert.equal(cur.shape, 'move');
  assert.deepEqual(cur.object.geometry.position.array, cursorShapeMesh('move', [1, 1, 1, 1]).positions);
  cur.dispose();
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

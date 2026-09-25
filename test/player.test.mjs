// Tests for the pure parts of inline3d-player.js: option validation, time formatting, and the
// keyboard map. All three are exported specifically so they can be checked without a DOM (no
// <video>, no canvas, no window) — see js/inline3d-player.js's own doc comment for why the
// DOM-touching paint loops and transport bar are NOT covered here (that needs the real browser
// pass described in the report, not a Node stub).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizePlayerOptions,
  formatTime,
  mapKeyToAction,
  bufferedFraction,
  dissolveAlpha,
  resolveTransition,
  PLAYER_EASINGS,
  DEFAULT_CROSSFADE_MS,
  PLAYER_SIZE_SCALE,
  PLAYER_ACCENTS,
  resolveAccent,
  fitRect,
  parseAspect,
  eyeRect,
  bandBox,
  pickSource,
  normalizeTitles,
  nextIndex,
  backTarget,
} from '../js/inline3d-player.js';

// ── normalizePlayerOptions ──────────────────────────────────────────────────────────────────

test('defaults match the spec: sbs, sdk controls, muted autoplay-safe, keyboard on', () => {
  const o = normalizePlayerOptions();
  assert.equal(o.format, 'sbs');
  assert.equal(o.controls, 'sdk');
  assert.equal(o.poster, null);
  assert.equal(o.autoplay, false);
  assert.equal(o.muted, true);
  assert.equal(o.loop, false);
  assert.equal(o.keyboard, true);
  assert.equal(o.fadeMs, 0);
});

test('an explicit format/controls value is kept when valid', () => {
  assert.equal(normalizePlayerOptions({ format: 'mono' }).format, 'mono');
  assert.equal(normalizePlayerOptions({ controls: 'none' }).controls, 'none');
});

test('an invalid format/controls value falls back to the default and warns once, not throws', () => {
  const real = console.warn;
  const warnings = [];
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    assert.equal(normalizePlayerOptions({ format: 'ou' }).format, 'sbs');
    assert.equal(normalizePlayerOptions({ controls: 'custom' }).controls, 'sdk');
    assert.ok(warnings.some((w) => w.includes('format') && w.includes('ou')));
    assert.ok(warnings.some((w) => w.includes('controls') && w.includes('custom')));
  } finally {
    console.warn = real;
  }
});

test('muted/loop/autoplay/keyboard coerce to booleans, including falsy-but-set values', () => {
  const o = normalizePlayerOptions({ muted: false, loop: 1, autoplay: 0, keyboard: false });
  assert.equal(o.muted, false);
  assert.equal(o.loop, true);
  assert.equal(o.autoplay, false);
  assert.equal(o.keyboard, false);
});

test('muted defaults true even when the caller omits it — autoplay needs this', () => {
  assert.equal(normalizePlayerOptions({}).muted, true);
  assert.equal(normalizePlayerOptions({ muted: undefined }).muted, true);
});

test('fadeMs (the legacy alias) is kept when a positive number, dropped otherwise', () => {
  assert.equal(normalizePlayerOptions({ fadeMs: 250 }).fadeMs, 250);
  assert.equal(normalizePlayerOptions({ fadeMs: 0 }).fadeMs, 0);
  assert.equal(normalizePlayerOptions({ fadeMs: -10 }).fadeMs, 0);
  assert.equal(normalizePlayerOptions({ fadeMs: 'fast' }).fadeMs, 0);
});

test('poster falls back to null for an empty string or omission, not to undefined', () => {
  assert.equal(normalizePlayerOptions({}).poster, null);
  assert.equal(normalizePlayerOptions({ poster: '' }).poster, null);
  assert.equal(normalizePlayerOptions({ poster: 'p.jpg' }).poster, 'p.jpg');
});

test('tile options and crossOrigin pass through unchanged (validated elsewhere / by the DOM)', () => {
  const o = normalizePlayerOptions({
    width: 640,
    height: 360,
    cornerRadius: 8,
    feather: 4,
    crossOrigin: 'use-credentials',
    observe: 'sentinel',
  });
  assert.equal(o.width, 640);
  assert.equal(o.height, 360);
  assert.equal(o.cornerRadius, 8);
  assert.equal(o.feather, 4);
  assert.equal(o.crossOrigin, 'use-credentials');
  assert.equal(o.observe, 'sentinel');
});

// ── formatTime ───────────────────────────────────────────────────────────────────────────────

test('formatTime renders M:SS under an hour, zero-padded', () => {
  assert.equal(formatTime(0), '0:00');
  assert.equal(formatTime(5), '0:05');
  assert.equal(formatTime(65), '1:05');
  assert.equal(formatTime(599), '9:59');
  assert.equal(formatTime(3599), '59:59');
});

test('formatTime renders H:MM:SS at an hour and beyond', () => {
  assert.equal(formatTime(3600), '1:00:00');
  assert.equal(formatTime(3661), '1:01:01');
  assert.equal(formatTime(7325), '2:02:05');
});

test('formatTime floors fractional seconds rather than rounding', () => {
  assert.equal(formatTime(59.9), '0:59');
  assert.equal(formatTime(60.0), '1:00');
});

test('formatTime never emits NaN/Infinity text — NaN, negative and Infinity all read as 0:00', () => {
  assert.equal(formatTime(NaN), '0:00');
  assert.equal(formatTime(-1), '0:00');
  assert.equal(formatTime(Infinity), '0:00');
  assert.equal(formatTime(undefined), '0:00');
});

// ── mapKeyToAction ───────────────────────────────────────────────────────────────────────────

test('play/pause: Space and K (either case) map to toggle', () => {
  for (const key of [' ', 'Space', 'Spacebar', 'k', 'K']) {
    assert.equal(mapKeyToAction(key), 'toggle', `key ${JSON.stringify(key)}`);
  }
});

test('arrow keys seek +/-5s; J/L seek +/-10s', () => {
  assert.equal(mapKeyToAction('ArrowLeft'), 'seek-5');
  assert.equal(mapKeyToAction('ArrowRight'), 'seek+5');
  assert.equal(mapKeyToAction('j'), 'seek-10');
  assert.equal(mapKeyToAction('J'), 'seek-10');
  assert.equal(mapKeyToAction('l'), 'seek+10');
  assert.equal(mapKeyToAction('L'), 'seek+10');
});

test('M (either case) maps to mute', () => {
  assert.equal(mapKeyToAction('m'), 'mute');
  assert.equal(mapKeyToAction('M'), 'mute');
  assert.equal(mapKeyToAction('f'), 'fullscreen');
  assert.equal(mapKeyToAction('F'), 'fullscreen');
});

test('an unmapped key returns null — so the caller never calls preventDefault for it', () => {
  for (const key of ['Tab', 'Escape', 'a', 'Enter', 'ArrowUp', 'ArrowDown', '1']) {
    assert.equal(mapKeyToAction(key), null, `key ${JSON.stringify(key)}`);
  }
});

// ── bufferedFraction ─────────────────────────────────────────────────────────────────────────
//
// The scrub bar's buffered shading. Takes [start,end] pairs rather than a live `TimeRanges`
// precisely so it can be checked here, without a <video>.

test('bufferedFraction reports the end of the range CONTAINING the playhead', () => {
  assert.equal(bufferedFraction([[0, 30]], 5, 60), 0.5);
  assert.equal(bufferedFraction([[0, 60]], 5, 60), 1);
});

test('a range the playhead has not reached does not count as buffered ahead', () => {
  // Seeked to 5 s; the only buffered region is 40-60 s. Nothing ahead of the playhead is ready,
  // and painting 100% there is the lie that makes a stalled player look fully loaded.
  assert.equal(bufferedFraction([[40, 60]], 5, 60), 0);
});

test('with several ranges, the one straddling the playhead wins — not the last one', () => {
  const ranges = [
    [0, 10],
    [45, 60],
  ];
  assert.equal(bufferedFraction(ranges, 3, 60), 10 / 60);
  assert.equal(bufferedFraction(ranges, 50, 60), 1);
});

test('a playhead a hair before a range start still counts (the 0.25 s seek tolerance)', () => {
  // A fresh seek lands the playhead marginally before the range the browser then reports.
  assert.equal(bufferedFraction([[10, 30]], 9.9, 60), 0.5);
  assert.equal(bufferedFraction([[10, 30]], 9.0, 60), 0);
});

test('an unknown duration yields 0 rather than NaN — a live stream must not paint a fill', () => {
  assert.equal(bufferedFraction([[0, 30]], 5, NaN), 0);
  assert.equal(bufferedFraction([[0, 30]], 5, Infinity), 0);
  assert.equal(bufferedFraction([[0, 30]], 5, 0), 0);
});

test('no ranges at all, or a missing buffered object, is 0 and never throws', () => {
  assert.equal(bufferedFraction([], 5, 60), 0);
  assert.equal(bufferedFraction(undefined, 5, 60), 0);
});

test('the fraction is clamped to 1 even if a range overruns the reported duration', () => {
  assert.equal(bufferedFraction([[0, 75]], 5, 60), 1);
});

// ── new chrome options ───────────────────────────────────────────────────────────────────────

test('accent is kept only as a non-empty string, else null', () => {
  assert.equal(normalizePlayerOptions({ accent: '#ff0066' }).accent, '#ff0066');
  assert.equal(normalizePlayerOptions({ accent: '' }).accent, null);
  assert.equal(normalizePlayerOptions({ accent: 0xff0066 }).accent, null);
  assert.equal(normalizePlayerOptions({}).accent, null);
});

test('badge3d defaults OFF and passes a custom label through', () => {
  assert.equal(normalizePlayerOptions({}).badge3d, false);
  assert.equal(normalizePlayerOptions({ badge3d: true }).badge3d, true);
  assert.equal(normalizePlayerOptions({ badge3d: 'SPATIAL' }).badge3d, 'SPATIAL');
});

// ── dissolveAlpha ────────────────────────────────────────────────────────────────────────────
//
// The setSource() dissolve ramp: how much of the INCOMING title to composite over the frozen
// outgoing frame, as a function of time since the incoming title's first frame.

test('dissolveAlpha ramps linearly from 0 to 1 across the fade', () => {
  assert.equal(dissolveAlpha(0, 400), 0);
  assert.equal(dissolveAlpha(100, 400), 0.25);
  assert.equal(dissolveAlpha(200, 400), 0.5);
  assert.equal(dissolveAlpha(400, 400), 1);
});

test('dissolveAlpha clamps past the end rather than overshooting', () => {
  assert.equal(dissolveAlpha(10_000, 400), 1);
});

test('negative elapsed time reads as 0, not a negative alpha', () => {
  // A clock that ticks backwards (a coarse timer, a tab restore) must not invert the blend.
  assert.equal(dissolveAlpha(-50, 400), 0);
});

test('a non-positive or non-finite duration collapses to a hard cut, never NaN alpha', () => {
  // NaN passed to globalAlpha is ignored by Chromium, which would leave the compositor stuck
  // half-dissolved — so the degenerate cases have to resolve to a number, and 1 (show the new
  // title) is the only safe one.
  for (const bad of [0, -1, NaN, Infinity, undefined]) {
    assert.equal(dissolveAlpha(100, bad), 1, `fadeMs ${String(bad)}`);
  }
});

test('fadeMs normalisation still rejects non-positive and non-numeric values', () => {
  assert.equal(normalizePlayerOptions({ fadeMs: 250 }).fadeMs, 250);
  assert.equal(normalizePlayerOptions({ fadeMs: -1 }).fadeMs, 0);
  assert.equal(normalizePlayerOptions({ fadeMs: '250' }).fadeMs, 0);
});

// ── resolveTransition: ./splat's vocabulary, the subset a video can mean ────────────────────────

test('default is a cut; transition:crossfade defaults to 600 ms easeInOutSine', () => {
  assert.deepEqual(
    (({ type, durationMs, easing }) => ({ type, durationMs, easing }))(resolveTransition()),
    { type: 'cut', durationMs: 0, easing: 'easeInOutSine' }
  );
  const x = resolveTransition({ transition: 'crossfade' });
  assert.equal(x.type, 'crossfade');
  assert.equal(x.durationMs, DEFAULT_CROSSFADE_MS);
  assert.equal(x.ease, PLAYER_EASINGS.easeInOutSine);
});

test('fadeMs is the legacy alias: > 0 is a crossfade of that length, 0 a cut', () => {
  assert.deepEqual([resolveTransition({ fadeMs: 250 }).type, resolveTransition({ fadeMs: 250 }).durationMs], ['crossfade', 250]);
  assert.equal(resolveTransition({ fadeMs: 0 }).type, 'cut');
  assert.equal(resolveTransition({ transition: 'crossfade', fadeMs: 300, durationMs: 900 }).durationMs, 900, 'durationMs wins');
  assert.equal(resolveTransition({ transition: 'crossfade', durationMs: 0 }).type, 'cut', 'a zero-length crossfade is a cut');
});

test('per-call options override the construction base field by field', () => {
  const base = resolveTransition({ transition: 'crossfade', durationMs: 800, easing: 'linear' });
  const longer = resolveTransition({ durationMs: 1500 }, base);
  assert.deepEqual([longer.type, longer.durationMs, longer.easing], ['crossfade', 1500, 'linear']);
  assert.equal(resolveTransition({ transition: 'cut' }, base).type, 'cut');
  assert.equal(resolveTransition({}, base).durationMs, 800, 'no options = the base');
  assert.equal(resolveTransition({ fadeMs: 0 }, base).type, 'cut', 'the legacy fadeMs:0 still means cut');
});

test("./splat's other transitions are refused by name, as are unknown easings and outgoing:'live'", () => {
  for (const t of ['flip', 'wavefront', 'reassemble', 'swarm'])
    assert.throws(() => resolveTransition({ transition: t }), /one of \.\/splat's/, t);
  assert.throws(() => resolveTransition({ transition: { type: 'sequence', out: 'fade', in: 'fade' } }), /\.\/splat's/);
  assert.throws(() => resolveTransition({ transition: 'wipe' }), /not a player transition\. Known: cut, crossfade/);
  assert.throws(() => resolveTransition({ easing: 'bouncy' }), /unknown easing 'bouncy'/);
  assert.throws(() => resolveTransition({ outgoing: 'live' }), /outgoing 'live' is not supported/);
  assert.doesNotThrow(() => resolveTransition({ outgoing: 'frozen', easing: (x) => x }));
});

test('the easing table is the ./splat table, curve for curve', async () => {
  const { EASINGS } = await import('../js/inline3d-splat-effects.js');
  assert.deepEqual(Object.keys(PLAYER_EASINGS), Object.keys(EASINGS));
  for (const k of Object.keys(EASINGS))
    for (const x of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) assert.equal(PLAYER_EASINGS[k](x), EASINGS[k](x), `${k}(${x})`);
});

test('normalizePlayerOptions resolves the construction transition', () => {
  assert.equal(normalizePlayerOptions({ fadeMs: 400 }).transition.type, 'crossfade');
  assert.equal(normalizePlayerOptions({}).transition.type, 'cut');
  assert.throws(() => normalizePlayerOptions({ transition: 'flip' }), /\.\/splat's/);
});

test('chrome options: title is page text or null, skip buttons and fullscreen default on', () => {
  const d = normalizePlayerOptions();
  assert.deepEqual([d.title, d.skipButtons, d.fullscreen], [null, true, true]);
  assert.equal(normalizePlayerOptions({ title: 'Fly Me to the Moon' }).title, 'Fly Me to the Moon');
  assert.equal(normalizePlayerOptions({ title: '' }).title, null);
  assert.equal(normalizePlayerOptions({ skipButtons: false }).skipButtons, false);
  assert.equal(normalizePlayerOptions({ fullscreen: false }).fullscreen, false);
});

test("skin: 'classic' by default, 'dock' accepted, anything else falls back with a warning", () => {
  assert.equal(normalizePlayerOptions().skin, 'classic');
  assert.equal(normalizePlayerOptions({ skin: 'dock' }).skin, 'dock');
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(normalizePlayerOptions({ skin: 'neon' }).skin, 'classic');
  } finally {
    console.warn = warn;
  }
});

test("size: 'm' by default, s/m/l accepted in any case, anything else falls back", () => {
  assert.equal(normalizePlayerOptions().size, 'm');
  assert.equal(normalizePlayerOptions({ size: 'L' }).size, 'l');
  assert.equal(normalizePlayerOptions({ size: 's' }).size, 's');
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(normalizePlayerOptions({ size: 'xl' }).size, 'm');
  } finally {
    console.warn = warn;
  }
  assert.ok(PLAYER_SIZE_SCALE.s < PLAYER_SIZE_SCALE.m && PLAYER_SIZE_SCALE.m === 1 && PLAYER_SIZE_SCALE.l > 1);
});

test('accent: named presets resolve to their colour, anything else passes through', () => {
  assert.equal(resolveAccent('sunset'), PLAYER_ACCENTS.sunset);
  assert.equal(resolveAccent('Mint'), PLAYER_ACCENTS.mint);
  assert.equal(resolveAccent('#123456'), '#123456');
  assert.equal(resolveAccent('rebeccapurple'), 'rebeccapurple');
  for (const c of Object.values(PLAYER_ACCENTS)) assert.match(c, /^#[0-9a-f]{6}$/);
});

test('fit: unset stretches (the 1.x pixels), contain/cover accepted, anything else falls back to unset', () => {
  assert.equal(normalizePlayerOptions().fit, null);
  assert.equal(normalizePlayerOptions({ fit: 'contain' }).fit, 'contain');
  assert.equal(normalizePlayerOptions({ fit: 'cover' }).fit, 'cover');
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(normalizePlayerOptions({ fit: 'fill' }).fit, null);
  } finally {
    console.warn = warn;
  }
});

test('fitRect: contain letterboxes the destination, cover crops the source, same aspect is a no-op', () => {
  // A 2.39:1 eye into a 16:9 box.
  const c = fitRect(2390, 1000, 1600, 900, 'contain');
  assert.deepEqual([c.sx, c.sy, c.sw, c.sh], [0, 0, 2390, 1000], 'contain keeps the whole source');
  assert.equal(c.dw, 1600);
  assert.ok(Math.abs(c.dh - 1600 / 2.39) < 1e-6 && Math.abs(c.dy - (900 - c.dh) / 2) < 1e-6, 'bars top and bottom');
  const v = fitRect(2390, 1000, 1600, 900, 'cover');
  assert.deepEqual([v.dx, v.dy, v.dw, v.dh], [0, 0, 1600, 900], 'cover fills the box');
  assert.ok(Math.abs(v.sw - 1000 * (16 / 9)) < 1e-6 && Math.abs(v.sx - (2390 - v.sw) / 2) < 1e-6, 'cropped at the sides');
  // A tall source into a wide box: contain pillarboxes.
  const p = fitRect(900, 1600, 1600, 900, 'contain');
  assert.ok(p.dx > 0 && p.dy === 0 && Math.abs(p.dh - 900) < 1e-6);
  assert.deepEqual(fitRect(1600, 900, 800, 450, 'cover'), { sx: 0, sy: 0, sw: 1600, sh: 900, dx: 0, dy: 0, dw: 800, dh: 450 });
  assert.deepEqual(fitRect(2390, 1000, 1600, 900, null), { sx: 0, sy: 0, sw: 2390, sh: 1000, dx: 0, dy: 0, dw: 1600, dh: 900 }, 'unset stretches');
});

// ── quick wins for the Show Spatial team ────────────────────────────────────────────────────────

test("format 'tb' is accepted (setVideo's vocabulary); eyeRect splits sbs/tb/mono", () => {
  assert.equal(normalizePlayerOptions({ format: 'tb' }).format, 'tb');
  assert.deepEqual(eyeRect('sbs', 800, 200, 1), { x: 400, y: 0, w: 400, h: 200 });
  assert.deepEqual(eyeRect('tb', 400, 400, 0), { x: 0, y: 0, w: 400, h: 200 }, 'left eye on top');
  assert.deepEqual(eyeRect('tb', 400, 400, 1), { x: 0, y: 200, w: 400, h: 200 });
  assert.deepEqual(eyeRect('mono', 400, 300, 1), { x: 0, y: 0, w: 400, h: 300 });
});

test('band: parsed from a number or W:H / W/H, and laid out as a centred slot', () => {
  assert.equal(parseAspect(2.39), 2.39);
  assert.ok(Math.abs(parseAspect('2.39:1') - 2.39) < 1e-9);
  assert.ok(Math.abs(parseAspect('21/9') - 21 / 9) < 1e-9);
  assert.equal(parseAspect('wide'), null);
  assert.equal(parseAspect(0), null);
  assert.equal(normalizePlayerOptions({ band: '2.39:1' }).band > 2.38, true);
  const b = bandBox(1600, 900, 2.39); // scope band in a 16:9 box: full width, bars top/bottom
  assert.equal(b.w, 1600);
  assert.ok(Math.abs(b.h - 1600 / 2.39) < 1e-6 && Math.abs(b.y - (900 - b.h) / 2) < 1e-6);
  const n = bandBox(1600, 900, 1); // square band: full height, centred
  assert.deepEqual([n.w, n.h, n.x], [900, 900, 350]);
  assert.deepEqual(bandBox(1600, 900, null), { x: 0, y: 0, w: 1600, h: 900 });
});

test("posterFormat: 'mono' by default; sbs/tb accepted", () => {
  assert.equal(normalizePlayerOptions().posterFormat, 'mono');
  assert.equal(normalizePlayerOptions({ posterFormat: 'sbs' }).posterFormat, 'sbs');
  assert.equal(normalizePlayerOptions({ posterFormat: 'tb' }).posterFormat, 'tb');
});

test('pickSource: best first, "probably" beats an earlier "maybe", untyped taken as-is, warns when nothing plays', () => {
  const dxr = (t) => (/vp9|av01|opus/.test(t) ? 'probably' : t.startsWith('video/mp4') ? 'maybe' : '');
  assert.equal(pickSource('a.webm', dxr), 'a.webm', 'a plain source passes through');
  assert.equal(
    pickSource([{ src: 'a.mp4', type: 'video/mp4; codecs="avc1.640028, mp4a.40.2"' }, { src: 'a.webm', type: 'video/webm; codecs="vp9, opus"' }], () => ''),
    'a.mp4',
    'nothing playable: the first, with a warning'.length ? 'a.mp4' : ''
  );
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(pickSource([{ src: 'h264.mp4', type: 'video/mp4' }, { src: 'vp9.webm', type: 'video/webm; codecs="vp9, opus"' }], dxr), 'vp9.webm', "'probably' beats an earlier 'maybe'");
    assert.equal(pickSource([{ src: 'h264.mp4', type: 'video/mp4' }], dxr), 'h264.mp4', "a lone 'maybe' is taken");
    assert.equal(pickSource([{ src: 'x', type: 'video/x' }, 'plain.webm'], dxr), 'plain.webm', 'an untyped candidate is taken as-is');
    let warned = false;
    console.warn = () => (warned = true);
    assert.equal(pickSource([{ src: 'h264.mp4', type: 'video/mp4; codecs="avc1"' }], () => ''), 'h264.mp4');
    assert.ok(warned, 'says so when nothing is playable');
  } finally {
    console.warn = warn;
  }
});

// ── playlist (RFC 0001 Addendum A4) ──────────────────────────────────────────────────────────────

test('normalizeTitles: ids default to the index, bare sources are accepted, bad lists throw at the call', () => {
  const t = normalizeTitles([{ src: 'a.webm', title: 'A' }, 'b.webm', { id: 'c', src: 'c.webm', poster: 'c.png' }]);
  assert.deepEqual(t.map((x) => x.id), ['0', '1', 'c']);
  assert.equal(t[1].src, 'b.webm');
  assert.equal(t[0].title, 'A');
  assert.equal(t[2].poster, 'c.png');
  assert.ok(Object.isFrozen(t) && Object.isFrozen(t[0]), 'read-only, like handle.titles');
  assert.deepEqual(normalizeTitles(undefined), []);
  assert.throws(() => normalizeTitles('a.webm'), /must be an array/);
  assert.throws(() => normalizeTitles([{ title: 'no src' }]), /titles\[0\] has no src/);
  assert.throws(() => normalizeTitles([{ id: 'x', src: 'a' }, { id: 'x', src: 'b' }]), /duplicate title id "x"/);
  assert.equal(normalizePlayerOptions({ titles: ['a', 'b'] }).titles.length, 2);
});

test('nextIndex: steps forward, stops at the end unless loopList, starts at 0 from nothing', () => {
  assert.equal(nextIndex(0, 3, false), 1);
  assert.equal(nextIndex(2, 3, false), -1, 'the end of the list without loopList');
  assert.equal(nextIndex(2, 3, true), 0, 'loopList wraps');
  assert.equal(nextIndex(-1, 3, false), 0, 'from no current title, the first');
  assert.equal(nextIndex(0, 0, true), -1, 'no titles, no next');
});

test("backTarget: a remote's previous — restart past 3 s, else the previous title", () => {
  assert.deepEqual(backTarget(10, 2, 3, false), { restart: true }, 'more than 3 s in: restart');
  assert.deepEqual(backTarget(1, 2, 3, false), { index: 1 }, 'near the start: the previous title');
  assert.deepEqual(backTarget(1, 0, 3, false), { restart: true }, 'at the first title: restart');
  assert.deepEqual(backTarget(1, 0, 3, true), { index: 2 }, 'loopList wraps back to the last');
  assert.deepEqual(backTarget(1, -1, 3, false), { restart: true }, 'no current title: restart');
});

test('loopList and autoAdvance default off', () => {
  const o = normalizePlayerOptions();
  assert.deepEqual([o.loopList, o.autoAdvance, o.titles.length], [false, false, 0]);
});

test("skins 'bars' and 'call' are accepted; 'call' implies a 2.39 band unless one is given", () => {
  assert.equal(normalizePlayerOptions({ skin: 'bars' }).skin, 'bars');
  assert.equal(normalizePlayerOptions({ skin: 'call' }).skin, 'call');
  assert.equal(normalizePlayerOptions({ skin: 'call' }).band, 2.39, "'call' is a picture in a scope band");
  assert.ok(Math.abs(normalizePlayerOptions({ skin: 'call', band: '16/9' }).band - 16 / 9) < 1e-9, 'an explicit band wins');
  assert.equal(normalizePlayerOptions({ skin: 'bars' }).band, null, "'bars' does not invent a band");
});

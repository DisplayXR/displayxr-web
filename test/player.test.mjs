// Tests for the pure parts of inline3d-player.js: option validation, time formatting, and the
// keyboard map. All three are exported specifically so they can be checked without a DOM (no
// <video>, no canvas, no window) — see js/inline3d-player.js's own doc comment for why the
// DOM-touching paint loops and transport bar are NOT covered here (that needs the real browser
// pass described in the report, not a Node stub).

import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizePlayerOptions, formatTime, mapKeyToAction } from '../js/inline3d-player.js';

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
    assert.equal(normalizePlayerOptions({ format: 'tb' }).format, 'sbs');
    assert.equal(normalizePlayerOptions({ controls: 'custom' }).controls, 'sdk');
    assert.ok(warnings.some((w) => w.includes('format') && w.includes('tb')));
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

test('fadeMs is accepted-not-implemented: kept when a positive number, dropped otherwise', () => {
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
});

test('an unmapped key returns null — so the caller never calls preventDefault for it', () => {
  for (const key of ['Tab', 'Escape', 'a', 'Enter', 'ArrowUp', 'ArrowDown', '1']) {
    assert.equal(mapKeyToAction(key), null, `key ${JSON.stringify(key)}`);
  }
});

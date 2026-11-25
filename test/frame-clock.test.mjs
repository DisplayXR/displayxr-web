// The scene frame clock behind handle.stats() (web#278): percentiles over a ring of onFrame
// intervals and callback times, and the `paced` hint computed from them. The clock reports; it
// never changes what the loop does, so everything here is arithmetic on recorded numbers.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createFrameClock, pacedHint, RING, MIN_SAMPLES, PAUSE_MS } from '../js/inline3d-frame-clock.js';

function feed(clock, intervals, cbMs, start = 0, frameNo = 0) {
  let t = start;
  clock.tick(t, frameNo++);
  for (let i = 0; i < intervals.length; i++) {
    t += intervals[i];
    clock.tick(t, frameNo++);
    clock.cb(typeof cbMs === 'function' ? cbMs(i) : cbMs);
  }
  return { t, frameNo };
}

test('empty clock: nulls, no samples, paced unknown', () => {
  const r = createFrameClock().read(null);
  assert.deepEqual(r, {
    frameIntervalMs: null,
    cbMs: null,
    frameClockSamples: 0,
    displayHz: null,
    displayHzSource: null,
    paced: null,
  });
});

test('the tablet signature: flat 33.5 ms, 5 ms callback -> paced (refresh unknown and 60 Hz)', () => {
  const c = createFrameClock();
  feed(c, Array(60).fill(33.5), 5);
  const r = c.read(null);
  assert.deepEqual(r.frameIntervalMs, { p50: 33.5, p95: 33.5 });
  assert.deepEqual(r.cbMs, { p50: 5, p95: 5 });
  assert.equal(r.paced, true);
  const r60 = c.read(60);
  assert.equal(r60.displayHz, 60);
  assert.equal(r60.displayHzSource, 'session');
  assert.equal(r60.paced, true, '33.5 ms is within 8% of 2 x 16.67 ms');
});

test('slow, not capped: the callback eats the interval -> not paced', () => {
  const c = createFrameClock();
  feed(c, Array(60).fill(33.4), 28);
  assert.equal(c.read(60).paced, false);
});

test('jittery interval -> not paced', () => {
  const c = createFrameClock();
  feed(c, Array.from({ length: 60 }, (_, i) => (i % 5 === 0 ? 50 : 17)), 3);
  const r = c.read(null);
  assert.equal(r.frameIntervalMs.p50, 17);
  assert.equal(r.frameIntervalMs.p95, 50);
  assert.equal(r.paced, false);
});

test('known refresh: an interval that is not a whole number of periods -> not paced', () => {
  const c = createFrameClock();
  feed(c, Array(60).fill(25), 3); // 1.5 x 16.67 ms
  assert.equal(c.read(null).paced, true, 'without a refresh rate only steadiness + idleness are checked');
  assert.equal(c.read(60).paced, false);
});

test(`fewer than ${MIN_SAMPLES} intervals -> paced is null, percentiles still reported`, () => {
  const c = createFrameClock();
  feed(c, Array(MIN_SAMPLES - 1).fill(16.7), 2);
  const r = c.read(60);
  assert.equal(r.frameClockSamples, MIN_SAMPLES - 1);
  assert.equal(r.frameIntervalMs.p50, 16.7);
  assert.equal(r.paced, null);
});

test('a window that sat out session frames does not report the gap as one interval', () => {
  const c = createFrameClock();
  c.tick(0, 10);
  c.tick(16.7, 11);
  c.tick(500, 40); // frames 12..39 skipped (no layer): not an interval
  c.tick(516.7, 41);
  const r = c.read(null);
  assert.equal(r.frameClockSamples, 2);
  assert.equal(r.frameIntervalMs.p95, 16.7);
});

test(`pauses over ${PAUSE_MS} ms are not intervals`, () => {
  const c = createFrameClock();
  c.tick(0, 0);
  c.tick(PAUSE_MS + 5, 1);
  assert.equal(c.read(null).frameClockSamples, 0);
});

test(`the ring keeps the last ${RING} intervals and follows a change`, () => {
  const c = createFrameClock();
  const { t, frameNo } = feed(c, Array(RING).fill(33.4), 4);
  feed(c, Array(RING).fill(16.7), 4, t, frameNo);
  const r = c.read(null);
  assert.equal(r.frameClockSamples, RING);
  assert.deepEqual(r.frameIntervalMs, { p50: 16.7, p95: 16.7 });
});

test('tick() and cb() allocate nothing per frame', () => {
  if (typeof globalThis.gc !== 'function') return; // only measurable under --expose-gc
  const c = createFrameClock();
  feed(c, Array(10).fill(16), 1);
  globalThis.gc();
  const before = process.memoryUsage().heapUsed;
  let t = 1000;
  for (let i = 0; i < 1e5; i++) {
    t += 16;
    c.tick(t, 100 + i);
    c.cb(2);
  }
  assert.ok(process.memoryUsage().heapUsed - before < 256 * 1024);
});

test('pacedHint is pure: same inputs, same answer', () => {
  const iv = { p50: 33.4, p95: 34 };
  assert.equal(pacedHint(iv, { p50: 4, p95: 6 }, 100, 60), true);
  assert.equal(pacedHint(iv, { p50: 4, p95: 6 }, 100, 90), true, '33.4 ms is 3 periods at 90 Hz');
  assert.equal(pacedHint(iv, { p50: 4, p95: 6 }, 100, 75), false, '33.4 ms is 2.5 periods at 75 Hz');
  assert.equal(pacedHint(iv, { p50: 4, p95: 6 }, 10, 60), null, 'too few samples');
});

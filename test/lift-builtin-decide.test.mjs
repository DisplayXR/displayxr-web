// Tests for tools/lift-builtin/decide.js — the built-in's native-vs-web decision per pick
// (runtime conversion-providers §7.4 / §8.1 fix 1): the browser's own `{native, liftState}` wins,
// `waiting` stays native (2D + spinner, never the in-page converter), only `unavailable` is web.

import test from 'node:test';
import assert from 'node:assert/strict';
import { decideLift } from '../tools/lift-builtin/decide.js';

const READY = { native: true, state: 'ready', liftState: 'ready', modes: ['sbs'], maxStreams: 2 };
const WAITING = { native: true, state: 'activating', liftState: 'waiting', modes: [] };
const NONE = { native: false, state: 'unavailable', liftState: 'unavailable', modes: [] };

test('decideLift: no hint (an older browser) — the fresh caps answer decides', () => {
  assert.deepEqual([decideLift(READY).native, decideLift(READY).liftState], [true, 'ready']);
  assert.deepEqual([decideLift(WAITING).native, decideLift(WAITING).liftState], [true, 'waiting']);
  assert.deepEqual([decideLift(NONE).native, decideLift(NONE).liftState], [false, 'unavailable']);
  // an older caps answer without liftState: activating maps to waiting
  const old = decideLift({ native: true, state: 'activating' });
  assert.deepEqual([old.native, old.liftState], [true, 'waiting']);
  assert.equal(decideLift(undefined).native, false);
});

test('decideLift: the browser said native — waiting stays native even if our own query raced to unavailable', () => {
  const d = decideLift(NONE, { native: true, liftState: 'waiting' });
  assert.equal(d.native, true);
  assert.equal(d.liftState, 'waiting');
  const r = decideLift(NONE, { native: true, liftState: 'unavailable' });
  assert.deepEqual([r.native, r.liftState], [true, 'waiting'], 'native + unavailable is contradictory: wait');
  const n = decideLift(READY, { native: true });
  assert.deepEqual([n.native, n.liftState, n.maxStreams], [true, 'ready', 2], 'no liftState in the hint: caps fills it');
});

test('decideLift: the browser said NOT native — the in-page path, whatever our query saw', () => {
  const d = decideLift(READY, { native: false, liftState: 'unavailable' });
  assert.deepEqual([d.native, d.liftState], [false, 'unavailable']);
});

test('decideLift: a malformed hint is ignored', () => {
  assert.equal(decideLift(WAITING, { native: 'yes' }).native, true);
  assert.equal(decideLift(NONE, { liftState: 'ready' }).native, false);
});

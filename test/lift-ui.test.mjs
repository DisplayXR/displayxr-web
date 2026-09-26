// The builtin chip's auto-hide timer (js/lift/ui.js createAutoHide): DOM-free, fake timers.
// Native mode defaults it on because the browser's lift crop weaves anything inside the element's
// rect — the chip included (docs/lift.md § Chrome over the tile).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAutoHide } from '../js/lift/ui.js';

function rig(ms = 2500) {
  const timers = new Map();
  let id = 0;
  const flips = [];
  const a = createAutoHide({
    ms,
    onChange: (v) => flips.push(v),
    setTimer: (fn, t) => (timers.set(++id, { fn, t }), id),
    clearTimer: (i) => timers.delete(i),
  });
  const fire = () => {
    const all = [...timers.values()];
    timers.clear();
    for (const t of all) t.fn();
  };
  return { a, flips, timers, fire };
}

test('chip auto-hide: hides after the quiet period, pointer activity shows it and restarts the timer', () => {
  const { a, flips, timers, fire } = rig();
  assert.equal(a.enabled, true);
  a.poke(); // mount
  assert.equal(a.visible, true);
  assert.equal(timers.size, 1);
  assert.equal([...timers.values()][0].t, 2500);
  fire();
  assert.equal(a.visible, false);
  assert.deepEqual(flips, [false]);
  a.poke(); // pointermove over the element
  assert.equal(a.visible, true);
  assert.equal(timers.size, 1, 'one timer at a time');
  a.poke(); // more activity restarts, never stacks
  assert.equal(timers.size, 1);
  fire();
  assert.equal(a.visible, false);
  assert.deepEqual(flips, [false, true, false]);
});

test('chip auto-hide: keyboard focus pins it visible; releasing re-arms', () => {
  const { a, timers, fire } = rig();
  a.poke();
  fire();
  assert.equal(a.visible, false);
  a.hold(true); // focusin on a chip button
  assert.equal(a.visible, true);
  assert.equal(timers.size, 0, 'no countdown while focused');
  a.poke(); // activity while focused does not arm a hide either
  assert.equal(timers.size, 0);
  a.hold(false); // focus left the chip
  assert.equal(timers.size, 1);
  fire();
  assert.equal(a.visible, false);
});

test('chip auto-hide: 0 disables it (web-path default) — always visible, no timers', () => {
  const { a, timers, flips } = rig(0);
  assert.equal(a.enabled, false);
  a.poke();
  a.hold(false);
  assert.equal(a.visible, true);
  assert.equal(timers.size, 0);
  assert.deepEqual(flips, []);
});

test('chip auto-hide: dispose stops a pending hide', () => {
  const { a, timers } = rig();
  a.poke();
  a.dispose();
  assert.equal(timers.size, 0);
  assert.equal(a.visible, true);
});

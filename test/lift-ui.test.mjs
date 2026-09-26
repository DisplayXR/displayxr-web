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

// ── the input shield: explore drags / clicks must never reach the page's player ───────────────
import { shieldInput, SHIELDED_EVENTS } from '../js/lift/ui.js';

function fakeTarget() {
  const ls = new Map();
  return {
    ls,
    addEventListener: (t, f, o) => ls.set(t, { f, o }),
    removeEventListener: (t) => ls.delete(t),
  };
}
function fakeEvent(type, cancelable = true) {
  return { type, cancelable, stopped: false, prevented: false, stopPropagation() { this.stopped = true; }, preventDefault() { this.prevented = true; } };
}

test('input shield: pointer/mouse/click/touch on the explore overlay stop propagating and are prevented', () => {
  const t = fakeTarget();
  const off = shieldInput(t);
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'click', 'mousedown', 'mouseup', 'dblclick', 'touchstart', 'touchmove', 'touchend']) {
    assert.ok(t.ls.has(type), `${type} shielded`);
    const e = fakeEvent(type);
    t.ls.get(type).f(e);
    assert.equal(e.stopped, true, `${type} does not reach the player`);
    assert.equal(e.prevented, true, `${type} default prevented`);
  }
  assert.equal(t.ls.get('touchstart').o.passive, false, 'touch listeners can preventDefault');
  assert.ok(!SHIELDED_EVENTS.includes('contextmenu'), "the browser's Convert-to-3D menu still opens");
  assert.ok(!SHIELDED_EVENTS.includes('wheel'), 'page scroll untouched');
  off();
  assert.equal(t.ls.size, 0);
});

test('input shield: the chip variant stops propagation only; isActive gates it', () => {
  const t = fakeTarget();
  shieldInput(t, { preventDefault: false });
  const e = fakeEvent('click');
  t.ls.get('click').f(e);
  assert.equal(e.stopped, true);
  assert.equal(e.prevented, false, 'button clicks / focus keep their default');
  let on = false;
  const t2 = fakeTarget();
  shieldInput(t2, { isActive: () => on });
  const e2 = fakeEvent('click');
  t2.ls.get('click').f(e2);
  assert.equal(e2.stopped, false);
  on = true;
  t2.ls.get('click').f(e2);
  assert.equal(e2.stopped, true);
});

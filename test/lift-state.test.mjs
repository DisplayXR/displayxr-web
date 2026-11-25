// The "Convert to 3D" state machine (js/lift/state.js): pure control flow, fake timers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLiftMachine, STATES, PAUSE_DEBOUNCE_MS } from '../js/lift/state.js';

function rig({ kind = 'video', mode = 'auto', paused = false } = {}) {
  const timers = new Map();
  let nextId = 1;
  const effects = [];
  const states = [];
  const env = { paused };
  const m = createLiftMachine({
    kind,
    mode,
    isPaused: () => env.paused,
    onEffect: (name, payload) => effects.push({ name, ...(payload || {}) }),
    onState: (from, to, why) => states.push(`${from}>${to}:${why}`),
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
  });
  return {
    m,
    env,
    effects,
    states,
    names: () => effects.map((e) => e.name),
    last: () => effects[effects.length - 1],
    flushTimers() {
      const all = [...timers.values()];
      timers.clear();
      for (const t of all) t.fn();
    },
    pendingTimers: () => timers.size,
    clear() {
      effects.length = 0;
      states.length = 0;
    },
  };
}

function toLive(r) {
  r.m.send('start');
  r.m.send('loaded');
  assert.equal(r.m.state, STATES.LIVE);
  r.clear();
}

/** Drive an in-flight lift to explore with the CURRENT generation. */
function completeLift(r) {
  const gen = r.m.gen;
  r.m.send('frozen', { gen });
  assert.equal(r.m.state, STATES.LIFTING);
  r.m.send('lifted', { gen });
  assert.equal(r.m.state, STATES.EXPLORE);
}

test('idle → loading → live, with load + startLive effects', () => {
  const r = rig();
  assert.equal(r.m.state, STATES.IDLE);
  r.m.send('start');
  assert.equal(r.m.state, STATES.LOADING);
  assert.deepEqual(r.names(), ['load']);
  r.m.send('loaded');
  assert.equal(r.m.state, STATES.LIVE);
  assert.deepEqual(r.names(), ['load', 'startLive']);
});

test('load failure → error', () => {
  const r = rig();
  r.m.send('start');
  const error = new Error('no model');
  r.m.send('fail', { error });
  assert.equal(r.m.state, STATES.ERROR);
  assert.equal(r.last().name, 'fail');
  assert.equal(r.last().error, error);
});

test('pause is debounced: a pause that holds freezes, then frozen → lifting → explore', () => {
  const r = rig();
  toLive(r);
  r.env.paused = true;
  r.m.send('pause');
  assert.equal(r.m.state, STATES.LIVE, 'nothing happens before the debounce');
  assert.equal(r.pendingTimers(), 1);
  r.flushTimers();
  assert.equal(r.m.state, STATES.FREEZING);
  assert.equal(r.last().name, 'freeze');
  completeLift(r);
  assert.deepEqual(r.names(), ['freeze', 'lift', 'enterExplore']);
  assert.equal(PAUSE_DEBOUNCE_MS, 150);
});

test('pause then play inside the debounce window never freezes', () => {
  const r = rig();
  toLive(r);
  r.env.paused = true;
  r.m.send('pause');
  r.env.paused = false;
  r.m.send('play');
  assert.equal(r.pendingTimers(), 0, 'play cancels the pending debounce');
  r.flushTimers();
  assert.equal(r.m.state, STATES.LIVE);
  assert.deepEqual(r.names(), []);
});

test('a debounce that fires after the media resumed does not freeze', () => {
  const r = rig();
  toLive(r);
  r.env.paused = true;
  r.m.send('pause');
  r.env.paused = false; // resumed without a play event reaching us yet
  r.flushTimers();
  assert.equal(r.m.state, STATES.LIVE);
});

test('play in explore crossfades back to live', () => {
  const r = rig();
  toLive(r);
  r.env.paused = true;
  r.m.send('pause');
  r.flushTimers();
  completeLift(r);
  r.clear();
  r.env.paused = false;
  r.m.send('play');
  assert.equal(r.m.state, STATES.LIVE);
  assert.deepEqual(r.effects, [{ name: 'exitExplore', crossfade: true }]);
});

test('play during freezing/lifting cancels the lift and stale results are dropped', () => {
  const r = rig();
  toLive(r);
  r.env.paused = true;
  r.m.send('pause');
  r.flushTimers();
  const gen = r.m.gen;
  r.m.send('frozen', { gen });
  assert.equal(r.m.state, STATES.LIFTING);
  r.env.paused = false;
  r.m.send('play');
  assert.equal(r.m.state, STATES.LIVE);
  assert.ok(r.names().includes('cancelLift'));
  assert.notEqual(r.m.gen, gen, 'cancel bumps the generation');
  assert.equal(r.m.send('lifted', { gen }), false, 'stale lifted is ignored');
  assert.equal(r.m.state, STATES.LIVE);
});

test('seeked while paused re-freezes with a new generation; the old one is stale', () => {
  const r = rig();
  toLive(r);
  r.env.paused = true;
  r.m.send('pause');
  r.flushTimers();
  const g1 = r.m.gen;
  r.m.send('seeked');
  assert.equal(r.m.state, STATES.FREEZING);
  const g2 = r.m.gen;
  assert.ok(g2 > g1);
  assert.equal(r.m.send('frozen', { gen: g1 }), false);
  assert.equal(r.m.state, STATES.FREEZING);
  r.m.send('frozen', { gen: g2 });
  assert.equal(r.m.state, STATES.LIFTING);
});

test('seeked while live-paused schedules a debounced lift (scrubbing never lifts per seek)', () => {
  const r = rig();
  toLive(r);
  r.env.paused = true;
  r.m.send('seeked');
  r.m.send('seeked');
  r.m.send('seeked');
  assert.equal(r.pendingTimers(), 1, 'one pending debounce, not three');
  r.flushTimers();
  assert.equal(r.m.state, STATES.FREEZING);
  assert.equal(r.names().filter((n) => n === 'freeze').length, 1);
});

test('seeked while playing resets the video provider and stays live', () => {
  const r = rig();
  toLive(r);
  r.m.send('seeked');
  assert.equal(r.m.state, STATES.LIVE);
  assert.deepEqual(r.names(), ['resetProvider']);
});

test('seeked while paused in explore exits explore and lifts the new frame', () => {
  const r = rig();
  toLive(r);
  r.env.paused = true;
  r.m.send('explore-request');
  completeLift(r);
  r.clear();
  r.m.send('seeked');
  assert.equal(r.m.state, STATES.FREEZING);
  assert.deepEqual(r.names(), ['exitExplore', 'freeze']);
});

test('ended lifts the last frame immediately (no debounce)', () => {
  const r = rig();
  toLive(r);
  r.env.paused = true;
  r.m.send('ended');
  assert.equal(r.m.state, STATES.FREEZING);
  assert.equal(r.pendingTimers(), 0);
});

test('emptied / src swap: reset and stay live, from live and from explore', () => {
  const r = rig();
  toLive(r);
  r.m.send('emptied');
  assert.equal(r.m.state, STATES.LIVE);
  assert.deepEqual(r.names(), ['resetProvider']);
  r.env.paused = true;
  r.m.send('explore-request');
  completeLift(r);
  r.clear();
  r.m.send('emptied');
  assert.equal(r.m.state, STATES.LIVE);
  assert.deepEqual(r.names(), ['exitExplore', 'resetProvider']);
});

test('explore-request on a playing video pauses it and freezes', () => {
  const r = rig();
  toLive(r);
  r.m.send('explore-request');
  assert.equal(r.m.state, STATES.FREEZING);
  assert.deepEqual(r.names(), ['pauseMedia', 'freeze']);
  // The element's own `pause` event arrives afterwards and must not restart anything.
  r.env.paused = true;
  r.m.send('pause');
  assert.equal(r.pendingTimers(), 0);
});

test('resume-request in explore goes live at once on the PAUSED frame — it never plays the media', () => {
  const r = rig();
  toLive(r);
  r.env.paused = true;
  r.m.send('explore-request');
  completeLift(r);
  r.clear();
  r.m.send('resume-request');
  assert.equal(r.m.state, STATES.LIVE, 'live in the same tick');
  assert.deepEqual(r.effects, [{ name: 'exitExplore', crossfade: true }], 'no playMedia: the video stays paused');
  assert.deepEqual(r.states, ['explore>live:resume']);
  // the paused video stays live: no re-lift on its own
  assert.equal(r.pendingTimers(), 0);
  // (c) an explicit play afterwards (the page's controls / handle.play()) lands in LIVE
  r.env.paused = false;
  r.clear();
  r.m.send('play');
  assert.equal(r.m.state, STATES.LIVE);
  assert.deepEqual(r.effects, []);
});

// ── play never waits on explore work ───────────────────────────────────────────────────────
// Wired the way lift.js wires it: the `lift` effect starts an async generator whose result is sent
// back with the generation it was started for. The generator is a deferred the test resolves.
function genRig() {
  const r = rig();
  const jobs = [];
  const m = createLiftMachine({
    kind: 'video',
    mode: 'auto',
    isPaused: () => r.env.paused,
    setTimer: (fn) => (fn(), 1), // debounce fires at once
    clearTimer: () => {},
    onEffect: (name, p = {}) => {
      r.effects.push({ name, ...p });
      if (name === 'freeze') queueMicrotask(() => m.send('frozen', { gen: p.gen }));
      if (name === 'lift') {
        let resolve;
        const promise = new Promise((res) => (resolve = res));
        const job = { gen: p.gen, resolve, settled: false, accepted: null };
        job.done = promise.then(() => {
          job.settled = true;
          job.accepted = m.send('lifted', { gen: job.gen });
        });
        jobs.push(job);
      }
    },
    onState: (from, to, why) => r.states.push(`${from}>${to}:${why}`),
  });
  return { ...r, m, jobs };
}

test('play during explore work returns to live synchronously, before the generator settles', async () => {
  const r = genRig();
  r.m.send('start');
  r.m.send('loaded');
  r.env.paused = true;
  r.m.send('pause'); // → freezing
  await Promise.resolve(); // frozen → lifting, generator started
  assert.equal(r.m.state, STATES.LIFTING);
  assert.equal(r.jobs.length, 1);
  r.clear();
  r.env.paused = false;
  r.m.send('play');
  // observed synchronously: no microtask has run, the generator has not settled
  assert.equal(r.m.state, STATES.LIVE);
  assert.equal(r.jobs[0].settled, false, 'the transition did not wait on the generator');
  assert.deepEqual(r.names(), ['cancelLift']);
  assert.deepEqual(r.states, ['lifting>live:play']);
  // the same from explore itself (the scene is up, a new lift not needed)
  r.env.paused = true;
  r.m.send('pause');
  await Promise.resolve();
  r.jobs[1].resolve();
  await r.jobs[1].done;
  assert.equal(r.m.state, STATES.EXPLORE);
  r.clear();
  r.env.paused = false;
  r.m.send('play');
  assert.equal(r.m.state, STATES.LIVE);
  assert.deepEqual(r.effects, [{ name: 'exitExplore', crossfade: true }]);
});

test('resume-request mid-lift goes live synchronously and abandons the lift, without playing', async () => {
  const r = genRig();
  r.m.send('start');
  r.m.send('loaded');
  r.env.paused = true;
  r.m.send('explore-request');
  assert.equal(r.m.state, STATES.FREEZING);
  r.clear();
  r.m.send('resume-request'); // the chip's Resume / handle.resume() while converting
  assert.equal(r.m.state, STATES.LIVE);
  assert.deepEqual(r.names(), ['cancelLift']);
  await Promise.resolve(); // the stale `frozen` from the abandoned freeze lands now
  assert.equal(r.m.state, STATES.LIVE, 'a late frozen from the abandoned gen is ignored');
  assert.equal(r.jobs.length, 0, 'no lift was started for it');
});

test('a generator result arriving after the cancel is ignored', async () => {
  const r = genRig();
  r.m.send('start');
  r.m.send('loaded');
  r.env.paused = true;
  r.m.send('pause');
  await Promise.resolve();
  const job = r.jobs[0];
  r.env.paused = false;
  r.m.send('play');
  const genAfter = r.m.gen;
  assert.notEqual(job.gen, genAfter, 'the cancel bumped the generation');
  r.clear();
  job.resolve({ ply: new Uint8Array(4) }); // the generator finishes anyway
  await job.done;
  assert.equal(job.accepted, false, 'lifted from the abandoned gen is rejected');
  assert.equal(r.m.state, STATES.LIVE);
  assert.deepEqual(r.effects, [], 'no enterExplore, no liftError, nothing');
  assert.deepEqual(r.states, []);
  // and a late failure is just as silent
  assert.equal(r.m.send('lift-failed', { gen: job.gen, error: new Error('late') }), false);
  assert.deepEqual(r.effects, []);
});

test('mode live: pause and ended never lift; explore() still does', () => {
  const r = rig({ mode: 'live' });
  toLive(r);
  r.env.paused = true;
  r.m.send('pause');
  r.flushTimers();
  r.m.send('ended');
  assert.equal(r.m.state, STATES.LIVE);
  r.m.send('explore-request');
  assert.equal(r.m.state, STATES.FREEZING);
});

test('mode explore: lifts as soon as loaded', () => {
  const r = rig({ mode: 'explore' });
  r.m.send('start');
  r.m.send('loaded');
  assert.equal(r.m.state, STATES.FREEZING);
});

test('an already-paused video lifts after loading (debounced)', () => {
  const r = rig({ paused: true });
  r.m.send('start');
  r.m.send('loaded');
  assert.equal(r.m.state, STATES.LIVE);
  r.flushTimers();
  assert.equal(r.m.state, STATES.FREEZING);
});

test('still (<img>/<canvas>): loading goes straight to a lift, then explore', () => {
  const r = rig({ kind: 'still' });
  r.m.send('start');
  r.m.send('loaded');
  assert.equal(r.m.state, STATES.FREEZING);
  assert.ok(!r.names().includes('startLive'));
  completeLift(r);
  r.m.send('play');
  assert.equal(r.m.state, STATES.EXPLORE, 'a still has no live state: media events are ignored');
});

test('lift failure: a video falls back to live, a still errors', () => {
  const v = rig();
  toLive(v);
  v.m.send('explore-request');
  const error = new Error('oom');
  v.m.send('lift-failed', { gen: v.m.gen, error });
  assert.equal(v.m.state, STATES.LIVE);
  assert.ok(v.names().includes('liftError'));

  const s = rig({ kind: 'still' });
  s.m.send('start');
  s.m.send('loaded');
  s.m.send('lift-failed', { gen: s.m.gen, error });
  assert.equal(s.m.state, STATES.ERROR);
});

test('hidden → suspended → visible returns to live and explore', () => {
  const r = rig();
  toLive(r);
  r.m.send('hidden');
  assert.equal(r.m.state, STATES.SUSPENDED);
  assert.deepEqual(r.names(), ['suspend']);
  r.m.send('visible');
  assert.equal(r.m.state, STATES.LIVE);
  r.env.paused = true;
  r.m.send('explore-request');
  completeLift(r);
  r.m.send('hidden');
  r.m.send('visible');
  assert.equal(r.m.state, STATES.EXPLORE);
});

test('hidden during lifting cancels; visible restarts the lift when still paused', () => {
  const r = rig();
  toLive(r);
  r.env.paused = true;
  r.m.send('explore-request');
  const g = r.m.gen;
  r.m.send('hidden');
  assert.equal(r.m.state, STATES.SUSPENDED);
  assert.ok(r.names().includes('cancelLift'));
  assert.equal(r.m.send('frozen', { gen: g }), false);
  r.m.send('visible');
  assert.equal(r.m.state, STATES.FREEZING);
  assert.ok(r.m.gen > g);
});

test('play while suspended in explore comes back live, not to a stale explore', () => {
  const r = rig();
  toLive(r);
  r.env.paused = true;
  r.m.send('explore-request');
  completeLift(r);
  r.m.send('hidden');
  r.env.paused = false;
  r.m.send('play');
  r.m.send('visible');
  assert.equal(r.m.state, STATES.LIVE);
  assert.ok(r.names().includes('exitExplore'));
});

test('hidden during loading: loaded arrives while away, visible completes it', () => {
  const r = rig();
  r.m.send('start');
  r.m.send('hidden');
  assert.equal(r.m.state, STATES.SUSPENDED);
  r.m.send('loaded');
  assert.equal(r.m.state, STATES.SUSPENDED);
  r.m.send('visible');
  assert.equal(r.m.state, STATES.LIVE);
});

test('disconnected / remove → disposed from any state; everything after is ignored', () => {
  for (const ev of ['remove', 'disconnected']) {
    const r = rig();
    toLive(r);
    r.m.send('explore-request');
    r.m.send(ev);
    assert.equal(r.m.state, STATES.DISPOSED);
    assert.deepEqual(r.names(), ['pauseMedia', 'freeze', 'cancelLift', 'dispose']);
    assert.equal(r.m.send('play'), false);
    assert.equal(r.m.send('start'), false);
    assert.equal(r.m.state, STATES.DISPOSED);
  }
});

test('remove cancels a pending pause debounce', () => {
  const r = rig();
  toLive(r);
  r.env.paused = true;
  r.m.send('pause');
  r.m.send('remove');
  assert.equal(r.pendingTimers(), 0);
});

test('fatal from anywhere → error; remove still disposes', () => {
  const r = rig();
  toLive(r);
  r.m.send('fatal', { error: new Error('context lost') });
  assert.equal(r.m.state, STATES.ERROR);
  r.m.send('remove');
  assert.equal(r.m.state, STATES.DISPOSED);
});

test('statechange log names the reason', () => {
  const r = rig();
  r.m.send('start');
  r.m.send('loaded');
  assert.deepEqual(r.states, ['idle>loading:start', 'loading>live:loaded']);
});

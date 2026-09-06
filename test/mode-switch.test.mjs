// Tests for the eased 2D<->3D transition: the `ModeSwitch` state machine on its own, and the
// manager integration that drives it.
//
// PART A mirrors `test_mode_switch` in displayxr-common's `tests/common_smoke.cpp` case for case —
// this is a port, and the port is only worth anything if it behaves identically. What those cases
// pin is not values but ORDER: a ->2D switch fires on landing (flat content first), a ->3D switch
// fires on the first frame (flat frame first), a reversed ->2D never fires at all, and duration 0
// collapses both into one update.
//
// PART B pins the browser-side half, which the C++ has no equivalent of: the up-ramp waits for the
// panel to REPORT 3D rather than starting when the request goes out, the page's promise settles on
// the FORWARDED request rather than on the click, a refusal in either direction leaves the page
// where the display actually is, and a mode change nobody asked for still snaps.
//
// The clock is stubbed and frames are stepped by hand, so nothing here depends on real time.

import test from 'node:test';
import assert from 'node:assert/strict';

import { ModeSwitch, normaliseModeSwitchEasing, MODE_SWITCH_DEFAULT_DURATION_MS } from '../js/inline3d-mode-switch.js';

// ── PART A: the state machine, against the C++ smoke test ───────────────────────────────

const DT = 0.06; // 3 frames spans the default 0.18 s ramp — the C++ test's step

test('C++ case 1 — 3D->2D ramps the disparity to 0 FIRST, then fires exactly once, on landing', () => {
  const ms = new ModeSwitch();
  ms.configure(0.18, 'smoothstep');
  ms.request({ targetMode: 0, targetViewCount: 1, currentMode: 1, currentViewCount: 2, current: 1, steady: 1 });
  assert.equal(ms.active(), true, '3D->2D should be active after request');

  let factor = 1;
  let prev = 2;
  let fired = false;
  let firedMode = 999;
  let fireCount = 0;
  for (let i = 0; i < 4; i++) {
    const out = ms.update(DT);
    factor = out.factor;
    assert.ok(factor <= prev + 1e-4, '3D->2D disparity must be monotonically non-increasing');
    prev = factor;
    if (out.fire) {
      fired = true;
      firedMode = out.mode;
      fireCount++;
    }
  }
  assert.ok(fired && firedMode === 0, '3D->2D must fire the 2D mode exactly once, on landing');
  assert.equal(fireCount, 1, '3D->2D fire must be edge (one frame only)');
  assert.ok(factor < 1e-3, '3D->2D must land at zero disparity');
  assert.equal(ms.active(), false, '3D->2D should be idle after landing');
});

test('C++ case 2 — 2D->3D fires IMMEDIATELY (flat first frame), then ramps up', () => {
  const ms = new ModeSwitch();
  ms.configure(0.18);
  ms.request({ targetMode: 1, targetViewCount: 2, currentMode: 0, currentViewCount: 1, current: 0, steady: 1 });

  let factor = -1;
  let prev = -1;
  let fireCount = 0;
  let firedMode = 999;
  let fireFrame = -1;
  for (let i = 0; i < 4; i++) {
    const out = ms.update(DT);
    if (out.fire) {
      fireCount++;
      firedMode = out.mode;
      if (fireFrame < 0) fireFrame = i;
    }
    factor = out.factor;
    assert.ok(factor >= prev - 1e-4, '2D->3D disparity must be monotonically non-decreasing');
    prev = factor;
  }
  assert.ok(fireCount === 1 && fireFrame === 0, '2D->3D must fire once, on the FIRST frame');
  assert.equal(firedMode, 1, '2D->3D must fire the requested 3D mode');
  assert.ok(factor > 0.99, '2D->3D must ramp up to the steady disparity');
  assert.equal(ms.active(), false, '2D->3D should be idle after landing');
});

test('C++ case 3 — reversing a NOT-YET-FIRED ->2D never switches, and restores steady disparity', () => {
  const ms = new ModeSwitch();
  ms.configure(0.18);
  ms.request({ targetMode: 0, targetViewCount: 1, currentMode: 1, currentViewCount: 2, current: 1, steady: 1 });

  let factor = 1;
  let everFired = false;
  for (let i = 0; i < 2; i++) {
    const out = ms.update(DT);
    factor = out.factor;
    if (out.fire) everFired = true;
  }
  assert.ok(!everFired && factor > 0 && factor < 1, 'mid ramp-down: not fired, partially flat');

  // The display is still 3D (the 2D switch never fired) -> reverse to 3D.
  ms.request({ targetMode: 1, targetViewCount: 2, currentMode: 1, currentViewCount: 2, current: factor, steady: 1 });
  for (let i = 0; i < 4; i++) {
    const out = ms.update(DT);
    factor = out.factor;
    if (out.fire) everFired = true;
  }
  assert.equal(everFired, false, 'reversing an un-fired ->2D must NEVER issue a mode switch');
  assert.ok(factor > 0.99, 'reversal must restore steady disparity');
  assert.equal(ms.active(), false, 'reversal should settle to idle');
});

test('C++ case 4 — duration 0 fires and reaches the endpoint on the first update, both ways', () => {
  const ms = new ModeSwitch();
  ms.configure(0);
  ms.request({ targetMode: 1, targetViewCount: 2, currentMode: 0, currentViewCount: 1, current: 0, steady: 1 });
  let out = ms.update(0.016);
  assert.ok(
    out.fire && out.mode === 1 && out.factor > 0.99 && !ms.active(),
    'instant 2D->3D must fire and reach steady in one frame'
  );

  ms.request({ targetMode: 0, targetViewCount: 1, currentMode: 1, currentViewCount: 2, current: 1, steady: 1 });
  out = ms.update(0.016);
  assert.ok(
    out.fire && out.mode === 0 && out.factor < 1e-3 && !ms.active(),
    'instant 3D->2D must fire and flatten in one frame'
  );
});

test('C++ case 5 — same-dimensionality 3D->3D fires once and never flattens', () => {
  const ms = new ModeSwitch();
  ms.configure(0.18);
  ms.request({ targetMode: 2, targetViewCount: 2, currentMode: 1, currentViewCount: 2, current: 1, steady: 1 });
  let fireCount = 0;
  let firedMode = 999;
  for (let i = 0; i < 4; i++) {
    const out = ms.update(DT);
    if (out.fire) {
      fireCount++;
      firedMode = out.mode;
    }
    assert.ok(out.factor > 0.99, '3D->3D must keep full disparity throughout (no flatten)');
  }
  assert.ok(fireCount === 1 && firedMode === 2, '3D->3D must fire the new mode once');
});

// The port's own additions — the defaults it has to match, and the value it restores TO.

test('the defaults are the C++ ones: 0.18 s, SmoothStep', () => {
  const ms = new ModeSwitch();
  assert.equal(MODE_SWITCH_DEFAULT_DURATION_MS, 180);
  assert.equal(ms.durationS, 0.18);
  assert.equal(ms.easing, 'smoothstep');
  // ...and smoothstep is Hermite, not linear: half way through, half way there is the ONE point
  // the two curves share, so check a quarter.
  ms.request({ targetViewCount: 2, currentViewCount: 1, current: 0, steady: 1 });
  const out = ms.update(0.045); // t = 0.25 -> 3t^2 - 2t^3 = 0.15625
  assert.ok(Math.abs(out.factor - 0.15625) < 1e-6, 'smoothstep, not linear');
});

test('an unknown easing name falls back rather than throwing; the known ones round-trip', () => {
  assert.equal(normaliseModeSwitchEasing('SmoothStep'), 'smoothstep');
  assert.equal(normaliseModeSwitchEasing('ease-out-cubic'), 'easeoutcubic');
  assert.equal(normaliseModeSwitchEasing('linear'), 'linear');
  assert.equal(normaliseModeSwitchEasing('ease-in-out'), null);
  assert.equal(new ModeSwitch(0.18, 'ease-in-out').easing, 'smoothstep');
});

test('the ramp restores to the CONFIGURED steady value, never a hardcoded 1', () => {
  const ms = new ModeSwitch(0.1, 'linear');
  ms.request({ targetViewCount: 2, currentViewCount: 1, current: 0, steady: 0.35 });
  ms.update(0.05);
  assert.ok(Math.abs(ms.value() - 0.175) < 1e-6, 'half way to the tuned value, not to 1');
  ms.update(0.05);
  assert.equal(ms.value(), 0.35);
});

test('wall-clock dt, not frame counts — the same ramp lands in the same TIME at any rate', () => {
  const slow = new ModeSwitch(0.18, 'linear');
  const fast = new ModeSwitch(0.18, 'linear');
  const req = { targetViewCount: 1, currentViewCount: 2, current: 1, steady: 1 };
  slow.request(req);
  fast.request(req);
  for (let i = 0; i < 3; i++) slow.update(0.03); // 30 fps, 90 ms
  for (let i = 0; i < 6; i++) fast.update(0.015); // 144-ish, 90 ms
  assert.ok(Math.abs(slow.value() - fast.value()) < 1e-6);
  assert.ok(Math.abs(slow.value() - 0.5) < 1e-6);
});

// ── PART B: the manager integration ─────────────────────────────────────────────────────

const DISPLAY_INFO = {
  displayWidthMeters: 0.6,
  displayHeightMeters: 0.34,
  displayPixelWidth: 3840,
  displayPixelHeight: 2160,
  recommendedViewScaleX: 0.5,
  recommendedViewScaleY: 1,
};

/** Mode 0 is the requestable 1-view (flat) mode; mode 1 is the 2-view one and starts active. */
function makeModes() {
  return [
    { modeIndex: 0, name: '2D', viewCount: 1, hardwareDisplay3D: false, isActive: false, isRequestable: true },
    { modeIndex: 1, name: 'SBS', viewCount: 2, hardwareDisplay3D: true, isActive: true, isRequestable: true },
  ];
}

const FRAME = { getViewerPose: () => null };
const flush = () => new Promise((r) => setTimeout(r, 0));

/**
 * The globals `createInline3D` touches, plus the two levers these tests need that the
 * display-mode tests do not: a STEPPABLE frame loop and a stubbed clock. Both matter because the
 * behaviour under test is a time-based ramp advanced from the session's frame callback — driving
 * it with real time would make every assertion a race.
 */
function installEnv({ refuse = [] } = {}) {
  const modes = makeModes();
  const created = [];
  const clock = { now: 1000 };
  let pendingFrame = null;

  class FakeDisplayLayer {
    constructor(session, canvas, init) {
      this.init = init;
      this.rigs = [];
      this.modeRequests = [];
      created.push(this);
    }
    getViewport() {
      return null;
    }
    close() {}
  }
  const P = FakeDisplayLayer.prototype;
  P.setViewRig = function setViewRig(rig) {
    this.rigs.push(rig);
  };
  P.getDisplayInfo = async () => DISPLAY_INFO;
  P.getRenderingModes = async () => modes;
  P.requestRenderingMode = function requestRenderingMode(i) {
    const mode = modes.find((m) => m.modeIndex === i);
    if (!mode) throw new TypeError('unknown modeIndex');
    this.modeRequests.push(i);
    if (refuse.includes(i)) {
      const e = new Error('not forwardable');
      e.name = 'NotSupportedError';
      return Promise.reject(e);
    }
    return Promise.resolve();
  };

  const listeners = new Map();
  const session = {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    requestReferenceSpace: async () => ({}),
    requestAnimationFrame(cb) {
      pendingFrame = cb;
      return 1;
    },
    end() {},
  };
  Object.defineProperty(globalThis, 'navigator', {
    value: { xr: { requestSession: async () => session } },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'performance', {
    value: { now: () => clock.now },
    configurable: true,
    writable: true,
  });
  globalThis.window = {
    XRDisplayLayer: FakeDisplayLayer,
    devicePixelRatio: 1,
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.XRDisplayLayer = FakeDisplayLayer;
  globalThis.document = undefined;
  globalThis.IntersectionObserver = class {
    constructor() {}
    observe() {}
    unobserve() {}
    disconnect() {}
  };

  return {
    session,
    created,
    modes,
    /** What the browser does when a mode goes active: the list moves, THEN the event fires. */
    goActive(i) {
      for (const m of modes) m.isActive = m.modeIndex === i;
      for (const fn of listeners.get('renderingmodechange') ?? []) fn({ type: 'renderingmodechange', detail: { modeIndex: i } });
    },
    /** Advance the wall clock by `ms` and run one session frame with it. */
    async step(ms) {
      clock.now += ms;
      const cb = pendingFrame;
      pendingFrame = null;
      if (cb) cb(clock.now, FRAME);
      await flush();
    },
  };
}

function makeCanvas() {
  return {
    style: {},
    width: 0,
    height: 0,
    clientWidth: 300,
    clientHeight: 150,
    parentElement: null,
    contains: () => false,
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 300, height: 150, right: 300, bottom: 150, left: 0, top: 0 }),
  };
}

installEnv();
const { createInline3D } = await import('../js/inline3d.js');

/** ipd 2 / parallax 2 — deliberately NOT 1, so "restores to steady" cannot pass by accident. */
const CAM_RIG = { type: 'camera', position: { x: 0, y: 0, z: 0 }, verticalFov: 0.8, ipdFactor: 2, parallaxFactor: 2 };

/** Silence the once-only auto-collapse notice. */
function quietInfo(fn) {
  const real = console.info;
  console.info = () => {};
  return Promise.resolve(fn()).finally(() => {
    console.info = real;
  });
}

/** A live, non-lazy wall with one scene window whose first mode read has already landed. */
async function makeWall(env, wallOpts = {}) {
  const wall = await createInline3D({ lazy: false, autoChrome: false, ...wallOpts });
  const handle = wall.addScene(makeCanvas(), () => {}, {});
  await flush();
  return { wall, handle, layer: env.created[0] };
}

test('3D->2D: the disparity ramps out FIRST and the mode request fires only on landing', async () => {
  const env = installEnv();
  const { wall, handle, layer } = await makeWall(env);
  handle.setViewRig(CAM_RIG);
  assert.equal(layer.rigs.at(-1).ipdFactor, 2);

  const pending = handle.requestRenderingMode(0);
  await flush();
  assert.deepEqual(layer.modeRequests, [], 'nothing may reach the browser before the ramp lands');

  await env.step(18); // a tenth of the way
  const first = layer.rigs.at(-1);
  assert.ok(first.ipdFactor > 1.8 && first.ipdFactor < 2, 'the FIRST press must not snap');
  assert.equal(first.parallaxFactor, first.ipdFactor, 'ipd and parallax ramp together');
  assert.equal(first.verticalFov, CAM_RIG.verticalFov, 'only the two factors move');

  await env.step(72); // half way
  assert.ok(Math.abs(layer.rigs.at(-1).ipdFactor - 1) < 1e-6, 'smoothstep(0.5) = 0.5 of steady');
  assert.deepEqual(layer.modeRequests, [], 'still not forwarded');
  assert.equal(wall.modeSwitch.active, true);

  await env.step(90); // lands
  assert.equal(layer.rigs.at(-1).ipdFactor, 0);
  await pending;
  assert.deepEqual(layer.modeRequests, [0], 'the request fires on already-flat content');
  assert.equal(wall.modeSwitch.factor, 0);
  assert.equal(wall.modeSwitch.active, false);

  // The page's own descriptor was never written into, so the restore can be exact.
  assert.equal(CAM_RIG.ipdFactor, 2);
  wall.close();
});

test('the ramp-down is monotonic and pushed every frame it moves, never when it is idle', async () => {
  const env = installEnv();
  const { wall, handle, layer } = await makeWall(env);
  handle.setViewRig(CAM_RIG);
  const pending = handle.requestRenderingMode(0);
  await flush();
  const from = layer.rigs.length;
  for (let i = 0; i < 12; i++) await env.step(20);
  await pending;
  const pushed = layer.rigs.slice(from).map((r) => r.ipdFactor);
  assert.ok(pushed.length >= 6 && pushed.length <= 10, `one push per moving frame, got ${pushed.length}`);
  for (let i = 1; i < pushed.length; i++) assert.ok(pushed[i] <= pushed[i - 1] + 1e-9, 'monotonic');
  assert.equal(pushed.at(-1), 0);

  const settled = layer.rigs.length;
  for (let i = 0; i < 5; i++) await env.step(20);
  assert.equal(layer.rigs.length, settled, 'an idle manager must not re-push the rig every frame');
  wall.close();
});

test('2D->3D: the request goes out FIRST, and the up-ramp waits for the panel to REPORT 3D', async () => {
  const env = installEnv();
  const { wall, handle, layer } = await makeWall(env);
  handle.setViewRig(CAM_RIG);
  await quietInfo(async () => {
    env.goActive(0); // the panel really is flat now
    await flush();
  });
  assert.equal(wall.modeSwitch.factor, 0);

  await wall.setStereoEnabled(true);
  assert.deepEqual(layer.modeRequests, [1], 'the ->3D request is forwarded immediately');
  assert.equal(wall.modeSwitch.active, true, 'a transition is in flight — waiting on the panel');

  await env.step(200); // frames run, but the panel has not said anything
  assert.equal(wall.modeSwitch.factor, 0, 'disparity on a still-flat panel would be a double image');
  assert.equal(layer.rigs.at(-1).ipdFactor, 0);

  env.goActive(1);
  await flush();
  await env.step(90);
  const mid = layer.rigs.at(-1).ipdFactor;
  assert.ok(mid > 0 && mid < 2, `mid-ramp, got ${mid}`);
  await env.step(90);
  assert.equal(layer.rigs.at(-1).ipdFactor, 2, 'eased back to the rig the page set, exactly');
  assert.equal(wall.modeSwitch.active, false);
  wall.close();
});

test('reversing a not-yet-fired ->2D ramps back up and NEVER fires the switch', async () => {
  const env = installEnv();
  const { wall, handle, layer } = await makeWall(env);
  handle.setViewRig(CAM_RIG);

  const down = handle.requestRenderingMode(0);
  // Claim the rejection now, not after the reversal: an unhandled rejection between the two is a
  // property of this test's timing, not of the SDK.
  const downSettled = assert.rejects(down, { name: 'superseded' }, 'the held 2D request is dropped, not fired late');
  await flush();
  await env.step(90);
  const half = layer.rigs.at(-1).ipdFactor;
  assert.ok(half > 0 && half < 2, 'half flat');

  const back = handle.requestRenderingMode(1); // the user changed their mind
  await flush();
  await downSettled;
  await back;
  assert.deepEqual(layer.modeRequests, [], 'the display never left mode 1, so nothing was asked of it');

  await env.step(90);
  const resumed = layer.rigs.at(-1).ipdFactor;
  assert.ok(resumed > half, 'the reversal ramps up from where it got to, seamlessly');
  await env.step(200);
  assert.equal(layer.rigs.at(-1).ipdFactor, 2);
  assert.equal(wall.modeSwitch.active, false);
  wall.close();
});

test('setStereoEnabled(true) reverses a ramp-down even though its 2-view mode is still active', async () => {
  const env = installEnv();
  const { wall, handle, layer } = await makeWall(env);
  handle.setViewRig(CAM_RIG);
  const down = wall.setStereoEnabled(false);
  const downSettled = assert.rejects(down, { name: 'superseded' });
  await flush();
  await env.step(60);

  // The sugar's idempotent early-out ("mode 1 is already active") must not fire here, or the page
  // would be left stuck part-way flat with no way back.
  await wall.setStereoEnabled(true);
  await downSettled;
  await env.step(200);
  assert.equal(layer.rigs.at(-1).ipdFactor, 2);
  wall.close();
});

test('a refused ->2D leaves the page in 3D: the disparity ramps back to steady', async () => {
  const env = installEnv({ refuse: [0] });
  const { wall, handle, layer } = await makeWall(env);
  handle.setViewRig(CAM_RIG);
  const pending = handle.requestRenderingMode(0);
  const settled = assert.rejects(pending, { name: 'NotSupportedError' }, 'the refusal reaches the page unchanged');
  await flush();
  await env.step(200); // ramp lands, request fires, browser refuses
  await settled;
  assert.deepEqual(layer.modeRequests, [0]);
  assert.equal(wall.stereoCollapsed, false, 'nothing was reported, so nothing latched');

  await env.step(200);
  assert.equal(layer.rigs.at(-1).ipdFactor, 2, 'a refused switch must not leave the page flat');
  wall.close();
});

test('a refused ->3D leaves the page FLAT: the armed up-ramp is disarmed, not run', async () => {
  const env = installEnv({ refuse: [1] });
  const { wall, handle, layer } = await makeWall(env);
  handle.setViewRig(CAM_RIG);
  await quietInfo(async () => {
    env.goActive(0);
    await flush();
  });
  await assert.rejects(() => handle.requestRenderingMode(1), { name: 'NotSupportedError' });
  await env.step(300);
  assert.equal(layer.rigs.at(-1).ipdFactor, 0, 'stereo on a flat panel is the one bad state');
  assert.equal(wall.modeSwitch.factor, 0);
  assert.equal(wall.modeSwitch.active, false);
  wall.close();
});

test('a mode change the page did not request still SNAPS — there is nothing to ramp from', async () => {
  const env = installEnv();
  const { wall, handle, layer } = await makeWall(env);
  handle.setViewRig(CAM_RIG);
  await quietInfo(async () => {
    env.goActive(0); // another tab, the shell, the user
    await flush();
  });
  assert.equal(layer.rigs.at(-1).ipdFactor, 0, 'no frame had to run for this');
  assert.equal(wall.modeSwitch.active, false);
  env.goActive(1);
  await flush();
  assert.deepEqual(layer.rigs.at(-1), CAM_RIG, 'and back, exactly');
  wall.close();
});

test('modeSwitch:{enabled:false} is the old snap — the request goes out at once, no rig moves', async () => {
  const env = installEnv();
  const { wall, handle, layer } = await makeWall(env, { modeSwitch: { enabled: false } });
  handle.setViewRig(CAM_RIG);
  const pushes = layer.rigs.length;
  await handle.requestRenderingMode(0);
  assert.deepEqual(layer.modeRequests, [0], 'forwarded on the click, not on a frame');
  assert.equal(layer.rigs.length, pushes, 'nothing ramped');
  assert.equal(wall.modeSwitch.active, false);
  wall.close();
});

test('modeSwitch:{durationMs:0} forwards immediately but still flattens first', async () => {
  const env = installEnv();
  const { wall, handle, layer } = await makeWall(env, { modeSwitch: { durationMs: 0 } });
  handle.setViewRig(CAM_RIG);
  const pending = handle.requestRenderingMode(0);
  await flush();
  await env.step(0); // one frame, no time
  await pending;
  assert.deepEqual(layer.modeRequests, [0]);
  assert.equal(layer.rigs.at(-1).ipdFactor, 0, 'the flatten still lands before the request');
  wall.close();
});

test('modeSwitch:{easing} takes the name; an unknown one warns once and uses smoothstep', async () => {
  const env = installEnv();
  const real = console.warn;
  const warnings = [];
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    const { wall, handle, layer } = await makeWall(env, { modeSwitch: { easing: 'linear' } });
    handle.setViewRig(CAM_RIG);
    const pending = handle.requestRenderingMode(0);
    await flush();
    await env.step(90);
    assert.ok(Math.abs(layer.rigs.at(-1).ipdFactor - 1) < 1e-6, 'linear at t=0.5 is also 0.5 — check the far end');
    await env.step(45);
    assert.ok(Math.abs(layer.rigs.at(-1).ipdFactor - 0.5) < 1e-6, 'linear at t=0.75, where smoothstep is 0.16');
    await env.step(90);
    await pending;
    wall.close();

    const bogus = await makeWall(installEnv(), { modeSwitch: { easing: 'ease-in-out' } });
    assert.ok(
      warnings.some((w) => w.includes('ease-in-out')),
      'a typo in the option is worth exactly one warning'
    );
    bogus.wall.close();
  } finally {
    console.warn = real;
  }
});

test('closing the session settles a held ->2D request instead of leaving the page waiting', async () => {
  const env = installEnv();
  const { wall, handle } = await makeWall(env);
  handle.setViewRig(CAM_RIG);
  const pending = handle.requestRenderingMode(0);
  await flush();
  await env.step(60);
  wall.close();
  await assert.rejects(pending, { name: 'closed' });
});

test('the transition is skipped on a browser with no setViewRig — there is nothing to ramp', async () => {
  const env = installEnv();
  delete globalThis.window.XRDisplayLayer.prototype.setViewRig;
  const real = console.warn;
  console.warn = () => {};
  try {
    const wall = await createInline3D({ lazy: false, autoChrome: false });
    const handle = wall.addScene(makeCanvas(), () => {}, {});
    await flush();
    await handle.requestRenderingMode(0);
    assert.deepEqual(env.created[0].modeRequests, [0], 'forwarded at once, exactly as before rigs existed');
    wall.close();
  } finally {
    console.warn = real;
    installEnv();
  }
});

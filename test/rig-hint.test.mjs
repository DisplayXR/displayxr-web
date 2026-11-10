// The one-time "this camera rig orbits a fixed point" hint (js/inline3d-rig-hint.js).
import test from 'node:test';
import assert from 'node:assert/strict';

const { noteCameraRigOrbit, ORBIT_HINT_MSG } = await import('../js/inline3d-rig-hint.js');

function withInfo(fn) {
  const infos = [];
  const real = console.info;
  console.info = (...a) => infos.push(a.map(String).join(' '));
  try {
    fn();
  } finally {
    console.info = real;
  }
  return infos;
}

// A camera on a circle of radius r around `target`, looking at it (yaw only), converged on it.
function orbitRig(yaw, { r = 5, target = [0, 1, 0], conv = r } = {}) {
  const half = yaw / 2;
  return {
    type: 'camera',
    position: { x: target[0] + r * Math.sin(yaw), y: target[1], z: target[2] + r * Math.cos(yaw) },
    orientation: { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) },
    convergenceDiopters: 1 / conv,
    verticalFov: 0.8,
  };
}

test('an orbit around a fixed target hints once, after a 45° swing', () => {
  const state = {};
  const infos = withInfo(() => {
    for (let deg = 0; deg <= 40; deg += 2) assert.equal(noteCameraRigOrbit(state, orbitRig((deg * Math.PI) / 180)), false, `${deg}°`);
    for (let deg = 42; deg <= 180; deg += 2) noteCameraRigOrbit(state, orbitRig((deg * Math.PI) / 180));
  });
  assert.equal(infos.length, 1, infos.join('\n'));
  assert.equal(infos[0], ORBIT_HINT_MSG);
  assert.match(infos[0], /displayRig\(/);
});

test('turning in place (first person) never hints: the convergence point moves', () => {
  const state = {};
  const infos = withInfo(() => {
    for (let deg = 0; deg <= 360; deg += 3) {
      const yaw = (deg * Math.PI) / 180;
      noteCameraRigOrbit(state, { ...orbitRig(yaw), position: { x: 0, y: 1.6, z: 0 } });
    }
  });
  assert.equal(infos.length, 0);
});

test('walking forward or following a moving subject never hints', () => {
  const state = {};
  const infos = withInfo(() => {
    for (let i = 0; i < 200; i++) noteCameraRigOrbit(state, orbitRig(i * 0.02, { target: [i * 0.5, 1, 0] }));
  });
  assert.equal(infos.length, 0);
});

test('display rigs, unconverged camera rigs and garbage are ignored; the rig is not modified', () => {
  const state = {};
  const frozen = Object.freeze({ ...orbitRig(0), position: Object.freeze({ x: 0, y: 1, z: 5 }) });
  const infos = withInfo(() => {
    noteCameraRigOrbit(state, { type: 'display', virtualDisplayHeight: 0.3 });
    noteCameraRigOrbit(state, { ...orbitRig(1), convergenceDiopters: 0 });
    noteCameraRigOrbit(state, null);
    noteCameraRigOrbit(state, frozen);
  });
  assert.equal(infos.length, 0);
});

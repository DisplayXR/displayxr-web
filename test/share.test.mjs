// 3D screen share, the page side (js/call/share.js, runtime ADR-061): recognising a running
// DisplayXR app offered as a `videoinput` — by its label, its `dxr-app:` id, or its track's
// `displayxrStereo.source === 'app'` — listing them, watching the list, and opening one as a
// display-referred side-by-side track. The shipping browser does not expose the hint fields yet,
// so the label / id must be enough and a missing `zeroDisparityShiftFrac` reads as 0.
import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeTrack, FakeStream } from './call-dom.mjs';
import { openTabShare, isTabShareHint } from '../js/call/share.js';
import { isAppShareDevice, isAppShareHint, legacyAppCandidate, appNameFromLabel, listShareableApps, watchShareableApps, openAppShare, describeAppShare, APP_SHARE_ID_PREFIX } from '../js/call/share.js';

const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

test('isAppShareDevice: by label, by dxr-app: id, by the track hint; cameras are not apps', () => {
  assert.equal(APP_SHARE_ID_PREFIX, 'dxr-app:');
  assert.ok(isAppShareDevice({ kind: 'videoinput', label: 'DisplayXR: Model Viewer (3D)', deviceId: 'h4sh' }), 'label');
  assert.ok(isAppShareDevice({ kind: 'videoinput', label: '', deviceId: 'dxr-app:9f2c' }), 'id prefix, no label');
  assert.ok(isAppShareDevice({ displayxrStereo: { layout: 'side-by-side', source: 'app' } }), 'settings hint');
  const track = Object.assign(new FakeTrack('video'), { label: 'something', getSettings: () => ({ displayxrStereo: { source: 'app' } }) });
  assert.ok(isAppShareDevice(track), 'a track: its own hint');
  assert.ok(isAppShareDevice('DisplayXR: Cube (3D)'), 'a label string');
  assert.ok(isAppShareDevice('dxr-app:abc'), 'an id string');
  for (const x of ['3D Camera (DisplayXR)', 'DisplayXR: Cube', 'USB Stereo Camera (3D)', '', null, undefined, 42, { label: 'Integrated Webcam', deviceId: 'dxr-stereo:1' }, { displayxrStereo: { source: 'camera' } }]) {
    assert.equal(isAppShareDevice(x), false, String(x && (x.label ?? JSON.stringify(x))));
  }
  const hostile = { get label() { throw new Error('no'); } };
  assert.equal(isAppShareDevice(hostile), false, 'never throws');
});

test('appNameFromLabel parses the app out of "DisplayXR: <app> (3D)"', () => {
  assert.equal(appNameFromLabel('DisplayXR: Model Viewer (3D)'), 'Model Viewer');
  assert.equal(appNameFromLabel('DisplayXR: a (3D) b (3D)'), 'a (3D) b', 'the last "(3D)" ends it');
  assert.equal(appNameFromLabel('Webcam'), null);
  assert.equal(appNameFromLabel(null), null);
});

function media(devices, { onOpen } = {}) {
  const listeners = new Set();
  return {
    devices,
    opened: [],
    async enumerateDevices() {
      return this.devices;
    },
    async getUserMedia(c) {
      this.opened.push(c);
      return onOpen(c);
    },
    addEventListener(t, f) {
      if (t === 'devicechange') listeners.add(f);
    },
    removeEventListener(t, f) {
      listeners.delete(f);
    },
    fire() {
      for (const f of listeners) f();
    },
    get listeners() {
      return listeners.size;
    },
  };
}

test('listShareableApps: only app-share videoinputs, appName parsed; never rejects', async () => {
  const md = media([
    { kind: 'videoinput', label: 'Integrated Webcam', deviceId: 'cam1' },
    { kind: 'videoinput', label: '3D Camera (DisplayXR)', deviceId: 'dxr-stereo:7' },
    { kind: 'videoinput', label: 'DisplayXR: Model Viewer (3D)', deviceId: 'dxr-app:a1' },
    { kind: 'audioinput', label: 'DisplayXR: Model Viewer (3D)', deviceId: 'dxr-app:mic' },
    { kind: 'videoinput', label: 'DisplayXR: Earth‮View (3D)', deviceId: 'dxr-app:b2' },
  ]);
  const apps = await listShareableApps({ mediaDevices: md });
  assert.deepEqual(apps.map((a) => [a.deviceId, a.appName]), [['dxr-app:a1', 'Model Viewer'], ['dxr-app:b2', 'Earth View']]);
  assert.equal(apps[0].label, 'DisplayXR: Model Viewer (3D)');
  assert.deepEqual(await listShareableApps({ mediaDevices: { enumerateDevices: async () => { throw new Error('x'); } } }), []);
  assert.deepEqual(await listShareableApps({ mediaDevices: {} }), []);
});

test('watchShareableApps: now, then on devicechange only when the list changed; unsubscribe detaches', async () => {
  const md = media([{ kind: 'videoinput', label: 'Webcam', deviceId: 'c' }]);
  const seen = [];
  const off = watchShareableApps((apps) => seen.push(apps.map((a) => a.appName)), { mediaDevices: md });
  await flush();
  assert.deepEqual(seen, [[]]);
  md.fire();
  await flush();
  assert.equal(seen.length, 1, 'no change, no call');
  md.devices = [...md.devices, { kind: 'videoinput', label: 'DisplayXR: Cube (3D)', deviceId: 'dxr-app:1' }];
  md.fire();
  await flush();
  assert.deepEqual(seen.at(-1), ['Cube']);
  off();
  assert.equal(md.listeners, 0);
  md.devices = [];
  md.fire();
  await flush();
  assert.equal(seen.length, 2);
  assert.throws(() => watchShareableApps(null), TypeError);
});

const appTrack = (settings, label = 'DisplayXR: Model Viewer (3D)') => Object.assign(new FakeTrack('video'), { label, getSettings: () => settings });

test('openAppShare: exact deviceId, display-referred descriptor; a missing zeroDisparityShiftFrac is 0', async () => {
  // The shipping browser: label + size, no source/appName/zeroDisparityShiftFrac yet.
  const md = media([], { onOpen: () => new FakeStream([appTrack({ width: 2560, height: 720, deviceId: 'dxr-app:a1', displayxrStereo: { layout: 'side-by-side', rectified: true } })]) });
  const s = await openAppShare('dxr-app:a1', { mediaDevices: md });
  assert.equal(md.opened[0].video.deviceId.exact, 'dxr-app:a1');
  assert.equal(md.opened[0].audio, false);
  assert.deepEqual(md.opened[0].video.width, { ideal: 2560 });
  assert.equal(s.track.contentHint, 'detail');
  assert.deepEqual(s.descriptor, { kind: 'content', format: 'sbs', width: 2560, height: 720, convergence: { known: true, frac: 0 }, appName: 'Model Viewer' });
  // A browser with the full hint: its appName and its frac.
  const md2 = media([], { onOpen: () => new FakeStream([appTrack({ width: 1920, height: 540, displayxrStereo: { layout: 'side-by-side', source: 'app', appName: 'Cube', zeroDisparityShiftFrac: 0.02 } }, 'whatever')]) });
  const s2 = await openAppShare('h4sh', { mediaDevices: md2, width: 1920, height: 540, frameRate: 60 });
  assert.deepEqual(s2.descriptor.convergence, { known: true, frac: 0.02 });
  assert.equal(s2.descriptor.appName, 'Cube');
  assert.deepEqual(md2.opened[0].video.frameRate, { ideal: 60 });
  // Junk frac → 0 is not right either: out of range is clamped, NaN is 0.
  assert.equal(describeAppShare(appTrack({ displayxrStereo: { source: 'app', zeroDisparityShiftFrac: NaN } })).convergence.frac, 0);
  assert.equal(describeAppShare(appTrack({ displayxrStereo: { source: 'app', zeroDisparityShiftFrac: 9 } })).convergence.frac, 0.5);
});

test('openAppShare: Deny at the runtime prompt → share-denied; a camera → not-app-share (closed again)', async () => {
  const denied = media([], { onOpen: () => Promise.reject(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' })) });
  await assert.rejects(openAppShare('dxr-app:a1', { mediaDevices: denied }), (e) => e.code === 'share-denied');
  const failed = media([], { onOpen: () => Promise.reject(Object.assign(new Error('busy'), { name: 'NotReadableError' })) });
  await assert.rejects(openAppShare('dxr-app:a1', { mediaDevices: failed }), (e) => e.code === 'share-failed');
  const cam = Object.assign(new FakeTrack('video'), { label: 'Integrated Webcam', getSettings: () => ({ width: 1280, height: 720 }) });
  const notApp = media([], { onOpen: () => new FakeStream([cam]) });
  await assert.rejects(openAppShare('cam1', { mediaDevices: notApp }), (e) => e.code === 'not-app-share');
  assert.equal(cam.readyState, 'ended', 'the camera it opened by mistake is stopped');
  await assert.rejects(openAppShare('', { mediaDevices: notApp }), (e) => e.code === 'not-app-share');
});

// Browsers WITHOUT the app-share device patch: the app is listed as `3D Camera (DisplayXR) - <app>`,
// and so is the real camera once the runtime lists two sources. No `source` in the hint; an app
// advertises baseline 0 and FOV 0 (runtime ADR-061 decision 2), a real camera never baseline 0.
const APP_HINT = { layout: 'side-by-side', rectified: true, baselineMm: 0, horizontalFovDeg: 0 };
const CAM_HINT = { layout: 'side-by-side', rectified: true, baselineMm: 63, horizontalFovDeg: 60 };

test('isAppShareHint: source app, or side-by-side with baseline AND fov exactly 0; a real camera is not', () => {
  assert.ok(isAppShareHint({ source: 'app' }));
  assert.ok(isAppShareHint(APP_HINT));
  assert.ok(isAppShareHint({ baselineMm: 0, horizontalFovDeg: 0 }), 'layout absent');
  for (const h of [CAM_HINT, { ...APP_HINT, baselineMm: 63 }, { ...APP_HINT, horizontalFovDeg: 60 }, { layout: 'side-by-side' }, { ...APP_HINT, layout: 'top-bottom' }, { ...APP_HINT, source: 'camera' }, null, undefined, 'app', 0]) {
    assert.equal(isAppShareHint(h), false, JSON.stringify(h));
  }
  assert.equal(isAppShareHint({ get source() { throw new Error('no'); } }), false, 'never throws');
  // isAppShareDevice takes the hint on a track or its settings; the legacy LABEL alone is not enough.
  assert.ok(isAppShareDevice({ displayxrStereo: APP_HINT }));
  assert.ok(isAppShareDevice(Object.assign(new FakeTrack('video'), { label: '3D Camera (DisplayXR) - Cube', getSettings: () => ({ displayxrStereo: APP_HINT }) })));
  assert.equal(isAppShareDevice(Object.assign(new FakeTrack('video'), { label: '3D Camera (DisplayXR) - Built-in camera', getSettings: () => ({ displayxrStereo: CAM_HINT }) })), false);
  assert.equal(isAppShareDevice({ kind: 'videoinput', label: '3D Camera (DisplayXR) - Cube', deviceId: 'dxr-stereo:1' }), false);
});

test('legacyAppCandidate: "3D Camera (DisplayXR) - <name>" is a candidate with its name; anything else is not', () => {
  assert.deepEqual(legacyAppCandidate({ label: '3D Camera (DisplayXR) - CubeOpenXRExt' }), { appName: 'CubeOpenXRExt' });
  assert.deepEqual(legacyAppCandidate('3D Camera (DisplayXR)  -  Model Viewer '), { appName: 'Model Viewer' });
  for (const x of ['3D Camera (DisplayXR)', '3D Camera (DisplayXR) - ', 'DisplayXR: Cube (3D)', 'Integrated Webcam', '', null, 7, {}]) {
    assert.equal(legacyAppCandidate(x), null, String(x));
  }
});

test('listShareableApps on a browser without the app-share patch: the suffixed entries as legacy candidates; ADR-form devices win', async () => {
  const legacy = media([
    { kind: 'videoinput', label: 'Integrated Webcam', deviceId: 'cam1' },
    { kind: 'videoinput', label: '3D Camera (DisplayXR) - CubeOpenXRExt', deviceId: 'dxr-stereo:app' },
    { kind: 'videoinput', label: '3D Camera (DisplayXR) - Built-in camera', deviceId: 'dxr-stereo:cam' },
    { kind: 'videoinput', label: '3D Camera (DisplayXR)', deviceId: 'dxr-stereo:solo' },
  ]);
  const apps = await listShareableApps({ mediaDevices: legacy, browserVersion: '1.9.2' });
  assert.deepEqual(apps.map((a) => [a.deviceId, a.appName, a.legacy]), [['dxr-stereo:app', 'CubeOpenXRExt', true], ['dxr-stereo:cam', 'Built-in camera', true]]);
  assert.equal(apps[0].label, '3D Camera (DisplayXR) - CubeOpenXRExt');
  const both = media([...legacy.devices, { kind: 'videoinput', label: 'DisplayXR: Cube (3D)', deviceId: 'dxr-app:c' }]);
  assert.deepEqual((await listShareableApps({ mediaDevices: both, browserVersion: '1.9.2' })).map((a) => [a.deviceId, a.legacy]), [['dxr-app:c', undefined]]);
});

test('listShareableApps on a patched browser (1.9.3+) or an unknown version: no legacy candidates, so two cameras are never listed as apps (#255)', async () => {
  // Two Leia screens, so two SR cameras, no app running: the patched browser labels both cameras in
  // the multi-source legacy form, and there is no ADR-form device to win.
  const twoCameras = media([
    { kind: 'videoinput', label: '3D Camera (DisplayXR) - Leia SR camera - Built-in display', deviceId: 'dxr-stereo:a' },
    { kind: 'videoinput', label: '3D Camera (DisplayXR) - Leia SR camera - DS1_156', deviceId: 'dxr-stereo:b' },
  ]);
  for (const browserVersion of ['1.9.3', '1.10.1', '2.0', null, '0.0.0-dev', undefined]) {
    assert.deepEqual(await listShareableApps({ mediaDevices: twoCameras, browserVersion }), [], String(browserVersion));
  }
  // Older releases still get them as candidates (openAppShare refuses the cameras).
  for (const browserVersion of ['1.9.2', '1.9', '1.0.7']) {
    assert.equal((await listShareableApps({ mediaDevices: twoCameras, browserVersion })).length, 2, browserVersion);
  }
  // With no override the version comes from userAgentData; node has none, so: unknown, no candidates.
  assert.deepEqual(await listShareableApps({ mediaDevices: twoCameras }), []);
});

test('openAppShare on a legacy candidate: a baseline-0 track is the app (name from its label); a suffixed real camera → not-app-share, closed', async () => {
  const app = appTrack({ width: 2560, height: 720, deviceId: 'dxr-stereo:app', displayxrStereo: APP_HINT }, '3D Camera (DisplayXR) - CubeOpenXRExt');
  const s = await openAppShare('dxr-stereo:app', { mediaDevices: media([], { onOpen: () => new FakeStream([app]) }) });
  assert.equal(s.track, app);
  assert.deepEqual(s.descriptor, { kind: 'content', format: 'sbs', width: 2560, height: 720, convergence: { known: true, frac: 0 }, appName: 'CubeOpenXRExt' });
  const cam = appTrack({ width: 2560, height: 720, deviceId: 'dxr-stereo:cam', displayxrStereo: CAM_HINT }, '3D Camera (DisplayXR) - Built-in camera');
  await assert.rejects(openAppShare('dxr-stereo:cam', { mediaDevices: media([], { onOpen: () => new FakeStream([cam]) }) }), (e) => e.code === 'not-app-share');
  assert.equal(cam.readyState, 'ended', 'the camera is stopped again');
  // Even under a dxr-app: id, a track whose hint is a real camera is not an app.
  const odd = appTrack({ width: 2560, height: 720, displayxrStereo: CAM_HINT }, 'whatever');
  await assert.rejects(openAppShare('dxr-app:x', { mediaDevices: media([], { onOpen: () => new FakeStream([odd]) }) }), (e) => e.code === 'not-app-share');
});

function displayMedia(settings, seen = {}) {
  return {
    getDisplayMedia: async (c) => {
      seen.constraints = c;
      const t = new FakeTrack('video');
      t.getSettings = () => settings;
      return new FakeStream([t]);
    },
  };
}
const HALF = { layout: 'side-by-side-half', source: 'tab', rectified: true, zeroDisparityShiftFrac: 0 };

test('isTabShareHint: only a half-width tab capture', () => {
  assert.equal(isTabShareHint(HALF), true);
  assert.equal(isTabShareHint({ layout: 'side-by-side', source: 'tab' }), false);
  assert.equal(isTabShareHint({ layout: 'side-by-side-half', source: 'app' }), false);
  assert.equal(isTabShareHint(undefined), false);
});

test('openTabShare: asks for stereo; a tab comes back true side-by-side at the converted size', async () => {
  const seen = {};
  const conv = new FakeTrack('video');
  let got;
  const unsqueeze = (src, w, h, fps) => {
    got = [w, h, fps];
    return { stream: new FakeStream([conv]), track: conv, width: 2560, height: 600 };
  };
  const r = await openTabShare({ mediaDevices: displayMedia({ width: 2560, height: 1200, frameRate: 30, displayxrStereo: HALF }, seen), unsqueeze });
  assert.equal(seen.constraints.displayxrStereo, true);
  assert.deepEqual(got, [2560, 1200, 30]);
  assert.equal(r.stereo, true);
  assert.equal(r.track, conv);
  assert.deepEqual([r.descriptor.format, r.descriptor.width, r.descriptor.height], ['sbs', 2560, 600]);
  assert.deepEqual(r.descriptor.convergence, { known: true, frac: 0 });
});

test('openTabShare: no hint (a window, a screen, another browser) stays flat', async () => {
  const r = await openTabShare({ mediaDevices: displayMedia({ width: 1920, height: 1080 }), unsqueeze: () => assert.fail('no conversion') });
  assert.equal(r.stereo, false);
  assert.deepEqual([r.descriptor.format, r.descriptor.width, r.descriptor.height], ['mono', 1920, 1080]);
});

test('openTabShare: a stereo frame that cannot be converted is refused and its track stopped', async () => {
  const seen = [];
  const md = {
    getDisplayMedia: async () => {
      const t = new FakeTrack('video');
      t.getSettings = () => ({ width: 2560, height: 1200, displayxrStereo: HALF });
      seen.push(t);
      return new FakeStream([t]);
    },
  };
  await assert.rejects(openTabShare({ mediaDevices: md, unsqueeze: () => null }), (e) => e.code === 'share-failed');
  assert.equal(seen[0].readyState, 'ended');
});

test('openTabShare: cancel is share-denied, other failures and no API are share-failed', async () => {
  const fail = (name) => ({ getDisplayMedia: async () => { throw Object.assign(new Error('x'), { name }); } });
  await assert.rejects(openTabShare({ mediaDevices: fail('NotAllowedError') }), (e) => e.code === 'share-denied');
  await assert.rejects(openTabShare({ mediaDevices: fail('NotReadableError') }), (e) => e.code === 'share-failed');
  await assert.rejects(openTabShare({ mediaDevices: {} }), (e) => e.code === 'share-failed');
});

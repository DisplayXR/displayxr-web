// 3D screen share, the page side (js/call/share.js, runtime ADR-061): recognising a running
// DisplayXR app offered as a `videoinput` — by its label, its `dxr-app:` id, or its track's
// `displayxrStereo.source === 'app'` — listing them, watching the list, and opening one as a
// display-referred side-by-side track. The shipping browser does not expose the hint fields yet,
// so the label / id must be enough and a missing `zeroDisparityShiftFrac` reads as 0.
import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeTrack, FakeStream } from './call-dom.mjs';
import { isAppShareDevice, appNameFromLabel, listShareableApps, watchShareableApps, openAppShare, describeAppShare, APP_SHARE_ID_PREFIX } from '../js/call/share.js';

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

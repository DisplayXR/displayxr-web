// openCamera's device exclusion (`exclude`, + the built-in sensor list) and the "pair by label or
// by its own description, never by list position" rule. Field case (Windows, DisplayXR Browser):
// with no stereo pair open, the last-resort "try every device" loop opened a HAND-TRACKING camera
// (an ordinary videoinput, wide enough to look like a pair) and sent it as the call's 3D picture;
// and the browser's "3D Camera (DisplayXR)" is listed LAST, not first.
import test from 'node:test';
import assert from 'node:assert/strict';

import { installCallDom, FakeTrack, FakeStream } from './call-dom.mjs';
import { cameraExcluder, noCameraCode, CAMERA_EXCLUDE_BUILTIN } from '../js/camera/capture.js';

installCallDom();
const { openCamera } = await import('../js/inline3d-camera.js');

/** A device list (labels hidden until the first getUserMedia unless `granted`), recording every open. */
function media(cams, { granted = false } = {}) {
  let ok = granted;
  const opens = [];
  const stopped = [];
  return {
    opens,
    stopped,
    async getUserMedia({ video }) {
      const id = video.deviceId ? video.deviceId.exact : null;
      const cam = id ? cams.find((c) => c.id === id) : cams[0];
      opens.push(id ? `id:${id}` : 'default');
      ok = true;
      if (cam.busy) throw Object.assign(new Error('in use'), { name: 'NotReadableError' });
      const track = Object.assign(new FakeTrack('video'), {
        label: cam.label,
        getSettings: () => ({ width: cam.w, height: cam.h, deviceId: cam.id, ...(cam.stereo ? { displayxrStereo: cam.stereo } : {}) }),
        stop() {
          this.readyState = 'ended';
          stopped.push(cam.id);
        },
      });
      return new FakeStream([track]);
    },
    async enumerateDevices() {
      return cams.map((c) => ({ kind: 'videoinput', deviceId: ok ? c.id : '', label: ok ? c.label : '' }));
    },
  };
}

const STEREO = { layout: 'side-by-side', rectified: true, baselineMm: 63, horizontalFovDeg: 60 };
const webcam = { id: 'web', label: 'Integrated Webcam', w: 1280, h: 720 };
const hands = { id: 'hands', label: 'Hand Tracking Camera', w: 768, h: 240 }; // 3.2:1 — a "pair" by shape
const pair3d = { id: 'pair', label: '3D Camera (DisplayXR)', w: 2560, h: 720, stereo: STEREO };

test('the built-in list: sensors, generic words only; strings, RegExps and deviceIds; false turns it off', () => {
  const ex = cameraExcluder();
  for (const l of ['Hand Tracking Camera', 'hand-tracking IR', 'Eye Tracker', 'eye-tracking camera', 'IR Tracking Camera', 'Depth Camera']) assert.ok(ex(l, 'x'), l);
  for (const l of ['Integrated Webcam', '3D Camera (DisplayXR)', 'USB Stereo Camera', 'FaceTime HD Camera', '']) assert.ok(!ex(l, 'x'), l);
  assert.ok(CAMERA_EXCLUDE_BUILTIN instanceof RegExp);
  const mine = cameraExcluder(['acme', /^Rear/, 'dev-7']);
  assert.ok(mine('ACME Wide 2560', 'a'));
  assert.ok(mine('Rear camera', 'b'));
  assert.ok(mine('anything', 'dev-7'), 'a string also matches a deviceId exactly');
  assert.ok(mine('Hand Tracking Camera', 'c'), 'the built-in list still applies');
  assert.ok(!mine('Front camera', 'd'));
  const off = cameraExcluder(false);
  assert.ok(!off('Hand Tracking Camera', 'x'));
  const sticky = cameraExcluder([/acme/gi]);
  assert.ok(sticky('acme', 'a') && sticky('acme', 'a'), 'a /g pattern is not stateful across devices');
});

test('noCameraCode ignores excluded devices: the rest all busy is still camera-busy', () => {
  assert.equal(noCameraCode([{ label: 'h', error: 'excluded', excluded: true }, { label: 'w', error: 'NotReadableError', busy: true }]), 'camera-busy');
  assert.equal(noCameraCode([{ label: 'h', error: 'excluded', excluded: true }]), 'no-camera');
});

test('last resort: a hand-tracking camera that looks like a pair is never opened (the field bug); exclude: false shows the old behaviour', async () => {
  const cams = [webcam, hands];
  const md = media(cams, { granted: true });
  const cam = await openCamera({ prefer: 'auto', mediaDevices: md });
  assert.equal(cam.format, 'mono');
  assert.equal(cam.deviceId, 'web');
  assert.ok(!md.opens.includes('id:hands'), `opens: ${md.opens}`);
  assert.deepEqual(cam.skipped.filter((s) => s.excluded).map((s) => [s.label, s.error]), [['Hand Tracking Camera', 'excluded']]);

  const md2 = media(cams, { granted: true });
  const bad = await openCamera({ prefer: 'auto', mediaDevices: md2, exclude: false });
  assert.equal(bad.format, 'sbs', 'without the list the sensor is taken for a pair');
  assert.equal(bad.deviceId, 'hands');
});

test('exclude applies to every probe path: a named pair, the default, and the last resort', async () => {
  // Named-pair fast path: a stereo-labelled device the page excludes is never opened.
  {
    const md = media([webcam, { id: 'acme', label: 'ACME Stereo Rig', w: 2560, h: 720 }], { granted: true });
    const cam = await openCamera({ prefer: 'auto', mediaDevices: md, exclude: ['acme'] });
    assert.equal(cam.deviceId, 'web');
    assert.ok(!md.opens.includes('id:acme'));
  }
  // The default: opened (its label is only known then), excluded, closed, never re-opened; the
  // first plain camera of the last-resort loop becomes the fallback.
  {
    const md = media([hands, webcam], { granted: true });
    const cam = await openCamera({ prefer: 'auto', mediaDevices: md });
    assert.equal(cam.format, 'mono');
    assert.equal(cam.deviceId, 'web');
    assert.deepEqual(md.opens, ['default', 'id:web'], 'the excluded default is opened once, never again');
    assert.deepEqual(md.stopped, ['hands']);
    assert.equal(cam.skipped.filter((s) => s.excluded).length, 1);
  }
  // prefer: 'mono' with an excluded default still finds a plain camera.
  {
    const md = media([hands, webcam], { granted: true });
    const cam = await openCamera({ prefer: 'mono', mediaDevices: md });
    assert.equal(cam.format, 'mono');
    assert.equal(cam.deviceId, 'web');
  }
  // Last resort, the page's own RegExp.
  {
    const md = media([webcam, { id: 'usb', label: 'USB 2.0 Camera', w: 2560, h: 720 }], { granted: true });
    const cam = await openCamera({ prefer: 'stereo', mediaDevices: md, exclude: [/^USB 2\.0/] });
    assert.equal(cam.format, 'mono');
    assert.ok(!md.opens.includes('id:usb'));
  }
  // Nothing left: the error says why, and the code is not confused by the left-out device.
  {
    const md = media([hands], { granted: true });
    await assert.rejects(openCamera({ prefer: 'auto', mediaDevices: md }), (e) => e.code === 'no-camera' && e.skipped.some((s) => s.excluded));
  }
  // An explicit deviceId is the page's choice.
  {
    const md = media([webcam, hands], { granted: true });
    const cam = await openCamera({ prefer: 'hands', mediaDevices: md });
    assert.equal(cam.deviceId, 'hands');
  }
});

test("the runtime's 3D camera is found by label, not position: listed LAST behind a hand tracker (Windows), without permission", async () => {
  const md = media([hands, webcam, pair3d]);
  const cam = await openCamera({ prefer: 'auto', mediaDevices: md });
  assert.equal(cam.format, 'sbs');
  assert.equal(cam.deviceId, 'pair');
  assert.deepEqual(md.opens, ['default', 'id:pair']);
  assert.ok(md.stopped.includes('hands'));
  // Even with the list off, a default that is a pair only by SHAPE loses to a named pair.
  const md2 = media([hands, webcam, pair3d]);
  const cam2 = await openCamera({ prefer: 'auto', mediaDevices: md2, exclude: false });
  assert.equal(cam2.deviceId, 'pair');
  // With labels visible the fast path opens it directly, wherever it is listed.
  const md3 = media([webcam, hands, pair3d], { granted: true });
  const cam3 = await openCamera({ prefer: 'auto', mediaDevices: md3 });
  assert.equal(cam3.deviceId, 'pair');
  assert.deepEqual(md3.opens, ['id:pair']);
});

test('a default that declares itself the pair (displayxrStereo) is kept at once; a shape-only default is kept when no named pair exists', async () => {
  const md = media([pair3d, webcam]);
  assert.equal((await openCamera({ prefer: 'auto', mediaDevices: md })).deviceId, 'pair');
  assert.deepEqual(md.opens, ['default']);
  const usb = { id: 'usb', label: 'USB Camera', w: 1280, h: 480 };
  const md2 = media([usb, webcam]);
  const cam = await openCamera({ prefer: 'auto', mediaDevices: md2 });
  assert.equal(cam.format, 'sbs');
  assert.equal(cam.deviceId, 'usb');
  assert.deepEqual(md2.opens, ['default']);
});

// ── addCameraView: aspect 'fill' and rectCover (the call's headless hooks use both) ───────────

test("addCameraView: rectCover reaches the wall's addImage only when given; aspect 'fill' follows the canvas box", async () => {
  const { doc } = await import('./call-dom.mjs');
  const { addCameraView } = await import('../js/inline3d-camera.js');
  const calls = [];
  const wall = { supported: true, addImage: (canvas, src, opts) => (calls.push({ src, opts }), { remove() {}, firstWoven: new Promise(() => {}) }) };
  const cam = await openCamera({ prefer: new FakeStream([Object.assign(new FakeTrack('video'), { getSettings: () => ({ width: 1280, height: 480 }) })]), format: 'sbs' });
  Object.assign(cam.video, { readyState: 4, videoWidth: 1280, videoHeight: 480 });
  const plain = addCameraView(wall, doc.createElement('canvas'), cam, { _loop: false });
  assert.equal(calls.at(-1).opts, undefined, 'no option: the core default, exactly as before');
  plain.remove();
  const canvas = doc.createElement('canvas');
  Object.assign(canvas, { clientWidth: 300, clientHeight: 400 });
  const view = addCameraView(wall, canvas, cam, { _loop: false, rectCover: 'auto', aspect: 'fill' });
  assert.deepEqual(calls.at(-1).opts, { rectCover: 'auto' });
  view.paint();
  const buf = calls.at(-1).src;
  assert.ok(Math.abs(buf.width / 2 / buf.height - 0.75) < 0.02, `per-eye ${buf.width / 2}x${buf.height} = the box's 3:4`);
  Object.assign(canvas, { clientWidth: 800, clientHeight: 200 });
  view.paint();
  assert.ok(Math.abs(buf.width / 2 / buf.height - 4) < 0.05, 'a 4:1 box, clamped at 4');
  Object.assign(canvas, { clientWidth: 0, clientHeight: 0 });
  view.paint();
  assert.ok(Math.abs(buf.width / 2 / buf.height - 4) < 0.05, 'a box with no size keeps the last aspect');
  view.remove();
  const num = addCameraView(wall, doc.createElement('canvas'), cam, { _loop: false, aspect: 4 / 3 });
  num.paint();
  const b2 = calls.at(-1).src;
  assert.ok(Math.abs(b2.width / 2 / b2.height - 4 / 3) < 0.02, 'a number is unchanged');
  num.remove();
});

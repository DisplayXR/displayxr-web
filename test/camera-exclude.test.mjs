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
  // The default: with labels visible and a sensor listed it is not opened blind — the first plain
  // camera is opened by id and the sensor is never started.
  {
    const md = media([hands, webcam], { granted: true });
    const cam = await openCamera({ prefer: 'auto', mediaDevices: md });
    assert.equal(cam.format, 'mono');
    assert.equal(cam.deviceId, 'web');
    assert.deepEqual(md.opens, ['id:web'], 'the sensor default is never opened');
    assert.deepEqual(md.stopped, []);
    assert.equal(cam.skipped.filter((s) => s.excluded).length, 1);
  }
  // Labels hidden: the default is primed blind (its label is only known then), excluded, closed,
  // never re-opened; the first plain camera of the last-resort loop becomes the fallback.
  {
    const md = media([hands, webcam]);
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

// ── the bare-brand hand tracker, and the default not opened blind ─────────────────────────────
// Field case (win box, 2026-11-04): the Ultraleap enumerates as a UVC "Ultraleap" — no "hand
// tracking" in the label — with modes of 2:1 or squarer (never a pair by shape). With its tracking
// service stopped it was free, listed first, and became the call's self view as the DEFAULT camera.

const leap = { id: 'leap', label: 'Ultraleap', w: 512, h: 256 };
const srcam = { id: 'sr', label: 'SpatialLabs Tracking Camera', w: 1280, h: 480, busy: true };

test('the built-in list names the Ultraleap by its bare brand, Leap Motion, infrared / IR cameras', () => {
  const ex = cameraExcluder();
  for (const l of ['Ultraleap', 'Ultraleap Stereo IR 170', 'Leap Motion Controller', 'Infrared Camera', 'IR Camera', 'SpatialLabs Tracking Camera']) assert.ok(ex(l, 'x'), l);
  for (const l of ['HD WebCam', 'Logitech BRIO', 'camera 0, facing front', 'Tracker stereo']) assert.ok(!ex(l, 'x'), l);
});

test('labels visible, a sensor listed: the default is not opened blind — the first camera for people is opened by id', async () => {
  const md = media([leap, webcam], { granted: true });
  const cam = await openCamera({ prefer: 'auto', mediaDevices: md });
  assert.equal(cam.format, 'mono');
  assert.equal(cam.deviceId, 'web');
  assert.deepEqual(md.opens, ['id:web'], 'the Ultraleap is never started');
  assert.deepEqual(md.stopped, []);
  assert.deepEqual(cam.skipped.filter((s) => s.excluded).map((s) => s.label), ['Ultraleap']);
  // 'mono' takes the same by-id route.
  const md2 = media([leap, webcam], { granted: true });
  assert.equal((await openCamera({ prefer: 'mono', mediaDevices: md2 })).deviceId, 'web');
  assert.deepEqual(md2.opens, ['id:web']);
  // Without labels the prime is blind: it lands on the Ultraleap, which is closed for the webcam.
  const md3 = media([leap, webcam]);
  const cam3 = await openCamera({ prefer: 'auto', mediaDevices: md3 });
  assert.equal(cam3.deviceId, 'web');
  assert.deepEqual(md3.opens, ['default', 'id:web']);
  assert.deepEqual(md3.stopped, ['leap']);
  // A sensor that names itself stereo ("Stereo IR 170") is not a pair for people either.
  const md4 = media([{ id: 'leap', label: 'Ultraleap Stereo IR 170', w: 2560, h: 720 }, webcam], { granted: true });
  const cam4 = await openCamera({ prefer: 'stereo', mediaDevices: md4 });
  assert.equal(cam4.format, 'mono');
  assert.deepEqual(md4.opens, ['id:web']);
});

test("the eye tracker's camera (busy or not) is never started; a sensor plus a busy webcam is camera-busy", async () => {
  const md = media([srcam, leap, webcam], { granted: true });
  const cam = await openCamera({ prefer: 'auto', mediaDevices: md });
  assert.equal(cam.deviceId, 'web');
  assert.deepEqual(md.opens, ['id:web']);
  const busy = media([leap, { ...webcam, busy: true }], { granted: true });
  await assert.rejects(openCamera({ prefer: 'auto', mediaDevices: busy }), (e) => e.code === 'camera-busy' && e.skipped.some((s) => s.excluded) && e.skipped.some((s) => s.busy));
  assert.deepEqual(busy.opens, ['id:web']);
});

test("prefer 'label:<text>': the first camera whose label contains the text; explicit, so it opens a sensor too", async () => {
  const md = media([leap, webcam], { granted: true });
  const cam = await openCamera({ prefer: 'label:integrated webcam', mediaDevices: md });
  assert.equal(cam.deviceId, 'web');
  assert.ok(md.opens.length && md.opens.every((o) => o === 'id:web'), 'resolved to the id, then opened by id');
  const cold = media([leap, webcam]);
  const cam2 = await openCamera({ prefer: 'label:WebCam', mediaDevices: cold });
  assert.equal(cam2.deviceId, 'web');
  assert.equal(cold.opens[0], 'default', 'labels were hidden: the default is primed once and let go');
  assert.deepEqual(cold.stopped.slice(0, 1), ['leap']);
  const md3 = media([leap, webcam], { granted: true });
  assert.equal((await openCamera({ prefer: 'label:ultra', mediaDevices: md3 })).label, 'Ultraleap');
  await assert.rejects(openCamera({ prefer: 'label:nothing like it', mediaDevices: md }), (e) => e.code === 'no-camera' && /no camera labelled/.test(e.message));
  await assert.rejects(openCamera({ prefer: 'label:', mediaDevices: md }), (e) => e.code === 'no-camera');
});

// ── 3D screen share: a running app is never a camera (runtime ADR-061) ───────────────────────
// The DisplayXR Browser lists each shareable app as a side-by-side `videoinput` labelled
// "DisplayXR: <app> (3D)" (id `dxr-app:…`). It is a pair AND its label says "3D", so stereoLabelHint
// alone would prefer it over a real stereo camera: no probe path may open it, `exclude: false`
// included. The shipping browser lacks the track hint, so the label / id must be enough.

const appShare = { id: 'dxr-app:mv', label: 'DisplayXR: Model Viewer (3D)', w: 2560, h: 720, stereo: { layout: 'side-by-side', rectified: true, source: 'app' } };
const appShareNoLabelHint = { id: 'dxr-app:cube', label: 'DisplayXR: Cube (3D)', w: 2560, h: 720, stereo: { layout: 'side-by-side', rectified: true } };

test('app share: stereoLabelHint never prefers it; cameraExcluder always leaves it out (exclude: false too)', async () => {
  const { stereoLabelHint } = await import('../js/camera/capture.js');
  assert.equal(stereoLabelHint('DisplayXR: Model Viewer (3D)'), false);
  assert.equal(stereoLabelHint('3D Camera (DisplayXR)'), true, 'the runtime camera still is');
  for (const ex of [cameraExcluder(), cameraExcluder(['acme']), cameraExcluder(false)]) {
    assert.ok(ex('DisplayXR: Model Viewer (3D)', 'h'), 'by label');
    assert.ok(ex('', 'dxr-app:mv'), 'by id');
    assert.ok(!ex('3D Camera (DisplayXR)', 'dxr-stereo:1'));
  }
});

test('app share: excluded from every probe path — named pair, default (blind and by id), last resort, mono, label:', async () => {
  const appSkips = (cam) => cam.skipped.filter((s) => s.reason === 'app-share').map((s) => s.label);
  // Labels visible, listed FIRST: the named-pair fast path takes the camera, never the app.
  {
    const md = media([appShare, webcam, pair3d], { granted: true });
    const cam = await openCamera({ prefer: 'auto', mediaDevices: md });
    assert.equal(cam.deviceId, 'pair');
    assert.deepEqual(md.opens, ['id:pair']);
  }
  // No stereo camera: the app is not the "pair" either — the webcam, by id (the default is not opened blind).
  {
    const md = media([appShare, webcam], { granted: true });
    const cam = await openCamera({ prefer: 'stereo', mediaDevices: md });
    assert.equal(cam.format, 'mono');
    assert.equal(cam.deviceId, 'web');
    assert.ok(!md.opens.includes('id:dxr-app:mv'), `opens: ${md.opens}`);
    assert.deepEqual(appSkips(cam), ['DisplayXR: Model Viewer (3D)']);
    const s = cam.skipped.find((x) => x.reason === 'app-share');
    assert.equal(s.excluded, true);
    assert.equal(s.error, 'excluded');
  }
  // exclude: false does not let it back in.
  {
    const md = media([webcam, appShare], { granted: true });
    const cam = await openCamera({ prefer: 'auto', mediaDevices: md, exclude: false });
    assert.equal(cam.deviceId, 'web');
    assert.ok(!md.opens.includes('id:dxr-app:mv'));
  }
  // The DEFAULT opened blind (no labels yet) turns out to be the app (its track hint): closed, never kept.
  {
    const md = media([{ ...appShare, label: 'unlabelled' }, webcam]);
    const cam = await openCamera({ prefer: 'auto', mediaDevices: md });
    assert.equal(cam.deviceId, 'web');
    assert.deepEqual(md.stopped.slice(0, 1), ['dxr-app:mv']);
    assert.equal(appSkips(cam).length, 1);
  }
  // A shipping-browser app (no source hint) as the blind default: its id / label give it away.
  {
    const md = media([appShareNoLabelHint, webcam]);
    const cam = await openCamera({ prefer: 'auto', mediaDevices: md });
    assert.equal(cam.deviceId, 'web');
    assert.ok(md.stopped.includes('dxr-app:cube'));
  }
  // 'mono' and the last resort.
  {
    const md = media([appShare, webcam], { granted: true });
    assert.equal((await openCamera({ prefer: 'mono', mediaDevices: md })).deviceId, 'web');
    assert.ok(!md.opens.includes('id:dxr-app:mv'));
  }
  {
    const md = media([appShare], { granted: true });
    await assert.rejects(openCamera({ prefer: 'auto', mediaDevices: md }), (e) => e.code === 'no-camera' && e.skipped.some((s) => s.reason === 'app-share'));
    assert.ok(!md.opens.includes('id:dxr-app:mv'));
  }
  // label: is a camera search — `label:3d` finds the runtime camera, not the app.
  {
    const md = media([appShare, pair3d], { granted: true });
    assert.equal((await openCamera({ prefer: 'label:3d', mediaDevices: md })).deviceId, 'pair');
  }
  // An explicit deviceId is the page's choice (openAppShare is the API for it, but it is not refused).
  {
    const md = media([webcam, appShare], { granted: true });
    assert.equal((await openCamera({ prefer: 'dxr-app:mv', mediaDevices: md })).deviceId, 'dxr-app:mv');
  }
});

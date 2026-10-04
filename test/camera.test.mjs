// @displayxr/inline3d/camera (RFC 0003 §4, C2): the pure parts and the StereoCamera / CameraView
// contracts under `node --test`. What is pinned:
//   - the self-view mirror is mirror-EACH-HALF-AND-SWAP: with a synthetic L/R pair whose subject
//     sits in FRONT of the screen (crossed disparity), the output keeps it crossed, and the view
//     the LEFT eye should see (the mirrored right camera) ends up on the left; the naive per-half
//     mirror inverts it (pseudoscopic);
//   - the stereo record round-trips through the file bytes (XMP in a JPEG, Tags in a WebM);
//   - suggestedName carries the `_2x1` layout suffix for a pair, nothing for mono;
//   - openCamera's error codes and the StereoCamera lifecycle (`ended` once, `close()` silent);
//   - addCameraView's routes on a 2D / 3D wall and its wall-lost path.
// The pixel path (a real canvas) is test/e2e/camera.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installCallDom, doc, FakeTrack, FakeStream } from './call-dom.mjs';
import { mirrorSwapOps, mirrorSwapPixels, eyeCropRect, looksSbs } from '../js/camera/geometry.js';
import { buildStereoXmp, parseStereoXmp, jpegWithXmp, readJpegXmp, readJpegStereoMeta, webmWithTags, readWebmTags, readWebmStereoMeta, stereoTagEntries, buildWebmTags, normalizeStereoMeta } from '../js/camera/metadata.js';
import { noCameraCode, isDeniedError, isBusyError } from '../js/camera/capture.js';

installCallDom();
const { openCamera, addCameraView, isStereoCamera, suggestedName, CAMERA_SDK, readJpegStereoMeta: fromEntry } = await import('../js/inline3d-camera.js');

// ── the mirroring trap ─────────────────────────────────────────────────────────────────────

/** A W×H single-channel SBS frame with one bright marker per eye; `lx`/`rx` are per-eye x positions. */
function pair(W, H, lx, rx) {
  const px = new Uint8Array(W * H);
  const half = W / 2;
  for (let y = 0; y < H; y++) {
    px[y * W + lx] = 200; // left eye's marker
    px[y * W + half + rx] = 200; // right eye's marker
  }
  return px;
}
const markerX = (px, W, half, y = 0) => {
  let l = -1;
  let r = -1;
  for (let x = 0; x < half; x++) if (px[y * W + x] === 200) l = x;
  for (let x = 0; x < half; x++) if (px[y * W + half + x] === 200) r = x;
  return { l, r };
};

test('mirror-and-swap keeps a crossed disparity crossed; the naive per-half mirror inverts it', () => {
  const W = 16;
  const H = 2;
  const half = 8;
  // Subject IN FRONT of the screen: the left eye sees it further right than the right eye does.
  const src = pair(W, H, 5, 3);
  assert.equal(markerX(src, W, half).l - markerX(src, W, half).r, 2, 'source disparity (left x − right x) is +2: crossed');
  const out = mirrorSwapPixels(src, W, H);
  const o = markerX(out, W, half);
  assert.equal(o.l - o.r, 2, 'after mirror+swap the disparity is still +2 — the face stays in front, not inside out');
  // The output's LEFT half is the mirrored RIGHT camera (what the left eye should see in a mirror).
  assert.equal(o.l, half - 1 - 3, 'left half = mirrored right eye');
  assert.equal(o.r, half - 1 - 5, 'right half = mirrored left eye');
  // The naive mirror (each half flipped in place, no swap) — the bug this guards against.
  const naive = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (const off of [0, half]) for (let x = 0; x < half; x++) naive[y * W + off + x] = src[y * W + off + (half - 1 - x)];
  const n = markerX(naive, W, half);
  assert.equal(n.l - n.r, -2, 'naive per-half mirror: disparity inverted (pseudoscopic)');
  // And the ops themselves: right source → left half, left source → right half, both mirrored.
  const ops = mirrorSwapOps(W, H);
  assert.deepEqual(ops.map((op) => [op.src, op.sx, op.dx, op.mirror]), [['R', half, 0, true], ['L', 0, half, true]]);
  // Mirror+swap equals a whole-frame flip (the pixels are the same; the ops just spell the intent).
  const flipped = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) flipped[y * W + x] = src[y * W + (W - 1 - x)];
  assert.deepEqual([...out], [...flipped]);
});

test('geometry: looksSbs and eyeCropRect', () => {
  assert.equal(looksSbs(1280, 480), true);
  assert.equal(looksSbs(1280, 720), false);
  const r = eyeCropRect(640, 480, 16 / 9, 0, 0);
  assert.equal(r.sw, 640);
  assert.equal(Math.round(r.sh), 360);
  assert.equal(r.sy, 60);
});

// ── the stereo record in the file ──────────────────────────────────────────────────────────

const META = { layout: 'sbs', convergencePx: 12.3456, baselineMm: 63, horizontalFovDeg: 70, rectified: true, eyeWidth: 1280, eyeHeight: 720, software: 'x "y" <z> & w' };
// SOI + APP0 (JFIF) + a DQT stub + SOS + EOI: enough JPEG to carry an APP1.
const tinyJpeg = () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xdb, 0, 4, 0, 1, 0xff, 0xda, 0, 2, 1, 2, 3, 0xff, 0xd9]);

test('XMP: the stereo record round-trips through a JPEG, is inserted after JFIF, replaced on rewrite, and absent reads null', () => {
  const xmp = buildStereoXmp(META);
  assert.match(xmp, /^<\?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"\?>/);
  assert.ok(xmp.includes('xmlns:dxr="http://displayxr.org/ns/stereo/1.0/"'));
  const jpeg = tinyJpeg();
  const out = jpegWithXmp(jpeg, xmp);
  assert.equal(readJpegXmp(out), xmp);
  // Inserted right after the APP0 segment (byte 20), before the DQT.
  assert.deepEqual([...out.slice(20, 22)], [0xff, 0xe1]);
  assert.deepEqual(readJpegStereoMeta(out), { layout: 'sbs', columns: 2, rows: 1, convergencePx: 12.346, baselineMm: 63, horizontalFovDeg: 70, rectified: true, eyeWidth: 1280, eyeHeight: 720, software: 'x "y" <z> & w' });
  assert.equal(fromEntry, readJpegStereoMeta, 'the reader is public on the entry');
  const again = jpegWithXmp(out, buildStereoXmp({ layout: 'mono' }));
  assert.equal(readJpegStereoMeta(again).layout, 'mono', 'a second write replaces, never appends');
  assert.equal(readJpegStereoMeta(again).columns, 1);
  assert.equal(readJpegXmp(jpeg), null);
  assert.equal(readJpegStereoMeta(jpeg), null);
  assert.equal(parseStereoXmp('<x:xmpmeta/>'), null, 'an XMP without our namespace is not a stereo record');
  assert.throws(() => jpegWithXmp(new Uint8Array([1, 2, 3, 4, 5]), xmp), /not a JPEG/);
  // Unknown fields are null, not NaN; a mono record carries no convergence.
  assert.deepEqual(normalizeStereoMeta({ layout: 'mono', convergencePx: NaN }), { layout: 'mono', columns: 1, rows: 1, convergencePx: null, baselineMm: null, horizontalFovDeg: null, rectified: null, eyeWidth: null, eyeHeight: null, software: null });
});

// EBML header + Segment(unknown size) + Cluster(unknown size) + Timecode + a SimpleBlock stub.
const liveWebm = () => new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x84, 0x42, 0x86, 0x81, 0x01, 0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x1f, 0x43, 0xb6, 0x75, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xe7, 0x81, 0x00, 0xa3, 0x82, 0x12, 0x54]);
// EBML header + Segment(known size, 1-byte vint) + Timecode.
const sizedWebm = () => new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x84, 0x42, 0x86, 0x81, 0x01, 0x18, 0x53, 0x80, 0x67, 0x83, 0xe7, 0x81, 0x00]);

test('WebM: the stereo record round-trips as DXR_* tags, on a live (unknown-size) and a sized Segment', () => {
  const entries = stereoTagEntries(META);
  assert.equal(entries.DXR_LAYOUT, 'side-by-side');
  assert.equal(entries.DXR_CONVERGENCE_PX, '12.346');
  const live = webmWithTags(liveWebm(), entries);
  assert.equal(live.length, liveWebm().length + buildWebmTags(entries).length, 'an unknown-size Segment just grows');
  assert.deepEqual(readWebmStereoMeta(live), readJpegStereoMeta(jpegWithXmp(tinyJpeg(), buildStereoXmp(META))), 'the same record either way');
  assert.equal(readWebmTags(liveWebm()), null);
  const sized = webmWithTags(sizedWebm(), { DXR_LAYOUT: 'mono', DXR_ROWS: '1', DXR_COLUMNS: '1' });
  assert.equal(sized[13], 0x80 | (3 + buildWebmTags({ DXR_LAYOUT: 'mono', DXR_ROWS: '1', DXR_COLUMNS: '1' }).length), 'the known size is patched in place');
  assert.equal(readWebmStereoMeta(sized).layout, 'mono');
  assert.deepEqual(readWebmTags(sized), { DXR_LAYOUT: 'mono', DXR_ROWS: '1', DXR_COLUMNS: '1' });
  assert.throws(() => webmWithTags(new Uint8Array([0, 1, 2, 3, 4, 5]), entries), /not a WebM/);
  assert.equal(readWebmStereoMeta(new Uint8Array([0, 1, 2, 3, 4, 5])), null);
});

test('suggestedName: `_2x1` for a pair, nothing for mono; the extension from the MIME type; a safe base', () => {
  assert.equal(suggestedName('photo-20260101-120000', 'sbs', 'image/jpeg'), 'photo-20260101-120000_2x1.jpg');
  assert.equal(suggestedName('photo', 'mono', 'image/png'), 'photo.png');
  assert.equal(suggestedName('clip', 'sbs', 'video/webm;codecs=vp9'), 'clip_2x1.webm');
  assert.equal(suggestedName('clip', 'sbs', 'video/mp4'), 'clip_2x1.mp4');
  assert.equal(suggestedName('my selfie / 1', 'sbs', 'image/webp'), 'my-selfie-1_2x1.webp');
  assert.equal(suggestedName('', 'mono', 'application/x'), 'capture.bin');
  assert.equal(CAMERA_SDK, 'inline3d-camera/1');
});

// ── openCamera: codes and the StereoCamera contract ───────────────────────────────────────

function fakeMedia(behaviour) {
  return {
    async getUserMedia({ video }) {
      const id = video && video.deviceId ? video.deviceId.exact : undefined;
      const r = behaviour(id);
      if (r instanceof Error) throw r;
      const track = Object.assign(new FakeTrack('video'), { label: id || 'default', getSettings: () => ({ width: r.w, height: r.h, deviceId: id || 'cam0', ...(r.stereo ? { displayxrStereo: r.stereo } : {}) }) });
      return new FakeStream([track]);
    },
    async enumerateDevices() {
      return [{ kind: 'videoinput', deviceId: 'cam0', label: 'Built-in' }, { kind: 'videoinput', deviceId: 'cam1', label: 'Tracker stereo' }];
    },
  };
}
const err = (name) => Object.assign(new Error(name), { name });

test('openCamera: every device busy → camera-busy; a refused prompt → permission-denied; nothing → no-camera', async () => {
  await assert.rejects(openCamera({ prefer: 'auto', mediaDevices: fakeMedia(() => err('NotReadableError')) }), (e) => e.code === 'camera-busy' && e.skipped.length > 0 && e.skipped.every((s) => s.busy));
  await assert.rejects(openCamera({ prefer: 'auto', mediaDevices: fakeMedia(() => err('NotAllowedError')) }), (e) => e.code === 'permission-denied' && e.skipped.every((s) => s.denied));
  await assert.rejects(openCamera({ prefer: 'mono', mediaDevices: fakeMedia(() => err('OverconstrainedError')) }), (e) => e.code === 'no-camera');
  await assert.rejects(openCamera({ prefer: 'auto', mediaDevices: null }), (e) => e.code === 'no-camera');
  assert.equal(noCameraCode([{ busy: true }, { busy: true }]), 'camera-busy');
  assert.equal(noCameraCode([{ busy: true }, { denied: true }]), 'permission-denied');
  assert.equal(noCameraCode([{ busy: false }]), 'no-camera');
  assert.equal(isDeniedError(err('SecurityError')), true);
  assert.equal(isBusyError(err('TrackStartError')), true);
});

test('openCamera: a stereo device (displayxrStereo) → format sbs + stereo info; the public spellings; `prefer` shorthand', async () => {
  const stereo = { layout: 'side-by-side', rectified: true, baselineMm: 120, horizontalFovDeg: 64 };
  const cam = await openCamera({ prefer: 'stereo', mediaDevices: fakeMedia((id) => (id === 'cam1' ? { w: 2560, h: 720, stereo } : { w: 1280, h: 720 })) });
  assert.equal(cam.format, 'sbs');
  assert.equal(cam.width, 2560);
  assert.equal(cam.eyeWidth, 1280);
  assert.deepEqual(cam.stereo, { rectified: true, baselineMm: 120, horizontalFovDeg: 64 });
  assert.equal(cam.owned, true);
  assert.equal(cam.state, 'live');
  assert.equal(isStereoCamera(cam), true);
  assert.equal(isStereoCamera({ stream: {} }), false);
  const mono = await openCamera('mono', { mediaDevices: fakeMedia(() => ({ w: 1280, h: 720 })) }).catch(() => null);
  // `openCamera('mono')` is the shorthand: the second argument is not an options bag.
  assert.equal(mono, null, 'shorthand takes no second argument (no mediaDevices → rejects)');
  const mono2 = await openCamera({ prefer: 'mono', mediaDevices: fakeMedia(() => ({ w: 1280, h: 720 })) });
  assert.equal(mono2.format, 'mono');
  assert.equal(mono2.stereo, null);
  assert.equal(mono2.eyeWidth, 1280);
});

test('openCamera: a page-supplied MediaStream declares its format; calibration uses the public `horizontalFovDeg`', async () => {
  const stream = new FakeStream([Object.assign(new FakeTrack('video'), { getSettings: () => ({ width: 1280, height: 480 }) })]);
  const cam = await openCamera({ prefer: stream, format: 'sbs', calibration: { baselineMm: 63, horizontalFovDeg: 70 } });
  assert.equal(cam.format, 'sbs');
  assert.equal(cam.owned, false, 'never stops a stream it did not open');
  assert.deepEqual(cam.stereo, { rectified: false, baselineMm: 63, horizontalFovDeg: 70 });
  assert.deepEqual(cam.calibration, { baselineMm: 63, hfovDeg: 70 }, 'the hello-shaped calibration the call reads');
  const guessed = await openCamera({ prefer: stream });
  assert.equal(guessed.format, 'mono', '3D-ness is never guessed from a stream');
  // Shorthand: the stream itself.
  assert.equal((await openCamera(stream)).format, 'mono');
});

test("StereoCamera: 'ended' fires once when a track ends under us; close() is silent, idempotent, and stops only owned tracks", async () => {
  const track = Object.assign(new FakeTrack('video'), { getSettings: () => ({ width: 1280, height: 480 }), listeners: {}, addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }, removeEventListener(t, f) { this.listeners[t] = (this.listeners[t] || []).filter((x) => x !== f); } });
  const stream = new FakeStream([track]);
  const cam = await openCamera({ prefer: stream, format: 'sbs' });
  const ended = [];
  const off = cam.on('ended', (e) => ended.push(e.reason));
  for (const f of track.listeners.ended) f();
  for (const f of track.listeners.ended) f();
  assert.deepEqual(ended, ['ended']);
  assert.equal(cam.state, 'ended');
  off();
  cam.close();
  cam.close();
  assert.equal(cam.state, 'closed');
  assert.equal(track.readyState, 'live', 'a page-supplied track is not stopped');
  assert.deepEqual(ended, ['ended'], 'close() fires no ended');
  const owned = await openCamera({ prefer: 'mono', mediaDevices: fakeMedia(() => ({ w: 640, h: 480 })) });
  const t = owned.stream.getVideoTracks()[0];
  owned.close();
  assert.equal(t.readyState, 'ended', 'an owned track is stopped');
  await assert.rejects(owned.capturePhoto(), (e) => e.code === 'closed');
  assert.throws(() => owned.record(), (e) => e.code === 'closed');
});

test('openCamera: the rectify hook replaces a raw pair and marks it rectified; a throwing hook keeps the raw pair', async () => {
  const md = fakeMedia((id) => (id === 'cam1' ? { w: 1280, h: 480 } : { w: 1280, h: 720 }));
  const rectified = new FakeStream([Object.assign(new FakeTrack('video'), { getSettings: () => ({ width: 1280, height: 480 }) })]);
  const cam = await openCamera({ prefer: 'stereo', mediaDevices: md, rectify: async (s, info) => (info.width === 1280 ? rectified : s) });
  assert.equal(cam.stream, rectified);
  assert.equal(cam.stereo.rectified, true);
  const raw = await openCamera({ prefer: 'stereo', mediaDevices: md, rectify: () => { throw new Error('no calibration'); } });
  assert.equal(raw.stereo.rectified, false);
  assert.match(raw.rectifyError.message, /no calibration/);
  const mono = await openCamera({ prefer: 'mono', mediaDevices: md, rectify: () => { throw new Error('never called'); } });
  assert.equal(mono.rectifyError, undefined, 'a mono camera never goes through rectify');
});

// ── addCameraView: routes ─────────────────────────────────────────────────────────────────

const sbsCam = () => openCamera({ prefer: new FakeStream([Object.assign(new FakeTrack('video'), { getSettings: () => ({ width: 1280, height: 480 }) })]), format: 'sbs' });

test('addCameraView: a pair on a 3D wall is woven (addImage) and mirrored; on a 2D wall it is the left eye; mono is flat', async () => {
  const added = [];
  const wall = { supported: true, addImage: (canvas, src) => { const h = { canvas, src, removed: 0, remove() { this.removed++; } }; added.push(h); return h; } };
  const cam = await sbsCam();
  const canvas = doc.createElement('canvas');
  const view = addCameraView(wall, canvas, cam);
  assert.equal(view.route, 'woven-sbs');
  assert.equal(view.woven, true);
  assert.equal(view.mirror, true);
  assert.equal(added.length, 1);
  assert.equal(added[0].canvas, canvas, 'the tile canvas is the one on the wall');
  assert.notEqual(added[0].src, canvas, 'painted from an intermediate SBS buffer the view owns');
  assert.equal(view.handle, added[0]);
  assert.equal(view.setDepth(3), 1, 'depth clamps to [-1, 1]');
  assert.equal(view.setDepth(null), 0);
  assert.equal(view.setMirror(), false);
  assert.equal(view.setMirror(true), true);
  assert.equal(view.setAutoConverge(true), true);
  assert.equal(view.disparityPx, null);
  view._onWallLost();
  assert.equal(view.route, 'flat-left', 'wall lost → the left eye, flat');
  assert.equal(added[0].removed, 1);
  view._reroute(true, wall);
  assert.equal(view.route, 'woven-sbs');
  assert.equal(added.length, 2, 're-registered on the wall');
  view.remove();
  assert.equal(added[1].removed, 1);
  assert.equal(view.route, 'woven-sbs', 'route is a record of the last registration');
  view.remove(); // idempotent
  assert.equal(added[1].removed, 1);
  const flat = addCameraView({ supported: false }, doc.createElement('canvas'), cam);
  assert.equal(flat.route, 'flat-left');
  assert.equal(flat.handle, null);
  flat.remove();
  const mono = await openCamera({ prefer: new FakeStream([new FakeTrack('video')]) });
  const m = addCameraView(wall, doc.createElement('canvas'), mono);
  assert.equal(m.route, 'flat', 'mono is never woven');
  assert.equal(added.length, 2);
  m.remove();
  // close() removes every view of the camera.
  const v2 = addCameraView(wall, doc.createElement('canvas'), cam);
  cam.close();
  assert.equal(v2.removed, true);
  assert.equal(added.at(-1).removed, 1);
  assert.throws(() => addCameraView(wall, null, cam), /needs a canvas/);
  assert.throws(() => addCameraView(wall, doc.createElement('canvas'), {}), /StereoCamera/);
});

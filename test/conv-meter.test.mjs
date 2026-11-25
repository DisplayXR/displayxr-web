// camera/conv-meter.js: the frame grab (WebCodecs Y plane, else a canvas) and the measuring loop a
// call's sender runs on its own raw frames (and a receiver runs as the fallback). Synthetic pairs
// with KNOWN disparities (test/sbs-fixtures.mjs); the grab is injected or driven through a fake
// `VideoFrame` / canvas.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createConvergenceMeter, grabLumaFrame, Y_PLANE_FORMATS } from '../js/camera/conv-meter.js';
import { texture, sbs, rect } from './sbs-fixtures.mjs';

const E = 240;
const H = 135;
/** A face-sized square `d` px in front of a textured wall at the plane, as a grayscale SBS copy. */
const pair = (d) => sbs(E, H, [{ d: 0, tex: texture(1) }, { d, tex: texture(2), inside: rect(90, 35, 150, 95) }]);

/** A grab that serves queued results (an Error = a throwing grab, null = an unreadable frame). */
function queuedGrab(queue) {
  const calls = [];
  const grab = async (video, o) => {
    calls.push(o);
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next === undefined ? null : next;
  };
  return { grab, calls };
}

test('meter: a pair with d = 48 at the copy scale → frac ≈ 48 / eyeW, d in SOURCE px', async () => {
  const { img, W } = pair(48);
  // A 960-px-wide source copied at half scale: 48 copy px = 96 source px, eye width 480.
  const video = { videoWidth: 2 * W, videoHeight: 2 * H };
  const { grab } = queuedGrab([{ img, w: W, h: H, scale: 0.5, via: 'canvas', readMs: 1 }]);
  const m = createConvergenceMeter({ grab, intervalMs: 0 });
  const r = await m.sample(video, 0);
  assert.ok(r, 'sampled');
  assert.ok(Math.abs(r.d - 96) <= 2, `d=${r.d}`);
  assert.ok(Math.abs(r.frac - 48 / E) <= 0.005, `frac=${r.frac}`);
  assert.ok(r.ncc >= 0.8, `ncc=${r.ncc}`);
  assert.ok(['mode', 'focus', 'track'].includes(r.method));
  assert.equal(r.via, 'canvas');
  assert.equal(r.luma.w, W);
  assert.equal(m.d, r.d);
  assert.equal(m.busy, false);
});

test('meter: a failed grab (null or a throw) holds the last value; reset() forgets it', async () => {
  const { img, W } = pair(48);
  const video = { videoWidth: W, videoHeight: H };
  const { grab } = queuedGrab([{ img, w: W, h: H, scale: 1, via: 'videoframe', readMs: 0 }, null, new Error('copyTo failed')]);
  const m = createConvergenceMeter({ grab, intervalMs: 0 });
  const first = await m.sample(video, 0);
  assert.ok(Math.abs(first.frac - 0.2) <= 0.005, `frac=${first.frac}`);
  const held = await m.sample(video, 1);
  assert.equal(held.d, first.d, 'an unreadable frame holds');
  assert.equal(held.frac, first.frac);
  assert.equal(held.luma, null);
  assert.equal(held.ncc, null);
  const threw = await m.sample(video, 2);
  assert.equal(threw.d, first.d, 'a throwing grab holds too, and never rejects');
  m.reset();
  assert.equal(m.d, null);
  const after = await m.sample(video, 3);
  assert.equal(after.d, null, 'reset forgets the held value');
  assert.equal(after.frac, null);
});

test('meter: paced by intervalMs; busy while a grab is in flight; a reset mid-grab drops the stale frame', async () => {
  const { img, W } = pair(48);
  const video = { videoWidth: W, videoHeight: H };
  let release;
  let hold = true; // false: the grab resolves at once
  const frame = { img, w: W, h: H, scale: 1, via: 'canvas', readMs: 0 };
  const grab = () => (hold ? new Promise((r) => (release = () => r(frame))) : Promise.resolve(frame));
  const m = createConvergenceMeter({ grab, intervalMs: 200 });
  const p = m.sample(video, 1000);
  assert.equal(m.busy, true);
  assert.equal(await m.sample(video, 1300), null, 'busy: no second grab');
  m.reset();
  assert.equal(m.busy, false);
  release();
  assert.equal(await p, null, 'the grab that resolved after reset() is dropped');
  assert.equal(m.d, null);
  const q = m.sample(video, 2000);
  release();
  assert.ok((await q).d !== null);
  hold = false;
  assert.equal(await m.sample(video, 2100), null, 'too soon after the last sample');
  assert.ok(await m.sample(video, 2200), 'due again after intervalMs');
});

// ── grabLumaFrame ──────────────────────────────────────────────────────────────────────────────

/** A fake WebCodecs VideoFrame whose plane 0 is a constant luma `y`. */
function installVideoFrame(format, { y = 100, fail = false } = {}) {
  const made = [];
  globalThis.VideoFrame = class {
    constructor(video) {
      this.format = format;
      this.visibleRect = { width: video.videoWidth, height: video.videoHeight };
      this.closed = false;
      made.push(this);
    }
    allocationSize() {
      return this.visibleRect.width * this.visibleRect.height * 2;
    }
    async copyTo(buf) {
      if (fail) throw new Error('copyTo failed');
      buf.fill(y, 0, this.visibleRect.width * this.visibleRect.height);
      return [{ offset: 0, stride: this.visibleRect.width }];
    }
    close() {
      this.closed = true;
    }
  };
  return made;
}

/** A scratch canvas whose 2D context reads back a constant grey. */
function fakeCanvas(grey = 50) {
  const c = { width: 0, height: 0, reads: 0 };
  c.getContext = () => ({
    drawImage() {},
    getImageData(x, y, w, h) {
      c.reads++;
      return { data: new Uint8ClampedArray(w * h * 4).fill(grey) };
    },
  });
  return c;
}

const video1280 = () => ({ videoWidth: 1280, videoHeight: 480, readyState: 4 });

test('grabLumaFrame: NV12 / I420 frames read the Y plane through VideoFrame, downsampled to eyeMax', async (t) => {
  t.after(() => delete globalThis.VideoFrame);
  assert.ok(Y_PLANE_FORMATS.has('NV12') && Y_PLANE_FORMATS.has('I420'));
  for (const format of ['NV12', 'I420']) {
    const made = installVideoFrame(format, { y: 100 });
    const scratch = fakeCanvas();
    const g = await grabLumaFrame(video1280(), { eyeMax: 240, scratch });
    assert.equal(g.via, 'videoframe', format);
    assert.equal(g.w, 426); // factor ceil(640 / 240) = 3: floor(1280 / 3), made even
    assert.ok(g.w / 2 <= 240, `eye ${g.w / 2} <= 240`);
    assert.equal(g.h, Math.floor(480 / 3));
    assert.ok(Math.abs(g.scale - g.w / 1280) < 1e-9);
    assert.equal(g.img[0], 100, 'the luma plane, not a colour conversion');
    assert.equal(scratch.reads, 0, 'no canvas readback');
    assert.equal(made[0].closed, true, 'the frame is closed');
  }
});

test('grabLumaFrame: a non-Y format, no VideoFrame, or a failed copy → canvas or null; frames always closed', async (t) => {
  t.after(() => delete globalThis.VideoFrame);
  let made = installVideoFrame('RGBA');
  let scratch = fakeCanvas(50);
  let g = await grabLumaFrame(video1280(), { eyeMax: 240, scratch });
  assert.equal(g.via, 'canvas');
  assert.equal(g.w, 480);
  assert.equal(g.h, 180);
  assert.equal(g.scale, 480 / 1280);
  assert.equal(g.img[0], 50);
  assert.equal(scratch.reads, 1);
  assert.equal(made[0].closed, true);

  delete globalThis.VideoFrame;
  g = await grabLumaFrame(video1280(), { scratch: fakeCanvas() });
  assert.equal(g.via, 'canvas', 'no WebCodecs: canvas');

  made = installVideoFrame('NV12', { fail: true });
  scratch = fakeCanvas();
  assert.equal(await grabLumaFrame(video1280(), { scratch }), null, 'a failed copyTo → null, not a throw');
  assert.equal(made[0].closed, true);
  assert.equal(scratch.reads, 0);

  assert.equal(await grabLumaFrame({ videoWidth: 1280, videoHeight: 480, readyState: 1 }, { scratch }), null, 'not decoded yet');
  const tainted = { width: 0, height: 0, getContext: () => ({ drawImage() {}, getImageData() { throw new Error('tainted'); } }) };
  delete globalThis.VideoFrame;
  assert.equal(await grabLumaFrame(video1280(), { scratch: tainted }), null, 'a tainted canvas → null');
});

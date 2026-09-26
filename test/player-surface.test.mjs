// Tests for surface mode — attachPlayer() on an existing splat handle (RFC 0001 Addendum A) — and
// the video proxy its transport binds to.
//
// What is pinned is the CONTRACT with the handle, not pixels:
//   - the player creates no canvas and draws only through `handle.setVideo(element, …)`;
//   - a source swap hands setVideo a NEW element and never releases the old one before the swap
//     lands (a released element would re-size and re-texture the plane to nothing);
//   - detach() gives the slot back with setVideo(null), and never clears a video someone else put
//     there; another setVideo taking the slot emits 'detached' once and the player stops.
//
// A recording fake <video> and a fake handle whose setVideo behaves like ./splat's (resolves at
// the element's first frame, rejects AbortError when superseded before it). No jsdom.

import test from 'node:test';
import assert from 'node:assert/strict';

class FakeVideo extends EventTarget {
  constructor() {
    super();
    this.paused = true;
    this.ended = false;
    this.muted = false;
    this.volume = 1;
    this.loop = false;
    this.currentTime = 0;
    this.duration = NaN;
    this.readyState = 0;
    this.src = '';
    this.released = false;
    this.error = null;
  }
  play() {
    this.paused = false;
    this.dispatchEvent(new Event('play'));
    return Promise.resolve();
  }
  pause() {
    if (this.paused) return;
    this.paused = true;
    this.dispatchEvent(new Event('pause'));
  }
  removeAttribute(n) {
    if (n === 'src') {
      this.src = '';
      this.released = true;
    }
  }
  load() {}
}

const created = [];
globalThis.document = {
  createElement(tag) {
    assert.equal(tag, 'video', 'surface mode creates <video> elements only — never a canvas');
    const v = new FakeVideo();
    created.push(v);
    return v;
  },
};

/** A handle whose setVideo behaves like ./splat's, with each call's first frame driven by the test. */
function makeSplat() {
  const calls = [];
  let shown = null;
  let pendingCall = null;
  const splat = {
    canvas: null, // no container: controls are skipped, which keeps this test DOM-free
    get videoElement() {
      return shown;
    },
    setVideo(el, o) {
      if (pendingCall) {
        const p = pendingCall;
        pendingCall = null;
        p.reject(Object.assign(new Error('superseded'), { name: 'AbortError' }));
      }
      if (el === null) {
        calls.push({ el: null });
        shown = null;
        return Promise.resolve(null);
      }
      let resolve, reject;
      const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      const call = { el, o, resolve, reject, promise };
      calls.push(call);
      pendingCall = call;
      return promise;
    },
    /** Deliver the pending call's first frame: the plane now shows its element. */
    firstFrame() {
      const c = pendingCall;
      assert.ok(c, 'a setVideo is pending');
      pendingCall = null;
      shown = c.el;
      c.resolve({ video: c.el });
    },
    /** Someone else's setVideo, already on screen. */
    foreign(el) {
      pendingCall = null;
      shown = el;
    },
    calls,
  };
  return splat;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

async function quiet(fn) {
  const w = console.warn;
  const warnings = [];
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    await fn();
  } finally {
    console.warn = w;
  }
  return warnings;
}

const { attachPlayer, createVideoProxy } = await import('../js/inline3d-player.js');

test('proxy: reads, writes and calls go to the current element; only its events are forwarded', () => {
  const a = new FakeVideo();
  const b = new FakeVideo();
  const p = createVideoProxy();
  const seen = [];
  p.addEventListener('pause', () => seen.push('pause'));
  p.use(a);
  p.muted = true;
  assert.equal(a.muted, true);
  a.play();
  a.pause();
  assert.deepEqual(seen, ['pause']);
  p.use(b);
  assert.equal(p.element, b);
  assert.equal(p.muted, false, 'reads come from the new element');
  a.play();
  a.pause();
  assert.deepEqual(seen, ['pause'], 'the old element is no longer heard');
  b.play();
  p.pause();
  assert.equal(b.paused, true);
  assert.deepEqual(seen, ['pause', 'pause']);
  p.use(null);
  assert.equal(p.paused, true, 'no element: reads as paused, never throws');
});

test('attach: draws through setVideo(element) with format, fit contain, autoplay off', async () => {
  const splat = makeSplat();
  const player = attachPlayer(splat, 'a.webm', { controls: 'none', format: 'tb' });
  assert.equal(splat.calls.length, 1);
  const c = splat.calls[0];
  assert.ok(c.el instanceof FakeVideo);
  assert.equal(c.el.src, 'a.webm');
  assert.deepEqual(c.o, { format: 'tb', fit: 'contain', autoplay: false });
  assert.equal(player.video.element, c.el, 'the handle exposes the proxy, answering for the element');
  await player.detach();
});

test("setSource: a NEW element, inheriting mute/volume/loop; the old one paused, released only after the swap lands", async () => {
  const splat = makeSplat();
  const player = attachPlayer(splat, 'a.webm', { controls: 'none' });
  splat.firstFrame();
  await flush();
  const a = splat.calls[0].el;
  a.muted = true;
  a.volume = 0.4;
  await a.play();
  player.setSource('b.webm');
  assert.equal(splat.calls.length, 2);
  const b = splat.calls[1].el;
  assert.notEqual(b, a);
  assert.equal(b.src, 'b.webm');
  assert.equal(b.muted, true);
  assert.equal(b.volume, 0.4);
  assert.equal(a.paused, true, 'the outgoing title stops at once');
  assert.equal(a.released, false, 'but it stays loaded: the plane still shows it');
  splat.firstFrame();
  await flush();
  assert.equal(a.released, true, 'released once the swap has landed');
  assert.equal(b.released, false);
  await player.detach();
});

test('detach(): setVideo(null), elements released, and it resolves', async () => {
  const splat = makeSplat();
  const player = attachPlayer(splat, 'a.webm', { controls: 'none' });
  splat.firstFrame();
  await flush();
  const a = splat.calls[0].el;
  await player.detach();
  assert.deepEqual(splat.calls.at(-1), { el: null });
  assert.equal(a.released, true);
  assert.equal(splat.videoElement, null);
});

test('detach() before the first frame cancels ours and emits no error', async () => {
  const splat = makeSplat();
  const player = attachPlayer(splat, 'a.webm', { controls: 'none' });
  const events = [];
  player.on('error', () => events.push('error'));
  player.on('detached', () => events.push('detached'));
  await player.detach();
  await flush();
  assert.deepEqual(splat.calls.at(-1), { el: null });
  assert.deepEqual(events, []);
});

test("another setVideo before our first frame: 'detached' superseded, and the slot is left alone", async () => {
  const splat = makeSplat();
  const player = attachPlayer(splat, 'a.webm', { controls: 'none' });
  const got = [];
  player.on('detached', (e) => got.push(e));
  splat.setVideo(new FakeVideo(), {}); // the page's own video takes the slot
  await flush();
  assert.deepEqual(got, [{ reason: 'superseded' }]);
  assert.equal(splat.calls.filter((c) => c.el === null).length, 0, 'never clears a video it does not own');
  await player.detach(); // a no-op now
  assert.equal(splat.calls.filter((c) => c.el === null).length, 0);
});

test("another video on screen after ours: noticed on the next transport event, 'detached' once", async () => {
  const splat = makeSplat();
  const player = attachPlayer(splat, 'a.webm', { controls: 'none' });
  splat.firstFrame();
  await flush();
  const got = [];
  player.on('detached', (e) => got.push(e.reason));
  const theirs = new FakeVideo();
  splat.foreign(theirs);
  const a = splat.calls[0].el;
  await a.play(); // a transport event: the player looks at the slot
  assert.deepEqual(got, ['superseded']);
  assert.equal(a.released, true, 'our element is let go');
  assert.equal(theirs.released, false, 'theirs is untouched');
  assert.equal(splat.calls.filter((c) => c.el === null).length, 0);
});

test("the slot emptied by someone else reads 'released'", async () => {
  const splat = makeSplat();
  const player = attachPlayer(splat, 'a.webm', { controls: 'none' });
  splat.firstFrame();
  await flush();
  const got = [];
  player.on('detached', (e) => got.push(e.reason));
  splat.foreign(null);
  await splat.calls[0].el.play();
  assert.deepEqual(got, ['released']);
});

test('playlist: next() goes through a new element and emits titlechange; back() restarts past 3 s', async () => {
  const splat = makeSplat();
  const titles = [
    { id: 'one', src: 'one.webm', title: 'One' },
    { id: 'two', src: 'two.webm', title: 'Two' },
  ];
  const player = attachPlayer(splat, null, { controls: 'none', titles });
  assert.equal(splat.calls[0].el.src, 'one.webm');
  splat.firstFrame();
  await flush();
  const changes = [];
  player.on('titlechange', (t) => changes.push(t.id));
  await player.next();
  assert.equal(splat.calls[1].el.src, 'two.webm');
  assert.equal(player.current.id, 'two');
  assert.deepEqual(changes, ['two']);
  splat.firstFrame();
  await flush();
  splat.calls[1].el.currentTime = 5;
  await player.back();
  assert.equal(splat.calls.length, 2, 'more than 3 s in: a restart, not a new element');
  assert.equal(splat.calls[1].el.currentTime, 0);
  await player.detach();
});

test("crossfade cuts with a warning; band / poster / tile options are ignored with a warning", async () => {
  const splat = makeSplat();
  let player;
  const w1 = await quiet(() => {
    player = attachPlayer(splat, 'a.webm', { controls: 'none', band: 2.39, poster: 'p.jpg', transition: 'crossfade' });
  });
  assert.ok(w1.some((w) => w.includes('ignores') && w.includes('band') && w.includes('poster')));
  splat.firstFrame();
  await flush();
  const w2 = await quiet(() => player.setSource('b.webm'));
  assert.ok(w2.some((w) => w.includes('cuts')));
  assert.equal(splat.calls.length, 2, 'still a clean swap through setVideo');
  await player.detach();
});

test('attachPlayer refuses anything without setVideo, by name', () => {
  assert.throws(() => attachPlayer({}, 'a.webm'), /needs an addSplat/);
  assert.throws(() => attachPlayer(null, 'a.webm'), /needs an addSplat/);
});

// Tests for js/lift/providers/lift-remote-sharp.js (the DEMO-ONLY remote SHARP lift provider),
// js/lift/sog-input.js (a .sog as lift input) and the lift-provider registry. fetch and the popup
// window are fakes; the .sog fixtures are built by our own sog-export.js.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createRemoteSharpLift,
  createPopupAuth,
  encodeJpeg,
  normalizeExpiry,
  RemoteLiftError,
  REMOTE_SHARP_DEFAULTS,
} from '../js/lift/providers/lift-remote-sharp.js';
import { getRegistry } from '../js/lift/providers/registry.js';
import { readLiftSog, liftMetaFromSogMeta, isSogBytes } from '../js/lift/sog-input.js';
import { buildSog } from '../js/lift/sog-export.js';

// ── fixtures ───────────────────────────────────────────────────────────────────────────────

let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);

function makePly(n) {
  const props = ['x', 'y', 'z', 'nx', 'ny', 'nz', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
  const head = `ply\nformat binary_little_endian 1.0\nelement vertex ${n}\n${props.map((p) => `property float ${p}`).join('\n')}\nend_header\n`;
  const hb = new TextEncoder().encode(head);
  const f = new Float32Array(n * props.length);
  for (let i = 0; i < n; i++) {
    const z = 0.5 + rnd() * 5;
    f.set([(rnd() - 0.5) * z, (rnd() - 0.5) * z, z, 0, 0, 0, rnd() - 0.5, rnd() - 0.5, rnd() - 0.5, rnd() * 4 - 2, -6, -6, -6, 1, 0, 0, 0], i * props.length);
  }
  const out = new Uint8Array(hb.length + f.byteLength);
  out.set(hb, 0);
  out.set(new Uint8Array(f.buffer), hb.length);
  return out;
}

// The shape the SHARP worker writes: camera block v2, focus from the nearest clump.
const SHARP_LIKE = {
  focalPx: 1380, pivotZ: 2.37, subjectZ: 2.37, w: 1536, h: 1024, layers: 2,
  intrinsics: { fx: 1380, fy: 1380, cx: 768, cy: 512, width: 1536, height: 1024 },
  convention: 'opencv', depthRange: { near: 0.9, far: 30 },
};
let SOG = null;
async function sogFixture() {
  if (!SOG) SOG = (await buildSog({ ply: makePly(500), meta: SHARP_LIKE, camera: { focus: { source: 'nearest-clump' } } })).bytes;
  return SOG;
}

const jpeg = () => new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9])], { type: 'image/jpeg' });

/** A fetch fake: records calls, answers with `respond(call)` (a Response or a thrown error). */
function fakeFetch(respond) {
  const calls = [];
  const f = async (url, init) => {
    const call = { url, init, form: init.body, headers: { ...(init.headers || {}) } };
    calls.push(call);
    return respond(call, calls.length);
  };
  f.calls = calls;
  return f;
}
const sogResponse = async (extraHeaders = {}) => {
  const b = await sogFixture();
  return new Response(b, { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': String(b.length), ...extraHeaders } });
};

// ── sog-input ──────────────────────────────────────────────────────────────────────────────

test('sog-input: an own-export .sog round-trips into lift meta (intrinsics → focal/size, focus → pivot, opencv)', async () => {
  const bytes = await sogFixture();
  assert.ok(isSogBytes(bytes));
  const { meta, sogMeta } = await readLiftSog(bytes);
  assert.equal(sogMeta.count, 500);
  assert.equal(meta.splatCount, 500);
  assert.equal(meta.focalPx, 1380);
  assert.equal(meta.w, 1536);
  assert.equal(meta.h, 1024);
  assert.equal(meta.pivotZ, 2.37);
  assert.equal(meta.axes, 'opencv');
  assert.equal(meta.convention, 'opencv');
  assert.equal(meta.layers, 2);
  assert.equal(meta.focusSource, 'nearest-clump');
  assert.deepEqual(meta.intrinsics, { fx: 1380, fy: 1380, cx: 768, cy: 512, w: 1536, h: 1024 });
  assert.deepEqual(meta.depthRange, { near: 0.9, far: 30 });
});

test('sog-input: no intrinsics → the fallback focal/size; no focus → subject, then fallback pivot', () => {
  const m = liftMetaFromSogMeta({ count: 3, camera: { convention: 'opencv', rig: 'camera' } }, { focalPx: 1000, w: 1200, h: 800, pivotZ: 3 });
  assert.equal(m.focalPx, 1000);
  assert.equal(m.w, 1200);
  assert.equal(m.pivotZ, 3);
  assert.throws(() => liftMetaFromSogMeta({ count: 3 }), /no usable intrinsics/);
});

test('sog-input: rejects non-SOG bytes', async () => {
  await assert.rejects(readLiftSog(new TextEncoder().encode('ply\n')), /not a \.sog/);
});

// ── the provider: the wire ─────────────────────────────────────────────────────────────────

test('remote-sharp: multipart shape, same-origin default endpoint, no auth header, sog + meta out', async () => {
  const f = fakeFetch(() => sogResponse({ 'x-sharp-focal-px': '1380', 'x-sharp-focal-source': 'request' }));
  const p = createRemoteSharpLift({ fetch: f });
  assert.equal(p.id, 'remote-sharp');
  assert.equal(p.needsDepth, false);
  const stages = [];
  const res = await p.generateLift({ rgb: jpeg(), size: { w: 1536, h: 1024 }, onProgress: (e) => stages.push(e.stage) });
  assert.equal(f.calls.length, 1);
  const c = f.calls[0];
  assert.equal(c.url, REMOTE_SHARP_DEFAULTS.endpoint);
  assert.equal(c.url, '/api/sharp/predict');
  assert.equal(c.init.method, 'POST');
  assert.equal(c.headers.Authorization, undefined);
  assert.ok(c.form instanceof FormData);
  assert.equal(c.form.get('mode'), 'mono');
  const img = c.form.get('image');
  assert.ok(img instanceof Blob);
  assert.equal(img.type, 'image/jpeg');
  assert.equal(img.name, 'frame.jpg');
  assert.equal(c.form.get('focal_length_px'), null, 'no focal when the caller does not know it');
  assert.ok(res.sog instanceof ArrayBuffer);
  assert.equal(res.sog.byteLength, (await sogFixture()).length);
  assert.equal(res.meta.source, 'remote-sharp');
  assert.equal(res.meta.layers, 2);
  assert.equal(res.meta.splatCount, 500);
  assert.equal(res.meta.focalPx, 1380);
  assert.equal(res.meta.pivotZ, 2.37);
  assert.equal(res.meta.w, 1536);
  assert.equal(res.meta.sharp.focalSource, 'request');
  assert.ok(res.meta.timings.totalMs >= 0);
  assert.ok(stages.includes('encoding') && stages.includes('uploading') && stages.includes('downloading'), stages.join());
});

test('remote-sharp: focal forwarded in pixels of the JPEG sent (rescaled from the depth grid)', async () => {
  const f = fakeFetch(() => sogResponse());
  const p = createRemoteSharpLift({ fetch: f });
  // lift.js hands focal in pixels of the frozen bitmap (focalGridW); the JPEG is that bitmap.
  await p.generateLift({ rgb: jpeg(), size: { w: 2000, h: 1000 }, depth: { w: 770, intrinsics: { focalPx: 1700, focalGridW: 2000 } } });
  assert.equal(f.calls[0].form.get('focal_length_px'), '1700');
  // A raw depth map's focal is in ITS grid (w = 770): 700 px there = 700·2000/770 in the image.
  await p.generateLift({ rgb: jpeg(), size: { w: 2000, h: 1000 }, depth: { w: 770, intrinsics: { focalPx: 700 } } });
  assert.equal(+f.calls[1].form.get('focal_length_px'), +((700 * 2000) / 770).toFixed(3));
  // spatial mode: the worker ignores focal, so it is not sent.
  const ps = createRemoteSharpLift({ fetch: f, mode: 'spatial' });
  await ps.generateLift({ rgb: jpeg(), size: { w: 2000, h: 1000 }, depth: { w: 2000, intrinsics: { focalPx: 1700 } } });
  assert.equal(f.calls[2].form.get('mode'), 'spatial');
  assert.equal(f.calls[2].form.get('focal_length_px'), null);
});

test('remote-sharp: encodeJpeg downsizes to maxSide and the focal follows the downscale', async () => {
  const drawn = [];
  const createCanvas = (w, h) => ({
    width: w, height: h,
    getContext: () => ({ drawImage: (src, x, y, dw, dh) => drawn.push([dw, dh]) }),
    convertToBlob: async ({ type, quality }) => new Blob([new Uint8Array(8)], { type: `${type};q=${quality}` }),
  });
  const bitmap = { width: 4032, height: 3024 };
  const enc = await encodeJpeg(bitmap, { createCanvas });
  assert.deepEqual([enc.w, enc.h], [1536, 1152]);
  assert.deepEqual(drawn[0], [1536, 1152]);
  assert.match(enc.blob.type, /image\/jpeg;q=0\.92/);
  const f = fakeFetch(() => sogResponse());
  const p = createRemoteSharpLift({ fetch: f, createCanvas });
  await p.generateLift({ rgb: bitmap, depth: { w: 4032, intrinsics: { focalPx: 3000, focalGridW: 4032 } } });
  assert.equal(+f.calls[0].form.get('focal_length_px'), +((3000 * 1536) / 4032).toFixed(3));
  const small = await encodeJpeg({ width: 800, height: 600 }, { createCanvas });
  assert.deepEqual([small.w, small.h], [800, 600], 'never upscales');
});

test('remote-sharp: bearer auth + getAuthHeaders hook per request; custom endpoint + extra fields', async () => {
  const f = fakeFetch(() => sogResponse());
  let n = 0;
  const p = createRemoteSharpLift({
    fetch: f,
    endpoint: 'https://example.test/api/sharp/predict',
    auth: { kind: 'bearer', token: 'tok-123' },
    getAuthHeaders: () => ({ 'X-Request-Id': `r${++n}` }),
    fields: { crop: 'none' },
  });
  await p.generateLift({ rgb: jpeg() });
  await p.generateLift({ rgb: jpeg() });
  assert.equal(f.calls[0].url, 'https://example.test/api/sharp/predict');
  assert.equal(f.calls[0].headers.Authorization, 'Bearer tok-123');
  assert.equal(f.calls[0].headers['X-Request-Id'], 'r1');
  assert.equal(f.calls[1].headers['X-Request-Id'], 'r2');
  assert.equal(f.calls[0].form.get('crop'), 'none');
});

// ── the provider: failures ─────────────────────────────────────────────────────────────────

test('remote-sharp: timeout → RemoteLiftError code timeout, fallback allowed', async () => {
  const f = fakeFetch(({ init }) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))));
  const p = createRemoteSharpLift({ fetch: f, timeoutMs: 60 });
  const t0 = Date.now();
  await assert.rejects(p.generateLift({ rgb: jpeg() }), (e) => e instanceof RemoteLiftError && e.code === 'timeout' && e.fallback === true);
  assert.ok(Date.now() - t0 < 2000);
});

test('remote-sharp: a fetch that ignores its signal still times out (the guard)', async () => {
  const f = fakeFetch(() => new Promise(() => {}));
  const p = createRemoteSharpLift({ fetch: f, timeoutMs: 50 });
  await assert.rejects(p.generateLift({ rgb: jpeg() }), (e) => e.code === 'timeout');
});

test('remote-sharp: caller abort → code aborted, fallback false; pre-aborted never fetches', async () => {
  const f = fakeFetch(({ init }) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))));
  const p = createRemoteSharpLift({ fetch: f });
  const ac = new AbortController();
  const run = p.generateLift({ rgb: jpeg(), signal: ac.signal });
  setTimeout(() => ac.abort(), 20);
  await assert.rejects(run, (e) => e.code === 'aborted' && e.fallback === false);
  assert.equal(f.calls[0].init.signal.aborted, true, 'the request itself is aborted');
  const ac2 = new AbortController();
  ac2.abort();
  const before = f.calls.length;
  await assert.rejects(p.generateLift({ rgb: jpeg(), signal: ac2.signal }), (e) => e.code === 'aborted');
  assert.equal(f.calls.length, before);
});

test('remote-sharp: HTTP error / network error / non-SOG body → clean errors that allow fallback', async () => {
  const p1 = createRemoteSharpLift({ fetch: fakeFetch(() => new Response('{"error":"boom"}', { status: 502, statusText: 'Bad Gateway' })) });
  await assert.rejects(p1.generateLift({ rgb: jpeg() }), (e) => e.code === 'http' && e.status === 502 && /boom/.test(e.message) && e.fallback);
  const p2 = createRemoteSharpLift({ fetch: fakeFetch(() => { throw new TypeError('Failed to fetch'); }) });
  await assert.rejects(p2.generateLift({ rgb: jpeg() }), (e) => e.code === 'network' && e.fallback);
  const p3 = createRemoteSharpLift({ fetch: fakeFetch(() => new Response('<html>login</html>', { status: 200 })) });
  await assert.rejects(p3.generateLift({ rgb: jpeg() }), (e) => e.code === 'format' && e.fallback);
  const p4 = createRemoteSharpLift({ fetch: fakeFetch(() => new Response('no', { status: 401 })) });
  await assert.rejects(p4.generateLift({ rgb: jpeg() }), (e) => e.code === 'auth');
});

test('remote-sharp: relay status codes → forbidden / quota / too-large, all still allowing fallback', async () => {
  const mk = (status, headers = {}) => createRemoteSharpLift({ fetch: fakeFetch(() => new Response(JSON.stringify({ error: 'why' }), { status, headers })) });
  await assert.rejects(mk(403).generateLift({ rgb: jpeg() }), (e) => e.code === 'forbidden' && /account not allowed — why/.test(e.message) && e.fallback);
  await assert.rejects(mk(429, { 'retry-after': '120' }).generateLift({ rgb: jpeg() }), (e) => e.code === 'quota' && e.retryAfterS === 120 && /quota reached \(retry in 120 s\)/.test(e.message));
  await assert.rejects(mk(413).generateLift({ rgb: jpeg() }), (e) => e.code === 'too-large');
  await assert.rejects(mk(503).generateLift({ rgb: jpeg() }), (e) => e.code === 'http' && e.status === 503 && e.fallback);
});

test('remote-sharp: relay headers X-DXR-Sharp / -Ms → meta.cacheHit / serverMs and the download progress', async () => {
  const seen = [];
  const p = createRemoteSharpLift({ fetch: fakeFetch(() => sogResponse({ 'x-dxr-sharp': 'cache-hit', 'x-dxr-sharp-ms': '212' })) });
  const r = await p.generateLift({ rgb: jpeg(), onProgress: (e) => e.stage === 'downloading' && seen.push(e) });
  assert.equal(r.meta.cacheHit, true);
  assert.equal(r.meta.serverMs, 212);
  assert.equal(seen.at(-1).cacheHit, true);
  const p2 = createRemoteSharpLift({ fetch: fakeFetch(() => sogResponse({ 'x-dxr-sharp': 'modal', 'x-dxr-sharp-ms': '8400' })) });
  assert.equal((await p2.generateLift({ rgb: jpeg() })).meta.cacheHit, false);
  const p3 = createRemoteSharpLift({ fetch: fakeFetch(() => sogResponse()) }); // via serve.py: unknown
  assert.equal((await p3.generateLift({ rgb: jpeg() })).meta.cacheHit, null);
});

test('remote-sharp: upload cap — re-encodes (quality, then size) until under maxBytes; a Blob over it is refused', async () => {
  const tries = [];
  const createCanvas = (w, h) => ({
    width: w, height: h, getContext: () => ({ drawImage() {} }),
    // bytes ∝ pixels × quality: 1536×1024 @0.92 ≈ 5.8 MB, over a 4 MB cap
    convertToBlob: async ({ quality }) => (tries.push([w, h, quality]), new Blob([new Uint8Array(Math.round(w * h * quality * 4))])),
  });
  const enc = await encodeJpeg({ width: 1536, height: 1024 }, { createCanvas, maxBytes: 4_000_000 });
  assert.ok(enc.blob.size <= 4_000_000, `${enc.blob.size}`);
  assert.equal(tries[0][2], 0.92);
  assert.ok(tries.length >= 2);
  assert.ok(tries.at(-1)[2] < 0.92 || tries.at(-1)[0] < 1536);
  await assert.rejects(encodeJpeg(new Blob([new Uint8Array(5_000_000)]), { maxBytes: 4_000_000 }), (e) => e.code === 'too-large');
});

// ── popup auth ─────────────────────────────────────────────────────────────────────────────

/** A fake window: open() returns a fake popup; post() delivers a message event to listeners. */
function fakeWindow({ blocked = false } = {}) {
  const listeners = new Set();
  const w = {
    location: { href: 'http://127.0.0.1:8812/samples/lift/index.html', origin: 'http://127.0.0.1:8812' },
    screenX: 100, screenY: 50, outerWidth: 1480, outerHeight: 1040,
    opened: [],
    open(url, name, features) {
      if (blocked) return null;
      const popup = { url, name, features, closed: false, close() { this.closed = true; } };
      w.opened.push(popup);
      return popup;
    },
    addEventListener(t, fn) { if (t === 'message') listeners.add(fn); },
    removeEventListener(t, fn) { if (t === 'message') listeners.delete(fn); },
    post(data, origin) { for (const fn of [...listeners]) fn({ data, origin }); },
    get listenerCount() { return listeners.size; },
  };
  return w;
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test('popup auth: centred 480×640 popup, token only from the login origin, cached until expiry', async () => {
  const win = fakeWindow();
  const a = createPopupAuth({ loginUrl: 'https://gallery.test/auth/popup', win });
  const p = a.getToken();
  await tick();
  assert.equal(win.opened.length, 1);
  const pop = win.opened[0];
  assert.equal(pop.url, 'https://gallery.test/auth/popup?origin=http%3A%2F%2F127.0.0.1%3A8812', 'tells the popup our origin');
  assert.match(pop.features, /width=480,height=640/);
  assert.match(pop.features, /left=600,top=250/); // 100 + (1480-480)/2, 50 + (1040-640)/2
  win.post({ type: 'dxr-auth', accessToken: 'evil', expiresAt: Date.now() + 3600e3 }, 'https://evil.test');
  win.post({ type: 'something-else', accessToken: 'x' }, 'https://gallery.test');
  win.post({ type: 'dxr-auth', accessToken: 'good-token', expiresAt: Date.now() + 3600e3, email: 'a@leiainc.com' }, 'https://gallery.test');
  assert.equal(await p, 'good-token');
  assert.equal(a.email, 'a@leiainc.com');
  assert.equal(pop.closed, true, 'the popup is closed after sign-in');
  assert.equal(win.listenerCount, 0);
  assert.equal(await a.getToken(), 'good-token');
  assert.equal(win.opened.length, 1, 'cached: no second popup');
  assert.equal(a.signedIn, true);
});

test('popup auth: an expired token re-opens the popup; concurrent callers share one popup', async () => {
  const win = fakeWindow();
  const a = createPopupAuth({ loginUrl: '/auth/popup', win }); // relative → the page origin
  const p = a.getToken();
  const q = a.getToken();
  await tick();
  assert.equal(win.opened.length, 1);
  win.post({ type: 'dxr-auth', accessToken: 't1', expiresAt: Date.now() + 10e3 }, 'http://127.0.0.1:8812'); // inside the 30 s skew
  assert.equal(await p, 't1');
  assert.equal(await q, 't1');
  const r = a.getToken();
  await tick();
  assert.equal(win.opened.length, 2, 'expiring token → sign in again');
  win.post({ type: 'dxr-auth', accessToken: 't2', expiresAt: new Date(Date.now() + 3600e3).toISOString() }, 'http://127.0.0.1:8812');
  assert.equal(await r, 't2');
});

test('popup auth: blocked popup, closed popup, and an error payload reject cleanly', async () => {
  const blocked = createPopupAuth({ loginUrl: 'https://g.test/auth/popup', win: fakeWindow({ blocked: true }) });
  await assert.rejects(blocked.getToken(), (e) => e.code === 'popup-blocked');
  const win = fakeWindow();
  const a = createPopupAuth({ loginUrl: 'https://g.test/auth/popup', win });
  const p = a.getToken();
  await tick();
  win.opened[0].closed = true;
  await assert.rejects(p, (e) => e.code === 'popup-closed' && /same-origin-allow-popups/.test(e.message));
  const p2 = a.getToken();
  await tick();
  win.post({ type: 'dxr-auth', error: 'access_denied' }, 'https://g.test');
  await assert.rejects(p2, (e) => e.code === 'auth' && /access_denied/.test(e.message));
});

test('remote-sharp + google auth: sends the popup token; a 401 re-opens the popup once and retries', async () => {
  const win = fakeWindow();
  let status = 401;
  const f = fakeFetch(async () => (status === 401 ? ((status = 200), new Response('expired', { status: 401 })) : sogResponse()));
  const p = createRemoteSharpLift({ fetch: f, window: win, endpoint: 'https://g.test/api/sharp/predict', auth: { kind: 'google', loginUrl: 'https://g.test/auth/popup' } });
  const run = p.generateLift({ rgb: jpeg() });
  await tick(5);
  win.post({ type: 'dxr-auth', accessToken: 'old', expiresAt: Date.now() + 3600e3 }, 'https://g.test');
  await tick(5);
  assert.equal(win.opened.length, 2, '401 → second popup');
  win.post({ type: 'dxr-auth', accessToken: 'fresh', expiresAt: Date.now() + 3600e3 }, 'https://g.test');
  const res = await run;
  assert.ok(res.sog.byteLength > 0);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].headers.Authorization, 'Bearer old');
  assert.equal(f.calls[1].headers.Authorization, 'Bearer fresh');
  // a second 401 after the retry is a clean auth error, not a loop
  const f2 = fakeFetch(() => new Response('nope', { status: 401 }));
  const win2 = fakeWindow();
  const p2 = createRemoteSharpLift({ fetch: f2, window: win2, auth: { kind: 'google', loginUrl: 'https://g.test/auth/popup' } });
  const run2 = p2.generateLift({ rgb: jpeg() });
  const answer = async () => { for (let i = 0; i < 20 && win2.listenerCount === 0; i++) await tick(2); win2.post({ type: 'dxr-auth', accessToken: 'a', expiresAt: Date.now() + 3600e3 }, 'https://g.test'); };
  await answer();
  await tick(5);
  await answer();
  await assert.rejects(run2, (e) => e.code === 'auth');
  assert.equal(f2.calls.length, 2);
});

test('normalizeExpiry: seconds, ms, ISO, junk', () => {
  assert.equal(normalizeExpiry(1_900_000_000), 1_900_000_000_000);
  assert.equal(normalizeExpiry(1_900_000_000_000), 1_900_000_000_000);
  assert.equal(normalizeExpiry('2030-01-01T00:00:00Z'), Date.parse('2030-01-01T00:00:00Z'));
  assert.equal(normalizeExpiry(undefined), 0);
});

// ── registry ───────────────────────────────────────────────────────────────────────────────

test('registry: remote-sharp self-registers opt-in — by name only, never the default', () => {
  const reg = getRegistry();
  const names = reg.listLiftProviders().map((e) => e.name);
  assert.ok(names.includes('remote-sharp'));
  assert.equal(reg.getLiftProvider(null), null, 'no default lift provider → local');
  assert.equal(reg.getLiftProvider('local'), null);
  const p = reg.getLiftProvider('remote-sharp', { endpoint: '/x', fetch: async () => {} });
  assert.equal(p.id, 'remote-sharp');
  assert.equal(p.endpoint, '/x');
  assert.throws(() => reg.getLiftProvider('nope'), /no lift provider registered/);
  // a normal-priority registration IS the default; opt-in ones never are
  const off = reg.registerLiftProvider('native-lift', () => ({ id: 'native-lift', generateLift() {} }), { priority: 5 });
  assert.equal(reg.getLiftProvider(null).id, 'native-lift');
  off();
  assert.equal(reg.getLiftProvider(null), null);
});

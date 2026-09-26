// Tests for js/lift/native.js — the DisplayXR Browser's vendor 2D→3D module seen from the SDK:
// liftCapabilities (inside / outside the browser's lift world), the dxr-lift attribute controller
// (native live mode), the `native` depth provider (parsing + ORT fallback), the `native-gaussians`
// lift provider and its selection over the local generator.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  liftCapabilities,
  _resetLiftCapabilities,
  parseNativeCaps,
  createNativeLiveAttrs,
  normalizePriority,
  LIFT_ATTRS,
  parseNativeDepthResponse,
  createNativeDepthProvider,
  createNativeGaussiansLift,
  ensureNativeProviders,
  defaultLiftProviderFor,
  sniffSplatFormat,
  NATIVE_CAPS_URL,
  NATIVE_DEPTH_URL,
  NATIVE_GAUSSIANS_URL,
} from '../js/lift/native.js';
import { createLiftMachine, STATES, resolveLiftMode } from '../js/lift/state.js';
import { getRegistry } from '../js/lift/providers/registry.js';

const CAPS = { native: true, provider: 'neurd-directml', modes: ['depth', 'sbs', 'nview', 'gaussians'], maxStreams: 2, approxMsPerConvert: 18, state: 'ready' };

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

/** A fetch that answers displayxr-lift:// the way the browser's lift world does. */
function browserFetch(routes, calls = []) {
  return async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET' });
    const h = routes[String(url)];
    if (!h) throw new TypeError('Failed to fetch'); // an unknown scheme / route
    return h(init);
  };
}
const outsideFetch = async () => {
  throw new TypeError('Failed to fetch'); // displayxr-lift:// does not resolve on an ordinary page
};
const noGpu = { gpu: undefined };

// ── liftCapabilities ──────────────────────────────────────────────────────────────────────

test('liftCapabilities inside the browser: native caps, cached per document, refresh re-asks', async () => {
  _resetLiftCapabilities();
  const calls = [];
  const fetch = browserFetch({ [NATIVE_CAPS_URL]: () => jsonResponse(CAPS) }, calls);
  const c = await liftCapabilities({ fetch, navigator: noGpu });
  assert.equal(c.native, true);
  assert.equal(c.provider, 'neurd-directml');
  assert.deepEqual(c.modes, ['depth', 'sbs', 'nview', 'gaussians']);
  assert.equal(c.maxStreams, 2);
  assert.equal(c.approxMsPerConvert, 18);
  assert.equal(c.state, 'ready');
  assert.deepEqual(c.webFallback, { video: false, still: false, webgpu: false });
  await liftCapabilities({ fetch, navigator: noGpu });
  assert.equal(calls.filter((x) => x.url === NATIVE_CAPS_URL).length, 1, 'cached');
  await liftCapabilities({ fetch, navigator: noGpu, refresh: true });
  assert.equal(calls.filter((x) => x.url === NATIVE_CAPS_URL).length, 2, 'refresh re-queries');
});

test('liftCapabilities outside the browser: fetch rejects → native:false', async () => {
  _resetLiftCapabilities();
  const c = await liftCapabilities({ fetch: outsideFetch, navigator: noGpu });
  assert.equal(c.native, false);
  assert.equal(c.provider, undefined);
  assert.deepEqual(c.webFallback, { video: false, still: false, webgpu: false });
});

test('liftCapabilities: an unavailable module or a non-OK answer is not native; an abort is not cached', async () => {
  _resetLiftCapabilities();
  let c = await liftCapabilities({ fetch: browserFetch({ [NATIVE_CAPS_URL]: () => jsonResponse({ ...CAPS, state: 'unavailable' }) }), navigator: noGpu });
  assert.equal(c.native, false);
  assert.equal(c.state, 'unavailable');
  c = await liftCapabilities({ fetch: browserFetch({ [NATIVE_CAPS_URL]: () => jsonResponse({}, 500) }), navigator: noGpu, refresh: true });
  assert.equal(c.native, false);
  // activating counts as native (the browser queues until ready)
  assert.equal(parseNativeCaps({ ...CAPS, state: 'activating' }).native, true);
  assert.deepEqual(parseNativeCaps({ native: true, modes: ['depth', 'bogus'] }).modes, ['depth']);

  _resetLiftCapabilities();
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(liftCapabilities({ fetch: browserFetch({ [NATIVE_CAPS_URL]: () => jsonResponse(CAPS) }), navigator: noGpu, signal: ac.signal }));
  c = await liftCapabilities({ fetch: browserFetch({ [NATIVE_CAPS_URL]: () => jsonResponse(CAPS) }), navigator: noGpu });
  assert.equal(c.native, true, 'the aborted query was not cached');
});

test('liftCapabilities webFallback: WebGPU adapter + model reachability through the model source', async () => {
  _resetLiftCapabilities();
  const probed = [];
  const models = {
    ready: async () => {},
    resolveName: (n, role) => (role === 'depth-video' ? 'vda-s' : 'moge3-m'),
    probe: async (name) => (probed.push(name), name === 'vda-s'),
  };
  const nav = { gpu: { requestAdapter: async () => ({}) } };
  const c = await liftCapabilities({ fetch: outsideFetch, navigator: nav, models });
  assert.deepEqual(c.webFallback, { video: true, still: false, webgpu: true });
  assert.deepEqual(probed.sort(), ['moge3-m', 'vda-s']);
  const c2 = await liftCapabilities({ fetch: outsideFetch, navigator: { gpu: { requestAdapter: async () => null } }, models: {}, refresh: true });
  assert.deepEqual(c2.webFallback, { video: false, still: false, webgpu: false });
  const c3 = await liftCapabilities({ fetch: outsideFetch, navigator: nav, models, webFallback: false, refresh: true });
  assert.deepEqual(c3.webFallback, { video: false, still: false, webgpu: false });
});

// ── native live: the attributes ───────────────────────────────────────────────────────────

function fakeEl(attrs = {}) {
  const a = new Map(Object.entries(attrs));
  return {
    a,
    hasAttribute: (n) => a.has(n),
    getAttribute: (n) => (a.has(n) ? a.get(n) : null),
    setAttribute: (n, v) => a.set(n, String(v)),
    removeAttribute: (n) => a.delete(n),
  };
}

test('native attrs: apply sets dxr-lift + options; setters map; clear restores exactly', () => {
  const el = fakeEl({ [LIFT_ATTRS.priority]: 'low', 'data-x': '1' });
  const n = createNativeLiveAttrs(el, { depth: 1.4, convergence: 'auto', priority: 'high' });
  assert.equal(el.a.has(LIFT_ATTRS.lift), false, 'nothing before apply()');
  n.apply();
  assert.equal(el.getAttribute('dxr-lift'), 'auto');
  assert.equal(el.getAttribute('dxr-lift-strength'), '1.4');
  assert.equal(el.getAttribute('dxr-lift-convergence'), 'auto');
  assert.equal(el.getAttribute('dxr-lift-priority'), 'high');
  n.setStrength(0.75);
  n.setConvergence(0.3);
  assert.equal(el.getAttribute('dxr-lift-strength'), '0.75');
  assert.equal(el.getAttribute('dxr-lift-convergence'), '0.3');
  n.setConvergence('nonsense');
  assert.equal(el.getAttribute('dxr-lift-convergence'), 'auto');
  assert.equal(n.setPriority('turbo'), false);
  assert.equal(el.getAttribute('dxr-lift-priority'), 'high');
  for (const p of ['high', 'normal', 'low', 'paused']) {
    assert.equal(n.setPriority(p), true);
    assert.equal(el.getAttribute('dxr-lift-priority'), p);
  }
  n.setPriority('normal');
  n.hold('paused'); // tab hidden
  assert.equal(el.getAttribute('dxr-lift-priority'), 'paused');
  n.hold(null);
  assert.equal(el.getAttribute('dxr-lift-priority'), 'normal');
  n.setOff(true); // explore owns the pixels
  assert.equal(el.getAttribute('dxr-lift'), 'off');
  n.setOff(false);
  assert.equal(el.getAttribute('dxr-lift'), 'auto');
  n.clear();
  assert.deepEqual([...el.a.entries()].sort(), [['data-x', '1'], [LIFT_ATTRS.priority, 'low']], 'page attributes restored, ours removed');
  n.clear(); // idempotent
  assert.equal(normalizePriority('paused'), 'paused');
  assert.equal(normalizePriority(''), null);
});

/**
 * Native-mode control flow, as lift.js wires it: the machine runs with kind 'video' (an <img> too),
 * `startLive` applies the attributes, `enterExplore` turns the browser's conversion off,
 * `exitExplore` turns it back on, `suspend` holds priority 'paused', `dispose` clears.
 */
function nativeHarness(tag, { mode, preset = {}, ownLiftAttr = false } = {}) {
  const el = fakeEl(preset);
  const attrs = createNativeLiveAttrs(el, { depth: 1, priority: 'normal', ownLiftAttr });
  const effects = [];
  let paused = tag === 'IMG';
  const kind = tag === 'VIDEO' ? 'video' : 'still';
  // exactly what lift.js runs: resolveLiftMode, a still is a still unless explicitly 'live'
  const machineMode = resolveLiftMode({ native: true, kind, mode });
  const machineKind = kind === 'still' && machineMode === 'live' ? 'video' : kind;
  if (kind === 'still' && machineMode === 'explore' && ownLiftAttr) attrs.drop();
  const m = createLiftMachine({
    kind: machineKind,
    mode: machineMode,
    isPaused: () => kind === 'still' || paused,
    setTimer: (fn) => (fn(), 1),
    clearTimer: () => {},
    onEffect: (name) => {
      effects.push(name);
      if (name === 'startLive') attrs.apply();
      if (name === 'enterExplore') attrs.setOff(true);
      if (name === 'exitExplore') attrs.setOff(false);
      if (name === 'suspend') attrs.hold('paused');
      if (name === 'resume') attrs.hold(null);
      if (name === 'dispose') attrs.clear();
    },
  });
  return { el, m, effects, setPaused: (p) => (paused = p) };
}

test('native state machine: <img> with an EXPLICIT mode:\'live\' is browser-converted until explore(); resume goes back', async () => {
  const { el, m, effects } = nativeHarness('IMG', { mode: 'live' });
  m.send('start');
  m.send('loaded');
  assert.equal(m.state, STATES.LIVE, 'an image is LIVE in native mode, not lifted at once');
  assert.equal(el.getAttribute('dxr-lift'), 'auto');
  m.send('explore-request');
  assert.equal(m.state, STATES.FREEZING);
  m.send('frozen', { gen: m.gen });
  m.send('lifted', { gen: m.gen });
  assert.equal(m.state, STATES.EXPLORE);
  assert.equal(el.getAttribute('dxr-lift'), 'off');
  m.send('resume-request');
  assert.equal(m.state, STATES.LIVE, 'resume is synchronous');
  assert.equal(el.getAttribute('dxr-lift'), 'auto', 'the browser converts again in the same tick');
  // a failed lift on an image is NOT fatal in native mode: it goes back to the browser's live view
  m.send('explore-request');
  m.send('lift-failed', { gen: m.gen, error: new Error('x') });
  assert.equal(m.state, STATES.LIVE);
  assert.equal(el.getAttribute('dxr-lift'), 'auto');
  m.send('remove');
  assert.equal(el.a.size, 0, 'attributes cleared on remove');
  assert.ok(effects.includes('dispose'));
});

test('native state machine: <video> with an EXPLICIT mode:\'auto\' keeps the old behaviour: pause → explore, hidden → priority paused, play → live', () => {
  const { el, m, setPaused } = nativeHarness('VIDEO', { mode: 'auto' });
  m.send('start');
  m.send('loaded');
  assert.equal(el.getAttribute('dxr-lift'), 'auto');
  m.send('hidden');
  assert.equal(el.getAttribute('dxr-lift-priority'), 'paused');
  m.send('visible');
  assert.equal(el.getAttribute('dxr-lift-priority'), 'normal');
  setPaused(true);
  m.send('pause'); // debounce fires at once in the harness
  assert.equal(m.state, STATES.FREEZING);
  m.send('frozen', { gen: m.gen });
  m.send('lifted', { gen: m.gen });
  assert.equal(el.getAttribute('dxr-lift'), 'off');
  setPaused(false);
  m.send('play');
  assert.equal(m.state, STATES.LIVE);
  assert.equal(el.getAttribute('dxr-lift'), 'auto');
});

test('native: play while the explore work is in flight → live + dxr-lift="auto" in the same tick', () => {
  const { el, m, effects, setPaused } = nativeHarness('VIDEO', { mode: 'auto' });
  m.send('start');
  m.send('loaded');
  setPaused(true);
  m.send('pause'); // → freezing (the lift/depth fetch would be in flight)
  const gen = m.gen;
  m.send('frozen', { gen }); // → lifting (the generator / gaussians POST in flight)
  assert.equal(m.state, STATES.LIFTING);
  setPaused(false);
  m.send('play');
  assert.equal(m.state, STATES.LIVE);
  assert.equal(el.getAttribute('dxr-lift'), 'auto');
  assert.ok(effects.includes('cancelLift'));
  assert.equal(m.send('lifted', { gen }), false, 'the abandoned lift cannot land explore');
  assert.equal(el.getAttribute('dxr-lift'), 'auto');
  // Resume from explore: dxr-lift back to auto before the video's play event arrives
  setPaused(true);
  m.send('pause');
  m.send('frozen', { gen: m.gen });
  m.send('lifted', { gen: m.gen });
  assert.equal(el.getAttribute('dxr-lift'), 'off');
  m.send('resume-request');
  assert.equal(m.state, STATES.LIVE);
  assert.equal(el.getAttribute('dxr-lift'), 'auto');
  assert.ok(!effects.includes('playMedia'), 'Resume returns to the paused frame, it never plays');
});

test('native Resume from explore: live on the PAUSED frame, dxr-lift="auto", no play; a later play stays live', () => {
  const { el, m, effects, setPaused } = nativeHarness('VIDEO');
  m.send('start');
  m.send('loaded');
  setPaused(true);
  m.send('pause');
  m.send('explore-request'); // chip Explore
  m.send('frozen', { gen: m.gen });
  m.send('lifted', { gen: m.gen });
  assert.equal(m.state, STATES.EXPLORE);
  assert.equal(el.getAttribute('dxr-lift'), 'off');
  m.send('resume-request'); // chip Resume
  assert.equal(m.state, STATES.LIVE);
  assert.equal(el.getAttribute('dxr-lift'), 'auto', 'the browser converts the paused frame again');
  assert.ok(!effects.includes('playMedia'));
  const n = effects.length;
  m.send('pause-settled'); // a stray settle: native default mode never re-lifts the paused frame
  assert.equal(m.state, STATES.LIVE);
  setPaused(false);
  m.send('play'); // the page's own controls
  assert.equal(m.state, STATES.LIVE);
  assert.equal(el.getAttribute('dxr-lift'), 'auto');
  assert.deepEqual(effects.slice(n), []);
});

test('native default mode is live: a paused <video> stays live — no freeze, no lift, no depth fetch', () => {
  const { el, m, effects, setPaused } = nativeHarness('VIDEO'); // no mode stated
  assert.equal(m.mode, 'live');
  m.send('start');
  m.send('loaded');
  setPaused(true);
  m.send('pause'); // the harness fires the debounce at once
  m.send('pause-settled');
  m.send('ended');
  assert.equal(m.state, STATES.LIVE);
  assert.equal(el.getAttribute('dxr-lift'), 'auto', 'the vendor module keeps weaving the paused frame');
  // freeze is what starts the depth fetch (doFreeze → stillDepthFor → POST lift/depth) and the lift
  for (const e of ['freeze', 'lift', 'enterExplore', 'pauseMedia']) assert.ok(!effects.includes(e), `no ${e}`);
});

test('native default mode: explore() still lifts the paused frame', () => {
  const { el, m, effects, setPaused } = nativeHarness('VIDEO');
  m.send('start');
  m.send('loaded');
  setPaused(true);
  m.send('pause');
  assert.equal(m.state, STATES.LIVE);
  m.send('explore-request'); // chip Explore / handle.explore()
  assert.equal(m.state, STATES.FREEZING);
  assert.ok(effects.includes('freeze'));
  m.send('frozen', { gen: m.gen });
  m.send('lifted', { gen: m.gen });
  assert.equal(m.state, STATES.EXPLORE);
  assert.equal(el.getAttribute('dxr-lift'), 'off');
});

test('native <img> (default): straight to explore — no live phase, no dxr-lift ever set; the menu\'s pre-set "auto" is dropped', () => {
  const { el, m, effects } = nativeHarness('IMG', { preset: { 'dxr-lift': 'auto' }, ownLiftAttr: true });
  assert.equal(el.hasAttribute('dxr-lift'), false, 'the browser menu\'s pre-set is taken away at once');
  const seen = [];
  const set = el.setAttribute;
  el.setAttribute = (n, v) => (seen.push([n, v]), set(n, v));
  const states = [];
  m.send('start');
  states.push(m.state);
  m.send('loaded');
  states.push(m.state);
  assert.equal(m.state, STATES.FREEZING, 'loaded → freezing: no live phase');
  m.send('frozen', { gen: m.gen });
  m.send('lifted', { gen: m.gen });
  assert.equal(m.state, STATES.EXPLORE);
  assert.deepEqual(states, ['loading', 'freezing']);
  assert.ok(!effects.includes('startLive'), 'no native live stream');
  assert.deepEqual(seen, [], 'no dxr-lift* attribute written, ever');
  // Resume does not apply to a picture; Exit removes it
  assert.equal(m.send('resume-request'), false);
  assert.equal(m.state, STATES.EXPLORE);
  m.send('remove');
  assert.equal(el.a.size, 0);
});

test('native <img> lift failure is an error (nothing live to fall back to)', () => {
  const { m } = nativeHarness('IMG', { ownLiftAttr: true });
  m.send('start');
  m.send('loaded');
  m.send('lift-failed', { gen: m.gen, error: new Error('x') });
  assert.equal(m.state, STATES.ERROR);
});

test('resolveLiftMode: native defaults to live, stated modes are honoured; the web path is unchanged', () => {
  // web path
  assert.equal(resolveLiftMode({ native: false, kind: 'video' }), 'auto');
  assert.equal(resolveLiftMode({ native: false, kind: 'still' }), 'auto');
  assert.equal(resolveLiftMode({ native: false, kind: 'video', mode: 'live' }), 'live');
  assert.equal(resolveLiftMode({ native: false, kind: 'video', mode: 'explore' }), 'explore');
  // native: the default flips to live for videos AND stills
  assert.equal(resolveLiftMode({ native: true, kind: 'video' }), 'live');
  assert.equal(resolveLiftMode({ native: true, kind: 'still' }), 'explore', 'a picture goes straight to explore');
  assert.equal(resolveLiftMode({ native: true, kind: 'video', mode: 'bogus' }), 'live');
  // …but what the caller states is honoured
  assert.equal(resolveLiftMode({ native: true, kind: 'video', mode: 'auto' }), 'auto');
  assert.equal(resolveLiftMode({ native: true, kind: 'video', mode: 'explore' }), 'explore');
  assert.equal(resolveLiftMode({ native: true, kind: 'still', mode: 'explore' }), 'explore');
  assert.equal(resolveLiftMode({ native: true, kind: 'still', mode: 'auto' }), 'explore', "'auto' on a still lifts at once");
  assert.equal(resolveLiftMode({ native: true, kind: 'still', mode: 'live' }), 'live', 'an explicit live is honoured');
});

test('native attrs ownLiftAttr: a pre-set dxr-lift="auto" (the browser menu) is REMOVED on clear, with the rest', () => {
  const el = fakeEl({ [LIFT_ATTRS.lift]: 'auto', [LIFT_ATTRS.priority]: 'high', 'data-x': '1' });
  const n = createNativeLiveAttrs(el, { depth: 1, ownLiftAttr: true });
  n.apply();
  n.setConvergence(0.4);
  n.setOff(true); // explore
  n.clear(); // remove() / chip Exit / toggle-off
  for (const name of Object.values(LIFT_ATTRS)) assert.equal(el.hasAttribute(name), false, `${name} gone`);
  assert.equal(el.getAttribute('data-x'), '1', 'other attributes untouched');
  // removed before it ever applied (e.g. Exit while loading): the menu's pre-set still goes
  const el2 = fakeEl({ [LIFT_ATTRS.lift]: 'auto' });
  createNativeLiveAttrs(el2, { ownLiftAttr: true }).clear();
  assert.equal(el2.hasAttribute(LIFT_ATTRS.lift), false);
});

test('native attrs without ownLiftAttr: a page-owned dxr-lift survives (old restore behaviour)', () => {
  const el = fakeEl({ [LIFT_ATTRS.lift]: 'auto', [LIFT_ATTRS.strength]: '0.7' });
  const n = createNativeLiveAttrs(el, { depth: 1.5 });
  n.apply();
  n.setOff(true);
  assert.equal(el.getAttribute(LIFT_ATTRS.lift), 'off');
  n.clear();
  assert.equal(el.getAttribute(LIFT_ATTRS.lift), 'auto', 'restored');
  assert.equal(el.getAttribute(LIFT_ATTRS.strength), '0.7');
  assert.equal(el.hasAttribute(LIFT_ATTRS.priority), false);
  const el2 = fakeEl({ [LIFT_ATTRS.lift]: 'auto' });
  createNativeLiveAttrs(el2).clear(); // never applied, not owned: untouched
  assert.equal(el2.getAttribute(LIFT_ATTRS.lift), 'auto');
});

// ── the native depth provider ─────────────────────────────────────────────────────────────

const frame = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }); // encodeFrame passes Blobs through

test('parseNativeDepthResponse: binary + headers, JSON base64 / array, semantics, focal', async () => {
  const f = new Float32Array([1, 2, 3, 4, 5, 6]);
  let d = await parseNativeDepthResponse(new Response(f.buffer, {
    headers: { 'content-type': 'application/octet-stream', 'x-dxr-depth-width': '3', 'x-dxr-depth-height': '2', 'x-dxr-depth-semantics': 'metric', 'x-dxr-depth-focalpx': '2.5' },
  }));
  assert.equal(d.w, 3);
  assert.equal(d.h, 2);
  assert.equal(d.space, 'metric');
  assert.deepEqual([...d.data], [1, 2, 3, 4, 5, 6]);
  assert.equal(d.intrinsics.focalPx, 2.5);
  const b64 = Buffer.from(f.buffer).toString('base64');
  d = await parseNativeDepthResponse(jsonResponse({ w: 2, h: 3, semantics: 'inverse-depth', data: b64 }));
  assert.equal(d.space, 'disparity');
  assert.equal(d.data.length, 6);
  assert.equal(d.intrinsics, undefined);
  d = await parseNativeDepthResponse(jsonResponse({ width: 1, height: 2, semantics: 'disparity', data: [0.5, 0.25], focalPx: 9 }));
  assert.deepEqual([...d.data], [0.5, 0.25]);
  await assert.rejects(parseNativeDepthResponse(jsonResponse({ w: 2, h: 2, semantics: 'depth-ish', data: [1, 2, 3, 4] })), { code: 'format' });
  await assert.rejects(parseNativeDepthResponse(jsonResponse({ w: 2, h: 2, semantics: 'metric', data: [1, 2, 3] })), { code: 'format' });
});

test('native depth provider: POSTs the frame, no model load; falls back to ORT on error, sticks after 404', async () => {
  const calls = [];
  let status = 200;
  const fetch = browserFetch({
    [NATIVE_DEPTH_URL]: () =>
      status === 200 ? jsonResponse({ w: 1, h: 1, semantics: 'metric', data: [2], focalPx: 1 }) : new Response('no', { status }),
  }, calls);
  const fbCalls = { load: 0, estimate: 0 };
  let fbOpts = null;
  const fallback = (o) => {
    fbOpts = o;
    return {
      id: 'ort-webgpu', kind: 'still',
      load: async () => { fbCalls.load++; },
      estimate: async () => (fbCalls.estimate++, { data: new Float32Array([7]), w: 1, h: 1, space: 'disparity' }),
      reset() {}, dispose() {},
    };
  };
  let ortLoads = 0;
  const p = createNativeDepthProvider({ kind: 'still', fetch, fallback, loadOrt: async () => (ortLoads++, { fake: 'ort' }), modelSource: {} });
  await p.load();
  assert.equal(fbCalls.load, 0, 'no model at load');
  let d = await p.estimate({ source: frame });
  assert.equal(d.space, 'metric');
  assert.equal(p.info.source, 'native');
  assert.equal(calls[0].method, 'POST');
  status = 500; // a transient error → this frame falls back, the next one tries native again
  d = await p.estimate({ source: frame });
  assert.equal(d.space, 'disparity');
  assert.equal(fbCalls.load, 1);
  assert.equal(ortLoads, 1, 'onnxruntime loaded lazily, only for the fallback');
  assert.deepEqual(fbOpts.ort, { fake: 'ort' });
  status = 200;
  d = await p.estimate({ source: frame });
  assert.equal(d.space, 'metric', 'native again after a transient error');
  status = 404;
  await p.estimate({ source: frame });
  assert.equal(p.info.unsupported, true);
  const n = calls.length;
  status = 200;
  d = await p.estimate({ source: frame });
  assert.equal(calls.length, n, 'after a 404 the module is not asked again');
  assert.equal(d.space, 'disparity');
  assert.equal(fbCalls.load, 1, 'fallback loaded once');
});

test('native depth: registered at priority 100 for stills only and wins over ORT for model names', () => {
  const r = getRegistry();
  const offOrt = r.registerDepthProvider('t-ort', () => ({ id: 't-ort' }), { priority: 0 });
  try {
    const names = ensureNativeProviders(CAPS, { registry: r, fetch: outsideFetch });
    assert.ok(names.includes('native'));
    assert.equal(r.resolve('still').name, 'native');
    assert.notEqual(r.resolve('video')?.name, 'native', 'live video is the browser\'s job, not a provider');
    const p = r.getDepthProvider('moge3', { quality: 'medium', modelSource: {} });
    assert.equal(p.id, 'native');
    assert.deepEqual(ensureNativeProviders({ native: false }, { registry: r }), []);
  } finally {
    offOrt();
    r.registerDepthProvider('native', () => null, {})(); // unregister
    r.registerLiftProvider?.('native-gaussians', () => null, {})();
  }
});

// ── native gaussians ──────────────────────────────────────────────────────────────────────

test('native gaussians: .sog passes through, .ply needs X-DXR-Lift-Meta, 404 sticks, errors fall back', async () => {
  let reply = () => new Response(new Uint8Array([0x50, 0x4b, 3, 4, 9, 9]));
  const calls = [];
  const fetch = browserFetch({ [NATIVE_GAUSSIANS_URL]: () => reply() }, calls);
  const g = createNativeGaussiansLift({ fetch });
  assert.equal(g.needsDepth, false);
  let res = await g.generateLift({ rgb: frame });
  assert.ok(res.sog instanceof Uint8Array);
  assert.equal(sniffSplatFormat(res.sog), 'sog');
  const ply = new TextEncoder().encode('ply\nformat binary_little_endian 1.0\n');
  reply = () => new Response(ply, { headers: { 'x-dxr-lift-meta': JSON.stringify({ focalPx: 800, w: 1024, h: 576, pivotZ: 1.5 }) } });
  res = await g.generateLift({ rgb: frame });
  assert.ok(res.ply instanceof ArrayBuffer);
  assert.equal(res.meta.focalPx, 800);
  assert.equal(res.meta.pivotZ, 1.5);
  reply = () => new Response(ply);
  await assert.rejects(g.generateLift({ rgb: frame }), (e) => e.code === 'format' && e.fallback === true);
  reply = () => new Response(new Uint8Array([1, 2, 3, 4]));
  await assert.rejects(g.generateLift({ rgb: frame }), (e) => e.code === 'format');
  reply = () => new Response('nope', { status: 404 });
  await assert.rejects(g.generateLift({ rgb: frame }), (e) => e.code === 'unsupported' && e.fallback === true);
  const n = calls.length;
  await assert.rejects(g.generateLift({ rgb: frame }), (e) => e.code === 'unsupported');
  assert.equal(calls.length, n, 'not asked again after a 404');
});

test('gaussians provider selection: native-gaussians is the default only when the module lifts', () => {
  assert.equal(defaultLiftProviderFor(CAPS), 'native-gaussians');
  assert.equal(defaultLiftProviderFor({ ...CAPS, modes: ['depth', 'sbs'] }), null);
  assert.equal(defaultLiftProviderFor({ native: false, modes: ['gaussians'] }), null);
  assert.equal(defaultLiftProviderFor(CAPS, { lift: 'local' }), 'local', 'the caller\'s choice wins');
  const r = getRegistry();
  if (typeof r.registerLiftProvider !== 'function') return; // a registry without lift providers
  try {
    const names = ensureNativeProviders(CAPS, { registry: r, fetch: outsideFetch });
    assert.ok(names.includes('native-gaussians'));
    const p = r.getLiftProvider('native-gaussians', {});
    assert.equal(p.id, 'native-gaussians');
    assert.equal(r.getLiftProvider('auto', {}).id, 'native-gaussians', 'picked over the local generator');
    assert.equal(r.getLiftProvider('local', {}), null);
  } finally {
    r.registerDepthProvider('native', () => null, {})();
    r.registerLiftProvider('native-gaussians', () => null, {})();
  }
  assert.equal(r.getLiftProvider('auto', {}), null, 'without a native module: the local generator');
  // no gaussians mode → not registered
  assert.deepEqual(ensureNativeProviders({ ...CAPS, modes: ['depth'] }, { registry: r }), ['native']);
  r.registerDepthProvider('native', () => null, {})();
});

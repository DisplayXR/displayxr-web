// The C2 surface trim of `./call` (RFC 0003 §2): the deprecated wrappers the entry keeps for one
// release (warn once, then behave), the 1.29 option spellings folded into the new groups with a
// warning, the handle renames (`localFormat`, `cameraOff` getter + `setCameraOff`, `tile()`,
// `diagnostics()`, the warned `wall` / `format` / `sendHint`), the `display` event replacing
// `format`, and the dressing API: `theme` → CSS variables on the host, `theme.strings`, `part`
// names, `ui: 'tiles'`, `layout: 'none'`. Drives the real Call with the recording DOM.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installCallDom, doc, channels, FakeTrack, FakeStream } from './call-dom.mjs';

installCallDom();
const mod = await import('../js/inline3d-call.js');
const { addCall } = mod;
const { DEPRECATED_CALL_EXPORTS, LEGACY_OPTIONS, normalizeCallOptions } = await import('../js/call/options.js');
const { makeHello } = await import('../js/call/wire.js');
const { CALL_STRINGS } = await import('../js/call/ui.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** The first element under `n` (inclusive) carrying `part="name"` — the chrome's documented hook. */
const findPart = (n, name) => (n.attrs && n.attrs.part === name ? n : (n.children || []).map((c) => findPart(c, name)).find(Boolean));
const noSignal = { async join(room, hooks) { return { id: hooks.id, peers: [], send() {}, leave() {} }; } };
const onePeer = { async join(room, hooks) { return { id: hooks.id, peers: ['~~~~~~~~~~~'], send() {}, leave() {} }; } };
const monoCam = () => new FakeStream([new FakeTrack('video')]);
const base = (extra = {}) => ({ signaling: noSignal, room: 'R'.repeat(22), ui: false, audio: false, selfView: false, camera: monoCam(), format: 'mono', ...extra });

function captureWarn(fn) {
  const warned = [];
  const orig = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  const done = () => (console.warn = orig);
  try {
    const r = fn(warned);
    if (r && typeof r.then === 'function') return r.finally(done).then(() => warned);
    done();
    return warned;
  } catch (e) {
    done();
    throw e;
  }
}

test('the public surface: 9 public value exports + the 38 deprecated wrappers, and nothing else', () => {
  const names = Object.keys(mod).sort();
  const pub = ['CALL_EVENT_PREFIX', 'DXR_SIGNAL_DEFAULT', 'DxrCallElement', 'addCall', 'attrsToOpts', 'defineCallElement', 'dxrSignaling', 'mountCall', 'parseInviteLink'];
  assert.deepEqual(names, [...pub, ...DEPRECATED_CALL_EXPORTS].sort());
  assert.equal(DEPRECATED_CALL_EXPORTS.length, 38);
  assert.equal(mod.peerjsCloud, undefined, 'Decision 12: gone outright');
});

test('deprecated wrappers: a function warns ONCE on first call then works; an object warns on first read; a class constructs', () => {
  const warned = captureWarn(() => {
    assert.match(mod.newRoomId(), /^[A-Za-z0-9_-]{22}$/);
    assert.equal(mod.isValidRoomId('x'), false);
    mod.newRoomId();
    assert.equal(mod.PLATE_TEXT.unreachable, CALL_STRINGS.unreachable);
    assert.equal(mod.PLATE_TEXT.cameraBusy, CALL_STRINGS.cameraBusy);
    assert.equal(mod.CALL_ACCENTS.violet, '#9b7bff');
    assert.equal(mod.VIDEO_CODEC_ORDER[0], 'VP9');
    assert.deepEqual(mod.LIFT_PRIORITY, { speaker: 'high', other: 'normal', hidden: 'paused' });
    const t = new mod.MeshTransport({ signaling: noSignal, id: 'me', maxPeers: 2 });
    assert.equal(t.size, 0);
    assert.equal(mod.clampMaxPeers(9), 4);
    assert.equal(typeof mod.WIRE_VERSION, 'number');
    assert.equal(mod.CALL_SDK, 'inline3d-call/1');
    assert.equal(mod.SIGNAL_PROTOCOL, 'dxr-signal/1');
    assert.equal(mod.badgeFor('lifted'), '2D→3D');
    assert.equal(mod.normalizeCallOptions({}).room, 'auto');
  });
  const counts = {};
  for (const w of warned) {
    const m = /`(\w+)` is internal and leaves '@displayxr\/inline3d\/call' in 1\.31/.exec(w);
    assert.ok(m, `unexpected warning: ${w}`);
    counts[m[1]] = (counts[m[1]] || 0) + 1;
  }
  assert.deepEqual(counts, { newRoomId: 1, isValidRoomId: 1, PLATE_TEXT: 1, CALL_ACCENTS: 1, VIDEO_CODEC_ORDER: 1, LIFT_PRIORITY: 1, MeshTransport: 1, clampMaxPeers: 1, badgeFor: 1, normalizeCallOptions: 1 }, 'one warning per name, none for primitives');
  assert.ok(warned[0].includes('js/call/wire.js'), 'names the file-path import that keeps working');
});

test('legacy options: the 1.29 spellings fold into the C2 groups with one warning per key; the groups win', () => {
  const warned = captureWarn(() => {
    const o = normalizeCallOptions({ accent: 'violet', tileAspect: 4 / 3, inviteBase: 'https://a/', updateUrl: false, browserUrl: 'https://b/', maxLifted: 2, scrollIntoView: false, recoverSession: false, log: () => {}, wallOptions: {} });
    assert.equal(o.cssVars['--dxr-accent'], '#9b7bff');
    assert.equal(o.tileAspect, 4 / 3);
    assert.equal(o.invite.base, 'https://a/');
    assert.equal(o.invite.updateUrl, false);
    assert.equal(o.landing.browserUrl, 'https://b/');
    assert.equal(o.maxLifted, 2);
    assert.equal(typeof o.log, 'function');
    // The new spelling wins over the old one when both are given.
    const both = normalizeCallOptions({ accent: 'violet', theme: { accent: 'lime' }, maxLifted: 1, liftOptions: { max: 3 }, inviteBase: 'x', invite: { base: 'y' } });
    assert.equal(both.cssVars['--dxr-accent'], '#9be15d');
    assert.equal(both.maxLifted, 3);
    assert.equal(both.invite.base, 'y');
  });
  const keys = warned.map((w) => /option `(\w+)` is deprecated/.exec(w)?.[1]).filter(Boolean);
  assert.deepEqual([...new Set(keys)].sort(), ['accent', 'browserUrl', 'inviteBase', 'log', 'maxLifted', 'recoverSession', 'scrollIntoView', 'tileAspect', 'updateUrl', 'wallOptions']);
  assert.equal(keys.length, new Set(keys).size, 'each key warns once per process');
  for (const k of keys) assert.ok(warned.find((w) => w.includes(`\`${k}\``)).includes(LEGACY_OPTIONS[k]), `names the replacement for ${k}`);
  // Already warned above: silent now.
  assert.deepEqual(captureWarn(() => normalizeCallOptions({ accent: 'ice' })), []);
});

/** A remote mono peer arrives: hello over the data channel, then its video plays. */
function arriveMono() {
  const hello = makeHello({ format: 'mono', width: 640, height: 480 });
  for (const dc of channels) dc.onmessage && dc.onmessage({ data: JSON.stringify(hello) });
  const v = doc.created.filter((e) => e.tagName === 'VIDEO' && (e.listeners.playing || []).length).at(-1);
  Object.assign(v, { readyState: 4, videoWidth: 640, videoHeight: 480 });
  v.fire('playing');
}

test('handle: localFormat, cameraOff getter + setCameraOff, join() → void, tile(), diagnostics(), the display event, left.reason', { timeout: 10000 }, async () => {
  const host = doc.body.appendChild(doc.createElement('div'));
  const events = { display: [], left: [], format: [] };
  const call = await addCall({ supported: false }, host, base({ signaling: onePeer, autoJoin: false }));
  try {
    assert.equal(call.state, 'lobby');
    assert.equal(call.localFormat, 'mono');
    assert.equal(call.cameraOff, false);
    assert.equal(call.setCameraOff(), true);
    assert.equal(call.cameraOff, true);
    assert.equal(call.setCameraOff(false), false);
    call.on('display', (e) => events.display.push(e));
    call.on('left', (e) => events.left.push(e));
    const warned = await captureWarn(async () => {
      call.on('format', (e) => events.format.push(e));
      assert.equal(await call.join(), undefined, 'join() resolves void (RFC 0003 §2)');
    });
    assert.ok(warned.some((w) => w.includes("'format' event is deprecated") && w.includes("listen for 'display'")));
    assert.equal(call.state, 'in-call');
    arriveMono();
    for (let i = 0; i < 200 && !events.display.length; i++) await sleep(5);
    assert.deepEqual(events.display, [{ id: '~~~~~~~~~~~', display: '2D' }]);
    assert.equal(events.format.length, 1, "the 1.29 'format' event still fires for a listener that asked for it");
    assert.equal(events.format[0].route, 'flat');
    const p = call.peers[0];
    assert.deepEqual(Object.keys(p).sort(), ['cameraOff', 'display', 'format', 'id', 'muted', 'speaking', 'state'], 'CallPeer is the trimmed shape');
    const tile = call.tile('~~~~~~~~~~~');
    assert.ok(tile);
    assert.equal(tile.getAttribute('data-dxr-peer'), '~~~~~~~~~~~');
    assert.equal(tile.getAttribute('part'), 'tile');
    assert.equal(call.tile('nobody'), null);
    const d = call.diagnostics();
    assert.equal(d.wall.supported, false);
    assert.equal(d.peers[0].route, 'flat');
    assert.equal(d.peers[0].hello.format, 'mono');
    assert.equal(d.peers[0].element, tile);
    assert.equal(d.local.format, 'mono');
    assert.equal(d.sdk, 'inline3d-call/1');
    assert.equal(typeof d.kill, 'function');
  } finally {
    call.leave();
  }
  assert.deepEqual(events.left, [{ room: 'R'.repeat(22), reason: 'left' }]);
});

test('handle: the 1.29 members `wall`, `format`, `sendHint`, `_debug` warn once each and still answer', async () => {
  const host = doc.body.appendChild(doc.createElement('div'));
  const wall = { supported: false };
  const call = await addCall(wall, host, base());
  try {
    const warned = captureWarn(() => {
      assert.equal(call.wall, wall);
      assert.equal(call.wall, wall);
      assert.equal(call.format, 'mono');
      assert.equal(call.sendHint(600), true, 'the rate gate passes the first hint');
      assert.ok(call._debug.transport, 'ui: false auto-joined, so the mesh exists');
      assert.equal(typeof call._debug.kill, 'function');
    });
    assert.deepEqual(warned.map((w) => /handle\.(\w+) is deprecated/.exec(w)?.[1]), ['wall', 'format', 'sendHint', '_debug']);
    assert.ok(warned[0].includes('diagnostics().wall'));
    assert.ok(!Object.keys(call).includes('wall'), 'legacy members are not enumerable: a spread of the handle sees the C2 shape');
  } finally {
    call.leave();
  }
});

test('theme: CSS variables land on the host (chrome only), strings override the plates, parts name the chrome', { timeout: 10000 }, async () => {
  const host = doc.body.appendChild(doc.createElement('div'));
  const vars = {};
  host.style = { setProperty: (k, v) => (vars[k] = v), getPropertyValue: () => '' };
  const call = await addCall({ supported: false }, host, base({ ui: true, autoJoin: false, selfView: true, signaling: onePeer, theme: { accent: 'violet', ink: '#eee', shell: 'black', danger: 'red', radius: 6, font: 'serif', tileAspect: 4 / 3, strings: { lobbyJoinTitle: 'Rejoindre', connecting: 'Connexion…', banner2D: '2D ici', you: 'Moi' } } }));
  try {
    assert.deepEqual(vars, { '--dxr-accent': '#9b7bff', '--dxr-ink': '#eee', '--dxr-shell': 'black', '--dxr-danger': 'red', '--dxr-radius': '6px', '--dxr-font': 'serif' });
    const parts = (n, out = []) => {
      if (n.attrs && n.attrs.part) out.push(n.attrs.part);
      for (const c of n.children || []) parts(c, out);
      return out;
    };
    const found = parts(host);
    for (const p of ['banner', 'grid', 'lobby', 'self', 'bar', 'invite', 'tile', 'badge', 'plate']) assert.ok(found.includes(p), `part="${p}" present`);
    const lobbyTitle = findPart(host, 'lobby').children[0];
    assert.equal(lobbyTitle.textContent, 'Rejoindre', 'theme.strings reaches the lobby (the room is preset, so it is the join title)');
    const banner = findPart(host, 'banner');
    assert.equal(banner.children[0].textContent, '2D ici');
    const selfBadge = findPart(findPart(host, 'self'), 'badge');
    assert.equal(selfBadge.children[0].textContent, 'Moi · 2D');
    await call.join();
    arriveMono();
    await sleep(30);
    const tile = call.tile('~~~~~~~~~~~');
    const plate = findPart(tile, 'plate');
    assert.equal(plate.textContent, 'Connexion…', 'theme.strings reaches a tile plate');
    assert.equal(tile.children[0].style.aspectRatio, String(4 / 3), 'theme.tileAspect is the tile aspect');
  } finally {
    call.leave();
  }
});

test("ui: 'tiles' keeps badges + plates and builds no bar / lobby; layout: 'none' marks the grid so the page lays tiles out", async () => {
  const host = doc.body.appendChild(doc.createElement('div'));
  const call = await addCall({ supported: false }, host, base({ ui: 'tiles', layout: 'none', signaling: onePeer }));
  try {
    assert.equal(call.state, 'in-call', "'tiles' has no lobby: autoJoin defaults on");
    const bar = findPart(host, 'bar'); // inside the footer, next to the self view
    assert.equal(bar.children.length, 0, 'no buttons were built');
    assert.ok(bar.classList.contains('dxr-call-hidden'));
    const grid = findPart(host, 'grid');
    assert.equal(grid.getAttribute('data-layout'), 'none');
    arriveMono();
    await sleep(30);
    const tile = call.tile('~~~~~~~~~~~');
    const badge = findPart(tile, 'badge');
    assert.ok(!badge.classList.contains('dxr-call-hidden'), "badges stay with ui: 'tiles'");
    assert.ok(!tile.classList.contains('dxr-call-tile--main'), 'layout none positions nothing');
  } finally {
    call.leave();
  }
  const bare = await addCall({ supported: false }, doc.body.appendChild(doc.createElement('div')), base({ ui: false, signaling: onePeer }));
  try {
    arriveMono();
    await sleep(30);
    const badge = findPart(bare.tile('~~~~~~~~~~~'), 'badge');
    assert.ok(badge.classList.contains('dxr-call-hidden'), 'ui: false hides the badges too');
  } finally {
    bare.leave();
  }
});

// display-modes — read what the panel IS, and ask it to change.
//
// Three questions and one request, on the wall (and on every tile handle — same names):
//
//   wall.getDisplayInfo()          the panel: metres, pixels, the view scale it recommends
//   wall.getRenderingModes()       every mode the runtime can put it in
//   wall.requestRenderingMode(i)   switch to mode i — THE ONLY REQUEST THERE IS
//   wall.setStereoEnabled(bool)    sugar: pick the first requestable 1-view / 2-view mode
//   wall.on(type, cb)              'renderingmodechange' / 'hardwaredisplaystatechange'
//
// THE ONE THING WORTH UNDERSTANDING. There is no page-facing control over the panel's HARDWARE
// DISPLAY STATE (2D or 3D) and there should not be: that state is a CONSEQUENCE of the active
// rendering mode. Request a mode with viewCount 1 and the browser puts the panel flat and reports
// that mode active — while the runtime carries on weaving the same fixed two-view atlas. Request
// the 2-view mode and it comes back. Tying the two together is what makes "flat panel showing a
// stereo atlas" — a blurry double image — unreachable.
//
// The SDK does the other half automatically: when a 1-view mode goes ACTIVE it zeroes every
// window's rig (ipdFactor/parallaxFactor -> 0, both eyes from one place) and restores it when a
// 2-view mode does — driven by the event, not by the request, so a refused request changes
// nothing and this page's own rendering code is untouched either way.
//
// SCALES ARE ADVISORY. `viewScaleX/Y` and `recommendedViewScaleX/Y` are what the runtime would
// LIKE the per-view resolution to be; the browser cannot resize a page's canvas, so honouring
// them means sizing your own backing store — see applyViewScale(), which runs on every
// renderingmodechange.
//
// EVERY ACTION LOGS A GREPPABLE LINE (`[display-modes] …`) so a harness can drive this page and
// read the outcome from the console instead of the pixels. The exact strings:
//
//   [display-modes] supported <true|false>
//   [display-modes] display <PXxPY>px <WxH>m recommended-scale <sx>,<sy>
//   [display-modes] display none            (no glasses-free display on this machine)
//   [display-modes] modes <n> active <index> requestable <n>
//   [display-modes] mode -> <index>
//   [display-modes] mode ok <index>
//   [display-modes] mode failed <index> <message>     (no API / no live layer / SDK error)
//   [display-modes] mode refused <index> <message>    (the browser or runtime declined)
//   [display-modes] event renderingmodechange <index>
//   [display-modes] event hardwaredisplaystatechange <2d|3d>
//   [display-modes] stereo -> <on|off>       (the setStereoEnabled convenience button)
//   [display-modes] stereo ok <on|off> / stereo failed <on|off> <message>
//   [display-modes] view-scale <sx>,<sy> buffer <w>x<h>

import * as THREE from 'three';
import { createInline3D, inline3dDisplayModesSupported } from '@displayxr/inline3d';
import { EyeCamera } from '@displayxr/inline3d/three';

const TAG = '[display-modes]';
const log = (...a) => console.log(TAG, ...a);

const canvas = document.getElementById('tile');
const statusEl = document.getElementById('status');
const badgeEl = document.getElementById('badge');
const infoEl = document.getElementById('info');
const modesEl = document.getElementById('modes');
const logEl = document.getElementById('log');
const stereoBtn = document.getElementById('stereo');
const refreshBtn = document.getElementById('refresh');

// Capability up front and in the log, because a page whose display controls silently do nothing
// looks exactly like a page whose display controls are broken.
const MODES_OK = inline3dDisplayModesSupported();
log('supported', MODES_OK);

// ---- state ---------------------------------------------------------------------------------
const S = {
  // Everything here is REPORTED, never requested: `hw` comes from hardwaredisplaystatechange and
  // `viewCount`/`activeMode` from the mode list. A request that is refused must leave the badge
  // exactly as it was, and the only way to guarantee that is to never write these from a request.
  hw: null,            // '2d' | '3d' | null (the browser has not said yet)
  activeMode: -1,
  viewCount: 0,
  viewScale: { x: 1, y: 1 },
};

// ---- scene ---------------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
// pixelRatio MUST be 1: layer.getViewport() reports BACKING-STORE pixels and three multiplies
// setViewport/setScissor by the renderer's pixelRatio, so anything else silently scales each
// eye's viewport. We size the backing store in device px ourselves.
renderer.setPixelRatio(1);
renderer.autoClear = false;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0c12);
scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x14203a, 1.0));
const key = new THREE.DirectionalLight(0xffffff, 1.1);
key.position.set(1.2, 2.0, 1.4);
scene.add(key);

// Three bars at three depths. Depth is the point of this page: when a 1-view mode goes active the
// SDK flattens the rig and they collapse onto one plane, which is what "the stereo faded to zero"
// looks like from the couch — and it happens with no change to the render code below.
const bars = [];
for (let i = 0; i < 3; i++) {
  const bar = new THREE.Mesh(
    new THREE.BoxGeometry(0.05, 0.05, 0.05),
    new THREE.MeshStandardMaterial({ color: [0xd8823a, 0x4ea3d8, 0x7ee2a4][i], roughness: 0.5 }),
  );
  bar.position.set((i - 1) * 0.075, 0, (i - 1) * 0.06);
  scene.add(bar);
  bars.push(bar);
}
const grid = new THREE.GridHelper(0.6, 12, 0x4d5a80, 0x2b3350);
grid.position.y = -0.06;
scene.add(grid);

const eyes = [new EyeCamera(THREE), new EyeCamera(THREE)];
const monoCam = new THREE.PerspectiveCamera(45, 16 / 9, 0.01, 20);
monoCam.position.set(0, 0.1, 0.5);
monoCam.lookAt(0, 0, 0);

// ---- backing store ---------------------------------------------------------------------------
// DOUBLE-WIDTH in device px while woven (left eye | right eye): getViewport() splits canvas.width
// in half, so each eye gets a full-resolution half, and the browser squashing that 2:1 buffer
// into the 16:9 CSS box IS the side-by-side squeeze the weave un-squeezes. `S.viewScale` is the
// advisory scale from the active mode, applied HERE because it is the only place it can be: the
// browser cannot touch a page's canvas.
let sbsMode = false;
function sizeToCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round((canvas.clientWidth || 640) * dpr * S.viewScale.x));
  const h = Math.max(1, Math.round((canvas.clientHeight || 360) * dpr * S.viewScale.y));
  renderer.setSize(sbsMode ? w * 2 : w, h, false);
  monoCam.aspect = (canvas.clientWidth || 640) / (canvas.clientHeight || 360);
  monoCam.updateProjectionMatrix();
  return { w: sbsMode ? w * 2 : w, h };
}
window.addEventListener('resize', () => sizeToCanvas());

// ---- render loops -----------------------------------------------------------------------------
function onXRFrame(views, layer) {
  // Validate BEFORE clearing. renderer.clear() is the point of no return: under load the session
  // can hand back a short view list or a null viewport, and an empty buffer is what the weave then
  // consumes — one dark tile, nothing thrown, nothing logged.
  if (!views || views.length < 2 || !layer) return;
  const vps = views.map((v) => layer.getViewport(v));
  if (vps.some((vp) => !vp || vp.width <= 0 || vp.height <= 0)) return;
  const t = performance.now() * 0.0006;
  for (let i = 0; i < bars.length; i++) bars[i].rotation.set(t * 0.7, t + i, 0);
  renderer.clear();
  renderer.setScissorTest(true);
  for (let i = 0; i < 2; i++) {
    const vp = vps[i];
    renderer.setViewport(vp.x, vp.y, vp.width, vp.height);
    renderer.setScissor(vp.x, vp.y, vp.width, vp.height);
    eyes[i].setFromView(views[i]);
    renderer.render(scene, eyes[i].camera);
  }
  renderer.setScissorTest(false);
}

function onMonoFrame() {
  requestAnimationFrame(onMonoFrame);
  const t = performance.now() * 0.0006;
  for (let i = 0; i < bars.length; i++) bars[i].rotation.set(t * 0.7, t + i, 0);
  renderer.clear();
  const size = new THREE.Vector2();
  renderer.getSize(size);
  renderer.setViewport(0, 0, size.x, size.y);
  renderer.render(scene, monoCam);
}

// ---- the event log --------------------------------------------------------------------------
function line(text, cls) {
  if (logEl.firstChild && logEl.firstChild.textContent === 'waiting…') logEl.textContent = '';
  const div = document.createElement('div');
  if (cls) div.className = cls;
  const now = new Date();
  div.textContent = `${now.toTimeString().slice(0, 8)}  ${text}`;
  logEl.prepend(div);
  while (logEl.childElementCount > 120) logEl.lastChild.remove();
}

// The badge is READ-ONLY and reports only what the display told us. `—` before the first
// hardwaredisplaystatechange is the honest answer; inventing '3d' there would make a page that
// never gets the event look identical to one that does.
function updateBadge() {
  const hw = S.hw || '—';
  const rig = wall && wall.stereoCollapsed ? 'flat (ipd 0)' : 'stereo';
  badgeEl.innerHTML = `hardware display state <b>${hw}</b> · mode ${S.activeMode} · rig ${rig}`;
  if (stereoBtn) stereoBtn.textContent = S.viewCount === 1 ? 'Go 3D (2-view mode)' : 'Go 2D (1-view mode)';
}

// ---- reading the display ----------------------------------------------------------------------
let wall = null;
let handle = null;

async function readDisplayInfo() {
  const info = await wall.getDisplayInfo();
  if (!info) {
    infoEl.innerHTML = '<dt>display</dt><dd>none — no glasses-free display on this machine</dd>';
    log('display none');
    return null;
  }
  S.viewScale = { x: info.recommendedViewScaleX || 1, y: info.recommendedViewScaleY || 1 };
  const rows = [
    ['physical', `${info.displayWidthMeters.toFixed(3)} × ${info.displayHeightMeters.toFixed(3)} m`],
    ['pixels', `${info.displayPixelWidth} × ${info.displayPixelHeight}`],
    ['recommended view scale', `${info.recommendedViewScaleX} × ${info.recommendedViewScaleY}`],
    ['ppi (derived)', `${(info.displayPixelWidth / (info.displayWidthMeters * 39.3701)).toFixed(0)}`],
  ];
  infoEl.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  log(
    'display',
    `${info.displayPixelWidth}x${info.displayPixelHeight}px`,
    `${info.displayWidthMeters.toFixed(3)}x${info.displayHeightMeters.toFixed(3)}m`,
    'recommended-scale',
    `${info.recommendedViewScaleX},${info.recommendedViewScaleY}`,
  );
  return info;
}

const COLS = [
  ['#', (m) => m.modeIndex],
  ['mode', (m) => m.name ?? m.modeName],
  ['views', (m) => m.viewCount],
  ['tiles', (m) => `${m.tileColumns}×${m.tileRows}`],
  ['view px', (m) => `${m.viewWidthPixels}×${m.viewHeightPixels}`],
  ['view scale', (m) => `${m.viewScaleX}×${m.viewScaleY}`],
  ['hw 3D', (m) => (m.hardwareDisplay3D ? 'yes' : 'no')],
];

async function readModes() {
  const modes = await wall.getRenderingModes();
  const head = `<tr>${COLS.map(([h]) => `<th>${h}</th>`).join('')}<th></th></tr>`;
  const body = modes
    .map((m) => {
      // A 1-view mode is offered like any other — requesting it is HOW a page goes flat. Only
      // two things block a row, and they must not be conflated: the runtime said
      // isRequestable:false, or the mode needs more views than this browser can ever render.
      const tooManyViews = m.viewCount > 2;
      const blocked = tooManyViews || !m.isRequestable;
      const cls = [m.isActive ? 'active' : '', blocked ? 'blocked' : ''].filter(Boolean).join(' ');
      const why = tooManyViews
        ? '<span class="why">needs more than 2 views — the browser renders exactly 2</span>'
        : !m.isRequestable
          ? '<span class="why">not requestable</span>'
          : m.isActive
            ? ''
            : `<button data-mode="${m.modeIndex}">request</button>`;
      return `<tr class="${cls}">${COLS.map(([, f]) => `<td>${f(m)}</td>`).join('')}<td>${why}</td></tr>`;
    })
    .join('');
  modesEl.innerHTML = `<thead>${head}</thead><tbody>${body}</tbody>`;
  for (const btn of modesEl.querySelectorAll('button[data-mode]')) {
    btn.addEventListener('click', () => requestMode(Number(btn.dataset.mode)));
  }
  const active = modes.find((m) => m.isActive);
  S.activeMode = active ? active.modeIndex : -1;
  S.viewCount = active ? active.viewCount : 0;
  log(
    'modes',
    modes.length,
    'active',
    S.activeMode,
    'requestable',
    modes.filter((m) => m.isRequestable && m.viewCount <= 2).length,
  );
  if (active) applyViewScale(active);
  updateBadge();
  return modes;
}

// The advisory half, made concrete: the active mode says what per-view resolution it wants, and
// the ONLY thing that can act on that is the page, by resizing its own backing store.
function applyViewScale(mode) {
  S.viewScale = { x: mode.viewScaleX || 1, y: mode.viewScaleY || 1 };
  const { w, h } = sizeToCanvas();
  log('view-scale', `${S.viewScale.x},${S.viewScale.y}`, 'buffer', `${w}x${h}`);
}

// ---- the one request ---------------------------------------------------------------------------
// REFUSED vs FAILED. A TypeError (view count / unknown index) or a NotSupportedError is the
// browser or the runtime DECLINING a well-formed request — that is `refused`. Anything else (no
// API on this browser, no live weave layer yet, an SDK error) never reached them — that is
// `failed`. Conflating the two is how "the panel would not switch" gets debugged in the wrong
// process for an afternoon.
function classify(e) {
  const name = e && e.name;
  return name === 'TypeError' || name === 'NotSupportedError' ? 'refused' : 'failed';
}

async function requestMode(index) {
  log('mode ->', index);
  line(`requestRenderingMode(${index})`, 'req');
  try {
    await wall.requestRenderingMode(index);
    log('mode ok', index);
  } catch (e) {
    log(`mode ${classify(e)}`, index, e && e.message);
    line(`${classify(e)}: ${e && e.message}`, 'err');
  }
}

// The convenience button: sugar over the same one request. It picks the first requestable 1-view
// (or 2-view) mode and asks for it — it does NOT touch the hardware state, because nothing can.
async function toggleStereo() {
  const next = S.viewCount === 1; // currently flat -> go back to stereo
  const label = next ? 'on' : 'off';
  log('stereo ->', label);
  line(`setStereoEnabled(${next})`, 'req');
  stereoBtn.disabled = true;
  try {
    await wall.setStereoEnabled(next);
    log('stereo ok', label);
  } catch (e) {
    log('stereo failed', label, e && e.message);
    line(`${classify(e)}: ${e && e.message}`, 'err');
  } finally {
    stereoBtn.disabled = false;
  }
}

// ---- boot ---------------------------------------------------------------------------------------
(async () => {
  updateBadge();
  wall = await createInline3D({ lazy: false, autoChrome: false });
  if (!wall.supported) {
    statusEl.className = 'status flat';
    statusEl.innerHTML =
      '<b>2D fallback</b> — open in the ' +
      '<a href="https://github.com/DisplayXR/displayxr-browser">DisplayXR Browser</a> on a ' +
      'DisplayXR display. The scene below still runs flat; the display controls need the browser.';
    requestAnimationFrame(onMonoFrame);
    return;
  }
  sbsMode = true;
  sizeToCanvas();
  handle = wall.addScene(canvas, onXRFrame, { virtualDisplayHeight: 0.24 });
  statusEl.className = 'status woven';

  if (!MODES_OK) {
    statusEl.innerHTML =
      '<b style="color:#fbbf24">inline-3D active, no display-mode API</b> — this browser weaves, ' +
      'but exposes none of getDisplayInfo / getRenderingModes / requestRenderingMode, so the ' +
      'controls stay disabled.';
    line('inline3dDisplayModesSupported() === false — nothing to drive', 'err');
    return;
  }
  statusEl.innerHTML =
    '<b style="color:#4ade80">inline-3D active</b> — display-mode API present; the controls below ' +
    'are live';

  // The two events, re-emitted on the wall. They carry the new state, so nothing here has to
  // guess — and the badge only ever moves because one of these fired.
  wall.on('renderingmodechange', (ev) => {
    log('event renderingmodechange', ev.modeIndex);
    line(`event renderingmodechange → active mode ${ev.modeIndex}`, 'ev');
    // Re-read: the whole table's isActive column moved, and the new mode's advisory view scale
    // is what the backing store should now be sized to.
    readModes().catch(() => {});
  });
  wall.on('hardwaredisplaystatechange', (ev) => {
    S.hw = ev.state || S.hw;
    log('event hardwaredisplaystatechange', ev.state);
    line(`event hardwaredisplaystatechange → ${ev.state}`, 'ev');
    updateBadge();
  });

  stereoBtn.disabled = false;
  refreshBtn.disabled = false;
  stereoBtn.addEventListener('click', toggleStereo);
  refreshBtn.addEventListener('click', () => {
    readDisplayInfo().catch((e) => line(`getDisplayInfo failed: ${e.message}`, 'err'));
    readModes().catch((e) => line(`getRenderingModes failed: ${e.message}`, 'err'));
  });

  try {
    await readDisplayInfo();
    await readModes();
  } catch (e) {
    line(`initial read failed: ${e.message}`, 'err');
  }
})();

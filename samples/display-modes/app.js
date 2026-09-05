// display-modes — read what the panel IS, and ask it to change.
//
// Four questions and two requests, all on the tile handle:
//
//   handle.getDisplayInfo()          the panel: metres, pixels, the view scale it recommends
//   handle.getRenderingModes()       every mode the runtime can put it in
//   handle.requestRenderingMode(i)   switch to mode i (2-view modes only — see below)
//   handle.requestDisplayMode(m)     flip the LENS, '2d' or '3d', and NOTHING else
//   handle.setStereoEnabled(bool)    the lens AND the rig, which is what you almost always want
//   handle.onDisplayModeChange(cb)   both session events, one callback
//
// THE ONE THING WORTH UNDERSTANDING. `requestDisplayMode('2d')` changes nothing about the page:
// it keeps submitting stereo and the runtime keeps weaving it. What the flat panel then shows is
// the woven ATLAS — two slightly different images averaged into one, which reads as a blurry
// double image. Sharp 2D needs the page to fade its own stereo out too, which is exactly what
// `setStereoEnabled(false)` does (lens -> 2d AND rig ipd/parallax -> 0). The "Lens only" button
// here is the wrong half, kept deliberately so the difference is visible on the panel rather than
// only described in a comment.
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
//   [display-modes] lens -> 2d              (setStereoEnabled — lens AND rig)
//   [display-modes] lens ok 2d
//   [display-modes] lens failed 2d <message>
//   [display-modes] lens-only -> 2d         (requestDisplayMode alone — the blurry half)
//   [display-modes] lens-only ok 2d
//   [display-modes] lens-only failed 2d <message>
//   [display-modes] mode -> <index>
//   [display-modes] mode ok <index>
//   [display-modes] mode refused <index> <message>
//   [display-modes] event renderingmodechange <index>
//   [display-modes] event hardwaredisplaystatechange <2d|3d>
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
const lensBtn = document.getElementById('lens');
const lensOnlyBtn = document.getElementById('lensOnly');
const refreshBtn = document.getElementById('refresh');

// Capability up front and in the log, because a page whose display controls silently do nothing
// looks exactly like a page whose display controls are broken.
const MODES_OK = inline3dDisplayModesSupported();
log('supported', MODES_OK);

// ---- state ---------------------------------------------------------------------------------
const S = {
  stereo: true,        // what setStereoEnabled last put in force
  lens: '3d',          // the page's BELIEF about the lens — the API exposes no getter for it, so
                       // this is what we last asked for, not what the panel reports
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

// Three bars at three depths. Depth is the point of this page: with the rig flat they collapse
// onto one plane, which is what "the stereo faded to zero" looks like from the couch.
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

function updateBadge() {
  badgeEl.innerHTML = `lens <b>${S.lens}</b> · rig ${S.stereo ? 'stereo' : 'flat (ipd 0)'}`;
  lensBtn.textContent = S.stereo ? 'Go 2D (lens + rig)' : 'Back to 3D (lens + rig)';
  lensOnlyBtn.textContent = `Lens only → ${S.lens === '3d' ? '2d' : '3d'}`;
}

// ---- reading the display ----------------------------------------------------------------------
let handle = null;

async function readDisplayInfo() {
  const info = await handle.getDisplayInfo();
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
  ['mode', (m) => m.modeName],
  ['views', (m) => m.viewCount],
  ['tiles', (m) => `${m.tileColumns}×${m.tileRows}`],
  ['view px', (m) => `${m.viewWidthPixels}×${m.viewHeightPixels}`],
  ['view scale', (m) => `${m.viewScaleX}×${m.viewScaleY}`],
  ['hw 3D', (m) => (m.hardwareDisplay3D ? 'yes' : 'no')],
];

async function readModes() {
  const modes = await handle.getRenderingModes();
  const head = `<tr>${COLS.map(([h]) => `<th>${h}</th>`).join('')}<th></th></tr>`;
  const body = modes
    .map((m) => {
      // Two different reasons a row is not offered, and they must not be conflated: the runtime
      // said isRequestable:false, or the mode is not 2-view and this browser could never fill it.
      const fixedTwo = m.viewCount !== 2;
      const blocked = fixedTwo || !m.isRequestable;
      const cls = [m.isActive ? 'active' : '', blocked ? 'blocked' : ''].filter(Boolean).join(' ');
      const why = fixedTwo
        ? '<span class="why">not requestable in the browser (fixed 2-view)</span>'
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
  log(
    'modes',
    modes.length,
    'active',
    active ? active.modeIndex : -1,
    'requestable',
    modes.filter((m) => m.isRequestable && m.viewCount === 2).length,
  );
  if (active) applyViewScale(active);
  return modes;
}

// The advisory half, made concrete: the active mode says what per-view resolution it wants, and
// the ONLY thing that can act on that is the page, by resizing its own backing store.
function applyViewScale(mode) {
  S.viewScale = { x: mode.viewScaleX || 1, y: mode.viewScaleY || 1 };
  const { w, h } = sizeToCanvas();
  log('view-scale', `${S.viewScale.x},${S.viewScale.y}`, 'buffer', `${w}x${h}`);
}

// ---- the two requests --------------------------------------------------------------------------
async function requestMode(index) {
  log('mode ->', index);
  line(`requestRenderingMode(${index})`, 'req');
  try {
    await handle.requestRenderingMode(index);
    log('mode ok', index);
  } catch (e) {
    // A TypeError here is the fixed-2-view refusal (raised synchronously by the browser, handed
    // back as a rejection by the SDK); a NotSupportedError is the runtime declining.
    log('mode refused', index, e && e.message);
    line(`refused: ${e && e.message}`, 'err');
  }
}

// setStereoEnabled — BOTH halves. This is the button a real page ships.
async function toggleStereo() {
  const next = !S.stereo;
  const lens = next ? '3d' : '2d';
  log('lens ->', lens);
  line(`setStereoEnabled(${next}) → lens ${lens} + rig ${next ? 'restore' : 'ipd/parallax 0'}`, 'req');
  lensBtn.disabled = true;
  try {
    S.stereo = await handle.setStereoEnabled(next);
    S.lens = lens;
    log('lens ok', lens);
  } catch (e) {
    log('lens failed', lens, e && e.message);
    line(`refused: ${e && e.message}`, 'err');
  } finally {
    lensBtn.disabled = false;
    updateBadge();
  }
}

// requestDisplayMode alone — the WRONG half, on purpose. With the lens flat and the page still
// submitting stereo, the panel shows the woven atlas flat: a blurry double image. Keeping the
// button is the only way this page can demonstrate what the composite above is for.
async function toggleLensOnly() {
  const lens = S.lens === '3d' ? '2d' : '3d';
  log('lens-only ->', lens);
  line(`requestDisplayMode('${lens}') — lens ONLY, the rig is untouched`, 'req');
  try {
    await handle.requestDisplayMode(lens);
    S.lens = lens;
    log('lens-only ok', lens);
  } catch (e) {
    log('lens-only failed', lens, e && e.message);
    line(`refused: ${e && e.message}`, 'err');
  } finally {
    updateBadge();
  }
}

// ---- boot ---------------------------------------------------------------------------------------
(async () => {
  updateBadge();
  const wall = await createInline3D({ lazy: false, autoChrome: false });
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
      'but exposes none of getDisplayInfo / getRenderingModes / requestRenderingMode / ' +
      'requestDisplayMode, so the controls stay disabled.';
    line('inline3dDisplayModesSupported() === false — nothing to drive', 'err');
    return;
  }
  statusEl.innerHTML =
    '<b style="color:#4ade80">inline-3D active</b> — display-mode API present; the controls below ' +
    'are live';

  // Both session events, one callback. They fire on the XRSession, not the layer, and they carry
  // no payload dictionary — so what they mean is "go read it again", which is what this does.
  handle.onDisplayModeChange(async ({ type }) => {
    if (type === 'renderingmodechange') {
      let index = -1;
      try {
        const modes = await handle.getRenderingModes();
        index = modes.find((m) => m.isActive)?.modeIndex ?? -1;
      } catch {
        /* the read is best-effort; the event is still worth logging */
      }
      log('event renderingmodechange', index);
      line(`event renderingmodechange → active mode ${index}`, 'ev');
      readModes().catch(() => {});
    } else {
      // No lens GETTER exists in the API, so the value logged is the page's own last request —
      // honest about which it is rather than inventing a read-back.
      log('event hardwaredisplaystatechange', S.lens);
      line(`event hardwaredisplaystatechange → lens ${S.lens} (page's last request)`, 'ev');
      updateBadge();
    }
  });

  lensBtn.disabled = false;
  lensOnlyBtn.disabled = false;
  refreshBtn.disabled = false;
  lensBtn.addEventListener('click', toggleStereo);
  lensOnlyBtn.addEventListener('click', toggleLensOnly);
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

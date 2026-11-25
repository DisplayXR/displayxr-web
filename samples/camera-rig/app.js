// camera-rig — an app camera the runtime perturbs, instead of a portal onto a virtual display.
//
// The other samples declare a DISPLAY rig: the canvas plane is world z = 0, the viewer looks
// through it, and the scene is authored in metres to fit a virtual display so many centimetres
// tall. That is the right model for a window onto a fixed object, and it is why those samples
// never touch a camera.
//
// A scene that owns a VIEWPOINT the user moves through a world — first person, a walkthrough, a
// game, a ported VR experience — wants the opposite deal, and it could not be expressed before
// `setViewRig`: "here is MY camera; keep my framing, and make it stereo." That is a CAMERA rig.
// The app sends pose + vertical FOV + a convergence distance; the runtime offsets the eyes and
// skews each frustum so convergence lands on the zero-disparity plane. Not one line of projection
// math happens in this file, which is the whole point — the off-axis maths is the runtime's, the
// same code the native apps run.
//
// THIS SAMPLE ORBITS, and that is a teaching choice, not a recommendation: an orbit around a
// subject is a DISPLAY-rig case (rotate the subject under a fixed portal — see samples/windows/
// and the "Which rig" section of docs/authoring-inline-3d.md). It is used here because the A/B
// against a display rig on the C key needs one subject both rigs can show. Do not copy the rig
// choice out of this file into a model/splat/avatar viewer.
//
// DEPTH follows the camera-rig rule (docs/authoring-inline-3d.md § Aim for real depth):
//   1. convergence = the distance to the centre of interest (the orbit distance), so the cube
//      straddles the glass;
//   2. never rescale the world, set metersToVirtual: this world HAS a true scale (metres: a 40 cm
//      cube orbited from ~1.2 m), so metersToVirtual is 1 (a game world with no true scale would
//      use convergence / 2);
//   3. ipdFactor tunes the depth: the scene is bounded (the cube and a 4 m floor), so it is set
//      to `depth` × cameraRigComfortFactor(...), the multiplier that fills the comfort zone, from
//      the canvas's real size and the display's nominal viewing distance. Too little depth is a
//      failure too; the readout shows how much of the zone is used.
// The comfort product (ipdFactor × metersToVirtual × convergenceDiopters × N ≤ 1) is printed as
// what it is: the divergence ceiling for content at infinity, not a target. Nothing is clamped.

import * as THREE from 'three';
import { createInline3D, inline3dViewRigSupported, cameraRigComfortFactor, sceneBufferSize } from '@displayxr/inline3d';
import { EyeCamera, cameraRigFromCamera, displayRig } from '@displayxr/inline3d/three';

const canvas = document.getElementById('stage');
const statusEl = document.getElementById('status');
const panelEl = document.getElementById('panel');
const readoutEl = document.getElementById('readout');

// Capability, up front and in the log, because a page whose rig is silently ignored looks
// exactly like a page whose rig is wrong.
const RIG_OK = inline3dViewRigSupported();
console.log('[camera-rig] inline3dViewRigSupported() =', RIG_OK);

// ---- state the UI drives -------------------------------------------------------------------
const S = {
  fov: 45,            // degrees, the FULL vertical angle (three's convention)
  yaw: 0,
  pitch: 0.18,
  radius: 1.2,        // metres from the cube — also the default convergence distance
  convergence: 0,     // 0 = follow the orbit distance
  depth: 0.9,         // share of the comfort zone the scene's nearest / farthest content fills
  attach: true,
  cameraRig: true,    // false = the display rig, toggled with C
};

// ---- scene ---------------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
// pixelRatio MUST be 1: layer.getViewport() reports BACKING-STORE pixels and three multiplies
// setViewport/setScissor by the renderer's pixelRatio, so anything else silently scales each
// eye's viewport — a scene that still head-tracks perfectly but is zoomed and off-centre, which
// reads as a projection bug and is not one. We size the backing store in device px ourselves.
renderer.setPixelRatio(1);
renderer.autoClear = false;

const scene = new THREE.Scene();
// A mid-tone background, not black: a bright edge on black is where the display ghosts first.
scene.background = new THREE.Color(0x5d6578);
scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x14203a, 1.0));
const key = new THREE.DirectionalLight(0xffffff, 1.1);
key.position.set(1.2, 2.0, 1.4);
scene.add(key);

const cube = new THREE.Mesh(
  new THREE.BoxGeometry(0.4, 0.4, 0.4),
  new THREE.MeshStandardMaterial({ color: 0xd8823a, roughness: 0.55, metalness: 0.1 }),
);
scene.add(cube);
// The floor: a soft, NON-repeating texture rather than a line grid. One-pixel lines alias and
// shimmer as the head moves, and a regular grid gives the eyes (and any depth check) nothing to
// lock onto but its period.
function floorTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#7d8799';
  g.fillRect(0, 0, 512, 512);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 900; i++) {
    const v = Math.round(95 + rnd() * 90);
    g.fillStyle = `rgba(${v},${v + 8},${v + 22},0.55)`;
    g.beginPath();
    g.arc(rnd() * 512, rnd() * 512, 4 + rnd() * 18, 0, Math.PI * 2);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(4, 4),
  new THREE.MeshStandardMaterial({ map: floorTexture(), roughness: 0.9 }),
);
floor.rotation.x = -Math.PI / 2;
floor.position.y = -0.5;
scene.add(floor);

// The app's own camera. IN THE SCENE on purpose: the attach pattern parents the eye cameras
// under it, and three only reaches a parented camera through a scene traversal (renderer.render
// auto-updates a camera solely when its `parent` is null).
const appCam = new THREE.PerspectiveCamera(S.fov, 16 / 9, 0.05, 100);
scene.add(appCam);

function placeCamera() {
  const cp = Math.cos(S.pitch);
  appCam.position.set(
    S.radius * cp * Math.sin(S.yaw),
    S.radius * Math.sin(S.pitch),
    S.radius * cp * Math.cos(S.yaw),
  );
  appCam.lookAt(0, 0, 0);
  appCam.fov = S.fov;
  appCam.updateProjectionMatrix();
}
placeCamera();

// ---- drag to orbit ---------------------------------------------------------------------------
let dragging = null;
canvas.addEventListener('pointerdown', (e) => {
  dragging = { x: e.clientX, y: e.clientY };
  canvas.classList.add('dragging');
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  S.yaw -= (e.clientX - dragging.x) * 0.006;
  S.pitch = Math.max(-1.2, Math.min(1.2, S.pitch + (e.clientY - dragging.y) * 0.005));
  dragging = { x: e.clientX, y: e.clientY };
  placeCamera();
});
const endDrag = () => { dragging = null; canvas.classList.remove('dragging'); };
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

// ---- backing store ---------------------------------------------------------------------------
// DOUBLE-WIDTH in device pixels while woven (left eye | right eye): getViewport() splits
// canvas.width in half, so each eye gets a full-resolution half, and the browser squashing that
// 2:1 buffer into the 16:9 CSS box IS the side-by-side squeeze the weave un-squeezes. Mono stays
// 1:1 — the flat fallback draws the whole canvas.
// sceneBufferSize: per eye, window device px x the display's view scale (what a native app
// renders), else CSS box x dpr capped at 2, fitted to the GL limits and the browser's area cap.
let sbsMode = false;
let viewInfo = null; // handle.getDisplayInfo(), once woven
function sizeToCanvas(cssW = canvas.clientWidth || 640, cssH = canvas.clientHeight || 360) {
  const s = sceneBufferSize(canvas, { sbs: sbsMode, viewScale: sbsMode ? viewInfo : null, cssWidth: cssW, cssHeight: cssH });
  renderer.setSize(s.width, s.height, false);
  appCam.aspect = s.eyeWidth / s.eyeHeight;
  appCam.updateProjectionMatrix();
}
sizeToCanvas();
// Woven, the store is resized ONLY in the SDK's onResize (inside its ResizeObserver, before paint,
// with a redraw — see onResize below). The flat fallback watches the box itself (boot).

// ---- the two eye cameras ---------------------------------------------------------------------
// One EyeCamera per eye rather than one reused twice, because the attach pattern PARENTS them:
// they are scene-graph nodes with a lifetime, not scratch objects.
const eyes = [new EyeCamera(THREE), new EyeCamera(THREE)];

// attach on  → the eyes hang off appCam and read the view transform as a LOCAL pose (rig space).
// attach off → the eyes are loose in the world and read it as a WORLD pose.
// Flipping the parenting without flipping which setter is used would apply the camera's transform
// twice, so the two are decided together, in one place.
function setAttach(on) {
  for (const eye of eyes) {
    if (on && eye.camera.parent !== appCam) appCam.add(eye.camera);
    else if (!on && eye.camera.parent) eye.camera.parent.remove(eye.camera);
  }
}

// ---- the rig, rebuilt every frame ------------------------------------------------------------
// A rig applies per-locate: to animate one you send new values, so this runs in the frame loop
// with no tweening, no state and no teardown. Both descriptors are written into reused objects —
// a per-frame call has no business allocating.
const camScratch = {};
const dispScratch = {};

function convergenceDistance() {
  return S.convergence > 0 ? S.convergence : S.radius;
}

// The canvas in physical units (handle.displayMetrics(), refreshed on resize). Until it is known
// the eye separation is the real one (ipdFactor 1).
const metrics = { tileHeightM: 0, viewerM: 0.6 };
function readMetrics() {
  if (!handle) return;
  handle.displayMetrics().then((m) => {
    metrics.tileHeightM = m.canvasSizeM[1];
    metrics.viewerM = m.nominalViewerM;
  }).catch(() => {});
}

// Rule 3: the scene's nearest and farthest visible content (the cube's near corner, the floor's
// far corner) put at `S.depth` of the comfort zone's edge. A measurement; the page applies it.
function fillFactor() {
  if (!(metrics.tileHeightM > 0)) return NaN;
  return cameraRigComfortFactor({
    zNear: Math.max(0.05, S.radius - 0.35),
    zFar: S.radius + 2.8,
    convergence: convergenceDistance(),
    verticalFov: THREE.MathUtils.degToRad(S.fov),
    aspect: appCam.aspect,
    tileHeightM: metrics.tileHeightM,
    viewerM: metrics.viewerM,
    ipdFactor: 1,
    metersToVirtual: 1,
  });
}
function ipdFactorForDepth() {
  const k = fillFactor();
  return Number.isFinite(k) && k > 0 ? S.depth * k : 1;
}

function currentRig() {
  if (S.cameraRig) {
    const ipd = ipdFactorForDepth();
    return cameraRigFromCamera(THREE, appCam, {
      convergence: convergenceDistance(),
      metersToVirtual: 1,     // rule 2: a true-scale (metre) world
      ipdFactor: ipd,         // rule 3: the helper fills the zone
      parallaxFactor: ipd,    // look-around matches the stereo
      attach: S.attach,
      out: camScratch,
    });
  }
  // The display rig the C key switches to. Its height is the app camera's view height AT the
  // convergence plane — 2·d·tan(fov/2) — which is what makes the switch invisible at the home
  // angle: the same cube subtends the same fraction of the window under both rigs. It is a
  // continuity check, not an equivalence; orbit away and the display rig stays where it is,
  // because a portal has no camera to follow you.
  const d = convergenceDistance();
  return displayRig({
    virtualDisplayHeight: 2 * d * Math.tan(THREE.MathUtils.degToRad(S.fov) / 2),
    out: dispScratch,
  });
}

let handle = null;
function pushRig() {
  if (!handle) return;
  // The display rig is world-space with an identity pose, so the eyes must be loose for it —
  // parented under the orbiting camera they would inherit a transform the rig knows nothing about.
  setAttach(S.cameraRig && S.attach);
  handle.setViewRig(currentRig());
}

// The last frame actually drawn, as COPIES (an XRView is valid only inside its own frame).
let last = null;

function onXRFrame(views, layer) {
  // Validate BEFORE clearing. renderer.clear() is the point of no return: under load the session
  // can hand back a short view list or a null viewport. Then REDRAW the last good frame rather
  // than skipping the frame (a skipped commit can leave the weave reading a stale buffer) or
  // clearing it (one dark tile, nothing thrown, nothing logged — web#12).
  const vps = views && views.length >= 2 && layer ? views.map((v) => layer.getViewport(v)) : null;
  if (vps && vps.every((vp) => vp && vp.width > 0 && vp.height > 0)) {
    last = views.slice(0, 2).map((v, i) => ({
      proj: Array.from(v.projectionMatrix), pose: Array.from(v.transform.matrix),
      vp: { x: vps[i].x, y: vps[i].y, width: vps[i].width, height: vps[i].height },
    }));
  }
  pushRig();   // drives the views delivered NEXT frame — Blink locates before the page's rAF
  drawEyes();
  updateReadout();
}

function drawEyes() {
  if (!last) return;
  renderer.clear();
  renderer.setScissorTest(true);
  for (let i = 0; i < 2; i++) {
    const { vp, proj, pose } = last[i];
    renderer.setViewport(vp.x, vp.y, vp.width, vp.height);
    renderer.setScissor(vp.x, vp.y, vp.width, vp.height);
    // The only difference the attach pattern makes on the render side: whether the reported eye
    // pose is world or rig-local. Everything else — projection, viewport, draw — is identical.
    if (S.cameraRig && S.attach) eyes[i].setLocalFromMatrices(proj, pose);
    else eyes[i].setFromMatrices(proj, pose);
    renderer.render(scene, eyes[i].camera);
  }
  renderer.setScissorTest(false);
}

// The SDK calls this inside its ResizeObserver, before paint: resize and redraw at once, so the
// old store is never shown stretched onto the new box. The new store's eye halves are its halves.
function onResize({ width, height }) {
  sizeToCanvas(width, height);
  readMetrics();
  if (!last) return;
  const w = canvas.width / 2;
  last.forEach((e, i) => { e.vp = { x: i * w, y: 0, width: w, height: canvas.height }; });
  drawEyes();
}

// ---- 2D fallback ------------------------------------------------------------------------------
let monoRunning = false;
function goFlat() {
  // No session, or the layer went away for good (onLayerLost): ONE mono view across the whole
  // canvas on our own rAF loop — never the last side-by-side pair left on screen.
  handle = null;
  sbsMode = false;
  sizeToCanvas();
  if (monoRunning) return;
  monoRunning = true;
  new ResizeObserver(() => sizeToCanvas()).observe(canvas);
  requestAnimationFrame(onMonoFrame);
}
function onMonoFrame() {
  requestAnimationFrame(onMonoFrame);
  renderer.clear();
  const size = new THREE.Vector2();
  renderer.getSize(size);
  renderer.setViewport(0, 0, size.x, size.y);
  renderer.render(scene, appCam);
}

// ---- UI ---------------------------------------------------------------------------------------
function slider(label, key, min, max, step, fmt, after) {
  const wrap = document.createElement('label');
  const name = document.createElement('span');
  name.textContent = label;
  const input = document.createElement('input');
  Object.assign(input, { type: 'range', min, max, step, value: S[key] });
  const out = document.createElement('span');
  out.textContent = fmt(S[key]);
  input.addEventListener('input', () => {
    S[key] = parseFloat(input.value);
    out.textContent = fmt(S[key]);
    if (after) after();
  });
  wrap.append(name, input, out);
  panelEl.appendChild(wrap);
  return input;
}

function checkbox(label, key, after) {
  const wrap = document.createElement('label');
  wrap.className = 'check';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = S[key];
  const name = document.createElement('span');
  name.textContent = label;
  input.addEventListener('change', () => {
    S[key] = input.checked;
    if (after) after();
  });
  wrap.append(input, name);
  panelEl.appendChild(wrap);
  return input;
}

function buildUI() {
  slider('fov', 'fov', 25, 75, 1, (v) => `${v.toFixed(0)}°`, placeCamera);
  // 0 is a real value here, not "off": it means "track the orbit distance", which is the sane
  // default and the thing an app usually wants (convergence on whatever you are looking at).
  slider('convergence', 'convergence', 0, 4, 0.05, (v) => (v > 0 ? `${v.toFixed(2)}m` : 'auto'));
  slider('distance', 'radius', 0.6, 3, 0.05, (v) => `${v.toFixed(2)}m`, placeCamera);
  // Share of the comfort zone the nearest / farthest content fills (rule 3). Below ~0.3 it reads flat.
  slider('depth', 'depth', 0, 1.2, 0.05, (v) => `${Math.round(v * 100)}%`);
  checkbox('attach (parent the eyes under the app camera — no rig lag)', 'attach', pushRig);
  checkbox('camera rig (uncheck, or press C, for a display rig)', 'cameraRig', pushRig).id = 'rigToggle';
  addEventListener('keydown', (e) => {
    if (e.key !== 'c' && e.key !== 'C') return;
    S.cameraRig = !S.cameraRig;
    document.getElementById('rigToggle').checked = S.cameraRig;
    pushRig();
  });
}

function updateReadout() {
  const d = convergenceDistance();
  const diopters = d > 0 ? 1 / d : 0;
  const ipd = S.cameraRig ? ipdFactorForDepth() : 1;
  const known = metrics.tileHeightM > 0;
  // The runtime's rule, verbatim: ipdFactor × metersToVirtual × convergenceDiopters × N, with N the
  // display's nominal viewing distance. At 1 the viewer's eyes are parallel on content at INFINITY
  // seen through a canvas that matches the camera's field of view. This scene ends at the floor's
  // far edge and the canvas is smaller than that (rule 4), so here the zone share the helper
  // computes is what binds, and the product can read above 1 while the scene stays inside the zone.
  // Both are reported, never enforced.
  const comfort = ipd * 1 * diopters * metrics.viewerM;
  const bad = known && S.cameraRig ? S.depth > 1 : comfort > 1;
  readoutEl.innerHTML =
    `rig <b>${S.cameraRig ? 'camera' : 'display'}</b>` +
    (S.cameraRig ? ` · pose <b>${S.attach ? 'identity (attached)' : 'world'}</b>` : '') +
    ` · convergence <b>${d.toFixed(2)} m</b> = ${diopters.toFixed(2)} D` +
    (S.cameraRig ? ` · ipdFactor <b>${ipd.toFixed(2)}</b>` +
      (known ? ` (zone used <b>${Math.round(S.depth * 100)}%</b>)` : ' (canvas size not known yet)') : '') +
    ` · comfort product ${comfort.toFixed(2)} (N ${metrics.viewerM.toFixed(2)} m; ceiling 1 for content at infinity on a FOV-matched canvas)` +
    (bad ? ` <span class="warn">— ${known && S.cameraRig ? 'past the comfort zone' : 'far content asks the eyes to diverge'}</span>` : '');
}

// ---- boot ---------------------------------------------------------------------------------------
// An opaque cover over the canvas until the first woven frame: before the browser joins the
// canvas, its side-by-side buffer would show raw.
function dropCover() {
  const cover = document.getElementById('cover');
  if (cover) cover.remove();
}

(async () => {
  buildUI();
  updateReadout();
  const wall = await createInline3D({ lazy: false }).catch((err) => {
    // a rejection must not leave a blank page: log it and take the 2D path below
    console.warn('inline 3D unavailable, showing 2D', err);
    return /** @type {import('@displayxr/inline3d').Inline3DUnsupported} */ ({ supported: false, trackingState: 'unknown', error: err });
  });
  if (!wall.supported) {
    statusEl.className = 'status flat';
    statusEl.innerHTML = '<b>2D fallback</b> — open in the ' +
      '<a href="https://github.com/DisplayXR/displayxr-browser">DisplayXR Browser</a> on a ' +
      'Spatial Display for 3D. Drag still orbits.';
    dropCover();
    goFlat();
    return;
  }
  sbsMode = true;
  sizeToCanvas();   // size BEFORE registering
  // The FIRST rig is passed at construction rather than pushed after: the layer's very first
  // located frame is then already on the app's camera, so the scene never shows one frame of
  // default framing on the way in.
  handle = wall.addScene(canvas, onXRFrame, {
    viewRig: currentRig(),
    onResize,
    onLayerLost: () => {
      statusEl.className = 'status flat';
      statusEl.innerHTML = '<b>2D</b> — the 3D layer went away; showing one flat view';
      goFlat();
    },
  });
  readMetrics();
  // The display's view scale sizes each eye like a native app (window x scale): resize + redraw once known.
  handle.getDisplayInfo().then((info) => {
    viewInfo = info;
    onResize({ width: canvas.clientWidth, height: canvas.clientHeight });
  }).catch(() => {});
  // The cover comes off when the browser first weaves the canvas — and on a timeout, so a missed
  // signal never leaves the page without its scene.
  Promise.race([handle.firstWoven, new Promise((r) => setTimeout(r, 4000))]).then(dropCover, dropCover);
  // Each eye's projection is built from the session's near/far: give it the app camera's.
  wall.session.updateRenderState({ depthNear: appCam.near, depthFar: appCam.far });
  setAttach(S.cameraRig && S.attach);
  statusEl.className = 'status woven';
  statusEl.innerHTML = RIG_OK
    ? '<b style="color:#4ade80">inline-3D active</b> — driving a camera rig each frame · drag to orbit'
    : '<b style="color:#fbbf24">inline-3D active, no setViewRig</b> — this browser ignores the rig ' +
      'and keeps its default display framing; the sliders are inert';
})().catch((err) => {
  console.warn('camera-rig: startup failed, showing 2D', err);
  dropCover();
  goFlat();
});

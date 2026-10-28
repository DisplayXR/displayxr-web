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
// Authored at METRE scale (a 40 cm cube, orbited from ~1.2 m), which is not a style choice: on a
// camera rig `ipdFactor` and `metersToVirtual` are ABSOLUTE, so the comfort rule
// (ipd × m2v × diopters × 0.5 ≤ 1) reads directly as "keep convergence past ~0.5 world units". A
// scene authored in centimetres would sail past that at every plausible distance.

import * as THREE from 'three';
import { createInline3D, inline3dViewRigSupported } from '@displayxr/inline3d';
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
scene.background = new THREE.Color(0x0b0c12);
scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x14203a, 1.0));
const key = new THREE.DirectionalLight(0xffffff, 1.1);
key.position.set(1.2, 2.0, 1.4);
scene.add(key);

const cube = new THREE.Mesh(
  new THREE.BoxGeometry(0.4, 0.4, 0.4),
  new THREE.MeshStandardMaterial({ color: 0xd8823a, roughness: 0.55, metalness: 0.1 }),
);
scene.add(cube);
const grid = new THREE.GridHelper(4, 20, 0x4d5a80, 0x2b3350);
grid.position.y = -0.5;
scene.add(grid);

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
let sbsMode = false;
function sizeToCanvas(cssW = canvas.clientWidth || 640, cssH = canvas.clientHeight || 360, dpr = window.devicePixelRatio || 1) {
  const w = Math.round(cssW * dpr);
  const h = Math.round(cssH * dpr);
  renderer.setSize(sbsMode ? w * 2 : w, h, false);
  appCam.aspect = w / h;
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

function currentRig() {
  if (S.cameraRig) {
    return cameraRigFromCamera(THREE, appCam, {
      convergence: convergenceDistance(),
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
function onResize({ width, height, dpr }) {
  sizeToCanvas(width, height, dpr);
  if (!last) return;
  const w = canvas.width / 2;
  last.forEach((e, i) => { e.vp = { x: i * w, y: 0, width: w, height: canvas.height }; });
  drawEyes();
}

// ---- 2D fallback ------------------------------------------------------------------------------
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
  // The runtime's rule, verbatim: ipdFactor × metersToVirtual × convergenceDiopters × N, with N
  // the ~0.5 m nominal viewing distance. At 1 the viewer's eyes are parallel on infinitely far
  // content; past it they diverge and nobody can fuse it. Reported, never enforced — the runtime
  // clamps its own inputs, and a sample that refused to show you the bad end would teach nothing.
  const comfort = 1 * 1 * diopters * 0.5;
  const bad = comfort > 1;
  readoutEl.innerHTML =
    `rig <b>${S.cameraRig ? 'camera' : 'display'}</b>` +
    (S.cameraRig ? ` · pose <b>${S.attach ? 'identity (attached)' : 'world'}</b>` : '') +
    ` · convergence <b>${d.toFixed(2)} m</b> = ${diopters.toFixed(2)} D` +
    ` · comfort <span class="${bad ? 'warn' : ''}">${comfort.toFixed(2)}</span>` +
    (bad ? ' <span class="warn">— far content asks the eyes to diverge</span>' : '');
}

// ---- boot ---------------------------------------------------------------------------------------
(async () => {
  buildUI();
  updateReadout();
  const wall = await createInline3D({ lazy: false });
  if (!wall.supported) {
    statusEl.className = 'status flat';
    statusEl.innerHTML = '<b>2D fallback</b> — open in the ' +
      '<a href="https://github.com/DisplayXR/displayxr-browser">DisplayXR Browser</a> on a ' +
      'DisplayXR display for glasses-free 3D. Drag still orbits.';
    new ResizeObserver(() => sizeToCanvas()).observe(canvas);
    requestAnimationFrame(onMonoFrame);
    return;
  }
  sbsMode = true;
  sizeToCanvas();   // size BEFORE registering
  // The FIRST rig is passed at construction rather than pushed after: the layer's very first
  // located frame is then already on the app's camera, so the scene never shows one frame of
  // default framing on the way in.
  handle = wall.addScene(canvas, onXRFrame, { viewRig: currentRig(), onResize });
  // Each eye's projection is built from the session's near/far: give it the app camera's.
  wall.session.updateRenderState({ depthNear: appCam.near, depthFar: appCam.far });
  setAttach(S.cameraRig && S.attach);
  statusEl.className = 'status woven';
  statusEl.innerHTML = RIG_OK
    ? '<b style="color:#4ade80">inline-3D active</b> — driving a camera rig each frame · drag to orbit'
    : '<b style="color:#fbbf24">inline-3D active, no setViewRig</b> — this browser ignores the rig ' +
      'and keeps its default display framing; the sliders are inert';
})();

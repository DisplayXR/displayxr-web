// hello-cube — the DisplayXR inline-3D "hello world", done by the rules of
// docs/making-3d-look-right.md.
//
// A normal three.js scene in a normal <canvas>. In the DisplayXR Browser the inline-3d session
// hands us two eye views per frame; we draw the scene once per eye into the side-by-side halves
// the layer reports. Anywhere else we draw one ordinary camera and the page is a spinning cube.
//
// RIG: a DISPLAY rig (the user looks at an object, they do not move through a world). The canvas
// is a portal onto a virtual display 0.12 m tall; author in metres for that display.
//
// DEPTH (measured by the headless stereo judge, 640x320 tile, nominal viewer 0.6 m):
//   front p2 ≈ −0.5 % of the tile width, behind p98 ≈ +1.3 % — inside the guide's COMFORTABLE
//   column (≤ 0.6 % in front, ≤ 1.5 % behind). A 0.3-tile-height cube spinning about two axes has
//   corners up to 0.26 h from its centre; centred ON the glass its front corners would reach
//   ~1.4 % (beyond comfortable). So the centre sits 0.12 h behind the glass: the spinning front
//   stays within ~0.14 h, the hidden back costs nothing.

import * as THREE from 'three';
import { createInline3D } from '@displayxr/inline3d';
import { EyeCamera, DepthCursor, raycastHitTest } from '@displayxr/inline3d/three';

const canvas = document.getElementById('cube');
const cover = document.getElementById('cover');
const statusEl = document.getElementById('status');

const VDH = 0.12;              // virtual display height, metres (the zoom knob: half it = 2x bigger)
const BG = 0x11141b;           // clear colour == the page colour behind the canvas (index.html)

// ---- renderer --------------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
// OPAQUE clear: a transparent pixel on the weave shows stale/black pixels. Same colour as the page.
renderer.setClearColor(BG, 1);
// pixelRatio MUST be 1: layer.getViewport() is in backing-store px and three multiplies viewports
// by pixelRatio — anything else zooms each eye off-centre. We size the store ourselves (below).
renderer.setPixelRatio(1);
renderer.autoClear = false;    // one clear per frame, then one draw per eye

// ---- scene -----------------------------------------------------------------------------------
const scene = new THREE.Scene();
const tex = new THREE.TextureLoader();
const load = (f, srgb) => {
  const t = tex.load(`./textures/Wood_Crate_001_${f}.jpg`);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;   // base colour only; normal/AO are data
  t.anisotropy = 4;
  return t;
};
const SIDE = 0.3 * VDH;        // 0.3 tile heights
const cube = new THREE.Mesh(
  new THREE.BoxGeometry(SIDE, SIDE, SIDE),
  new THREE.MeshStandardMaterial({
    map: load('basecolor', true), normalMap: load('normal'), aoMap: load('ambientOcclusion'),
    roughness: 0.7, metalness: 0.05,
  }),
);
cube.position.z = -0.12 * VDH; // 0.12 h behind the glass (z = 0): see DEPTH above
scene.add(cube);
scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x14203a, 0.9));
const key = new THREE.DirectionalLight(0xffffff, 0.7);
key.position.set(0.3, 0.8, 0.5);
scene.add(key);

// ?cursor=depth: the pointer rises to the cube instead of sitting on the glass (opt-in demo).
const depthCursor = new URLSearchParams(location.search).get('cursor') === 'depth'
  ? new DepthCursor(THREE, { canvas, hitTest: raycastHitTest(THREE, [cube]) })
  : null;
if (depthCursor) scene.add(depthCursor.object);

let lastT = 0;
function spin(now) {
  const dt = lastT ? Math.min((now - lastT) / 1000, 0.1) : 0;
  lastT = now;
  cube.rotation.y += dt * 0.7;
  cube.rotation.x += dt * 0.25;
}

// ---- backing store ---------------------------------------------------------------------------
// Woven: 2x the CSS box wide in device px (left eye | right eye), each eye a full-res half.
// Mono: 1:1. Sized BEFORE the canvas is registered, and afterwards only in the SDK's onResize.
let sbs = false;
function sizeStore(cssW = canvas.clientWidth, cssH = canvas.clientHeight, dpr = devicePixelRatio || 1) {
  const w = Math.max(1, Math.round(cssW * dpr)), h = Math.max(1, Math.round(cssH * dpr));
  renderer.setSize(sbs ? 2 * w : w, h, false);
  monoCam.aspect = w / h;
  monoCam.updateProjectionMatrix();
}

// ---- woven path: one draw per eye, from the last GOOD frame ------------------------------------
const eye = new EyeCamera(THREE);
let last = null;  // copies of the last frame drawn — an XRView is only valid inside its own frame

function onXRFrame(views, layer) {
  spin(performance.now());
  // Validate BEFORE clearing: under load the session can deliver a short view list or a null
  // viewport. Then we redraw the last good frame (one frame stale is invisible; a black or
  // skipped frame is not).
  const vps = views && views.length >= 2 ? views.map((v) => layer.getViewport(v)) : null;
  if (vps && vps.every((vp) => vp && vp.width > 0 && vp.height > 0)) {
    last = views.map((v, i) => ({
      proj: Array.from(v.projectionMatrix), pose: Array.from(v.transform.matrix),
      vp: { x: vps[i].x, y: vps[i].y, width: vps[i].width, height: vps[i].height },
    }));
  }
  if (depthCursor && last) {
    scene.updateMatrixWorld();
    depthCursor.update(last.map((e) => ({ projectionMatrix: e.proj, transformMatrix: e.pose })), { layer });
  }
  drawEyes();
}

function drawEyes() {
  if (!last) return;   // nothing good drawn yet: nothing to replay
  renderer.clear();
  renderer.setScissorTest(true);
  for (const e of last) {
    renderer.setViewport(e.vp.x, e.vp.y, e.vp.width, e.vp.height);
    renderer.setScissor(e.vp.x, e.vp.y, e.vp.width, e.vp.height);
    eye.setFromMatrices(e.proj, e.pose);   // this eye's OWN projection + pose
    renderer.render(scene, eye.camera);
  }
  renderer.setScissorTest(false);
}

// The SDK calls this inside its ResizeObserver, before paint: resize the store and redraw now, so
// the old store is never shown stretched. The new store's eye halves are its two halves.
function onResize({ width, height, dpr }) {
  sizeStore(width, height, dpr);
  if (!last) return;
  const w = canvas.width / 2, h = canvas.height;
  last.forEach((e, i) => { e.vp = { x: i * w, y: 0, width: w, height: h }; });
  drawEyes();
}

// ---- mono path (any other browser): one ordinary camera ----------------------------------------
const monoCam = new THREE.PerspectiveCamera(30, 2, 0.01, 10);
monoCam.position.set(0, 0, 0.5 * VDH / Math.tan(THREE.MathUtils.degToRad(15))); // frames the display height
monoCam.lookAt(0, 0, cube.position.z);

function onMonoFrame(now) {
  requestAnimationFrame(onMonoFrame);
  spin(now);
  renderer.clear();
  renderer.setViewport(0, 0, canvas.width, canvas.height);
  renderer.render(scene, monoCam);
}

// ---- boot --------------------------------------------------------------------------------------
const wall = await createInline3D({ lazy: false });
if (wall.supported) {
  sbs = true;
  sizeStore();                                    // size BEFORE registering
  const handle = wall.addScene(canvas, onXRFrame, { virtualDisplayHeight: VDH, onResize });
  // Each eye's projection is built from the session's near/far: give it ours.
  wall.session.updateRenderState({ depthNear: monoCam.near, depthFar: monoCam.far });
  statusEl.innerHTML = '<b style="color:#4ade80">inline-3D active</b> — weaving glasses-free 3D · ' +
    'move your head to look around';
  await handle.firstWoven;                        // keep the cover until the first woven frame
  cover.remove();                                 // cut, never fade
} else {
  sizeStore();
  new ResizeObserver(() => sizeStore()).observe(canvas);
  cover.remove();
  statusEl.innerHTML = '<b>2D fallback</b> — open in the ' +
    '<a href="https://github.com/DisplayXR/displayxr-browser">DisplayXR Browser</a> ' +
    'on a DisplayXR display for glasses-free 3D';
  requestAnimationFrame(onMonoFrame);
}

// A known-good inline-3D page: one persistent canvas, a cover that always comes off, a 2D fallback.
// Display rig (the user turns a SUBJECT). Scene units are metres for a 0.24 m virtual display;
// the subject straddles z = 0 (the glass). Replace buildScene() with your content.
import * as THREE from 'three';
import { createInline3D, sceneBufferSize } from '@displayxr/inline3d';
import { EyeCamera } from '@displayxr/inline3d/three';

const VIRTUAL_DISPLAY_HEIGHT = 0.24; // metres of virtual display the canvas shows
const canvas = document.getElementById('stage');
const cover = document.getElementById('cover');
const statusEl = document.getElementById('status');

// ---- the cover: on top of the canvas, removed by a hard cut, and ALWAYS removed --------------
let coverDone = false;
function dropCover() {
  if (coverDone) return;
  coverDone = true;
  cover.remove();
}
const coverTimer = setTimeout(dropCover, 4000); // a missed signal never leaves the page without its scene

// ---- renderer + scene --------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(1); // getViewport() returns buffer pixels; three must not rescale them
renderer.autoClear = false;
renderer.setClearColor(0x9aa3ad, 1); // mid-tone, low contrast behind the subject (never pure black)
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const subject = buildScene(scene);

function buildScene(s) {
  s.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(0.3, 0.5, 0.6);
  s.add(key);
  // ~0.11 m across: about half the virtual display's height, centred on the glass (z = 0).
  const mesh = new THREE.Mesh(
    new THREE.TorusKnotGeometry(0.035, 0.011, 160, 24),
    new THREE.MeshStandardMaterial({ color: 0xd9822b, roughness: 0.45, metalness: 0.1 }),
  );
  s.add(mesh);
  return mesh;
}

// Rotate the SUBJECT, not the camera (display rig).
let last = performance.now();
function animate(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  subject.rotation.y += dt * 0.5;
  subject.rotation.x = 0.35;
}

// ---- backing store: sceneBufferSize, never clientWidth x devicePixelRatio x 2 ----------------
// Per eye it gives window device px x the runtime's recommended view scale (once getDisplayInfo()
// has answered; devicePixelRatio <= 2 until then), fitted to the GL limits and the browser's
// drawing-buffer area cap. The view scale is the 3D mode's: never pass it for the flat 2D store.
// A hand-rolled store overflows that cap on a big panel: the browser
// shrinks the buffer silently, the eyes land off-centre and one eye shows both images.
let viewInfo = null;
function sizeBuffer(stereo) {
  const s = sceneBufferSize(canvas, { sbs: stereo, viewScale: stereo ? viewInfo : null, gl: renderer.getContext() });
  // Writing width/height clears the buffer even when the value is the same: only on a change.
  if (canvas.width !== s.width || canvas.height !== s.height) {
    canvas.width = s.width;
    canvas.height = s.height;
    return true;
  }
  return false;
}

// ---- 2D fallback: one mono camera framed like the virtual display ----------------------------
const monoCam = new THREE.PerspectiveCamera(35, 1, 0.01, 10);
monoCam.position.set(0, 0, VIRTUAL_DISPLAY_HEIGHT / 2 / Math.tan(THREE.MathUtils.degToRad(35 / 2)));
function render2D(now) {
  sizeBuffer(false);
  animate(now);
  monoCam.aspect = canvas.width / canvas.height;
  monoCam.updateProjectionMatrix();
  renderer.setViewport(0, 0, canvas.width, canvas.height);
  renderer.clear();
  renderer.render(scene, monoCam);
  requestAnimationFrame(render2D);
}
function start2D(reason) {
  statusEl.textContent = `2D (${reason})`;
  clearTimeout(coverTimer);
  dropCover();
  requestAnimationFrame(render2D);
}

// ---- 3D -------------------------------------------------------------------------------------
const eye = new EyeCamera(THREE);
const lastGood = [0, 1].map(() => ({ proj: new Float32Array(16), xf: new Float32Array(16), vp: null }));
let haveLast = false;

function drawEyes(eyes) {
  renderer.setScissorTest(true);
  renderer.setViewport(0, 0, canvas.width, canvas.height);
  renderer.setScissor(0, 0, canvas.width, canvas.height);
  renderer.clear();
  for (const e of eyes) {
    renderer.setViewport(e.vp.x, e.vp.y, e.vp.width, e.vp.height);
    renderer.setScissor(e.vp.x, e.vp.y, e.vp.width, e.vp.height);
    eye.setFromMatrices(e.proj, e.xf);
    renderer.render(scene, eye.camera);
  }
  renderer.setScissorTest(false);
}

function onFrame(views, layer) {
  animate(performance.now());
  // Validate BEFORE clearing: a short view list or a null viewport must not become a black frame.
  const vps = views.length >= 2 ? views.map((v) => layer.getViewport(v)) : null;
  if (vps && vps.every(Boolean)) {
    views.forEach((v, i) => {
      const g = lastGood[i];
      g.proj.set(v.projectionMatrix);
      g.xf.set(v.transform.matrix);
      const vp = vps[i];
      g.vp = { x: vp.x, y: vp.y, width: vp.width, height: vp.height }; // copy fields by name
    });
    haveLast = true;
  }
  if (haveLast) drawEyes(lastGood); // also repaints the last good frame when this one was short
}

async function start() {
  const wall = await createInline3D();
  if (!wall.supported) return start2D('no inline 3D here');
  sizeBuffer(true); // size before registering (woven-canvas rule 4)
  const handle = wall.addScene(canvas, onFrame, {
    virtualDisplayHeight: VIRTUAL_DISPLAY_HEIGHT,
    onResize: () => { if (sizeBuffer(true) && haveLast) drawEyes(lastGood); }, // repaint at once
    // The layer went away for good (session ended / layer failed): go flat. An empty callback
    // would leave the last side-by-side pair on screen, unwoven.
    onLayerLost: () => start2D('3D layer lost'),
  });
  statusEl.textContent = '3D on a Spatial Display';
  handle.getDisplayInfo().then((info) => {
    viewInfo = info;
    if (sizeBuffer(true) && haveLast) drawEyes(lastGood);
  }).catch(() => {});
  addEventListener('pagehide', () => wall.close());
  const result = await handle.firstWoven; // never rejects
  clearTimeout(coverTimer);
  dropCover(); // woven or not: drop it and keep drawing both eyes
  if (!result.woven) statusEl.textContent = `3D (${result.reason})`;
}

// createInline3D() and the setup around it can reject (no WebGL, a failed import, a bad asset).
// Keep this catch: log the reason and show the 2D view, never an unhandled rejection over a
// blank or still-covered canvas.
start().catch((err) => {
  console.warn('inline 3D setup failed, showing 2D', err);
  start2D('error');
});

// hello-cube — the DisplayXR inline-3D "hello world".
//
// A normal three.js scene rendered into a normal <canvas>. When the DisplayXR Browser's
// `inline-3d` session is available we render the scene TWICE per frame — once per eye — into
// the side-by-side halves the XRDisplayLayer reports, using the off-axis projection + eye pose
// the session updates every frame (the look-around). Otherwise we render a single mono camera
// so the page still shows a spinning cube in any browser.

import * as THREE from 'three';
import { startInline3D } from '../../js/displayxr-inline3d.js';

const canvas = document.getElementById('cube');
const statusEl = document.getElementById('status');

// ---- scene ---------------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
// pixelRatio MUST be 1. layer.getViewport() hands back BACKING-STORE pixels, and three.js's
// setViewport()/setScissor() multiply what you give them by the renderer's pixelRatio — so any
// other value silently scales each eye's viewport (at dpr 2 the left eye covers the whole canvas
// and overflows vertically). It fails deceptively: the scene still head-tracks perfectly, it is
// just zoomed and off-centre, so it reads as a projection bug rather than a viewport one. We size
// the backing store in device pixels ourselves below instead.
renderer.setPixelRatio(1);
renderer.autoClear = false;                     // we clear once per frame, then draw N eye viewports

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b1020);

// SCENE SCALE IS THE RUNTIME'S JOB. startInline3D declares virtualDisplayHeight = 0.24, so
// author in METRES for a 24 cm-tall display and render the reported views as-is — no app-side
// scaling. These are the native cube_handle reference's numbers: a 6 cm crate sitting on the
// z=0 (zero-disparity) plane over a 0.5 m grid, so the browser and native scenes match.
// (A metre-scale scene here would be ~4x the whole virtual display and render enormous.)
const tex = new THREE.TextureLoader();
const load = (f, srgb) => {
  const t = tex.load(`./textures/Wood_Crate_001_${f}.jpg`);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;  // basecolor only; normal/AO are raw data
  t.anisotropy = 4;
  return t;
};
const cube = new THREE.Mesh(
  new THREE.BoxGeometry(0.06, 0.06, 0.06),
  new THREE.MeshStandardMaterial({
    map: load('basecolor', true),
    normalMap: load('normal', false),
    aoMap: load('ambientOcclusion', false),
    roughness: 0.7,
    metalness: 0.05,
  }),
);
cube.geometry.setAttribute('uv2', cube.geometry.attributes.uv);  // aoMap samples uv2
cube.position.set(0, 0.03, 0);   // bottom on z=0; +z is behind the glass, -z in front
scene.add(cube);

// Depth cue so parallax/look-around is obvious: a receding grid floor.
const grid = new THREE.GridHelper(0.5, 10, 0x4d4d59, 0x4d4d59);
grid.position.y = -0.05;
scene.add(grid);

scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x14203a, 0.9));
const key = new THREE.DirectionalLight(0xffffff, 0.7); key.position.set(0.3, 0.8, 0.5); scene.add(key);

// Mono fallback camera (also the initial framing before an eye pose arrives). Framed for the
// same 0.24 m virtual display: ~0.6 m back is the nominal viewing distance.
const monoCam = new THREE.PerspectiveCamera(45, 2, 0.01, 100);
monoCam.position.set(0, 0.03, 0.35);
monoCam.lookAt(0, 0.03, 0);

// ---- per-eye camera driven by the session's reported views --------------------------------
const eyeCam = new THREE.PerspectiveCamera();
eyeCam.matrixAutoUpdate = false;                 // we set matrices directly from the XRView

function setCameraFromView(view) {
  eyeCam.projectionMatrix.fromArray(view.projectionMatrix);
  eyeCam.projectionMatrixInverse.copy(eyeCam.projectionMatrix).invert();
  eyeCam.matrix.fromArray(view.transform.matrix);          // camera world pose
  eyeCam.matrixWorld.copy(eyeCam.matrix);
  eyeCam.matrixWorldInverse.copy(eyeCam.matrixWorld).invert();
}

// In inline-3D the backing store is DOUBLE-WIDTH in device pixels (left eye | right eye):
// getViewport() splits canvas.width in half, so each eye then gets a full-resolution half, and
// the browser squashing that 2:1 buffer into the 1:1 CSS box IS the SBS squeeze the weave
// un-squeezes. Sizing to the CSS box instead renders each eye at half width and upscales it.
//
// Mono stays 1:1 — the flat fallback draws the whole canvas, so a 2:1 store would just stretch
// it. updateStyle=false: the layout owns the CSS box, never the renderer.
let sbsMode = false;
function sizeToCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round((canvas.clientWidth || 512) * dpr);
  const h = Math.round((canvas.clientHeight || 256) * dpr);
  renderer.setSize(sbsMode ? w * 2 : w, h, false);
  monoCam.aspect = w / h; monoCam.updateProjectionMatrix();
}
window.addEventListener('resize', sizeToCanvas);
sizeToCanvas();

function spin(dt) { cube.rotation.y += dt * 0.7; cube.rotation.x += dt * 0.25; }

// ---- inline-3D path (two off-axis eye viewports) ------------------------------------------
let last = 0;
function onXRFrame(views, layer) {
  const now = performance.now(); const dt = last ? (now - last) / 1000 : 0; last = now;
  spin(dt);
  const size = new THREE.Vector2(); renderer.getSize(size);
  renderer.clear();
  renderer.setScissorTest(true);
  for (const view of views) {
    const vp = layer.getViewport(view) || fallbackHalf(view, views, size);
    renderer.setViewport(vp.x, vp.y, vp.width, vp.height);
    renderer.setScissor(vp.x, vp.y, vp.width, vp.height);
    setCameraFromView(view);
    renderer.render(scene, eyeCam);
  }
  renderer.setScissorTest(false);
}
// If getViewport ever returns null, split the canvas L/R by view index.
function fallbackHalf(view, views, size) {
  const i = views.indexOf(view), half = size.x / 2;
  return { x: i === 0 ? 0 : half, y: 0, width: half, height: size.y };
}

// ---- mono fallback loop --------------------------------------------------------------------
function onMonoFrame(now) {
  requestAnimationFrame(onMonoFrame);
  const dt = last ? (now - last) / 1000 : 0; last = now;
  spin(dt);
  renderer.clear();
  const size = new THREE.Vector2(); renderer.getSize(size);
  renderer.setViewport(0, 0, size.x, size.y);
  renderer.render(scene, monoCam);
}

// ---- boot ----------------------------------------------------------------------------------
(async () => {
  // virtualDisplayHeight: this scene is composed for a 24 cm-tall display (see the scene block).
  // The runtime scales the eye poses it reports to match, so the views render as-is.
  const xr = await startInline3D(canvas, {
    onFrame: onXRFrame,
    virtualDisplayHeight: 0.24,
  });
  if (xr.supported) {
    // Only now do we know we render side-by-side — re-size the backing store to 2x width.
    sbsMode = true;
    sizeToCanvas();
    statusEl.innerHTML = '<b style="color:#4ade80">inline-3D active</b> — weaving glasses-free 3D · ' +
      'move your head to look around';
  } else {
    statusEl.innerHTML = '<b>2D fallback</b> — open in the ' +
      '<a href="https://github.com/DisplayXR/displayxr-browser">DisplayXR Browser</a> ' +
      'on a DisplayXR display for glasses-free 3D';
    requestAnimationFrame(onMonoFrame);
  }
})();

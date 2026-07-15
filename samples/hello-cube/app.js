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

const cube = new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshStandardMaterial({ color: 0x3b82f6, metalness: 0.25, roughness: 0.35 }),
);
scene.add(cube);

// Depth cues so parallax/look-around is obvious: an edge outline + a receding grid floor.
cube.add(new THREE.LineSegments(
  new THREE.EdgesGeometry(cube.geometry),
  new THREE.LineBasicMaterial({ color: 0x9ecbff }),
));
const grid = new THREE.GridHelper(10, 20, 0x274060, 0x1a2740);
grid.position.y = -1.2;
scene.add(grid);

scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x14203a, 1.1));
const key = new THREE.DirectionalLight(0xffffff, 1.4); key.position.set(2, 3, 2); scene.add(key);

// Mono fallback camera (also the initial framing before an eye pose arrives).
const monoCam = new THREE.PerspectiveCamera(45, 2, 0.05, 100);
monoCam.position.set(0, 0.25, 3.2);
monoCam.lookAt(0, 0, 0);

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
  const xr = await startInline3D(canvas, { onFrame: onXRFrame });
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

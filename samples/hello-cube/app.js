// hello-cube — the DisplayXR inline-3D "hello world".
//
// A normal three.js scene rendered into a normal <canvas>. When the DisplayXR Browser's
// `inline-3d` session is available we render the scene TWICE per frame — once per eye — into
// the side-by-side halves the XRDisplayLayer reports, using the off-axis projection + eye pose
// the session updates every frame (the look-around). Otherwise we render a single mono camera
// so the page still shows a spinning cube in any browser.

import * as THREE from 'three';
import { createInline3D, inline3dViewRigSupported } from '@displayxr/inline3d';
import { EdgeFeather, displayRig } from '@displayxr/inline3d/three';

const canvas = document.getElementById('cube');
const statusEl = document.getElementById('status');

// ---- scene ---------------------------------------------------------------------------------
// alpha: true + a 0-alpha clear so the edges can fade to TRANSPARENT and let the page show
// through (see EdgeFeather below). An opaque scene.background would defeat it.
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setClearColor(0x000000, 0);
// pixelRatio MUST be 1. layer.getViewport() hands back BACKING-STORE pixels, and three.js's
// setViewport()/setScissor() multiply what you give them by the renderer's pixelRatio — so any
// other value silently scales each eye's viewport (at dpr 2 the left eye covers the whole canvas
// and overflows vertically). It fails deceptively: the scene still head-tracks perfectly, it is
// just zoomed and off-centre, so it reads as a projection bug rather than a viewport one. We size
// the backing store in device pixels ourselves below instead.
renderer.setPixelRatio(1);
renderer.autoClear = false;                     // we clear once per frame, then draw N eye viewports

const scene = new THREE.Scene();
// No background: the window dissolves into the page at its edges instead of ending at a hard
// rectangle. The CSS box keeps a flat backdrop for the mono fallback.
scene.background = null;

// SCENE SCALE IS THE RUNTIME'S JOB. addScene declares virtualDisplayHeight = 0.12, so
// author in METRES for a 12 cm-tall display and render the reported views as-is — no app-side
// scaling. These are the native cube_handle reference's numbers: a 6 cm crate straddling the
// z=0 (zero-disparity) plane. Same crate as the native cube_handle reference and samples/windows.
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
// Centred on the zero-disparity plane: the cube straddles z=0, so it reads half in front of the
// glass and half behind — the strongest depth cue available without a floor. (It used to be
// lifted to y=0.03 to stand ON the grid; with the grid gone that would just sit it high.)
cube.position.set(0, 0, 0);
scene.add(cube);


scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x14203a, 0.9));
const key = new THREE.DirectionalLight(0xffffff, 0.7); key.position.set(0.3, 0.8, 0.5); scene.add(key);

// Mono fallback camera (also the initial framing before an eye pose arrives). Framed for the
// same 0.12 m virtual display: ~0.6 m back is the nominal viewing distance.
const monoCam = new THREE.PerspectiveCamera(45, 2, 0.01, 100);
monoCam.position.set(0, 0, 0.35);
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

// Per-eye edge fade. MUST be per-eye: each eye's image spans the whole window, so each needs a
// fade on all four of ITS edges — a CSS mask on the canvas would fade only the element box's
// outer edges (left eye faded on its left, not its right) and would wrongly fade the split line.
const feather = new EdgeFeather(THREE, { px: 26 });

// ---- inline-3D path (two off-axis eye viewports) ------------------------------------------
let last = 0;
// ---- physical-pixel debug overlay (bring-up instrumentation) -------------------------------
const dbgEl = document.createElement('div');
dbgEl.style.cssText = 'position:fixed;left:0;top:0;z-index:9999;background:#000c;color:#0f0;' +
  'font:700 13px/1.5 monospace;padding:6px 8px;pointer-events:none;white-space:pre';
document.body.appendChild(dbgEl);
// Debug HUD is OPT-IN: append ?debug to the URL. Default is a clean page —
// the readout exists for bring-up, not for demos.
const DEBUG_HUD = new URLSearchParams(location.search).has('debug');
if (!DEBUG_HUD && typeof dbgEl !== 'undefined' && dbgEl) dbgEl.style.display = 'none';
let dbgN = 0;
// bring-up: tap anywhere -> toggle fullscreen (window becomes the full panel; tests the
// target-extent-vs-panel-height hypothesis for the portrait double image)
addEventListener('pointerup', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(()=>{});
});
function dbgUpdate(views, layer) {
  if (!DEBUG_HUD) return;
  if ((dbgN++ % 30) !== 0) return;
  const dpr = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  let vps = '';
  if (views && layer) {
    for (const v of views) {
      const vp = layer.getViewport(v);
      vps += vp ? ` [${vp.x},${vp.y} ${vp.width}x${vp.height}]` : ' [null]';
    }
  }
  dbgEl.textContent =
    `dpr=${dpr}  ss=${screen.width}x${screen.height}  win.inner=${innerWidth}x${innerHeight}\n` +
    `canvas css=${canvas.clientWidth}x${canvas.clientHeight}  rect=${r.x.toFixed(1)},${r.y.toFixed(1)} ` +
    `${r.width.toFixed(1)}x${r.height.toFixed(1)}\n` +
    `rect*dpr=${(r.x*dpr).toFixed(0)},${(r.y*dpr).toFixed(0)} ${(r.width*dpr).toFixed(0)}x${(r.height*dpr).toFixed(0)}\n` +
    `backing=${canvas.width}x${canvas.height}  sbs=${sbsMode}  views=${views?views.length:0}${vps}`;
}

function onXRFrame(views, layer) {
  const now = performance.now(); const dt = last ? (now - last) / 1000 : 0; last = now;
  dbgUpdate(views, layer);
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
    feather.render(renderer, vp);   // fade THIS eye's edges to transparent
  }
  renderer.setScissorTest(false);
}
// If getViewport ever returns null, split the canvas L/R by view index.
function fallbackHalf(view, views, size) {
  const i = views.indexOf(view), half = size.x / 2;
  return { x: i === 0 ? 0 : half, y: 0, width: half, height: size.y };
}

// ---- ?debug: the display rig's knobs, live -------------------------------------------------
//
// virtualDisplayHeight is one field of a whole DISPLAY-rig descriptor: the canvas is a portal
// onto a virtual display that tall, and the rig can also be POSED (tilt the portal) and dialled
// (eye separation, head-tracking response, off-axis strength). displayRig() builds the
// descriptor; handle.setViewRig() replaces it. A rig applies per-locate, so "animating" one is
// just sending new values — there is nothing to tween and nothing to tear down.
//
// Debug-gated for the same reason as the HUD above: this page is the hello-world, and a rack of
// sliders under it is bring-up furniture, not the demo. The DOM is built here rather than in
// index.html so the clean page carries no markup for a panel it never shows.
//
// Expect ONE FRAME OF LAG on every slider: the browser locates views before the page's rAF, so a
// rig set now drives the next frame's views. On a knob dragged by hand that is invisible — it is
// only a problem for a rig that tracks a fast-moving camera, which is what the camera-rig
// sample's `attach` pattern exists to solve.
function buildRigPanel(handle) {
  const RIG = { yaw: 0, pitch: 0, vdh: 0.12, ipd: 1, parallax: 1, perspective: 1 };
  const q = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const scratch = {};                             // reused descriptor: no per-change allocation
  const push = () => {
    // YXZ: yaw about the page's up axis first, then tilt — the intuitive order for "turn the
    // portal, then lean it back", and the one that keeps yaw meaningful at a non-zero pitch.
    euler.set(THREE.MathUtils.degToRad(RIG.pitch), THREE.MathUtils.degToRad(RIG.yaw), 0, 'YXZ');
    q.setFromEuler(euler);
    handle.setViewRig(displayRig({
      virtualDisplayHeight: RIG.vdh,
      orientation: { x: q.x, y: q.y, z: q.z, w: q.w },
      ipdFactor: RIG.ipd,
      parallaxFactor: RIG.parallax,
      perspectiveFactor: RIG.perspective,
      out: scratch,
    }));
  };

  const panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:9999;background:#000d;' +
    'color:#eee;font:12px/1.5 system-ui,sans-serif;padding:10px 12px;border-radius:8px;' +
    'min-width:240px;backdrop-filter:none';
  panel.innerHTML = '<div style="font-weight:600;margin-bottom:6px">display rig · ?debug</div>';
  if (!inline3dViewRigSupported()) {
    // Say it here as well as in the SDK's one-shot console warning: a page of sliders that
    // silently do nothing is worse than no sliders.
    panel.innerHTML +=
      '<div style="color:#fbbf24;margin-bottom:6px">this browser has no setViewRig — the ' +
      'sliders are inert (the cube still weaves on the default rig)</div>';
  }
  const row = (label, key, min, max, step, fmt) => {
    const wrap = document.createElement('label');
    wrap.style.cssText = 'display:grid;grid-template-columns:74px 1fr 46px;gap:6px;align-items:center';
    const name = document.createElement('span'); name.textContent = label;
    const input = document.createElement('input');
    Object.assign(input, { type: 'range', min, max, step, value: RIG[key] });
    input.style.width = '100%';
    const out = document.createElement('span');
    out.style.cssText = 'text-align:right;font-variant-numeric:tabular-nums;opacity:.8';
    out.textContent = fmt(RIG[key]);
    input.addEventListener('input', () => {
      RIG[key] = parseFloat(input.value);
      out.textContent = fmt(RIG[key]);
      push();
    });
    wrap.append(name, input, out);
    panel.appendChild(wrap);
  };
  const deg = (v) => `${v.toFixed(0)}°`;
  const num = (v) => v.toFixed(2);
  row('yaw', 'yaw', -40, 40, 1, deg);
  row('pitch', 'pitch', -40, 40, 1, deg);
  row('height m', 'vdh', 0.04, 0.5, 0.005, (v) => v.toFixed(3));
  row('ipd', 'ipd', 0, 1, 0.02, num);            // [0,1] RELATIVE on a display rig — 0 = mono
  row('parallax', 'parallax', 0, 1, 0.02, num);  // [0,1] — 0 freezes the look-around
  row('perspective', 'perspective', 0.1, 3, 0.05, num); // [0.1,10]; an effect, not a correction
  document.body.appendChild(panel);
  push(); // start from the same rig the scalar virtualDisplayHeight would have built
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
  // virtualDisplayHeight: this scene is composed for a 12 cm-tall display (see the scene block).
  // The runtime scales the eye poses it reports to match, so the views render as-is.
  //
  // It is the ZOOM knob: m2v = virtualDisplayHeight / the element's physical height, so HALVING
  // this doubles how much of the window a given object fills. The 6 cm crate spans half of a
  // 12 cm virtual display; at 0.24 it spanned a quarter. Same scene, same units — only the
  // declared size of the display it is composed for changes.
  //
  // createInline3D + addScene rather than the startInline3D one-liner (which is exactly those
  // two calls) purely to get the window's HANDLE back: the handle is what carries setViewRig,
  // and the ?debug panel below drives it.
  const wall = await createInline3D({ lazy: false });
  if (wall.supported) {
    const handle = wall.addScene(canvas, onXRFrame, { virtualDisplayHeight: 0.12 });
    // Only now do we know we render side-by-side — re-size the backing store to 2x width.
    sbsMode = true;
    sizeToCanvas();
    statusEl.innerHTML = '<b style="color:#4ade80">inline-3D active</b> — weaving glasses-free 3D · ' +
      'move your head to look around';
    if (DEBUG_HUD) buildRigPanel(handle);
  } else {
    statusEl.innerHTML = '<b>2D fallback</b> — open in the ' +
      '<a href="https://github.com/DisplayXR/displayxr-browser">DisplayXR Browser</a> ' +
      'on a DisplayXR display for glasses-free 3D';
    requestAnimationFrame(onMonoFrame);
  }
})();

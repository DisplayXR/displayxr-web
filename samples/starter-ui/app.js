// starter-ui — HTML around a 3D chart: a title, a legend, a units label, a depth slider and a
// 2D/3D switch. Copy this for a dashboard tile, a map with a legend, any 3D view with 2D chrome.
// Rules: docs/making-3d-look-right.md.
//
// RIG (guide §1): a chart is an object you look at → a DISPLAY rig, framed by SceneViewer.
// SCREEN PLANE (§2): through the chart, nudged back (depthOffset) to use the "behind" budget too.
// DEPTH (§3): depthFit to the comfortable column, 0.1 h in front / 0.27 h behind on this 16:9
// tile (≈ 0.6 % / 1.5 % of the width). Measured by the headless stereo judge:
//   front p2 ≈ +0.1 % (the face-on chart sits just behind the glass), behind p98 ≈ +0.8 %.
// 2D UI (§4, §6): the title, legend and controls are HTML OUTSIDE the tile; the one label over it
// (units, top-left) sits over empty background, where nothing comes out of the glass. Plain
// rgba() backgrounds only: no filter, backdrop-filter, opacity or animated transform.

import * as THREE from 'three';
import { createInline3D } from '@displayxr/inline3d';
import { EyeCamera, displayRig } from '@displayxr/inline3d/three';
import { SceneViewer } from '@displayxr/inline3d/viewer';

const canvas = document.getElementById('chart');
const cover = document.getElementById('cover');
const depth = document.getElementById('depth');
const modeBtn = document.getElementById('mode');
const modeNote = document.getElementById('modeNote');

const VDH = 0.24;                      // virtual display height, metres — the SAME on addScene
const FRONT = 0.1, BACK = 0.27;        // depth budget, tile heights (16:9)
const BG = '#f3f4f6';                  // == the page colour behind the tile (index.html)

// The data: quarterly sales of three products (rows) — legend and colours in index.html.
const SERIES = [
  { color: '#3b6fd8', values: [3, 4.5, 5, 6.5] },
  { color: '#e0803a', values: [2, 2.5, 4, 3.5] },
  { color: '#3fa66b', values: [1, 2, 2.5, 4.5] },
];

const viewer = new SceneViewer(THREE, canvas, {
  virtualDisplayHeight: VDH,
  clearColor: BG,                      // OPAQUE clear
  depthFit: { front: FRONT, back: BACK },
  fitSweep: false,                     // no turntable: budget the chart's real depth
  orbit: false,                        // a fixed view keeps the legend and labels true
}).useEyeCamera(EyeCamera);

// ---- the chart, modelled in "chart units" ---------------------------------------------------------
let seed = 11;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
function speckle(base, contrast = 0.18) {   // a fine irregular grain: stereo matching needs detail
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = base;
  g.fillRect(0, 0, 64, 64);
  for (let i = 0; i < 400; i++) {
    g.fillStyle = `rgba(${rnd() < 0.5 ? '0,0,0' : '255,255,255'},${rnd() * contrast})`;
    g.fillRect(rnd() * 64, rnd() * 64, 1 + rnd() * 3, 1 + rnd() * 3);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshStandardMaterial({ map: t, roughness: 0.7 });
}
// FACE-ON, square to the glass. Yaw spends depth: a wide, shallow chart turned 45° becomes deep,
// and the fit would then have to shrink it. Heights are NORMALISED (the tallest bar = 4 units),
// so any data set frames the same. Grouped bars in one row: nothing hides behind anything.
const chart = new THREE.Group();
const COLS = SERIES[0].values.length, N = SERIES.length;
const MAX = Math.max(...SERIES.flatMap((x) => x.values));
SERIES.forEach((ser, i) => {
  const m = speckle(ser.color);
  ser.values.forEach((v, col) => {
    const h = (v / MAX) * 4;
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.7, h, 0.7), m);
    bar.position.set((col - (COLS - 1) / 2) * 3 + (i - (N - 1) / 2) * 0.8, h / 2, 0);
    chart.add(bar);
  });
});
const axis = new THREE.Mesh(new THREE.BoxGeometry(COLS * 3, 0.06, 0.7), speckle('#9aa0ad'));
axis.position.y = -0.03;
chart.add(axis);
chart.rotation.x = THREE.MathUtils.degToRad(8);   // a hint of the tops; the face stays square
viewer.content.add(chart);
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(-2, 4, 3);
viewer.scene.add(sun, new THREE.HemisphereLight(0xffffff, 0x8890a0, 1.2));

// Frame on the box the chart really occupies after the tilt, so depthFit sees its true depth.
viewer.depthOffset = -((BACK - FRONT) / 2) * VDH;
const box = new THREE.Box3().setFromObject(viewer.content);
viewer.fitTo(box.getCenter(new THREE.Vector3()), box.getSize(new THREE.Vector3()));

// ---- boot --------------------------------------------------------------------------------------
const wall = await createInline3D({ lazy: false });
if (!wall.supported) {
  // An ordinary browser: the same page, flat. Same layout; the 3D controls rest, and say why.
  viewer.startMono();
  cover.remove();
  depth.disabled = modeBtn.disabled = true;
  modeBtn.textContent = '2D';
  modeNote.textContent = 'Open this page in the DisplayXR Browser on a 3D display to see it in 3D.';
} else {
  const rig = (k) => displayRig({ virtualDisplayHeight: VDH, ipdFactor: k, parallaxFactor: k });
  const handle = wall.addScene(canvas, viewer.onFrame, { viewRig: rig(1), onLayerLost: viewer.onLayerLost });
  // Near and far are the page's: no SDK viewer calls updateRenderState.
  wall.session.updateRenderState({ depthNear: 0.01, depthFar: 20 });

  // Depth slider: ONE value k moves BOTH factors (stereo and look-around shrink together). On a
  // display rig 1 is what the display does naturally; below 1 only makes it shallower.
  depth.addEventListener('input', () => handle.setViewRig(rig(Number(depth.value))));

  // 2D/3D switch on the TILE HANDLE (this is an addScene tile). `in3D` is what the display REPORTS
  // (renderingmodechange) and nothing else, so the button can never invert.
  let in3D = true;
  const show = () => {
    const flat = !in3D || Number(depth.value) === 0;
    modeBtn.textContent = flat ? 'Show in 3D' : 'Show in 2D';
    modeBtn.setAttribute('aria-pressed', String(flat));
  };
  handle.on('renderingmodechange', (e) => {
    if (e.viewCount) { in3D = e.viewCount !== 1; show(); }
  });
  modeBtn.addEventListener('click', async () => {
    try {
      await handle.setStereoEnabled(!in3D);
    } catch {
      // No flat mode on this display (nothing changed): the depth slider at 0 is flat anywhere.
      depth.value = Number(depth.value) === 0 ? 1 : 0;
      handle.setViewRig(rig(Number(depth.value)));
      show();
    }
  });
  depth.addEventListener('input', show);
  show();
  await handle.firstWoven;             // cover until the first woven frame
  cover.remove();                      // cut, never fade
}

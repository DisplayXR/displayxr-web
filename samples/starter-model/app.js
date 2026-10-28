// starter-model — a product / object viewer: one glTF in a 3D tile, the product's HTML beside it,
// a depth slider and a 2D/3D switch. Copy this for a shop page, a configurator, a figurine.
// Rules: docs/making-3d-look-right.md.
//
// RIG (guide §1): the user turns an OBJECT, so a display rig — addModel's default. It scales the
// model into a virtual display VDH metres tall, so the depth does not depend on the model's units.
//
// SCREEN PLANE (§2): through the subject. addModel centres the model on the glass; the turntable
// turns it about that centre.
//
// DEPTH (§3): depthFit shrinks the model UNIFORMLY (never per-axis) until, at every turntable
// angle, its nearest point is ≤ 0.1 tile heights in front of the glass and its farthest ≤ 0.27 h
// behind. On this 16:9 tile that is ≈ 0.6 % / 1.6 % of the width: the comfortable column (on
// another tile shape multiply both by aspect / 1.78). Centred, the front binds first.
// Measured by the headless stereo judge: front p2 ≈ −0.2 %, behind p98 ≈ +0.8 % of the width.
// (The fit budgets the box the model sweeps as it turns, so a rounded model measures inside it.)
//
// 2D UI (§4, §6): the title, price and buttons live BESIDE the tile (index.html), never over the
// part of the model that comes out of the glass.

import { createInline3D } from '@displayxr/inline3d';
import { addModel } from '@displayxr/inline3d/model';

const canvas = document.getElementById('tile');
const cover = document.getElementById('cover');
const depth = document.getElementById('depth');
const modeBtn = document.getElementById('mode');
const modeNote = document.getElementById('modeNote');

const MODEL = './assets/Duck.gltf';
const VDH = 0.16;                      // virtual display height, metres (the zoom knob)
const FRONT = 0.1, BACK = 0.27;        // depth budget, tile heights (16:9, comfortable)
const BG = '#e9e6df';                  // == the page colour behind the tile (index.html)

const wall = await createInline3D({ lazy: false });
const model = addModel(wall, canvas, MODEL, {
  virtualDisplayHeight: VDH,
  clearColor: BG,                      // OPAQUE clear: alpha-0 pixels weave as stale/black
  depthFit: { front: FRONT, back: BACK },
  idleSpin: 14,                        // degrees/s once idle; drag to turn, wheel to zoom
  // Draco-compressed asset: the decoder files must be served by your site. Delete this line for
  // an uncompressed glTF/GLB.
  decoderPath: { draco: new URL('../../vendor/draco/', import.meta.url).pathname },
  // no `feather`: it fades to transparent, which needs an alpha clear (guide §5)
});

// Centred, only the FRONT budget binds and the cheaper BEHIND budget goes unused. Slide the model
// back by half the difference (0.085 h) and refit: both ends then sit at their budget, and the
// model can be ~1.9x larger for the same comfort. (depthOffset survives fitTo.)
const framed = model.ready.then(() => {
  model.viewer.depthOffset = -((BACK - FRONT) / 2) * VDH;
  model.viewer.fitTo(model.frame.center, model.frame.extent);
}).catch((e) => console.warn('[starter-model] model failed to load:', e));

// Cover until the model is framed AND the tile is woven; then cut (never fade). In an ordinary
// browser firstWoven resolves at once ('unsupported') and the flat view is shown.
Promise.all([framed, model.firstWoven]).then(() => cover.remove());

// ---- depth slider: ONE value k moves BOTH factors, so the look-around shrinks with the depth ------
// On a display rig 1 = what the display does naturally; below 1 only makes it shallower.
depth.addEventListener('input', () => {
  const k = Number(depth.value);
  model.setStereo({ ipdFactor: k, parallaxFactor: k });
});

// ---- 2D/3D switch: ask the display for its flat mode; show the state the display REPORTS ----------
let flat = false;                      // what the display last reported, never what we asked for
function showMode() {
  modeBtn.textContent = flat ? 'Show in 3D' : 'Show in 2D';
  modeBtn.setAttribute('aria-pressed', String(flat));
}
if (wall.supported) {
  wall.on('renderingmodechange', (e) => {
    if (e.viewCount) { flat = e.viewCount === 1; showMode(); }
  });
  modeBtn.addEventListener('click', () => {
    wall.setStereoEnabled(flat).catch(() => {
      // This display lists no flat mode (the call changed nothing): fall back to the slider,
      // which gives a flat image on any display.
      flat = !flat;
      depth.value = flat ? 0 : 1;
      depth.dispatchEvent(new Event('input'));
      showMode();
    });
  });
  showMode();
} else {
  // An ordinary browser: the same page, already flat. Keep the layout; say why the controls rest.
  modeBtn.disabled = depth.disabled = true;
  modeBtn.textContent = '2D';
  modeNote.textContent = 'Open this page in the DisplayXR Browser on a 3D display to see it in 3D.';
}

document.getElementById('buy').addEventListener('click', (e) => {
  e.currentTarget.textContent = 'Added ✓';
});

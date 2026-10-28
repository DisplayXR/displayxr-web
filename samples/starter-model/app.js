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
// Measured by the headless stereo judge: front p2 ≈ −0.2 %, behind p98 ≈ +0.8 % of the width;
// zoomed to the 1.3x cap −0.4 % / +0.8 %.
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

const MODEL = './assets/Duck.glb';  // uncompressed: no decoder files to serve
const VDH = 0.16;                      // virtual display height, metres (the zoom knob)
const FRONT = 0.1, BACK = 0.27;        // depth budget, tile heights (16:9, comfortable)
const BG = '#e9e6df';                  // == the page colour behind the tile (index.html)

const wall = await createInline3D({ lazy: false });
const model = addModel(wall, canvas, MODEL, {
  virtualDisplayHeight: VDH,
  clearColor: BG,                      // OPAQUE clear: alpha-0 pixels weave as stale/black
  depthFit: { front: FRONT, back: BACK },
  idleSpin: 14,                        // degrees/s once idle; drag to turn, wheel to zoom
  // ZOOM SPENDS DEPTH: depthFit is applied when the model is framed, not again when it is zoomed,
  // and the depth grows with the zoom. Capped at 1.3x, the comfortable fit (0.1 h in front) stays
  // inside the strong column (≈ 0.13 h ≈ 0.8 % of the width). (PlayCanvas, the default engine.)
  zoom: { max: 1.3 },
  // A Draco / KTX2-compressed asset also needs `decoderPath` pointing at decoder files YOUR site
  // serves (see samples/model/); this uncompressed GLB needs none.
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

// ---- 2D/3D switch, on `wall` (addModel has no tile handle of its own) ------------------------------
// `in3D` is what the display REPORTS (renderingmodechange) and nothing else, so the button can
// never invert: a click asks for the opposite of the reported state.
let in3D = true;
const showMode = () => {
  const flat = !in3D || Number(depth.value) === 0;
  modeBtn.textContent = flat ? 'Show in 3D' : 'Show in 2D';
  modeBtn.setAttribute('aria-pressed', String(flat));
};
if (wall.supported) {
  // Near and far are the page's: no SDK viewer calls updateRenderState.
  wall.session.updateRenderState({ depthNear: 0.01, depthFar: 20 });
  wall.on('renderingmodechange', (e) => {
    if (e.viewCount) { in3D = e.viewCount !== 1; showMode(); }
  });
  modeBtn.addEventListener('click', async () => {
    try {
      await wall.setStereoEnabled(!in3D);
    } catch {
      // This display lists no flat mode (nothing changed): the depth slider at 0 is flat anywhere.
      depth.value = Number(depth.value) === 0 ? 1 : 0;
      depth.dispatchEvent(new Event('input'));
      showMode();
    }
  });
  depth.addEventListener('input', showMode);
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

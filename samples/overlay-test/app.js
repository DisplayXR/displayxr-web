// overlay-aspect-test — minimal repro for the 2D-overlay vertical-squish bug.
//
// One full-window inline-3D canvas (a plain solid tile, just to engage the weave) plus two
// 2D overlays registered via wall.addGlobalOverlay(). The overlays carry a square + inscribed
// circle + grid so any x≠y scale in the overlay-composite path is obvious on the panel.
//
// Raw WebGL (no three.js) so there is nothing app-side that could distort aspect — if the
// square/circle render squished, it is the browser's overlay path, not this page.

import { startInline3D } from '@displayxr/inline3d';

const canvas = document.getElementById('tile');
const gl = canvas.getContext('webgl', { alpha: true, antialias: true, premultipliedAlpha: true });

// Size the backing store in DEVICE pixels ourselves. In inline-3D the store is DOUBLE-WIDTH
// (left|right eye); the browser squashing that 2:1 buffer into the 1:1 CSS box IS the SBS
// squeeze the weave un-squeezes (same rule as hello-cube).
let sbs = false;
function size() {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round((canvas.clientWidth || 512) * dpr);
  const h = Math.round((canvas.clientHeight || 256) * dpr);
  canvas.width = sbs ? w * 2 : w;
  canvas.height = h;
}
window.addEventListener('resize', size);
size();

// Draw a flat, zero-disparity tile: same color in both eye halves (so it weaves to a solid
// plane at z=0 — we only need the weave to be in flight so the overlay atlas is composited).
function draw(views, layer) {
  gl.enable(gl.SCISSOR_TEST);
  const list = views && views.length ? views : [null, null];
  for (let i = 0; i < list.length; i++) {
    const view = list[i];
    const vp = (view && layer && layer.getViewport(view)) || {
      x: i === 0 ? 0 : canvas.width / 2, y: 0, width: canvas.width / 2, height: canvas.height,
    };
    gl.viewport(vp.x, vp.y, vp.width, vp.height);
    gl.scissor(vp.x, vp.y, vp.width, vp.height);
    gl.clearColor(0.12, 0.18, 0.28, 1.0);   // opaque slate tile
    gl.clear(gl.COLOR_BUFFER_BIT);
  }
  gl.disable(gl.SCISSOR_TEST);
}

(async () => {
  const xr = await startInline3D(canvas, { onFrame: draw, virtualDisplayHeight: 0.12 });
  const probes = ['p5', 'p1', 'p2', 'p3', 'p4'].map((id) => document.getElementById(id));
  if (xr.supported) {
    sbs = true;
    size();
    // Register P5 (the known-good square) FIRST so registration ORDER can't explain why P1
    // squishes — if P1 still squishes though registered after the good square, order isn't it.
    for (const el of probes) xr.wall.addGlobalOverlay(el);
    document.title = 'overlay-aspect-test — inline-3D ACTIVE';
  } else {
    draw(null, null);
    document.title = 'overlay-aspect-test — 2D fallback';
  }
})();

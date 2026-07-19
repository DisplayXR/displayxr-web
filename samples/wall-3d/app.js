// DisplayXR inline-3D picture wall — the lazy-load stress sample (#625).
//
// A long scrolling grid of side-by-side 3D pictures. Each tile is woven ONLY while it is
// (near-)visible -- the SDK's lazy mode creates a window's weave layer as it approaches the
// viewport and closes it on leave, so the page pays only for what is on screen. With the
// batched submit (XR_DXR_weave spec v3) every visible rect weaves in ONE runtime call per
// frame, so the wall scales far past the old ~8-12 visible-element ceiling.
//
// This is the SDK's whole reason to exist, so the sample is deliberately thin: build 60
// canvases, hand each to wall.addImage(), done. The lazy lifecycle, the SBS buffer, the per-eye
// corner radius and the per-frame repaint are all createInline3D's.
//
// Pictures reuse the demo-gallery's shipped 2-view logo assets (1024x512
// side-by-side L|R), tiled WALL_REPEATS times. Painting a fixed SBS image into
// an inline-3d canvas is the proven per-element weave path — no eye/rig
// consumption, pure multi-element scale.

import { createInline3D } from '../../js/inline3d.js';

const PICS = ['mediaplayer', 'avatar', 'gaussiansplat', 'modelviewer', 'earthview'];
const WALL_REPEATS = 12; // 60 tiles total; ~15-25 visible at typical sizes

// Native SBS dimensions (1024x512 = two 512x512 eyes).
const SBS_W = 1024;
const SBS_H = 512;
const EYE_W = SBS_W / 2;

// Rounded corners are baked PER EYE in buffer space (CSS cannot act post-weave
// — see demo-gallery). The eye square maps uniformly onto the on-screen square
// stage, so a circular buffer-space radius stays circular after the weave.
const CORNER_FRAC = 10 / 132; // same visual radius as the demo gallery
const EYE_R = Math.round(CORNER_FRAC * SBS_H);

// Flat 2D fallback ONLY (no DisplayXR Browser): the LEFT eye in a square buffer.
// When inline-3D is live the SDK owns these canvases outright -- do not touch them, or a stray
// paint resizes the SBS buffer back to a flat square.
function paintFlat(tile) {
  const { ctx, img } = tile;
  if (!img.complete || img.naturalWidth === 0) return;
  const c = ctx.canvas;
  c.width = EYE_W; c.height = SBS_H;
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.save();
  ctx.beginPath();
  if (ctx.roundRect) { ctx.roundRect(0, 0, c.width, c.height, EYE_R); ctx.clip(); }
  ctx.drawImage(img, 0, 0, EYE_W, SBS_H, 0, 0, c.width, c.height);
  ctx.restore();
}

function buildWall() {
  const grid = document.getElementById('grid');
  const tiles = [];
  const images = new Map(); // one Image per asset, shared across repeats
  for (const key of PICS) {
    const img = new Image();
    img.src = `../demo-gallery/assets/${key}.png`;
    images.set(key, img);
  }
  for (let r = 0; r < WALL_REPEATS; r++) {
    for (const key of PICS) {
      const stage = document.createElement('div');
      stage.className = 'stage';
      const canvas = document.createElement('canvas');
      canvas.className = 'pic';
      // Own compositing layer so the element is a distinct weave target.
      canvas.style.willChange = 'transform';
      canvas.style.transform = 'translateZ(0)';
      stage.appendChild(canvas);
      // Hover metadata plate ON the picture (browser#18). data-inline3d-overlay is
      // all it takes: the SDK auto-excludes marked descendants of the canvas's
      // container while the window is woven, so the plate composites as crisp 2D
      // over the weave (final = M·weave + (1−M)·2D, M=0 under the plate) instead
      // of being interleaved. Show/hide is pure CSS — a hidden plate reports an
      // empty rect and costs nothing.
      const plate = document.createElement('div');
      plate.className = 'plate';
      plate.setAttribute('data-inline3d-overlay', '');
      plate.innerHTML =
        `<div class="title">${key}</div>` +
        `<div class="meta">2-view SBS · tile ${r * PICS.length + PICS.indexOf(key) + 1}</div>`;
      stage.appendChild(plate);
      grid.appendChild(stage);

      const tile = { key, canvas, ctx: canvas.getContext('2d'), img: images.get(key) };
      tiles.push(tile);
    }
  }
  return tiles;
}

function setStatus(mode, detail) {
  const el = document.getElementById('status');
  el.className = 'status ' + mode;
  el.textContent = detail;
}

(async function main() {
  const tiles = buildWall();

  // Lazy is the DEFAULT (rootMargin '50% 0px' pre-arms a window half a viewport early, so a fast
  // scroll never reveals a raw un-woven tile). Detection opens a real session -- createInline3D
  // avoids isSessionSupported(), which false-negatives before the OS weave service binds.
  const wall = await createInline3D();

  if (!wall.supported) {
    for (const t of tiles) {
      if (t.img.complete) paintFlat(t); else t.img.addEventListener('load', () => paintFlat(t));
    }
    setStatus('flat',
      'Flat 2D preview - open in the DisplayXR Browser on a 3D display for the woven 3D wall.');
    return;
  }

  // 60 pictures, one call each. width/height are PER EYE, so the buffer is the assets' native
  // 1024x512 SBS (no resampling) and EYE_R stays in those buffer px.
  for (const tile of tiles) {
    wall.addImage(tile.canvas, `../demo-gallery/assets/${tile.key}.png`,
                  { width: EYE_W, height: SBS_H, cornerRadius: EYE_R });
  }
  window.__wall = wall;

  const refresh = () => setStatus('woven',
    `DisplayXR Browser - ${tiles.length}-picture wall, ${wall.liveCount} woven (visible) layers live.`);
  refresh();
  setInterval(refresh, 500);   // liveCount changes as you scroll
})();

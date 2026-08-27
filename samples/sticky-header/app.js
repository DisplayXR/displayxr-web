// DisplayXR inline-3D — sticky header over a scrolling woven wall.
//
// The one thing this sample exists for: page CHROME occluding woven tiles that scroll under
// it. A sticky, translucent bar sits above a wall of side-by-side 3D tiles; as the wall
// scrolls, every tile passing behind the bar must show flat 2D there and woven 3D everywhere
// else — no 3D over the bar, no seam along its edge. That path had no repro outside a private
// gallery, which is why it lives here.
//
// The page code for it is EMPTY — on BOTH browser generations, for two different reasons:
//
//  • Draw-order occlusion (the browser's Phase-2 compositor path): any 2D that paints over a
//    tile occludes it per-pixel, by draw order. The sticky bar is just 2D that paints later, so
//    it occludes the tiles with no declaration of any kind. inline3dOcclusionByDrawOrder()
//    reports whether that path is live — false until the browser exposes the capability flag,
//    which is why the legacy branch below is still what you see today.
//  • Overlay exclusion (everything shipping so far): auto-chrome (createInline3D's default)
//    scans the top DOM levels for position:sticky/fixed furniture and registers the bar — plus its
//    text/replaced descendants, since a full-width bar can raster as several compositor
//    quads and match none — as page-global overlays, excluded from every tile's weave and
//    re-applied whenever a lazy tile re-activates.
//
// Either way: no addGlobalOverlay(), no per-tile exclude(), nothing to wire, and the same page
// runs on both. What the sample DOES have to get right is the header's CSS (see index.html):
// translucent yes, backdrop-filter never (a backdrop filter is a function of what is behind
// it, so it has no isolated composited resource — the one 2D-over-3D case that still fails).
// The `translucency` button drops the bar to 45% alpha: the see-through-chrome showcase for
// draw-order occlusion, opt-in because a legacy browser's quad matching can seam at that alpha.
//
// Tiles reuse the demo-gallery's shipped 2-view logo assets (1024x512 side-by-side L|R),
// tiled WALL_REPEATS times — the same proven fixed-SBS path as samples/wall-3d, so nothing
// here depends on eye tracking or the rig.

import { createInline3D, inline3dOcclusionByDrawOrder } from '@displayxr/inline3d';

const PICS = ['mediaplayer', 'avatar', 'gaussiansplat', 'modelviewer', 'earthview'];
const WALL_REPEATS = 8; // 40 tiles — long enough that scrolling crosses the bar repeatedly

// Native SBS dimensions of the assets (1024x512 = two 512x512 eyes).
const SBS_H = 512;
const EYE_W = 512;

// Corners are baked PER EYE in buffer space: CSS border-radius acts on the PACKED
// side-by-side rectangle, so after the eye-split the left view would be rounded only on its
// left and the right only on its right. The eye square maps uniformly onto the square stage,
// so a circular buffer-space radius stays circular after the weave.
const EYE_R = Math.round((10 / 132) * SBS_H);

// Flat 2D fallback ONLY (no DisplayXR Browser): the LEFT eye in a square buffer. When
// inline-3D is live the SDK owns these canvases — a stray paint here would resize the SBS
// buffer back to a flat square.
function paintFlat(tile) {
  const { ctx, img } = tile;
  if (!img.complete || img.naturalWidth === 0) return;
  const c = ctx.canvas;
  c.width = EYE_W;
  c.height = SBS_H;
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.save();
  if (ctx.roundRect) {
    ctx.beginPath();
    ctx.roundRect(0, 0, c.width, c.height, EYE_R);
    ctx.clip();
  }
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
      stage.appendChild(canvas);

      // A caption band ON the tile: data-inline3d-overlay is the whole contract — the SDK
      // auto-excludes marked descendants of the canvas's container while the tile is woven.
      // Note it is a BAND, not a full-bleed layer: an overlay congruent with the canvas
      // matches the canvas's own quad in the browser's geometric matcher and the tile drops
      // out of the weave entirely (the SDK now refuses that with a console warning).
      const plate = document.createElement('div');
      plate.className = 'plate';
      plate.setAttribute('data-inline3d-overlay', '');
      const n = r * PICS.length + PICS.indexOf(key) + 1;
      plate.innerHTML = `<div class="title">${key}</div><div class="meta">tile ${n}</div>`;
      stage.appendChild(plate);
      grid.appendChild(stage);

      tiles.push({ key, canvas, ctx: canvas.getContext('2d'), img: images.get(key) });
    }
  }
  return tiles;
}

function setStatus(mode, detail) {
  const el = document.getElementById('status');
  el.className = 'status ' + mode;
  el.textContent = detail;
}

// The see-through variant is pure CSS — a class on <header>, nothing inline-3D about it. That
// is the point: changing the bar's alpha changes nothing about how it occludes the tiles.
function wireTranslucency() {
  const btn = document.getElementById('seethrough');
  const header = document.querySelector('header');
  btn.addEventListener('click', () => {
    const on = header.classList.toggle('see-through');
    btn.setAttribute('aria-pressed', String(on));
  });
}

(async function main() {
  const tiles = buildWall();
  wireTranslucency();

  // Lazy is the DEFAULT: a tile's weave layer is created as it nears the viewport and closed
  // on leave, so scrolling churns layers — which is exactly the state auto-chrome's
  // re-application has to survive. Detection opens a real session; createInline3D avoids
  // isSessionSupported(), which false-negatives before the OS weave service binds.
  const wall = await createInline3D();

  if (!wall.supported) {
    for (const t of tiles) {
      if (t.img.complete) paintFlat(t);
      else t.img.addEventListener('load', () => paintFlat(t));
    }
    setStatus('flat', 'Flat 2D preview — open in the DisplayXR Browser on a 3D display.');
    return;
  }

  // width/height are PER EYE, so the buffer is the assets' native 1024x512 SBS (no
  // resampling) and EYE_R stays in those buffer px.
  for (const tile of tiles) {
    wall.addImage(tile.canvas, `../demo-gallery/assets/${tile.key}.png`, {
      width: EYE_W,
      height: SBS_H,
      cornerRadius: EYE_R,
    });
  }
  window.__wall = wall; // handy from the console: __wall.liveCount

  // Which occlusion path is live. Purely informational — the page code above is identical
  // either way; only the SDK's internal bookkeeping differs (auto-chrome scan + will-change
  // promotions on the legacy path, nothing at all on the draw-order path).
  const path = inline3dOcclusionByDrawOrder()
    ? 'draw-order occlusion (automatic)'
    : 'overlay exclusion (auto-chrome)';

  const refresh = () =>
    setStatus(
      'woven',
      `DisplayXR Browser — ${tiles.length} tiles, ${wall.liveCount} woven layers live, ` +
        `${path}. Scroll: tiles must pass UNDER the bar as flat 2D.`
    );
  refresh();
  setInterval(refresh, 500); // liveCount changes as you scroll
})();

// DisplayXR inline-3D picture wall — the lazy-load stress sample (#625).
//
// A long scrolling grid of side-by-side 3D pictures. Each tile gets its
// XRDisplayLayer ONLY while it is (near-)visible: an IntersectionObserver
// creates the layer on viewport enter and close()s it on leave, so the weave
// works only on what is on screen. With the batched submit (XR_DXR_weave spec
// v3) every visible rect weaves in ONE runtime call per frame, so the wall
// scales far past the old ~8-12 visible-element ceiling.
//
// Pictures reuse the demo-gallery's shipped 2-view logo assets (1024x512
// side-by-side L|R), tiled WALL_REPEATS times. Painting a fixed SBS image into
// an inline-3d canvas is the proven per-element weave path — no eye/rig
// consumption, pure multi-element scale.

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

function drawEyeRounded(ctx, img, sx, dx, w, h) {
  ctx.save();
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(dx, 0, w, h, EYE_R);
    ctx.clip();
  }
  ctx.drawImage(img, sx, 0, EYE_W, SBS_H, dx, 0, w, h);
  ctx.restore();
}

function paintPic(tile) {
  const { ctx, img } = tile;
  if (!img.complete || img.naturalWidth === 0) {
    return;
  }
  const c = ctx.canvas;
  ctx.clearRect(0, 0, c.width, c.height);
  if (tile.sbs) {
    drawEyeRounded(ctx, img, 0, 0, c.width / 2, c.height);              // L eye
    drawEyeRounded(ctx, img, EYE_W, c.width / 2, c.width / 2, c.height); // R eye
  } else {
    drawEyeRounded(ctx, img, 0, 0, c.width, c.height); // L eye only (flat 2D)
  }
}

function setMode(tile, sbs) {
  tile.sbs = sbs;
  tile.canvas.width = sbs ? SBS_W : EYE_W;
  tile.canvas.height = SBS_H;
  paintPic(tile);
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
      grid.appendChild(stage);

      const img = images.get(key);
      const tile = {
        canvas,
        ctx: canvas.getContext('2d'),
        img,
        sbs: false,
        layer: null,    // live XRDisplayLayer while (near-)visible
        visible: false,
      };
      setMode(tile, false);
      img.addEventListener('load', () => paintPic(tile));
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

  // Detect the DisplayXR Browser by opening the inline-3d session directly
  // (requestSession is Blink-local; isSessionSupported can false-negative at
  // load — see demo-gallery).
  let session = null;
  if (navigator.xr) {
    try {
      session = await navigator.xr.requestSession('inline-3d');
    } catch (e) {
      session = null;
    }
  }

  if (!session) {
    setStatus('flat',
      'Flat 2D preview — open in the DisplayXR Browser on a 3D display for the woven 3D wall.');
    return;
  }

  await session.requestReferenceSpace('viewer').catch(() => null);

  let liveCount = 0;
  const refreshStatus = () => setStatus('woven',
    `DisplayXR Browser — ${tiles.length}-picture wall, ${liveCount} woven (visible) layers live.`);
  refreshStatus();

  // Lazy layer lifecycle: create the XRDisplayLayer as a tile approaches the
  // viewport, close it as it leaves. rootMargin pre-arms tiles half a viewport
  // early so a fast scroll never shows an un-woven (raw SBS) tile.
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const tile = tiles.find((t) => t.canvas.parentElement === entry.target);
      if (!tile) {
        continue;
      }
      tile.visible = entry.isIntersecting;
      if (entry.isIntersecting && !tile.layer) {
        setMode(tile, true); // SBS buffer only while woven
        try {
          tile.layer = new XRDisplayLayer(session, tile.canvas, {});
          liveCount++;
        } catch (e) {
          tile.layer = null;
          setMode(tile, false);
        }
      } else if (!entry.isIntersecting && tile.layer) {
        try {
          tile.layer.close();
        } catch (e) { /* already closed */ }
        tile.layer = null;
        liveCount--;
        setMode(tile, false); // flat left-eye buffer while off screen
      }
    }
    refreshStatus();
  }, { rootMargin: '50% 0px' });
  tiles.forEach((t) => observer.observe(t.canvas.parentElement));

  window.__wall = { session, tiles, xrFrames: 0,
                    get live() { return liveCount; } };

  // Repaint only the woven (visible) tiles each frame so their canvas layers
  // stay live and keep producing composited quads for the weave to read.
  function paintFrame() {
    for (const t of tiles) {
      if (t.layer) {
        paintPic(t);
      }
    }
    requestAnimationFrame(paintFrame);
  }
  requestAnimationFrame(paintFrame);

  // Drive the XR session frame loop — this is what reports the inline-3d rect
  // set to the compositor each frame.
  function onXRFrame(t, frame) {
    window.__wall.xrFrames++;
    session.requestAnimationFrame(onXRFrame);
  }
  session.requestAnimationFrame(onXRFrame);
})();

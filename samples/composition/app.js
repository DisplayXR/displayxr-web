// Composition showcase — the 14-case 2D/3D overlap matrix.
//
// WHAT THIS PAGE IS. Two jobs at once: a demo of what draw-order occlusion buys an author, and
// a standing hardware regression surface for every future composition change. The second job
// constrains the first — nothing here is tuned to look good. Cases that glitch today (07 until
// browser#117 lands, 12 because tile-over-tile is undefined, 02/03 because of browser#120) are
// built anyway and marked red on-page. A case softened until it passes is not a regression test.
//
// ORDER (browser#120). The page runs 01, then 04…14, then a KNOWN BROKEN banner, then 02 and 03.
// It used to open into 02/03, whose full-tile backdrop-filter hits #120 — so the first thing a
// hardware walk-through saw was a screenful of frosted black, which reads as "the sample is
// broken" rather than "this one case is". The broken pair is kept (a regression surface that
// hides its failures is not one) but it is announced, it is last, and its frost is opt-in.
//
// THE RULES THIS FILE OBEYS
//
//  1. ONE createInline3D() FOR THE WHOLE DOCUMENT, closed on pagehide. The browser's
//     element-rect channel is a WHOLE-WIDGET setter: two live sessions in one document
//     overwrite each other's rect list every frame and neither one's tiles hold still (the SDK
//     warns about exactly this). Every tile below — images, the video, the scene — is added to
//     this single manager.
//
//  2. autoChrome:false. That flag is the SDK's LEGACY-browser fallback: a DOM scan that
//     registers sticky/fixed furniture as page-global weave exclusions. It stands down by
//     itself where the browser occludes by draw order, but this page exists to measure PURE
//     draw-order occlusion, so no SDK-side exclusion machinery may participate at all.
//
//  3. ZERO exclusion-era API. No handle.exclude(), no wall.addGlobalOverlay(), no
//     data-inline3d-overlay attribute anywhere in index.html. Every 2D element on the page is
//     an ordinary DOM sibling painted after the canvas. (excludeElement is a deprecated no-op
//     on a draw-order browser; relying on it here would hide the very thing being measured.)
//
//  4. cornerRadius: 0 on every tile. Case 11 has to judge a hard seam between two adjacent
//     tiles, and a baked radius would round it away.
//
//  5. LAZY LIFECYCLE LEFT AT THE SDK DEFAULT (lazy:true, rootMargin '50% 0px'). That is the
//     configuration real pages ship, so it is the one worth regression-testing — and the
//     margin is generous enough that case 07's tile is still live at 10% visibility. The
//     status line prints wall.liveCount so an operator can confirm a suspect tile was live
//     before blaming the weave.
//
// ASSETS are reused from the sibling samples — nothing here is synthesised media:
//   ../demo-gallery/assets/*.png     1024x512 side-by-side stills (two 512x512 eyes)
//   ../windows/assets/*.webm         VP9 side-by-side video (see the codec note below)
//   ../windows/assets/Wood_Crate_*   the crate PBR set the native reference app uses

import { createInline3D, inline3dOcclusionByDrawOrder } from '@displayxr/inline3d';

// ── assets ──────────────────────────────────────────────────────────────────────────────────
const PIC_DIR = '../demo-gallery/assets/';
const WIN_DIR = '../windows/assets/';

// Native side-by-side dimensions of the still assets: 1024x512 = two 512x512 eyes. Passing
// these as width/height means the buffer is the asset's native resolution with no resampling.
const EYE_W = 512;
const EYE_H = 512;

// CODEC: VP9/WebM, never H.264/mp4. Stock Chromium builds ship ffmpeg_branding="Chromium" with
// proprietary_codecs off, so an .mp4 fails with MEDIA_ERR_SRC_NOT_SUPPORTED — which reads
// exactly like a broken path and is not one. VP9 is royalty-free and always compiled in.
// SIZE: 640x360 per eye. After the interlace each eye receives about half the panel's samples,
// so encoding past ~0.5x the tile per eye is download weight for pixels the weave discards.
const VIDEO_SRC = WIN_DIR + 'flymetothemoon_sbs.webm';
const VIDEO_EYE_W = 640;
const VIDEO_EYE_H = 360;

const SWEEP_MARKS = [0.9, 0.7, 0.5, 0.3, 0.1];

// ── page furniture that needs no session ────────────────────────────────────────────────────

// Document order, which since the browser#120 reorder is: 01, 04…14, then the KNOWN BROKEN
// banner, then 02 and 03. querySelectorAll returns document order, so the TOC follows the page
// for free — the case NUMBERS are stable, only their position moved.
function buildToc() {
  const toc = document.getElementById('toc');
  for (const sec of document.querySelectorAll('.case[data-case], #known-broken')) {
    const a = document.createElement('a');
    a.href = '#' + sec.id;
    if (sec.id === 'known-broken') {
      a.className = 'broken';
      a.textContent = '⚠ known broken · browser#120';
    } else {
      if (sec.classList.contains('is-broken')) a.className = 'broken';
      a.textContent = sec.dataset.case + ' · ' + sec.querySelector('h2').textContent.trim();
    }
    toc.appendChild(a);
  }
}

// Cases 02 / 03 — OPT-IN FROST. backdrop-filter over a whole tile is browser#120 (the frost rect
// carries neither the suppressed canvas nor the clipped-out weave, so the blur samples an empty
// dark region and the tile reads as a black void). These two are the repro, but a page that opens
// into two screenfuls of frosted black is unusable as a walk-through, so both panels ship as
// plain translucent 2D and the blur is added live by these buttons.
function wireFrostArm() {
  const panels = { '02': document.getElementById('frost02'), '03': document.getElementById('frost03') };
  const btns = { '02': document.getElementById('arm02'), '03': document.getElementById('arm03') };
  const set = (which, on) => {
    const panel = panels[which];
    const btn = btns[which];
    if (!panel || !btn) return false;
    const armed = on === undefined ? !panel.classList.contains('frosted') : !!on;
    panel.classList.toggle('frosted', armed);
    btn.setAttribute('aria-pressed', String(armed));
    btn.textContent = armed ? 'disarm frost' : 'arm frost (#120 repro)';
    return armed;
  };
  for (const which of Object.keys(btns)) {
    btns[which]?.addEventListener('click', () => set(which));
  }
  return set;
}

// The sticky header is FROSTED by default — see the CSS comment in index.html. A backdrop
// filter reaches the compositor through its own render pass, which is the child-pass condition
// browser#117's log names, and the top-edge leg of case 07 runs directly under this bar.
function wireHeaderMode() {
  const btn = document.getElementById('headermode');
  const head = document.getElementById('pagehead');
  btn.addEventListener('click', () => {
    const solid = head.classList.toggle('solid');
    btn.setAttribute('aria-pressed', String(!solid));
    btn.textContent = solid ? 'header: solid' : 'header: frosted';
  });
}

// Case 05 — a page-DOM modal, deliberately NOT a browser popup: the scrim and card are ordinary
// DOM painted after every canvas, so draw order alone has to put them over the woven tiles.
function wireModal() {
  const scrim = document.getElementById('scrim05');
  const show = (on) => { scrim.hidden = !on; };
  document.getElementById('open05').addEventListener('click', () => show(true));
  document.getElementById('close05').addEventListener('click', () => show(false));
  scrim.addEventListener('click', (e) => { if (e.target === scrim) show(false); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') show(false); });
  return show;
}

// Case 06 — ~10 Hz plate thrash. Off by default: a 10 Hz DOM mutation running for the life of
// the page would be a load confound for every other case on it. Toggle it, then scroll THIS
// section through the viewport.
function wireThrash() {
  const btn = document.getElementById('thrash06');
  const plate = document.getElementById('plate06');
  let timer = null;
  const set = (on) => {
    if (on && !timer) {
      let vis = false;
      timer = setInterval(() => {
        vis = !vis;
        plate.style.display = vis ? 'block' : 'none'; // display, not opacity: an empty rect
      }, 95); // ~10.5 Hz
    } else if (!on && timer) {
      clearInterval(timer);
      timer = null;
      plate.style.display = 'none';
    }
    btn.setAttribute('aria-pressed', String(!!timer));
    btn.textContent = timer ? 'stop thrash' : 'start thrash';
  };
  btn.addEventListener('click', () => set(!timer));
  window.addEventListener('pagehide', () => set(false));
  return set;
}

// ── case 07 — the partial-visibility sweep ──────────────────────────────────────────────────
//
// Geometry, for both legs. Let the tile span [0, H] in its own axis and let d be the distance
// from the tile's leading edge to the clipping viewport edge:
//   leading edge clipped (top / left):    visible = (H - d)/H   →  d = (1 - p)·H
//   trailing edge clipped (bottom/right): visible =       d /H   →  d =       p ·H
// The rulers place a tick at each d and the snap buttons scroll to it exactly.
//
// The ticks live in the GUTTERS, never on the tile: a hairline painted over the tile would add
// a 2D-over-3D composition on top of the very thing being measured.

function buildRails() {
  const mk = (rail, pct, label, axis) => {
    const t = document.createElement('div');
    t.className = 'tick';
    t.style[axis] = pct + '%';
    const s = document.createElement('span');
    s.textContent = label;
    t.appendChild(s);
    rail.appendChild(t);
  };
  for (const p of SWEEP_MARKS) {
    const label = Math.round(p * 100) + '%';
    mk(document.getElementById('railtop'), (1 - p) * 100, label, 'top');
    mk(document.getElementById('railbot'), p * 100, label, 'top');
    mk(document.getElementById('hrailleft'), (1 - p) * 100, label, 'left');
    mk(document.getElementById('hrailright'), p * 100, label, 'left');
  }
}

function wireSweep() {
  const vStage = document.getElementById('sweepvstage');
  const hStage = document.getElementById('sweephstage');
  const hScroll = document.getElementById('hscroll');
  const hud = document.getElementById('sweephud');

  // The viewport's CONTENT box, not innerWidth/innerHeight: those include the classic
  // scrollbars, and the horizontal leg's full-bleed strip is `100vw` wide — which also includes
  // the vertical scrollbar — so the strip's own edges sit a few px OUTSIDE the visible area.
  // Snapping off the scroller's geometry instead of the viewport's put every horizontal mark
  // two percent out. Solve for where the TILE must land and move the scroller by the delta.
  const vpW = () => document.documentElement.clientWidth;
  const vpH = () => document.documentElement.clientHeight;

  function snap(leg, edge, p) {
    if (leg === 'v') {
      const r = vStage.getBoundingClientRect();
      // top edge clipped:    tile.top    = -(1-p)·H     (leading part scrolled off)
      // bottom edge clipped: tile.top    = V - p·H      (trailing part below the fold)
      const want = edge === 'top' ? -(1 - p) * r.height : vpH() - p * r.height;
      window.scrollBy(0, r.top - want); // two-arg form: always instant, never smooth
    } else {
      const r = hStage.getBoundingClientRect();
      const want = edge === 'left' ? -(1 - p) * r.width : vpW() - p * r.width;
      hScroll.scrollLeft += r.left - want;
    }
  }

  for (const btn of document.querySelectorAll('[data-sweep]')) {
    const [leg, edge, p] = btn.dataset.sweep.split(':');
    btn.addEventListener('click', () => snap(leg, edge, parseFloat(p)));
  }

  // Live readout, parked in the far screen gutter so it can never overlap a tile, and shown
  // only while case 07 is on screen.
  const frac = (near, far, size) =>
    size > 0 ? Math.max(0, Math.min(far, size) - Math.max(near, 0)) : 0;
  function refresh() {
    const rv = vStage.getBoundingClientRect();
    const rh = hStage.getBoundingClientRect();
    const v = rv.height ? frac(rv.top, rv.bottom, vpH()) / rv.height : 0;
    const h = rh.width ? frac(rh.left, rh.right, vpW()) / rh.width : 0;
    hud.innerHTML =
      `case&nbsp;07<b>${Math.round(v * 100)}%</b>vertical<b>${Math.round(h * 100)}%</b>horizontal`;
  }
  window.addEventListener('scroll', refresh, { passive: true });
  window.addEventListener('resize', refresh);
  hScroll.addEventListener('scroll', refresh, { passive: true });
  new IntersectionObserver((entries) => {
    for (const e of entries) hud.hidden = !e.isIntersecting;
    refresh();
  }).observe(document.getElementById('c07'));
  refresh();

  return snap;
}

// ── tiles ───────────────────────────────────────────────────────────────────────────────────

// Flat 2D fallback ONLY (no DisplayXR Browser): paint the LEFT eye so the page still shows
// something everywhere. When inline-3D is live the SDK owns these canvases — a stray paint here
// would resize the side-by-side buffer back to a flat square.
function paintFlatImage(canvas, url) {
  const img = new Image();
  img.onload = () => {
    canvas.width = EYE_W;
    canvas.height = EYE_H;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, img.naturalWidth / 2, img.naturalHeight, 0, 0, EYE_W, EYE_H);
  };
  img.src = url;
}

// addVideo() re-draws the <video> into its canvas every decoded frame, so a plain muted+looping
// element is all the SDK needs — no MediaStream, no captureStream.
function makeVideo() {
  const v = document.createElement('video');
  v.src = VIDEO_SRC;
  v.muted = true; // required for autoplay
  v.loop = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.play().catch(() => {
    const kick = () => { v.play().catch(() => {}); window.removeEventListener('pointerdown', kick); };
    window.addEventListener('pointerdown', kick, { once: true });
  });
  return v;
}

function paintFlatVideo(canvas, video) {
  const ctx = canvas.getContext('2d');
  const tick = () => {
    if (video.videoWidth) {
      canvas.width = VIDEO_EYE_W;
      canvas.height = VIDEO_EYE_H;
      ctx.drawImage(video, 0, 0, video.videoWidth / 2, video.videoHeight,
        0, 0, VIDEO_EYE_W, VIDEO_EYE_H);
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// Case 14's live scene. Dynamically imported so a CDN hiccup degrades this one tile instead of
// killing the module graph the other thirteen cases hang off.
async function buildScene(canvas, live) {
  const THREE = await import('three');
  const { EyeCamera } = await import('@displayxr/inline3d/three');

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  // pixelRatio MUST be 1. layer.getViewport() hands back BACKING-STORE pixels, and three's
  // setViewport()/setScissor() multiply whatever you give them by the renderer's pixelRatio —
  // so any other value silently scales each eye's viewport (at dpr 2 the left eye covers the
  // whole canvas and overflows vertically, which reads as a zoomed, off-centre scene that
  // still head-tracks correctly, i.e. it looks like a rig bug and is not one). The backing
  // store is sized in device pixels below instead.
  renderer.setPixelRatio(1);
  renderer.autoClear = false;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d0d40);
  scene.add(new THREE.AmbientLight(0xffffff, 0.35));
  const dir = new THREE.DirectionalLight(0xffffff, 0.7);
  dir.position.set(0.3, 0.8, 0.5);
  scene.add(dir);

  const tex = new THREE.TextureLoader();
  const load = (f, srgb) => {
    const t = tex.load(`${WIN_DIR}Wood_Crate_001_${f}.jpg`);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace; // only basecolor carries colour
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
  cube.geometry.setAttribute('uv2', cube.geometry.attributes.uv); // aoMap samples uv2
  cube.position.set(0, 0.03, 0); // z = 0 → on the zero-disparity plane
  scene.add(cube);
  const grid = new THREE.GridHelper(0.5, 10, 0x4d4d59, 0x4d4d59);
  grid.position.y = -0.05;
  scene.add(grid);

  // Backing store: DOUBLE-WIDTH in device pixels (left eye | right eye) once the session is
  // live. getViewport() splits canvas.width in half, so each eye then gets a full
  // tile-resolution square; the browser squashes the 2:1 buffer into the 1:1 CSS box — which IS
  // the side-by-side squeeze — and the weave un-squeezes it. The MONO fallback stays 1:1, so a
  // 2D-only browser renders one correct un-squeezed view; we only go 2:1 once `live` is true.
  // updateStyle=false: the layout owns the CSS box, never the renderer.
  let sbs = live;
  function size() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round((canvas.clientWidth || 256) * dpr);
    const h = Math.round((canvas.clientHeight || 256) * dpr);
    renderer.setSize(sbs ? w * 2 : w, h, false);
  }
  window.addEventListener('resize', size);
  size();

  let last = 0;
  const spin = () => {
    const now = performance.now();
    const dt = last ? (now - last) / 1000 : 0;
    last = now;
    cube.rotation.y = (cube.rotation.y + dt * 0.5) % (Math.PI * 2);
  };

  if (!live) {
    // Mono preview: one ordinary perspective camera, 1:1 buffer, framed like the stereo pair.
    const cam = new THREE.PerspectiveCamera(45, 1, 0.01, 10);
    cam.position.set(0, 0.05, 0.28);
    cam.lookAt(0, 0.03, 0);
    const tick = () => {
      spin();
      renderer.clear();
      renderer.setViewport(0, 0, canvas.width, canvas.height);
      renderer.render(scene, cam);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return null;
  }

  const eye = new EyeCamera(THREE);
  return function onFrame(views, layer) {
    spin();
    renderer.clear();
    renderer.setScissorTest(true);
    for (const view of views) {
      const vp = layer.getViewport(view);
      if (!vp) continue;
      renderer.setViewport(vp.x, vp.y, vp.width, vp.height);
      renderer.setScissor(vp.x, vp.y, vp.width, vp.height);
      eye.setFromView(view); // projection + pose already scaled by the runtime rig
      renderer.render(scene, eye.camera);
    }
    renderer.setScissorTest(false);
  };
}

function setStatus(mode, text) {
  const el = document.getElementById('status');
  el.className = 'status ' + mode;
  el.textContent = text;
}

// ── boot ────────────────────────────────────────────────────────────────────────────────────
(async function main() {
  buildToc();
  buildRails();
  wireHeaderMode();
  const modal = wireModal();
  const thrash = wireThrash();
  const frost = wireFrostArm();
  const snap = wireSweep();

  const imageTiles = [...document.querySelectorAll('canvas[data-pic]')].map((c) => ({
    canvas: c,
    url: PIC_DIR + c.dataset.pic + '.png',
  }));
  const videoCanvas = document.querySelector('canvas[data-video]');
  const sceneCanvas = document.querySelector('canvas[data-scene]');
  const video = makeVideo();

  // ONE session for the whole document (rule 1), with the SDK's exclusion machinery stood
  // down (rule 2). createInline3D detects by acquiring a real session — isSessionSupported()
  // false-negatives before the OS weave service binds.
  const wall = await createInline3D({ autoChrome: false });

  Object.assign(window, {
    __showcase: { wall, snap, modal, thrash, frost, video },
    __wall: wall, // same console hook the other samples expose
  });

  if (!wall.supported) {
    for (const t of imageTiles) paintFlatImage(t.canvas, t.url);
    paintFlatVideo(videoCanvas, video);
    buildScene(sceneCanvas, false).catch(() => {});
    setStatus('flat',
      'Flat 2D preview — open in the DisplayXR Browser on a 3D display to weave these 14 cases. '
      + 'Every case is still laid out exactly as it will be judged.');
    return;
  }

  // width/height are PER EYE, so the buffer is the assets' native side-by-side with no
  // resampling. cornerRadius stays 0 across the page — case 11 judges a hard seam.
  for (const t of imageTiles) {
    wall.addImage(t.canvas, t.url, { width: EYE_W, height: EYE_H, cornerRadius: 0 });
  }
  wall.addVideo(videoCanvas, video, { width: VIDEO_EYE_W, height: VIDEO_EYE_H, cornerRadius: 0 });

  buildScene(sceneCanvas, true)
    .then((onFrame) => { if (onFrame) wall.addScene(sceneCanvas, onFrame, { cornerRadius: 0 }); })
    .catch((err) => {
      const cap = sceneCanvas.closest('.stage')?.parentElement?.querySelector('.cap');
      if (cap) cap.textContent = `scene tile unavailable: ${err?.message || err}`;
    });

  // One session, closed exactly once. Two live managers in one document overwrite each other's
  // element-rect list every frame, so leaving this one open across a bfcache restore into
  // another inline-3D page is the trap the SDK warns about.
  window.addEventListener('pagehide', () => wall.close());

  // Which occlusion mechanism is live. Purely informational — the page code is identical either
  // way — but it is the first thing to check when a case reads red: on a browser WITHOUT
  // draw-order occlusion most of this matrix cannot pass, because the page declares nothing.
  const path = inline3dOcclusionByDrawOrder()
    ? 'draw-order occlusion (automatic)'
    : 'NO draw-order occlusion — this page declares nothing, so most cases will read red here';

  const refresh = () => setStatus('woven',
    `DisplayXR Browser — ${imageTiles.length} stills + 1 video + 1 scene, `
    + `${wall.liveCount} woven layers live · ${path}`);
  refresh();
  setInterval(refresh, 500); // liveCount changes as you scroll (lazy lifecycle)
})();

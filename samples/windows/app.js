// Mixed 3D windows — the inline-3D SDK carrying all three content types on one page:
// still SBS photos, a live SBS video, and a real-time three.js scene, all on one session.

import * as THREE from 'three';
import { createInline3D } from '@displayxr/inline3d';
import { EyeCamera } from '@displayxr/inline3d/three';

const PHOTOS = ['avatar', 'gaussiansplat', 'modelviewer', 'earthview', 'mediaplayer'];

function setStatus(mode, text) {
  const el = document.getElementById('status');
  el.className = 'status ' + mode;
  el.textContent = text;
}

// Build the photo tiles (canvases) up front so they exist in flat 2D too.
function buildPhotoTiles() {
  const grid = document.getElementById('photos');
  const tiles = [];
  for (const key of PHOTOS) {
    const stage = document.createElement('div');
    stage.className = 'stage';
    const canvas = document.createElement('canvas');
    stage.appendChild(canvas);
    grid.appendChild(stage);
    tiles.push({ key, canvas, url: `assets/${key}.png` });
  }
  return tiles;
}

// A real side-by-side 3D video, 1280x360 (640x360 per eye).
//
// SIZE: the tile is ~1208x680 device px, but a 3D display's recommended render scale is
// ~0.5x0.5 — after the interlace each eye only receives about half the panel's samples — so
// ~604x340 of real detail per eye is all that survives. Encoding past that is download weight
// for pixels the weave throws away. Hence 640x360/eye, and 5 MB instead of 32.
//
// CODEC: VP9/WebM, not H.264/mp4. Stock Chromium builds ship ffmpeg_branding="Chromium" with
// proprietary_codecs off, so an .mp4 fails with MEDIA_ERR_SRC_NOT_SUPPORTED in any dev build.
// VP9 is royalty-free and always compiled in, so this plays everywhere the SDK does.
//
// addVideo() re-draws the <video> into its canvas every frame, so a plain muted+looping
// element is all the SDK needs; no MediaStream, no captureStream.
function makeSbsVideo() {
  const video = document.createElement('video');
  video.src = './assets/flymetothemoon_sbs.webm';
  video.muted = true;      // required for autoplay
  video.loop = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.play().catch(() => {
    // Autoplay can still be refused; start on the first user gesture instead.
    const kick = () => { video.play().catch(() => {}); window.removeEventListener('pointerdown', kick); };
    window.addEventListener('pointerdown', kick, { once: true });
  });
  return video;
}

// ---- three.js scene (crate) ----------------------------------------------------------------
function buildScene(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  // pixelRatio MUST be 1. layer.getViewport() hands back BACKING-STORE pixels, and
  // three.js's setViewport()/setScissor() multiply whatever you give them by the
  // renderer's pixelRatio — so any other value silently scales each eye's viewport
  // (at dpr 2 the left eye covers the whole canvas and overflows vertically, which
  // reads on screen as a zoomed, off-centre scene that still head-tracks correctly).
  // We size the backing store in device pixels ourselves below instead.
  renderer.setPixelRatio(1);
  renderer.autoClear = false;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d0d40);
  scene.add(new THREE.AmbientLight(0xffffff, 0.35));
  const dir = new THREE.DirectionalLight(0xffffff, 0.7);
  dir.position.set(0.3, 0.8, 0.5);
  scene.add(dir);

  // Authored in metres at the cube_handle reference's scale: a 6 cm crate on the z=0 plane over
  // a 0.5 m grid. That is the whole contract of a DISPLAY rig — author at a fixed scale for a
  // fixed window, declare the one scale number, and consume render-ready views. There is NO
  // app-side world scaling and no app-side projection math.
  // Same wood-crate PBR set the native cube_handle reference app uses, so the
  // browser scene and the native scene show the identical object.
  const tex = new THREE.TextureLoader();
  const load = (f, srgb) => {
    const t = tex.load(`./assets/Wood_Crate_001_${f}.jpg`);
    // Only the basecolor carries colour; normal/AO are raw data and must stay linear.
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
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
    })
  );
  // aoMap samples uv2; BoxGeometry only ships uv, so alias it.
  cube.geometry.setAttribute('uv2', cube.geometry.attributes.uv);
  cube.position.set(0, 0.03, 0); // z=0 → on the zero-disparity plane
  scene.add(cube);
  const grid = new THREE.GridHelper(0.5, 10, 0x4d4d59, 0x4d4d59);
  grid.position.y = -0.05;
  scene.add(grid);

  // Side-by-side backing store: DOUBLE-WIDTH in device pixels (left eye | right eye).
  // getViewport() splits canvas.width in half, so each eye then gets a full
  // tile-resolution square. The browser squashes the 2:1 buffer into the 1:1 CSS box —
  // which IS the SBS squeeze — and the weave un-squeezes it back. Sizing to the CSS box
  // instead would render each eye at half width and upscale it on the way out.
  // updateStyle=false: the layout owns the CSS box, never the renderer.
  function size() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round((canvas.clientWidth || 256) * dpr);
    const h = Math.round((canvas.clientHeight || 256) * dpr);
    renderer.setSize(w * 2, h, false);
  }
  window.addEventListener('resize', size);
  size();

  // ---- this tile runs on the DISPLAY rig --------------------------------------------------
  //
  // Every tile on this page is a portal, this one included: the canvas frames a SUBJECT (a crate
  // on a turntable), it does not carry a viewpoint the user moves through a world. A display rig
  // is the right model for that, and it is scale-invariant — the runtime scales the eye poses by
  // virtualDisplayHeight / the element's physical height, so the crate reads the same depth
  // whatever size the element is laid out at and whatever units the scene is authored in.
  //
  // A camera rig would be the wrong tool here twice over. It would need an app camera invented
  // purely to be handed over, and because its ipd/parallax are ABSOLUTE it would give a 6 cm
  // crate the full 63 mm human eye separation — a scene two decades below metre scale, with a
  // 0.28-unit convergence at 3.6 diopters, lands the comfort product (ipd × m2v × diopters × 0.5)
  // at 1.8, well past the 1 where eyes diverge on far content. Correcting that with
  // metersToVirtual is exactly the "scale correction" that means the scene wanted a display rig.
  // See samples/camera-rig/ for a scene that genuinely owns a viewpoint.
  //
  // One EyeCamera per eye, unparented: on a display rig the reported eye pose is already in
  // world space, so setFromView applies it directly (setLocalFromView + a parent is the attach
  // pattern, and belongs only to a camera rig).
  const eyes = [new EyeCamera(THREE), new EyeCamera(THREE)];

  let last = 0;
  function onFrame(views, layer) {
    const now = performance.now();
    const dt = last ? (now - last) / 1000 : 0;
    last = now;
    cube.rotation.y = (cube.rotation.y + dt * 0.5) % (Math.PI * 2);
    renderer.clear();
    renderer.setScissorTest(true);
    for (let i = 0; i < views.length && i < eyes.length; i++) {
      const vp = layer.getViewport(views[i]);
      if (!vp) continue;
      renderer.setViewport(vp.x, vp.y, vp.width, vp.height);
      renderer.setScissor(vp.x, vp.y, vp.width, vp.height);
      // setFrom, not setLocal: a display rig reports the eye pose in world space and these
      // cameras have no parent, so the view's transform IS the world transform.
      eyes[i].setFromView(views[i]);
      renderer.render(scene, eyes[i].camera);
    }
    renderer.setScissorTest(false);
  }

  return { onFrame };
}

// ---- boot ----------------------------------------------------------------------------------
(async () => {
  const photoTiles = buildPhotoTiles();

  const wall = await createInline3D(); // lazy on by default
  if (!wall.supported) {
    // Flat 2D: paint the left eye of each photo so the page still shows something.
    setStatus('flat',
      'Flat 2D preview — open in the DisplayXR Browser on a 3D display to weave these windows.');
    for (const t of photoTiles) {
      const img = new Image();
      img.onload = () => {
        t.canvas.width = t.canvas.clientWidth || 200;
        t.canvas.height = t.canvas.clientHeight || 200;
        const ctx = t.canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, img.naturalWidth / 2, img.naturalHeight,
          0, 0, t.canvas.width, t.canvas.height);
      };
      img.src = t.url;
    }
    return;
  }

  // Weave everything on the one wall.
  for (const t of photoTiles) wall.addImage(t.canvas, t.url, { cornerRadius: 28 });
  wall.addVideo(document.getElementById('movie'), makeSbsVideo());
  const sceneCanvas = document.getElementById('scene');
  const live = buildScene(sceneCanvas);
  // 0.24 m of world across the tile's HEIGHT — the crate is 6 cm, so it takes about a quarter of
  // the window. This one scalar is the whole rig; halving it zooms in, doubling it pulls back.
  wall.addScene(sceneCanvas, live.onFrame, { virtualDisplayHeight: 0.24 });

  window.__wall = wall;
  const tick = () => {
    setStatus('woven',
      `DisplayXR Browser — ${PHOTOS.length} photos + 1 video + 1 scene, ${wall.liveCount} windows woven now.`);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();

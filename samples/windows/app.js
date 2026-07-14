// Mixed 3D windows — the inline-3D SDK carrying all three content types on one page:
// still SBS photos, a live SBS video, and a real-time three.js scene, all on one session.

import * as THREE from 'three';
import { createInline3D } from '../../js/inline3d.js';
import { EyeCamera } from '../../js/inline3d-three.js';

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

// A synthetic side-by-side "3D video": an offscreen canvas animates a shape with horizontal
// PARALLAX between the left and right halves (nearer = more offset), captured as a real
// MediaStream video. This exercises addVideo's per-frame drawImage(videoEl) path with real
// decoded frames — a shipped SBS .mp4 would be wired identically.
function makeSbsVideo() {
  const src = document.createElement('canvas');
  src.width = 1280;
  src.height = 360; // 2:1-ish SBS (each 640×360 eye = 16:9)
  const ctx = src.getContext('2d');
  const eyeW = src.width / 2;
  let t = 0;
  function draw() {
    t += 0.016;
    for (let eye = 0; eye < 2; eye++) {
      const ox = eye * eyeW;
      ctx.fillStyle = '#0b1020';
      ctx.fillRect(ox, 0, eyeW, src.height);
      // Two orbiting discs at different depths → different L/R parallax.
      for (const d of [{ r: 46, depth: 26, col: '#5aa8ff', ph: 0 },
                       { r: 30, depth: 10, col: '#f0a35a', ph: 2.1 }]) {
        const cx = ox + eyeW / 2 + Math.cos(t + d.ph) * 120 - (eye === 1 ? d.depth : -d.depth);
        const cy = src.height / 2 + Math.sin(t + d.ph) * 60;
        ctx.beginPath();
        ctx.arc(cx, cy, d.r, 0, Math.PI * 2);
        ctx.fillStyle = d.col;
        ctx.fill();
      }
    }
    requestAnimationFrame(draw);
  }
  draw();
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = src.captureStream(30);
  video.play().catch(() => {});
  return video;
}

// ---- three.js scene (crate) ----------------------------------------------------------------
function buildScene(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.autoClear = false;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d0d40);
  scene.add(new THREE.AmbientLight(0xffffff, 0.35));
  const dir = new THREE.DirectionalLight(0xffffff, 0.7);
  dir.position.set(0.3, 0.8, 0.5);
  scene.add(dir);

  // Authored in metres for a 0.24 m virtual display (addScene's virtualDisplayHeight); the
  // runtime scales the eye poses so this renders correctly with NO app-side scaling. Matches
  // the cube_handle reference: a 6 cm crate on the z=0 plane over a 0.5 m grid.
  const cube = new THREE.Mesh(
    new THREE.BoxGeometry(0.06, 0.06, 0.06),
    new THREE.MeshStandardMaterial({ color: 0xb9884e, roughness: 0.7, metalness: 0.05 })
  );
  cube.position.set(0, 0.03, 0); // z=0 → on the zero-disparity plane
  scene.add(cube);
  const grid = new THREE.GridHelper(0.5, 10, 0x4d4d59, 0x4d4d59);
  grid.position.y = -0.05;
  scene.add(grid);

  function size() {
    const w = canvas.clientWidth || 256, h = canvas.clientHeight || 256;
    renderer.setSize(w, h, false);
  }
  window.addEventListener('resize', size);
  size();

  const eye = new EyeCamera(THREE);
  let last = 0;
  return function onFrame(views, layer) {
    const now = performance.now();
    const dt = last ? (now - last) / 1000 : 0;
    last = now;
    cube.rotation.y = (cube.rotation.y + dt * 0.5) % (Math.PI * 2);
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
  wall.addScene(document.getElementById('scene'), buildScene(document.getElementById('scene')));

  window.__wall = wall;
  const tick = () => {
    setStatus('woven',
      `DisplayXR Browser — ${PHOTOS.length} photos + 1 video + 1 scene, ${wall.liveCount} windows woven now.`);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();

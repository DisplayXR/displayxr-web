// starter-world — a first-person walk-through on a CAMERA rig. Copy this for a game, a
// flythrough, an editor or a ported WebXR scene. Rules: docs/making-3d-look-right.md.
//
// RIG (guide §1): the user moves THROUGH a world, so a camera rig — the app owns its camera and
// the runtime turns it into two eyes. The world is authored in metres.
//
// SCREEN PLANE (§2): ONE fixed, finite convergence for the room. It is not driven by gaze or the
// cursor (the world would breathe) and never 0 (infinity puts the whole room in front of the
// glass). It must keep everything in the outer ~10 % of EVERY edge (floor, walls, ceiling,
// furniture against the walls) at or behind the glass at EVERY pose the visitor can reach, so
// three knobs are set together:
//   CONVERGENCE 1.6 m · walls and furniture kept CLEAR = 2.5 m away · pitch limited to ±30°.
// Why the clearance is not "half the convergence": a wall you face squarely is all at its
// distance, and the frame's corner rays reach a wall seen at an angle sooner than that — at worst
// 1/√(1 + tan²(hfov/2) + tan²(vfov/2)) ≈ 0.65 of it on this 16:9, 60° frame. So the clearance
// must be ≥ CONVERGENCE / 0.65 ≈ 2.5 m. The floor at the pitch limit sits at
// EYE_H / (sin 30° + tan 30° · cos 30°) = 1.6 m: on the glass.
//
// DEPTH (§3, full-frame column). With the plane that near, the far end is the budget:
// behind (% of width) = 100·0.063·IPD·(1/D − 1/z) / (2·tan(fov/2)·aspect), which at IPD 1 is
// 1.9 % at infinity. IPD = 0.5 halves it: ≤ 0.96 % for anything, however far.
// `checkReachablePoses()` below verifies all of it with cameraRigDisparityPct() (open the page
// with ?check: nearest edge content 0.00 %, farthest +0.83 %). Measured by the headless stereo
// judge: start pose front p2 +0.5 % / behind p98 +0.8 %; walked into the far-left corner, turned to
// the wall and looking down at the limit +0.05 % / +0.6 %; facing the sofa wall +0.3 % / +0.5 %
// (full-frame comfortable: ≥ −0.3 % / ≤ 1.0 %, and ≈ 0 or behind at the edges).

import * as THREE from 'three';
import { createInline3D } from '@displayxr/inline3d';
import { EyeCamera, cameraRigFromCamera } from '@displayxr/inline3d/three';
import { cameraRigDisparityPct } from '@displayxr/inline3d/depth';

const canvas = document.getElementById('world');
const cover = document.getElementById('cover');
const hud = document.getElementById('hud');

const FOV = 60;                       // full vertical angle, degrees
const EYE_H = 1.6;                    // eye height, metres
const CONVERGENCE = 1.6;              // metres, fixed for this room (see SCREEN PLANE)
const IPD = 0.5;                      // eye separation factor, ABSOLUTE on a camera rig (1 = 63 mm)
const CLEAR = 2.5;                    // metres kept between the eye and any wall or furniture face
const PITCH_MAX = THREE.MathUtils.degToRad(30);
const ROOM = { w: 9, h: 3.6, near: 1, far: -12 };  // x ∈ ±4.5, y ∈ [0, 3.6], z ∈ [−12, 1]
const BAND = 0.9;                     // furniture stands in a 0.9 m band along the walls
// Where the eye may go: the room minus the wall band, minus the clearance.
const WALK = { x: ROOM.w / 2 - BAND - CLEAR, zMin: ROOM.far + BAND + CLEAR, zMax: ROOM.near - CLEAR };
const BG = 0x15171c;

// ---- renderer + camera -------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setClearColor(BG, 1);        // OPAQUE clear (a transparent pixel weaves as stale/black)
renderer.setPixelRatio(1);            // getViewport() is in store px; see sizeStore()
renderer.autoClear = false;
const scene = new THREE.Scene();
// The app camera. IN the scene: the eye cameras hang under it (the attach pattern), and three only
// composes a parented camera's world matrix through a scene traversal.
const cam = new THREE.PerspectiveCamera(FOV, 16 / 9, 0.05, 30);
cam.position.set(0, EYE_H, WALK.zMax);
scene.add(cam);

// ---- the room: procedural, irregular textures (the eyes need detail to fuse; repeats confuse them)
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
function tex(base, { repeat = [1, 1], planks = 0, spots = 1500, contrast = 0.2, r = 8 } = {}) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = base;
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < planks; i++) {  // boards: a tone per board, a dark seam between
    g.fillStyle = `rgba(${rnd() < 0.5 ? '0,0,0' : '255,255,255'},${rnd() * 0.18})`;
    g.fillRect(0, (i * 256) / planks, 256, 256 / planks);
    g.fillStyle = 'rgba(0,0,0,0.45)';
    g.fillRect(0, (i * 256) / planks, 256, 2);
  }
  for (let i = 0; i < spots; i++) {   // soft, random blotches of every size
    g.fillStyle = `rgba(${rnd() < 0.5 ? '0,0,0' : '255,255,255'},${rnd() * contrast})`;
    g.beginPath();
    g.arc(rnd() * 256, rnd() * 256, 1 + rnd() * rnd() * r, 0, 7);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(...repeat);
  t.anisotropy = 8;
  return t;
}
const mat = (base, o) => new THREE.MeshStandardMaterial({ map: tex(base, o), roughness: 0.85 });
function box(w, h, d, x, y, z, m, ry = 0) {
  const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  b.position.set(x, y, z);
  b.rotation.y = ry;
  scene.add(b);
  return b;
}
const L = ROOM.near - ROOM.far, MZ = (ROOM.near + ROOM.far) / 2;
const plane = (w, h, m, pos, rot) => {
  const p = new THREE.Mesh(new THREE.PlaneGeometry(w, h), m);
  p.position.set(...pos);
  p.rotation.set(...rot);
  scene.add(p);
};
plane(ROOM.w, L, mat('#8a6a4a', { planks: 10, repeat: [2, 4], r: 4 }), [0, 0, MZ], [-Math.PI / 2, 0, 0]);       // floor
plane(ROOM.w, L, mat('#d9d4c8', { repeat: [2, 3], contrast: 0.08 }), [0, ROOM.h, MZ], [Math.PI / 2, 0, 0]); // ceiling
const wallMat = mat('#b9a98f', { repeat: [3, 1], contrast: 0.12, spots: 3000, r: 5 });
plane(L, ROOM.h, wallMat, [-ROOM.w / 2, ROOM.h / 2, MZ], [0, Math.PI / 2, 0]);
plane(L, ROOM.h, wallMat, [ROOM.w / 2, ROOM.h / 2, MZ], [0, -Math.PI / 2, 0]);
plane(ROOM.w, ROOM.h, wallMat, [0, ROOM.h / 2, ROOM.far], [0, 0, 0]);
plane(ROOM.w, ROOM.h, wallMat, [0, ROOM.h / 2, ROOM.near], [0, Math.PI, 0]);
// Furniture stands only in the BAND along the walls; the middle is open floor (a rug). A table in
// the middle would need the same clearance as a wall all round it.
plane(3, 4, mat('#7a2e2e', { spots: 900, contrast: 0.35 }), [0, 0.005, -5.5], [-Math.PI / 2, 0, 0]); // rug
const wood = mat('#6b4a2e', { planks: 6, contrast: 0.2 });
const fabric = mat('#3d5a7a', { spots: 900, contrast: 0.3 });
const R = ROOM.w / 2;
box(0.9, 0.45, 2.4, R - 0.45, 0.22, -6, fabric);                                  // sofa (right wall)
box(0.25, 0.5, 2.4, R - 0.12, 0.6, -6, fabric);
box(0.5, 0.8, 1.8, -R + 0.25, 0.4, -4, wood);                                      // sideboard (left wall)
const shelf = box(2.4, 2.2, 0.35, 0, 1.1, ROOM.far + 0.18, wood);                 // bookshelf (far wall)
for (let r = 0; r < 4; r++) for (let x = -1.1; x < 1.05; x += 0.05 + rnd() * 0.06) {
  const h = 0.3 + rnd() * 0.18;
  box(0.045, h, 0.25, x, 0.15 + r * 0.52 + h / 2, shelf.position.z + 0.05,
    new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(rnd(), 0.45, 0.25 + rnd() * 0.35) }));
}
for (const [z, c] of [[-7, '#3f6b4f'], [-9.5, '#a0663a']]) {                      // two paintings
  plane(1.2, 0.8, mat(c, { spots: 1500, contrast: 0.5 }), [-R + 0.01, 1.7, z], [0, Math.PI / 2, 0]);
}
const lampLight = new THREE.PointLight(0xffd9a0, 8, 10, 1.5);                     // floor lamp
lampLight.position.set(-R + 0.4, 1.7, -10.5);
scene.add(lampLight);
box(0.05, 1.6, 0.05, -R + 0.4, 0.8, -10.5, wood);
const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.25, 0.3, 24, 1, true), mat('#e8d9b0', { contrast: 0.1 }));
shade.position.set(-R + 0.4, 1.7, -10.5);
shade.material.side = THREE.DoubleSide;
scene.add(shade);
scene.add(new THREE.HemisphereLight(0xfff4e0, 0x403028, 1.6));

// ---- input: WASD / arrows to walk, drag to look (no pointer lock needed) --------------------------
const keys = new Set();
addEventListener('keydown', (e) => keys.add(e.code));
addEventListener('keyup', (e) => keys.delete(e.code));
let yaw = 0, pitch = 0, drag = null;
canvas.addEventListener('pointerdown', (e) => { drag = [e.clientX, e.clientY]; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointerup', () => { drag = null; });
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  yaw -= (e.clientX - drag[0]) * 0.004;
  pitch = Math.max(-PITCH_MAX, Math.min(PITCH_MAX, pitch - (e.clientY - drag[1]) * 0.004));
  drag = [e.clientX, e.clientY];
});
let lastT = 0;
function move(now) {
  const dt = lastT ? Math.min((now - lastT) / 1000, 0.1) : 0;
  lastT = now;
  const f = (keys.has('KeyW') || keys.has('ArrowUp')) - (keys.has('KeyS') || keys.has('ArrowDown'));
  const s = (keys.has('KeyD') || keys.has('ArrowRight')) - (keys.has('KeyA') || keys.has('ArrowLeft'));
  const v = 1.6 * dt;                // walking speed, m/s
  cam.position.x += (-Math.sin(yaw) * f + Math.cos(yaw) * s) * v;
  cam.position.z += (-Math.cos(yaw) * f - Math.sin(yaw) * s) * v;
  cam.position.x = Math.max(-WALK.x, Math.min(WALK.x, cam.position.x));        // the clearance
  cam.position.z = Math.max(WALK.zMin, Math.min(WALK.zMax, cam.position.z));
  cam.rotation.set(pitch, yaw, 0, 'YXZ');
}

// ---- verify the depth at the reachable extremes (?check) ------------------------------------------
// Casts rays through the outer 10 % of every edge and the middle of the frame, takes each hit's
// distance along the view axis, and turns it into disparity with the SAME rig numbers the runtime
// gets. Front of the glass is negative. Run it after changing the room, CONVERGENCE, CLEAR or PITCH.
const ray = new THREE.Raycaster();
function poseDisparity() {
  cam.updateMatrixWorld();
  const o = { convergence: CONVERGENCE, ipdFactor: IPD, verticalFov: THREE.MathUtils.degToRad(FOV), aspect: cam.aspect };
  let edge = Infinity, far = -Infinity;
  for (let i = 0; i <= 20; i++) for (let j = 0; j <= 20; j++) {
    const u = i / 10 - 1, v = j / 10 - 1, inEdge = Math.abs(u) >= 0.8 || Math.abs(v) >= 0.8;
    ray.setFromCamera({ x: u, y: v }, cam);
    const hit = ray.intersectObjects(scene.children, false)[0];
    if (!hit) continue;
    const z = -hit.point.clone().applyMatrix4(cam.matrixWorldInverse).z;
    const d = cameraRigDisparityPct({ z, ...o });
    if (inEdge) edge = Math.min(edge, d);
    far = Math.max(far, d);
  }
  return { edge, far };
}
function checkReachablePoses() {
  const save = [cam.position.clone(), yaw, pitch];
  let worst = { edge: Infinity, far: -Infinity };
  for (const x of [-WALK.x, 0, WALK.x]) for (const z of [WALK.zMin, WALK.zMax]) {
    for (let a = 0; a < 360; a += 15) for (const p of [-PITCH_MAX, 0, PITCH_MAX]) {
      cam.position.set(x, EYE_H, z);
      cam.rotation.set(p, THREE.MathUtils.degToRad(a), 0, 'YXZ');
      const r = poseDisparity();
      if (r.edge < worst.edge) worst = { ...worst, edge: r.edge, at: [x, z, a, p] };
      worst.far = Math.max(worst.far, r.far);
    }
  }
  [cam.position.x, cam.position.y, cam.position.z] = save[0].toArray();
  console.info(`[starter-world] reachable poses: nearest edge content ${worst.edge.toFixed(2)} % ` +
    `(at x,z,yaw,pitch ${worst.at.map((n) => +n.toFixed(2))}), farthest ${worst.far.toFixed(2)} % of the width`);
}

// ---- backing store: 2x wide woven, 1:1 flat. Sized BEFORE registering, then only in onResize ------
let sbs = false;
function sizeStore(cssW = canvas.clientWidth, cssH = canvas.clientHeight, dpr = devicePixelRatio || 1) {
  const w = Math.max(1, Math.round(cssW * dpr)), h = Math.max(1, Math.round(cssH * dpr));
  renderer.setSize(sbs ? 2 * w : w, h, false);
  cam.aspect = w / h;
  cam.updateProjectionMatrix();
}

// ---- woven path: the attach pattern, drawn from the last GOOD frame ------------------------------
// The rig is sent ONCE with an identity pose (attach: true): the eyes are parented under `cam`, so
// three supplies THIS frame's camera pose — no one-frame rig lag while you turn.
const eyes = [new EyeCamera(THREE), new EyeCamera(THREE)];
for (const e of eyes) cam.add(e.camera);
let last = null;                     // copies: an XRView is valid only inside its own frame

function onXRFrame(views, layer) {
  move(performance.now());
  // Validate before clearing; a short view list (the session under load) replays the last frame.
  const vps = views && views.length >= 2 ? views.map((v) => layer.getViewport(v)) : null;
  if (vps && vps.every((vp) => vp && vp.width > 0 && vp.height > 0)) {
    last = views.slice(0, 2).map((v, i) => ({
      proj: Array.from(v.projectionMatrix), pose: Array.from(v.transform.matrix),
      vp: { x: vps[i].x, y: vps[i].y, width: vps[i].width, height: vps[i].height },
    }));
  }
  drawEyes();
}
function drawEyes() {
  if (!last) return;
  renderer.clear();
  renderer.setScissorTest(true);
  last.forEach((e, i) => {
    renderer.setViewport(e.vp.x, e.vp.y, e.vp.width, e.vp.height);
    renderer.setScissor(e.vp.x, e.vp.y, e.vp.width, e.vp.height);
    eyes[i].setLocalFromMatrices(e.proj, e.pose);   // rig-local eye pose, under `cam`
    renderer.render(scene, eyes[i].camera);
  });
  renderer.setScissorTest(false);
}
function onResize({ width, height, dpr }) {     // inside the SDK's observer, before paint
  sizeStore(width, height, dpr);
  if (!last) return;
  const w = canvas.width / 2;
  last.forEach((e, i) => { e.vp = { x: i * w, y: 0, width: w, height: canvas.height }; });
  drawEyes();
}

// ---- mono path: the same camera, drawn once --------------------------------------------------------
function onMonoFrame(now) {
  requestAnimationFrame(onMonoFrame);
  move(now);
  renderer.clear();
  renderer.setViewport(0, 0, canvas.width, canvas.height);
  renderer.render(scene, cam);
}

// ---- boot ------------------------------------------------------------------------------------------
const wall = await createInline3D({ lazy: false });
if (wall.supported) {
  sbs = true;
  sizeStore();                                   // size BEFORE registering
  const handle = wall.addScene(canvas, onXRFrame, {
    viewRig: cameraRigFromCamera(THREE, cam, { convergence: CONVERGENCE, ipdFactor: IPD, attach: true }),
    onResize,
  });
  // Each eye's projection is built from the session's near/far: give it the camera's.
  wall.session.updateRenderState({ depthNear: cam.near, depthFar: cam.far });
  hud.textContent = 'WASD / arrows to walk · drag to look';
  await handle.firstWoven;                       // cover until the first woven frame
  cover.remove();                                // cut, never fade
} else {
  sizeStore();
  new ResizeObserver(() => sizeStore()).observe(canvas);
  cover.remove();
  hud.textContent = 'WASD / arrows to walk · drag to look · 2D (open in the DisplayXR Browser for 3D)';
  requestAnimationFrame(onMonoFrame);
}
if (new URLSearchParams(location.search).has('check')) checkReachablePoses();

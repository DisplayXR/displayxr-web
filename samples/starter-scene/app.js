// starter-scene — your own three.js object scene, framed by SceneViewer on a DISPLAY rig. Copy
// this for a diorama, a product configurator, an animated set piece. Rules:
// docs/making-3d-look-right.md.
//
// RIG (guide §1): the user LOOKS AT a thing; nobody walks through it. So a display rig: the canvas
// is a portal onto a virtual display VDH metres tall, and SceneViewer scales the subject into it
// (so its depth does not depend on how big you modelled it). Near/far are set on the session by
// the page (no SDK viewer does it), and the ground is scene, not subject (see below).
//
// SCREEN PLANE (§2): through the subject — SceneViewer centres it on the glass — then nudged back
// with depthOffset so that the comfortable budget's larger "behind" half is used too.
//
// DEPTH (§3): depthFit shrinks the subject UNIFORMLY until its nearest point is ≤ FRONT and its
// farthest ≤ BACK tile heights from the glass. 0.1 h ≈ 0.6 % and 0.27 h ≈ 1.5 % of the width on a
// 16:9 tile (the comfortable column; on another shape multiply both by aspect / 1.78).
// Measured by the headless stereo judge: front p2 ≈ −0.2 %, behind p98 ≈ +1.0 % of the width.

import * as THREE from 'three';
import { createInline3D } from '@displayxr/inline3d';
import { EyeCamera } from '@displayxr/inline3d/three';
import { SceneViewer } from '@displayxr/inline3d/viewer';

const canvas = document.getElementById('scene');
const cover = document.getElementById('cover');
const VDH = 0.24;                      // virtual display height, metres — pass the SAME to addScene
const FRONT = 0.1, BACK = 0.27;        // depth budget, tile heights (16:9)
const BG = '#0d1626';                  // == the page colour behind the canvas (index.html)

const viewer = new SceneViewer(THREE, canvas, {
  virtualDisplayHeight: VDH,
  clearColor: BG,                      // OPAQUE clear: alpha-0 pixels weave as stale/black
  depthFit: { front: FRONT, back: BACK },
  fitSweep: false,                     // nothing turns the subject about Y, so budget its real depth
  orbit: false,                        // drag-to-orbit would swing the wheel's width into depth,
                                       // past the budget it was fitted to; head tracking still looks around
  // no `feather`: it fades to transparent, which needs an alpha clear (guide §5)
}).useEyeCamera(EyeCamera);

// ---- the content: a small fairground wheel, modelled in any units ---------------------------------
let seed = 3;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
function speckle(base, contrast = 0.25) {     // irregular texture: stereo matching needs detail
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = base;
  g.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 900; i++) {
    g.fillStyle = `rgba(${rnd() < 0.5 ? '0,0,0' : '255,255,255'},${rnd() * contrast})`;
    g.fillRect(rnd() * 128, rnd() * 128, 1 + rnd() * 5, 1 + rnd() * 5);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshStandardMaterial({ map: t, roughness: 0.6, metalness: 0.1 });
}
const steel = speckle('#c9ced6', 0.15);
const R = 1, SEATS = 12;
const set = new THREE.Group();               // the whole set piece
const wheel = new THREE.Group();             // the part that turns
wheel.position.y = 0.2;
for (const z of [-0.15, 0.15]) {
  const rim = new THREE.Mesh(new THREE.TorusGeometry(R, 0.03, 8, 64), steel);
  rim.position.z = z;
  wheel.add(rim);
  for (let i = 0; i < SEATS; i++) {
    const spoke = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, R, 6), steel);
    const a = (i / SEATS) * Math.PI * 2;
    spoke.position.set((Math.cos(a) * R) / 2, (Math.sin(a) * R) / 2, z);
    spoke.rotation.z = a - Math.PI / 2;
    wheel.add(spoke);
  }
}
wheel.add(new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.4, 16).rotateX(Math.PI / 2), steel));
const seats = [];
for (let i = 0; i < SEATS; i++) {
  const a = (i / SEATS) * Math.PI * 2;
  const pivot = new THREE.Group();
  pivot.position.set(Math.cos(a) * R, Math.sin(a) * R, 0);
  const cab = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.18, 0.22), speckle(`hsl(${(i * 47) % 360} 60% 52%)`));
  cab.position.y = -0.13;                    // hangs below its pivot
  pivot.add(cab);
  wheel.add(pivot);
  seats.push(pivot);
}
set.add(wheel);
for (const z of [-0.3, 0.3]) for (const s of [-1, 1]) {        // the A-frame stand
  const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.035, 1.5, 8), steel);
  leg.position.set(s * 0.32, -0.45, z);
  leg.rotation.z = s * 0.43;
  set.add(leg);
}
// Square to the glass (yaw spends depth: turned 45°, this wide, shallow wheel would be as deep as it
// is wide and the fit would shrink it), tilted a little to show the hub. Head tracking does the
// looking around.
set.rotation.x = THREE.MathUtils.degToRad(8);
viewer.content.add(set);
const sun = new THREE.DirectionalLight(0xfff1dd, 2.2);
sun.position.set(1, 2, 3);
viewer.scene.add(sun, new THREE.HemisphereLight(0xa8c4ff, 0x302418, 1.1));

// Frame on the box the subject really occupies (after its tilt), so depthFit sees its true depth.
viewer.depthOffset = -((BACK - FRONT) / 2) * VDH;   // centre 0.085 h behind the glass: both ends at budget
const box = new THREE.Box3().setFromObject(viewer.content);
viewer.fitTo(box.getCenter(new THREE.Vector3()), box.getSize(new THREE.Vector3()));

// The ground is NOT the subject: it lives in viewer.scene (display metres, glass at z = 0), so
// depthFit sizes the wheel alone. Budget it by hand: under the wheel, spanning the depth budget.
const fit = viewer.getSubjectBounds();
const deck = new THREE.Mesh(
  new THREE.BoxGeometry(fit.extent.x * 1.4, 0.004, (FRONT + BACK) * VDH * 0.9),
  speckle('#6b5a45', 0.35),
);
deck.position.set(0, -fit.extent.y / 2 - 0.002, viewer.depthOffset);
viewer.scene.add(deck);

// ---- animation: SceneViewer calls onTick once per drawn frame, woven or flat ----------------------
let lastT = 0;
viewer.onTick = () => {
  const now = performance.now(), dt = lastT ? Math.min((now - lastT) / 1000, 0.1) : 0;
  lastT = now;
  wheel.rotation.z += dt * 0.25;
  for (const p of seats) p.rotation.z = -wheel.rotation.z;   // cabins stay upright
};

// ---- boot ------------------------------------------------------------------------------------------
const wall = await createInline3D({ lazy: false });
if (wall.supported) {
  // SceneViewer sizes the canvas, handles resizes, validates views and replays the last good frame.
  const handle = wall.addScene(canvas, viewer.onFrame, {
    virtualDisplayHeight: VDH,
    onLayerLost: viewer.onLayerLost,           // the session ended: go flat, never raw side-by-side
  });
  wall.session.updateRenderState({ depthNear: 0.01, depthFar: 20 });
  await handle.firstWoven;                     // cover until the first woven frame
} else {
  viewer.startMono();                          // an ordinary browser: one normal camera
}
cover.remove();                                // cut, never fade

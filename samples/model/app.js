// model — a glTF mesh in an inline-3D window, and a mesh + splat sharing one scene.

import * as THREE from 'three';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import { createInline3D } from '@displayxr/inline3d';
import { addModel } from '@displayxr/inline3d/model';
import { measureSplatBounds } from '@displayxr/inline3d/splat';

const GLB = './assets/Fox.glb';
const SPLAT = 'https://sparkjs.dev/assets/splats/butterfly.spz';
const DRACO_GLTF = './assets/glTF-Draco/Duck.gltf';
// Where THIS SITE serves three's Draco decoder. The SDK defaults to `/draco/` on your origin and
// deliberately never falls back to a CDN, so a page hosted under a path prefix (as GitHub Pages
// hosts this one) has to say where the files actually are.
const DECODER_PATH = { draco: new URL('../../vendor/draco/', import.meta.url).pathname };

const wall = await createInline3D({ lazy: false });
const woven = wall.supported;

// ── A. the mesh on its own ──────────────────────────────────────────────────────────────────
const a = addModel(wall, document.getElementById('tileA'), GLB, {
  virtualDisplayHeight: 0.16,
  idleSpin: 12,
  feather: 24,
  renderScale: 0.6,
});
a.exclude(document.getElementById('plateA')); // crisp 2D price plate over the woven 3D

report(a.ready, 'noteA', () => {
  const [w, h, d] = a.frame.extent.map((n) => n.toFixed(2));
  return `glTF loaded · Box3 bounds ${w} x ${h} x ${d} · framed on the display plane`;
});

// ── B. the same viewer, with a splat added alongside the mesh ───────────────────────────────
// addModel/addSplat each own a viewer, but the viewer's `scene` and `content` are public on
// purpose: composing beyond what the two wrappers do is meant to be a few lines, not a fork.
// SAME virtualDisplayHeight as tile A, deliberately. The fit normalises apparent size against
// vH, so a different value does not change how big anything looks — but it does change the
// world scale the runtime's eye poses are expressed in, and having the two tiles differ makes
// them impossible to compare by eye. Keep the only difference between these tiles the CONTENT.
const b = addModel(wall, document.getElementById('tileB'), GLB, {
  virtualDisplayHeight: 0.16,
  idleSpin: 12,
  feather: 24,
  renderScale: 0.6,
});

const mixed = b.ready.then(async () => {
  // One SparkRenderer per scene; splats then sort against the mesh in the same pass.
  const spark = new SparkRenderer({ renderer: b.viewer.renderer, minSortIntervalMs: 16 });
  b.viewer.scene.add(spark);

  const splat = new SplatMesh({ url: SPLAT });
  splat.quaternion.set(1, 0, 0, 0); // most exports are Y-down; three.js is Y-up
  await splat.initialized;

  // Size it RELATIVE TO THE MESH, by measuring the splat's own bounds rather than guessing.
  // Scaling by some fraction of the mesh's extent is meaningless — the two assets are in
  // unrelated unit systems, which is exactly how you end up with a splat towering over a model.
  const sb = measureSplatBounds(splat, THREE);
  const mesh = b.frame;
  const scale = (mesh.extent[1] * 0.45) / (sb?.extent[1] || 1); // ~half the mesh's height
  splat.scale.setScalar(scale);
  splat.position.set(mesh.extent[0] * 0.9, mesh.extent[1] * 0.3, 0);
  b.viewer.content.add(splat);

  // TWO SUBJECTS, ONE FRAME. Fitting to the mesh alone would let the splat hang out of the
  // tile — whatever is in the window has to be inside the fit, so re-fit to the union of both
  // boxes. Everything is already in the content group's space, so this is plain arithmetic.
  if (sb) {
    const half = (o, i) => (o.extent[i] / 2);
    const sCenter = [
      sb.center[0] * scale + splat.position.x,
      sb.center[1] * scale + splat.position.y,
      sb.center[2] * scale + splat.position.z,
    ];
    const min = [], max = [];
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(mesh.center[i] - half(mesh, i), sCenter[i] - (sb.extent[i] * scale) / 2);
      max[i] = Math.max(mesh.center[i] + half(mesh, i), sCenter[i] + (sb.extent[i] * scale) / 2);
    }
    const union = {
      center: [0, 1, 2].map((i) => (min[i] + max[i]) / 2),
      extent: [0, 1, 2].map((i) => Math.max(max[i] - min[i], 1e-6)),
    };
    b.union = union;
    b.viewer.fitTo(union.center, union.extent);
  }
  return splat;
});

report(mixed, 'noteB', (splat) =>
  `mesh + ${splat.numSplats.toLocaleString()} splats in one scene, one render pass` +
  (woven ? ' · woven' : ' · flat fallback'),
);

// ── C. the compressed file a real catalogue holds ───────────────────────────────────────────
// Nothing here is different except the ASSET: a bare GLTFLoader throws outright on
// KHR_draco_mesh_compression, so "your existing catalogue works unchanged" is only true if the
// decoder is wired. addModel reads the glTF's extensionsUsed and wires exactly what it declares.
const c = addModel(wall, document.getElementById('tileC'), DRACO_GLTF, {
  virtualDisplayHeight: 0.16,
  idleSpin: 12,
  feather: 24,
  renderScale: 0.6,
  decoderPath: DECODER_PATH,
});

report(c.ready, 'noteC', () => {
  let verts = 0;
  c.model.traverse((o) => { if (o.isMesh) verts += o.geometry.attributes.position.count; });
  return `Draco decoded · ${verts.toLocaleString()} vertices · same call, same handle, same framing`;
});

// ── page furniture ──────────────────────────────────────────────────────────────────────────
function report(p, id, ok) {
  const el = document.getElementById(id);
  p.then((v) => {
    el.textContent = ok(v) + (woven ? '' : ' — open in the DisplayXR Browser for 3D');
  }).catch((err) => {
    el.textContent = `failed: ${err?.message || err}`;
  });
}

// ── fit A/B ─────────────────────────────────────────────────────────────────────────────────
// The subject sits centred on the zero-disparity plane — the native convention, and the one
// that read better on hardware. What IS worth toggling is the horizontal fit, because the
// difference only shows once something turns.
//
//   swept  — fit the box's horizontal DIAGONAL, so the subject stays inside the tile at every
//            yaw. The Fox is 25 wide but 155 deep: fit its width and it looks right face-on,
//            then swings a metre and a half out of frame as the turntable turns it.
//   width  — fit the width only. Bigger face-on, wrong the moment it moves.
const sweepBtn = document.getElementById('sweep');
const zNote = document.getElementById('noteZ');
let swept = true;

const refit = (h) => {
  const bounds = h === b && b.union ? b.union : h.frame;
  if (bounds) h.viewer.fitTo(bounds.center, bounds.extent);
};

const applyFit = () => {
  for (const h of [a, b]) {
    h.viewer.fitSweep = swept;
    refit(h);
  }
  sweepBtn.textContent = swept ? 'Fit: swept (turn-safe)' : 'Fit: width only';
  if (a.frame) {
    const v = a.viewer, e = a.frame.extent, s = v._fitScale;
    const box = v.canvas.getBoundingClientRect();
    const vW = v.vH * (box.width / box.height);
    zNote.textContent =
      `Fox is ${e[0].toFixed(0)} wide and ${e[2].toFixed(0)} deep. ` +
      `Face-on it spans ${((e[0] * s) / vW * 100).toFixed(0)}% of the tile width; ` +
      `turned side-on, ${((e[2] * s) / vW * 100).toFixed(0)}%.`;
  }
};

sweepBtn.addEventListener('click', () => {
  swept = !swept;
  applyFit();
});
document.getElementById('reset').addEventListener('click', () => {
  a.resetPose();
  b.resetPose();
});
Promise.allSettled([a.ready, mixed]).then(applyFit);

Object.assign(window, { __model: a, __mixed: b, __THREE: THREE }); // debug hooks, as in other samples

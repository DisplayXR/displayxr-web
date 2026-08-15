// model — a glTF mesh in an inline-3D window, and a mesh + splat sharing one scene.

import * as THREE from 'three';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import { createInline3D } from '@displayxr/inline3d';
import { addModel } from '@displayxr/inline3d/model';

const GLB = './assets/Fox.glb';
const SPLAT = 'https://sparkjs.dev/assets/splats/butterfly.spz';

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
const b = addModel(wall, document.getElementById('tileB'), GLB, {
  virtualDisplayHeight: 0.22,
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

  // Park it beside the mesh, in the mesh's own units, so the two are unambiguously in one space.
  const e = b.frame.extent;
  splat.scale.setScalar(Math.max(...e) * 0.9);
  splat.position.set(e[0] * 0.75, e[1] * 0.35, -e[2] * 0.25);
  b.viewer.content.add(splat);
  return splat;
});

report(mixed, 'noteB', (splat) =>
  `mesh + ${splat.numSplats.toLocaleString()} splats in one scene, one render pass` +
  (woven ? ' · woven' : ' · flat fallback'),
);

// ── page furniture ──────────────────────────────────────────────────────────────────────────
function report(p, id, ok) {
  const el = document.getElementById(id);
  p.then((v) => {
    el.textContent = ok(v) + (woven ? '' : ' — open in the DisplayXR Browser for 3D');
  }).catch((err) => {
    el.textContent = `failed: ${err?.message || err}`;
  });
}

Object.assign(window, { __model: a, __mixed: b, __THREE: THREE }); // debug hooks, as in other samples

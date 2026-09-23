// model — a glTF mesh in an inline-3D window, and a mesh + splat sharing one scene.

import * as THREE from 'three';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import { createInline3D } from '@displayxr/inline3d';
import { addModel } from '@displayxr/inline3d/model';
import { addSplat, measureSplatBounds } from '@displayxr/inline3d/splat';

const GLB = './assets/Fox.glb';
const SPLAT = 'https://sparkjs.dev/assets/splats/butterfly.spz';
const DRACO_GLTF = './assets/glTF-Draco/Duck.gltf';
// Where THIS SITE serves three's Draco decoder. The SDK defaults to `/draco/` on your origin and
// deliberately never falls back to a CDN, so a page hosted under a path prefix (as GitHub Pages
// hosts this one) has to say where the files actually are.
const DECODER_PATH = { draco: new URL('../../vendor/draco/', import.meta.url).pathname };

const wall = await createInline3D({ lazy: false });
const woven = wall.supported;
// Which engine renders tiles A and C. Unset is the SDK default (PlayCanvas, from 1.12);
// `?engine=three` is the 1.11 renderer, kept as the kill switch. Tile B is three.js either way —
// it composes a Spark splat into the tile's three scene, which is a three-only thing to do.
const ENGINE = new URLSearchParams(location.search).get('engine') || undefined;
const engineOpt = ENGINE ? { engine: ENGINE } : {};

// ── A. the mesh on its own ──────────────────────────────────────────────────────────────────
const a = addModel(wall, document.getElementById('tileA'), GLB, {
  virtualDisplayHeight: 0.16,
  idleSpin: 12,
  feather: 24,
  renderScale: 0.6,
  ...engineOpt,
});
a.exclude(document.getElementById('plateA')); // crisp 2D price plate over the woven 3D

report(a.ready, 'noteA', () => {
  const [w, h, d] = a.frame.extent.map((n) => n.toFixed(2));
  return `glTF loaded · bounds ${w} x ${h} x ${d} · framed on the display plane · ${a.backend}`;
});

// ── B. a mesh and a splat in ONE scene ────────────────────────────────────────────────────
// Two ways to build it, one per splat engine:
//   PlayCanvas (the default once a .sog is configured): addSplat renders the splat, and the fox
//     goes into the SAME engine scene through handle.engine (SDK >= 1.9.1 registers the glTF
//     handler and the render / light / anim systems on the tile's app).
//   Spark: addModel renders the fox in three.js, and a Spark SplatMesh joins its scene.
// Either way the splat sorts against the mesh in one pass: splats depth-test against the mesh.
//
// The PlayCanvas path needs a .sog or .ply (it cannot read Spark's .spz). There is no default
// .sog with publishing rights yet, so until one is set here, the tile uses the Spark path unless
// the page gets ?splat=<.sog url>. ?engine=spark forces the Spark path.
const MIXED_SOG = '';
const pageParams = new URLSearchParams(location.search);
const mixedSog = pageParams.get('splat') || MIXED_SOG;
const mixedEngine = pageParams.get('engine') === 'spark' || !mixedSog ? 'spark' : 'playcanvas';

// SAME virtualDisplayHeight as tile A, deliberately. The fit normalises apparent size against
// vH, so a different value does not change how big anything looks — but it does change the
// world scale the runtime's eye poses are expressed in, and having the two tiles differ makes
// them impossible to compare by eye. Keep the only difference between these tiles the CONTENT.
const TILE_OPTS = { virtualDisplayHeight: 0.16, idleSpin: 12, feather: 24, renderScale: 0.6 };
const tileB = document.getElementById('tileB');

const { handle: b, ready: mixed } = mixedEngine === 'playcanvas' ? mixedPlayCanvas() : mixedSpark();

report(mixed, 'noteB', (numSplats) =>
  `mesh + ${numSplats.toLocaleString()} splats in one scene, one render pass · ` +
  (mixedEngine === 'playcanvas' ? 'PlayCanvas' : 'three.js + Spark') +
  (woven ? ' · woven' : ' · flat fallback'),
);

/** Union of two boxes given as { center, extent } in the same space. */
function unionBox(p, q) {
  const min = [], max = [];
  for (let i = 0; i < 3; i++) {
    min[i] = Math.min(p.center[i] - p.extent[i] / 2, q.center[i] - q.extent[i] / 2);
    max[i] = Math.max(p.center[i] + p.extent[i] / 2, q.center[i] + q.extent[i] / 2);
  }
  return {
    center: [0, 1, 2].map((i) => (min[i] + max[i]) / 2),
    extent: [0, 1, 2].map((i) => Math.max(max[i] - min[i], 1e-6)),
  };
}

function mixedPlayCanvas() {
  const h = addSplat(wall, tileB, mixedSog, { engine: 'playcanvas', ...TILE_OPTS });
  const ready = h.ready.then(async () => {
    const pc = await import('playcanvas');
    const { app, root } = h.engine;

    // The splat framed itself. The fox is sized RELATIVE TO IT (the splat about 45 % of the
    // fox's height, as on the Spark path) and stands to its left. The two assets are in
    // unrelated unit systems, so both sizes come from measured bounds, never from a guess.
    const asset = new pc.Asset('fox', 'container', { url: new URL(GLB, import.meta.url).href });
    app.assets.add(asset);
    await new Promise((resolve, reject) => {
      asset.ready(resolve);
      asset.on('error', (e) => reject(new Error(`Fox.glb: ${e}`)));
      app.assets.load(asset);
    });
    const fox = asset.resource.instantiateRenderEntity();
    root.addChild(fox);
    const aabb = new pc.BoundingBox();
    let first = true;
    for (const r of fox.findComponents('render')) {
      for (const mi of r.meshInstances) {
        if (first) aabb.copy(mi.aabb);
        else aabb.add(mi.aabb);
        first = false;
      }
    }
    const splatBox = h.frame;
    const c = aabb.center;
    const he = aabb.halfExtents;
    const k = splatBox.extent[1] / 0.45 / (he.y * 2 || 1);
    fox.setLocalScale(k, k, k);
    const foxBox = {
      extent: [he.x * 2 * k, he.y * 2 * k, he.z * 2 * k],
      center: [
        splatBox.center[0] - splatBox.extent[0] / 2 - he.x * k * 1.1, // right side at the splat's left
        splatBox.center[1] - splatBox.extent[1] / 2 + he.y * k, // feet level with the splat's base
        splatBox.center[2],
      ],
    };
    // aabb was measured at scale 1 and the origin, so its centre offset scales with the fox.
    fox.setLocalPosition(
      foxBox.center[0] - c.x * k,
      foxBox.center[1] - c.y * k,
      foxBox.center[2] - c.z * k,
    );

    // A splat carries its own lighting; a mesh needs some. A light shines along its local −Y,
    // so it is aimed by rotation, not lookAt (docs/playcanvas-adapter.md, handle.engine).
    app.scene.ambientLight = new pc.Color(0.55, 0.55, 0.6);
    const sun = new pc.Entity('sun', app);
    sun.addComponent('light', { type: 'directional', intensity: 1.2, color: new pc.Color(1, 0.97, 0.92) });
    sun.setLocalEulerAngles(45, 30, 0);
    root.addChild(sun);

    // TWO SUBJECTS, ONE FRAME: re-fit to the union of both boxes, as the Spark path does.
    const union = unionBox(splatBox, foxBox);
    h.union = union;
    h.viewer.fitTo(union.center, union.extent);
    return h.mesh.numSplats;
  });
  return { handle: h, engine: 'playcanvas', ready };
}

function mixedSpark() {
  const h = addModel(wall, tileB, GLB, TILE_OPTS);
  // addModel/addSplat each own a viewer, but the viewer's `scene` and `content` are public on
  // purpose: composing beyond what the two wrappers do is meant to be a few lines, not a fork.
  const ready = h.ready.then(async () => {
    // One SparkRenderer per scene; splats then sort against the mesh in the same pass.
    const spark = new SparkRenderer({ renderer: h.viewer.renderer, minSortIntervalMs: 16 });
    h.viewer.scene.add(spark);

    const splat = new SplatMesh({ url: mixedSog || SPLAT });
    splat.quaternion.set(1, 0, 0, 0); // most exports are Y-down; three.js is Y-up
    await splat.initialized;

    // Size it RELATIVE TO THE MESH, by measuring the splat's own bounds rather than guessing.
    // Scaling by some fraction of the mesh's extent is meaningless — the two assets are in
    // unrelated unit systems, which is exactly how you end up with a splat towering over a model.
    const sb = measureSplatBounds(splat, THREE);
    const mesh = h.frame;
    const scale = (mesh.extent[1] * 0.45) / (sb?.extent[1] || 1); // ~half the mesh's height
    splat.scale.setScalar(scale);
    splat.position.set(mesh.extent[0] * 0.9, mesh.extent[1] * 0.3, 0);
    h.viewer.content.add(splat);

    // TWO SUBJECTS, ONE FRAME. Fitting to the mesh alone would let the splat hang out of the
    // tile — whatever is in the window has to be inside the fit, so re-fit to the union of both
    // boxes. Everything is already in the content group's space, so this is plain arithmetic.
    if (sb) {
      const splatBox = {
        center: [0, 1, 2].map((i) => sb.center[i] * scale + splat.position.getComponent(i)),
        extent: sb.extent.map((e) => e * scale),
      };
      const union = unionBox(mesh, splatBox);
      h.union = union;
      h.viewer.fitTo(union.center, union.extent);
    }
    return splat.numSplats;
  });
  return { handle: h, engine: 'spark', ready };
}

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
  ...engineOpt,
});

report(c.ready, 'noteC', () => `Draco decoded · ${vertexCount(c).toLocaleString()} vertices · ` +
  `same call, same handle, same framing · ${c.backend}`);

/** Vertices in a model handle, on either engine (`model` is an engine object). */
function vertexCount(h) {
  let verts = 0;
  if (h.backend === 'three') {
    h.model.traverse((o) => { if (o.isMesh) verts += o.geometry.attributes.position.count; });
  } else {
    for (const r of h.model.findComponents('render')) {
      for (const mi of r.meshInstances) verts += mi.mesh.vertexBuffer?.numVertices || 0;
    }
  }
  return verts;
}

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
    const v = a.viewer, e = a.frame.extent;
    // `scale` is model units -> display metres under the live pose (fit x zoom). It used to take
    // reading v._fitScale, which is why web#26 exists; getSubjectBounds() is the supported way.
    const s = v.getSubjectBounds().scale;
    zNote.textContent =
      `Fox is ${e[0].toFixed(0)} wide and ${e[2].toFixed(0)} deep. ` +
      `Face-on it spans ${((e[0] * s) / tileWidthMetres(v) * 100).toFixed(0)}% of the tile width; ` +
      `turned side-on, ${((e[2] * s) / tileWidthMetres(v) * 100).toFixed(0)}%.`;
    zNote.appendChild(live);
  }
};

// Harness hook, same precedent as samples/display-modes' window.__dxrWall: the placement numbers
// above are only checkable from outside if something exposes the viewer.
window.__dxrModel = { a, b, wall };

/** Metres of world the tile's WIDTH spans — vH is the height, the canvas box gives the aspect. */
function tileWidthMetres(v) {
  const box = v.canvas.getBoundingClientRect();
  return v.vH * (box.width / box.height);
}

// ── the same numbers, live ──────────────────────────────────────────────────────────────────
// The sentence above is the FIT: what the framing decided, face-on and side-on. This line is
// what is on the glass right now, and the two disagree constantly because tile A spins
// (`idleSpin: 12`). That disagreement is the whole reason getSubjectBounds() is a per-frame call
// and not something to measure once at load: yaw swings the subject's DEPTH into the display's
// z, so its footprint and its pop-out are functions of the pose, not constants of the model.
const live = document.createElement('span');
live.className = 'live';
(function tickReadout() {
  requestAnimationFrame(tickReadout);
  if (!a.frame) return;
  const b = a.viewer.getSubjectBounds();
  const pct = ((b.extent.x / tileWidthMetres(a.viewer)) * 100).toFixed(0);
  // +z is toward the viewer: front > 0 pops out of the glass, back < 0 is depth behind it.
  const out = Math.round(b.front * 100);
  const behind = Math.round(-b.back * 100);
  live.textContent =
    ` Right now: ${pct}% of the tile width, ` +
    `${out > 0 ? `${out} cm out of the glass` : 'on the glass'}` +
    `${behind > 0 ? `, ${behind} cm behind it` : ''}.`;
})();

sweepBtn.addEventListener('click', () => {
  swept = !swept;
  applyFit();
});
document.getElementById('reset').addEventListener('click', () => {
  a.resetPose();
  b.resetPose();
});
Promise.allSettled([a.ready, mixed]).then(applyFit);

Object.assign(window, { __model: a, __mixed: b, __mixedEngine: mixedEngine, __THREE: THREE }); // debug hooks, as in other samples

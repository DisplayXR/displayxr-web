// inline3d-cursor-bvh.js — the depth cursor's pick, BVH-accelerated, for three.js scenes.
//
// Loaded ONLY when a page opts into `cursor: 'depth'` (./model imports it dynamically on opt-in;
// ADR-046 §0: zero cost, no download otherwise). It brings the vendored MeshBVH slice of
// three-mesh-bvh (js/vendor/three-mesh-bvh.js, MIT), which imports the page's own `three`.
//
// Same answer as three's Raycaster.intersectObjects(targets, true)[0] — the nearest hit, the same
// layer test, the same traversal (an object's raycast returning false stops its subtree) — but each
// plain Mesh is tested against a bounds tree instead of every triangle. Nothing on the page is
// touched: no prototype patching, no `geometry.boundsTree`, no index reordering (`indirect: true`);
// the trees live in a WeakMap keyed by geometry.
//
//  - Built lazily, the first time a ray reaches a mesh's bounding sphere, within a small time
//    budget a frame (one big mesh may exceed it once; it cannot be split). A mesh not built yet is
//    raycast the plain way meanwhile, so the answer never waits for a build.
//  - CPU-animated vertices (the position attribute's version moves): the tree is refitted.
//    A replaced attribute, a changed vertex count or index: rebuilt.
//  - Skinned, morphing, instanced or batched meshes, a partial drawRange, and anything that is not
//    a Mesh (points, lines, sprites, a splat's own raycast): three's own raycast, as before —
//    its answer follows the deformation; a static tree would not.

import { MeshBVH } from './vendor/three-mesh-bvh.js';

/** Build time allowed per ~frame (ms) before further builds wait for the next one. */
const BUILD_BUDGET_MS = 4;
const FRAME_MS = 16;

/**
 * A hit test for ./three's DepthCursor over `targets` (searched recursively): the nearest hit along
 * a WORLD ray, as a world point, or null.
 * @param {object} THREE  the page's three.js namespace.
 * @param {object[]} targets  Object3Ds that count as content.
 * @returns {((origin: number[], direction: number[]) => number[]|null) & {info: () => object}}
 */
export function bvhHitTest(THREE, targets, { now = () => (globalThis.performance ? globalThis.performance.now() : Date.now()) } = {}) {
  const raycaster = new THREE.Raycaster();
  raycaster.firstHitOnly = true; // MeshBVH.raycastObject3D: the nearest hit only
  const o = new THREE.Vector3();
  const d = new THREE.Vector3();
  const sphere = new THREE.Sphere();
  const trees = new WeakMap(); // geometry → { bvh, pos, idx, count, posVersion, idxVersion } | false (cannot)
  const hits = [];
  const info = { mode: 'bvh', built: 0, refits: 0, failed: 0, buildMs: 0, plainCasts: 0 };
  let windowStart = -Infinity;
  let spent = 0;
  const best = [0, 0, 0];
  let bestDist = Infinity;

  function treeFor(mesh) {
    if (mesh.isSkinnedMesh || mesh.isInstancedMesh || mesh.isBatchedMesh) return null;
    const g = mesh.geometry;
    if (!g || !g.attributes) return null;
    const pos = g.attributes.position;
    if (!pos) return null;
    if (g.morphAttributes && g.morphAttributes.position && g.morphAttributes.position.length) return null;
    const idx = g.index;
    const full = idx ? idx.count : pos.count;
    const dr = g.drawRange;
    if (dr && (dr.start > 0 || (dr.count !== Infinity && dr.count < full))) return null;
    let t = trees.get(g);
    if (t === false) return null;
    if (t) {
      if (t.pos !== pos || t.idx !== idx || t.count !== pos.count || (idx && idx.version !== t.idxVersion)) {
        trees.delete(g); // replaced or resized: rebuild below
        t = undefined;
      } else {
        if (pos.version !== t.posVersion) {
          t.bvh.refit(); // vertices animated on the CPU
          t.posVersion = pos.version;
          info.refits++;
        }
        return t;
      }
    }
    const t0 = now();
    if (t0 - windowStart >= FRAME_MS) {
      windowStart = t0;
      spent = 0;
    }
    if (spent >= BUILD_BUDGET_MS) return null; // plain raycast this time; built on a later frame
    try {
      const bvh = new MeshBVH(g, { indirect: true, setBoundingBox: false, verbose: false });
      t = { bvh, pos, idx, count: pos.count, posVersion: pos.version, idxVersion: idx ? idx.version : 0 };
      trees.set(g, t);
      info.built++;
    } catch (err) {
      trees.set(g, false); // e.g. a three.js older than the slice supports: plain raycast for good
      info.failed++;
      t = null;
    }
    const dt = now() - t0;
    spent += dt;
    info.buildMs += dt;
    return t;
  }

  function castOne(obj) {
    hits.length = 0;
    let result;
    const t = obj.isMesh ? treeFor(obj) : null;
    if (t) {
      const g = obj.geometry;
      if (g.boundingSphere === null) g.computeBoundingSphere(); // as Mesh.raycast does
      sphere.copy(g.boundingSphere).applyMatrix4(obj.matrixWorld);
      if (!raycaster.ray.intersectsSphere(sphere)) return undefined;
      t.bvh.raycastObject3D(obj, raycaster, hits);
    } else {
      if (obj.isMesh || obj.isPoints || obj.isLine || obj.isSprite) info.plainCasts++; // drawables only, not groups
      result = obj.raycast(raycaster, hits);
    }
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      if (h.distance < bestDist) {
        bestDist = h.distance;
        best[0] = h.point.x;
        best[1] = h.point.y;
        best[2] = h.point.z;
      }
    }
    return result;
  }

  // Raycaster.intersectObject's traversal: the layer test, and `false` from raycast stops the subtree.
  function visit(obj) {
    let propagate = true;
    if (obj.layers.test(raycaster.layers)) {
      if (castOne(obj) === false) propagate = false;
    }
    if (propagate) {
      const c = obj.children;
      for (let i = 0; i < c.length; i++) visit(c[i]);
    }
  }

  const hitTest = (origin, direction) => {
    o.set(origin[0], origin[1], origin[2]);
    d.set(direction[0], direction[1], direction[2]).normalize();
    raycaster.set(o, d);
    bestDist = Infinity;
    for (let i = 0; i < targets.length; i++) visit(targets[i]);
    hits.length = 0;
    return bestDist < Infinity ? [best[0], best[1], best[2]] : null;
  };
  /** Diagnostics: `{ mode: 'bvh', built, refits, failed, buildMs, plainCasts }` (cumulative). */
  hitTest.info = () => ({ ...info });
  return hitTest;
}

// inline3d-model-frame.js — `addModel`'s robust framing (web#327): where a mesh's turn pivot, its
// screen plane and its fit extent come from, when not from the bounding box.
//
// EXPERIMENTAL, internal to `./model` (both engines). Engine-free and pure: each backend hands in
// the mesh's triangles in CONTENT space (its world transform, and for a skinned mesh the bind-pose
// skinning, already applied) plus the box it would have framed on, and gets a frame back.
//
// WHY. The axis-aligned box does three separate jobs for a mesh (scale, pivot, screen plane), and
// one thin outlier (a tail, an antenna, a strap) skews all three: the subject shrinks, it turns
// about a point behind its body, and the bulk of it comes out of the glass. A surface sample
// weighted by TRIANGLE AREA (not by vertex count, so dense detail such as eyes or text does not
// dominate) gives each job its own robust statistic:
//
//   job                    box framing ('box')      robust framing ('robust', the default)
//   ───────────────────    ─────────────────────    ─────────────────────────────────────────────
//   fit extent             full box                 per-axis area-weighted 1st–99th percentile,
//                                                   never tighter than the FULL box (measured
//                                                   about the pivot) at FULL_BOX_CAP of the tile
//   turn pivot (x, z)      box centre               area-weighted median
//   pivot y                box centre               box centre (unchanged)
//   screen plane (z)       box centre               area-weighted SCREEN_PLANE_PERCENTILE of depth
//                                                   toward the viewer (+z): ~25% of the surface
//                                                   is in front of the glass
//
// The 25% target matches the runtime's own default for auto-convergence. The native model viewer
// (displayxr-demo-modelviewer#192) applies the same rule, so an undocked product keeps its size
// and placement.
//
// ANIMATION. Sampled once, at load, in the model's bind / rest pose (the pose the SDK first draws;
// it does not play clips itself). A page that plays a clip which moves the subject a long way can
// pass `frame:` or `framing: 'box'`.

/** Area-weighted surface samples drawn at load (deterministic: a fixed seed). */
export const ROBUST_SAMPLES = 65536;
/**
 * The sampler's fixed seed, so a model always frames the same. The SAME seed and generator as
 * displayxr-common's `dxr::RobustFrameSampler` (common/robust_frame.h, `kRobustFrameSeed`), so the
 * web and the native model viewer draw the same samples and frame a model identically.
 */
export const ROBUST_SEED = 0x9e3779b97f4a7c15n;
/** Trimmed extent: this percentile and its complement, per axis. */
export const TRIM_PERCENTILE = 0.01;
/** The depth (content z, + toward the viewer) placed on the glass: ~25% of the surface in front. */
export const SCREEN_PLANE_PERCENTILE = 0.75;
/** The full box (about the pivot) may fill at most this fraction of the tile. */
export const FULL_BOX_CAP = 0.9;
/** Values `framing` accepts; the first is the default. */
export const FRAMINGS = Object.freeze(['robust', 'box']);

/**
 * Throws for a `framing` value other than the two modes. Returns the resolved mode.
 * @param {unknown} v
 * @param {string} [tag]
 * @returns {'robust'|'box'}
 */
export function resolveFraming(v, tag = '@displayxr/inline3d/model') {
  if (v === undefined || v === null) return 'robust';
  if (!FRAMINGS.includes(v)) {
    throw new Error(`${tag}: framing must be 'robust' or 'box' (got ${typeof v === 'string' ? `"${v}"` : String(v)}).`);
  }
  return v;
}

// ── The sampling, exactly as displayxr-common's robust_frame.h specifies it ──────────────────
// The native model viewer (displayxr-common v2.35.0+, `dxr::RobustFrameSampler`) and this file must
// frame a model identically, because an undocked product keeps its size and placement as it leaves
// the page. The header fully specifies the sampling; this is a line-for-line port:
//   - triangles in the order added; area = 0.5·|(b−a)×(c−a)| in float32, accumulated in double;
//     zero-area and non-finite triangles are skipped (not drawn from at all);
//   - RNG: 64-bit LCG s = s·6364136223846793005 + 1442695040888963407 (mod 2^64), seeded with
//     ROBUST_SEED; each draw is (s >> 11)·2^-53;
//   - per sample: r = draw()·total picks the first triangle whose cumulative area is ≥ r
//     (lower_bound); u = f32(draw()), v = f32(draw()), folded when u + v > 1; the point
//     a + u(b−a) + v(c−a) is evaluated in float32;
//   - percentile q of n sorted samples is element min(n−1, trunc(f32(q)·f32(n−1) + 0.5f)).
// float32 steps go through Math.fround so each rounds where the C++ rounds. A native build that
// fuses a·b + c into one FMA (clang on arm64 does by default) can differ by an ulp per point; the
// triangle choices and therefore the frame agree to that.

const f32 = Math.fround;

// The LCG on two uint32 halves (no BigInt in the hot loop): A = 0x5851F42D_4C957F2D,
// C = 0x14057B7E_F767814F.
const A_HI = 0x5851f42d;
const A_LO = 0x4c957f2d;
const C_HI = 0x14057b7e;
const C_LO = 0xf767814f;

/** Full 64-bit product of two uint32s, as [hi, lo] uint32s. */
function mul32(a, b) {
  const a0 = a & 0xffff, a1 = a >>> 16, b0 = b & 0xffff, b1 = b >>> 16;
  const p00 = a0 * b0, p01 = a0 * b1, p10 = a1 * b0, p11 = a1 * b1;
  const mid = (p00 >>> 16) + (p01 & 0xffff) + (p10 & 0xffff);
  const lo = (((mid & 0xffff) << 16) | (p00 & 0xffff)) >>> 0;
  const hi = (p11 + (p01 >>> 16) + (p10 >>> 16) + Math.floor(mid / 65536)) >>> 0;
  return [hi, lo];
}

/**
 * robust_frame.h's generator: uniform doubles in [0, 1). Exported for the parity test.
 * @param {bigint|number} [seed]
 */
export function robustRng(seed = ROBUST_SEED) {
  const s0 = BigInt.asUintN(64, BigInt(seed));
  let hi = Number(s0 >> 32n) >>> 0;
  let lo = Number(s0 & 0xffffffffn) >>> 0;
  return () => {
    const [ph, pl] = mul32(lo, A_LO);
    const nh = (ph + Math.imul(hi, A_LO) + Math.imul(lo, A_HI)) >>> 0;
    const l2 = pl + C_LO;
    lo = l2 >>> 0;
    hi = (nh + C_HI + (l2 > 0xffffffff ? 1 : 0)) >>> 0;
    // (s >> 11) · 2^-53: the top 53 bits, exact in a double.
    return (hi * 2097152 + (lo >>> 11)) / 9007199254740992;
  };
}

/**
 * Draw `samples` points uniformly over the surface (probability ∝ triangle area).
 *
 * @param {{positions: ArrayLike<number>, indices?: ArrayLike<number>|null}[]} meshes  content-space
 *        xyz triplets; `indices` (triangle list) or null for a non-indexed triangle list.
 * @returns {{x: Float64Array, y: Float64Array, z: Float64Array, area: number, triangles: number}|null}
 *          null when there is no surface with area. `triangles` counts the triangles with area.
 */
export function sampleSurface(meshes, { samples = ROBUST_SAMPLES, seed = ROBUST_SEED } = {}) {
  let triCount = 0;
  for (const m of meshes || []) {
    if (!m || !m.positions) continue;
    const n = m.indices ? m.indices.length : m.positions.length / 3;
    triCount += Math.floor(n / 3);
  }
  if (!triCount) return null;
  // The triangles WITH area, as float32 corners (a, b, c: 9 floats each), and their cumulative area.
  const T = new Float32Array(9 * triCount);
  const cum = new Float64Array(triCount);
  let kept = 0;
  let total = 0;
  for (const m of meshes) {
    if (!m || !m.positions) continue;
    const P = m.positions;
    const I = m.indices || null;
    const nv = P.length / 3;
    const n = Math.floor((I ? I.length : nv) / 3);
    for (let t = 0; t < n; t++) {
      const i0 = I ? I[3 * t] : 3 * t;
      const i1 = I ? I[3 * t + 1] : 3 * t + 1;
      const i2 = I ? I[3 * t + 2] : 3 * t + 2;
      if (!(i0 < nv && i1 < nv && i2 < nv)) continue;
      const ax = f32(P[3 * i0]), ay = f32(P[3 * i0 + 1]), az = f32(P[3 * i0 + 2]);
      const bx = f32(P[3 * i1]), by = f32(P[3 * i1 + 1]), bz = f32(P[3 * i1 + 2]);
      const cx = f32(P[3 * i2]), cy = f32(P[3 * i2 + 1]), cz = f32(P[3 * i2 + 2]);
      const ux = f32(bx - ax), uy = f32(by - ay), uz = f32(bz - az);
      const vx = f32(cx - ax), vy = f32(cy - ay), vz = f32(cz - az);
      const nx = f32(f32(uy * vz) - f32(uz * vy));
      const ny = f32(f32(uz * vx) - f32(ux * vz));
      const nz = f32(f32(ux * vy) - f32(uy * vx));
      const a = 0.5 * f32(Math.sqrt(f32(f32(f32(nx * nx) + f32(ny * ny)) + f32(nz * nz))));
      if (!(a > 0) || !Number.isFinite(a)) continue;
      T.set([ax, ay, az, bx, by, bz, cx, cy, cz], 9 * kept);
      total += a;
      cum[kept++] = total;
    }
  }
  if (!(total > 0)) return null;
  const x = new Float64Array(samples);
  const y = new Float64Array(samples);
  const z = new Float64Array(samples);
  const out = [x, y, z];
  const rand = robustRng(seed);
  for (let s = 0; s < samples; s++) {
    // lower_bound(cum, r): the first triangle whose cumulative area reaches r.
    const r = rand() * total;
    let lo = 0;
    let hi = kept;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (cum[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    const o = 9 * Math.min(lo, kept - 1);
    let u = f32(rand());
    let v = f32(rand());
    if (f32(u + v) > 1) {
      u = f32(1 - u);
      v = f32(1 - v);
    }
    for (let c = 0; c < 3; c++) {
      const a = T[o + c];
      out[c][s] = f32(f32(a + f32(u * f32(T[o + 3 + c] - a))) + f32(v * f32(T[o + 6 + c] - a)));
    }
  }
  return { x, y, z, area: total, triangles: kept };
}

/** The q-quantile of a SORTED array: robust_frame.h's nearest-rank index, in float32. */
export function percentileSorted(a, q) {
  const n = a.length;
  if (!n) return NaN;
  return a[Math.min(n - 1, Math.max(0, Math.trunc(f32(f32(f32(q) * f32(n - 1)) + 0.5))))];
}

/**
 * The robust frame of a mesh: turn pivot, fit extent and screen-plane depth (see the table above).
 *
 * @param {{positions: ArrayLike<number>, indices?: ArrayLike<number>|null}[]} meshes  content space.
 * @param {{center: number[], extent: number[]}} box  the box framing would use (the engine's).
 * @param {object} [o]
 * @param {number} [o.margin=0.8]  the fit's margin, so the full-box guard means "the full box at
 *        FULL_BOX_CAP of the tile" whatever margin the page asked for.
 * @param {number} [o.samples]
 * @param {number} [o.seed]
 * @returns {{center: number[], extent: number[], screenPlaneZ: number, depthRange: number[], box: {center: number[], extent: number[]}}|null}
 *          null when the meshes have no usable surface, or when the surface does not lie inside the
 *          box (geometry the sampler cannot read faithfully, e.g. a quantized stream): the caller
 *          then frames on the box.
 */
export function robustFrame(meshes, box, { margin = 0.8, samples = ROBUST_SAMPLES, seed = ROBUST_SEED } = {}) {
  if (!box || !box.center || !box.extent) return null;
  const S = sampleSurface(meshes, { samples, seed });
  if (!S) return null;
  const min = [0, 1, 2].map((i) => box.center[i] - box.extent[i] / 2);
  const max = [0, 1, 2].map((i) => box.center[i] + box.extent[i] / 2);
  // Plausibility: the samples must lie in the box (a little slack for float and loose engine boxes).
  const slack = 0.02 * Math.hypot(box.extent[0], box.extent[1], box.extent[2]) + 1e-6;
  let outside = 0;
  const axes = [S.x, S.y, S.z];
  for (let s = 0; s < S.x.length; s++) {
    for (let i = 0; i < 3; i++) {
      const v = axes[i][s];
      if (!(v >= min[i] - slack && v <= max[i] + slack)) {
        outside++;
        break;
      }
    }
  }
  if (outside > 0.005 * S.x.length) return null;
  for (const a of axes) a.sort();
  const p = (i, q) => percentileSorted(axes[i], q);
  const center = [p(0, 0.5), box.center[1], p(2, 0.5)];
  const fill = Number.isFinite(margin) && margin > 0 ? margin : 0.8;
  const extent = [0, 1, 2].map((i) => {
    const trimmed = Math.max(Math.fround(p(i, 1 - TRIM_PERCENTILE) - p(i, TRIM_PERCENTILE)), Math.fround(1e-6));
    // The full box measured about the pivot (the subject turns about it), so a fit on `extent`
    // at `margin` never puts the full box past FULL_BOX_CAP of the tile.
    const symFull = 2 * Math.max(max[i] - center[i], center[i] - min[i]);
    return Math.max(trimmed, (symFull * fill) / FULL_BOX_CAP, 1e-6);
  });
  return {
    center,
    extent,
    screenPlaneZ: p(2, SCREEN_PLANE_PERCENTILE),
    depthRange: [p(2, TRIM_PERCENTILE), p(2, 1 - TRIM_PERCENTILE)],
    box: { center: box.center.slice(0, 3), extent: box.extent.slice(0, 3) },
  };
}

/**
 * fitTo's third argument for a frame: its `screenPlaneZ` / `depthRange` when it carries them
 * (a robust frame, or a page's `frame:` that names them), else undefined: a plain box frame then
 * makes the 2-argument call, bit for bit as before.
 */
export function fitOptionsOf(bounds) {
  if (!bounds) return undefined;
  const o = {};
  if (Number.isFinite(bounds.screenPlaneZ)) o.screenPlaneZ = bounds.screenPlaneZ;
  if (Array.isArray(bounds.depthRange) && bounds.depthRange.length === 2) o.depthRange = bounds.depthRange;
  return Object.keys(o).length ? o : undefined;
}

/**
 * Column-major 4×4 × point, into `out` at `o`.
 */
function xform(m, x, y, z, out, o) {
  out[o] = m[0] * x + m[4] * y + m[8] * z + m[12];
  out[o + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
  out[o + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
}

/** a · b, column-major 4×4 (affine is enough here, but the general product is as cheap). */
function mul4(a, b) {
  const r = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    for (let rI = 0; rI < 4; rI++) {
      r[c * 4 + rI] = a[rI] * b[c * 4] + a[4 + rI] * b[c * 4 + 1] + a[8 + rI] * b[c * 4 + 2] + a[12 + rI] * b[c * 4 + 3];
    }
  }
  return r;
}

/**
 * PlayCanvas: the render entity's triangles in content space (the space `boundsOfEntity` measures
 * in). Static meshes go through their node's world transform; a skinned one is skinned on the CPU
 * at the bind / rest pose (bone world × inverse bind pose, blended by its weights), which is what
 * the engine draws first. Reads the vertex buffer's CPU copy (`mesh.getPositions`); a mesh
 * instance that cannot be read is skipped, and nothing readable → [] (the caller frames on the box).
 */
export function meshesOfPlayCanvasEntity(entity) {
  const out = [];
  const renders = entity && entity.findComponents ? entity.findComponents('render') : [];
  for (const r of renders) {
    for (const mi of r.meshInstances || []) {
      try {
        const m = trianglesOfMeshInstance(mi);
        if (m) out.push(m);
      } catch {
        /* unreadable: skipped (the box still covers it via the plausibility check) */
      }
    }
  }
  return out;
}

function trianglesOfMeshInstance(mi) {
  const mesh = mi && mi.mesh;
  if (!mesh || typeof mesh.getPositions !== 'function') return null;
  const prim = (mesh.primitive && mesh.primitive[0]) || {};
  if (prim.type !== undefined && prim.type !== 4) return null; // PRIMITIVE_TRIANGLES only
  const nv = mesh.vertexBuffer?.numVertices ?? 0;
  if (!nv) return null;
  const local = new Float32Array(nv * 3);
  if (mesh.getPositions(local) !== nv) return null;
  let indices = null;
  if (prim.indexed && mesh.indexBuffer && mesh.indexBuffer[0]) {
    const all = new Uint32Array(mesh.indexBuffer[0].numIndices);
    mesh.getIndices(all);
    const base = prim.base || 0;
    const count = prim.count || all.length - base;
    indices = all.subarray(base, base + count);
  } else if (prim.count && (prim.base || prim.count !== nv)) {
    indices = new Uint32Array(prim.count);
    for (let i = 0; i < prim.count; i++) indices[i] = (prim.base || 0) + i;
  }
  const P = new Float32Array(nv * 3);
  const skin = mi.skinInstance;
  if (skin && skin.bones && skin.skin && skin.skin.inverseBindPose) {
    const J = new Float32Array(nv * 4);
    const W = new Float32Array(nv * 4);
    if (mesh.getVertexStream('BLENDINDICES', J) !== nv || mesh.getVertexStream('BLENDWEIGHT', W) !== nv) return null;
    const mats = skin.bones.map((b, j) => mul4(b.getWorldTransform().data, skin.skin.inverseBindPose[j].data));
    const tmp = new Float64Array(3);
    for (let v = 0; v < nv; v++) {
      const x = local[3 * v], y = local[3 * v + 1], z = local[3 * v + 2];
      let sx = 0, sy = 0, sz = 0, sw = 0;
      for (let c = 0; c < 4; c++) {
        const w = W[4 * v + c];
        const M = mats[J[4 * v + c]];
        if (!(w > 0) || !M) continue;
        xform(M, x, y, z, tmp, 0);
        sx += w * tmp[0];
        sy += w * tmp[1];
        sz += w * tmp[2];
        sw += w;
      }
      if (!(sw > 0)) return null;
      P[3 * v] = sx / sw;
      P[3 * v + 1] = sy / sw;
      P[3 * v + 2] = sz / sw;
    }
  } else {
    const node = mi.node;
    const m = node && typeof node.getWorldTransform === 'function' ? node.getWorldTransform().data : null;
    if (m) for (let v = 0; v < nv; v++) xform(m, local[3 * v], local[3 * v + 1], local[3 * v + 2], P, 3 * v);
    else P.set(local);
  }
  return { positions: P, indices };
}

/**
 * three.js: the object tree's triangles in content space (the space `Box3.setFromObject` measures
 * in). `SkinnedMesh.getVertexPosition` applies the bind-pose skinning and morph targets the same
 * way three's own skinned bounds do. Returns null when the tree holds an InstancedMesh (its
 * instances are not sampled: the caller frames on the box).
 */
export function meshesOfThreeObject(THREE, root) {
  const out = [];
  let instanced = false;
  root.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  root.traverse((o) => {
    if (o.isInstancedMesh) instanced = true;
    if (!o.isMesh || o.isInstancedMesh || !o.geometry) return;
    const g = o.geometry;
    const pos = g.attributes && g.attributes.position;
    if (!pos) return;
    const n = pos.count;
    const P = new Float32Array(n * 3);
    const skinned = o.isSkinnedMesh && typeof o.getVertexPosition === 'function';
    for (let i = 0; i < n; i++) {
      if (skinned) o.getVertexPosition(i, v);
      else v.fromBufferAttribute(pos, i);
      v.applyMatrix4(o.matrixWorld);
      P[3 * i] = v.x;
      P[3 * i + 1] = v.y;
      P[3 * i + 2] = v.z;
    }
    out.push({ positions: P, indices: g.index ? g.index.array : null });
  });
  return instanced ? null : out;
}

// inline3d-splat-rig.js — how a splat decides which rig it is on, what lens it was taken with,
// and what it is looking at. The WATERFALL, and the arithmetic under it.
//
// EXPERIMENTAL. Internal to `./splat`. Not covered by the SDK's 1.x semver promise.
//
// Three questions have to be answered before a splat can be drawn, and each of them has a good
// answer, a worse answer and a last resort. Writing that as a waterfall — with the step that
// answered it recorded next to the value — is the whole design:
//
//   RIG        caller › the block's `rig` › (a block at all ? camera : display)
//   INTRINSICS the block › caller › ESTIMATED from the cloud › 28 mm-eq
//   FOCUS      caller › the block's `focus.point` › MEDIAN DISPARITY › 2 m
//
// The two capitalised steps are the interesting ones, and they exist because the fallbacks
// underneath them are bad in a specific, silent way. A splat with no intrinsics rendered through
// a guessed lens is drawn at the wrong SIZE — a splat built at focal f_s and viewed at f_v is
// scaled by f_v/f_s about the frame centre, nothing else changes, so there is no artefact to
// notice, only a picture that "feels zoomed out". And a focus picked as the middle of the
// measured bounds lands ~40 m away on an open scene (sky and ground are in those bounds),
// which puts every bit of actual subject in front of the glass.
//
// Everything here is PLAIN ARITHMETIC on numbers and arrays — no three.js types — so the whole
// waterfall is unit-testable without a GPU, a canvas or a renderer. The caller does the one
// thing that needs the library: walking the cloud once.

/** Rotate `v` by the CONJUGATE of quaternion `q` (xyzw) — i.e. world → the frame `q` defines. */
export function unrotate(q, v) {
  const [x, y, z, w] = q;
  // q* · v · q, expanded. Conjugating is negating the vector part.
  const ix = -x;
  const iy = -y;
  const iz = -z;
  const tx = 2 * (iy * v[2] - iz * v[1]);
  const ty = 2 * (iz * v[0] - ix * v[2]);
  const tz = 2 * (ix * v[1] - iy * v[0]);
  return [
    v[0] + w * tx + (iy * tz - iz * ty),
    v[1] + w * ty + (iz * tx - ix * tz),
    v[2] + w * tz + (ix * ty - iy * tx),
  ];
}

/** Rotate `v` BY quaternion `q` (xyzw) — the frame `q` defines → world. */
export function rotate(q, v) {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

/** A model-space point in the rest camera's own frame (OpenCV: +x right, +y down, +z forward). */
export function toRestSpace(rest, p) {
  const t = rest.position;
  return unrotate(rest.rotation, [p[0] - t[0], p[1] - t[1], p[2] - t[2]]);
}

/** A point `d` metres straight ahead of the rest camera, back in model space. */
export function aheadOfRest(rest, d) {
  const f = rotate(rest.rotation, [0, 0, 1]);
  return [rest.position[0] + f[0] * d, rest.position[1] + f[1] * d, rest.position[2] + f[2] * d];
}

/** Distance from the rest camera to a model-space point, along the view axis (the PLANE). */
export function planeDistance(rest, p) {
  return toRestSpace(rest, p)[2];
}

/** `p`-th percentile of an ALREADY SORTED array, linearly interpolated. */
function pct(sorted, p) {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/** Half the 35 mm frame's diagonal, in mm — the constant behind every "35 mm equivalent". */
const HALF_DIAGONAL_35MM = Math.hypot(36, 24) / 2;

/** The 35 mm-equivalent focal implied by a pair of half-tangents. */
export function focalEq35(hTan, vTan) {
  const diag = Math.hypot(hTan, vTan);
  return diag > 0 ? HALF_DIAGONAL_35MM / diag : Infinity;
}

/**
 * Sanity band on an ESTIMATED lens, in 35 mm-equivalent mm.
 *
 * Outside it the estimate is not a lens, it is a statement about the CLOUD: a scene that wraps
 * around the camera (a 360 capture, a scan the viewer is inside) has an angular extent of most
 * of a sphere and implies a sub-fisheye focal, while a single distant object subtends almost
 * nothing and implies a telescope. Neither is the camera the picture was taken with, so both
 * fall through to the default rather than being believed.
 */
const FOCAL_EQ_MIN_MM = 14;
const FOCAL_EQ_MAX_MM = 85;

/** What the fallback claims when the cloud cannot be trusted: a phone's main camera. */
const DEFAULT_FOCAL_EQ_MM = 28;

/** The pixel height every estimated lens is expressed against. Only ratios matter. */
const NOMINAL_HEIGHT_PX = 1000;

/**
 * Build intrinsics from four tangent limits (left/right/top/bottom, in the OpenCV frame where
 * +y is DOWN).
 *
 * Pixels come out square by construction — `width` is chosen from the tangent aspect — because
 * nothing in a point cloud distinguishes a non-square pixel from a differently shaped frame, and
 * inventing one would be a claim the data does not support.
 */
export function intrinsicsFromTangents(txLo, txHi, tyLo, tyHi) {
  const dtx = txHi - txLo;
  const dty = tyHi - tyLo;
  if (!(dtx > 0) || !(dty > 0)) return null;
  const height = NOMINAL_HEIGHT_PX;
  const width = Math.max(1, Math.round((height * dtx) / dty));
  const fy = height / dty;
  const fx = width / dtx;
  return { fx, fy, cx: -txLo * fx, cy: -tyLo * fy, width, height };
}

/**
 * Estimate the capture lens from the cloud's ANGULAR EXTENT about the rest camera.
 *
 * A capture's gaussians only exist where the camera could see them, so the cloud's own extent in
 * tangent space IS the frustum that made it — read the edges and you have read the lens. The
 * edges are taken as P1/P99 rather than min/max because a lifted capture always has a few
 * gaussians outside the frame (the refinement hallucinates a little past the edges, and the
 * depth cap scatters some), and one of those would otherwise set the field of view for the whole
 * asset.
 *
 * Validated against a capture whose true half-tangents are ±0.857 horizontal and ±0.482
 * vertical: this returns −0.854/+0.863 and −0.480/+0.505. The asymmetry is real and is why the
 * limits are kept separately rather than symmetrised — it falls straight out as `cx`/`cy`.
 *
 * @param {Float64Array|number[]} tx  x/z per sampled splat, in rest-camera space.
 * @param {Float64Array|number[]} ty  y/z per sampled splat, same order.
 * @param {number} n  how many entries are populated.
 * @returns {{intrinsics:object, focalEqMm:number}|null} null when the cloud says something that
 *          is not a camera — see FOCAL_EQ_MIN_MM.
 */
export function estimateIntrinsics(tx, ty, n) {
  if (!n || n < 64) return null;
  const sx = Array.prototype.slice.call(tx, 0, n).sort((a, b) => a - b);
  const sy = Array.prototype.slice.call(ty, 0, n).sort((a, b) => a - b);
  const txLo = pct(sx, 0.01);
  const txHi = pct(sx, 0.99);
  const tyLo = pct(sy, 0.01);
  const tyHi = pct(sy, 0.99);
  const intrinsics = intrinsicsFromTangents(txLo, txHi, tyLo, tyHi);
  if (!intrinsics) return null;
  const focalEqMm = focalEq35((txHi - txLo) / 2, (tyHi - tyLo) / 2);
  if (!(focalEqMm >= FOCAL_EQ_MIN_MM) || !(focalEqMm <= FOCAL_EQ_MAX_MM)) return null;
  return { intrinsics, focalEqMm, tangents: { txLo, txHi, tyLo, tyHi } };
}

/**
 * The last resort: a 28 mm-equivalent lens, in the orientation the cloud's extent suggests.
 *
 * The aspect is worth keeping even when the focal was refused, because portrait-vs-landscape is
 * the one thing a wildly wrong extent still gets right, and getting it wrong crops the picture
 * along the wrong axis.
 */
export function fallbackIntrinsics(aspect = 4 / 3) {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 4 / 3;
  const diag = HALF_DIAGONAL_35MM / DEFAULT_FOCAL_EQ_MM;
  const vTan = diag / Math.hypot(a, 1);
  const hTan = a * vTan;
  return intrinsicsFromTangents(-hTan, hTan, -vTan, vTan);
}

/**
 * Focus distance from MEDIAN DISPARITY — the median of 1/z, inverted.
 *
 * Not the median of z, and the difference is the point. Disparity is what a stereo pair actually
 * measures and what the depth was derived from, so its median is the scene's typical depth in the
 * space where the errors are symmetric; in metres the same distribution is a long tail to
 * infinity that drags any average outwards. On the reference capture this gives 2.159 m against
 * the gallery's own 2.138 m from its stored median disparity — the same number by a different
 * route, which is the check that matters.
 *
 * @param {Float64Array|number[]} invz  1/z per sampled splat (z forward, in metres).
 */
export function medianDisparityDistance(invz, n) {
  if (!n) return null;
  const s = Array.prototype.slice.call(invz, 0, n).sort((a, b) => a - b);
  const m = s.length % 2 ? s[s.length >> 1] : 0.5 * (s[s.length / 2 - 1] + s[s.length / 2]);
  return m > 0 ? 1 / m : null;
}

/** Where a focus ends up when there is nothing at all to go on. */
export const DEFAULT_FOCUS_M = 2.0;

/** Sane band on a derived focus distance, in metres. */
export const FOCUS_MIN_M = 0.2;
export const FOCUS_MAX_M = 60;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const isVec3 = (v) => Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every(Number.isFinite);

/**
 * Run the whole waterfall.
 *
 * @param {object} args
 * @param {object|null} args.camera  the parsed `.sog` camera block, or null.
 * @param {object} args.opts  the caller's `addSplat` options.
 * @param {object|null} args.cloud  `{ tx, ty, invz, n }` from one pass over the splats in
 *        rest-camera space, or null if there was nothing to walk.
 * @param {number} args.canvasAspect  fallback orientation when the cloud cannot supply one.
 * @returns {object} the resolved rig, every field beside the step that produced it.
 */
export function resolveRig({ camera = null, opts = {}, cloud = null, canvasAspect = 4 / 3 }) {
  const rest = camera?.rest ?? { position: [0, 0, 0], rotation: [0, 0, 0, 1] };

  // ── rig ───────────────────────────────────────────────────────────────────────────────
  let type;
  let typeSource;
  if (opts.rig === 'camera' || opts.rig === 'display') {
    type = opts.rig;
    typeSource = 'caller';
  } else if (camera?.rig) {
    type = camera.rig;
    typeSource = 'block';
  } else {
    // A block at all means a camera was recorded, which only happens for a capture. `rig:
    // "display"` alongside a `rest` is how an asset says "a display rig, opened at this
    // viewpoint" — so the presence of the block is the default, not the override.
    type = camera ? 'camera' : 'display';
    typeSource = camera ? 'block-present' : 'default';
  }

  // ── intrinsics ────────────────────────────────────────────────────────────────────────
  let intrinsics = null;
  let intrinsicsSource = null;
  let focalEqMm = null;
  if (camera?.intrinsics) {
    intrinsics = camera.intrinsics;
    intrinsicsSource = 'block';
  } else if (opts.intrinsics && Number.isFinite(opts.intrinsics.fx)) {
    intrinsics = opts.intrinsics;
    intrinsicsSource = 'caller';
  } else if (cloud) {
    const est = estimateIntrinsics(cloud.tx, cloud.ty, cloud.n);
    if (est) {
      intrinsics = est.intrinsics;
      intrinsicsSource = 'estimated';
      focalEqMm = est.focalEqMm;
    }
  }
  if (!intrinsics) {
    // Keep the ORIENTATION the cloud implies even when its focal was refused: portrait vs
    // landscape is the part a bad extent still gets right, and getting it wrong crops the
    // picture along the wrong axis.
    let aspect = canvasAspect;
    if (cloud && cloud.n >= 64) {
      const est = intrinsicsFromTangents(
        ...(() => {
          const sx = Array.prototype.slice.call(cloud.tx, 0, cloud.n).sort((a, b) => a - b);
          const sy = Array.prototype.slice.call(cloud.ty, 0, cloud.n).sort((a, b) => a - b);
          return [pct(sx, 0.01), pct(sx, 0.99), pct(sy, 0.01), pct(sy, 0.99)];
        })(),
      );
      if (est) aspect = est.width / est.height;
    }
    intrinsics = fallbackIntrinsics(aspect);
    intrinsicsSource = 'fallback-28mm';
    focalEqMm = DEFAULT_FOCAL_EQ_MM;
  }
  if (focalEqMm === null && intrinsics) {
    focalEqMm = focalEq35(intrinsics.width / 2 / intrinsics.fx, intrinsics.height / 2 / intrinsics.fy);
  }

  // ── focus ─────────────────────────────────────────────────────────────────────────────
  //
  // ONE point, and it is the orbit centre, the pivot plane and the convergence distance at
  // once. Resolved as a point in model space; the distance falls out of it, never the reverse.
  let point = null;
  let focusSource = null;
  if (isVec3(opts.focus)) {
    point = opts.focus.slice(0, 3);
    focusSource = 'caller';
  } else if (Number.isFinite(opts.convergence) && opts.convergence > 0) {
    // The scalar shorthand: a focus straight ahead at this distance.
    point = aheadOfRest(rest, opts.convergence);
    focusSource = 'caller-convergence';
  } else if (isVec3(camera?.focus?.point)) {
    point = camera.focus.point.slice(0, 3);
    focusSource = 'block';
  } else if (cloud) {
    const d = medianDisparityDistance(cloud.invz, cloud.n);
    if (d) {
      point = aheadOfRest(rest, clamp(d, FOCUS_MIN_M, FOCUS_MAX_M));
      focusSource = 'median-disparity';
    }
  }
  if (!point) {
    point = aheadOfRest(rest, DEFAULT_FOCUS_M);
    focusSource = 'default';
  }

  const convergence = planeDistance(rest, point);

  return {
    type,
    typeSource,
    rest,
    intrinsics,
    intrinsicsSource,
    focalEqMm,
    focus: point,
    focusSource,
    // Advisory, straight from the block — a host page's depth budget or HUD may want them.
    focusDistances: camera?.focus
      ? { subject_m: camera.focus.subject_m, near_m: camera.focus.near_m, far_m: camera.focus.far_m }
      : null,
    convergence,
    // ABSOLUTE on a camera rig, and they stay absolute: normalising them against the convergence
    // would make the scene's depth breathe every time the viewer re-focused.
    ipdFactor: Number.isFinite(opts.ipdFactor) ? opts.ipdFactor : (camera?.dxr?.ipdFactor ?? 1),
    parallaxFactor: Number.isFinite(opts.parallaxFactor)
      ? opts.parallaxFactor
      : (camera?.dxr?.parallaxFactor ?? 1),
  };
}

// ── walking the cloud, for any backend ──────────────────────────────────────────────────
//
// The waterfall needs ONE pass over the splat centres (in the file's own space), and the
// auto-frame needs another. Both used to be written against Spark's `mesh.forEachSplat`, which
// is the only thing in them that is Spark. A second backend (./inline3d-splat-playcanvas.js)
// has the same centres as a flat Float32Array instead, so the walk is expressed here against a
// VISITOR — `forEachCentre(visit)` calls `visit(index, x, y, z, opacity)` once per splat, in
// index order, with `opacity` undefined when the backend has none — and each backend supplies
// the two-line adapter from what it holds. The sampling rules (stride, cap, opacity floor) live
// here once, so the two backends cannot drift apart on what "the cloud" means.

/** Cap on how many splats the rig pass inspects. Percentiles of a uniform subsample converge. */
export const RIG_SAMPLE_CAP = 40000;

/** Below this, a splat is haze — it is not where the camera was pointed and not what it saw. */
export const RIG_MIN_OPACITY = 0.05;

/** Nearer than this, a splat is behind or on the lens and its x/z, y/z, 1/z are meaningless. */
export const RIG_MIN_Z = 0.05;

/** Cap on how many splat centres the fallback framing pass inspects. */
export const FRAME_SAMPLE_CAP = 200000;

/**
 * A visitor over flat arrays: `xyz` is [x,y,z, x,y,z, …] and `opacity` (optional) is one peak
 * opacity per splat in [0,1].
 *
 * @param {ArrayLike<number>} xyz
 * @param {ArrayLike<number>|null} [opacity]
 * @param {number} [count]  splats to visit; defaults to what `xyz` holds.
 * @returns {(visit: Function) => void}
 */
export function centresVisitor(xyz, opacity = null, count = Math.floor(xyz.length / 3)) {
  return (visit) => {
    for (let i = 0; i < count; i++) {
      visit(i, xyz[i * 3], xyz[i * 3 + 1], xyz[i * 3 + 2], opacity ? opacity[i] : undefined);
    }
  };
}

/**
 * ONE walk over the cloud, in the REST CAMERA's frame, producing everything the waterfall needs
 * that is not in the file: the angular extent that is the lens (x/z, y/z) and the disparities
 * whose median is the focus (1/z).
 *
 * Model space, deliberately — the centres are the file's own OpenCV frame, before any display
 * flip, which is the frame `rest` and `intrinsics` are expressed in. Doing it after the Y-flip
 * would mean undoing the flip to compare with the block.
 *
 * @param {number} total  how many splats `forEachCentre` will visit.
 * @param {(visit: Function) => void} forEachCentre
 * @param {{position:number[],rotation:number[]}|null} rest
 * @returns {{tx:Float64Array,ty:Float64Array,invz:Float64Array,n:number}|null}
 */
export function sampleCloudRestSpace(total, forEachCentre, rest) {
  if (!total || typeof forEachCentre !== 'function') return null;
  const r = rest || { position: [0, 0, 0], rotation: [0, 0, 0, 1] };
  const stride = Math.max(1, Math.ceil(total / RIG_SAMPLE_CAP));
  const cap = Math.ceil(total / stride) + 1;
  const tx = new Float64Array(cap);
  const ty = new Float64Array(cap);
  const invz = new Float64Array(cap);
  let n = 0;
  const p = [0, 0, 0];
  forEachCentre((index, x, y, z, opacity) => {
    if (index % stride !== 0 || n >= cap) return;
    if (opacity !== undefined && opacity < RIG_MIN_OPACITY) return;
    p[0] = x;
    p[1] = y;
    p[2] = z;
    const c = toRestSpace(r, p);
    if (!(c[2] > RIG_MIN_Z)) return;
    tx[n] = c[0] / c[2];
    ty[n] = c[1] / c[2];
    invz[n] = 1 / c[2];
    n++;
  });
  return n ? { tx, ty, invz, n } : null;
}

/**
 * A strided, opacity-filtered subsample of the centres, flat [x,y,z, …] — the input to
 * `boundsFromPositions` for the fallback auto-frame. Skips near-transparent splats (haze and
 * floaters drag a box outwards) and strides above FRAME_SAMPLE_CAP (percentiles of a uniform
 * subsample are indistinguishable from the full set's, at a fraction of the cost).
 *
 * @param {number} total
 * @param {(visit: Function) => void} forEachCentre
 * @returns {Float32Array|null}
 */
export function sampleCloudCentres(total, forEachCentre) {
  if (!total || typeof forEachCentre !== 'function') return null;
  const stride = Math.max(1, Math.ceil(total / FRAME_SAMPLE_CAP));
  const xyz = new Float32Array(Math.ceil(total / stride) * 3);
  let k = 0;
  forEachCentre((index, x, y, z, opacity) => {
    if (index % stride !== 0) return;
    if (opacity !== undefined && opacity < RIG_MIN_OPACITY) return;
    if (k + 3 > xyz.length) return;
    xyz[k++] = x;
    xyz[k++] = y;
    xyz[k++] = z;
  });
  return xyz.subarray(0, k);
}

/** The splat backends `addSplat` knows. The first is the default. */
export const SPLAT_ENGINES = ['spark', 'playcanvas'];

/**
 * Which backend an `addSplat` call asked for. Unset is Spark — the path every page had before
 * there was a choice. Anything unknown THROWS, synchronously: a typo'd engine name is a page bug
 * that is true of every call, not a condition of one asset.
 *
 * @param {{engine?: string}} [opts]
 * @returns {'spark'|'playcanvas'}
 */
export function resolveSplatEngine(opts) {
  const engine = opts?.engine ?? 'spark';
  if (!SPLAT_ENGINES.includes(engine)) {
    throw new Error(
      `@displayxr/inline3d/splat: unknown engine "${engine}" — expected ` +
        `${SPLAT_ENGINES.map((e) => `'${e}'`).join(' or ')} (default 'spark').`,
    );
  }
  return engine;
}

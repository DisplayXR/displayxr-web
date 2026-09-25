// inline3d-splat-rig-map.js — each photo through ITS OWN camera rig, whatever camera rig the
// runtime's views were located for. Internal to ./inline3d-splat-playcanvas.js (and
// ./inline3d-splat-live.js).
//
// THE BUG THIS FIXES. A live transition (crossfade, wavefront, the particle transitions) keeps the
// outgoing photo on screen while the incoming photo's rig is declared. The runtime's views are
// then the INCOMING rig's, and the outgoing photo was mapped back to its own framing by a node
// chain N = R_o·K_o·D_o·D_n⁻¹·K_n⁻¹, D = diag(c·t, c·t, c). That maps the incoming WINDOW onto
// the outgoing one exactly, but it scales the EYES with it: a camera rig's eyes do not scale with
// its window (they are the viewer's eyes, times metersToVirtual), so the outgoing photo was drawn
// from eyes scaled by (c_o·t_o)/(c_n·t_n) — its disparity and head parallax jumped by that factor
// the moment the rig switched. And a declaration reaches the views a frame or more later, so for
// those frames the chain mapped views that were still the OUTGOING rig's (and the incoming photo
// was drawn through them).
//
// NO KOOIMA HERE, and no frustum is built. The runtime's projection matrices are used verbatim
// (only their depth rows are rescaled, as clampProjectionDepth already does). What this does is
// exact algebra on the runtime's outputs and the descriptors we declared:
//
//   1. A camera rig is a PORTAL (displayxr-common's dxr_camera3d_compute_view): every view looks,
//      from its own eye, through ONE window rectangle on the convergence plane — centre
//      Wc = N0 + D·fwd, half-height t·D (t = tan(vfov/2)), half-width aspect·t·D — and its eye is
//      N0 + R·m·(π·c̄ + ι·(q − c̄)) (q the viewer's eye relative to the nominal viewer, c̄ their
//      centroid, π/ι the parallax/ipd factors, m metersToVirtual).
//   2. WHICH rig a view set was located for is read off the views: under the right descriptor
//      every view's frustum crosses the window plane exactly in the window (`viewResidual`). The
//      candidates are the descriptors declared recently (`RigTracker`); none within tolerance ⇒
//      unknown ⇒ nothing is remapped (the caller keeps its old path).
//   3. From the located rig F to a target rig T, per view: the eye maps exactly (step 1 inverted
//      and re-applied — the eye centroid and offsets come from the views themselves), and the
//      affine map A_i that sends F's window onto T's (in-plane scale σ = t_T·D_T / t_F·D_F, the
//      same for x and y: both windows have the canvas's aspect) and F's eye onto T's eye maps
//      every ray from F's eye through a window point onto the ray from T's eye through the
//      matching window point. So
//
//          viewInv_T,i = A_i · viewInv_F,i        proj_T,i = proj_F,i  (depth rows rescaled)
//
//      renders EXACTLY what T's own view i would (same pixel for every point: both frusta are
//      the pyramid through the window, and A_i maps one pyramid onto the other with the window
//      rectangle onto the window rectangle). Vertical FOV, convergence, metersToVirtual and the
//      two factors may all differ. Only the depth mapping moves (A_i scales depth by a_z), which
//      is why the near/far planes are divided by a_z: the target keeps the runtime's near/far.
//
// A display rig is NOT mapped: its eyes are absolute (the viewer's z includes the nominal
// distance, which the browser does not expose), so display ↔ camera would need that one scalar.
// Everything here is PLAIN ARITHMETIC on arrays, unit-testable without a GPU.

/** A view set matches a rig when every residual is below this, in window HALF-HEIGHTS (≈0.2 px at 720 px). */
export const RIG_MATCH_TOL = 5e-4;

/** How many recently declared rigs the tracker keeps as candidates. */
export const RIG_HISTORY = 8;

const FIELDS = ['convergenceDiopters', 'verticalFov', 'metersToVirtual', 'ipdFactor', 'parallaxFactor', 'virtualDisplayHeight', 'perspectiveFactor'];

/** Rotate v by unit quaternion q (xyzw). */
function rotate(q, v) {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** A value copy of a declared descriptor (the SDK rewrites its camera-rig object in place), or null. */
export function rigSnapshot(rig) {
  if (!rig || typeof rig !== 'object') return null;
  const p = rig.position || {};
  const q = rig.orientation || {};
  const o = {
    type: rig.type,
    position: { x: +p.x || 0, y: +p.y || 0, z: +p.z || 0 },
    orientation: { x: +q.x || 0, y: +q.y || 0, z: +q.z || 0, w: q.w === undefined ? 1 : +q.w },
  };
  for (const k of FIELDS) if (rig[k] !== undefined) o[k] = rig[k];
  return o;
}

/** Same declared values (snapshots)? */
export function sameRig(a, b) {
  if (a === b) return true;
  if (!a || !b || a.type !== b.type) return false;
  for (const k of ['x', 'y', 'z']) if (a.position[k] !== b.position[k]) return false;
  for (const k of ['x', 'y', 'z', 'w']) if (a.orientation[k] !== b.orientation[k]) return false;
  for (const k of FIELDS) if (a[k] !== b[k]) return false;
  return true;
}

/**
 * The portal of a CAMERA-rig descriptor, or null (a display rig, convergence at infinity, a
 * factor of 0 — nothing to invert — or a non-finite field).
 * @returns {{ N0: number[], q: number[], right: number[], up: number[], back: number[], Wc: number[], D: number, t: number, m: number, ipd: number, par: number }|null}
 */
export function cameraPortal(rig) {
  if (!rig || rig.type !== 'camera') return null;
  const inv = rig.convergenceDiopters;
  const vfov = rig.verticalFov;
  if (!(Number.isFinite(inv) && inv > 0) || !(Number.isFinite(vfov) && vfov > 0 && vfov < Math.PI)) return null;
  const m = Number.isFinite(rig.metersToVirtual) && rig.metersToVirtual > 0 ? rig.metersToVirtual : 1;
  const ipd = rig.ipdFactor ?? 1;
  const par = rig.parallaxFactor ?? 1;
  if (!(Number.isFinite(ipd) && ipd > 0) || !(Number.isFinite(par) && par > 0)) return null;
  const p = rig.position || {};
  const o = rig.orientation || {};
  let q = [+o.x || 0, +o.y || 0, +o.z || 0, o.w === undefined ? 1 : +o.w];
  const qn = Math.hypot(q[0], q[1], q[2], q[3]);
  if (!(qn > 0)) return null;
  q = q.map((c) => c / qn);
  const N0 = [+p.x || 0, +p.y || 0, +p.z || 0];
  const right = rotate(q, [1, 0, 0]);
  const up = rotate(q, [0, 1, 0]);
  const back = rotate(q, [0, 0, 1]);
  const D = 1 / inv;
  const Wc = [N0[0] - D * back[0], N0[1] - D * back[1], N0[2] - D * back[2]];
  return { N0, q, right, up, back, Wc, D, t: Math.tan(vfov / 2), m, ipd, par };
}

/** Window-local coordinates (right, up, toward the viewer) of a point, about the window centre. */
function local(P, X) {
  const d = [X[0] - P.Wc[0], X[1] - P.Wc[1], X[2] - P.Wc[2]];
  return [dot(P.right, d), dot(P.up, d), dot(P.back, d)];
}

/**
 * How far one runtime view is from being a view of portal P, in window half-heights: its
 * rotation must be P's, and its frustum must cross P's window plane exactly in the window
 * (centred on Wc, t·D tall). Reads the projection's off-axis tangents; builds nothing.
 */
export function viewResidual(entry, P) {
  const m = entry.pose;
  const pr = entry.proj;
  // rotation: the pose's columns against the rig's axes (unit vectors; 1e-7 is float32 noise)
  const rot = Math.max(
    Math.abs(m[0] - P.right[0]), Math.abs(m[1] - P.right[1]), Math.abs(m[2] - P.right[2]),
    Math.abs(m[4] - P.up[0]), Math.abs(m[5] - P.up[1]), Math.abs(m[6] - P.up[2]),
    Math.abs(m[8] - P.back[0]), Math.abs(m[9] - P.back[1]), Math.abs(m[10] - P.back[2]),
  );
  if (!(pr[0] > 0) || !(pr[5] > 0) || Math.abs(pr[11] + 1) > 1e-6 || Math.abs(pr[4]) > 1e-6) return Infinity;
  const u = local(P, [m[12], m[13], m[14]]);
  if (!(u[2] > 0)) return Infinity;
  const tl = (pr[8] - 1) / pr[0];
  const tr = (pr[8] + 1) / pr[0];
  const tb = (pr[9] - 1) / pr[5];
  const tt = (pr[9] + 1) / pr[5];
  const h = P.t * P.D;
  const cx = u[0] + 0.5 * (tl + tr) * u[2];
  const cy = u[1] + 0.5 * (tb + tt) * u[2];
  const hy = 0.5 * (tt - tb) * u[2];
  return Math.max(rot, Math.abs(cx) / h, Math.abs(cy) / h, Math.abs(hy - h) / h);
}

/** The worst view's residual for portal P (Infinity when P is null). */
export function viewsResidual(entries, P) {
  if (!P || !entries?.length) return Infinity;
  let r = 0;
  for (const e of entries) r = Math.max(r, viewResidual(e, P));
  return r;
}

function mul4(a, b, out = new Float64Array(16)) {
  const r = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    for (let row = 0; row < 4; row++) {
      r[c * 4 + row] = a[row] * b[c * 4] + a[4 + row] * b[c * 4 + 1] + a[8 + row] * b[c * 4 + 2] + a[12 + row] * b[c * 4 + 3];
    }
  }
  out.set(r);
  return out;
}

/** Inverse of an affine column-major 4×4 (last row 0 0 0 1). Null when singular. */
export function invertAffine(m, out = new Float64Array(16)) {
  const a = m[0], b = m[4], c = m[8];
  const d = m[1], e = m[5], f = m[9];
  const g = m[2], h = m[6], i = m[10];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!(Math.abs(det) > 1e-300)) return null;
  const k = 1 / det;
  const r00 = A * k, r01 = -(b * i - c * h) * k, r02 = (b * f - c * e) * k;
  const r10 = B * k, r11 = (a * i - c * g) * k, r12 = -(a * f - c * d) * k;
  const r20 = C * k, r21 = -(a * h - b * g) * k, r22 = (a * e - b * d) * k;
  const tx = m[12], ty = m[13], tz = m[14];
  out[0] = r00; out[1] = r10; out[2] = r20; out[3] = 0;
  out[4] = r01; out[5] = r11; out[6] = r21; out[7] = 0;
  out[8] = r02; out[9] = r12; out[10] = r22; out[11] = 0;
  out[12] = -(r00 * tx + r01 * ty + r02 * tz);
  out[13] = -(r10 * tx + r11 * ty + r12 * tz);
  out[14] = -(r20 * tx + r21 * ty + r22 * tz);
  out[15] = 1;
  return out;
}

/**
 * The eyes of target portal T for the same physical eyes that produced these views of portal F
 * (dxr_display3d_apply_eye_factors_n inverted for F, re-applied for T). Rig space.
 */
export function mapEyes(entries, F, T) {
  const n = entries.length;
  const l = [];
  const c = [0, 0, 0];
  for (const e of entries) {
    const d = [e.pose[12] - F.N0[0], e.pose[13] - F.N0[1], e.pose[14] - F.N0[2]];
    const v = [dot(F.right, d) / F.m, dot(F.up, d) / F.m, dot(F.back, d) / F.m];
    l.push(v);
    c[0] += v[0] / n; c[1] += v[1] / n; c[2] += v[2] / n;
  }
  const kc = T.par / F.par;
  const ko = T.ipd / F.ipd;
  return l.map((v) => {
    const w = [0, 1, 2].map((k) => T.m * (kc * c[k] + ko * (v[k] - c[k])));
    return [0, 1, 2].map((k) => T.N0[k] + T.right[k] * w[0] + T.up[k] * w[1] + T.back[k] * w[2]);
  });
}

/**
 * The affine map A (column-major 4×4) that sends F's window onto T's window (in-plane scale σ)
 * and eye Ef onto eye Et. Null when either eye is not in front of its window.
 */
export function portalMap(F, T, Ef, Et, sigma = (T.t * T.D) / (F.t * F.D)) {
  const uf = local(F, Ef);
  const ut = local(T, Et);
  if (!(uf[2] > 0) || !(ut[2] > 0)) return null;
  // L (window-local, F → T): [σ 0 ax; 0 σ ay; 0 0 az], with L·uf = ut.
  const ax = (ut[0] - sigma * uf[0]) / uf[2];
  const ay = (ut[1] - sigma * uf[1]) / uf[2];
  const az = ut[2] / uf[2];
  // A(X) = Wc_T + B_T · L · B_Fᵀ · (X − Wc_F), B = [right up back] (columns).
  const BT = [T.right, T.up, T.back];
  const BF = [F.right, F.up, F.back];
  const Lc = [[sigma, 0, 0], [0, sigma, 0], [ax, ay, az]]; // columns of L
  // M = B_T · L · B_Fᵀ: column j = Σ_k (B_T · L)_col_k · BF[k][j]
  const TL = Lc.map((col) => [0, 1, 2].map((r) => BT[0][r] * col[0] + BT[1][r] * col[1] + BT[2][r] * col[2]));
  const A = new Float64Array(16);
  for (let j = 0; j < 3; j++) {
    for (let r = 0; r < 3; r++) A[j * 4 + r] = TL[0][r] * BF[0][j] + TL[1][r] * BF[1][j] + TL[2][r] * BF[2][j];
  }
  for (let r = 0; r < 3; r++) A[12 + r] = T.Wc[r] - (A[r] * F.Wc[0] + A[4 + r] * F.Wc[1] + A[8 + r] * F.Wc[2]);
  A[15] = 1;
  return { A, az };
}

/** Rewrite a projection's depth rows for near/far divided by `k` (the map's depth scale). */
function scaleDepth(P, k, out) {
  out.set(P);
  if (!(k > 0) || k === 1) return out;
  if (Math.abs(P[11] + 1) > 1e-6 || Math.abs(P[15]) > 1e-6) return out; // not a perspective: leave it
  const n = P[14] / (P[10] - 1);
  if (Math.abs(P[10] + 1) < 1e-9) {
    out[14] = -2 * (n / k); // infinite far: only the near plane moves
    return out;
  }
  const f = P[14] / (P[10] + 1);
  const n2 = n / k;
  const f2 = f / k;
  out[10] = -(f2 + n2) / (f2 - n2);
  out[14] = (-2 * f2 * n2) / (f2 - n2);
  return out;
}

/**
 * These views (located for portal F) as portal T's views. Per view: { proj, viewInv, view, eye }
 * — what RenderView.setView takes, and the target eye (rig space) for the camera node. Null when
 * there is nothing to do (F and T the same portal) or the map does not exist (an eye at or behind
 * a window): the caller keeps the views as they are.
 */
export function remapViews(entries, F, T, into = []) {
  if (!F || !T || !entries?.length) return null;
  if (F === T) return null;
  const Et = mapEyes(entries, F, T);
  const sigma = (T.t * T.D) / (F.t * F.D);
  into.length = entries.length;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const Ef = [e.pose[12], e.pose[13], e.pose[14]];
    const pm = portalMap(F, T, Ef, Et[i], sigma);
    if (!pm) return null;
    const o = (into[i] ||= { proj: new Float64Array(16), viewInv: new Float64Array(16), view: new Float64Array(16), eye: [0, 0, 0] });
    mul4(pm.A, e.pose, o.viewInv);
    if (!invertAffine(o.viewInv, o.view)) return null;
    scaleDepth(e.proj, pm.az, o.proj);
    o.eye[0] = Et[i][0];
    o.eye[1] = Et[i][1];
    o.eye[2] = Et[i][2];
    o.x = e.x;
    o.y = e.y;
    o.width = e.width;
    o.height = e.height;
  }
  return into;
}

/** Two portals with the same window (pose, convergence, vertical FOV) — only their eyes can differ. */
export function sameWindow(a, b) {
  return a.D === b.D && a.t === b.t && a.N0.every((x, k) => x === b.N0[k]) && a.q.every((x, k) => x === b.q[k]);
}

/** Rigid pose matrix (column-major) from a portal's orientation at `eye` — a camera node's pose. */
export function nodePose(T, eye, out = new Float64Array(16)) {
  out[0] = T.right[0]; out[1] = T.right[1]; out[2] = T.right[2]; out[3] = 0;
  out[4] = T.up[0]; out[5] = T.up[1]; out[6] = T.up[2]; out[7] = 0;
  out[8] = T.back[0]; out[9] = T.back[1]; out[10] = T.back[2]; out[11] = 0;
  out[12] = eye[0]; out[13] = eye[1]; out[14] = eye[2]; out[15] = 1;
  return out;
}

/**
 * The rigs this tile declared, newest last, and which one a view set was located for.
 * `note(rig)` on every declaration; `locate(entries)` per drawn frame.
 */
export class RigTracker {
  constructor({ history = RIG_HISTORY, tol = RIG_MATCH_TOL } = {}) {
    this.history = history;
    this.tol = tol;
    /** [{ id, rig (snapshot), portal (or null) }], oldest first. */
    this.rigs = [];
    this._seq = 0;
  }

  /** A declaration (the value, not the object: the SDK rewrites its descriptor in place). */
  note(rig) {
    const snap = rigSnapshot(rig);
    const last = this.rigs[this.rigs.length - 1];
    if (last && sameRig(last.rig, snap)) return last;
    const entry = { id: ++this._seq, rig: snap, portal: cameraPortal(snap) };
    this.rigs.push(entry);
    if (this.rigs.length > this.history) this.rigs.splice(0, this.rigs.length - this.history);
    return entry;
  }

  /** The rig declared last (what the drawing photo wants now), or null. */
  get latest() {
    return this.rigs[this.rigs.length - 1] || null;
  }

  /**
   * The declared camera rig these views were located for, or null when none matches within
   * tolerance (a display rig, a runtime clamp, a rig older than the history).
   *
   * The views pin down the WINDOW (pose, convergence, vertical FOV) exactly, but not the eye
   * factors: any eyes are consistent with a window (metersToVirtual, ipdFactor and
   * parallaxFactor only move the eyes). When several candidates match — rigs that differ ONLY in
   * those — `prefer` wins if it is among them (the rig declared when these views were pulled:
   * Blink's one frame of latency), else the newest.
   */
  locate(entries, prefer = null) {
    let best = null;
    let bestR = Infinity;
    const matches = [];
    for (let i = this.rigs.length - 1; i >= 0; i--) {
      const c = this.rigs[i];
      if (!c.portal) continue;
      const r = viewsResidual(entries, c.portal);
      if (r <= this.tol) matches.push(c); // newest first
      if (r < bestR) {
        bestR = r;
        best = c;
      }
    }
    this.lastResidual = bestR;
    if (!best || !(bestR <= this.tol)) return null;
    // Among the rigs sharing the best match's window (they differ only in the eye factors):
    // `prefer` if it is one of them, else the newest.
    const group = matches.filter((c) => sameWindow(c.portal, best.portal));
    return group.includes(prefer) ? prefer : group[0];
  }
}

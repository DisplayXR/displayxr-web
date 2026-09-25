// still-post.js — post-processing for still-depth graphs whose last step can't live in ONNX.
// Ported from the export spike (~/dxr-2d3d-exports/still/js/still_depth.js):
//   MoGe-3 ViT-L (MIT): affine point map + mask + metric scale → metric depth + focal (focal/shift
//     recovery mirrors moge/utils/geometry_torch.py recover_focal_shift).
//   DA3Mono-Large (Apache-2.0): relative DEPTH (larger = farther — checked against the reference
//     npz: traffic scene top 2.53 vs bottom 0.21) + sky prob → sky filled with the 99th percentile.
// Both graphs: static shape, RGB [0,1] CHW input, ImageNet normalisation inside the graph.

/** UV of the normalised view plane, MoGe convention: corners at (+-W/diag, +-H/diag) (pixel centres). */
function viewPlaneUV(W, H) {
  const a = W / H, sx = a / Math.sqrt(1 + a * a), sy = 1 / Math.sqrt(1 + a * a);
  const lin = (span, n, i) => (n === 1 ? -span * (n - 1) / n : -span * (n - 1) / n + (2 * span * (n - 1) / n) * i / (n - 1));
  return { u: i => lin(sx, W, i), v: j => lin(sy, H, j) };
}

/** torch F.interpolate(mode='nearest') source index. */
const nearestIdx = (nIn, nOut) => Array.from({ length: nOut }, (_, i) => Math.min(Math.floor(i * (nIn / nOut)), nIn - 1));

/** Solve min_{shift,f} sum |f * xy/(z+shift) - uv|^2 (f closed-form per shift); 1-D damped Newton on shift. */
export function solveFocalShift(U, V, X, Y, Z) {
  const n = Z.length; let zmin = Infinity; for (let i = 0; i < n; i++) zmin = Math.min(zmin, Z[i]);
  const cost = s => {
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { const w = 1 / (Z[i] + s), px = X[i] * w, py = Y[i] * w; num += px * U[i] + py * V[i]; den += px * px + py * py; }
    const f = num / den; let c = 0;
    for (let i = 0; i < n; i++) { const w = 1 / (Z[i] + s), rx = f * X[i] * w - U[i], ry = f * Y[i] * w - V[i]; c += rx * rx + ry * ry; }
    return [c, f];
  };
  let s = 0, [c] = cost(0);
  for (let it = 0; it < 50; it++) {
    const h = 1e-4 * Math.max(1, Math.abs(s) + zmin);
    const cp = cost(s + h)[0], cm = s - h > -zmin ? cost(s - h)[0] : c;
    const g = (cp - cm) / (2 * h), H2 = (cp - 2 * c + cm) / (h * h);
    let step = -g / (Math.abs(H2) * (1 + 1e-3) + 1e-12), sn = s, cn = c;
    for (;;) {
      sn = s + step;
      if (sn > -zmin + 1e-6) { cn = cost(sn)[0]; if (cn <= c) break; }
      step *= 0.5; if (Math.abs(step) < 1e-9) break;
    }
    if (Math.abs(step) < 1e-9) break;
    const conv = Math.abs(c - cn) <= 1e-6 * c; s = sn; c = cn; if (conv) break;
  }
  return { shift: s, focal: cost(s)[1] };
}

/**
 * MoGe infer() post-processing. points: Float32Array H*W*3 (affine point map, graph output),
 * maskProb: H*W, scale: metric scale, normal: H*W*3 or null.
 * Returns depth (metres, 0 where invalid), mask (Uint8Array), focalPx (fx == fy, principal point at centre), normals.
 */
export function mogePost(points, maskProb, scale, normal, W, H) {
  const N = W * H, mask = new Uint8Array(N);
  for (let i = 0; i < N; i++) mask[i] = maskProb[i] > 0.5 ? 1 : 0;
  const iy = nearestIdx(H, 64), ix = nearestIdx(W, 64), uv = viewPlaneUV(W, H);
  const U = [], V = [], X = [], Y = [], Z = [];
  for (const y of iy) for (const x of ix) {
    const k = y * W + x; if (!mask[k]) continue;
    U.push(uv.u(x)); V.push(uv.v(y)); X.push(points[3 * k]); Y.push(points[3 * k + 1]); Z.push(points[3 * k + 2]);
  }
  const { shift, focal } = Z.length < 2 ? { shift: 0, focal: 1 } : solveFocalShift(U, V, X, Y, Z);
  const depth = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const d = (points[3 * i + 2] + shift) * scale;
    if (mask[i] && d > 0) depth[i] = d; else mask[i] = 0;
  }
  let normals = null;
  if (normal) { normals = new Float32Array(normal); for (let i = 0; i < N; i++) if (!mask[i]) normals[3 * i] = normals[3 * i + 1] = normals[3 * i + 2] = 0; }
  const focalPx = focal * 0.5 * Math.hypot(W, H);
  return { depth, mask, focalPx, fovXDeg: 2 * Math.atan(W / 2 / focalPx) * 180 / Math.PI, normals, shift, metricScale: scale };
}

/**
 * DA3Mono post-processing (upstream da3.py _process_mono_sky_estimation, taken out of the graph because it
 * subsamples with torch.randint): non-sky = sky < 0.3; sky pixels are set to the 99th percentile of non-sky depth.
 * We use an EXACT percentile (upstream: of a random 100k subsample). Depth is relative (larger = farther,
 * scale-ambiguous); DA3Mono has no camera head -> focalPx null. mask = non-sky.
 */
export function da3Post(depthRaw, sky, W, H) {
  const N = W * H, depth = Float32Array.from(depthRaw), mask = new Uint8Array(N); let nNon = 0;
  for (let i = 0; i < N; i++) { mask[i] = sky[i] < 0.3 ? 1 : 0; nNon += mask[i]; }
  if (nNon > 10 && N - nNon > 10) {
    const v = new Float32Array(nNon); for (let i = 0, k = 0; i < N; i++) if (mask[i]) v[k++] = depth[i];
    v.sort(); const p = 0.99 * (nNon - 1), lo = Math.floor(p), q = v[lo] + (v[Math.min(lo + 1, nNon - 1)] - v[lo]) * (p - lo);
    for (let i = 0; i < N; i++) if (!mask[i]) depth[i] = q;
  }
  return { depth, mask, focalPx: null, normals: null, skyFillDepth: nNon > 10 && N - nNon > 10 };
}


// cpu-ref.js — plain-JS reference implementations of the generator's morphology passes
// (./passes/erode, ./passes/edges, ./passes/hidden). They mirror the GLSL tap for tap and exist
// for two reasons: the Node unit tests pin the SEMANTICS on synthetic depth without a GPU, and
// the in-browser parity test (test/lift-gen-gpu.html) checks the GPU passes against them.
//
// Arrays are row-major, row 0 = image TOP, single channel unless noted.

const at = (a, W, H, x, y) => a[Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))];

/** Separable grey erosion (min-filter), radius R, clamp-to-edge. */
export function erodeRef(d, W, H, R) {
  const t = new Float32Array(W * H), o = new Float32Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let m = d[y * W + x];
      for (let k = 1; k <= R; k++) m = Math.min(m, at(d, W, H, x + k, y), at(d, W, H, x - k, y));
      t[y * W + x] = m;
    }
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let m = t[y * W + x];
      for (let k = 1; k <= R; k++) m = Math.min(m, at(t, W, H, x, y + k), at(t, W, H, x, y - k));
      o[y * W + x] = m;
    }
  return o;
}

/** Far-side edge map → Float32Array W·H·4 (ΔL, ΔR, ΔU, ΔD). pad/inner as in the GLSL. */
export function edgesRef(d, W, H, { pad = [0, 0], inner = [W, H], tau }) {
  const o = new Float32Array(W * H * 4);
  const f = Math.fround;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const qx = x - pad[0], qy = y - pad[1];
      if (qx < 0 || qy < 0 || qx >= inner[0] || qy >= inner[1]) continue;
      const c = d[y * W + x];
      const st = (dx, dy) => {
        const n = Math.max(at(d, W, H, x + dx, y + dy), at(d, W, H, x + 2 * dx, y + 2 * dy));
        const s = f(n - c);
        return s > tau ? s : 0;
      };
      const i = 4 * (y * W + x);
      o[i] = st(-1, 0); o[i + 1] = st(1, 0); o[i + 2] = st(0, -1); o[i + 3] = st(0, 1);
    }
  return o;
}

/** Hidden-layer mask → Float32Array W·H·4 (maskRight, maskLeft, dist | −1 border, bg d̂). */
export function hiddenRef(d, E, W, H, { pad = [0, 0], inner = [W, H], K, band, tau }) {
  const o = new Float32Array(W * H * 4);
  const lo = pad, hi = [pad[0] + inner[0] - 1, pad[1] + inner[1] - 1];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = 4 * (y * W + x);
      const qx = x - pad[0], qy = y - pad[1];
      if (qx < 0 || qy < 0 || qx >= inner[0] || qy >= inner[1]) {
        const left = qx < Math.trunc(inner[0] / 2);
        o[i] = left ? 1 : 0; o[i + 1] = left ? 0 : 1; o[i + 2] = -1; o[i + 3] = 0;
        continue;
      }
      const c = d[y * W + x];
      const probe = (ex, ey, ch, k) => {
        const s = E[4 * (ey * W + ex) + ch];
        const de = d[ey * W + ex];
        return s > 0 && k <= s * band && c > de + 0.5 * tau ? de : null;
      };
      for (let k = 1; k <= K; k++) {
        let de;
        if (x + k <= hi[0] && (de = probe(x + k, y, 0, k)) !== null) { o.set([1, 0, k, de], i); break; }
        if (x - k >= lo[0] && (de = probe(x - k, y, 1, k)) !== null) { o.set([0, 1, k, de], i); break; }
        if (y + k <= hi[1] && (de = probe(x, y + k, 2, k)) !== null) { o.set([1, 0, k, de], i); break; }
        if (y - k >= lo[1] && (de = probe(x, y - k, 3, k)) !== null) { o.set([1, 0, k, de], i); break; }
      }
    }
  return o;
}

// test/sbs-fixtures.mjs — synthetic side-by-side grayscale pairs with KNOWN disparities, shared by
// the auto-convergence tests (call-autoconv, conv-meter, call-sender-conv). Not a test file.
// d = left x − right x; positive = in front of the display plane.

/** Deterministic texture: a value per (x, y) in 4-px cells, seeded. */
export function texture(seed) {
  return (x, y) => {
    let h = (Math.floor(x / 4) * 73856093) ^ (Math.floor(y / 4) * 19349663) ^ (seed * 83492791);
    h = (h ^ (h >>> 13)) * 1274126177;
    return 40 + (((h ^ (h >>> 16)) >>> 0) % 176);
  };
}

/**
 * A SBS gray image. `layers` are drawn back to front: { d, tex, inside(x, y) } where inside() is in
 * LEFT-eye coordinates (null = everywhere). The right eye sees each layer shifted left by d.
 */
export function sbs(E, H, layers) {
  const W = 2 * E;
  const img = new Uint8Array(W * H);
  for (let eye = 0; eye < 2; eye++) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < E; x++) {
        let v = 128;
        for (const L of layers) {
          const xl = eye === 0 ? x : x + L.d; // the left-eye point this right-eye pixel shows
          if (!L.inside || L.inside(xl, y)) v = L.tex(xl, y);
        }
        img[y * W + eye * E + x] = v;
      }
    }
  }
  return { img, W, H };
}

export const rect = (x0, y0, x1, y1) => (x, y) => x >= x0 && x < x1 && y >= y0 && y < y1;
export const ellipse = (cx, cy, rx, ry) => (x, y) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;

// Synthetic ground-truth scene for the live-DIBR dev page and tests: a textured slanted ground
// plane + a mid-depth rectangle + a near disc, moving on a 4 s loop. Pure JS (runs in node to
// encode test/lift-dibr-clip.mp4, and in the page to produce the analytic depth at any res).
// Disparity is RELATIVE (bigger = nearer), in [0.15, 0.9].

export const W = 1280;
export const H = 720;
export const FPS = 60;
export const DURATION = 4;

const TAU = Math.PI * 2;
function objects(t) {
  const ph = (TAU * t) / DURATION;
  return {
    rect: { cx: 420 + 200 * Math.sin(ph), cy: 400, hw: 130, hh: 110, d: 0.6 },
    disc: { cx: 860 - 220 * Math.sin(ph + 1), cy: 320, r: 110, d: 0.9 },
  };
}
const bgDisp = (y) => 0.15 + 0.35 * (y / H); // top far, bottom near
function hash(i, j) {
  let h = (i * 374761393 + j * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Disparity at image point (x,y) in 1280x720 px coords at time t. */
export function dispAt(x, y, t, o = objects(t)) {
  const { disc, rect } = o;
  if ((x - disc.cx) ** 2 + (y - disc.cy) ** 2 <= disc.r * disc.r) return disc.d;
  if (Math.abs(x - rect.cx) <= rect.hw && Math.abs(y - rect.cy) <= rect.hh) return rect.d;
  return bgDisp(y);
}

/** RGBA frame at time t into `out` (Uint8ClampedArray W*H*4). */
export function renderFrame(t, out = new Uint8ClampedArray(W * H * 4)) {
  const o = objects(t);
  const { disc, rect } = o;
  for (let y = 0; y < H; y++) {
    // ground plane texture: tiles shrink toward the top (perspective-ish)
    const s = 10 + 40 * (y / H);
    const tj = Math.floor(y / s);
    for (let x = 0; x < W; x++) {
      const k = (y * W + x) * 4;
      let r, g, b;
      if ((x - disc.cx) ** 2 + (y - disc.cy) ** 2 <= disc.r * disc.r) {
        const rr = Math.sqrt((x - disc.cx) ** 2 + (y - disc.cy) ** 2);
        const ring = Math.floor(rr / 14) % 2;
        r = ring ? 40 : 90; g = ring ? 120 : 190; b = 250;
      } else if (Math.abs(x - rect.cx) <= rect.hw && Math.abs(y - rect.cy) <= rect.hh) {
        const st = Math.floor((x - rect.cx + y - rect.cy + 1000) / 18) % 2;
        r = 250; g = st ? 150 : 90; b = st ? 40 : 20;
      } else {
        const ti = Math.floor((x - W / 2) / s + 1000);
        const v = hash(ti, tj);
        const chk = (ti + tj) % 2;
        r = 60 + 90 * v + 50 * chk; g = 110 + 80 * v + 30 * chk; b = 60 + 40 * v;
      }
      out[k] = r; out[k + 1] = g; out[k + 2] = b; out[k + 3] = 255;
    }
  }
  return out;
}

/** Ground-truth disparity map at w x h (row 0 = top), box-sampled at pixel centres. */
export function depthMap(t, w, h) {
  const o = objects(t);
  const out = new Float32Array(w * h);
  for (let j = 0; j < h; j++) {
    const y = ((j + 0.5) * H) / h;
    for (let i = 0; i < w; i++) out[j * w + i] = dispAt(((i + 0.5) * W) / w, y, t, o);
  }
  return out;
}

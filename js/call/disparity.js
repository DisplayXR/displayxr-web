// Auto-convergence (RFC 0002 §3): MEASURE how far apart the remote person's eyes are between the two
// halves of their side-by-side frame, so the receiver can shift each eye by d/2 in opposite
// directions and put the point between the eyes at zero parallax (the display plane).
//
// No focal length, baseline or distance: those only PREDICT the disparity (f·B/Z); here it is read
// off the pixels. Works for any SBS sender, calibrated or not, as long as the rows roughly align (a
// small vertical search absorbs the residual of a raw, unrectified pair).
//
// The focus is ONE point, the midpoint between the eyes. It stays meaningful when the head turns (one
// eye may be hidden), unlike "both eyes" or "the whole face". Without a face detector the module
// finds the subject as the NEAREST strong disparity mode (in a call the person is in front of the
// room) and takes the eye line from the top of that blob.
//
// Pure: a grayscale SBS image in, numbers out. No DOM, no WebRTC. Sizes are in the INPUT's pixels;
// the caller scales back to source pixels.

/** Blocks with a luma standard deviation below this are too flat to match. */
const MIN_TEXTURE = 6;

/** A block match must reach this normalised cross-correlation to count. */
export const MIN_NCC = 0.8;

/**
 * Normalised cross-correlation of a `bw`×`bh` block of the left eye at (lx, ly) against the right
 * eye at (rx, ry). `img` is the whole SBS image, `W` its full width, `E` the per-eye width.
 * Returns -1 when the right block would leave the right eye or is flat.
 */
function ncc(img, W, E, lx, ly, rx, ry, bw, bh, lMean, lStd) {
  if (rx < 0 || rx + bw > E || ry < 0) return -1;
  let sum = 0;
  let sum2 = 0;
  let cross = 0;
  const n = bw * bh;
  for (let y = 0; y < bh; y++) {
    const lo = (ly + y) * W + lx;
    const ro = (ry + y) * W + E + rx;
    for (let x = 0; x < bw; x++) {
      const r = img[ro + x];
      sum += r;
      sum2 += r * r;
      cross += img[lo + x] * r;
    }
  }
  const rMean = sum / n;
  const rVar = sum2 / n - rMean * rMean;
  if (rVar < 1) return -1;
  return (cross / n - lMean * rMean) / (lStd * Math.sqrt(rVar));
}

function blockStats(img, W, x0, y0, bw, bh) {
  let sum = 0;
  let sum2 = 0;
  for (let y = 0; y < bh; y++) {
    const o = (y0 + y) * W + x0;
    for (let x = 0; x < bw; x++) {
      const v = img[o + x];
      sum += v;
      sum2 += v * v;
    }
  }
  const n = bw * bh;
  const mean = sum / n;
  return { mean, std: Math.sqrt(Math.max(0, sum2 / n - mean * mean)) };
}

/**
 * Best horizontal disparity of one left-eye block: `d = xLeft − xRight` (positive = crossed = in
 * front of the display plane), searched over [dMin, dMax] and ±dy rows. Sub-pixel by a parabola.
 * @returns {{d:number, dy:number, c:number}|null}
 */
export function matchBlock(img, W, H, x0, y0, bw, bh, { dMin, dMax, dyMax = 2 } = {}) {
  const E = W / 2;
  const { mean, std } = blockStats(img, W, x0, y0, bw, bh);
  if (std < MIN_TEXTURE) return null;
  let best = -2;
  let bd = 0;
  let bdy = 0;
  const scan = (d0, d1, dStep, y0s, y1s) => {
    for (let dy = y0s; dy <= y1s; dy++) {
      const ry = y0 + dy;
      if (ry < 0 || ry + bh > H) continue;
      for (let d = d0; d <= d1; d += dStep) {
        const c = ncc(img, W, E, x0, y0, x0 - d, ry, bw, bh, mean, std);
        if (c > best) {
          best = c;
          bd = d;
          bdy = dy;
        }
      }
    }
  };
  // Coarse (every 2nd disparity, rows every 2nd), then a full-resolution pass around the winner:
  // ~1/4 of the exhaustive cost, and textures here are never finer than the downscaled 2-px step.
  const coarse = dMax - dMin > 8;
  scan(dMin, dMax, coarse ? 2 : 1, -dyMax, dyMax);
  if (coarse && best > -1) {
    const cd = bd;
    const cy = bdy;
    scan(Math.max(dMin, cd - 2), Math.min(dMax, cd + 2), 1, Math.max(-dyMax, cy - 1), Math.min(dyMax, cy + 1));
  }
  if (best < -1) return null;
  // Sub-pixel along d at the best row.
  const cm = ncc(img, W, E, x0, y0, x0 - (bd - 1), y0 + bdy, bw, bh, mean, std);
  const cp = ncc(img, W, E, x0, y0, x0 - (bd + 1), y0 + bdy, bw, bh, mean, std);
  let sub = 0;
  const den = cm - 2 * best + cp;
  if (cm > -1 && cp > -1 && den < 0) sub = Math.max(-0.5, Math.min(0.5, (0.5 * (cm - cp)) / den));
  return { d: bd + sub, dy: bdy, c: best };
}

/**
 * Block disparities over the central region of the LEFT eye.
 * @returns {Array<{x:number,y:number,d:number,dy:number,c:number}>} block top-left corners
 */
export function blockDisparities(img, W, H, o = {}) {
  const E = W / 2;
  const b = o.block || Math.max(8, Math.round(E / 20));
  const step = o.step || Math.round(b * 1.5); // sparse grid: half the blocks, same modes
  const dMax = o.dMax ?? Math.round(E * 0.3);
  const dMin = o.dMin ?? -Math.round(E * 0.05);
  const x0 = Math.round(E * (o.roiX0 ?? 0.15));
  const x1 = Math.round(E * (o.roiX1 ?? 0.85)) - b;
  const y0 = Math.round(H * (o.roiY0 ?? 0.05));
  const y1 = Math.round(H * (o.roiY1 ?? 0.85)) - b;
  const out = [];
  for (let y = y0; y <= y1; y += step) {
    for (let x = x0; x <= x1; x += step) {
      const m = matchBlock(img, W, H, x, y, b, b, { dMin, dMax, dyMax: o.dyMax ?? 2 });
      if (m && m.c >= (o.minNcc ?? MIN_NCC)) out.push({ x, y, ...m });
    }
  }
  return out;
}

/**
 * The subject = the NEAREST strong disparity mode: the largest `d` whose ±`tol` bin holds at least
 * `minFrac` of the matched blocks (and `minBlocks`). Returns its members, or null.
 */
export function nearestMode(blocks, { tol = 2, minFrac = 0.12, minBlocks = 3 } = {}) {
  if (!blocks.length) return null;
  const need = Math.max(minBlocks, Math.ceil(blocks.length * minFrac));
  const ds = blocks.map((b) => b.d).sort((a, b) => b - a); // descending: nearest first
  for (const d of ds) {
    const members = blocks.filter((b) => Math.abs(b.d - d) <= tol);
    if (members.length >= need) {
      const md = members.map((b) => b.d).sort((a, b) => a - b);
      return { d: md[md.length >> 1], members };
    }
  }
  return null;
}

/**
 * Where the eyes are in a subject blob: horizontally the centre of its TOP rows (the head, not the
 * shoulders), vertically ~40% down a head whose height ≈ 1.3 × its width.
 *
 * Measured on real SR-camera frames (grayscale, dim), only a handful of blocks match on a face, so
 * this lands on the upper face, often the forehead, a few cm above the eyes. That is the same depth
 * plane to within ~1 cm: at 0.6 m the disparity differs by ~1-2 source px, under 1 px of shift per
 * eye. A darkest-band eye-line search was tried and rejected: the darkest band is the hair. Pass
 * `focus` (a face detector's eye midpoint) for the exact point.
 */
export function eyeMidpoint(members, block) {
  const top = Math.min(...members.map((m) => m.y));
  const headRows = members.filter((m) => m.y <= top + 2 * block);
  const xs = headRows.map((m) => m.x);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs) + block;
  const headW = xMax - xMin;
  return { x: (xMin + xMax) / 2, y: top + 0.4 * 1.3 * headW };
}

/**
 * The disparity of the point between the eyes, in input pixels.
 *
 * @param {Uint8Array|Uint8ClampedArray|number[]} img  grayscale SBS, row-major, `W`×`H`
 * @param {number} W  full SBS width (both eyes)
 * @param {number} H
 * @param {object} [o]
 * @param {{x:number,y:number}} [o.focus]  the eye midpoint in LEFT-eye pixels (e.g. from a face
 *        detector); skips the subject search
 * @returns {{d:number, x:number, y:number, c:number, method:'focus'|'mode', blocks:number}|null}
 */
export function measureFocusDisparity(img, W, H, o = {}) {
  const E = W / 2;
  const b = o.block || Math.max(8, Math.round(E / 20));
  const dMax = o.dMax ?? Math.round(E * 0.3);
  const dMin = o.dMin ?? -Math.round(E * 0.05);
  let focus = o.focus || null;
  let method = 'focus';
  let blocks = 0;
  let d0 = null;
  if (!focus) {
    const all = blockDisparities(img, W, H, { ...o, block: b, dMax, dMin });
    blocks = all.length;
    const mode = nearestMode(all, o);
    if (!mode) return null;
    focus = eyeMidpoint(mode.members, b);
    d0 = mode.d;
    method = 'mode';
  }
  // Refine with one wider window centred on the focus point: eyes + brow + nose bridge carry
  // plenty of texture even when one eye is turned away.
  const ww = Math.round(b * (o.refineW ?? 3));
  const wh = Math.round(b * (o.refineH ?? 1.5));
  const rx = Math.round(Math.max(0, Math.min(E - ww, focus.x - ww / 2)));
  const ry = Math.round(Math.max(0, Math.min(H - wh, focus.y - wh / 2)));
  const lo = d0 === null ? dMin : Math.max(dMin, Math.floor(d0) - 4);
  const hi = d0 === null ? dMax : Math.min(dMax, Math.ceil(d0) + 4);
  const m = matchBlock(img, W, H, rx, ry, ww, wh, { dMin: lo, dMax: hi, dyMax: o.dyMax ?? 2 });
  if (m && m.c >= (o.minNcc ?? MIN_NCC)) return { d: m.d, x: focus.x, y: focus.y, c: m.c, method, blocks };
  // A flat or occluded focus window: fall back to the subject's mode.
  if (d0 !== null) return { d: d0, x: focus.x, y: focus.y, c: 0, method, blocks };
  return null;
}

/** RGBA pixels (ImageData.data) of a SBS frame → luma, same size. */
export function lumaFromRgba(rgba, n) {
  const out = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) out[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
  return out;
}

/**
 * Temporal steadiness for measurements: the median of the last `n` accepted values, and a hold of
 * the last good value when a measurement fails (a blink, a hand over the face) rather than snapping
 * back to zero.
 */
export function createDisparityTrack({ n = 3 } = {}) {
  const hist = [];
  const t = {
    value: null,
    push(d) {
      if (d === null || !Number.isFinite(d)) return t.value;
      hist.push(d);
      if (hist.length > n) hist.shift();
      const s = [...hist].sort((a, b) => a - b);
      t.value = s[s.length >> 1];
      return t.value;
    },
    reset() {
      hist.length = 0;
      t.value = null;
    },
  };
  return t;
}

/** Copy a `w`×`h` patch of the LEFT eye at (x, y). */
function copyPatch(img, W, x, y, w, h) {
  const p = new Float32Array(w * h);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) p[r * w + c] = img[(y + r) * W + x + c];
  return p;
}

/** Best NCC position of `tpl` (w×h) in the LEFT eye within ±rx/±ry of (x0, y0). */
function findInLeft(img, W, H, tpl, w, h, x0, y0, rx, ry) {
  const E = W / 2;
  const n = w * h;
  let tm = 0;
  let t2 = 0;
  for (let i = 0; i < n; i++) {
    tm += tpl[i];
    t2 += tpl[i] * tpl[i];
  }
  tm /= n;
  const ts = Math.sqrt(Math.max(1e-6, t2 / n - tm * tm));
  let best = -2;
  let bx = x0;
  let by = y0;
  for (let y = Math.max(0, y0 - ry); y <= Math.min(H - h, y0 + ry); y++) {
    for (let x = Math.max(0, x0 - rx); x <= Math.min(E - w, x0 + rx); x++) {
      let s = 0;
      let s2 = 0;
      let cr = 0;
      for (let r = 0; r < h; r++) {
        const o = (y + r) * W + x;
        for (let c = 0; c < w; c++) {
          const v = img[o + c];
          s += v;
          s2 += v * v;
          cr += v * tpl[r * w + c];
        }
      }
      const m = s / n;
      const vr = s2 / n - m * m;
      if (vr < 1) continue;
      const cc = (cr / n - m * tm) / (Math.sqrt(vr) * ts);
      if (cc > best) {
        best = cc;
        bx = x;
        by = y;
      }
    }
  }
  return { x: bx, y: by, c: best };
}

/**
 * Cheap frame-to-frame tracking of the focus point. A full subject search (measureFocusDisparity)
 * locks on; after that each call only re-finds a small left-eye template around the last position
 * (the head moved) and matches it to the right eye in a ±`dWin` disparity window. The full search
 * re-runs every `fullEveryMs`, or as soon as tracking loses the template.
 */
export function createFocusTracker({ fullEveryMs = 2000, dWin = 4, rx = 12, ry = 8, minTrackNcc = 0.75 } = {}) {
  let st = null; // { x, y, d, tpl, w, h, at }
  const t = {
    /** @returns {{d:number,x:number,y:number,c:number,method:'mode'|'focus'|'track',blocks:number}|null} */
    measure(img, W, H, now, o = {}) {
      const E = W / 2;
      const b = o.block || Math.max(8, Math.round(E / 20));
      const w = Math.round(b * 3);
      const h = Math.round(b * 1.5);
      if (st && now - st.at < fullEveryMs && st.w === w && st.h === h) {
        const f = findInLeft(img, W, H, st.tpl, w, h, st.x, st.y, rx, ry);
        if (f.c >= minTrackNcc) {
          const m = matchBlock(img, W, H, f.x, f.y, w, h, { dMin: Math.floor(st.d) - dWin, dMax: Math.ceil(st.d) + dWin, dyMax: 2 });
          if (m && m.c >= MIN_NCC) {
            st = { ...st, x: f.x, y: f.y, d: m.d, tpl: copyPatch(img, W, f.x, f.y, w, h) };
            return { d: m.d, x: f.x + w / 2, y: f.y + h / 2, c: m.c, method: 'track', blocks: 0 };
          }
        }
      }
      const m = measureFocusDisparity(img, W, H, o);
      if (!m) {
        st = null;
        return null;
      }
      const x = Math.round(Math.max(0, Math.min(E - w, m.x - w / 2)));
      const y = Math.round(Math.max(0, Math.min(H - h, m.y - h / 2)));
      st = { x, y, d: m.d, tpl: copyPatch(img, W, x, y, w, h), w, h, at: now };
      return m;
    },
    reset() {
      st = null;
    },
  };
  return t;
}

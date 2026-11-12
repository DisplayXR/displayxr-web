// Pixel analysis for inline3d-check. Pure functions over { width, height, data: RGBA bytes }, so
// they are unit-tested without a browser (test/analyze.test.mjs).

export function crop(img, x, y, w, h) {
  x = Math.max(0, Math.round(x)); y = Math.max(0, Math.round(y));
  w = Math.max(0, Math.min(img.width - x, Math.round(w))); h = Math.max(0, Math.min(img.height - y, Math.round(h)));
  const out = new Uint8Array(w * h * 4);
  for (let j = 0; j < h; j++) out.set(img.data.subarray(((y + j) * img.width + x) * 4, ((y + j) * img.width + x + w) * 4), j * w * 4);
  return { width: w, height: h, data: out };
}

export function halves(img) {
  const hw = Math.floor(img.width / 2);
  return [crop(img, 0, 0, hw, img.height), crop(img, hw, 0, hw, img.height)];
}

/** Luminance composited over mid-grey (so transparent and opaque pixels compare sensibly). */
export function gray(img) {
  const n = img.width * img.height, g = new Float32Array(n), d = img.data;
  for (let i = 0; i < n; i++) {
    const o = i * 4, a = d[o + 3] / 255;
    const l = 0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2];
    g[i] = l * a + 128 * (1 - a);
  }
  return g;
}

/**
 * What a picture holds: the dominant colour (4-bit quantised RGBA) and the fraction of pixels that
 * differ from it. `blank` = less than 0.3 % of the picture is anything but that one colour —
 * an all-black, all-transparent or flat-filled eye.
 */
export function contentStats(img) {
  const d = img.data, n = img.width * img.height;
  if (!n) return { blank: true, contentFraction: 0, opaqueFraction: 0, meanLum: 0, lumStd: 0, dominant: null, n };
  const hist = new Map();
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const k = (d[o] >> 4) | ((d[o + 1] >> 4) << 4) | ((d[o + 2] >> 4) << 8) | ((d[o + 3] >> 4) << 12);
    hist.set(k, (hist.get(k) || 0) + 1);
  }
  let dom = 0, best = -1;
  for (const [k, v] of hist) if (v > best) { best = v; dom = k; }
  const dr = (dom & 15) * 16 + 8, dg = ((dom >> 4) & 15) * 16 + 8, db = ((dom >> 8) & 15) * 16 + 8, da = ((dom >> 12) & 15) * 16 + 8;
  let content = 0, opaque = 0, sum = 0, sum2 = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (Math.abs(d[o] - dr) + Math.abs(d[o + 1] - dg) + Math.abs(d[o + 2] - db) + Math.abs(d[o + 3] - da) > 48) content++;
    if (d[o + 3] > 240) opaque++;
    const l = (0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2]) * (d[o + 3] / 255);
    sum += l; sum2 += l * l;
  }
  const meanLum = sum / n;
  const contentFraction = content / n;
  return {
    blank: contentFraction < 0.003,
    contentFraction,
    opaqueFraction: opaque / n,
    meanLum,
    lumStd: Math.sqrt(Math.max(0, sum2 / n - meanLum * meanLum)),
    dominant: [dr - 8, dg - 8, db - 8, da - 8],
    black: opaque / n > 0.9 && meanLum < 10 && contentFraction < 0.003,
    transparent: da < 16 && contentFraction < 0.003,
    n,
  };
}

/** Mean |A(x) − B(x + s)| over the overlap, on grey arrays of the same w×h. */
export function madShift(A, B, w, h, s) {
  let sum = 0, cnt = 0;
  const x0 = Math.max(0, -s), x1 = Math.min(w, w - s);
  for (let y = 0; y < h; y++) {
    const r = y * w;
    for (let x = x0; x < x1; x++) { sum += Math.abs(A[r + x] - B[r + x + s]); cnt++; }
  }
  return cnt ? sum / cnt : Infinity;
}

export function std(G) {
  let s = 0, s2 = 0;
  for (const v of G) { s += v; s2 += v * v; }
  const m = s / (G.length || 1);
  return Math.sqrt(Math.max(0, s2 / (G.length || 1) - m * m));
}

/**
 * Compare two eyes. identical: the eyes are the same picture (a duplicated flat image);
 * bestShift / madBest: the single horizontal shift that aligns them best; baseline: the mismatch
 * at a third of the width, i.e. what "unrelated" looks like for this content.
 */
export function compareEyes(L, R) {
  const w = L.width, h = L.height;
  const a = gray(L), b = gray(R);
  let maxd = 0, big = 0, sum = 0;
  for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); sum += d; if (d > maxd) maxd = d; if (d > 10) big++; }
  const mad0 = sum / (a.length || 1);
  const S = Math.max(2, Math.round(w * 0.12));
  let madBest = Infinity, bestShift = 0;
  for (let s = -S; s <= S; s++) { const m = madShift(a, b, w, h, s); if (m < madBest) { madBest = m; bestShift = s; } }
  const baseline = madShift(a, b, w, h, Math.round(w / 3));
  return {
    mad0,
    maxDiff: maxd,
    differingFraction: big / (a.length || 1),
    identical: mad0 < 0.5 && big / (a.length || 1) < 0.001,
    bestShift,
    madBest,
    baseline,
    stdL: std(a),
    stdR: std(b),
  };
}

/**
 * Per-block horizontal disparity, right eye relative to left (xR − xL, eye pixels): + = behind the
 * glass (uncrossed), − = in front (crossed). Only textured blocks with a clear match count.
 */
export function blockDisparity(L, R, { block = 12, maxShiftFrac = 0.12 } = {}) {
  const w = L.width, h = L.height;
  const a = gray(L), b = gray(R);
  const S = Math.max(2, Math.round(w * maxShiftFrac));
  const out = [];
  out.textured = 0;
  for (let by = 0; by + block <= h; by += block) {
    for (let bx = 0; bx + block <= w; bx += block) {
      let s = 0, s2 = 0;
      for (let y = by; y < by + block; y++) for (let x = bx; x < bx + block; x++) { const v = a[y * w + x]; s += v; s2 += v * v; }
      const nn = block * block, m = s / nn, sd = Math.sqrt(Math.max(0, s2 / nn - m * m));
      if (sd < 6) continue;
      out.textured++;
      const costs = [];
      for (let d = -S; d <= S; d++) {
        if (bx + d < 0 || bx + d + block > w) { costs.push(Infinity); continue; }
        let c = 0;
        for (let y = by; y < by + block; y++) { const r = y * w; for (let x = bx; x < bx + block; x++) c += Math.abs(a[r + x] - b[r + x + d]); }
        costs.push(c / nn);
      }
      let bi = 0;
      for (let i = 1; i < costs.length; i++) if (costs[i] < costs[bi]) bi = i;
      const best = costs[bi];
      let second = Infinity;
      for (let i = 0; i < costs.length; i++) if (Math.abs(i - bi) > 2 && costs[i] < second) second = costs[i];
      if (!(best < 0.6 * second) || best > 12) continue;
      // sub-pixel parabola
      let sub = 0;
      if (bi > 0 && bi < costs.length - 1 && isFinite(costs[bi - 1]) && isFinite(costs[bi + 1])) {
        const den = costs[bi - 1] - 2 * best + costs[bi + 1];
        if (den > 1e-6) sub = (0.5 * (costs[bi - 1] - costs[bi + 1])) / den;
      }
      out.push({ x: bx + block / 2, y: by + block / 2, d: bi - S + sub });
    }
  }
  return out;
}

export function quantile(arr, q) {
  if (!arr.length) return null;
  const s = [...arr].sort((x, y) => x - y);
  const i = Math.min(s.length - 1, Math.max(0, (s.length - 1) * q));
  const lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}

/**
 * Seam continuity of a full side-by-side buffer: the step across the middle column relative to
 * the typical step between neighbouring columns. ~1 means the picture runs straight across the
 * middle (one wide flat picture); a stereo pair usually breaks there (the right edge of one eye
 * meets the left edge of the other).
 */
export function seamRatio(img) {
  const w = img.width, h = img.height, g = gray(img);
  const colDiff = (x) => { let s = 0; for (let y = 0; y < h; y++) s += Math.abs(g[y * w + x] - g[y * w + x + 1]); return s / h; };
  const mid = Math.floor(w / 2) - 1;
  const seam = colDiff(mid);
  const samples = [];
  for (let k = 1; k < 16; k++) { const x = Math.floor((k / 16) * (w - 2)); if (Math.abs(x - mid) > 2) samples.push(colDiff(x)); }
  const typical = quantile(samples, 0.5) || 0;
  return { seam, typical, ratio: seam / Math.max(0.5, typical) };
}

/**
 * A woven canvas holding ONE full-width flat picture instead of two eyes: the halves are not two
 * views of one scene (no horizontal shift explains one by the other). seamRatio is reported
 * alongside (a picture that runs on across the middle is the typical signature).
 */
export function flatWideVerdict(buf) {
  const [L, R] = halves(buf);
  const cmp = compareEyes(L, R);
  const seam = seamRatio(buf);
  const statsL = contentStats(L), statsR = contentStats(R);
  // Two tests, both must hold for "two views of one scene": a single shift explains most of the
  // picture (global), and most textured blocks of EACH half find their match in the other within
  // ±12 % of the eye width (local; on a plain background the global test alone is fooled).
  const fwd = blockDisparity(L, R), back = blockDisparity(R, L);
  const textured = fwd.textured + back.textured;
  const matchRatio = textured ? (fwd.length + back.length) / textured : 1;
  const sameScene = cmp.identical || (cmp.madBest < Math.max(3, 0.35 * cmp.baseline) && (textured < 8 || matchRatio >= 0.35));
  // The seam is evidence, not a gate: on a mostly uniform background the "typical" column step is
  // ~0 and any content crossing the middle looks like a break. Two halves that no shift within
  // ±12 % of the eye width explains are not a stereo pair a display could fuse either way.
  const flatWide = !sameScene && !statsL.blank && !statsR.blank && cmp.stdL > 4 && cmp.stdR > 4;
  return { flatWide, sameScene, cmp, seam, matchRatio, textured };
}

/**
 * A raw side-by-side pair shown FLAT (in an <img>, a 2D canvas, a video, or a woven canvas the
 * browser is not weaving): the element's two halves are nearly the same picture.
 */
export function sbsPairVerdict(region) {
  if (region.width < 40 || region.height < 20) return { sbs: false, reason: 'too small' };
  const [L, R] = halves(region);
  const w = L.width, h = L.height;
  const a = gray(L), b = gray(R);
  const sL = std(a), sR = std(b);
  const S = Math.max(2, Math.round(w * 0.06));
  let madBest = Infinity, shift = 0;
  for (let s = -S; s <= S; s++) { const m = madShift(a, b, w, h, s); if (m < madBest) { madBest = m; shift = s; } }
  const baseline = madShift(a, b, w, h, Math.round(w / 3));
  const sbs = sL > 10 && sR > 10 && madBest < 12 && madBest < 0.4 * baseline;
  return { sbs, madBest, baseline, shift, stdL: sL, stdR: sR };
}

/** Shibata comfort zone at a viewing distance, as screen disparity in mm (same as the SDK's ./depth comfortZone). */
export function shibataZoneMm(viewerM = 0.65, eyeSepM = 0.063) {
  const Dv = 1 / viewerM;
  const frontD = Dv / 1.035 + 0.626 - Dv;
  const far = Dv / 1.129 - 0.442;
  const behindD = far > 0 ? Dv - far : Infinity;
  const mm = (d) => eyeSepM * viewerM * d * 1000;
  return { frontMm: mm(frontD), behindMm: mm(behindD) };
}

export function fromBase64Rgba(b64, w, h) {
  return { width: w, height: h, data: new Uint8Array(Buffer.from(b64, 'base64')) };
}

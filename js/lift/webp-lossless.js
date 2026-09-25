// lift/webp-lossless.js — a small, dependency-free LOSSLESS WebP (VP8L) encoder, for the SOG
// export (./sog-export.js).
//
// EXPERIMENTAL, internal. Why not `canvas.toBlob('image/webp', 1)`: a `.sog` stores DATA in its
// webp planes — packed quaternions, codebook indices, 16-bit positions split over two images,
// opacity in alpha — and every byte must round-trip exactly. A 2D canvas holds PREMULTIPLIED
// alpha, so any pixel with alpha < 255 (sh0's alpha IS the splat opacity; quats' alpha is
// 252..255) loses its RGB on the way in (alpha 0 zeroes it outright), whatever the encoder does
// afterwards; and whether quality 1 means lossless is a browser detail, not a contract. So the
// bitstream is written here, from the RGBA bytes, per the WebP Lossless Bitstream Specification
// (RFC 9649 §3–5).
//
// What it does (enough for dense data planes, not a libwebp replacement):
//   · transforms: SUBTRACT_GREEN, then PREDICTOR with one mode for the whole image (mode 1, the
//     LEFT pixel — the lift's splats are stored in image scan order, so consecutive texels are
//     neighbouring pixels of the photo and the left prediction is the useful one);
//   · no colour cache, no meta prefix codes, no LZ77 backward references: every pixel is four
//     Huffman-coded literals (green, red, blue, alpha), codes length-limited to 15 bits;
//   · the RIFF container with one VP8L chunk.
// Decoders (libwebp's dwebp, Chrome, the PlayCanvas SOG loader) read it as any other lossless
// webp; test/lift-sog-export.test.mjs has a spec decoder that checks the round trip bit-exactly.

const MAX_DIM = 16384;
const CODE_LENGTH_ORDER = [17, 18, 0, 1, 2, 3, 4, 5, 16, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
const GREEN_ALPHABET = 256 + 24; // literals + LZ77 length prefixes (no colour cache)
const DIST_ALPHABET = 40;

/** LSB-first bit writer (the VP8L bit order). */
class BitWriter {
  constructor(cap = 1 << 16) {
    this.buf = new Uint8Array(cap);
    this.pos = 0;
    this.acc = 0; // pending bits, LSB first
    this.n = 0; // how many
  }
  _grow(extra) {
    if (this.pos + extra <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.pos + extra) cap *= 2;
    const b = new Uint8Array(cap);
    b.set(this.buf.subarray(0, this.pos));
    this.buf = b;
  }
  /** Write the low `nbits` (≤ 24) of `value`. */
  put(value, nbits) {
    if (nbits === 0) return;
    this.acc |= (value & ((1 << nbits) - 1)) << this.n;
    this.n += nbits;
    if (this.n >= 8) {
      this._grow(4);
      while (this.n >= 8) {
        this.buf[this.pos++] = this.acc & 0xff;
        this.acc >>>= 8;
        this.n -= 8;
      }
    }
  }
  bytes() {
    if (this.n > 0) {
      this._grow(1);
      this.buf[this.pos++] = this.acc & 0xff;
      this.acc = 0;
      this.n = 0;
    }
    return this.buf.subarray(0, this.pos);
  }
}

/**
 * Huffman code lengths for `counts`, limited to `limit` bits (libwebp's strategy: when the tree
 * is too deep, raise every non-zero count to a floor and rebuild, doubling the floor).
 * @returns {Uint8Array} lengths (0 = unused symbol)
 */
export function huffmanLengths(counts, limit) {
  const n = counts.length;
  const lengths = new Uint8Array(n);
  const used = [];
  for (let i = 0; i < n; i++) if (counts[i] > 0) used.push(i);
  if (used.length === 0) return lengths;
  if (used.length === 1) {
    lengths[used[0]] = 1;
    return lengths;
  }
  for (let floor = 1; ; floor *= 2) {
    // Package the tree with a simple binary heap on (weight, id).
    const w = [];
    const parent = [];
    const heap = [];
    const push = (id) => {
      heap.push(id);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (w[heap[p]] < w[heap[i]] || (w[heap[p]] === w[heap[i]] && heap[p] < heap[i])) break;
        [heap[p], heap[i]] = [heap[i], heap[p]];
        i = p;
      }
    };
    const pop = () => {
      const top = heap[0];
      const last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          const lt = (a, b) => w[heap[a]] < w[heap[b]] || (w[heap[a]] === w[heap[b]] && heap[a] < heap[b]);
          if (l < heap.length && lt(l, m)) m = l;
          if (r < heap.length && lt(r, m)) m = r;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i], heap[m]];
          i = m;
        }
      }
      return top;
    };
    for (let k = 0; k < used.length; k++) {
      w.push(Math.max(counts[used[k]], floor));
      parent.push(-1);
      push(k);
    }
    while (heap.length > 1) {
      const a = pop();
      const b = pop();
      const id = w.length;
      w.push(w[a] + w[b]);
      parent.push(-1);
      parent[a] = id;
      parent[b] = id;
      push(id);
    }
    let max = 0;
    for (let k = 0; k < used.length; k++) {
      let d = 0;
      for (let x = k; parent[x] !== -1; x = parent[x]) d++;
      lengths[used[k]] = d;
      if (d > max) max = d;
    }
    if (max <= limit) return lengths;
  }
}

/** Canonical codes (DEFLATE / VP8L order), BIT-REVERSED for the LSB-first writer. */
export function canonicalCodes(lengths) {
  let maxLen = 0;
  for (const l of lengths) if (l > maxLen) maxLen = l;
  const blCount = new Uint32Array(maxLen + 1);
  for (const l of lengths) if (l) blCount[l]++;
  const next = new Uint32Array(maxLen + 2);
  let code = 0;
  for (let b = 1; b <= maxLen; b++) {
    code = (code + blCount[b - 1]) << 1;
    next[b] = code;
  }
  const codes = new Uint32Array(lengths.length);
  for (let s = 0; s < lengths.length; s++) {
    const l = lengths[s];
    if (!l) continue;
    let c = next[l]++;
    let r = 0;
    for (let i = 0; i < l; i++) {
      r = (r << 1) | (c & 1);
      c >>= 1;
    }
    codes[s] = r;
  }
  return codes;
}

/**
 * Write one prefix code for an alphabet with symbol `counts`; returns {codes, lengths} for the
 * data that follows (a symbol with length 0 costs zero bits — the single-symbol case).
 */
function writePrefixCode(bw, counts) {
  const used = [];
  for (let i = 0; i < counts.length && used.length < 3; i++) if (counts[i] > 0) used.push(i);
  if (used.length <= 2 && used.every((s) => s < 256)) {
    // Simple code: 1 or 2 symbols (8-bit symbols).
    const syms = used.length ? used : [0];
    bw.put(1, 1); // simple
    bw.put(syms.length - 1, 1);
    const first8 = syms[0] > 1 ? 1 : 0;
    bw.put(first8, 1);
    bw.put(syms[0], first8 ? 8 : 1);
    if (syms.length === 2) bw.put(syms[1], 8);
    const lengths = new Uint8Array(counts.length);
    const codes = new Uint32Array(counts.length);
    if (syms.length === 2) {
      lengths[syms[0]] = 1;
      lengths[syms[1]] = 1;
      codes[syms[1]] = 1;
    }
    return { lengths, codes };
  }
  const lengths = huffmanLengths(counts, 15);
  const codes = canonicalCodes(lengths);
  // Code lengths as tokens: literal 0..15, 17 = run of 3..10 zeros, 18 = run of 11..138 zeros.
  let last = lengths.length;
  while (last > 0 && lengths[last - 1] === 0) last--;
  const toks = []; // [symbol, extraBits, extraValue]
  for (let i = 0; i < last; ) {
    const l = lengths[i];
    if (l === 0) {
      let r = 1;
      while (i + r < last && lengths[i + r] === 0 && r < 138) r++;
      if (r >= 11) toks.push([18, 7, r - 11]);
      else if (r >= 3) toks.push([17, 3, r - 3]);
      else for (let k = 0; k < r; k++) toks.push([0, 0, 0]);
      i += r;
    } else {
      toks.push([l, 0, 0]);
      i++;
    }
  }
  // A trimmed tail is announced with max_symbol (a count of TOKENS, ≥ 2 by construction of the
  // field: max_symbol = 2 + read(length_nbits)); pad a one-token list with an explicit zero.
  const trimmed = last < lengths.length;
  if (trimmed && toks.length < 2) toks.push([0, 0, 0]);
  const clCounts = new Uint32Array(19);
  for (const t of toks) clCounts[t[0]]++;
  let clLengths = huffmanLengths(clCounts, 7);
  // A code-length code with a single used symbol would be zero-bit; give it a partner so every
  // decoder builds a proper two-leaf tree.
  let usedCl = 0;
  for (const c of clCounts) if (c > 0) usedCl++;
  if (usedCl === 1) {
    const only = clCounts.findIndex((c) => c > 0);
    clLengths = new Uint8Array(19);
    clLengths[only] = 1;
    clLengths[only === 0 ? 1 : 0] = 1;
  }
  const clCodes = canonicalCodes(clLengths);
  let nCl = 19;
  while (nCl > 4 && clLengths[CODE_LENGTH_ORDER[nCl - 1]] === 0) nCl--;
  bw.put(0, 1); // normal
  bw.put(nCl - 4, 4);
  for (let i = 0; i < nCl; i++) bw.put(clLengths[CODE_LENGTH_ORDER[i]], 3);
  if (trimmed) {
    const m = toks.length;
    let k = 0; // length_nbits = 2 + 2k must hold m − 2
    while (k < 7 && (m - 2) >= (1 << (2 + 2 * k))) k++;
    bw.put(1, 1);
    bw.put(k, 3);
    bw.put(m - 2, 2 + 2 * k);
  } else bw.put(0, 1);
  for (const [s, eb, ev] of toks) {
    bw.put(clCodes[s], clLengths[s]);
    if (eb) bw.put(ev, eb);
  }
  return { lengths, codes };
}

/** Five prefix codes (G, R, B, A, dist) from literal ARGB histograms, and the pixels after them. */
function writeEntropyCodedPixels(bw, argb) {
  const cg = new Uint32Array(GREEN_ALPHABET);
  const cr = new Uint32Array(256);
  const cb = new Uint32Array(256);
  const ca = new Uint32Array(256);
  for (let i = 0; i < argb.length; i++) {
    const p = argb[i];
    cg[(p >>> 8) & 0xff]++;
    cr[(p >>> 16) & 0xff]++;
    cb[p & 0xff]++;
    ca[p >>> 24]++;
  }
  const G = writePrefixCode(bw, cg);
  const R = writePrefixCode(bw, cr);
  const B = writePrefixCode(bw, cb);
  const A = writePrefixCode(bw, ca);
  writePrefixCode(bw, new Uint32Array(DIST_ALPHABET)); // unused: one zero-bit symbol
  for (let i = 0; i < argb.length; i++) {
    const p = argb[i];
    const g = (p >>> 8) & 0xff, r = (p >>> 16) & 0xff, b = p & 0xff, a = p >>> 24;
    bw.put(G.codes[g], G.lengths[g]);
    bw.put(R.codes[r], R.lengths[r]);
    bw.put(B.codes[b], B.lengths[b]);
    bw.put(A.codes[a], A.lengths[a]);
  }
}

/**
 * Encode RGBA8 pixels as a lossless WebP file.
 * @param {Uint8Array|Uint8ClampedArray} rgba  width·height·4 bytes, row-major, top row first.
 * @param {number} width
 * @param {number} height
 * @param {{predict?:boolean, subtractGreen?:boolean}} [opts]  both default true.
 * @returns {Uint8Array} the .webp file bytes
 */
export function encodeWebpLossless(rgba, width, height, opts = {}) {
  if (!(width >= 1 && height >= 1 && width <= MAX_DIM && height <= MAX_DIM)) {
    throw new Error(`webp-lossless: ${width}×${height} is outside 1..${MAX_DIM}`);
  }
  const n = width * height;
  if (rgba.length < n * 4) throw new Error('webp-lossless: not enough pixel data');
  const predict = opts.predict !== false;
  const subGreen = opts.subtractGreen !== false;
  // ARGB words, then the transforms in the order they are WRITTEN (the decoder undoes them in
  // reverse): subtract-green first, then the predictor on the green-subtracted image.
  const px = new Uint32Array(n);
  let alphaUsed = false;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    let r = rgba[j], g = rgba[j + 1], b = rgba[j + 2];
    const a = rgba[j + 3];
    if (a !== 255) alphaUsed = true;
    if (subGreen) {
      r = (r - g) & 0xff;
      b = (b - g) & 0xff;
    }
    px[i] = ((a << 24) | (r << 16) | (g << 8) | b) >>> 0;
  }
  const res = predict ? new Uint32Array(n) : px;
  if (predict) {
    const sub = (p, q) =>
      ((((p >>> 24) - (q >>> 24)) & 0xff) << 24 |
        ((((p >>> 16) & 0xff) - ((q >>> 16) & 0xff)) & 0xff) << 16 |
        ((((p >>> 8) & 0xff) - ((q >>> 8) & 0xff)) & 0xff) << 8 |
        (((p & 0xff) - (q & 0xff)) & 0xff)) >>> 0;
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        const i = row + x;
        let pred;
        if (x === 0 && y === 0) pred = 0xff000000;
        else if (y === 0) pred = px[i - 1];
        else if (x === 0) pred = px[i - width];
        else pred = px[i - 1]; // mode 1 (L) everywhere
        res[i] = sub(px[i], pred);
      }
    }
  }

  const bw = new BitWriter(Math.max(1024, n * 3));
  bw.put(0x2f, 8);
  bw.put(width - 1, 14);
  bw.put(height - 1, 14);
  bw.put(alphaUsed ? 1 : 0, 1);
  bw.put(0, 3);
  if (subGreen) {
    bw.put(1, 1);
    bw.put(2, 2); // SUBTRACT_GREEN
  }
  if (predict) {
    bw.put(1, 1);
    bw.put(0, 2); // PREDICTOR
    const bits = 9; // 512-px blocks: the smallest mode image
    bw.put(bits - 2, 3);
    const bw_ = Math.ceil(width / (1 << bits));
    const bh_ = Math.ceil(height / (1 << bits));
    const modes = new Uint32Array(bw_ * bh_).fill(0xff000100); // green = mode 1
    bw.put(0, 1); // no colour cache (sub-image)
    writeEntropyCodedPixels(bw, modes);
  }
  bw.put(0, 1); // no more transforms
  bw.put(0, 1); // no colour cache
  bw.put(0, 1); // no meta prefix codes
  writeEntropyCodedPixels(bw, res);
  const vp8l = bw.bytes();

  const pad = vp8l.length & 1;
  const out = new Uint8Array(20 + vp8l.length + pad);
  const dv = new DataView(out.buffer);
  out.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  dv.setUint32(4, 12 + vp8l.length + pad, true);
  out.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  out.set([0x56, 0x50, 0x38, 0x4c], 12); // VP8L
  dv.setUint32(16, vp8l.length, true);
  out.set(vp8l, 20);
  return out;
}

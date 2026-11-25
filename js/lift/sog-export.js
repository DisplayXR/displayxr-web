// lift/sog-export.js — "Download SOG": pack a lift's Gaussian scene as a PlayCanvas `.sog`
// (SOG v2, the bundled zip form), entirely in the browser, with the DisplayXR `camera` block v2
// in its meta.json so the gallery / the SDK's splat viewer / the native gauss demo open it on the
// photo's own camera rig at the lift's convergence.
//
// EXPERIMENTAL, not covered by the 1.x semver promise.
//
//   import { exportSog } from './lift/sog-export.js';
//   const blob = await exportSog({ ply, meta });            // ply: the lift's binary 3DGS PLY
//   // or: exportSog({ splats: { count, positions, fdc, opacity, scales, rotations }, meta })
//
// THE CONTAINER (what the PlayCanvas engine's SogBundleParser / GSplatSogData read, @ 2.22.3 —
// the engine is the reference, not a copy of splat-transform's writer):
//
//   <name>.sog = PKZip (stored entries) of
//     meta.json      { version: 2, count, means, scales, quats, sh0, camera }
//     means_l.webp   RGB = low  byte of each axis' 16-bit position
//     means_u.webp   RGB = high byte          "
//     quats.webp     RGB = the three smallest quaternion components, A = 252 + which is largest
//     scales.webp    RGB = indices into scales.codebook (log scales)
//     sh0.webp       RGB = indices into sh0.codebook (f_dc), A = sigmoid(opacity)·255
//
//   Positions: n = sign(v)·ln(|v| + 1) per axis, quantised to 16 bits over [mins, maxs] of n.
//   Quaternions: normalised, sign flipped so the largest |component| is positive, the other
//   three (each within ±1/√2) mapped to bytes as (c/√2 + 0.5)·255. Engine order (w, x, y, z)
//   reconstructs as: mode 0 → w largest, stored (x, y, z); 1 → x, (w, y, z); 2 → y, (w, x, z);
//   3 → z, (w, x, y).
//   Codebooks: 256 values each, a 1-D k-means over every axis/channel together (scales: the three
//   log scales; sh0: the three f_dc) — the SOG v2 scheme.
//   Texels: row-major, width = ⌈√count / 4⌉·4, height = ⌈count / width / 4⌉·4 (splat-transform's
//   sizing), splats in the lift's own order (image scan order: neighbouring texels are
//   neighbouring pixels, which is what the encoder's left-predictor exploits).
//
// The webp planes are LOSSLESS, written by ./webp-lossless.js from the RGBA bytes: a 2D canvas
// premultiplies alpha and would destroy sh0's RGB wherever opacity < 1 (see that file). No
// `canvas.toBlob`, no Worker, no blob: URL, no eval — this runs as-is in the DXR Browser's lift
// isolated world.

import { encodeWebpLossless } from './webp-lossless.js';

const SH_C0 = 0.28209479177387814;
const SQRT1_2 = Math.SQRT1_2;
const yieldTask = () => new Promise((r) => setTimeout(r, 0));

// ── PLY in ─────────────────────────────────────────────────────────────────────────────────

/**
 * Parse a binary little-endian 3DGS PLY (float properties) into SoA arrays.
 * @param {ArrayBuffer|Uint8Array} ply
 * @returns {{count:number, positions:Float32Array, fdc:Float32Array, opacity:Float32Array,
 *            scales:Float32Array, rotations:Float32Array}} rotations are (w, x, y, z)
 */
export function parseGaussianPly(ply) {
  const u8 = ply instanceof Uint8Array ? ply : new Uint8Array(ply);
  const head = new TextDecoder().decode(u8.subarray(0, Math.min(u8.length, 16384)));
  const endTok = 'end_header\n';
  const end = head.indexOf(endTok);
  if (!head.startsWith('ply') || end < 0) throw new Error('sog-export: not a PLY');
  if (!/format binary_little_endian 1\.0/.test(head)) throw new Error('sog-export: only binary_little_endian PLY is supported');
  const count = +(/element vertex (\d+)/.exec(head) || [])[1];
  if (!(count > 0)) throw new Error('sog-export: PLY has no vertices');
  const props = [];
  const sizeOf = { float: 4, float32: 4, double: 8, uchar: 1, uint8: 1, int: 4, uint: 4, short: 2, ushort: 2 };
  for (const m of head.slice(head.indexOf('element vertex'), end).matchAll(/property (\S+) (\S+)/g)) {
    props.push({ type: m[1], name: m[2], size: sizeOf[m[1]] ?? 4 });
  }
  let stride = 0;
  const off = {};
  for (const p of props) {
    off[p.name] = { at: stride, type: p.type };
    stride += p.size;
  }
  const need = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
  for (const k of need) {
    if (!off[k]) throw new Error(`sog-export: PLY lacks "${k}"`);
    if (off[k].type !== 'float' && off[k].type !== 'float32') throw new Error(`sog-export: PLY "${k}" is ${off[k].type}, expected float`);
  }
  const base = u8.byteOffset + end + endTok.length;
  if (u8.byteLength - (end + endTok.length) < count * stride) throw new Error('sog-export: PLY is truncated');
  const dv = new DataView(u8.buffer, base, count * stride);
  const out = {
    count,
    positions: new Float32Array(count * 3),
    fdc: new Float32Array(count * 3),
    opacity: new Float32Array(count),
    scales: new Float32Array(count * 3),
    rotations: new Float32Array(count * 4),
  };
  const o = (k) => off[k].at;
  const ox = o('x'), oy = o('y'), oz = o('z');
  const oc = [o('f_dc_0'), o('f_dc_1'), o('f_dc_2')];
  const oo = o('opacity');
  const os = [o('scale_0'), o('scale_1'), o('scale_2')];
  const or = [o('rot_0'), o('rot_1'), o('rot_2'), o('rot_3')];
  for (let i = 0, b = 0; i < count; i++, b += stride) {
    out.positions[i * 3] = dv.getFloat32(b + ox, true);
    out.positions[i * 3 + 1] = dv.getFloat32(b + oy, true);
    out.positions[i * 3 + 2] = dv.getFloat32(b + oz, true);
    for (let c = 0; c < 3; c++) {
      out.fdc[i * 3 + c] = dv.getFloat32(b + oc[c], true);
      out.scales[i * 3 + c] = dv.getFloat32(b + os[c], true);
    }
    out.opacity[i] = dv.getFloat32(b + oo, true);
    for (let c = 0; c < 4; c++) out.rotations[i * 4 + c] = dv.getFloat32(b + or[c], true);
  }
  return out;
}

// ── quantisers ─────────────────────────────────────────────────────────────────────────────

/** SOG's position map: n = sign(v)·ln(|v| + 1) (and its inverse). */
export const logMap = (v) => Math.sign(v) * Math.log(Math.abs(v) + 1);
export const logUnmap = (n) => Math.sign(n) * (Math.exp(Math.abs(n)) - 1);

/**
 * A 256-entry 1-D k-means codebook over `values` (finite floats), sorted ascending. Lloyd on a
 * 4096-bin histogram (weights + in-bin means), seeded at the mass quantiles — the codebook
 * `splat-transform` builds for SOG v2, computed in O(n + bins·iters).
 */
export function codebook256(values, iters = 24) {
  let lo = Infinity, hi = -Infinity;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const K = 256;
  if (!(hi > lo)) return new Float32Array(K).fill(Number.isFinite(lo) ? lo : 0);
  const B = 4096;
  const w = new Float64Array(B);
  const sum = new Float64Array(B);
  const scale = (B - 1) / (hi - lo);
  for (const v of values) {
    const b = Math.round((v - lo) * scale);
    w[b]++;
    sum[b] += v;
  }
  const bins = [];
  for (let b = 0; b < B; b++) if (w[b] > 0) bins.push(b);
  const mean = (b) => sum[b] / w[b];
  let c = new Float64Array(K);
  if (bins.length <= K) {
    // Few distinct values: the codebook is those values (padded with the last).
    for (let k = 0; k < K; k++) c[k] = mean(bins[Math.min(k, bins.length - 1)]);
    return Float32Array.from(c);
  }
  let total = 0;
  for (const b of bins) total += w[b];
  // Seed at the (k + 0.5)/K mass quantiles.
  for (let k = 0, acc = 0, j = 0; k < K; k++) {
    const target = ((k + 0.5) / K) * total;
    while (j < bins.length - 1 && acc + w[bins[j]] < target) acc += w[bins[j++]];
    c[k] = mean(bins[j]);
  }
  const cw = new Float64Array(K);
  const cs = new Float64Array(K);
  for (let it = 0; it < iters; it++) {
    c.sort();
    cw.fill(0);
    cs.fill(0);
    let k = 0;
    for (const b of bins) {
      const m = mean(b);
      while (k < K - 1 && Math.abs(c[k + 1] - m) <= Math.abs(c[k] - m)) k++;
      cw[k] += w[b];
      cs[k] += sum[b];
    }
    let moved = 0;
    for (let q = 0; q < K; q++) {
      if (cw[q] > 0) {
        const nv = cs[q] / cw[q];
        moved = Math.max(moved, Math.abs(nv - c[q]));
        c[q] = nv;
      }
    }
    if (moved < 1e-7 * (hi - lo)) break;
  }
  c.sort();
  return Float32Array.from(c);
}

/** Index of the codebook entry nearest `v` (codebook sorted ascending). */
export function nearestIndex(cb, v) {
  let a = 0, b = cb.length - 1;
  if (v <= cb[0]) return 0;
  if (v >= cb[b]) return b;
  while (b - a > 1) {
    const m = (a + b) >> 1;
    if (cb[m] <= v) a = m;
    else b = m;
  }
  return v - cb[a] <= cb[b] - v ? a : b;
}

/** Pack one quaternion (w, x, y, z) into 4 bytes (see the header). */
export function packQuat(w, x, y, z, out, o) {
  const len = Math.hypot(w, x, y, z) || 1;
  w /= len; x /= len; y /= len; z /= len;
  const aw = Math.abs(w), ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  let mode = 0; // w
  let m = aw;
  if (ax > m) { mode = 1; m = ax; }
  if (ay > m) { mode = 2; m = ay; }
  if (az > m) { mode = 3; m = az; }
  const big = mode === 0 ? w : mode === 1 ? x : mode === 2 ? y : z;
  if (big < 0) { w = -w; x = -x; y = -y; z = -z; }
  let a, b, c;
  if (mode === 0) { a = x; b = y; c = z; }
  else if (mode === 1) { a = w; b = y; c = z; }
  else if (mode === 2) { a = w; b = x; c = z; }
  else { a = w; b = x; c = y; }
  const q = (v) => Math.max(0, Math.min(255, Math.round((v * SQRT1_2 + 0.5) * 255)));
  out[o] = q(a);
  out[o + 1] = q(b);
  out[o + 2] = q(c);
  out[o + 3] = 252 + mode;
}

/** SOG texture size for `count` splats (splat-transform's sizing). */
export function sogTextureSize(count) {
  const width = Math.max(4, Math.ceil(Math.sqrt(count) / 4) * 4);
  const height = Math.max(4, Math.ceil(count / width / 4) * 4);
  return { width, height };
}

// ── the camera block ───────────────────────────────────────────────────────────────────────

/**
 * The DisplayXR `.sog` camera block v2 for a lift (js/inline3d-sog.js documents the shape;
 * `sogCameraFromMeta` is its validator):
 *   convention  'opencv' — the lift's PLY frame (+x right, +y down, +z forward)
 *   rig         'camera' — a photograph lifted into 3D: conserve the capture camera
 *   rest        the capture camera at the origin, identity rotation
 *   intrinsics  the focal the gaussians were unprojected through, principal point at the centre
 *   focus       point = [0, 0, pivotZ] — THE point: orbit centre = pivot plane = convergence
 *               (pivotZ = min(convergence, subject), the gallery's rule, computed by lift-gen);
 *               subject_m, near_m/far_m from the lift's depth range; source 'convergence'
 *   dxr         ipd_factor / parallax_factor 1 (the explore renderer's "IPD factor 1": a metric
 *               scene seen by eyes a real IPD apart)
 * No `stereo` key: a single-image lift has one camera. `overrides` is merged on top (a caller
 * that re-focused the scene passes `{ focus: { point, source: 'manual' } }`).
 */
export function liftCameraBlock(meta, overrides = null) {
  const f = +meta?.focalPx;
  const W = +meta?.w, H = +meta?.h;
  if (!(f > 0) || !(W > 0) || !(H > 0)) throw new Error('sog-export: meta needs focalPx, w, h');
  const conv = meta.convention || meta.axes || 'opencv';
  if (conv !== 'opencv') throw new Error(`sog-export: the lift PLY is "${conv}"; the camera block is OpenCV-only`);
  const intr = meta.intrinsics && meta.intrinsics.fx > 0 ? meta.intrinsics : { fx: f, fy: f, cx: W / 2, cy: H / 2, width: W, height: H };
  const pivot = Number.isFinite(+meta.pivotZ) && +meta.pivotZ > 0 ? +meta.pivotZ : 2;
  const num = (v) => (Number.isFinite(+v) ? +v : undefined);
  const cam = {
    convention: 'opencv',
    rig: 'camera',
    rest: { position: [0, 0, 0], rotation: [0, 0, 0, 1] },
    intrinsics: { fx: +intr.fx, fy: +intr.fy, cx: +intr.cx, cy: +intr.cy, width: +intr.width, height: +intr.height },
    focus: {
      point: [0, 0, pivot],
      subject_m: num(meta.subjectZ),
      near_m: num(meta.depthRange?.near),
      far_m: num(meta.depthRange?.far),
      source: 'convergence',
    },
    dxr: { ipd_factor: 1, parallax_factor: 1 },
  };
  for (const k of Object.keys(cam.focus)) if (cam.focus[k] === undefined) delete cam.focus[k];
  if (overrides && typeof overrides === 'object') {
    for (const [k, v] of Object.entries(overrides)) {
      cam[k] = v && typeof v === 'object' && !Array.isArray(v) && cam[k] && typeof cam[k] === 'object' ? { ...cam[k], ...v } : v;
    }
  }
  return cam;
}

// ── zip (stored) ───────────────────────────────────────────────────────────────────────────

let CRC_TABLE = null;
export function crc32(u8) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A PKZip of STORED entries (method 0) — what every SOG reader accepts. */
export function zipStored(entries) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1; // fixed: reproducible bytes
  for (const e of entries) {
    const name = enc.encode(e.name);
    const data = e.data;
    const crc = crc32(data);
    const lh = new Uint8Array(30 + name.length);
    const l = new DataView(lh.buffer);
    l.setUint32(0, 0x04034b50, true);
    l.setUint16(4, 20, true);
    l.setUint16(6, 0x0800, true); // UTF-8 names
    l.setUint16(8, 0, true);
    l.setUint16(10, 0, true);
    l.setUint16(12, DOS_DATE, true);
    l.setUint32(14, crc, true);
    l.setUint32(18, data.length, true);
    l.setUint32(22, data.length, true);
    l.setUint16(26, name.length, true);
    l.setUint16(28, 0, true);
    lh.set(name, 30);
    parts.push(lh, data);
    const ch = new Uint8Array(46 + name.length);
    const c = new DataView(ch.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true);
    c.setUint16(10, 0, true);
    c.setUint16(12, 0, true);
    c.setUint16(14, DOS_DATE, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, data.length, true);
    c.setUint32(24, data.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    ch.set(name, 46);
    central.push(ch);
    offset += lh.length + data.length;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const eocd = new Uint8Array(22);
  const d = new DataView(eocd.buffer);
  d.setUint32(0, 0x06054b50, true);
  d.setUint16(8, entries.length, true);
  d.setUint16(10, entries.length, true);
  d.setUint32(12, cdSize, true);
  d.setUint32(16, offset, true);
  const total = offset + cdSize + 22;
  const out = new Uint8Array(total);
  let p = 0;
  for (const x of [...parts, ...central, eocd]) {
    out.set(x, p);
    p += x.length;
  }
  return out;
}

// ── the export ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the `.sog` bytes.
 * @param {object} o
 * @param {ArrayBuffer|Uint8Array} [o.ply]  the lift's binary 3DGS PLY, or
 * @param {object} [o.splats]  {count, positions, fdc, opacity(logit), scales(log), rotations(w,x,y,z)}
 * @param {object} o.meta  the lift meta (focalPx, pivotZ, w, h, subjectZ, depthRange, intrinsics…)
 * @param {object|false} [o.camera]  overrides merged onto the camera block; `false` omits it.
 * @param {(p:number)=>void} [o.onProgress]
 * @param {AbortSignal} [o.signal]  checked at every yield: an abort rejects with an AbortError
 *        (lift.js aborts a download when explore is left — play must not wait on the encode).
 * @returns {Promise<{bytes:Uint8Array, meta:object, width:number, height:number}>}
 */
export async function buildSog(o) {
  const s = o.splats || parseGaussianPly(o.ply);
  const n = s.count;
  const prog = (p) => o.onProgress?.(p);
  const checkAbort = () => {
    if (o.signal && o.signal.aborted) {
      throw typeof DOMException === 'function' ? new DOMException('sog export aborted', 'AbortError') : new Error('aborted');
    }
  };
  checkAbort();
  const { width, height } = sogTextureSize(n);
  const texels = width * height;

  // means
  const mins = [Infinity, Infinity, Infinity];
  const maxs = [-Infinity, -Infinity, -Infinity];
  const nlog = new Float32Array(n * 3);
  for (let i = 0; i < n * 3; i++) {
    const v = logMap(s.positions[i]);
    nlog[i] = v;
    const a = i % 3;
    if (v < mins[a]) mins[a] = v;
    if (v > maxs[a]) maxs[a] = v;
  }
  const meansL = new Uint8Array(texels * 4);
  const meansU = new Uint8Array(texels * 4);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < 3; a++) {
      const span = maxs[a] - mins[a];
      const q = span > 0 ? Math.round(((nlog[i * 3 + a] - mins[a]) / span) * 65535) : 0;
      meansL[i * 4 + a] = q & 0xff;
      meansU[i * 4 + a] = q >>> 8;
    }
    meansL[i * 4 + 3] = 255;
    meansU[i * 4 + 3] = 255;
  }
  prog(0.1);
  await yieldTask();
  checkAbort();

  // quats
  const quats = new Uint8Array(texels * 4);
  const r = s.rotations;
  for (let i = 0; i < n; i++) packQuat(r[i * 4], r[i * 4 + 1], r[i * 4 + 2], r[i * 4 + 3], quats, i * 4);

  // scales + sh0 (codebooks)
  const scalesCb = codebook256(s.scales);
  const sh0Cb = codebook256(s.fdc);
  prog(0.25);
  await yieldTask();
  checkAbort();
  const scales = new Uint8Array(texels * 4);
  const sh0 = new Uint8Array(texels * 4);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < 3; a++) {
      scales[i * 4 + a] = nearestIndex(scalesCb, s.scales[i * 3 + a]);
      sh0[i * 4 + a] = nearestIndex(sh0Cb, s.fdc[i * 3 + a]);
    }
    scales[i * 4 + 3] = 255;
    const alpha = 1 / (1 + Math.exp(-s.opacity[i]));
    sh0[i * 4 + 3] = Math.max(0, Math.min(255, Math.round(alpha * 255)));
  }
  prog(0.35);
  await yieldTask();
  checkAbort();

  const planes = [
    ['means_l.webp', meansL],
    ['means_u.webp', meansU],
    ['quats.webp', quats],
    ['scales.webp', scales],
    ['sh0.webp', sh0],
  ];
  const files = [];
  for (let k = 0; k < planes.length; k++) {
    files.push({ name: planes[k][0], data: encodeWebpLossless(planes[k][1], width, height) });
    prog(0.35 + (0.6 * (k + 1)) / planes.length);
    await yieldTask();
    checkAbort();
  }

  const meta = {
    version: 2,
    count: n,
    ...(o.camera === false ? {} : { camera: liftCameraBlock(o.meta, o.camera || null) }),
    means: { mins, maxs, files: ['means_l.webp', 'means_u.webp'] },
    scales: { codebook: Array.from(scalesCb), files: ['scales.webp'] },
    quats: { files: ['quats.webp'] },
    sh0: { codebook: Array.from(sh0Cb), files: ['sh0.webp'] },
  };
  // `camera` sits right after `count` (the block's documented position); JSON key order is the
  // insertion order above.
  const bytes = zipStored([{ name: 'meta.json', data: new TextEncoder().encode(JSON.stringify(meta)) }, ...files]);
  prog(1);
  return { bytes, meta, width, height };
}

/**
 * `exportSog({ply|splats, meta, camera}) → Blob` (`application/octet-stream`; name it `.sog`).
 * See buildSog for the options.
 */
export async function exportSog(o) {
  const { bytes } = await buildSog(o);
  return new Blob([bytes], { type: 'application/octet-stream' });
}

/** Unused by the export; the reader-side constant the engine applies to sh0 (tests). */
export const SOG_SH_C0 = SH_C0;

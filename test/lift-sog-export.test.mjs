// Tests for js/lift/sog-export.js + js/lift/webp-lossless.js — the lift's "Download SOG".
//
// The webp planes are decoded by a SPEC decoder written here (WebP Lossless Bitstream, RFC 9649 —
// independent of the encoder: canonical prefix codes read bit by bit, the transforms undone per the
// spec), and the splats are reconstructed with the PlayCanvas engine's own SOG v2 formulas
// (GSplatSogIterator @ 2.22.3). libwebp's `dwebp` was used out of band on real exports as well
// (docs/lift.md § Download SOG).

import test from 'node:test';
import assert from 'node:assert/strict';

import { encodeWebpLossless, huffmanLengths, canonicalCodes } from '../js/lift/webp-lossless.js';
import {
  buildSog,
  exportSog,
  parseGaussianPly,
  codebook256,
  nearestIndex,
  packQuat,
  sogTextureSize,
  liftCameraBlock,
  logMap,
  logUnmap,
  crc32,
} from '../js/lift/sog-export.js';
import { readZipEntry, readSogMeta, sogCameraFromMeta, readSogCamera } from '../js/inline3d-sog.js';

// ── a spec VP8L decoder (only what a decoder needs; LZ77 / colour cache refused loudly) ─────

class BitReader {
  constructor(u8, pos = 0) {
    this.u8 = u8;
    this.bit = pos * 8;
  }
  read(n) {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const b = (this.u8[this.bit >> 3] >> (this.bit & 7)) & 1;
      v |= b << i;
      this.bit++;
    }
    return v >>> 0;
  }
}

const ORDER = [17, 18, 0, 1, 2, 3, 4, 5, 16, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

/** Canonical code from lengths → a decoder reading MSB-first code bits one at a time. */
function makeDecoder(lengths) {
  const used = [];
  for (let s = 0; s < lengths.length; s++) if (lengths[s]) used.push(s);
  if (used.length === 0) return () => 0;
  if (used.length === 1) return () => used[0]; // zero-bit code
  let maxLen = 0;
  for (const l of lengths) maxLen = Math.max(maxLen, l);
  const blCount = new Array(maxLen + 1).fill(0);
  for (const l of lengths) if (l) blCount[l]++;
  const next = new Array(maxLen + 2).fill(0);
  let code = 0;
  for (let b = 1; b <= maxLen; b++) {
    code = (code + blCount[b - 1]) << 1;
    next[b] = code;
  }
  const map = new Map();
  for (let s = 0; s < lengths.length; s++) if (lengths[s]) map.set(`${lengths[s]}:${next[lengths[s]]++}`, s);
  return (br) => {
    let c = 0;
    for (let len = 1; len <= maxLen; len++) {
      c = (c << 1) | br.read(1);
      const s = map.get(`${len}:${c}`);
      if (s !== undefined) return s;
    }
    throw new Error('bad prefix code');
  };
}

function readPrefixCode(br, alphabet) {
  const lengths = new Uint8Array(alphabet);
  if (br.read(1)) {
    const num = br.read(1) + 1;
    const first8 = br.read(1);
    const s0 = br.read(first8 ? 8 : 1);
    if (num === 1) {
      lengths[s0] = 1; // single symbol → zero-bit (handled by makeDecoder's 1-symbol case)
      return makeDecoder(lengths);
    }
    const s1 = br.read(8);
    lengths[s0] = 1;
    lengths[s1] = 1;
    return makeDecoder(lengths);
  }
  const nCl = 4 + br.read(4);
  const cl = new Uint8Array(19);
  for (let i = 0; i < nCl; i++) cl[ORDER[i]] = br.read(3);
  const clDec = makeDecoder(cl);
  let maxSymbol = alphabet;
  if (br.read(1)) {
    const nbits = 2 + 2 * br.read(3);
    maxSymbol = 2 + br.read(nbits);
    assert.ok(maxSymbol <= alphabet, 'max_symbol > alphabet');
  }
  let prev = 8;
  for (let s = 0; s < alphabet; ) {
    if (maxSymbol-- === 0) break;
    const c = clDec(br);
    if (c < 16) {
      lengths[s++] = c;
      if (c) prev = c;
    } else {
      const [extra, base, val] = c === 16 ? [2, 3, prev] : c === 17 ? [3, 3, 0] : [7, 11, 0];
      const rep = base + br.read(extra);
      for (let k = 0; k < rep; k++) lengths[s++] = val;
    }
  }
  return makeDecoder(lengths);
}

function readCodedImage(br, w, h, level0) {
  assert.equal(br.read(1), 0, 'colour cache not expected');
  if (level0) assert.equal(br.read(1), 0, 'meta prefix codes not expected');
  const G = readPrefixCode(br, 280), R = readPrefixCode(br, 256), B = readPrefixCode(br, 256), A = readPrefixCode(br, 256);
  readPrefixCode(br, 40);
  const px = new Uint32Array(w * h);
  for (let i = 0; i < px.length; i++) {
    const g = G(br);
    assert.ok(g < 256, 'LZ77 not expected');
    const r = R(br), b = B(br), a = A(br);
    px[i] = ((a << 24) | (r << 16) | (g << 8) | b) >>> 0;
  }
  return px;
}

function decodeWebp(u8) {
  const s = (o, n) => String.fromCharCode(...u8.subarray(o, o + n));
  assert.equal(s(0, 4), 'RIFF');
  assert.equal(s(8, 4), 'WEBP');
  assert.equal(s(12, 4), 'VP8L');
  const br = new BitReader(u8, 20);
  assert.equal(br.read(8), 0x2f);
  const w = br.read(14) + 1, h = br.read(14) + 1;
  br.read(1);
  assert.equal(br.read(3), 0);
  const transforms = [];
  while (br.read(1)) {
    const type = br.read(2);
    if (type === 0) {
      const bits = br.read(3) + 2;
      const bw = Math.ceil(w / (1 << bits)), bh = Math.ceil(h / (1 << bits));
      transforms.push({ type, bits, bw, modes: readCodedImage(br, bw, bh, false) });
    } else if (type === 2) transforms.push({ type });
    else throw new Error('unexpected transform ' + type);
  }
  const px = readCodedImage(br, w, h, true);
  const add = (p, q) =>
    ((((p >>> 24) + (q >>> 24)) & 0xff) << 24 | ((((p >>> 16) & 0xff) + ((q >>> 16) & 0xff)) & 0xff) << 16 |
      ((((p >>> 8) & 0xff) + ((q >>> 8) & 0xff)) & 0xff) << 8 | (((p & 0xff) + (q & 0xff)) & 0xff)) >>> 0;
  for (let t = transforms.length - 1; t >= 0; t--) {
    const T = transforms[t];
    if (T.type === 0) {
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          let pred;
          if (!x && !y) pred = 0xff000000;
          else if (!y) pred = px[i - 1];
          else if (!x) pred = px[i - w];
          else {
            const mode = (T.modes[(y >> T.bits) * T.bw + (x >> T.bits)] >>> 8) & 0xf;
            if (mode === 1) pred = px[i - 1];
            else if (mode === 2) pred = px[i - w];
            else throw new Error('predictor mode ' + mode + ' not implemented in the test decoder');
          }
          px[i] = add(px[i], pred);
        }
    } else {
      for (let i = 0; i < px.length; i++) {
        const p = px[i], g = (p >>> 8) & 0xff;
        px[i] = ((p & 0xff00ff00) | ((((p >>> 16) & 0xff) + g) & 0xff) << 16 | (((p & 0xff) + g) & 0xff)) >>> 0;
      }
    }
  }
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < px.length; i++) {
    const p = px[i];
    rgba[i * 4] = (p >>> 16) & 0xff;
    rgba[i * 4 + 1] = (p >>> 8) & 0xff;
    rgba[i * 4 + 2] = p & 0xff;
    rgba[i * 4 + 3] = p >>> 24;
  }
  return { w, h, rgba };
}

// ── fixtures ─────────────────────────────────────────────────────────────────────────────

let seed = 12345;
const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);

/** A binary 3DGS PLY in the lift's exact field layout. */
function makePly(n) {
  const props = ['x', 'y', 'z', 'nx', 'ny', 'nz', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
  const head = `ply\nformat binary_little_endian 1.0\nelement vertex ${n}\n${props.map((p) => `property float ${p}`).join('\n')}\nend_header\n`;
  const hb = new TextEncoder().encode(head);
  const f = new Float32Array(n * props.length);
  const src = [];
  for (let i = 0; i < n; i++) {
    // image-aligned-ish: a camera frustum out to 60 m, some behind-ish noise near the camera
    const z = 0.3 + rnd() ** 2 * 60;
    const x = (rnd() - 0.5) * z, y = (rnd() - 0.5) * z * 0.75;
    let q = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5, rnd() - 0.5];
    const ql = Math.hypot(...q);
    q = q.map((v) => v / ql);
    const rec = [x, y, z, 0, 0, 0, (rnd() - 0.5) * 3, (rnd() - 0.5) * 3, (rnd() - 0.5) * 3, (rnd() - 0.5) * 12, -9 + rnd() * 7, -9 + rnd() * 7, -9 + rnd() * 7, ...q];
    f.set(rec, i * props.length);
    src.push(rec);
  }
  const out = new Uint8Array(hb.length + f.byteLength);
  out.set(hb, 0);
  out.set(new Uint8Array(f.buffer), hb.length);
  return { ply: out, src };
}

const META = {
  focalPx: 900, pivotZ: 2.1, subjectZ: 2.4, convergenceZ: 2.1, w: 1200, h: 900, layers: 2,
  intrinsics: { fx: 900, fy: 900, cx: 600, cy: 450, width: 1200, height: 900 },
  convention: 'opencv', axes: 'opencv', depthRange: { near: 0.4, far: 55 },
};

// ── webp ─────────────────────────────────────────────────────────────────────────────────

test('webp-lossless: bit-exact round trip incl. alpha 0 and odd sizes', () => {
  for (const [w, h] of [[1, 1], [3, 7], [64, 64], [257, 33]]) {
    const px = new Uint8Array(w * h * 4);
    for (let i = 0; i < px.length; i++) px[i] = (rnd() * 256) | 0;
    for (let i = 3; i < px.length; i += 8) px[i] = 0; // alpha 0: a premultiplying path would zero RGB
    const dec = decodeWebp(encodeWebpLossless(px, w, h));
    assert.equal(dec.w, w);
    assert.equal(dec.h, h);
    assert.deepEqual(dec.rgba, px);
  }
});

test('webp-lossless: constant / two-valued planes (simple codes) round-trip; transforms can be off', () => {
  const w = 40, h = 9;
  const a = new Uint8Array(w * h * 4).fill(255);
  const b = new Uint8Array(w * h * 4);
  for (let i = 0; i < b.length; i += 4) b.set([i % 8 ? 3 : 200, 7, 9, 252 + ((i >> 2) & 3)], i);
  for (const px of [a, b]) {
    for (const opts of [{}, { predict: false }, { subtractGreen: false }, { predict: false, subtractGreen: false }]) {
      assert.deepEqual(decodeWebp(encodeWebpLossless(px, w, h, opts)).rgba, px);
    }
  }
});

test('webp-lossless: huffman lengths respect the limit and form a complete code', () => {
  const counts = new Uint32Array(280);
  for (let i = 0; i < 280; i++) counts[i] = Math.floor(2 ** (i / 10)); // very skewed
  const L = huffmanLengths(counts, 15);
  let kraft = 0;
  for (const l of L) if (l) kraft += 2 ** -l;
  assert.ok(Math.max(...L) <= 15);
  assert.ok(Math.abs(kraft - 1) < 1e-9, `kraft ${kraft}`);
  const codes = canonicalCodes(L);
  assert.equal(codes.length, 280);
});

// ── the SOG ──────────────────────────────────────────────────────────────────────────────

test('sog: container + meta + camera block v2 (validated by the SDK reader)', async () => {
  const { ply } = makePly(1000);
  const { bytes, meta } = await buildSog({ ply, meta: META });
  assert.equal(bytes[0], 0x50);
  const m = await readSogMeta(bytes);
  assert.equal(m.version, 2);
  assert.equal(m.count, 1000);
  assert.deepEqual(Object.keys(m).slice(0, 3), ['version', 'count', 'camera']);
  assert.deepEqual(m.means.files, ['means_l.webp', 'means_u.webp']);
  assert.equal(m.scales.codebook.length, 256);
  assert.equal(m.sh0.codebook.length, 256);
  assert.deepEqual(meta, m);
  const cam = sogCameraFromMeta(m);
  assert.equal(cam.rig, 'camera');
  assert.deepEqual(cam.focus.point, [0, 0, 2.1]);
  assert.equal(cam.focus.subject_m, 2.4);
  assert.equal(cam.focus.near_m, 0.4);
  assert.equal(cam.focus.far_m, 55);
  assert.equal(cam.focus.source, 'convergence');
  assert.deepEqual(cam.intrinsics, META.intrinsics);
  assert.equal(cam.dxr.ipdFactor, 1);
  assert.equal(cam.stereo, null);
  assert.deepEqual(await readSogCamera(bytes), cam);
  const blob = await exportSog({ ply, meta: META });
  assert.equal(blob.size, bytes.length);
});

test('sog: round trip — count, positions within quantisation, quats, scales, colour, opacity', async () => {
  const N = 3000;
  const { ply, src } = makePly(N);
  const { bytes } = await buildSog({ ply, meta: META });
  const m = await readSogMeta(bytes);
  const { width, height } = sogTextureSize(N);
  const plane = async (name) => {
    const d = decodeWebp(await readZipEntry(bytes, name));
    assert.equal(d.w, width);
    assert.equal(d.h, height);
    return d.rgba;
  };
  const [ml, mu, qt, sc, c0] = [await plane('means_l.webp'), await plane('means_u.webp'), await plane('quats.webp'), await plane('scales.webp'), await plane('sh0.webp')];
  const lerp = (a, b, t) => a * (1 - t) + b * t;
  const SH_C0 = 0.28209479177387814;
  let maxPosRel = 0, maxQ = 0, maxOp = 0;
  for (let i = 0; i < N; i++) {
    const s = src[i];
    // positions (GSplatSogIterator): n = lerp(min, max, (u<<8 | l)/65535), v = sign·(e^|n| − 1)
    for (let a = 0; a < 3; a++) {
      const n = lerp(m.means.mins[a], m.means.maxs[a], ((mu[i * 4 + a] << 8) + ml[i * 4 + a]) / 65535);
      const v = logUnmap(n);
      // one 16-bit step in the log domain, at this value: (span/65535)·(|v|+1), half of it max
      const step = ((m.means.maxs[a] - m.means.mins[a]) / 65535) * (Math.abs(s[a]) + 1);
      const err = Math.abs(v - s[a]);
      assert.ok(err <= 0.51 * step * 1.001 + 1e-6, `pos ${i}/${a}: ${v} vs ${s[a]} (step ${step})`);
      maxPosRel = Math.max(maxPosRel, err / (Math.abs(s[a]) + 1));
    }
    // quaternion (engine: mode = A − 252, (a,b,c) = (byte/255 − 0.5)·√2)
    const [A, B, C] = [0, 1, 2].map((k) => (qt[i * 4 + k] / 255 - 0.5) * Math.SQRT2);
    const d = Math.sqrt(Math.max(0, 1 - (A * A + B * B + C * C)));
    const mode = qt[i * 4 + 3] - 252;
    const [x, y, z, w] = mode === 0 ? [A, B, C, d] : mode === 1 ? [d, B, C, A] : mode === 2 ? [B, d, C, A] : [B, C, d, A];
    const [qw, qx, qy, qz] = [s[13], s[14], s[15], s[16]];
    const dot = Math.abs(w * qw + x * qx + y * qy + z * qz);
    maxQ = Math.max(maxQ, 1 - dot);
    assert.ok(dot > 0.9995, `quat ${i}: |dot| ${dot}`);
    // scales + colour: the codebook value is the nearest entry
    for (let a = 0; a < 3; a++) {
      assert.equal(m.scales.codebook[sc[i * 4 + a]], m.scales.codebook[nearestIndex(Float32Array.from(m.scales.codebook), s[10 + a])]);
      assert.equal(m.sh0.codebook[c0[i * 4 + a]], m.sh0.codebook[nearestIndex(Float32Array.from(m.sh0.codebook), s[6 + a])]);
    }
    const alpha = c0[i * 4 + 3] / 255;
    const want = 1 / (1 + Math.exp(-s[9]));
    maxOp = Math.max(maxOp, Math.abs(alpha - want));
    assert.ok(Math.abs(alpha - want) <= 0.5 / 255 + 1e-9);
    // the engine's own colour: 0.5 + f_dc·SH_C0 — within the codebook spacing
    const col = 0.5 + m.sh0.codebook[c0[i * 4]] * SH_C0;
    assert.ok(Math.abs(col - (0.5 + s[6] * SH_C0)) < 0.02, `colour ${i}`);
  }
  assert.ok(maxPosRel < 1e-4, `max relative position error ${maxPosRel}`);
  assert.ok(maxQ < 5e-4);
  assert.ok(maxOp <= 0.5 / 255 + 1e-9);
});

test('sog: packQuat — every mode, sign canonicalised', () => {
  const out = new Uint8Array(4);
  for (const q of [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1], [-0.9, 0.1, 0.3, 0.2], [0.1, -0.2, -0.95, 0.1]]) {
    packQuat(q[0], q[1], q[2], q[3], out, 0);
    const mode = out[3] - 252;
    const abs = q.map(Math.abs);
    const want = [0, 1, 2, 3][abs.indexOf(Math.max(...abs))];
    assert.equal(mode, want);
  }
});

test('sog: codebook256 — sorted, 256 entries, few-valued input kept exact', () => {
  const vals = new Float32Array(10000);
  for (let i = 0; i < vals.length; i++) vals[i] = Math.log(0.001 + rnd() ** 3);
  const cb = codebook256(vals);
  assert.equal(cb.length, 256);
  for (let i = 1; i < 256; i++) assert.ok(cb[i] >= cb[i - 1]);
  let worst = 0;
  for (const v of vals) worst = Math.max(worst, Math.abs(cb[nearestIndex(cb, v)] - v));
  const span = Math.max(...vals) - Math.min(...vals);
  assert.ok(worst < span / 64, `worst ${worst} of span ${span}`);
  const few = Float32Array.from([1, 2, 2, 3, 1, 3]);
  const cf = codebook256(few);
  assert.deepEqual([...new Set(cf)], [1, 2, 3]);
});

test('sog: helpers — log map, texture size, crc32, PLY parse, camera overrides', () => {
  for (const v of [-50, -1, 0, 0.3, 7, 60]) assert.ok(Math.abs(logUnmap(logMap(v)) - v) < 1e-9);
  assert.deepEqual(sogTextureSize(1000), { width: 32, height: 32 });
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  const { ply, src } = makePly(5);
  const p = parseGaussianPly(ply);
  assert.equal(p.count, 5);
  assert.ok(Math.abs(p.positions[3 * 4 + 2] - src[4][2]) < 1e-6);
  const cam = liftCameraBlock(META, { focus: { point: [0, 0, 3], source: 'manual' } });
  assert.deepEqual(cam.focus.point, [0, 0, 3]);
  assert.equal(cam.focus.source, 'manual');
  assert.equal(cam.focus.subject_m, 2.4); // merged, not replaced
  assert.throws(() => liftCameraBlock({ ...META, convention: 'opengl', axes: undefined }), /OpenCV-only/);
});

test('sog: an aborted signal stops the export at its next yield (AbortError)', async () => {
  const { ply } = makePly(1000);
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(buildSog({ ply, meta: META, signal: pre.signal }), { name: 'AbortError' });
  const mid = new AbortController();
  let seen = 0;
  await assert.rejects(
    buildSog({ ply, meta: META, signal: mid.signal, onProgress: (p) => { seen = p; if (p >= 0.1) mid.abort(); } }),
    { name: 'AbortError' },
  );
  assert.ok(seen < 1, 'never finished');
});

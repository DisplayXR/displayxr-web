// Tests for the `.sog` metadata reader and the `camera` block it exists to find
// (`js/inline3d-sog.js`).
//
// What is worth pinning here is not the JSON round-trip but the two things that decide whether a
// page renders a photograph on the camera it was taken with:
//
//   1. the ZIP reader finds ONE named entry in a real-shaped archive — stored AND deflated, with
//      other entries before and after it, and with a local header whose sizes are zeroed the way
//      a streaming writer leaves them (the central directory is the authority);
//   2. the `camera` block is taken ONLY when it is fully usable. A partly-understood block would
//      put a photo scene on a plausible-looking rig that is not the capture, and that is
//      indistinguishable on screen from a framing bug — so an unknown `convention`, missing
//      intrinsics or a non-finite focal must all come back null and leave the asset on the
//      display rig, which is what every existing page already gets.
//
// Zips are BUILT here rather than checked in, so the fixtures stay readable and a failure points
// at the reader instead of at a binary blob. The real 9.3 MB `.sog` this was developed against
// cannot live in the repo; the shapes below are its `meta.json` with the planes stubbed out.

import test from 'node:test';
import assert from 'node:assert/strict';

import { readZipEntry, readSogMeta, sogCameraFromMeta, readSogCamera } from '../js/inline3d-sog.js';

// ── a minimal PKZip writer, for fixtures ────────────────────────────────────────────────

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflateRaw(bytes) {
  const cs = new CompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Build a zip from `[{ name, data, deflate, zeroLocalSizes }]`.
 *
 * `zeroLocalSizes` writes 0 into the LOCAL header's crc/size fields (bit 3 of the general-purpose
 * flags) — what a writer that streams entries does, and the reason the reader must take its sizes
 * from the central directory.
 */
async function makeZip(entries) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const raw = typeof e.data === 'string' ? enc.encode(e.data) : e.data;
    const stored = e.deflate ? await deflateRaw(raw) : raw;
    const name = enc.encode(e.name);
    const crc = crc32(raw);
    const loc = new Uint8Array(30 + name.length);
    const ldv = new DataView(loc.buffer);
    ldv.setUint32(0, 0x04034b50, true);
    ldv.setUint16(4, 20, true);
    ldv.setUint16(6, e.zeroLocalSizes ? 0x08 : 0, true);
    ldv.setUint16(8, e.deflate ? 8 : 0, true);
    ldv.setUint32(14, e.zeroLocalSizes ? 0 : crc, true);
    ldv.setUint32(18, e.zeroLocalSizes ? 0 : stored.length, true);
    ldv.setUint32(22, e.zeroLocalSizes ? 0 : raw.length, true);
    ldv.setUint16(26, name.length, true);
    loc.set(name, 30);
    parts.push(loc, stored);

    const cen = new Uint8Array(46 + name.length);
    const cdv = new DataView(cen.buffer);
    cdv.setUint32(0, 0x02014b50, true);
    cdv.setUint16(10, e.deflate ? 8 : 0, true);
    cdv.setUint32(16, crc, true);
    cdv.setUint32(20, stored.length, true);
    cdv.setUint32(24, raw.length, true);
    cdv.setUint16(28, name.length, true);
    cdv.setUint32(42, offset, true);
    cen.set(name, 46);
    central.push(cen);
    offset += loc.length + stored.length;
  }
  const cenSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true);
  edv.setUint16(8, entries.length, true);
  edv.setUint16(10, entries.length, true);
  edv.setUint32(12, cenSize, true);
  edv.setUint32(16, offset, true);

  const all = [...parts, ...central, eocd];
  const total = all.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of all) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

/** The locked schema, as PR dfattal/displayxr-gallery-pvt#70 writes it. */
const CAMERA = {
  convention: 'opencv',
  rest: { position: [0, 0, 0], rotation: [0, 0, 0, 1] },
  intrinsics: { fx: 1194.665984, fy: 1194.665984, cx: 1024, cy: 576, width: 2048, height: 1152 },
  stereo: { baseline_m: 0.063 },
};

const META = { version: 2, asset: { generator: 'sharp' }, count: 1179648, antialias: false };

// ── the zip reader ──────────────────────────────────────────────────────────────────────

test('readZipEntry finds a STORED entry among others', async () => {
  const zip = await makeZip([
    { name: 'means_l.webp', data: new Uint8Array([1, 2, 3, 4]) },
    { name: 'meta.json', data: '{"version":2}' },
    { name: 'sh0.webp', data: new Uint8Array([9, 9]) },
  ]);
  const got = await readZipEntry(zip, 'meta.json');
  assert.equal(new TextDecoder().decode(got), '{"version":2}');
});

test('readZipEntry inflates a DEFLATED entry', async () => {
  // Repetitive on purpose: deflate must actually shrink it, so method 8 is genuinely exercised.
  const json = JSON.stringify({ ...META, camera: CAMERA, pad: 'x'.repeat(4000) });
  const zip = await makeZip([
    { name: 'means_u.webp', data: new Uint8Array(32) },
    { name: 'meta.json', data: json, deflate: true },
  ]);
  const got = await readZipEntry(zip, 'meta.json');
  assert.equal(new TextDecoder().decode(got), json);
});

test('readZipEntry trusts the CENTRAL directory when the local header has no sizes', async () => {
  const zip = await makeZip([
    { name: 'meta.json', data: JSON.stringify(META), deflate: true, zeroLocalSizes: true },
  ]);
  const got = await readZipEntry(zip, 'meta.json');
  assert.deepEqual(JSON.parse(new TextDecoder().decode(got)), META);
});

test('readZipEntry returns null for a missing entry, and for non-zip bytes', async () => {
  const zip = await makeZip([{ name: 'meta.json', data: '{}' }]);
  assert.equal(await readZipEntry(zip, 'camera.json'), null);
  assert.equal(await readZipEntry(new Uint8Array([0x70, 0x6c, 0x79, 0x0a]), 'meta.json'), null);
  assert.equal(await readZipEntry(new Uint8Array(0), 'meta.json'), null);
});

test('readSogMeta rejects anything that is not a PKZip WITHOUT scanning it', async () => {
  // A `.ply` header and a gzip (`.spz`) are the two other things this SDK is handed.
  assert.equal(await readSogMeta(new Uint8Array([0x70, 0x6c, 0x79, 0x0a])), null);
  assert.equal(await readSogMeta(new Uint8Array([0x1f, 0x8b, 0x08, 0x00])), null);
  assert.equal(await readSogMeta(null), null);
});

test('readSogMeta parses meta.json and survives a corrupt one', async () => {
  const ok = await makeZip([{ name: 'meta.json', data: JSON.stringify(META) }]);
  assert.deepEqual(await readSogMeta(ok), META);
  const bad = await makeZip([{ name: 'meta.json', data: '{ not json' }]);
  assert.equal(await readSogMeta(bad), null);
});

// ── the camera block ────────────────────────────────────────────────────────────────────

test('a camera block round-trips out of real .sog bytes, with its derived fields', async () => {
  const zip = await makeZip([
    { name: 'meta.json', data: JSON.stringify({ ...META, camera: CAMERA }), deflate: true },
  ]);
  const cam = await readSogCamera(zip);
  assert.ok(cam);
  assert.equal(cam.convention, 'opencv');
  assert.deepEqual(cam.intrinsics, CAMERA.intrinsics);
  assert.deepEqual(cam.stereo, { baseline_m: 0.063 });
  // 2·atan(h / 2fy) — the FULL vertical angle, in radians.
  assert.ok(Math.abs(cam.verticalFov - 2 * Math.atan(1152 / (2 * 1194.665984))) < 1e-12);
  // Principal point dead centre ⇒ no lens shift, i.e. this pair is not deconverged.
  assert.deepEqual(cam.principalOffset, { x: 0, y: -0 });
});

test('a shifted principal point becomes a fractional lens offset, y flipped out of OpenCV', () => {
  const cam = sogCameraFromMeta({
    camera: {
      ...CAMERA,
      intrinsics: { ...CAMERA.intrinsics, cx: 1024 + 20.48, cy: 576 - 11.52 },
    },
  });
  // +x in OpenCV is +x in GL: the principal point moved right by 1% of the frame.
  assert.ok(Math.abs(cam.principalOffset.x - 0.01) < 1e-12);
  // OpenCV's y grows DOWNWARDS, so a smaller cy is UP — and must come back positive.
  assert.ok(Math.abs(cam.principalOffset.y - 0.01) < 1e-12);
});

test('no camera block means null — the asset stays on the display rig', () => {
  assert.equal(sogCameraFromMeta(META), null);
  assert.equal(sogCameraFromMeta(null), null);
  assert.equal(sogCameraFromMeta({ camera: 'yes' }), null);
});

test('an unusable camera block is REFUSED rather than partly believed', () => {
  // Another convention: the intrinsics would be mis-signed, silently.
  assert.equal(sogCameraFromMeta({ camera: { ...CAMERA, convention: 'opengl' } }), null);
  assert.equal(sogCameraFromMeta({ camera: { convention: 'opencv' } }), null);
  for (const bad of [
    { ...CAMERA.intrinsics, fy: 0 },
    { ...CAMERA.intrinsics, fx: 'wide' },
    { ...CAMERA.intrinsics, width: -2048 },
    { ...CAMERA.intrinsics, cx: null },
  ]) {
    assert.equal(sogCameraFromMeta({ camera: { ...CAMERA, intrinsics: bad } }), null, JSON.stringify(bad));
  }
});

test('rest pose and baseline default sanely when absent', () => {
  const cam = sogCameraFromMeta({ camera: { convention: 'opencv', intrinsics: CAMERA.intrinsics } });
  assert.deepEqual(cam.rest, { position: [0, 0, 0], rotation: [0, 0, 0, 1] });
  // A missing baseline is NOT 0.063: the block said nothing, so nothing is claimed.
  assert.equal(cam.stereo, null);
});

// inline3d-sog.js — read the `meta.json` out of a `.sog`, and the optional `camera` block in it.
//
// EXPERIMENTAL. Internal to `./splat`, which re-exports `readSogCamera`. Not covered by the SDK's
// 1.x semver promise — see docs/sdk-stability.md.
//
// WHY A ZIP READER IS IN THIS SDK AT ALL. A `.sog` from `splat-transform` is a PKZip of webp
// planes plus a `meta.json`, and Spark reads exactly the fields it needs to build splats out of
// it — it neither surfaces the rest of the file nor hands back the parsed metadata. But whether a
// splat is an OBJECT (a product hero, a scan, a turntable subject) or a PHOTOGRAPH LIFTED INTO 3D
// is not a rendering detail: it decides which VIEW RIG the window should be on, and getting that
// wrong is the difference between a picture you can lean into and an arbitrary cloud framed by a
// bounding box. The `camera` block records the recording camera so the viewer can conserve it.
//
// So the choice is between asking every page to parse its own assets and reading ~40 bytes of
// central directory here. The reader below does the second: it is deliberately the smallest thing
// that can find ONE named entry in a zip, and it never touches the webp planes (which are
// megabytes, and Spark's business).
//
// It is BYTES-ONLY on purpose. The gallery hands the SDK bytes rather than a URL (Spark infers a
// splat's format from the URL path, so an extension-less `blob:` URL fails inside a worker), and
// those same bytes are the ones this reads — one download, no second fetch, no range request, and
// no chance of reading metadata from a different build of the asset than the one on screen.

/** `PK\x05\x06` — end of central directory. */
const EOCD_SIG = 0x06054b50;
/** `PK\x01\x02` — a central-directory file header. */
const CEN_SIG = 0x02014b50;
/** `PK\x03\x04` — a local file header. */
const LOC_SIG = 0x04034b50;

/** EOCD is 22 bytes plus a comment of at most 64 KiB. */
const EOCD_MAX_BACK = 22 + 0xffff;

/**
 * A `meta.json` this large is not a `meta.json`. The guard is against a malformed/hostile
 * central directory, not against real assets: the largest one seen is ~4 KB.
 */
const META_MAX_BYTES = 4 << 20;

/** Locate the end-of-central-directory record, scanning backwards. */
function findEocd(dv) {
  const len = dv.byteLength;
  if (len < 22) return -1;
  const stop = Math.max(0, len - EOCD_MAX_BACK);
  for (let i = len - 22; i >= stop; i--) {
    if (dv.getUint32(i, true) === EOCD_SIG) return i;
  }
  return -1;
}

/** Inflate a raw deflate stream. Returns null where the platform has no DecompressionStream. */
async function inflateRaw(slice) {
  if (typeof DecompressionStream !== 'function') return null;
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([slice]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Read one named entry out of a PKZip, as bytes.
 *
 * Handles the two compression methods a `.sog` actually uses — 0 (stored) and 8 (deflate) — and
 * returns null for anything else rather than guessing. Zip64 is refused the same way: a `.sog`
 * big enough to need it would have to be over 4 GB.
 *
 * @param {Uint8Array} bytes  the whole archive.
 * @param {string} name  exact entry name, e.g. `meta.json`.
 * @returns {Promise<Uint8Array|null>}
 */
export async function readZipEntry(bytes, name) {
  if (!bytes || bytes.byteLength < 22) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(dv);
  if (eocd < 0) return null;

  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  // 0xffffffff in either field is the zip64 escape; we do not follow it (see above).
  if (p === 0xffffffff || p >= dv.byteLength) return null;

  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (p + 46 > dv.byteLength || dv.getUint32(p, true) !== CEN_SIG) return null;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const rawSize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const entry = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (entry !== name) continue;

    if (compSize === 0xffffffff || rawSize === 0xffffffff || localOff === 0xffffffff) return null;
    if (rawSize > META_MAX_BYTES) return null;
    // The central directory's sizes are authoritative; the LOCAL header's may be zeroed (a
    // streaming writer defers them to a data descriptor). Only its two length fields are read.
    if (localOff + 30 > dv.byteLength || dv.getUint32(localOff, true) !== LOC_SIG) return null;
    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const start = localOff + 30 + lNameLen + lExtraLen;
    if (start + compSize > dv.byteLength) return null;
    const slice = bytes.subarray(start, start + compSize);
    if (method === 0) return slice;
    if (method === 8) return inflateRaw(slice);
    return null;
  }
  return null;
}

/**
 * Parse a `.sog`'s `meta.json`.
 *
 * @param {Uint8Array|ArrayBuffer} bytes
 * @returns {Promise<object|null>} the parsed object, or null if this is not a `.sog`, has no
 *          `meta.json`, or the entry cannot be read on this platform.
 */
export async function readSogMeta(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : bytes ? new Uint8Array(bytes) : null;
  if (!u8 || u8.length < 4) return null;
  // PK\x03\x04 — cheap reject before the backwards scan, so a `.ply`/`.spz`/`.splat` costs
  // four byte comparisons.
  if (!(u8[0] === 0x50 && u8[1] === 0x4b && u8[2] === 0x03 && u8[3] === 0x04)) return null;
  let raw;
  try {
    raw = await readZipEntry(u8, 'meta.json');
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    return JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return null;
  }
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Validate the `camera` block of a `.sog` `meta.json`.
 *
 * THE BLOCK IS THE RIG SWITCH — present means "this splat was lifted from a photograph, and here
 * is the camera that took it"; absent means "this is an object", which is the display rig and the
 * behaviour every existing page already has. That is the whole contract, and it is why this is
 * strict: a half-parsed block that silently keeps some defaults would put a photo scene on a
 * plausible-looking rig that is not the capture, which is indistinguishable from a framing bug.
 *
 * Shape (`meta.json`, top level, right after `count`; `version` stays 2). v2 is a SUPERSET of
 * v1 — every key below except `convention` is optional, and a v1 block still reads:
 *
 *     "camera": {
 *       "convention": "opencv",
 *       "rig":        "camera",                        // v2: which rig this asset wants
 *       "rest":       { "position": [0,0,0], "rotation": [0,0,0,1] },
 *       "intrinsics": { "fx":…, "fy":…, "cx":…, "cy":…, "width":…, "height":… },
 *       "stereo":     { "baseline_m": 0.063 },
 *       "focus":      { "point": [0,0,1.68], "subject_m":…, "near_m":…, "far_m":…,
 *                       "source": "convergence|manual|auto" },   // v2
 *       "dxr":        { "ipd_factor": 1.0, "parallax_factor": 1.0 }   // v2
 *     }
 *
 * `intrinsics` BECAME OPTIONAL IN v2, which is the change with teeth: a block can now say "this
 * is a camera rig, open it at this viewpoint" without claiming a lens, and the consumer is
 * expected to estimate one. So this returns a descriptor with null intrinsics rather than
 * refusing the block — refusing it would silently demote a camera-rig asset to the display rig,
 * which is the failure this whole mechanism exists to prevent.
 *
 * `focus.point` is THE point: the orbit centre, the pivot plane and the convergence distance,
 * which are one thing and are stored once.
 *
 * `convention` is REQUIRED to be `opencv` (+x right, +y DOWN, +z forward, pixel (0,0) at the top
 * left) rather than defaulted: it is the frame the intrinsics are expressed in, and a reader that
 * assumed it would mis-sign the principal-point offset on any other convention — a wrong answer
 * with no error, which is the one failure mode a metadata block must not have.
 *
 * @param {object|null} meta  a parsed `meta.json`.
 * @returns {object|null} a normalised camera descriptor, or null.
 */
export function sogCameraFromMeta(meta) {
  const c = meta && typeof meta === 'object' ? meta.camera : null;
  if (!c || typeof c !== 'object') return null;
  if (c.convention !== 'opencv') {
    console.warn(
      `[inline3d/splat] .sog camera block has convention "${c.convention}" — only "opencv" is ` +
        'understood, so the block is IGNORED and this asset stays on the display rig.',
    );
    return null;
  }
  const i = c.intrinsics;
  let intrinsics = null;
  if (i && typeof i === 'object') {
    const fx = num(i.fx);
    const fy = num(i.fy);
    const cx = num(i.cx);
    const cy = num(i.cy);
    const width = num(i.width);
    const height = num(i.height);
    if (!(fx > 0) || !(fy > 0) || !(width > 0) || !(height > 0) || cx === null || cy === null) {
      // Half-believing a lens is worse than having none: with intrinsics optional in v2 there is
      // a well-defined thing to do instead, which is estimate one from the cloud.
      console.warn(
        '[inline3d/splat] .sog camera block has unusable intrinsics — they are DROPPED and the ' +
          'lens is estimated from the cloud instead; the rest of the block still applies.',
        i,
      );
    } else {
      intrinsics = { fx, fy, cx, cy, width, height };
    }
  }
  const pos = Array.isArray(c.rest?.position) ? c.rest.position.map((v) => num(v) ?? 0) : [0, 0, 0];
  const rot = Array.isArray(c.rest?.rotation) ? c.rest.rotation.map((v) => num(v) ?? 0) : [0, 0, 0, 1];
  const baseline = num(c.stereo?.baseline_m);

  // v2 `rig`. Anything unrecognised is dropped rather than guessed at — the waterfall's next
  // step (a block means a camera) is a better answer than a typo taken literally.
  let rig = null;
  if (c.rig === 'camera' || c.rig === 'display') rig = c.rig;
  else if (c.rig !== undefined) {
    console.warn(`[inline3d/splat] .sog camera block has rig "${c.rig}" — ignored`, c.rig);
  }

  // v2 `focus`. The point is the only required part; the three distances are advisory and are
  // carried through untouched for a host page that wants them (a depth budget, a HUD).
  let focus = null;
  const fp = c.focus?.point;
  if (Array.isArray(fp) && fp.length >= 3 && fp.every((v) => num(v) !== null)) {
    focus = {
      point: [fp[0], fp[1], fp[2]],
      subject_m: num(c.focus.subject_m),
      near_m: num(c.focus.near_m),
      far_m: num(c.focus.far_m),
      source: typeof c.focus.source === 'string' ? c.focus.source : null,
    };
  } else if (c.focus !== undefined) {
    console.warn('[inline3d/splat] .sog camera block has an unusable focus — ignored', c.focus);
  }

  // v2 `dxr`. These are the camera rig's ABSOLUTE scalars, and they stay absolute: normalising
  // them against the convergence distance would make the scene's depth breathe every time the
  // viewer re-focused.
  const ipdFactor = num(c.dxr?.ipd_factor);
  const parallaxFactor = num(c.dxr?.parallax_factor);

  return {
    convention: 'opencv',
    rig,
    focus,
    dxr: {
      ipdFactor: ipdFactor !== null && ipdFactor >= 0 ? ipdFactor : null,
      parallaxFactor: parallaxFactor !== null && parallaxFactor >= 0 ? parallaxFactor : null,
    },
    rest: {
      position: [pos[0] ?? 0, pos[1] ?? 0, pos[2] ?? 0],
      rotation: [rot[0] ?? 0, rot[1] ?? 0, rot[2] ?? 0, rot[3] ?? 1],
    },
    intrinsics,
    stereo: baseline > 0 ? { baseline_m: baseline } : null,
    /**
     * Derived, because every consumer needs them and each is one line to get subtly wrong.
     *
     * Null when the block carried no usable intrinsics (legal in v2) — the caller estimates a
     * lens from the cloud instead.
     *
     * `verticalFov` is the FULL vertical angle the capture subtends, in RADIANS — the unit an
     * XRViewRigInit wants (three's `camera.fov` is the same angle in degrees).
     *
     * `principalOffset` is the principal point's offset from the frame centre as a fraction of
     * the frame, x rightwards and **y upwards** — i.e. already out of OpenCV's y-down frame and
     * into the GL/three one, so a consumer never has to remember which way `cy` grows. A
     * rectified stereo pair carries its deconvergence here: shifting the principal point is what
     * "deconverging" DOES to a pair, so a non-zero x is the capture's zero-disparity plane
     * expressed as a lens shift rather than as a distance.
     */
    verticalFov: intrinsics ? 2 * Math.atan(intrinsics.height / (2 * intrinsics.fy)) : null,
    principalOffset: intrinsics
      ? {
          x: (intrinsics.cx - intrinsics.width / 2) / intrinsics.width,
          y: -(intrinsics.cy - intrinsics.height / 2) / intrinsics.height,
        }
      : null,
  };
}

/**
 * Read the `camera` block straight out of `.sog` bytes. Convenience over
 * {@link readSogMeta} + {@link sogCameraFromMeta}.
 *
 * @param {Uint8Array|ArrayBuffer} bytes
 * @returns {Promise<object|null>}
 */
export async function readSogCamera(bytes) {
  return sogCameraFromMeta(await readSogMeta(bytes));
}

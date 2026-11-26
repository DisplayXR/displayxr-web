// lift/sog-input.js — a `.sog` as lift INPUT: the lift meta the explore renderer needs, read off
// the file's own camera block v2 (js/inline3d-sog.js documents the block; `sogCameraFromMeta`
// validates it). Used by the remote SHARP provider (providers/lift-remote-sharp.js) and by
// createExplore({ sog }).
//
// The rig is the photo's own camera: focalPx / w / h from `camera.intrinsics` (the grid the
// gaussians were unprojected through — any raster works, rigFromMeta only needs them consistent),
// pivotZ from `camera.focus.point[2]` (OpenCV +z forward, so positive), axes 'opencv'. With those
// the explore view's neutral pose IS the photo, exactly as for a local lift.

import { readSogMeta, sogCameraFromMeta } from '../inline3d-sog.js';

/** `PK\x03\x04` — a `.sog` bundle is a zip. */
export function isSogBytes(u8) {
  return !!u8 && u8.length >= 4 && u8[0] === 0x50 && u8[1] === 0x4b && u8[2] === 0x03 && u8[3] === 0x04;
}

/**
 * Lift meta from a parsed `.sog` meta.json. `fallback` fills what the block does not carry
 * (e.g. the focal and size the caller sent with the request).
 *
 * @param {object} sogMeta  parsed meta.json
 * @param {{focalPx?:number, w?:number, h?:number, pivotZ?:number}} [fallback]
 * @returns {{focalPx:number, pivotZ:number, w:number, h:number, layers:number, splatCount:number,
 *            convention:'opencv', axes:'opencv', space:'metric', intrinsics:object|null,
 *            camera:object|null, focusSource:string|null}}
 */
export function liftMetaFromSogMeta(sogMeta, fallback = {}) {
  if (!sogMeta || typeof sogMeta !== 'object') throw new Error('lift: .sog has no readable meta.json');
  const cam = sogCameraFromMeta(sogMeta);
  const it = cam && cam.intrinsics;
  const focalPx = it ? it.fx : +fallback.focalPx;
  const w = it ? it.width : +fallback.w;
  const h = it ? it.height : +fallback.h;
  if (!(focalPx > 0) || !(w > 0) || !(h > 0)) {
    throw new Error('lift: .sog camera block has no usable intrinsics and no fallback focal/size was given');
  }
  const fz = cam && cam.focus ? cam.focus.point[2] : NaN;
  const pivotZ = fz > 0 ? fz : cam?.focus?.subject_m > 0 ? cam.focus.subject_m : +fallback.pivotZ > 0 ? +fallback.pivotZ : 2;
  return {
    focalPx,
    pivotZ,
    w,
    h,
    layers: 2,
    splatCount: Number.isFinite(+sogMeta.count) ? +sogMeta.count : 0,
    convention: 'opencv',
    axes: 'opencv',
    // SHARP's scale is a learned metric prior (like MoGe-3's), so explore's comfort rule treats it
    // as metric: a pivot more than 2x off the 2 m target is normalised (docs/lift-explore.md).
    space: 'metric',
    intrinsics: it ? { fx: it.fx, fy: it.fy, cx: it.cx, cy: it.cy, w: it.width, h: it.height } : null,
    subjectZ: cam?.focus?.subject_m ?? undefined,
    depthRange: cam?.focus && (cam.focus.near_m || cam.focus.far_m) ? { near: cam.focus.near_m, far: cam.focus.far_m } : undefined,
    camera: cam,
    focusSource: cam?.focus?.source ?? null,
  };
}

/** Read a `.sog`'s meta.json and turn it into lift meta. Throws on anything that is not a SOG. */
export async function readLiftSog(bytes, fallback = {}) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (!isSogBytes(u8)) throw new Error('lift: not a .sog (no zip signature)');
  const sogMeta = await readSogMeta(u8);
  return { meta: liftMetaFromSogMeta(sogMeta, fallback), sogMeta };
}

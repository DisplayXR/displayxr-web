// camera/geometry.js — the pure geometry of a side-by-side frame: what counts as a pair, how one
// eye is cropped to a tile's aspect (with a convergence shift), and the self-view mirroring trap.
// Shared by `@displayxr/inline3d/camera` (the self view, capture) and `/call` (remote tiles).
// No DOM — see test/camera.test.mjs and test/call.test.mjs.

/** A delivered frame wider than this (w / h) is a side-by-side pair (e.g. 1280x480, 2560x720). */
export const SBS_ASPECT_MIN = 2.5;

/** Does a delivered frame look like a side-by-side pair? (`prefer: 'auto'` only) */
export function looksSbs(width, height) {
  return width > 0 && height > 0 && width / height > SBS_ASPECT_MIN;
}

/**
 * The source rectangle of ONE eye, cropped to the tile's aspect and shifted by the convergence
 * offset. Never upscales past the source: a 640-wide eye (a real raw stereo camera) stays 640.
 *
 * @param {number} eyeW  source per-eye width (px)
 * @param {number} eyeH  source height
 * @param {number} aspect  the tile's (= the woven buffer's per-eye) aspect, w/h
 * @param {number} shift  per-eye shift in source px (see convergenceShiftPx); + = push back
 * @param {0|1} eye  0 = left, 1 = right
 * @returns {{sx:number, sy:number, sw:number, sh:number}} relative to that eye's half
 */
export function eyeCropRect(eyeW, eyeH, aspect, shift, eye) {
  const s = Math.abs(shift || 0);
  let sw = Math.min(eyeW - 2 * s, eyeH * aspect);
  sw = Math.max(1, sw);
  const sh = Math.min(eyeH, sw / aspect);
  sw = sh * aspect;
  const cx = (eyeW - sw) / 2 + (eye === 0 ? shift : -shift);
  return { sx: Math.max(0, Math.min(eyeW - sw, cx)), sy: (eyeH - sh) / 2, sw, sh };
}

/** The output per-eye size for a source eye and a tile aspect: no upscaling, even numbers. */
export function eyeOutputSize(eyeW, eyeH, aspect) {
  const w = Math.min(eyeW, eyeH * aspect);
  const h = w / aspect;
  return { w: Math.max(2, Math.round(w / 2) * 2), h: Math.max(2, Math.round(h / 2) * 2) };
}

// ── self view: the mirroring trap (RFC 0002 §3, RFC 0003 §4) ───────────────────────────────

/**
 * The draw operations for a MIRRORED stereo self-view: each half mirrored AND the halves swapped.
 *
 * Why both: mirroring a scene horizontally means the reflected left eye sees what the original
 * right eye saw (mirrored), and vice versa. Mirroring each half IN PLACE keeps the eyes where they
 * were and inverts every disparity — the face goes pseudoscopic (inside-out). Mirror + swap keeps
 * crossed disparity crossed. (It is the same pixels as flipping the whole SBS frame; spelled out
 * per half so the intent survives refactoring.) The WIRE is never mirrored — only this preview.
 *
 * @param {number} W  full SBS frame width
 * @param {number} H  height
 * @returns {Array<{src:'L'|'R', sx:number, sw:number, sy:number, sh:number, dx:number, dw:number, mirror:true}>}
 */
export function mirrorSwapOps(W, H) {
  const half = W / 2;
  return [
    { src: 'R', sx: half, sw: half, sy: 0, sh: H, dx: 0, dw: half, mirror: true },
    { src: 'L', sx: 0, sw: half, sy: 0, sh: H, dx: half, dw: half, mirror: true },
  ];
}

/**
 * Apply mirrorSwapOps to a row-major single-channel frame (tests, and a reference for the canvas
 * path). Returns a new array.
 */
export function mirrorSwapPixels(px, W, H) {
  const out = new px.constructor(px.length);
  for (const op of mirrorSwapOps(W, H)) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < op.dw; x++) {
        const srcX = op.sx + (op.sw - 1 - x); // mirrored within the half
        out[y * W + op.dx + x] = px[y * W + srcX];
      }
    }
  }
  return out;
}

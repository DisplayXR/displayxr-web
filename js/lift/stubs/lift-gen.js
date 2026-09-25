// lift/stubs/lift-gen.js — STUB of js/lift/gen/lift-gen.js (A4). No inpainting, no optimisation.
//
// Same contract: generateLift({rgb, depth, inpainter?, quality, signal, onProgress})
//   → { ply: ArrayBuffer (binary little-endian 3DGS PLY), meta: {focalPx, pivotZ, w, h, layers: 2} }.
// Emits a pixel-grid of isotropic splats unprojected through the depth map (layer 0), plus a
// second copy pushed 6 % further back (layer 1: a stand-in for the inpainted background), in the
// standard INRIA property layout so any 3DGS reader (and the explore stub) can parse it.

const SH_C0 = 0.28209479177387814;
const PROPS = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];

const tick = () => new Promise((r) => setTimeout(r, 30));

export async function generateLift({ rgb, depth, quality = 'medium', signal, onProgress } = {}) {
  const check = () => {
    if (signal && signal.aborted) throw signal.reason || Object.assign(new Error('aborted'), { name: 'AbortError' });
  };
  const w = rgb.width, h = rgb.height;
  const GW = quality === 'high' ? 256 : quality === 'low' ? 96 : 160;
  const GH = Math.max(2, Math.round((GW * h) / w));
  const c = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(GW, GH) : Object.assign(document.createElement('canvas'), { width: GW, height: GH });
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(rgb, 0, 0, GW, GH);
  const px = ctx.getImageData(0, 0, GW, GH).data;
  onProgress && onProgress(0.1);
  await tick();
  check();

  // Normalise disparity → 0..1 (1 = nearest), then to metric-ish depth 1..2.5 m.
  let lo = Infinity, hi = -Infinity;
  for (const v of depth.data) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const span = hi - lo || 1;
  const focalPx = (depth.intrinsics && depth.intrinsics.focalPx) ? (depth.intrinsics.focalPx * GW) / depth.w : GW * 0.9;
  const n = GW * GH;
  const layers = 2;
  const floats = new Float32Array(n * layers * PROPS.length);
  let k = 0;
  let zSum = 0;
  for (let layer = 0; layer < layers; layer++) {
    for (let y = 0; y < GH; y++) {
      for (let x = 0; x < GW; x++) {
        const dx = Math.min(depth.w - 1, Math.floor((x / GW) * depth.w));
        const dy = Math.min(depth.h - 1, Math.floor((y / GH) * depth.h));
        const dn = depth.space === 'metric' ? null : (depth.data[dy * depth.w + dx] - lo) / span;
        let Z = dn === null ? depth.data[dy * depth.w + dx] : 1 + (1 - dn) * 1.5;
        if (layer === 1) Z *= 1.06;
        const X = ((x + 0.5 - GW / 2) * Z) / focalPx;
        const Y = ((y + 0.5 - GH / 2) * Z) / focalPx;
        const i = (y * GW + x) * 4;
        const s = Math.log((0.75 * Z) / focalPx);
        floats.set([X, Y, Z, (px[i] / 255 - 0.5) / SH_C0, (px[i + 1] / 255 - 0.5) / SH_C0, (px[i + 2] / 255 - 0.5) / SH_C0, layer ? 2 : 6, s, s, s, 1, 0, 0, 0], k);
        k += PROPS.length;
        if (layer === 0) zSum += Z;
      }
    }
    onProgress && onProgress(0.1 + 0.4 * (layer + 1));
    await tick();
    check();
  }
  const header =
    'ply\nformat binary_little_endian 1.0\n' +
    `element vertex ${n * layers}\n` +
    PROPS.map((p) => `property float ${p}\n`).join('') +
    'end_header\n';
  const hb = new TextEncoder().encode(header);
  const ply = new ArrayBuffer(hb.length + floats.byteLength);
  new Uint8Array(ply).set(hb, 0);
  new Uint8Array(ply).set(new Uint8Array(floats.buffer), hb.length);
  onProgress && onProgress(1);
  return { ply, meta: { focalPx, pivotZ: zSum / n, w: GW, h: GH, layers } };
}

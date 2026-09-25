// lift/stubs/depth.js — STUB of js/lift/providers/depth-ort.js (A2). No model, no ORT.
//
// Same contract: createDepthProvider({kind, modelSource, ort?, quality}) → DepthProvider.
// estimate() returns a cheap fake DISPARITY map (relative, larger = nearer, un-normalised):
// a bottom-is-nearer ramp plus a bit of luminance, so a live preview and a lift both have
// something plausibly 3D to show. Exists so the state machine and sample run before A2 lands.

const W = 96;
const H = 54;

export function createDepthProvider({ kind = 'video', quality = 'medium' } = {}) {
  let scratch = null;
  let ctx = null;
  let loaded = false;
  return {
    id: `stub-depth-${kind}`,
    kind,
    quality,
    async load({ signal, onProgress } = {}) {
      // Pretend to fetch a model so progress UI has something to show.
      for (let i = 1; i <= 4; i++) {
        if (signal && signal.aborted) throw signal.reason || new Error('aborted');
        await new Promise((r) => setTimeout(r, kind === 'still' ? 60 : 25));
        onProgress && onProgress(i / 4);
      }
      loaded = true;
    },
    async estimate({ source }) {
      if (!loaded) throw new Error('stub depth: estimate() before load()');
      if (!scratch) {
        scratch = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H });
        ctx = scratch.getContext('2d', { willReadFrequently: true });
      }
      let lum = null;
      try {
        ctx.drawImage(source, 0, 0, W, H);
        lum = ctx.getImageData(0, 0, W, H).data;
      } catch {
        /* not drawable yet (video with no frame): ramp only */
      }
      const data = new Float32Array(W * H);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = y * W + x;
          const ramp = 0.2 + 0.8 * (y / (H - 1));
          const l = lum ? (0.299 * lum[i * 4] + 0.587 * lum[i * 4 + 1] + 0.114 * lum[i * 4 + 2]) / 255 : 0.5;
          data[i] = (ramp * 0.75 + l * 0.25) * 10; // un-normalised on purpose
        }
      }
      return { data, w: W, h: H, space: 'disparity' };
    },
    reset() {},
    dispose() {
      scratch = ctx = null;
    },
  };
}

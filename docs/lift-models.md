# Lift models: depth, inpainting, and how they get delivered

"Convert to 3D" (`lift`) needs neural networks for depth estimation and disocclusion inpainting.
This page covers the provider layer under `js/lift/providers/`: which models exist, how a page
gets them, how ONNX Runtime is loaded, and how to run them in development.

**Models are never bundled into the SDK and never committed to git.** The SDK ships a manifest,
`js/lift/models.json`, with each file's name, size and sha256. The page hosts the `.onnx` files
(or the DisplayXR Browser supplies them), and the SDK downloads, verifies and caches them.

## Model families

A provider accepts `model:` as either a family alias or a concrete manifest name. A family plus a
`quality` selects a resolution:

| family (`model:`) | kind | `low` | `medium` / `auto` | `high` | output |
|---|---|---|---|---|---|
| `vda-small` *(video default)* | video | `vda-small-stream-364x210` | `vda-small-stream-518x294` ¹ | 518×294 | `disparity` |
| `moge3` *(still default)* | still | `moge3-vitl-770x434` | `moge3-vitl-770x434` | `moge3-vitl-1022x574` | `metric` + `intrinsics.focalPx` + `mask` |
| `da3` | still | `da3mono-large-770x434` | same | `da3mono-large-1022x574` | `disparity` (sky filled) + `mask` |
| `da2-small` | still | `da2-small` (dynamic, long side 518) | same | same | `disparity` |
| `light-inpaint-v1` | inpaint | 512×288 tiles | 512×288 | 1024×576 | RGB |

With no `model:`, the defaults come from the manifest's `defaults`: video uses `vda-small`, and
stills use **DA2-Small for `low`**, **MoGe-3 770×434 for `medium`/`auto`**, and **MoGe-3 1022×574
for `high`**.

¹ Video `auto` loads 518×294, then times a warm-up (one untimed compile frame plus three timed
frames, median). If a frame takes more than 90 ms, it switches to 364×210. On an M1 Pro,
518×294 takes 148 ms per frame, so `auto` settles on 364×210 at about 12.5 fps. To pin a
resolution, pass `quality: 'medium'` or a concrete name.

| model | file | size | licence | notes |
|---|---|---|---|---|
| Video-Depth-Anything-Small streaming | `vda/vda_s_stream_{518x294,364x210}_w16.onnx` | 58 MB | Apache-2.0 | **w16** = fp16 weights, fp32 compute. Pure fp16 has 8–10 % error on ORT WebGPU; w16 has 0.1 % |
| MoGe-3 ViT-L (backbone only) | `still/moge3_vitl_{770x434,1022x574}_fp16.onnx` | 715 / 757 MB | MIT | focal/shift solve runs in JS (`still-post.js`); fp16 shifts focal by about +1.4 % |
| DA3Mono-Large | `still/da3mono_large_{770x434,1022x574}_fp16.onnx` | 669 / 672 MB | Apache-2.0 | outputs relative *depth* (larger = farther), which the provider inverts to disparity; sky fill runs in JS |
| Depth-Anything-V2-Small | `da2/depth_anything_v2_small_fp16.onnx` | 50 MB | Apache-2.0 | ImageNet normalisation runs in JS (the others do it in-graph) |
| iw3 light_inpaint_v1 | `inpaint/light_inpaint_v1_{1024x576,512x288}_fp16.onnx` | 7 / 5 MB | MIT | directional: expects the background to the RIGHT of a hole |

## API

```js
import {
  createDepthProvider, createInpainter, createModelSource, getRegistry, loadOrt,
} from './js/lift/providers/index.js';

const modelSource = createModelSource({ baseUrl: 'https://my.cdn/lift-models' });
const ort = await loadOrt();                     // optional; providers call it themselves if omitted

const video = createDepthProvider({ kind: 'video', modelSource, ort, quality: 'auto' });
await video.load({ onProgress: ({ loaded, total }) => {} , signal });
const { data, w, h, space } = await video.estimate({ source: videoEl, t: videoEl.currentTime });
video.reset();                                   // scene cut; also automatic on a backwards seek or a jump over 1 s in `t`

const still = createDepthProvider({ model: 'moge3', modelSource, quality: 'high' });  // kind inferred
await still.load();
const d = await still.estimate({ source: imgEl });   // { data, w, h, space: 'metric', mask, intrinsics: { focalPx, fovXDeg } }

const ip = createInpainter({ modelSource, ort, quality: 'medium' });
await ip.load();
const filled = await ip.inpaintTwoSided(rgbChw, maskRight, maskLeft, W, H);
```

- `estimate` resolves to a row-major `Float32Array` at **model resolution** (`w×h`); the caller
  resamples it to the source. `intrinsics.focalPx` uses the pixel grid of the returned map.
  `fovXDeg` does not depend on the grid.
- Calls are serialised. An `estimate` made while another is in flight waits for it to finish.
- `source` can be an `HTMLVideoElement`, `HTMLImageElement`, `HTMLCanvasElement`, `VideoFrame` or
  `ImageBitmap`.
- `provider.info` reports `{ model, width, height, preprocess: 'gpu'|'cpu', warmupMs, autoDropped }`.

### Registry

`getRegistry()` returns a singleton that all copies of the SDK on a page share. The ORT providers
register themselves as `'ort'` at priority 0. A native provider (the Browser's Phase B) or a vendor
provider registers at a higher priority and then wins:

```js
getRegistry().registerDepthProvider('native', (opts) => myProvider(opts), { priority: 100, kinds: ['video', 'still'], available: () => !!globalThis.__dxrLiftNativeDepth });
getRegistry().registerInpainter('native', (opts) => myInpainter(opts), { priority: 100 });

getRegistry().getDepthProvider('moge3', { modelSource, quality: 'high' });  // name = family/model → best provider
getRegistry().getDepthProvider('ort',   { kind: 'video', modelSource });     // name = registered provider
getRegistry().getInpainter(null, { modelSource });                          // best inpainter, default model
```

### Model delivery (`createModelSource`)

`createModelSource({ baseUrl?, manifest?, native?, verify? })` resolves names from `models.json`,
then:

1. **Native store.** When `globalThis.__dxrLiftNative` is set, or the page itself is served from
   `displayxr-lift:`, the model source fetches `displayxr-lift://models/<name>`. The browser has
   already verified the bytes it ships (Phase A). If the native store fails, the source falls back
   to the network.
2. **Cache API.** Models are cached in `caches.open('dxr-lift-models')`, keyed by URL. The body
   is streamed into the cache with a `tee()` of the download. Chrome's `Cache.put` rejects a
   ~700 MB in-memory `Response` with "Unexpected internal error" but accepts the same bytes
   streamed. A separate small entry at `stampKey(url)` records the sha256 the bytes matched, so a
   warm load is not hashed again. An entry without a stamp is verified once and then stamped; if
   it fails, it is evicted.
3. **Network.** The URL is `baseUrl + '/' + path` when a `baseUrl` is given, else an absolute
   per-file `url`, else the public content-addressed store `${blobBaseUrl}/${sha256}.${format}`
   (manifest top-level `blobBaseUrl`; the same blobs the DisplayXR Browser installer provisions —
   each entry's `installer: true|false` marks that default set). The source fetches it and reports progress from
   `Content-Length`. It checks the size and then the sha256 (WebCrypto). Bytes that fail
   (`err.code === 'EINTEGRITY'`) are never cached.

`get(name)` returns `{ stream, size, sha256, source }`. `getBytes(name)` returns the same with a
`Uint8Array`. `url(name)`, `has(name)`, `resolveName(nameOrFamily, role, quality)` and `clear()`
are also available.

Memory: a MoGe/DA3 file is about 700 MB. Loading it holds that as a JS buffer while ORT copies it
into the wasm heap, so peak use is about 1.5 GB. That is fine on desktop Chrome and too much for
phones. Phones should use the `low` still tier (DA2-Small, 50 MB).

## Loading ONNX Runtime

The SDK never bundles `onnxruntime-web`. There are two ways to get it:

- Pass your own: `createDepthProvider({ ..., ort })`.
- Or let `loadOrt({ baseUrl, bundle })` dynamically `import()` it. `baseUrl` defaults to jsDelivr,
  pinned to `onnxruntime-web@1.31.0-dev.20260918-bc8e7ed75`. `loadOrt` sets
  `ort.env.wasm.wasmPaths = baseUrl`. With `bundle: 'auto'` it picks `ort.jspi.min.mjs` when the
  browser has `WebAssembly.Suspending` (JSPI) and `ort.webgpu.min.mjs` otherwise. JSPI measured
  11–14 % faster on the VDA model. Without cross-origin isolation, wasm runs with one thread; the
  WebGPU EP does the heavy work either way.

**Preprocessing** is GPU-side by default. `copyExternalImageToTexture` runs on ORT's own
`GPUDevice`, then one compute pass resamples with a 4-tap box filter, normalises, and writes CHW
float32 into a storage buffer, which is passed to `ort.Tensor.fromGpuBuffer`. The CPU fallback
(`preprocess: 'cpu'`) does `drawImage` into an OffscreenCanvas, then `getImageData`, then a CHW
loop.

## Measured (M1 Pro, Chrome 153 headless, `--use-angle=metal`, GPU idle, JSPI bundle)

Each row is a fresh browser, run only after the GPU was idle and no other headless Chrome was
running. Figures are medians.

| path | preprocess | per frame / image | fps |
|---|---|---|---|
| video 364×210 (`low`, and what `auto` picks on this machine) | gpu | 79.5–81 ms | 12.3–12.6 |
| video 364×210 | cpu | 83.3 ms | 12.0 |
| video 518×294 (`medium`) | gpu | 148.4 ms | 6.7 |
| video 518×294 | cpu | 153.7 ms | 6.5 |
| still MoGe-3 770×434 (`auto`/`medium`) | gpu | 1.32 s (first call 1.4–1.9 s) | |
| still MoGe-3 1022×574 (`high`) | gpu | 2.77 s | |
| still DA3Mono-L 770×434 / 1022×574 | gpu | 1.21 s / 2.49 s | |
| still DA2-Small 518×294 (`low`) | gpu | 66 ms | |
| inpaint two-sided 960×540, 512×288 / 1024×576 tiles | – | 277 ms / 234 ms | |

GPU preprocessing is 3–5 % faster than CPU and is the default. Video `auto` costs about 2.9 s of
load time on this machine: it loads 518×294, runs the warm-up (80 ms/frame is over the limit),
then loads 364×210. Model load for MoGe 770 (715 MB from localhost) takes 3.8–5.0 s cold,
including the sha256, and 2.7 s warm from the Cache API.

On the synthetic scene, whose true horizontal FOV is 60°, MoGe reports fovX 58.1° at 770×434 and
60.5° at 1022×574.

The temporal cache stays on the GPU (`preferredOutputLocation: { cache_out: 'gpu-buffer' }`) and
is fed back every frame. Reading it back doubles the frame time.

## Development

The models live outside the repo. Link them into the gitignored `_scratch/` directory and serve the
repo root:

```sh
mkdir -p _scratch
ln -sfn ~/dxr-2d3d-exports/models _scratch/models      # tree: vda/ still/ da2/ inpaint/ dev/
ln -sfn /path/to/node_modules/onnxruntime-web/dist _scratch/ort   # optional; else the CDN is used
python3 -m http.server 8811 --bind 127.0.0.1
open http://127.0.0.1:8811/samples/lift/dev-depth.html
```

`~/dxr-2d3d-exports/models/` is the flat tree that matches the manifest `path`s (hard links into
the export folders). `dev/pan.mp4` and `dev/synthetic.jpg` are synthetic test assets: a
ray-traced checker floor with three spheres, panned with ffmpeg.

The dev page takes these query options: `quality=low|medium|auto` (video), `still=low|medium|high`,
`stillModel=moge3|da3|da2-small|<name>`, `pre=gpu|cpu`, `mode=video|still|both`, `video=`,
`image=`, `models=`, `ort=`, `bundle=jspi|webgpu`. `auto=1&frames=N` runs headless and prints
`RESULT {...}` then `DONE` to the console.

To regenerate `models.json` hashes after a re-export, use `shasum -a 256 <file>` and `stat -f %z`
(macOS). The unit tests check that every `defaults` and `families` target exists and that the VDA
cache shape matches the resolution.

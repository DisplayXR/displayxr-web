# lift-gen — one photo + depth → a two-layer Gaussian scene

**EXPERIMENTAL.** `js/lift/gen/` is the generator half of "Convert to 3D" (`lift`). It takes one
RGB image and a disparity (or metric depth) map and returns a **standard binary 3DGS PLY** that
`addSplat` loads (Spark or PlayCanvas), plus the metadata a viewer needs to open it on the
camera it was lifted from. It never runs a depth or inpainting model itself; the caller brings
depth and, optionally, an inpainter.

```js
import { generateLift } from './js/lift/gen/lift-gen.js';

const { ply, meta } = await generateLift({
  rgb,                                   // ImageBitmap | HTMLCanvasElement | OffscreenCanvas | ImageData
  depth: { data, w, h, space: 'disparity', intrinsics: { focalPx } },  // focalPx in SOURCE pixels, optional
  inpainter,                             // optional: { inpaintTwoSided(rgbChw, maskRight, maskLeft, W, H) → Promise<Float32Array> }
  quality: 'medium',                     // low 768 | medium 1024 | high 1536 wide (never upscaled)
  signal, onProgress,                    // AbortSignal; ({stage, progress}) callback
  params: { /* overrides for LIFT_DEFAULTS */ },
});

addSplat(wall, canvas, ply, {
  rig: 'camera', intrinsics: meta.intrinsics, focus: [0, 0, meta.pivotZ], idleSpin: 0,
});
```

`meta`: `{ focalPx, pivotZ, w, h, layers: 2, splatCount, layerCounts: [layer0, layer1],
hiddenBandCount, hiddenBackplateCount, bounds: {min, max}, intrinsics, convention: 'opencv',
border, depthRange: {near, far}, maxBandPx, backplatePx, inpainted, timings }`. `focalPx`,
`w`, `h` and `intrinsics` describe the **output** raster (the one the splats were built on) —
render through that focal and the neutral view is the photo (the gallery's focal-agreement
invariant).

## Coordinate convention

OpenCV camera frame, **metres**, the capture camera at the origin, principal point at the image
centre — the same frame as SHARP output and the `.sog` `camera` block (`convention: 'opencv'`).

```
            image (u right, v down)                    3D (OpenCV camera frame)
     (0,0) +-------------------+                          +y is DOWN
           |        · (cx,cy)  |                              |
           |                   |              camera ●--------+------> +x (right)
           +-------------------+ (W,H)          origin \
                                                         \
                                                          v  +z  FORWARD (into the scene,
                                                                  away from the camera)

   pixel (u, v) at depth z   →   x = (u + 0.5 − W/2) · z / f
                                 y = (v + 0.5 − H/2) · z / f
                                 z = z
```

`addSplat`'s default `flipY: true` applies the half turn about X that takes this into three.js
(+y up, the scene along **−z**, i.e. in front of a camera that looks down −z) — exactly what it
does for SHARP/gallery assets, so nothing special is needed. On the wall the display rig's +z is
**out of the glass**; a lift is a *camera-rig* asset (the photo has a viewpoint to conserve), so
`rig: 'camera'` + `meta.intrinsics` + `focus: [0, 0, pivotZ]` is the intended open.

Depth scale: a **relative** disparity map is normalised on its 2nd–98th percentiles and mapped
so 1/z is linear in disparity between **zNear = 0.7 m** and **zFar = 3 m** (the comfort range).
A **metric** map keeps its own 1/z range (far side clamped at 100 m). Without `focalPx` the
focal is `1.2 × width` (≈ 45° horizontal).

`pivotZ` is the median layer-0 depth of the central 40 % × 40 % of the frame. (The gallery's
rule is pivot = min(convergence, subject); a saliency map, when there is one, should replace the
central box.)

## What is generated

The shape is Apple SHARP's: two image-aligned layers.

- **Layer 0 — the visible surface.** One Gaussian per output pixel. Opacity 1 except a 1–2 px
  soft matte on foreground silhouettes.
- **Layer 1 — the hidden background.** Only where the orbit can reveal it:
  - the **band** — full resolution, under each foreground silhouette, as wide as the background
    can slide out at the maximum orbit (15°), capped at **5 % of the width**; its colour comes
    from the inpainting net when one is supplied;
  - the **backplate** — the same hidden surface continued out to **25 % of the width** at
    **half resolution** with push-pull colour, so reveals wider than the band show smooth
    background instead of black;
  - a **4 % outpainted border** round the frame.

PLY fields (17 × float32, little endian): `x y z nx ny nz(=0) f_dc_0..2 opacity scale_0..2
rot_0..3` — SH degree 0 (`f_dc = (c − 0.5)/0.28209479`, sRGB), opacity as a logit, scales as
log σ, rotation as a unit quaternion **w, x, y, z**. Layer 0 comes first, then layer 1 (band,
then backplate), so `layerCounts` slices the file.

## The algorithm, as built

Image processing is **WebGL2 fragment passes** (`gl.js`, `passes/*.glsl.js`) on the
generator's **own** offscreen context (never a display canvas's — the live renderer owns that).
WebGL2 over WebGPU because every pass is a per-pixel gather, and WebGL2 +
`EXT_color_buffer_float` reaches every browser the SDK targets. Gaussian emission and PLY
packing run in a **module Worker** (`ply-writer.js`, transferable buffers).

All rasters are on the **padded** domain (frame + 4 % border on each side).

1. **Normalise** (CPU, low-res): percentiles → d̂ ∈ [0,1]; the pivot seed is the median of the
   central box.
2. **Upsample** (`upsample`): joint-bilateral upsample of d̂ to the output raster with the RGB
   as guide (4×4 low-res taps, σs = 1 low-res px, σr = 0.08).
3. **Snap** (`snap`): where a 7×7 window spans more than 0.08 of d̂ (a real step — a ground plane
   moves ~0.002/px), each pixel goes to the nearer extreme. Kills the soft ramp a monocular net
   draws across a discontinuity, which unprojects as a rubber sheet ("flying pixels").
4. **Edges** (`edges`): far-side pixels of every discontinuity (a neighbour 1–2 px away nearer by
   more than τ = 0.04), with the direction the foreground lies in.
5. **Hidden mask** (`hidden`): a directional dilation *into the foreground* by
   `w = f · zp · tan15° · Δ(1/z)` px, as a gather over the four axes. Split by background side for
   the directional inpainting net: `maskRight` (background on the hole's right), `maskLeft`.
   Run twice: capped at 5 % (the band) and at 25 % (the backplate).
6. **Erode** (`erode`): separable min-filter of d̂, radius band + 2. A pixel nearer than its eroded
   value by more than τ is foreground-near-an-edge and may not seed the background.
7. **Fill** (`pushpull`): push-pull (Gortler '96) of colour and d̂ from the seeds (inside the
   frame, outside the wide mask, not foreground-near-an-edge) — the hidden layer's depth, its
   colour without a net, and the outpaint border.
8. **Matte** (`matte`): closed-form two-colour alpha on silhouette pixels (projection of the pixel
   onto the local background→foreground colour segment), 30 % toward a distance prior.
9. **Compose** (`compose`): layer 1's disparity is forced ≥ τ/2 *farther* than layer 0.
10. **Inpaint** (optional, CPU↔net): holes are **pre-filled with the push-pull colour** first —
    the light net passes much of a wide hole through, and a hole still holding the foreground
    came back as a copy of it — then `inpaintTwoSided` fills the band + border (≤ 1024×576 tiles
    are the inpainter's own business).
11. **Emit** (Worker): each Gaussian is a **surfel on the local tangent plane**: its in-plane axes
    are the 3D steps to the neighbouring pixels (one-sided, taking the smaller depth step so a
    discontinuity is never read as a slant; the depth part capped at 8 pixel footprints), σ =
    0.65 of that step, thickness 0.15 σ. Frontoparallel disks (`params.orient: false`) open into
    rows of gaps — concentric moiré rings on a floor — at ±15°; a cap of 3 footprints did too.

## Measured (MacBook, Apple GPU, Chrome headless `--use-angle=metal`, GPU idle, medium)

| photo | raster | splats (L0 + L1) | PLY | total | prep | upsample | mask | erode | fill | matte | readback | emit |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| office (indoor, cluttered) | 1022×574 | 908 k (587 k + 322 k) | 58.9 MiB | 492 ms | 83 | 14 | 6 | 3 | 11 | 6 | 68 | 310 |
| Big Sur Road | 1024×1024 | 1.29 M (1.05 M + 240 k) | 83.6 MiB | 587 ms | 67 | 19 | 5 | 2 | 8 | 4 | 116 | 371 |
| Sonoma (graphic) | 1024×622 | 744 k (637 k + 107 k) | 48.2 MiB | 666 ms | 140 | 33 | 8 | 5 | 16 | 12 | 145 | 365 |

Medians of 4 warm runs (the first run adds shader compile + Worker load, ~+200 ms). The GPU
passes are ~40 ms together; the cost is the CPU side: rasterising/reading the image (`prep`),
float readbacks, and the Worker's emission (~180 ms of pure JS for 0.9 M surfels in Node).
**With the inpainting net** (light_inpaint_v1 1024×576 fp16, onnxruntime-web WebGPU) add
**2.0–2.5 s** on the office photo: a padded 1104×620 raster is 4 tiles, and the two-sided pass
runs them twice.

PLY size is 68 B/splat — ~60 MB at medium. A viewer that keeps it should convert (SOG/SPZ).

## Known artefacts (from renders at −15°, 0°, +15°)

- **The orbit is large for this depth range.** 15° about a pivot at ~2 m moves the camera
  ~0.55 m; content at the 0.7 m near plane then shifts by up to ~38° — beyond the half-FOV — so
  the frame edge of near content swings into view as **black** (the 4 % border is far too small
  for that) and whole foreground objects slide a third of the frame. This is geometry, not a
  generator bug; the explore renderer should bound it (smaller angle, a nearer pivot, or a
  compressed depth range).
- **Band cap vs. reveal width.** On the office photo a full-strength edge needs a ~700 px band;
  the band stops at 5 % (51 px). Beyond it the half-res backplate shows **smooth, blurry
  background** (push-pull), which reads as a smear rather than a hole.
- **Inpainting net on wide masks.** The light net is trained for thin disocclusion bands; on the
  union of bands in a cluttered scene it hallucinates repetitive vertical stripes, and its
  texture meets the backplate's flat push-pull colour at a visible seam. On thin bands it is
  better than push-pull; on wide ones it is not obviously so.
- **Thin structures and mis-estimated depth** (lamp arm, paper sheets, chair slats) turn into
  streaks and shards at ±15° — monocular depth has them at the wrong depth, and the snap puts a
  1-px structure on one side or the other.
- **Slightly soft** at the neutral view (σ = 0.65 px Gaussians); the neutral view is otherwise
  the photo.

## Files

| file | what |
|---|---|
| `js/lift/gen/lift-gen.js` | `generateLift`, `LIFT_DEFAULTS`, `LIFT_QUALITY`, `normaliseDisparity` |
| `js/lift/gen/gl.js` | the WebGL2 pass runner |
| `js/lift/gen/passes/*.glsl.js` | the fragment passes (GLSL as JS strings) |
| `js/lift/gen/ply-writer.js` | surfel emission + PLY writer (module Worker), `parsePly` |
| `js/lift/gen/cpu-ref.js` | CPU references of edges / hidden mask / erosion |
| `samples/lift/dev-gen.html` | photo → depth → `generateLift` → every raster + the splat with an orbit slider |
| `test/lift-gen.test.mjs` | Node: PLY round trip + encodings, surfels, morphology on synthetic depth |
| `test/lift-gen-gpu.html` + `.run.mjs` | headless Chrome: GPU passes vs the CPU references (a mutated pass fails it) |

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
border: {x, y, left, right, top, bottom, needed}, depthRange: {near, far}, maxBandPx, backplatePx, inpainted, timings }`. `focalPx`,
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

- **Layer 0 — the visible surface.** One Gaussian per output pixel. Opacity 1 except a 1-px soft
  matte on foreground silhouettes, whose colour is un-mixed from the background behind it.
- **Layer 1 — the hidden background.** Only where the orbit can reveal it:
  - the **band** — full resolution, under each foreground silhouette, as wide as the background
    can slide out at the maximum orbit (15°), capped at **5 % of the width**; its colour comes
    from the inpainting net when one is supplied;
  - the **backplate** — the same hidden surface continued out to **25 % of the width** at
    **half resolution** with push-pull colour, so reveals wider than the band show smooth
    background instead of black;
  - an **outpainted border** round the frame, **sized per side to the orbit** (below): the first
    4 % at full resolution, the rest at half resolution. It sits at the depth of the frame pixel it
    continues (replicated), so it travels with that content, and its colour is the frame mirrored
    across its edge, fading into the push-pull colour.

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

All rasters are on the **padded** domain (frame + the outpaint border, per side).

0. **Border sizing** (CPU, low-res; `outpaintBorders`). The explore camera is an off-axis window
   camera — the window is the photo's frustum cut at the pivot zp, the eye moves on a cone of
   half-angle θ (the orbit cap) about the pivot, i.e. laterally by zp·tanθ — so a point at depth z
   lands f·tanθ·|1 − zp/z| px from where the photo has it. Per side: the 95th percentile of that over
   the edge strip, +10 %, clamped to [4 %, 12 % of W]. zp = min(central median, convergence) — the
   same rule as `meta.pivotZ`, computed up front.

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
7. **Far side** (`farside`, `farblur`). For every pixel, a walk along the four axes (1 px steps to
   32 px, then 2 px — an edge band is ≥ 2 px wide on its far side) out to 45 % of the frame for the
   first far-side edge whose foreground faces back toward it and whose background it is nearer than.
   That gives (a) whether the pixel is **foreground at all** — the whole object, not just the rim
   the band covers; (b) layer 1's **depth**: the found background disparities, those nearer than
   their median by > τ rejected, the rest weighted 1/dist² with the horizontal axes ×4 (yaw
   dominates, and what a horizontal move uncovers is the background continued horizontally); (c)
   layer 1's **colour**: the per-channel median of the background 2, 5 and 9 px past each of those
   edges (clear of the mixed pixel and of any glow the photo has round the object), same weights.
   `farblur` then smooths both with a radius of 0.5 × the distance to the edge (≤ 24 px): exact at the
   silhouette, where the orbit first reveals it, a smooth membrane deeper in.
8. **Fill** (`pushpull`): push-pull (Gortler '96) of colour and d̂ from the seeds (inside the
   frame, outside the wide mask, not foreground-near-an-edge, **not foreground per `farside`**) —
   layer 1 where `farside` found nothing, and the border's far colour.
9. **Matte** (`matte`): closed-form two-colour alpha on pixels with a background neighbour within
   **1 px** (projection of the pixel onto the local background→foreground colour segment, means over
   the 5×5 window), 20 % toward a 0.6 prior. The foreground colour is un-mixed, F = (c − (1−α)B)/α
   (pulled to the local foreground mean where α is small), and packed into the layer-0 raster.
10. **Compose** (`compose`): layer 1's disparity is forced ≥ τ/2 *farther* than layer 0.
11. **Inpaint** (optional, CPU↔net): holes are **pre-filled with the generator's own colour** first —
    the light net passes much of a wide hole through — then `inpaintTwoSided` fills the band +
    border. Off by default in `lift()` (see *Known artefacts*).
12. **Emit** (Worker): each Gaussian is a **surfel on the local tangent plane**: its in-plane axes
    are the 3D steps to the neighbouring pixels (one-sided, taking the smaller depth step so a
    discontinuity is never read as a slant; the depth part capped at **24** pixel footprints, **1.5**
    on a silhouette pixel), σ = 0.65 of that step, thickness 0.15 σ. Frontoparallel disks
    (`params.orient: false`) open into rows of gaps — concentric moiré rings on a floor — at ±15°; a
    cap of 3 footprints did too, and 8 left black cracks down steep depth ramps (a rock face the depth
    net fades into the sea). The silhouette cap keeps a limb's surfels from swinging out as a fringe.

## Measured (MacBook, Apple GPU, Chrome headless `--use-angle=metal`, GPU idle, medium)

`generateLift` alone on the same frozen MoGe-3 depth, baseline (`f43d338`) vs the quality pass,
medians of 5 warm runs, interleaved (ms):

| photo | splats (base → now) | total | prep | upsample | mask* | erode | fill | matte | readback | emit |
|---|---|---|---|---|---|---|---|---|---|---|
| office 1022×574 | 860 k → 905 k | 324 → **366** (+13 %) | 82 → 85 | 12 → 13 | 4.5 → 10.1 | 2.2 → 2.4 | 7.2 → 7.9 | 4.5 → 5.8 | 33 → 44 | 177 → 192 |
| Big Sur Road 1024² | 1.30 M → 1.40 M | 467 → **532** (+14 %) | 71 → 75 | 15 → 17 | 5.0 → 11.7 | 2.4 → 2.6 | 9.2 → 9.5 | 5.4 → 6.8 | 73 → 102 | 283 → 309 |
| Shore Rocks 1024² | 1.25 M → 1.34 M | 544 → **602** (+11 %) | 92 → 91 | 15 → 16 | 5.3 → 12.3 | 2.6 → 3.6 | 9.1 → 10.4 | 6.1 → 8.5 | 78 → 113 | 311 → 345 |

\* `mask` now includes `farside` + `farblur` (~6 ms). The rest of the increase is the bigger
padded raster (readback) and the border's extra splats (emit). The first run adds shader compile +
Worker load (~+200 ms). **With the inpainting net** (light_inpaint_v1 1024×576 fp16,
onnxruntime-web WebGPU) add **1.3–1.5 s**.

PLY size is 68 B/splat — ~60 MB at medium. A viewer that keeps it should convert (SOG/SPZ).

## Known artefacts (renders at −10°, 0°, +10° after the quality pass, 2026-09-25)

- **Fixed:** object-shaped ghosts behind foreground (a translucent second sphere / chair back /
  mountain wedge). They were the hidden layer, not layer 0: push-pull depth drifted toward near
  borders and, clamped to sit just behind the object, made a shell that swung out from under it;
  push-pull colour averaged the floor and frame border into the object-shaped hole, a shade off the
  background around it. Black strips at the frame edge on office / rocks / spheres. The 1–2 px
  semi-transparent silhouette band.
- **Residual: faint crescent** (~3/255) where the band meets a flat synthetic wall.
- **Residual: 1-px outline** at the old silhouette position where the photo has a glow round the
  object — those background-side mixed pixels are opaque layer 0.
- **Residual: streaks.** The far-side fill is an axis extrapolation: floor texture under a sphere
  stretches horizontally, and a cluttered room's deep hidden regions are blocky (rarely revealed).
- **Residual: dark sliver down a soft depth ramp** (rock → sea): no step ⇒ no edge ⇒ no hidden layer;
  the 24-footprint surfel cap narrows it (8 left a wide black crack) but does not close it.
- **Frame edge past the cap.** Metric depth with near ground at a frame edge can need far more than
  12 % of W (Big Sur Road: ~890 px at 15° against a 28 m pivot); black remains there. Raising the cap
  costs raster area (readback + emit) roughly linearly. Where the border's replicated depth changes
  between rows (a mountain against the sky at the frame edge) it shows as a hard-edged slab.
- **Inpainting net on wide masks.** With the new fill it no longer duplicates whole objects, but it
  still hallucinates texture that meets the fill at visible seams (a ragged streak under the Big Sur
  ridge) for +1.3–1.5 s; the net-free result is cleaner on every photo tried. Keep it off.
- **Thin structures and mis-estimated depth** (lamp arm, paper sheets, chair slats) still turn into
  shards at ±15° — monocular depth has them at the wrong depth.
- **Slightly soft** at the neutral view (σ = 0.65 px Gaussians); the neutral view is otherwise
  the photo.

## Files

| file | what |
|---|---|
| `js/lift/gen/lift-gen.js` | `generateLift`, `LIFT_DEFAULTS`, `LIFT_QUALITY`, `normaliseDisparity` |
| `js/lift/gen/gl.js` | the WebGL2 pass runner |
| `js/lift/gen/passes/*.glsl.js` | the fragment passes (GLSL as JS strings) |
| `js/lift/gen/ply-writer.js` | surfel emission + PLY writer (module Worker), `parsePly` |
| `js/lift/gen/cpu-ref.js` | CPU references of edges / hidden mask / erosion (not yet of `farside`) |
| `samples/lift/dev-gen.html` | photo → depth → `generateLift` → every raster + the splat with an orbit slider |
| `test/lift-gen.test.mjs` | Node: PLY round trip + encodings, surfels, morphology on synthetic depth |
| `test/lift-gen-gpu.html` + `.run.mjs` | headless Chrome: GPU passes vs the CPU references (a mutated pass fails it) |

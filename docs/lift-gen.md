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
border: {x, y, left, right, top, bottom, needed}, depthRange: {near, far}, maxBandPx, backplatePx, reveal: {h, v, hWeight}, inpainted, timings }`. `focalPx`,
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
  - the **backplate** — the same hidden surface continued at **half resolution** out to the widest
    reveal the depth range allows, 1.1 · f·zp·tanθ·(1/zNear − 1/zFar) px (never under 25 %, at most
    45 % of the width), so reveals wider than the band show background instead of black;
  - an **outpainted border** round the frame, **sized per side to the orbit** (below): the first
    4 % at full resolution, then half resolution, and beyond 12 % quarter resolution. It sits at the depth of the frame pixel it
    continues (replicated), so it travels with that content, and its colour is the frame mirrored
    across its edge, fading into the push-pull colour.
  - **behind a foreground edge**, the border holds two surfaces, like the frame: where the frame pixel
    it replicates is foreground over a background (a torso crossing the bottom of the frame), the
    edge's hidden layer (far-side depth + colour, replicated) goes into the backplate slot behind the
    continuation; on the top/bottom borders the continuation stops where its own parallax about the
    pivot does, and the far layer carries on alone. (Side borders keep the continuation: yaw's edge
    foreshortening sized them for it, and a farther surface there outran the border on the office.)

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

0. **Border sizing** (CPU, low-res; `outpaintBorders`). The explore orbit turns the scene by up to
   θ about the pivot (0, 0, zp) and views it through the photo's fixed window. Each frame-edge point
   (offset u_e from the centre, depth z) is turned by ±θ and projected; the border must cover how far
   it moves **inward**. (The small-angle f·tanθ·|1 − zp/z| misses the foreshortening of the edge
   itself: 290 px where the render moves 330 on a portrait against a far street.) Per side: the 95th
   percentile over the edge strip, +10 %, clamped to [4 %, 35 % of W], then all sides shrunk in
   proportion if the padded raster would exceed **2.1 · W²** (every pass, the readback and the emit
   scale with it). zp = min(central median, convergence) — the same rule as `meta.pivotZ`.

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
   `w = f · zp · tanθh · Δ(1/z)` px — θh the **reveal budget**, the drag orbit plus the viewer's own
   head/eye excursion (`revealAngles()`, *Panel follow-up* below; ≈ 20° on a portrait at 0.9 m), as a gather over the four axes (1 px steps to 32 px, then 2 px).
   Δ is the larger of the edge's own step and the pixel's (d − d_bg): a subject whose rim is soft in
   depth (hair, a rounded shoulder) is still far in front of the background inside it. Split by background side for
   the directional inpainting net: `maskRight` (background on the hole's right), `maskLeft`.
   Run twice: capped at 5 % (the band) and at 25 % (the backplate).
6. **Erode** (`erode`): separable min-filter of d̂, radius band + 2. A pixel nearer than its eroded
   value by more than τ is foreground-near-an-edge and may not seed the background.
7. **Far side** (`farside`, `farblur`). For every pixel, a walk along the four axes (1 px steps to
   32 px, then 2 px — an edge band is ≥ 2 px wide on its far side) out to 45 % of the frame over the
   far-side edges whose foreground faces back toward it and whose background it is nearer than, and
   takes, of those whose **reveal reaches it** ((d − d_bg)·f·zp·tanθ·Δ(1/z) ≥ distance), the one with
   the **farthest** background (none reaches: the farthest found). Taking the first edge stopped at
   internal edges (a sleeve over the torso) and gave layer 1 their near depth deep inside a big
   subject; it stayed under the subject while the street slid out, and the reveal opened black.
   That gives (a) whether the pixel is **foreground at all** — the whole object, not just the rim
   the band covers; (b) layer 1's **depth**: the found background disparities, those nearer than
   their median by > τ rejected, the rest weighted 1/dist² with the horizontal axes ×4 (yaw
   dominates, and what a horizontal move uncovers is the background continued horizontally — the factor is now
   derived from the rig, tan θh / tan θv, ≈ 3.4 on a portrait); (c)
   layer 1's **colour**: the per-channel median of the background 2, 5 and 9 px past each of those
   edges (clear of the mixed pixel and of any glow the photo has round the object), same weights.
   `farblur` then smooths both with a radius of 1 × the distance to the edge (≤ 48 px): exact at the
   silhouette, where the orbit first reveals it, a smooth membrane deeper in. Colour only across the
   same surface (|Δd̂| < τ); **depth across up to 0.15** — under a subject the axes switch column by
   column between a far street, a nearer hedge and the hair, and each switch kept as a step inside
   layer 1 opened as a thin vertical crack at the orbit.
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

**Coverage fix (2026-09-25, `tamarra2k.jpg`, a portrait at ~0.9 m against a street to ~30 m,
MoGe-3 medium).** Black at ±15° was two things, both generator-side, neither a splat budget (there
is none — every layer-1 texel is emitted): (a) the frame edge, where the border needed ~315 px
against a 123 px cap; (b) behind the subject, where layer 1 existed but at the depth of the first
internal edge, so it never slid out. Black pixels at −15°/0°/+15°: 18.0/0/20.2 % → 2.6/0/1.9 %.
Office and the synthetic clip unchanged or better; Big Sur Road's frame edge improves (its near
road still needs ~890 px). Warm `generateLift` (medians of interleaved runs): tamarra 407 → 461 ms
(+13 %, 1.06 → 1.13 M splats), Big Sur Road 489 → 517 ms (+6 %), office 341 → 342 ms.
Trade-off: one hidden surface per pixel, now the far one — the thin gap an internal edge opens at
orbit shows the far background, not the surface just behind the edge.

**Panel follow-up (2026-09-25, pass 2).** The panel still showed "holes in the back, behind the
subject, more uniform". Re-measured through the product path — `createExplore` fed the panel's
tracked eye PAIR (DisplayXR Browser 1.0.2 dump, `test/lift-dibr-math.test.mjs`), its median rest
head, drag ±15°, and head offsets — not a centred camera. Findings:

- The rig's **constant** vertical offset (eyes ~0.45 tile heights above the tile centre, `P9 ≈ −0.9`)
  **never reaches explore**: `createHeadTracker` subtracts its median rest pose, and explore builds
  its own off-axis frusta from the eye positions (never the runtime's projection). The panel pair at
  rest renders like the centred camera plus ±31.5 mm of stereo.
- What the panel saw were **cracks inside layer 1**: its depth switched column by column (street /
  hedge / hair) and each step opened a thin vertical tear at the orbit, in both eyes — "uniform".
  Fixed by the depth-smoothing in `farblur` (above).
- **Vertical** motion (pitch drag, head height) was the worst case per degree: the far background
  under a subject that crosses the bottom/top of the frame had to come from a border that held only
  the subject's continuation. Fixed by the two-surface border (above).
- Stereo eyes + tracked head **add** to the drag: the band is now sized for `revealAngles()`.

Black % of each view (`_scratch/coverage2/sheet.png`; "behind" = hole components not touching the
viewport edge, "edge" = the frame-edge strips, which this pass does not address), before → after:

| tamarra2k (portrait) | behind | edge |
|---|---|---|
| centred ±15° | 0.54 / 0.69 → **0.20 / 0.29** | 3.3 / 2.6 → 3.2 / 2.6 |
| panel pair −15° R eye / +15° L eye | 0.48 / 0.80 → **0.16 / 0.42** | 6.5 / 5.7 → 6.4 / 5.6 |
| +15° + head (+5, +10 cm), L eye | 1.32 → **0.43** | 2.1 → 1.1 |
| pitch −10° / +10° (L eye) | 1.93 / 1.49 → **0.35 / 0.04** | 0.2 / 0.1 → 0 / 0 |
| head −10 cm / +10 cm vertical (L eye) | 0.03 / 0.01 → 0.06 / 0.04 | 1.07 / 0.56 → **0.07 / 0.00** |

Office, Big Sur Road and the synthetic clip: behind and edge equal or lower in every case (office
behind 0.5–0.7 → 0.35–0.5 %; Big Sur Road's ridge reveal at +15° 0.74 → 0.39 %). Warm
`generateLift`, medians of 7 interleaved runs, same frozen depth: tamarra 483 → 471 ms (1.13 → 1.14 M
splats), office 337 → 362 ms (+7 %, 0.91 → 0.94 M), Big Sur Road 481 → 482 ms.

Remaining: the **frame-edge strip** at ±15° (the border's area budget; worse on the eye that sits
outward), the arm-over-torso gap that shows the far street, and short tears at the hair tips.

`params.viewerOffset` (`{x, y, z}` m) / `viewerIpd` / `revealMarginDeg` / `farHWeight` override the
rig assumptions; `lift()` passes them through `genParams` today, so the real rig's nominal excursion
can be fed from there.

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
  the 35 % cap / 2.1·W² area budget (Big Sur Road: ~890 px at 15° against a 28 m pivot); black
  remains there. Raster area costs readback + emit roughly linearly. Where the border's replicated depth changes
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
| `js/lift/gen/lift-gen.js` | `generateLift`, `LIFT_DEFAULTS`, `LIFT_QUALITY`, `normaliseDisparity`, `revealAngles` |
| `js/lift/gen/gl.js` | the WebGL2 pass runner |
| `js/lift/gen/passes/*.glsl.js` | the fragment passes (GLSL as JS strings) |
| `js/lift/gen/ply-writer.js` | surfel emission + PLY writer (module Worker), `parsePly` |
| `js/lift/gen/cpu-ref.js` | CPU references of edges / hidden mask / erosion (not yet of `farside`) |
| `samples/lift/dev-gen.html` | photo → depth → `generateLift` → every raster + the splat with an orbit slider |
| `test/lift-gen.test.mjs` | Node: PLY round trip + encodings, surfels, morphology on synthetic depth |
| `test/lift-gen-gpu.html` + `.run.mjs` | headless Chrome: GPU passes vs the CPU references (a mutated pass fails it) |

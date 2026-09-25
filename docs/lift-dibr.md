# Live DIBR (`js/lift/live-dibr.js`)

The render half of "Convert to 3D" (`lift`): a 2D frame plus a low-res **relative disparity** map,
rendered as one depth-image-based rendering per SDK view, straight into
`layer.getViewport(view)`. WebGL2, one layer, N views, 60 fps. Depth arrives at 364×210 or
518×294 at 10–15 fps; every `render()` reuses the last depth.

```js
import { createLiveDibr } from './js/lift/live-dibr.js'; // internal module; lift() is the public entry (@displayxr/inline3d/lift)
const dibr = createLiveDibr({ canvas, maxLayers: 1 });   // canvas = your addScene canvas
dibr.setSource(video);                                    // video | image | canvas | VideoFrame
onDepth = (f32, w, h) => dibr.setDepth({ data: f32, w, h, space: 'disparity' });
dibr.setParams({ depth: 1, convergence: 'auto', dilate: 2, edgeTaper: 0.03, stabilize: true });
wall.addScene(canvas, (views, layer) => dibr.render({ views, layer }));
```

`setDepth({reset:true})` on a scene cut drops the EMA state. `touchSource()` marks a canvas/image
source as changed (a playing video is re-uploaded on its own). `getStats()` returns frames,
depth updates, the live `lo/hi/convergence/qScale`, the source camera `cam` (`D0 = cam.z`), and CPU timings.

## The view → uniform mapping

The shader reads **only `view.projectionMatrix`**. The SDK's views are off-axis (Kooima) frusta
onto the display window, so the eye relative to the window can be read back from the matrix
(column-major, `P0=2n/(r-l)`, `P5=2n/(t-b)`, `P8=(r+l)/(r-l)`, `P9=(t+b)/(t-b)`):

| quantity (in window HEIGHTS, origin = window centre, +z toward viewer) | from P |
|---|---|
| `eye.x` | `-P8·P5 / (2·P0)` |
| `eye.y` | `-P9 / 2` |
| `eye.z` (distance to the glass) | `P5 / 2` |
| window aspect `A` | `P5 / P0` |

No `view.transform`, no `virtualDisplayHeight`, no rig assumption beyond "the near plane is
parallel to the window" (true for any display rig). Round trip is unit-tested
(`viewEye(kooimaProjection(e)) == e`).

**Relation to the RGBD player / LDI ray-marcher.** The player normalises the head by the IPD
(`facePos = cam/ipd`), then builds the output camera as focal `f2 = D(1 - facePos.z·invd)` and
off-axis skew `sk2 = -facePos.xy·invd / (1 - facePos.z·invd)` so the zero-parallax plane lands on
the screen. That skew/focal pair *is* the Kooima frustum; the runtime has already computed it into
`P8/P9` and `P0/P5`. So instead of re-deriving it we work in screen coordinates, where the viewport
already *is* the window:

* output pixel `p' = ((u-0.5)·A, v-0.5)` on the glass;
* the 2D frame is what a virtual **source camera `C`** saw through the window;
* a scene point has relative parallax `q = z/(C.z - z)` (0 on the glass, >0 in front), linear in
  disparity like the marcher's `invZ`;
* the ray from `eye` through `p'` reaches depth `z` at `r = eye + (p'-eye)(eye.z - z)/eye.z`, which
  `C` sees at `x_s = C + (r - C)(1+q)`.

For `eye.z == C.z` this collapses to **`x_s = p' + (eye - C).xy·q`** — the marcher's
`s1 = s2 + C.xy·invZ` with the convergence skew folded in, where the marcher's `C` is the eye's
offset *from the source camera*. The march steps `q` from near to far (32 coarse steps, 6 bisection
refinements — the marcher's halving), first surface hit wins. `q = 0` is the identity for every
eye and every `C`: content on the glass never moves.

### Where the source camera sits (the 1.0.2 panel bug)

**`C` = the centroid of this frame's eyes** (`sourceCamera()`), in all three axes. It used to be
`(0, 0, D0)` — on the tile's normal axis at the eyes' mean distance — which is only right for a tile
seen head-on. An inline tile never is: the runtime's nominal viewer sits ~0.1 m above the panel
centre, and the tile sits wherever the page put it. With `C` on the axis, the eyes' common offset
`ē = mean(eye) - C` became a parallax **shared by both views**, `ē.xy·q`: a whole-frame shear, far
content one way and near content the other, pinned to zero only in the border taper (the smear).

First real panel run (DisplayXR Browser 1.0.2, Leia SR 3840×2160, tile 800×450 CSS @ dpr 2.5 →
2×2000×1125 views). The dumped matrices decode (`viewEye`) to eyes at
`(-0.403, 0.442, 5.481)` / `(0.209, 0.456, 5.473)` tile heights — **0.45 tile heights above the
tile centre** (P9 ≈ -0.9), 0.61 apart. Rebuilding each matrix from that eye with the runtime's own
Kooima (`l/r/b/t = near·(±half - e)/e.z`, displayxr-common `dxr_display3d`) gives the dump back
to 1e-5, so the matrices and `viewEye` were right (no sign / half-height / y-down error) and no
skew is applied twice (the shader has no skew of its own: the viewport *is* the window). The
vertical offset alone gave far content (`q ≈ -0.6·qScale`) `0.45·0.046 = 2 %` of the tile height
of upward shift at the dump's pose, and proportionally more wherever the tile sat further below
the eyes (the panel capture showed ~8 %). Headless reproduction on the dev page
(`?eyeY=0.1&dist=0.55`, 720-px views, convergence on the rect):

| | far ground (x, y) px | near disc (x, y) px | rect at convergence |
|---|---|---|---|
| pre-fix, L / R | (-8, **-29**) / (8, **-29**) | (6.5, **22.5**) / (-6.5, **22.5**) | (0, 0) |
| fixed, L / R | (-9, 0) / (9, 0) | (6.5, 0) / (-6.5, 0) | (0, 0) |

(`y` top-down; the pre-fix vertical matched the prediction `E.y·q·H = -30 px`.) The verbatim panel
matrices (`?panel`) give the same picture: pre-fix -13 px far / +10 px near vertically, fixed 0
(±0.15 px from the ~0.007-tile-height head roll between the two eyes, which is real).

Note the flat-source test does **not** catch this: a constant-depth source at convergence is `q = 0`
everywhere, the identity for any `C`, so it passed (MAE 0) before the fix too. The shear only shows
with depth off the convergence plane.

**`lookAround`** (param, 0..1, default **0**). With `C` locked to the centroid, head motion gives
no motion parallax, only stereo (the eyes differ from `C` by ±IPD/2). `lookAround > 0` blends
`C.xy` toward an anchor that follows the centroid with a 1 s time constant (`LOOK_AROUND_TAU_S`), so
a head *move* gives transient look-around that re-centres instead of a permanent shear. `C.z` always
follows the viewer: forward/back motion is not turned into z-parallax.

**Parallax sign.** A right eye (`eye.x > C.x`) samples the source to the right of `p'` for `q > 0`,
so in-front content moves LEFT in the right view (crossed disparity), nearer content more; behind-
glass content moves right. Same as the RGBD player (`C.x = +facePos.x` for the right eye).

## Depth pipeline (CPU, at depth resolution)

1. `metric` → `1/z`; `disparity` passes through (relative, bigger = nearer).
2. **Foreground dilation**: separable max filter, radius `dilate` depth px. Pushes the depth edge
   out into the background colour so the edge ramp never smears foreground colour.
3. **Percentile normalisation**: 2nd–98th percentile (2048-bin histogram) → `lo/hi`, EMA decay 0.9.
   The shader maps `n = clamp((d-lo)/(hi-lo))`, so an EMA step changes two uniforms, not a texture.
4. **Auto-convergence**: median `n` over the centre 50%×50%, EMA 0.9; a number 0..1 overrides it.
5. Upload as `R16F` (bilinear) — `texSubImage2D` of the Float32Array, ~0.1 ms.

`dilate` changes re-run steps 2–5 on the last map. Measured 1.9 ms per update at 364×210 (steady
state; first call ~8 ms JIT). At 12 fps that is ~2% of a core.

## Shader details

* **Disparity** per pixel: `q = qScale·(n - conv)·taper`, `qScale = budget·depth·A / (κ·C.z)`,
  `κ = 0.063/0.6` (nominal IPD/distance). With this, the nominal eye pair sees **`budget·depth` of
  the width** between `n=0` and `n=1` (default `budget = 0.025`, i.e. ≈ 32 px across the full range
  at 1280 px). A tracked eye further out gets proportionally more; a multiview fan gets what its
  view spacing implies.
* **Border taper**: `q → 0` over `edgeTaper` of the width (distance measured in width units on both
  axes), so the frame border sits on the glass and never tears.
* **Disocclusion** (gather form of iw3 `shift_fill`): probe `q` two depth texels either side of the
  hit along the parallax direction. A large jump **and** a hit on the ramp (not on the foreground
  plateau) means a hole: move the colour sample toward the lower-`q` (background) side by the hole
  width `|eye.xy - C.xy|·Δq`, and blend a 3-tap blur along that line. The move is proportional to
  `|eye.xy - C.xy|`, so the neutral view is never touched.
* Output is opaque (`alpha = 1`); the source is stretched to the viewport (size the canvas to the
  source aspect).

## Parameters

| param | default | meaning |
|---|---|---|
| `depth` | 1 | gain on the disparity budget |
| `convergence` | `'auto'` | normalised disparity placed on the glass (`auto` = EMA'd centre median) |
| `dilate` | 2 | foreground max-filter radius, depth px |
| `edgeTaper` | 0.03 | border fade of disparity, fraction of width |
| `stabilize` | true | EMA on range + convergence (false = per-frame values) |
| `budget` | 0.025 | total near–far disparity for the nominal pair, fraction of width |
| `steps` | 32 | coarse march steps (4–64) |
| `lookAround` | 0 | 0 = source camera on the eye centroid (stereo only); >0 = transient head-motion parallax |
| `loPct`/`hiPct`/`ema` | 0.02/0.98/0.9 | normalisation |
| `convMode` / `convBand` | `'mean'` / 0.05 | auto-convergence statistic (Gaussian centre mean; `'median'` = ≤ 1.0.x) and its dead band |
| `upsample` | true | joint-bilateral upsample of the depth to video res (long side ≤ `upsampleMax` 1280), guided by the frame |
| `snap` / `snapCore` / `snapRadius` / `snapTau` | true / 4 / 8 / 0.12 | edge snap (px at 364 wide, scaled with the depth width; radius ≤ 12) |
| `dilateHi` | 0 | max filter after the upsample, upsampled px |
| `debug` | 0 | 1 = draw the normalised disparity |

## Live-quality pass (2026-09-25): edge-aware upsample, edge snap, stable convergence

Measured offline on three real VP9 clips (a football close-up, a webcam talking head, a 12 s film
trailer segment with 7 cuts) through the real VDA-S streaming provider at the live cadence, with
each depth map held for the live latency (display frame = depth frame + 1.5 × period).
Harness: `samples/lift/dev-livequality.html` driven by `test/lift-livequality.run.mjs`.

**What the depth actually gets wrong.** VDA-S silhouettes are FAT: the foreground edge sits
3–5 depth px (≈ 10–15 px at 1280) outside the person even with zero latency, and the live latency
adds the subject's motion on top. That band of background carried at foreground depth is the
halo that rides with people; bilinear sampling of a 364×210 map adds a ramp on top.

* **JBU pre-pass** (Kopf 4×4, sigma_s 1 depth px, sigma_r 0.1 RGB) into an R16F raster at video res,
  once per new frame or depth: sharpens the ramp but can only move an edge ±1.5 depth px.
* **Edge snap** in the same pass: within `snapCore` of a network edge (min-/max-filtered maps
  disagree), re-decide the pixel by colour against the foreground CORE (still foreground after a
  min filter of radius `snapCore`) and background CORE colour means (two-colour matte, 20 % prior
  toward the network), Gaussian-weighted with a radial fade so nothing steps at texel lines. Falls
  back to JBU where the two colours are too close or a core is missing. `snapCore` 3 speckles, 5
  leaves a sliver ring; 4 hugs the head (see `_scratch` sheets).
* **Convergence**: the centre MEDIAN flips between the modes of a bimodal centre (0.05 ↔ 0.9 on the
  football clip) and the EMA turned that into a whole-scene depth sweep every 1–2 s. Gaussian centre
  MEAN + a 0.05 dead band: mean |Δconv| per update 0.028 → 0.003 (football), 0.020 → 0.007
  (trailer). A slower EMA (0.95/0.97) buys little more and slows cut recovery; `ema` stays 0.9.
* **Scene cuts** (`depth-ort.js`, `sceneCut`): 64×36 thumbnail mean |ΔRGB| > 0.12 between depth
  frames drops the VDA temporal cache before the frame and returns `reset:true` (the normaliser
  resets). All 7 ffmpeg `scene>0.3` cuts of the trailer segment scored 0.13–0.24; in-shot p90
  0.07–0.09 at 13 Hz. A luma histogram missed 4 of 7. Known: at medium's ~7 Hz the frame gap is
  twice as long and fast motion trips it (8 false cuts on the football clip).

Edge alignment (depth-gradient-weighted image gradient / mean image gradient; higher = depth
edges on image edges), depth held for the latency:

| clip | bilinear (before) | JBU | JBU + snap |
|---|---|---|---|
| football | 1.46 | 1.86 | **2.71** |
| webcam | 6.68 | 9.48 | **10.35** |
| trailer | 1.91 | 2.52 | **2.96** |

GPU (M1 Pro, 2 views 1280×720 + frame upload, per new video frame): bilinear 1.00 ms, +JBU
1.25 ms, +JBU+snap 1.83 ms (364×210) / 2.11–2.21 ms (518×294). Neutral view MAE stays 0.000003/255.

**Tier.** With the snap, 518×294 at ~7 Hz scores at best equal to 364×210 at ~13 Hz (football
2.59 vs 2.71, trailer 2.65 vs 2.96 lagged; equal on the static webcam), because its latency is
double. `quality:'auto'` therefore keeps its 90 ms drop threshold (low on M1 Pro and the
5070-class laptop); making auto prefer medium up to ~170 ms is NOT supported by these clips.
**Latency is now the largest remaining error**: the same metric with zero latency is 3.60
(football) / 3.50 (trailer) vs 2.71 / 2.96 lagged — delaying the displayed frame to match its
depth (a GPU frame ring) is the next lever, not resolution. `dilate` stays 0 in `lift()`: the
snap removes the halo that dilation would widen; `dilateHi` exists for experiments.

## Verification (`samples/lift/dev-dibr.html`)

The dev page plays `test/lift-dibr-clip.mp4` (synthetic 1280×720 60 fps, 4 s loop, encoded by
`node test/lift-dibr-make-clip.mjs` from `test/lift-dibr-scene.mjs`) and feeds the **analytic**
disparity of the same scene at 364×210, 12 fps. With a DisplayXR session it weaves via
`createInline3D` + `addScene`; otherwise it renders simulated Kooima eyes side by side
(`?views=N`, `?eye=spacing-in-IPDs`; off-axis viewer `?eyeY=0.1&dist=0.55[&eyeX=][&tileH=]` in
metres, or `?panel` for the two matrices dumped on the 1.0.2 panel run). Off-axis, `?check` adds:
flat source at convergence = source in both eyes (MAE < 1/255), and with convergence on the rect:
rect still, disc and far ground moving opposite ways horizontally, nothing moving vertically. `?check` runs the checks at load (`&hold` keeps the checked
frame on screen); results land in `window.__dibr.results`.

Headless Chrome (puppeteer-core, `--use-angle=metal`), M1 Pro, 2026-09-24:

| check | result |
|---|---|
| neutral view (eye on axis) vs the source frame, 1280×720 | **MAE 0.000003/255**, max 1/255 (pass < 3) |
| near disc (d=0.9) R−L shift | **−22.05 px** (predicted −22.04) |
| mid rectangle (d=0.6) R−L shift | −11.6 px (predicted −9.1; centroid biased by the disc occluding it) |
| sign | nearer ⇒ more crossed (negative) shift ✓ |
| GPU, 1 view 1280×720, 32 steps | **0.62–0.75 ms** (8 steps 0.28, 64 steps 1.06) |
| 2 views + 720p video upload | 2.1 ms / frame |
| live rAF loop, 2×1280×720, depth @12 fps | 60.3 fps, p95 frame 17–18 ms, 0.7 ms CPU/frame |

**Benchmark trap:** repeatedly drawing opaque full-viewport passes into the same tiles on Apple
GPUs lets tile-based hidden-surface removal cull all but the last draw, which read as 0.03 ms/view.
The page clears between iterations to defeat it.

Not verified here: a real DisplayXR session / Leia SR weave, estimated (non-ground-truth) depth,
and `maxLayers > 1` (throws).

Unit tests: `node --test test/lift-dibr-math.test.mjs` (percentiles, EMA/reset, centre median,
dilation, metric→disparity, projection round trip, budget scaling, and — on the verbatim panel
matrices — Kooima reconstruction, source-camera placement, q=0 identity, near/far opposite and
level, plus a regression pinning the pre-fix shear). `srcUvRef()` is the JS mirror of the shader's
`srcUv()`; the dev page's `?check` pins the GPU against the same invariants.

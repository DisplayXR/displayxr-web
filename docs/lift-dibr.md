# Live DIBR (`js/lift/live-dibr.js`)

The render half of "Convert to 3D" (`lift`): a 2D frame plus a low-res **relative disparity** map,
rendered as one depth-image-based rendering per SDK view, straight into
`layer.getViewport(view)`. WebGL2, one layer, N views, 60 fps. Depth arrives at 364×210 or
518×294 at 10–15 fps; every `render()` reuses the last depth.

```js
import { createLiveDibr } from '@displayxr/inline3d/js/lift/live-dibr.js'; // path, not yet an export
const dibr = createLiveDibr({ canvas, maxLayers: 1 });   // canvas = your addScene canvas
dibr.setSource(video);                                    // video | image | canvas | VideoFrame
onDepth = (f32, w, h) => dibr.setDepth({ data: f32, w, h, space: 'disparity' });
dibr.setParams({ depth: 1, convergence: 'auto', dilate: 2, edgeTaper: 0.03, stabilize: true });
wall.addScene(canvas, (views, layer) => dibr.render({ views, layer }));
```

`setDepth({reset:true})` on a scene cut drops the EMA state. `touchSource()` marks a canvas/image
source as changed (a playing video is re-uploaded on its own). `getStats()` returns frames,
depth updates, the live `lo/hi/convergence/qScale/D0`, and CPU timings.

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
* a scene point has relative parallax `q = z/(D0 - z)` (0 on the glass, >0 in front), linear in
  disparity like the marcher's `invZ`;
* the ray from `eye` through `p'` reaches depth `z` at `r = eye + (p'-eye)(eye.z - z)/eye.z`, which
  the virtual source camera (centred, distance `D0`) sees at `x_s = r·(1+q)`.

For `eye.z == D0` this collapses to `x_s = p' + eye.xy·q` — the marcher's
`s1 = s2 + C.xy·invZ` with the convergence skew folded in. The march steps `q` from near to far
(32 coarse steps, 6 bisection refinements — the marcher's halving), first surface hit wins.

`D0` = the mean `eye.z` of the frame's views, so a centred eye is exactly the identity (neutral view
reproduces the source) and head motion gives lateral parallax. **Forward/back head motion is not
turned into z-parallax** (the source camera follows the viewer's distance); the general
`eye.z != D0` formula is in the shader if that is wanted later.

**Parallax sign.** A right eye (`eye.x > 0`) samples the source to the right of `p'` for `q > 0`,
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

* **Disparity** per pixel: `q = qScale·(n - conv)·taper`, `qScale = budget·depth·A / (κ·D0)`,
  `κ = 0.063/0.6` (nominal IPD/distance). With this, the nominal eye pair sees **`budget·depth` of
  the width** between `n=0` and `n=1` (default `budget = 0.025`, i.e. ≈ 32 px across the full range
  at 1280 px). A tracked eye further out gets proportionally more; a multiview fan gets what its
  view spacing implies.
* **Border taper**: `q → 0` over `edgeTaper` of the width (distance measured in width units on both
  axes), so the frame border sits on the glass and never tears.
* **Disocclusion** (gather form of iw3 `shift_fill`): probe `q` two depth texels either side of the
  hit along the parallax direction. A large jump **and** a hit on the ramp (not on the foreground
  plateau) means a hole: move the colour sample toward the lower-`q` (background) side by the hole
  width `|eye.xy|·Δq`, and blend a 3-tap blur along that line. The move is proportional to
  `|eye.xy|`, so the neutral view is never touched.
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
| `loPct`/`hiPct`/`ema` | 0.02/0.98/0.9 | normalisation |

## Verification (`samples/lift/dev-dibr.html`)

The dev page plays `test/lift-dibr-clip.mp4` (synthetic 1280×720 60 fps, 4 s loop, encoded by
`node test/lift-dibr-make-clip.mjs` from `test/lift-dibr-scene.mjs`) and feeds the **analytic**
disparity of the same scene at 364×210, 12 fps. With a DisplayXR session it weaves via
`createInline3D` + `addScene`; otherwise it renders simulated Kooima eyes side by side
(`?views=N`, `?eye=spacing-in-IPDs`). `?check` runs the checks at load (`&hold` keeps the checked
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
dilation, metric→disparity, projection round trip, budget scaling).

# The PlayCanvas splat backend (the `addSplat` default since 1.8)

Status: **preview** (the `./splat` tier — see [sdk-stability.md](sdk-stability.md)). Epic
[#36](https://github.com/DisplayXR/displayxr-web/issues/36). The design and the P0 spike that
justified it are in `docs/playcanvas-backend.md` (PR #37).

```js
import { addSplat } from '@displayxr/inline3d/splat';
const h = addSplat(wall, canvas, bytesOrUrl);                     // PlayCanvas (default)
const s = addSplat(wall, canvas, bytesOrUrl, { engine: 'spark' }); // three + Spark, the kill switch
```

- **Default, with a kill switch.** No `engine` → PlayCanvas. `engine: 'spark'` is three + Spark
  as in 1.7. `./splat` itself imports no renderer; each backend is a literal dynamic `import()`, so
  a page fetches only the engine it renders with.
- **Peer:** `playcanvas >=2.22.3 <3`, optional. Or hand the module in: `{ playcanvas: pc }`. If it
  is missing, a default page falls back to Spark with one warning when Spark's peers resolve;
  otherwise `ready` rejects saying what to install. An explicit `engine: 'playcanvas'` never falls
  back.
- **Formats:** `.sog` (bytes or URL), `.ply`, and a Streamed-SOG `lod-meta.json` URL. `.spz`,
  `.splat` and `.ksplat` are Spark-only: `addSplat` **throws at call time** on the PlayCanvas
  engine when it can tell (a URL extension, gzip bytes, a Spark-only `fileType`).
- **Extra options:** `preserveDrawingBuffer` (default false; the weave's zero-copy read race on
  large canvases, browser-pvt#24), `orbitMaxDeg` / `orbitEase`, and `captureFit` (both backends).

## How it is built

One `AppBase` per tile on our own WebGL2 device (`xrCompatible: false`, no `XrManager`, no
mouse/keyboard/touch). One camera renders every view: its `camera.xrViews` is a list of
`RenderView`s, one per runtime view, with the view's projection, pose and pixel viewport, which is
the engine's own WebXR stereo path driven without WebXR. That means one gsplat manager, one sort
and one work buffer per frame for all eyes. The engine's `requestAnimationFrame` is a no-op, and
`app.tick()` runs from the wall's frame callback in 3D and from the SDK's own rAF in mono.

The subject does not move; the eyes do. The camera's parent node carries the **inverse** of the
same pivot SceneViewer puts on the content (orbit centre, pitch·yaw, fit × zoom, −focus).
`RenderView` composes the parent into every view, so the picture is identical: view × model is
the same product. This module's tick is the only writer of that node, which keeps the 1.7
ownership rule.

Two engine shader chunks are rewritten after `app.init`, each behind a whitespace-agnostic regex
anchor that warns once and renders unpatched if the engine moves the line:

1. **`gsplatCornerVS` footprint fix** (always on). The engine derives one focal length from the
   viewport *width* and uses it for both axes. A side-by-side eye is half-width over a full-height
   frustum, so without the fix every splat is drawn at half height. The fix uses
   `viewport_size.y · P[1][1]` for y. It is a no-op on square pixels. Upstream: P4d.
2. **`gsplatCommonVS` quad extent** (only when a `perf` preset shrinks the quad). This is Spark's
   `maxStdDev`.

## `perf` on this engine

| Spark knob | engine | note |
|---|---|---|
| `alphaRadius` | always on | the engine already cuts each quad at its own alpha radius (`clipCorner`) |
| `minAlpha` | `scene.gsplat.alphaClipForward` | engine default is already 1/255 |
| `maxStdDev` | `gsplatCommonVS` override | only ever shrinks, down from √8σ |
| `minPixelRadius` | `scene.gsplat.minPixelSize` = 2 × r | the engine compares a quad *diameter* |
| `lod*`, `maxPixelRadius`, `falloff`, `alphaFloor` | none | named once in a warning, then ignored |
| (engine-native) `splatBudget`, `minPixelSize`, `alphaClipForward`, `antiAlias` | passed through | win over the mapping |

**The one default changed is `minPixelSize`.** The engine default is 2 px; Spark keeps sub-2px
splats. So every `perf` value except `false` starts from 0. **`perf: false` is the kill switch:**
engine defaults, untouched. `splatBudget` is a no-op on a flat `.sog`: 1,179,648 of 1,179,648
drawn at a 600k budget. It only acts on Streamed SOG (P2).

## Divergences from the Spark path

What is left after 1.8's parity pass. Everything else is the same option, the same method and the
same numbers: the viewer constants are shared, and a side-by-side trace test pins SceneViewer and
the PlayCanvas viewer bit-identical through fit, focus easing, wheel, clamps, idle spin, `setPose`
and `resetPose`.

- **The orbit drag is tilt-and-relax, by design.** The drag is a fraction of the tile, measured
  from the press, and capped at ±`orbitMaxDeg` (15°). It eases with τ = 0.2 s and relaxes back to
  rest with τ = 0.6 s on release. SceneViewer (Spark) still turns cumulatively (a full-width drag
  = 180°). The constants are shared, so switching Spark over later is a one-line change.
- **`handle.viewer` is a `PlayCanvasSplatViewer`.** It has the same pose surface and constants,
  but it is **not** field-compatible with SceneViewer: pages that write SceneViewer's private
  fields (`_targetYaw`, `_fitScale`, `_eye`, `monoCamera`, …) need a path for this backend.
  `handle.engine` is the supported way in.
- **`mesh`** is `{ numSplats, entity, asset, resource }`, not a Spark `SplatMesh`. There is no
  `spark` field.
- **`pick`** is the exact nearest gaussian CENTRE to the ray over the full centre set, not a
  surface raycast (Spark tries its raycast first). On a Streamed SOG it runs over the resident
  chunks only.
- **`setSource`** is PlayCanvas-only; on Spark it throws.
- **`sortIntervalMs` is a no-op**: the engine re-sorts on camera rotation, with one directional
  sort for every view.
- **URL `.sog` gets its `camera` block** (the engine keeps unknown `meta.json` keys). On Spark,
  only the bytes path can read it.
- **Streamed SOG** is framed from the octree's root bound (raw min/max) and has no cloud pass, so a
  block without intrinsics falls to the 28 mm lens and the nearest-clump rung cannot run. The rest
  of streaming is P2.
- **Memory:** the cloud pass copies a strided ≤200k-splat sample (about 3.1 MB on the 1.18M bench
  asset) and drops it after `ready`. The exact pick keeps one opacity byte per splat (1.18 MB)
  and reads the engine's own centre array at pick time.
- **Engine hygiene** (not user-visible, recorded because each one bit when it was absent):
  - The canvas CSS is never touched: no `setCanvasFillMode` / `setCanvasResolution`.
  - Every `Entity` is built with its tile's `app`, not the engine's global one.
  - `setSource` disables the old splat and destroys and unloads it a few frames later; tearing it
    down in the same frame throws inside the engine.

## Gates (P1)

Measured in headless Chrome 153 on the real GPU (`ANGLE Metal, Apple M1 Pro`), with the
`ports_100_cam.sog` bench asset (1,179,648 gaussians, v2 camera block) on a plain SDK page loading
bytes. Reference: the source left photograph, 1280×720. Grey MAE /255.

| rest view (mono, camera rig from the block) | MAE vs photo |
|---|---|
| Spark (`engine` unset) | 2.94 |
| **PlayCanvas** | **2.25** |
| PlayCanvas vs Spark directly | 1.49 |

Display rig, PlayCanvas vs Spark directly: `ports_25.sog` 0.79, `ports_100_cam.sog`
(`rig:'display'`) 0.53.

Synthetic stereo, with the SDK's real 3D path driven by a stand-in wall: two views of the capture
camera at ±32 mm and ±0.02 NDC skew, on a 2560×720 SBS buffer. PlayCanvas vs Spark directly:
**1.14**, with the footprint fix on. The unfixed engine was not re-run here; the P0 spike measured
11.5 without the fix, against a square-pixel reference.

Several PlayCanvas tiles on one page each render their own splat (checked with 4 tiles, mixed
camera and display rigs). A page that never passes `engine` makes **0** `playcanvas` requests.

### GPU time per frame

`EXT_disjoint_timer_query_webgl2`, `TIME_ELAPSED` around exactly one config's frame per rAF. The rest
pose is pinned, the asset is `ports_100_cam.sog` (1,179,648 gaussians), DPR is 1, 60 warm-up frames,
then 300 measured frames. Values are median / p90 in ms, headless Chrome 153 on the real GPU (ANGLE
Metal, Apple M1 Pro), idle machine.

**Each config is loaded ALONE, one page load per config, in one Chrome process** (`parity/perf_solo.mjs`).
An earlier interleaved run (several canvases in one page, alternating frames) was NOT usable: on
ANGLE-Metal a context's timer query absorbs other contexts' in-flight GPU work — PlayCanvas read
27–50 ms paired with a Spark tile and 6.5–15 ms paired with another PlayCanvas tile. Interleaving
still guards against clock drift between processes; a solo load in one process guards against both.

| config | 720p | 1080p |
|---|---|---|
| Spark `exact` | 60.5 / 66.2 | 75.4 / 80.7 |
| Spark `balanced` | 51.8 / 56.0 | 64.5 / 72.7 |
| PlayCanvas default (`minPixelSize` 0) | 7.4 / 9.5 | 10.0 / 10.5 |
| PlayCanvas `balanced` (quad √6σ) | 7.1 / 9.5 | 9.1 / 9.9 |
| PlayCanvas `splatBudget` 600k | 7.4 / 9.7 | — |
| **stereo**, 2 views, SBS (2560×720 / 3840×1080): Spark `exact` | 120.0 / 136.0 | 162.7 / 179.0 |
| **stereo**, 2 views, SBS: PlayCanvas default | 12.7 / 13.2 | 35.5 / 38.4 |

- `gsplatCount` is 1,179,648 in every PlayCanvas row, **600k budget included**: the budget does
  nothing on a flat `.sog` (no LOD levels to trade), and its time matches the default within noise.
  The budget is a P2 (Streamed SOG) lever.
- On this photo-lift asset the PlayCanvas quad path is ~8× cheaper than Spark in mono and ~5–9×
  in stereo. Both engines pay ~2× for two views here. Treat the table as ranking + order of
  magnitude on one GPU; re-check on the Windows box.
- Every drawn frame was checked non-empty (mean canvas luminance ~123) in every row.

**Wall-clock check (the honest number).** The timer query above OVERSTATES Spark: measured by rAF
cadence on the same page, alone on an idle GPU (two repeats each, vsync on, 6 s windows):

| config | rAF Hz | ms/frame |
|---|---|---|
| Spark `exact`, mono 1280×720 | 35.5 | 28.2 |
| PlayCanvas default, mono | 60.2 (vsync cap) | ≤ 16.6 |
| Spark `exact`, 2-view SBS 2560×720 | 17.0–17.2 | 58.3–58.8 |
| PlayCanvas default, 2-view SBS | 59.0–60.2 (vsync cap) | ≤ 16.6–17.0 |

So on this asset the stereo ratio is **at least 3.5×** (Spark 58 ms vs PlayCanvas at the cap; the
timer query puts PlayCanvas near 13 ms, i.e. ~4.5×), and mono at least 1.7×. Quote these, not the
timer-query ratios. Why the query overstates Spark is not established (its bracket likely spans
Spark's sort readback pipeline); the PlayCanvas query values are consistent with the cadence.

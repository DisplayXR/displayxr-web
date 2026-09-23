# The PlayCanvas splat backend (`engine: 'playcanvas'`)

Status: **preview** (the `./splat` tier — see [sdk-stability.md](sdk-stability.md)). Epic
[#36](https://github.com/DisplayXR/displayxr-web/issues/36), phase P1. The design and the P0
spike that justified it are in `docs/playcanvas-backend.md` (PR #37).

```js
import { addSplat } from '@displayxr/inline3d/splat';
const h = addSplat(wall, canvas, bytesOrUrl, { engine: 'playcanvas' });   // same handle as Spark
```

- **Opt-in only.** No `engine` (or `engine: 'spark'`) is the three + Spark path, unchanged. A page
  that never asks never resolves `playcanvas`: `./splat` imports the adapter with a literal dynamic
  `import('./inline3d-splat-playcanvas.js')`, and the adapter imports the engine the same way.
- **Peer:** `playcanvas >=2.22.3 <3`, optional. Or hand the module in: `{ playcanvas: pc }`.
- **Formats:** `.sog` (bytes or URL), `.ply`, and a Streamed-SOG `lod-meta.json` URL. `.spz`,
  `.splat` and `.ksplat` stay Spark-only and reject `ready` with a message saying so.
- **Extra option:** `preserveDrawingBuffer` (default false), the knob for the weave's zero-copy
  read race on large canvases (browser-pvt#24).

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

- **No SceneViewer.** `handle.viewer` is a `PlayCanvasSplatViewer` with the same pose surface
  (`idleSpin`, `setPose`/`getPose`/`resetPose`, `setFocus`/`getFocus`, `fitTo`,
  `getSubjectBounds`, `depthOffset`, `is3D`) and the same constants. It is **not**
  field-compatible, though. Pages that write SceneViewer's private fields (`_targetYaw`,
  `_fitScale`, `_eye`, `monoCamera`, …) need their own path for this engine. P1 deliberately does
  not refactor SceneViewer into a shared controller.
- **`viewer` arrives one module-load late.** The handle is returned synchronously. Calls made
  before the adapter loads (`exclude`, `setPose`, `setFocus`, `remove`) are queued and replayed
  on the same object. Fields are null until then.
- **`mesh`** is `{ numSplats, entity, asset, resource }`, not a Spark `SplatMesh`. There is no
  `spark` field.
- **`getFocus()` and `onFocusChange`** exist on the handle, in the splat's own space. On Spark
  they live only on the viewer, in content space.
- **`pick`** is always the nearest-centre-to-ray fallback (a strided, opacity-filtered centre
  set, like Spark's fallback). There is no surface raycast; the engine's GPU picker is not used
  yet.
- **URL `.sog` gets its `camera` block.** The engine keeps unknown `meta.json` keys, so the URL
  path now reads `resource.gsplatData.meta.camera` (and a Streamed SOG's top-level `camera` in
  `lod-meta.json`). On Spark, only the bytes path can read it.
- **Opacities for the cloud pass** are read back from the SOG `sh0` plane (one GPU readback at
  load). On a `.ply` they come from the `opacity` property.
- **`feather` is not implemented** (it warns once). **`sortIntervalMs` is ignored**: the engine
  re-sorts on camera rotation, one directional sort for all views.
- **`./splat` still imports three and Spark statically**, so a PlayCanvas-only page still needs
  them resolvable. The adapter module itself imports neither. A three-free entry point is a
  small follow-up.
- **The canvas CSS is never touched.** The adapter does not call `setCanvasFillMode` or
  `setCanvasResolution`. Without explicit sizes, both write the canvas: a NaN buffer width, which
  becomes 0, and an inline `style.width`. `RESOLUTION_FIXED` is `AppBase`'s default, and that is
  relied on instead.
- **Every engine `Entity` is constructed with its tile's `app`.** The engine defaults to a global
  "current app". With two tiles on a page, that silently put the first tile's splat in the second
  tile's scene, and the first tile rendered nothing. This was found by running two tiles.

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

`EXT_disjoint_timer_query_webgl2`, `TIME_ELAPSED` around exactly one config's frame per rAF. All
configs are interleaved in one page and one Chrome process. The rest pose is pinned, the asset is
`ports_100_cam.sog`, DPR is 1, there are 60 warm-up frames, then 300 measured frames per config.
Values are median / p90 in ms. There are two repeats (r1, r2).

**Read this first: the absolute numbers are noisy.** The M1 Pro was shared with other sessions'
headless-Chrome GPU benchmarks throughout. More importantly, on ANGLE-Metal a context's timer
**absorbs other contexts' in-flight GPU work**. Paired with a Spark tile, PlayCanvas read
27–50 ms; paired with another PlayCanvas tile, the same config read 6.5–15 ms. So the table
compares within one engine, from same-engine pairs. The cross-engine ordering is consistent in
every pairing, but its ratio is not a clean number.

| config | 720p r1 | 720p r2 | 1080p r1 | 1080p r2 |
|---|---|---|---|---|
| Spark `exact` (paired with Spark `balanced`) | 44.6 / 52.9 | 58.1 / 138.1 | 73.5 / 168.9 | 63.9 / 78.3 |
| Spark `balanced` | 45.7 / 55.7 | 57.3 / 134.4 | 73.2 / 182.3 | 63.4 / 76.8 |
| PlayCanvas default (`minPixelSize` 0), paired with PlayCanvas `balanced` | 9.8 / 12.7 | 8.9 / 11.9 | 14.9 / 23.9 | 11.0 / 12.1 |
| PlayCanvas `balanced` (quad √6σ) | 8.8 / 11.5 | 8.0 / 11.1 | 14.5 / 22.6 | 9.5 / 10.8 |
| PlayCanvas `splatBudget` 600k (paired with the default) | 9.35 vs 9.23 | 12.13 vs 12.23 | 10.24 vs 10.25 | 16.36 vs 16.94 |
| **stereo**, 2 views, SBS: Spark `exact` vs its mono | 85.9 vs 78.8 | 85.0 vs 78.8 | 150.1 vs 127.8 | 119.2 vs 115.0 |
| **stereo**, 2 views, SBS: PlayCanvas default vs its mono | 13.3 vs 6.7 | 13.1 vs 6.5 | 20.9 vs 10.9 | 19.8 vs 10.0 |

- `gsplatCount` is 1,179,648 in every PlayCanvas row, **600k budget included**: the budget does
  nothing on a flat `.sog` (no LOD levels to trade), and its times match the default within noise.
  The budget is a P2 (Streamed SOG) lever.
- PlayCanvas stereo costs about 2× its mono (every view composites every splat). Spark stereo
  costs +4…+17 % over its mono.
- Every drawn frame was checked non-empty (mean canvas luminance ~123) in every row.

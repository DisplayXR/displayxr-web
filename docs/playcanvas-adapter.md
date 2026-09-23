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
- **Formats:** `.sog` (bytes or URL), `.ply`, and a Streamed SOG by URL: its `lod-meta.json`, or
  the directory holding it (a URL ending in `/`). Bytes of a `lod-meta.json` throw at call time
  (a Streamed SOG is a directory of relatively named chunks; §Streamed SOG). `.spz`,
  `.splat` and `.ksplat` are Spark-only: with `engine: 'playcanvas'`, `addSplat` **throws at call
  time** when it can tell (a URL extension, gzip bytes, a Spark-only `fileType`).
- **Extra options:** `preserveDrawingBuffer` (default false; the weave's zero-copy read race on
  large canvases, browser-pvt#24), `orbitMaxDeg` / `orbitEase`, and `captureFit` (both backends).
- **Extra handle members:** `setSource(src, { fadeMs, resetPose })` (it throws on Spark) and
  `engine` → `{ app, root, camera }`.

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

## `handle.engine` — adding your own content

`handle.engine` is `{ app, root, camera }`: the tile's `pc.AppBase`, the content root entity
(the splat's content space; add your entities under it), and the eye-rig camera entity.
`remove()` destroys the app and everything under `root` with it. This is advanced and not
covered by the semver promise.

**What the app registers (1.9.1).**
- Component systems: `Camera` and `GSplat` for the splat, plus `Render`, `Light` and `Anim`.
- Resource handlers: `Texture` and `GSplat`, plus `Container` (`.glb` / `.gltf`).

That is exactly what a glTF needs, skinned and animated included, and nothing more from the
engine's full `Application` list. Physics, UI, audio, particles and scripts remain the page's to
add. The container's sub-assets (render, material, animation) arrive already loaded, so they need
no handlers of their own (verified by running a skinned, animated `.glb`).

Pages written before 1.9.1 registered those systems themselves. The engine throws on a duplicate
system id, so the adapter makes a second `app.systems.add()` of a registered id a no-op that
returns the existing system. Re-adding a handler is harmless in the engine anyway.

**Cost**, measured:
- Bundle, esbuild 0.28.2 minified, for a tree-shaken minimal viewer: **+152 KB min / +41.8 KB
  gzip** (1,346,588 → 1,498,900 bytes; gzip 354,215 → 396,009).
- For the SDK as shipped, the bundle cost is none. The adapter reaches the engine through the
  namespace of a dynamic `import('playcanvas')`, which bundlers do not tree-shake, and an
  importmap loads the whole engine anyway.
- Boot: `AppBase.init` median **0.4 → 0.5 ms** (+0.1 ms), in headless Chrome 153 on M1 Pro, 20
  interleaved runs each.

That is well under the 5 ms threshold, so registration is **eager**: `handle.engine.root` is
usable as soon as `ready` resolves.

```js
const { app, root } = handle.engine;
const a = new pc.Asset('fox', 'container', { url: 'fox.glb' });
app.assets.add(a); app.assets.load(a);
a.ready(() => {
  const e = a.resource.instantiateRenderEntity();
  root.addChild(e);                       // content space, same as handle.frame
  e.addComponent('anim', { activate: true });
  const track = a.resource.animations[0].resource;
  e.anim.assignAnimation(track.name, track);   // the TRACK's name — see below
});
```

**Two engine gotchas** hit in the field:
- **A light shines along its local −Y**, while `lookAt` aims an entity's −Z. A light pointed with
  `lookAt` lights the wrong way. Rotate it (for example `setLocalEulerAngles(45, 30, 0)`), or
  `lookAt` and then pitch it by −90°.
- **Container sub-assets are named `<asset name>/animation/N`.** When the asset name has a dot
  (`fox.glb`), passing that string to `assignAnimation` makes the anim component read the dot as
  a path separator. Measured here, the animation silently never plays (no base layer is
  created). The field page instead threw `t.getChild is not a function`. Either way, use the
  track's own name: `track.name`.

**Depth.** Meshes depth-test against each other, and splats test against the meshes; splats don't
write depth. Verified: a skinned fox placed behind the photo's foreground loses 741 of 7,014
pixels to nearer splats, and 0 when placed in front.

The adapter owns the projections: runtime views in 3D, and in 2D the mono camera at near 0.001
with far 1000 (display rig) or 5000 (camera rig). A mixed scene may want tighter depth precision,
so **`nearClip` / `farClip`** (both optional, `perf`-independent) are a **floor on near and a cap
on far**. They never widen the range, and they rewrite only the depth mapping, not the frustum.
Anything nearer than `nearClip` is clipped, splats included.

## `setSource` — what a swap costs the main thread

Measured in headless Chrome 153 on an M1 Pro. The swap is `ports_25.sog` → `ports_100_cam.sog`
(1,179,648 gaussians, bytes), `fadeMs: 0`, 3 fresh browsers each. The "4× CPU" rows use DevTools
CPU throttling as a stand-in for a tablet. Long tasks come from a `longtask` PerformanceObserver.
The gap is the longest time between two rAFs during the swap and the second after it.

| | longest main-thread task | longest rAF gap | swap wall time |
|---|---|---|---|
| 1.10.0, 1× CPU | 60–64 ms | 65–77 ms | 195–202 ms |
| **1.10.1**, 1× CPU | **none over 50 ms** | **35–44 ms** | 152–161 ms |
| 1.10.0, 4× CPU | 218–238 ms (plus more: 318–354 ms blocked in total) | 233–249 ms | 460–497 ms |
| **1.10.1**, 4× CPU | **60–65 ms** (one task, the engine's) | **102–122 ms** | 301–352 ms |
| 1.10.0 / 1.10.1, 1× CPU, `fadeMs: 500` | 56–58 ms / none | 68–79 ms / 42–52 ms | 704–726 / 662–704 ms |

Where the time goes. The SDK's stages show as `performance.measure` entries named
`inline3d:*`, visible in DevTools; these are the 1× figures.
- **The engine's SOG load: about 90–110 ms of wall time, almost all of it asynchronous.** At
  2.22.3 the WebP planes decode through `createImageBitmap`, which is asynchronous and off the
  main thread in Chromium (its synchronous part measured 0.0–0.2 ms per plane). The zip entries
  inflate through `DecompressionStream`. The GPU centre pass plus its readback (`generateCenters`)
  is asynchronous, 35–56 ms of wall time. Texture uploads cost 1–3 ms each.
- **The one long task left is the engine's**: its end-of-load work (unpacking the centre readback
  into a Float32Array and building the resource). That is about 15 ms at 1× and **60–65 ms per
  1.18M gaussians at 4× CPU**. The engine at 2.22.3 has no worker or asynchronous parse path for a
  bundled SOG. Safari has no `createImageBitmap` path in the engine (`supportsImageBitmap` is false
  there), so the WebP decode lands on the main thread at texture upload. That was NOT measured.
- **The SDK's own passes were the rest:** the strided cloud copy (9 ms), the opacity pass (4 ms),
  the framing percentiles (46 ms, now 15 ms with a linear-time select), the rest-space sample and
  the pick set (4 ms). They used to run in one task, stacked on the engine's. Each now runs in its
  own task, with a yield (`scheduler.yield()` where available) in between. The numbers are the
  same: the framing's percentile values are bit-identical, by test.

**Recommended pattern for a document that swaps photos.** Call `setSource` for the next photo well
before the user navigates to it. The load and decode run while the current one is still on screen,
and the crossfade itself costs no long task. Keep a poster for the first paint and gate on the
`firstWoven` promise as before. On a slow device, expect one ~60 ms main-thread hitch per 1M
gaussians from the engine, per swap.

## `perf` on this engine

| Spark knob | engine | note |
|---|---|---|
| `alphaRadius` | always on | the engine already cuts each quad at its own alpha radius (`clipCorner`) |
| `minAlpha` | `scene.gsplat.alphaClipForward` | engine default is already 1/255 |
| `maxStdDev` | `gsplatCommonVS` override | only ever shrinks, down from √8σ |
| `minPixelRadius` | `scene.gsplat.minPixelSize` = 2 × r | the engine compares a quad *diameter* |
| `lod*`, `maxPixelRadius`, `falloff`, `alphaFloor` | none | named once in a warning, then ignored |
| (engine-native) `splatBudget`, `minPixelSize`, `alphaClipForward`, `antiAlias` | passed through | win over the mapping |
| (engine-native, Streamed SOG) `lodMode`, `lodUpdateDistance`, `lodUpdateAngle`, `lodUnderfillLimit` | passed through | unset = engine default; each is its own kill switch |

**The one default changed is `minPixelSize`.** The engine default is 2 px; Spark keeps sub-2px
splats. So every `perf` value except `false` starts from 0. **`perf: false` is the kill switch:**
engine defaults, untouched. `splatBudget` is a no-op on a flat `.sog`: 1,179,648 of 1,179,648
drawn at a 600k budget. It only acts on a Streamed SOG, where it defaults to **600k per tile**
(both eyes included) instead of the engine's 1M; `perf: false` keeps the 1M (§Streamed SOG).

## Divergences from the Spark path

What is left after the parity pass. Everything else is the same option, the same method and the
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
  `handle.engine` is the supported way in. `viewer` is also null until the adapter module has
  loaded (calls made before that are queued).
- **`mesh`** is `{ numSplats, entity, asset, resource }`, not a Spark `SplatMesh`. There is no
  `spark` field.
- **`pick`** is the exact nearest gaussian CENTRE to the ray over the full centre set, not a
  surface raycast (Spark tries its raycast first). On a Streamed SOG it runs over the resident
  chunks only.
- **`setSource`** is PlayCanvas-only; on Spark it throws.
- **No sky box.** The eye camera renders without the engine's Skybox layer, so nothing is drawn
  behind the splat even when a page sets `scene.envAtlas` to light its own meshes. A hidden splat
  shows the page, not a grey gradient box. Pass `sky: true` for the engine's sky (1.10.1).
- **`sortIntervalMs` is a no-op**: the engine re-sorts on camera rotation, with one directional
  sort for every view.
- **URL `.sog` gets its `camera` block** (the engine keeps unknown `meta.json` keys). On Spark,
  only the bytes path can read it.
- **Streamed SOG** has no cloud pass. It is framed from a count-weighted sample of its octree leaf
  boxes (not the root bound), so a block without intrinsics falls to the 28 mm lens and the
  nearest-clump rung cannot run. `mesh.numSplats` is the finest level's count; `stats().resident`
  is what is drawn. Budget, knobs and measurements: §Streamed SOG.
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

## Streamed SOG (P2)

A **Streamed SOG** is a directory: `lod-meta.json` (an octree of chunk boxes, per-level counts,
relative file names) plus one unbundled SOG per chunk per LOD level. The engine fetches only the
chunks the camera needs and draws at most a **splat budget** of them. On this backend:

```js
// the lod-meta.json, or the directory that holds it
const h = addSplat(wall, canvas, 'https://cdn.example/scene/v1/lod-meta.json', { engine: 'playcanvas' });
const h2 = addSplat(wall, canvas, 'https://cdn.example/scene/v1/', { engine: 'playcanvas', perf: { splatBudget: 400000 } });
h.stats(); // { kind:'streamed', resident, peakResident, budget, numSplats, views, lodLevels, files, filesLoaded, firstFrameMs }
```

- **URL only.** Bytes of a `lod-meta.json` (`Uint8Array` / `ArrayBuffer`) make `addSplat` throw at
  call time with a message giving the URL form; a `Blob` (and `setSource`) rejects with the same
  message. The file names hundreds of chunks by relative path, and bytes have no base URL to
  resolve them.
- **The camera block** is read from the top level of `lod-meta.json` (sibling of `asset`). It is
  the same block as in a `.sog`, and it drives the same waterfall: intrinsics present ⇒ camera rig
  at the recorded rest pose. Verified on a streamed scene: `rig.type 'camera'`,
  `intrinsicsSource 'block'`, and the mono pose equal to `capturePose(rest)` to 4 decimals, the
  same as the flat `.sog` of the same scene.
- **Framing without a block** uses the octree's leaf boxes, not its root. The root bound is the
  raw container of every chunk, sky shells and floaters included: 391×821×390 m on a captured
  castle whose flat file measures 65×25×76 m, and ±240 m around a 2 m statue. The adapter spreads a
  count-weighted, deterministic sample through the leaf boxes (`octreeSample`) and frames it the
  way a flat cloud is framed. That lands within a node size of the flat measurement: 101×33×114 m
  on the castle. A caller `frame` wins over both.
- **`pick`** searches the centres of the chunks currently resident (P1's exact-pick change), so it
  can only hit what the budget let in. Not measured here.
- **`engine: 'spark'`** cannot read a Streamed SOG. A streamed URL with `engine: 'spark'` makes
  `addSplat` throw at call time with a message naming `engine: 'playcanvas'`, before Spark is
  handed the URL.

### The budget model

`splatBudget` is **per tile, and covers every view of the tile**. Pinned in
`SPLAT_BUDGET_MODEL` (`js/inline3d-splat-perf.js`) and held by a test:

- Every tile is its own `AppBase`, so it has its own scene, its own `scene.gsplat.splatBudget` and
  its own gsplat manager. Two tiles on a page have two budgets.
- The engine keys gsplat managers by **camera** (`GSplatDirector.camerasMap` holds one
  `GSplatManager` per camera × layer), and this adapter draws all N views through **one** camera
  with N `RenderView`s. So there is one manager, one LOD pass, one budget and one work buffer for
  both eyes. Measured on the castle at 600k, reading `renderer.gsplatDirector` in the page:

  | path | cameras | managers | scene budget | resident |
  |---|---|---|---|---|
  | mono | 1 | 1 | 600,000 | 588,879 |
  | 2 views, RenderView (default) | 1 | 1 | 600,000 | 590,331 |
  | 2 views, N-camera fallback | 2 | 2 | 300,000 each | 734,764 |

- The N-camera fallback (`playcanvasViewPath: 'cameras'`) makes one manager per view, each reading
  the same scene budget. The adapter divides the budget by N there (`budgetPerManager`).
- **The budget has a floor.** The engine never draws a chunk coarser than its coarsest level, so
  `resident` bottoms out at the sum of the visible chunks' coarsest levels: 367,382 on the
  castle's 5-level pyramid at a 300k budget, and 2 × 367,382 on the fallback above. Add levels
  when you need a lower floor.
- LOD distance is measured from the camera node, which sits on the first view's eye. Both eyes
  use the LOD it picked.
- **Default 600k** (`STREAMED_SPLAT_BUDGET`) when the caller names none; `perf: false` keeps the
  engine's 1M. On the M1, 1M also fits: the castle's two-view 1080p frame is 10.9 ms at 1M and
  9.6 ms at 600k. 600k is chosen for **headroom** on the weaker GPUs a 3D display ships with
  (Windows iGPUs and Android tablets, not measured yet). Only 600k and 1M were measured, so 600k
  is a safe default, not a tuned optimum. Revisit it with the Windows-box numbers.
- The LOD knobs `lodMode` (`'distance'` | `'error'`), `lodUpdateDistance` (file units, engine
  default 1), `lodUpdateAngle` (degrees, default 0 = off) and `lodUnderfillLimit` (default 0) pass
  through `perf`. Unset means the engine's default.

### Producing one (with the camera block)

splat-transform's `lod-meta.json` writer takes **PLY inputs only**, one per `--tag-lod` level.
`-d` must be the last action and must write a `.ply`. The recipe (5 levels, uniform decimation,
splat-transform's default chunking of 512K gaussians / 16 m):

```bash
splat-transform -w scene.sog  levels/lod0.ply
splat-transform -w levels/lod0.ply -d 50%    levels/lod1.ply
splat-transform -w levels/lod0.ply -d 25%    levels/lod2.ply
splat-transform -w levels/lod0.ply -d 12.5%  levels/lod3.ply
splat-transform -w levels/lod0.ply -d 6.25%  levels/lod4.ply
splat-transform -w levels/lod0.ply -l 0 levels/lod1.ply -l 1 levels/lod2.ply -l 2 \
                   levels/lod3.ply -l 3 levels/lod4.ply -l 4 out/lod-meta.json
```

A PLY has nowhere to hold the camera block. So neither the released splat-transform (3.6.1) nor
the camera-block build (upstream PR for #319, which does carry the block from
`.sog`/`meta.json`/`lod-meta.json` to `lod-meta.json`) can carry it through this recipe: the block
has to be **injected at the top level of `lod-meta.json` afterwards**. The gallery repo's
`scripts/make_streamed_sog.ts` does all of this, reading the block from the input `.sog` or from
`--camera block.json`. It checks the result and refuses inputs under 2M gaussians unless `--force`
is given. Its README section ("Streamed SOG") explains why photo lifts never qualify.

### Serving it

Upload the whole directory to the **same bucket** as the flat assets, under an **immutable,
versioned prefix** (`…/{id}/streamed-v1/`, `Cache-Control: public, max-age=31536000,
immutable`). The chunk paths are relative, so any prefix works. A rebuild goes to a new prefix,
never over the old one: a viewer mid-stream would otherwise mix levels from two builds. Cross-origin
hosting needs CORS on every chunk (`Access-Control-Allow-Origin`). The public Trogir scene below
serves `*`.

### Measured

Headless Chrome 153 on the real GPU (`ANGLE Metal, Apple M1 Pro`), engine 2.22.3, one config per
page load, HTTP cache **off**, no other Chrome running. Harness: `m.html` + `measure.mjs` (the
epic's parity scratch, `p2/`). Local assets are served from `python3 -m http.server` on localhost,
and Trogir comes over the network from CloudFront. GPU = `EXT_disjoint_timer_query_webgl2` around
exactly one frame per rAF, 300 frames after 60 warm-up, rest pose, median / p90 ms. "Stereo" is
the SDK's real 3D path driven by a stand-in wall with two synthetic views (±32 mm): a 2560×720 or
3840×1080 SBS buffer. First frame = `stats().firstFrameMs` (ms since navigation start, first tick
that drew a non-empty set). It includes loading the SDK, three and Spark from a CDN (static imports of `./splat` when this
was measured, on p1 @ `ebeb1b2`) and the engine from localhost. Bytes =
CDP `Network.loadingFinished.encodedDataLength` for the asset's URLs.

Scenes:

- **(A) museum statue** — a captured room, 364,374 gaussians, with a camera-rig block (rest pose
  in front of the statue, fx = fy = 1100 at 1280×720, `focus.point` = the opacity-weighted
  centroid of opacity > 0.5 splats inside the statue's box: (−0.368, −0.084, −0.468)). Flat
  `.sog` 5.83 MB. Streamed: 5 levels (100/50/25/12.5/6.25 %), default chunking, 16.4 MB on disk.
  `streamed32` is the same scene with `--lod-chunk-count 32` (23 files, 22.2 MB).
- **(A′) captured castle on a hill** — 5,878,108 gaussians, no block (display rig). Flat `.sog`
  79.75 MB. Streamed: 5 levels, default chunking, 23 files, 196.3 MB on disk. The streamed runs
  pass the flat run's measured `frame`, so both render the same camera.
- **(B) Trogir** — `https://d28zzqy0iyovbz.cloudfront.net/14bac5b2/v1/lod-meta.json`, public,
  45,756,761 gaussians over 7 levels (23.1M finest), 86 files, per-chunk LOD errors, an
  environment splat. It has no camera block, so it runs on the display rig, auto-framed from the
  leaf boxes. There is no flat baseline.

**First frame and bytes at rest** (mono 720p; first frame is the median of 3 loads; 100 Mbit/s =
CDP-throttled, 20 ms latency, median of 2):

| scene | first frame, localhost | first frame, 100 Mbit/s | bytes at rest | resident at rest (budget) |
|---|---|---|---|---|
| A flat | 562 ms | 2,588 ms | 5.83 MB | 364,374 (all) |
| A streamed | 608 ms | 2,443 ms | 5.98 MB | 364,374 (600k) |
| A′ flat | 1,578 ms | **20,758 ms** | 79.75 MB | 5,878,108 (all) |
| A′ streamed | 627 ms | **2,902 ms** | 138.1 MB | 593,001 (600k) |
| B streamed (CloudFront) | 837 ms | — | 13.0 MB | 604,809 (600k) |

**Bytes after a 10 s scripted orbit** (yaw ±60°, pitch ±10°, zoom 1→2.5→1; cache off, so an
evicted chunk is fetched again: total / unique):

| scene | at rest | after orbit, total | after orbit, unique URLs |
|---|---|---|---|
| A flat | 5.8 MB | 5.8 MB | 5.8 MB |
| A streamed (600k) | 6.0 MB | 6.0 MB | 6.0 MB |
| A streamed32 (600k) | 9.0 MB | 9.0 MB | 9.0 MB |
| A′ flat | 79.8 MB | 79.8 MB | 79.8 MB |
| A′ streamed 600k | 138.1 MB | 301.5 MB | 165.9 MB |
| A′ streamed 1M | 139.9 MB | 264.7 MB | 165.9 MB |
| B 600k | 13.0 MB | 31.8 MB | 31.8 MB |
| B 1M | 21.2 MB | 51.2 MB | 51.2 MB |

**Streaming is not a byte saving at a close framing.** The castle fetched more than its whole flat
file before settling. The engine loads whole chunk files per level, and coarse levels come in
before fine ones. It is a first-frame and frame-time lever. Trogir, framed whole from far away,
is the case where it also saves bytes: 13 MB of a 23M-splat finest level.

**GPU ms/frame** (median / p90; resident was constant through every timed run; **every row ran
with no other Chrome on the machine**: the driver checks for foreign headless Chromes before and
after each config and retakes a config that overlapped one):

| scene · budget | 720p mono | 1080p mono | 2 views 2560×720 | 2 views 3840×1080 |
|---|---|---|---|---|
| A flat (364k drawn) | 4.2 / 6.2 | 7.1 / 9.2 | 7.5 / 8.8 | 8.5 / 9.1 |
| A streamed 600k (364k drawn) | 3.8 / 6.0 | 7.2 / 9.7 | 7.6 / 10.1 | 8.6 / 10.8 |
| A streamed 300k (299k drawn) | 3.8 / 4.6 | — | 7.1 / 9.8 | — |
| A′ flat (5.88M drawn) | 67.7 / 72.1 | 66.3 / 70.4 | 133.7 / 155.9 | 116.9 / 122.4 |
| A′ streamed 600k (593k) | 6.4 / 8.6 | 5.9 / 8.2 | 9.8 / 13.9 | **9.6 / 12.9** |
| A′ streamed 1M (989k) | 7.3 / 10.4 | 7.8 / 10.6 | 11.3 / 12.6 | **10.9 / 13.3** |
| A′ streamed 300k (367k: the floor) | 4.1 / 6.7 | — | — | — |
| B 600k (605k) | 7.0 / 9.8 | 6.1 / 8.7 | 7.7 / 9.1 | 8.3 / 11.1 |
| B 1M (1.006M) | 9.4 / 11.8 | 9.3 / 12.6 | 10.4 / 12.4 | 10.3 / 11.9 |
| B 600k, `lodMode:'error'` (591k) | 6.0 / 8.6 | — | — | — |

**Why "no other Chrome" is load-bearing.** On ANGLE Metal a timer query absorbs other processes'
GPU work. An earlier pass that only checked for other Chromes at start-up read the castle's
two-view 1080p at 1M as 36.8 / 64.2 ms. The clean retake reads 10.9 / 13.3. Other rows moved by
2–4× the same way (castle 600k, two views at 720p: 17.8 contaminated, 7.8–9.8 in clean runs). Those passes are
discarded; only the clean retake is in the table. Even clean, treat the numbers as ranking and
order of magnitude: headless, vsync-free, one run per row. `lodMode:'error'` on Trogir loaded 42
of 86 files (252.6 MB) against 3 (13.0 MB) in distance mode.

**Rest-view fidelity, streamed vs flat** (A, same camera from the block; grey MAE /255 at
1280×720 against the flat render; flat vs flat reloaded = 0.000):

| budget | resident | MAE (default chunking) | MAE (`streamed32`) |
|---|---|---|---|
| 1M | 364,374 | 0.241 | — |
| 600k | 364,374 | 0.241 | 0.155 |
| 300k | 298,623 / 293,007 | 1.264 | 1.182 |

A′ (castle, `frame` pinned to the flat's): 1M 4.51, 600k 5.63, 300k (the 367k floor) 10.47. At a
full budget, A's residual is re-encoding. The chunk SOGs are encoded from PLY, independently of
the flat `.sog`, with their own codebooks. On the castle, the budget is doing its job: 5.88M
become 0.6–1M, and fine grain becomes coarse levels, most visibly on the near ground.

**Pending:** the same table on the Windows box (Leia SR, the DisplayXR Browser's real inline-3d
views, the weave) is not measured here.

### Not tested (P2)

The DisplayXR Browser (real inline-3d views, the weave join, zero-copy read), Windows and Android;
a real 3D wall driving the streamed path (only the stand-in wall); multiple streamed tiles on one
page (separate budgets are asserted from code, not measured); `lodUnderfillLimit` /
`lodUpdateAngle` effects (they are wired and unit-tested, not measured); HTTP-cache behaviour on
re-fetch (every run had the cache off); `remove()` during an in-flight chunk load; context loss
mid-stream; engine versions other than 2.22.3.

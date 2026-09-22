# PlayCanvas as a second splat backend: P0 design note

Status: **P0 investigation**, epic [#36](https://github.com/DisplayXR/displayxr-web/issues/36).
Read-only: no SDK code changed. Every claim below cites upstream source as `path:line @ sha`
or names the run that showed it. Claims taken from reading alone are listed in [NOT TESTED](#not-tested).

Upstream revisions read:

| repo | ref | sha |
|---|---|---|
| `playcanvas/engine` | tag `v2.22.3` (= npm `playcanvas@2.22.3`, latest on 2026-09-22) | `b134b31` |
| `playcanvas/engine` | `main` HEAD (`2.23.0-beta.16`) | `1f19945` |
| `playcanvas/splat-transform` | `main` HEAD (`3.6.1`, same as npm) | `9c73f01` |
| `playcanvas/supersplat-viewer` | `main` HEAD (`1.32.0`) | `9d8cc43` |

Unqualified engine citations are **@ `b134b31` (v2.22.3)**. HEAD differs from 2.22.3 in the files
that matter here only by two new `GSplatParams` knobs (`stochastic`, `dither`); `render-view.js`
is identical, and the footprint bug in §2 is still present at HEAD (`gsplatCorner.js:55-60 @ 1f19945`).

---

## Summary and decision

**Go for P1, on WebGL2, as an optional npm peer dependency `playcanvas >= 2.22.3 < 3`.**

1. **N views into one canvas works, two ways, and they are bit-identical.** Spike (below):
   - (a) N `CameraComponent`s with `rect` halves and `calculateProjection` returning our matrix;
   - (b) ONE `CameraComponent` whose `camera.camera.xrViews` is a list of `pc.RenderView`s
     (projection, pose and pixel viewport per view): the engine's own WebXR stereo path, driven
     without `XrManager`.

   Both put a 0.2-NDC off-axis skew on screen as exactly 64 px between the halves, and the two
   images differ by MAE 0.0. **(b) is the recommendation.** It gives one gsplat manager, one sort,
   one LOD pass and one work buffer per frame for all views. (a) gives one of each **per camera**
   (`gsplatCount` 589,824 = 2 × 294,912 in the spike).
2. **The engine has a real bug for our buffer contract, and we can patch around it with a
   supported hook.** The splat footprint uses a single focal length derived from the viewport
   *width* for both axes (`gsplatCorner.js:29,51-60`), which assumes square pixels. Our
   side-by-side (SBS) buffer squeezes each eye 2:1 horizontally, so every splat is drawn at half
   its correct height. Measured: MAE **11.50** against a square-pixel reference, and **1.70** with a
   one-line chunk override that uses `viewport_size.y * P[1][1]` for the y focal. On square pixels
   the fix changes nothing (MAE 2.5e-6). Ship the override in P1 and upstream it (P4d).
3. **Custom projections are honoured where it matters.** The CPU-sort WebGL path sorts along the
   camera node's forward vector, which does not depend on the projection. It does no CPU frustum
   culling; the per-splat clip in the vertex shader uses the per-view projection. LOD, however,
   compensates for FOV using `camera.fov`, not the matrix (`gsplat-octree-instance.js:518-530`), so
   the adapter must keep `camera.fov` equal to the views' vertical FOV.
4. **WebGL2 for P1. WebGPU is "later, maybe never".** The weave is engine-agnostic: it joins the
   canvas's own Viz resource. The engine's WebGPU stereo path is hard-wired to exactly two views and
   computes covariance for eye 0 only (`gsplat-projector.js:727-744`). WebGPU canvases in the
   browser's weave join are unverified. Nothing we need requires WebGPU: the budget, LOD and
   streaming all run on WebGL2 with CPU sort.
5. **Use npm as a peer dependency, don't vendor.** The package ships tree-shakeable ESM
   (`"sideEffects": false`). A minimal splat viewer bundles to **357 KB gzip**, against **1,089 KB
   gzip** for today's `./splat` (three + Spark). One bundler trap: the worker sources contain a
   `require("node:worker_threads")` fallback that esbuild's browser build cannot resolve. Mark it
   external.
6. **The engine keeps our `camera` block; splat-transform drops it.** The engine retains unknown
   `meta.json` keys (`resource.gsplatData.meta.camera`) and unknown `lod-meta.json` keys
   (`resource.data.camera`), both verified by run. splat-transform drops `camera` on a SOG
   re-encode, and its Streamed-SOG writer builds `lod-meta.json` from a fixed shape (also verified
   by run). On chunked output, the block belongs at the top level of `lod-meta.json`.
7. **Keep `XrManager` off by construction.** Build on `AppBase` with our own device. Don't use
   `pc.Application`: that path constructs `XrManager`, which probes `isSessionSupported`, and it
   forces `xrCompatible: true` on the context. With `AppBase`, `app.xr === null` (run) and the
   engine has no code path to `navigator.xr.requestSession` (`xr-manager.js:629` is reachable only
   from `start()`).

---

## Spike (question 3): what was run

- **Page:** `scratchpad/p0/spike/index.html`, driven by `drive.mjs` (Chrome DevTools Protocol, one
  headless Chrome, killed on exit). It imports `playcanvas.mjs` from the packed
  `playcanvas-2.22.3.tgz` and is served over `http://127.0.0.1`.
- **Command:** `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new
  --use-angle=metal --enable-gpu --ignore-gpu-blocklist --remote-debugging-port=9333
  --window-size=1280,720` (Chrome 153).
- **GPU:** real, not SwiftShader. `UNMASKED_RENDERER = ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)`.
- **Asset and canvas:** the gallery bench asset `ports_25.sog` (294,912 gaussians, SH0, no `camera`
  block) in a 1280×720 canvas treated as an SBS atlas (two 640×720 eyes).
- **Matrices:** `Mat4.setPerspective(60°, 16/9, 0.1, 100)` with `data[8] = ∓0.1`, the
  column-major `[2][0]` skew slot, the same one three.js and WebXR use. Both eyes share a pose, so
  any horizontal shift comes from the projection alone.
- **Frame loop:** the engine's own rAF is disabled (`app.requestAnimationFrame = () => {}`) and
  `app.tick(t)` is driven from the page's loop. This is how P1 drives it from the SDK's `onFrame`.
  240 frames per run.

| run | result |
|---|---|
| `mode=cams` (2 cameras, `rect` halves, `calculateProjection`) | L→R shift **64 px** (= 0.2 NDC × 320 px). `gsplatCount` **589,824** (two managers). |
| `mode=views` (1 camera, 2 `RenderView`s) | shift **64 px**. `gsplatCount` **294,912** (one manager). Image equals `cams` (MAE **0.0**). |
| `…&shift=0` (control) | shift **0 px**. |
| `mode=ref` (1 camera, full 1280×720, left matrix: square pixels) | clean reference. |
| `mode=views` vs ref (left half stretched 2× horizontally) | MAE **11.50**: visible vertical stipple/cracks |
| `mode=views&fix=1` vs ref | MAE **1.70** (bilinear-stretch residual) |
| `mode=ref&fix=1` vs `mode=ref` | MAE **2.5e-6** (the fix is a no-op on square pixels) |
| `asset=cam` (bench asset with an injected `camera` block) | `a.resource.gsplatData.meta.camera` present, and still present after 240 frames |
| `asset=lod&budget=150000` (3-level Streamed SOG, see §7) | renders; `gsplatCount` **137,706** ≤ budget; `a.resource.data.camera` present |
| `asset=lod&budget=1000000` | `gsplatCount` **294,912** (every node at LOD 0) |
| `spin=content` vs `spin=camera` (orbit the splat vs orbit a camera parent) | CPU per `tick` 0.46 vs 0.43 ms (spin=none: 0.41). **GPU time was not measured.** |

PNGs are in the scratch dir (not committed): `out_mode_cams.png`, `out_mode_views.png`,
`out_mode_ref.png`, `out_mode_views_fix_1.png`, `out_mode_cams_fix_1.png`,
`out_mode_views_fix_1_asset_lod_budget_150000.png`.

---

## 1. Engine version and the gsplat-unified API surface

**Files.** `src/scene/gsplat-unified/` holds the same 33 modules at 2.22.3 and at HEAD, and the npm
build ships them all under `build/playcanvas/src/scene/gsplat-unified/` as individual ESM files
(checked in the tarball): `gsplat-manager`, `-director`, `-world`, `-world-state`, `-octree`,
`-octree-instance`, `-octree-node`, `-octree.resource`, `-lod-table`, `-budget-balancer`, `-params`,
`-frustum-culler`, `-quad-renderer` (WebGL/CPU sort), `-hybrid-renderer` + `-projector` +
`-interval-compaction` (WebGPU/GPU sort), `-unified-sorter` + `-unified-sort-worker`,
`-work-buffer*`, `-placement*`, `-shadow-renderer`, `-varyings`, `-info`, `-sort-bin-weights`,
`-alloc-id`, `-asset-loader-base`, `constants`.

**Public surface.**
- `GSplatComponent`: `asset` or `resource` (`component.js:684,715`), `layers` (`:650`),
  `castShadows` (`:324`), `lodRangeMin` / `lodRangeMax` per placement (`:453,477`), `lodFalloff`
  (`:391`). `unified` now defaults to `true` (`:168`) and is deprecated for removal (`:538`).
  `lodBaseDistance` / `lodMultiplier` / `lodDistances` are deprecated in favour of the budget
  (`:412-498`), and `GSplatComponent.splatBudget` is **removed** (`:517`).
- **Global knobs** live on `app.scene.gsplat` (a `GSplatParams`, `scene.js:336,528`):
  - `splatBudget`: a count of splats, default 1,000,000 (`gsplat-params.js:486`, `constants.js`
    `SPLAT_BUDGET_DEFAULT`). Non-positive values are replaced with the default (`gsplat-world.js:559-563`).
  - `lodMode`: `'distance'` (default) or `'error'` (`:517`).
  - `lodUpdateDistance = 1` world unit (`:371`) and `lodUpdateAngle = 0°` (`:377`).
  - `lodBehindPenalty` (`:391`) and `lodUnderfillLimit` (`:456`).
  - `renderer`: AUTO resolves to CPU sort on WebGL and GPU sort on WebGPU (`:162-183,190`).
  - `radialSorting = false` (directional sort) (`:138`).
  - `alphaClipForward = 1/255` (`:673`), `minPixelSize = 2` px (`:692`), `antiAlias` (`:787`).
  - GPU-sort only: `minContribution` and `foveationStrength` / `foveationCenter` (`:714,739,761`).
  - `colorUpdateAngle = 10` (`:609`), `cooldownTicks = 100` (`:880`), `dataFormat` (`:907`).
- **How a scene sets a budget:** `app.scene.gsplat.splatBudget = 600_000;`. It's one number for the
  whole scene, shared by every placement.

**Per-camera or global?** The params are global, but **all state is per camera**. The director
keeps a `GSplatManager` per (camera, layer) (`gsplat-director.js:39-63,357-417`). Each manager owns
its own `GSplatWorld`: work buffer, octree/LOD evaluation, budget enforcement, and a CPU sort worker
("Created 1:1 per manager (no sharing yet)", `gsplat-manager.js:73-79`). So N cameras mean N full
budgets resident, N LOD passes, N work buffers and N workers (the spike's 589,824). One camera with
N `RenderView`s means one of each. This is the main reason to prefer design (b).

## 2. N views into one canvas, with custom off-axis projections

**Mechanisms, all public at 2.22.3:**
- `CameraComponent#calculateProjection(mat, view)`. It is called with the camera's cached
  projection before the uniforms are set (`renderer.js:343-347`) and before the frustum is built
  (`camera.js:829-831`). The callback writes that cached matrix in place, so later
  `camera.projectionMatrix` reads return ours.
- `CameraComponent#projectionOffset` (`Vec2`): writes `data[8]` / `data[9]` directly
  (`camera.js:515-521,936-948`). That is enough for a pure shift, but not for an arbitrary
  runtime-supplied matrix, so we use it only as a fallback idea.
- `CameraComponent#rect`: normalized viewport. `setupViewport` floors `rect × target size`
  (`renderer.js:306-328`).
- **`RenderView`** (exported, `index.js:152`; class at `render-view.js:13`). `setView(projMat,
  viewInvMat)` and `setViewport(x, y, w, h)` (pixels) are marked `@ignore` in the docs, but they
  are the calls `XrManager` makes. `Camera#xrViews` is a public setter (`camera.js:589-603`). With a
  list assigned, `setCameraUniforms` returns it (`renderer.js:336-340`), the forward renderer loops
  views per draw with `device.setViewport(view.viewport…)` (`forward-renderer.js:627-634,713-730`),
  and per-view uniforms come from `setupViewUniforms` (`renderer.js:715-727`).
  `RenderView.updateTransforms` multiplies the camera's **parent** world transform into every view
  (`render-view.js:190-207`), which is what makes the orbit-the-camera trick in §9 free.

**Does the gsplat path honour a custom projection?**
- **Draw:** yes, per view. The splat vertex shader uses `matrix_projection` (`gsplatCenter.js:69`),
  and the covariance uses `center.projMat00 = matrix_projection[0][0]` (`gsplatCenter.js:79`).
  The off-axis skew (`[2][0]`) does not enter the covariance Jacobian: `x_ndc` depends on the skew
  only through a constant, so its derivative is zero. So off-axis is exact **except** for the
  focal bug below.
- **Footprint bug (anisotropic pixels).** `focal = viewport_size.x * projMat00`
  (`gsplatCorner.js:29`) is used for **both** axes of the Jacobian (`:51-60`). That is correct only
  when `viewportW · P00 == viewportH · P11`, i.e. square pixels. In our SBS atlas each eye is
  half-width but its frustum spans the full CSS box, so the y focal is half its true value and
  every splat is drawn at half height. The WGSL twin has the same shape (`gsplatCorner.js:56-60 @
  1f19945`, wgsl), as does the GPU projector (`gsplat-projector.js:736,744`). The engine's XR use
  never hits this because headset eyes have square pixels. **Fix (spike-verified, via the
  supported `ShaderChunks.get(device, 'glsl').set('gsplatCornerVS', …)`; the chunks are registered
  by `GSplatComponentSystem` during `app.init`, `gsplat/system.js:140`, so override after init):**
  ```glsl
  float J1y = (viewport_size.y * matrix_projection[1][1]) / vp.z;
  vec2 J2 = vec2(-J1 / vp.z * vp.x, -J1y / vp.z * vp.y);
  mat3 J = mat3(J1, 0.0, J2.x,  0.0, J1y, J2.y,  0.0, 0.0, 0.0);
  ```
  The npm build re-indents chunks with tabs, so anchor with a regex and warn once if the anchor
  misses, as `inline3d-splat-perf.js` does for Spark.
- **Sort:** CPU sort (WebGL) is directional along `cameraNode.forward` and re-sorts only when the
  forward vector rotates more than 0.001 rad (`gsplat-manager.js:567-585,721-730`). Projection
  plays no part. Our views share one orientation (the display normal on a display rig, the rig
  orientation on a camera rig), so a directional sort from the camera node is **exact** for every
  view, not merely close. That is better than Spark's one-sort-for-both trade.
- **LOD / budget:** from the camera node's position, plus FOV compensation from `camera.fov`
  (`gsplat-octree-instance.js:518-530`). LOD re-evaluates when the camera moves more than
  `lodUpdateDistance`, rotates more than `lodUpdateAngle`, or `fov` changes by more than 2%
  (`gsplat-world.js:1020-1054`). **The adapter must set `camera.fov = 2·atan(1/P[1][1])` (degrees)
  from the views**, or LOD is tuned for the default 45°.
- **Culling:** the WebGL/CPU path allocates no frustum-cull bounds (`gsplat-manager.js:688-690`).
  The only culling is the per-splat clip in the vertex shader against the per-view projection
  (`gsplatCorner.js:97-100`), which is correct off-axis. The WebGPU path culls against
  `camera.frustum`, merged across all `xrViews` (`gsplat-hybrid-renderer.js:537-547` →
  `camera.js:794-809`), which is also correct.
- **Once or per camera?** Per manager, therefore once per frame in design (b) and N times in (a).

**The engine's XR stereo path is the precedent.** `XrManager._onSessionStart` sets
`camera.camera.xrViews = this.views.list` (`xr-manager.js:795`). WebGL then draws each view into its
viewport inside one pass. The GPU-sort path has a dedicated 2-view "stereo" projector in which
"Eye 0 drives the shared covariance/depth/sort; eye 1 contributes only its screen position"
(`gsplat-projector.js:727-737`).

## 4. WebGL2 or WebGPU

**How the browser captures the canvas.** The weave runs in Viz. The aggregator joins each
inline-3D element to the **canvas's own resource quad** by layer identity, and
`WeaveCompositedSurface` sources the weave input from that SharedImage (zero-copy where possible),
falling back to the composited sub-rect (`displayxr-browser-pvt/docs/integration-points.md`
§3 "Canvas resource join"). That is engine-agnostic by construction: whatever the page composites
into the canvas is woven. The existing constraints still apply:
- **Redraw every frame.** An un-redrawn canvas can be dropped from the aggregated frame
  (`inline3d.js` `_frame`).
- **The known zero-copy read/write race on large WebGL canvases** (browser-pvt#24,
  `porting-three-js-apps.md` item 26). The adapter must expose `preserveDrawingBuffer`, as three's
  path lets pages do.

**Decision: WebGL2 for P1.**
- The browser's WebXR emulation lists WebGPU as explicit non-support in v1
  (`displayxr-browser-pvt/docs/design/immersive-vr-emulation.md:28,133`). Nobody has verified a
  WebGPU canvas (Dawn/D3D12 on Windows, Vulkan on Android) through the canvas-resource join.
- gsplat-unified needs **nothing** from WebGPU: the budget, LOD, streaming and octree all run on
  WebGL2 with CPU sort, as the spike shows.
- WebGPU buys GPU radix sort, `minContribution` / foveation culling and GPU frustum culling
  (`gsplat-params.js:162-183,714-761`). But its stereo projector is **two views only, with eye-0
  covariance** (`gsplat-projector.js:638,727-737`), and it has the same focal bug.

**WebGPU: later, and only on evidence.** Revisit if a P2 large-scene profile on the Windows box
shows the CPU sort worker as the bottleneck (watch `jobsInFlight` back-pressure,
`gsplat-manager.js:623-627`) **and** a WebGPU canvas is proven through the weave join.

## 5. XrManager stays off

- `pc.Application` sets `appOptions.xr = XrManager` (`application.js:179`) and, whenever
  `navigator.xr` exists, forces `graphicsDeviceOptions.xrCompatible = true` (`application.js:189-190`).
- `AppBase` constructs `XrManager` only if `AppOptions.xr` is given (`app-base.js:625`).
- The `XrManager` constructor, when `navigator.xr` exists and the permissions policy allows,
  subscribes to `devicechange` and calls `isSessionSupported` for inline / VR / AR
  (`xr-manager.js:301-331,690-694,759`). That is a read-only probe with no session. In our browser
  it would report `immersive-vr` as available; that is harmless, but it is noise, and it is exactly
  the condition a page's own "Enter VR" UI keys off.
- **The only `navigator.xr.requestSession`** in the engine is `_onStartOptionsReady`
  (`xr-manager.js:629`), which is reachable only from `app.xr.start(…)`. The engine never
  auto-starts XR. The render loop switches to `session.requestAnimationFrame` only when
  `app.xr.session` is set (`app-base.js:1068-1073`).

**Recommendation.** Use `new pc.AppBase(canvas)` + `app.init(opts)` with `opts.graphicsDevice`
from `pc.createGraphicsDevice(canvas, {deviceTypes: [DEVICETYPE_WEBGL2], xrCompatible: false, …})`
and **no `opts.xr`**. Verified: `app.xr === null` and
`getContextAttributes().xrCompatible === false` while `navigator.xr` is present. Also leave out
`opts.mouse` / `opts.keyboard` / `opts.touch`: the SDK owns input. Our SDK's own
`requestSession('inline-3d')` (`inline3d.js:526`) is then the only session request in the document.

## 6. Footprint, and coexistence with three

esbuild 0.28.2, `--bundle --minify --format=esm`, sizes are gzip -9:

| entry | min | gzip |
|---|---:|---:|
| `playcanvas` minimal splat viewer (AppBase, AppOptions, createGraphicsDevice, Entity, Asset, Camera+GSplat systems, GSplatHandler, RenderView, math, ShaderChunks) | 1,346,718 | **357,295** |
| `playcanvas` `Application` only | 1,993,208 | 517,304 |
| `playcanvas` everything (`import * as pc`) | 2,480,412 | 648,625 |
| today's `@displayxr/inline3d/splat` (three 0.186 + Spark 2.2.0 + SDK) | 3,294,645 | **1,088,983** |
| `three` alone (`import * as THREE`) | 745,510 | 191,074 |

- **Tree-shaking works.** The package declares `"sideEffects": false` and ships per-module ESM
  (`exports["."].import → build/playcanvas/src/index.js`). The gsplat floor is ~1.35 MB min because
  the GSplat system pulls in the scene renderer.
- **Bundler trap:** the inline worker sources (`gsplat-unified-sort-worker.js`,
  `gsplat-sort-worker.js`, `draco-worker.js`) contain `require("node:worker_threads")` as a
  non-browser fallback. esbuild's browser platform fails to resolve it; build with
  `--external:node:worker_threads`. Check Next's bundler in the gallery before P1 lands.
- **Workers are Blob URLs** (`gsplat-unified-sorter.js:58-66`), so a CSP needs `worker-src blob:`.
- **Coexistence:** the ESM build writes no globals (no `window.pc`). three writes only
  `window.__THREE__` (`three.core.js`). They can share a page, but **not a canvas**: one canvas has
  one context.
- **One app per tile.** Each `pc.AppBase` owns a WebGL context and a sort worker, the same as one
  `WebGLRenderer` per tile today.

## 7. Streamed SOG and `lod-meta.json`

**Producing it** (run with splat-transform 3.6.1):
```
splat-transform in.sog in.ply                      # a SOG input must go through PLY first
splat-transform in.ply -d 50% l1.ply               # decimation must be its own pass:
splat-transform in.ply -d 25% l2.ply               #   "--decimate must be the final action and the output must be .ply"
splat-transform in.ply -l 0 l1.ply -l 1 l2.ply -l 2 [--lod-chunk-count 512] [--lod-chunk-extent 16] out/lod-meta.json
```
- `-l/--tag-lod n` tags the preceding input with LOD level n; `-1` marks the environment
  (README `:141`).
- A `lod-meta.json` output accepts only local **PLY** inputs, or a single streamed-SOG / LCC input
  (`src/cli/index.ts:1433-1445 @ 9c73f01`).
- Chunking: `--lod-chunk-count` K gaussians (default 512), `--lod-chunk-extent` m (default 16),
  `--lod-chunk-min` K (default 8), and `--lod-errors` for per-chunk error tables, which needs a GPU
  (README `:215-224`).

**Schema** (`write-lod.ts:17-64,783-798 @ 9c73f01`; confirmed on the output of the run above):
```jsonc
{ "version": 1,
  "asset": { "generator": "splat-transform v3.6.1", "chunkGaussians": 65536, "chunkExtent": 16, "chunkMinGaussians": 8192 },
  "count": 516096, "counts": [294912, 147456, 73728], "lodLevels": 3, "lodErrors": false,
  "environment": "env/meta.json",            // only when an env input was tagged -1
  "filenames": ["2_0/meta.json", "1_0/meta.json", "0_0/meta.json", …],   // "<lod>_<unit>/meta.json"
  "tree": { "bound": {"min":[…],"max":[…]}, "children": [ …,
            { "bound": …, "lods": { "0": {"file": 2, "offset": 0, "count": 37104}, "1": {…}, "2": {…} },
              "errors": [ … ] } ] } }        // errors only with --lod-errors
```
Each chunk directory is an **unbundled SOG**: `meta.json` (a normal v2 SOG meta) plus the
`means_l/means_u/quats/scales/sh0[/shN]` WebPs.

**Engine consumption.** The app points a `gsplat` asset at **`…/lod-meta.json`**
(`handlers/gsplat.js:21-28`; `parsers/gsplat-octree.js` matches on the basename). The resource is
a `GSplatOctreeResource` (`gsplat-octree.resource.js:43-51`), and chunk files stream through
`GSplatAssetLoader` as the LOD selection requests them.

**Budget balancer and LOD.** The unit is a **splat count** (`splatBudget`, global, default 1M). The
balancer starts every node at its coarsest level and buys single-level upgrades ranked by
`coverage × error-removed / splats-added`, stopping at the first one that doesn't fit
(`gsplat-budget-balancer.js:48-60`). In the default `'distance'` mode, coverage is a
distance-based projected-radius proxy with FOV compensation and a behind-camera penalty
(`gsplat-octree-instance.js:495-630`). `'error'` mode uses the asset's error tables. Re-evaluation
happens on camera move / rotation / FOV change (thresholds above), on params dirty, and on
resource arrival (`gsplat-world.js:543-565`). `lodUnderfillLimit` allows showing a coarser
resident level while the optimal one loads (`gsplat-params.js:456`).

**Observed on the bench asset (a photo lift, not the target class).** At a 150k budget the far band
drops to LOD 1/2, and the uniform `-d` pyramid shows visible holes there. That is the "25% breaks"
result from #36 again. The P2 gate must be a large captured scene with a proper pyramid, not a photo
lift.

## 8. Unknown keys in `meta.json`

- **Engine: keeps them (run).**
  - Bundled `.sog`: `SogBundleParser` stores the parsed JSON unmodified as `GSplatSogData.meta`
    (`sog-bundle.js:252-254,329-331`), reachable at `asset.resource.gsplatData.meta`. The spike read
    `meta.camera` from it after 240 frames. One caveat: v1 metas are upgraded to a fixed shape that
    drops extras (`sog.js:52-82,131-134`), but every file we produce is v2.
  - Streamed: `GSplatOctreeResource.data` retains the raw `lod-meta.json` with only `tree` nulled
    ("retained for consumers that read custom or extension fields", `gsplat-octree.resource.js:28-51`).
    The spike read `data.camera`.
- **Adapter plan:** keep parsing with `inline3d-sog.js` (`readSogMeta` / `sogCameraFromMeta`) on
  the bytes path, as today. On a URL `.sog`, read `resource.gsplatData.meta` after load. That
  removes today's "no camera block on the URL path" limitation (`inline3d-splat.js:302-306`) at no
  extra fetch. On a streamed asset, read `resource.data`. Either way, validate through
  `sogCameraFromMeta`. Don't trust the engine to interpret the block.
- **splat-transform drops it (run).** A bench SOG with a `camera` block, re-encoded `.sog → .sog`,
  came out with keys `version, asset, count, means, scales, quats, sh0`.
  - Reader: `MetaV2` has no `camera` (`read-sog.ts:27-36`).
  - Writer: `metaObj` is built from scratch (`write-sog.ts:398-409`).
  - The streamed writer builds `LodMeta` from scratch too (`write-lod.ts:783-798`), and the chunk
    metas come from `writeSogSource`.
  - **On chunked output the block belongs at the top level of `lod-meta.json`**, sibling to
    `asset`, not in any chunk `meta.json`. The engine already surfaces it there.
  - Upstream precedent for the P4a PR: `model` is the one extra key splat-transform already
    carries through read → write (`read-sog.ts:49-55`, `write-sog.ts:402-403`). A `camera`
    pass-through can follow the same path.

## 9. Adapter design (P1)

**Shape:** `addSplat(wall, canvas, src, { engine: 'playcanvas', … })` → the same handle
(`remove/exclude/unexclude/setFocus/pick/setPose/resetPose/ready/rig/camera/frame/perf/viewer`).
It is implemented in a new `js/inline3d-splat-playcanvas.js` that `inline3d-splat.js` imports
**dynamically**, so a Spark-only page never resolves `playcanvas`.

**Step 0 (prerequisite refactor): split `SceneViewer`'s state machine from three.** The pose/orbit/zoom/
focus/fit/turntable/last-good-replay logic in `inline3d-viewer.js` is renderer-agnostic in
substance, but it is written against `THREE.Group`s and it constructs a `WebGLRenderer` on the
canvas in its constructor (`inline3d-viewer.js:212`). A second context on the same canvas is
impossible. The gallery writes the viewer's private fields directly (`_targetYaw`, `_fitScale`,
`_eye`, `monoCamera`…, `SpatialView.tsx:551-660`). Both backends must therefore expose the **same
controller object with the same fields**. Extract a `PoseController` (plain numbers in, one pivot
matrix out). `SceneViewer` keeps using it with three, and the PlayCanvas adapter uses it with
`pc.Mat4`. The `_applyTransform` ownership rule carries over unchanged: the controller owns the
pivot, and nothing else writes it.

**Engine objects, one set per tile:**
```js
const device = await pc.createGraphicsDevice(canvas, { deviceTypes: [pc.DEVICETYPE_WEBGL2],
  alpha: true, premultipliedAlpha: true, antialias: false, xrCompatible: false,
  preserveDrawingBuffer: opts.preserveDrawingBuffer ?? false });   // same attrs as three's path, plus the #24 knob
const app = new pc.AppBase(canvas);
app.init(Object.assign(new pc.AppOptions(), { graphicsDevice: device,
  componentSystems: [pc.CameraComponentSystem, pc.GSplatComponentSystem],
  resourceHandlers: [pc.GSplatHandler] }));                         // no xr, no mouse/keyboard
app.setCanvasFillMode(pc.FILLMODE_NONE); app.setCanvasResolution(pc.RESOLUTION_FIXED); // SDK sizes the buffer
app.requestAnimationFrame = () => {};   // the SDK's frame drives the engine; no second rAF
patchFootprint(device);                 // §2 gsplatCornerVS override (after init)
app.start();
```
- **Frame driving.** Call `app.tick(timestamp)` from `onFrame` (the wall's `session.requestAnimationFrame`),
  or from the mono loop. `tick` is `@ignore` but documented as the loop body (`app-base.js:201-282`).
  Its `cancelAnimationFrame(null)` and our no-op `requestAnimationFrame` make it safe to call
  directly. Measured cost: 0.4 ms CPU per tick in the spike. `app.render()` alone would skip
  `framerender`, which is where gsplat streaming advances (`gsplat-manager.js:597-600`).
- **Views.** One camera entity `eyeRig` holds one `RenderView` per view. Per frame:
  `rv[i].setView(view.projectionMatrix, view.transform.matrix)` (copies; safe with recycled
  XRView memory) and `rv[i].setViewport(vp.x, vp.y, vp.width, vp.height)` from
  `layer.getViewport(view)`; then `camera.camera.xrViews = rv` (assigned once), and
  `camera.fov` from `P[1][1]`, `nearClip` / `farClip` from the matrix. The `validate-before-clear` /
  `_replayLastGood` rules port as they are: validate the views, then tick, or else replay the
  cached matrices through the same `RenderView`s.
- **Canvas size.** The SDK writes `canvas.width/height` (double-width in 3D, 1:1 in mono), exactly as
  `SceneViewer._resize` does, and the device reads them (`graphics-device.js:1581-1592`). With
  `RESOLUTION_FIXED`, `updateCanvasSize` never touches the canvas (`app-base.js:1327-1339`).
  `maxPixelRatio` is irrelevant because we never call `resizeCanvas`. DPR stays the SDK's business
  (`min(dpr,2) × renderScale`).
- **Orbit and pivot.** `RenderView.updateTransforms` pre-multiplies the camera's parent world
  transform. So put `eyeRig` under a node carrying **inverse(pivot)**, and orbit/zoom/focus move the
  eyes while the splat entity stays still. That avoids the work-buffer re-bake a moving placement
  triggers (`gsplat-world.js:940-956`), and it keeps the display-rig contract, because the views
  still come from the runtime and are only re-expressed in content space. The spike showed equal
  CPU cost for either choice. GPU cost is a P1 measurement.
- **The flip.** Entity `setLocalEulerAngles(180, 0, 0)`: OpenCV → engine, same as Spark's
  `quaternion.set(1,0,0,0)`.
- **Focus and pick.** `setFocus` goes through the `PoseController`, unchanged. For `pick`, the engine
  has a GPU picker for gsplats (`gsplat-director.js:236-252`, `prepareForPicking`, requires
  `scene.gsplat.enableIds`). It is a render pass, so start with the CPU "nearest centre to ray"
  fallback. It needs centres: on the bytes path we already have them from our own SOG reader.
  Otherwise use `resource.gsplatData` (a bundled SOG keeps it, and the spike still saw it after
  240 frames) or the streamed chunk data. **`pick` on streamed assets is limited to resident LODs.**
- **Rig waterfall.** Reuse `resolveRig` / `inline3d-splat-rig.js` unchanged. It needs a cloud sample
  in rest space. `measureBounds` / `sampleRestSpace` currently iterate `mesh.forEachSplat` (Spark),
  so generalise them to take a centres `Float32Array` (+ opacities).
- **Camera block** feeds `resolveRig` exactly as today (§8 for where it comes from). On a camera rig,
  `pushViewRig` → `handle.setViewRig(cameraRigFromCamera(…))` needs a camera-shaped
  `{fov, matrixWorld}`. Pass a plain descriptor (the function reads only `.fov` and decomposes the
  matrix), not a three camera.
- **Perf presets** (Spark → engine, in the same spirit: nothing changes unless asked):

  | Spark knob | engine equivalent | note |
  |---|---|---|
  | `minAlpha` (1/255) | `scene.gsplat.alphaClipForward` (default already 1/255) | global per app = per tile |
  | `minPixelRadius` | `scene.gsplat.minPixelSize` (**default 2 px**, a diameter-ish `max(l1,l2)`) | the engine **already drops sub-2px splats by default**; set 0 for Spark parity in MAE runs |
  | `maxStdDev` (quad extent σ) | none: a fixed multiple of σ, `l = 2·sqrt(2λ)` (`gsplatCorner.js:88-89`); the σ-multiple was not independently derived | needs a chunk override (same technique as the footprint fix) |
  | `alphaRadius` (per-splat 1/255 radius) | none | a chunk override: shrink `l1,l2` by `sqrt(2·ln(a/floor))/sqrt(8)` |
  | decimation / LOD count | **`scene.gsplat.splatBudget`**, Streamed SOG, `lodRangeMin/Max` | the lever #36 is after |
  | — | `antiAlias` (only for AA-trained assets) | off by default |

- **Mono fallback.** It is the same app with `xrViews = null` and a normal camera (fov/aspect, or the
  `applyCaptureCamera` off-axis window via `calculateProjection`). Driven by the mono rAF.

**Engine APIs used, with signatures (2.22.3):**
- `createGraphicsDevice(canvas, {deviceTypes, alpha, premultipliedAlpha, antialias, xrCompatible, preserveDrawingBuffer}) → Promise<GraphicsDevice>`
- `new AppBase(canvas)`; `app.init(AppOptions)`; `app.start()`; `app.tick(timestamp?)`
  (`@ignore`); `app.setCanvasFillMode(FILLMODE_NONE)`;
  `app.setCanvasResolution(RESOLUTION_FIXED)`; `app.destroy()`
- `app.scene.gsplat: GSplatParams`: `splatBudget: number`, `lodMode`, `lodUpdateDistance`,
  `lodUpdateAngle`, `alphaClipForward`, `minPixelSize`, `radialSorting`, `lodUnderfillLimit`
- `new Asset(name, 'gsplat', {url} | file)`; `app.assets.add/load`;
  `entity.addComponent('gsplat', {asset})`; `gsplat.lodRangeMin/Max`
- `entity.addComponent('camera', {clearColor, nearClip, farClip, fov})`;
  `camera.camera.xrViews = RenderView[]`; `camera.calculateProjection = (mat4, view) => void` (fallback)
- `new RenderView()`; `.setView(proj16, viewInv16)` and `.setViewport(x, y, w, h)` (both `@ignore`)
- `ShaderChunks.get(device, SHADERLANGUAGE_GLSL).get/set('gsplatCornerVS', src)`
- `asset.resource.gsplatData.meta` (bundled SOG) / `asset.resource.data` (streamed)

## 10. Go / no-go

- **WebGPU: no for P1, later only on evidence** (§4).
- **Vendoring vs npm: npm, an optional peer dependency** `"playcanvas": ">=2.22.3 <3"` in
  `peerDependenciesMeta` (optional), like three and Spark. No vendoring: MIT, tree-shakeable ESM,
  and a fast-moving gsplat subsystem we want fixes from.
- **Engine floor 2.22.3.** `RenderView` and the `xrViews` setter exist from **2.20.0** (absent in
  2.19.4, checked in the npm tarballs), and `GSplatOctreeResource.data` from ≤2.19.0. But 2.22.3 is
  the only version run, and `setView` / `setViewport` are `@ignore`. So pin the floor to what was
  tested, and feature-detect at runtime: `typeof pc.RenderView === 'function' &&
  'xrViews' in pc.Camera.prototype`. If detection fails, fall back to design (a), N cameras with
  `rect` + `calculateProjection`, which is all public API and bit-identical (§ spike), at N× gsplat
  memory.

## Risks

1. **`RenderView.setView/setViewport` are `@ignore`.** They are the XR path's own calls, so a
   rename would break WebXR too, but semver does not cover them. Mitigation: feature-detect, plus
   the design (a) fallback.
2. **The footprint chunk override is a source patch on an engine chunk.** The anchor can move on any
   engine release. Mitigation: regex anchor, warn once, still render; upstream the fix (P4d). Until
   it lands, an unpatched engine renders visibly wrong on the SBS buffer (MAE 11.5), so **the P1
   parity gate must run with the override verified**.
3. **`app.tick` is `@ignore`.** It is the loop body, but overriding `app.requestAnimationFrame` is
   monkey-patching. The alternative, `autoRender=false` with the engine's own loop running on the
   window rAF alongside the XR session rAF, orders two loops non-deterministically. Take the
   monkey-patch and pin the version.
4. **Per-view `viewport_size` comes from `xrViews[0]`** (`renderer.js:440-452`). All views must have
   equal tile sizes. True for the SBS contract, but an N-view atlas with unequal tiles would break it.
5. **The GPU picker and shadows are camera-scoped.** `isVisibleFunc` matches the manager's own
   camera (`gsplat-quad-renderer.js:466-481`). Harmless for us, but it means any second camera (a
   thumbnail, a picker) gets its own manager and full budget.
6. **Budget is per manager, not per page.** N tiles with N apps means N × `splatBudget` resident.
   The P2 budget has to be divided across visible tiles by the SDK; the engine can't do it.
7. **Default `minPixelSize = 2`** culls fine grain that Spark keeps. Expect a small MAE difference at
   rest until it is set to 0 for parity.
8. **Context attributes.** `premultipliedAlpha: true` + `alpha: true` match three's path. Whether
   the weave's zero-copy read races the engine's back buffer the same way as three's (browser-pvt#24)
   is unknown. Expose `preserveDrawingBuffer`.
9. **Blob workers and CSP.** The gallery must allow `worker-src blob:`.
10. **Bundler:** `node:worker_threads` must be external (§6). Next.js/Turbopack not checked.
11. **Color pipeline:** the engine applies `useTonemap` / `useFog` / gamma to splats
    (`gsplat-params.js:578,586`). An sRGB-encoding mismatch against Spark would show as a
    rest-view MAE offset. Not measured here: the spike's reference was the engine itself.
12. **Uniform-decimation pyramids break photo lifts** (§7). Streamed SOG is for large captured
    scenes. Don't gate P2 on the bench asset.

## NOT TESTED

Asserted from reading or reasoning, not from a run:
- Anything on the **DisplayXR Browser** (Windows D3D11 or Android): the weave join of a PlayCanvas
  WebGL canvas, the #24 race, and real XRView matrices from `inline-3d`. The spike used synthetic
  matrices in stock headless Chrome 153 on an M1 Pro.
- **That runtime views share one orientation**, which is what makes the directional sort exact for
  every view. It follows from the Kooima/display-rig model; not checked against a live `XRView` list.
- **Rest-view parity with Spark** (MAE vs the source photo) and colour/tonemap equivalence.
- **GPU timings.** Only CPU `tick` time and vsync-bound frame time were measured. Nothing on the
  content-spin vs camera-spin GPU cost, and no interleaved GPU timer-query table.
- **WebGPU entirely**, including its 2-view stereo projector and the focal bug in the WGSL chunk
  (the bug was read there, not run).
- **`pick` via the engine's GPU picker** (`prepareForPicking`, `enableIds`).
- `lodMode: 'error'` and `--lod-errors` (needs a GPU in splat-transform), `lodUnderfillLimit`, the
  environment (`-l -1`) path, and streaming over HTTP with real latency (the spike served locally).
- The engine's **v1** SOG meta upgrade dropping extras (read, not run: we only produce v2).
- Multiple PlayCanvas apps (tiles) on one page; context-loss handling; `app.destroy()` teardown and
  worker cleanup.
- The Next.js/Turbopack bundle of `playcanvas` in the gallery.
- Engine versions other than 2.22.3 at runtime. The 2.19/2.20 API presence came from grepping the
  npm tarballs only.
- The `supersplat-viewer` clone (`9d8cc43`) was not analysed beyond what #36 already records.

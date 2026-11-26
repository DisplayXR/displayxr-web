# Convert to 3D — the explore renderer (`js/lift/explore.js`)

**Experimental**, not covered by the 1.x semver promise. Renders a *lifted* photo — a two-layer,
image-aligned 3D Gaussian scene — into the SDK's per-view viewports, with real head parallax from the
runtime's tracked eyes and a drag orbit capped at ±15° that relaxes home on release. The camera model
is the gallery's **Spatial View** (displayxr-gallery-pvt `src/lib/spatialView/camera.ts`, `reveal.ts`,
the wall camera rig in `SpatialView.tsx`); the renderer is the **PlayCanvas engine**, the one behind
`addSplat(…, { engine: 'playcanvas' })` and the gallery's Spatial View. Until 2026-09 it was three +
Spark ("we moved away from Spark, the PlayCanvas viewer is much better" — David); the contract did
not change.

```js
import { createExplore } from './js/lift/explore.js'; // internal module; lift() is the public entry (@displayxr/inline3d/lift)
const ex = await createExplore({ canvas, gl, ply, meta, orbit: { maxAngleDeg: 15, relax: true } });
wall.addScene(canvas, (views, layer) => ex.render({ views, layer, session: wall }));
canvas.addEventListener('pointerdown', (e) => ex.onPointerDown(e)); // + pointermove / pointerup / pointercancel
await ex.fadeIn(500);   // crossfade in over whatever is underneath
await ex.fadeOut(400);  // … and back out; render() then draws nothing
```

## Contract

`createExplore({canvas, gl?, ply, meta, orbit:{maxAngleDeg=15, relax=true, gain?}, onReady, …}) →`
`{ render({views, layer, session}), onPointerDown(ev), onPointerMove(ev), onPointerUp(ev), setTarget(yaw, pitch), fadeIn(ms), fadeOut(ms) → Promise, setDepthGain(x), dispose() }`
(+ `rig`, `sceneScale`, `stats`, and `engine` = the PlayCanvas objects, for diagnostics).

| input | meaning |
|---|---|
| `ply` | standard binary 3DGS PLY, both layers in one file: `x y z nx ny nz f_dc_0..2 opacity(logit) scale_0..2(log) rot_0..3(w,x,y,z)` |
| `meta` | `{focalPx, pivotZ, w, h, layers:2}` — the focal the gaussians were unprojected through, the convergence depth (along the PLY's z), the image size in px (principal point at the centre) |
| `gl` | optional existing WebGL2 context on `canvas` (see *One canvas, one context*) |
| `axes` | `'opengl'` (default) or `'opencv'` — see *The convention adapter* |
| `fit` | `'cover'` (default) / `'contain'` / `'stretch'`: the photo window vs the viewport's aspect |
| `restHead` | `'median'` (default, the gallery's hardware-verified rule) or `'display'` |
| `comfort`, `space` | the comfort normalisation (see *Comfort*); `space` is the depth's `'metric'` / `'disparity'` |
| `eyes` | `'nominal'` (default: eye separation normalised to 63 mm) or `'tracked'` (view positions taken as metres) |
| `perf` | the SDK's splat perf presets, PlayCanvas mapping (`playcanvasPerfSettings`); default `{antiAlias:true}` (see *Rendering*) |
| `depthGain` | initial depth strength about the pivot (lift passes its `depth` option) |
| `startFlat`, `startHidden`, `clear`, `clearAlpha`, `clearColor`, `onClick` | see the JSDoc in `explore.js` |

`render({views})` with `views` omitted is the flat fallback (one eye at the rest head, the whole
canvas). A short view list (the load-induced mono blip) or a missing viewport **replays** the last
good frame instead of clearing (the SceneViewer rule: a woven canvas that is not redrawn can smear).
Pointer handlers call `setPointerCapture`; a press that travels < 6 px is a click (`onClick`), not a
drag. The canvas's backing store belongs to the caller, as `addScene` says; this module never sizes it
(the engine runs `RESOLUTION_FIXED`; viewports are backing-store px).

## The engine, as used here

One `AppBase` per explore (no `XrManager`, no input systems — the SDK owns input), registering only
`CameraComponentSystem` + `GSplatComponentSystem` and the `GSplatHandler`:

```
app.root
├── lift-splat   gsplat component (the PLY) — the OpenCV flip (180° about X) and the comfort scale
│                live HERE and never change: the engine bakes a splat's placement into its work buffer
└── lift-rig     ← the ORBIT, inverted: T(F)·Rᵀ·T(−F), F = (0,0,−D) — written every frame
    └── lift-eye ONE CameraComponent with N `RenderView`s (camera.xrViews) — the engine's own
                 WebXR stereo path driven without WebXR: one gsplat manager, ONE sort and one work
                 buffer serve both eyes
```

- **The subject does not move, the eyes do.** The Spark renderer turned the content under fixed
  eyes; PlayCanvas would re-bake its work buffer for a moving splat entity, so here the rig node
  carries the inverse orbit and each `RenderView` is the eye's translation in rig space (identity
  rotation — the frustum is off-axis). View × model is the same product: `test/lift-explore-pc.test.mjs`
  checks it point for point against the Spark mapping (1e-12).
- **The camera node** sits at the eyes' midpoint: it drives the (single) sort direction. `camera.fov`
  etc. come from `setXrProperties` with the first view's frustum (LOD reads them; the SDK adapter's rule).
- **The PLY** goes through the engine's own parser from in-memory bytes: `new Asset(url, 'gsplat',
  { url, filename, contents: new Response(bytes) })` — no fetch, no `blob:` URL (the lift world's CSP
  would block a `blob:` fetch), no worker.
- **Shader chunks**: the SDK adapter's non-square-pixel **footprint patch** (`gsplatCornerVS`,
  byte-identical to `patchGsplatFootprint` in `inline3d-splat-playcanvas.js`, asserted by a test; a no-op
  on the lift's square-pixel eye viewports) and the lift's own render-time modifier on the tile
  material (`gsplatModifyVS`, see *Depth gain / reveal / fade*).
- **Statically imported** engine members through `../inline3d-playcanvas-engine.js`, so a bundler keeps
  only what this module names (a dynamic import would keep the whole slice — the WebGPU backend and its
  `import()`s included). The device is `new WebglGraphicsDevice(…)` directly for the same reason.

Tested against playcanvas **2.22.3** (`PLAYCANVAS_TESTED`), the SDK's peer floor.

## One canvas, one context (integration with the live DIBR)

The lift canvas has exactly one WebGL2 context, created by the live-DIBR renderer
(`js/lift/live-dibr.js`). Pass it as `gl`. **The engine adopts it** — `WebglGraphicsDevice` takes
`options.gl` (2.22.3: `const gl = options.gl ?? canvas.getContext('webgl2', options)`), so this module
never calls `getContext`, and `app.destroy()` → `device.destroy()` frees the engine's own GL objects
but never loses the context (checked in the 2.22.3 source). No second canvas, no CSS crossfade: the
weave rect registration in `lift.js` keeps targeting the one canvas.

The two renderers hand the context over every frame (`js/lift/explore-gl.js`):

- **`adoptGlState(device)`** before the engine draws — the PlayCanvas equivalent of three's
  `resetState()`: `device.initializeRenderState()` re-issues blend/depth/cull/stencil/scissor/pixel-store
  and resets their caches; the VAO, program, framebuffer, texture-unit and vertex-buffer caches are
  dropped by hand. **Not** `initializeContextCaches()`: it replaces the VAO map, which would leak every
  VAO each frame.
- **`releaseGlState(gl)`** after it: default framebuffer, no VAO/program, the fixed-function toggles
  off, and `UNPACK_COLORSPACE_CONVERSION_WEBGL` back to the browser default (the engine sets NONE,
  which would skip the page image's colour conversion in the DIBR's next upload).

Behaviour on a shared context (unchanged from the Spark renderer):

- The explore tile starts **hidden** (draws and clears nothing) until `fadeIn()`.
- **No clear during a fade.** `fadeIn` / `fadeOut` composite the splats over whatever is in the buffer
  (the gsplat material's premultiplied "over"), so the DIBR frame drawn earlier in the same callback
  shows underneath. Outside a fade the camera clears (colour + depth, once for the whole canvas —
  never between the two eye viewports); `clear: false` disables that.
- `fadeIn(ms)` on a shared context is an **opacity ramp only** (no inflate); standalone it is the
  gallery's inflate reveal. Both selectable: `fadeIn(ms, {inflate, opacity})`. Resolves when finished
  (the ramp advances inside `render()`).
- `fadeOut(ms)` ramps opacity to 0, then `render()` becomes a no-op until the next `fadeIn`.
- The fade is a per-*splat* alpha multiplier; on a dense sheet coverage is `1 − (1 − m)^k` with
  k ≈ 5 splats per pixel, so the requested level is inverted through that (`FADE_OVERLAP`).

`test/lift-explore-gpu.html` (+ `.run.mjs`, headless Chrome) runs exactly this shape: a DIBR stand-in
that leaves its program/VAO bound, blend off and scissor toggled, drawn first on the same context.

## Stereo stability (the disocclusion "blink")

Panel finding on the Spark renderer (2026-09-25): with a real two-eye session the disoccluded
(hidden-layer) regions blinked between black and filled frame to frame. On PlayCanvas one sort serves
both eyes and both `RenderView`s are drawn in the same engine tick from the same sorted order; nothing
clears between the eye viewports. `test/lift-explore-gpu.html` pins it: a fixed asymmetric pair (eye
positions 0.10 m above the tile, 63 mm apart; Kooima projections with the test box's P[9] ≈ −0.91),
orbit +10° so the hidden layer is exposed, then 10 consecutive frames must be **bit-identical** in
both viewports and the strip behind the near box must show the hidden layer (never the clear or the
underlay) in every frame. A mutant that alternates the layer's alpha per frame fails it. The blink
does **not** reproduce on PlayCanvas (and, per the panel, no longer on Spark either after the
`clearAlpha`/quality merges).

The same test checks the **source camera sits at the eye pair's centroid**: at orbit 0 the near box is
vertically centred in both eyes with a level top edge (no shear), and its horizontal disparity is
symmetric about the eyes' centre — the viewer's 0.10 m vertical offset is absorbed by the rest head.

## Camera mapping

The invariant (gallery, verified to MAE 2.6/255 on real assets): **the neutral view is the photo.** The
lift's origin is the capture camera, so an eye at the origin looking through the photo's own frustum
reproduces the picture; only motion reveals depth.

- **Rig** (`rigFromMeta`): pivot depth `D = fwd·pivotZ` (sanity-clamped to 0.1–20 m, the gallery's
  `PIVOT_MIN/MAX_M`); the **window** is the photo frustum cut at the pivot:
  `halfW = D·(w/2)/focalPx`, `halfH = D·(h/2)/focalPx`, then fitted to the viewport aspect (`fit`).
- **Per eye** (`frustumFor`, the gallery's function): camera at the eye `e`, **identity rotation**, an
  off-axis frustum through the fixed window: `d = D + e.z`, `l = (−halfW − e.x)·near/d`, `r = (halfW −
  e.x)·near/d`, `t/b` likewise. Zero parallax sits on the window plane, i.e. the pivot lands on the
  glass. `near = 0.02`, `far = 5000` (the engine sorts rather than depth-tests splats, so the ratio is
  free).
- **Eyes from the runtime** (`createHeadTracker`, the wall's `?rig=camera` branch): the views'
  `transform.position`s are in world units where the tile spans `virtualDisplayHeight`; with
  `eyes:'nominal'` the measured interocular converts them to metres (`0.063 / |E_R − E_L|`), with
  `eyes:'tracked'` they are taken as metres as given (a display rig sized to the physical tile; the
  viewer's real IPD). Positions are relative to a frozen rest head, the median of the first 12 eye
  midpoints — which is why the SOURCE camera is at the eyes' centroid, not on the tile's straight-out
  axis. **The runtime's projection matrices are deliberately not used** — the frustum is the photo's (a
  camera rig, not a display rig); the panel's strongly off-axis vertical projection (P[9] ≈ −0.91) is
  therefore irrelevant here, by construction.
- **Cone clamp** (`clampHead`): the head midpoint is held within `tan(15°)·D` of rest in x/y; both eyes
  move with it so their separation is never squeezed.
- **Orbit on top**: yaw/pitch turn the scene about `F = (0, 0, −D)` — carried by the eyes, inverted
  (see *The engine*). Eyes and window are untouched, so head parallax and the orbit compose.

## Comfort (metric scenes)

Panel finding (David, 2026-09-25): explore on a PHOTO is right; on a paused CG VIDEO frame with MoGe-3
metric depth and a far pivot the depth read far too small — a scene converged 10 m away, seen by eyes a
real IPD apart, has almost no disparity. `comfortScale(meta, {mode, target, tolerance, space})`
(`js/lift/orbit.js`) scales the scene **uniformly about the capture camera** so the pivot lands at
`target` (default **2.0 m**): every splat slides along its own ray, so the neutral image is exactly
unchanged and parallax scales by `pivotZ / target`.

- `mode:'auto'` (default): only `space:'metric'` scenes whose |pivot| is more than 25 % off target.
  **Note**: MoGe-3 stills are metric too, so an indoor photo with its pivot at ~2.9 m is scaled (0.69 on
  the office test photo — 1.46× the parallax it had before this change). `'off'` restores the old view
  for A/B; `lift(el, { explore: { comfort: 'off' | 'always', pivotTargetM } })`.
- The splat entity carries the scale; the rig is built from the scaled pivot, so the window, the cone
  and the reveal's pivot plane are all in the scaled scene. Reported as `ex.sceneScale` /
  `handle.stats.exploreScale`.
- The `.sog` export stays metric and says the same thing the way a camera rig does:
  `dxr.ipd_factor = dxr.parallax_factor = 1 / scale` (see docs/lift.md § Download SOG).

## Depth gain / reveal / fade

One render-time vertex modifier (`LIFT_MODIFY_VS`, the tile material's `gsplatModifyVS` — the engine's
TILE hook that `inline3d-splat-effects.js` uses too: every splat, every view, every frame, no work-buffer
re-render) slides each splat along the ray from a centre of projection `o` so its depth becomes
`t' = D + (t − D)·s`, scaling its size by the same λ — invisible from `o`, only the disparity changes.
World space here is the capture frame (camera at the origin looking −z for every axes convention), so
depth is `−z`. `s = gain` at rest (`setDepthGain`, which `lift`'s `setDepth()` now drives in explore);
`s: 0.05 → gain` over `fadeIn` is the gallery's inflate. `o` is the capture camera, fed the live head
(through the orbit rig) while the reveal plays. The same function multiplies the splat alpha for the
fade. λ keeps each splat on its own ray from `o`, so the engine's sort (by original centres) stays a
valid back-to-front order.

## Rendering: PlayCanvas vs Spark on the same lift

Office photo (`_scratch/photos/office.png`, 1022×574, MoGe-3, 904,821 splats), the same PLY rendered
by both (`samples/lift/dev-explore.html?ply=…&meta=…`, flat path, 1008×566):

| yaw | MAE vs Spark (PC default = AA on) | PC without AA |
|---|---|---|
| −10° | 2.14 | 3.71 |
| 0° | 2.02 | 3.61 |
| +10° | 2.17 | 3.78 |

Without the engine's splat anti-aliasing the lift's hidden-layer splats — sub-pixel-thin where the band
is stretched — draw as horizontal streaks; with it (`perf` default `{antiAlias:true}`) the band reads
like Spark's, and the lit side is marginally sharper. Black (uncovered) pixels at ±10° are the same
fraction on both (0.1–0.2 %), i.e. fill coverage is the generator's, not the renderer's.

## The convention adapter

`LIFT_AXES` in `js/lift/orbit.js`: `opengl` = camera at the origin looking −z, y up (the default);
`opencv` = looking +z, y down (what the generator writes, `meta.convention`; the splat entity gets the
same 180°-about-X turn as `addSplat`'s `flipY`, and depth is `+z`). Pass `meta.axes` /
`createExplore({axes})`.

## Orbit parameters

`js/lift/orbit.js` `createOrbit`, the gallery's `orbitFromDrag` with the PlayCanvas backend's
tilt-and-relax easing (constants shared from `inline3d-splat-shared.js` §ORBIT):

| | value | why |
|---|---|---|
| cap | ±15° both axes | at 20° real lifts show floaters (no support that far off the capture axis) |
| mapping | `target = clamp(Δ/size · gain, ±cap)`, `gain = 2·cap`, measured from the press | a half-width swipe reaches the cap; a fraction of the canvas so a tablet swipe and a mouse agree |
| sign | turntable: +dx ⇒ +yaw (near content slides right), +dy ⇒ +pitch | the scene follows the finger (David, 2026-09-07) |
| held | `k = 1 − exp(−dt/0.2 s)` | tracks with a little weight |
| release | `k = 1 − exp(−dt/0.6 s)` back to rest (0, or `setTarget`'s pose); `relax:false` holds | 15° → 9.1, 5.5, 3.4, 2.0, 1.2, 0.7 at 0.3 s steps |
| click | < 6 px travel | a tap is not a drag |

Unit tests: `test/lift-explore-orbit.test.mjs` (orbit + camera model), `test/lift-explore-pc.test.mjs`
(the camera-side orbit ≡ Spark's content-side orbit, λ, comfort, footprint patch, tracked eyes).

## Test asset

`samples/lift/dev-explore.html` synthesises a lift the generator can drop in for: a procedural photo
(896×672, 60° HFOV) with analytic depth — three boxes in front of a wall at 6 m and a floor — lifted one
gaussian per pixel per layer, pivot 2.0 m, **1,204,224 gaussians**. Query: `views=sbs|mono`, `shared=1`,
`axes=opencv`, `fit`, `perf` (preset or JSON), `grid`, `dpr` + `store=sbs`, `sync=1`, `reveal=0`,
`rep=N` (N draws per animation frame: a GPU-throughput probe), and `ply=<url>&meta=<url>` +
`aspect=W/H` to load a REAL lift (its PLY and meta JSON) instead.

## Performance

M1 Pro, Chrome 154 headless, ANGLE Metal, GPU idle (checked before every run), one Chrome at a time.
The office lift above (904,821 splats), orbit spinning continuously.

| path | store | PlayCanvas | Spark (before) |
|---|---|---|---|
| `lift()` page, woven SBS mock, 800 CSS px tile | dpr 1 (1600×449) | 60.2 fps | 60.0 fps |
| same | dpr 2 (3200×899, `exploreDpr=2`) | 60.0 fps | 60.0 fps |
| dev harness, SBS 2136×600 (dpr 1), `rep=4` | cost per stereo frame | **8.9 ms** (p95 of 4-frame batch 36.8 ms) | 13.2 ms (p95 187 ms) |
| same, 4272×1200 (dpr 2), `rep=4` | cost per stereo frame | **17.1 ms** | 19.3 ms (p95 275 ms) |
| load | PLY parse + upload (`exploreLoadMs`) | 510–560 ms | 220 ms |

Both hold the 60 Hz cap on the product path at dpr 1 and 2; the throughput probe (N frames per rAF,
cost ≈ frame time / N) shows PlayCanvas with ~1.5× the headroom at dpr 1 and without Spark's multi-
hundred-ms regeneration stalls. The load is slower: the engine parses the PLY on the main thread
(Spark used a wasm worker) — ~0.3 s more pause→explore. `exploreMaxDpr` (lift.js) is unchanged.

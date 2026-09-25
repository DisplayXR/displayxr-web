# Convert to 3D — the explore renderer (`js/lift/explore.js`)

**Experimental**, not covered by the 1.x semver promise. Renders a *lifted* photo — a two-layer,
image-aligned 3D Gaussian scene — into the SDK's per-view viewports, with real head parallax from the
runtime's tracked eyes and a drag orbit capped at ±15° that relaxes home on release. It is the
gallery's **Spatial View** (displayxr-gallery-pvt `src/lib/spatialView/camera.ts`, `reveal.ts`, the wall
camera rig in `SpatialView.tsx`) ported into the SDK as one module on the SDK's Spark path.

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

| input | meaning |
|---|---|
| `ply` | standard binary 3DGS PLY, both layers in one file: `x y z nx ny nz f_dc_0..2 opacity(logit) scale_0..2(log) rot_0..3(w,x,y,z)` |
| `meta` | `{focalPx, pivotZ, w, h, layers:2}` — the focal the gaussians were unprojected through, the convergence depth (along the PLY's z), the image size in px (principal point at the centre) |
| `gl` | optional existing WebGL2 context on `canvas` (see *One canvas, one context*) |
| `axes` | `'opengl'` (default) or `'opencv'` — see *The convention adapter* |
| `fit` | `'cover'` (default) / `'contain'` / `'stretch'`: the photo window vs the viewport's aspect |
| `restHead` | `'median'` (default, the gallery's hardware-verified rule) or `'display'` |
| `perf` | Spark overdraw presets, the same `exact / balanced / aggressive` as `addSplat` |
| `startFlat`, `startHidden`, `clear`, `depthGain`, `onClick` | see the JSDoc in `explore.js` |

`render({views})` with `views` omitted is the flat fallback (one eye at the rest head, the whole
canvas). A short view list (the load-induced mono blip) or a missing viewport **replays** the last
good frame instead of clearing (the SceneViewer rule: a woven canvas that is not redrawn can smear).
Pointer handlers call `setPointerCapture`; a press that travels < 6 px is a click (`onClick`), not a
drag. The canvas's backing store belongs to the caller, as `addScene` says; this module never sizes it
and keeps three's pixel ratio at 1 (viewports are backing-store px).

## One canvas, one context (integration with the live DIBR)

The lift canvas has exactly one WebGL2 context, created by the live-DIBR renderer
(`js/lift/live-dibr.js`). Pass it as `gl`:

- three wraps it (`new WebGLRenderer({canvas, context: gl})`); this module **never calls
  `getContext`** when `gl` is given, and three's `dispose()` does not lose the context.
- `renderer.resetState()` runs before every draw (the DIBR moved program / VAO / blend / scissor /
  texture-unit state behind three's cache). Nothing is restored afterwards — the DIBR sets what it
  needs each frame.
- The explore tile starts **hidden** (draws and clears nothing) until `fadeIn()`.
- **No clear during a fade.** `fadeIn` / `fadeOut` composite the splats over whatever is in the buffer
  (premultiplied "over"), so the DIBR frame drawn earlier in the same callback shows underneath.
  Outside a fade the frame is cleared (`clear: false` disables that).
- `fadeIn(ms)` on a shared context is an **opacity ramp only** (no inflate: the DIBR frame already
  has depth, and inflating from flat would read as depth collapsing and regrowing). Standalone it is the
  gallery's inflate reveal instead (the 2D photo was what was on screen). Both are selectable:
  `fadeIn(ms, {inflate, opacity})`. Resolves when finished.
- `fadeOut(ms)` ramps opacity to 0, then `render()` becomes a no-op until the next `fadeIn`. Resolves
  when hidden.
- The fade uses Spark's `mesh.opacity`, a per-*splat* multiplier. On a dense sheet coverage is
  `1 − (1 − m)^k` with k ≈ 5 splats per pixel, so the requested level is inverted through that
  (`FADE_OVERLAP`); a linear `m` read as ~45 % visible at 10 %. The disocclusion layer shows through a
  little mid-fade — fine for a ~0.5 s crossfade.

Verified in `samples/lift/dev-explore.html?shared=1`: a stand-in underlay that leaves GL state the way
`live-dibr.js` does (its program + VAO bound, blend off, scissor toggled, a texture on unit 1) under a
fade-in, a fade-out (Promise resolved, underlay alone afterwards) and a re-fade-in.

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
  glass: content nearer than the pivot pops out, the background recedes. The neutral frustum's width
  is `near·w/focalPx` whatever the pivot, which is why the pivot can be chosen on comfort grounds
  (gallery: `min(convergence, subject)`) without touching the rest pose. `near = 0.02`, `far = 5000`
  (a lifted sky scatters past any smaller far plane and drops out as black holes on orbit; Spark sorts
  rather than depth-tests, so the ratio is free).
- **Eyes from the runtime** (`createHeadTracker`, the wall's `?rig=camera` branch): the views'
  `transform.position`s are in world units where the tile spans `virtualDisplayHeight`; the measured
  interocular converts them to metres (`0.063 / |E_R − E_L|` — the only display fact needed; the web
  SDK exposes no panel size or distance). Positions are taken relative to a frozen rest head, the
  median of the first 12 eye midpoints. That is "IPD factor 1": virtual eyes a real IPD apart in a
  metric scene; leaning 10 cm moves the virtual eye 10 cm. The runtime's projection matrices are not
  used — the frustum is the photo's (a camera rig, not a display rig).
- **Cone clamp** (`clampHead`, the gallery's `clampEye` centred on the capture camera, since a single-
  image lift has one camera): the head midpoint is held within `tan(15°)·D` of rest in x/y; both eyes
  move with it so their separation is never squeezed.
- **Orbit on top**: yaw/pitch turn the scene about `F = (0, 0, −D)` — the screen centre at the pivot
  plane, the same point head motion pivots about — via
  `scene › orbit(at F, R = Ry(yaw)·Rx(pitch)) › centering(−F) › axes › mesh`. Eyes and window are
  untouched, so head parallax and the orbit compose.
- **Depth gain / reveal**: one Spark `objectModifier` (a dyno graph, per splat on the GPU) slides
  each splat along the ray from a centre of projection `o` so its depth becomes `t' = D + (t − D)·s`,
  scaling its size by the same λ — invisible from `o`, only the disparity changes. `s = gain` at rest
  (`setDepthGain`, a non-metric lift's strength knob); `s: 0.05 → gain` over `fadeIn` is the gallery's
  inflate (0.05, not 0: a flat cloud has no depth order and the composite goes arbitrary). `o` is the
  capture camera (= the rest head in this rig), fed the live head midpoint while the reveal plays.
  Remember Spark regenerates only on `mesh.updateVersion()` — a uniform change alone does nothing.

## The convention adapter

`LIFT_AXES` in `js/lift/orbit.js`: `opengl` = camera at the origin looking −z, y up (the assumed
contract, the default); `opencv` = looking +z, y down (what SHARP writes; the mesh gets the same
180°-about-X turn as `addSplat`'s `flipY`, and depth is `+z`). If the generator documents the other
convention, change `LIFT_AXES_DEFAULT` (one line) or pass `meta.axes` / `createExplore({axes})`. The
harness's `?axes=opencv` writes the same scene in the OpenCV convention: at yaw 15° it renders within
MAE 0.008/255 of the OpenGL one.

## Orbit parameters

`js/lift/orbit.js` `createOrbit`, the gallery's `orbitFromDrag` with the PlayCanvas backend's
tilt-and-relax easing (constants shared from `inline3d-splat-shared.js` §ORBIT):

| | value | why |
|---|---|---|
| cap | ±15° both axes | at 20° real lifts show floaters (no support that far off the capture axis) |
| mapping | `target = clamp(Δ/size · gain, ±cap)`, `gain = 2·cap`, measured from the press | a half-width swipe reaches the cap; a fraction of the canvas so a tablet swipe and a mouse agree |
| sign | turntable: +dx ⇒ +yaw (near content slides right), +dy ⇒ +pitch | the scene follows the finger (David, 2026-09-07) |
| held | `k = 1 − exp(−dt/0.2 s)` | tracks with a little weight |
| release | `k = 1 − exp(−dt/0.6 s)` back to rest (0, or `setTarget`'s pose); `relax:false` holds | measured in the harness: 15° → 9.1, 5.5, 3.4, 2.0, 1.2, 0.7 at 0.3 s steps (= 15·e^(−t/0.6)) |
| click | < 6 px travel | a tap is not a drag |

Unit tests: `test/lift-explore-orbit.test.mjs` (cap, gain, sign, absolute-from-press, relax curve at
30/60/144 fps, settle, `relax:false`, `setTarget`, click slop, rig / frustum / fit / cone / head
tracker / axes).

## Test asset

`samples/lift/dev-explore.html` synthesises a lift A4's generator can drop in for: a procedural photo
(896×672, 60° HFOV) with analytic depth — three boxes (front faces at 1.1, 1.75 and 2.7 m) in front of a
wall at 6 m and a floor — lifted one gaussian per pixel per layer (layer 0 = visible surface, layer 1 =
the background with the boxes removed, i.e. what an inpainter puts behind them), pivot 2.0 m,
**1,204,224 gaussians**, the exact PLY field layout above. Query: `views=sbs|mono`, `shared=1`,
`axes=opencv`, `fit`, `perf`, `grid` (resolution fraction), `dpr` + `store=sbs` (size the store like the
woven layer), `sync=1`, `reveal=0`. Headless-verified (puppeteer-core, `--use-angle=metal`): at −15° the
near box slides left while the wall slides right, at +15° the reverse; the region of the blue box
hidden behind the near box at rest opens onto the layer-1 floor when orbiting (the two layers
composite, no holes).

## Performance

M1 Pro, Chrome 153 headless, ANGLE Metal, 1.20 M gaussians, the orbit spinning continuously (so
Spark re-sorts every frame). **Caveat: the GPU was at 87–100 % utilisation from other processes the
whole time** (other sessions on this box); the high-resolution rows are pessimistic and noisy.

| store (both views) | per eye | p50 frame | mean frame |
|---|---|---|---|
| mono 2200×1650 | 3.6 MP | 16.7 ms | 16.7 ms (60 fps) |
| SBS 2200×825 (dpr 1) | 0.9 MP | 16.7 ms | 16.7 ms (**60 fps**) |
| SBS 4400×1650 (dpr 2) | 3.6 MP | 16.6 ms | 19–38 ms (26–53 fps), p95 55–160 ms |
| SBS 4400×1650, `perf:'aggressive'` | 3.6 MP | 16.6 ms | 18.6 ms (54 fps), p95 ~56 ms |
| SBS 4400×1650, 301 k gaussians (`grid=0.5`) | 3.6 MP | 16.7 ms | 16.7 ms (60 fps) |

`render()` itself costs 0.2–0.4 ms of CPU. Synthesising the PLY takes ~120 ms, Spark's parse + upload
~300 ms.

**The stereo fix that got the dpr-1 row to 60 fps.** With Spark's default `autoUpdate`, every
`renderer.render()` whose camera moved > 1 mm runs Spark's update — splat *generation* and sort
scheduling — and a stereo frame alternates two cameras 63 mm apart, so all 1.2 M splats were
regenerated twice per frame: p95 100–140 ms, mean 27–33 ms, where mono ran a flat 60 fps. This module
sets `autoUpdate: false` and runs one update per frame from the eyes' midpoint (one generate, one
sort, both eyes). It must be Spark's internal `updateInternal({autoUpdate: true})`: the public
`update()` forces a full regeneration on every call (mono dropped from 60 to ~25 fps with it). That is
the one Spark internal this module relies on; it falls back to `update()` if a Spark release renames
it. **`addSplat` on Spark has the same double-regeneration today** (`inline3d-splat.js` leaves
`autoUpdate` on) — worth porting when the integrator factors `createSplatRenderer` out.

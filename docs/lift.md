# lift — Convert to 3D

**EXPERIMENTAL** — the `./lift` subpath is preview tier (docs/sdk-stability.md). This page is the
overview and the integration contract; each module has its own page:
[models + providers](lift-models.md) · [live DIBR](lift-dibr.md) · [lift generator](lift-gen.md) ·
[explore renderer](lift-explore.md).

`lift(element, opts)` turns an ordinary `<video>`, `<img>` or `<canvas>` on a page into 3D **in place**:
a video plays as **live** 3D (per-frame monocular depth + depth-image-based rendering), and when it
pauses or ends the frame is **lifted** into a small 3D Gaussian scene you can **explore** with a
bounded orbit. A still goes straight to explore. On the DisplayXR Browser the canvas weaves
glasses-free; everywhere else it renders the same pipeline as a single mono view (the 2D fallback).

```js
import { lift, resolveMediaAt } from '@displayxr/inline3d/lift';

const h = await lift(document.querySelector('video'));
h.on('statechange', ({ state, from, reason }) => console.log(from, '→', state, reason));
h.on('progress', ({ phase, value }) => {});   // phase: 'models' | 'depth' | 'lift', value 0..1
h.on('error', ({ error, fatal }) => {});      // fatal=false: live/lift hiccup, still usable
h.setDepth(1.4);
h.stats;       // { state, fps, modelLoadMs, liveDepthMs, stillDepthMs, generateMs, exploreLoadMs, pauseToExploreMs, splats }
h.setOrbit(8); // explore: turn the lifted scene (degrees, clamped to the orbit cap)
h.explore();   // freeze + lift now (pauses a playing video)
h.resume();    // back to live (plays the video; its `play` event crossfades explore → live)
h.remove();    // unmounts; the element is exactly as it was

// "Convert whatever is under the pointer":
addEventListener('click', (e) => { if (e.altKey) { const el = resolveMediaAt(e.clientX, e.clientY); el && lift(el); } });
```

The explore renderer needs the SDK's optional peers `three` (≥ 0.180) and `@sparkjsdev/spark` (2.x),
resolvable as bare specifiers (an import map or a bundler), exactly like `addSplat`. The models are
never bundled: see [Models](#models-and-onnx-runtime).

Sample: [`samples/lift/`](../samples/lift/) — runs the real models when its model tree answers
(`?providers=real|stub` to force). Locally:

```sh
mkdir -p _scratch
ln -sfn ~/dxr-2d3d-exports/models _scratch/models                          # vda/ still/ da2/ inpaint/ dev/
ln -sfn /path/to/node_modules/onnxruntime-web/dist _scratch/ort           # optional; else jsDelivr
python3 -m http.server 8812 --bind 127.0.0.1
open 'http://127.0.0.1:8812/samples/lift/index.html?image=/_scratch/photos/office.png'
```

## Options

| option | default | |
|---|---|---|
| `mode` | `'auto'` | `auto`: live while playing, lift on pause/end. `live`: never lifts by itself (`explore()` still does). `explore`: lift as soon as the models are in. |
| `depth` | `1` | depth strength multiplier (live DIBR). |
| `convergence` | `'auto'` | zero-disparity depth; handed to live-DIBR as given. |
| `quality` | `'auto'` | `low`/`medium`/`high`; `auto` picks `medium` on a desktop with ≥ 4 GB and ≥ 4 cores, else `low` — **never `high`** (MoGe-3 1022×574 is 2.8 s vs 1.3 s, and a 1536-wide lift is ~1.2 M splats). The still model, generator and inpainter get the concrete tier; the video model keeps `auto` (its warm-up picks 364×210 vs 518×294 by measured frame time). |
| `wall` | — | an existing `createInline3D()` manager to join. **Pass it if the page already has one** — one inline-3D session per document. |
| `orbit` | `{ maxAngleDeg: 15, relax: true }` | explore orbit bounds; `relax` springs back to centre on release. |
| `models` | `'auto'` | a `ModelSource`; a base URL string (= `createModelSource({ baseUrl })`); or `'auto'` (`createModelSource({})`: the native store in the DisplayXR Browser, else the public blob store). |
| `ort` | — | onnxruntime-web: the module, its `dist/` URL, or `loadOrt` options. Default: `loadOrt()` (jsDelivr, pinned). |
| `providers` | `{ video: 'vda-small', still: 'moge3', inpaint: 'none' }` | `still` also accepts `'da3'`, `'da2-small'`, a manifest name or a registered provider name. `inpaint: 'light-inpaint-v1'` enables the net (off by default: see *Known issues*). |
| `prefetch` | `false` | load the still model as soon as live runs. Live depth is **held** while it compiles (see *One ORT session at a time*). |
| `exploreMaxDpr` | 1 woven / ∞ flat | dpr cap on the canvas while explore is up. 1 on the woven SBS store unless `quality: 'high'`. |
| `ui` | `'builtin'` | a small chip (progress %, Explore / Resume / Exit) in the element's corner; `'none'` = drive the handle yourself. |
| `signal` | — | `AbortSignal`; aborting removes the lift. |
| `backend` | `'real'` | `'stub'` swaps in `js/lift/stubs/*` (same contracts, no ML) — development and demos only. |

Handle: `state`, `element`, `canvas`, `layout` (`standard`/`picture`/`aspectRatio`/`overlay`),
`woven` (true = inline-3D session, false = 2D fallback), `stats`, `on(type, cb) → off`, `off`,
`explore()`, `resume()`, `setOrbit(yaw, pitch)`, `setDepth(x)`, `setConvergence(x)`, `remove()`.
Types: [`lift.d.ts`](../lift.d.ts).

## State machine (`js/lift/state.js`)

```
            start            loaded (video)
  idle ───────────▶ loading ───────────────▶ live ◀───────────── play / emptied / seeked-while-playing
                       │  │                   │  ▲                         │
                  fail │  │ loaded (still,     │  │ play                    │
                       ▼  │ or mode:explore)   │  │                         │
                    error │     pause (150 ms  │  │                         │
                          │     debounce) /    ▼  │                         │
                          └──────────────▶ freezing ──frozen──▶ lifting ──lifted──▶ explore
                                  ended /     ▲ seeked-while-paused (new gen)          │
                                  explore()   └────────────────────────────────────────┘

  live | loading | freezing | lifting | explore ──hidden──▶ suspended ──visible──▶ (where it was)
  any ──remove / element disconnected──▶ disposed        any ──fatal──▶ error
```

- **Pause is debounced 150 ms** (`PAUSE_DEBOUNCE_MS`); a pause that is undone inside the window never
  lifts, and a scrub (many `seeked` while paused) schedules one lift, not one per seek.
- **Generation counter.** Every freeze gets a new `gen`; `frozen` / `lifted` / `lift-failed` carrying
  an older gen are dropped. A provider that ignores its `AbortSignal` still cannot land a stale view.
- `play` in explore **crossfades** back to live (uses the explore renderer's `fadeOut` if it has one).
- `seeked` while playing → `provider.reset()` (temporal models must not blend across a cut).
- `ended` → explore the last frame immediately.
- `emptied` / `loadstart` (src swap) → reset, stay live.
- Element removed (per-frame `isConnected` + a `MutationObserver`) → `disposed`, element restored.
- `visibilitychange` hidden → `suspended`: inference stops, models stay loaded. An in-flight lift is
  cancelled and restarted on return if the video is still paused.
- `ResizeObserver` / window resize / devicePixelRatio change → canvas re-placed and re-allocated.
- Lift failure on a video is **non-fatal** (back to live, `error` with `fatal:false`); on a still it is
  fatal (nothing else to show). Fatal errors hide the canvas and leave the page's element visible.

## Placement (`js/lift/placement.js`)

A port of the Immersity Lens approach. `resolveMediaAt(x, y)` scans the whole `elementsFromPoint`
stack (looking *through* overlays, into open shadow roots, and resolving hits inside a player's chrome
such as YouTube's `.html5-video-player` to its `<video>`), then falls back to the
`findImgInParentsAndSiblings` walk (own subtree, then siblings, ≤ 5 levels). Candidates must be
≥ 50 px with aspect 0.2..5.

`mountCanvas(el)` inserts a host in the element's own container (layout modes: `standard`,
`picture` — next to the `<picture>`, `aspectRatio` — inside a padding-bottom ratio box, `overlay` —
absolute/fixed/transformed media, z-index + 1). The host matches the element's **content box**, holds
the canvas in a **closed shadow root**, and the canvas matches the visible media pixels per CSS
`object-fit` / `object-position` (a video's letterbox comes from `videoWidth/Height`). When object-fit
crops (`cover`, `none`), the providers and the DIBR read a crop of the visible part. `pointer-events`
is `none` in live (page and player controls keep working) and `auto` in explore (drag to orbit).
The element itself is never modified; `unmount()` removes the host.

## Session

All lifts in a document share **one** `createInline3D()` manager — the page's (`opts.wall`) or a
private one created on first use and closed when the last lift is removed. The canvas is a normal
`addScene()` window: the SDK calls back with `(views, layer, frame)` and lift forwards
`{ views, layer, session }` to live-DIBR / explore. The backing store is SBS (2 × width) while a
session is live. Without inline-3D, the same frame function runs from `requestAnimationFrame` with one
mono view and a full-canvas `getViewport` — the 2D fallback. If the session ends (`onLayerLost`), the
lift continues on the fallback loop. The builtin chip is registered with the window's `exclude()`.

## Provider interfaces

These are fixed; each module is built against them independently.

- `js/lift/providers/depth-ort.js`: `createDepthProvider({kind:'video'|'still', modelSource, ort?, quality}) → DepthProvider` with `id, kind, load({signal,onProgress}), estimate({source: HTMLVideoElement|HTMLImageElement|HTMLCanvasElement|VideoFrame|ImageBitmap, t}) → Promise<{data: Float32Array /*row-major h×w*/, w, h, space:'disparity'|'metric', intrinsics?:{focalPx}}>, reset(), dispose()`. Disparity is relative, larger = nearer, un-normalised.
- `js/lift/providers/models.js`: `createModelSource({baseUrl?, manifest?}) → { get(name) → Promise<{stream, size, sha256}>, url(name) }`, plus `loadOrt({baseUrl}) → ort` and `getRegistry()` with `registerDepthProvider(name, factory, {priority})`.
- `js/lift/live-dibr.js`: `createLiveDibr({canvas /*WebGL2*/}) → { setSource(el|VideoFrame), setDepth({data,w,h,space}), setParams({depth, convergence, dilate}), render({views, layer, session}) /* draws every view into layer.getViewport(view), same convention as addScene callbacks */, dispose() }`.
- `js/lift/gen/lift-gen.js`: `generateLift({rgb: ImageBitmap|HTMLCanvasElement, depth:{data,w,h,space,intrinsics}, inpainter?, quality, signal, onProgress}) → Promise<{ply: ArrayBuffer /*binary 3DGS PLY*/, meta:{focalPx, pivotZ, w, h, layers:2}}>`.
- `js/lift/explore.js`: `createExplore({canvas, gl?, ply, meta, axes?, clearAlpha?, orbit:{maxAngleDeg, relax}}) → Promise<{ render({views, layer, session}), onPointerDown/Move/Up(ev), setTarget(yaw,pitch), fadeIn(ms), fadeOut(ms), setDepthGain(x), dispose() }>` (async: Spark parses the PLY in a worker).
- Inpainter (`js/lift/providers/inpaint-ort.js`): `createInpainter({modelSource, ort?, quality, model?}) → { load(), inpaintTwoSided(rgbChw, maskRight, maskLeft, W, H) }`.

### How lift.js uses them (the parts the contracts leave open)

- **One canvas, one WebGL2 context.** Live-DIBR and explore are both created on the same canvas, so
  `getContext('webgl2')` returns the same context to both. Each must set the GL state it needs on
  every `render()` (program, VAO, textures, blend, viewport) and must not assume the other left it
  clean. While explore fades in, lift renders DIBR first and explore on top — so explore must **not
  clear** while its fade alpha is < 1 (the stub clears only at full opacity).
- **Optional `fadeOut(ms)`** on the explore renderer is used for the explore → live crossfade when
  present; without it the switch is a cut.
- **Provider selection.** `registry.getDepthProvider(name, {kind, modelSource, ort, quality, model})`
  returns an **instance**: `name` is a registered provider (`'ort'`, a native one) or a model family /
  manifest name handed to the best provider as `model`. Without a registry lift falls back to
  `createDepthProvider`. The ORT providers register themselves when `providers/index.js` loads.
- **Inpainter.** `registry.getInpainter(providers.inpaint, {modelSource, ort, quality})`, `load()`ed
  lazily on the first lift; any failure is a non-fatal `error` (`phase: 'inpaint'`) and the lift
  continues with the generator's push-pull fill. `'none'` (the default) skips it.
- **Focal.** The still depth arrives at model resolution (e.g. 770×434) and MoGe's
  `intrinsics.focalPx` is in that grid. `generateLift` wants it in pixels of the RGB it is given
  (it rescales to its own raster, and `meta.focalPx` is in output-raster px), so lift multiplies by
  `bitmap.width / depth.w` first. Depth maps themselves go to live-DIBR and the generator at model
  resolution; both upsample (bilinear `R16F` / joint-bilateral).
- **Axes.** The generator writes the OpenCV camera frame (`meta.convention` / `meta.axes =
  'opencv'`); explore defaults to OpenGL, so lift passes `axes: meta.axes || meta.convention`.
- **Pivot.** `meta.pivotZ = min(convergenceZ, subjectZ)` — the gallery's Spatial View rule. `subjectZ`
  is the median layer-0 depth of the central box; `convergenceZ` the depth at the mean normalised
  disparity of the central 60 %. The median alone landed on the background whenever the frame's
  centre is sky/wall between near objects, and the whole foreground then swung under the orbit.
- **Opaque explore.** Explore clears opaque black (`clearAlpha: 1`). With a transparent clear, every
  pixel the splat sheet did not fully cover showed the page's own flat `<img>`/`<video>` underneath —
  a ghost double of the foreground under the orbit.
- **One ORT session at a time.** onnxruntime-web must not create or run a second session while one
  is running (measured: wasm `Aborted()` / `unreachable` / out-of-bounds, after which the ORT
  instance is dead). lift awaits the in-flight live estimate before the still model is loaded or
  run, holds live inference while still depth / inpainting run, and `prefetch` holds it while the
  still model compiles. The video provider's `reset()` is serialised behind its queue.
- **Convergence** is passed to `setParams` as given (`'auto'` or a number); live-DIBR resolves `'auto'`.
- **Live inference** runs at most one `estimate()` at a time, only on a new video frame, and depth
  that arrives after a `reset()` is discarded. The frozen frame's still-model depth is also pushed to
  live-DIBR, so the paused frame looks its best while the lift runs.
- **Progress.** The chip shows one bar per phase group: models 0–25 %, depth 25–35 %, lift 35–100 %.
  Providers report `{loaded,total}` (downloads) or `{stage,progress}` (generator); lift normalises.
- **dpr.** Live DIBR always renders at full dpr. While explore is up the canvas is capped at
  `exploreMaxDpr` (default 1 on the woven SBS store; the mono 2D fallback held 60 fps at dpr 2).
- **Shared GL.** Live-DIBR creates the canvas's WebGL2 context and exposes it as `dibr.gl`; explore
  wraps it (`gl` option) and calls `resetState()` before each draw; DIBR sets its full state every
  `render()`. During the 350 ms fade both draw in one callback (DIBR first).

## Models and ONNX Runtime

Models are never bundled. `js/lift/models.json` (schema 1) names every file with its size and
sha256; [`lift-models.md`](lift-models.md) has the families, sizes, licences and measurements.
A file's URL is, in order: the page's `baseUrl` + the file's `path`; an absolute per-file `url`;
else the public content-addressed store `${blobBaseUrl}/${sha256}.${format}`
(`blobBaseUrl` = `https://github.com/DisplayXR/displayxr-models/releases/download/blobs`). Each
entry's `installer: true|false` marks the default set the DisplayXR Browser's Windows installer
provisions (false only for the two DA3Mono-L files). **The browser installer carries a
byte-identical copy of this manifest** (`displayxr-browser-pvt` `installer/models.json`, spec
`docs/model-distribution.md` there), so a change here is a change to what the installer
downloads — bump `generated` and re-sync the copy. Inside the DisplayXR Browser the models come from
its native store (`displayxr-lift://models/<name>`) instead of the network.

## Measured end-to-end (M1 Pro, Chrome headless `--use-angle=metal --enable-unsafe-webgpu`, 2026-09-25)

`samples/lift/`, the synthetic 1280×720 pan (`dev/pan.mp4`) and the office photo (1022×574), models
from localhost, the local ORT 1.31 dev build (JSPI), `quality: 'auto'` (→ medium), no inpainting.
GPU idle (< 10 % for 6 s) before each run; the numbers are one run each — expect ±15 %.

| | 2D fallback, dpr 1 | 2D fallback, dpr 2 | mock woven session (SBS), dpr 1 |
|---|---|---|---|
| video: `lift()` → live (VDA-S, `auto` warm-up → 364×210) | 3.4 s | 3.0 s | 3.4 s |
| live: page fps / depth per frame | 60 / 77 ms (13 Hz) | 60 / 79 ms | 60 / 79 ms |
| 1st pause → explore, **cold** Cache API (MoGe download + sha256 + session, depth 1.5 s, generate 0.37 s, PLY parse 0.2 s) | 8.2–9.0 s | 6.5 s | 7.5–8.1 s |
| 2nd pause → explore (model resident) | 1.8–2.9 s | 1.8 s | — |
| explore fps, orbit spinning (0.76–0.86 M splats) | 60 (p95 16.7 ms) | 60 (1600×900, p95 16.8 ms) | 60 |
| image (1022×574): `lift()` → explore, MoGe from a **warm** Cache API (load 1.1 s) | 3.1 s | | 3.2 s |

Each harness run is a fresh Chrome profile, so the video's first pause always paid the 715 MB
download + hash from localhost; with a warm cache (a returning visitor, or the DisplayXR Browser's
native store) the first pause is ≈ 1.1 s load + 1.5 s depth + 0.6 s ≈ 3 s.

`quality: 'high'` at dpr 2: live depth 147 ms/frame (518×294), pause → explore 9.7 s / 3.7 s, 1.2 M
splats, explore still 60 fps in the mono fallback. With `inpaint: 'light-inpaint-v1'` add 1.0–1.5 s to
every lift.

## Known issues

- **Hidden-layer residue (after the quality pass, 2026-09-25).** The object-shaped ghosts behind
  foreground (chair back, mountain ridge, the synthetic spheres) are gone: the hidden layer now takes
  its depth and colour from the background found *past* each silhouette (lift-gen `farside`), and
  whole foreground objects no longer seed its fill. What remains: a faint (~3/255) crescent where the
  band meets the wall on flat synthetic backgrounds; a 1-px outline where the photo itself has a glow
  round an object (the background-side mixed pixels are opaque layer-0); horizontal streaks of floor
  texture under objects that stand on it; a thin dark sliver where the depth map fades an object into
  its background with no step (no edge ⇒ no hidden layer). See docs/lift-gen.md.
- **Inpainting net: still off.** Re-tested after the fix on office / Big Sur Road / Shore Rocks: the
  whole-object duplicates are gone with the net too, but it adds 1.3–1.5 s per lift and on wide masks
  still leaves textured seams (a ragged dark streak under the Big Sur ridge, faint lamp/desk remnants in
  the office) where the net-free fill is clean. `inpaint: 'none'` stays the default.
- **Frame edges.** The outpaint border is now sized per side to what a 15° orbit can reveal there
  (mirrored continuation of the frame), so office / rocks / spheres show no black strip at ±10°. It is
  capped at 12 % of the width: a metric-depth landscape with near ground at the bottom (Big Sur Road:
  ~890 px needed against a 28 m pivot) still shows black at the corners and bottom.
- **First pause latency** is dominated by creating the 715 MB MoGe-3 session (~4.5 s).
  `prefetch: true` moves it to just after live starts, at the price of held live depth meanwhile.
- **Spark**: disposing the explore renderer surfaces an unhandled `Worker terminate` / `No target`
  rejection from Spark's worker pool (harmless). `addSplat` still has the stereo double-regeneration
  that `createSplatRenderer` fixes (CHANGELOG).

## Stubs (`js/lift/stubs/`)

Same contracts, no ML: a luminance + bottom-is-nearer ramp for depth, a one-pass backward-warp DIBR,
a point-grid PLY generator (two layers, INRIA property layout), and a point-sprite explore renderer.
In the mono 2D fallback the DIBR and explore stubs sway slowly so the page visibly shows the pipeline
running. Use `backend: 'stub'`.


## Media codecs

The DisplayXR Browser is built without proprietary codecs: `<video>` sources must be VP9 or AV1 (WebM/MP4). An H.264/HEVC source never reaches `loadeddata`; `lift()` then fails fast with a `MediaError` (`code 4`, `MEDIA_ERR_SRC_NOT_SUPPORTED`) and an `error` event instead of staying in `loading`. YouTube serves VP9/AV1, so it is unaffected.

## Chrome over the tile (chip, buttons, overlays)

Anything the lift draws over its own woven tile must use a **near-solid background and no `backdrop-filter`** (the authoring guide's config C3). A frosted element over a tile makes the DisplayXR Browser send that tile raw — the panel shows side-by-side instead of 3D — until the element leaves the tile. This was hit on the first panel test with the builtin chip.


## Live look-around

`lift(el, { live: { lookAround: 0..1 } })` — with a real inline tile the source camera sits at the centroid of the current eye pair (stereo only, default `0`); `lookAround > 0` lets head motion produce transient parallax that re-centres over ~1 s. See `docs/lift-dibr.md`.

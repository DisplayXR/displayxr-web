# Changelog — `@displayxr/inline3d`

Versioning follows [`docs/sdk-stability.md`](docs/sdk-stability.md). Read that first: the core
entry points (`.`, `./three`) are frozen for 1.x, while the **scene subpaths** (`./viewer`,
`./splat`, `./model`) are a preview tier whose options may change in any release. Entries below say
which tier they touch, because that is what tells you whether an upgrade can move your pixels.

## Unreleased — proposed 1.22.0 (minor: a new experimental subpath)

Adds a **preview-tier** subpath; nothing existing changes.

### Added

- **`@displayxr/inline3d/lift` — "Convert to 3D"** (experimental). `lift(element, opts)` lifts a
  `<video>`, `<img>` or `<canvas>` in place: live depth-image-based rendering from a streaming
  Video-Depth-Anything-Small while a video plays; on pause/end (or for a still) MoGe-3 depth → a
  two-layer 3D Gaussian scene (`gen/`) → a bounded drag orbit with head parallax (`explore`). A state
  machine (debounced pause, generation counter, visibility suspend), closed-shadow canvas placement
  that follows `object-fit`, a builtin chip, and a pluggable provider registry
  (`getRegistry().registerDepthProvider` for native/vendor depth). Models are never bundled:
  `js/lift/models.json` (schema 1, with `blobBaseUrl` + per-entry `installer`) is resolved against
  the page's `baseUrl`, else the public content-addressed blob store; onnxruntime-web is imported at
  runtime. Types in `lift.d.ts`; guide in `docs/lift.md`.

### Notes

- `createSplatRenderer` in `js/lift/explore.js` fixes Spark's stereo **double regeneration**
  (`autoUpdate` off, one `updateInternal` per frame from the eyes' midpoint): 26–33 → 60 fps at
  1.2 M splats, dpr 1, SBS. **`addSplat` (`./splat`, Spark engine) still has the bug** — port the fix
  when `createSplatRenderer` is factored out (not done in this release).

## 1.21.1 — 2026-09-24

Touches the **preview tier** (`./splat`, `engine: 'playcanvas'` only). No API change; nothing changes at rest.

- **A gated `reveal` no longer shows its start state frozen.** The splat is hidden until the reveal's clock
  starts, so its first visible frame is the first frame of motion; previously the start state (e.g.
  `assemble`'s scatter) sat still for up to the rest of the `firstWoven` hold, then jumped. On a cached
  asset the tile is empty for the rest of the hold instead.

## 1.21.0 — 2026-09-24

Touches the **preview tier** (`./splat`, `engine: 'playcanvas'` only). Minor: a new `setSource`
option. No pixel change for any existing transition, and the default (`cut`) is unchanged.

### Added

- **Sequence transitions: one splat at a time** (#36). `setSource(next, { transition: 'reassemble' })`
  disperses the current photo (`assemble` played backwards), releases it, loads the next one and
  assembles it: 3000 ms, 45 % out, a 10 % empty beat, 45 % in. The general form
  `transition: { type: 'sequence', out, in, durationMs?, beat?, easing? }` runs any two of
  `assemble`, `dissolve-in`, `converge`, `shimmer`, `sweep`, `fade` (each draws nothing at its start,
  which is what makes the swap invisible; `inflate` and `dissolve` are refused).
  - No second camera, live-outgoing layer, overlay target or frozen capture: the eye camera renders
    every frame with one asset in the scene, so the transition machinery cannot hold an image still
    under a moving head. The fallback if a panel still pauses on the other transitions.
  - One splat resident: the next file is only FETCHED during the out phase, and reaches the engine
    after the old asset is destroyed and unloaded. `prepareSource(src, { transition: 'reassemble' })`
    therefore only fetches and compiles (`numSplats` is `null`); `resident: true` opts back into the
    full prepare. Measured peak: 1 asset, 1,179,648 gaussians, 58.8 MB of GPU textures, the still
    photo's (a live `crossfade`: 2 assets, 131.6 MB).
  - Latest wins: a newer sequence takes over from the amount on screen; any other call ends it as it
    ends any transition. An HTTP error on the next file brings the current photo back and rejects.
  - Both bodies are pre-warmed (by `prepareSource`, or before the out clock starts); `?dxrdiag`
    records the sequence with its steps. See `docs/splat-effects.md` § Sequence transitions.

## 1.20.0 — 2026-09-24

Touches the **preview tier** (`./splat`, `engine: 'playcanvas'` only). No pixel change at rest; the
first frames of a live `crossfade` / `wavefront` / particle transition change (see Fixed).

### Added

- **Transition diagnostics: `diag` / `?dxrdiag`** (#36). Off by default. Records every woven
  frame (interval, whether its eye poses are bit-identical to the previous frame's, what the
  transition overlay shows), every `setViewRig` push with its values, long tasks and the
  `setSource` phases. Shows a small overlay excluded from the weave, logs one
  `[dxr-diag] transition #N <verdict>` line per transition, and exposes `window.__dxrDiag`
  (`copy(__dxrDiag.dump())`). Kill switches for A/B: `norig`, `frozen`, `nowarm`, `cold`,
  `nooverlay`. See `docs/playcanvas-adapter.md` § Diagnosing transition stalls.

### Fixed

- **The live outgoing photo no longer starts as a still** (#36). A live transition put the old
  photo on a FRESH gsplat manager at the swap, and until that manager's first sort came back the
  overlay showed the frozen capture at full weight: the whole picture stood still for 2–7 frames
  right as the transition started. The live camera now pre-sorts the current photo BEFORE the swap
  (it stays on screen, untouched, meanwhile), so the overlay samples the live image from the swap
  frame on: 0 frozen frames. The transition starts later by about the length of that sort instead
  (bounded at 1.5 s, then the old bridge). `?dxrdiag=cold` restores the 1.19.2 path.

## 1.19.3 — 2026-09-24

Touches the **preview tier** (`./splat`, `./model`). No API change and no pixel change on a core that
has view rigs.

### Fixed

- **A view rig the wall cannot take is no longer dropped silently** (#36).
  - Every scene backend (`./splat` Spark and PlayCanvas, `./model` PlayCanvas) declared its rig
    with `handle?.setViewRig?.(rig)`. On a handle from a core that predates view rigs, that call
    does nothing.
  - A page that vendors an older `inline3d.js` and hands that wall to `./splat` therefore had its
    CAMERA rig thrown away. The wall wove the metric photo scene on the `addScene` display-rig
    shorthand (`virtualDisplayHeight` 0.24): way off in convergence and scale in 3D, correct in 2D.
    That is how the gallery's Spatial View wall regressed; the rig this SDK declared was the same
    from 1.8.0 to 1.19.2.
  - Now it logs one `console.warn` per page ("the view rig was dropped: your inline3d core
    predates view rigs …") carrying the dropped rig.
  - The Spark path used `handle?.setViewRig(…)` without the second `?.`, so it would have THROWN
    there. It now takes the same warning path.
  - Regression tests pin the declared rig for a camera-rig asset with `zoom {1, 2, relax}` and the
    `assemble` reveal, at rest and after the reveal, on the fake engine.

## 1.19.2 — 2026-09-24

Touches the **preview tier** (`./splat`, `engine: 'playcanvas'` only). No API change and no pixel
change: every frame of a `crossfade` or `wavefront` is the one 1.19.1 draws, and the end is still a
plain `cut` (MAE 0.000).

### Changed

- **The live `wavefront` costs about one photo's draw, not two** (#36).
  - Its depth ridge was an entity-scope work-buffer modifier: a full rewrite of the new photo's
    1.18M-gaussian work buffer and a CPU re-sort, every frame (0.9–1.0 of each per frame, measured).
    It now runs at render time on the eye camera's gsplat manager, as the particle transitions do:
    0 rewrites and 0 sorts in the window.
  - Each photo is drawn only on its side of the front: the new one left of where its commit
    starts, the old one right of where it ends, so the two overlap only in the band. A gaussian
    whose on-screen footprint (bounded the way the engine sizes its quad) lies wholly on the far
    side in every eye gets alpha 0, which the engine culls in the vertex stage. Frames with the
    cull on and off are bit-identical (both eyes, colour and alpha, 5 points of the window).
  - An engine whose managers are not reachable keeps the entity-scope ridge (`_transitionPath`
    says which ran).
- **No shader links inside a `crossfade` or `wavefront` window.** The overlay's two quads compiled
  on the window's first frames (30–180 ms on the M1). `prepareSource()` now warms them whatever
  transition follows, `prepareSource(src, { transition: 'wavefront' })` also builds the render-time
  ridge and cull, and an unprepared `setSource` warms them while its asset loads.

Measured pacing and GPU cost: [`docs/splat-effects.md` § Wavefront: one draw's worth](docs/splat-effects.md#wavefront-one-draws-worth).
The live `crossfade` still draws both photos in full: at mid-fade every pixel needs both images.

## 1.19.1 — 2026-09-24

Touches packaging only (`./splat` and `./model`, `engine: 'playcanvas'`). No pixels move: the
code is moved, not changed.

### Fixed

- **A bundled app that uses only `./splat` builds again without `meshoptimizer` installed**
  (#36). This was a regression in 1.16.0.
  - `setRig('display')` lazily imported `inline3d-model-playcanvas.js` for its look helpers. That
    module also contains `import('meshoptimizer/decoder')` for `./model`'s optional meshopt
    decoder.
  - Bundlers (webpack, Turbopack, Vite/rollup, esbuild) follow every `import()` in the graph, so
    the build failed with *Can't resolve 'meshoptimizer/decoder'*.
  - The two generated environments, their yaw constants and `prepareTransmission` now live in a
    new internal module, `js/inline3d-pc-look.js`. The splat adapter imports that module, which
    reaches nothing optional. `inline3d-model-playcanvas.js` re-exports every name it exported
    before.
  - `./model` still needs `meshoptimizer` only for EXT_meshopt_compression assets, as before.
  - A unit test walks the import graph from each package entry. It fails if `./splat` reaches
    meshoptimizer, and also if `./model` stops reaching it.
  - Gate, on a real GPU: `setRig('display')` vs `addModel` is still **MAE 0.0000** (max 0), mono
    and stereo, with `antialias: true`. The renders are pixel-identical to the 1.16 gate's.

## 1.19.0 — 2026-09-24

Touches the **preview tier** (`./splat` and `./model`, `engine: 'playcanvas'` only). The defaults
keep the wheel's pixels. One default does change: a two-finger touch now pinch-zooms (within the
old 0.2–6 range, with no relax) where it used to act as an erratic one-finger drag.

### Added

- **`zoom: { min, max, relax, ease }`** (#36), bounded zoom that relaxes back to rest.
  - Wheel, pinch and `setPose` clamp to `[min, max]`. Defaults are 0.2 and 6, as before.
  - `relax: true` eases back to rest (1×, or the last `setPose` zoom) once the wheel has been idle
    150 ms or the pinch ends. It uses the orbit's τ 0.6 s, with a landing floor so 2× is exactly
    home in about 2.9 s, and it never fights a live gesture.
  - The zoom scales about the focus, so the focus keeps its place and its disparity in both eyes.
  - The gallery's Spatial View passes `{ min: 1, max: 2, relax: true }`: you can't zoom out past
    the frame's edges, and a peek comes back on its own.
- **Two-finger pinch zoom** on the PlayCanvas viewer, with Pointer Events and the same bounds.
- Gates, on a real GPU (1280×720):
  - Zooming out is refused: MAE 0 against the rest render.
  - Wheel and pinch reach the 2× cap and return to **MAE 0** against rest 3 s after release.
  - In fake stereo, the focus's disparity is unchanged at 1×, 1.5× and 2×.

## 1.18.0 — 2026-09-24

Touches the **preview tier** (`./splat`, `engine: 'playcanvas'` only). Additive: a page that never
calls `setVideo` renders the same pixels.

### Added

- **`handle.setVideo(src, options?)`** (#36): a stereo video on the persistent PlayCanvas splat
  handle, with no second canvas, layer or session. This is for pages that keep one woven canvas for
  the whole app, where a fresh `addVideo` canvas after a navigation is the side-by-side flash.
  - `src` is a URL (an SDK-owned `<video>`, autoplaying) or your `HTMLVideoElement`. Options:
    `format: 'sbs' | 'tb' | 'mono'`, `fit: 'contain' | 'cover'`, `rig: 'display'`,
    `virtualDisplayHeight`, `loop`, `muted`, `autoplay`.
  - It resolves on the video's first frame to `{ video, format, fit, remove(), stats() }`. The page
    drives transport through `video`.
  - The splat is hidden and a screen-locked plane on the display rig shows the video. Each eye
    samples only its own half. Flat (mono), it shows the left half at full resolution.
  - Upload is gated on `requestVideoFrameCallback`. The colour is `addVideo`'s own.
  - `setVideo(null)` restores the splat, the pose, the lens and the declared view rig exactly.
  - It throws during an in-flight `setSource`. While a video is on, `setSource` rejects and
    `setRig` throws. `controls:'page'` throws.
  - Gates, on a real GPU: each eye shows 0 px of the other half, exit renders **MAE 0.0000**
    against the pre-video frame with the same declared rig, and colour matches `addVideo`'s paint
    at MAE 0.003. At 3840×1080 the upload runs 29.9/s with `texImage2D` at p50 0.1 ms, and 0 video
    frames drop on a 120 Hz panel.
  - See [`docs/playcanvas-adapter.md` § setVideo](docs/playcanvas-adapter.md#setvideo--a-stereo-video-on-the-persistent-handle-36).

## 1.17.0 — 2026-09-24

Touches the **preview tier** (`./model` and `./splat`, `engine: 'playcanvas'` only). The default look
does not move except on glTFs that use `KHR_materials_transmission`.

### Changed

- **`environment: 'room'` is now three's room on the PlayCanvas backend** (#36). `addModel(…, {
  environment: 'room' })` and `setRig('display', { environment: 'room' })` light with three.js's
  procedural RoomEnvironment, regenerated in memory (ray cast, no asset, ~16 ms once per page), and
  default to tone mapping `'none'`, three's. Through 1.16 `'room'` was an alias of `'neutral'` on
  this engine, so a page that passed it to keep its three look got the Sample-Viewer studio with PBR
  Neutral. **The default is now spelled `'neutral'` and renders exactly as before** (Khronos gate
  re-run: 16.7 / 6.4 / 2.7 / 9.4, unchanged). On a four-item product catalogue, object MAE against three r180
  `room` goes from 20.5 / 54.4 / 29.5 / 23.3 (the default) to **10.2 / 11.0 / 7.1 / 6.3** (storm
  lantern / handbag / boot / compass). Tone mapping and the environment explain the gap, and what is
  left is where three departs from the Sample Viewer (PlayCanvas `room` is closer to the Sample
  Viewer lit by the same room than three is: handbag 4.8 vs 13.4). `setRig('display')` with
  `'room'` renders pixel-identical to `addModel` with it. See
  [`docs/playcanvas-model-backend.md` § Environments](docs/playcanvas-model-backend.md#environments--neutral-default-and-room-three).
- `setRig('display')`'s `toneMapping` now defaults to the environment's (`'none'` for `'room'`,
  `'neutral'` otherwise). A second `setRig('display')` with another environment swaps the IBL it
  installed.

### Fixed

- **`KHR_materials_transmission` / `_volume` on PlayCanvas** (#36), for `addModel` and for meshes
  under root on `setRig('display')`:
  - The scene-colour grab pass the material samples is now requested. Without it the storm lantern's
    burner rendered as a magenta blob inside the globe.
  - Transmissive draws sort ahead of blended ones, the pass order of the Sample Viewer and three.
    The lantern's opaque-alpha globe no longer shows the burner through it.
  - The grab UV is taken per view. The engine mapped each view's NDC over the whole target, so in
    stereo each eye sampled across both. Mono renders are identical.
  - Lantern object MAE vs the Sample Viewer (default look): 14.4 → 12.4.
  - See [§ Transmission](docs/playcanvas-model-backend.md#transmission-khr_materials_transmission--_volume).

## 1.16.0 — 2026-09-24

Touches the **preview tier** (`./splat`, `engine: 'playcanvas'` only). Additive. A page that never
calls `setRig` renders the same pixels, except for the `setSource` fix below.

### Added

- **`handle.setRig(type, options?)`** (#36): a live, reversible rig switch on the PlayCanvas splat
  handle. It applies on the next frame with no remount, reload or new session, and returns a
  `Promise<handle>`.
  - `setRig('display', { virtualDisplayHeight, fit, margin, frame, … })` frames the enabled meshes
    under `handle.engine.root`, plus the splat when it is shown. The defaults are addModel's (0.24,
    `contain`, 0.8, depthLimit 4, idleSpin 8), and it declares a display rig.
  - While the splat is hidden, the page's meshes get addModel's tone mapping (`'neutral'`) and, if
    the scene has no `envAtlas` of its own, addModel's neutral-studio IBL. Both are removed when the
    rig switches away.
  - `setRig('camera')` goes back to the asset's capture rig, re-resolved from the waterfall's own
    inputs. `setRig('auto')` is the load-time result.
  - The pose resets to the new rig's rest. `handle.rig.typeSource` reads `'setRig'`. The choice
    sticks across `setSource` until `'auto'`, and `controls:'page'` throws.
  - Gates, on a real GPU: a hidden splat plus `setRig('display')` plus DamagedHelmet or Fox renders
    **MAE 0.0000** against `addModel(url, { engine: 'playcanvas' })`, in mono and fake stereo, with
    `antialias: true`. With the tile's default MSAA off the residual is 0.11–0.44, silhouette edges
    only. The round trip `setRig('display')` → `setRig('camera')` returns to the exact pre-switch
    render (**MAE 0.0000**) and the same camera-rig declaration.
  - See [`docs/playcanvas-adapter.md` § setRig](docs/playcanvas-adapter.md#setrig--switching-between-the-display-rig-and-the-camera-rig-36).
- **`addSplat(…, { engine: 'playcanvas', antialias: true })`** creates the tile's WebGL context with
  MSAA. The default stays off. Use it when a page draws meshes under `handle.engine.root`.

### Fixed

- **`setSource` from a camera-rig asset to a display-rig asset** now declares the display rig to the
  runtime. The camera rig used to stay declared. The new asset also orbits its frame centre again
  (the camera rig's `recentre: false` was left behind).

## 1.15.0 — 2026-09-24

Touches the **preview tier** (`./splat`, `engine: 'playcanvas'` only). Additive; the existing transitions
and reveals render the same pixels.

### Added

- **Particle transitions for `setSource`** (#36): `transition: 'swarm' | 'burst' | 'shimmer-cross' | 'dust'`.
  They play the particle reveals across a slide change, with both photos live, in 3D and in 2D.
  The old photo plays its effect backwards while the new one plays it forwards, on overlapping
  spans of one clock (`overlap`).
  - `swarm`: the old photo disperses into a curl-noise swarm and the new one assembles out of one.
  - `burst`: the old photo collapses into its focus and the new one bursts out of its own.
  - `shimmer-cross`: twinkling points out and twinkling points in; nothing moves.
  - `dust`: drifting dust out, gathering dust in.

  Defaults are 2.6–2.8 s on a linear shared clock; each particle eases on its own path. The end
  state is a `cut`, MAE 0.000 in colour and alpha in both eyes, and VRAM goes back to baseline.
  A hidden tab gets the crossfade.
  See [`docs/splat-effects.md` § Particle transitions](docs/splat-effects.md#particle-transitions).
- They render at RENDER TIME. One tile-scope chunk serves both photos, and each photo's values
  sit on the mesh instance of the gsplat manager that draws it. A first cut used entity-scope
  work-buffer modifiers, which rewrote both 1.18M work buffers and re-sorted both every frame.
  Measured in a visible Chrome, that cost 2D pacing its 120 Hz: p95 went from 16.7 ms to 9.8–10.1.
  A photo with nothing to draw skips its draw.
- **`prepareSource(src, { transition, … })`**: with a particle transition, this also compiles and
  links its shaders in the dwell. Otherwise the first transition of each kind blocks its first
  frame on the link: 35–50 ms, and 190 + 260 ms on a variant the machine has never compiled.
- Particle options `vanish` (fade over the first part of the flight) and `density` (the share
  drawn in flight). Both are off for the reveals.

### Not changed

- The live `crossfade` / `wavefront` still run at about 40 Hz in stereo on an M1 (median 25.6 ms).
  They draw both photos in full for the whole window. The same skip-what-is-not-visible idea may
  apply there; that is a follow-up.

## 1.14.0 — 2026-09-24

Touches the **preview tier** (`./splat`, `engine: 'playcanvas'` only). New particle reveals are additive. One default changes pixels
DURING a transition in a woven 3D session (the old photo is now live); end states and 2D are
unchanged.

### Changed

- **`crossfade` / `wavefront`: the outgoing photo is LIVE in a woven 3D session** (#36). Before, it
  was a frozen frame for the whole window, and on a tracked panel a still image under a moving head
  reads as "eye tracking hung, then resumed". The old asset now stays resident. A second camera
  with its own layer, RenderViews and render target keeps rendering it through the same eye views,
  and the overlay lerps or wipes the two live images per eye with the same maths as before. Measured
  on the GPU with a fake 2-view wall, the old photo at four head poses matches its own plain render
  with MAE 0.000 in both eyes, across the rig switch; 1.13.0 showed one image at every pose. End
  state == `cut`, MAE 0.000, colour and alpha, both eyes. Cost: about 2× splat draw for the
  window, and both assets resident (+73 MB of GPU textures at 1.18M gaussians).
  `outgoing: 'frozen'` restores 1.13.0; it stays the default in 2D. See
  [`docs/splat-effects.md` § Live or frozen outgoing](docs/splat-effects.md#live-or-frozen-outgoing).
- The frozen-frame texture is freed when a transition ends; it used to stay allocated (7 MB at
  2560×720).
- The framing pass (the percentile core per axis, then the window pass) runs in steps with yields
  between them, with bit-identical results. It was a single 60–80 ms main-thread task per 1.18M
  gaussians at 4× CPU. It now runs under 50 ms per step, so the longest task left in a load is the
  engine's own centre readback (≈60 ms at 4×).

### Added

- **`handle.prepareSource(src) → Promise<SplatPreparedSource>`**: fetch, decode and upload the next
  asset in the background, without rendering it. The SDK's own passes run in idle periods. Then
  `setSource(prepared, opts)` starts on the next frame, with no load on the transition path.
  `prepared.dispose()`, single use; `remove()` disposes what is left.
  Measured with 4× / 6× CPU throttling on an M1 (1,179,648 gaussians): from the `setSource` call to
  the first transition frame, the longest main-thread task goes from 104 / 159 ms to none over 50 ms, and the
  longest rAF gap from 138 / 196 ms to 18 / 17 ms. Memory: +22.5 MB of GPU textures plus the
  engine's centre array (≈14 MB) per prepared 1.18M SOG, until used.
- `setSource`'s `outgoing: 'live' | 'frozen'` option; `SplatPreparedSource` in `splat.d.ts`.
- **Particle reveals** ([`docs/splat-effects.md` §Particle reveals](docs/splat-effects.md#particle-reveals)),
  usable as `reveal: '<name>'`, `playEffect(name)` and `setSource(…, { reveal })`. Every gaussian is
  a particle with its own start time:
  - `assemble`: a swarm that flies home along spiralling curl-noise paths.
  - `dissolve-in`: a dissolve played backwards; dust drifts in and gathers patch by patch.
  - `converge`: a burst from the focus that flies out and settles.
  - `shimmer`: twinkling points that grow into the picture.
  - Options: `order` (`'radial'`, `'depth'`, `'noise'`, `'random'`, or `'layers'` for SHARP grid
    order via `splat.index`, which is entity scope only), `stagger`, `jitter`, `dotSize`, `grow`,
    `flightAlpha`, `color`/`glow`, `noiseScale`, plus per-effect shape options.
  - Comfort cap `maxDisparity` (default 0.004 of the view width, exact at every depth; nominal
    separation in 2D). The swarm never comes nearer the viewer than that.
  - Every effect ends bit-identical to the plain render. Measured on the real GPU: MAE 0.000,
    colour and alpha, mono and fake stereo, tile and entity scope; removal is exact too.
  - In-flight particles are ~1 px dots until nearly home, which hides the engine's
    original-centre sort order.
- The eye frame that effects receive now carries `tanHalfFovY` (internal; the `'radial'` key spans the
  view actually seen).

## 1.13.1 — 2026-09-24

Touches the **preview tier** (`./splat`, `engine: 'playcanvas'` only). No pixel change.

### Fixed

- **An asset kept re-rendering its work buffer, and re-sorting, every frame after any entity-scope
  effect had ended**: the `wavefront` and `flip` transitions, a load-time `reveal`, a `setSource`
  `reveal`, and `playEffect`/`setEffect` with `scope: 'entity'`. The effects runner ended an effect
  with `workBufferUpdate = ONCE`. The engine's placement setter treats ONCE as a one-shot re-render
  and never leaves ALWAYS, so the photo shown after a wavefront paid a full work-buffer copy, a CPU
  sort and a 4.7 MB order-texture upload every frame until the next swap. Removal now sets AUTO,
  then ONCE, for one clean re-render. Measured on an M1 (headless Chrome, 1,179,648 gaussians,
  steady state after a `wavefront`, 3 runs): sorts went from 60/s (every frame) to 0. Main-thread
  frame time at 4× CPU throttling went from 1.9–2.1 ms to 0.2–0.7 ms. GPU-synced frame time at 1×
  went from 16.0 ms to 14.4–14.6 ms, the same as after a `crossfade` (14.3–14.7 ms), which never
  had the bug.
## 1.13.0 — 2026-09-24

Touches the **preview tier** (`./splat`, `engine: 'playcanvas'` only), additively. A page that
passes none of the new options renders the same pixels (rest view MAE 0.000 vs 1.12.1).

### Added

- **Splat shader effects** ([`docs/splat-effects.md`](docs/splat-effects.md)). Every effect is keyed
  on world position and time only, so both eyes of a woven tile agree (measured: coincident eyes,
  L == R, MAE 0.000, for every effect).
  - `addSplat(…, { reveal: 'inflate' | 'sweep' | 'dissolve' | 'fade' | { type, durationMs, holdMs,
    easing, origin } })`: installed at its start state before the first frame, played once
    `firstWoven` settles (at once in 2D).
  - `handle.playEffect(name, { durationMs, holdMs, easing, origin, direction, scope }) →
    Promise<{ finished }>`, `handle.setEffect(name, params | null)` (persistent effects, or any
    effect held at `{ progress }`), `handle.stopEffect(name?, { finish })`, `handle.effects()`.
  - Effects: `inflate` (the gallery's reveal, `z' = D + (z − D)·s` along rays from the eyes),
    `deflate`, `sweep` (radial, sized from the framing box), `fade` (coverage-linear to ±8 %),
    `dissolve` (the engine's dissolve script, as a reveal), `pulse`, `grade`, `clip`, and
    `custom` / `custom:<name>` GLSL (engine-shaped functions, `dxrProgress`, `dxrTime`,
    `splat.index` in entity scope; screen-space inputs refused).
  - The SDK owns ONE generated chunk per scope (tile: the unified material's `gsplatModifyVS`;
    entity: a work-buffer modifier), composed grade → clip → reveal → pulse → custom. Removing
    the last effect restores the engine's own chunk: MAE 0.000, colour and alpha.
  - `setSource(src, { transition: 'cut' | 'crossfade' | 'flip' | 'wavefront', durationMs, easing,
    reveal, ridge, ridgeMaxDisparity })`. **`wavefront`** is the photo-frame prototype's sweep:
    a soft left → right front, 0.18 of the travel wide, commits each column from the old photo
    (a frozen frame, wiped at the same viewport u in both eyes) to the new one, with a 0.03 m
    depth ridge riding it (capped at 0.4 % of the view width in disparity). It takes 2000 ms,
    ease-in-out, and falls back to the crossfade in a hidden tab. `flip` flattens the old photo
    onto its convergence plane, swaps at zero disparity and inflates the new one. `reveal`
    reveals the incoming asset (entity scope) while the old one fades. `fadeMs` keeps its 1.12.1
    meaning. For photo slideshows: `crossfade` or `wavefront`.
  - Frame cost within noise (stereo 18.10 ms → 18.73 ms with an animating inflate; hiding effects
    are cheaper).
  - Spark: `reveal`, `playEffect`, `setEffect`, `stopEffect` throw "PlayCanvas-only in this
    version".
- **`THIRD_PARTY_NOTICES.md`** (in the package): the MIT notices of PlayCanvas engine, three.js
  and Spark. Shader code adapted from the engine carries a provenance comment.

## 1.12.1 — 2026-09-24

### Fixed

- **`setSource(…, { fadeMs })` is a real crossfade** (`./splat`, `engine: 'playcanvas'`). The fade
  scaled every splat's alpha by t and drew both photos in one sorted pass, so whichever photo sat in
  front won: an incoming photo in front covered 64 % of the picture at t = 0.2 (an 800 ms fade read
  as a snap), one behind it only 18 % at t = 0.5 (a late pop). Now the last frame of the outgoing
  asset is frozen into a texture (both eyes) and lerped with the live incoming one, per
  premultiplied pixel, alpha included. Measured on three SHARP photo pairs, mono and a fake 2-view
  stereo pair: the blend fraction is **t to ±0.001** at every tenth, identical in both eyes; the
  frame at t = 0 equals the outgoing frame and the end state equals a `fadeMs: 0` swap (MAE 0.000,
  colour and alpha). The outgoing photo holds still during the fade. If no frame is drawn within
  250 ms (a hidden tab) the old one-pass fade runs, now with a coverage-linear alpha remap.

## 1.12.0 — 2026-09-24

Touches the **preview tier** (`./model`, and `./splat`'s `engine: 'playcanvas'` import path). A
page that calls `addModel` without `engine` now renders with PlayCanvas and **looks different**:
it is lit to match the Khronos glTF Sample Viewer instead of three's RoomEnvironment. Pass
`engine: 'three'` to keep 1.11 exactly. Epic [#36](https://github.com/DisplayXR/displayxr-web/issues/36);
design and measurements: [`docs/playcanvas-model-backend.md`](docs/playcanvas-model-backend.md).

### Changed

- **`addModel` defaults to PlayCanvas** (optional peer `playcanvas >=2.22.3 <3`). The handle is
  the same: `ready`, `firstWoven`, `setPose`, `resetPose`, `exclude`, `unexclude`, `remove`,
  `frame`, `model`, `viewer`. On PlayCanvas `model` is the render `pc.Entity`, and the handle also
  carries `backend`, `engine` (`{ app, root, camera }`) and `container`.
- **Both engines are imported dynamically** by `./model` (now `js/inline3d-model-entry.js`): a
  default page loads no three, an `engine: 'three'` page loads no PlayCanvas.
- **`handle.viewer` is null until the backend module has loaded**, on both engines (1.11 set it
  synchronously). Read it after `ready`, or import **`@displayxr/inline3d/model/three`**: the 1.11
  module, byte for byte, synchronous `viewer` included.
- **No `engine` and no `playcanvas` installed:** the tile renders on three with one console
  warning. Neither installed: `ready` rejects naming both. With no `engine`, a three.js object in
  `GLTFLoader` / `DRACOLoader` / `KTX2Loader` / `envMap` selects three (a 1.11 page that injects
  loaders keeps working unchanged).
- **The PlayCanvas adapters import `playcanvas` by name** (`js/inline3d-playcanvas-engine.js`), not
  as a namespace, so bundlers tree-shake the engine: 2,434,536 → 1,499,851 bytes minified,
  **626 → 397 KB gzip** (esbuild 0.28.2), for `addModel` and for `addSplat(…, {engine:'playcanvas'})`.

### Added (PlayCanvas backend)

- **Lighting matched to the Khronos glTF Sample Viewer** (not to three.js): an in-memory neutral
  studio fitted to the Sample Viewer's "Studio Neutral" (no asset, no licence), Khronos PBR Neutral
  tone mapping, exposure 1, sRGB output, MSAA on. On-object MAE vs the Sample Viewer (/255):
  DamagedHelmet 16.7 (three 36.2), Fox 6.4 (19.5), BrainStem 2.7 (26.7), MetalRoughSpheres 9.4 (26.4).
- `environment: 'neutral'` (alias of the default `'room'`), `environmentRotation` (degrees),
  `envMap` as a URL (equirect .hdr/.png/.jpg) or a `pc.Texture`; `'studio'` and `'none'` as on three.
- Compressed glTF with the **same served files as three**: Draco and KTX2/Basis through the
  engine's own workers, fed three's `libs/draco/` and `libs/basis/`; `decoderPath` unchanged; a
  mis-served folder rejects `ready` naming the extension, the file and the option.
  `EXT_meshopt_compression` via meshoptimizer's `MeshoptDecoder` (new optional peer
  `meshoptimizer >=1`, loaded only for an asset that declares it; `meshoptDecoder` injects it).
- `controls: 'page'` + `setCameraPose` / `getCameraPose` / `onBeforeFrame` / `comfortDepth` on
  models, as on splats (the rig converges on the model's bounds centre unless the pose says).
- `antialias`, `preserveDrawingBuffer`, `nearClip`, `farClip`, `orbitMaxDeg`, `orbitEase`, `playcanvas`.

### Throws at call time

- An unknown `engine` or `environment`; a PlayCanvas-only option with `engine: 'three'`; a three.js
  loader or texture with `engine: 'playcanvas'`; a `meshoptDecoder` without `decodeGltfBuffer`;
  `setCameraPose` without `controls: 'page'`; `setPose` / `resetPose` with it.

### Samples

- `samples/model/` (tiles A and C) and `samples/shopify/` render on the new default;
  `?engine=three` switches back. Tile B stays on three (it composes a Spark splat into a three scene).

## 1.11.0 — 2026-09-24

Touches the **preview tier** (`./splat`, `engine: 'playcanvas'` only), additively. Nothing changes
for a page that does not pass `controls: 'page'`.

### Added

- **`controls: 'page'`: the page owns the camera.** This is for a game, or any page with its own
  camera (F1000's phase 1). With `addSplat(…, { engine: 'playcanvas', controls: 'page' })` the
  adapter runs no orbit, idle spin, auto-fit or focus gestures. It keeps the eye math: the
  `RenderView` list, the footprint fix, near/far and the mono fallback.
  - **`handle.setCameraPose(matrixWorld, { verticalFovDeg, near?, far?, convergence? })`**, called
    every frame. `matrixWorld` is the page camera in the splat's own space (three.js convention).
    A uniform scale is allowed: F1000 passes `inv(splatWorld) · camera.matrixWorld`, which carries
    0.4. The adapter applies the OpenCV → engine flip itself. The last call wins, and a page that
    stops calling keeps its last pose. **`handle.getCameraPose()`** returns a copy of it.
  - **`onBeforeFrame(frame)`** (`{ time, views, dt }`) runs once per adapter frame, before
    anything renders. A pose set inside it is what that frame draws, with zero lag. A throw is
    warned once and frames keep rendering.
  - **Mono** renders exactly that camera: fov × canvas aspect, principal point centred.
  - **3D** is the attach pattern. Each eye = `matrixWorld × view.transform`, with the runtime's
    projection untouched: the page's near/far rewrite only the depth mapping. The rig is declared
    every frame and is the auto-3D shim's, field for field: `type: 'camera'`, identity pose,
    `verticalFov`, `convergenceDiopters = 1/d`, `metersToVirtual = comfortDepth · d / 0.5`.
    **`comfortDepth`** is a new option, default 0.3, in (0, 1].
  - `d` is the page's `convergence`, else the focus waterfall's. It stays fixed while the camera
    moves and is re-estimated only on `setSource`. `setFocus(point)` sets `d` to the point's
    distance along the view axis. `getFocus` / `onFocusChange` report the convergence point.
  - `setPose` / `resetPose` throw, and `rig: 'display'` throws. `fit`, `virtualDisplayHeight`,
    `orbit`, `idleSpin`, `focusInput` and the other framing/orbit knobs are ignored, named once in
    a `console.info`.
  - **Spark:** `controls: 'page'` throws, naming `engine: 'playcanvas'`. Spark would need
    SceneViewer (shared with `./viewer` and `./model`) to take an external camera on both its
    paths.

## 1.10.1 — 2026-09-23

Touches the **preview tier** (`./splat`, `engine: 'playcanvas'` only), and `boundsFromPositions` in
`./viewer` (same results, less time). Nothing changes for Spark callers' pixels.

### Fixed

- **No grey sky box behind the splat.** The engine draws a sky whenever the scene has something to
  draw it from, and `scene.envAtlas` counts. A page that set one to light its meshes under
  `handle.engine.root` got a grey gradient box the instant the splat was hidden (mid-`setSource`,
  or a page showing only its own meshes). The eye camera now renders without the Skybox layer, so
  the canvas stays transparent. Image-based lighting still lights the meshes. The new **`sky: true`**
  brings the engine's sky back.
  - Verified headless with `envAtlas` set and the splat hidden: the corner pixel reads
    `[140,140,140,255]` in 1.10.0 and `[0,0,0,0]` now (and `[140,140,140,255]` again with
    `sky: true`).
- **`setSource` no longer blocks input for its cloud passes.** The SDK's framing, rest-space sample
  and pick-set passes ran in one main-thread task stacked on the engine's end-of-load work. Now
  each runs in its own task (with `scheduler.yield()` where available).
  - `boundsFromPositions` takes its percentiles with a linear-time select instead of full sorts.
    The values are bit-identical, pinned by a test.
  - On a 1.18M-gaussian swap (headless, M1 Pro), the longest main-thread task went from
    **60–64 ms to under 50 ms** (none reported), and the longest frame gap from 65–77 to
    35–44 ms. At 4× CPU throttling it went from 218–238 ms to 60–65 ms, which is the engine's own
    remainder, documented per 1M gaussians with the recommended pre-load pattern.
  - The load stages are visible as `performance.measure` entries named `inline3d:*`.

## 1.10.0 — 2026-09-23

Touches the **core tier** (`.`), additively. The frozen 1.x surface gains one handle member and
one option, and nothing that exists changes behaviour. The preview subpaths (`./splat`,
`./model`) forward the new member. No pixels move for any page that does not read it.

### Added

- **`handle.firstWoven`**: a promise that tells the page when it is safe to reveal a woven canvas
  (core tier; web#36 follow-up).
  - It resolves once and never rejects, with `{ woven, confirmed, reason, ms }`.
  - `woven: true` means a real stereo frame is on a layer that has existed for
    `firstWovenHoldMs`.
  - `woven: false` (`'layer-failed'` / `'session-ended'` / `'removed'`) means the window will not
    weave. The canvas is already flat, or the scene's `onLayerLost` has already run.
  - `onFirstWoven(cb)` is the callback form.
  - It replaces the worst-case `setTimeout` that pages kept to hide the raw side-by-side pair a
    fresh canvas shows until the browser's compositor joins it.
- **`firstWovenHoldMs`** on every `add*()` (default **1200**, the browser's measured worst case
  for a canvas that is fresh to its compositor).
- **It is approximate, by design, and says so.** No browser reports the join yet (checked
  against the browser's JavaScript surface: the verdict exists only as a compositor log line). So
  `confirmed` is always `false` and the result is the hold. When a browser reports joins it
  becomes `confirmed: true` and earlier, with no change to the page. The browser ask is
  [`docs/proposals/layer-joined-signal.md`](docs/proposals/layer-joined-signal.md).
- `addSplat` (both engines) and `addModel` handles carry `firstWoven` and accept
  `firstWovenHoldMs` (preview tier). With no inline-3D session they resolve
  `{ woven: false, reason: 'unsupported' }` at once.
- Docs: **[`docs/woven-canvas-rules.md`](docs/woven-canvas-rules.md)**: eight rules for never
  showing a raw side-by-side frame. Each rule comes with its reason and the SDK call that
  satisfies it, plus a hardware checklist keyed on the browser's
  `withheld … ids=[<token>=<why>@<rect>]` log line. There is a summary section in the authoring
  guide, and links from the porting guide and the README.
  - It corrects two claims in circulation. **No shipping browser draws a flat frame instead of
    the raw pair** for a fresh canvas: that fallback was measured and not shipped. And the
    `withheld` line is logged at error level with throttling, so a missing line proves nothing.

## 1.9.1 — 2026-09-23

Touches the **preview tier** (`./splat`, `engine: 'playcanvas'` only), plus the package manifest.
Nothing changes for Spark callers or for splat-only pages. The fixes affect only what a page can
do with `handle.engine`.

### Fixed

- **`handle.engine.root` is usable as documented.** The tile's `AppBase` now registers `Render`,
  `Light` and `Anim` component systems and a `Container` resource handler, next to `Camera`,
  `GSplat` and `Texture`/`GSplat`. That is exactly what a glTF needs, skinned and animated
  included. Before, a page had to register them itself or `instantiateRenderEntity()` produced
  nothing.
  - A page that still registers them now gets the existing system back instead of an engine
    "already registered" throw.
  - Cost: +0.1 ms boot (`AppBase.init` 0.4 → 0.5 ms). +41.8 KB gzip only for a hand-tree-shaken
    engine build; nothing for the SDK as shipped.
  - Verified with a skinned, animated `.glb` over a splat: composited, depth-tested against nearer
    splats, animation advancing.
- **`"./package.json"` is exported**, so `import pkg from '@displayxr/inline3d/package.json'` and
  `require.resolve('@displayxr/inline3d/package.json')` work instead of
  `ERR_PACKAGE_PATH_NOT_EXPORTED`.

### Added

- **`nearClip` / `farClip`** (PlayCanvas): a floor on the projection's near plane and a cap on its
  far plane, for depth precision in a mixed mesh + splat scene. The adapter still owns the
  projections, and unset leaves them untouched.
- Docs: `handle.engine` in [`docs/playcanvas-adapter.md`](docs/playcanvas-adapter.md). Covers what
  is registered, the cost, and two engine gotchas (lights shine along local −Y; use `AnimTrack.name`
  with `assignAnimation`).

## 1.9.0 — 2026-09-23

Touches the **preview tier** (`./splat`, `engine: 'playcanvas'` only). Additive: nothing changes for
Spark callers or for flat `.sog` files.

### Added

- **Streamed SOG on the PlayCanvas backend** (epic #36 P2).
  - Pass the URL of the `lod-meta.json`, or of the directory holding it. Bytes of a
    `lod-meta.json`, or a streamed URL with `engine: 'spark'`, throw at call time with a message
    saying what to pass instead.
  - `splatBudget` is **per tile, all views included**: one engine camera renders every view, so
    both eyes share one budget. It defaults to **600k** on a Streamed SOG when unset, and
    `perf: false` keeps the engine's 1M.
  - New `perf` keys pass through: `lodMode`, `lodUpdateDistance`, `lodUpdateAngle`,
    `lodUnderfillLimit` (unset = engine default).
  - New **`handle.stats()`**: `resident`, `peakResident`, `budget`, `numSplats`, `views`,
    `lodLevels`, `files`, `filesLoaded`, `firstFrameMs`.
  - Framed from its octree leaf boxes, not the root bound. The `camera` block is read from the
    top level of `lod-meta.json`.
  - Measured on a 5.88M-gaussian captured scene (M1 Pro): first frame 2.9 s against 20.8 s flat
    at 100 Mbit/s, and 9.6 ms against 117 ms for two 1080p views. It is not a byte saving at a
    close framing. Recipe and tables: [`docs/playcanvas-adapter.md`](docs/playcanvas-adapter.md)
    §Streamed SOG.

## 1.8.0 — 2026-09-22

Touches the **preview tier** (`./splat`, plus one additive `./three` export). **Existing callers get
the same engine and the same code path**: with no `engine` option, or `engine: 'spark'`, `addSplat`
renders with three.js + Spark as in 1.7.1. The PlayCanvas engine is **opt-in** with
`engine: 'playcanvas'`.

**One behaviour change, for one class of file.** The camera-rig focus waterfall gains a rung (see
*Changed*). A `.sog` whose `camera` block has **no `focus`**, or a `focus` its converter computed
as the whole-cloud median (`focus.source: "cloud-median"`), now converges on the **nearest
substantial clump** in the middle of the frame instead of the whole-scene median. On an open
landscape that is 2.4 m (the tree trunk), not 46.9 m, so that file's 3D will look different, as
intended. Blocks with a considered focus (`convergence`, `manual`, …, or no `source`), assets with
no block, and a caller's `focus` / `convergence` are unaffected. Both engines.

### Added

- **`addSplat(…, { engine: 'playcanvas' })`: the PlayCanvas engine as a second splat backend**
  (epic #36).
  - Same handle and the same rig/lens/focus waterfall as Spark. One camera renders every view
    through the engine's `RenderView` list, so one sort serves all eyes.
  - A shader-chunk fix for the engine's square-pixel footprint assumption, which a side-by-side
    buffer breaks.
  - `perf` presets map onto engine knobs, and `perf: false` leaves the engine alone.
  - A **URL** `.sog` yields its `camera` block too.
  - Needs the new **optional** peer `playcanvas >=2.22.3 <3`, loaded by a dynamic `import()` only
    when asked for.
  - Reads `.sog`, `.ply` and a Streamed-SOG `lod-meta.json`. With `engine: 'playcanvas'`, a
    `.spz` / `.splat` / `.ksplat` source (or a Spark-only `fileType`) **throws at call time**.
    Those stay Spark formats.
  - Differences from the Spark path: [`docs/playcanvas-adapter.md`](docs/playcanvas-adapter.md).
- On the PlayCanvas backend:
  - **`handle.setSource(src, { fadeMs, resetPose })`**: a crossfading in-place asset swap that
    re-runs the rig waterfall for the new file. The pose is kept unless `resetPose`. It throws on
    Spark.
  - **`feather`**: the per-eye edge fade, matching `EdgeFeather`.
  - **Tilt-and-relax `orbit`**: the drag is a fraction of the tile, capped at `orbitMaxDeg` (15°),
    and relaxes back on release (`orbitEase` `{ drag: 0.2, rest: 0.6 }` s). Spark keeps its
    turntable drag.
  - **Exact `pick`**: the nearest gaussian centre over the full centre set, with haze skipped.
- **`captureFit: 'height' | 'cover'`** on the camera rig, both backends. `'height'` (default) is
  the 1.7 window. `'cover'` fills the tile with photograph (a 4:3 capture in a 16:9 tile crops
  top/bottom).
- **`handle.engine`** (advanced, not semver-covered): `{ app, root, camera }` on PlayCanvas, and
  `{ renderer, scene, camera }` on Spark. **`handle.backend`**: `'playcanvas'` or `'spark'`.
- **`handle.getFocus()`** and **`handle.onFocusChange(point, { focusSource })`**, in the splat's
  own space, on both backends. `handle.rig` gains `blockFocusSource` and `clumpMassFrac`.
- **`cameraRigFromPose(pose, opts)`** in `./three`. It builds the camera-rig descriptor from a
  plain `{position, orientation, fov}`, bit-identical to `cameraRigFromCamera`, which is unchanged.

### Changed

- **Focus waterfall: `nearest-clump`** (the behaviour change above). The order is now: caller ›
  caller convergence › block focus (any source except `cloud-median` / `median-disparity`) ›
  **nearest-clump** (needs the block's or caller's lens) › `block-cloud-median` ›
  `median-disparity` › 2 m.
- **Viewer tuning constants are shared** (`inline3d-splat-shared.js`). SceneViewer reads the same
  damping, idle, focus-ease, wheel and zoom numbers as before, now from one module the PlayCanvas
  viewer also reads. The values are unchanged, and a side-by-side trace test pins the two viewers
  bit-identical.

## 1.7.1 — 2026-09-20

Touches the **preview tier** (`./model`) only, and fixes exactly one thing: under a bundler, a
compressed glTF never loaded at all. Uncompressed assets are unaffected, and so is every page that
loads compressed ones through a bare importmap — same pixels, same timing. If your page builds with
webpack / Turbopack / Vite / rollup and loads a Draco-, KTX2- or meshopt-compressed model, the tile
that used to stay empty with a rejected `handle.ready` now renders the product.

### Fixed

- **`addModel` could not load ANY compressed asset under a bundler — all three decoders**
  (preview tier). The decoders were resolved with `await import(spec.module)`, the specifier read
  out of the `DECODERS` table — an *expression*, which no bundler can follow. The build printed

  ```
  Critical dependency: the request of a dependency is an expression
  ```

  and shipped a stub that throws `Cannot find module 'three/addons/…'` at runtime, which `addModel`
  then reported honestly as a module-resolution failure in its own decoder error. Draco, KTX2/Basis
  **and** meshopt all went through that one call, so the blast radius was the whole compressed path
  — and a catalogue GLB out of a real pipeline is nearly always compressed, which is precisely the
  case `/model` exists for. Each decoder now has a literal `import()` of its own
  (`load: () => import('three/addons/loaders/DRACOLoader.js')`, and so on): that is what a build
  tool can analyse, and it resolves unchanged under the `"three/addons/"` importmap prefix the
  samples use.

  It survived four releases because neither path that was exercised has the fault — `samples/` runs
  on a bare importmap, which resolves specifiers at runtime and does not care, and the test suite is
  deliberately dependency-free, so it never imported a decoder at all. The guard added with this fix
  is therefore a source-level one: it reads `js/` the way a bundler does and fails if any `import()`
  is handed a computed specifier again.

  Nothing else moved. Injection (`{ DRACOLoader }`, `{ KTX2Loader }`, `{ meshoptDecoder }`, a class
  or a ready instance you configured yourself), the shared ref-counted decoder cache, `decoderPath`
  and the serve-the-decoder-files-yourself requirement are all as they were, and a decoder is still
  imported only for an asset that declares its extension — bundlers now code-split each one into its
  own chunk, so an uncompressed GLB downloads none of them.

  Verified in Chrome against a Next.js 15 / webpack app loading an `EXT_meshopt_compression` GLB:
  before, the build warning above plus `Cannot find module
  'three/addons/libs/meshopt_decoder.module.js'` and an empty stage; after, no warning, the meshopt
  decoder arriving as its own chunk, and the model on screen.

## 1.7.0 — 2026-09-19

Touches the **preview tier** (`./splat`) only, and additively: `addSplat` with no new options
renders exactly as it did in 1.6.1 — every Spark default stays where Spark put it and the display
rig with its auto-frame is still what an asset without a `camera` block gets.

### Added

- **`addSplat({ perf })` — cut a splat's overdraw** (preview tier). A splat scene's cost is the
  per-fragment composite, and splat COUNT is the weakest axis on it: decimating the reference
  1.18M-gaussian capture to 25 % breaks it visibly while removing less cost than these settings,
  which remove none of the picture. Two presets (`'balanced'`, `'aggressive'`) or an object of your
  own over Spark's `minAlpha` / `maxStdDev` / `minPixelRadius` / `maxPixelRadius` / `falloff` and
  its LOD budget, plus two of this SDK's own:
  - **`alphaRadius`** shrinks each splat's quad to the radius where its own alpha reaches
    `minAlpha`. Spark's fragment shader already discards everything past that radius, so this
    removes work and not pixels — **bit-exact**, measured: 457 of 3,686,400 channel bytes differ
    at 1280×720, every one of them by exactly 1. Spark 2.1.0 has no option for it (`maxStdDev` is
    one global uniform), so the SDK patches Spark's splat vertex shader through its supported
    `vertexShader` surface, rewriting Spark's OWN source off the live material rather than shipping
    a copy — a Spark upgrade brings its shader fixes along, and if the lines stop matching the
    patch declines with one warning and everything still renders.
  - **`alphaFloor`** moves that cut up: each tail is dropped where IT reaches the floor rather than
    where an 8-bit framebuffer stops representing it — the per-splat version of turning
    `maxStdDev` down.

  Two results from measuring it that are worth more than the options themselves, because both are
  the opposite of the obvious move (M1 Pro, Chrome/ANGLE-Metal, GPU timer queries, configs
  interleaved frame by frame):
  - **Decimating the asset buys nothing.** 50 % and 25 % decimations measured within noise of the
    full 1.18M-gaussian scene. Decimation drops the small gaussians and the few huge ones that
    cover the frame survive it. A decimated `.sog` is a download win, not a render-cost win.
  - **The bit-exact shrink buys little on a lifted photograph**, because 86 % of its gaussians are
    near-opaque and an opaque splat's own 1/255 radius is already wider than the σ Spark draws it
    at. It is exact and it stays — the scene it was built for is large low-alpha haze — but the
    preset that pays on the web (`'balanced'`, −5…−20 %) tightens the quad extent instead.

  `handle.perf` reports what was applied, and `applySplatPerf(spark, perf)` is exported for pages
  that build their own `SparkRenderer` — the knobs are live, so a quality menu can call it at any
  time. Measured numbers, and which knob is worth which pixels, are in
  [docs/authoring-inline-3d.md](docs/authoring-inline-3d.md#gaussian-splats-performance-and-the-camera-block).

- **A `.sog`'s `camera` block now picks the view rig, and a WATERFALL fills in the rest**
  (preview tier). A splat viewer needs BOTH rigs and the same call site loads both kinds of asset
  — a product hero wants the display rig and its auto-frame, while a photograph lifted into 3D
  wants the camera it was taken with. Nothing in the page can tell them apart; the file can.
  `addSplat` reads the `camera` block out of the `.sog` (a PKZip — ~40 bytes of central directory,
  never the webp planes, and only on the BYTES path) and resolves three questions from it:

  | | 1st | 2nd | 3rd | last |
  |---|---|---|---|---|
  | **rig** | caller | the block's `rig` | a block at all ⇒ camera | display |
  | **intrinsics** | the block | caller | **estimated from the cloud** | 28 mm-eq |
  | **focus** | caller | the block's `focus.point` | **median disparity** | 2 m ahead |

  Each resolved value carries the step that produced it (`handle.rig.focusSource`,
  `intrinsicsSource`, `typeSource`), because a number from a lower step is not a wrong number, it
  is a wrong SOURCE, and that is invisible in the picture.

  The block is now a **v2 superset**: `rig`, `focus` (one point that is the orbit centre, the pivot
  plane AND the convergence) and `dxr` (the camera rig's absolute scalars) join it, `intrinsics`
  becomes optional, and a v1 block still reads. `rig: "display"` beside a `rest` is meaningful —
  *a display rig, opened at this viewpoint*.

  **Estimating the lens** works because a capture's gaussians only exist where its camera could see
  them: P1/P99 of `x/z` and `y/z` about the rest camera ARE the frustum that made it, principal
  point included. Measured against a capture whose true half-tangents are ±0.857 and ±0.482:
  0.8635 and 0.4827, +0.75 % and +0.12 %. The implied 35 mm-equivalent focal is gated to
  [14, 85] mm, outside which the cloud is describing something that is not a camera. It matters
  because a splat rendered through the wrong focal is drawn at the wrong SIZE and nothing else —
  no artefact, just a picture that feels zoomed out.

  **Estimating the focus** is the median of 1/z, inverted — not of z. On the reference capture that
  is 2.17 m against the gallery's own 2.14 m; the centre of the measured bounds, which this
  replaced, was 39.8 m, because an open scene's percentile bounds are 128 m wide.

  On the camera path the subject is not reframed, the turntable is off, the mono camera is posed
  and lensed as the capture, and the rig is **declared** with `cameraRigFromCamera` — the off-axis
  projection stays in the runtime.

- **Pointing the window: double-click, Space and `handle.setFocus(point|null)`** (preview tier).
  The focus is one point — the orbit centre, the pivot plane and the convergence — and it is now
  something a viewer can move. Double-click focuses what was clicked (Spark's own
  `SplatMesh.raycast`, ~57 ms over 1.18M gaussians, with a nearest-gaussian-to-the-ray fallback
  documented as the approximation it is); Space returns to the resolved value; both ease at 0.18
  per frame, and while the ease runs a camera rig re-declares its convergence every frame. What
  moves depends on the rig and only on that: a camera rig moves the rotation centre and leaves the
  capture where it was placed, a display rig brings the focused point to the middle of the tile.
  `focusInput: false` turns the gestures off for a page that owns them itself, and
  `handle.pick(x, y)` exposes the raycast.

  New on the handle: **`handle.camera`** (the raw block), **`handle.rig`** (the resolved waterfall),
  `handle.viewRig`, `handle.perf`, `handle.setFocus`, `handle.pick`. New exports from `./splat`:
  `readSogCamera(bytes)`, `readSogMeta(bytes)`, `resolveRig`, `applySplatPerf`,
  `SPLAT_PERF_PRESETS`. **`SceneViewer` gains `setFocus` / `getFocus` / `onFocusChange` / `onTick`**
  (`./viewer`), and `fitTo` now goes through the focus, so a refit cannot leave the orbit turning
  about somewhere the framing has moved away from.

## 1.6.1 — 2026-09-09

Touches the **core tier** (`.`) with a behaviour fix only — no API changes — and the **preview tier**
(`./viewer`, `./splat`, `./model`) with one additive option. A page that ignores everything below
renders identically while it is weaving; the changes only decide what a canvas shows once nothing
weaves it any more.

### Fixed

- **A canvas nothing is weaving can no longer be left holding a raw side-by-side pair**
  ([#28](https://github.com/DisplayXR/displayxr-web/issues/28), field report
  [browser-pvt#99](https://github.com/DisplayXR/displayxr-browser-pvt/issues/99)). Every fallback in
  this SDK was decided once at boot, so four paths ended with a tile showing a flat squeezed
  left|right pair, permanently — the symptom users report as "3D element shows SBS", usually on a
  slow connection:
  - session `end` tore down without the mono repaint `_deactivate` does — every image and video
    canvas kept its last SBS frame; teardown, deactivate and a failed activate now share one
    `_paintMono`;
  - an image whose download landed **after** teardown painted a fresh SBS pair into a canvas with no
    layer — `_paint` now forces the mono branch (and a 1:1 buffer) whenever the manager is stopped or
    the window has no live layer, whatever `win.sbs` says;
  - a throwing `new XRDisplayLayer()` was swallowed silently and left the canvas as it was — it now
    warns once per window (with the error) and repaints mono; still no retry;
  - a buffering video (`readyState < 2`) skipped its paint entirely, so its canvas layer went idle and
    could drop out of the browser's aggregated frame — it now re-commits its last decoded frame with
    an identity blit.
- **One throwing scene no longer stops the windows after it from repainting.** `onFrame` is contained
  per window and warned about once; an un-redrawn canvas is exactly what the browser's weave join
  loses.

### Added

- **`addScene({ onLayerLost })`** (preview tier): called once when a scene window's layer goes away
  for good (session end, or the layer could not be created) — not when a lazy tile scrolls off. The
  SDK does not own a scene canvas's pixels, so this is how it tells the owner to go flat.
  `SceneViewer.onLayerLost` is the ready-made handler (`startMono()`), and `./splat` / `./model` wire
  it for you.

## 1.6.0 — 2026-09-08

Touches the **preview tier** (`./viewer`) and fixes a **documentation error in the core tier**.
Purely additive to the viewer's API: no framing behaviour changes and no existing option changes
meaning, so a page that ignores everything below renders identically to 1.5.1.

### Added

- **`SceneViewer` has an output surface** ([#26](https://github.com/DisplayXR/displayxr-web/issues/26)).
  It could frame, scale and orbit a subject but never say where the subject ended up, so pages
  that needed that — a pop-out readout, a depth-budget check, a HUD that must clear the model —
  had to read `_pivot`, `_fitScale` and `_zoom`. Three additions replace all of it:
  - **`getSubjectBounds()`** → `{center, extent, front, back, scale}` in **display metres**, for
    the pose being drawn. `front` is the surface nearest the viewer (`> 0` = out of the glass),
    `back` the far side, `scale` the model-unit → metre factor in force (fit × zoom).
    **Call it per frame.** The orbit rotates the *subject*, so yaw swings its depth into the
    display's `z`: a page-shaped subject 1 m × 0.02 m is 0.01 m deep face-on and 0.5 m deep
    turned side-on. Anything measured once at load is correct at yaw 0 and wrong everywhere
    else — and with `idleSpin` on, yaw 0 is a passing instant. The call allocates one object and
    does no matrix work.
  - **`depthOffset`** (get/set) — slides the subject along the depth axis in display metres,
    `+` toward the viewer. It **translates and never rescales**, so it moves the depth budget
    without resizing it.
  - **`getPose({target})`** — the counterpart to `setPose`. Yaw/pitch/zoom are eased, so
    mid-gesture "what is drawn" and "what it is settling toward" genuinely differ; the default
    reports the drawn value, `target: true` the destination.
  - `setPose()` now also accepts `depthOffset`.

### Changed

- **`fitTo()` no longer discards `depthOffset`.** It used to hardcode the pivot's z to 0, so
  reframing a subject silently threw away where the author had placed it. `resetPose()` clears
  it, which is where "back to default" belongs. **No effect on any 1.5.x page**: the offset is 0
  unless something sets it, and 0 is what `fitTo` used to write.
- `samples/model` reads `getSubjectBounds()` instead of `_fitScale`, and prints its footprint and
  pop-out **live** — the visible disagreement between that and the static fit numbers is the
  point, and is why the call is per-frame.

### Fixed

- **The depth axis was documented BACKWARDS.** `docs/authoring-inline-3d.md` and the header of
  `inline3d-three.js` both said "`+z` behind the glass, `−z` in front". It is the other way
  round: the runtime places the nominal viewer at `z = +0.6 m` with the glass at `z = 0`
  (`dxr_view_math`'s `nomv`), so **`+z` is toward the viewer, out of the glass**. Every mono
  fallback camera in this repo already sat at `+z` for that reason, so only the prose was wrong —
  but the prose is what authors code against, and the symptom is a depth control whose labels are
  inverted. Symmetric subjects hide it completely. New section:
  [Which way is out](docs/authoring-inline-3d.md#which-way-is-out).

## 1.5.1 — 2026-09-06

### Fixed

- **Undock: `ended` now means the viewer exited.** The browser contract (browser-pvt#25) resolves
  `layer.undock()` on a successful LAUNCH and reports the viewer's exit separately as the XRSession's
  `undockend` event; 1.4.0/1.5.0 derived `ended` from the launch promise, so it resolved a frame after
  the window opened. The helper now arms an `undockend` listener before launching and resolves
  `ended` on it; the browser's DOMException names (NotAllowedError, NotSupportedError,
  SecurityError, InvalidStateError, OperationError) map onto the four contract names. The
  fallback path is unchanged (`detached === true`, `ended` immediate).
- README: vendoring note — `inline3d-mode-switch.js` is a static dependency of `inline3d.js`.

## 1.5.0 — 2026-09-06

### Added

- **The 2D↔3D switch is EASED, and every page gets it for free.** 1.4.0 made the panel's mode a
  page-facing control and collapsed the stereo rig the moment a 1-view mode went active — correct,
  and a snap. The transition now ramps: a **page-initiated** switch walks every window's
  `ipdFactor`/`parallaxFactor` between 0 and what the page asked for over **180 ms**, **smoothstep**
  (Hermite `3t^2 - 2t^3`) — the defaults the native DisplayXR apps configure, because this is a port
  of the sequencer they already use (`dxr::ModeSwitch`, displayxr-common) rather than a second
  design. New dependency-free module `js/inline3d-mode-switch.js` holds the state machine;
  `test/mode-switch.test.mjs` mirrors the C++ smoke test case for case. *(core tier — additive)*

- **The ORDER is the feature, and it is asymmetric.** Going flat (a `viewCount === 1` target) ramps
  the disparity **out first** and forwards the mode request only when it lands, so the panel flips
  on already-flat content instead of snapping a stereo image flat. Coming back (a 2-view target)
  forwards the request **first** and eases the disparity in **only once the panel REPORTS 3D** —
  ramping up any earlier would put stereo on a still-flat panel, which is the blurry double image
  the whole mode API exists to make unreachable. A hand-rolled tween gets exactly this wrong.

- **`createInline3D({ modeSwitch: { durationMs, easing, enabled } })`** — `durationMs` default
  `180` (`0` keeps the ordering and lands in one frame), `easing` default `'smoothstep'` (also
  `'linear'`, `'easeoutcubic'`; an unknown name warns once and falls back), `enabled: false`
  restores 1.4.0's snap exactly. **`wall.modeSwitch`** is the read-only live state
  `{active, factor}` for a page that wants to move its own 2D chrome alongside the panel. The SDK
  adds **no UI** — which key or button toggles the display stays the page's call.
  *(core tier — additive)*

- **What a page can feel, spelled out.** The restore is to the **configured** steady factors (each
  window's own rig, never a hardcoded 1) and the ramp is a **copy** on the way to the layer, so the
  1.4.0 guarantees hold unchanged: a per-frame `setViewRig` loop cannot walk the page out of 2D,
  and a lazy tile that rebuilds mid-transition comes back at the current factor. The ramp is driven
  by **wall-clock dt** from the session's frame loop (never frame counts, so it lasts the same at
  30 fps and 144 fps), with a timer fallback so a held request still lands when frames stop.
  Reversing mid-flight retargets from the disparity **in force** — the first press never snaps —
  and a reversed going-flat switch **never fires**: nothing is asked of the display at all.

### Changed

- **`requestRenderingMode(i)` / `setStereoEnabled(false)` for a 1-view target now resolve when the
  request has been FORWARDED**, i.e. after the ramp (~`durationMs`), not on the call. They reject
  as before if the browser refuses — and a refusal ramps the disparity back **up**, because a
  refused switch must leave the page in 3D rather than flat. One new failure: a request dropped by
  a reversal before it ever fired rejects with an `Error` named **`superseded`**. Nothing changes
  for a page that only awaits the promise it already awaited; `{ enabled: false }` restores the old
  timing. *(core tier — behaviour change, opt-out)*

- A mode change the page did **not** request (another tab, the shell, a page that opens with the
  panel already flat) still **snaps** — there is nothing to ramp from, and the reported state stays
  the sole authority for the rig. `wall.stereoCollapsed` continues to mean what the display last
  **reported**, never what is mid-ramp.

## 1.4.0 — 2026-09-06

### Added

- **Display modes — the page can read what the panel IS, and ask it to change.** Until now a page
  could describe its own framing (a view rig) but knew nothing about the display it was framing
  *for*: not its size in metres, not its pixel count, not which of the runtime's rendering modes it
  was in, and it had no way to ask for a different one. Three pass-throughs close that:
  **`getDisplayInfo()`** (physical size, pixel size, recommended view scale; `null` where there is
  no glasses-free display), **`getRenderingModes()`** (every mode the runtime can put the display
  in — view count, tile grid, per-view pixels, `hardwareDisplay3D`, `isActive`, `isRequestable`)
  and **`requestRenderingMode(i)`**. They sit on the **`createInline3D()` result** — the panel is
  the document's, not a tile's — and under the same names on every tile handle, routed to whichever
  window currently holds a live layer. Gate the group with
  **`inline3dDisplayModesSupported()`**, which requires all three methods on
  `XRDisplayLayer.prototype` — a browser shipping half the set is one mid-implementation, and
  calling it supported would surface as a `not a function` inside a click handler.
  *(core tier — additive)*

- **The 2D/3D hardware state is a consequence of the mode, not a control.** There is deliberately
  **no page-facing request** for it. Asking for a mode with `viewCount === 1` puts the panel in its
  2D state and the browser reports that mode active — the runtime carries on weaving the same fixed
  two-view atlas — and asking for the 2-view mode puts it back. Tying the two together makes the
  one bad state (a flat panel showing a stereo atlas, i.e. a blurry double image rather than 2D)
  unreachable. **`requestDisplayMode('2d'|'3d')` is gone**, and so is every mention of a "lens".

- **The SDK collapses the stereo rig automatically.** When a 1-view mode goes **active** every
  window's `ipdFactor`/`parallaxFactor` is pushed to 0 (both eyes render from one place), and a
  2-view mode going active restores them. This is driven by the `renderingmodechange` event — plus
  the first `getRenderingModes()` read, so a page that OPENS with the panel already flat is
  collapsed too — and **not** by the request. So it happens however the mode changed (this page,
  another one, the shell), the page's own render loop is untouched, and **a refused request changes
  nothing in either direction**, which is now structural rather than a rollback.

  **The restore is exact, and that is a design property, not luck.** The flattening is a *copy*
  pushed at the layer — a page driving a rig every frame reuses one descriptor object, so zeroing
  it in place would write the flattening into the page's own state and the restore would restore
  0. So each window keeps what the page asked for, untouched, and the flat rig is derived on the
  way out. That latch also means a per-frame `setViewRig` loop cannot walk the page out of 2D, a
  lazy tile that scrolls away and rebuilds its layer comes back flat rather than in 3D, and a
  window that never set a rig at all is flattened (and restored) via the exact rig equivalent of
  its `virtualDisplayHeight`. *(core tier — additive)*

- **`setStereoEnabled(bool)` is now SUGAR, and only sugar** — `false` requests the first mode with
  `viewCount === 1 && isRequestable`, `true` the first with `viewCount === 2 && isRequestable`. It
  touches neither the hardware state (nothing can) nor the rig (the event does that). It rejects
  rather than inventing a mode when the panel lists none. *(core tier — behaviour change on an
  unreleased API)*

- **`on(type, cb)` / `off(type, cb)`** — the two events, which fire on the **XRSession** and not on
  the layer, re-emitted on the wall and on every handle: `renderingmodechange`
  `{type, modeIndex, viewCount, mode, detail}` and `hardwaredisplaystatechange`
  `{type, state:'2d'|'3d', detail}`. `on` returns an unsubscribe function;
  **`onDisplayModeChange(cb)`** remains as the both-events-one-callback shape.
  `wall.hardwareDisplayState`, `wall.activeMode` and `wall.stereoCollapsed` expose the last
  **reported** state — never the last requested one. *(core tier — additive)*

- **Undock — lift a window's asset into a floating native viewer over the desktop.**
  **`wall.undock`** is `{model, splat}` on a browser with `XRDisplayLayer.undock` and **`null`** on
  one without (plain Chrome, or an older DisplayXR browser) — that null is what a page branches on;
  **`wall.refreshUndock()`** re-reads it, **`inline3dUndockSupported()`** is the sync probe. The
  action is **`await undock(element, {src, type, env?, pose?, margin?, title?})`** (new module
  `js/inline3d-undock.js`, re-exported from the main entry): API-first through `layer.undock()`,
  falling back to the `displayxr-view:` OS protocol (hidden-iframe navigation, Chrome's one-time
  "Open DisplayXR…?" prompt) where the layer method is absent. **Call it synchronously inside the
  click** — both paths need the transient activation. Resolves to `{ended, viewer, detached}`;
  rejects with an Error named `not-installed` | `src-not-allowed` | `no-activation` | `busy`.
  *(core tier — additive)*

- **[`samples/display-modes/`](samples/display-modes/)** — the whole surface on one page: the
  `getDisplayInfo()` fields, the `getRenderingModes()` table with the active row marked, a request
  button on every requestable row (`viewCount` 1 **or** 2) and the rows needing more than two views
  greyed with the reason, one `setStereoEnabled` convenience button, a **read-only** hardware
  display state badge fed by the event, and a live event log. Every action prints a greppable
  `[display-modes] …` line so a harness can drive it from the console.

### Notes

- **Advisory scales.** `viewScaleX/Y` and `recommendedViewScaleX/Y` are what the runtime would like
  the per-view resolution to be. The browser cannot resize a page's canvas, so nothing applies them
  for you — a page honours them by sizing its own backing store. Ignoring them costs sharpness or
  fill rate, never correctness.
- **The browser is fixed at two views.** No view synthesis exists anywhere in this stack, so a mode
  needing MORE than two is listed (the panel really can do it) and refused. Show those rows; mark
  them. A **one**-view mode is requestable — the browser still submits two views and the runtime
  still weaves them; it is the panel that goes flat.

## 1.3.0 — 2026-09-04

### Added

- **View rigs — the page can hand the runtime its own CAMERA, not just a virtual-display height.**
  Every inline-3D frame is located against a *view rig*, and until now there was exactly one: a
  display rig with an identity pose whose only knob was `virtualDisplayHeight`. That is the right
  model for a portal — the canvas is a window onto a scene authored to fit it — and the wrong one
  for a scene that owns a camera. An orbit, a walkthrough, a game has a pose and a field of view
  already; it does not want to be told where the eyes are, it wants its own frustum perturbed by
  them. That could not be expressed at all, so those pages either fought the display rig or
  re-derived stereo themselves.

  `handle.setViewRig(rig)` and `addScene`'s `viewRig` option send the whole descriptor:
  `{type:'display'|'camera', position, orientation, virtualDisplayHeight, ipdFactor,
  parallaxFactor, perspectiveFactor, convergenceDiopters, verticalFov, metersToVirtual}`. A rig
  applies per-locate, so animating one is just sending new values each frame — nothing to tween,
  nothing to tear down. **No projection math lands in the SDK**: it fills in a descriptor and the
  off-axis (Kooima) frustum stays in the runtime, which is the same code the native apps consume.
  *(core tier — additive)*

- **`inline3dViewRigSupported()`**, and a fallback that actually falls back. The gate reads a
  capability (`XRDisplayLayer.prototype.setViewRig` being present), never a version or UA string.
  Without it `setViewRig()` warns once and returns `false` while the window keeps weaving — so a
  page that merely wants the extra control where it exists can call it unconditionally. And a
  `viewRig` is only put in the layer init on a browser that *has* rigs: an older one would take
  the init, find no member it recognised, and drop to its **own** default height, so passing a
  camera rig alongside a `virtualDisplayHeight` now genuinely names the older browser's framing.
  *(core tier — additive)*

- **`cameraRigFromCamera(THREE, camera, opts)` and `displayRig(opts)`** in
  `@displayxr/inline3d/three` — descriptor builders, both accepting an `out` object so a per-frame
  call allocates nothing. `cameraRigFromCamera` decomposes the pose from `matrixWorld` rather than
  reading `.position`/`.quaternion` (those are local, and an app camera parented under a dolly —
  the usual way to build an orbit — would otherwise report a pose in the wrong space), converts
  three's degrees to the descriptor's radians, and turns a convergence *distance* into diopters so
  "infinity" is a finite `0`. *(core tier — additive)*

- **`EyeCamera.setLocalFromView(view)` / `setLocalFromMatrices(proj, transform)`, for the attach
  pattern.** The browser locates views **before** the page's rAF, so a rig set during frame N
  drives the views delivered in frame N+1. On a slider that is invisible; on a camera moving under
  the pointer it reads as a soft, swimming misalignment. The fix is not prediction: send an
  identity-posed camera rig and parent the eye cameras under the app camera, and three's scene
  graph composes *this* frame's world pose with no lag. These setters write `camera.matrix` and
  leave `matrixWorld` to three's traversal, which is the whole of it — a scene-graph parent, not
  projection math. `setFromView` (world) is unchanged. *(core tier — additive)*

- **`samples/camera-rig/`** — an orbiting scene on a camera rig, with sliders for FOV, convergence
  and distance, an `attach` toggle, a live comfort readout, and `C` to cut between the camera rig
  and a display rig framed to match it at the home angle. `samples/hello-cube/?debug` gains the
  display rig's knobs; `samples/windows/`'s live scene tile moves to a camera rig in the attach
  pattern. The comfort rule the readout prints is the runtime's own
  (`ipdFactor × metersToVirtual × convergenceDiopters × N`, N ≈ 0.5 m): at 1 the viewer's eyes are
  parallel on infinitely far content and past it they diverge. The SDK documents it and never
  enforces it — the runtime clamps its own inputs, once, with a warning.

### Docs

- **[`docs/porting-three-js-apps.md`](docs/porting-three-js-apps.md) — porting an existing three.js
  app (WebXR or plain) to inline 3D.** The rig work above closed the gap that made this guide
  possible: an app that owns a camera can now hand it over, so "port your WebXR app" stops meaning
  "re-author it as a portal". The guide is the WebXR→inline-3d mapping table (what each of
  `isSessionSupported`, `renderer.xr`, `setAnimationLoop`, `XRWebGLLayer`, reference spaces,
  offset-reference-space locomotion, `ArrayCamera`, controllers and `updateRenderState` becomes, and
  why), the whole render loop with validate-before-clear and last-good replay, the Spark
  double-sort, DOM UI over a woven canvas, picking, a hardware checklist, and a 24-item pitfalls
  register. Linked from the README and from the top of the authoring guide.

## 1.2.1 — 2026-08-25

### Fixed

- **`./viewer` wheel zoom is proportional and eased.** It scaled by the delta's SIGN only — a flat
  8% step per wheel event — which is about right for one mouse notch and badly wrong for a
  trackpad, where a single two-finger flick emits dozens of small events. Measured: a 20-event
  flick reached **5.3x** and a longer swipe hit the 6x clamp, on gestures the user reads as gentle.

  The handler now scales by magnitude, normalises `deltaMode` (Chrome reports pixels; Firefox
  reports LINES for a mouse wheel, so identical hardware was ~2x more sensitive in one browser),
  clamps per event against OS pointer-acceleration spikes, and applies the zoom as `exp()` so equal
  deltas give equal ratios in both directions — `1 + d` and `1 - d` are not inverses, and the
  asymmetry was felt as zooming out being weaker than zooming in. Zoom then eases toward its target
  on the same damping curve yaw and pitch already used, so a notch glides instead of stepping.

  Same gestures after: trackpad flick **1.13x**, mouse 3 notches **1.35x**, and Chrome and Firefox
  now agree per notch. *(preview tier — no API change)*

## 1.2.0 — 2026-08-20

### Added

- **`./model` lights meshes with an image-based environment by default (`environment: 'room'`).**
  The previous default, `studio`, is three punctual lights and nothing else. A punctual light
  contributes a specular highlight but does not fill a metallic BRDF, so a `metalness: 1` surface
  sampled an empty environment and resolved to **black** — chrome rendering as a dark disc, glass
  lenses as opaque holes. The failure reads as a corrupt asset rather than a lighting choice, and
  it cost real debugging time: two perfectly good models were discarded as broken before the cause
  was found.

  `environment` now takes `'room' | 'studio' | 'none'` and defaults to `'room'`, which bakes a
  PMREM from three's procedural `RoomEnvironment` — generated in memory, so this buys IBL with no
  HDRI to fetch and keeps an offline or kiosk build free of a CDN in its critical path. `'studio'`
  remains for wholly dielectric matte content, and an explicit `envMap` still overrides both. Only
  meshes are affected: splats carry their own baked radiance and never enter this path.

  **This moves your pixels.** Metal and glass gain reflections they should always have had, and
  dielectric surfaces pick up a softer ambient. Pass `environment: 'studio'` to keep 1.1.1's look.
  *(preview tier — changed default)*

- **`./model` loads compressed glTF — Draco, meshopt and KTX2/Basis.** `addModel()` resolved
  `GLTFLoader` and called a bare `new Loader().loadAsync(src)`, so any asset carrying a compression
  extension threw outright: `"No DRACOLoader instance provided."` for
  `KHR_draco_mesh_compression`, `"setMeshoptDecoder must be called before loading compressed
  files"` for `EXT_meshopt_compression`, and a failed texture for `KHR_texture_basisu`. These are
  hard failures, not degraded loads, and Draco is close to universal in catalogue GLBs — so the
  module's own premise, that a retailer's existing glTF renders unchanged, was false for most real
  files.

  `addModel` now reads the asset's `extensionsUsed` / `extensionsRequired` **before** parsing and
  attaches exactly the decoders it declares. The inspection is a single `fetch` whose bytes go
  straight to `loader.parse()`, so it replaces the loader's own request rather than adding one, and
  an asset that declares no compression imports nothing, constructs nothing and costs exactly what
  it did in 1.1.1 (measured: zero decoder requests, one request for the asset). Decoders are shared
  across tiles and ref-counted by configuration, so a grid of twelve products stands up one Draco
  worker pool and one tile's `remove()` cannot tear down the pool the other eleven are decoding on.
  *(preview tier — additive)*

- **`decoderPath`, and the reason it is not a CDN.** three ships the Draco decoder and the Basis
  transcoder as *runtime* files that `DRACOLoader` / `KTX2Loader` fetch at decode time, so
  something has to say where they are. The default is **your own origin** —
  `{draco:'/draco/', basis:'/basis/'}`, the layout `cp -r node_modules/three/examples/jsm/libs/…`
  produces — and there is deliberately **no CDN fallback**: pages built on this SDK include offline
  kiosk builds, and a default that reached for `cdn.jsdelivr.net` the first time someone opened a
  compressed product would make the page's offline story depend on one asset's compression setting.
  A string is a parent directory holding both; an object overrides either key.
  `EXT_meshopt_compression` needs nothing served — its decoder is pure JS. *(preview tier —
  additive)*

- **`DRACOLoader` / `KTX2Loader` / `meshoptDecoder` injection**, mirroring the existing
  `GLTFLoader` escape. A **class** is constructed for you and pointed at `decoderPath`; an
  **instance** is used exactly as you configured it and its decoder path is left alone — rewriting
  it would defeat the one thing people inject for. `KTX2Loader.detectSupport()` is called for you
  with the tile's own `WebGLRenderer` (`SceneViewer` owns it, and it exists synchronously by the
  time the asset lands), and re-called per tile on a shared instance. *(preview tier — additive)*

- **A failure message aimed at the page author.** A missing or mis-served decoder rejects
  `handle.ready` with an error naming the **glTF extension**, the **option that fixes it** and the
  **path it actually looked in** — plus `err.gltfExtension` / `err.decoder` for programmatic
  handling. three's own message names a class the page never mentions and says nothing about the
  two things that resolve it. The 404 case reads: *needs the "KHR_draco_mesh_compression" decoder
  (Draco mesh compression) and it could not be used … Currently looking in "/draco/" — check that
  it is actually served … Underlying error: fetch for ".../draco_wasm_wrapper.js" responded with
  404*. *(preview tier — additive)*

- **KTX2's silent failure is now loud.** `GLTFLoader` swallows a texture-load rejection, so a
  mis-served Basis transcoder resolved a model with **zero textures and no error** — seven
  compressed textures became none and `ready` resolved (measured on three r180). `addModel` now
  loads the transcoder eagerly via `KTX2Loader.init()` once an asset declares
  `KHR_texture_basisu`, which converts that into the named rejection above. *(preview tier)*

- **`samples/model/` gains a Draco tile**, with three's Draco decoder served out of this repo at
  `vendor/draco/` and the sample passing `decoderPath` — because the site is hosted under a path
  prefix, which is exactly the case where the absolute default 404s. The tile is the same
  `addModel` call as the others; only the asset differs. Duck (CC0, Khronos glTF-Sample-Assets).

### Fixed

- **`remove()` releases compressed textures.** `disposeTree` disposed geometries and materials but
  not the materials' texture maps, which is real GPU memory as soon as KTX2 is in play and a
  catalogue churns through it. *(preview tier)*

## 1.1.1 — 2026-08-20

### Fixed

- **`./viewer` validates a frame before it clears the canvas — the dark blink under GPU load
  (web#12).** `SceneViewer.onFrame` cleared unconditionally and then rendered whatever it could.
  Under load the session hands the callback a **short view list** — one view, or none, a per-frame
  mono fallback — and the old loop turned that into a cleared buffer with a single origin-camera
  view drawn into it whose content is entirely near-plane-clipped: a fully transparent
  side-by-side buffer, i.e. **one dark woven tile**. The blink was the viewer's, not the weave's;
  it was reported as a compositor fault (glTF and splat tiles blinking on a busy box) with the
  whole submit/match path provably healthy.

  Now every disqualifying condition — a short view list, a `null` or degenerate
  `layer.getViewport(view)`, a disposed viewer — is checked **while the canvas still holds the
  last good image**, and only a frame that will draw is allowed to clear. A frame that cannot
  draw **replays the last good one** from per-eye `Float32Array(16)` copies of
  `projectionMatrix` / `transform.matrix` plus the viewport rects (copies, because an `XRView` is
  valid only inside its own frame callback), rather than skipping the commit — the SDK's
  every-frame-repaint invariant is real, and an un-redrawn canvas can drop out of the aggregated
  frame and leave the weave reading a stale sub-rect. A one-frame-stale eye pose is
  imperceptible; a black frame and a smear are not. Before the first good frame there is nothing
  to replay, and the frame simply returns without clearing.

  **This changes pixels only on frames that were previously black.** A frame that passed
  validation renders byte-for-byte as it did in 1.1.0 — same clear, same viewports, same
  matrices, same order. *(preview tier)*

- **A no-op resize no longer blanks the tile (web#12).** `renderer.setSize()` writes
  `canvas.width`/`canvas.height` unconditionally, and writing either — *including the same value*
  — reallocates and clears the drawing buffer. `ResizeObserver` fires on things that leave the
  buffer's dimensions exactly where they were (a sub-pixel reflow, a scrollbar coming and going, a
  sibling settling), and its callback runs after rAF and before paint, so each one committed a
  black frame with nothing on the way to repaint it. `_resize` now compares against
  `renderer.domElement.width/height` and returns early when nothing moved; a real change resizes
  and then **immediately** re-renders from the replay cache (rects scaled to the new buffer), so
  the cleared store never reaches the compositor. Observer bursts coalesce to one animation frame,
  matching what the core already does for its own windows. *(preview tier)*

- **`SceneViewer` without `useEyeCamera()` says so instead of rendering nothing.** With no
  `./three` glue the 3D path had no eye camera, so it cleared and drew nothing every frame,
  forever, in silence — and this module's own header example omitted the call, making the failure
  reachable by copy-paste. It now warns once and renders the **mono camera** into both eye
  viewports (flat, but visible), and the example passes `EyeCamera`. `./splat` and `./model` were
  never affected — they supply the glue for you. *(preview tier)*

### Added

- **`EyeCamera.setFromMatrices(projectionMatrix, transformMatrix)`** — the same two matrices an
  `XRView` carries, handed over separately, for re-drawing a frame you have already drawn.
  `setFromView` is now a one-line forward to it, so a replay path can never drift from the live
  one. *(core tier — additive)*
- **`handle.stats()` → `{ frames, monoFrames }`** on the handle every `add*()` returns. For scene
  windows, `monoFrames` counts the deliveries that carried fewer than two views — the
  load-induced fallback that used to be invisible from the page, since nothing throws and nothing
  logs. A rising ratio is the machine telling you the session is degrading before it becomes a bug
  report about "blinking"; one throttled `console.debug` (the first, then 1-in-300) names the
  rate. The core's own contract is unchanged: the view list is passed to `onFrame` exactly as
  reported, filtered by nothing and synthesised from nothing. *(core tier — additive)*
- **Unit tests.** `test/*.test.mjs` under `node --test`, with the DOM and three.js stubbed by
  hand (`test/stubs.mjs`) so the test run needs no dependency either. They pin the rules above:
  zero `clear()` calls for an empty view list, a one-eye list, a null viewport and a missing
  layer; a replay that renders the cached matrices and survives the UA recycling the views it
  cached from; no `setSize` on a no-op resize; an immediate repaint after a real one. 13 of the
  15 fail against 1.1.0. Wired into CI as a second job.

## 1.1.0 — 2026-08-19

### Added

- **`inline3dOcclusionByDrawOrder()` — and the whole overlay-exclusion machinery turns itself off
  where it's true.** The browser's Phase-2 compositor path composites ANY 2D content over woven
  tiles per-pixel by draw order: a header, a badge, a dropdown, a translucent scrim, even a
  full-tile plate occludes a tile with nothing declared. On such a browser this SDK stops working
  around it — no auto-chrome DOM scan (a `querySelectorAll` + `getComputedStyle` sweep at every
  layer activation), no `MutationObserver` per live tile for `data-inline3d-overlay`, and no
  `will-change: transform` promotions written onto the page's own elements. `exclude()`,
  `addGlobalOverlay()` and their `remove`/`unexclude` pairs still accept and store their argument
  and simply do nothing, so ONE page runs unchanged on both browser generations; one
  `console.info` says so the first time a page calls one.

  The probe is a **capability, not a version**: the browser change is compositor-side and leaves
  the JS API untouched, so `excludeElement` is present on both generations and only its effect
  differs — its presence cannot tell them apart, and neither can `inline3dOverlaySupported()`,
  whose question ("does 2D on a tile composite as crisp 2D?") is true on both. The gate is a
  readonly capability flag the browser exposes on `XRDisplayLayer` —
  `typeof XRDisplayLayer.occlusionByDrawOrder === 'boolean' ? XRDisplayLayer.occlusionByDrawOrder : …`,
  falling back to the same-named per-layer attribute read off the first live layer if that is the
  shape it lands in. **DisplayXR Browser 0.1.11 is the first build to expose it**, so on 0.1.11 and
  newer this release stands the machinery down; on 0.1.10 and earlier the legacy path runs, byte for
  byte as in 1.0 — verified by replaying one page against both SDK builds and diffing every
  exclusion call, promotion, warning and registration. A user-agent or version gate was rejected: a
  page pins an SDK for years, and a version string cannot describe a compositor behaviour that is
  switch-gated — which is also why the flag reads `false` on a 0.1.11 launched with
  `--disable-inline-3d-occlusion`, and the SDK correctly resumes the legacy path there.

  Note what the *obvious* probe would have done.
  `!!XRDisplayLayer.prototype.occlusionByDrawOrder` **throws** — a Blink IDL attribute getter
  raises `TypeError: Illegal invocation` when its receiver is the prototype rather than an
  instance — so the natural one-liner would have failed on precisely the browser it was looking
  for. Presence is therefore probed with `in` (which calls no getter) and every value read has a
  legal receiver: the interface object, or a real layer.

  Effects on an element that overlaps a tile remain the exception on both generations: a
  `backdrop-filter` (a function of what is behind it, and what is behind it is the woven buffer),
  and — new small print for the Phase-2 path — a pixel-moving `filter`, a non-normal blend mode or
  a 3D sorting context, none of which draw as the plain quad the split can lift. Plain chrome is
  unaffected. *(core tier — additive: one new helper, no behaviour change on current browsers. The
  exclusion APIs are deprecated-but-covered; see the stability policy.)*

- **`./viewer`, `./splat` and `./model` are now published exports.** 1.0.0 shipped `exports` for
  `.` and `./three` only, so `import { addSplat } from '@displayxr/inline3d/splat'` failed on an
  npm install even though the modules existed in the repo — vendoring the files was the only way to
  use a splat or a mesh tile. Additive, so nothing in 1.0.0 changes.
  *(preview tier — see the stability policy before depending on their option shapes)*
- `boundsFromPositions` takes `expand` (default 2.5), the width of the outlier-rejection window in
  core extents. `expand: 0` restores the 1.0-era percentile-only box. *(preview)*
- `addSplat` checks `THREE.REVISION` and throws a named error when three is older than 0.180,
  Spark's floor. npm cannot express a peer range per export, so the manifest states the
  package-wide `>=0.150` and an install on 0.16x succeeds; the failure used to surface from inside
  a Spark worker as something unrelated to versions. *(preview)*
- **A live window now tracks its own box and `devicePixelRatio`.** `addImage`/`addVideo` windows
  get a `ResizeObserver` while active, plus a `(resolution: Ndppx)` media query for the changes a
  `ResizeObserver` cannot see (browser zoom, a drag to a different-scale monitor); the
  side-by-side buffer is re-derived and repainted on the next animation frame. `addScene`
  canvases and windows given an explicit `{ width, height }` are box-independent and untouched.
  *(core tier — additive; no API change)*
- **Creating a second manager while one is live warns.** The browser's element-rect channel is a
  whole-widget setter, so two live sessions in one document overwrite each other's rect list
  every frame and neither one's tiles hold still. One `console.warn` says so; nothing is refused,
  because a route change that closes one manager and opens the next is the normal case.
  *(core tier)*
- **A full-tile overlay is refused with an explanation instead of destroying the tile.** The
  browser matches an excluded element to a composited quad by ≥70% area overlap, so a plate
  congruent with its own canvas matches the **canvas** — which then leaves the weave input and
  presents its raw side-by-side buffer. Both the imperative `exclude()` and the
  `data-inline3d-overlay` scan now measure mutual overlap and skip such an element. The test is
  mutual, so page-global chrome that fully covers a small tile is unaffected. Make the overlay a
  partial region of the tile, or page chrome via `addGlobalOverlay()`. *(core tier)*

### Changed — this moves existing pixels

- **A splat's framing changes: subjects that were 10–15% too large now render smaller.**
  `boundsFromPositions` returned a percentile-trimmed box as the subject's extent. Trimming is
  essential on captured content — one floater a hundred metres out and the subject is a speck — but
  the tail it drops on a DENSE subject is that subject's own outer shell, so the box came back
  small and the fit faithfully turned that into a subject overflowing its tile. A uniform cube of
  20k points measured 0.899 of its real size with no outliers present at all.

  Percentiles now bound a rejection window and the returned extent is the true min/max inside it;
  the same cube measures 1.000 and the floater is still rejected. Measured across seven scanned
  products, rendered silhouettes went from 0.849–0.980 of the tile to 0.739–0.880, against 0.856
  for the `./model` path whose `Box3` bounds were always exact.

  If a page compensated for the old behaviour with a reduced `margin`, remove that compensation.
  *(preview tier — `./viewer`, and `./splat` through it. `./model` is unaffected: its bounds were
  never percentile-based.)*

### Fixed

- **Back-navigation left ghost 3D windows woven over the next page.** A window's rect reaches the
  compositor from the session's own animation frames, and the only way to clear a rect is to push
  a list without it — so a page frozen into the bfcache mid-loop leaves its last list standing and
  its tiles keep weaving over whatever is on screen now (context:
  [displayxr-browser#87](https://github.com/DisplayXR/displayxr-browser/issues/87)). Every live
  window is now released on `pagehide` (and `freeze`, for a tab frozen without one) while frames
  still run, so the outgoing frames report an empty list, and re-armed on `pageshow`/`resume`
  through the existing lazy logic — re-observing re-delivers the current intersection state, so a
  tile scrolled away before leaving stays dark. Page chrome is rescanned on restore. *(core tier)*
- **A restored page could come back alive but never paint.** A bfcache restore can hand back a
  session whose pending animation frame never arrives, leaving the manager nominally running with
  a dead loop. A persisted `pageshow` now gives it a second to prove otherwise and then starts a
  fresh loop; loops carry an id and only the current one re-arms, so a stalled predecessor cannot
  double the loop if it later fires. *(core tier)*
- `addSplat` threw a `ReferenceError` on the **URL path** — every ordinary page — because the
  loader assigned `out.mesh` before `const out` was initialised. An async body runs synchronously
  to its first `await`, and the URL path has none. The throw escaped into `ready` *after* the mesh
  had joined the scene, so the splat rendered at raw model scale and never got framed: the symptom
  was "the fit is wrong" when the fit had never run. The Blob path awaited `arrayBuffer()` and so
  was unaffected, which is how it survived a commit about the bytes path. *(preview)*
- A rejected splat load now detaches its mesh, so a failed tile is empty as documented rather than
  an unframed subject spilling out of the window under the caller's error state. *(preview)*
- `addSplat` warns when no usable bounds could be measured, instead of silently drawing at model
  scale. *(preview)*

## 1.0.0 — 2026-07-20

First published release. Freezes the imperative authoring API — `createInline3D`, the `Inline3D`
manager (`addImage` / `addVideo` / `addScene`, global overlays), the `TileHandle`, the detection
helpers, the `data-inline3d-overlay` contract, and the side-by-side buffer contract — as the
supported surface for 1.x. Exports `.` and `./three`.

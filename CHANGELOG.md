# Changelog — `@displayxr/inline3d`

Versioning follows [`docs/sdk-stability.md`](docs/sdk-stability.md). Read that first: the core
entry points (`.`, `./three`) are frozen for 1.x, while the **scene subpaths** (`./viewer`,
`./splat`, `./model`) are a preview tier whose options may change in any release. Entries below say
which tier they touch, because that is what tells you whether an upgrade can move your pixels.

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

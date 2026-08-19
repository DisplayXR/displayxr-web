# Changelog — `@displayxr/inline3d`

Versioning follows [`docs/sdk-stability.md`](docs/sdk-stability.md). Read that first: the core
entry points (`.`, `./three`) are frozen for 1.x, while the **scene subpaths** (`./viewer`,
`./splat`, `./model`) are a preview tier whose options may change in any release. Entries below say
which tier they touch, because that is what tells you whether an upgrade can move your pixels.

## 1.1.0 — unreleased

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
  shape it lands in. No browser exposes it yet, so this release changes nothing for anyone today:
  the legacy path runs, byte for byte as in 1.0 — verified by replaying one page against both SDK
  builds and diffing every exclusion call, promotion, warning and registration. It flips the moment
  a browser exposes the flag. A user-agent or version gate was rejected: a page pins an SDK for
  years, and a version string cannot describe a compositor behaviour that is switch-gated.

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

# `@displayxr/inline3d` — stability & versioning policy

The SDK follows [semantic versioning](https://semver.org/). **1.0.0** freezes the imperative
JavaScript authoring API as the supported public surface; everything below is a promise about what
will and won't break.

## Covered by semver (won't break in a 1.x)

The **exported** surface of the package entry points:

- `@displayxr/inline3d`
  - `createInline3D(opts?)`, `startInline3D(canvas, opts?)`
  - the `Inline3D` manager: `addImage`, `addVideo`, `addScene`, `addGlobalOverlay`,
    `removeGlobalOverlay`, `close`, and the `supported` / `session` / `refSpace` / `liveCount` fields
  - the `TileHandle`: `remove`, `exclude`, `unexclude`
  - `inline3DAvailable()`, `inline3dOverlaySupported()`, `inline3dOcclusionByDrawOrder()`
- `@displayxr/inline3d/three`
  - `EyeCamera` (`.camera`, `.setFromView`), `EdgeFeather` (`.render`)
- The declarative `data-inline3d-overlay` attribute contract.
- The **one buffer contract**: a weaved window is a `<canvas>` whose backing buffer holds
  side-by-side stereo (left eye left half, right eye right half); its CSS box is the shape the
  viewer sees.

Within 1.x these keep working; additions (new optional options, new helpers) ship as **minor**
releases, fixes as **patches**.

### Deprecated in 1.1.0 — the overlay-exclusion surface

`TileHandle.exclude` / `unexclude`, `Inline3D.addGlobalOverlay` / `removeGlobalOverlay`, the
`autoChrome` option and the `data-inline3d-overlay` attribute are **deprecated but still
covered**. A browser with draw-order occlusion composites any 2D over woven 3D per-pixel by draw
order, so there is nothing left for them to declare: the SDK accepts them and does nothing
(details in [authoring](authoring-inline-3d.md#2d-over-3d--draw-order-occlusion)).

Deprecated here means *documented as unnecessary*, not scheduled for removal:

- They keep their exact 1.0 behaviour on every browser without draw-order occlusion, and those
  browsers are in the field. A page must be able to support both generations unchanged, which is
  the whole reason the browser also kept `excludeElement` as a no-op.
- Removing them would be a **2.0**, and nothing here motivates one. Expect them to outlive 1.x.
- `inline3dOverlaySupported()` is *not* deprecated: its question ("does 2D on a tile composite as
  crisp 2D?") has the same answer on both generations. To distinguish the mechanisms — and only
  ever the mechanisms, never a version or UA string — use `inline3dOcclusionByDrawOrder()`.

## Explicitly NOT covered (may change without a major bump)

- **The scene subpaths — `@displayxr/inline3d/viewer`, `/splat` and `/model`.**
  `SceneViewer`, `boundsFromPositions`, `addSplat`, `addModel`, and every option they take are
  **experimental** and may change in any release. They are shipped inside the 1.x package
  rather than as a separate one so there is a single version to install and a single CI to keep
  green — but they are new, they wrap a fast-moving renderer, and freezing their surface now
  would be guessing. The core entry points above stay frozen regardless; a page that never
  imports these subpaths is unaffected by anything that happens to them.

  `/model` is in this tier for the same reason as the other two, not a lesser one: it is a thin
  wrapper over the SAME `SceneViewer`, so anything that moves the viewer's framing moves meshes
  too. Listing only `/viewer` and `/splat` here previously left its status to be inferred, and
  the reasonable inference was the wrong one.

  **PROMOTION CRITERION.** "Once the API has settled" was unfalsifiable, so: promote when two
  consecutive releases ship with no change to framing behaviour or to an option's meaning, OR when
  the N-view render contract lands — whichever comes first, since N-view has to touch the viewer
  anyway. As of 1.1.0 the record is the argument against promoting: the subpaths landed
  2026-08-14 and framing changed three times in the four days that followed (the swept-horizontal
  fit, measuring bounds in-page instead of trusting a sidecar, and percentile-reject-then-measure).
  Each was a fix; each also changed what a shipped page looks like.
  **1.2.0 does not restart that clock, and does add an obligation.** The compressed-glTF work on
  `/model` changed no framing behaviour and no existing option's meaning — it is purely additive
  (`decoderPath`, three decoder-injection escapes) — so by the criterion above it counts as one of
  the two quiet releases. What it *does* introduce is the preview tier's first **deployment**
  requirement: a page that loads a Draco- or KTX2-compressed asset must serve three's decoder files
  itself (`/draco/`, `/basis/`, or wherever `decoderPath` points). The core tier has no such
  requirement and will not acquire one; note it here because "install the package" is no longer the
  whole setup story for `/model`, and because the default is deliberately not a CDN, so the
  requirement cannot quietly satisfy itself.

  - They need peers the core does not: `three` (**>=0.180** for `/splat`, which is Spark's own
    floor — above the package-wide `>=0.150` the `./three` glue asks for) and
    `@sparkjsdev/spark` (>=2.0). Both are declared **optional**, so the core install is
    unchanged and only pages importing a viewer subpath pay for them.
    npm has no per-export peer range, so the manifest necessarily states the lower bound and an
    install on 0.16x succeeds. `addSplat` therefore checks `THREE.REVISION` itself and throws a
    named error rather than letting the mismatch surface from inside a Spark worker.
- Anything prefixed `_` (internal), and any field/behavior not listed above.
- The **browser ↔ display-processor plumbing** the weave rides on (overlay compositing, wish mask,
  the batch weave transport). Web authors never touch it; it is free to evolve. See
  displayxr-browser#22.
- Exact pixel results of the weave / feather / reconvergence (hardware- and DP-dependent).

## Not in 1.0 — the deferred declarative API (targets 1.x / 2.0)

These are **intentionally** out of 1.0 (see displayxr-browser#25). They depend on the Phase-2
**N-view** render contract and the Option-B region model, which are not final — freezing them now
would box in a public API on a moving foundation. They will land **additively** (so today's 2-view
code keeps working):

1. `<dxr-scene>` / `<dxr-video>` / `<dxr-image>` **web components** — need the N-view render contract.
2. A **three.js N-view adapter** — render N tiles rather than a fixed 2-view pair.
3. `@media (glasses-free-3d)` + **auto-isolation** (relax today's `will-change` / `backdrop-filter`
   constraints) — depends on the isolation model (browser#22 B, browser#23).
4. A **CSS-native** region/z-order declaration (eventual successor to `data-inline3d-overlay`).

Draw-order occlusion overtakes parts of 3 and 4: with 2D-over-3D decided per-pixel by draw order,
the successor to `data-inline3d-overlay` is *ordinary CSS stacking* — nothing new to declare — and
the isolation constraints the SDK works around (`will-change` promotion) do not arise. What stays
open is `@media (glasses-free-3d)`, and `backdrop-filter`, which no z-order model fixes.

Because N-view is additive over the frozen 2-view core, shipping 1.0 now is semver-safe.

## Browser compatibility

The SDK is progressive enhancement: on any non-DisplayXR browser `createInline3D()` resolves to
`{ supported: false }` and the page shows its normal 2D content. Overlay exclusion
(`addGlobalOverlay` / `handle.exclude`) additionally requires a DisplayXR Browser new enough to
expose `XRDisplayLayer.excludeElement`; where absent it silently no-ops. A browser on the Phase-2
compositor path occludes tiles with 2D **by draw order**, with nothing declared, and the same
calls no-op there too.

Query all of this at runtime — `inline3DAvailable()`, `inline3dOverlaySupported()`,
`inline3dOcclusionByDrawOrder()` — and never by sniffing a version or user-agent string. Each
reads a capability the browser exposes; version sniffing is not a supported way to detect any
inline-3D feature, and a page pinned to one SDK release will outlive whatever it inferred. Note
in particular that `excludeElement`'s *presence* is not a generation test: the Phase-2 change is
compositor-side and leaves the JS API exactly as it was, so the method is present on both
generations and only its effect differs.

## TypeScript

Types ship in the package (`index.d.ts`, `three.d.ts`). TS consumers should also have
[`@types/webxr`](https://www.npmjs.com/package/@types/webxr) installed for the `XR*` types the API
references.

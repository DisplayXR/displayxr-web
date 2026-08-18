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
  - `inline3DAvailable()`, `inline3dOverlaySupported()`
- `@displayxr/inline3d/three`
  - `EyeCamera` (`.camera`, `.setFromView`), `EdgeFeather` (`.render`)
- The declarative `data-inline3d-overlay` attribute contract.
- The **one buffer contract**: a weaved window is a `<canvas>` whose backing buffer holds
  side-by-side stereo (left eye left half, right eye right half); its CSS box is the shape the
  viewer sees.

Within 1.x these keep working; additions (new optional options, new helpers) ship as **minor**
releases, fixes as **patches**.

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

Because N-view is additive over the frozen 2-view core, shipping 1.0 now is semver-safe.

## Browser compatibility

The SDK is progressive enhancement: on any non-DisplayXR browser `createInline3D()` resolves to
`{ supported: false }` and the page shows its normal 2D content. Overlay exclusion
(`addGlobalOverlay` / `handle.exclude`) additionally requires a DisplayXR Browser new enough to
expose `XRDisplayLayer.excludeElement`; where absent it silently no-ops. Query support at runtime
with `inline3DAvailable()` and `inline3dOverlaySupported()` rather than sniffing versions.

## TypeScript

Types ship in the package (`index.d.ts`, `three.d.ts`). TS consumers should also have
[`@types/webxr`](https://www.npmjs.com/package/@types/webxr) installed for the `XR*` types the API
references.

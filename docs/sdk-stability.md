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

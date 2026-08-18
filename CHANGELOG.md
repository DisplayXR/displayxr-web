# Changelog — `@displayxr/inline3d`

Versioning follows [`docs/sdk-stability.md`](docs/sdk-stability.md). Read that first: the core
entry points (`.`, `./three`) are frozen for 1.x, while the **scene subpaths** (`./viewer`,
`./splat`, `./model`) are a preview tier whose options may change in any release. Entries below say
which tier they touch, because that is what tells you whether an upgrade can move your pixels.

## 1.1.0 — unreleased

### Added

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

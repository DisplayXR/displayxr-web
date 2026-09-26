# AGENTS.md

**Before touching any page that hosts a woven canvas, read
[`docs/woven-canvas-rules.md`](docs/woven-canvas-rules.md)** (including §5, pitfalls found on
hardware). Most "3D is broken" reports on a DisplayXR panel are one of those rules, not a browser
or runtime bug: a raw side-by-side flash, a black picture, a flat tile, a stall that looks like lost
head tracking.

Then, by task:

- Writing an inline-3D page: [`docs/authoring-inline-3d.md`](docs/authoring-inline-3d.md).
- Motion and effects on woven tiles: [`docs/authoring-motion-and-effects.md`](docs/authoring-motion-and-effects.md).
- Porting a three.js app: [`docs/porting-three-js-apps.md`](docs/porting-three-js-apps.md).
- Splats on the PlayCanvas backend (transitions, reveals, diagnostics with `?dxrdiag`):
  [`docs/playcanvas-adapter.md`](docs/playcanvas-adapter.md), [`docs/splat-effects.md`](docs/splat-effects.md).
- API: the `.d.ts` files at the repo root; changes per release: [`CHANGELOG.md`](CHANGELOG.md).

Working in this repo: `npm test` runs the unit tests and the public-API typecheck (both are CI
checks). The SDK publishes to npm as `@displayxr/inline3d` from `sdk-v*` tags.

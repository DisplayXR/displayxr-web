# starter-model — a product / object viewer

One glTF in a 3D tile, with the product's title, price and buttons beside it, a depth slider and a
2D/3D switch. Built with `addModel()` on a **display rig**.

**Rules it demonstrates** ([Making 3D that looks right](../../docs/making-3d-look-right.md)):
rule 1 (an object the user turns → display rig), rule 2 (screen plane through the subject),
rule 3 (`depthFit` to the comfortable budget, then `depthOffset` so the cheaper "behind" half is
used too), rule 4 (no HTML over pop-out: the UI sits beside the tile), rule 5 (opaque
`clearColor` matching the page, no feather), rule 7 (cover until `firstWoven`, cut), rules 8–9
(depth slider moving `ipdFactor` and `parallaxFactor` together; a 2D/3D switch on `wall` written
so it cannot invert — `await wall.setStereoEnabled(!in3D)`, `in3D` set only from
`renderingmodechange` — with a fallback to the slider at 0; a finished page in an ordinary browser).

Measured by the headless stereo judge: front p2 −0.2 %, behind p98 +0.8 % of the tile width at
the start, −0.4 % / +0.8 % wheel-zoomed to the cap (comfortable: ≥ −0.6 % / ≤ 1.5 %). Near and far
are set on `wall.session` by the page: no SDK viewer does it.

## Adapt it

- **Your model:** change `MODEL`. This one is an uncompressed GLB, so nothing else is needed. A
  Draco- or KTX2-compressed asset also needs `decoderPath` pointing at decoder files your own site
  serves (`samples/model/` shows it); a path relative to this repo will not exist in your copy.
- **Zoom:** capped at `zoom: { max: 1.3 }` because zoom spends depth (the fit is not redone when
  the user zooms). Raise it only with the strong column in mind, or set `max: 1` to turn zoom off.
- **Your page colour:** change `BG` in `app.js` and the `background` in `index.html` together.
- **Tile shape:** the budget is in tile heights for a 16:9 tile. On another shape multiply `FRONT`
  and `BACK` by `aspect / 1.78` (a square tile: 0.056 / 0.15), because disparity is a share of the
  tile's *width*.
- **Bigger on screen?** Make the tile wider, not the budget larger: the depth a tile can hold
  grows with its width. A model that turns (`idleSpin`) is budgeted over every angle, so a model
  that never turns can be fitted larger (`fitSweep: false`, `idleSpin: 0`, `orbit: false`).
- **The import map** points at this repo (`../../js/`). In your project use
  `@displayxr/inline3d` from npm or the CDN build instead.

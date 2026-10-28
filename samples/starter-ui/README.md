# starter-ui — HTML around a 3D view

A 3D bar chart on a **display rig** with its 2D chrome in HTML: a title above, a legend and the
controls beside it, a units label over an empty corner of the tile, a depth slider and a 2D/3D
switch. Use it for a dashboard tile, a map with a legend, any 3D view with UI around it.

**Rules it demonstrates** ([Making 3D that looks right](../../docs/making-3d-look-right.md)):
rule 4 (no HTML over content that comes out of the glass: the only label over the tile sits over
empty background), rule 6 (text and controls are HTML at the glass; plain `rgba()` backgrounds; no
`filter`, `backdrop-filter`, `opacity` or animated `transform` on, around or over the canvas),
rule 7 (cover until `firstWoven`, one canvas), rule 8 (one slider value `k` →
`displayRig({ ipdFactor: k, parallaxFactor: k })` via `handle.setViewRig`), rule 9
(`handle.setStereoEnabled()` with a fallback to the slider at 0 when the display has no flat mode;
the button shows what `renderingmodechange` reports; the same layout in an ordinary browser), plus
rules 1–3 and 5 as in [starter-scene](../starter-scene/README.md).

Measured by the headless stereo judge: front p2 −0.5 %, behind p98 +0.9 % of the tile width
(comfortable: ≥ −0.6 % / ≤ 1.5 %).

## Adapt it

- **Your data:** edit `SERIES` (and the legend in `index.html`).
- **More UI over the tile:** first find where the picture is behind the glass (empty background,
  far content) and put it only there. Over content that comes out of the glass, move the UI out of
  the tile or draw the label inside the 3D scene.
- **Depth slider range:** 0–1. On a display rig 1 is what the display does naturally; to get a
  deeper picture give the scene more depth (within the budget), not a factor above 1.

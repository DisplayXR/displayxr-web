# starter-scene — your own three.js object scene

An animated set piece (a small fairground wheel) built in plain three.js and framed by
`SceneViewer` on a **display rig**, with `EyeCamera` drawing each eye from its own view. Use it for
a diorama, a configurator, an animated object — anything the user looks *at*.

**Rules it demonstrates** ([Making 3D that looks right](../../docs/making-3d-look-right.md)):
rule 1 (display rig), rule 2 (screen plane through the subject, nudged back with
`depthOffset`), rule 3 (`depthFit` to the comfortable budget, fitted on the box the content really
occupies after its 3/4 turn), rule 5 (each eye from its own view via `SceneViewer` +
`EyeCamera`; opaque `clearColor` matching the page; no feather), rule 7 (cover until
`firstWoven`), rule 9 (`startMono()` in an ordinary browser).

Measured by the headless stereo judge: front p2 −0.3 %, behind p98 +1.0 % of the tile width
(comfortable: ≥ −0.6 % / ≤ 1.5 %).

## Adapt it

- **Your content:** replace everything between "the content" and `viewer.content.add(set)`.
  Model in any units: `fitTo()` scales it. Keep the fit on `Box3.setFromObject(viewer.content)`
  so the budget sees the turned object's real depth.
- **Animation:** put it in `viewer.onTick`; it runs once per drawn frame, woven or flat.
- **Turning the object:** `orbit: false` and `fitSweep: false` because nothing turns it. If the
  user may spin it, set both to `true`: the fit then budgets every angle, and the object is drawn
  smaller.
- **Tile shape and colour:** as in [starter-model](../starter-model/README.md) — scale `FRONT`/`BACK`
  by `aspect / 1.78`, and keep `BG` and the page background equal.
